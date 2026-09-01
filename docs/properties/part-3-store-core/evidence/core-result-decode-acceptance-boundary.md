# core-result-decode-acceptance-boundary

## Discovery trigger

`decode_claim_operation_result` is documented at
`crates/mc-core/src/claim_operation.rs:595-596` as a "Strict decoder for a
stored result envelope. Fails closed on an unknown encoding version, outcome, or
malformed effect rows." The word "strict" and the fail-closed posture invite a
check of what the decoder actually constrains. Reading the field handling in
order revealed that five of six fields are recognised strictly and the sixth,
`payload`, is a bare pass-through, and that no rule couples `staleReason` to
`outcome`.

## Evidence trail

Field-by-field, at HEAD `ed487e11`:

- `crates/mc-core/src/claim_operation.rs:600-602` — parse failure is rejected.
- `:603-605` — a non-object top level is rejected.
- `:606-621` — an explicit allowlist of the six permitted top-level keys, with
  any unknown key rejected at `:614-620`.
- `:622-632` — `resultEncodingVersion` must be an integer and must equal
  `CLAIM_RESULT_ENCODING_VERSION` (`:26-27`, value 1).
- `:633-637` — `outcome` must parse via the private
  `ClaimResultOutcome::parse` (`:491-498`) to `applied`, `stale`, or `noop`.
- `:638-646` — `staleReason` must be a string or null. **The value is
  type-checked only. Nothing relates it to `outcome`.**
- `:647-654` — `effects` must be an array, each entry decoded by
  `decode_effect` (`:536-593`), which itself allowlists five fields at
  `:540-554`, requires string `effectKey` and `changeKind` at `:555-563`,
  requires safe-integer `projectId` and `generation` at `:583-590`, and
  re-parses any `revisionLocator` through `parse_revision_locator` at
  `:564-579`.
- `:655-661` — `generations` must be an object whose values are safe integers.
- `:666` — **`payload: record.get("payload").cloned().unwrap_or(Value::Null)`.
  No validation of any kind.**

The asymmetry is exact. `canonical_json_encode` rejects a fractional or
out-of-range number anywhere in the value tree, because
`encode_canonical_value` recurses into arrays at `:119` and objects at `:132`
and calls `number_as_safe_integer` at `:107-109` for every number it meets. So
a payload containing `1.5` cannot be *produced* by the canonical encoder, yet it
is *accepted* by the decoder. `decode_claim_operation_result` therefore accepts
a strict superset of the canonical language, and decode-then-re-encode is not
total.

Fixture coverage, enumerated from
`packages/plugin/src/features/magic-context/memory/fixtures/claim-operation-contract-v1.json`:

- `results.valid` has 2 entries. The `applied` case has payload
  `{"claim":{"publicClaimId":"mcm_...","revision":2},"kind":"revised"}` and
  `staleReason: null`. The `stale` case has payload `null` and
  `staleReason: "revision: revision head moved from r1 to r2"`. Both payloads
  are canonical, and both happen to satisfy the missing cross-field rule.
- `results.invalid` has 5 entries: `wrong-version`, `unknown-outcome`,
  `not-json`, `bad-effect-locator`, `float-generation`. Note `float-generation`
  targets the `generations` map, which *is* validated at `:660`, not the
  payload.

So the fixture cannot detect either gap: it contains no non-canonical payload
and no inconsistent outcome/reason pair.

The re-encode assertion at `:861-868` is worth reading precisely. It parses the
stored bytes and asserts `canonical_json_encode(&parsed) == result_json`. If a
valid fixture case had a non-canonical payload, `canonical_json_encode` would
return `Err` and the `.unwrap()` at `:865` would panic, so the test *would*
catch it. That means the gap is not that the test is weak in kind, but that the
corpus never exercises it.

## Failure scenario

A producer writes a result envelope whose payload was not canonicalised. The
realistic producers are: an older writer predating the canonical rule, a
hand-repaired database row during an incident, a future encoding version whose
payload vocabulary is wider, or a path that serialises the payload with
`serde_json::to_string` instead of `canonical_json_encode`. The envelope is
stored.

On replay, `decode_claim_operation_result` accepts it and returns a
`ClaimOperationResult` whose `payload` carries `1.5`. The failure then surfaces
at whatever layer next canonicalises that payload, as a `NotCanonical` error far
from the write that caused it. A validation miss at write time becomes an
attribution problem at read time.

The cross-field gap has a different shape. An envelope with
`outcome: "applied"` and a non-null `staleReason`, or `outcome: "stale"` with
`staleReason: null`, decodes cleanly. Every consumer that branches on the pair
then sees an incoherent result. `crates/mc-store/src/lib.rs:3943` matches
`ClaimResultOutcome::Applied | ClaimResultOutcome::Noop` as one class, so it
treats the applied case as a success while a `staleReason` is sitting in the
same envelope, which is exactly the kind of contradiction that makes an
incident hard to read.

## Timing windows and dependencies

No runtime race inside the decoder; it is a pure function of a string.

The relevant window is the write-then-replay gap. The decoder's whole purpose is
to be called later, potentially much later, on bytes written by a different
build. So the interesting fault is version skew: bytes produced by build A
decoded by build B. The encoding-version pin at `:628` guards the *envelope*
shape across versions, but because `payload` is exempt from validation, the pin
does not constrain the payload's vocabulary even within version 1.

Dependency: this record shares the number vocabulary with
`core-canonical-encoding-crossruntime-parity`. The two are separable because
that record checks producer-side agreement between runtimes and this one checks
consumer-side acceptance breadth.

## What a test must construct

1. A generator of envelopes that are valid by every rule the decoder enforces
   but whose `payload` subtree contains a non-canonical number: `1.5`,
   `9007199254740993`, `-9007199254740993`, `1e400`, nested inside arrays and
   objects at depth 2 or more so the recursion at `:119` and `:132` is
   exercised.
2. The property: for every input `s`, if `decode_claim_operation_result(s)` is
   `Ok` then `canonical_json_encode(&serde_json::from_str::<Value>(s)?)` is also
   `Ok`. Expressed as `always` over accepted inputs.
3. The cross-field property: for every accepted envelope,
   `decoded.stale_reason.is_some() == matches!(decoded.outcome, Stale)`. Also
   `always`, and stated as a condition on the accepted value.
4. A `sometimes` marker that the campaign actually produced an envelope with a
   non-canonical payload that the decoder accepted, so the coverage is recorded
   rather than assumed. This marker asserts an independent precondition (the
   generator emitted such an envelope), not the violation itself, per the
   coverage-check rule.
5. Round-trip coverage of the `noop` outcome, which the fixture never
   exercises: searching the fixture text for `noop` returns nothing.

Semantics note: both clauses are `always(condition on accepted value)`, never
`unreachable`. The forbidden thing here is a *state* (an accepted envelope that
is non-canonical, or an inconsistent outcome/reason pair). There is no code
location in the decoder that must not execute, so `unreachable` would be the
wrong choice and the method contract forbids it.

## Investigation log

### Q: Is `payload` intentionally opaque?

- Sources examined: `crates/mc-core/src/claim_operation.rs:6-15` (the module's
  statement of the canonical vocabulary, which speaks of "values" generally and
  does not carve out an opaque region), `:518-527` (the
  `ClaimOperationResult` struct, where `payload: Value` is typed as an arbitrary
  JSON value alongside strictly typed siblings), `:666` (the pass-through),
  `:861-868` (the re-encode assertion, which would catch a non-canonical
  payload if the corpus contained one), and the two fixture valid cases (both
  canonical).
- Findings: the evidence points both ways. In favour of opacity: `payload` is
  typed as a bare `Value` while every sibling is a narrowed type, and the
  decoder deliberately allowlists the *keys* but never recurses into the
  payload. In favour of strictness: the module doc describes one vocabulary for
  all values with no exemption, the re-encode assertion at `:865` implicitly
  requires payload canonicality for every fixture case, and both fixture
  payloads are in fact canonical. If payloads were genuinely opaque, the
  re-encode assertion could not be stated as it is.
- Missing evidence: a statement of intent, or a fixture case that deliberately
  stores a non-canonical payload to document the allowance.
- Conclusion: needs human input. The most likely reading is that payload
  canonicality is assumed at write time and simply not re-verified at read time,
  which is a reasonable trust boundary to draw explicitly and a bad one to draw
  by omission. The property is worth checking either way, because the answer
  determines whether the decoder or the writer owns the guarantee.

### Q: Should `staleReason` be data on the `Stale` variant?

- Sources examined: `crates/mc-core/src/claim_operation.rs:483-507`
  (`ClaimResultOutcome`, a fieldless `Copy` enum), `:519-527`
  (`ClaimOperationResult`, where `outcome` and `stale_reason` are siblings),
  `:638-646` (the type-only validation), and the fixture's two valid cases.
- Findings: making `stale_reason` a field of a `Stale` variant would make the
  inconsistent pair unrepresentable, which is the strongest form of the fix.
  The cost is that `ClaimResultOutcome` currently derives `Copy` and has a
  `pub fn as_str(self)` (`:500`), both of which a `String` payload would break,
  and the enum is consumed by `crates/mc-store/src/lib.rs:3943` in a `matches!`
  pattern that would need updating. The wire format at `:606-613` would be
  unchanged, since the two fields stay separate on the wire.
- Missing evidence: how many call sites pattern-match on the enum. I found one
  in `mc-store`; a full survey is that lens's territory.
- Conclusion: needs human input. This catalog records the property and makes no
  fixes, per the method contract. Recording the design option because the
  alternative (an assertion) has to be maintained forever while the type change
  is a one-time cost.
