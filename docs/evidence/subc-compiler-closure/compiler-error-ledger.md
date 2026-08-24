# Compiler-Error Ledger — subc Compiler Closure

Task: `magic-context-c50.12` · Plan: `2026-08-24-0115-fix-subc-compiler-closure-plan.md`
Worktree revision: `e1a09a549e6560543b906e73521f484c01010fb8` (pass repeated clean at
`574569d5`, the current `main` tip; log sections `[rerun-*]`) · Toolchain: rustc 1.97.1

Rule: the stubs were seeded from the verified inventory
(`docs/subc-api-surface-inventory-2026-08-17.md`), and every later stub change
required a rustc diagnostic first. This ledger holds exactly those changes.
Diagnostics quoted from `compiler-closure.log`.

## Entry 1 — `FrameType::Ping` (genuine completeness miss; the positive control)

- **Demanding target:** `cargo test -p mc-module --test broca_roundtrip --no-run`
- **Demanding site:** `crates/mc-module/tests/broca_roundtrip.rs:544`
- **Diagnostic (log section `stub-pass ledger-1 Ping positive control (pre-fix)`):**

  ```text
  error[E0599]: no variant, associated function, or constant named `Ping` found for enum `FrameType` in the current scope
     --> crates/mc-module/tests/broca_roundtrip.rs:544:54
      |
  544 |                     && frame.header.ty != FrameType::Ping
      |                                                      ^^^^ variant, associated function, or constant not found in `FrameType`
  ```

- **Stub change:** added variant `Ping` to `subc_protocol::FrameType`.
- **Inventory impact:** new row (test class, weight P). Published `subc-protocol`
  0.10.0 declares `Ping = 7`, so the row scores **exact**.
- **Classification:** genuine inventory miss, additive, published — pass continues
  per R13. This was also the deliberate seed omission (R9), proving the pass
  detects a missing item rather than silently absorbing it.

## Entry 2 — `PartialEq` on `manifest::ConsumerRole` (shape mismatch)

- **Demanding target:** `cargo test -p mc-module --lib --no-run`
- **Demanding site:** `crates/mc-module/src/lib.rs:16853` (unit test compares
  `manifest().consumes` with `assert_eq!`)
- **Diagnostic (log section `stub-pass ledger-2 (pre-fix)`):**

  ```text
  error[E0369]: binary operation `==` cannot be applied to type `Vec<subc_protocol::manifest::ConsumerRole>`
       --> crates/mc-module/src/lib.rs:16853:9
        |
  16853 | /         assert_eq!(
  16854 | |             m.consumes,
  16855 | |             vec![ConsumerRole::ServiceClient {
  16856 | |                 of: vec!["thalamus".to_string()]
  ```

- **Stub change:** derived `PartialEq, Eq` on `subc_protocol::manifest::ConsumerRole`.
- **Inventory impact:** existing row's required shape amended to include
  `PartialEq` (test-demanded). Published 0.10.0 derives `PartialEq` on
  `ConsumerRole`, so the row stays **exact**.
- **Classification:** shape mismatch between the recorded row and the compiled
  requirement; additive, published — pass continues per R13.

## Entry 3 — derive/trait strictness sweep (review-driven re-run)

A review of the first pass found the seeded stubs **over-derived**: traits like
`Debug`, `Clone`, `PartialEq`, `Eq`, and serde impls were present without a
mapping inventory row, which could silently absorb exactly the fault class
entry 2 caught. Every un-demanded derive and trait impl was stripped and the
full pass repeated (log sections `[strict-derives ...]`) so rustc demanded the
real trait surface. Each demanded trait below was captured pre-fix in the log,
added back with a doc comment naming the demanding site, and folded into the
inventory row's required shape. All are present in the published MIT sources,
so **every row stays `exact` and the totals are unchanged**.

| Type | Demanded trait(s) | Demanding site | Diagnostic |
| --- | --- | --- | --- |
| `subc_protocol::ErrorBody` | `Debug` | structural: `CallError::Module(ErrorBody)` + the `CallError` row's recorded `Debug` | E0277, iter-1 |
| `subc_protocol::BindIdentity` | `Clone` | `session_resolver.rs:101` (`identity.clone()`) | E0599, iter-2 |
| `subc_protocol::RouteTarget` | `Clone`; `PartialEq` + `Debug` (test) | `session_resolver.rs:100`; unit test `session_resolver.rs:255` `assert_eq!` | E0599/E0369/E0277 |
| `subc_protocol::FrameType` | `Debug` (test) | `tests/broca_roundtrip.rs:583` `assert_eq!` | E0277, iter-6 |
| `manifest::ConsumerRole` | `Debug` (test) | lib unit-test `assert_eq!` on `manifest().consumes` | E0277, iter-4 |
| `manifest::ExecutionMode` | `Debug` (test) | `prompt_surface.rs:338` `assert_eq!` | E0277, iter-4 |
| `subc_client_rs::HandlerOutcome` | `Debug` (test) | lib unit tests format `{other:?}` (lib.rs:17261 + siblings) | E0277, iter-4 |
| `subc_client_rs::HealthStatus` | `Debug` (test) | lib.rs:17067 `assert_eq!` | E0277, iter-4 |
| `subc_control::ClientControlResponse` | `Debug` (test) | `tests/broca_roundtrip.rs:591:58` `panic!("unexpected control response {other:?}")` | E0277, iter-6 |
| `AuthError`, `ConnectionFileError`, `FrameIoError`, `FrameBuildError` | `std::error::Error` | `historian_producer.rs:522-526` `source()` casts to `&dyn StdError` | E0277, iter-8 |

Serde impls retained without individual diagnostics are wire-contract rows
(`BindIdentity`, `RouteTarget`, `ConsumerIdentity`, `ClientControlRequest`/
`Response` — "serde-tagged control envelope"; `Tool` — "serde must
round-trip"; `ModuleHelloAckBody.storage` deserialization), and the `Default`
derives are recorded in the `CallOptions`/`CloseRouteOptions` rows
(`RetryBackoff`'s `Default` is structural to `CallOptions`'s). The sweep also
proved two impls **un-demanded** and removed them: `std::error::Error` for
`CallError` and for the opaque connect error (their rows record only
`Display` + `Debug`).

## Non-entries (observed, deliberately not stub changes)

- `warning: irrefutable if let pattern` (`historian_producer.rs:947`),
  `warning: unreachable pattern` (`tests/broca_roundtrip.rs:588`), and
  `warning: unreachable else clause` (lib test, `ProviderRole` match):
  mc-module matches `ClientControlResponse`/`ClientControlRequest`/
  `ProviderRole` non-exhaustively, so a single-variant strict stub compiles
  with a warning. The real enums carry additional variants mc-module never
  names; adding speculative variants would violate the no-unverified-surface
  rule (R6). No API item is missing.
- No demanded item was private-only or behavior-heavy, so the R13/AE4 stop
  condition never triggered; the closure leaves the original c50.1
  shim-vs-rewrite analysis unchanged. The operative decision remains the
  direct mc-host port with no `subc-*` compatibility shims
  (`magic-context-c50.1` as of 2026-08-22, executed by `magic-context-c50.4`).

## Totals

2 surface ledger entries (plus the entry-3 trait-shape amendments, which stay
within existing rows) → inventory moves from 86 rows (82 exact / 3 changed / 0
absent / 1 private-unknown) to **87 rows (83 exact / 3 changed / 0 absent / 1
private-unknown)**. Every demanded item and trait is satisfied by the
published MIT sources.
