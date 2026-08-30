# an-observed-wedge-cause-reaches-the-operator

## Discovery trigger

The catalog recorded this as a reachability record: the classifier computes
thirteen distinct wedge reasons and the sole production consumer forwards one.
The lens is output coverage rather than state construction — the reasons are
already computed and already asserted by in-crate tests, so the only question is
whether any of them crosses the process boundary. That makes it verifiable by
counting producers and tracing the single consumer.

## Evidence trail

Thirteen distinct reason strings can accompany a `Wedged` verdict. The count is
**verified** at thirteen. One is produced in `probe_lifecycle` and twelve in
`classify`, all in `crates/mc-host/src/lifecycle.rs`:

1. `:965` `"lifetime fence held without a runtime directory"` — the only one
   outside `classify`.
2. `:1093` `"lifetime and runtime locks disagree"`
3. `:1097` `UNSUPPORTED_STATE_SCHEMA_REASON`, i.e. `"unsupported_state_schema"`
   (`:35`)
4. `:1100` `"lifecycle record failed security checks"`
5. `:1103` `"publication failed security checks"`
6. `:1113` `"record carries no payload digest"`
7. `:1119` `"instance lock held without a lifecycle record"`
8. `:1121` `"lifecycle record is corrupt"`
9. `:1127` `"publication is corrupt or violates the contract"`
10. `:1141` `"starting record expired"`
11. `:1151` `"publication daemon ID does not match the record"`
12. `:1155` `"running record without a publication"`
13. `:1165` `"stopping record expired"`

Reasons 2 through 9 go through the `wedged` closure defined at `:1075-1082`;
reasons 10 through 13 are tuple arms feeding the construction at `:1169-1176`.
There are only two `state: LifecycleState::Wedged` constructions in the file
(`:964` and `:1076`), so this enumeration is exhaustive.

- **Correction.** The catalog says "the reason table is complete in one
  function." It is not: twelve reasons live in `classify` and the thirteenth,
  `:965`, is produced in `probe_lifecycle` before `classify` is ever called. The
  total of thirteen is right; the single-function claim is not.
- The sole production consumer of the field is
  `crates/mc-module/src/bin/ck-mc-host.rs`. A grep for `.reason` on a probe shows
  exactly one read: `:388`, inside `quarantined_observation` (`:387-395`), which
  compares against `mc_host::UNSUPPORTED_STATE_SCHEMA_REASON` and returns `None`
  for anything else.
- So **one of thirteen** reaches the operator. In `cmd_probe` (`:588-611`) the
  forwarded case is `:598-599`, which emits reason `"unsupported_state_schema"`.
  Every other wedge falls to `:600-606`, and `LifecycleState::Wedged` maps to the
  bare string `"wedged"` at `:605`. The twelve remaining reasons are discarded
  before serialization.
- The distinction is not recoverable downstream. `remediation_for`
  (`:86-118`) keys on the emitted reason: `"wedged"` yields
  `inspect_daemon_process` (`:97-103`) while `"unsupported_state_schema"` yields
  `align_versions` (`:92`). Twelve causes therefore share one remediation.
- **A probe error collapses to the same output.** When `probe()` itself fails,
  `cmd_probe` takes `:590-595` and calls `instance_failure` (`:329-342`). Two of
  its arms — `InstanceError::Insecure` and `InstanceError::NamespaceDrift` at
  `:335-337` — return exactly `("wedged", "wedged")`, byte-identical to the
  twelve collapsed classifier reasons. Confirmed.
  - **Refinement:** the catalog describes this as "erasing the distinction
    between fence incoherence and an I/O failure." An I/O failure is in fact
    distinguishable: `InstanceError::Io` maps to `("wedged", "internal_error")`
    at `:338-340`. The indistinguishable pair is `Insecure`/`NamespaceDrift`
    against the twelve collapsed reasons, not `Io`.
- There is no second channel. `crates/mc-host/Cargo.toml` lists no `tracing`,
  `log`, or `env_logger` dependency, so the crate cannot emit these strings to a
  log even in principle. Verified.

## Failure scenario

1. Any wedge other than the quarantined-schema case occurs — say a replaced
   runtime directory under a live daemon, which produces reason `:965`, or a
   record that failed its security checks, which produces `:1100`.
2. `probe_lifecycle` returns a `LifecycleProbe` whose `reason` names the cause
   precisely.
3. `cmd_probe` calls `quarantined_observation` at `:598`. The reason is not
   `UNSUPPORTED_STATE_SCHEMA_REASON`, so `:389` returns `None`.
4. The match falls to `:605` and the emitted reason becomes `"wedged"`.
   `remediation_for` attaches `inspect_daemon_process`.
5. The operator receives identical output for a namespace replacement, a corrupt
   record, an insecure publication, a fence disagreement, an expired phase, a
   daemon-ID mismatch, and a probe that failed with `Insecure` or
   `NamespaceDrift`. The advice is the same where the causes are not.

## Timing windows and dependencies

No timing angle. This is a static output-coverage gap: the forwarding decision is
a single conditional at `:388`, evaluated identically on every path. The record
depends on the classifier's reason set staying complete, which
`probe-never-reports-stopped-while-either-fence-is-held` and
`clock-anomalies-do-not-invalidate-live-evidence` both rely on from the other
direction — those records reason about which verdict is correct, while this one
observes that the correctness detail never leaves the process.

## What a test must construct

For each distinguished wedge reason, assert some operator-visible output differs.
This is location and output coverage, not a state to construct, so the test lives
at the CLI boundary and reads the emitted `DaemonResult`. Two reasons are already
fixtured in-crate and can be lifted directly: `lifetime_and_runtime_lock_disagreement_is_wedged`
(`lifecycle.rs:2400`) produces reason 2, and
`a_replaced_cortexkit_subtree_is_not_reported_stopped_while_the_daemon_lives`
(`:2275`) produces reason 1. Driving either through `cmd_probe` and asserting the
serialized reason is anything other than `"wedged"` fails today, which is the
demonstration. A third case should invoke the probe-error path with an
`Insecure` shape and assert its output differs from a classifier wedge.

## Investigation log

### Q: How many distinct wedge reasons can the classifier produce, and how many reach the operator?

- Sources examined: every `state: LifecycleState::Wedged` construction in
  `lifecycle.rs` (`:964`, `:1076`); the `wedged` closure `:1075-1082` and all its
  call sites; the tuple arms at `:1141`, `:1151`, `:1155`, `:1165`; the constant
  at `:35`; a complete grep for `.reason` in `ck-mc-host.rs`; `cmd_probe`
  `:588-611`; `quarantined_observation` `:387-395`; `remediation_for` `:86-118`.
- Findings: thirteen distinct strings, matching the catalog's count. Exactly one,
  `"unsupported_state_schema"`, is forwarded, via the single conditional at
  `:388`. The other twelve collapse to `"wedged"` at `:605`. **Correction:** the
  reasons are not all in one function — twelve are in `classify`, one (`:965`) is
  in `probe_lifecycle`.
- Missing evidence: none.
- Conclusion: resolved. Thirteen computed, one conveyed, twelve lost.

### Q: Does a probe error also collapse to the same output?

- Sources examined: `cmd_probe` `:588-596`; `instance_failure` `:329-342`;
  `remediation_for` `:86-118`; `crates/mc-host/Cargo.toml` dependency list.
- Findings: confirmed for two arms — `Insecure` and `NamespaceDrift` at
  `:335-337` both emit `("wedged", "wedged")`, identical to a collapsed
  classifier wedge. `Io` is distinguishable as `"internal_error"` at `:338-340`,
  so the catalog's framing of the erased pair needs the refinement noted above.
  No `tracing` or `log` dependency exists in the crate, so there is no second
  channel.
- Missing evidence: none.
- Conclusion: resolved with a refinement. A probe error does collapse to the same
  output, but through `Insecure`/`NamespaceDrift` rather than through `Io`.

### Q: Is only the forwarded reason a contract, with the other twelve as pure diagnostics?

- Sources examined: the `quarantined_observation` doc comment `:378-386`, which
  explains why that one reason must be keyed on; the closed reason union in
  `remediation_for` `:86-118`; in-crate tests asserting `observed.reason`
  directly.
- Findings: the code justifies forwarding the quarantined-schema reason because
  `InstanceGuard::acquire` refuses to start over it, so callers must key on the
  reason rather than the state. Nothing states a status for the other twelve.
- Missing evidence: no design note declaring the twelve diagnostics-only.
- Conclusion: unresolved; needs human input, as the catalog records. If they are
  diagnostics, they are diagnostics no operator can observe, since the crate has
  no logging channel either.
