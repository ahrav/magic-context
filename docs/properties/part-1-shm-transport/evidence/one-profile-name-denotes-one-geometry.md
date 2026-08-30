# one-profile-name-denotes-one-geometry

## Discovery trigger

Commit `daf6e244`, "fix(shm): track the ring layout total in the raw descriptor
test grant", is the worked example. Its message records that a hardcoded
`total_bytes` of `arena + 12288` became wrong when the control region grew from
two pages to three, that `RingGrant::decode` recomputed the layout and rejected
the grant, and that only one test noticed because "the other boundary cases
expect a rejection and passed either way". That is a hand-maintained copy of a
derived constant silently weakening a test suite for a day. Searching for other
copies of the same geometry found seven artifacts naming one profile string,
`mc-host-test-ring-v1`, with two different geometries.

## The arithmetic, computed rather than asserted

`Layout::new` (`crates/mc-shm-transport/src/backend/ring.rs:141-185`) is
deterministic in `(depth, arena_bytes)`. The inputs it depends on:
`CACHELINE = 128` and `PAGE_SIZE = 4096` (`:28-29`); `ProducerPage`,
`ConsumerPage`, and `ReclaimPage`, each `#[repr(C, align(128))]` holding two
`AtomicU64` (`:39-55`), so `size_of` is 128 each; and `DescriptorSlot`,
`#[repr(C, align(128))]` holding `AtomicU8`, two `AtomicU64`, and
`UnsafeCell<SharedDescriptor>` (`:109-115`), where `SharedDescriptor` is
`#[repr(C)]` (`:57-71`).

I compiled those exact declarations and evaluated the arithmetic rather than
computing it by hand. Results: `size_of::<SharedDescriptor>() == 120` and
`size_of::<DescriptorSlot>() == 256`.

Substituting into `Layout::new`, with `arena_bytes = 67_108_864` (the
`MIN_ARENA_BYTES == MAX_FRAME_BYTES == 64 MiB` floor,
`crates/mc-shm-transport/src/arena.rs:4-6`), the control-region prefix is
`align_up(128 + 128 + 128, 128) == 384` in both cases, and:

| depth | `slots + slot_bytes` | `arena` offset | `total` | `total - arena_bytes` |
| --- | --- | --- | --- | --- |
| 8 | `384 + 2048 = 2432` | 4,096 (1 page) | 67,117,056 | **8,192** |
| 32 | `384 + 8192 = 8576` | 12,288 (3 pages) | 67,125,248 | **16,384** |

The overhead is the arena's page-aligned offset plus the trailing lifecycle page
(`:172-174`), which is why depth 8 yields two pages and depth 32 yields four.

The TypeScript constant `GRANT_LAYOUT_OVERHEAD_BYTES` in
`packages/mc-shm-native/tests/mechanism.ts:99` is `16_384n`. It is **correct for
depth 32 and wrong for depth 8**, understating nothing and overstating the
depth-8 overhead by 8,192 bytes. It is internally consistent, because the same
file declares `GRANT_DESCRIPTOR_DEPTH = 32n` (`:81`) and
`GRANT_MAX_LEASES = 32n` (`:84`). This also confirms the `daf6e244` story
arithmetically: the old value `12_288` is exactly the depth-32 overhead one page
short, matching "assumed the control region ahead of the arena fit in two pages.
It now needs three."

## Which artifacts agree, and which disagree

Depth 8, overhead 8,192:

- `crates/mc-host/src/shm_provider.rs:91-94` — `qualified_test_profile`:
  `descriptor_depth: DESCRIPTOR_DEPTH` where `DESCRIPTOR_DEPTH = 8` (`:54`),
  `arena_bytes: MIN_ARENA_BYTES`, `max_leases: DESCRIPTOR_DEPTH`.
- `crates/mc-host/src/shm_provider.rs:864-867` — an existing assertion that the
  encoded grant's total equals `(mc_shm_transport::MIN_ARENA_BYTES + 8_192) as
  u64`. Independent confirmation of the depth-8 row above.
- `packages/plugin/src/shared/mc-host-client/shm-grant.ts:67-69` —
  `DESCRIPTOR_DEPTH = 8n`, `ARENA_BYTES = 67_108_864n`, `MAX_LEASES = 8n`,
  enforced at `:160-168` as `geometry_mismatch`.
- `packages/plugin/src/shared/mc-host-client/test-support/shm-grant-fixtures.ts:26-30`
  — `grantHex` defaults: `depth ?? 8n`, `arena ?? 67_108_864n`,
  `maxLeases ?? 8n`, `total ?? arena + 8_192n`.

Depth 32, overhead 16,384:

- `crates/mc-shm-transport/src/profile.rs:682-685` — `ring_profile`:
  `descriptor_depth: 32`, `arena_bytes: MIN_ARENA_BYTES`, `max_leases: 32`.
- `packages/mc-shm-native/tests/mechanism.ts:81-99` — `GRANT_DESCRIPTOR_DEPTH =
  32n`, `GRANT_MAX_LEASES = 32n`, `GRANT_LAYOUT_OVERHEAD_BYTES = 16_384n`,
  assembled at `:113-119`. Its comment at `:80` states the intent explicitly:
  "Geometry of the `mc-host-test-ring-v1` profile (`ring_profile`)."
- `crates/mc-shm-transport/fuzz/corpus/provider_grant/valid` — the golden grant
  fixture, pinned as a hex literal at `crates/mc-shm-transport/tests/ring.rs:504-505`.
  Decoding it gives layout version 2, lane 0, depth 32, arena 67,108,864, leases
  32, total 67,125,248, reserved 0 — overhead 16,384. This fixture doubles as the
  fuzz `provider_grant` seed asserted to be *accepted*.

So four artifacts describe depth 8 and three describe depth 32, under one profile
name. Every artifact is internally consistent and every one of the seven agrees
with `Layout::new` for the depth it declares. The contradiction is entirely in the
name.

## Failure scenario

The name is the only thing a caller matches on: the addon's attach checks
`profile != PROFILE` (`packages/mc-shm-native/src/lib.rs:492-494`) and nothing
more, and `PROFILE` is `"mc-host-test-ring-v1"` (`:32`). Because
`attach-binds-geometry-to-a-local-profile` holds — no attach path compares grant
geometry to a local profile — a depth-32 grant carrying that name is accepted
natively while the host's admission charged for depth 8. The concrete recurrence
mode is the one `daf6e244` already exhibited: change a control-region struct,
and a hand-maintained overhead constant becomes stale in whichever family did not
get updated, degrading tests that expect rejection into tests that pass for the
wrong reason.

## Timing windows and dependencies

No fault, no window. This is static and live at `9c1eb4d1`. Depends on
`attach-binds-geometry-to-a-local-profile` for the disagreement to be
consequential rather than merely untidy; grouped with
`negative-tests-fail-for-their-stated-reason`, because a stale constant in this
cluster degrades negative tests specifically.

## What a test must construct

Nothing to inject — fault class F8, a cross-artifact equality assertion, which
does not exist anywhere in the repository. The assertion needed is: for the single
authoritative `(depth, arena_bytes, max_leases)` tuple, every artifact naming
`mc-host-test-ring-v1` matches it, and every hardcoded overhead constant equals
`Layout::new(depth, arena_bytes).total - arena_bytes`. The second half is
mechanically checkable today from Rust; the first half requires deciding which of
the two geometries the name means.

## Investigation log

### Q: Is the depth-32 fixture a deliberate model of `create_test_pair` (which uses `ring_profile`), in which case the profile string is knowingly overloaded across two geometries?

- Sources examined: `packages/mc-shm-native/tests/mechanism.ts:64-135` for the
  fixture and its `loadRawAddon` path; `packages/mc-shm-native/src/lib.rs:552-580`
  for `create_test_pair`; `crates/mc-shm-transport/src/profile.rs:661-696` for
  `ring_profile`; `git log -1 --format=%B daf6e244`;
  `crates/mc-shm-transport/tests/ring.rs:500-527` for the golden fixture.
- Findings: the fixture is deliberate. `create_test_pair` calls
  `ring_profile(HardwareProfileId::new(PROFILE)?, ColdParkWake)`
  (`lib.rs:563-566`) where `PROFILE` is the same string the host uses, so the
  addon really does create depth-32 rings under that name, and the fixture's own
  comment at `:80` names `ring_profile` as its source. The golden fuzz seed is a
  third depth-32 artifact, so this is a family, not a one-off. What the sources do
  not establish is whether the overload is *intended* or is an accident of
  `ring_profile` reusing the host's profile string as a hardware-profile id.
  `HardwareProfileId::new(PROFILE)` passes a *profile name* into a *hardware
  profile* slot, which is at least a suspicious reuse.
- Missing evidence: any document or plan stating which geometry
  `mc-host-test-ring-v1` denotes. `docs/mc-host-shm-transport.md:99-104` tabulates
  "descriptors 16 total, 8 per direction" and "receive leases 16 total, 8 per
  direction", which matches the depth-8 family only, and never mentions a
  depth-32 variant.
- Conclusion: partially resolved. The fixture's depth-32 choice is deliberate and
  traceable; whether one name may denote two geometries needs human input.
  Independent of that answer, the document at `:99-104` describes only the
  depth-8 geometry, so the depth-32 family is undocumented.
- Correction recorded while verifying: the assertion message at
  `crates/mc-shm-transport/tests/ring.rs:518-519` instructs a human to "update the
  copy of this hex in
  packages/plugin/src/shared/mc-host-client/shm-transport-provider.test.ts too".
  No copy of that hex exists in `packages/` at `9c1eb4d1`; that test file builds
  grants through `grantHex()` from the depth-8 fixtures module instead. The
  instruction points at a file that can no longer be kept in sync, and following
  it would put a depth-32 literal into a depth-8 suite.
