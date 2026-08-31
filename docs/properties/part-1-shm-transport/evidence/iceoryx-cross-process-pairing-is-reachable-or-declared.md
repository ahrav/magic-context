# iceoryx-cross-process-pairing-is-reachable-or-declared

## Discovery trigger

The ring's cross-process story is explicit and checkable: a `RingGrant` carrying
the incarnation is encoded, transferred alongside a duplicated file descriptor,
and re-verified against the shared lifecycle page at attach. The iceoryx backend
has no grant, no descriptor transfer, no seals, and no lifecycle page. The
question "what authenticates the peer" therefore has to be asked before any
parity claim, and the answer turns out to be that no peer can exist: the backend
creates both ports itself, under a service name it never discloses.

## Evidence trail

- **The cited mechanism is gone.** `0f336d3c` ("refactor(shm): collapse to fixed
  ring transport") deleted `crates/mc-shm-transport/src/backend/iceoryx.rs`,
  `crates/mc-shm-transport/tests/iceoryx.rs`, and the `iceoryx` Cargo feature, so
  `backend/mod.rs` now declares only `ring` and `sample`. Every `iceoryx.rs`
  citation below is kept as a record of what the removed backend did and did not
  guarantee, and resolves against `9c1eb4d1`, not HEAD. No successor backend
  exists in the tree.

- `backend/iceoryx.rs:57-69` — the service name is built from 16 bytes of
  `getrandom` output formatted as `mc-shm-` plus 32 hex characters, inside
  `create`. It is not a parameter, it is not stored on the struct
  (`:36-46`), there is no accessor, and no other function in the file mentions
  `ServiceName`. Nothing in the repository can learn or supply it, so
  `open_or_create` at `:82` always creates.
- `backend/iceoryx.rs:76-77` — `max_publishers(1)` and `max_subscribers(1)`.
  `:84-88` creates the subscriber and `:89-106` creates the publisher, both on
  the same instance, so both slots are consumed by the creator. In iceoryx2
  0.9.3 a second port beyond the bound fails at creation:
  `src/port/publisher.rs:567` returns
  `PublisherCreateError::ExceedsMaxSupportedPublishers` and
  `src/port/subscriber.rs:328` returns
  `SubscriberCreateError::ExceedsMaxSupportedSubscribers`. Since
  `IceoryxBackend::create` builds one of each, a second process that somehow
  guessed the name could not construct a backend against a live pair at all.
- `backend/iceoryx.rs:56` and `:163` — the incarnation is minted locally by
  `Incarnation::random()` (`descriptor.rs:102-106`), and `try_receive` builds the
  expected identity from `self.incarnation`. There is no accessor for it, no
  constructor that accepts one, and no encode or decode path. Compare
  `backend/sample.rs:94-96`: a sample whose prefix carries any other incarnation
  is rejected as `WrongIncarnation`. So even a hypothetical second participant
  would have every one of its samples refused.
- `backend/ring.rs:398-488` `RingGrant` with `encode` (`:406`), `decode`
  (`:425`), and `decode_slice` (`:456`); `:619-621` `grant()`; `:624-626`
  `raw_fd()`; `:629-642` `attachment()` duplicating the descriptor with
  `F_DUPFD_CLOEXEC`. That is the transfer channel the iceoryx backend lacks.
- `backend/ring.rs:606` calls `validate_lifecycle`, which at `:1639-1670` reads
  eight fields from the shared page and compares all eight against the grant,
  including the incarnation (`snapshot.6` at `:1655`, compared at `:1665`). On
  Linux `create_in` also seals the object (`:580-581`) and
  `validate_seals` (`:1701-1708`) requires `F_SEAL_GROW|SHRINK|SEAL`. None of
  these three mechanisms — grant equality, incarnation equality against shared
  state, or seals — exists on the iceoryx path.
- `crates/mc-shm-transport/tests/iceoryx.rs` — all seven tests construct exactly
  one `IceoryxBackend` and use it as both producer and receiver (`:79`, `:108`,
  `:123`, `:141`, `:289`; the two decoder tests at `:164` and `:233` call
  `SamplePrefix` directly and touch no backend at all).
  `benches/hardware_envelope.rs:564` does the same, and the bench report
  classifies the arm accordingly: `loopback_smoke_arms: ["iceoryx_0_9_3"]`
  (`:141`), against nine `paired_process_arms` at `:140` that include `ring`.
- `crates/mc-shm-transport/tests/ring.rs:581`
  `two_process_zero_copy_exchange_uses_authenticated_grant` is the ring's
  two-process test. There is no iceoryx analogue, and none can be written against
  this API.
- `crates/mc-shm-transport/Cargo.toml:9-10` — `default = ["iceoryx"]`. The
  backend is compiled by default *for the transport crate*.
  `crates/mc-host/Cargo.toml:25` and `packages/mc-shm-native/Cargo.toml:16` both
  depend with `default-features = false`, so neither the host nor the shipped
  addon contains it.

## Failure scenario

Nothing breaks at runtime; the loss is evidential. The iceoryx backend is
`selectable` in the release-gate manifest
(`benches/manifests/v1.json:107-110`) as one of two candidate providers for a
transport whose entire purpose is moving frames between the host process and a
JavaScript runtime process. Every observation that exists about it was produced
by one process talking to itself.

The concrete consequence for the properties this catalog already holds: a
same-instance exercise structurally cannot construct the second participant, so
it cannot prove any property whose predicate ranges over two address spaces or
two incarnations. That covers publication visibility across a real
release-acquire edge, peer authentication at attach, geometry binding, restart
reconciliation, and stale-cursor handling — five of the ring's groups. It is not
that these are untested on iceoryx; it is that no test written against
`IceoryxBackend::create(profile, lane)` can reach them, because the API admits
neither an inbound service name nor an inbound incarnation. The loopback also
suppresses the failure mode of
`iceoryx-receive-expectation-tracks-the-delivered-stream`: with one instance
owning both cursors, the restart divergence that record derives cannot occur,
which is why that record is latent rather than live.

## Timing windows and dependencies

No window and no fault; this is a static property of the constructor. The one
runtime dependency worth recording is that the tests do run. Verified by
executing `cargo nextest list -p mc-shm-transport -p mc-shm-native` at
`4d781582`: the listing includes `mc-shm-transport::iceoryx` with all seven
tests, because selecting the transport crate on the command line enables its
default features regardless of the two dependents' `default-features = false`.
That is the command at `.github/workflows/ci.yml:162`, guarded by
`if: runner.os == 'Linux'`, so the iceoryx suite executes in CI on Linux. The
macOS branch at `:172-173` selects only `--test contract --test fuzz_corpus`, so
it never runs there, while `cargo check -p mc-shm-transport --features iceoryx`
at `:157` compiles it on both. This corrects
`existing-checks.md:56`, which states the suite is "not executed anywhere in CI;
only `cargo check --features iceoryx` runs."

## What a test must construct

Two distinct processes exchanging one frame over iceoryx, with the receiving side
refusing a mismatched peer identity. That requires an API change first, so the
test cannot be written today: `create` must accept a service name and an
incarnation from an authenticated setup channel — the same way `Ring::attach`
takes a `RingGrant` — and expose the pair for the creating side to publish. Until
then the campaign obligation is the declaration, not the test: assert that no arm
whose evidence is loopback-only is marked `selectable`, and that the bench
report's `loopback_smoke_arms` and the manifest's `selectable` list do not
overlap. Today they do, on this arm. Coverage check to emit:
`shm_iceoryx_two_process_exchange`, which will not fire, and whose not firing is
the evidence.

## Investigation log

### Q: Given no grant, no descriptor, no seals, and no lifecycle page, what authenticates a peer on the iceoryx path?

- Sources examined: `backend/iceoryx.rs:48-118`, `:150-176`, `:36-46`;
  `crates/mc-shm-transport/src/descriptor.rs:100-117`;
  `backend/sample.rs:83-127`; `backend/ring.rs:398-488`, `:534-611`,
  `:613-639`, `:1639-1670`, `:1701-1708`; `tests/iceoryx.rs` in full;
  `tests/ring.rs:581`; `benches/hardware_envelope.rs:140-141`, `:531-598`;
  `benches/manifests/v1.json:100-155`; the three `Cargo.toml` files;
  `.github/workflows/ci.yml:154-176`; and in iceoryx2 0.9.3,
  `src/port/publisher.rs:560-570` and `src/port/subscriber.rs:320-332`.
- Findings: nothing authenticates a peer, because the design admits no peer. The
  service name is locally random and undisclosed, both port slots are consumed by
  the creator under caps of one, and the expected incarnation is the local one.
  Three independent facts, each sufficient on its own. The backend is a loopback,
  and the bench's own report already says so at `:141` while the manifest calls
  the arm selectable at `:107-110`.
- Missing evidence: whether loopback is the intended permanent shape of this
  candidate or a scaffold pending a grant-equivalent. The transport document
  scopes it as "a source-built candidate, not a selected backend"
  (`docs/mc-host-shm-transport.md:120`), which is consistent with either reading.
- Conclusion: resolved with answer, and it reframes the gap. The parity question
  is not which ring guarantees the iceoryx backend fails to meet; it is that a
  whole class of them is unprovable on it by construction, and that the release
  gate does not currently notice.
