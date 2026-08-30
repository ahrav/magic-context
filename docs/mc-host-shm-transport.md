# mc-host shared-memory transport

## Status

Shared memory is the only transport. The fixed ring is mandatory: there is no negotiation, no provider registry, and no TCP path to fall back to. A client that cannot attach a ring cannot reach the host.

Linux and macOS integration uses profile `mc-host-test-ring-v1`, exposed as `MC_HOST_RING_PROFILE`. Host receive still calls `lease.to_vec()` and records one transport-body copy before semantic dispatch, so this path must not support a zero-copy claim.

## Architecture

An authenticated Unix stream socket bootstraps the ring. The host publishes its absolute path as `setup_socket` in the connection file; the client dials it, proves identity over the shared HMAC construction, and receives the two ring descriptors over `SCM_RIGHTS`. Preparation creates two ordered directions and returns an opaque grant. Attachment validates the exact objects and profile before activation. Correlations 1 and 2 activate and commit the new channel; application traffic starts at correlation 3.

Because descriptors cross the boundary as file descriptors, the setup socket cannot be proxied by a byte forwarder; any container or remote topology has to make the socket itself reachable.

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

## Recovery contract

This section documents the implemented behavior of `crates/mc-host/src/provider_recovery.rs`, `crates/mc-host/src/shm_provider.rs`, and the client recovery loop in `packages/plugin/src/shared/mc-host-client/client.ts` (R16). Wire-level fallback semantics are normative in `docs/mc-host-wire-protocol.md` §7.7.3.

### Typed `unavailable`

Preflight returns a typed, side-effect-free eligibility result: `Serveable`, `StaticallyOmitted`, or `DynamicallyUnavailable`. Only `DynamicallyUnavailable` — provider readiness `Recovering`/`Quarantined` or admission pressure on an installed, statically eligible provider — produces the wire fallback reason `unavailable`. Permanent absence and static ineligibility (wrong platform, wrong offer parameters) select TCP with no reason and never authorize a recovery probe.

### Readiness and candidate custody

A provider exposes three readiness states: `Recovering`, `Ready`, and `Quarantined`. Readiness is a pure state read that governs new offers only; a readiness change never invalidates an existing committed candidate or the observer's route. Preflight offers shared memory only in `Ready` and performs no cleanup, no probe, and no counter change.

Each prepared candidate's identity, exact admission charges, and cleanup authority live in one provider-private custody record from admission until release or quarantine. Release returns every active charge exactly once; repeated or stale releases (including releases carrying an old provider incarnation) are rejected without touching aggregate counters. Quarantine retains the exact charges and permanently prevents that record's storage from being reused.

### Recovery execution

One bounded controller per provider drives suspect records through a deduplicated inbox (bound 8; overflow isolates the incoming record directly). At most one cleanup call is in flight per provider, on a detached OS thread — never a Tokio request worker and never the provider preparation worker. Each episode has one immutable 30-second deadline fixed at episode start: retry delay, repeated stale observations, and late results never extend it. A cleanup call that never returns suppresses further dispatch, is never joined during bounded shutdown, and cannot publish a late result unless both its episode and the provider incarnation still match.

### Clean reclamation versus quarantine exhaustion

These are distinct outcomes and distinct test experiments:

- **Clean reclamation:** cleanup proves the stale resources are gone, the record's active charges return exactly once, a new provider incarnation is minted (fencing stale releases and stale results), and readiness returns to `Ready` only when a non-destructive probe succeeds and another retained profile still fits the frozen host limits.
- **Quarantine:** an uncertain outcome, or a stale-retry still pending at the deadline, isolates the candidate with its exact charges. Provider-wide uncertainty (failed probe) or admission-cap exhaustion sets readiness `Quarantined`: terminal for new offers, charges stay visible, later suspects are isolated directly with no new episode or cleanup call, and no further provider resource is created.

### Fresh-generation re-upgrade and drain

A client that committed TCP with exact reason `unavailable` starts one client-wide recovery episode with one deadline (default 30 seconds) created once and never reset by any retry. Each attempt runs full fresh discovery, dial, authentication, negotiation, and — on a grant — activation and commit. Only discovery/dial transients and repeated exact `unavailable` selections retry; any other fallback reason, reasonless TCP, malformed negotiation, authentication, attachment, activation, commit, or protocol failure stops the episode permanently.

Publication is source-fenced: the shadow commit becomes primary only while the exact source TCP generation is still primary and the single draining-predecessor slot is free; otherwise the candidate retires. After promotion only new managed work routes through shared memory. Pending requests and raw route handles stay bound to the old TCP generation until they settle or close — an `outcome_unknown` result surfaces once and is never replayed — and the predecessor retires only at pending-zero with no live route handles. Primary, predecessor, and shadow consume at most three authenticated connection permits; every failed or cancelled shadow releases its permit. Owner close cancels shadow publication first, then closes primary and predecessor under one bounded shutdown deadline.

### Daemon restart

A daemon restart retires the client's old generation with its existing outcome classification (no replay). The client reconnects through fresh discovery and authentication. If the restarted daemon selects TCP with exact `unavailable` — for example while its provider is still `Recovering` — the client serves over TCP and re-upgrades through a fresh shared-memory generation exactly as above, moving only later managed calls.

### Kill-and-reap boundary

The crash harness kills a victim with `SIGKILL`, requires signal-9 wait status, and starts its bounded post-reap observation window (20 seconds) only after the child is reaped. A deliberately held zombie has no observation window. The harness window is observation-only: the provider's 30-second episode deadline and the client's recovery deadline are independent and are never restarted or extended by kill, reap, or harness timing.

### Dead-peer reclamation gap (ring backend)

Shared-memory peer death is silent for the ring endpoint: a peer that dies without sending `Goodbye` produces no readable close and never becomes a suspect, so its candidate's exact admission charges stay `active` until the daemon itself closes. The clean soak cycles in `shm_soak.rs` therefore prove clean-close charge conservation plus crash-side OS hygiene — not dead-peer charge reclamation, which remains a provider gap pending the frozen retained-tuple manifest (`magic-context-ymc.12`). The gap is pinned exactly by `killed_victim_holding_active_charges_is_never_reclaimed` in `crates/mc-host/tests/shm_failure_modes.rs`; the reachable unclean-close suspect path (a live peer publishing a structurally invalid frame) is driven by `corrupt_peer_frame_quarantines_exact_charges_and_returns_ready` in the same file.

### Operator-visible failure limits

Admission accounting exposes redacted aggregate `active` and `quarantined` charges (descriptors, arena bytes, leases, mappings, pinned workers) alongside provider readiness. Active and quarantine caps are frozen per profile; quarantine retains charges against its cap instead of returning storage, and cap exhaustion stops shared-memory offers (readiness `Quarantined`) while TCP service continues. Diagnostics and errors carry state names and counts only — never descriptors, grants, tokens, object names, addresses, or provider text.

## Trusted-peer boundary

Owner-only attachment establishes same-user authentication. R19 still trusts peer and in-process consumer to honor lane ownership, no-transfer, no resizing, and post-publication immutability. Zero-copy guarantees lifetime and ownership discipline. It does not protect against a malicious authenticated peer mutating mapped payload after publication, and tests or docs must not claim such immutability.

## Platform status

- **Linux:** ring host/addon/native and TypeScript lifetime tests run locally. Provider remains explicit and non-selectable. iceoryx2 `0.9.3` is a source-built candidate, not a selected backend.
- **macOS:** transport crate contains a file-backed fixed-size ring candidate, but hosted `Ring::create` currently returns `ObjectSetupFailed`. Host and native preflight therefore omit ring capability. CI source-builds all components and proves clean omission; no macOS hardware campaign has run.
- **Bun:** native mechanism and lease propagation activate on Linux. This is correctness evidence only.
- **Node 24:** the addon source-builds and loads, but hosted Node aborts inside `napi_detach_arraybuffer`. Preflight therefore omits shared memory before creating an external alias. It never falls back to copying.

Hosted Ubuntu and macOS CI compile source and run correctness gates. Hosted CI never applies hardware thresholds and never uploads `.node` files.
