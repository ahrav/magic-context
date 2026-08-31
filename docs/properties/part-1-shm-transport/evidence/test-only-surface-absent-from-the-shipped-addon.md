# test-only-surface-absent-from-the-shipped-addon

> Refresh note, 2026-08-31: PR #131 (merge `5d638e3e8`) changed two facts this
> record relies on. First, the export inventory grew: `lib.rs` now carries 26
> `#[napi]` attributes, adding `build_profile` (`:459`), `build_target`
> (`:468`), `connect_setup` (`:765`), `finish_setup` (`:776`), `watch` (`:1109`,
> the eventfd reactor registration), `readiness_handled` (`:1135`), and
> `peer_closed` (`:1291`); the inventory below covers only the pre-#131 set and
> needs re-derivation. Second, the debug-build finding is obsolete: the package
> now builds with `cargo build --release` and copies from `target/release/`
> (`package.json:16`), and exposes a `build_profile` probe (`lib.rs:459-465`).
> The core claim — the six named test-only exports ship unconditionally and are
> re-exported through `index.ts` — was re-verified at HEAD. Table line numbers
> below were re-anchored to HEAD.

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
| 34 | `NativeTestPair` (object) | test-pair result type |
| 447 | `napi_version` | probe support |
| 473 | `create_external_probe` | **test-only**: allocates an owned probe buffer |
| 478 | `detach_array_buffer` | **test-only**: detaches an arbitrary `ArrayBuffer` |
| 483 | `register_cleanup_probe` | **test-only**: arbitrary-path cleanup marker |
| 488 | `native_leak_diagnostics` | diagnostic counter |
| 493 | `active_external_ref_count` | diagnostic counter |
| 498 | `set_external_view_failpoint` | **test-only**: fault injector |
| 503 | `worker_limit` | constant read |
| 508 | `active_channel_count` | diagnostic counter |
| 522 | `attach` | transport |
| 794 | `create_test_pair` | **test-only**: constructs a duplex pair |
| 859 | `produce` | transport |
| 937 | `reserve` | transport |
| 1017 | `commit_reservation` | transport |
| 1051 | `abort_reservation` | transport |
| 1160 | `poll` | transport |
| 1269 | `release` | transport |
| 1308 | `close` | transport |
| 1335 | `force_close` | **test-only**: forced quarantine close |

All six surfaces the catalog names are present and confirmed at those lines
(re-anchored to post-#131 HEAD, 2026-08-31).

Three diagnostic counters the catalog does not name — `native_leak_diagnostics`,
`active_external_ref_count`, `active_channel_count` — are also unconditionally
exported. They leak internal accounting rather than granting a capability, so
they are a lesser concern, but they belong in an export inventory.

### Absence of build-time gating

Every `cfg` attribute in the file is a platform predicate except two additions
from #131: the in-file unit-test module behind `#[cfg(test)]` at `:1065` and
the runtime `cfg!(debug_assertions)` inside `build_profile` at `:460`, neither
of which gates an export. There is still **no** `cfg(test)`,
`cfg(feature = ...)`, or `cfg(debug_assertions)` attribute on any export.
Nothing in the build can remove any export.

The same shape appears in the transport crate:
`crates/mc-shm-transport/src/lib.rs:8` is `pub mod harness;`, the fuzz decoder
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
  (`napi_buffers.rs:220-222`) that makes the *n*th subsequent
  `create_external_view` fail (`napi_buffers.rs:65-81`). That reaches
  `cleanup_created_refs` from `produce` (lib.rs:907, 914), `reserve` (983), and
  `poll` (875). `cleanup_created_refs` (248-269) quarantines only if the
  follow-on `detach_all` (259) or `delete_all` (266) also fails, so the failpoint
  alone does not quarantine.
- `detach_array_buffer` (427) calls `napi_buffers::detach_value`
  (`napi_buffers.rs:268-283`), which performs no ownership check: the raw value
  goes straight to `napi_detach_arraybuffer`, and the runtime validates only that
  it is an `ArrayBuffer`. Any detachable buffer in the process can be detached,
  including buffers the addon never created.
- `register_cleanup_probe` (432) forwards a caller-supplied `String` as a
  `PathBuf` to `lifecycle::register_cleanup_marker`. The path is written at
  environment teardown; `tests/mechanism.ts:60` reads the marker back and asserts
  its contents are `"clean"`.

### Debug versus release

Resolved by #131 (verified 2026-08-31): `package.json:16` now builds with
`cargo build --release` and copies the artifact from `target/release/`:

```
"build:native": "test \"$(uname -s)-$(uname -m)\" = Linux-x86_64 && cargo build --release -p mc-shm-native && cp -f ../../target/release/libmc_shm_native.so ./mc_shm_native.node"
```

The pre-#131 finding (a debug-only build with no release script) no longer
holds; a `build_profile` probe (`lib.rs:459-465`) now reports the compiled
profile at runtime.

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

One dependency was worth recording pre-#131: the then-debug-only build
compounded this. That coupling is gone now that the shipped artifact is a
release build; the export surface stands on its own.

## What a test must construct

1. An export inventory taken from the **built artifact**, not the source: load
   `mc_shm_native.node` and enumerate its keys, asserting the set excludes
   `createExternalProbe`, `detachArrayBuffer`, `registerCleanupProbe`,
   `setExternalViewFailpoint`, `createTestPair`, and `forceClose`. This fails
   today, which is the point; it becomes the gate once a gating mechanism exists.
2. The same assertion against `index.ts`'s exported names, since the package
   interface is the reachable surface for consumers.
3. A build-profile assertion: that the copied artifact originates from
   `target/release/` (now true; pin it with the `build_profile` export so a
   regression to a debug artifact fails the suite).
4. A negative control for the inventory itself: add a sentinel export and assert
   the inventory test fails. Without it, an inventory that enumerates nothing
   passes.

## Investigation log

### Q: Is a `cfg`- or feature-gated split intended before this transport becomes selectable, or is the surface considered acceptable because the transport is test-only?

- Sources examined: `packages/mc-shm-native/src/lib.rs` — every `#[napi]`
  attribute and every `cfg` attribute enumerated;
  `packages/mc-shm-native/package.json` in full;
  `packages/mc-shm-native/index.ts:393-525` for the re-export surface;
  `packages/mc-shm-native/src/napi_buffers.rs:52-87`, `:220-222`, `:268-283`;
  `packages/mc-shm-native/src/lib.rs:272-294` and `:352-379`;
  `crates/mc-shm-transport/src/lib.rs:1-17`;
  `packages/mc-shm-native/tests/mechanism.ts:28-50`.
- Findings: no gating mechanism exists to be intended or unintended — the
  package declares no Cargo features and no `cfg` gates any export. (The
  pre-#131 debug-build observation is obsolete: `build:native` now runs
  `cargo build --release` and copies from `target/release/`,
  `package.json:16`.) The
  test-only exports are additionally promoted into the package's declared
  TypeScript interface, which is a stronger position than "reachable if you dig
  for it".
- Missing evidence: nothing in the tree states an intent either way. No feature
  is declared in `Cargo.toml` for this package, no comment marks any export as
  test-only, and no plan document reviewed for this part assigns the split.
- Conclusion: needs human input on intent. Three facts are settled
  independently and do not require that answer: no export carries a `cfg(test)`,
  `cfg(feature = ...)`, or `cfg(debug_assertions)` gate; all six named test-only
  surfaces plus three diagnostic counters are unconditionally exported and
  re-exported through `index.ts`; and the shipped artifact carries the full
  surface regardless of build profile (the artifact is now a release build,
  `package.json:16`). One catalog
  correction: the sentence attributing the both-direction quarantine to the
  external-view failpoint describes `force_close` instead. `force_close`
  quarantines both rings unconditionally at `lib.rs:381-382`; the failpoint only
  reaches the quarantine-capable cleanup path and requires a second failure
  there.
