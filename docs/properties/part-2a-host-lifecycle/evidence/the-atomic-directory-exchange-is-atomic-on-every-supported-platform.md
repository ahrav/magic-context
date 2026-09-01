# the-atomic-directory-exchange-is-atomic-on-every-supported-platform

## Discovery trigger

Gap G5 from `portfolio-evaluation.md`: "The atomic exchange has a distinct macOS
backend with no property and no observed test." The task was to verify the backend
divergence and the claim that no in-crate lifecycle or generation test executes on
macOS.

## Evidence trail

**Two kernel interfaces behind one expression.** `generation.rs:1191-1198`:

```
/// Atomic same-filesystem directory exchange. Rustix maps `EXCHANGE` to
/// Linux `renameat2(RENAME_EXCHANGE)` and macOS
/// `renameatx_np(RENAME_SWAP)`; unsupported platforms fail closed.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn exchange_dirs(dir: &OwnedFd, a: &str, b: &str) -> Result<(), GenerationError> {
    rustix::fs::renameat_with(dir, a, dir, b, rustix::fs::RenameFlags::EXCHANGE)
        .map_err(|_| invalid("atomic digest-target exchange failed"))
}
```

and the fail-closed stub, `:1200-1205`:

```
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn exchange_dirs(_dir: &OwnedFd, _a: &str, _b: &str) -> Result<(), GenerationError> {
    Err(invalid(
        "atomic digest-target exchange is unsupported on this platform",
    ))
}
```

The doc comment states the divergence itself: `renameat2(RENAME_EXCHANGE)` and
`renameatx_np(RENAME_SWAP)` are separate syscalls with independent semantics,
error sets, and filesystem support, reached through one line of Rust and covered by
one cfg predicate.

**The call site is a repair, followed immediately by a deletion.**
`generation.rs:877-911`, inside `promote_temp`:

- `:882-885` try the no-replace rename; on success, fsync and return.
- `:886-900` the target is occupied: a valid occupant wins and the temp is
  discarded; `UnsupportedStateSchema` abandons the mutation.
- `:901-903` a protected corrupt target abandons the mutation.
- `:905` `exchange_dirs(&self.generations_fd, temp_name, digest)?`
- `:906` fsync the generations directory.
- `:907-910` revalidate the promoted target, then `remove_tree` the displaced
  orphan now at the temp name.

So a non-atomic or partially-applied exchange means `remove_tree` deletes the wrong
directory. `promote_temp`'s contract at `:865-876` depends on the swap being
all-or-nothing.

**macOS executes no test in this scope.** CI's matrix job is
`.github/workflows/ci.yml:126-184`, `os: [ubuntu-latest, macos-latest]` at `:132`.
The mc-host steps that run on macOS are exactly four:

| Line | Step | What it runs |
| --- | --- | --- |
| `:156` | source build | `cargo build -p mc-host`, no test binaries |
| `:178` | macOS contracts | `cargo nextest run -p mc-host --test shm_soak` |
| `:179-181` | macOS contracts | `cargo test -p mc-host --lib shm_provider::tests::platform_preflight_is_side_effect_free` |
| `:182-183` | lease non-escape | `cargo test -p mc-host --doc` |

The Linux-only step at `:163-171` runs `--test shm_transport --test
transport_negotiation`. There is no `--test lifecycle`, no `--test client`, no
`--test activation`, and no unfiltered `--lib` run on either platform in this job.
The step comment at `:171-174` states the position in its own words: the macOS job
proves "side-effect-free omission (R15), not active parity".

One nuance worth recording, because it bounds what the omission does and does not
hide: the filtered `--lib` run at `:179-181` *compiles* the whole lib test binary
on macOS, so a macOS type error or a cfg mistake in `generation.rs`'s test module
would fail the build. What never happens is executing a `generation` or
`lifecycle` test body on macOS.

Reachability label evidence: `default-production`, with a platform qualifier. The
exchange is not behind a config option or a cfg(test) gate; it is reached whenever
`promote_temp` finds a corrupt unprotected occupant. The label describes the
configuration, and the platform scoping is stated in the record's Existing check
and here, because METHOD offers only three labels and none of them encodes
"production on one platform, unobserved on another".

## Failure scenario

A generation directory at the digest name is corrupt, for example a partially
written manifest after a power loss, and is not in the protected set. A restage of
the same digest runs. `rename_no_replace` returns `Ok(false)`, `validate` fails,
the protection check passes, and `exchange_dirs` runs.

On macOS, if `renameatx_np(RENAME_SWAP)` behaves differently on APFS from
`RENAME_EXCHANGE` on ext4, for example by not being atomic across a crash, by
failing on a directory rather than a file, or by returning a different errno that
the blanket `map_err` at `:1197` flattens into one message, then either the
mutation is abandoned with a message that names the wrong cause, or the swap
partially applies and `:910` deletes a retained generation.

The blanket `map_err` matters here on its own: every error from either syscall
becomes `invalid("atomic digest-target exchange failed")`, so a platform-specific
`ENOTSUP` from a filesystem that does not support the swap is indistinguishable
from an `EXDEV` or a permission failure. The record's check should assert the
error is returned, not what it says, but the diagnosis loss is worth noting.

## Timing windows and dependencies

The exchange must be atomic with respect to a crash, because `:905-910` is
exchange, fsync, revalidate, delete. A crash between `:905` and `:910` leaves the
corrupt orphan at the temp name, which the catalog's
`current-profile-never-names-an-unvalidatable-generation` covers as an orphan a
later prune removes. A non-atomic exchange breaks that reasoning, because the
intermediate state is then not one of the two states the recovery argument assumes.

Dependency: same-filesystem. Both syscalls operate within one directory descriptor
(`dir` is passed as both the old and new dirfd at `:1196`), so cross-device is not
reachable here.

## What a test must construct

The fixture already exists. `generation.rs:1689`
`same_digest_corrupt_target_is_repaired_only_by_validated_exchange` drives
`promote_temp` into the exchange branch: `:1705` covers the protected corrupt
target being refused and `:1714-1721` covers the unprotected case exchanging
atomically and the orphan temp being removed.

What is missing is executing it on macOS. Concretely:

1. Add the generation and lifecycle test selection to the macOS branch of
   `.github/workflows/ci.yml:175-181`, or add a macOS entry that runs the
   `generation::tests` filter of `--lib`. The binary already compiles there.
2. For the stub platforms, a compile-time assertion is the only available check:
   call `exchange_dirs` under `#[cfg(not(any(target_os = "linux", target_os =
   "macos")))]` and assert it returns `Err`. That branch has no CI target in this
   repository, so the check documents intent rather than proving behaviour.
3. Strengthen the existing Linux test with an explicit no-intermediate assertion:
   after the exchange, assert both names are occupied, the digest name validates,
   and the temp name holds the corrupt content.

Note that this record's obligation is mostly a CI change rather than a new test,
which places it in the same enforcement class as
`the-largest-lifecycle-proof-runs-in-ci` and is one of the three biases the
portfolio evaluation asked a human to separate.

## Investigation log

### Q: Is macOS a supported deployment target for the lifecycle store, or only a development platform?

- Sources examined: `generation.rs:1191-1205` (both cfg arms),
  `.github/workflows/ci.yml:126-184` in full (the matrix, both platform branches,
  and the omission comment at `:171-174`), `src/generation.rs` and
  `src/lifecycle.rs` cfg inventory (`generation.rs:1217` and `lifecycle.rs:1839`,
  `:2013`, `:2040`, `:2081` are the only `target_os` gates in either file).
- Findings: the evidence points both ways and cannot be resolved from the code.
  For support: macOS gets a real syscall mapping rather than the stub, mc-host is
  built on macOS in CI, and `lifecycle.rs`'s Linux-only gates are all inside test
  code rather than production paths, so the production lifecycle path compiles and
  is intended to work on macOS. Against support: the macOS job runs no lifecycle or
  generation test, and its own comment frames macOS as proving omission rather than
  parity, which is a statement about the shared-memory provider rather than about
  the store.
- Missing evidence: no product document, target list, or release manifest was
  examined in this pass, and none is cited in either source file.
- Conclusion: needs human input. If macOS is supported, this is a real coverage gap
  and the fix is a CI selection change. If it is not, the honest shape is to move
  macOS to the fail-closed stub at `:1200-1205`, which would turn a silent
  divergence into an explicit refusal.
