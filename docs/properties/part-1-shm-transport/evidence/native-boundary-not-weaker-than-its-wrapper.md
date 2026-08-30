# native-boundary-not-weaker-than-its-wrapper

## Discovery trigger

`packages/mc-shm-native/tests/mechanism.ts` loads the addon directly with
`createRequire` (`:71-78`) and calls `attach` with a hand-built plain object. The
addon's own test therefore demonstrates that the TypeScript grant decoder is
optional. That makes the decoder's rejections a claim about a layer a caller can
skip, so the question is which of them the native boundary reproduces.

## Evidence trail

The wrapper, `decodeShmGrant` in
`packages/plugin/src/shared/mc-host-client/shm-grant.ts:198-287`, plus
`validateRingGrant` (`:146-174`):

- `:203-217` — closed field set. `Reflect.ownKeys` is enumerated; any key not in
  `GRANT_FIELDS` (`:81-89`) is `unexpected_field`, and any missing one is
  `missing_field`.
- `:225-230` — `profile !== options.expectedProfile` is `profile_mismatch`.
- `:232-247` — `candidate_id` is read and compared against a replay high-water
  mark; `pid === previous.pid && candidateId <= previous.candidateId` is
  `stale_candidate`.
- `:160-168` — exact geometry: `layoutVersion`, `descriptorDepth === 8n`,
  `arenaBytes === 67_108_864n`, `maxLeases === 8n`, `reserved === 0`, else
  `geometry_mismatch`.
- `:169-171` — `totalBytes < arenaBytes || totalBytes > MAX_TOTAL_BYTES` is
  `out_of_range`, where `MAX_TOTAL_BYTES = ARENA_BYTES + 1_048_576n` (`:76`).
- `:172` — `lane !== expectedLane` is `lane_mismatch`, with lane 0 required for
  `host_to_peer` and lane 1 for `peer_to_host` (`:78-79`, `:270-281`).
- `:283-287` — `aliased_lanes` on equal fds, equal grant text, **or equal
  incarnations**.

The native boundary, `attach` in `packages/mc-shm-native/src/lib.rs:470-550`:

- `:486-490` — argument must be an `Object`.
- `:491-494` — `profile != PROFILE`, where `PROFILE` is `"mc-host-test-ring-v1"`
  (`:32`). Present.
- `:495-499` — `pid` in `1..=u32::MAX`, both fds in `0..=i32::MAX`. Present.
- `:500-513` — both grant strings are read with a `256`-byte length cap and
  decoded by `decode_hex` (`:216-236`), which requires exact length and strict
  lowercase hex, then by `RingGrant::decode`
  (`crates/mc-shm-transport/src/backend/ring.rs:430-457`), which rejects nonzero
  reserved bytes at `:430-432` and runs `checked_layout` at `:455`.
- `:516-518` — `host_to_peer_fd == peer_to_host_fd || host_to_peer_grant ==
  peer_to_host_grant` rejects. Two of the wrapper's three aliasing conditions.
- `:523-526` — `GrantReservation::claim` refuses a grant already live in this
  process.

What the native boundary does **not** do, checked against the list above:

1. No closed field set. Extra properties are ignored; only the six named fields
   are read at `:491-512`.
2. No `candidate_id` at all. `NativeDescriptor`
   (`packages/mc-shm-native/index.ts:17-24`) declares exactly six fields, and
   `candidateId` is not among them, so the wrapper's replay fence is dropped by the
   type contract before it can be dropped by the implementation.
3. No `stale_candidate` monotonicity, following from 2.
4. No lane binding. `RingGrant::decode` reads `lane` and `validate_lifecycle`
   confirms it matches the mapped object (`ring.rs:1663`), but nothing requires
   `host_to_peer` to carry lane 0.
5. No aliasing-by-incarnation. `:516` compares fds and encoded grants, not
   incarnations.
6. No geometry pin. `checked_layout` (`ring.rs:465-482`) accepts any nonzero
   depth with `max_leases <= depth` and an arena at or above the floor, so depth
   32 passes where the wrapper demands 8.
7. No absolute total-bytes ceiling. Native instead requires `layout.total ==
   total` exactly (`ring.rs:478-480`), which is *stronger* for internal
   consistency and *weaker* as a cap, since it admits any consistent total.

`GrantReservation` (`packages/mc-shm-native/src/lib.rs:552-580` for `claim`, and
its `Drop`) keys on the two encoded grants and removes them on drop, so the claim
covers only concurrently live grants. A grant released and re-presented is
admitted again.

## Failure scenario

Any caller reaching the addon without the wrapper — the addon's own mechanism
test, a worker that requires the `.node` directly, or a future non-TypeScript
client — can present a descriptor the wrapper would reject. The two consequences
that matter:

Replay. A previously attached and released grant is accepted natively, because
there is no `candidate_id` and the process-wide claim has already been dropped.
The wrapper's `stale_candidate` fence exists precisely to stop this.

Role confusion. Field *position* is the only thing assigning a direction: `attach`
passes `host_to_peer_grant` to the `from_host` slot and `peer_to_host_grant` to
`to_host` (`:527-528`, `:540-541`). If both grants carry the same lane, nothing
native objects, and two producers end up on one single-producer lane. The
single-producer assumption is load-bearing: `try_reserve` derives the next
sequence from `published + 1` and claims the slot with a
`FREE → PRODUCER_RESERVED` compare-exchange (`ring.rs:687-701`), which is only
race-free with one producer.

## Timing windows and dependencies

No timing window; this is a static asymmetry in where checks live. The production
path is currently safe by construction: the plugin builds `NativeDescriptor` only
from the wrapper's validated output
(`packages/plugin/src/shared/mc-host-client/shm-transport-provider.ts:57-64`), so
role assignment there is correct and `candidateId` is deliberately dropped after
the fence has already been applied. That makes the role-confusion half latent, and
the replay half reachable by any direct caller. Depends on
`attach-binds-geometry-to-a-local-profile` for item 6, and supplies the mechanism
by which the depth-32 fixture in `one-profile-name-denotes-one-geometry` is
accepted at all.

## What a test must construct

One direct native call per wrapper error code, using the `createRequire` shape the
addon's own test already has. For each of `unexpected_field`, `stale_candidate`,
`lane_mismatch`, `aliased_lanes` by incarnation, `geometry_mismatch`, and
`out_of_range`, build the descriptor that triggers it and assert the native
`attach` rejects, with `activeChannelCount()`, `activeExternalRefCount()`, and
`nativeLeakDiagnostics()` unchanged across the throw — the pattern
`expectRejectedWithoutEffects` (`mechanism.ts:139-145`) already uses. Six of these
are expected to fail today; that is the point. The replay case needs a full
attach, close, and re-attach with the same grant, so it needs a real host-created
object rather than the synthetic fixture.

## Investigation log

### Q: Can any caller reach native `attach` with attacker-ordered or bug-ordered lane fields, making the role confusion reachable rather than latent?

- Sources examined:
  `packages/plugin/src/shared/mc-host-client/shm-transport-provider.ts:41-71`,
  the only production construction of a `NativeDescriptor`;
  `packages/mc-shm-native/index.ts:43` and `:394-399`, where `NativeChannel.attach`
  forwards a `NativeDescriptor` to `native.attach`;
  `packages/mc-shm-native/tests/mechanism.ts:64-135` for the direct-require path
  and its synthetic grants; `packages/mc-shm-native/src/lib.rs:470-550` and
  `:527-528` for how the two grants are bound to `from_host` and `to_host`.
- Findings: no *attacker*-ordered path exists today. The single production caller
  copies the wrapper's already-validated, already-lane-checked fields into the
  descriptor by name (`:57-64`), so a hostile provider cannot swap them there —
  the wrapper has already bound lane 0 to `host_to_peer` and lane 1 to
  `peer_to_host`. A *bug*-ordered path is fully reachable: `NativeDescriptor` is a
  TypeScript interface, erased at runtime, and the two grant fields are both
  `string`, so transposing them at any call site is a type-checked, silently
  accepted mistake. The mechanism test proves an unvalidated caller can reach
  `attach` at all.
- Missing evidence: whether the ring's own incarnation and lane checks would
  catch a transposition in practice. `validate_lifecycle` (`ring.rs:1637-1668`)
  compares the grant's lane against the mapped object's lane, so a transposed
  *pair of grants together with their matching fds* would still attach
  successfully with both directions inverted; a transposition of grants without
  fds would fail at `:1663`. I did not construct either case, so the exact
  survivable transpositions are unestablished.
- Conclusion: unresolved, needs the transposition matrix. Concretely: enumerate
  the four combinations of swapped and unswapped `(fd, grant)` pairs and record
  which attach successfully. Until then the record stands as "native admits
  descriptors the wrapper rejects", which is established on six independent counts
  above, with the role-confusion consequence rated latent-in-production and
  reachable-by-bug.
