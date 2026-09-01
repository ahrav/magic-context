# exactly-one-core-step-executes-per-pass

## Discovery trigger

The current transform source contains seven `core.step` call sites. The relevant
property is at-most-one execution per pass: accepted Defer paths can execute no
step, while every stepping path reaches only one site.

## Provenance

Magic citations were verified against source commit
`af5e153c12750354a82f91bc796367031ac5c658` plus the current companion U6 diff
on 2026-09-01. Cache-core citations use the exact source at commons U6 commit
`cb5a5c01a5a98df8d80fd41f16c4de5a5cc16d`.

## Evidence trail

### Seven current call sites

| Site | Action | Guard and control-flow owner |
| --- | --- | --- |
| `crates/mc-module/src/transform.rs:2785-2792` | `Hard` | `apply_additive_only`'s `match plan` arm `Hard | MigrateHard`, opened at `:2748-2749` |
| `crates/mc-module/src/transform.rs:2852-2859` | `Soft` | `apply_additive_only`'s `PassPlan::Soft` arm, opened at `:2832` |
| `crates/mc-module/src/transform.rs:4236-4249` | `Soft` | main path, `req.is_subagent` and scheduler decision is not `Defer`, at `:4234-4236` |
| `crates/mc-module/src/transform.rs:4453-4460` | `Hard` | non-subagent `match plan` arm `Hard | MigrateHard`, opened at `:4251-4254` |
| `crates/mc-module/src/transform.rs:4649-4656` | `Hard` | non-subagent `PassPlan::Soft` arm when `pressure_refold` is true; condition at `:4543-4550` |
| `crates/mc-module/src/transform.rs:4737-4744` | `Soft` | `else` of the same `pressure_refold` branch, opened at `:4691` |
| `crates/mc-module/src/transform.rs:4782` | `SoftPlus` | non-subagent `PassPlan::Defer` arm, opened at `:4774` |

The two groups cannot mix. `apply_once` returns directly into
`apply_additive_only` when compaction is disabled
(`crates/mc-module/src/transform.rs:3043-3056`). The first two sites live inside
that returned function. The remaining five live in the compaction-enabled body.

Inside `apply_additive_only`, one `match plan` owns both sites
(`transform.rs:2748-2889`). `Hard | MigrateHard` and `Soft` are distinct arms;
`Defer` executes no step (`:2883-2887`), and `Reject` was returned before
composition (`:2710-2712`).

Inside the main path, the subagent branch and the non-subagent `match plan` are
the two halves of one `if/else` (`transform.rs:4234-4252`). A subagent scheduler
Defer executes no step. In the non-subagent branch, `Reject` returns before a
step (`:4252-4254`), the Hard and Defer arms each contain one site, and the Soft
arm selects exactly one of its Hard/Soft sites through the `pressure_refold`
`if/else` (`:4543-4550`, `:4691`).

### Move argument

The main path constructs one owned `String` named `boundary_token` at
`crates/mc-module/src/transform.rs:3329-3338`. Each of the five main-path step
sites moves that same value into `PassInput.boundary_present`:

- subagent Soft: `:4236-4239`
- plan Hard: `:4453-4456`
- pressure-refold Hard: `:4649-4652`
- non-refold Soft: `:4737-4740`
- Defer SoftPlus: `:4782`

`PassInput.boundary_present` is an owned `String`
(`commons@cb5a5c01:crates/cortexkit-cache-core/src/lib.rs:100-118`), and
`PassInput::new` consumes an `Into<String>` at
`commons@cb5a5c01:crates/cortexkit-cache-core/src/lib.rs:120-132`. Without a clone or
other replacement value, two main-path sites on one control-flow path would
attempt to use `boundary_token` after move and fail to compile.

This compiler argument does not cover the two additive-only sites: each creates
its own `"-".to_string()` (`transform.rs:2785-2788`, `:2852-2855`). Their
exclusivity comes from the single `match plan` and the early return from
`apply_once`.

### What each action changes

`CoreState::step` dispatches the proposed action at
`commons@cb5a5c01:crates/cortexkit-cache-core/src/lib.rs:164-173`.

- `SoftPlus` queues pending units, optionally retains only lineage units, and
  recomputes `reconcile_pending` without incrementing `version`
  (`:181-212`).
- `Soft` applies rendered units, conditionally advances the boundary, and
  increments `version` once (`:234-246`).
- `Hard` drains pending changes into rendered units, applies them, updates the
  boundary, clears reconciliation, and increments `version` once (`:252-265`).
- `apply_units` replaces existing keys in place and appends new keys in input
  order (`:271-279`).

All seven module call sites discard the returned `StepResult`. Its fields are
defined at `commons@cb5a5c01:crates/cortexkit-cache-core/src/lib.rs:134-139`.

## Failure scenario

A second Soft or Hard step in one pass would increment `core.version` twice.
A second Hard would also re-run `apply_units` after `pending_changes` had already
been drained. A Soft after Hard would evaluate the Soft boundary guard against
state already changed by the same pass. Current control flow prevents these
sequences.

The move check is intentionally described as supporting evidence, not the whole
proof. Cloning `boundary_token` at every main-path site would remove that compiler
backstop while leaving the present branches mutually exclusive.

## Timing windows and dependencies

None. This is a structural, single-pass property.

The property depends on three source shapes:

1. compaction-disabled execution returns into `apply_additive_only`;
2. additive-only planning uses one `match`;
3. the main path keeps subagent and non-subagent work in one `if/else`, with the
   Soft refold decision in one nested `if/else`.

## What a test must construct

Instrument a wrapper around `CoreState::step` and count calls per `apply_once`
attempt. Assert:

- zero or one call for every accepted pass;
- zero on additive-only Defer and subagent scheduler Defer;
- one Hard on additive-only Hard/MigrateHard;
- one Soft on additive-only Soft;
- one Soft on non-Defer subagent;
- one Hard on non-subagent Hard/MigrateHard;
- one Hard or one Soft, never both, across the two `pressure_refold` outcomes;
- one SoftPlus on non-subagent Defer.

As a behavior proxy, assert the core-version delta is zero when no step or a
SoftPlus step executes, and one when Soft or Hard executes. The response exposes
`core.version` at `crates/mc-module/src/transform.rs:5263-5275`.

## Investigation log

### Q: Are there still five call sites?

- Sources examined: every `core.step` occurrence in
  `crates/mc-module/src/transform.rs`.
- Finding: no. There are seven, at lines 2785, 2852, 4236, 4453, 4649, 4737,
  and 4782.
- Missing evidence: none.

### Q: Can one pass reach two sites?

- Sources examined: `transform.rs:2710-2889`, `:3043-3056`, `:4234-4254`,
  `:4543-4550`, `:4691-4788`;
  `commons@cb5a5c01:crates/cortexkit-cache-core/src/lib.rs:100-132`.
- Finding: no current path reaches two. Some accepted paths reach zero, so the
  precise invariant is at-most-one rather than exactly one.
- Missing evidence: no runtime counter exists; the conclusion is structural.
