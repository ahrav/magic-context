# ring-a-host-never-quarantines-an-admission-charge

## Discovery trigger

`docs/mc-host-shm-transport.md` presents quarantined charge accounting as a live
safety mechanism in three places: `:21` ("Active and quarantined charges are
reported separately"), `:65` ("active and quarantined accounting"), and `:79`
("quarantined charges remain within the configured process bound").
`RingTransport::diagnostics` does report both figures
(`crates/mc-host/src/ring_transport.rs:168-173`). The question is whether the
quarantined figure can ever be non-zero on a host.

It cannot. Following the charge-release mapping for
`ring-a-admission-charge-releases-on-every-endpoint-thread-exit` surfaced that
`Admission::quarantine` has no `mc-host` caller.

## Evidence trail

**The two terminal transitions.** `Admission` (`profile.rs:551-557`) has exactly
two consuming methods:

- `release` (`profile.rs:561-564`) returns all charges to the active pool.
- `quarantine` (`profile.rs:566-570`) calls
  `AdmissionController::quarantine`, which subtracts the charges from `active`,
  calls `release_spans`, and then adds a `retained` set back into `quarantined`
  (`profile.rs:522-541`). The retained set zeroes `workers` and `pinned_workers`
  and keeps everything else (`:531-535`), so bytes, descriptors, leases,
  mappings, file descriptors, and client instances stay charged against the
  process bound.

`Drop` (`profile.rs:583-589`) releases when the state is still `Active`, so
dropping an `Admission` is a release, never a quarantine.

**Caller enumeration.** `.quarantine()` appears in exactly two places in the
tree, both transport-crate tests:
`crates/mc-shm-transport/tests/contract.rs:368` and `:479`. There is no
`mc-host` caller. There is no caller in `packages/mc-shm-native` either.

**Why the host cannot call it even if it wanted to.** The `Admission` guard is
moved into the endpoint thread closure at `ring_transport.rs:240` and consumed by
`release()` at `:276`. `RingTransport` retains no handle to it (`:83-92` has no
`Admission` field), and nothing is passed back over the `done_tx` oneshot
(`:233`, `:277`, which carries `()`). So by the time any host code could observe
a reason to quarantine, the guard is gone.

**The path that most obviously wants quarantine.** When `Ring::try_receive`
fails descriptor validation it calls `self.enter_quarantine()` and returns
`Err(RingError::Descriptor(error))` (`ring.rs:1093-1100`). Per Part 1's
`quarantine-authority-survives-peer-writes` the ring is then terminally
quarantined and every subsequent operation on it fails. The host maps that error
to `ReadClose::Corrupt("shared-memory receive failed")`
(`ring_transport.rs:499`), `run_endpoint` sends the close and returns at
`:406-411`, and then `:276` releases the charge in full. So the transport-level
quarantine and the host-level charge accounting disagree: the ring is condemned,
the charge says the storage is free.

**The counter-argument, which is strong.** `run_endpoint` takes `rings:
DuplexRing` by value (`:359-368`), so returning drops the `DuplexRing` and unmaps
both mappings before `:276` runs. If the mapping is genuinely gone, the arena
bytes really are reclaimable by the OS and releasing the charge is correct. The
Part 1 rationale for quarantine was different: it retains charges for storage
whose *alias state* is unknown, specifically where a JavaScript alias may still
be attached (Part 1 cites
`packages/mc-shm-native/src/lib.rs:259-263`). That hazard lives on the native
peer side, not on the host's own mapping.

So the honest reading is that quarantine is a peer-side concern and the host
never needed it — and the doc, which attributes quarantined accounting to the
host's process bound and doctor output, is what is out of date.

## Failure scenario

Two distinguishable readings, and they differ on real behaviour:

1. Quarantine is peer-side only. Then the host's `quarantined` figure is
   correctly always zero, and the defect is documentation: three doc lines and
   one doctor field describe a mechanism the host does not have.
2. Quarantine should apply when the host condemns a ring. Then every `Corrupt`
   exit currently under-accounts: the host tells itself the charge came back
   while the peer may still hold an alias into the same shared object, and a
   subsequent `prepare` admits a new connection against capacity that is not
   actually free.

Under reading 2 the failure is silent and cumulative, and its only symptom is
peer-side corruption, which is precisely the class quarantine was introduced to
prevent.

## Timing windows and dependencies

No timing window; the property is a static caller enumeration.

Dependencies: Part 1's `quarantine-charge-transition-is-atomic` cited
`provider_recovery.rs:187` as its host-side driver, and Part 1's
`custody-terminal-transition-exactly-once` cited
`provider_recovery.rs:167-197` and `:811`. All three citations are dead. The
re-scope flagged that those two records' reachability labels may need to change
and that only a Part 1 refresh pass can settle it. This record supplies the
missing fact for that pass: the host-side driver has no successor and the
host-side quarantine transition is unreachable.

## What a test must construct

The cheap screen is a static assertion: no `mc-host` path calls
`Admission::quarantine`. That is a grep, and it belongs alongside the
`mandatory-ring-architecture` gate (`ci.yml:41-58`) if reading 1 is confirmed,
because then the absence is the intended contract and should be pinned.

If reading 2 is confirmed, the test is a runtime one and needs a real
descriptor-validation failure:

1. Prepare a connection. Attach a peer.
2. Have the peer publish a frame, then corrupt the shared descriptor for a later
   sequence so `try_receive`'s
   `validate` call at `ring.rs:1095` fails. `crates/mc-shm-transport/tests/ring.rs`
   already constructs descriptor corruption, so the technique exists.
3. Assert the host observes `ReadClose::Corrupt`, and then assert
   `accounting().quarantined` is non-zero and `accounting().active` returned to
   its pre-connection value minus the retained set.

Today step 3's second half fails by construction.

`ring_transport.rs:880` asserts
`diagnostics["accounting"]["quarantined"]["arena_bytes"] == 0` on a fresh
transport, which is the same value this property says can never change, so it is
an existing check that passes vacuously.

## Investigation log

### Q: Was host-side quarantine accounting deliberately dropped with `provider_recovery.rs`, or lost?

- Sources examined: `.quarantine()` call sites across `crates/` and `packages/`
  (two, both in `crates/mc-shm-transport/tests/contract.rs`);
  `profile.rs:522-541` and `:566-570` (the transition; `profile.rs` was not
  re-swept post-#131);
  `ring_transport.rs:223-281` (guard ownership);
  `docs/mc-host-shm-transport.md:21`, `:65`, `:79` (the three doc claims);
  Part 1's index rows for `quarantine-charge-transition-is-atomic` and
  `custody-terminal-transition-exactly-once`, both marked
  `Reaches production: yes`.
- Findings: the transport-side machinery is fully intact —
  `AdmissionController::quarantine`, `Admission::quarantine`,
  `QuarantineRecord`, `Ring::enter_quarantine`, and the per-operation gates are
  all present and tested in `mc-shm-transport`. Only the host-side driver is
  gone. Part 1 marked both records `Reaches production: yes` on the strength of
  a host-side driver that no longer exists, so those two rows are now wrong
  regardless of which reading is correct.
- Missing evidence: design intent. The refactor commit messages named in the
  re-scope (`ed487e11 refactor(host): make ring transport mandatory` and three
  follow-ups) do not distinguish "quarantine was peer-side all along" from
  "quarantine handling was collateral".
- Conclusion: needs human input on intent. Resolved on fact: the host-side
  quarantine transition is unreachable, the transport-side one is intact, and
  Part 1's two `Reaches production: yes` labels need re-grading.

### Q: Does releasing the charge on a `Corrupt` exit actually over-admit?

- Sources examined: `ring_transport.rs:359-368` (`run_endpoint` takes `rings` by
  value), `:406-411` (the `Corrupt` exit), `:276` (release);
  `ring.rs:1093-1100` (`enter_quarantine` on descriptor failure);
  `profile.rs:531-535` (what quarantine retains; not re-swept post-#131).
- Findings: the host's own mappings are dropped before the release, so from the
  host's perspective the bytes are free. The quarantine retention set is about
  storage that might still be aliased, and the alias hazard Part 1 identified
  lives in `packages/mc-shm-native/src/lib.rs`. I did not read that file in this
  pass, so I cannot say whether the native side retains its own accounting.
- Missing evidence: whether `mc-shm-native` performs an equivalent retention on
  its side, which would make the host's release correct and complete.
- Conclusion: unresolved, needs a read of `packages/mc-shm-native/src/lib.rs`
  around `:259-263` and `:312` against Part 1's
  `dead-peer-charges-are-reclaimed-or-declared`. That file is Part 1 scope, so
  the read belongs to the Part 1 refresh pass rather than here.
