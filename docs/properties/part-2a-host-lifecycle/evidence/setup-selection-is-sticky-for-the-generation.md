# setup-selection-is-sticky-for-the-generation

## Discovery trigger

`docs/mc-host-wire-protocol.md:651` makes stickiness normative in one sentence:
"Selection is sticky for the generation: a direct TCP selection, a negotiated TCP
fallback, or a committed non-TCP grant remains fixed until retirement... At most
one candidate may be prepared. Any late or repeated negotiation, or any
application-bearing operation while a candidate is being set up, retires the
generation." Gap G1 named it uncataloged. The reason it matters more than it
looks: the candidate handoff slot is a single `Option`, so a second accepted
negotiation would not just violate the protocol, it would overwrite a live
resource handle.

## Evidence trail

`setup.state` is written in exactly two places in the whole crate, confirmed by
grep over `crates/mc-host/src/connection.rs`:

- `:960` — `setup.state = TransportState::TcpCommitted;` immediately before
  `respond_tcp` at `:961`.
- `:1103` — `setup.state = TransportState::CandidateSetup;` in `grant_candidate`,
  immediately before `setup.handoff = Some(handoff)` at `:1104`.

The two constructors set an initial state rather than transition:
`ConnectionSetup::bootstrap()` at `:802-808` (`BootstrapTcp`) and
`ConnectionSetup::provider_active()` at `:812-818` (`ProviderActive`).

The gate that makes those writes at-most-once is `handle_negotiate:846-848`:

```rust
if !matches!(setup.state, TransportState::BootstrapTcp) {
    return ControlFlow::Close(ReadExit::Peer);
}
```

Both write sites leave `BootstrapTcp`, and nothing writes it back. So:

- A second negotiate on a TCP-committed generation retires. Covered by
  `tests/transport_negotiation.rs:962-980`.
- A negotiate during candidate setup retires. Uncovered.
- A negotiate on a promoted generation retires, because
  `ConnectionSetup::provider_active()` starts at `ProviderActive` (`:814`).
  Uncovered.

`setup.handoff` has exactly one write, `:1104`, and one read,
`setup.handoff.take()` in `serve_generation:349`. The take happens after
`gen.read_tasks.wait().await` at `:340`, and the comment at `:346-348` states why
that ordering makes the transfer race-free: the candidate driver is tracked in
`read_tasks`, so it has already joined and is the only writer of the promotion
slot.

The document's state diagram (`:653-670`) matches these arcs, with one
representation difference worth recording. `AwaitingCommit --> ProviderActive`
(`:665`) is not a state mutation. `run_candidate_setup` stores the promoted
receiver at `:1186` and retires the bootstrap at `:1189-1190`; `run_connection`
then mints a second generation at `:211-216` and calls `serve_generation` again at
`:217-224` with a fresh `ConnectionSetup`. One documented state machine spans two
in-code generations.

## Failure scenario

Suppose the gate at `:846-848` were relaxed to allow renegotiation from
`CandidateSetup`, or a future state were added and omitted from the `matches!`.
A second `grant_candidate` runs, reaches `:1104`, and assigns a new
`Arc<CandidateHandoff>` over the old one. The old handoff is dropped from the
setup, so the reaping path in `run_connection:201-234` never sees it. That path is
the stated guarantee of release: the comment at `:227-228` says the setup owner,
not the provider, is what guarantees resource release. The first candidate's
`FrameSender`, cancellation root, and spawned I/O task therefore survive with no
owner until process exit or until the provider's own internal fencing notices.

The second failure mode is the protocol one: two prepared candidates against one
authenticated bootstrap violates the bound the connection permit is supposed to
enforce (`:136-138` states that holding the authenticated connection permit for
the whole setup is what bounds prepared candidates by `max_connections`).

## Timing windows and dependencies

There is no interleaving to construct. All three writes happen on the sole read
loop of one generation, and `handle_negotiate` is `await`ed inline from
`handle_control` (`:638`), so no second negotiate can be in flight concurrently.
This is a control-flow property, not a concurrency one, and a current-thread test
is sufficient.

The timing detail that does matter runs the other way: the state closes at `:960`
and `:1103` *before* the corresponding response is queued. A client that pipelines
two negotiate requests will therefore observe retirement, and may observe it
before or interleaved with the first selection response, depending on writer
scheduling. A test must not require the first response to arrive before the close.

Reachability splits by arc. `TcpCommitted` needs no provider and no configuration,
so it is default-production. `CandidateSetup` and `ProviderActive` are only
reachable through `grant_candidate`, which needs `providers.find` to succeed
(`:901-905`) against a registry that is empty by default
(`transport_provider.rs:157-163`), so those arcs are test-only.

## What a test must construct

1. The covered case, as a baseline: negotiate TCP, negotiate again, assert close.
   Exists at `tests/transport_negotiation.rs:962`.
2. Negotiate during candidate setup: inject a provider whose `prepare` blocks long
   enough to hold `CandidateSetup`, send a second negotiate on the bootstrap, and
   assert both bootstrap and candidate retire with no promotion.
3. Negotiate on a promoted generation: complete activation and commit, then send a
   negotiate on the candidate channel and assert retirement.
4. The resource claim, which is the one worth the most: after any of the above,
   assert that every prepared candidate's sender is discarded and its I/O task has
   completed. A counting provider that records `prepared_count` already exists in
   the test file (`tests/transport_negotiation.rs:899` reads it), so the
   instrumentation is available.

## Investigation log

### Q: Can `setup.handoff` be overwritten in the tree as it stands?

- Sources examined: all writes to `setup.state` and `setup.handoff` in
  `connection.rs`; `handle_negotiate:846-848`; `grant_candidate:1001-1122`;
  `serve_generation:349`; `run_connection:198-235`.
- Findings: no. The only write to `setup.handoff` is at `:1104`, reachable only
  from `grant_candidate`, reachable only from `handle_negotiate`'s serveable-offer
  branch at `:920-929`, which is guarded by the `BootstrapTcp` check at
  `:846-848`. The state is set to `CandidateSetup` at `:1103`, one line before the
  handoff write, so the door closes before the slot is filled.
- Missing evidence: none. The ordering of `:1103` and `:1104` is load-bearing and
  is not commented as such, which is the fragility this record exists to pin.
- Conclusion: resolved. The property holds today; the record's value is that the
  proof is a two-line ordering with no test behind it.
