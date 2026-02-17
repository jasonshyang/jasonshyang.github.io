---
layout: post
title: Shared Memory IPC
date: 2026-02-17
categories: [Systems]
tags: [rust, ipc]
---

When building multi process applications, at some point we need these different processes to communicate with each other. We might reach for methods like network sockets, but those usually come with some sort of overhead (e.g. for gRPC there's serialization, framing etc.). If performance is critical and our processes are on the same machine, there's a much faster option: *shared memory*.

In this post, we'll explore what shared memory IPC is, and go through a practical example: [`shmq`](https://github.com/jasonshyang/shmq), a lock free SPSC message queue using POSIX shared memory. We'll cover the fundamentals of IPC, explore shared memory primitives, and touch on zero-copy serialization with `rkyv`.

## What is IPC and Why Does It Matter?

*Inter Process Communication* (IPC) refers to mechanisms that allow separate processes to exchange data. Unlike threads within the same process that share memory naturally, processes have isolated memory spaces allocated for them, so that for example if one process crashes, it won't crash others. But this also means we need some mechanisms to communicate between processes - because they cannot simply access each other's memory.

Consider a typical scenario: we're building a trading system where one process produces market data, and another process consumes it and produces actions, and another process consumes those actions and executes trades. These processes need to exchange messages rapidly, and we are very latency sensitive here as our message communication mechanism will directly impact our system's latency and throughput.

While there are different IPC mechanisms, such as local sockets, pipes, here we mainly explore the **Shared Memory** approach, where processes share a memory region together and can directly read/write to it without kernel involvement.

## POSIX Shared Memory

POSIX defines a standard API for shared memory that works across Unix based systems (MacOS / Linux). The core idea is simple - create a memory region that multiple processes can map into their address space, giving them direct access to the same physical memory.

The POSIX shared memory API has just a few key functions:

```c
int shm_open(const char *name, int oflag, mode_t mode);
int ftruncate(int fd, off_t length);
void *mmap(void *addr, size_t length, int prot, int flags, int fd, off_t offset);
int munmap(void *addr, size_t length);
int shm_unlink(const char *name);
```

Here's the workflow:

1. **Producer** calls `shm_open` with `O_CREAT` to create a shared memory object
2. **Producer** calls `ftruncate` to set its size
3. **Producer** calls `mmap` to map it into its address space, getting a pointer
4. **Consumer** calls `shm_open` without `O_CREAT` to access the existing object
5. **Consumer** calls `mmap` to map it into its own address space
6. Both can now read/write through their pointers to the same memory
7. When done, both call `munmap`, and the producer calls `shm_unlink` to clean up

## The shmq Design

Now that we have covered the basics on POSIX Shared Memory, let's look at how we build a message queue on top of this primitive. We will go through three key topics: the ring buffer structure, atomic synchronization, and zero-copy serialization with `rkyv`.

### Ring Buffer

A *ring buffer* fits our SPSC usage well, its fixed-size property simplifies memory management, avoiding the need to dynamically allocate memory for new messages, while still provides the producer/consumer semantics we need.

Here's the memory layout of our queue:

```text
┌─────────────────────────────────────────────────────────────┐
│                      QueueHeader                            │
│  ┌──────────┬──────────┬───────┬─────────┐                  │
│  │ write_idx│ read_idx │ state │ padding │                  │
│  └──────────┴──────────┴───────┴─────────┘                  │
├─────────────────────────────────────────────────────────────┤
│                         Slots                               │
│  ┌─────────┬──────────────────────────────────────────────┐ │
│  │ len (8B)│              data (SLOT_SIZE)                │ │
│  └─────────┴──────────────────────────────────────────────┘ │
│  ┌─────────┬──────────────────────────────────────────────┐ │
│  │ len (8B)│              data (SLOT_SIZE)                │ │
│  └─────────┴──────────────────────────────────────────────┘ │
│                          ...                                │
└─────────────────────────────────────────────────────────────┘
```

The header contains our coordination primitives:

```rust
#[repr(C)]
pub struct QueueHeader {
    pub write_idx: AtomicU64,  // Producer's write position
    pub read_idx: AtomicU64,   // Consumer's read position  
    pub state: AtomicU8,       // Queue state
    pub _padding: [u8; 7],     // Alignment
}
```

The `#[repr(C)]` attribute is very important - it ensures a stable memory layout that's consistent across compilation. Without it, our trusty compiler may reorder fields, and if our producer and consumer processes are compiled separately, they may interpret the memory differently.

The padding is needed here because the `AtomicU8` is only 1 byte, and we want to ensure the entire header is aligned to 64 bytes for cache efficiency.

Each slot has an 8-byte length header followed by the message data:

```rust
struct SlotHeader {
    len: u64,  // How many bytes in this message
}
// Followed by SLOT_SIZE bytes of data
```

We access the data in the queue with pointer arithmetic, calculating offsets based on the slot index and the fixed slot size.

### Lock-Free Synchronization

We generally want to avoid using any locks in our hot path, as it imposes overhead and potential contention across processes (though in our case it's SPSC, so it wouldn't be a major problem). Instead, we can use atomic operations to coordinate access to the ring buffer which does not require lock.

Let's first look at the producer's write operation:

```rust
pub fn try_push(&mut self, msg: &M) -> Result<()> {
    // 1. Check if queue is full
    let write = self.header.write_idx.load(Ordering::Acquire);
    let read = self.header.read_idx.load(Ordering::Acquire);
    if write - read >= SLOT_COUNT {
        return Err(Error::QueueFull);
    }
    
    // 2. Serialize message
    let bytes = msg.to_bytes()?;
    
    // 3. Write to slot
    let slot_idx = (write as usize) % SLOT_COUNT;
    unsafe {
        let slot_data = self.slot_data_mut(slot_idx);
        slot_data[..bytes.len()].copy_from_slice(&bytes);
        self.set_slot_len(slot_idx, bytes.len() as u64);
    }
    
    // 4. Advance write index with Release ordering
    self.header.write_idx.store(write + 1, Ordering::Release);
    Ok(())
}
```

And the consumer's read:

```rust
pub fn try_pop_zero_copy(&self) -> Result<Option<&M::Archived>> {
    // 1. Check if queue is empty
    let write = self.header.write_idx.load(Ordering::Acquire);
    let read = self.header.read_idx.load(Ordering::Relaxed);
    if read == write {
        return Ok(None);
    }
    
    // 2. Read from slot
    let slot_idx = (read as usize) % SLOT_COUNT;
    let data = unsafe { self.slot_data(slot_idx) };
    
    // 3. Access archived message
    let archived = M::access(data)?;
    Ok(Some(archived))
}

pub fn commit(&self) {
    let read = self.header.read_idx.load(Ordering::Relaxed);
    self.header.read_idx.store(read + 1, Ordering::Release);
}
```

The memory ordering is critical here:

| Operation                   | Ordering  | Reason                                                    |
| --------------------------- | --------- | --------------------------------------------------------- |
| Producer writes data        | —         | Regular memory write                                      |
| Producer stores `write_idx` | `Release` | All previous writes must be visible before index update   |
| Consumer loads `write_idx`  | `Acquire` | Must see all writes that happened before the index update |
| Consumer reads data         | —         | Now safe because Acquire guarantees visibility            |
| Consumer stores `read_idx`  | `Release` | Signal to producer that slot is now free                  |
| Producer loads `read_idx`   | `Acquire` | Must see the read completion                              |

This is called *Release-Acquire ordering*, and it provides a synchronization point without locks. The `Release` store ensures all prior writes are committed before the index is updated. The `Acquire` load ensures all those writes are visible before we proceed. This creates a *happens-before relationship* that makes our queue correct. Jon Gjengset has an amazing [video](https://www.youtube.com/watch?v=rMGWeSjctlY&t=5587s) that dives into this topic in great details.

### Why Relaxed Ordering Won't Work

Let's first go through why `Relaxed` ordering does not work well here.

#### What Relaxed Ordering Allows

`Relaxed` ordering guarantees only that the atomic operation itself is indivisible but it makes no guarantees about the ordering of surrounding memory operations. This means:

1. **Our trusty compiler** can reorder operations around relaxed atomics during optimization
2. **Our CPU** can reorder these operations too

Consider what happens if we use `Relaxed` instead:

```rust
// Producer
let slot_idx = (write as usize) % SLOT_COUNT;

// Write message data
slot_data[..bytes.len()].copy_from_slice(&bytes);  // (A)
self.set_slot_len(slot_idx, bytes.len() as u64);   // (B)

// Update write index
self.header.write_idx.store(write + 1, Ordering::Relaxed);  // (C)
```

With `Relaxed` ordering, the CPU or compiler is free to reorder A, B and C lines we wrote, there's no guarantee that the data writes (A and B) will be visible before the index update (C). This means the consumer may see the updated `write_idx` (C) before the data is actually written (A and B), so consumer can read garbage data!

The problem isn't just the producer. If the consumer uses `Relaxed` ordering:

```rust
// Consumer
let write = self.header.write_idx.load(Ordering::Relaxed);
let read = self.header.read_idx.load(Ordering::Relaxed);

if read != write {
    let slot_idx = (read as usize) % SLOT_COUNT;
    let data = self.slot_data(slot_idx);  // (D)
    
    // ...
    
    self.header.read_idx.store(read + 1, Ordering::Relaxed);  // (E)
}
```

Consumer may commit the `read_idx` update (E) before the data read (D). This means we may signal to the producer that we're done reading before we actually are, and the producer could then overwrite the slot while we're still reading it!

#### How Release-Acquire Fixes This

`Release` and `Acquire` create *synchronization* between producer and consumer:

```rust
// Producer
slot_data.copy_from_slice(&bytes);                    // (A)
self.set_slot_len(slot_idx, len);                    // (B)
self.write_idx.store(write + 1, Ordering::Release);  // (C) - Release fence

// Consumer  
let write = self.write_idx.load(Ordering::Acquire);  // (D) - Acquire fence
let data = self.slot_data(slot_idx);                 // (E)
```

The `Release` store on the producer side acts as a barrier - it prevents all prior operations (A and B) from being reordered *after* the store (C). This means the producer commits all its writes to shared memory before publishing the new index. Neither the compiler nor the CPU can move (A) (B) past (C).

The `Acquire` load on the consumer side acts as another barrier: it prevents all subsequent operations (E) from being reordered *before* the load (D). More importantly, it synchronizes with the producer's `Release`, guaranteeing that once the consumer sees the updated index, all writes that happened before the producer's `Release` are now visible. Neither the compiler nor the CPU can move (E) before (D).

Together they form a *happens-before* relationship: if the consumer sees `write_idx`, it's guaranteed to see all the data writes before that index update. 

This mechanism may look similar to a lock, but it's actually much more efficient because it doesn't involve any blocking - it's just a matter of memory ordering.

## Zero-Copy Serialization with rkyv

Now we get to the most interesting part - how do we serialize messages to put them in shared memory? Traditional serialization libraries like `serde` with `bincode` work by traversing the data structure and encoding it to bytes. When deserializing, they allocate new memory and reconstruct the object. For a message with nested structures it can mean multiple allocations, and the overhead could become significant - e.g. every string needs its own allocation, every vec needs its own allocation. This is too slow!

`rkyv` provides a very interesting concept called *zero-copy deserialization*. The key insight is this: if we laid out our data in memory in exactly the same format as we will read it, then deserialization becomes just a pointer cast with validation, we no longer need to allocate new memory or copy data around.

### How rkyv Works

When we derive `Archive` on a type, rkyv generates an "archived" version of that type:

```rust
#[derive(Archive, Serialize, Deserialize)]
#[rkyv(compare(PartialEq), derive(Debug))]
struct Message {
    id: u32,
    payload: String,
    values: Vec<i64>,
}

// rkyv generates something like:
struct ArchivedMessage {
    id: u32,
    payload: ArchivedString,  // Inline length + offset to data
    values: ArchivedVec<i64>, // Length + offset to inline array
}
```

The archived version stores offsets instead of pointers. This is crucial because pointers are meaningless across process boundaries (different address spaces), but offsets from a known base are stable.

When we serialize:

```rust
let msg = Message {
    id: 42,
    payload: "hello".into(),
    values: vec![1, 2, 3],
};

let bytes = rkyv::to_bytes(&msg)?;
```

The key insight is that everything gets laid out in a single contiguous buffer. Instead of having pointers that point to heap allocations (which wouldn't work across processes), rkyv uses *relative offsets* - each field stores how far away its data is, measured from that field's location. 

When we want to access it:

```rust
let archived: &ArchivedMessage = rkyv::access(&bytes)?;

println!("{}", archived.id);                  // Direct field access
println!("{}", archived.payload.as_str());    // Offset + slice
println!("{:?}", archived.values.as_slice()); // Offset + slice
```

Notice we get `&ArchivedMessage` not `Message`. The archived version provides methods to access the data in place. This means we serialize once, copy the bytes to shared memory, and the consumer can access fields directly without any deserialization overhead.

### The Performance Win

Let's compare the approaches:

**Traditional (serde + bincode):**
```rust
// Producer
let msg = Message { /* ... */ };
let bytes = bincode::serialize(&msg)?;          // Allocate + encode
shared_memory[slot].copy_from_slice(&bytes);    // Copy

// Consumer  
let bytes = &shared_memory[slot];
let msg: Message = bincode::deserialize(bytes)?; // Allocate + decode
// Now we can use msg
```

**Zero-copy (rkyv):**
```rust
// Producer
let msg = Message { /* ... */ };
let bytes = rkyv::to_bytes(&msg)?;              // Allocate + layout
shared_memory[slot].copy_from_slice(&bytes);    // Copy

// Consumer
let bytes = &shared_memory[slot];
let msg = rkyv::access(bytes)?;                 // no allocation!
// We can use msg immediately via references
```

The consumer side is much faster with rkyv as we no longer need to allocate memory or copy data around. We can access fields directly from the shared memory region, which is a huge win from latency standpoint.

## Trade-offs

Shared memory isn't always the right choice (in fact most of the time it's not). Here are some trade-offs to consider:

- **Only works on the same machine** - Processes must share the same physical memory. If we need to communicate across machines, we need network communication (sockets, gRPC, etc.).
- **Requires careful synchronization** - We need atomics or locks to coordinate access or our unsafe code can easily lead to undefined behavior.
- **Memory management is manual** - We have to decide the size upfront or we risk overflow. We also need to handle cleanup of shared memory objects.

## Conclusion

In this post, we explored these key concepts and how they are used to build a simple SPSC message queue:

- **POSIX shared memory** provides a portable way for processes on the same machine to share memory regions, with just a few system calls for setup and none in the hot path
- **Release-Acquire ordering** is crucial for lock-free synchronization - without it, the compiler and CPU can reorder operations and break our queue, which would be very difficult to debug
- **Zero-copy serialization** with `rkyv` eliminates deserialization overhead, allowing direct access to data in shared memory

Shared memory IPC isn't the right choice for most applications - sockets and higher level frameworks are simpler and more portable. But when we're building latency sensitive systems where processes are on the same machine and we control both ends, shared memory can deliver performance that's an order of magnitude better than alternatives.