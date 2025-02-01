---
layout: post
title: Building a Concurrent Task Runner in Rust
date: 2025-02-01
categories: [Projects]
tags: [rust, async, generics]
---
In this article, we will walk through the design and implementation of a flexible and type-safe async task runner I designed and implemented using Rust generics and `tokio` channels.

---

## Overview

In this project [run-task](https://github.com/jasonshyang/run-task), I set out to build a concurrent task runner that can distribute the workloads efficiently while maintaining type safety and flexibility.

My goal is to design a library that:
- can run data tasks with **any input/output** data types, **repeatedly** at a specified interval
  - such as running timeseries analysis, pre-processing data, forming an analytic pipeline
- can run these tasks **concurrently** and **efficiently**
- **allow update** of the underlying input data while running the tasks, **without memory safety issues**

The solution centers around two key pillars: **generics** for compile-time polymorphism, **tokio runtime** for concurrent processing.

Let's get into the details!

## Modelling Tasks

### `Runnable` trait
The `Runnable` trait is at the heart of the `run-task` library, which defines the contract for all tasks in the system.

```rust
pub trait Runnable<Input, Output>: Send + Sync {
    fn name(&self) -> String;
    fn run(&self, data: &Input, start: u64, end: u64) -> Result<Output, TaskError<Output>>;
}
```

Here, `Input` and `Output` are generic type parameters, allowing the implementer to define concrete data types with minimal bound (we still need `Send` and `Sync` as we are using `tokio::channels`). This allows it to support wide variety of tasks with different input/output types, making it flexible and reusable.

For example:
```rust
struct CorrelationCalculator;

impl Runnable<(Vec<f64>, Vec<f64>), f64> for CorrelationCalculator {
    fn name(&self) -> String { "correlation_calculator".to_string() }

    fn run(&self, data: &(Vec<f64>, Vec<f64>), start: u64, end: u64) -> Result<f64, TaskError<f64>> { }
}
```

The `start` and `end` will be provided by the `Runner` while running the tasks on a specified interval, the implementer can utilize them if required (e.g. for aggregating timeseries data).

The `name()` method provides a human-readable identifier for the task, which is used in the output dataset labelling.

I choose to make the `run()` method `sync` instead of `async` for the following reasons:
- the tasks should be computational activities (e.g. aggregating data, running algo)
- the tasks should not involve long running operations (such as file I/O), making the `run` a sync method conveys the message to the user
- the `Runner` needs to consolidate all the `Runnable` tasks before moving to the next interval, if we allow task to `await`, the `Runner` can be blocked for generating the next interval

### `Worker` struct
The `Worker` struct wraps a `Runnable` task and a `TaskContext`, which is responsible for running the `Runnable` in a dedicated `tokio::spawn` task.

```rust
pub struct Worker<Input, Output> {
    task: Arc<dyn Runnable<Input, Output>>,
    ctx: TaskContext<Input, Output>,
}
```

I choose to use dynamic dispatch on `task` for the following reasons:
- the `Runner` only instantiates the `Runnable` tasks at the beginning, considering we are interested in running these tasks repeatedly over a long period of time, the overhead of dynamic dispatch is amortized to be very minimum
- if we use generics here, given each `Worker` will have its own task, we will increase the binary size (as Rust will need to implement concrete `Worker` for each generics) for very minimum performance gain

The `Worker` struct provides a `run()` method to orchestrates the task execution.

```rust
    pub async fn run(
        &mut self,
        mut shutdown_rx: broadcast::Receiver<()>,
        timeout_secs: u64,
    ) -> Result<(), TaskError<Output>> {
        // ...

        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    // graceful shutdown ...
                }
                result = self.ctx.receiver.recv() => {
                    match result {
                        Ok((start, end)) => {
                            debug!(start = %start, end = %end, "Processing time window");
                            
                            let data = match time::timeout(timeout_duration, self.ctx.data.read()).await {
                                // ...
                            };

                            match self.task.run(&*data, start, end) {
                                // send result via self.ctx.sender.send() ...
                            }
                        }
                        Err(e) => {
                            // ...
                        }
                    }
                }
            }
        }
    }
```
- **Graceful shutdown**: each `Worker` carries a `Receiver<()>` used solely for shutdown purpose
- **Signal to start task**: `Worker` gets signal via `ctx.receiver` which is a `(u64, u64)`, it serves the purpose of signalling `Worker` to start work, and to give the start and end of the time interval for the `Runnable` task to use in computation
- **Result sent via channel**: after calling the `run()` method passing in the data (which is wrapped in `Arc` and `RwLock`), the result is sent back via a broadcast channel
- **Timeout handling**: added timeout to avoid deadlock while acquiring the read lock on `ctx.data`

To cover the rationale for a few design choices:
- The `shutdown` signal is sent via a dedicated channel instead of the `self.ctx.receiver` for faster shutdown response (if the `Worker` is blocked on reading, the shutdown signal will not be received).
- Using `broadcast` channel instead of `mpsc` channel as each `Worker` is running in a separate spawned `tokio` task, so the signal is going from the central `Runner` to distributed `Worker`s, hence it is single producer multi consumer, and a `broadcast` channel is appropriate here.
- Setting timeout on `ctx.data.read()` avoids potential deadlock. If the user acquires write lock on the underlying data on an operation depending on results from the `Runner`, this will create deadlock. The timeout here helps prevent this and surfaces the error.

## Modelling Contexts

### `Context` struct
The `Context` struct is used for instantiating the `Runner`. It encapsulates everything needed to start the `Runner` and its `Worker`s.

```rust
pub struct Context<Input, Output> {
    pub config: RunnerConfig,
    pub tasks: Vec<Arc<dyn Runnable<Input, Output>>>,
    pub data: Arc<RwLock<Input>>,
    pub interval: TaskInterval,
    pub sender: mpsc::Sender<DataSet<Output>>,
}
```

- **Config**: holds config settings for the `Runner`, such as channel capacities, timeout etc
- **Tasks**: maintains a list of tasks to be used for instantiating `Worker`s
- **Data**: a pointer to the underlying input data guarded by a `RwLock`
- **Interval**: an enum that can be in `minutes`, `seconds`, `micros`, `millis`
- **Sender**: an `mpsc` Sender for sending the consolidated Output data back to the caller

### `ContextBuilder` struct
The `ContextBuilder` provides a builder pattern for creating `Context` instances to simply the creation.

```rust
pub struct ContextBuilder<Input: Default, Output> {
    tasks: Vec<Arc<dyn Runnable<Input, Output>>>,
    data: Option<Arc<RwLock<Input>>>,
    interval: TaskInterval,
    config: RunnerConfig,
}
```

The builder struct provides the following methods:
- `with_data` sets the underlying data
- `with_config` sets the config
- `with_task` plugs in a single task
- `with_tasks` plugs in multiple tasks
- `with_interval` sets the task running intervals

The builder struct provides several default settings for ease of use. As long as a `Runnable` task is provided, the caller can create a `Context` with the `ContextBuilder` by simply calling `with_task(task).build()`:
- if `data` is not provided, a default value will be created and wrapped in `Arc` and `RwLock`. A pointer will be returned to the caller after calling `build()` to be used for updating the data afterward.
- `config` and `interval` both have default values, so if not set, they will take the default value.

The caller will get back an instance of `Context`, a `Receiver` for receiving the consolidated data, and a pointer to the shared data (this can be ignored if the `data` was provided while building the context).

Note: while the builder here should cover majority of use cases, the `Context` struct itself still provides a public `new` method mainly for use case where the consolidated data is required to be sent to a predefined channel.

### `DataSet` struct

The `DataSet<Output>` is a simple struct wraps on a `HashMap<String, Output>` and a timestamp. 

```rust
pub struct DataSet<Output> {
    pub timestamp: u64,
    pub data: HashMap<String, Output>,
}
```

This struct is used to store the consolidated output data from different `Worker`s, which is stored in a `HashMap` with the task name as the key. The struct also stores the `timestamp` for running the tasks which can be used for constructing a timeseries data (and connecting multiple instances of `Runner` can therefore create an analytic pipeline).

## Managing Workers

### `Runner` struct
The `Runner` struct is the main orchestrator for managing multiple `Worker`s. It is responsible for managing the lifecycle of `Worker`s, coordinating `Runnable` task execution, and consolidating results.

```rust
pub struct Runner<Input, Output> {
    pub ctx: Context<Input, Output>,
    shutdown: broadcast::Sender<()>,
}
```

The `Runner` is responsible for:
- **Worker Management**: spawning and managing `Worker`s
- **Task Scheduling**: sending signals for `Worker`s to start work
- **Result Consolidation**: collecting and aggregating results into `DataSet` struct
- **Graceful Shutdown**: sending shutdown signals to `Worker`s to ensure the system can shutdown cleanly

### `Runner::new()`
The `new` method initialized the `Runner` with a `Context`, and creates an internal shutdown channel.
```rust
pub fn new(ctx: Context<Input, Output>) -> Self {
    let (shutdown, _) = broadcast::channel(1);
    Runner { ctx, shutdown }
}
```

### `Runner::shutdown()`
This is a public method for caller to shutdown the `Runner`, which simply uses the internal shutdown channel to send the message back to itself.
```rust
pub fn shutdown(&self) -> Result<(), TaskError<Output>> {
    self.shutdown
        .send(())
        // ...
    // ...
}
```

Using an internal channel allows the handling of shutdown to be independent from running tasks, and allow synchronous shutdown call from the caller.

### `Runner::run()`
The `run()` method is the heart of the `Runner`.

```rust
pub async fn run(&self) -> Result<(), TaskError<Output>> {
    // ...
}
```

#### Key components of the `run()` method:
**Worker Spawning**: for each task, the `Runner` instantiates a `Worker` with a `TaskContext` containing a pointer to the shared data, a receiver for signal to start task, and a sender to send back the results. Each `Worker` runs its task in a separate tokio task, the handle is pushed to the `worker_handles` vec to await at the end to capture task error.

```rust
for task in self.ctx.tasks.iter() {
    //...
    let mut worker = Worker::new(task, task_ctx);
    // ...
    let handle = tokio::spawn(async move { worker.run(shutdown_rx, timeout).await });
    worker_handles.push(handle);
}
```

**Time Broadcasting**: the `Runner` broadcasts time window `(start, end)` to all `Worker`s at predefined intervals. This ensures every `Worker` process data for the same time range. The `task_interval` specified in the `Context` is converted to `micros` for standardization.

```rust
let (time_broadcaster, _) =
    broadcast::channel::<(u64, u64)>(self.ctx.config.broadcast_channel_capacity);
let mut interval = interval(Duration::from_micros(task_interval.as_micros()));
// ...
tokio::select! {
    // ...
    interval.tick() => {
        // ...
        let end = get_current_time(&task_interval);
        let start = end - task_interval.as_u64();
        if let Err(e) = time_broadcaster.send((start, end)) {
            // ...
        }
    }
}
```

The `get_current_time()` is a helper function to get the current timestamp in a format matching with the `task_interval` specified in the `Context`. This effectively allows the library user to set the timestamp format in the output `DataSet`.

```rust
fn get_current_time(task_interval: &TaskInterval) -> u64 {
    match task_interval {
        TaskInterval::Micros(_) => chrono::Utc::now().timestamp_micros() as u64,
        TaskInterval::Millis(_) => chrono::Utc::now().timestamp_millis() as u64,
        TaskInterval::Seconds(_) => chrono::Utc::now().timestamp() as u64,
        TaskInterval::Minutes(_) => (chrono::Utc::now().timestamp() * 60) as u64,
    }
}
```

**Result Consolidation**: the `Runner` collects results from workers using an `mpsc` channel, consolidates them into a `DataSet`, and then send back via another `mpsc` channel.

```rust
let mut dataset = DataSet::new(end);
collect_results(&mut output_receiver, &mut dataset, task_count).await?;
if let Err(e) = result_sender.send(dataset).await { // ...
}
```

`collect_results` is a helper function for aggregating results from workers.

```rust
async fn collect_results<Output>(
    output_receiver: &mut mpsc::Receiver<TaskResult<Output>>,
    dataset: &mut DataSet<Output>,
    task_count: usize,
) -> Result<(), TaskError<Output>> {
    for i in 0..task_count {
      // ...
    }
}
```

## Usage Example - Building an Analytics Pipeline
In this example, we'll demonstrate how to use the `run-task` library to quickly build an analytics pipeline to process timeseries data.

The pipeline will perform the following steps:
- **Data Ingestion**: load data into the system
- **Data Preprocessing**: preprocess data (e.g. aggregating data / calculating stats)
- **Feature Extraction**: extract features

### Step 1: Define Data Struct
We need to define the data struct here, for example here we use `BTreeMap` for storing the raw timeseries data.
```rust
pub struct RawTimeSeries {
    time_series: BTreeMap<u64, i64>,
}

pub struct TimeSeries {
    time_series: BTreeMap<u64, i64>,
}
```

### Step 2: Define Preprocessor Tasks
First, let's define tasks for preprocessor:

```rust
pub struct RollingAverage {
    // ...
}

impl Runnable<RawTimeSeries, i64> for RollingAverage {
    fn name(&self) -> String {
        "rolling_average".to_string()
    }

    fn run(&self, data: &RawTimeSeries, start: u64, end: u64) -> Result<i64, TaskError<i64>> {
        // ...
    }
}

pub struct StandardDeviation {
    // ...
}

impl Runnable<RawTimeSeries, i64> for StandardDeviation {
    fn name(&self) -> String {
        "standard_deviation".to_string()
    }

    fn run(&self, data: &RawTimeSeries, start: u64, end: u64) -> Result<i64, TaskError<i64>> {
        // ...
    }
}
```

### Step 3: Define Feature Extraction Tasks
Similarly, we can define tasks for FeatureExtractor:
```rust
pub enum FeatureResult {
    // ...
}

pub struct FeatureTask1 {
    // ...
}

impl Runnable<TimeSeries, FeatureResult> for FeatureTask1 {
    fn name(&self) -> String {
        "feature_1".to_string()
    }

    fn run(&self, data: &TimeSeries, start: u64, end: u64) -> Result<FeatureResult, TaskError<FeatureResult>> {
        // ...
    }
}

pub struct FeatureTask2 {
    // ...
}

impl Runnable<TimeSeries, FeatureResult> for FeatureTask2 {
    fn name(&self) -> String {
        "feature_1".to_string()
    }

    fn run(&self, data: &TimeSeries, start: u64, end: u64) -> Result<FeatureResult, TaskError<FeatureResult>> {
        // ...
    }
}
```

### Step 4: Set Up the Pipeline
Now we can set up the pipeline using the `ContextBuilder` and `Runner`.

```rust
async fn run_pipeline() -> Result<(), Box<dyn Error>> {
    // Step 1.1: Define the input data, wrapped in Arc and RwLock.
    let raw_time_series_data = Arc::new(RwLock::new(RawTimeSeries::new()));
    // Step 1.2: Define the intermediate input data, storing the result from preprocessor.
    let time_series_data = Arc::new(RwLock::new(TimeSeries::new()));

    // Step 2: Define the tasks
    let rolling_average_task = RollingAverage;
    let standard_deviation_task = StandardDeviation;
    let feature_1_task = FeatureTask1;
    let feature_2_task = FeatureTask2;

    // Step 3: Build the first runner for preprocessor
    let (preprocess_ctx, preprocess_result_receiver, _) = ContextBuilder::new()
        .with_data(Arc::clone(&raw_time_series_data))
        .with_task(rolling_average_task)
        .with_task(standard_deviation_task)
        .with_interval(TaskInterval::Seconds(10))
        .build();

    // Step 4: Build the second runner for feature extractor
    let (feature_ctx, feature_result_receiver, _) = ContextBuilder::new()
        .with_data(Arc::clone(&time_series_data))
        .with_task(feature_1_task)
        .with_task(feature_2_task)
        .with_interval(TaskInterval::Seconds(10))
        .build();

    // ... skipping the steps where we ingest data to raw_time_series_data
    // ... we can continue to update the underlying data by periodically acquiring the write lock while running the pipeline

    // Step 5: Create and run the preprocessor runner
    let preprocess_runner = Runner::new(preprocess_ctx);
    let preprocess_runner_handle = tokio::spawn(async move {
        runner.run().await
    });

    // Step 6: Create and run the feature extraction runner
    let feature_runner = Runner::new(feature_ctx);
    let feature_runner_handle = tokio::spawn(async move {
        runner.run().await
    });

    // Step 7: Ingest the preprocessed result into the timeseries data
    let time_series_data_clone = Arc::clone(&time_series_data);
    tokio::spawn(async move {
        while let Some(dataset) = preprocess_result_receiver.recv().await {
            let mut time_series = time_series_data_clone.write().await; // Need to acquire write lock
            // Ingest data
        }
    });

    // Step 8: Process the feature extraction results
    tokio::spawn(async move {
        while let Some(dataset) = feature_result_receiver.recv().await {
            // Here we can further ingest this into another data struct and have another Runner to run data tasks on it
        }
    });
    
    // ..
}
```

### Step 5: Run the Pipeline
All we left to do is to call the `run_pipeline()`, and it will repeatedly do the following things:
- Ingest data to `raw_time_series`
- Run Preprocessor tasks every 10 seconds, and write the result to `time_series`
- Run Feature Extraction tasks every 10 seconds using `time_series`
- ...  we can connect more `Runner`s after this to distill the data progressively