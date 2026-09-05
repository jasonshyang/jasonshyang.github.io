---
title: "Testing Anchor Programs in Layers"
description: "How I test Solana Anchor programs: inline unit tests, every instruction path on LiteSVM, one end-to-end run against a validator, and property tests where the logic is pure and invariant-rich - all in Rust, and why."
date: 2026-08-29
tags: [solana, anchor, testing, rust]
kind: Systems
---
Anchor's default scaffold gives you a `tests/` folder with a TypeScript suite that runs against a local validator. It works, but it is one tier doing every job: each test pays for a validator, every test shares one chain, and the program is only ever reached through its IDL. Different questions about a program deserve different tools.

This post is how I test Anchor programs instead: four layers, all in Rust, run from a single command. Unit tests for the maths and the layout, LiteSVM for every instruction path, one end-to-end run against a real validator, and property tests where the logic has invariants worth stating. For each layer I want to cover what it is for, what it cannot do, and why it is set up the way it is.

A small share-based vault is the running example: users deposit a token and receive shares, the pool can receive yield, and a position can be withdrawn once its lockup has passed.

## Start With the Shape of the Program

The most important testing decision is not about tests at all. It is about where the logic lives.

An Anchor instruction has three parts: an `Accounts` struct with constraints, a validation step (I attach one with `#[access_control]`), and a handler. If the handler holds the business logic, the only way to exercise it is to build accounts, sign a transaction and run it through an SVM. That is slow, and it couples every test of the maths to account plumbing.

So the handlers stay thin. State accounts carry the logic as methods, and the methods take plain values. The vault's `deposit` handler, minus the CPI boilerplate, looks like this:

```rust
pub(crate) fn handler(ctx: Context<Deposit>, assets: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    let quote = {
        let mut pool = ctx.accounts.pool.load_mut()?;
        let quote = pool.quote_deposit(assets)?;
        pool.apply_deposit(quote)?;
        quote
    };
    ctx.accounts.position.load_mut()?.record_deposit(quote.shares, now)?;

    token::transfer(/* user -> vault */, quote.assets)?;
    token::mint_to(/* share mint -> user */, quote.shares)?;

    emit!(Deposited { user: ctx.accounts.user.key(), assets: quote.assets, shares: quote.shares });
    Ok(())
}
```

The interesting code is on `Pool`, a `#[account(zero_copy)]` struct that tracks share supply and asset balance. Its surface is a set of *quote* and *apply* pairs:

```rust
impl Pool {
    pub fn quote_deposit(&self, assets: u64) -> Result<DepositQuote>;
    pub fn apply_deposit(&mut self, quote: DepositQuote) -> Result<()>;

    pub fn quote_withdraw(&self, shares: u64) -> Result<WithdrawQuote>;
    pub fn apply_withdraw(&mut self, quote: WithdrawQuote) -> Result<()>;

    pub fn add_yield(&mut self, assets: u64) -> Result<()>;
}

impl Position {
    pub fn record_deposit(&mut self, shares: u64, now: i64) -> Result<()>;
    pub fn require_unlocked(&self, now: i64, lock_seconds: u64) -> Result<()>;
}
```

A quote is pure: it prices the operation against the current state and does not mutate. An apply takes the quote back and mutates with checked arithmetic. Neither touches a `Context`, an `AccountInfo` or the clock sysvar - the handler reads the clock once and passes it in as a number.

The consequence is that everything with a number in it can be tested with plain `cargo test` and no Solana runtime. The Anchor layer - constraints, signers, PDAs, CPIs, events - gets its own tier where it is tested against the compiled program.

## The Layers

| Layer           | Runs on                                          | What it proves                                                                | Speed   |
| --------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- | ------- |
| **Unit**        | `cargo test` inside the program crate            | Maths, account layout, packing - including private code                       | ms      |
| **Integration** | LiteSVM, in-process, running the compiled `.so`  | Every instruction path: constraints, auth, validation, CPIs, events, compute  | seconds |
| **End-to-end**  | `anchor test` against `solana-test-validator`    | The deployed artifact, IDL, client ser/de and RPC work together               | minutes |
| **Property**    | `cargo test` in a separate crate                 | Invariants over random inputs and random operation sequences                  | seconds |

The first three are the backbone and every program gets them. Property tests are optional: they earn their place where the program has pure, deterministic, invariant-rich logic, and add little otherwise.

## Unit Tests: Next to the Code

Unit tests sit inline as `#[cfg(test)] mod tests` at the bottom of the module they test. The main reason is privacy in Rust is per module, so a test module inside the file can reach private functions, fields and constants directly. A separate test crate only sees the public API. For unit tests that is a real cost - you either make helpers `pub` that have no business being public, or you test internals through several layers of indirection.

Two kinds of unit test carry most of the weight.

The first is ordinary: hand-computed expectations for the maths. A pool holding `200_000` assets against `100_000` shares prices one share at two assets, so depositing `50_000` should mint `25_000`. Small, readable numbers that a reviewer can check in their head.

The second kind pins layout. Zero-copy accounts are `#[repr(C, packed)]`, and their bytes are a wire contract with indexers, client code and every account already deployed on chain. So every state struct has a test like this:

```rust
/// Field byte offsets (after the 8-byte discriminator) are the account's
/// wire contract. The size test below is permutation-invariant; this one
/// fails on any reorder or resize.
#[test]
fn pool_layout_offsets_are_pinned() {
    assert_eq!(offset_of!(Pool, bump), 0);
    assert_eq!(offset_of!(Pool, authority), 1);
    assert_eq!(offset_of!(Pool, asset_mint), 33);
    assert_eq!(offset_of!(Pool, share_mint), 65);
    assert_eq!(offset_of!(Pool, total_assets), 97);
    assert_eq!(offset_of!(Pool, total_shares), 105);
    assert_eq!(offset_of!(Pool, lock_seconds), 113);
    assert_eq!(offset_of!(Pool, is_paused), 121);
    assert_eq!(offset_of!(Pool, _reserved), 122);
    assert_eq!(Pool::SPACE, 258);
}
```

A hand-calculated `SPACE` check alone is not enough, because swapping two fields of the same size leaves the total unchanged. The offsets catch that. The same idea applies to anything stored as an integer: if a `Role` enum is written to accounts as a `u8`, a test pins each variant's discriminant, because renumbering it would silently reassign roles on every deployed account.

## Integration Tests: LiteSVM

The unit tier never loads the program. This one does. [LiteSVM](https://github.com/LiteSVM/litesvm) is an in-process Solana VM: you hand it the compiled `.so`, submit transactions from Rust, and get back the transaction metadata - logs, compute units, the error - with no validator process. Each test constructs a fresh VM, so tests are independent and run in parallel, and the whole tier finishes in seconds.

Two properties make it the workhorse tier.

**It runs the real artifact.** The VM loads the same `target/deploy/*.so` that Anchor builds, so account constraints, signer checks, PDA derivation, CPIs and events are exercised exactly as they will be on chain, not through the `lib` target compiled for the host.

**Scenarios are cheap to arrange.** The VM is a value you own. `svm.airdrop(...)` funds a key, `svm.set_sysvar(&clock)` moves time, `svm.set_account(...)` writes any account you like at any address. Arranging "a user with funds, a pool that has been running for a week, and a position whose lockup expired an hour ago" takes a few lines and no waiting. If you have used Surfpool's surfnet, the feel is familiar, and not by accident: Surfpool is built on LiteSVM.

### The harness

The test crate has a small harness that every test is written against.

`Env::new()` builds the world: a VM with the program loaded, a funded authority keypair, the asset mint, and a helper to move the clock.

One **builder per instruction**. Its defaults form the happy path; `with_*` methods override the one thing a test cares about; `.send()` signs and submits and returns LiteSVM's `TransactionResult`. Harness structs such as `PositionHarness::setup(&mut env)` compose the prerequisite instructions - initialise the pool, fund a user, deposit - so an individual test starts at the interesting step.

**Assertion macros** for the two ways an Anchor transaction fails. `assert_anchor_err!(result, VaultError::PositionLocked)` pulls the custom code out of `TransactionError::InstructionError(_, Custom(code))` and compares it against the variant plus Anchor's `6000` offset; `assert_anchor_builtin_err!` does the same for framework errors like `ConstraintAddress`. `load_zero_copy::<Pool>(&svm, &pda)` reads an account's bytes past the discriminator so state can be asserted directly.

### One file per instruction

Each instruction gets a test file, and each file has the same named modules. A trimmed `withdraw.rs`:

```rust
mod happy_path {
    #[test]
    fn burns_shares_and_returns_assets() {
        let mut env = Env::new();
        let h = PositionHarness::setup(&mut env); // pool live, user holds 100_000 shares
        env.advance_clock(h.lock_seconds);

        Withdraw::new(&mut env, &h).with_shares(100_000).send().unwrap();

        assert_eq!(token_balance(&env.svm, &h.user_asset_account), h.starting_balance);
        let pool = load_zero_copy::<Pool>(&env.svm, &h.pool);
        assert_eq!({ pool.total_shares }, 0);
        assert_eq!({ pool.total_assets }, 0);
    }
}

mod validation {
    #[test]
    fn rejects_before_lock_expires() {
        let mut env = Env::new();
        let h = PositionHarness::setup(&mut env);
        env.advance_clock(h.lock_seconds - 1);

        let result = Withdraw::new(&mut env, &h).send();
        assert_anchor_err!(result, VaultError::PositionLocked);
    }
}

mod accounts {
    #[test]
    fn rejects_a_vault_belonging_to_another_pool() {
        let mut env = Env::new();
        let h = PositionHarness::setup(&mut env);
        let other = PoolHarness::setup_named(&mut env, "other");

        let result = Withdraw::new(&mut env, &h).with_vault(other.vault).send();
        assert_anchor_builtin_err!(result, ErrorCode::ConstraintAddress);
    }
}

mod pause {
    #[test]
    fn rejects_when_pool_is_paused() {
        let mut env = Env::new();
        let h = PositionHarness::setup(&mut env);
        SetPaused::new(&mut env).with_paused(true).send().unwrap();

        let result = Withdraw::new(&mut env, &h).send();
        assert_anchor_err!(result, VaultError::Paused);
    }
}
```

The recurring module names are `happy_path`, `auth`, `validation`, `accounts`, `re_init` and `pause`, plus whatever the instruction specifically needs. When I add an instruction, the file is a checklist: who may call it, what state rejects it, which wrong account is rejected and with which error, whether it can be run twice, and what a pause does to it.

### Three tricks the tier depends on

**Plant accounts instead of running programs.** Suppose the vault gates deposits on a price feed owned by an oracle program, read through an `AccountLoader<PriceFeed>`. The loader checks only owner and discriminator; it does not care how the bytes got there. So instead of loading and driving the oracle program in every test, build the feed account's bytes with a small fixture builder and write them into the VM with `set_account`, owned by the oracle's program id. The negative matrix becomes trivial - stale, halted, wrong feed, corrupt discriminator, wrong owner - each one `with_*` call. The same trick installs the `ProgramData` account that an upgrade-authority check reads.

**Own the clock.** Lockups, cooldowns, vesting schedules and staleness windows are all tested by setting the clock sysvar to the second you want, never by sleeping.

**Run the real external program where the CPI is the point.** When an instruction genuinely calls into another program - a token-metadata program, a DEX - load that program's `.so` into the VM, or bind it with `declare_program!` on its IDL, and let the CPI happen for real. Planting accounts covers reads; CPIs need the callee.

### Pin compute

LiteSVM reports `compute_units_consumed`, so the hottest instructions can be pinned. Measure the worst case the program permits - the largest input, the heaviest branch - and set a budget above it with modest headroom: a real regression trips the assertion, ordinary jitter does not. A change that pushes an instruction over budget then fails at `cargo test`, not on chain.

## End-to-End: One Run Against a Validator

The last backbone tier is `anchor test`. Anchor spawns a fresh `solana-test-validator`, deploys the program, sets `ANCHOR_WALLET`, and runs whatever the `[scripts] test` entry says. The test uses `anchor-client`: a typed `Program` handle, `program.request().accounts(...).args(...).send()`, and `program.account::<Pool>(pda)` to read state back.

This is the only tier that runs the program through the same validator, RPC and client stack a real deployment uses. So it is the only place that truly tests the IDL, the client-side serialisation and deserialisation of instructions and accounts, and the RPC round trip. LiteSVM bypasses all three: it takes an `Instruction` value and hands back account bytes.

It also has a limitation the other tiers do not: every test shares one chain. `cargo test` runs tests on parallel threads, all against the same validator, and singleton PDAs such as the pool config can only be initialised once. One test's `init_pool` fails because another's already ran; one test's pause breaks another's deposit. You can serialise with `--test-threads=1`, but the tests still share state, so ordering assumptions creep in and a failure in one leaves debris for the next.

So there is exactly one test. It walks every instruction in the order a real deployment would - initialise, configure, deposit, add yield, wait out the lockup, withdraw, pause and resume - asserting the on-chain state after each step. Written that way, the shared chain stops being a hazard: each step's preconditions are the previous step's assertions.

Failure paths do not belong here. Every rejection has already been asserted against the same binary in LiteSVM, and a validator round trip is two orders of magnitude slower.

One wrinkle worth knowing: the validator runs on the wall clock. If the program gates on a timestamp inside an account the validator pre-loads via `[[test.validator.account]]`, that fixture has to be regenerated at run time or it goes stale. LiteSVM never has this problem because it owns its clock.

## Property Tests: Where the Logic Deserves Them

Property tests are the optional tier. They pay off where a program has logic that is pure, deterministic and rich in invariants - accounting, pricing, consensus, anything a spec describes with sentences like "X never exceeds Y". Where a program is mostly plumbing, they add little over a good unit tier and I leave them out.

When the logic qualifies, the setup is a separate `property-tests` crate that depends only on the program's `lib` target and runs with `proptest` under plain `cargo test`. The spec that precedes the code usually already lists the invariants; the properties are those sentences typed out.

For the vault there are three layers of properties.

**Stateless properties** over the quote functions: things that should hold for any single quote at any state. Depositing `a` then immediately withdrawing the minted shares never returns more than `a`. Rounding always favours the pool.

**Invariants over operation sequences.** An `Op` enum covers every mutation the program can make, and a `Sim` applies a random sequence of them to an empty pool, checking the invariants after every step:

```rust
#[derive(Debug, Clone, Copy)]
enum Op {
    Deposit { assets: u64 },
    Withdraw { frac: u8 },   // burn frac/255 of outstanding shares
    AddYield { assets: u64 }, // assets in, no shares out
}

proptest! {
    #[test]
    fn invariants_hold_over_any_sequence(
        ops in prop::collection::vec(op_strategy(), 0..=64),
    ) {
        let mut sim = Sim::new(Pool::empty());

        for (i, op) in ops.iter().enumerate() {
            let before = sim.share_price();
            let _ = sim.apply(op);
            prop_assert!(sim.conserved(), "conservation broke after op {} ({:?})", i, op);
            prop_assert!(sim.share_price() >= before, "share price fell after op {} ({:?})", i, op);
        }
    }
}
```

Two invariants carry the vault. *Conservation*: `total_assets` equals deposits plus yield minus withdrawals, tracked by a small ledger in the simulator. *Monotonic share price*: assets per share never decreases across any operation, which is what floor rounding on both mint and redeem is supposed to guarantee - compared by cross-multiplication rather than division.

Two details matter here. First, `sim.apply(op)` returning an error is not a failure. Most randomly generated operations are rejected by the program - insufficient shares, a paused pool, a cap - and the invariants must hold after a rejection just as after a success. Second, the ledger is the only model in the suite. It tracks external flows in and out, nothing more. Everything else is asserted against the real `Pool`, so there is no parallel implementation to drift out of sync with the program.

**Targeted edge cases.** Random sequences rarely land on the first deposit into an empty pool, a full exit with `frac == 255`, or a pool of three assets where rounding bias is most visible. A third file biases its generators toward those bands.

There is one more family, *exact deltas*, that exists because conservation is coarse. An apply that accidentally moved value between two unrelated fields would still conserve the total. So for each apply method a test snapshots the state before and after, and asserts field-by-field equality on everything outside the method's documented write set:

```rust
let before = PoolSnapshot::capture(&pool);
pool.apply_deposit(quote).unwrap();
let after = PoolSnapshot::capture(&pool);

let expected = PoolSnapshot {
    total_assets: before.total_assets + quote.assets,
    total_shares: before.total_shares + quote.shares,
    ..before
};
prop_assert_eq!(after, expected);
```

The same shape turns up wherever a spec makes a security claim about a pure function: a median over several submitted values, a quorum rule, a fee schedule. "One bad input cannot move the output outside the range of the good ones" is a property, and it is far more convincing as ten thousand random cases than as three hand-picked ones.

Property tests run with proptest's default of 256 cases per property on every `test` invocation. Before a release, or after touching the maths, a `test-prop-long` task runs the same properties in release mode with `PROPTEST_CASES=10000` or more.

## Why Rust for Every Tier

Three reasons, in order of weight.

**The tests import the program as a library.** A LiteSVM test uses `vault::accounts::Withdraw` for the account metas, `vault::instruction::Withdraw` for the data, the real error enum for assertions, the real state structs to read accounts back, and the real seed constants to derive PDAs. Rename a field, add an account, or renumber an error, and the test crate fails to compile. A TypeScript test reaches the program through the IDL, so the same change is a runtime failure, and only in the tests that happen to hit it.

**The in-process tier wants Rust.** LiteSVM does ship Node bindings, but the TypeScript side still builds instructions and decodes accounts through the IDL-generated client, so the type-sharing argument above does not go away. In Rust, `load_zero_copy::<Pool>` is a `bytemuck` cast of the program's own struct; `assert_anchor_err!` compares against the program's own enum.

**Helpers exist once.** PDA derivation and default instruction params live in the test crate's `src/` and serve both the LiteSVM and end-to-end tiers. The property tests need the Rust types regardless, so one language and one toolchain is the path of least resistance, and CI needs no Node to run tests.

## Wiring It Together

A `mise.toml` defines the tasks, and the dependency graph does the sequencing:

```toml
[tasks.test-unit]
run = "cargo test --manifest-path programs/vault/Cargo.toml"

[tasks.test-prop]
run = "cargo test -p property-tests"

[tasks.build-program]
run = "anchor build"

[tasks.test-litesvm]
depends = ["build-program"]              # needs target/deploy/*.so
run = "cargo test -p tests --test litesvm"

[tasks.test-e2e]
run = "anchor test"

[tasks.test]
depends = ["test-unit", "test-prop", "test-litesvm"]

[tasks.precommit]
depends = ["fmt", "lint", "test", "test-e2e"]
```

`mise run test` is the inner loop. `mise run precommit` adds formatting, clippy with warnings denied, and the validator run, and is what runs before a push.

## What It Does Not Do

LiteSVM is not mainnet. When a program's external dependencies can be pinned as committed binaries or IDLs, a local VM is enough. A program that integrates with a live DEX or lending market needs real mainnet state, and that is where a Surfpool surfnet with mainnet forking slots in, between LiteSVM and the validator run.

Property tests are only as good as the invariants you write down. They will not find a property you did not think to state, and a suite that passes is not a proof of the ones you did not.

And the whole layering depends on the design decision at the top. If the handlers hold the logic, the fast tiers have nothing to bite on, and you are back to testing arithmetic through transactions.

## Conclusion

- **Put the logic on state structs**, behind quote and apply methods or pure functions that take the clock as an argument. This is what makes fast tests possible at all.
- **Keep unit tests inline** so they can reach private code, and use them to pin what is a wire contract: field offsets, sizes, enum discriminants.
- **Cover every instruction path in-process** on LiteSVM against the real `.so`, with one file per instruction, a builder per instruction, planted accounts for dependencies, and a clock you control.
- **Run the validator once**, in one long test, because it is the only tier that exercises the IDL, client and RPC stack, and because every test on a validator shares one chain.
- **Add property tests where the logic is pure and invariant-rich**, against the real code, with rejections treated as normal and a targeted generator for the boundaries random sampling misses.
- **Write it all in Rust**, so the tests share the program's types and a breaking change is a compile error rather than a runtime surprise.