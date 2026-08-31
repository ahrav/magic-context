# documented-close-order-has-a-production-driver

## Discovery trigger

`docs/mc-host-shm-transport.md:63` states a seven-stage close ordering as
implemented behaviour, and the traceability record marks the corresponding
requirement `PASS` on the strength of a contract test. The type that encodes
that ordering was traced to its callers to establish which shipping code obeys
it.

## Evidence trail

`crates/mc-shm-transport/src/lifecycle.rs` encodes the ordering faithfully.
`CloseState` (lines 4-27) declares eleven variants whose doc comments track the
documented stages almost word for word — `Quiescing` is "New admission has
stopped", `DrainingPublished` is "Already-published frames are draining",
`RevokingJsOnEnv` is "The environment thread detaches JavaScript aliases"
(reworded from "JavaScript aliases are being detached on environment thread"
by the #131 comment pass),
`AwaitingRustScopes`, `ReleasingSamples`, `DroppingTransport`, `Joined`.
`advance` permits exactly one edge per step (valid pairs at lines 59-77) and
treats `Joined` and `Quarantined` as terminal (line 80). `mark_prepared`
(lines 41-47) and `must_fail_closed` (lines 49-51) encode the
no-TCP-replay-after-preparation rule (formerly cited to
`docs/mc-host-shm-transport.md:61`; the trimmed post-#131 document no longer
carries that sentence — unresolved, needs a current normative source for the
documented ordering).

A repository-wide search for `CloseState`, `Lifecycle::new`, `mark_prepared`,
and `must_fail_closed`, excluding `docs/` and `target/`, returns matches in
exactly two files:

- `crates/mc-shm-transport/src/lifecycle.rs` — the definition itself.
- `crates/mc-shm-transport/tests/contract.rs` — lines 272-335, all inside
  `lifecycle_accepts_only_diagram_edges_and_quarantine_is_terminal` (declared at
  line 272).

No production caller exists. `Lifecycle` is constructed only by the test.

The two real close paths each implement their own ordering:

- **Addon.** `close` (`packages/mc-shm-native/src/lib.rs:1308`) calls
  `close_channel` (`:358-373`), which sets `channel.closed = true`, aborts every
  registered producer reservation via `detach_producer(...)?.abort()`, detaches
  every active lease, then detaches stranded references. `force_close` (`:1335`)
  calls `quarantine_channel` (`:375`), which additionally calls
  `enter_quarantine()` on both rings (`:381-382`) before the same detach
  sequence. Neither calls `Lifecycle::advance`.
- **Host.** The endpoint thread wraps `run_endpoint` in `catch_unwind`
  (`crates/mc-host/src/ring_transport.rs:264-275`) and then takes no branch at
  all on the result: the unconditional `admission.release()` at `:276` follows
  regardless of outcome (the former clean/unclean custody disposition was
  deleted with `shm_provider.rs`). This is a disposition decision, not an
  ordered teardown, and it does not call `Lifecycle::advance` either.

The documented "drains published data" stage has no counterpart in the addon
path. `close_channel` **aborts** producer reservations rather than committing or
draining them, and **detaches** active leases rather than waiting for them to be
received. Published-but-unreceived frames are not polled.

## Failure scenario

A future change reorders the addon close path — for example, detaching stranded
references before active leases, or dropping the mapping before the last alias
is revoked. `lifecycle_accepts_only_diagram_edges_and_quarantine_is_terminal`
still passes, because it exercises a model that the changed code does not touch.
The traceability row still reads `PASS`. The documentation still describes the
original order. Nothing in the tree contradicts any of the three, and the
divergence is invisible until a use-after-free surfaces at runtime.

## Timing windows and dependencies

None. This is a static reachability question: does any non-test caller advance
the machine. The answer does not depend on scheduling, faults, or state.

The dependency worth naming is that this property is what makes several other
close-ordering claims unverifiable. Any property whose evidence is the
lifecycle contract test inherits this gap, because that test proves the model's
edges rather than the shipping paths' behaviour.

## What a test must construct

A reachability assertion, not a state construction:

1. Assert that at least one non-test caller advances `Lifecycle`. Today this
   fails by inspection, so the check is a static one — for example, a test that
   would fail if `Lifecycle` were referenced only from `tests/`.
2. Failing that, the alternative is to make the shipping paths the object of
   test. That requires an observable trace of stage transitions from
   `close_channel`, `quarantine_channel`, and the host disposition branch, and
   an assertion that the observed sequence is an accepted path through
   `CloseState`.
3. Either way, a case that pins the `DrainingPublished` stage is needed, because
   that is the stage with no implementation in the addon path. The construction
   is a channel closed while a committed frame has not been received, asserting
   the documented disposition for that frame.

## Investigation log

### Q: Is the state machine intended to become the driver, or is it a specification artifact? If specification-only, which code is normative for close ordering?

- Sources examined: `crates/mc-shm-transport/src/lifecycle.rs` in full;
  repository-wide search for `CloseState`, `Lifecycle::new`, `mark_prepared`,
  `must_fail_closed` excluding `docs/` and `target/`;
  `crates/mc-shm-transport/tests/contract.rs:272-335`;
  `packages/mc-shm-native/src/lib.rs:358-393` and `:1308-1356`;
  `crates/mc-host/src/ring_transport.rs:256-282`;
  `docs/mc-host-shm-transport.md` (the close narrative formerly at `:59-65` is
  gone from the trimmed post-#131 document).
- Findings: the machine is a complete and internally consistent encoding of the
  documented ordering, with per-edge validation and correct terminality. It has
  no production caller. The two shipping close paths implement partial,
  differently-shaped teardowns and neither references it. The pre-#131
  `//! Checked close state machine` module doc comment is gone at HEAD
  (`lifecycle.rs` now opens with `use std::fmt;`), so nothing
  distinguishes specification from implementation.
- Missing evidence: no plan document, comment, or issue reviewed for this part
  states whether the machine is intended to be wired in. The `advance` API
  takes `&mut self`, which suits a driver rather than a validator, but that is
  suggestive, not decisive. I did not read `run_endpoint` in full, so whether
  the host path performs an internal drain before returning its boolean is not
  established here; what is established is that it does not advance the machine.
- Conclusion: needs human input. The mechanical facts are settled — two
  referencing files, no production driver, and one documented stage with no
  counterpart in the addon path — but which artifact is normative for close
  ordering is a decision the tree does not record.
