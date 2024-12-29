---
layout: post
title: Implementing an Async Runtime in Rust
date: 2024-12-05
categories: [Project]
tags: [rust, async]
---
In this article, we will walk through the design and implementation of my manual async runtime written in Rust.

This implementation avoids using any standard libraries except `std::sync::{Arc, Condvar, Mutex}` for shared ownership.

## What Is an Async Runtime?

An Async Runtime is an environment to execute asynchronous code, the runtime is needed because async tasks need to be managed and scheduled by a program. 

### Sync vs Async
- **Synchronous execution** runs code one after another, so each task must complete before the next one starts. This is the default behaviour of a program.
- **Asynchronous execution** allows tasks to concurrently, so each task does not need to wait for previous task to complete first. 

### Multithreading vs Async
**Multithreading** (e.g. using `thread::spawn` in Rust) is one way of achieving concurrent execution. Threads are created and managed by OS, each thread has its own stack and program counter, which can be simultaneously ran on different CPU cores. Within each thread, codes are executed synchronously, and any blocking I/O will block the thread till it completes. When there are more threads than CPU cores, OS will schedule these threads across the limited cores, and context-switch between threads (this is an expensive task as it involves copying the entire stack)

**Async** provides concurrency without involving the OS. Tasks are created and managed by the async runtime, and can be ran on a single thread. For single thread async, tasks can be seen as interweaved, so it is not true parallel execution (where two tasks are processed by the CPU at the same time). Because OS is not involved, context-switching is very fast, and many tasks can be spawned.

This Stack Overflow page explains it well: [What is the difference between asynchronous programming and multithreading?](https://stackoverflow.com/questions/34680985/what-is-the-difference-between-asynchronous-programming-and-multithreading).

---

## Async in Rust
This article is not a tutorial on Async Rust so we will only cover the basics here, the [Async Book](https://rust-lang.github.io/async-book/) is a great starting point for learning Async Rust.

The standard library of Rust does not provide an async runtime, and instead relies on [community-provided async ecosystems](https://rust-lang.github.io/async-book/08_ecosystem/00_chapter.html) to fill in these gaps. `tokio` is usually the go-to option, other options include `smol` or `async-std`. Some of the trade-off decisions on why Rust doesnt include a built-in runtime can be found in this video [Async Rust: the good, the bad, and the ugly - Steve Klabnik](https://youtu.be/1zOd52_tUWg?si=WgHFJ9WXVoAPerw-). 

In Rust, asynchronous programming is facilitated through the use of the `async` and `await` keywords, both of these are Rust syntatic sugar.

### `async` and `await`
Let's look at this example:
```rust
async fn foo() -> String {
    // Some IO tasks
    "bar".into() 
}

fn bar() -> impl Future<Output = String> {
    foo()
}
```

We can see here, by wrapping `foo()` with the `async` keyword, the return type of `foo()` is not `String`, but `Future<Output = String>`. This is a type that implements `std::future::Future` trait, with `Output = String`.

```rust
pub trait Future {
    type Output; // The type of value produced on completion

    // Required method
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output>;
}
```

The `Future` trait requires `poll` method to be implemented, below is Rust's documentation on what `poll` method is:

> The core method of future, `poll`, attempts to resolve the future into a final value. This method does not block if the value is not ready. Instead, the current task is scheduled to be woken up when it’s possible to make further progress by `poll`ing again. The `Context` passed to the `poll` method can provide a `Waker`, which is a handle for waking up the current task.
> 
> When using a future, you generally won’t call `poll` directly, but instead `.await` the value.

When a function calls `foo().await`, it will attempt the run foo() to completion. If foo() is not ready, the `poll` method will return `Poll::Pending` and yield control of the current thread, it also stores a clone of the `Waker` provided by the `Context`. This `Waker` is woken by event signals (e.g. through listeners on network i/o, file i/o etc.), and will attempt to call the `poll` method again, if it is ready, it will now return `Poll::Ready(val)`.

---

## Setting the Groundwork

Before diving into implementation, let's cover the basic components we need to build in order to achieve async execution:

- **Future:** because we don't use `std::future`, we will need our own implementation of `Future` trait 
- **Tasks:** this would be the struct we work with that wraps on structs implemented our `Future` trait
- **Executor:** this would manage running the async tasks
- **Waker:** we need a mechanism to wake up tasks when they are ready to make progress
- **Channel:** we need a simple channel to communicate the wake up signal

---

## Core Implementation
Our goal here is to build a minimal runtime that demonstrates the core principles. 

### `SimpleFuture`
Our `SimpleFuture` trait is very similar to the `std::future:Future` trait, with one main difference: in our `SimpleFuture`, we do not use `Pin` on self. `Pin<Self>` pin data to a location in memory and cannot be moved to a different location. This is mainly for simplicity as we are not dealing with complex scheduling / tasks.

```rust
pub trait SimpleFuture {
    type Output;
    fn poll(&mut self, ctx: &mut Context) -> State<Self::Output>;
}

pub enum State<T> {
    Pending,
    Ready(T),
}

pub struct Context {
    pub waker: Waker,
}
```

### `Task`
The `Task` struct is used internally by the `Executor` in its task queue. It wraps the future in a `Box` so the data is stored on the heap. This is because the size of the `SimpleFuture` trait object is not known at compiler time.

The `Output = ()` is an another simplication here. Because we are using the `Channel` to send data instead of directing returning, our `SimpleFuture` here doesn't need to return data.

```rust
pub struct Task {
    pub future: Box<dyn SimpleFuture<Output = ()>>,
}

impl Task {
    pub fn new(future: Box<dyn SimpleFuture<Output = ()>>) -> Self {
        Task { future }
    }
}
```

### `Executor`
The `Executor` is made up of a task queue and a `Condvar` notifier. 
- We store our tasks in the queue, and the main job of the `Executor` is to manage these tasks. 
- The `Condvar` (Conditional Variable) is used for putting the `Executor` to sleep when all tasks are pending.

There is a major downside of using `Condvar` here, as it blocks the current thread, meaning if we run the `Executor` on the main thread, it will block the main thread. It also means we cannot easily add new tasks to the `Executor` after it is started.

The benefit is it is a relatively simple implementation that avoids constant polling (this is something I aim to improve in future iteration).

```rust
pub struct Executor {
    queue: VecDeque<Task>,
    notifier: Arc<(Mutex<bool>, Condvar)>,
}
```

The `Executor` has 3 methods:
#### `spawn`
Takes a input that implements `SimpleFuture` and returns `()`. We need `f` to be `'static` lifetime because we are storing `f` in a `Box` (inside our `Task` struct), so we need to guarantee that `f` is valid for as long as it is stored (meaning it doesn't rely on references that might be deallocated when we pop the task from the queue and want to execute it).

If we are allowing spawning after calling `.run()`, we will need to add the code here to wake up the `Executor`.

``` rust
pub fn spawn<F>(&mut self, f: F)
where
    F: SimpleFuture<Output = ()> + 'static,
{
    self.queue.push_back(
        Task::new(Box::new(f))
    );
}
```

#### `wait`
Blocks the thread till receiving notification. The way to achieve this is to use `Condvar.wait(mutex_guard)` - this blocks the current thread until this condition variable receives a notification. This function will atomically unlock the mutex passed in and block the current thread. Any calls to `cvar.notify_one()` (from another thread) will wake this thread up, when this function call returns, the mutex lock will have been re-acquired.

```rust
fn wait(&self) -> Result<(), ()> {
    let (lock, cvar) = &*self.notifier;
    let mut notified = lock.lock().unwrap();
    while !*notified {
        notified = cvar.wait(notified).unwrap();
    }
    *notified = false;
    Ok(())
}
```

#### `run`
This is the main loop that runs tasks in queue to completion until there is no more tasks in the queue.

We pop tasks one by one from the queue, register a `Waker` function which calls the `cvar.notify_one()` in the `Context`, and then call the `poll` method for the task. If the task is not ready, we push the task back to a pending queue, and then call `self.wait()` to wait.

If we want our `SimpleFuture` to be able to return data, we could use a channel here for something like `State::Ready(data) => { Sender.send(data) }`.

```rust
pub fn run(&mut self) {
    while !self.queue.is_empty() {
        let mut pending_tasks = VecDeque::new();

        // Run each task in the queue
        while let Some(mut task) = self.queue.pop_front() {
            let waker = Waker::new(Arc::new({
                let notifier = self.notifier.clone();
                move || {
                    let (lock, cvar) = &*notifier;
                    let mut notified = lock.lock().unwrap();
                    *notified = true;
                    cvar.notify_one();
                }
            }));
            let mut ctx = Context::new(waker);
            match task.future.poll(&mut ctx) {
                State::Ready(_) => {}
                State::Pending => {
                    pending_tasks.push_back(task);
                }
            }
        }

        if pending_tasks.is_empty() {
            break;
        }
        // Wait for notification to wake up
        self.wait().unwrap();

        // Put the pending tasks back into the queue
        self.queue = pending_tasks;
    }
}
```
There are a lot of room for optimisation here, for example the use of a `pending_tasks` queue creates additional overhead, which should ideally be optimised. The main purpose of this project is to explore the underlying workings of async, not to provide a production ready async runtime, hence these optimisations are not done here.

### `Waker`
The `Waker` struct is very straightforward: it has a `wake_fn()`, which we can call `waker.wake()` to invoke it.

```rust
pub struct Waker {
    wake_fn: Arc<dyn Fn() + Send + Sync>,
}

impl Waker {
    pub fn new(wake_fn: Arc<dyn Fn() + Send + Sync>) -> Self {
        Waker { wake_fn }
    }

    pub fn wake(&self) {
        (self.wake_fn)();
    }
}
```

### `Channel`
The `Channel` provides a way to communicate to the `Executor` thread so we can call our `wake()` function.

We don't have a `Channel` struct here, instead we have a `Sender<T>` and a `Receiver<T>` here. This is similar to how you would use a `tokio` channel which by calling `tokio::sync::mpsc::channel(size)` also gives you back a pair of sender and receiver.

The choice of using generics here is so that this channel can be more generic purpose for sending both data and the `Task`.

Both `Sender` and `Receiver` share the same queue and the same `waker`(via `Mutex`).

```rust
pub fn channel<T>() -> (Sender<T>, Receiver<T>) {
    let queue = Arc::new(Mutex::new(VecDeque::new()));
    let waker = Arc::new(Mutex::new(None));
    let sender: Sender<T> = Sender {
        queue: Arc::clone(&queue),
        waker: Arc::clone(&waker),
    };
    let receiver: Receiver<T> = Receiver { queue, waker };
    (sender, receiver)
}

pub struct Sender<T> {
    queue: Arc<Mutex<VecDeque<T>>>,
    waker: Arc<Mutex<Option<Waker>>>,
}

pub struct Receiver<T> {
    queue: Arc<Mutex<VecDeque<T>>>,
    waker: Arc<Mutex<Option<Waker>>>,
}
```

The `Sender` has only a `send` method: it acquires the queue lock, push the data to the queue, takes the waker out and call `wake()`.

```rust
pub fn send(&self, value: T) {
    let mut queue = self.queue.lock().unwrap();
    queue.push_back(value);

    if let Some(waker) = self.waker.lock().unwrap().take() {
        waker.wake();
    }
}
```

The `Receiver` has two methods: 
- `try_recv` which acquires the queue lock and pop the data from the queue. In our simple implementation and usage, the `Sender` will not `send` very frequently, so the channel should not be blocked, and this `try_recv` method should return immediately.
- `register_waker` which acquires the waker lock, and set the waker.

```rust
pub fn try_recv(&self) -> Option<T> {
    let mut queue = self.queue.lock().unwrap();
    queue.pop_front()
}

pub fn register_waker(&self, waker: Waker) {
    let mut waker_slot = self.waker.lock().unwrap();
    *waker_slot = Some(waker);
}
```

### Putting It All Together
We can now have a simple task that implements our `SimpleFuture`, let's say this is a network I/O task that we are waiting for the response.

We use our `Channel` to send the data back, to simulate when we receive the data from the network call. And our `poll` method for this task will try receiving data from the channel, if there is no data, we register the waker provided by the `Context`.

```rust
struct IoTask {
    receiver: Receiver<String>,
}

impl SimpleFuture for IoTask {
    type Output = ();

    fn poll(&mut self, ctx: &mut Context) -> State<Self::Output> {
        match self.receiver.try_recv() {
            Some(data) => {
                println!("Received data: {}", data);
                State::Ready(())
            }
            None => {
                self.receiver.register_waker(ctx.waker().clone());
                State::Pending
            }
        }
    }
}
```

We can then create these tasks, note that we will need to use `thread::spawn` for our data sender as the main thread will be blocked by the `Executor`. This simulates the network return which is processed on a different CPU so our example should be valid here.

```rust
fn start_task(id: usize, duration: u64) -> IoTask {
    println!("Starting I/O task ... {}", id);
    let (sender, receiver) = channel::<String>();
    let task = IoTask { receiver };

    thread::spawn(move || {
        process_task(id, Duration::from_secs(duration), sender);
    });
    task
}

fn process_task(id: usize, duration: Duration, sender: Sender<String>) {
    thread::sleep(duration);
    let data = "Task id: ".to_string() + &id.to_string() + " completed, process time: " + &duration.as_secs().to_string() + " seconds";
    sender.send(data);
}
```

Finally our main function to call the `Executor`.

```rust
fn main() {
    let mut executor = Executor::new();
    executor.spawn( start_task(1, 1) );
    executor.spawn( start_task(2, 3) );
    executor.spawn( start_task(3, 2) );
    executor.spawn( start_task(4, 3) );
    executor.run();
}
```

When we run this example, we get the following console logs:

```zsh
Starting I/O task ... 1
Starting I/O task ... 2
Starting I/O task ... 3
Starting I/O task ... 4
Executor is waiting
Waker is called
Received data: Task id: 1 completed, process time: 1 seconds
Executor is waiting
Waker is called
Received data: Task id: 3 completed, process time: 2 seconds
Executor is waiting
Waker is called
Waker is called
Received data: Task id: 2 completed, process time: 3 seconds
Received data: Task id: 4 completed, process time: 3 seconds
```

We can see that when the data is received, the `Executor` wakes up, process the task (and we get the data in the `Received data` print), and then go back to waiting.

---

## Future Exploration

Below are a list of features we can include in our future enhancement:
- Integrate with the `Future` from the standard library so we can handle `async` and `await` keywords
- Add event listeners for I/O (like tokio's `TCPlistener`)
- Use `threadpool` to allow multithreading
- Use scheduler rather than `Condvar`

---

## Conclusion

This project helped me build up a good understanding of what's behind the scene for handling async tasks, the learning is useful when I write async codes using libraries such as `tokio`. I now understand when I call `tokio::spawn()`, what is `tokio` doing behind the scene, why it takes an `async` block, what does it do with the block provided, when I call `.await` what happens, etc.