# setup-a-the-managed-rust-peer-repeats-every-native-peer-rejection

## Discovery trigger

Part 1 recorded `native-boundary-not-weaker-than-its-wrapper`: every rejection the
TypeScript grant decoder performed was absent from the directly-callable native
`attach`, so the permissive layer was the inner one. The refactor added
`packages/mc-shm-native/src/setup.rs`, and the task asked whether that asymmetry
still exists. It does, inverted.

## Evidence trail

All references at commit `e447c927`.

### What the native peer now checks

`packages/mc-shm-native/src/setup.rs:95-161`, `connect`:

- `:102-104`: key length exactly 32, daemon-id length exactly 16, timeout nonzero.
- `:107-113`: full three-message mutual authentication.
- `:114`: `receive_grant`.
- `:115-119`: `wire_version != 2` or
  `descriptor_schema != DESCRIPTOR_SCHEMA_VERSION` rejected.
- `:120-121`: both grant strings decoded through `decode_grant`, which is
  `strict_hex` then `RingGrant::decode` (`:354-357`).
- `:122-124`: `grant.descriptor.profile != super::PROFILE` **or**
  `host_to_peer_grant == peer_to_host_grant` rejected. This is the alias check.

Also structural: `GrantMessage` is a tagged enum with `deny_unknown_fields`
(`:42-51`) and `Descriptor` likewise (`:60-66`), so an unexpected field is a decode
failure. `receive_grant` requires exactly two descriptors (`:255-257`) and rejects
`CTRUNC` (`:244-246`).

`packages/mc-shm-native/src/lib.rs:571-629`, `connect_setup`, adds two more:

- `:582-584`: rejects equal grants again, after `setup::connect` already did.
- `:585-588`: `GrantReservation::claim(...)`, a process-wide claim over both
  encoded grants.

`lib.rs:491-568`, `attach`, the descriptor-taking entry point Part 1 mined, now
carries:

- `:505-509`: raw `ValueType::Object` check before any coercion, and profile
  compared against `PROFILE`.
- `:510-513`: `hostToPeerFd` and `peerToHostFd` read as bounded integers.
- `:514-533`: both grant hex strings length-bounded to
  `RingGrant::encoded_len() * 2` and decoded.
- `:534-537`: `host_to_peer_fd == peer_to_host_fd || host_to_peer_grant ==
  peer_to_host_grant` rejected, with the comment "an aliased fd or grant collapses
  them onto one ring".
- `:539-549`: `GrantReservation::claim`, with the comment stating the claim is
  process-wide because worker threads hold separate registries yet map the same
  memory.

So Part 1's specific findings about `attach` have been addressed: the profile
check, the grant decode, the alias check and a replay fence all exist natively now.

### What the managed Rust peer checks

`crates/mc-host/src/setup_socket.rs:288-331`, `activate_client`:

- `:295`: `receive_grant`.
- `:296-301`: deserialize into `GrantMessage`. Note this struct
  (`:52-59`) has `#[serde(tag = "type", rename = "grant")]` and **no**
  `deny_unknown_fields`, unlike the native `GrantMessage` (`setup.rs:42-43`).
- `:302-306`: `wire_version != PROTOCOL_VERSION` or
  `descriptor_schema != DESCRIPTOR_SCHEMA_VERSION` rejected.
- `:307-329`: activate, await `Activated`, commit, await `Committed`.
- `:330`: returns `(descriptor, descriptors)` where `descriptor` is still an
  unvalidated `serde_json::Value`.

No profile check. No grant decode. No alias check. No claim.

`crates/mc-host/src/ring_transport.rs:636-656`,
`RingClientEndpoint::attach_with_descriptors`, reached from
`client.rs:1855-1858`:

- `:640-641`: deserialize into `WireDescriptor` (`:316-322`), which **does** carry
  `#[serde(deny_unknown_fields)]` at `:317`.
- `:642-644`: `descriptor.profile != RING_PROFILE` rejected. So the profile check
  exists, one layer later.
- `:646-647`: both grants decoded.
- `:648-650`: `from_host_grant.geometry() != to_host_grant.geometry()` rejected.
- `:651-655`: attach both.

### The two divergences

First, **the alias check is absent and its nearest neighbour is the opposite
predicate**. Native rejects when the two grants are *equal*
(`setup.rs:122`, `lib.rs:534-537`, `lib.rs:582-584`). Managed rejects when their
geometries are *unequal* (`ring_transport.rs:648-650`). Two identical grants have
identical geometry, so they pass the managed check and fail every native one.

Second, **no process-wide claim**. `GrantReservation::claim` appears at
`lib.rs:539-549` and `:585-588` and nowhere in `crates/mc-host/src`. So the managed
Rust client has no equivalent of the exclusive-active-attachment fence, and two
`Client` instances in one process attaching the same grant are not detected.

## Failure scenario

A host, or something impersonating one, emits a grant whose two grant strings are
identical. The native peer refuses at `setup.rs:122`. The managed Rust peer accepts,
decodes both to the same `RingGrant`, and calls `Ring::attach` twice
(`ring_transport.rs:651-654`) over the two distinct descriptors it received. If
those descriptors also refer to one object, both directions collapse onto one ring
and the single-producer contract is violated on both sides at once. Part 1's
`release-authority-bound-to-lease-ownership` and
`publication-visibility-derives-only-from-the-published-cursor` are the properties
that would then be reasoning over a ring with two producers.

The honest reachability statement: the only grant producer in the tree is
`ring_transport.rs:324-327` `worker_descriptor`, which encodes two distinct rings,
so today an aliased pair cannot arise from an honest host. It becomes live under a
rogue host, a bug in `worker_descriptor`, or a future producer. That is the same
latency argument Part 1 made for its own record, and the same reason to hold the
property anyway.

## Timing windows and dependencies

None temporal. The exposure is a divergence between two independently maintained
validation lists in two languages, which drifts on edit rather than on schedule.

Depends on which peer a deployment uses. `shm-frame-channel.ts:77` uses
`NativeChannel.connectSetup`, so the shipped TypeScript client takes the stronger
path. `client.rs:346` is the managed Rust client, used by embedders and by the
crate's own tests.

## What a test must construct

A shared rejection table driven against both peers. Enumerated from the native
side, which is the stronger list:

1. `wire_version` not 2;
2. `descriptor_schema` not `DESCRIPTOR_SCHEMA_VERSION`;
3. `profile` not `RING_PROFILE`;
4. `host_to_peer_grant` not valid strict hex;
5. `host_to_peer_grant` hex that fails `RingGrant::decode`;
6. `host_to_peer_grant == peer_to_host_grant`;
7. an unexpected extra field in the grant *envelope*, alongside `wire_version`,
   `descriptor_schema`, `activation_token` and `descriptor`;
8. a second attach of the same grant in one process.

For each row, drive both `packages/mc-shm-native`'s `connect_setup` and the managed
`activate_client` plus `attach_with_descriptors`, and assert both refuse. Rows 6, 7
and 8 are the ones expected to fail on the managed side today, so the test's first
run documents the gap rather than passing. An unexpected field inside the
*descriptor* object is not a gap: `ring_transport.rs:317` rejects it.

The test needs a controllable grant source. `activate_server`
(`setup_socket.rs:237`) takes the descriptor as a `&serde_json::Value` parameter,
so a test can hand it an arbitrary object without touching `worker_descriptor`.
`setup_socket.rs:768-808` already uses that shape to drive stale identities.

## Investigation log

### Q: Does Part 1's `native-boundary-not-weaker-than-its-wrapper` still hold as written?

- Sources examined: the Part 1 record, `lib.rs:491-568`, `packages/mc-shm-native/index.ts:41-48`.
- Findings: its `Confidence` line cites `lib.rs:491-512` as containing none of the
  wrapper's checks. At `e447c927` that range contains the object type check, the
  profile comparison and the fd reads, and `:514-537` contains the decode and alias
  checks. Its `Impact` line says `NativeDescriptor` structurally omits `candidateId`
  so the replay fence is dropped; `index.ts:41-48` still defines
  `NativeDescriptor` without a candidate id, but `attach` now takes
  `GrantReservation::claim` (`:539-549`), which is a different fence covering
  concurrently live grants rather than released ones.
- Missing evidence: whether the wrapper-level checks the Part 1 record enumerated,
  "unexpected field, stale candidate, lane mismatch, aliased lanes by incarnation,
  geometry mismatch, out-of-range total", map one-to-one onto what `attach` now
  does. Several of those names do not appear in the current code.
- Conclusion: needs human input, and it is a Part 1 revision rather than this
  lens's call. Recorded as lens open question 5. What this pass can state is the
  direction: the native boundary got stronger, the managed Rust one did not, and
  the asymmetry now points the other way.

### Q: Is `deny_unknown_fields` present on both grant decoders?

- Sources examined: `setup_socket.rs:52-59`, `:61-62`,
  `packages/mc-shm-native/src/setup.rs:42-43`, `:60-61`,
  `ring_transport.rs:316-322`.
- Findings: a first draft of this file claimed `WireDescriptor` lacked the
  attribute. **That was wrong and is corrected here.** `ring_transport.rs:317` is
  `#[serde(deny_unknown_fields)]`, so the managed path does reject an unexpected
  field inside the *descriptor* object, at the `attach_with_descriptors` layer.
  The real divergence is one level up: the host's `GrantMessage`
  (`setup_socket.rs:52-53`) carries only `tag` and `rename`, while the native
  `GrantMessage` (`setup.rs:42-43`) carries `deny_unknown_fields`. The host's
  `ClientMessage` (`setup_socket.rs:62`) does carry it. So an unexpected field in
  the grant *envelope* is accepted by the managed peer and rejected by the native
  peer; an unexpected field in the descriptor is rejected by both.
- Missing evidence: none.
- Conclusion: resolved, with the draft error corrected. Row 7 of the test table is
  narrowed to the envelope rather than the descriptor.

### Q: Could the aliased-grant case arise from the current host?

- Sources examined: `ring_transport.rs:324-327`.
- Findings: `worker_descriptor` encodes `rings.first.grant()` and, by symmetry, the
  second ring's grant. Two distinct rings produce two distinct grants unless the
  grant encoding loses the distinguishing field.
- Missing evidence: `RingGrant`'s encoding is in the transport crate and was not
  read, so "unless the encoding loses it" is unverified.
- Conclusion: resolved as latent-today. Recorded on the record as its open
  question, with the threat model, a rogue or impersonating host, stated as the
  reason to hold it anyway.
