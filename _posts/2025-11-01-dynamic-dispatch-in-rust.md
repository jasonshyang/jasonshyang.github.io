---
layout: post
title: Dynamic Dispatch in Rust - From Sized to VTables
date: 2025-11-01
categories: [Concepts]
tags: [rust]
---
When we work with traits in Rust, at some point we would come across this error `the size for values of type XXX cannot be known at compilation time`. 

For example, if we write `fn bar(foo: dyn Foo) {}`, doesn't matter what `Foo` is, we will get the compiler error above, but putting a `&` or wrapping it with a `Box` would make the function works. 

If we don't understand the inner workings of dynamic dispatch and `Sized`, it may come as a surprise. In this post, we will go through what *dynamic dispatch* means in Rust context, covering what `dyn Trait` does under the hood, the difference between that and `impl Trait`, what *object safety* is, how *vtables* make it work under the hood, and what's the performance trade-offs come with it.

## `Sized` trait

Before we jump into dynamic dispatch, it's quite important we first understand what does the `Sized` trait mean.

First of all, it's a marker trait (just like `Send`, `Sync`), so there's no implementation, it just tells the compiler this type has a size that's known at compile time, any custom types containing data that is all `Sized` is auto implemented for `Sized`, and if it contains data that is not `Sized`, it is opted out from `Sized` (much like `Send` and `Sync`).

For example, a `u8` is `Sized`, but a `[u8]` is not `Sized` (we can make it `Sized` by adding the length `[u8; 32]`).

It's important to know that pointers are also `Sized`, for example, a `String` is a wrapper on `Vec<u8>`, where `Vec` internally holds a pointer to the heap-allocated data, along with its length and capacity. Although the data on the heap can grow or shrink, our pointer here has a fixed size as it only stores these three values.

Now we can go back to our example mentioned in the introduction, why `fn bar(foo: dyn Foo) {}` does not work but `fn bar(foo: &dyn Foo) {}` does. 

When we pass in `dyn Foo`, it can be anything that implements `Foo`, at compile time there's no guarantee what gets passed into `bar()`, meaning there's no way for us to know the size of `dyn Foo`, so we cannot compile this code because we won't know how much stack space to allocate for `foo`.

When we pass in `&dyn Foo`, we are just passing in a reference to something that implements `Foo`. Although we still don't know what size `Foo` is, but we know the size of the reference pointer, so we can compile this code with no issue (same for `Box` or other pointers).

## Static vs Dynamic Dispatch

For our `bar()` example, another way to make it work is to use generics: `fn bar(foo: impl Foo) {}`. 

The `impl Foo` here is syntactic sugar for `fn bar<T: Foo>(foo: T) {}` (note that `fn bar<T: Foo>(foo: T, foo2: T)` is not the same as `fn bar(foo: impl Foo, foo2: impl Foo)` though, the latter is more flexible as `foo` and `foo2` can be two different types).

This approach is known as *static dispatch*, it tells the compiler that `bar()` can handle any types that implements `Foo`, but the exact type will be determined at compile time. This is crucially important to understand the difference between `impl Foo` and `dyn Foo` - we must specify the concrete types at compile time for `impl Foo` when we use `bar(foo: impl Foo)`, but we don't need to do that for `bar(foo: &dyn Foo)`

Behind the scene, the compiler will generate a new `bar_*()` for each concrete types it's called with, a process known as *monomorphization*. This means the actual method being called is fulled resolved at compile time, and the compiler can do its magic to optimize things.

On the other hand, using `dyn Foo` performs *dynamic dispatch*, where the method only resolves at runtime. This means instead of calling the concrete implementation, the code will need to look up the appropriate method in a *vtable* -- a table of function pointers -- at runtime through a trait object.

## Trait Objects and Object Safety

A trait object is written as `dyn Trait` and always used behind some sort of pointer as we covered above, like a `&dyn Trait` or a `Box<dyn Trait>` if we need it to be owned.

We can have a struct like this:
```rust
struct MyFoo<'a> {
    foo: Box<dyn Foo>,
    foo2: &'a dyn Foo,
    foo_map: HashMap<String, Box<dyn Foo>>
}
```
At compile time, we don't know what type `foo`, `foo2` and `foo_map` is, but we can still compile the code because they are behind pointers which size is known.

However, not all traits can be turned into a trait object like this. The below error may look familiar if we work with traits a lot in Rust:
```
error[E0038]: the trait `Foo` is not dyn compatible
  --> src/main.rs:13:14
   |
13 |     foo: Box<dyn Foo>,
   |              ^^^^^^^ `Foo` is not dyn compatible
   |
note: for a trait to be dyn compatible it needs to allow building a vtable
```

If we don't understand trait object safety, this may feel puzzling, consider the following example pairs:

**Pair 1:**
```rust
trait Foo1 {
    fn new() -> Self;
}

trait Foo2 {
    fn new() -> Self where Self: Sized;
}
```
**Pair 2:**
```rust
trait Foo3 {
    fn foo();
}

trait Foo4 {
    fn foo(&self);
}
```
**Pair 3:**
```rust
trait Foo5 {
    fn foo(&self, bar: impl Fn());
}

trait Foo6 {
    fn foo(&self, bar: &dyn Fn());
}
```
**Pair 4:**
```rust
trait Foo7: Sized {
    fn foo(&self);
}

trait Foo8 {
    fn foo(&self);
}
```

All 4 pairs look quite similar, but only one of each is object safe - we can only do `Box<dyn Foo>` on `Foo2`, `Foo4`, `Foo6` and `Foo8`, but not the other 4.

The rules for *object safe* are:
- All its methods can be called on a `dyn Trait` reference
- It does not use generic methods `impl Fn()` or `<T: Fn()>`
- It does not require `Self: Sized`

Let's go through one by one.

**1. All its methods can be called on a `dyn Trait` reference**

The first rule means the trait cannot have methods that returns `Self` or take `self`, or just don't take anything (like `fn foo();`). This explains our example `Foo1 `and `Foo3`. Because in order to return or take a `Self` or an associated function like `fn foo()`, we need to know what the type really is. 

Imagine if we have a `dyn Foo1` in a function, how do we actually call `Foo1::new()`? `Foo1` here is just the trait, so what types are we actually constructing here? We have no way to know that as it does not take a reference to self, so if we pass in a `foo: Box<dyn Foo1>`, the `new()` method isn't callable from `foo.new()` (we normally do `Foo::new()` if we know the type, but we don't here).

Similarly for `Foo3`, say we have two different types implement it, one do a console log, one launch a nuclear bomb, how do we know which one to invoke when we call it via a trait object.

However, `Foo2` works by simply adding `where Self: Sized`, this is because by adding this, we are opting out the trait object for this method (because we say `Self` needs to be `Sized` when this is called, and we know from above that `dyn Trait` is not `Sized`, so this method's bound is not met).

This means we cannot call a method marked as `where Self: Sized` via trait object, consider this example:
```rust
trait Foo {
    fn foo(&self) where Self: Sized;
}

fn bar(foo: Box<dyn Foo>) {
    foo.foo();
}
```

This does not compile and we get this error:
```
error: the `foo` method cannot be invoked on a trait object
  --> src/main.rs:13:9
   |
9  |     fn foo(&self) where Self: Sized;
   |                               ----- this has a `Sized` requirement
...
13 |     foo.foo();
   |  
```

But notice that we can still construct a `Box<dyn Foo>`, just that the `foo()` method is not accessible. This is extremely useful, as it's not uncommon to have methods in a trait that are not object safe, but there are also methods that are actually object safe, and we are fine for using only those method via a trait object (and use the other methods via generics).

**2. It does not use generic methods `impl Fn()` or `<T: Fn()>`**

The second rule is a bit harder to understand, you may wonder why generics are not allowed. This is because the compiler will do its monomorphization magic for generic functions, turning them into concrete implementations. But at compile time we don't know how this method will be called - we don't know what `Fn()` will be invoked because we don't know exactly which type that implements `Foo5` will get called here at compile time.

To fully explain this, we will need to dive into *vtable*, in the next section we will cover that in more detail.

**3. It does not require `Self: Sized`**

Lastly, when a trait explicitly requires `Self: Sized` (consider our `Foo7` above), it means the trait has opted out for trait objects explicitly, this is not very commonly used as we can opt out at method level as covered above, unless our trait is useless in trait objects.

Consider `Clone` for example, it's declared as `trait Clone: Sized` in the core library, because we can only do `clone()` on `Clone`, and `clone()` is not object safe, so constructing a `Box<dyn Clone>` is pointless, and the trait author opts out from it by adding the `Self: Sized`.

## Vtables

A *vtable* is a virtual table, containing the concrete implementations of the trait methods and some metadata.

When we create a trait object like `&dyn Trait`, it creates what is called a *fat pointer*, that is made up of two pointers:
- a data pointer to the actual data (the thing that implements `Trait`)
- a pointer to a *vtable* containing the concrete methods implemented for that type

Consider the following simple dynamic dispatch example:
```rust
trait Foo {
    fn foo(&self);
}

struct Bar;
struct Baz;

impl Foo for Bar {
    fn foo(&self) {/* do A */}
}

impl Foo for Baz {
    fn foo(&self) {/* do B */}
}

fn main() {
    let bars: Vec<&dyn Foo> = vec![&Bar, &Baz];

    for bar in bars {
        bar.foo();
    }
}
```

Here's what happens at runtime for each `foo()` call:
- Each `bar` in `bars` is a fat pointer containing: a pointer to either `Bar` or `Baz` value, a pointer to the corresponding vtable `vtable_Bar` and `vtable_Baz`
- For each `foo()` call, we dereference the vtable pointer, look up the function pointer for `foo()` in that table, and calls that function passing in the data pointer as `self`

We can visualize what's happening in memory like this:
```
Bar instance     →  [ Bar {...} ]
vtable_Bar       →  [ ptr to Bar::foo, ptr to drop::<Bar>, ... ]
trait object     →  [ data_ptr = &Bar, vtable_ptr = &vtable_Bar ]

Baz instance     →  [ Baz {...} ]
vtable_Baz       →  [ ptr to Baz::foo, ptr to drop::<Baz>, ... ]
trait object     →  [ data_ptr = &Baz, vtable_ptr = &vtable_Baz ]
```

So the `bar.foo()` actually works something like this:
```rust
(*bar.vtable_ptr.foo)(bar.data_ptr)
```

This is very useful because it allows Rust to:
- Call the correct methods
- Drop the correct type when the trait object goes out of scope
- Allocate and deallocate memory correctly (the size of `Bar` is also stored in the vtable, as well as the alignment in bytes)

Now that we understand how *dynamic dispatch* actually works, we can revisit the second rule mentioned in previous section. The reason why generics don't work with *dynamic dispatch* is that we don't know how to construct the vtable - for generics, the compiler generates copies of the same function for different types using it, those functions would ideally go into the vtable, but we don't know them at compile time, so there's no good way to construct the vtable correctly.

### Associated Types

This is a bonus section, for traits that have associated types, we will need to specify that associate type to make the trait object work. For example, if we have a `Foo` trait with `Fooz` as associated type, we cannot have a `Box<&dyn Foo>` without specifying what `Fooz` is.
```
error[E0191]: the value of the associated type `Fooz` in `Foo` must be specified
  --> src/main.rs:20:23
   |
2  |     type Fooz;
   |     --------- `Fooz` defined here
...
20 |     let foo: Box<&dyn Foo>;
   |                       ^^^ help: specify the associated type: `Foo<Fooz = Type>`
```

Each trait object relies on its vtable that contains the function pointers, if a trait has an associated type, the compile cannot generate the methods in the vtable without knowing what exactly is that type. 

Our `Fooz` can be a `()` or a super mega large struct, our vtable needs to know all the function signatures to be defined correctly, but if we have a function `foo(v: Self::Fooz)`, we don't know what `Fooz` is here, so we cannot construct the vtable.

## Performance Trade-offs

Generally speaking, `dyn Trait` is more flexible than `impl Trait`.

We can have a struct `MyStruct` that contains a `Box<dyn Foo>` , but for static dispatch, we will need to either specify the concrete type or make our struct generic `MyStruct<T: Foo>`, and that generic will propagate to any types and functions using `MyStruct<T>` which can get pretty annoying quickly. Also we can have a collection over `dyn Foo`, but we cannot have a collection over `impl Foo`, which is probably one of the most common reasons for going with dynamic dispatch (e.g. having a `HashMap<String, Box<dyn Foo>>`)

However, using `dyn Trait` is not free. There are mainly two performance implications:
- Using dynamic dispatch involves the runtime overhead of vtable
- Compiler cannot do optimization on codes using dynamic dispatch

For performance-critical Rust code, static dispatch is usually preferred because the compiler can do its magic, inline and optimize aggressively (because things are statically known). However, static dispatch is also not entirely free - it comes at the cost of larger code size due to monomorphization, for example if we have a function that takes `impl Fn()` and we pass many different `Fn()` into it, the compiler will end up having to generate quite a lot of codes. As a general rule, we should avoid using dynamic dispatch in part of our code where we are frequently invoking it, for example in a `HashMap` where we lookup for `Box<dyn Foo>` every 10 microseconds, as the performance cost will quickly accumulate.

There's one more alternative to this, which is an enum based polymorphism. For example, we may have `trait Foo` implemented for `Bar`, `Bar1`, and `Bar2`, we cannot do a `Vec<impl Foo>`, and we don't want to do a `Vec<Box<dyn Foo>>`, we can have a `BarEnum { Bar(Bar), Bar1(Bar1), Bar2(Bar2) }`, now we can have a `Vec<BarEnum>`, and match on it to access the underlying data (or implement `Foo` for `BarEnum` which delegates to the underlying variants). This approach has many limitations of its own, e.g. it requires more boilerplate codes, and is not possible for using in a library (where the concrete implementations are not in the library codes).

## Conclusion

The key takeaways:
- A function argument needs to be `Sized`, so we need a trait object (e.g. a `&dyn Trait` or `Box<dyn Trait>` which size is known as they are pointers) to work with dynamic dispatch
- Not all traits can be turned into a trait object as it needs to be object safe to allow a consistent vtable to be generated for runtime method calls
- Dynamic dispatch uses vtable under the hood with a fat pointer to achieve runtime polymorphism: method calls resolved at runtime based on the underlying concrete type
- Comparing to static dispatch, there's performance cost for using dynamic dispatch, so dynamic dispatch should be used thoughtfully