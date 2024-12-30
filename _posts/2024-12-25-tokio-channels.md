---
layout: post
title: Tokio Channels
date: 2024-12-25
categories: [Concepts]
tags: [rust, tokio, async]
---
This article provides a practical introduction to `tokio` channels covering `oneshot`, `mpsc`, `broadcast` and `watch` channels, illustrates how to use them with examples, and highlights key considerations. 

It also shares helpful resources and insights from a personal learning journey, making it a great guide for anyone exploring Async Rust.

## What is `tokio`

`Tokio` is one of the most popular asynchronous runtime in Rust, at the time of writing, `tokio` has in total 255,174,159 downloads, and the next most downloaded async runtime crate `async-std` has 32,616,918. 

We are using `tokio` because Rust does not have built-in async runtime, it relies on community projects to provide the implementation. There are a lot of controversy on this topic, as different libraries could use different runtimes, and writing runtime-agnostic async codes requires additional layers and handlings (this is probably why we are seeing `tokio` being so dominant, which kind of defeat Rust's original purpose of not providing built-in async, i.e. to give choices).

`Tokio` provides a framework for running async codes, below is how the `tokio` team describes its core components:

> Tokio is an asynchronous runtime for the Rust programming language. It provides the building blocks needed for writing networking applications. It gives the flexibility to target a wide range of systems, from large servers with dozens of cores to small embedded devices.
> At a high level, Tokio provides a few major components:
> - A multi-threaded runtime for executing asynchronous code.
> - An asynchronous version of the standard library.
> - A large ecosystem of libraries.

Note that `tokio` is a **multi-threaded** runtime, meaning we will need to use `Arc`, `Mutex` or `RwLock`, and declare `Send + Sync` whenever we are working with `tokio` as we need to guarantee multi-thread safety, we will cover this when we look at the usage of channels.

---

## What is `channel`

A `channel`, as you can guess from the name, is a mechanism that allows you to send data between async tasks.

### Why `channel`
Suppose we want to spawn two async tasks, both wanted to do something with the `data`, the below code won't compile because `data` is moved into the async block in `t1`, and trying to access it again in `t2` would require shared ownership or copying the data (this requires `SomeData` to implement the `Copy` trait, and copying data in many places is usually not a good solution).

```rust
let mut data = SomeData::new();
let t1 = tokio::spawn(async move {
    do_something(&mut data, 1).await;
});

let t2 = tokio::spawn(async move {
    do_something(&mut data, 2).await;
});
```

#### Using `Arc` and `Mutex` instead of `channel`
We can use `Arc` and `Mutex` to achieve shared ownership and make this code compiles:

```rust
let data = Arc::new(Mutex::new(SomeData::new()));
let data_clone = Arc::clone(&data);

let t1 = tokio::spawn(async move {
    let mut data = data_clone.lock().await;
    do_something(&mut data, 1).await;
});

let data_clone = Arc::clone(&data);
let t2 = tokio::spawn(async move {
    let mut data = data_clone.lock().await;
    do_something(&mut data, 2).await;
});
```

This can be a solution in some cases if we want shared ownership on `data`: both `t1` and `t2` have an `Arc` pointer pointing to the 42 which is guarded by the `Mutex`, when they need to mutate the data they need to acquire the `lock` and deference to access the data wrapped inside the `Mutex`.

But in many cases, we might not want shared ownership on the data. 

Let's say both task 1 and task 2 were to write to the websocket, we wouldn't want to share the websocket's ownership here. Here we can use a `channel` to send the data we want to write across to a single writer, so our writer has exclusive access to the websocket (although it's worth noting that `tokio` still uses `Arc`, `Mutex`, `RwLock` behind the scene for the data we send as it is multi-threaded by default)

---

## Using `channel`
Here we use a `mpsc` (Multi-Producer, Single-Consumer) channel, and spawned a dedicated task `t1` to manage the mutation of data. Now any tasks wanting to mutate the data can send a message through the `channel` to task `t1`, and `t1` will process them one by one.

This is a better solution because now we have make `t1` to have exclusive access to `data`, avoiding the use of `Mutex` which could lead to the possibility of a deadlock (e.g. thread A locks `mutex1` and now try to acquire `mutex2`, but `mutex2` is locked by thread B which tries to acquire `mutex1`, they will now be staring at each other for eternity 😅).

```rust
let (tx, mut rx) = mpsc::channel(32);
let mut data = SomeData::new();

let t1 = tokio::spawn(async move {
    while let Some(ctx) = rx.recv().await {
        do_something(&mut data, ctx).await;
    }
});

let tx_clone = tx.clone();
let t2 = tokio::spawn(async move {
    tx_clone.send(1).await.unwrap();
});

let tx_clone = tx.clone();
let t3 = tokio::spawn(async move {
    tx_clone.send(2).await.unwrap();
});
```

This is also more scalable, we can do something like this:

```rust
tokio::spawn(async move {
    for i in 0..10 {
        tx.send(i).await.unwrap();
    }
});
```

### Taking a closer look
Now let's take a closer look at the example above.

First we created a `mpsc::channel` with buffer size 32, this returns a `tx` (`mpsc::Sender<T>`) and a `rx` (`mpsc::Receiver<T>`). This channel will buffer messages sent by the `Sender` up to 32 (if buffer is full, calling `send()` will block the sender till the `Receiver` receives messages). 

We then move the ownership of `data` and `rx` to `t1` task. Note that we cannot call `clone()` for `rx`, this is because we are working with `mpsc` channel here which allows only single consumer (we will cover the `broadcast` channel which allows multiple consumers later).

```rust
let (tx, mut rx) = mpsc::channel(32)
```

We call `.recv()` here, which returns the data when the sender sends. Note that the `.recv()` method is a blocking call: as long as the `channel` is not closed, this method will sleep until there is a new message. The `Receiver` struct has other methods like `.try_recv()` which returns `TryRecvError::Empty` instead of blocking, or `.recv_many()` which receives messages in batches (size specified by the `limit` parameter passed in), appends to the `buffer` (which is a `Vec`), and then return the number of messages received.

```rust
let t1 = tokio::spawn(async move {
    while let Some(ctx) = rx.recv().await {
        do_something(&mut data, ctx).await;
    }
});
```

Finally, we clone the `Sender` (because it is multi-producer, this is allowed) and call the `.send()` method to send data.
```rust
let tx_clone = tx.clone();
let t2 = tokio::spawn(async move {
    tx_clone.send(1).await.unwrap();
});
```

---

## Types of `tokio` `channel`

There are four types of `channel` offered by the `tokio` library.
- `oneshot`: a one-shot channel is used for sending a single message between asynchronous tasks.
- `mpsc`: a multi-producer, single-consumer queue for sending values between asynchronous tasks.
- `broadcast`: a multi-producer, multi-consumer broadcast queue.
- `watch`: a multi-producer, multi-consumer channel that only retains the last sent value.

### `oneshot`
A `oneshot` channel is a single-product single-consumer channel for sending a **single** message. Below is a usage example provided by the `tokio` library:

```rust
let (tx, rx) = oneshot::channel();

tokio::spawn(async move {
    if let Err(_) = tx.send(3) {
        println!("the receiver dropped");
    }
});

match rx.await {
    Ok(v) => println!("got = {:?}", v),
    Err(_) => println!("the sender dropped"),
}
```
This is a straightforward example, we send 3 from `tx` to `rx`, looks easy!

Now there are a few of interesting points worth highlighting:
- we directly call `rx.await` instead of `rx.recv()`: this is because the `Receiver` itself [implements the Future trait](https://docs.rs/tokio/latest/src/tokio/sync/oneshot.rs.html#1095), so we can use the `await` keyword directly on `rx`.
- we did not use `.await` keyword when we call `tx.send()`: this is because the `oneshot::Sender`'s send method is not marked as async, reason being there is only one sender, one receiver, and one message here, so there is nothing that needs waiting.
- if we take a closer look at the `send()` signature of `oneshot::Sender`, `pub fn send(self, t: T)`, we can see it consumes `self`, so only one value can ever be sent on the channel, and after that the `Sender` will be dropped.

### `mpsc`
We have covered `mpsc` channel in previous sections, this is a channel allowing multi-producer, single-consumer.

There are two variants, `bounded` and `unbounded`, we can create them by calling `mpsc::channel` and `mpsc::unbounded_channel`. 

The considerations here:
- do we want to limit the number of messages we stored in the channel buffer, with a downside that if the channel is full, our `send()` (which normally wouldn't block) will be blocked until our `Receiver` start receiving the next message
- or, do we want to make sure our `send()` method never block, but risk consuming unexpected amount of memory if the receiver is not able to work fast enough (or maybe it was blocked)

Worth noting that the `Sender` returned by `mpsc::unbounded_channel` is an `UnboundedSender`, if we take a look at its implementation of `.send()`, `pub fn send(&self, message: T)`, we can see it is not an async function, this means we can use the `UnboundedSender` in our sync code, but we cannot do that with our `Sender.send()` (we can use `blocking_send()` instead if we need to send from sync code to async code with a bounded channel).


### `broadcast`
A `broadcast` channel is a multi-producer, multi-consumer channel, this means we are allow to have multiple `Sender` and `Receiver`. 

#### Creating new `Receiver`
For getting a new `Receiver`, you don't call `clone`, but instead you should call `subscribe` on the `Sender` to get a clone of a `Receiver`.

You may wonder why we cannot just call `.clone()`? There is a reason for this (not because folks in the `tokio` team wanted to make our lives difficult 😅). When we call `subscribe`, we are not really getting a **clone** of an existing `Receiver`, we are getting back a new `Receiver`. If we take a closer look at the `Receiver` struct:

```rust
// broadcast::Receiver
pub struct Receiver<T> {
    /// State shared with all receivers and senders.
    shared: Arc<Shared<T>>,
    /// Next position to read from
    next: u64,
}
// mpsc::Receiver
pub struct Receiver<T> {
    /// The channel receiver.
    chan: chan::Rx<T, Semaphore>,
}
```
We can see that the `broadcast::Receiver` has a state `next` specific to its position in the message queue. When we call `subscribe`, the new receiver is produced with next pointing to the tail of the message queue.

This means the new `Receiver` we get back will only receive messages sent after its creation. If we first have the `Sender` sends message, and then subscribe to create `Receiver`s, if we call the `recv()` on these receivers, we will not get back the message, and this will block until our `Sender` sends another message.

#### Dropping Message
Another thing worth mentioning is how message is removed from the queue for `broadcast` channel versus `mpsc` channel.

In `mpsc` channel, because we only have one `Receiver`, it is nice and simple: once it consumes the message, the message will be removed from the queue.

In `broadcast` channel, because there are many consumers, each of each tracks its own position in the queue, only if all the consumers have consumed the message will the message be removed. 

It is entirely possible that we could have one `Receiver` lagging behind in a `broadcast` channel, which will quickly fill up our precious memory if the channel is unbounded. That is why we don't have `unbounded_channel` for `broadcast` like we do for `mpsc`. 

The size of the `broadcast` channel is the hard cap of how many values we can retain in the channel. Unlike the size for `mpsc` which blocks the `Sender` from sending, the size for `broadcast` does not block when filled up. Instead, it will release the oldest message from the queue to free up space for the new message. If the lagged `Receiver` now wants to receive the message (which is now released), it will return `RecvError::Lagged` and update this `Receiver`'s pointer to point to the oldest message in the queue.

### `watch`
A `watch` channel is also a multi-producer, multi-consumer channel like `broadcast`. 

Unlike `broadcast`, a `watch` channel only stores the most recent value. When we create the channel with `watch::channel()`, we need to pass in the initial state, and each `Receiver` keep track of its last observed version.

If we take a closer look at the `Shared<T>` struct for `watch` vs `broadcast`, we can see inside `watch` channel we are storing a `value` guarded by a `RwLock`, with reference counters, while inside a `broadcast` channel we are storing a slice of `Slot<T>` objects.
```rust
// watch::Shared<T>
struct Shared<T> {
    /// The most recent value.
    value: RwLock<T>,

    /// The lowest bit represents a "closed" state. The rest of the bits
    /// represent the current version.
    state: AtomicState,

    /// Tracks the number of `Receiver` instances.
    ref_count_rx: AtomicUsize,

    /// Tracks the number of `Sender` instances.
    ref_count_tx: AtomicUsize,

    /// Notifies waiting receivers that the value changed.
    notify_rx: big_notify::BigNotify,

    /// Notifies any task listening for `Receiver` dropped events.
    notify_tx: Notify,
}
// broadcast::Shared<T>
struct Shared<T> {
    /// slots in the channel.
    buffer: Box<[RwLock<Slot<T>>]>,

    /// Mask a position -> index.
    mask: usize,

    /// Tail of the queue. Includes the rx wait list.
    tail: Mutex<Tail>,

    /// Number of outstanding Sender handles.
    num_tx: AtomicUsize,
}
```

Because there is no more queue, we don't call `recv()` from `Receiver` when we want to get data, instead we use `borrow_and_update()` or `borrow()`. Both methods returns a reference to the latest value, the difference is `borrow_and_update()` will mark the value as seen while `borrow()` wouldn't. Note that both methods are not marked as `async` so we can call them in sync codes.

One thing worth mentioning here is, because the inner data is guarded by a `RwLock`, the call to `borrow` will acquire the read lock, which blocks the `Sender` to get the write lock to update the data. So we should keep the borrow as short-lived as possible to avoid blocking the value from being updated. The tokio library documentation provided some examples of [potential deadlock scenarios](https://docs.rs/tokio/latest/tokio/sync/watch/struct.Receiver.html)

We can call `changed()` from `Receiver` which blocks and waits for a change, when there is a change, it will marks that as seen and return.

The `wait_for()` method is a useful method as well. It takes a closure that returns a `bool` as the condition, and waits for a value that satisfies this condition (behind the scene, the method calls the provided closure for the current data, and then repeat this whenever there is a new data). If the closure returns `true`, this method will return the value that met the condition.

For example, we can call `rx.wait_for(|&state| state > 5)`, this will block until we receive a state that is greater than 5.

One caveat here is, if the messages are sent to the channel faster than the `wait_for()` method is able to call the provided closure (for example, if the closure condition requires significant computation, and we receives data very very frequently), it may skip some updates.

## Conclusion

The `channel`s provided by `tokio` library are a set of very powerful tools, allowing us to handle concurrent programming tasks with ease. 

We can use the `oneshot` channel to create a one-time communication, for example, if our server needs to perform a background task and notify the main task when the work is done.

The `mpsc` channel has a wide range of use cases, for example when we want to log messages and persist that to a file, we can have many senders from different places sending the log messages to a `mpsc` channel, and one dedicated logger task that receives the message and handle the file writing. We can also use `mpsc` for consolidating computation results, say we are extracting features from a data set into a feature set, we can spawn tasks that perform the computation and send the data back via a `mpsc` channel, and then a consolidator that receives the message into a feature set data.

The `broadcast` channel can be used for event broadcasting, for example if we are building a multi-user chat group, and we want to broadcast the message sent by one user to everyone. We can also use it to achieve single sender, multiple consumer design: say we have some tasks that we want to distribute to a group of workers, we can use a `broadcast` channel to achieve this.

The `watch` channel can be used to when we want to keep a single state updated, with all subscribers receiving the update and have access to the latest state. For example, say we have a config file for our web server for things like rate limit or db connection settings, and we have multiple worker tasks that need to respond to these changes, we could have the config manager task sends updates to a `watch` channel, and each worker tasks subscribe to the channel and updates its internal state whenever a change is published.

---

## Resources

- [Official Tutorial](https://tokio.rs/tokio/tutorial)