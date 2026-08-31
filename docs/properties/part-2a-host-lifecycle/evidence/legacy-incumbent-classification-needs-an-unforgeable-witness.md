# legacy-incumbent-classification-needs-an-unforgeable-witness

## Discovery trigger

The catalog recorded this as a repaired defect whose fix widened classification
to an unauthenticated shape, at high confidence because "the widened predicate
was read directly, and the regression test constructs the forgery itself." The
lens is a trust-boundary question about a compatibility fix: a canonical-digest
requirement made every pre-coordination record decode as malformed, so the
repair relaxed it, and the question is what the relaxed predicate still proves.

## Evidence trail

- The fix is `5a74228b`, "fix(mc-host): close review findings on lifecycle
  fences and release contract." Its own summary states the intent: decode the
  pre-U1 shape as `Legacy` so a runtime-lock holder without the lifetime fence
  "classifies as a stoppable pre-coordination incumbent instead of alarming
  wedged on every routine upgrade."
- The diff widens the disagreement check. Before, `classify` had `if lock_free !=
  lifetime_free { return wedged("lifetime and runtime locks disagree", record); }`
  — every single-fence shape was a fault. After, the same commit adds the
  predicate and an exemption:

      let incumbent = !lock_free && lifetime_free && legacy_record.is_some();
      if lock_free != lifetime_free && !incumbent {

  and adds the legacy-record fork that follows it.
- `decode_record` gained the `Legacy` arm in the same commit. At
  `crates/mc-host/src/lifecycle.rs:378`, `legacy_digest` is
  `wire.payload_manifest_digest.is_empty()`; `:381` accepts `legacy_digest ||
  is_canonical_payload_digest(...)`; `:393-397` returns `Legacy` when the digest
  is empty and `Valid` otherwise. Before the commit `:381` required a canonical
  digest unconditionally, so an empty digest was `Malformed`.
- The current predicate is `lifecycle.rs:1091`, exactly as the diff added it. It
  requires three things and nothing else: the runtime lock held (`!lock_free`),
  the lifetime fence free (`lifetime_free`), and a decoded legacy record
  (`legacy_record.is_some()`). It does **not** require a publication, and it does
  not authenticate anything.
- Once `incumbent` is true, `:1110-1116` substitutes the legacy record for the
  valid one and classification proceeds by phase at `:1131-1168`. The `Running`
  verdict at `:1145-1148` additionally requires `publication.daemon_id ==
  record.daemon_id`. The `Starting` and `Stopping` verdicts at `:1138` and
  `:1162` require only a fresh timestamp and **no publication at all**.
- The regression test is the forgery. `a_pre_coordination_incumbent_classifies_by_its_record`
  (`lifecycle.rs:2435-2492`) captures genuine record and publication bytes, lets
  the guard tear down, rewrites `payload_manifest_digest` to the empty string,
  writes both files back with `std::fs::write` and mode `0o600`, takes only an
  exclusive flock on the runtime directory, and asserts `Running`.

Files an attacker must write under the same-user model, and what the runtime lock
does about each:

1. **`mc-host-lifecycle.json`** (`lifecycle.rs:26`) in the runtime directory —
   schema 1, `phase` one of the three strings (`:303-309`), `launch_id` and
   `daemon_id` each 32 lowercase hex characters (`:337-338`, `:371-375`),
   `payload_manifest_digest` exactly empty, `written_at_ms` within 60 s of now
   for a `starting`/`stopping` claim. The runtime lock does **not** protect this
   file: it is an advisory flock on the directory, it guards no write to any name
   inside, and in this scenario the attacker is the holder.
2. **`subc-connection.json`** (`instance.rs:22`) in the same directory, needed
   only for a `Running` verdict — must parse as `ConnectionInfo`, pass
   `info.validate()`, and satisfy `publication_summary` (`lifecycle.rs:887-905`):
   first endpoint host `127.0.0.1`, nonzero port, nonempty `daemon_ver`, key
   length exactly `KEY_LEN = 32` (`connection_file.rs:28`), and `daemon_id`
   matching the record. Same lock story: unprotected, and held by the attacker.
3. Both files must pass `is_secure_regular` (`instance.rs:787-793`): regular
   file, `st_nlink == 1`, `st_uid` equal to the effective uid, and
   `mode & 0o077 == 0`. Under the same-user model all four are satisfiable by
   the attacker, which is what the regression test's `0o600` write demonstrates.

The runtime lock is the only thing the attacker must *hold* rather than write,
and holding it is unprivileged: `flock(dir, NonBlockingLockExclusive)` on a
directory descriptor the same user can open. Nothing in the predicate
distinguishes that from a genuine pre-coordination daemon.

## Failure scenario

1. No daemon is running. The runtime directory exists and is owner-only.
2. A same-user process writes a legacy-shaped record and a matching publication,
   both mode `0o600`, with `phase` `running` and equal `daemon_id` values.
3. It opens the runtime directory and takes an exclusive flock, and does not
   touch `lifetime.lock`.
4. A probe samples: `lock_free == false`, `lifetime_free == true`,
   `legacy_record.is_some() == true`, so `incumbent` is true at `:1091` and the
   disagreement check at `:1092` is bypassed.
5. `classify` reaches the `Running` arm, the daemon IDs match, and the verdict is
   `Running` with reason `"publication matches the running record"`.
6. A launcher reading `Running` treats the squatter as a live incumbent, which
   suppresses a legitimate successor start.

## Timing windows and dependencies

No timing window: every input is a file on disk plus one flock, and the verdict
is deterministic for as long as the attacker holds the lock. A `running` claim
needs no fresh timestamp at all, since the running arm never calls
`timestamp_fresh`; a `starting` or `stopping` claim needs the timestamp refreshed
within the 60 s window (`:773`) but needs no publication. This record depends on
the fence semantics that `probe-never-reports-stopped-while-either-fence-is-held`
establishes — specifically that `incumbent` is the one exempted single-fence
shape.

## What a test must construct

For a legacy-shaped record beside a matching publication, assert the `running`
verdict requires a witness not writable by whoever wrote the record. There is no
such witness today, so the test fails by construction, which is the point. The
adversarial half already exists as
`a_pre_coordination_incumbent_classifies_by_its_record` (`:2435`) — it plants
exactly the forgery and asserts the current permissive outcome, so a property
test can reuse its setup verbatim and invert the assertion. Two variants are
worth adding: a `starting`-phase legacy record with **no** publication at all,
which reaches `Starting` through `:1138` on strictly less evidence, and a
`running` legacy record whose publication `daemon_id` differs, which should stay
`Wedged` via `:1149-1152`.

## Investigation log

### Q: What did `5a74228b` change, and what does the current `incumbent` predicate require?

- Sources examined: `git show 5a74228b` message and its `lifecycle.rs` hunks;
  the current `decode_record` `:356-398`; `classify` `:1035-1177`, in particular
  `:1091-1092` and `:1110-1116`.
- Findings: the commit added the `Legacy` decode arm and replaced an
  unconditional single-fence `wedged` with an `incumbent` exemption. The current
  predicate at `:1091` requires only a held runtime lock, a free lifetime fence,
  and an empty-digest record. **Refinement to the catalog:** the predicate itself
  does not require a matching publication; the publication is required only by
  the `Running` arm at `:1145`. A legacy `starting` or `stopping` record needs no
  publication whatsoever.
- Missing evidence: none.
- Conclusion: confirmed, and the unauthenticated surface is slightly larger than
  the catalog states.

### Q: Which files must an attacker write, and which does the runtime lock protect?

- Sources examined: `lifecycle.rs:26`, `:337-338`, `:356-398`, `:887-905`;
  `instance.rs:22`, `:787-793`; `connection_file.rs:28`; the regression test
  `lifecycle.rs:2435-2492`.
- Findings: two files — the lifecycle record always, the publication only for a
  `running` claim — both subject to `is_secure_regular`, all of whose checks a
  same-user writer satisfies. The runtime-directory flock protects neither: it is
  advisory, it gates no write to any name in the directory, and the attacker is
  its holder in this scenario.
- Missing evidence: none.
- Conclusion: resolved. Nothing in the predicate is unforgeable under the
  same-user model.

### Q: Are pre-coordination releases trusted by definition?

- Sources examined: the commit message's stated intent; the `RecordDecode`
  doc comment at `:340-347`; the `incumbent` comment at `:1084-1090`.
- Findings: all three explain the compatibility motive — a routine upgrade must
  see a stoppable incumbent rather than an alarm — and none states a trust
  assumption about who may write the legacy shape.
- Missing evidence: no design note on the trust model for pre-coordination
  releases.
- Conclusion: unresolved; needs human input, as the catalog records. Not
  answered here.
