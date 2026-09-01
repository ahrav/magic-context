# setup-readiness-is-decided-by-one-predicate

## Discovery trigger

While enumerating the negotiation-first gate for gap G1 I expected one predicate
and five call sites. There are two predicates. Four frame-kind arms call
`transport_ready`; the channel-0 control gate hand-rolls the same `matches!`
inline. The `Pong` hole recorded separately has exactly the shape that duplication
produces, so the duplication is worth its own record even though the two copies
currently agree.

The second half of the trigger was the doc-to-code state mapping: the document
names eight states (`docs/mc-host-wire-protocol.md:653-670`) and the code has four
variants, so a reader tracing the document cannot find a guard for four of them
and needs the mapping written down.

## Evidence trail

The function, `crates/mc-host/src/connection.rs:832-837`:

```rust
fn transport_ready(setup: &ConnectionSetup) -> bool {
    matches!(
        setup.state,
        TransportState::TcpCommitted | TransportState::ProviderActive
    )
}
```

The inline copy, `connection.rs:642-647`:

```rust
if !matches!(
    setup.state,
    TransportState::TcpCommitted | TransportState::ProviderActive
) {
    return ControlFlow::Close(ReadExit::Peer);
}
```

Textually identical predicates over the same field. Call sites of the function:
`:430`, `:483`, `:495`, `:552`. Call site of the copy: `:642`. Nothing forces the
two to agree; no test reads the setup state at all.

The variant set, `connection.rs:785-793`: `BootstrapTcp`, `TcpCommitted`,
`CandidateSetup`, `ProviderActive`. The `matches!` shape is the fail-closed
direction: a fifth variant is refused by both copies until an author explicitly
adds it. That is the good news, and it is also the trap, because adding it to one
copy compiles and passes.

The state mapping against the document's diagram, verified arc by arc:

| Document node (`:653-670`) | In-code representation |
| --- | --- |
| `Authenticating` | No variant. `authenticate_server` at `:148-155`, failure return at `:158-160`, both before `ConnectionSetup::bootstrap()` at `:194`. |
| `SetupOnly` | `BootstrapTcp` (`:786`). |
| `TcpCommitted` | `TcpCommitted` (`:787`), assigned at `:960`. |
| `CandidatePrepared`, `Activating`, `AwaitingCommit` | One variant, `CandidateSetup` (`:788-790`), assigned at `:1103`. The three sub-stages are the sequential body of `run_candidate_setup` (`:1130-1199`): activation `:1140-1152`, commit `:1154-1171`. The collapse is documented at `:781-784`. |
| `ProviderActive` | `ProviderActive` (`:792`), reached only as the initial state of a fresh `ConnectionSetup::provider_active()` (`:812-818`) for a fresh generation (`:211-224`), never by mutating an existing setup. |
| `Retired` | Not a state. It is the read loop returning a `ReadExit` (`:371-379`), stated at `:780`: "`Retired` has no variant: it is the read loop returning a [`ReadExit`]." |

So a reader tracing the document finds:

- No guard for `Authenticating`, correctly, because it precedes the type.
- One guard for three documented states, which is correct but means the document's
  `Activating --> Retired: token, timeout, or channel failure` arc (`:664`) is
  enforced inside `run_candidate_setup` and `expect_candidate_request`
  (`:1211-1230`), not by the setup gate at all.
- No guard for `Retired`, correctly, because there is no state to guard. That the
  document draws `Retired` as a state and the code makes it a return value is a
  representation difference, not a defect, and it is the safer of the two shapes:
  there is no retired state that a `matches!` arm could mistakenly admit.

## Failure scenario

A future change adds a fifth setup state, for example a `Draining` or a
`Renegotiating` state, and updates `transport_ready` but not the inline copy at
`:642-645`, or the reverse. The gate then admits channel-0 control operations in a
state where routed requests are refused, or refuses control while routed dispatch
proceeds. Either direction produces a non-uniform negotiation-first gate, which is
precisely the class of defect the `Pong` arm already demonstrates: one frame kind
following a different rule than the other seven, with no compiler error and no
failing test.

The blast radius of the control half is larger than it looks: the control gate is
what stands between an un-negotiated generation and `route.open`
(`connection.rs:753-765`), `host.shutdown` (`:721-728`), and `host.status`
(`:729-752`).

## Timing windows and dependencies

None. This is a structural property of the source. The fault is a future edit, not
a runtime interleaving, and the check is a source-level or extracted-predicate
assertion rather than a scenario.

It does depend on the enforcement class question the portfolio evaluation raised
as bias 3: the cheapest correct instrument here is arguably not a test at all. If
the inline copy is deleted and `handle_control` calls `transport_ready`, the
property becomes unfalsifiable by construction and needs no check. That
possibility belongs in the record's check line, and it is stated there.

## What a test must construct

Either of two things, and the second is preferred:

1. A test over an extracted predicate: enumerate all `TransportState` variants and
   assert that the function and the inline copy classify each identically. This
   requires making the inline copy callable, which is most of the work of just
   deleting it.
2. A structural assertion: `transport_ready` is the only readiness test in the
   file. Cheap as a grep-based test or a clippy-style lint over
   `connection.rs`, and it fires on the real fault, which is a second copy
   appearing rather than the current two disagreeing.

Neither is a runtime scenario, and a fixture that adds a fifth variant proves only
that `matches!` fails closed, which the language already guarantees.

## Investigation log

### Q: Is the inline copy at `:642-645` deliberate?

- Sources examined: `connection.rs:626-647` (`handle_control`'s prologue),
  `:832-837` (`transport_ready`), the four function call sites, and the negotiation
  interception at `:636-641`.
- Findings: no comment explains the duplication. There is a plausible mechanical
  reason: `handle_control` runs the negotiation interception first (`:636-641`) and
  the gate second, so the gate reads as part of that prologue rather than as a
  per-frame check like the four read-loop sites. There is no visibility or borrow
  obstacle: `transport_ready` takes `&ConnectionSetup` and `handle_control` holds
  `setup: &mut ConnectionSetup` (`:631`), so the call would compile unchanged.
- Missing evidence: no design note, plan reference, or commit message in the tree
  addresses it. The surrounding comments cite plan identifiers (KTD4, KTD6, KTD9,
  KTD10) but none covers this.
- Conclusion: needs human input. The record does not assert it is a defect; it
  asserts the two copies must agree, which is true either way.
