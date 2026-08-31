# rt-a-no-configured-limit-is-silently-clamped

## Discovery trigger

The task brief names silent clamping that diverges from a documented bound as a
recurring shape in this repository. I checked every validation branch in
`config.rs` for a clamp, a `min`, a `max`, or a saturating assignment.

## Evidence trail

`HostLimits::validate` (`config.rs:147-193`) and `HostConfig::validate`
(`:300-379`) take `&self`, not `&mut self`. Neither can modify the config; the
signature alone forecloses clamping. Every out-of-range branch returns an `Err`.

The complete rejection inventory, each verified:

| Site | Condition | Error, and whether it names the key |
| --- | --- | --- |
| `:157-159` | count is zero | `ZeroLimit { name }` — yes |
| `:160-166` | count above `Semaphore::MAX_PERMITS` | `LimitTooLarge { name, configured, maximum }` — yes, with both values |
| `:168-174` | `max_routes > u16::MAX` | `LimitTooLarge` — yes |
| `:175-180` | below `MIN_RESIDENT_BYTES` | `ResidentBytesBelowInteropMinimum { configured, minimum }` — no name needed, one field |
| `:186-191` | above `min(MAX_PERMITS, u32::MAX)` | `ResidentBytesTooLarge { configured, maximum }` — yes |
| `:302-304` | empty `daemon_ver` | `EmptyDaemonVer` — yes |
| `:305-309` | non-canonical digest | `InvalidPayloadDigest { len }` — length only, deliberately (`:399`) |
| `:333-340` | `daemon_ver` oversizes auth or publication | `DaemonVerTooLarge { auth_message_bytes, connection_file_bytes }` — yes |
| `:357-359` | zero duration | `ZeroDuration { name }` — yes |
| `:360-362` | duration above `MAX_CONFIG_DURATION` | `DurationTooLarge { name }` — yes |
| `:365-369` | zero liveness period | `ZeroDuration { name: "liveness period" }` — coarse; does not say which of the two |
| `:370-376` | oversize liveness period | `DurationTooLarge { name: "liveness period" }` — same coarseness |

`Display` (`:417-458`) renders each with the configured and maximum values, so
the caller learns which bound and by how much. `:430-434` even prints
`MAX_CONFIG_DURATION.as_secs()`.

Two deliberate exceptions to "the caller learns which":

- `InvalidPayloadDigest` carries only `len`, and `:399` states why: "Carries
  only the offending length so diagnostics stay bounded."
- The two liveness arms collapse `ping_interval` and `pong_deadline` into the
  literal `"liveness period"` (`:367`, `:374`). An operator who sets both and
  gets `ZeroDuration { name: "liveness period" }` cannot tell which one is at
  fault. This is a diagnostic granularity gap, not a clamp.

The one silent narrowing found anywhere in this sub-part is
`file_mode::raw_mode` (`file_mode.rs:17-19`):

```
pub(crate) fn raw_mode(mode: u32) -> rustix::fs::RawMode {
    (mode & 0o7777) as rustix::fs::RawMode
}
```

It masks and casts with no error path. Its doc comment (`:12-15`) states the
precondition: "every value passed is already within them (0o600 or 0o700 for
staged output, and a manifest mode that validation requires to equal
`mode & 0o777`), so the mask documents that range rather than narrowing a value
that could exceed it."

Within `harness_closure.rs` the precondition holds by construction.
`validate_manifest` rejects any `node.mode` other than `0o600` or `0o700`
(`:284-286`), and it runs before `materialize` stages anything (`:505`) and
before `validate` returns a closure (`:582`). The three call sites are
`copy_node` (`:704`, `:707`), `write_new_file` (`:979`, `:982`), and both pass
already-validated or literal modes.

Defence in depth exists: `verify_secure_file` (`:859-870`) compares
`mode & 0o777 != expected_mode` against the *unmasked* `u32`, so a mode carrying
high bits would fail the comparison rather than pass silently.

## Failure scenario

The clamping scenario does not exist for `HostConfig`; the signatures prevent it.

The `raw_mode` scenario is cross-module. `file_mode.rs:1-5` says the function is
"shared by the closure and generation stagers", and `generation.rs` is outside
this footprint. If a generation manifest ever committed a `mode` with a bit
above `0o7777` — a full `st_mode` including `S_IFREG`, for example, which is
`0o100000` — the mask would silently reduce `0o100700` to `0o700`. That happens
to be the intended permission, so the file is created correctly and nothing
reports the narrowing. A subsequent `verify_secure_file`-style comparison
against the unmasked value would then fail, so the outcome is a confusing
mismatch rather than a security hole.

## Timing windows and dependencies

None. Both validators are pure functions of an owned `HostConfig`. `raw_mode` is
a pure function of a `u32`.

The dependency worth naming: the eight startup gates in `runtime.rs`
(`:500-740`) are *not* part of `validate`, because they need handler-derived
inputs. So "the config validated" never means "this host can start", and the
reject-not-clamp guarantee covers only the config-shaped half of the refusals.

## What a test must construct

An exhaustive per-field table test. For each field of `HostLimits`,
`HostTiming`, and `LivenessPolicy`, set it one step outside its bound, assert
`Err`, and assert the rendered `Display` string contains that field's name. Then
set it exactly at the bound and assert `Ok` and that the accepted config is
byte-identical to the submitted one.

`config.rs` already has seven per-key tests (`:503`, `:551`, `:565`, `:577`,
`:604`, `:637`, `:647`), so the shape exists; what is missing is exhaustiveness
over fields and the "identical after validation" half. The latter needs
`PartialEq` on `HostLimits` and `HostTiming`, which neither derives today
(`:89`, `:198` derive only `Debug, Clone`).

For `raw_mode`, the cheapest oracle is a unit test asserting that any input with
a bit above `0o7777` is unreachable from the crate's own call sites, which is a
review-level claim rather than a runtime one, or changing the signature to take
a validated newtype.

## Investigation log

### Q: does `MAX_CONFIG_DURATION` clamp or reject?

- Sources examined: `config.rs:76-81`, `:356-363`, `:646-673`.
- Findings: rejects. `:360-362` returns `DurationTooLarge`. The doc comment at
  `:76-80` explains the motive: `Instant + Duration` panics on overflow, so
  `Duration::MAX` must be refused at validation "instead of crashing the
  published host when a deadline is armed". The test at `:670-672` asserts the
  exact maximum is accepted.
- Missing evidence: none.
- Conclusion: resolved with answer — reject, with the boundary value accepted,
  and a test pinning it.

### Q: is any bound derived rather than configured, and therefore clamped downstream?

- Sources examined: `runtime.rs:1223`, `:965`, `:1130`, `instance.rs:674-675`.
- Findings: four derived or fixed durations exist and none is validated against
  `MAX_CONFIG_DURATION`: `lifecycle_callback_deadline.saturating_mul(2)` at
  `:1223` (saturating, so a large input silently yields a value the validator
  would itself reject), `ACCEPT_ERROR_BACKOFF` 100 ms at `:965`, the 50 ms
  activation interval at `:1130`, and the 25 ms lock retry delay at
  `instance.rs:675`.
- Missing evidence: none.
- Conclusion: resolved with answer — the derived `saturating_mul(2)` is the only
  one that can produce an out-of-contract duration, and it cannot overflow, so it
  is a coherence issue tracked under
  `rt-a-forced-shutdown-outlives-the-configured-shutdown-deadline` rather than a
  clamp.
