# attach-binds-geometry-to-a-local-profile

## Citation refresh, 2026-08-30

The ring-transport refactor (`0f336d3c`, `d8bde128`, `793a973e`, `ed487e11`)
renamed `crates/mc-host/src/shm_provider.rs` to
`crates/mc-host/src/ring_transport.rs` and deleted `provider_recovery.rs`,
`transport_negotiation.rs`, and `transport_provider.rs`. Host-side citations below
were re-anchored against `ring_transport.rs` at `e447c927`.

Where the cited construct survives, the citation names `ring_transport.rs` and a
line re-verified against that commit. Where it does not, the original reference is
kept and prefixed `former`, so it reads as pre-refactor evidence rather than a
current location. A `former` line number is never a claim about the tree today.
Every `provider_recovery.rs` reference is `former` by definition: that module has
no successor. See the refresh note in [../catalog.md](../catalog.md).

## Discovery trigger

`Ring::create_in` takes a `&TargetProfile` and derives the layout from it.
`Ring::attach` takes no profile at all. Admission charges a profile's geometry
before a candidate is prepared, so the attaching side charges for one geometry and
maps whatever the grant declares, with no step that compares the two.

## Evidence trail

- `crates/mc-shm-transport/src/backend/ring.rs:593-611` — `Ring::attach(fd:
  OwnedFd, grant: RingGrant, scheduling: SchedulingMode)`. Three parameters, none
  of them a profile. The whole body is: `grant.checked_layout()` (`:598`),
  `Mapping::attach` (`:600`), `validate_lifecycle` (`:601`), `prefault_read`
  (`:602`).
- `crates/mc-shm-transport/src/backend/ring.rs:544-558` — the contrast.
  `Ring::create_in` rejects a profile whose backend, memory layout, or `max_spans`
  disagrees (`:552-557`) before deriving `Layout::new(profile.descriptor_depth(),
  profile.arena_bytes())` (`:558`). All of that is skipped on attach.
- `crates/mc-shm-transport/src/backend/ring.rs:465-482` — `checked_layout`, the
  only bound on attach geometry. It rejects `layout_version != LAYOUT_VERSION`,
  `descriptor_depth == 0`, `arena_bytes < MAX_FRAME_BYTES`, `max_leases == 0`,
  and `max_leases > descriptor_depth` (`:466-473`), then requires `layout.total ==
  total` (`:478-480`). Depth has a floor of 1 and no ceiling; the only thing
  stopping a huge depth is that the resulting `total` must be arithmetically
  consistent, and `Layout::new` returns `ArithmeticOverflow` only at `usize`
  overflow.
- `crates/mc-shm-transport/src/backend/ring.rs:1637-1668` — `validate_lifecycle`.
  It compares the mapped lifecycle page against the *grant*: magic, layout
  version, depth, arena bytes, max leases, total bytes, incarnation, and lane
  (`:1656-1666`). Every comparison is grant-versus-mapping. None is
  profile-versus-grant, so a self-consistent object plus a matching grant passes
  regardless of what the local profile charged.
- `crates/mc-shm-transport/src/backend/ring.rs:599-600` — the mapping size comes
  straight from `grant.total_bytes`, so the grant chooses the `mmap` length.
- Every `Ring::attach` call site in the tree passes `(fd, grant, scheduling)` and
  no profile: `ring.rs:508` (`RingAttachment::attach`),
  `packages/mc-shm-native/src/lib.rs:244` (the addon's `attach_ring`),
  former `crates/mc-host/src/shm_provider.rs:787` (the Rust test peer's `attach_ring`),
  and `crates/mc-shm-transport/tests/ring.rs:437`, `:464`, `:615`.
- `packages/mc-shm-native/src/lib.rs:491-494` — the addon does check a profile,
  but only as a string: `profile != PROFILE` rejects. `PROFILE` is
  `"mc-host-test-ring-v1"` (`:32`). A name match is not a geometry match.
- `crates/mc-host/src/ring_transport.rs:822-827` —
  `qualified_test_profile_pins_client_grant_geometry` asserts
  `descriptor_depth() == 8`, `max_leases() == 8`, and `arena_bytes() ==
  MIN_ARENA_BYTES`. This pins the host's own profile object, on the creating side.
- `packages/plugin/src/shared/mc-host-client/shm-grant.ts:161-171` — the only
  place any attaching side pins geometry, and it is in TypeScript: exact
  `descriptorDepth`, `arenaBytes`, `maxLeases`, and `reserved` (`geometry_mismatch`
  at `:167`), plus `totalBytes` bounded by `MAX_TOTAL_BYTES` (`:170`), which is
  `ARENA_BYTES + 1_048_576n` (`:76`).

## Failure scenario

A grant declares depth 4096 with the arena floor. `checked_layout` accepts it:
depth is nonzero, the arena meets its floor, leases can be set to any value up to
depth, and `total_bytes` can be set to whatever `Layout::new(4096, 67_108_864)`
computes. `validate_lifecycle` accepts it, because the object was initialized from
that same grant. The attaching process maps roughly 1 MiB of extra control region
that its admission charge never accounted for, and the local accounting now
describes an object that was never mapped.

The larger version is the one the TypeScript cap exists for: nothing inside Rust
places a ceiling on depth or total bytes, so a self-consistent grant with a very
large depth reaches `mmap` with only `shm-grant.ts:170` in the way. Any caller
that reaches `Ring::attach` without that wrapper — the addon's own raw boundary,
the Rust test peer, a future non-TypeScript client — has no such ceiling.

## Timing windows and dependencies

No fault and no window. The gap is a missing parameter, so it holds at every
attach. Directly enables `one-profile-name-denotes-one-geometry`: because attach
never checks the profile's geometry, two artifacts can name one profile with two
geometries and nothing detects it. Also enables the geometry half of
`native-boundary-not-weaker-than-its-wrapper`, since the wrapper's
`geometry_mismatch` has no native counterpart.

## What a test must construct

A grant whose geometry differs from the admitted profile's, driven through the
attaching path. Two arms are worth separating. First, agreement: attach with a
correct grant and assert that the mapped depth, arena bytes, and lease cap equal
the local profile's values — this requires the attach API to be told the profile,
so today the test cannot be written without a signature change. Second, a
ceiling: assert `Ring::attach` refuses a self-consistent grant whose depth or
total bytes exceeds a Rust-side bound, which today it does not, so the assertion
fails and pins the gap.

## Investigation log

### Q: none recorded — the catalog lists "Open questions: None".

The record carries no open question. This log records the check that had to be
run before accepting the claim, since a single missed call site would refute it.

- Sources examined: `crates/mc-shm-transport/src/backend/ring.rs:593-611` and
  `:465-482` and `:1637-1668` read in full; every `Ring::attach` and
  `attachment().attach()` call site found by grep across `crates/` and
  `packages/`, excluding `target/`, `node_modules/`, and `dist/`;
  `packages/mc-shm-native/src/lib.rs:240-247` and
  former `crates/mc-host/src/shm_provider.rs:779-788` for the two `attach_ring` wrappers;
  `packages/plugin/src/shared/mc-host-client/shm-grant.ts:146-174` for the
  TypeScript geometry pin.
- Findings: the claim holds. Six call sites, none passing a profile. The two
  `attach_ring` wrappers do carry a `pid` and `fd` and open
  `/proc/{pid}/fd/{fd}`, so they authenticate the object's provenance, but they
  pass the decoded grant straight through. `create_test_pair`
  (`packages/mc-shm-native/src/lib.rs:563-580`) is the one path that does use a
  profile on both sides, and only because it creates both rings locally and
  attaches via `RingAttachment`, so the grant it attaches with was derived from
  that same profile moments earlier.
- Missing evidence: none. The catalog's citations `ring.rs:593` and `:465` both
  resolve, and its statement that `checked_layout` "bounds depth only by `!= 0`
  plus layout arithmetic" is accurate; it omits the related
  `max_leases <= descriptor_depth` constraint at `:470`, which bounds leases
  relative to depth but places no absolute ceiling on either.
- Conclusion: resolved with answer. No attach path anywhere in the tree binds
  grant geometry to a local profile, and the only geometry ceiling in the system
  lives in TypeScript.
