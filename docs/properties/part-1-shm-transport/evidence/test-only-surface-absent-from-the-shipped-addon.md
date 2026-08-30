# test-only-surface-absent-from-the-shipped-addon

## Discovery trigger

The addon is the trust boundary between JavaScript and shared memory mapped
read-write by both roles. Any name it exports is callable by any JavaScript in
the host process. The exported surface was therefore enumerated in full and
checked for build-time gating.

## Evidence trail

### Exported N-API surface

`packages/mc-shm-native/src/lib.rs` carries 19 `#[napi]` functions and one
`#[napi(object)]` type. In source order:

| Line | Export | Character |
| --- | --- | --- |
| 39 | `NativeTestPair` (object) | test-pair result type |
| 410 | `napi_version` | probe support |
| 422 | `create_external_probe` | **test-only**: allocates an owned probe buffer |
| 427 | `detach_array_buffer` | **test-only**: detaches an arbitrary `ArrayBuffer` |
| 432 | `register_cleanup_probe` | **test-only**: arbitrary-path cleanup marker |
| 437 | `native_leak_diagnostics` | diagnostic counter |
| 442 | `active_external_ref_count` | diagnostic counter |
| 447 | `set_external_view_failpoint` | **test-only**: fault injector |
| 452 | `worker_limit` | constant read |
| 457 | `active_channel_count` | diagnostic counter |
| 471 | `attach` | transport |
| 553 | `create_test_pair` | **test-only**: constructs a duplex pair |
| 628 | `produce` | transport |
| 706 | `reserve` | transport |
| 784 | `commit_reservation` | transport |
| 818 | `abort_reservation` | transport |
| 833 | `poll` | transport |
| 920 | `release` | transport |
| 934 | `close` | transport |
| 958 | `force_close` | **test-only**: forced quarantine close |

All six surfaces the catalog names are present and confirmed at those lines. The
catalog's `409-454` range covers `napi_version` through `worker_limit` but stops
before `active_channel_count` at 457; `:553` and `:958` are exact.

Three diagnostic counters the catalog does not name — `native_leak_diagnostics`,
`active_external_ref_count`, `active_channel_count` — are also unconditionally
exported. They leak internal accounting rather than granting a capability, so
they are a lesser concern, but they belong in an export inventory.

### Absence of build-time gating

Every `cfg` attribute in the file is a platform predicate. The complete set, by
line: 9, 11, 17, 20, 23, 31, 88, 116, 119, 215, 237, 364, 375, 398, 472, 479,
554, 561 — each one `cfg(target_os = "linux")` or
`cfg(not(target_os = "linux"))`. There is **no** `cfg(test)`,
`cfg(feature = ...)`, or `cfg(debug_assertions)` anywhere in the file. Nothing in
the build can remove any export.

The same shape appears in the transport crate:
`crates/mc-shm-transport/src/lib.rs:16` is `pub mod harness;`, the fuzz decoder
entry points, exported from the library with no gate.

### The surface reaches JavaScript as declared package API

`packages/mc-shm-native/package.json` sets `"main": "index.ts"`,
`"types": "index.ts"`, and `"exports": { ".": "./index.ts" }`. `index.ts`
re-exports the test-only surface as public TypeScript: `registerCleanupProbe`
(line 497), `nativeLeakDiagnostics` (504), `activeExternalRefs` (508),
`setExternalViewCreationFailpoint` (512), `activeNativeChannels` (516),
`NativeChannel.createTestPair` (402), and `NativeChannel.forceClose` (486). These
are not merely raw addon symbols reachable by `require`; they are the package's
declared interface.

### What each capability actually permits

- `force_close` (958) calls `quarantine_channel` (348), which calls
  `enter_quarantine()` on `to_host` at line 350 and `from_host` at line 351
  before any detach. One call from JavaScript unconditionally drives **both**
  directions terminal.
- `set_external_view_failpoint` (447) sets a thread-local counter
  (`napi_buffers.rs:223-225`) that makes the *n*th subsequent
  `create_external_view` fail (`napi_buffers.rs:68-84`). That reaches
  `cleanup_created_refs` from `produce` (lib.rs:676, 683), `reserve` (750), and
  `poll` (875). `cleanup_created_refs` (248-269) quarantines only if the
  follow-on `detach_all` (259) or `delete_all` (266) also fails, so the failpoint
  alone does not quarantine.
- `detach_array_buffer` (427) calls `napi_buffers::detach_value`
  (`napi_buffers.rs:271-286`), which performs no ownership check: the raw value
  goes straight to `napi_detach_arraybuffer`, and the runtime validates only that
  it is an `ArrayBuffer`. Any detachable buffer in the process can be detached,
  including buffers the addon never created.
- `register_cleanup_probe` (432) forwards a caller-supplied `String` as a
  `PathBuf` to `lifecycle::register_cleanup_marker`. The path is written at
  environment teardown; `tests/mechanism.ts:60` reads the marker back and asserts
  its contents are `"clean"`.

### Debug versus release

`package.json` has one build script and it is a debug build:

```
"build": "cargo build -p mc-shm-native && cp -f ../../target/debug/libmc_shm_native.$(...) ./mc_shm_native.node"
```

No `--release` flag, and the copy source is `target/debug/`. `"build:source"` is
`bun run build`, the same path. No release build script exists, so the artifact
loaded as `mc_shm_native.node` is always a debug build and release behaviour is
never exercised.

## Failure scenario

Any JavaScript running in the host process — a plugin, a dependency, an injected
script — calls `forceClose(id)`. Both rings enter quarantine, all producer
reservations abort, all active leases detach, and the channel is terminal with
its host charge retained. No authentication, capability, or role check stands in
front of it, because the export is unconditional and `index.ts` publishes it.

The `detachArrayBuffer` variant is broader: it detaches any `ArrayBuffer` in the
process, so the damage is not confined to the transport.

## Timing windows and dependencies

None. The surface is present from the moment the addon loads, and every capability
is a single synchronous call. There is no window to narrow and no interleaving to
construct.

One dependency is worth recording: the debug-build finding compounds this. Any
behaviour that differs between profiles — `debug_assert!` firing, overflow
checks, different inlining around the `unsafe` blocks — is exercised only in the
configuration that ships, and the release configuration is untested. That is a
separate gap from the export surface but shares the same root, which is that
there is no build-profile distinction anywhere in this package.

## What a test must construct

1. An export inventory taken from the **built artifact**, not the source: load
   `mc_shm_native.node` and enumerate its keys, asserting the set excludes
   `createExternalProbe`, `detachArrayBuffer`, `registerCleanupProbe`,
   `setExternalViewFailpoint`, `createTestPair`, and `forceClose`. This fails
   today, which is the point; it becomes the gate once a gating mechanism exists.
2. The same assertion against `index.ts`'s exported names, since the package
   interface is the reachable surface for consumers.
3. A build-profile assertion: that the copied artifact originates from
   `target/release/`, or that a release artifact exists and passes the same test
   suite as the debug one.
4. A negative control for the inventory itself: add a sentinel export and assert
   the inventory test fails. Without it, an inventory that enumerates nothing
   passes.

## Investigation log

### Q: Is a `cfg`- or feature-gated split intended before this transport becomes selectable, or is the surface considered acceptable because the transport is test-only?

- Sources examined: `packages/mc-shm-native/src/lib.rs` — every `#[napi]`
  attribute and every `cfg` attribute enumerated;
  `packages/mc-shm-native/package.json` in full;
  `packages/mc-shm-native/index.ts:386-518` for the re-export surface;
  `packages/mc-shm-native/src/napi_buffers.rs:55-90`, `:223-225`, `:271-286`;
  `packages/mc-shm-native/src/lib.rs:248-269` and `:334-360`;
  `crates/mc-shm-transport/src/lib.rs:1-26`;
  `packages/mc-shm-native/tests/mechanism.ts:38-60`.
- Findings: no gating mechanism exists to be intended or unintended — the
  package declares no Cargo features and the source contains no non-platform
  `cfg`. The build produces exactly one artifact, from `target/debug/`. The
  test-only exports are additionally promoted into the package's declared
  TypeScript interface, which is a stronger position than "reachable if you dig
  for it".
- Missing evidence: nothing in the tree states an intent either way. No feature
  is declared in `Cargo.toml` for this package, no comment marks any export as
  test-only, and no plan document reviewed for this part assigns the split.
- Conclusion: needs human input on intent. Three facts are settled
  independently and do not require that answer: the file contains no `cfg(test)`,
  `cfg(feature = ...)`, or `cfg(debug_assertions)` gate; all six named test-only
  surfaces plus three diagnostic counters are unconditionally exported and
  re-exported through `index.ts`; and the shipped artifact is copied from
  `target/debug/`, with no release build script in the package. One catalog
  correction: the sentence attributing the both-direction quarantine to the
  external-view failpoint describes `force_close` instead. `force_close`
  quarantines both rings unconditionally at `lib.rs:350-351`; the failpoint only
  reaches the quarantine-capable cleanup path and requires a second failure
  there.
