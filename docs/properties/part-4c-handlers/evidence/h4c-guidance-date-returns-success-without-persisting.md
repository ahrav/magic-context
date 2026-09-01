# h4c-guidance-date-returns-success-without-persisting

## Discovery trigger

Part 3 recorded `intent-control-transition-write-is-silently-dropped`: a store
function that returns `Ok(())` without writing when a guard fails. Scanning this
lens's scope for the same shape, `guidance_date_for_session`
(`crates/mc-module/src/lib.rs:7725-7764`) has two returns that skip its only
`store.commit`, and its caller reports `ok: true` either way. The function's
result type is `Result<String, McStoreError>`, so nothing in the signature marks
the difference between a persisted and an unpersisted date.

All references are to `crates/mc-module/src/lib.rs` unless stated. Verified at
`HEAD` `b5dc778e`; `mc-module` is untouched between `76cd6f41` and `b5dc778e`.

## Evidence trail

**The whole function, since its control flow is the finding.**

```
7730        for _ in 0..2 {
7731            let loaded = store.load(session_id)?;
7732            if !loaded.meta.guidance_date.is_empty() {
7733                self.guidance_dates
...
7737                return Ok(loaded.meta.guidance_date);
7738            }
7739            let date_line = self
7740                .guidance_dates
...
7745                .clone();
7746            let Some(expected) = loaded.row_version else {
7747                return Ok(date_line);
7748            };
7749            let mut meta = loaded.meta.clone();
7750            meta.guidance_date.clone_from(&date_line);
7751            match store.commit(session_id, Some(expected), &loaded.core, &meta) {
7752                Ok(_) => return Ok(date_line),
7753                Err(mc_store::McStoreError::CasConflict { .. }) => continue,
7754                Err(error) => return Err(error),
7755            }
7756        }
7757        Ok(self
7758            .guidance_dates
7759            .lock()
7760            .expect("guidance date mutex")
7761            .get(session_id)
7762            .cloned()
7763            .unwrap_or_else(|| self.guidance_date_line()))
7764    }
```

Four exits. `:7737` returns a date that is already durable, which is correct.
`:7752` returns a date it just committed, which is correct. `:7754` returns an
error, which is honest. The two remaining exits are the finding:

- **`:7746-7748`.** `loaded.row_version` is `None`, so the function returns the
  freshly minted `date_line` having written nothing. There is no comment.
- **`:7757-7763`.** The `for _ in 0..2` loop is exhausted. Reaching here requires
  two `CasConflict` results, because `:7753` is the only `continue`. The function
  returns the memoised line, or mints a new one if the memo is gone, having
  written nothing. There is no comment.

**The caller cannot tell.**

```
7674        let date_line = match self.guidance_date_for_session(&store, session_id) {
7675            Ok(date) => date,
7676            Err(error) => {
7677                return PreparedOutcome::Error {
7678                    code: "store_write_failed".to_string(),
7679                    message: error.to_string(),
7680                };
7681            }
7682        };
```

`Ok` means "here is your date". The error code `store_write_failed` at `:7678`
frames the `Err` arm as the write-failure signal, which makes the two silent
non-writing `Ok` arms read as successes.

**The response has no persistence field.** `:7704-7722` builds the reply:
`ok`, `bytes`, `hash`, `content_hash`, `preset`, `served_preset`,
`preset_fallback`, `fallback_notice`, `manifest_content_epoch`,
`manifest_preset_fallback`, `tool_manifest`. `bytes` embeds the date line via
`guidance_bytes_for(text_for_bytes, &date_line)` at `:7703`. Nothing reports
whether that line reached the store.

**The in-process memo hides the divergence.** `self.guidance_dates` is populated
at `:7739-7745` with `or_insert_with`, so once a session has an entry the same
line is returned on every later call that reaches that code, whether or not the
store ever accepted it. Two other sites interact with the memo:
`handle_transform_unpaged_value` removes the entry when a pass commits
(`:8522-8527`), and `:7733-7736` removes it once the store has a date.

**The comparison to Part 3.** Part 3's
`intent-control-transition-write-is-silently-dropped` quotes
`crates/mc-store/src/lib.rs:4124-4126`:

```
4124     if !is_lower_hex(database_incarnation_id, 32) {
4125         return Ok(());
4126     }
```

Same shape, one layer down: a guard failure produces an indistinguishable success.
That record is about a store function; this one is about a module handler, so they
are separate records rather than duplicates.

## Failure scenario

The CAS path, which is the reachable one in normal traffic:

1. A session has an empty `meta.guidance_date` and a live `row_version`.
2. `guidance.get` arrives. `:7731` loads. `:7732` sees an empty date. `:7746` gets
   a `Some(expected)`. `:7751` commits and hits `CasConflict` because a transform
   pass committed in between.
3. `:7753` continues. Second iteration: `:7731` reloads, `:7732` still sees an
   empty date because the competing writer was a transform, not this function.
   `:7751` conflicts again.
4. The loop ends. `:7757-7763` returns the memoised line.
5. The caller receives `ok: true` with that date in `bytes` and a `hash` over it.
   `meta.guidance_date` is still empty.
6. Every later `guidance.get` in this process re-enters the same loop and returns
   the same memoised line, so the served bytes stay self-consistent.
7. The process restarts. The memo is gone. The next call mints a fresh line at
   `:7744`. If the wall clock has crossed midnight, or if `guidance_now_ms` differs,
   the session's served date changes even though nothing about the session did.

The `row_version == None` path at `:7746-7748` is the same ending reached sooner.

## Timing windows and dependencies

The CAS window needs two conflicts in a row. The competing writer is any other
`store.commit` against the same session; the transform pass commit is the obvious
one, and `handle_session_recomp_value` (`:6077`) is another. Under a busy session
this is ordinary traffic, not a rare interleaving.

The `row_version == None` window needs a session whose loaded state has no row
version. Whether that is reachable in production depends on `store.load`'s
behaviour for a session with no committed row, which this lens did not chase into
`mc-store`.

Dependency on the clock: `guidance_date_line_for_ms` (`:4510-4517`) formats
`Local` time, so the observable consequence of the unpersisted state is
date-boundary dependent. `set_guidance_now_ms_for_test` exists in the
`:4427-4532` group, so the clock is injectable.

## What a test must construct

- A session with an empty `meta.guidance_date` and a live `row_version`.
- Two consecutive `CasConflict` results from `store.commit`. The cheapest
  construction is a real competing committer rather than a fault injector: drive a
  transform commit concurrently, twice. A store seam that returns `CasConflict`
  twice is cheaper if one exists.
- Oracle: assert `store.load(session_id).meta.guidance_date` is nonempty whenever
  a `guidance.get` returned `ok: true`. This is the direct oracle and it does not
  require observing the defect, because on a correct implementation the postcondition
  simply holds.
- Coverage form for the preconditions: assert separately that the served response
  was `ok: true` and that the loop reached its second iteration. Both are
  independent of the bug.
- The `row_version == None` path needs its own case and may not be constructible;
  if not, that half of the record is `always-or-unreached` in practice and should
  be split out.

## Investigation log

### Q: Is the two-iteration retry budget deliberate?

- Sources examined: `:7730` for the loop bound; the surrounding function for any
  comment; `:7757-7763` for the fall-through; the four `guidance_*` tests at
  `:22491`, `:22537`, `:22590`, `:22909` and `:22935`.
- Findings: no comment anywhere in `:7725-7764`. No test drives a conflict. Other
  bounded retries in this file do carry comments explaining the bound, for example
  the CAS-conflict reasoning at `:6080-6082` in the recomp handler, which makes the
  silence here notable rather than conventional.
- Missing evidence: author intent. Two plausible readings: `0..2` is a deliberate
  best-effort budget on a non-critical field, or it was written as "try, then try
  once more" without considering the fall-through.
- Conclusion: needs human input. The behaviour is established; the intent is not.

### Q: Does the unpersisted date actually change what the agent sees, or is it cosmetic?

- Sources examined: `:7703` where `date_line` enters `guidance_bytes_for`;
  `:7707` where `hash` is taken over those bytes; `:7708-7710` where the comment
  states "The date line changes every day, so content_hash excludes it".
- Findings: the comment at `:7708-7710` establishes that the authors treat the
  date line as deliberately outside `content_hash`, so a changed date does not
  invalidate `content_hash`. But `hash` at `:7707` *is* over the full bytes
  including the date. So a date change across a process restart changes `hash`
  while leaving `content_hash` stable.
- Missing evidence: what the caller does with `hash` versus `content_hash`. That
  consumer is host-side or in 4d's range.
- Conclusion: unresolved, needs the consumer of the `hash` field. The mechanism
  is established: an unpersisted date can produce a different `hash` for the same
  session after a restart.

### Q: Is this the same defect Part 3 already recorded?

- Sources examined: `docs/properties/part-3-store-core/evidence/intent-control-transition-write-is-silently-dropped.md`,
  which cites `crates/mc-store/src/lib.rs:4118-4145`.
- Findings: different function, different crate, different guard. Part 3's is a
  store-internal transaction helper guarded on a hex-format check; this is a module
  handler guarded on a CAS budget and a missing row version.
- Missing evidence: none.
- Conclusion: resolved with answer. Distinct records. The value of the link is that
  it establishes silent non-writing as a recurring pattern across two layers, not
  that the records overlap.
