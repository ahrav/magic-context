# current-profile-never-names-an-unvalidatable-generation

Scope note: "generation" here is the payload generation — a content-addressed
on-disk directory under `generations/`, named by the SHA-256 of its canonical
manifest bytes. It is not the connection generation of `connection.rs`, which is
an in-process `u64` lifecycle id. Nothing in this record involves async code.

## Discovery trigger

Reading `stage_and_promote` (`crates/mc-host/src/generation.rs:724-770`) top to
bottom against its own doc comment (`:714-723`), which promises `current` is
unchanged on every failure. The promise is per-error-class, and the sequence has
two renames and four distinct sync points, so "unchanged" has to be checked
against a crash between them rather than against a returned `Err`.

## Evidence trail

The durability order is explicit and, read against the syscalls, correct.
Staging (`:807-864`) synces bottom-up: each copied file is fsynced inside
`copy_source_into` (`:1127`), the manifest is written and fsynced by
`write_new_file` (`:854`, sync at `:1187`), then every directory the run created
entries in is reopened and fsynced deepest-first (`:857-861`), then the temp root
itself (`:862`). The deepest-first claim rests on `dirs.iter().rev()` over a
`BTreeSet<String>` of relative paths: a prefix sorts before its extensions, so
`a` precedes `a/b` lexicographically and the reversed walk emits `a/b` before
`a`. Children are durable before the parent entry naming them.

Promotion (`:876-912`) is the first rename. `rename_no_replace` (`:1216-1242`)
must not replace, because POSIX `renameat` succeeds onto an existing empty
directory (`:872-875`); on success `generations_fd` is fsynced (`:883`) before
returning. Only then does `replace_profile` (`:914-932`) write the profile temp
(`:922`, fsynced at `:1187`), rename it over `current-profile.json` (`:923-929`),
and fsync the root (`:930`). So the ordering is: temp contents durable, digest
entry durable, profile durable — never inverted.

Two forward guards keep the profile from naming something unreadable. Staging
refuses a manifest above `MAX_MANIFEST_BYTES` *before* writing it (`:851-853`),
whose comment states the reason: validation reads under that cap, so a larger
manifest could never be revalidated after promotion. And a quarantined profile
aborts the whole mutation up front (`:732-734`).

The failure paths preserve the selector. Staging failure removes the temp and
returns (`:758-762`). Promotion failure removes the temp and returns
(`:764-767`). `replace_profile` failing after a successful promote leaves an
orphan directory at the digest name that no profile references; `prune`
(`:976-1016`) removes it as unprotected, since only the current profile target,
lock-held digests, and the active candidate are protected (`:970-975`).

## Failure scenario

The fast path never validates what it promoted. When `rename_no_replace`
succeeds at `:882`, `promote_temp` returns immediately and `replace_profile`
names the digest without any call to `validate`. Correctness there rests
entirely on the digest being computed from the exact bytes just written
(`:763`, `:838-846`). Any defect that lets staged content diverge from the
manifest it hashed becomes a profile naming an unvalidatable generation, with no
second check to catch it.

The exchange-then-revalidate window is the other shape. On same-digest repair the
sequence is `exchange_dirs` (`:905`), fsync (`:906`), `validate(digest)` (`:909`),
then delete the orphan now at the temp name (`:910`). Between `:906` and `:910`
the digest name holds the candidate and the temp name holds the corrupt orphan,
both durable. A crash there is benign: the profile still names the same digest
string, that name now holds the repaired directory, and a later prune removes the
temp by its `tmp-` prefix (`:992-996`). The residue is that `validate` at `:909`
re-resolves the digest pathname rather than inspecting the descriptor the
exchange acted on, so it attests to whatever occupies the name at that instant.

## Timing windows and dependencies

Fault class H4, plus a real termination. Every window is inside one
`transaction.lock` hold: `promote_temp`'s two renames, and the gap between the
promote and `replace_profile`. Depends on
`validation-and-enumeration-address-one-directory-object` for the meaning of
`validate` at `:909`, and on `persisted-state-quarantine-caps-agree`, since the
`:851` pre-write refusal is stated in terms of the same cap.

## What a test must construct

Storage exhaustion at each write and sync point, which needs `fsync`-time
exhaustion on a delayed-allocation filesystem to reach the
`fsync_preserving_storage` classification (`:111-119`), and a process kill between
the promoting rename and the profile rename. No fault injection and no crash
test exists. Four in-crate tests cover adjacent ground:
`stage_validate_and_read_current_roundtrip` (`:1456`), the same-digest repair
including the protected-target refusal
(`same_digest_corrupt_target_is_repaired_only_by_validated_exchange`, `:1689`),
post-hoc tampering (`validation_rejects_every_tampered_shape`, `:1516`), and the
quarantine abort (`unknown_schemas_are_quarantined_and_block_mutation`, `:1571`).
`interrupted_staging_leaves_the_old_profile_complete` (`:1736`) plants a leftover
temp and a leftover profile temp rather than interrupting anything, so it proves
inertness of residue, not crash recovery.

## Investigation log

### Q: Should the exchange-then-revalidate window be crash-tested? Whether any reader can observe the intermediate was not established.

- Sources examined: `generation.rs:876-912`, `:914-932`, `:566-597`,
  `:1195-1205`, `:1216-1242`; every `GenerationStore` construction site
  (`crates/mc-module/src/bin/ck-mc-host.rs:845`, `:966`, `:1001`;
  `crates/mc-module/src/bin/ck_mc_host/serve.rs:544`); `preflight_generation`
  (`ck-mc-host.rs:813-847`), `resolve_generation` (`:952-1010`),
  `serve::run` (`serve.rs:538-547`).
- Findings: the crash outcome itself is decidable and safe, for the reason given
  above — same digest string, exchanged content, temp removed by prune. The
  observability half is not. `read_current` and `validate` take no lock
  internally, so exclusion is the caller's. Both launcher readers are under the
  held lock: `preflight_generation`'s comment at `ck-mc-host.rs:830` says the
  store state "is observable under the lock we already hold", and
  `resolve_generation` is reached inside the serialized transaction (`:1268`,
  `:1510`). The one reader that takes no transaction lock is the spawned
  daemon's own revalidation, `serve::run` at `serve.rs:544-547`, in a different
  process. `GenerationStore::prune` has exactly one production caller,
  `ck-mc-host.rs:975`, under the lock.
- Missing evidence: whether the launcher's lock hold extends across the child's
  revalidation, and therefore whether `serve::run` can ever run concurrently
  with another process inside `promote_temp`. The daemon takes `lifetime.lock`,
  not `transaction.lock`, so nothing in the store excludes it; the exclusion
  would come from spawn ordering, which no test asserts.
- Conclusion: unresolved, and narrower than the catalog states. I found no
  reader that can observe the intermediate, but the reason is spawn ordering
  rather than mutual exclusion, and that ordering is unasserted. The crash
  question is answerable without human input; the concurrent-observer question
  needs the launcher's lock lifetime around spawn established first.
