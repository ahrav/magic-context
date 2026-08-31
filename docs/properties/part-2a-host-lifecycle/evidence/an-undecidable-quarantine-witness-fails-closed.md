# an-undecidable-quarantine-witness-fails-closed

Scope note: two persisted objects are in scope — the lifecycle record
(`lifecycle.json`, one per data root) and the payload generation manifest
(`manifest.json`, one per content-addressed generation directory). "Generation"
throughout is the on-disk payload generation, never the in-process connection
generation of `connection.rs`.

## Discovery trigger

The lifecycle gate was repaired to fail closed, and the repair's reasoning was
written into its doc comment. Reading that comment
(`crates/mc-host/src/lifecycle.rs:250-257`) and then the manifest-side gate
(`crates/mc-host/src/generation.rs:941-968`) shows two gates answering the same
question — "can I prove this schema is known?" — with opposite defaults.

## Evidence trail

The repaired gate is `quarantined_record_present`
(`crates/mc-host/src/lifecycle.rs:257-284`). It splits absence from
undecidability. `openat` returning `NOENT`, `LOOP`, or `NOTDIR` is `Ok(false)`
(`:270-272`), deliberately, because startup's atomic rename replaces a planted
symlink without following it; any other open errno is an `Err` (`:273`), and a
failing `fstat` is an `Err` (`:275`), both of which refuse the start rather than
admit an overwrite. A failing or oversize `read_all_fd` returns `Ok(true)`
(`:278-281`) — undecidable therefore quarantined.

The manifest-side gate is `is_quarantined_schema`
(`crates/mc-host/src/generation.rs:941-968`). Its four early returns are:

1. `:942-944` — `open_child_dir(&self.generations_fd, digest)` yields `None`.
2. `:945-947` — `open_rel_nofollow(&dir, GENERATION_MANIFEST_NAME)` yields `None`.
3. `:956-960` — `fstat` on the manifest descriptor returns `Err`.
4. `:961-963` — `read_all_fd(&manifest_fd, MAX_MANIFEST_BYTES)` returns `Err`.

All four evaluate to removable. Only the size test at `:957`, which fires when
`st_size` exceeds the cap, returns quarantined; its comment (`:948-955`) states
the principle the other four violate — "we could not read it" is not evidence
that it is schema 1 — and then ends with "Every other read failure stays
removable." The terminal `matches!` at `:964-967` returning false for `Valid` and
`Malformed` is the intended classification, not a failure mode.

Reachability differs sharply across the four. Return 1 is the most reachable, for
two independent reasons: `open_child_dir_for_removal` (`:1293-1307`) collapses
every errno to `None` through `.ok()?`, so `EACCES`, `ELOOP`, `ENOTDIR`, `EIO`,
and descriptor exhaustion all land here; and `open_child_dir` additionally
returns `None` when any group or other mode bit is set (`:1262-1264`). This
implementation always creates generation directories 0o700 (`:777-803`), so a
0o755 directory means some other writer created it — a future release with a
different mode policy, a restore, or an archive extraction under a default umask
— which is precisely the forward-compatibility case quarantine exists for, and it
is classified removable. Return 2 is reachable through an absent or renamed
manifest, or a planted symlink at `manifest.json` yielding `ELOOP`; a future
release that renames its manifest is deleted. Return 4 is reachable through `EIO`
mid-read on a failing device. `read_all_fd`
(`crates/mc-host/src/instance.rs:852-865`) also errors when the accumulated
length exceeds the cap (`:861-863`), but that path is only reached if the file
grew after the `fstat` at `:956`, which needs a writer the transaction lock does
not exclude. Return 3 needs `fstat` to fail on an already-open descriptor, so it
is the least reachable — `EIO` only.

## Failure scenario

`is_quarantined_schema` has exactly one caller, `prune` at `:1007`, reached only
for a canonical digest name outside the protected set (`:997-1003`). So every one
of the four returns produces the same effect: `remove_tree` deletes the
generation (`:1010`). A retained generation written by a newer release, whose
manifest this release cannot read or whose directory mode it does not recognise,
is deleted rather than preserved. That is the forward-compatibility break the
mechanism exists to prevent, and the deletion is not recoverable.

## Timing windows and dependencies

Fault class H4, with H6 for the planted-symlink and mode-bit shapes. No timing
window: the gate is a synchronous read inside a `prune` call that already holds
the transaction lock. Depends on `persisted-state-quarantine-caps-agree`, since
`MAX_MANIFEST_BYTES` is the threshold the one closed arm tests, and on
`validation-and-enumeration-address-one-directory-object`, since the descriptor
this gate opens is not the descriptor `prune` later removes through.

## What a test must construct

Four cases against `prune`, each asserting the generation survives: a generation
directory chmodded 0o755; a manifest replaced by a symlink or removed outright;
an `EIO` on the manifest read; and a failing `fstat`. The last two need an
injectable I/O fault, which does not exist. One test exists,
`an_oversized_manifest_is_quarantined_rather_than_pruned` (`:2059-2100`), and it
covers only the `fstat` size arm at `:957` — it writes an unknown-schema manifest
padded past the cap, promotes a successor so the oversized generation is
unprotected, and asserts `prune` preserves it byte-for-byte.

## Investigation log

### Q: None recorded in the catalog. Verified here instead: are all four failure modes real, and which are reachable?

- Sources examined: `generation.rs:941-968`, `:976-1016`, `:1259-1307`,
  `:364-384`; `crates/mc-host/src/instance.rs:852-865`;
  `crates/mc-host/src/lifecycle.rs:250-284`; the one existing test at
  `generation.rs:2059-2100`; `existing-checks.md:171-173`.
- Findings: all four are real and distinct, as enumerated above. Reachability
  ranks 1 (high, two independent causes including the mode-bit test), 2 (high),
  4 (moderate, `EIO`), 3 (low, `EIO` on an open descriptor only). The catalog's
  claim is confirmed and one cause it does not name — the group/other mode-bit
  rejection inside `open_child_dir` — is the most reachable of all.
- Missing evidence: none needed for the enumeration. Not established is whether
  any release has in fact shipped generation directories with a mode other than
  0o700, which would decide whether return 1 has already fired in the field.
- Conclusion: resolved. The manifest gate returns removable on four failure
  modes; at least two are reachable without any injected fault, and the single
  existing test exercises neither.
