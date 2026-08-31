# operation-counters-are-observed-not-declared

## Discovery trigger

The release gate in `benches/manifests/v1.json` names six counter fields as
`required_counter_fields` (lines 147-154) and sets
`injected_gate_control_must_be_disqualified: true` (line 155). A gate that
decides whether a shared-memory provider may ship is only as good as the
provenance of the numbers it reads, so each counter was traced back from the
gate to the site that writes it.

## Evidence trail

`crates/mc-shm-transport/src/evidence.rs` declares the six fields at lines 9,
11, 13, 15, 17, and 19, and reads them at lines 30, 33, 36, 40, 43, and 46 to
emit reason codes. The type performs no counting; it classifies values handed
to it.

Every write to any of the six fields, repository-wide, is one of:

- `crates/mc-shm-transport/tests/contract.rs:488-493` — a literal `1` per field
  in the `purity_gate_rejects_injected_copy_allocation_queue_and_wake` fixture
  (`#[test]` at line 420, `fn` at line 421).
- `crates/mc-shm-transport/benches/hardware_envelope.rs:162-167` — construction
  from the `measure` tuple; `generic_queue_hops: 0` and `scheduler_handoffs: 0`
  are literals here.
- `benches/hardware_envelope.rs:191-196` — all six overwritten with `1` under
  `if arm == "injected_avoidable_operations"`.
- `benches/hardware_envelope.rs:212-217` — copied into the emitted
  `Measurement`.
- `benches/hardware_envelope.rs:249-254` — all six zeroed in `failed()`.

`OperationCounters` is imported by exactly two files outside its own module:
`tests/contract.rs:10` and `benches/hardware_envelope.rs:14`. No production
(non-test, non-bench) code path increments any of the six fields.

Per-counter provenance in the bench, by arm family:

| Counter | `ring` / `h1` / ablations (`run_ring`) | `unix_socket` / `tcp` | `h0` | `iceoryx_0_9_3` |
| --- | --- | --- | --- | --- |
| `body_copies` | producer side observed at the `body.clone()` site (`:376-377`); receiver side computed as `copied_receiver as u64 * iterations` (`:397-398`) | `iterations * 2` (`:523`) | `0` (`:314`) | `0` (`:597`) |
| `native_allocations` | producer side observed at `:378`; receiver side computed at `:399` | literal `3` (`:524`) | `0` | `0` |
| `syscalls` | literal `0` (`:409`) | `iterations * 4` (`:525`) | `0` | `0` |
| `park_wakes` | `u64::from(scheduling == ColdParkWake) * iterations` (`:410`) | `0` (`:526`) | `0` | `0` |
| `generic_queue_hops` | literal `0` (`:187`) | literal `0` | literal `0` | literal `0` |
| `scheduler_handoffs` | literal `0` (`:188`) | literal `0` | literal `0` | literal `0` |

For the selectable `ring` arm, `copied_producer` and `copied_receiver` are both
`false` (`:166`), so none of the six counters is observed at an operation site:
four are literals and `park_wakes` is derived from the schedule label.

The receiver copy is `lease.to_vec()` in `ring_consumer` at `:436`, which runs
in the child forked at `:361`. The count is added in the parent at `:397-400`,
after `wait_child(child)` at `:393` — a different process, after the process
that performed the copy exited.

`park_wakes` derives from the mode label, not from wakes: the sleep is
`std::thread::sleep(Duration::from_micros(50))` at `:429`, reached only when
`try_receive()` returns `Ok(None)`, so the true count is data-dependent while
the reported count is `iterations` exactly.

The gate control `injected_avoidable_operations` dispatches to
`run_ring(scheduling, iterations, payload, false, false)` at `:176` — argument
for argument the same body as the selectable `ring` arm at `:165-167` — and
then has all six counters replaced by `1` on the strength of its arm name.

## Failure scenario

A body copy is added to the `ring` receive path. `syscalls`,
`generic_queue_hops`, and `scheduler_handoffs` are literal zeros;
`body_copies` and `native_allocations` for the leased-receiver configuration
are `0 + (false as u64 * iterations) == 0`. `disqualifications()` returns an
empty vector, the reason string becomes "smoke evidence is never
designated-host qualification", and the arm reports as clean. The gate reads
`body_copies == 0` from a run that performed one copy per frame.

## Timing windows and dependencies

None. This is a static property of the harness: the values are assigned from
constants, arm labels, booleans, and iteration counts before any observation
could contradict them. No interleaving, fault, or race is needed to reach the
defect, and no timing makes it go away.

## What a test must construct

Two negative controls, each asserting that a counter *drops* when the
corresponding operation is removed:

1. Run the copied-receiver ablation, record `body_copies`, then run the same
   arm with the `lease.to_vec()` at `:436` replaced by the leased path, and
   assert the value falls by `iterations`. Today it falls because the boolean
   changed, not because the copy went away, so the control must instead keep
   `copied_receiver == true` and remove the copy — which currently produces no
   change and is therefore the discriminating case.
2. Run the cold arm, record `park_wakes`, then remove the `:429` sleep and
   assert the value falls. It will not.

Both controls require the counter to be incremented in the process and at the
site that performs the operation, which means the child must report its own
counts across the fork boundary rather than having them inferred after
`waitpid`.

## Investigation log

### Q: Is `OperationCounters` intended to be wired to real instrumentation, or is it permanently a report-schema type? If the latter, the "counts copies" language in `docs/mc-host-shm-transport.md:25` overstates what any artifact can prove.

- Sources examined: `crates/mc-shm-transport/src/evidence.rs` in full;
  repository-wide search for each of the six field names and for
  `OperationCounters` and `disqualifications`;
  `benches/hardware_envelope.rs` in full; `benches/manifests/v1.json`
  `selection_gate`; `tests/contract.rs:486-509`;
  `docs/mc-host-shm-transport.md:25`.
- Findings: the type has no constructor that observes anything and no
  production caller. Its doc comment calls it "Operation counters used to
  produce disqualification reason codes", which describes a classifier, not an
  instrument. `docs/mc-host-shm-transport.md:25` reads "Owned-buffer adapters
  count their copies separately and are never zero-copy evidence", which
  asserts that counting happens. No code performs that counting for the
  transport arms.
- Missing evidence: nothing in the repository states the intended design. The
  manifest requires the fields but not their provenance. No plan document
  reviewed for this part assigns ownership of instrumentation.
- Conclusion: needs human input. The mechanical facts are settled — no
  production path writes any counter, and the bench derives all six for the
  selectable arm — but whether that is a gap or the intended scope is a design
  decision that is not recorded anywhere in the tree.
