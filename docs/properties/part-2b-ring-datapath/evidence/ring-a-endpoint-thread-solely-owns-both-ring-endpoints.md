# ring-a-endpoint-thread-solely-owns-both-ring-endpoints

## Discovery trigger

The module doc at `crates/mc-host/src/ring_transport.rs:3-4` states a
load-bearing design claim: "One dedicated OS thread creates and owns both
`!Send` ring endpoints. Host tasks exchange frame tickets and completion
notifications with that thread." The re-scope named this the first attention
focus for sub-part 2b and asked specifically whether both endpoints really stay
confined. Every other property in this lens rests on the answer, because the
transport's producer and consumer cursors are unsynchronized between local
threads: a second local thread touching one direction is a data race, not a
slowdown.

## Evidence trail

Ownership is established in four steps, all inside `prepare`
(`ring_transport.rs:217-303`).

1. The OS thread is spawned at `:238-240` with the name
   `mc-host-shm-endpoint`. Everything from `:241` to `:277` is inside that
   closure.
2. `DuplexRing::create(&profile)` runs at `:248`, inside the closure. The only
   thing the caller supplies is `Arc<TargetProfile>`, cloned at `:234`.
3. `rings` is moved by value into `run_endpoint(rings, ...)` at `:265`.
   `run_endpoint`'s signature takes `rings: DuplexRing` by value
   (`:359-368`), so the value is dropped when `run_endpoint` returns, still inside
   the closure and still inside the `catch_unwind` at `:264-275`.
4. What crosses the thread boundary is a `std::sync::mpsc::sync_channel(1)`
   created at `:231` and carrying
   `Result<(serde_json::Value, [OwnedFd; RING_DESCRIPTOR_COUNT]), RingUnavailable>`
   — six descriptors post-#131 (three per direction: mapping, data doorbell,
   capacity doorbell), up from two — sent at `:261`
   and received at `:282`. No ring, no mapping pointer, no arena reference.

`PreparedRing` (`:93-101`) is the handle the connection task receives. Its
seven fields are `descriptor: serde_json::Value`,
`descriptors: [OwnedFd; RING_DESCRIPTOR_COUNT]`,
`sender: FrameSender`, `receiver: ShmReceiver`, `io: Pin<Box<dyn Future>>`,
`root: CancellationToken`, `read_cancel: CancellationToken`. None owns a `Ring`.

Two independent structural reinforcements:

- `Ring` is `!Send`. `RingClientEndpoint`'s doc at `:650` says
  "Thread-confined", and the peer side in `client.rs:1842-1893` likewise
  constructs its endpoint inside its own thread closure at `client.rs:1855`.
  A direct move of a `Ring` across a thread boundary would not compile.
- `crates/mc-host/src/lib.rs:5` is `#![deny(unsafe_code)]`, with the doc comment
  at `:1-4` recording that the one permitted `unsafe` block in the crate is a
  `pre_exec` hook in the Broca subprocess spawner. So there is currently no
  route in `mc-host` for smuggling a raw pointer into the arena past the
  `!Send` bound.

The inline test `construction_has_no_ring_side_effects`
(`:851-856`) asserts the process-level half: a freshly constructed
`RingTransport` has `accounting.active == ResourceCharges::ZERO` and
`accounting.quarantined == ResourceCharges::ZERO`, so no ring exists before
`prepare`.

## Failure scenario

The compiler currently forecloses the direct violation, so the realistic failure
is a future change that keeps the types legal while breaking confinement:

- `prepare` is changed to return a ring handle for a diagnostics or test path,
  making the endpoint thread one of two owners.
- A `ReceiveLease` or a span pointer is returned from the endpoint thread
  through a channel that carries a raw address as an integer, which no type
  system catches.
- The endpoint thread's current-thread Tokio runtime (`:242-246`) is changed to
  a multi-thread runtime, at which point `run_endpoint`'s futures could migrate
  between worker threads. `run_endpoint` holds `&rings` across `await` points
  (`:386-397`, `:479-484`), so a multi-thread runtime would immediately require
  `DuplexRing: Send` and fail to compile — but only as long as the ring is held
  across an await, which is an incidental rather than a stated invariant.

If confinement broke, the observable consequence would be descriptor validation
failures on `try_receive` (`ring.rs:1093-1100`) leading to quarantine, or torn
payload delivery with a valid descriptor, depending on which cursor raced.

## Timing windows and dependencies

The window is the entire connection lifetime, from `:248` to `run_endpoint`
returning. There is no narrow interleaving to hit; the property is structural.

Dependencies: Part 1's transport-side properties all assume single-threaded
access per direction, notably
`validated-spans-are-disjoint-and-inside-the-arena` and
`no-rust-reference-over-peer-writable-payload`. This record is the host-side
premise those rest on.

## What a test must construct

Two options, and the static one is the better buy.

Static: a test or lint asserting that `PreparedRing` has no field whose type
transitively owns a `Ring`, plus compile-fail doctests in the style of the two
already on `frame_channel::ReceiveLease` (`frame_channel.rs:296-308`), one
requiring `Send` and one requiring `'static`, applied to `DuplexRing` as
returned from any host-visible function. That closes the refactor risk without
needing a running connection.

Dynamic: instrument the endpoint thread with a `thread::current().id()` capture
on first ring touch, stored in an `OnceLock` on a test-only shim, and assert on
teardown that exactly one id was recorded. This needs an active connection with
both directions carrying traffic so that a second toucher would exist to be
caught. The `RingFactory` harness (`frame_channel/contract_tests.rs:498-521`)
already builds a real transport and calls the production `prepare`, so it is the
natural host.

Neither runs in CI today: every `-p mc-host` invocation in `ci.yml` carries a
`--test <name>` filter, which excludes the lib target.

## Investigation log

### Q: Should `PreparedRing` carry a negative marker or a compile-fail doctest so confinement is enforced rather than reviewed?

- Sources examined: `ring_transport.rs:93-101` (`PreparedRing` fields),
  `:238-277` (thread closure), `:359-368` (`run_endpoint` signature),
  `frame_channel.rs:296-308` (the two existing compile-fail doctests on
  `ReceiveLease`; not re-swept post-#131), `lib.rs:5` (`deny(unsafe_code)`).
- Findings: the crate already uses compile-fail doctests for exactly this kind
  of confinement claim, on `ReceiveLease`, where the two doctests assert
  `!Send` and `!'static`. So the technique is established in this codebase and
  would be consistent rather than novel. `PreparedRing` is `pub(crate)`, so a
  doctest cannot name it; the assertion would have to be a unit test using
  `static_assertions`-style trait probes, or a doctest on a `pub` wrapper.
- Missing evidence: whether the team considers the `!Send` bound on `Ring`
  sufficient. There is no comment saying so.
- Conclusion: unresolved, needs a design decision on whether `PreparedRing`
  should be `pub` enough to carry a doctest, or whether a `pub(crate)` unit test
  asserting the field set is the right shape. The property itself is verified;
  only the enforcement mechanism is open.

### Q: Does the current-thread runtime choice at `:257-259` carry part of the confinement guarantee?

- Sources examined: `ring_transport.rs:242-246`
  (`Builder::new_current_thread().enable_io().enable_time().build()`), `:359-485`
  (`run_endpoint`'s loop, which holds `&rings` across awaits at `:386-397` and
  uses `&rings.first` at `:479-484`).
- Findings: yes, incidentally. Because `run_endpoint` holds a `&DuplexRing`
  across `.await`, switching to a multi-thread runtime would require the future
  to be `Send`, which `DuplexRing` is not. So the current-thread choice is
  load-bearing and the compiler enforces it. But nothing states this: the
  builder call reads as a resource-economy choice, not a safety one.
- Missing evidence: none needed.
- Conclusion: resolved. The confinement is compiler-enforced today through the
  combination of `!Send` and the current-thread runtime, but the coupling is
  undocumented, so a comment at `:242` would be the cheapest hardening.
