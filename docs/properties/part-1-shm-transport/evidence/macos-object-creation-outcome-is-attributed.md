# macos-object-creation-outcome-is-attributed

## Citation refresh, 2026-08-30

The ring-transport refactor (`0f336d3c`, `d8bde128`, `793a973e`, `ed487e11`)
renamed `crates/mc-host/src/shm_provider.rs` to
`crates/mc-host/src/ring_transport.rs` and deleted `provider_recovery.rs`,
`transport_negotiation.rs`, and `transport_provider.rs`. Host-side citations below
were re-anchored against `ring_transport.rs` at `e447c927`.

Where the cited construct survives, the citation names `ring_transport.rs` and a
line re-verified against that commit. Where it does not, the original reference is
kept and prefixed `former`, so it reads as pre-refactor evidence rather than a
current location. A `former` line number is never a claim about the tree today.
Every `provider_recovery.rs` reference is `former` by definition: that module has
no successor. See the refresh note in [../catalog.md](../catalog.md).

## Discovery trigger

`docs/mc-host-shm-transport.md:121` states that on macOS "hosted `Ring::create`
currently returns `ObjectSetupFailed`". That is a symptom recorded as a platform
status with no cause attached. The whole macOS omission decision rests on it, and
nothing in the tree names which of the four fallible steps inside
`create_macos_shm` produces it.

## Evidence trail

`create_macos_shm` (`crates/mc-shm-transport/src/backend/ring.rs:1748-1783`) has
exactly four failure exits, three of which return `ObjectSetupFailed`:
`getrandom` (`:1751`), `shm_open` (`:1768-1770`), `shm_unlink` (`:1774-1776`),
and `ftruncate` (`:1779-1781`). The fourth conversion failure returns
`ArithmeticOverflow` (`:1777`). The caller `Mapping::create` (`:215-245`) then
runs `validate_object` (`:220`), which returns `ObjectValidationFailed`, not
`ObjectSetupFailed`. The documented error therefore points inside
`create_macos_shm`, not at validation — a discriminator the platform-status note
does not use.

The name is computed at `:1755-1764`: `String::from("/mc-shm-")` folded over 16
random bytes formatted `{byte:02x}`. That is 8 + 32 = 40 characters, 41 bytes
with the terminator. I computed this by replicating the fold rather than reading
it off. The comparable `RuntimeDir` leaf is `mc-shm-<32 hex>` = 39 characters
(`:326`), but that is a filesystem path, which is not subject to the POSIX
shared-memory name limit.

No CI job on macOS executes this function. `.github/workflows/ci.yml:132` builds
the matrix `[ubuntu-latest, macos-latest]`. The Linux step (`:159-166`) runs
`cargo nextest run -p mc-shm-native -p mc-shm-transport` with no target filter.
The macOS step (`:169-176`) runs `cargo nextest run -p mc-shm-transport --test
contract --test fuzz_corpus`, then `-p mc-host --test shm_soak`, then one
`mc-host` lib test. `tests/contract.rs` references `BackendId::Ring` only as an
enum value (`:366`, `:449`) and never constructs a `Ring`; `tests/fuzz_corpus.rs`
uses only `mc_shm_transport::harness` (`:11`). `tests/shm_soak.rs` gates its ring
work on `#[cfg(target_os = "linux")]` (`:252`, `:259`, `:267`, `:287`). So no
macOS job reaches `Ring::create`.

Update 2026-08-31: the CI paragraph above resolves against the pre-#131
workflow. PR #131 (merge `5d638e3e8`) removed the macOS matrix leg entirely;
`.github/workflows/ci.yml` at HEAD `bdf72f46a` contains only `ubuntu-latest`
jobs. The same merge deleted the Darwin npm packages
(`packages/mc-host-darwin-*`, removed in `55f47ac64`). See the dated
investigation-log entry below for what remains of the macOS path at HEAD.

The provider does not reach it either: `ShmProvider::preflight`
(former `crates/mc-host/src/shm_provider.rs:276-278`) and `prepare` (former `:288-290`) both
return early on `!cfg!(target_os = "linux")`, and
`platform_preflight_is_side_effect_free` (former `:827-848`) asserts
`StaticallyOmitted` on non-Linux. The omission is a compile-time decision, so the
documented runtime error is never observed by any check.

## Failure scenario

Two distinct bad outcomes share the same recorded symptom. If the cause is the
40-character name, then `shm_open` fails before any object exists, the platform
is inert, and the omission is correct but for an accidental reason. If the cause
is instead `ftruncate` — the step that moved after `shm_unlink` in `a5568707` —
then an object was created, its name was already removed, and the failure exit
returns without the object ever being mapped. Both report
`ObjectSetupFailed`. An engineer who fixes the first cause silently activates
every downstream macOS behaviour at once: creation with no seal, attach with no
type check, and a mapping whose descriptor was dropped, none of which any test
covers.

## Timing windows and dependencies

No concurrency and no fault injection. The dependency is environmental: a macOS
host, which no reachable code path in CI supplies. This record is the premise for
`attach-validation-is-not-platform-weakened` and
`macos-object-creation-leaks-no-shm-name`, because both describe behaviour that
only matters once object creation can succeed.

## What a test must construct

A macOS execution of `create_macos_shm` that records which step failed and with
which `errno`, rather than collapsing to one variant. Two arms. Negative-control
arm: assert that the currently documented outcome reproduces, and capture the
distinguishing `errno` so the status note can cite a cause. Attribution arm: call
`shm_open` directly with a name shortened below the platform limit and assert
whether it succeeds, which isolates the name length from the flag set and from
the truncation order. Running `tests/ring.rs` on the macOS runner is the cheapest
way to reach any of this; today that file is not in the macOS command.

## Investigation log

### Q: Which of the three `ObjectSetupFailed` exits in `create_macos_shm` produces the documented macOS failure?

- Sources examined: `ring.rs:1748-1783` line by line; `ring.rs:215-245` for the
  caller and the error it maps; `ring.rs:1677-1703` to confirm validation returns
  a different variant; `docs/mc-host-shm-transport.md:110-125`;
  `docs/evidence/mc-shm-traceability-v1.json:48`, `:157`, `:195`;
  `.github/workflows/ci.yml:126-177`; `tests/contract.rs` and
  `tests/fuzz_corpus.rs` import lists; `crates/mc-host/tests/shm_soak.rs` cfg
  gates; former `crates/mc-host/src/shm_provider.rs:275-290`, former `:827-848`; the diff of
  `a5568707` restricted to this function.
- Findings: the error is raised inside `create_macos_shm`, since
  `validate_object` uses `ObjectValidationFailed`. The name is 40 characters,
  computed, not assumed. `a5568707` moved `shm_unlink` from after `ftruncate` to
  before it, so the current order is `shm_open`, `shm_unlink`, `ftruncate`. I
  could not execute anything on macOS, so I could not observe the errno.
- Missing evidence: the Darwin limit on POSIX shared-memory names is external to
  this repository. XNU's `PSHMNAMLEN` is 31 bytes including the terminator in the
  sources I can recall, which a 41-byte name would exceed, but I did not verify
  that constant against a Darwin header or a live `shm_open`, and I am not
  stating it as fact. Whether Darwin's `shm_open` accepts `O_CLOEXEC` (former `:1769`)
  is a second unverified candidate, and whether `ftruncate` on an unlinked shm
  object is permitted on Darwin is a third.
- Conclusion: unresolved. The failing step is not determined. The name-length
  candidate is the strongest because its premise is arithmetic from source rather
  than a behavioural guess, but confirming it needs a macOS run. The claim that
  no macOS job reaches `Ring::create` is settled and does not depend on the cause.

### Q: Is Darwin still a supported release surface? (added 2026-08-31)

- Sources examined: `packages/` listing at HEAD `bdf72f46a` (no
  `mc-host-darwin-*` directories remain); `.github/workflows/ci.yml` at HEAD
  (every `runs-on` is `ubuntu-latest`);
  `git log --diff-filter=D -- packages/mc-host-darwin-arm64/package.json`
  (deleted in `55f47ac64`, merged via `5d638e3e8`, PR #131);
  `crates/mc-shm-transport/src/backend/ring.rs:1-2`, `:311-312`, `:2109-2115`,
  `:2176-2219`; `docs/mc-host-shm-transport.md:5`, `:83`.
- Findings: the Darwin packages and macOS CI jobs are gone. `ring.rs:1-2` now
  raises `compile_error!("mc-shm-transport ring backend supports Linux only")`
  off Linux, `Mapping::create` calls `create_linux_memfd` unconditionally
  (`:311-312`), and `create_macos_shm` (`:2176`) has no caller — the only
  occurrence of its name in the crate is its definition. `099a314d5` also
  rewrote its body: the name is now 10 random bytes, 28 characters against a
  commented 31-byte Darwin limit (`:2177-2178`), which addresses this record's
  strongest failure candidate, and `FD_CLOEXEC` is set via `fcntl` after
  `shm_open` (`:2206`) because Darwin rejects `O_CLOEXEC` in `shm_open` flags.
  The doc claim this record was anchored to (former
  `docs/mc-host-shm-transport.md:121`, macOS `Ring::create` returns
  `ObjectSetupFailed`) is gone; the doc now states Linux-x64 glibc support only
  (`:5`, `:83`).
- Missing evidence: any statement of intent for the surviving
  `cfg(target_os = "macos")` code — dead residue, or a kept seed for a Darwin
  return.
- Conclusion: needs human input. Citation corrections: `create_macos_shm` is at
  `ring.rs:2176-2219` at HEAD, not `:1748-1783`; the `ci.yml` matrix lines
  cited above (`:132`, `:159-166`, `:169-176`) no longer exist; the
  40-character-name analysis describes the pre-#131 body and is superseded by
  the 28-character form.
