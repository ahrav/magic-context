# an-occupied-rename-target-is-never-replaced-on-the-portable-path

## Discovery trigger

Gap G5's second half: "the portable rename fallback (~1216-1242), which never
executes because the flagged path always succeeds on Linux, and is a check-then-act
window justified only by a prose claim about the transaction lock." Verifying that
turned up a stronger fact than "never executes": the fallback is the *only* path on
macOS, and macOS is where no test in this scope runs.

## Evidence trail

**The function has two paths that do not implement the same guarantee.**
`generation.rs:1216-1242`. The Linux-only block, `:1217-1230`:

```
#[cfg(target_os = "linux")]
{
    match rustix::fs::renameat_with(dir, from, dir, to, rustix::fs::RenameFlags::NOREPLACE) {
        Ok(()) => return Ok(true),
        Err(rustix::io::Errno::EXIST) | Err(rustix::io::Errno::NOTEMPTY) => return Ok(false),
        Err(rustix::io::Errno::NOSPC) => return Err(GenerationError::InsufficientStorage),
        // No renameat2 flag support on this kernel or filesystem: fall
        // through to the portable occupancy check.
        Err(rustix::io::Errno::INVAL)
        | Err(rustix::io::Errno::NOSYS)
        | Err(rustix::io::Errno::OPNOTSUPP) => {}
        Err(_) => return Err(invalid("generation rename failed")),
    }
}
```

and the portable path, `:1231-1241`:

```
match rustix::fs::statat(dir, to, AtFlags::SYMLINK_NOFOLLOW) {
    Ok(_) => return Ok(false),
    Err(rustix::io::Errno::NOENT) => {}
    Err(_) => return Err(invalid("generation target stat failed")),
}
match renameat(dir, from, dir, to) {
    Ok(()) => Ok(true),
    Err(rustix::io::Errno::EXIST) | Err(rustix::io::Errno::NOTEMPTY) => Ok(false),
    Err(rustix::io::Errno::NOSPC) => Err(GenerationError::InsufficientStorage),
    Err(_) => Err(invalid("generation rename failed")),
}
```

The flagged path returns on `Ok`, `EXIST`, `NOTEMPTY`, and `NOSPC`, so on a current
Linux kernel with ext4, tmpfs, or overlayfs it never falls through. The
`#[cfg(target_os = "linux")]` attribute means the entire block is absent on macOS,
so there the portable path is the only path.

**The two paths differ on empty directories, and the caller says which behaviour is
required.** `promote_temp`'s doc comment, `generation.rs:872-875`:

> The rename must not replace: POSIX `renameat` succeeds when the target is an
> existing empty directory, so a plain rename would silently destroy a protected
> occupant that had been corrupted into an empty directory before the protection
> check below ever ran.

`RENAME_NOREPLACE` fails with `EEXIST` regardless of the occupant's emptiness, so
the flagged path satisfies that unconditionally. The portable path's `renameat` at
`:1236` is exactly the "plain rename" the comment names: it returns `Ok(())` for an
empty target directory, so the portable path satisfies the requirement only for the
interval it checks, and only against actors it can exclude.

**The justification is a prose claim.** `generation.rs:1211-1215`:

> Linux takes `RENAME_NOREPLACE`, which makes the emptiness of an occupying
> directory irrelevant. Filesystems that reject `renameat2` flags, and platforms
> without them, fall back to checking occupancy first; that check is sound here
> because every mutating entry point holds `transaction.lock`, so no other
> participant in the trust model creates the target concurrently.

`transaction.lock` is real: `lifecycle.rs:44` names it, `:495-496` describes it as
an exclusive cross-process flock on a never-renamed path, and `:534` describes
acquiring it non-blocking. The claim is sound for what it says, which is
"participant in the trust model".

**The same file assumes out-of-model writers elsewhere.** `validate_in_dir`'s walk
comment at `generation.rs:669-678` describes a directory-replacement attack in
detail and explains why the walk must go through a retained descriptor rather than
a pathname. The catalog's
`validation-and-enumeration-address-one-directory-object` records two shipped
defects from that class. So the store defends against planted replacements in the
validation path and relies on the lock in the rename path. Those two positions are
not consistent with each other.

Reachability label evidence: `default-production`, with the same platform
qualifier as the sibling exchange record. Nothing gates the function by config or
cfg(test); the platform decides which of its two paths runs.

## Failure scenario

A protected generation at the digest name has been corrupted into an empty
directory, for example by a partial removal after a crash. A restage of that digest
runs on macOS. `rename_no_replace` calls `statat`, which is the moment the target
must be observed as occupied. If the target is observed as occupied, the function
returns `Ok(false)` and `promote_temp` proceeds to its validate-and-protect logic at
`:887-904`, which refuses the mutation. Correct.

If the directory is created in the window between `:1231` and `:1236`, `statat`
returns `NOENT`, the plain `renameat` at `:1236` replaces the now-empty directory,
and the function returns `Ok(true)`. `promote_temp` then takes the early return at
`:882-885`, fsyncs, and reports success. The protection check at `:902-903` never
runs, which is precisely the sequencing the comment at `:872-875` says must not
happen: "before the protection check below ever ran".

The result is a deleted retained generation with no error and, per
`authentication-and-capacity-rejections-are-observable`, no operator-visible
record.

## Timing windows and dependencies

The window is between the `statat` at `:1231` and the `renameat` at `:1236`: two
syscalls with no lock held between them beyond `transaction.lock`, which is held for
the whole mutation rather than for this pair specifically. It is small in wall-clock
terms and unbounded in the presence of scheduler preemption.

Two independent dependencies gate whether the window is live at all:

1. **Platform.** On Linux the fallback needs a filesystem that returns `INVAL`,
   `NOSYS`, or `OPNOTSUPP` for `renameat2` flags. On macOS it is unconditional.
2. **Actor.** The window requires a writer outside `transaction.lock`'s discipline.
   Whether such a writer exists in a real deployment is the record's open question
   and was not established here.

The severity therefore splits: the mechanism is certain, and whether it is
exploitable depends on an unestablished fact about deployment. That is why the
record's Confidence is high on the mechanism and medium on severity.

## What a test must construct

The occupancy assertion, which passes today and should exist anyway:

1. Plant an **empty** directory at the digest name, call `promote_temp` through
   `stage_and_promote`, and assert the mutation is refused when the digest is
   protected. This distinguishes the two paths' behaviour on the exact case
   `:872-875` names.
2. Repeat with a **nonempty** corrupt directory. The existing
   `same_digest_corrupt_target_is_repaired_only_by_validated_exchange`
   (`generation.rs:1689`) covers the nonempty case indirectly; the empty case has no
   coverage.

Reaching the portable path deterministically needs one of:

- Extracting the fallback into a separately callable function so a test can drive it
  directly on any platform. This is the cheapest option and needs no filesystem
  fixture.
- A filesystem that rejects `renameat2` flags, mounted in the test environment. Not
  available in this repository's CI.
- Running the tests on macOS, where the fallback is the default. See the sibling
  record for the CI selection that would enable this.

Constructing the race itself needs a failpoint between `:1235` and `:1236`, plus a
second process or thread that creates the target. That is the only way to observe
the replacement rather than reason about it, and it is worth doing only if the open
question below resolves toward "yes, out-of-model writers exist".

## Investigation log

### Q: Does anything outside the trust model have write access to the generations directory in a real deployment?

- Sources examined: `generation.rs:1211-1215` (the lock justification),
  `lifecycle.rs:44`, `:495-496`, `:534`, `:579-585` (the lock's definition, scope,
  and the note that the lifecycle CLI holds it from outside the process),
  `generation.rs:669-678` (the walk's replacement-attack comment),
  `:1245-1258` (`validate_lifecycle_root_fd`, which checks owner uid and safe
  ancestry), `:1259-1261` onward (`open_child_dir`).
- Findings: the store's own security model is explicitly concerned with hostile
  planting. `validate_lifecycle_root_fd` at `:1248-1254` rejects a root not owned by
  the expected uid or with unsafe ancestry, and the child-directory open rejects
  group and other mode bits, which the catalog's
  `an-undecidable-quarantine-witness-fails-closed` record examines. Those checks
  exist because the code does not assume the directory is private. At the same time
  the rename fallback assumes exactly that. `lifecycle.rs:585` notes the lifecycle
  CLI holds the transaction lock from outside the host process, which shows the
  model spans processes and is enforced by the lock, not by directory permissions.
- Missing evidence: the deployment's actual filesystem permissions on the data
  root, and whether any tool, installer, or backup restore writes into the
  generations directory without taking the lock. Not determinable from this crate.
- Conclusion: needs human input. The lock argument is sound if and only if the
  answer is no, and the store's validation path is written as though the answer is
  yes.

### Q: Should the fallback be removed rather than justified?

- Sources examined: `generation.rs:1216-1242`, `:1191-1205` (the exchange's
  fail-closed stub as a precedent), `.github/workflows/ci.yml:126-184`.
- Findings: the exchange already demonstrates the alternative shape. On an
  unsupported platform `exchange_dirs` returns an error rather than emulating the
  primitive with a weaker sequence. `rename_no_replace` makes the opposite choice
  for the same class of problem in the same file. If macOS is supported, it needs a
  real no-replace primitive rather than an emulation; macOS has no
  `RENAME_NOREPLACE` equivalent, so the honest options are a link-then-unlink
  construction or accepting the weaker guarantee explicitly. If macOS is not
  supported, the fallback is dead on every supported platform and the stub shape is
  correct.
- Missing evidence: whether a link-based no-replace construction is viable for
  directories on APFS. `linkat` does not work on directories on macOS, so probably
  not, which would leave "accept the weaker guarantee explicitly" as the only
  option. Not verified against APFS documentation in this pass.
- Conclusion: needs human input, and it depends on the platform-support decision in
  the sibling record's open question.
