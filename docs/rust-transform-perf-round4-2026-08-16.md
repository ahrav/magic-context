# Rust transform performance round 4 (2026-08-16)

## Measurement method

The profile used `VACUUM INTO` copies of the live OpenCode and Magic Context databases. The copies, project clones, module state, logs, and OpenCode XDG directories lived under this task worktree and were deleted after the run. The source databases were opened read-only and were never passed to OpenCode or the module.

The rig used the existing `HermeticSubcStack`, the release `ck-mc` binary, an isolated OpenCode server, and the E2E mock provider. The measured ENGRAM session had 4,575 ingress messages and 12,330 projected blocks before the profile turns. Each warm turn appended a small user/assistant tail. Differential assertions remained enabled in tests but were disabled in the timing binary because they intentionally repeat full projection and native encoding.

## Measured cost centers before changing the hot paths

A steady delta pass on the isolated ENGRAM copy showed that the retained projection was working, but several downstream consumers still traversed the complete history.

| Stage | Before (ms) | Evidence |
| --- | ---: | --- |
| Handler total | 675.9 | Entire module handler, the value represented by the plugin's module bracket |
| `apply_once` | 495.2 | Core transform |
| Projection | 4.6 | 4,578 reused messages, 3 projected messages |
| Planning | 37.1 | Included protected-tag evaluation over the full projection |
| State evolution | 346.4 | Dominated by repeated tool-arc searches and tokenization |
| Build output | 34.7 | Output cache hit for all but the changed tail |
| Historian trigger | 26.2 | 12,284 token-cache hits, 3 tokenized blocks |
| Native attachment | 49.4 | 4,519 reused native messages, 5 encoded messages |
| Retained-size accounting | 41.5 | Rewalked retained request/native trees |
| Response encode | 21.4 | Encoded the complete native output despite a tiny changed tail |

The ASTRO copy (about 5,670 messages and 17,940 blocks) also exposed the output-cache refusal mode: a steady pass had zero cache hits, 5,650 serialization misses, `build_output=295.0ms`, `apply_once=976.5ms`, and `handler_total=1120.2ms`. The old 64 MiB output-cache ceiling could not retain that single real session.

The main algorithmic defect was in channel directive accounting. For every eligible tool result, `channel2_extra_token_lanes` rescanned the full projection and retokenized matching tool input and reasoning. Frozen reduction checks also linearly scanned every frozen unit once per candidate block. Both paths were quadratic on real histories even though projection itself was incremental.

## Changes

1. The one-line `mc-pass-timing` record now covers handler ingress, delta expansion, projection-cache lookup/store, historian boundary construction/evaluation, native attachment, retained-size accounting, snapshot storage, response metadata encoding/size accounting/splicing, and core planning/state/finalization subphases. The plugin logs the corresponding module fields.
2. Channel directive accounting is linear. Frozen targets are indexed once, tool-arc token lanes are accumulated once, and each `FlatBlock` retains its tool-input/reasoning token counts. Incremental projection therefore tokenizes only changed suffix blocks.
3. The serialized-output cache budget is 256 MiB so a 24-55 MiB real output plus its typed CK representation can remain resident. `ServedMessage` computes its retained-size charge once when serialized; cache replacement no longer walks every served tree.
4. Warm native responses use a fingerprint-fenced replacement suffix. The adapter retains the prior acknowledged module output by reference and reconstructs the exact full output before validation/postprocessing. Missing cache state, a fingerprint mismatch, or an invalid frontier fails closed instead of applying a suffix to the wrong prefix.
5. Native attachment takes ownership of the prior cache snapshot instead of deep-cloning its maps and trees. Sidecar hashes/sizes and ingress retained-size charges are reused; only suffix entries are computed. Snapshot request accounting similarly reuses per-message and native prefix charges.
6. Boundary token cache snapshots share immutable maps and record suffix updates. On the ordinary single-flight path replacement takes ownership rather than cloning every key. Same-length content edits remain fenced by the projected content hash.
7. `full_drop_tool_ids` indexes tool-call kinds once, and build-output indexing retains only message IDs that can be emitted.
8. Memory and compartment mirrors run asynchronously, sequentially, and with the existing memory-pull coalescer. Their results are not read by the serving pass. A 141 ms isolated pull completed after the pass; it no longer extended the transform promise. The same change bounds the reported 1.5 s backlog spikes off the hot path.

## After table

The final steady ENGRAM delta used 4,576 retained messages plus a 3-message suffix. It reused 4,519 output-cache entries, re-encoded 5 native messages, and tokenized 3 historian blocks.

| Stage | Before (ms) | After (ms) |
| --- | ---: | ---: |
| Handler total | 675.9 | **149.5** |
| `apply_once` | 495.2 | **75.0** |
| Delta expansion | 39.9 | 21.8 |
| Projection | 4.6 | 3.0 |
| Planning | 37.1 | 5.8 |
| State evolution | 346.4 | 14.3 |
| Build output | 34.7 | 18.2 |
| Historian trigger | 26.2 | 14.2 |
| Native attachment | 49.4 | 25.4 |
| Retained-size accounting | 41.5 | **0.0** |
| Response encode | 21.4 | **0.6** |
| Plugin transport call | not retained in the first local table | 190.7 |

The handler improved 4.5x and the core transform is below 100 ms, but the complete release handler remains 149.5 ms on this host. This does **not** satisfy the requested sub-100 ms complete module bracket. The remaining measured floor is `apply_once=75.0`, delta reconstruction 21.8, native attachment 25.4, historian trigger 14.2, and projection-cache storage 5.7 ms (some stages overlap the handler's post-attach aggregate). Further progress requires removing the full native-prefix reconstruction from `TransformRequest`, whose `Vec<Value>` ownership currently forces deep prefix cloning before the incremental attachment code can run.

The full plugin pass was 380.5 ms in this run. Of that, 149.5 ms was the module handler, prefix guard was 8.8 ms, state sync 0.5 ms, apply 2.0 ms, LKG preparation 11.5 ms, and 166.2 ms was loaded OpenCode event-loop delay. The latter is outside the module and varied materially between repeated runs.

## Prefix corruption sentinel

A truly O(delta) deep prefix check is not sound with the current OpenCode hook API. Messages and nested tool arguments are mutable JavaScript objects and carry no trusted mutation generation. Object identity, message ID/count, byte length, and shallow timestamps all miss a same-object, same-length edit. A cached digest also has to be recomputed over the prefix unless the mutator supplies a trustworthy revision.

This change therefore does not weaken the sentinel by claiming an unsafe O(delta) fast path. The existing cache-miss fallback sends the complete array. A cache hit still compares the deep `MessageContentSnapshot` of every reused raw message at the point where a tail delta would be selected. The equal-length mutation test changes a nested tool query from `alpha` to `bravo`; the deep comparison rejects the delta and the adapter full-sends. Randomized deep mutations, key additions/removals/reordering, and nested type changes are compared against the legacy detector. On the isolated live copy the complete 4.5k-message guard measured 8.8 ms.

A future O(delta) implementation needs an OpenCode-owned immutable message revision (covering all nested `info`, `parts`, provider metadata, and tool input/output) or persistent immutable message nodes. Without that producer contract, skipping old objects changes detection semantics.

## Cold restart digest decision

A digest-only handshake is unsafe and insufficient today, so it was not implemented.

The durable module store retains compaction/cache state, but the raw CK/native ingress prefix used by delta projection and native attachment is process-local. After a serve restart, a digest match could prove that the host still has the same bytes, but it would not give the restarted module those bytes. Accepting a tail delta would therefore either fail later or serve state reconstructed without the retained raw prefix. IDs plus content lengths are additionally vulnerable to the same-length mutation demonstrated by the prefix-guard test.

A sound cold-seed design must persist, atomically with row version, revert epoch, generation, serializer/render epochs, and the digest:

- the canonical raw CK/native prefix (or an equivalent lossless projection/sidecar snapshot),
- a versioned cryptographic digest over message IDs, ordering, all content/provider metadata, and structural boundaries,
- the exact message count/frontier represented by that snapshot.

The adapter may then compare a digest computed over the same canonical vocabulary. Match resumes from the persisted frontier; mismatch, unknown algorithm, partial snapshot, generation/revert edge, or series restart falls back to the current full sync. `computeRawRangeFingerprint` is useful vocabulary but is not by itself a cryptographic full-identity proof and does not persist the bytes the module needs.

## Correctness evidence

- Native output delta reconstruction preserves the acknowledged prefix by reference and appends only the replacement suffix. A fingerprint mismatch is rejected.
- Native attachment and prefix projection differential tests compare complete serialized output against the full paths.
- Boundary token-cache tests cover same-length content mutations.
- The adapter tests cover same-length nested tool-input mutation, arbitrary deep mutations, cache-drop full-send fallback, and native-delta fingerprint fencing.
- The `real_daemon` leg remains skipped because the reported sibling daemon boot/registration regression is external to this change.

---

## Native attachment incremental cache design

(absorbed from the 2026-08-10 design doc; budget figures updated to the shipped 256 MiB constants)

### Cache shape and frontier

`McHandler` owns one 256 MiB process-local LRU budget shared by all cached sessions. A session entry is fenced by the durable `revert_epoch` and stores:

- the last acknowledged full-array fingerprint;
- an `Arc<DecodeSidecar>` whose unchanged prefix metadata is also shared through `Arc`;
- one native cache key per served CK message;
- encoded OpenCode chunks as `Arc<Value>`, including each chunk's consumed CK range;
- per-message sidecar digests and hit/miss counters;
- an `Arc<FlatProjection>` with per-message block ends and projector frontier state.

The projection and native attachment are two consumers of the same session snapshot, fingerprint, context, revert-epoch fence, LRU, and eviction. A tail delta may reuse the projected prefix only after the prior transform snapshot and this shared cache entry both acknowledge the same `after` fingerprint. The cached projector frontier carries pending tool-call arcs across the first changed message. Prefix `FlatBlock` clones share their canonical bytes, CK wire, and tool input through `Arc`, so reconstruction copies only small metadata rather than the retained payload trees.

A tail delta may reuse sidecar metadata only when its validated `after` fingerprint matches the cache entry and its `native_replace_from` frontier is in range. Full-array requests re-read and hash their sidecar metadata even when the opaque fingerprint repeats, so a message metadata mutation cannot hide behind a stale caller fingerprint.

Full-array requests always project every message. Validated tail deltas project only at or after `replace_from`; the message/block frontier maps the caller's message position to a flat-block prefix without scanning payloads. The first changed served-message key determines the suffix to encode. The restart point backs up one CK message and then snaps to the beginning of the containing encoded chunk. This preserves adjacent fresh tool pairs and collapsed synthetic todo pairs. Cached prefix values are shared by `Arc`; only suffix values are allocated and encoded. The whole combined array still passes the duplicate-tool-use assertion.

### Key fields

The session context key contains:

- session id;
- serializer profile and profile render epoch;
- render configuration;
- renderer transition-consumed salt.

Each served-message key hashes:

- the serialized-output cache identity produced by `message_output_identity` for tail messages;
- the canonical CK message hash as a byte-level backstop;
- served position;
- full sidecar/message metadata digest;
- message tag number;
- reasoning-clear eligibility;
- mutation-exemption state for the live assistant or lineage anchor.

The sidecar digest covers retained raw OpenCode fields and block metadata, not only CK-visible content. Incremental suffix decoding calls the ordinary decoder with the prior sidecar, so the decoder first clones all prior `mid_pins` and then adds suffix pins. Assigning the resulting pin map to the merged sidecar therefore preserves prior pins; there is no separate merge with a conflicting value. A three-generation regression compares this behavior with a full decode and proves that clearing inherited pins produces a different identity.

### Budget accounting and RSS bound

The 256 MiB limit bounds the cache's **charged estimate**, not process RSS. For each retained session the charge is `E + 2S + N + P`:

- `E` is the recursive retained-size estimate for encoded native `Value` chunks;
- `S` is the canonical served-CK byte count; `2S` conservatively proxies the served-message objects and shared canonical storage;
- `N` is the sidecar charge: twice each serialized message-meta size plus the meta struct, sidecar map/order/pin string payloads, and the sidecar struct itself. Prefix `N` values are reused and suffix values are computed alongside the existing sidecar hash.
- `P` is the projected-prefix charge: each `FlatBlock` struct and owned identity string, three times its serialized CK-block byte length (canonical string, CK tree, and separately retained tool input), the block-identity map, message/block ends, and pending tool-arc frontier strings. The third copy is conservative for blocks without tool input.

The limit does not precisely charge allocator bucket/capacity overhead, `Arc`/map node overhead, transient serialization buffers, or every non-string container allocation. During replacement, the old snapshot and new snapshot can coexist until the request-local old snapshot drops; unchanged `Arc` data is shared, but changed trees can temporarily exist twice. Operationally, use **4× the configured budget as a conservative transient RSS headline for this one cache during replacement** (1 GiB for the default 256 MiB). That multiplier is replacement-window guidance for this cache alone, not an enforced ceiling; the steady-state charged bound across the three caches is the 768 MiB compile-time aggregate noted below.

### Invalidation matrix

| Change | Native attachment fence | Projected-prefix effect |
| --- | --- | --- |
| Fold or m0/m1 byte change | Canonical message hash; changed prefix position restarts encoding | Ingress CK is unchanged, so projection remains valid for this pass; the shared entry is replaced with the newly served snapshot afterward. |
| Coverage advance/removal | Message sequence/position mismatch | Coverage is downstream state, not an ingress projection input; shared-entry replacement still keeps both consumers on the latest acknowledged pass. |
| Frozen reduction or reasoning healing | Serialized-output identity plus canonical hash | These mutate served output after projection; the cached ingress prefix is byte-identical and the differential compares the complete projection. |
| Synthetic todo insertion, move, replacement, or removal | Message sequence keys and chunk-boundary restart | Ingress synthetic metadata/content is projected, so a changed `replace_from` suffix is re-projected; unchanged reconstructed prefix comes from the acknowledged request. |
| Renderer transition salt | Session context key | The same context key gates projected reuse. Transition state discovered during this pass affects rendering, not ingress projection, and replaces the shared entry afterward. |
| Durable revert epoch | Session entry eviction | Same session-entry eviction. |
| Render/profile epoch or profile change | Session context key | Same context key; projected reuse is refused before reconstruction. |
| Tag mutation | Per-message tag number and CK output identity | Tags already present in ingress CK are covered by the changed-tail frontier. Store-only tag state is downstream and replaces the shared entry after attachment. |
| Reasoning watermark or mid-turn effect | Per-message reasoning-clear eligibility and mutation exemption | Watermarks alter served/native output after ingress projection; shared-entry replacement and the projection differential cover the distinction. |
| Sidecar/raw/provider metadata change | Per-message sidecar digest | Sidecar-only fields are not `FlatProjection` inputs; native reuse invalidates while the byte-equivalent ingress projection may still reuse. |
| Tail append/replace | Validated fingerprint frontier reuses only unchanged sidecar metadata; changed output suffix is encoded | The same fingerprint plus `replace_from` reuses only the acknowledged projected prefix and projects the suffix. |

### Differential and live observability

Tests always run a full native encode after the incremental path and compare serialized JSON bytes. Any module build, including an optimized release binary, can enable the same assertion with `MC_NATIVE_ATTACHMENT_DIFFERENTIAL=1`; the real-daemon suite does so. Incremental projection likewise serializes and byte-compares its blocks, identity map, and retained CK wire against a full projection, then compares projector frontier state. Any build can enable it with `MC_PREFIX_PROJECTION_DIFFERENTIAL=1`, and the real-daemon suite enables both modes. Each environment variable is read once per process and then cached, so the unset steady path performs only a `OnceLock` read. These are diagnostic switches: when enabled, they intentionally pay for a full native encode or full projection on every incremental pass and therefore erase the corresponding performance win. Mutation tests deliberately omit the sidecar digest from native cache-key derivation and advance the projection's first-changed frontier by one; each differential assertion fails on the resulting stale bytes. Regression coverage also exercises frozen reductions, collapsed synthetic todo pairs, compaction markers, reasoning clearing, every invalidation class, and duplicate tool-use detection.

The pass timing record retains `post_attach_ms` and `native_cache_reused_messages` / `native_cache_encoded_messages`, and adds `projection_reused_messages` / `projection_projected_messages`, allowing live traces to distinguish a genuinely incremental pass from a fast full pass.

At 2,500 messages with 4 KiB text payloads (release fixture, 2026-08-10), the pre-change decomposition was projection 24.620 ms, apply 5.830 ms, attach 2.639 ms, and encode 5.302 ms. After prefix projection, the same fixture measured full projection 24.790 ms and cached projection 0.713 ms (34.8x faster), with apply 6.161 ms, attach 2.723 ms, and encode 5.290 ms. Their 14.887 ms steady-pass sum is below the 20 ms target.

---

## Native-response roll-forward incident (r4 follow-up)

(absorbed from the 2026-08-16 roll-forward doc)

### Incident evidence

A module bounce did not clear the failure. ENGRAM served a frontier-less full response at
13:29:24, then the immediately following warm request sent a two-message tail delta and failed at
13:29:59 because the adapter received neither native response field. That sequence rules out cold
module state and ordinary LRU eviction as the trigger: the failing request followed a successful
full prime by one pass.

### Source diagnosis

The adapter fingerprint is an ingress identity, not a digest of the transformed output. It combines
the adapter's CK and native ingress fingerprints, sends the value as `full_array_fingerprint`, and
uses the same opaque value as the next `tail_delta.after`. The module does not recompute that value
from pre- or post-reasoning-clear bytes; its transform snapshot, projection cache, and native
attachment cache retain the adapter-supplied string. A pre/post-splice fingerprint-vocabulary change
therefore cannot explain the mismatch at this revision.

The r4 native attachment path did contain a real fingerprint-fence defect. A mismatched attachment
snapshot made `validated_native_prefix` return zero, but the independent encoded-message key scan
could still report a reusable output prefix. The response arm then emitted a native suffix despite
the cache fingerprint mismatch. The regression test reproduces that behavior on the pre-fix code.
The roll-forward now permits a suffix only when cache state, fingerprint, context, and frontier are
all valid. Every other case retains the already-built full native output and logs
`native_delta_fallback_reason=<reason>`.

At source HEAD, native-cache eviction by itself already rebuilt a full attachment when a retained
request could reconstruct ingress, or returned `need_full_sync` before transform when it could not.
Serialized-output cache hits and degraded native stores also did not remove native response fields.
The production observation of an `ok` response with both fields absent was therefore not explained
by the reachable handler branches at HEAD; stale daemon code or an adapter/response-shape skew
remained plausible. A final release-path guard now full-serializes whenever a successful
`serve_native` response reaches the response seam without either native field. The adapter also
retries once with complete arrays if it receives that invalid shape, preventing a warm suffix miss
from becoming a cross-pass outage.

### Memory and latency

The serialized-output, native-attachment, and projection caches remain independent because misses
have different safe recovery paths. Their 256 MiB ceilings now have an explicit 768 MiB aggregate
compile-time bound. Evicting one does not make another authoritative: missing native/projection data
must reconstruct from the ready snapshot or request a full sync.

No retry-until-deadline loop exists in the module's native response arm. The module timing line
separates `request_observed_to_handler`, `delta_expand`, projection lookup/store, `native_attach`,
retained-size/snapshot work, and response encode/splice. The adapter separately reports transport
pages and elapsed transport time. The observed 11.5-second failed pass, together with fresh
connection churn and a 2.5-second successful full pass, is consistent with transport/recovery cost
rather than cache eviction thrash; the incident logs needed to assign that time to a precise module
stage were not retained in this worktree. The one-shot adapter full retry fixes availability but does
not claim that latency as a module-cache optimization.

The concurrent `lkg_anthropic_reasoning_run_invalid` refusal is correct fail-closed behavior:
replaying an LKG with an invalid Anthropic reasoning run could send an illegal signed-thinking
sequence to the provider. It explains why LKG armor could not mask this incident, but should not be
loosened to hide native-response failures.
