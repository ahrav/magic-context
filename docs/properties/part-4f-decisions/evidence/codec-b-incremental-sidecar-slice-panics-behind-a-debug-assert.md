# codec-b-incremental-sidecar-slice-panics-behind-a-debug-assert

## Discovery trigger

The task brief asked me to check codec paths for panicking constructs
explicitly, because a sibling part found a production `assert!` and an
`unreachable!` elsewhere in this crate. Grepping the codec production halves for
`unwrap()`, `expect`, `panic!`, `unreachable!`, and `assert!` returned nothing.
Grepping for `debug_assert!` returned three hits, and the line eight lines below
the first two is a slice index on the value they guard.

## Evidence trail

`crates/mc-module/src/codec/opencode.rs:246-262`, read at `HEAD` `e447c927`:

```
246: pub(crate) fn decode_opencode_sidecar_incremental(
247:     messages: &[MessageV2Json],
248:     prior: &DecodeSidecar,
249:     replace_from: usize,
250: ) -> DecodeSidecar {
251:     debug_assert!(replace_from <= messages.len());
252:     debug_assert!(replace_from <= prior.order.len());
253:     if replace_from == messages.len() && replace_from == prior.order.len() {
254:         return prior.clone();
255:     }
256:
257:     let suffix = decode_opencode_with_sidecar_and_base(
258:         &messages[replace_from..],
259:         Some(prior),
260:         replace_from as u64,
261:     )
262:     .sidecar;
```

`debug_assert!` is compiled out when `debug_assertions` is off, which is the
default for `[profile.release]`. The early return at `:253-255` requires equality
on both counts, so it does not shield `:258`: for `replace_from = 5` and
`messages.len() = 3`, the condition is false and control reaches the slice.
`&messages[5..]` on a 3-element slice panics with "range start index 5 out of
range for slice of length 3".

The second `debug_assert!` at `:252` guards a different expression:
`prior.order.iter().take(replace_from)` at `:265` is a `take`, which saturates
rather than panicking. So `:252` is advisory and `:251` is load-bearing.

Both in-tree callers, traced:

`crates/mc-module/src/lib.rs:12550-12563`:

```
12550: fn validated_native_prefix(
12551:     request: &TransformRequest,
12552:     snapshot: &NativeAttachmentCacheSnapshot,
12553:     frontier: Option<&NativeDeltaFrontier>,
12554: ) -> usize {
12555:     let native_len = request.native_messages.as_deref().map_or(0, <[Value]>::len);
12556:     frontier
12557:         .filter(|frontier| {
12558:             Some(frontier.after.as_str()) == snapshot.full_array_fingerprint.as_deref()
12559:         })
12560:         .map(|frontier| frontier.native_replace_from)
12561:         .filter(|replace_from| *replace_from <= native_len)
12562:         .unwrap_or(0)
12563: }
```

`crates/mc-module/src/lib.rs:12565-12585`:

```
12565: fn native_sidecar(
12566:     request: &TransformRequest,
12567:     snapshot: Option<&NativeAttachmentCacheSnapshot>,
12568:     trusted_prefix: usize,
12569: ) -> Arc<codec::DecodeSidecar> {
12570:     let native_messages = request.native_messages.as_deref().unwrap_or_default();
12571:     let Some(snapshot) = snapshot else {
12572:         return Arc::new(codec::decode_opencode(native_messages).sidecar);
12573:     };
12574:     if trusted_prefix == native_messages.len() && trusted_prefix == snapshot.sidecar.order.len() {
12575:         return Arc::clone(&snapshot.sidecar);
12576:     }
12577:     if trusted_prefix > 0 && trusted_prefix <= snapshot.sidecar.order.len() {
12578:         return Arc::new(codec::opencode::decode_opencode_sidecar_incremental(
12579:             native_messages,
12580:             &snapshot.sidecar,
12581:             trusted_prefix,
12582:         ));
12583:     }
12584:     Arc::new(codec::decode_opencode(native_messages).sidecar)
12585: }
```

The important detail: `native_sidecar`'s own guard at `:12577` bounds
`trusted_prefix` against `snapshot.sidecar.order.len()`, which discharges
`debug_assert!` at `:252`. It says nothing about `native_messages.len()`, which is
what `:251` needs. That bound arrives only because the caller passes
`validated_native_prefix`'s return value, and that function filters against
`native_len` at `:12561`. So the two assertions in the callee are discharged by
two checks in two different functions, and neither check names the callee.

The frontier field itself is `frontier.native_replace_from`, which comes from
cached snapshot state rather than from the current request, which is why the
`:12561` filter exists at all: a stale frontier can name a prefix longer than the
current array.

Contrast with the projection path, which handles the identical hazard
explicitly. `lib.rs:12531-12541` deliberately corrupts the prefix under
`cfg(test)`:

```
12531:     #[cfg(test)]
12532:     let prefix = if mode == ProjectionCacheKeyMode::CorruptFrontierForTest {
12533:         replace_from.saturating_add(1)
12534:     } else {
12535:         replace_from
12536:     };
```

and then re-clamps at `:12543` with
`(prefix <= projection.message_count()).then_some(...)`. The test hook is
declared at `lib.rs:12456-12461` (`ProjectionCacheKeyMode::CorruptFrontierForTest`)
alongside `NativeCacheKeyMode::CorruptSidecarForTest` at `:12450-12454`. So the
authors built a corruption hook for the projection prefix and clamp it defensively;
the sidecar slice has neither.

`ck_wire.rs:369-372` states the policy the projection path follows: "The caller
validates the session fingerprint and context before supplying `cached`;
malformed or out-of-range local metadata falls back to a full projection rather
than trusting a partial result." The sidecar path has the same caller-validates
structure and the opposite failure behaviour.

Confirmed this is production code and not test-gated: the nearest `#[cfg(test)]`
markers above `:12588` are at `:12452`, `:12459`, and `:12531`, and all three are
attributes on an enum variant or a `let` binding, not on a `mod tests` wrapper.

## Failure scenario

A release build. A cached `NativeAttachmentCacheSnapshot` whose
`full_array_fingerprint` matches a `NativeDeltaFrontier` whose
`native_replace_from` exceeds the current `native_messages.len()`, reaching
`decode_opencode_sidecar_incremental` without passing through
`validated_native_prefix`. Today that requires a new caller or an edit to
`:12561`. The result is a panic inside the transform on the default production
path, which unwinds through the host's request handler.

The realistic route is maintenance, not input: a third caller added for a new
incremental path, written against `native_sidecar`'s visible guard at `:12577`
(which looks sufficient) and unaware that the `messages.len()` bound comes from
somewhere else entirely.

## Timing windows and dependencies

No runtime window inside the callee; it is a pure function. The window is between
the two guards and the call: `validated_native_prefix` computes `native_len` from
`request.native_messages` at `:12555`, and `native_sidecar` re-derives
`native_messages` from the same request at `:12570`. Both read the same
`&TransformRequest`, so they cannot disagree within one call. If a future
refactor separated them, they could.

Depends on: nothing. Depended on by: the correctness of every incremental
native-attachment pass, since a panic here aborts the pass.

## What a test must construct

1. A direct unit test on `decode_opencode_sidecar_incremental` with
   `replace_from = messages.len() + 1`, asserting a returned sidecar rather than a
   panic. It will fail at `HEAD`, which is the point: the property as stated is
   not satisfied.
2. The same test compiled with `debug_assertions` off, so the observed failure is
   the slice panic rather than the assertion. `cargo test --release` is enough.
3. A `NativeCacheKeyMode::CorruptSidecarForTest` path mirroring
   `lib.rs:12531-12541`'s projection corruption, so the integration-level route
   is exercised too. The enum variant already exists at `:12450-12454`; I did not
   determine whether it currently perturbs the prefix or something else.

## Investigation log

### Q: Should the function clamp and fall back to a full decode?

- Sources examined: `codec/opencode.rs:246-281`; `lib.rs:12525-12585`;
  `ck_wire.rs:364-380`; `ck_wire.rs:419-430`.
- Findings: the projection path already implements exactly that policy and
  documents it at `ck_wire.rs:369-372`. `native_sidecar` has a full-decode
  fallback available and uses it in two other arms (`:12572`, `:12584`), so the
  clamp would cost one line and reuse an existing path. There is no counterargument
  in any comment.
- Missing evidence: none technical. Whether the `debug_assert!` is intended as a
  contract on callers ("this must never happen, and I want it loud in debug") or
  as a placeholder is not stated.
- Conclusion: needs human input. The mechanism is clear and the fix is cheap; the
  choice between "clamp silently" and "return an error" is a contract decision,
  and the crate holds both positions in adjacent code.

### Q: Does `NativeCacheKeyMode::CorruptSidecarForTest` already exercise this?

- Sources examined: `lib.rs:12448-12461`; searched for uses of
  `CorruptSidecarForTest` across `crates/mc-module/src`.
- Findings: the variant is declared at `:12450-12453` under `#[cfg(test)]`. I did
  not trace every use site, and I did not confirm what it perturbs.
- Missing evidence: the full use-site set. This is 4c and 4d territory (the
  native-attachment cache), and tracing it fully would exceed this lens's scope.
- Conclusion: unresolved, needs a 4c or 4d reading of the native-attachment cache
  key modes. If `CorruptSidecarForTest` does perturb the prefix, the record's
  `Exercised` line should move from `not yet` to `partial` and the impact drops,
  because a debug-build test would then catch the assertion.

### Q: Is `debug_assert!` at `:252` also load-bearing?

- Sources examined: `codec/opencode.rs:263-280`.
- Findings: no. The only use of `replace_from` after `:258` is
  `prior.order.iter().take(replace_from)` at `:265`. `Iterator::take` saturates at
  the iterator's length, so an over-large `replace_from` yields the whole prefix
  rather than panicking.
- Missing evidence: none.
- Conclusion: resolved with answer. `:251` is the one that panics; `:252` is
  advisory. The record's check is stated over `replace_from` generally, which
  covers both.
