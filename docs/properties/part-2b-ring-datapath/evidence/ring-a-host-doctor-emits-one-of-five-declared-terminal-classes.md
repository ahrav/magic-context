# ring-a-host-doctor-emits-one-of-five-declared-terminal-classes

## Discovery trigger

`docs/mc-host-shm-transport.md:53-59` states that
`magic-context daemon doctor` "reports either a healthy fixed ring or one
terminal class", and lists exactly five: `missing_addon`, `identity_mismatch`,
`setup_failure`, `peer_death`, `resource_exhaustion`. Reading
`RingTransport::diagnostics`, which is the host's producer of that report,
shows a two-arm `match` that can emit one of them.

## Evidence trail

**The whole producer.** `crates/mc-host/src/ring_transport.rs:176-190`:

```
let (state, error_class, accounting) = match self.accounting() {
    Ok(accounting) => (
        "healthy",
        serde_json::Value::Null,
        serde_json::json!({
            "active": charges(accounting.active),
            "quarantined": charges(accounting.quarantined),
        }),
    ),
    Err(_) => (
        "terminal",
        serde_json::Value::String("setup_failure".to_owned()),
        serde_json::Value::Null,
    ),
};
```

Two arms. `error_class` is either `Null` or the literal `"setup_failure"`.

**What makes the `Err` arm fire.** `self.accounting()` (`:143-150`) is
`self.admission.snapshot()`. `AdmissionController::snapshot`
(`crates/mc-shm-transport/src/profile.rs:500-510`) returns `Err` on exactly one
condition:

```
let accounting = self
    .accounting
    .lock()
    .map_err(|_| AdmissionError::AccountingUnavailable)?;
```

A poisoned `Mutex`. That requires a panic while the accounting lock is held. The
lock is held inside `admit`, `release`, `quarantine`, and `snapshot`, none of
which calls user code, so no host path panics under it. So the one class the
host can emit is emitted on a condition the host does not create.

**Where the other four literals live.** Grepping all five across `crates/` and
`packages/`:

- `"setup_failure"` in Rust: only `ring_transport.rs:187`.
- `"missing_addon"`, `"identity_mismatch"`, `"peer_death"`,
  `"resource_exhaustion"`: no Rust producer. They appear only in TypeScript, as a
  union at `packages/plugin/src/shared/mc-host-client/types.ts:69-73`, and as
  classification outputs in
  `packages/plugin/src/shared/mc-host-client/shared-memory-failure.ts:14-30`,
  which maps *client-side* error shapes onto the union. `client.ts:1588-1592`
  enumerates them, and `policy.ts:871` derives
  `exhaustion: { observed: errorClass === "resource_exhaustion" ? 1 : 0 }`.

So the taxonomy is real and implemented, on the client, by classifying errors the
client itself saw. The host contributes counters, not classes.

**The counters, and why they do not close the gap.** `diagnostics()` emits five
counters at `:201-205`:

```
"attachment": {"completed": self.preparations.load(Ordering::Acquire)},
"activation": {"completed": self.activations.load(Ordering::Acquire)},
"peer_death": {"observed": self.peer_deaths.load(Ordering::Acquire)},
"reclamation": {"completed": self.reclamations.load(Ordering::Acquire)},
"exhaustion": {"observed": self.exhaustions.load(Ordering::Acquire)},
```

`peer_death` and `resource_exhaustion` therefore exist host-side as *observation
counts*, not as `error_class` values, and `state` never consults them. A host
with `exhaustion.observed` in the thousands still reports `state: "healthy"`,
because the `match` keys on `accounting()` alone.

**A second degeneracy in the same output.** `record_attachment` and
`record_activation` are called back to back with no branch between them
(`connection.rs:187-188`):

```
shared.ring.record_attachment();
shared.ring.record_activation();
```

So `attachment.completed` and `activation.completed` are equal for all time,
while `docs/mc-host-shm-transport.md:66` presents them as two values and the
lifecycle diagram at `:26-36` has a distinct `Attached -> Failed` edge for
"validation, attach, or commit fails" that neither counter can witness. Folded
into this record rather than given its own, because the consequence is confined
to the same diagnostics surface.

## Failure scenario

An operator investigates a host that is serving nothing.

- If the cause is admission exhaustion, `exhaustion.observed` is non-zero and
  `state` is `"healthy"`. The operator has one true number and one misleading
  verdict.
- If the cause is any of the other four `RingUnavailable` producers
  (`ring_transport.rs:260-270`, `:271-275`, `:294-296`, `:297` — see
  `ring-a-ring-unavailability-fails-closed-without-a-classified-reason`), every
  counter is zero and `state` is `"healthy"`. The operator has nothing.
- If the cause is a lost endpoint thread from a hook panic (see
  `ring-a-endpoint-thread-panic-is-reported-as-orderly-completion`), likewise:
  every counter zero, `state: "healthy"`.

In all three the client reports `setup_failed`, so the operator's only signal
comes from the peer, and it does not distinguish the causes either.

## Timing windows and dependencies

No timing window. This is a static enumeration of a two-arm `match`.

Dependencies:

- `ring-a-ring-unavailability-fails-closed-without-a-classified-reason` supplies
  the four uncounted causes.
- `ring-a-host-never-quarantines-an-admission-charge` explains why the
  `"quarantined"` field inside the healthy arm (`:182`) is structurally zero.
- `ring-a-reclamation-count-does-not-witness-charge-release` explains why the
  `reclamation.completed` field cannot be read as a charge witness.

Taken together, four of the eight fields `diagnostics()` emits are degenerate:
`quarantined` is always zero, `attachment` and `activation` are always equal, and
`state` is insensitive to every failure the host actually experiences.

## What a test must construct

The `reachable` check needs one construction per class, and four of the five have
no producer to reach, so the honest test is a producer-existence assertion rather
than a runtime one:

1. Enumerate the five literals from the doc.
2. Assert each has at least one emission site in `RingTransport::diagnostics`.

That is a source-level check, and it belongs beside the
`mandatory-ring-architecture` gate (`ci.yml:41-58`) if the taxonomy is meant to
be host-produced.

For the one existing producer, a runtime test would need a poisoned accounting
mutex. That is constructible only by panicking inside a closure that holds the
lock, which requires a test-only injection into
`AdmissionController`. Given that no host path can poison it, a test proving the
`terminal` arm renders correctly is worth more than a test proving it is
reachable: build the JSON with a stubbed `Err` and assert the shape, so at least
the redaction properties on the terminal branch are covered.

Existing checks: `ring_transport.rs:787-805`
`diagnostics_report_fixed_identity_bounds_accounting_and_lifecycle_counts`
asserts `state == "healthy"`, `error_class == Null`, the three artifact identity
fields, the bounds, both accounting figures, and all five counters, plus a
seven-string redaction sweep at `:807-818`. It is a thorough test of the healthy
arm and covers the terminal arm not at all. It does not run in CI.

## Investigation log

### Q: Is the five-class terminal taxonomy the client's contract only, with the host intended to expose counters?

- Sources examined: `docs/mc-host-shm-transport.md:51-73` (the whole Doctor and
  diagnostics section), `ring_transport.rs:153-207`,
  `packages/plugin/src/shared/mc-host-client/types.ts:69-73`,
  `shared-memory-failure.ts:14-30`, `client.ts:788` and `:1581-1592`,
  `policy.ts:871`.
- Findings: the doc is genuinely ambiguous and the two readings cut differently.
  `:53` attributes the taxonomy to `magic-context daemon doctor`, which is
  host-side, and `:61-69` then lists the healthy report's contents as exactly the
  eight fields `diagnostics()` emits — so the healthy half of the doc describes
  the host's output precisely. But `:71` says "Client diagnostics use the same
  terminal-class set", which implies the host has a set for the client to
  match. And the client's implementation classifies errors it saw itself
  (`shared-memory-failure.ts:14-30` inspects error messages with regexes), not
  values the host sent. `policy.ts:871` even reconstructs an
  `exhaustion.observed` count from a client-derived `errorClass`, which is the
  reverse of the host's direction.
- Missing evidence: whether `magic-context daemon doctor` renders the host's
  `diagnostics()` output directly or merges it with client-side classification.
  That is CLI code I did not read, and it is outside the 2b file list.
- Conclusion: needs human input. The evidence supports "the healthy half is the
  host's contract and the terminal half is the client's", which would make the
  doc's `:53` attribution the error rather than the code. But `:71`'s "same
  terminal-class set" only makes sense if the host has one, so I cannot settle it
  from the two sides I read.

### Q: Should `state` consult the counters, so a host with non-zero exhaustion is not reported healthy?

- Sources examined: `ring_transport.rs:176-190` (the `match`), `:201-205` (the
  counters), `:240` (the only `exhaustions` increment),
  `docs/mc-host-shm-transport.md:59` (`resource_exhaustion` as a terminal class).
- Findings: `resource_exhaustion` being a *terminal* class is the tension.
  Admission exhaustion is not terminal for the host: it is ordinary backpressure
  when `max_connections` live rings exist, and the next disconnect frees a slot.
  So mapping a non-zero `exhaustions` count to `state: "terminal"` would be
  wrong. What is missing is a middle state — the doc's binary healthy-or-terminal
  shape has no room for "saturated". Note that `runtime.rs` initializes the
  host's own `HealthReport` with `HealthStatus::Degraded`
  (`runtime.rs:889-891`), so a three-valued health vocabulary exists elsewhere in
  the crate.
- Missing evidence: whether `HealthStatus` and the doctor's state field are meant
  to be the same vocabulary. `runtime.rs` is sub-part 2f scope.
- Conclusion: unresolved. The simple fix is wrong because exhaustion is not
  terminal; the right fix needs a state the doc does not define. Recorded as the
  open question rather than resolved in favour of either side.
