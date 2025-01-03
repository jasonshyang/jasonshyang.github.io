---
layout: post
title: Lifetime Specifier in Rust
date: 2025-01-01
categories: [Concepts]
tags: [rust, generics]
---
This article provides a practical introduction to *lifetime specifiers* in Rust Programming language. We will first quickly cover what *lifetime* is, and then dive into the usage of *lifetime specifiers*. The goal is to better understand the concept of lifetime and lifetime specifiers.

---

## What is *lifetime*

Let's first briefly cover what *lifetime* is.

The concept of *lifetime* in Rust is a unique feature in the way it is implemented and enforced by the compiler in order to ensure memory safety without a garbage collector. Every reference in Rust has a *lifetime*. As the name suggested, this *lifetime* specifies the scope for which the reference is valid.

The compiler's *borrow checker* checks this at compile-time by comparing *lifetime* of borrowing reference and *lifetime* of borrowed data, and rejects the code if the borrowed data does not live long enough to cover the scope of the reference. This guarantees when the borrowing reference wants to use the data, it's always there.

When first starting to write Rust code, the following error would arguably be the most common error we would encounter:
```zsh
error[E0597]: `foo` does not live long enough
```

We can look at a set of very simple examples here to demonstrate this. Firstly let's look at below code, this can be compiled and ran with no issue.
```rust
fn main() {
    let mut my_vec = Vec::new();
    let my_string = String::from("hello world");
    for s in my_string.split_whitespace() {
        my_vec.push(s);
    }
}
```

But let's say we now want to do this in a loop:
```rust
// This does not compile
fn main() {
    let mut my_vec = Vec::new();
    for _ in 0..2 {
        let my_string = String::from("hello world");
        for s in my_string.split_whitespace() {
            my_vec.push(s);
        }
    }
}
```

Now the Rust compiler is not happy and gives us the `error[E0597]: my_string does not live long enough` error. 

Let's go through the second example step by step to understand why:
- the scope of `my_string` is created as a new `String` in each iteration, so its scope is limited to each iteration
- in our for loop for `split_whitespace()`, the `s` we push to `my_vec` is just a reference to parts of `my_string`
- at the end of each iteration, `my_string` is dropped, and its memory is deallocated, but `my_vec` still has reference pointing to `my_string`
- if the compiler lets us compile this, and if we want to access `my_vec[0]`, we will be accessing a memory that has already been deallocated!

Fixing this is very simple - we just need `my_string` to live long enough to cover each iteration, the below code can compile and ran with no issue:
```rust
fn main() {
    let mut my_vec = Vec::new();
    let my_string = String::from("hello world");
    for _ in 0..2 {
        for s in my_string.split_whitespace() {
            my_vec.push(s);
        }
    }
}
```

*Lifetime* is a very important concept to master and certainly deserves more explanation than just the above. The rest of this article focuses on the use of *lifetime specifier*, which is probably the most confusing part of the *lifetime* concept.

---

## What is *lifetime specifier*

It is an annotation so the Rust compiler can correctly apply checks and guarantees to ensure our program's memory safety. These lifetime specifiers look like `'a` and are placed in function signatures, structs, or other places where references are involved. 

The use of `a` in `'a` is just a naming convention, the syntax for *lifetime specifier* in Rust is an apostrophe (') follow by the name. This is placed after the `&` of a reference, separated by a space.


### When do we need to specify lifetime
Below is a set of examples showing where we will typically need to use `'a`, if we remove the `'a` the code will not compile:
```rust
struct Foo<'a, T> { x: &'a T }
enum Bar<'a, T> { A(i64), B(&'a T) }
fn baz<'a>(x: &'a str, y: &'a str) -> Vec<&'a str> { vec![x, y] }

```

In order to understand when we need to specify lifetime, we will first need to look at when we don't need to specify.

#### When we don't need to specify lifetime
We might wonder why we don't see the `'a` everywhere in Rust code if it plays such an important role. 

As it turns out, the Rust compiler can infer the lifetime in most cases, which is call the [**lifetime elision rules**](https://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html#lifetime-elision)

Below is the explanation provided by the Rust book:
> The compiler uses three rules to figure out the lifetimes of the references when there aren’t explicit annotations:
> ...
> The first rule is that the compiler assigns a lifetime parameter to each parameter that’s a reference. In other words, a function with one parameter gets one lifetime parameter: `fn foo<'a>(x: &'a i32)`; a function with two parameters gets two separate lifetime parameters: `fn foo<'a, 'b>(x: &'a i32, y: &'b i32)`; and so on.
> The second rule is that, if there is exactly one input lifetime parameter, that lifetime is assigned to all output lifetime parameters: `fn foo<'a>(x: &'a i32) -> &'a i32`.
> The third rule is that, if there are multiple input lifetime parameters, but one of them is `&self` or `&mut self` because this is a method, the lifetime of self is assigned to all output lifetime parameters. 

Let's look at some examples where the lifetime is inferred.
```rust
fn foo(s: &str) {}
fn bar(s: &str) -> &str { s }
fn baz(s1: &str, s2: &str) -> String { s1.to_string() + s2 }
```

If after applying all these elision rules, the compiler still cannot infer the lifetime, we will get the `error[E0106]: missing lifetime specifier`. This is due to the ambiguity of our code, the compiler cannot work out the lifetime and needs our help to specify it explicitly. 

Now we have a better understand of when we would need the lifetime annotation and when we can let the compiler infer, we can finally understand why just by removing the `'a` annotation for `y`, our code will not compile: because the `Vec` we return contains references to `x` and `y`, the compiler does not know how to infer its lifetime, the `'a` we included helps the compiler to figure out the `Vec` has same lifetime as `x` and `y`.

```rust
fn baz1<'a>(x: &'a str, y: &'a str) -> Vec<&'a str> { vec![x, y] } // This compiles
fn baz2<'a>(x: &'a str, y: &str) -> Vec<&'a str> { vec![x, y] } // This does not compile
```

### What does the *lifetime specifier* actually do
Nothing 😅.

This can get confusing sometimes, but the lifetime specifier does not change the lifetime of the value, just like declaring a type in the function signature does not change the type of the input. The *lifetime specifier* serves as an annotation just like the type of a function's parameter. This specifier form part of the function's signature, and our trusty compiler will help us enforce this!

---

## How do we use *lifetime specifier*

We typically need to use *lifetime specifier* in one of the following places:
- `struct` (`enum` works in similar way)
- `function`
- `method`

In this section, we will cover these in some detail to explain how the specifier is used.

### `struct` lifetime
When our structs hold references, we must specify lifetimes. Our **lifetime elision rules** do not have us covered for any structs holding references.
```rust
struct Foo<'a, T> { pub x: &'a T } // This compiles
struct Foo2<T> { pub x: &T } // This does not compile
```

Let's go through the reason why this is needed to guarantee memory safety:

Suppose our compiler let us compile our `Foo2`, and we created a new `foo` of the type `Foo2<bool>` with a reference pointer to `x: bool`. Our code is very complex, our new `foo` was sent around to difference places but our `x` was dropped soon after `foo` was created (so the boolean data stored in memory was deallocated). Now we want to call `foo.x` to access the boolean, oh no ... the pointer we have here is pointing to a deallocated memory address!

So when we create a struct that does not own the data inside, we need to use lifetime annotations to specify how long the borrowed data is valid. By specifying the `'a` here, we are telling the compiler the reference data `x` inside our `Foo` will remain valid for at least as long as the instance of the `Foo` is alive.

If we try to then use our `Foo` in the same way as we were using our `Foo2` in the above example, our compiler will know to reject the code.
```rust
fn main() {
    let foo;
    {
        let value = 42;
        foo = Foo { x: &value };
        // our value is dropped here
    }
    println!("{}", foo.x); // This will return: error[E0597]: `value` does not live long enough
}
```

This is because the compiler now knows to check our reference to `x` should live as long as our instance of `Foo`, but here our reference to `value` has a smaller scope (so shorter lifetime) than our `foo`. 

### `function` lifetime
We have already covered quite a lot of how lifetime works with `function` in previous section. The **lifetime elision rules** cover us for the most common scenarios, so in most cases we are not required to specify lifetime when we work with `function`.

We already know function taking one reference does not need a lifetime specifier as covered by the second lifetime elision rule 
> "if there is exactly one input lifetime parameter, that lifetime is assigned to all output lifetime parameters"
This means that if a function only takes a single reference and returns a reference tied to the same lifetime, Rust will automatically infer the correct lifetime for the return value.

Note that this does not hold true if our function takes no reference but return a reference (this is uncommon unless we are returning a reference to external source or some static data), as it does not satisfy the requirement to have exactly one input lifetime parameter.

For function taking multiple references, we know we will need to use lifetime specifier. Usually we would want to assign the same `'a` for all our input references and our output references, but this is not always the case.

Consider this example:
```rust
fn foo<'a, 'b>(x: &'a str, y: &'b str) -> (&'a str, &'b str) { (x, y) }
```
Our `foo` function takes two string references and play them back, here we can define two lifetime specifiers for `x` and `y`. 

This can be useful if we don't want to enforce the same lifetime constraints for our two reference. Let's use an example to demonstrate this:
```rust
fn foo<'a, 'b>(x: &'a str, y: &'b str) -> (&'a str, &'b str) { (x, y) }
fn foo2<'a>(x: &'a str, y: &'a str) -> (&'a str, &'a str) { (x, y) }
fn main() {
    let s1 = String::from("Hello");
    let mut part1 = &s1[..3];
    {
        let s2 = String::from("World");
        let mut part2 = &s2[..4];
        (part1, part2) = foo(part1, part2); // this does not compile if we use foo2 here
    }
    println!("part1: {}", part1);
}
```

In this example, both our `part1` and `part2` are references to string but they have different lifetimes: `part2` is declared in a `{}` closure, so it was dropped after the closure ends. 

This code compiles with `foo()`, but the compiler won't allow us to compile if we attempt to use `foo2()` in this example:
```zsh
error[E0597]: `s2` does not live long enough
   --> src/main.rs:114:26
    |
113 |         let s2 = String::from("World");
    |             -- binding `s2` declared here
114 |         let mut part2 = &s2[..4];
    |                          ^^ borrowed value does not live long enough
115 |         (part1, part2) = foo2(part1, part2);
116 |     }
    |     - `s2` dropped here while still borrowed
117 |     println!("part1: {}", part1);
    |                           ----- borrow later used here
```

This code is safe to run but our compiler rejects it (although in reality if our part1 uses part2 and part2 uses part1, this would not be safe).

This is because the compiler is confused here: our `foo2()` makes it thinks our `part1` and `part2` should have lifetime of `'a`, and live as least as long as the lifetime of `part1` and `part2` (which means as least as long as `part2` which has smaller lifetime), when we want to access `part1` after `part2` was dropped, the compiler rejects the code thinking it references `part2` which is dropped!

### `method` lifetime
We declare lifetime for method with similar syntax as *generics*, the lifetime specifier is declared after the `impl` keyword and then used after the `struct`.
```rust
impl<'a> Foo<'a> {}
```

When we are working with methods, the third **lifetime elision rule** covers quite a lot of ground for us.
> if there are multiple input lifetime parameters, but one of them is `&self` or `&mut self` because this is a method, the lifetime of self is assigned to all output lifetime parameters. 
In many cases we would not need to declare the lifetime for a method. We typically would need to declare lifetime if the struct we are working with has a lifetime specifier (just like *generics*, for `Foo<T>` we need to `impl<T>`).

We have an interesting example here that can demonstrate how the third rule works:
```rust
struct Foo { name: String }

impl Foo {
    fn bar1(&self, x: &str) -> &str { &self.name.as_str() } // This compiles
    fn bar2(&self, x: &str) -> &str { x } // This does not compile
}
```
Our `bar1()` passes the compiler, but our `bar2()` doesn't, the compiler gives us a fantastically detailed explanation (this is why we all love Rust!)
```zsh
error: lifetime may not live long enough
   --> src/main.rs:137:38
    |
137 |     fn bar2(&self, x: &str) -> &str { x }
    |            -         -               ^ method was supposed to return data with lifetime `'2` but it is returning data with lifetime `'1`
    |            |         |
    |            |         let's call the lifetime of this reference `'1`
    |            let's call the lifetime of this reference `'2`
    |
help: consider introducing a named lifetime parameter and update trait if needed
    |
137 |     fn bar2<'a>(&self, x: &'a str) -> &'a str { x }
    |           ++++            ++          ++
```

Our `self` has a lifetime of `'1`, our `x` input has a lifetime of `'2`, the compiler following **the third rule** tried to make the returned `&str` with lifetime of `'1`, but we are returning `x` here in `bar2()`, our compiler is confused (sorry Ferris 😢).

---

## `'static` lifetime

Finally let's touch on the use of `'static` lifetime, which is often a very confusing concept in Rust.

The reason for the confusion is, this `'static` lifetime has two different usages:
- we use it to declare a reference's lifetime as **static**
- we use it in a trait bound to declare the type does not contain **non-static** references

These two usage situations are different and so does the meaning of `'static`.

#### using `'static` as lifetime specifier for a reference
When we say a reference has a `'static` lifetime, it means the reference is valid for the entire duration of the program. This normally means the referenced data is typically hard-coded into the binary (e.g., string literals) or managed globally.

Here are two example where we declare the output `str` as `'static`, meaning the output is a reference to a string literal.
```rust
fn foo() -> &'static str { "Hello" }
struct Foo { bar: &'static str }
```

#### using `'static` as trait bound
This is probably the most common usage of `'static`, hence why it can get confusing.

We use `'static` trait bound like this:
```rust
fn foo<T: 'static>(data: T) {}
```
Notice the syntax difference to static lifetime reference, here we use `'static` like we do with `T: Send`, it is used as a trait bound! 

A trait bounds mandates the type must implement a particular trait specified. When we declare a `'static` trait bound to type `T`, we are mandating type `T` must not contain any non-static references. 

This means `T` either (a) hold references that have `'static` lifetime (which is our first usage situation discussed above); or (b) owns its data completely

We say the type `T` here has a `'static` lifetime because the receiver of this type can keep it around indefinitely without worrying about it becoming invalid or dangling. This is because the data it refers to either has static lifetime, or it is entirely owned by `T` (meaning as long as `T` lives, these data will live).

We come across the need to declare `'static` when we use async libraries like `tokio` (the infamous `Send + Sync + 'static` 😅). This is because async task can be ran at later stage (even on a different thread), if the task uses a type `T` that is not `static`, there is no guarantee when we run the task, the reference is still valid.

Note that the use of lifetime specifier in trait bound is not limited to just `'static`, we can write:
```rust
fn f<'a, 'b>(x: &'a i32, mut y: &'b i32) where 'a: 'b {
    y = x; 
    let r: &'b &'a i32 = &&0;
}
```

Here `'a: 'b` indicates 'a outlives 'b, meaning `'a` lasts at least as long as `'b`. Notice that our `T: 'static` works in similar way, `T` lasts at least as long as `'static`, yes because these are all called **lifetime bounds**, [this link from the Rust Reference book](https://doc.rust-lang.org/reference/trait-bounds.html) provides more explanation on the usage of lifetime bounds.

---

## Conclusion

The lifetime concept is very crucial to understanding how the Rust compiler's **borrow checker** helps us ensure memory safety. While all references have lifetime, not all references' lifetime need to be explicitly declared thanks to the **lifetime elision rule** which infers the lifetime when it is safe to do so. We sometime come across the `'static` lifetime in a trait bound, which has different meanings to when this is used as a lifetime specifier for reference