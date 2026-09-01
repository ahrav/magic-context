# h4c-authority-drain-finish-compares-two-caller-supplied-checksums

## Discovery trigger

`handle_authority_prepare_value` computes one side of its checksum comparison
itself, calling `store.authority_seed_checksum` at
`crates/mc-module/src/lib.rs:7197-7206` and passing only the *expected* side from
the request. `handle_authority_drain_value`, a hundred lines later in the same
`impl` and serving the same authority state machine, passes both sides from the
request. Two paths through one state machine treat the same integrity check
differently.

References are to `crates/mc-module/src/lib.rs` unless the store is named.
Verified at `HEAD` `b5dc778e`; `mc-module` is unchanged between `76cd6f41` and
`b5dc778e`.

## Evidence trail

**The prepare path, which does it well.**

```
7197                let actual =
7198                    match store.authority_seed_checksum(context_store_uuid, project, domain) {
7199                        Ok(checksum) => checksum,
7200                        Err(error) => {
7201                            return PreparedOutcome::Error {
7202                                code: "authority_checksum_failed".to_string(),
7203                                message: error.to_string(),
7204                            };
7205                        }
7206                    };
7207                store.authority_verify_prepare(
7208                    context_store_uuid,
7209                    project,
7210                    domain,
7211                    expected_generation,
7212                    expected,
7213                    &actual,
7214                )
```

`expected` comes from the request at `:7193-7196`; `actual` is computed. The
comparison is therefore between a caller's assertion and the system's own
measurement, which is what an integrity check means.

**The drain finish path, which does not.**

```
7354            "finish" | "flip" => {
7355                let Some(generation) = request.get("generation").and_then(Value::as_u64) else {
7356                    return invalid_params_error("authority drain finish requires generation");
7357                };
7358                let token = request
7359                    .get("coordinator_token")
7360                    .and_then(Value::as_str)
7361                    .unwrap_or("");
7362                let now = request
7363                    .get("now_ms")
7364                    .and_then(Value::as_i64)
7365                    .unwrap_or_else(now_ms);
7366                store.authority_finish_drain(
7367                    context_store_uuid,
7368                    project,
7369                    domain,
7370                    generation,
7371                    request
7372                        .get("checksum_expected")
7373                        .and_then(Value::as_str)
7374                        .unwrap_or(""),
7375                    request
7376                        .get("checksum_actual")
7377                        .and_then(Value::as_str)
7378                        .unwrap_or(""),
7379                    request
7380                        .get("verified")
7381                        .and_then(Value::as_bool)
7382                        .unwrap_or(false),
7383                    token,
7384                    now,
7385                )
```

Three caller-controlled values feed the store's guard, and two of them default to
the empty string.

**The store's guard.**

```
11911                if !all_steps || !verified || checksum_expected != checksum_actual {
11912                    return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
```

(`crates/mc-store/src/lib.rs:11911-11912`.) Three conditions, of which the module
supplies all three inputs to two of them. The guard also checks the generation and
the state first:

```
11888                if current.generation != expected_generation {
...
11896                if current.state != "DRAINING" {
```

(`crates/mc-store/src/lib.rs:11888-11900`.) So a finish request cannot fabricate a
transition from an arbitrary state; it must already be `DRAINING` at the caller's
generation, and `all_steps` must hold.

**Why `verified` defaulting to `false` is the saving grace.** `:7379-7382` defaults
`verified` to `false`, and store `:11911` rejects when `!verified`. So an omission
of all three fields fails closed. The hole requires the caller to *assert*
`verified: true`, at which point the `"" == ""` comparison at store `:11911`
passes vacuously.

**A weaker instance of the same shape on `begin`.**

```
7336                let lease = request.get("lease").and_then(Value::as_str).unwrap_or("");
7337                let expires = request
7338                    .get("lease_expires_at")
7339                    .and_then(Value::as_i64)
7340                    .unwrap_or(0);
```

Here there is no second predicate that fails closed on the default. Whether
`authority_begin_drain` rejects an empty lease is unresolved; see the log.

**A third instance nearby, with the same pattern.** `crates/mc-store/src/lib.rs:11588`
reads `if verified && checksum_expected != checksum_actual`, which is a different
and weaker composition than `:11911`: there the checksum check applies only when
`verified` is true, so an unverified call skips it entirely rather than failing.
Noted because it shows the two-sided-checksum pattern recurs in the store, and a
reader comparing `:11588` with `:11911` should not assume they are equivalent.

## Failure scenario

1. An authority for `(uuid, project, domain)` is in `DRAINING` at generation `g`,
   with all drain steps recorded so `all_steps` holds.
2. A `authority.drain.finish` request arrives carrying `generation: g`, a valid
   `coordinator_token`, `verified: true`, and neither `checksum_expected` nor
   `checksum_actual`.
3. `:7371-7378` default both to `""`.
4. Store `:11888` and `:11896` pass. `all_steps` holds. `verified` is true.
   `"" != ""` is false.
5. The guard at `:11911` does not fire. The drain flips.

Nothing compared the drained data against anything. The flip happened because the
requester said it had verified, and supplied two equal strings as proof.

The severity depends entirely on who may send this request, which is the record's
open question and the reason confidence is medium rather than high.

## Timing windows and dependencies

No timing angle. This is input trust, not a race.

Dependency: the trust class of the drain coordinator. If the coordinator is an
in-process or otherwise trusted component whose token at `:7358-7361` already
authenticates it, this is a robustness gap: a buggy coordinator can flip without
verifying. If the coordinator is a remote or model-influenced caller, it is a
validation hole.

Dependency: `all_steps`, computed inside the store before `:11911`. It is the one
condition the caller does not supply, so it is the real gate. What it requires is
in `mc-store`, which this lens did not read beyond the guard.

## What a test must construct

- An authority driven to `DRAINING` at a known generation with all drain steps
  recorded, so `all_steps` holds and the generation and state checks at store
  `:11888` and `:11896` pass. The eleven `authority.drain.*` dispatch arms at
  `:12257-12267` give the step vocabulary needed to walk it there.
- A `finish` request with `verified: true` and both checksum fields absent.
- Oracle: assert that the authority did not flip. This is a direct state check and
  does not require observing a corrupt intermediate.
- Coverage form for the preconditions, per METHOD.md: assert independently that the
  authority reached `DRAINING` with `all_steps` satisfied, and that the request
  omitted both checksum fields while asserting `verified`. Both are properties of the
  setup, not of the outcome, so the marker fires on a correct implementation too.
- The complementary case is worth the same test file: send `verified: true` with two
  *different* checksums and assert the flip is rejected. That confirms the guard
  works when given real inputs and isolates the finding to the defaulting.
- A separate case for `begin` with `lease` absent, asserting whatever
  `authority_begin_drain` is supposed to do with an empty token.

## Investigation log

### Q: Who may send `authority.drain.finish`?

- Sources examined: the dispatch arms at `:12257-12267`, which route eleven
  `authority.drain.*` method names with no authentication step visible in the match;
  `CompositeComponent::handle` at `:11963-11997`, which applies only
  `enforce_request_byte_cap` before dispatch; the `coordinator_token` parameter at
  `:7358-7361`, whose presence implies the store does authenticate the coordinator
  somehow; `handle_authority_drain_value`'s signature at `:7320`, which notably does
  *not* take a `channel`, unlike `handle_authority_prepare_value` at `:7169-7173`.
- Findings: the missing `channel` parameter is the most telling detail. Every other
  durable handler in this lens takes `channel` and resolves a route binding through
  `resolve_binding` or `management_binding`; `handle_authority_drain_value` and
  `handle_authority_seed_value` (`:7267`) do not. So neither is gated on a route
  binding at all. The only caller-scoping is `authority_request_key` at `:7324` plus
  the `coordinator_token` the store presumably checks.
- Missing evidence: whether the store validates `coordinator_token` against
  something it minted, and what the transport-level trust of the drain methods is.
- Conclusion: needs human input. The absence of a route binding on this handler,
  when every sibling has one, is a real asymmetry and strengthens rather than
  weakens the record, but it does not by itself establish that an untrusted party can
  reach it.

### Q: Does `verified: false` plus equal empty checksums pass?

- Sources examined: store `:11911`.
- Findings: no. `!verified` short-circuits the disjunction and the guard fires. The
  default at `:7379-7382` is therefore fail-closed for an omission.
- Missing evidence: none.
- Conclusion: resolved with answer, negatively. This is why the record is
  `always-or-unreached` rather than `always`: the vulnerable path requires an
  affirmative `verified: true`, which may never occur in shipped traffic.

### Q: Does `authority_begin_drain` reject an empty lease token?

- Sources examined: the call at `:7345-7352`; the defaults at `:7336-7340`.
- Findings: the module passes `""` and `0` without comment. Unlike `finish`, no
  third field fails closed.
- Missing evidence: `authority_begin_drain`'s body in `mc-store`.
- Conclusion: unresolved, needs `mc-store`. Recorded as a second open question on
  this record rather than a separate record, because the mechanism is the same
  defaulting habit and splitting it would duplicate the evidence trail.

### Q: Why does prepare compute the checksum and drain does not?

- Sources examined: `:7197-7214` versus `:7366-7385`; the surrounding code for any
  comment, of which there is none in either place; store `:11588` versus `:11911`
  for the two different compositions of the same check.
- Findings: `authority_seed_checksum` exists and is callable from the module, as
  `:7198` proves, so the drain path could compute `actual` the same way. No comment
  explains why it does not. One plausible reading is that at finish time the data has
  already moved and the coordinator is the only party positioned to have measured both
  sides; that would be a legitimate design, but it is unwritten.
- Missing evidence: author intent.
- Conclusion: unresolved. Recorded as contract-vs-code lead L5 in the lens, with both
  sides cited, rather than resolved in either direction.
