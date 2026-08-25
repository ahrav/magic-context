# mc-host shared-memory transport

## Status

Shared memory is explicit, test-only, and non-default. Host and client production registries are empty. No backend or target profile has qualified on a designated host, so no shared-memory provider ships. TCP remains the production transport.

Current Linux integration uses profile `mc-host-test-ring-v1` only when tests inject `ShmProvider` and `createExplicitShmTestProvider`. This control proves negotiation and lifecycle behavior. It is not selectable evidence: host receive calls `lease.to_vec()` and records one transport-body copy before semantic dispatch. It must not support a zero-copy or hardware-limited claim.

## Architecture

Authenticated TCP bootstraps negotiation. Side-effect-free preflight checks exact provider identity `("shm", 1)`, immutable profile fields, runtime capability, and process-wide admission. Preparation creates two ordered directions and returns an opaque grant. Attachment validates the exact objects and profile before activation. Correlations 1 and 2 activate and commit the new channel; application traffic starts at correlation 3.

Each direction has a bounded descriptor ring and payload arena. A direct producer reserves bounded spans, fills through a cursor, detaches producer aliases, and commits the exact length. One descriptor carries the wire-v2 header, span metadata, incarnation, lane, and `u64` sequence. A receiver snapshots and validates descriptor metadata, then holds shared spans through a scoped Rust lease or explicit JavaScript lease.

## Zero-copy ownership contract

A selectable profile must satisfy all of these rules:

- Shared arena bytes are canonical transport storage. Direct producers write them once.
- Underfill, overflow, partial serialization, or a commit outside the reservation publishes nothing.
- Rust decodes transport bytes synchronously while its lease is live. Only owned semantic state may cross into async work.
- JavaScript sees one exact-bounds external `ArrayBuffer` per segment. Producer aliases detach before publication. Receive aliases detach and verify before storage recycle.
- Release identity includes incarnation, lane, and sequence. Stale and duplicate release fails.
- Descriptor, arena, and lease exhaustion backpressure only until the request deadline. Ownership never switches to copying after admission.
- Owned-buffer adapters count their copies separately and are never zero-copy evidence.

Current native and TypeScript mechanism tests exercise this contract. They do not qualify hardware performance. Current host integration control has one accounted receive copy and remains non-selectable.

## Runtime capability probe

`probeCapabilities()` advertises capability only on Linux and only when every step succeeds:

1. Load package-relative `mc_shm_native.node` built from source.
2. Read N-API version and require version 8 or newer.
3. Create a 31-byte external `Uint8Array`.
4. Require offset 0, view length 31, and backing `ArrayBuffer.byteLength` 31.
5. Create `subarray`, `DataView`, and `Buffer` aliases.
6. Mark backing untransferable, require `structuredClone(..., { transfer: [...] })` to throw, and require backing length to remain 31.
7. Detach backing through N-API and require every alias to become unusable.
8. Require async cleanup-hook support.

Any failure returns `available: false` with a bounded reason. It does not substitute a copy. On unsupported platforms the platform check runs before addon loading. CI then checks that active native channel count stays zero. Tests also create and close a pair when capability is advertised, proving advertised capability activates.

## Resource charges

Explicit test profile charges both directions before activation:

| Resource | Charge |
| --- | ---: |
| descriptors | 16 total, 8 per direction |
| arena bytes | 134,217,728 total, 64 MiB per direction |
| receive leases | 16 total, 8 per direction |
| mappings | 2 |
| spans per frame | at most 2 |
| pinned workers | 0 |

Host implementation also starts one fused, unpinned owner thread per prepared candidate. Admission accounts active and quarantined descriptor, arena, lease, mapping, and pinned-worker commitments. Quarantine retains charges instead of making uncertain storage reusable.

## Failure, fallback, and close

TCP fallback is valid only during offer filtering, before provider preparation. After preparation starts, setup timeout, malformed data, peer loss, publication failure, cleanup uncertainty, or quarantine closes the connection without TCP replay.

Close stops admission, drains published data, revokes JavaScript aliases on the environment thread, waits for Rust scopes, releases samples, drops transport objects, and joins workers. Duplicate close is harmless. Unknown alias state quarantines storage, rejects successful close, and keeps its host charge.

Diagnostics redact descriptors, activation tokens, object names, grants, incarnations, mapped addresses, and provider-owned errors.

## Trusted-peer boundary

Owner-only attachment establishes same-user authentication. R19 still trusts peer and in-process consumer to honor lane ownership, no-transfer, no resizing, and post-publication immutability. Zero-copy guarantees lifetime and ownership discipline. It does not protect against a malicious authenticated peer mutating mapped payload after publication, and tests or docs must not claim such immutability.

## Platform status

- **Linux:** ring host/addon/native and TypeScript lifetime tests run locally. Provider remains explicit and non-selectable. iceoryx2 `0.9.3` is a source-built candidate, not a selected backend.
- **macOS:** transport crate contains a file-backed fixed-size ring primitive, but current host grant and native attachment paths intentionally omit ring capability. CI must prove clean omission. No local macOS runtime or hardware campaign has run.
- **Bun:** native mechanism and lease propagation activate on Linux. This is correctness evidence only.
- **Node 24:** the addon source-builds and loads, but hosted Node aborts inside `napi_detach_arraybuffer`. Preflight therefore omits shared memory before creating an external alias. It never falls back to copying.

Hosted Ubuntu and macOS CI compile source and run correctness gates. Hosted CI never applies hardware thresholds and never uploads `.node` files.
