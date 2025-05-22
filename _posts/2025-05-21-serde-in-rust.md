---
layout: post
title: Serialization and Deserialization in Rust
date: 2025-05-21
categories: [Concepts]
tags: [rust, serde]
---
In this article, we'll explore how to use `serde` crate to seamlessly serialize and deserialize data. We will walk through the powerful `#[derive(Serialize, Deserialize)]` macro and many of its customization options. Along the way, we will use practical examples to understand how to use these features to work with different data structures we have at hand.

---

## Overview
Serialization is the process of converting a data structure into a format that can be transmitted or stored. Deserialization works the other way around, where we take that format and reconstruct the original structure.

In Rust, we typically use `serde` crate (and `serde_json` if we are dealing with JSON) for these tasks. 

`serde` crate provides the core framework for serialization and deserialization, including the traits, the derive macros etc. Whereas `serde_json` provides concrete implementation for converting data structs to and from JSON.

## How does it work
### `Serialize` and `Deserialize` traits
At its core, `serde` uses two traits: `Serialize` and `Deserialize`.
* `Serialize` implementation maps the data struct into one of the 29 Serde data types and invoke the corresponding method in the `Serializer`. 
* The `Serializer` then maps the Serde data type to the desirable data format (e.g. JSON).
* `Deserialize` implementation maps the data struct into a Serde data type and pass a `Visitor` to the `Deserializer`.
* The `Deserializer` then maps the input data to the Serde data type and invokes the corresponding `Visitor` method, and returns the data struct we want to deserialize into.

#### `Serialize`
The `Serialize` trait is implemented by data struct that can be serialized into data format that implements the `Serializer` trait.

```rust
pub trait Serialize {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
       where S: Serializer;
}
```

The `Serialize::serialize()` takes `&self` and a serializer `S` (where S implements `Serializer`), and returns a result containing either the serialized representation or an error.

Under the hood, it uses one of the `serialize_*` methods from the `Serializer`, for example, let's see `serde_json`'s implementation for `serialize_bool`:

```rust
fn serialize_bool(self, value: bool) -> Result<()> {
    self.formatter
        .write_bool(&mut self.writer, value)
        .map_err(Error::io)
}
// ... //
fn write_bool<W>(&mut self, writer: &mut W, value: bool) -> io::Result<()>
where
    W: ?Sized + io::Write,
{
    let s = if value {
        b"true" as &[u8]
    } else {
        b"false" as &[u8]
    };
    writer.write_all(s)
}
```

Serde out of the box provides `Serialize` implementations for most of the common data structs such as Rust primitive types (e.g. bool, i64, u64, char, str etc.). 

This means we can serialize these types (to, say JSON format) without explicitly implementing `Serialize` for them.
```rust
let boolean = true;
let number = 42;
let text = "hello";
let list = vec![1, 2, 3];
let tuple = ("Alice", 30);

let json_boolean = serde_json::to_string(&boolean)?;
let json_number = serde_json::to_string(&number)?;
let json_text = serde_json::to_string(&text)?;
let json_list = serde_json::to_string(&list)?;
let json_tuple = serde_json::to_string(&tuple)?;
```

#### `Deserialize`
The `Deserialize` trait is implemented by data struct that needs to be deserialized from data format that implements the `Deserializer` trait.

```
pub trait Deserialize<'de>: Sized {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
       where D: Deserializer<'de>;
}
```

Similar to `Serialize` (but in opposite direction), the `Deserialize::deserialize()` takes a deserializer `D`. The `Deserializer` deserializes the data by calling one of the `Visitor` methods (e.g. `visit_str`), which converts a value into this struct.

The `<'de>` lifetime enables zero-copy deserialization. When deserializing, the `Deserializer` borrows the data instead of copying them, and the lifetime specifier guarantees that the input data will outlive the period of the output data struct being in scope, avoiding the memory safety issue if the input data gets dropped while the output data struct still refers to it, without copying the data.

When we deserialize to a `bool`, we are invoking the `Deserializer::deserialize_bool` which then call the `Visitor::visit_bool` to eventually return `Self::Value` (which would be `bool` for this `Visitor`):
```rust
// [Deserializer] trait
fn deserialize_bool<V>(self, visitor: V) -> Result<V::Value, Self::Error>
where
    V: Visitor<'de>;

// [Visitor] trait
fn visit_bool<E>(self, v: bool) -> Result<Self::Value, E>
where
    E: Error,
```

We can simply convert the strings from our previous example back to its original struct:
```rust
let deserialized_boolean: bool = serde_json::from_str(&json_boolean)?;
let deserialized_number: i32 = serde_json::from_str(&json_number)?;
let deserialized_text: String = serde_json::from_str(&json_text)?;
let deserialized_list: Vec<i32> = serde_json::from_str(&json_list)?;
let deserialized_tuple: (String, i32) = serde_json::from_str(&json_tuple)?;
```

## How to use it
The most common way would be to use Serde with the derive macro.

### `#[derive(Serialize, Deserialize)]`
The derive macro is very handy for making our custom structs implementing both the traits. To use this feature, we will need to enable the `features = ["derive"]` for `serde`.

The usage is very simple:
```rust
#[derive(Serialize, Deserialize)]
struct Person {
    name: String,
    age: u32,
}
// .. //
let person = Person {
    name: String::from("Bob"),
    age: 25,
};
let json_person = serde_json::to_string(&person)?; // {"name":"Bob","age":25}
```

Behind the scene, the derive macro does something like this:
```rust
impl Serialize for Person {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("Person", 2)?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("age", &self.age)?;
        state.end()
    }
}
```

This macro comes with many useful features, so let's go through them one by one.

### `#[serde(rename = "...")]`
This change the field name in the output, the below will get serialized by `serde_json` to `Person: {"first_name":"Bob","age":25}`.

```rust
#[derive(Serialize, Deserialize)]
struct Person {
    #[serde(rename = "first_name")]
    name: String,
    age: u32,
}
```

This can be very handy, for example, if we need to send a request to an external API which is expecting this JSON:
```json
{
    "type": "person",
    "data": "1"
}
```

We cannot call a field `type` in Rust, but we can do this `#[serde(rename = "type")]`.

Other examples including naming convention (e.g. `myField` vs `my_field`), but there's a better way to do that using `rename_all`.

### `#[serde(rename_all = "...")]`
This attribute automatically renames all fields in a struct (or all variants in an enum) using a consistent case convention. The most common one would be `camelCase`, which looks like this:
```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Person {
    first_name: String, // becomes "firstName"
    last_name: String,  // becomes "lastName"
    is_active: bool,    // becomes "isActive"
}
```

This happens at both direction, an API response with camel case will be deserialized into our struct which has snake case field names.

Below is a full list of all the possible renames:
* "camelCase"
* "lowercase"
* "UPPERCASE"
* "PascalCase"
* "snake_case"
* "SCREAMING_SNAKE_CASE"
* "kebab-case"
* "SCREAMING-KEBAB-CASE"

### `#[serde(skip)]`
This attribute means the field will be skipped when serializing or deserializing, for example there's some internal data fields that we don't want to include in the API request, or some sensitive data.
```rust
#[derive(Serialize, Deserialize)]
struct User {
    username: String,
    #[serde(skip)]
    password: String, // won't be serialized or deserialized
}
```

When working with optional fields, we can often use `skip_serializing_if = "Option::is_none"`, this means do not include this field when serializing if it's `None`.

### `#[serde(default)]`
This attribute means when a field is missing during deserialization, use the default value instead.
```rust
#[derive(Serialize, Deserialize, Debug)]
struct User {
    name: String,
    #[serde(default)]
    is_active: bool,
}
// .. //
let user_str = r#"{"name":"Bob"}"#;
let user: User = serde_json::from_str(user_str)?; // User { name: "Bob", is_active: false }
```

Using the `#[serde(default)]` would require the field data type to implement `Default` trait. But we can also pass in a default function instead:
```rust
#[derive(Serialize, Deserialize, Debug)]
struct User {
    name: String,
    #[serde(default = "default_data")]
    data: Data,
}

fn default_data() -> Data { Data {data: String::from("default")} }
```
In the above example, when `Data` is missing, the `default_data()` will be called which is expected to return the default value for `Data`. This can be useful when we deal with types that have already had `Default` implemented but we want a different value (e.g. a `String` is default to be empty but we want to have a default value).

This could also be useful when we deal with `Option`. Imagine we need to deal with a user flag that is `Option<String>`, and we need the behavior to be like this:
* if flag is missing, we set to a default value
* if flag is explicitly set to `null`, we set to `None`
* if some value is there in flag, we set to that value

If we simply deserialize the data without a default, we get the same `None` when the flag is missing and when it's `null`. But if we add a `#[serde(default)]` to it, now we can achieve the desirable behavior.



### `#[serde(flatten)]`
This is a very handy attribute when dealing with nested structs, it lets you embed the fields of the nested struct into the parent struct.

Consider this example:
```rust
#[derive(Serialize, Deserialize, Debug)]
struct Address {
    line_one: String,
    line_two: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct Person {
    name: String,
    #[serde(flatten)]
    address: Address,
}
```

With the `flatten` attribute, Serde knows to serialize and deserialize the `Person` struct as if it has 3 fields - name, line_one, line_two. This can be very useful if we are dealing with data structure that is differently define in our domain model versus the external source.


### `#[serde(tag = "...")]` 
The `tag` attribute is useful when we want to flatten an enum.

Consider this example:
```rust
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
enum Message {
    Email { subject: String, body: String },
    Text { text: String },
}
```

This will get serialized into `{"type":"Email","subject":"Hello","body":"World"}` for `Message::Email`, and `{"type":"Text","text":"Hello"}` for `Message:Text`.


### `untagged`, `content`
The `untagged` attribute means we will ignore the variant field, the below example will be serialized into `{"subject":"Hello","body":"World"}` for `Message::Email` if we add the `untagged` attribute.

```rust
#[derive(Serialize, Deserialize, Debug)]
enum Message {
    Email { subject: String, body: String },
    Text { text: String },
}
```

The `content` attribute is another one to work with enum (we must use this together with `tag`), it's helpful if we are dealing with a data structure that looks something like this
```rust
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", content = "content")]
enum Message {
    Email(String),
    Notification,
}
```

This will get serialized into `{"type":"Email","content":"Hello"}` or `{"type":"Notification"}`.

### `#[serde(alias = "...")]`
The `alias` attribute means a field can be deserialized from multiple names in the input, for example if we have different API responses some returns `{ "name": "Alice" }` ,some returns `{ "username": "Alice" }`, some returns `{ "user_name": "Alice" }`, we can do this:
```rust
#[derive(Serialize, Deserialize, Debug)]
struct User {
    #[serde(alias = "username")]
    #[serde(alias = "user_name")]
    name: String,
}
```

With the alias defined, all these API responses can be deserialized to our `User` struct nicely!

### `#[serde(with = "...")]`
The `with` attribute is the more advance feature offered by the `serde` crate, it allows us to define a custom ser / de module and use that for this field. This can be handy if we want to handle the ser / de differently, or having an external struct that we want to define how to ser/de it.

To use this, we need to define a module with two functions:
* `serialize`
* `deserialize`

These effectively act as adapters between our data type and the basic Serde types which the crate knows how to ser / de. These two functions look like this:
```rust
pub fn serialize<S>(value: &T, serializer: S) -> Result<S::Ok, S::Error>
pub fn deserialize<'de, D>(deserializer: D) -> Result<T, D::Error>
```

To write the `serialize` function, we need to:
* convert our value `T` into one of the 29 Serde data types (e.g. to a string)
* use the corresponding `serialize_*` method from the `serializer` to serialize it

To write the `deserialize` function, we need to:
* deserialize the input to a Serde data type
* convert that data type to the type of our value `T`

Here's an example, say we want to ser/de the `SystemTime` to a `u64` format:
```rust
mod time_as_secs {
    use serde::{self, Serializer, Deserializer};
    use std::time::{SystemTime, UNIX_EPOCH, Duration};

    pub fn serialize<S>(time: &SystemTime, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let secs = time.duration_since(UNIX_EPOCH).unwrap().as_secs();
        serializer.serialize_u64(secs)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<SystemTime, D::Error>
    where
        D: Deserializer<'de>,
    {
        let secs = u64::deserialize(deserializer)?;
        Ok(UNIX_EPOCH + Duration::from_secs(secs))
    }
}

#[derive(Serialize, Deserialize, Debug)]
struct Time {
    #[serde(with = "time_as_secs")]
    timestamp: SystemTime,
}
```

This struct will get ser/de into something like this `{"timestamp":1747930344}`. Without `#[serde(with = "time_as_secs")]`, we will get `{"timestamp":{"secs_since_epoch":1747930419,"nanos_since_epoch":661960000}}` instead.


If we only care about deserializing a data, we can use `#[serde(deserialize_with = "...")]` instead. The `deserialize_with` attribute is similar to `with`, but instead of providing a module, we provide a `deserialize` function here (the function name doesn't necessarily need to be `deserialize`, but it must take one argument that implements `Deserializer`).

## Conclusion

`serde` is a powerful tool for performing serialization and deserialization in Rust. It saves us from writing hundreds of lines of boilerplate code to convert Rust types to and from popular data formats like JSON. Mastering this crate gives us the ability to build systems that can interact seamlessly with external data.

By understanding all the customization options provided by the derive macro, we gain deeper understanding and controls over how data is interpreted and handled by `serde`.