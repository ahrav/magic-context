# core-applicability-heads-order-independence

## Discovery trigger

`compute_applicability_heads_digest`
(`crates/mc-core/src/claim_operation.rs:270-282`) is documented as a "Digest
over applicability stream heads: `{seq, streamKey}` pairs sorted by stream key".
Sorting before digesting is the standard way to make a digest depend on a set
rather than on a sequence, which means the function is making an
order-independence promise. The fixture exercises two head lists but never the
same list in two orders, so the promise is asserted nowhere. Reading the sort
comparator then exposed a boundary the promise does not cover.

## Evidence trail

The function:

- `crates/mc-core/src/claim_operation.rs:275` — `let mut sorted: Vec<&(String, i64)> = heads.iter().collect();`
- `crates/mc-core/src/claim_operation.rs:276` — `sorted.sort_by(|left, right| left.0.cmp(&right.0));`
  The comparator reads `left.0` and `right.0` only, which is the stream key. The
  sequence number at index 1 is **not** part of the ordering.
- `cratests/mc-core/src/claim_operation.rs:277-280` — maps each pair to
  `{"seq": seq, "streamKey": stream_key}` in the sorted order.
- `crates/mc-core/src/claim_operation.rs:281` — digests the resulting array
  under `APPLICABILITY_HEADS_DIGEST_PROTOCOL` (`:36`).

`Vec::sort_by` is documented as a stable sort. Stability is exactly what makes
the duplicate-key case order-sensitive: for two entries sharing a stream key,
the comparator returns `Equal` and the sort preserves their input relative
order. So `[("a", 1), ("a", 2)]` and `[("a", 2), ("a", 1)]` produce different
arrays and therefore different digests.

For pairwise-distinct keys the comparator is a total order, so the sorted output
is unique regardless of input order, and the digest is genuinely
permutation-invariant. That is the property to record.

Cross-runtime agreement, checked rather than assumed:

- TS `:240` declares `computeApplicabilityHeadsDigest`.
- TS `:243-245` is `const sorted = [...heads].sort((left, right) => compareCodePoints(left.streamKey, right.streamKey)).map((head) => ({ seq: head.seq, streamKey: head.streamKey }));`
  The comparator is key-only, exactly as in Rust, and it sorts a copied array so
  the caller's array is not mutated.
- `Array.prototype.sort` has been required to be stable since ES2019, so the
  duplicate-key behaviour matches Rust's stable `sort_by`. The two runtimes
  therefore agree on both the distinct-key invariance and the duplicate-key
  order sensitivity.
- The key comparison itself uses `compareCodePoints` (TS `:53-63`), which agrees
  with Rust's `String` ordering. That agreement is covered by
  `core-canonical-encoding-crossruntime-parity`; this record depends on it but
  does not re-verify it.

Neither implementation dedupes, rejects, or otherwise notices duplicate stream
keys. There is no `dedup`, no `HashSet` check, and no error path.

Fixture coverage: the `applicabilityHeads` array has 2 entries. The first is the
empty list with digest
`375aa357e35eec20a8b67953e58e6a9ea05fb829b8a6c5044353ec7b169a1fd3`. The second
is `[{"streamKey":"baseline:v1","seq":4},{"streamKey":"agent:v1","seq":1}]` with
digest `dd5e89e1fc45ba3785369f7356b081775e1f668e3a02a0688ed8cad9806c748a`. Note
the second case is supplied in non-sorted order (`baseline:v1` before
`agent:v1`), so it does prove the sort runs. It does not prove invariance,
because the reversed list is not a separate case with the same expected digest.

## Failure scenario

The digest feeds `ClaimMutationToken.applicability_heads_digest`
(`crates/mc-core/src/claim_operation.rs:244`), which is one of the seven fields
digested into the mutation-token fence at
`compute_claim_mutation_token_digest` (`:264-268`). The fence's job is to detect
that the claim's applicability state changed since the token was issued.

If the digest were order-sensitive for distinct keys, a caller that enumerates
the same heads in a different order would compute a different fence value for
unchanged state. The fence then reports a conflict where none exists, and the
mutation is rejected or retried. Because head enumeration order is typically an
accident of a query plan, an index change or a row-order change in `mc-store`
would produce sporadic, unreproducible fence mismatches: the worst failure shape
to debug, since the data is unchanged and the code is unchanged.

The duplicate-key case is the sharper hazard, because it is not a hypothetical
regression but current behaviour. If a duplicate stream key can occur, the digest
is ill-defined: the same logical state yields one of two digests depending on
enumeration order, producing exactly the sporadic fence mismatch described
above, with no code change required to trigger it.

## Timing windows and dependencies

No race inside the function; it is pure.

The window is at the boundary: whatever produces the head list in `mc-store`
determines both the order and whether duplicates are possible. If that producer
is a SQL query without an `ORDER BY`, the order is unstable across plan changes,
which is precisely the condition that makes order-independence load-bearing
rather than incidental.

Dependency: the key comparison agreement between runtimes belongs to
`core-canonical-encoding-crossruntime-parity`. This record assumes it and
checks only invariance.

## What a test must construct

1. A generator of head lists with **pairwise-distinct** stream keys, including
   keys that differ only past a long shared prefix, keys where one is a prefix
   of another, and keys spanning the BMP/astral boundary so the underlying
   comparison is exercised.
2. For each list, every permutation (or a random sample of permutations for
   longer lists), asserting all permutations produce the same digest.
   Semantics: `always`, since the digest is computed on every token issuance and
   the invariance must hold at every evaluation.
3. Explicitly **not** an invariance assertion for duplicate-key lists. Asserting
   it would assert a law the code does not claim and both runtimes actively
   contradict. Instead:
4. A `sometimes` marker recording whether a head list with a duplicate stream
   key ever reaches the function. This is a situation, not a location, so
   `sometimes` is correct and `reachable` would be wrong. The marker asserts an
   independent precondition (a duplicate key was observed in an input) and never
   the violation, so it still fires on a correct implementation and complies with
   the coverage-check rule.
5. A cross-runtime differential over the same generated lists, comparing the
   Rust digest to the TypeScript digest, since the two implementations must agree
   including on the duplicate-key ordering.

## Investigation log

### Q: Can a duplicate stream key occur in a real head list?

- Sources examined: `crates/mc-core/src/claim_operation.rs:270-282` (the
  function, no dedupe), `:234-246` (`ClaimMutationToken`, which carries only the
  digest, not the heads), TS `:240-246` (same shape), the fixture's two
  `applicabilityHeads` cases (no duplicates), and the parameter type
  `&[(String, i64)]` which permits duplicates by construction.
- Findings: nothing in `mc-core` prevents or detects a duplicate. The type is a
  slice of tuples, not a map, so the caller's shape decides. If the caller
  builds the list from a `BTreeMap` or `HashMap` keyed by stream key, duplicates
  are impossible and the property holds unconditionally. If it builds the list
  from a SQL result set, duplicates depend on the query's grouping. The name
  "heads" implies one row per stream (a stream has one head), which argues
  duplicates are semantically impossible, but that is an inference from naming,
  not evidence.
- Missing evidence: the head-collection query in `mc-store`. That file belongs
  to a sibling lens and this lens must not read it into a conclusion.
- Conclusion: unresolved, needs the `mc-store` head-collection query. If
  duplicates are impossible by construction upstream, the right response is a
  documented precondition on the function plus a debug assertion, not a change
  in behaviour. If they are possible, the digest is ill-defined and the function
  needs to dedupe or reject. Either way the invariance property for distinct
  keys stands on its own and should be checked now.

### Q: Does the fixture's second case prove the sort runs?

- Sources examined: the fixture's `applicabilityHeads[1]` heads array, which is
  `baseline:v1` then `agent:v1`; `crates/mc-core/src/claim_operation.rs:803-822`
  (the test, which feeds the heads in fixture order).
- Findings: yes. `agent:v1` sorts before `baseline:v1`, and the input supplies
  them in the opposite order, so a build that skipped the sort at `:276` would
  produce a different digest and fail. This is a deliberate and good fixture
  choice worth preserving.
- Missing evidence: none.
- Conclusion: resolved with answer. The fixture proves the sort executes; it
  does not prove invariance across permutations, because there is only one
  ordering per case. The property test adds the invariance; it does not replace
  the fixture.
