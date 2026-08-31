# setup-a-only-an-authenticated-grant-enters-the-native-channel-registry

## Discovery trigger

The lens's question was "at what point does a peer become authorized to map shared
memory". For the native addon the answer turns out to be "it depends which of two
exported entry points it calls", because only one of them involves the setup socket
at all.

## Evidence trail

All references at commit `e447c927`.

Two napi exports reach the same channel registry.

`packages/mc-shm-native/src/lib.rs:491`, `attach`:

- signature `pub fn attach(env: &Env, descriptor: Unknown<'_>) -> Result<u32>`.
  The only argument is a JavaScript object.
- `:505-509`: raw `ValueType::Object` check, then the profile field compared
  against `PROFILE`.
- `:510-513`: `hostToPeerFd` and `peerToHostFd` read as bounded integers in
  `[0, i32::MAX]`. **These are caller-supplied file descriptor numbers.**
- `:514-533`: both grant hex strings decoded.
- `:534-537`: aliased fd or aliased grant rejected.
- `:539-549`: `GrantReservation::claim` over the two encoded grants.
- `:550-556`: `attach_ring` on each fd, then `insert_channel` into `REGISTRY`.

Nowhere in that path is a socket opened, a key consulted, or a proof computed.

`packages/mc-shm-native/src/lib.rs:571`, `connect_setup`:

- signature `pub fn connect_setup(env: &Env, options: NativeSetupOptions) ->
  Result<u32>`, with `NativeSetupOptions` carrying `setup_socket`, `key`,
  `daemon_id`, `daemon_ver` and `timeout_ms` (`:41-48`).
- `:572-580`: calls `setup::connect`, which dials the socket (`setup.rs:106`) and
  performs the three-message handshake (`setup.rs:107-113`, `:174-220`).
- `:582-584`: rejects equal grants.
- `:585-588`: `GrantReservation::claim`.
- `:589-596`: `Ring::attach` on each descriptor received over `SCM_RIGHTS`, then
  `insert_channel` into the same `REGISTRY`, with the setup stream retained in the
  channel's `setup: Some(connected.stream)` field.

That retained stream is what makes the peer-lifetime sentinel work from the native
side; `lib.rs:343` calls `setup::goodbye(&mut setup)` on teardown.

Both are surfaced in TypeScript. `packages/mc-shm-native/index.ts:76-77` declares
both on the native binding interface, and `:526-529` and `:531-534` wrap them as
`NativeChannel.attach` and `NativeChannel.connectSetup`. Neither is marked
internal, neither is `#[cfg(test)]`, and neither is `#[doc(hidden)]`.

The shipped consumer uses only one: `packages/plugin/src/shared/mc-host-client/
shm-frame-channel.ts:77` is `this.native = NativeChannel.connectSetup({...})`. A
repository search for `NativeChannel.attach` outside `index.ts` returned nothing
under `packages/plugin/src/shared/mc-host-client/`.

`create_test_pair` at `lib.rs:631` is the other descriptor-producing entry point and
is the likeliest intended consumer of `attach`, which supports reading `attach` as
test surface.

## Failure scenario

The property is about a belief rather than a crash. Every argument in this catalog
that begins "the peer must have authenticated, therefore..." is unsound for an
in-process JavaScript caller, because `attach` exists. Concretely: a plugin, a
dependency, or a worker script running in the same Node process can construct a
descriptor object over any fd it can obtain and enter the ring registry with no
key, no socket, and no proof.

Under the stated same-user trust model
(`docs/mc-host-wire-protocol.md:29` and its key-reader paragraph) that is not a
privilege escalation: such a caller already shares the process with the legitimate
client and could read its memory directly. The concrete harm is narrower and real:
the setup socket is not the only path into the ring, so a security review that
audits the socket has not audited the boundary.

The other direction matters more for correctness than for security. Part 1's
records about grant custody, lease ownership and publication cursors are all
written about a ring reached through a validated grant. A ring reached through
`attach` with a fd the caller chose is the same data structure with none of the
provenance, and `GrantReservation::claim` (`:539-549`) fences only *concurrently
live* grants, not previously released ones. Part 1 recorded that limitation in
`native-boundary-not-weaker-than-its-wrapper`.

## Timing windows and dependencies

None. This is a call-graph property, decided at build time by which exports exist
and at run time by which the wrapper calls.

Depends on `PROFILE` gating (`lib.rs:507-509` region) as the only thing preventing
an arbitrary object from being accepted, and on `RingGrant::decode` rejecting
malformed grant bytes. Both are validation of the descriptor's *shape*, not of its
*provenance*, and provenance is the thing this record is about.

Depends on Part 1's `test-only-surface-absent-from-the-shipped-addon`, which should
be checked for whether it already covers `attach`. On the face of the code it does
not: `attach` carries no cfg gate and no doc-hidden marker, so it is present in the
shipped addon by construction.

## What a test must construct

1. Instrument both `insert_channel` call sites, `lib.rs:550-556` and `:589-596`,
   with distinct constant markers. The marker names must be constant and globally
   unique, never constructed from the entry point's name at run time.
2. Run the shipped TypeScript client through a full connect, request and close
   cycle.
3. Assert the `connect_setup` marker fired at least once and the `attach` marker
   fired zero times.

That is the whole property. It is cheap and it is the kind of check that only ever
fails when someone adds a shortcut.

A companion check, which is a different property and belongs with Part 1's
test-only-surface record rather than here: assert that the shipped addon's export
list matches an approved allowlist, so a new descriptor-taking entry point cannot
appear without review.

The negative control is step 3's first clause. Without asserting `connect_setup`
fired, a run that failed to connect at all would satisfy the second clause
vacuously.

## Investigation log

### Q: Is `attach` reachable from the shipped TypeScript client?

- Sources examined: `packages/mc-shm-native/index.ts:76-77`, `:526-534`, and a
  search for `NativeChannel.attach`, `connectSetup` and `attach(` across
  `packages/plugin/src/shared/mc-host-client/` and `packages/mc-shm-native/`.
- Findings: `attach` is declared and wrapped but the only hit for the wrapper
  outside `index.ts` is none; `shm-frame-channel.ts:77` uses `connectSetup`. So it
  is reachable in principle by any code that imports the module, and unused by the
  shipped path.
- Missing evidence: the search covered `packages/plugin/src/shared/mc-host-client/`
  and `packages/mc-shm-native/`. Other packages and any test files under
  `packages/` were not exhaustively searched in this pass.
- Conclusion: resolved for the shipped frame channel, partial for the repository.
  Recorded as `Exercised: not yet` with the search scope stated.

### Q: Does `GrantReservation::claim` make `attach` safe enough?

- Sources examined: `lib.rs:539-549` and its comment, `:585-588`, and Part 1's
  `native-boundary-not-weaker-than-its-wrapper`.
- Findings: the comment says the claim is process-wide "because worker threads each
  hold their own `REGISTRY` yet map the same memory", and that a grant already
  backing a live channel is "a replayed or concurrently duplicated descriptor". So
  it fences concurrent duplication. It does not fence a grant whose previous
  channel was closed, which is exactly what Part 1's record said about replay.
- Missing evidence: `GrantReservation`'s implementation was not read.
- Conclusion: resolved as a partial fence. It closes concurrent aliasing and not
  sequential replay, which is why this record is about provenance rather than about
  the claim.

### Q: Is `attach` intended as production surface?

- Sources examined: `lib.rs:491-568`, `:631` (`create_test_pair`),
  `index.ts:41-48` (`NativeDescriptor`), `:76-77`.
- Findings: `create_test_pair` produces a pair of channels for tests and is the
  natural producer of the fds `attach` consumes. `NativeDescriptor` is an exported
  public interface. No comment states an intended audience for `attach`, in contrast
  to `ring_transport.rs:627`, where the Rust side's client endpoint is explicitly
  doc-commented as being for integration tests.
- Missing evidence: no design note. Git archaeology was not performed.
- Conclusion: needs human input. Recorded as the record's open question, and it
  bears directly on the record's reachability label: if `attach` is test-only, the
  property is a build-time surface check; if it is production, it is a provenance
  hole.
