---
layout: post
title: Pin and Unpin in Rust
date: 2025-06-02
categories: [Concepts]
tags: [rust, async]
---
I was motivated to write about `Pin` and `Unpin` as it was (and still is) a very confusing topic in Rust, hope this article can provide some clarity on these two concepts.

## Overview
The `Pin<Ptr>` pointer and the `Unpin` trait are one of the (many) confusing topics in Rust. While the [Rust standard library](https://doc.rust-lang.org/std/pin/index.html#) offers an excellent explanation of `Pin` and `Unpin` with great amount of details, I believe there's still value in writing this article to walk through these two concepts, in order to understand how they work and go through some of the confusing elements.

## What is `Pin` and `Unpin`
The concept of 'pinning' is quite easy to understand at a high level: we `pin` a value to a memory location, and we guarantee it will not be `move`d out of that location during its lifetime. 

But to have a better understanding on these two concepts, it's important to first understand what we mean by `move`, why and when a value would `move` in its memory location. 

### `move`
We actually experience `move` very often in Rust as this is generally speaking a trivial task, and the compiler is permitted to move value in many situations (unless the struct specifically opt out of `Unpin` which we get to in later part of the article).

Consider the following simple example:
```rust
fn consume(val: String) {
    println!("{}", val);
}

fn main() {
    let s = String::from("hello");
    consume(s);
}
```
The string value is moved as we transfer the ownership to the `consume` function (when we passed it in as `String`).

We can validate the address is moved with a helper function:
```rust
fn addr<T>(val: &T) {
    println!("location: {:p}", val);
}

fn consume(val: String) {
    addr(&val);
}

fn main() {
    let s = String::from("hello");
    addr(&s);
    consume(s);
}
```
Running this we will get this console log, and we can see the memory address changed after we transfer the ownership of our String.
```zsh
location: 0x1f00
location: 0x1ee8
```

Another common example is `Vec<T>` reallocation - when a `Vec` grows in size, it can move all its elements to a new memory location. This is because when we push new elements to the `Vec`, if it uses up all the buffer (so all the heap allocated memory is used up for this `Vec`), we will need to move it to a new location in the heap where we have enough capacity to handle the larger `Vec` (expanding it). Consider this example:
```rust
fn main() {
    let mut vec = Vec::new();
    for i in 0..20 {
        vec.push(i);
        let ptr = vec.as_ptr();
        println!("After pushing {}, vec is at: {:p}", i, ptr);
    }
}
```
Running this we get this log, so we can see memory reallocation occurs when our `Vec` reaches certain sizes (that's when the length of the `Vec` reaches its buffer's capacity).
```zsh
After pushing 0, vec is at: 0x1050
...
After pushing 7, vec is at: 0x1050
After pushing 8, vec is at: 0x10c0
...
After pushing 15, vec is at: 0x10c0
After pushing 16, vec is at: 0x1e60
...
```

Last example on `move` is the use of `move` keyword in async block (`async move`). Understanding this one helps us get better understanding of why we sometimes need to `Pin` in async (we will cover this in later part of the article). 

The below code would look very familiar if we ever write any async codes in Rust:
```rust
tokio::spawn(async move { ... });
```

We might wonder why we need the `move` here. When we write `async` block, the compiler auto generates code for a state machine to manage the async task, it looks something like this:
```rust
struct MyFuture { val ... }

impl Future for MyFuture {
    type Output = ...;
    fn poll(...) -> Poll<Self::Output> { ... }
}
```

Because Rust futures are lazy (only runs when `.await`ed), it's very possible when we await the future, the value has been dropped, leading to a use-after-free issue. 

To prevent that, our compiler requires us to `move` the ownership of the value to the async block, so we can be certain that when we await the future (calling the poll method), our async task has all the data available.

### `Pin`, `Unpin`
We spent a lot of time understanding the `move` concept, now it's time we go back to our main topic `Pin` and `Unpin`.

To create a pinning `Box` pointer, we can simply use `Box::pin()`.
```rust
Box::pin(something);
```

`Pin` always wraps on a pointer, this is the first confusing point around `Pin`. While it wraps on a pointer, it does not pin the pointer, instead it pins the pointee (the value pointed by the pointer), the Rust standard library refer to a `Pin<Ptr>` as a **pinning pointer**. So we are free to move the pointer, we just cannot move the pointee.

The second confusing point is on the `Unpin` trait. When a type implements the `Unpin` trait, wrapping it with a pinning pointer does **not** do anything! And to add more confusion to the picture, this `Unpin` trait is an auto trait, meaning it is automatically implemented for all types unless we explicitly opt out of it!

We might wonder why it needs to be designed in this way. The main reason is so that when an API requires some types to be pinned, it can require the `Pin` wrapper, and only those that really needs to be pinned (which we explicitly opt out, this is covered in later part of the article) will be restricted by the `Pin` wrapper, other types that implements `Unpin` can be freely moved even with a `Pin` wrapper, which both satisfy the API requirement, and also doesn't impose unnecessary restriction.

### 'Self-Referential' Struct
Now let's talk about Why do we need to `Pin`, in other words, why some values are memory address sensitive.

The standard library documentation uses 'self-referential' struct (a struct with a pointer to its own data) as example to explain the need for pin. Consider a struct like this:
```rust
struct SelfRef {
    data: u8,
    ptr: *const u8,
}
```

This struct has a raw pointer (`*const`) to a `u8`, when constructing it, we can make this pointer points to the data field, effectively creating a 'self-referential' struct.

Our trusty Rust compiler normally doesn't allow us to mess around with memory even for a struct like this, but we can try to show what could happen with this:
```rust
impl SelfRef {
    fn new(data: u8) -> Box<SelfRef> {
        let mut s = Box::new(SelfRef {
            data,
            ptr: std::ptr::null(),
        });
        let slice_ptr = &s.data as *const u8;
        s.ptr = slice_ptr;
        s
    }
}

fn main() {
    let mut self_ref = SelfRef::new(42);
    println!("data address: {:p}, ptr points to: {:p}", &self_ref.data, self_ref.ptr);
    let self_ref = std::mem::replace(&mut *self_ref, SelfRef {
        data: 100,
        ptr: std::ptr::null(),
    });
    println!("after replace, data address: {:p}, ptr points to: {:p}", &self_ref.data, self_ref.ptr);
}
```

When we run this, we get this console log:
```zsh
data address: 0x1458, ptr points to: 0x1458
after replace, data address: 0x1688, ptr points to: 0x1458
```

This is very interesting, here's what happened: when we call `mem::replace`, we move a new `SelfRef` struct to the memory location of our original struct, this function returns the old `SelfRef` struct, which now lives in a different address `0x1688`. However, nobody told our pointer `ptr` about this! As a result, it is still pointing to the original memory address `0x1458`, which is now owned by the new `SelfRef`. If we drop the new `SelfRef`, we will get ourselves a dangling pointer!

### 'Self-Referential' in Async Rust
We might wonder if there's a more practical example of such self-referential struct, as the example in previous section does not look too useful in practice, and having these whole `Pin` thing for such a niche use case feels strange.

Actually we encounter it very frequently when we write async codes! Remember in the `move` section above, we talked about an auto generated state machine when compiler needs to handle async task? This is where we can have such self-referential types. 

When we await a future, before yielding control, our async task need to store the stack frame internally (so we can resume the task later), this means any pointers pointing to these data will be pointing internally, so these compiler generated state machines can have pointers referencing another internal data (i.e. a self-referential struct)! When the task resumes, these pointers would assume the address are still valid and continue from there, but if it was moved, we will end up with Undefined Behavior.

```zsh
[1. Calling an async function which returns a state machine `impl Future`]
  ┌───────────────┐
  │ Future struct │  ← freely movable
  └──────┬────────┘
         │
         ▼
[2. Calling the poll method for the first time]
  ┌────────────────────────────┐
  │ self-references stored     │
  │ internal pointers created  │ ← now address-sensitive
  └────────────┬───────────────┘
               │
               ▼
[3. Subsequent calls to poll]
  ┌──────────────────────────────┐
  │ assumes address is stable    │ ← moving this = Undefined Behavior!
  └──────────────┬───────────────┘
                 │
                 ▼
[4. Drop after Future is ready]
  ┌──────────────────────────────┐
  │ internal cleanup happens     │
  │ pointers released            │
  └──────────────────────────────┘
```

Because of this reason, the `poll` method's signature includes the `Pin` wrapper:
```rust
fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output>
```

The `Pin` here provides the guarantee that from the moment we first call `poll`, our `Future` is pinned.

## How to use `Pin` and `Unpin`
We have covered the concept of `Pin` and `Unpin` and gave some examples of when they are useful, now let's dive into how to use `Pin` and `Unpin`.

### `Pin::new()` vs `Pin::new_unchecked()`
The `Pin::new()` method can be very confusing to use, if we look into the code:
```rust
impl<Ptr: Deref<Target: Unpin>> Pin<Ptr> {
    pub const fn new(pointer: Ptr) -> Pin<Ptr>
    // .. //
}
```

The `new` method is only implemented for type `Ptr` which implements `Deref<Target: Unpin>`, meaning only for pointers that dereference to a type that implements `Unpin`, but we also know that `Pin` does not apply to types that implements `Unpin`, why would we want to create a `Pin` on a pointer pointing to `Unpin` if we know it doesn't do anything !?

As we mentioned before, there might be APIs that require a `Pin<T>` arg but our struct isn't memory address sensitive. Because our struct auto implements `Unpin`, we can safely wrap that with a `Box` and then wrap that with a `Pin` (so the `Ptr` which is `Box` here can `Deref` to a target that implements `Unpin`), and this has no effect on our code.

When we actually need to construct a `Pin`, we would need to use the `unsafe` method called `new_unchecked`:
```rust
impl<Ptr: Deref> Pin<Ptr> {
    pub const unsafe fn new_unchecked(pointer: Ptr) -> Pin<Ptr>
    // .. //
}
```

As we can see here, unlike `Pin::new()`, the `Pin::new_unchecked()` method is actually implements for any types that implements `Deref`, meaning if a pointer dereferences to a type that does not implement `Unpin` (and hence is pinnable), we can use this method to create the `Pin<T>`.

This is `unsafe` because the compiler does not know if the data pointed to by `pointer` is pinned, therefore it's us the programmer's job to make sure that is the case, and we need the `unsafe` block for that.

The more common (and safe) way to do this is via the `Box::pin()` method, which wraps our struct in a `Pin<Box<T>>` wrapper, if we look into `Box::pin()`, we can see it's also calling the `new_unchecked()`:
```rust
pub fn pin(x: T) -> Pin<Box<T>> {
    Box::new(x).into()
}

pub fn into_pin(boxed: Self) -> Pin<Self>
where
    A: 'static,
{
    unsafe { Pin::new_unchecked(boxed) }
}
```

### Opting out of `Unpin`
We have gone through a lot about wrapping things in `Pin`, but we never talked about how we opt our struct out of `Unpin` so the `Pin` can actually do the magic.

To mark our struct as not `Unpin`, we need to use one of the marker types `PhantomPinned`.
```rust
struct PinStruct {
    _pin: std::marker::PhantomPinned,
}
```

This marker type implements `!Unpin`, which means it does not implement `Unpin`, and having such marker in our struct makes our struct also opt out of `Unpin`. As a result of that, we can have our struct wrapper with `Box::pin()` and be sure that it won't move in memory.

### How does `Pin` achieve the pinning
The last question we have is, how exactly does `Pin` guarantee the memory doesn't get moved? What is the magic behind the scene?

We should first think about how do we move a struct that's wrapped on a pointer (say a `Box`)? In order to access that struct, we need to dereference our pointer and get a mutable borrow (`&mut *my_box`). This is using the `DerefMut` trait which is implemented for `Box<T>`:
```rust
impl<T: ?Sized, A: Allocator> DerefMut for Box<T, A> { .. }
```

Now let's look at what is implemented for `Pin<T>`:
```rust
impl<Ptr: DerefMut<Target: Unpin>> DerefMut for Pin<Ptr> { .. }
```

Oh! We can see the `DerefMut` is only implemented for when the `Target: Unpin`. In other words, only when `T` implements `Unpin` (meaning we don't care about memory address for `T`) we can mutably borrow `T` that is wrapped in `Pin<Box<T>>`!

We can try our previous self-referential struct example again but this time make our `SelfRef` struct opt out of `Unpin`:

```rust
struct SelfRef {
    data: u8,
    ptr: *const u8,
    _pin: std::marker::PhantomPinned,
}
impl SelfRef {
    fn new(data: u8) -> Pin<Box<SelfRef>> {
        let mut s = Box::new(SelfRef {
            data,
            ptr: std::ptr::null(),
            _pin: std::marker::PhantomPinned,
        });
        let slice_ptr = &s.data as *const u8;
        s.ptr = slice_ptr;
        unsafe { Pin::new_unchecked(s) }
    }
}

fn main() {
    let mut self_ref = SelfRef::new(42);
    let self_ref = std::mem::replace(&mut *self_ref, SelfRef {
        data: 100,
        ptr: std::ptr::null(),
        _pin: std::marker::PhantomPinned,
    });
}
```

This time our code won't compile, and we get this error:
```zsh
error[E0596]: cannot borrow data in dereference of `Pin<Box<SelfRef>>` as mutable
  --> src/main.rs:23:38
   |
23 |     let self_ref = std::mem::replace(&mut *self_ref, SelfRef {
   |                                      ^^^^^^^^^^^^^^ cannot borrow as mutable
   |
   = help: trait `DerefMut` is required to modify through a dereference, but it is not implemented for `Pin<Box<SelfRef>>`
```

We can no longer borrow our data as mutable because it's wrapped in `Pin<Box<T>>`, so effectively the `Pin` gated the mutation which achieves the effect of pinning the pointed value in place!

## Conclusion
In this article, we have gone through `Pin` and `Unpin` in quite some details, `Pin` is used for gating the mutable borrow to the pointer's pointed data, achieving the goal of making the memory in place. Most types implements an auto trait `Unpin` making them immutable to `Pin`, and only when we really need to pin the data, we use a marker type to make our struct opt out of `Unpin`. There are still a lot more on this topic we haven't covered, including some very useful crates such as `pin_project`, but those are topics for another day.

These two concepts remain one of the most confusing elements in Rust (I think partially because of the `Unpin` trait naming), but hopefully next time when we see something like `where Self: Unpin` or `Pin<Box<dyn Future<Output = .. >>>`, they can start to make more sense to us :)