# no-rust-reference-over-peer-writable-payload

## Discovery trigger

`crates/mc-shm-transport/src/lease.rs` reads arena bytes three ways in one file,
and one of them differs from the other two. `read_byte` uses `read_volatile`,
`copy_to` uses `copy_nonoverlapping`, and `checksum` builds a `&[u8]` with
`std::slice::from_raw_parts`. The file's own doc comment on `ReceiveLease`
(`:88-89`) states the intent: "Raw span access avoids creating a long-lived safe
reference to memory a trusted peer could still address." `checksum` creates one.

## Evidence trail

- `crates/mc-shm-transport/src/lease.rs:69-75` — `checksum`. Line 71 is
  `let bytes = unsafe { std::slice::from_raw_parts(self.base.as_ptr(), self.len)
  };`, then a fold over `bytes.iter()`. The slice is live across the whole fold.
- `crates/mc-shm-transport/src/lease.rs:70` — the SAFETY comment justifies it
  with "R19 forbids peer writes before release", a contract term, not a
  mechanism.
- `docs/mc-host-shm-transport.md:116` — the contract term the comment leans on,
  in full: "It does not protect against a malicious authenticated peer mutating
  mapped payload after publication, and tests or docs must not claim such
  immutability." The premise cited at `lease.rs:70` is the premise the document
  declines to guarantee.
- `crates/mc-shm-transport/src/lease.rs:57-66` — `copy_to` uses
  `copy_nonoverlapping` (`:62-64`) with the same SAFETY reasoning, but no Rust
  reference is created, so a concurrent peer write is a torn value rather than
  undefined behaviour.
- `crates/mc-shm-transport/src/lease.rs:48-54` — `read_byte` uses `read_volatile`
  at `:53`. Same property.
- `crates/mc-shm-transport/src/lease.rs:178-196` — `to_vec`, the path the host
  actually uses, is built entirely on `copy_to`, so the aggregate body read is
  sound by the same argument.
- `crates/mc-shm-transport/src/lease.rs:38-40` — `pub const fn as_mut_ptr(self)
  -> *mut u8` on a `Copy` receiver. It hands out a mutable pointer from a
  by-value `self`, so nothing in the type system limits how many live mutable
  pointers exist for one span.
- `crates/mc-shm-transport/src/lib.rs:26` — `pub use lease::{LeaseSpan,
  ReceiveLease};`. Both the slice-building method and `as_mut_ptr` are crate
  public API, not internal helpers.
- `packages/mc-shm-native/src/lib.rs:986-989` — the receive path calls
  `lease.segment(index)` then `napi_buffers::create_external_view(env,
  span.as_mut_ptr(), span.len())`.
- `packages/mc-shm-native/src/napi_buffers.rs:63-100` — that helper calls
  `napi_create_external_arraybuffer` over the raw pointer. The result is an
  ordinary writable ArrayBuffer; nothing marks it read-only.
- `packages/mc-shm-native/src/lib.rs:741` and `:817` — the same helper on the two
  produce paths, where a writable view is intended.

## Failure scenario

Two distinct exposures share one root.

The Rust one: any caller of `LeaseSpan::checksum` while the peer writes the same
bytes has a data race between a Rust shared reference and a foreign write. That
is undefined behaviour under Rust's aliasing model, not a wrong checksum. The
compiler is entitled to assume the slice is immutable for the fold's duration and
may hoist, split, or vectorize the loads accordingly.

The JavaScript one: the receive path exposes leased arena bytes as a writable
external ArrayBuffer. While the host is inside `to_vec`, JavaScript holding that
view can write the same range. `to_vec` uses `copy_nonoverlapping`, so this is a
torn body rather than undefined behaviour, but the descriptor the body was
validated against was read earlier, so a body can disagree with its own validated
length and wire header.

## Timing windows and dependencies

The `checksum` window is the duration of one fold over `len` bytes, up to
`MAX_FRAME_BYTES` (64 MiB), so it is wide. The JavaScript window spans from view
creation until the view is detached. Both windows are only reachable because
`Mapping::create` and `Mapping::attach` map the whole object
`PROT_READ | PROT_WRITE` (`ring.rs:227`, `:249`) and the required seals are
`F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL` with no `F_SEAL_WRITE`
(`ring.rs:1704`). This is the same root decision behind
`quarantine-authority-survives-peer-writes` and
`reclaim-advance-bounded-by-the-producer-reservation`.

## What a test must construct

The audit form needs no fault: enumerate every method on `LeaseSpan` and
`ReceiveLease` that touches arena bytes and assert each uses `read_volatile` or
`copy_nonoverlapping`. That is a source-level or review-level check, and it fails
today at `lease.rs:71`.

The impact demonstration needs a peer that writes leased bytes concurrently,
which is fault class F2 and does not exist. Under Miri or ThreadSanitizer the
`checksum` race would be reportable, and neither tool is configured anywhere in
the repository. A cheaper intermediate: run `checksum` against a span while a
second thread writes it, under `-Zsanitizer=thread`.

## Investigation log

### Q: Is `checksum` reachable from any non-bench caller? If it is bench-only, gating it removes the finding; if it is part of the intended read API, the slice needs to go.

- Sources examined: `grep -rn "checksum" crates/mc-shm-transport/` and
  `packages/mc-shm-native/`; `grep -rn "\.checksum()" crates/ packages/`
  excluding `node_modules`, `dist`, and `target`;
  `crates/mc-shm-transport/src/lib.rs` for the export surface.
- Findings: exactly one call site exists in the entire tree —
  `crates/mc-shm-transport/benches/hardware_envelope.rs:406`,
  `black_box(span.checksum())`. There are no callers in
  `crates/mc-shm-transport/src`, no callers in any `tests/` directory, no callers
  in `packages/mc-shm-native`, and no callers in any other crate. The other
  `checksum` matches in the repository are unrelated: evidence-manifest sidecar
  hashing in `crates/mc-host/benches/support/evidence.rs`, authority seed
  checksums in `crates/mc-module`, and store columns in `crates/mc-store`. The
  method is nonetheless `pub` on a type re-exported at `lib.rs:26`, so it is part
  of the crate's public API and a downstream caller is admissible today.
- Missing evidence: none for reachability. The catalog's parenthetical "the only
  observed call sites are the bench and tests" overstates it — there is no test
  caller.
- Conclusion: resolved with answer. The finding is **gated, not live**: no
  non-bench, non-test caller exists at `9c1eb4d1`, and in fact no test caller
  exists either. It is not dead, because the method is public API. The record
  stays active as an audit-form property, with severity reduced from "a production
  read path is unsound" to "a public API method invites an unsound read, and one
  benchmark takes it". The sibling finding about `as_mut_ptr` and the writable
  receive-path ArrayBuffer is independent of this answer and is live.
