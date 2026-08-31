# Lens A, sub-part 2b: the ring datapath's ownership and frame lifecycle

Attention focus: what owns the ring on the host side, how a frame enters and
leaves it, what happens on each failure path, and what the host now guarantees
that the deleted negotiated-transport layer used to. Claims inventory and
existing-check inventory belong to a sibling lens and are not built here.

Provenance: code read from `/local/home/ahrav/scratch/magic-context`, branch
`feat/shared-memory-release-gate-audit`, `HEAD` = `e447c927`. Every line
reference below was printed from that tree before being written. Method contract
in [../../METHOD.md](../../METHOD.md). File list taken verbatim from
[../../part-2-rescope/scope-map-and-risk-ranking.md](../../part-2-rescope/scope-map-and-risk-ranking.md):
`ring_transport.rs` (966), `wire.rs` (973), `frame_channel.rs` (807),
`frame_channel/contract_tests.rs` (701).

Part 1 and Part 2a results are cited, not re-derived. In particular Part 1's
`publication-visibility-derives-only-from-the-published-cursor`,
`no-frame-observable-before-commit`, `release-exactly-once-per-sequence`,
`release-authority-bound-to-lease-ownership`, `receive-failure-leaves-no-wedged-slot`,
and `quarantine-authority-survives-peer-writes` are taken as given for the
transport crate; Part 2a's
`close-disposition-is-a-total-function-of-the-read-exit-cause` and
`a-cancelled-emission-releases-every-permit-it-held` are taken as given for the
connection engine.

## Reachability resolution

The re-scope left the ring's reachability class open, citing three conflicting
signals. It is resolvable from code, and the answer is **default-production**.

The three signals and what each actually proves:

1. `RING_PROFILE` is the string `"mc-host-test-ring-v1"`
   (`ring_transport.rs:31`). This is a profile **name** carried inside the
   descriptor and compared for equality at attach (`:642-644`). It gates
   nothing about whether the ring runs. `docs/mc-host-shm-transport.md:11`
   declares the same literal as the release-fixed profile identity, so the
   string is production identity with a misleading name, not a test marker.
2. `RingClientEndpoint` is doc-commented "Thread-confined peer endpoint for
   integration tests" (`ring_transport.rs:626`). That comment is stale.
   `client.rs:1855` constructs it inside `start_ring_bridge`, which
   `Client::connect_info` reaches on the ordinary connect path
   (`client.rs:346-375`), with no `cfg(test)` and no config gate.
3. `lib.rs:20-21` exports the module as `#[doc(hidden)] pub mod ring_transport`.
   `#[doc(hidden)]` hides it from rustdoc; it does not restrict linkage. The
   re-scope's citation of `lib.rs:21` is correct and worth the refinement that
   the attribute sits on `:20`.

The decisive evidence is that there is no gate at all. `RingTransport` is
constructed unconditionally during host startup at `runtime.rs:872-878`, with
`process_limits` failure turned into a hard `HostError::InitFailed`, and stored
non-optionally as `HostShared.ring` (`runtime.rs:104`). Every authenticated
connection calls `ring.prepare(...)` at `connection.rs:148`. There is no
`Option`, no `if config`, and no alternative branch, which matches
`docs/mc-host-shm-transport.md:7`: "There is no runtime transport selector,
alternate shared-memory backend, compatibility reader, or degraded data path."

So the datapath itself is `default-production`. Two named sub-surfaces inside
the same file are not, and their records say so individually:

- `set_publish_hook` (`ring_transport.rs:229`) and `PublishHook`
  (`:39`) are reached only through `runtime.rs:643-648`
  `run_with_publish_hook`, which is `#[doc(hidden)]`. Its only callers are
  `tests/support/mod.rs:597` and `:614`. Records touching the hook are
  `test-only`.
- `RingClientEndpoint::try_recv_with` (`:694`) is `pub(crate)` and reached from
  `client.rs:1878` in production and from the inline test at `:872-875`. It is
  `default-production`.

One label I could not resolve and do not guess: whether the *host-side*
`RingClientEndpoint` usage in `frame_channel/contract_tests.rs:466-521` is the
only in-tree consumer of `RingClientEndpoint::send`/`recv`. Those two methods
are `pub`, the crate exports the module, and an out-of-tree embedder could call
them; I inspected only this repository.

## Ownership map

Four nested lifetimes, each with a distinct owner. Nothing in this map is
shared between connections except the first level.

**1. Process: `RingTransport`.** Constructed once at `runtime.rs:876`, held as
`Arc<RingTransport>` in `HostShared.ring` (`runtime.rs:104`), so its lifetime is
the host incarnation's. It owns exactly four things: the fixed `TargetProfile`
(`ring_transport.rs:92`), the `AdmissionController` (`:93`), the five lifecycle
counters (`:95-99`), and the optional publish hook (`:100`). It owns **no ring
and no mapping**. The inline test `construction_has_no_ring_side_effects`
(`:770-775`) asserts exactly that. Teardown is `Arc` drop at host shutdown; the
controller's accounting is dropped with it, so quarantined charges do not
outlive the process.

**2. Connection: the `DuplexRing` and its OS thread.** `RingTransport::prepare`
(`:233-313`) is the only constructor. It runs on a Tokio blocking thread
(`connection.rs:148` wraps it in `spawn_blocking`) and does five things in
order: charges admission (`:239-242`), creates the cancellation pair
(`:243-244`), creates the frame queue and the inbound mpsc (`:245-246`), spawns
a named OS thread `mc-host-shm-endpoint` (`:254-256`), and blocks on the
thread's initialization handshake (`:297`).

The `DuplexRing` is created **inside** that thread at `:263` and moved by value
into `run_endpoint` at `:280-289`. It is never returned and never cloned, so
the module doc's claim at `:3-4` — "One dedicated OS thread creates and owns
both `!Send` ring endpoints" — is structurally true: no other thread ever holds
a `Ring`. What crosses the thread boundary is only a JSON descriptor plus two
`OwnedFd` values, over a `sync_channel(1)` (`:247`, `:276`, `:297`).

The thread also owns the `Admission` guard, moved into the closure and consumed
by `admission.release()` at `:291`. Teardown is `run_endpoint` returning, which
drops the `DuplexRing` (unmapping both mappings) inside the `catch_unwind` at
`:279-290`, then releases the charge, then signals `done_tx` at `:292`. That
ordering matches `docs/mc-host-shm-transport.md:49`, "Joined endpoint teardown
returns its admission charge when the mapping is unmapped".

**3. Connection task: `PreparedRing`.** `PreparedRing` (`:103-111`) is the
handle the connection task receives. It carries the descriptor, the two
`OwnedFd`s, a `FrameSender`, a `BoxedReceiver` wrapping `ShmReceiver`, an `io`
future that is just `done_rx.await` (`:301-303`), and the two cancellation
tokens. `connection.rs:149-157` destructures it; `:187` drops the descriptors
after `activate_server` has sent them. The `io` future is spawned as
`AbortOnDropHandle` at `connection.rs:190` and joined at `connection.rs:347`.

**4. Peer: `RingClientEndpoint`.** Owns two attached `Ring` values
(`:627-632`), created by `attach_with_descriptors` (`:636-656`) from the
descriptor and the two received fds. In-process, `client.rs:1842-1893` confines
it to its own OS thread `mc-host-ring-client`. Teardown is thread exit, which
drops both rings and then writes the encoded goodbye on the setup socket
(`client.rs:1890-1893`).

**Who tears the ring down.** Five distinct triggers, and they do not share a
mechanism:

| Trigger | Site | Effect on `run_endpoint` |
| --- | --- | --- |
| `FrameSender::discard()` | `connection.rs:167`, `:181`, `connection.rs:353` | `discard` arm at `ring_transport.rs:424`, `return` |
| `FrameSender::finish()` | `connection.rs:340` | `finish` arm at `:425-428`, drain then `return` at `:419` |
| root token cancel | `connection.rs:168`, `:182`, `gen.token.cancel()` | `root` arm at `:440`, `return` |
| all senders dropped | `PreparedRing` drop | `queue.recv()` yields `None`, `return` at `:438` |
| inbound receiver dropped | `PreparedRing` drop | `inbound.send` fails, `receive_one` returns `Cancelled` at `:483`/`:532` |

Note that `root` is the generation token: `connection.rs:191` passes
`root.clone()` into `new_generation`, so `gen.token` **is** the ring's root
token. Cancelling the generation cancels the ring worker.

## Frame lifecycle map

### Outbound: host to peer

1. **Admission.** `FrameSender::send_ticket_before` (`frame_channel.rs:727-753`)
   allocates the shared `AtomicU8` state at `QUEUED` and pushes a
   `QueuedOutboundFrame` into the bounded mpsc under `timeout_at(deadline, ...)`.
   Admission timeout cancels `retired` and `generation` and returns
   `WriterGone` (`:746-750`).
2. **Selection.** `run_endpoint` takes at most one queued frame per loop pass:
   `queue.try_recv()` after a received inbound frame (`ring_transport.rs:415`),
   `queue.try_recv()` while finishing (`:417`), or the `select!` at `:422-442`.
3. **Publication gate.** `publish_one` (`:536`) calls
   `queued.begin_publication()` (`frame_channel.rs:645-657`), a
   `compare_exchange(QUEUED -> PUBLISHED)`. A losing exchange means the ticket
   was already cancelled, and `publish_one` returns `Ok(())` without touching
   the ring (`ring_transport.rs:542-544`). This is the mechanism behind
   `docs/mc-host-wire-protocol.md:60`, "`not_sent`: sender proves the request
   frame was not published to the ring".
4. **Reserve.** `publish_direct` (`:580-593`) or `publish_owned` (`:595-606`)
   calls `Ring::reserve_until(body_len, header, deadline)` with
   `deadline = now + frame_deadline` (`:559`).
5. **Fill.** `publish_direct` runs the caller's serializer through
   `ReservationWriter` (`:608-624`) inside
   `crate::panic_boundary::redact_sync` (`:586-589`). `publish_owned` writes
   the split body and tail directly (`:602-603`).
6. **Commit — the visibility point.** `reservation.commit(body_len)`
   (`:591`, `:604`). Inside the transport this is
   `commit_reservation` (`ring.rs:1166-1212`), whose final act is
   `published.store(sequence, Ordering::Release)` (`ring.rs:1208`). **That
   release store is the instant the frame becomes visible to the peer**, per
   Part 1's `publication-visibility-derives-only-from-the-published-cursor`.
   `commit_reservation` also rejects a header whose declared `len` disagrees
   with the committed exact length (`ring.rs:1173-1182`,
   `ProducerError::WireHeaderMismatch`).
7. **Local completion.** Back in `publish_one`: `completion.store(COMPLETE,
   Ordering::Release)` (`:567`), then the publish hook (`:568-572`), then the
   `written` local-completion hook (`:573-575`), then `drop(charge)` (`:576`).
   The hooks run **after** peer visibility, and outside the inner
   `catch_unwind` that ends at `:563`.
8. **Storage reuse.** Not the host's decision. Arena bytes become reusable when
   the peer releases the corresponding lease and the producer's reclaim cursor
   advances (Part 1, `reclaim-advance-bounded-by-the-producer-reservation`).

`ProducerReservation::abort` (`ring.rs:1385`) and its `Drop` are the
no-publication paths; `publish_direct`/`publish_owned` never call `abort`
explicitly, relying on `Drop` after their `map_err(|_| ())?` early returns.

### Inbound: peer to host

1. **Acquire.** `receive_one` (`:455`) calls `rings.second.try_receive()`
   (`:464-470`). `Ok(None)` means empty or all `max_leases` leases outstanding,
   and returns `Ok(false)`; `Err` becomes
   `ReadClose::Corrupt("shared-memory receive failed")`.
2. **Header decode and role gate.** `decode_header(&lease.wire_header())`
   (`:471-472`), then `validate_inbound_header(header)` (`:473`), the shared
   structural gate at `frame_channel.rs:58-76`. Both run **while the lease is
   held**, before any body byte is read.
3. **Oversize channel-0 rejection.** `header.ty == Request && channel == 0 &&
   len > MAX_CONTROL_BODY_LEN` (`:474`, cap `65_536` at `wire.rs:374`) releases
   the lease immediately (`:475-477`) and forwards
   `InboundEvent::Rejected { corr }` (`:478-484`). No ingress charge is taken
   and no body byte is read.
4. **Ingress admission.** The loop at `:488-518` retries
   `ingress.try_charge(header.len as usize)` until it succeeds, `read_cancel`
   fires (`:492-494`), or the absolute `frame_deadline` expires
   (`:495-500`, `ReadClose::Overloaded`). Between attempts it services one
   queued outbound frame (`:504-509`) or sleeps `POLL_INTERVAL`
   (`:510-517`). **The receive lease is held across this entire wait**, so one
   of the eight lease slots is occupied for up to `frame_deadline`.
5. **Copy.** `lease.to_vec()` (`:519-521`). This is the single explicit copy;
   `CopyCounter::record_copy()` at `:526` accounts exactly one.
6. **Release — the storage-reuse point.** `lease.release()` (`:522-524`). After
   this call the peer's producer may reclaim that arena range. The host holds
   no reference into shared storage past this line, because `to_vec` already
   moved the bytes into an owned `Vec`.
7. **Handoff.** `InboundFrame::owned(header, body, charge, copies)` (`:528-530`)
   is sent on the bounded inbound mpsc. From there `ShmReceiver::recv`
   (`:354-361`) yields it to `read_loop`, which decodes through
   `decode_contiguous` (`connection.rs:579-587`).

So on the host side the frame's shared-memory life ends at `:524`, and
everything downstream operates on owned bytes. The `ReceiveLease` the connection
engine sees (`frame_channel.rs:309`) is a lease over the host's own `Vec`, not
over the arena.

## Observations

O1. `ring_transport.rs:263` creates the `DuplexRing` inside the spawned thread's
closure, and `:280` moves it by value into `run_endpoint`. No `Ring` value
crosses a thread boundary anywhere in the crate; `PreparedRing`
(`:103-111`) carries no ring field.

O2. `ring_transport.rs:591`, `:604`, and `:670` are the three non-test callers
of `ProducerReservation::commit`. All three write
`.commit(..).map_err(|_| ..)?`, so the returned `ReleaseIdentity`
(`ring.rs:1354`) is dropped at the `?`. The inline tests at `:856`, `:906`,
`:943` and the integration support at `tests/support/raw_client.rs:705`,
`:750`, `:806` also discard it. The only in-tree code that constructs a
`ReleaseIdentity` for a direct `Ring::release` call is
`crates/mc-shm-transport/tests/ring.rs:164-187`.

O3. `admission.release()` (`:291`) is unconditional and sits after the
`catch_unwind` at `:279-290`. `Admission::quarantine`
(`crates/mc-shm-transport/src/profile.rs:566`) has no caller in `mc-host` at
all; its only in-tree callers are `crates/mc-shm-transport/tests/contract.rs:368`
and `:479`.

O4. `run_endpoint`'s publish-failure path (`:447-451`) cancels
`queue.retired` and `root` and returns **without sending anything on
`inbound`**. Dropping the `inbound` sender closes the channel, and
`ShmReceiver::recv` maps a closed channel to
`Err(ReadClose::CleanEof)` (`:359`). `connection.rs:401-404` maps `CleanEof` to
`ReadExit::Peer`.

O5. The outer `catch_unwind` at `:279` discards its result with `let _ =`
(`:279`) and then runs `admission.release()` and `done_tx.send(())` regardless.
The publish hook (`:570`) and the `written` completion hook (`:574`) sit outside
the inner `catch_unwind`, whose scope ends at `:563`.

O6. `prepare` increments `exhaustions` only on `AdmissionController::admit`
failure (`:240`). The four other `RingUnavailable` producers — runtime build or
`DuplexRing::create` failure (`:260-270`), `worker_descriptor` failure
(`:271-275`), thread-spawn failure (`:294-296`), and initialization-channel
failure (`:297`) — increment nothing. `connection.rs:149-164` turns every
`RingUnavailable` into a bare `return` before `activate_server` runs.

O7. `RingTransport::diagnostics` (`:153-207`) can only ever emit
`error_class` `"setup_failure"` (`:187`), and only when
`AdmissionController::snapshot` returns `Err`, which happens only on a poisoned
accounting mutex (`profile.rs:501-505`). `docs/mc-host-shm-transport.md:53-59`
declares five terminal classes. `peer_death` and `resource_exhaustion` appear
only as counters (`:203`, `:205`), never as `error_class`, and `state` stays
`"healthy"` while `exhaustion.observed` is non-zero.

O8. `record_attachment` and `record_activation` are called back to back with no
branch between them (`connection.rs:187-188`), so `attachment.completed` and
`activation.completed` are structurally equal for all time. The
`docs/mc-host-shm-transport.md:66` phrase "completed attachment and activation
counts" implies two independently meaningful values.

O9. `record_reclamation` (`connection.rs:209`) runs after `serve_generation`
returns. On the normal path `serve_generation` awaits `io_task`
(`connection.rs:347`), which completes only after `admission.release()` at
`ring_transport.rs:291`, so the count follows the release. On the
already-draining early return (`connection.rs:273-276`) `serve_generation`
returns without awaiting `io_task`, and `AbortOnDropHandle` aborts the awaiting
task, so `record_reclamation` can be incremented before the charge is returned.

O10. `ReadClose::RejectedDrainFailed` (`frame_channel.rs:47`) and
`ReadClose::Io` (`:45`) have **no producer** at `HEAD`. Their only mentions are
the consuming match arms at `connection.rs:391` and `:403`. Consequently
`ReadExit::PeerKeepQueue`, produced only at `connection.rs:397`, is
unconstructible, and the `serve_generation` arm at `connection.rs:304-308` plus
the `reject_written` bookkeeping at `connection.rs:385` are dead.

O11. `receive_one` reports a `lease.release()` failure as
`ReadClose::Corrupt("shared-memory completion failed")` on both explicit paths
(`:475-477`, `:522-524`). On the `Cancelled` (`:493`, `:513`) and `Overloaded`
(`:499`) returns the lease is dropped instead, and
`ReceiveLease::Drop` (`crates/mc-shm-transport/src/lease.rs:215-221`) calls
`release_once` and discards its `Result` with `let _ =`.

O12. `InboundFrame::segmented` (`frame_channel.rs:477`) has zero callers
anywhere in the tree, including tests. Its attribute reads
`#[allow(dead_code, reason = "shared-memory backends supply wrapped bodies")]`
(`:476`), but the shared-memory backend supplies `InboundFrame::owned`
(`ring_transport.rs:528`). So `ReceiveBody::Segmented` (`:448`) is
unconstructible in production, `with_lease` (`:506`) always yields a contiguous
lease, and `decode_contiguous`'s `None` arm (`connection.rs:586`) is dead.

O13. `frame_channel::LeaseTracker` (`:398-444`), `frame_channel::ProducerReservation`
(`:117`), and `ProducedBody` (`:231`) have no production callers. Every
reference is in `frame_channel/contract_tests.rs` (`:531`, `:564`, `:598`,
`:607`, `:622`, `:675`, `:691`). `ProducedBody::into_charge` (`:283`) has no
caller at all. `ring_transport.rs` uses
`mc_shm_transport::backend::ring::ProducerReservation` (`:14`) instead.

O14. The `received == true` branch of `run_endpoint` (`:409-415`) checks
neither `discard`, nor `finish`, nor `root`. The `select!` at `:422-442` is the
only place those are observed, and it is skipped whenever the previous
`receive_one` returned `Ok(true)`. Likewise `read_cancel.is_cancelled()` is
checked only on the `Ok(false)` branch (`:394`) and inside the budget wait
(`:492`, `:513`). The comment at `:429-435` states the intent: drain frames
committed before the cancellation edge, then report `Cancelled` "after the first
empty observation".

O15. `frame_channel_contract_suite!` is invoked exactly once, with `RingFactory`
(`frame_channel/contract_tests.rs:524`). `RingFactory::connect`
(`:498-521`) builds a **real** `RingTransport` and calls the production
`prepare`, so the suite exercises production code, but no `mc-host` inline unit
test runs in CI (re-scope CI section, `ci.yml` `-p mc-host` invocations all
carry `--test <name>`).

## Candidate properties

### ring-a-endpoint-thread-solely-owns-both-ring-endpoints

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `construction_has_no_ring_side_effects`
(`ring_transport.rs:770-775`) proves the process-level owner holds no ring, and
the `RingFactory` contract suite drives a real `prepare`, but nothing asserts
that no `Ring` value is ever observed from a second thread.
Guarantee: For the whole life of one connection, exactly one OS thread ever
holds either `Ring` of its `DuplexRing`, and no ring handle, mapping pointer, or
arena reference crosses a thread boundary.
Check: `always` — for every prepared connection, the set of thread ids that
touch either `Ring` has cardinality one, and `PreparedRing` contains no field
whose type transitively owns a `Ring`. `always` fits because this is the
premise every other ring property rests on: the transport's single-producer and
single-consumer cursors are unsynchronized between peers of the same direction,
so a second local thread is immediate undefined behaviour, not a degradation.
Fault/timing angle: the window is the whole connection. The specific risk is a
future refactor returning a ring from `prepare` or storing one in
`PreparedRing`; `Ring` is `!Send`, so the compiler catches the direct move, but
a raw pointer, an index into a shared arena, or a `ReceiveLease` smuggled out
through an `unsafe` block would not be caught. `#![deny(unsafe_code)]`
(`lib.rs:8`) currently forecloses that inside `mc-host`.
Required faults and enabling state: none for the structural check. For a
runtime check, an active connection with both directions carrying traffic, so
that a second thread would actually contend.
Confidence: high — [evidence](../evidence/ring-a-endpoint-thread-solely-owns-both-ring-endpoints.md).
Verified by inspection: `DuplexRing::create` at `ring_transport.rs:263` is
inside the thread closure opened at `:256`; `rings` is moved into
`run_endpoint` by value at `:280`; `PreparedRing` (`:103-111`) has seven fields
and none is a `Ring`; the only values crossing the `sync_channel` at `:247` are
a `serde_json::Value` and `[OwnedFd; 2]` (`:276`).
Existing check: `ring_transport.rs:770-775`
`construction_has_no_ring_side_effects` — covers the process owner only, and
does not run in CI. Status unaudited.
Impact: two threads driving one direction's cursors is a data race on the shared
control page, which the transport's `try_receive` would surface as descriptor
validation failure and quarantine at best, and as torn payload delivery at
worst.
Open questions:
- Should `PreparedRing` carry a negative marker, or a compile-fail doctest like
  the two on `frame_channel::ReceiveLease` (`frame_channel.rs:296-308`), so the
  confinement is enforced rather than reviewed?

### ring-a-no-producer-retains-a-committed-release-identity

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — no test asserts the absence, and the value is dropped at
every call site so no test could observe it without a code change.
Guarantee: No host or client producer path retains the `ReleaseIdentity`
returned by `ProducerReservation::commit`, so `Ring::release` is never called
with a producer-derived identity, and the producer-side half of Part 1's
release contract stays unreachable.
Check: `unreachable` — the code location `Ring::release` (`ring.rs:849`) is
never entered with an identity that originated from `commit`
(`ring.rs:1354`). `unreachable` rather than `always(!X)` because this is a
statement about a specific code location being unentered on a specific
argument provenance, which is exactly what location semantics express: the
only entries are through `ring_release_callback` (`ring.rs:1255-1262`) carrying
a lease-derived identity.
Fault/timing angle: none. This is a static call-graph property; the
interleaving risk it *forecloses* is a producer releasing a sequence a consumer
still holds a lease on.
Required faults and enabling state: none. The check is a call-graph assertion,
optionally backed by a `#[cfg(debug_assertions)]` counter on the
producer-identity path.
Confidence: high — [evidence](../evidence/ring-a-no-producer-retains-a-committed-release-identity.md).
Verified by enumerating every `.commit(` call in the tree: the three non-test
producers are `ring_transport.rs:591`, `:604`, `:670`, all of which apply
`map_err(..)?` and discard the `Ok` value; the inline tests `:856`, `:906`,
`:943` and `tests/support/raw_client.rs:705`, `:750`, `:806` also discard it;
`contract_tests.rs:567` and `:600` call the unrelated
`frame_channel::ProducerReservation::commit`, which returns `ProducedBody`.
Existing check: none.
Impact: **Part 1's latency verdict on the producer-side release survives the
refactor.** Part 1 judged `Ring::release`'s producer-facing form latent because
every non-test `commit` caller discarded the identity. The refactor rewrote all
of those callers, and they still discard it. So Part 1's
`release-authority-bound-to-lease-ownership` and
`release-exactly-once-per-sequence` keep their reachability labels on the
producer side, and no re-anchoring of the verdict is needed — only of the line
numbers, from `shm_provider.rs:365` to `ring_transport.rs:591`/`:604`.
Open questions:
- Is the producer-side `ReleaseIdentity` return value intended to stay unused?
  If so, `#[must_use]` on `commit` is currently misleading, and the simpler
  contract would be for `commit` to return `()` and for identities to exist
  only on the consumer side. (needs human input)

### ring-a-admission-charge-releases-on-every-endpoint-thread-exit

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `docs/mc-host-shm-transport.md:79` states the obligation
("Repeated peer crashes must not increase active charges after reclamation")
and `tests/shm_failure_modes` exists, but no test in the 2b file set asserts
per-exit-path charge return.
Guarantee: Every path out of the endpoint thread returns the connection's full
admission charge exactly once, including the initialization-failure paths that
exit before `run_endpoint` is entered.
Check: `always` — after the endpoint thread for a connection has terminated,
`AdmissionController::snapshot().active` has decreased by exactly
`per_connection_limits()` relative to the value just after that connection's
`admit`. `always` fits because a charge stranded on any path is monotone: the
controller has no sweeper, so the leak persists for the host's lifetime and
each occurrence permanently lowers `max_connections`.
Fault/timing angle: the interesting paths are the ones that exit *before* the
`Admission` guard is consumed at `:291`. Two return early inside the closure:
runtime or `DuplexRing::create` failure (`:264-270`) and `worker_descriptor`
failure (`:272-275`). Both drop `admission` rather than calling `release()`, so
correctness depends on `Admission`'s `Drop` (`profile.rs:583-589`) which
releases when the state is still `Active`. A third path, `initialized_tx.send`
failing at `:276-278`, likewise relies on `Drop`.
Required faults and enabling state: one fault per path. `DuplexRing::create`
failure needs shared-memory object creation to fail, reachable by exhausting
`/dev/shm` or the fd limit. `worker_descriptor` failure needs
`Ring::attachment()` to fail. Thread-spawn failure (`:294-296`) exits before
`admit`'s guard leaves the caller, so it needs the guard's `Drop` on the
`prepare` side. A panic inside `run_endpoint` needs the `catch_unwind` at `:279`
to still reach `:291`.
Confidence: high — [evidence](../evidence/ring-a-admission-charge-releases-on-every-endpoint-thread-exit.md).
Verified by inspection: `Admission` carries an `AdmissionState`
(`profile.rs:544-557`) and its `Drop` releases when `Active`
(`profile.rs:583-589`); the explicit `release()` at `ring_transport.rs:291` is
outside the `catch_unwind`, so a panic inside `run_endpoint` still reaches it;
`AdmissionController::release` (`profile.rs:512-520`) is a `checked_sub` that
silently no-ops on underflow, so a double release cannot go negative but also
cannot be detected.
Existing check: none in the 2b file set. `crates/mc-shm-transport/tests/contract.rs:472`
covers `Admission::release` at the transport layer. Status unaudited.
Impact: a stranded charge is permanent. Since `process_limits` multiplies the
per-connection charge by `max_connections` (`ring_transport.rs:75-88`), one
stranded connection's worth of arena bytes permanently removes one connection
slot, and the failure presents much later as `RingUnavailable` on an unrelated
connect with `state: "healthy"` in diagnostics (see
`ring-a-host-doctor-emits-one-of-five-declared-terminal-classes`).
Open questions:
- `AdmissionController::release` swallows a `checked_sub` underflow
  (`profile.rs:516-519`). Is a double release meant to be silent, or should it
  be a detectable accounting fault?

### ring-a-host-never-quarantines-an-admission-charge

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — nothing in `mc-host` can construct the state, so no host
test can reach it.
Guarantee: The host's quarantined-charge accounting is structurally always
zero, because no `mc-host` path calls `Admission::quarantine`; every endpoint
exit, including one caused by ring corruption or a swallowed panic, releases the
charge as if the storage were cleanly recycled.
Check: `unreachable` — the code location `Admission::quarantine`
(`profile.rs:566`) is never entered from any `mc-host` call path.
`unreachable` fits because the subject is a specific unentered function, not a
forbidden state; the derived state claim (`snapshot().quarantined ==
ResourceCharges::ZERO` for every host process) follows from it and is the
cheaper screen.
Fault/timing angle: the window that matters is a `Corrupt` exit. When
`Ring::try_receive` fails descriptor validation it calls `enter_quarantine()`
inside the transport (`ring.rs:808`), so the ring is terminally quarantined per
Part 1's `quarantine-authority-survives-peer-writes`. The host maps that to
`ReadClose::Corrupt` (`ring_transport.rs:467`), exits `run_endpoint` at
`:404`, and still calls `admission.release()` at `:291`. The process-wide
accounting therefore shows the arena bytes as free while the ring that held
them is condemned.
Required faults and enabling state: a descriptor-validation failure on the
peer-to-host direction, which needs a peer that publishes a malformed
descriptor, plus an inspection of `accounting().quarantined` afterwards.
Confidence: high — [evidence](../evidence/ring-a-host-never-quarantines-an-admission-charge.md).
Verified by enumerating `.quarantine()` calls in the tree: the only two are
`crates/mc-shm-transport/tests/contract.rs:368` and `:479`. `mc-host` never
calls it, and `RingTransport` holds no `Admission` value after `prepare` returns
because the guard moved into the thread closure at `:256`.
Existing check: `ring_transport.rs:799-800` asserts
`accounting.quarantined.arena_bytes == 0` on a fresh transport, which is the
same value the property says can never change. Status unaudited.
Impact: the quarantine accounting that
`docs/mc-host-shm-transport.md:21`, `:65`, and `:79` present as a live safety
mechanism is inert on the host. Because the mapping is genuinely unmapped when
`run_endpoint` drops the `DuplexRing`, releasing the charge is arguably correct
and the doc is what is wrong; but the two readings differ on whether a
quarantined ring's arena bytes should be retained against the process bound,
and only a human can settle which was intended.
Open questions:
- Was host-side quarantine accounting deliberately dropped with
  `provider_recovery.rs`, or lost? Part 1's
  `quarantine-charge-transition-is-atomic` cited
  `provider_recovery.rs:187` as its host-side driver, and that file has no
  successor. (needs human input)

### ring-a-publish-failure-is-reported-as-a-clean-peer-close

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — needs an outbound publication that fails while the
connection is otherwise healthy, plus an assertion on the resulting close
disposition rather than on liveness.
Guarantee: An outbound publication failure is reported to the connection engine
with a close cause distinct from a clean peer EOF, so a host-side transport
fault is never attributed to the peer.
Check: `always` — whenever `publish_one` returns `Err`, the cause delivered on
the inbound channel is not `ReadClose::CleanEof`. `always` fits because the
close disposition is a total function of the cause (Part 2a,
`close-disposition-is-a-total-function-of-the-read-exit-cause`) and a
misclassified cause silently selects the wrong teardown every time it occurs.
Fault/timing angle: no interleaving is needed; the misreport is the
straight-line behaviour. `run_endpoint:447-451` cancels `queue.retired` and
`root` and returns without sending on `inbound`. Dropping the sender closes the
channel, and `ShmReceiver::recv` maps a closed channel to
`Err(ReadClose::CleanEof)` (`:359`), which `connection.rs:401-404` maps to
`ReadExit::Peer` — a silent retirement with no terminals and no Goodbye
(`connection.rs:309-315`). The one exception is a publish failure raised from
inside the ingress-budget wait, which does return a distinguishable cause,
`ReadClose::Corrupt("shared-memory publish failed")` (`:506-508`). So the same
fault classifies two different ways depending on which loop observed it.
Required faults and enabling state: an outbound publish failure. Four
mechanisms reach it: reservation deadline expiry under a full host-to-peer ring
(`ring.rs:739`), a wire-header/length disagreement rejected by
`commit_reservation` (`ring.rs:1176-1182`), a panic in the direct serializer
caught at `:560-563`, and `ReservationWriter` exhaustion (`:612-617`). The
cheapest to construct is a peer that attaches and then never receives, filling
the host-to-peer ring until `reserve_until` hits its deadline.
Confidence: high — [evidence](../evidence/ring-a-publish-failure-is-reported-as-a-clean-peer-close.md).
Verified by inspection: `publish_one` returns `Result<(), ()>` (`:541`), so
every distinct cause is erased to a unit before `run_endpoint` sees it; the
`:447-451` block sends nothing; `:359` is the only `CleanEof` producer in the
crate; `connection.rs:401` is the only `CleanEof` consumer.
Existing check: none. `connection.rs:401-404` is the consuming match, not a
check.
Impact: two consequences. Operationally, a host-side ring fault is indexed as a
peer disconnect, so the diagnostics counters and any operator narrative blame
the client. Protocol-wise, `ReadExit::Peer` retires silently and discards the
queued frames (`connection.rs:315-318`), which is the correct handling for a
peer-caused close but means a host-caused close also produces no terminal, so
every pending correlation becomes `outcome_unknown` with no recorded reason.
Open questions:
- Should `publish_one` carry a cause enum rather than `()`? The information
  exists at each of the four failure sites and is discarded at `:564-566`.
- Is the asymmetry between `:506-508` (`Corrupt`) and `:447-451` (`CleanEof`)
  for the identical fault deliberate? (needs human input)

### ring-a-endpoint-thread-panic-is-reported-as-orderly-completion

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — needs an induced panic on the endpoint thread. The publish
hook (`test-only`) is the cheapest injection point, but the property is about
the production `written` hook too.
Guarantee: A panic that escapes `run_endpoint` is distinguishable by the
connection engine from an orderly endpoint exit, and the frame it was
publishing is not left recorded as complete.
Check: `always-or-unreached` — if the outer `catch_unwind` at
`ring_transport.rs:279` observes `Err`, then the connection observes a cause
other than a clean completion, and no `QueuedOutboundFrame` remains in state
`COMPLETE` without having reached the ring. `always-or-unreached` fits because
a panic on this thread is an optional path that a correct build never takes, but
it must be safe when it does; `always` would overstate a requirement that the
path be exercised.
Fault/timing angle: the exposed window is between `:563` and `:576`. The inner
`catch_unwind` protects only the reserve-fill-commit block. A panic in the
publish hook (`:570`), or in the `written` local-completion hook (`:574`),
unwinds `publish_one` and `run_endpoint`, is swallowed by `let _ =` at `:279`,
and then `admission.release()` (`:291`) and `done_tx.send(())` (`:292`) run
exactly as on an orderly exit. Neither `queue.retired` nor `root` is cancelled,
so `FrameSender::send_ticket_before` keeps admitting frames until its own
admission timeout fires (`frame_channel.rs:742-750`), and the `io` future
completes successfully, which `connection.rs:347` reads as a clean join. A
second, narrower window: a panic inside `on_publish()` (`frame_channel.rs:653-655`)
leaves the ticket state at `PUBLISHED` with the frame never written, so a
later `FrameSendTicket::cancel` returns `PossibleSend` for a frame that was
provably not sent, contradicting
`docs/mc-host-wire-protocol.md:60`.
Required faults and enabling state: a panicking hook. `written` is the
production one; `dispatch.rs` supplies it through `OutboundFrame::written`
(`frame_channel.rs:630`). Part 2a owns writer-hook panics on the writer task
(`no-writer-hook-panic-poisons-a-generation-lock`); this is the ring thread, a
different owner, and the panic there has no boundary at all.
Confidence: high — [evidence](../evidence/ring-a-endpoint-thread-panic-is-reported-as-orderly-completion.md).
Verified by inspection: `:279` discards the `catch_unwind` result; the inner
`catch_unwind` closes at `:563`; `:567` stores `COMPLETE` before the hooks run
at `:568-575`; `panic_boundary::redact_sync` wraps only the direct serializer
(`:586-589`) and not the hooks.
Existing check: none for the ring thread. `panic_boundary.rs` is Part 2a scope.
Impact: the host loses its only transport thread and reports success. Frames
admitted after the panic sit in the queue until each hits its admission
deadline, so the connection degrades over `frame_deadline` per frame rather than
retiring, and diagnostics records nothing at all: no `peer_death`, no
`exhaustion`, and `state: "healthy"`.
Open questions:
- Should `:567`'s `COMPLETE` store move after the hooks, or should the hooks
  move inside the inner `catch_unwind`? The two answers differ on whether a
  hook panic should retire the connection.

### ring-a-ring-unavailability-fails-closed-without-a-classified-reason

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the exhaustion sub-case is covered by
`docs/mc-host-shm-transport.md:79`'s stated gate and is counted at
`ring_transport.rs:240`; the other four causes are uncounted and untested.
Guarantee: When the ring cannot be prepared the host refuses the connection
before any application frame can flow, and the refusal is attributable to a
cause rather than presenting as an unexplained socket close.
Check: `always` — for every `prepare` returning `Err(RingUnavailable)`, no
`activate_server` runs on that connection, and exactly one host-observable
record names the cause. The first clause is the fail-closed half and holds; the
second is the reportability half and is where the property is expected to fail.
`always` fits because there is no fallback path to degrade onto: after the
refactor, `docs/mc-host-shm-transport.md:7` makes ring failure terminal for the
connection, so every occurrence must be attributable or the operator has no
signal at all.
Fault/timing angle: none for the fail-closed half; `connection.rs:149-164` is a
straight-line `let ... else { return; }` placed before the
`activate_server` call at `connection.rs:170`. The reportability half has a
timing wrinkle: `connection.rs:158-164` wraps `prepare` in `timeout_at`, and
`spawn_blocking` work cannot be cancelled, so on timeout the blocking task
continues, `prepare` succeeds, and the resulting `PreparedRing` is dropped
inside the blocking task. Dropping a `CancellationToken` does not cancel it, so
teardown falls to the mpsc-closure path at `:438`, and that path is only reached
through the `select!`, which requires `receive_one` to have returned
`Ok(false)`.
Required faults and enabling state: one fault per cause. Admission exhaustion
needs `max_connections` concurrent live rings. `DuplexRing::create` failure
needs shared-memory creation to fail. `worker_descriptor` failure needs
`Ring::attachment()` to fail. Thread-spawn failure needs the thread limit.
`initialized_rx.recv` failure needs the endpoint thread to die between spawn and
handshake. The timeout path needs `prepare` to exceed
`transport_setup_deadline`.
Confidence: high — [evidence](../evidence/ring-a-ring-unavailability-fails-closed-without-a-classified-reason.md).
Verified by inspection: `RingUnavailable` (`:113-122`) is a unit struct with a
fixed `Display` string and no cause field; only `:240` increments a counter;
`connection.rs:149-164`'s `else` branch is a bare `return` that emits no
`ServerMessage`, so the peer observes a closed setup socket and
`activate_client` (`client.rs:367`) reports the generic
`ClientError::new("setup_failed", ...)` at `client.rs:368`.
Existing check: `ring_transport.rs:805` asserts
`diagnostics["exhaustion"]["observed"] == 0` on a fresh transport. Nothing
covers the other four causes. Status unaudited.
Impact: the host fails closed, which is the important half and holds. But four
of five causes are invisible: a host that cannot create shared-memory objects at
all refuses every connection while reporting `state: "healthy"` with all five
counters at zero, and the client sees only `setup_failed`. That is a silent
total outage of the only datapath.
Open questions:
- Should `RingUnavailable` carry a closed cause class matching the doctor's
  five terminal classes (`docs/mc-host-shm-transport.md:53-59`)?
- On the `prepare` timeout path, should the connection task cancel the ring it
  abandoned? It currently relies on sender-drop, which the `received == true`
  branch can defer (see
  `ring-a-cancellation-close-requires-an-empty-inbound-observation`).

### ring-a-lease-release-failure-is-observable-only-on-the-success-path

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — needs a `release` that fails, which needs a quarantined or
identity-mismatched ring while a lease is held.
Guarantee: A receive-lease completion failure is reported on every inbound path
that holds a lease, not only on the paths that go on to deliver a frame.
Check: `always` — for every `receive_one` invocation that acquired a lease, if
the underlying `Ring::release` returns `Err` then the invocation returns a
`ReadClose` other than the cause it would have returned had the release
succeeded. `always` fits because a lease that fails to release does not free
its slot, so the loss is cumulative against `max_leases` = 8
(`ring_transport.rs:50`) and eight silent failures wedge the direction.
Fault/timing angle: the two explicit release calls (`:475-477` for the oversize
rejection and `:522-524` on the delivery path) map `Err` to
`ReadClose::Corrupt("shared-memory completion failed")`. The three early
returns that hold a lease do not: `Cancelled` at `:493`, `Overloaded` at
`:499`, and `Cancelled` at `:513` all drop the lease, and
`ReceiveLease::Drop` (`crates/mc-shm-transport/src/lease.rs:215-221`) calls
`release_once` and discards its `Result`. So exactly the paths taken under
cancellation and overload — the paths most likely to coincide with a stressed or
quarantined ring — are the ones that cannot report a completion failure.
Required faults and enabling state: a held lease **and** a release failure.
`Ring::release` returns `Err` on quarantine (`ring.rs:850-851`), wrong incarnation
(`:853-854`), wrong lane (`:856-857`), stale sequence (`:868-870`), and duplicate
release
(`lease.rs:200`). Quarantine is the reachable one: a peer publishes a malformed
descriptor on a *later* sequence, `try_receive` quarantines, and a lease taken
earlier then fails to release. Constructing that needs two frames in flight and
a lease held across the ingress-budget wait.
Confidence: high — [evidence](../evidence/ring-a-lease-release-failure-is-observable-only-on-the-success-path.md).
Verified by inspection: `receive_one`'s five return points that follow a
successful `try_receive` are `:477`, `:484`, `:493`, `:499`, `:513`, `:521`,
`:524`, `:532`, `:533`; of those, only `:477` and `:524` route a release error;
`lease.rs:215-221` discards the drop-path `Result` with `let _ =`.
Existing check: `crates/mc-shm-transport/tests/ring.rs:256`
`quarantine_rejects_all_operations_and_reports_conservation` covers the
transport-side `Err(Quarantined)` from `release`, not the host's handling of it.
Status unaudited.
Impact: this is the host-side counterpart of Part 1's
`release-failure-is-observable`, which Part 1 marked `medium` confidence with
its host anchor at `shm_provider.rs:365`. That anchor is gone; the surviving
host behaviour is the asymmetry above. Scoped correctly after investigation: all
three untracked paths return an `Err(ReadClose::..)` that ends the read loop
(`:404`), so a silent release failure always coincides with the connection
retiring and cannot accumulate across its life. What is lost is the signal that
the ring was quarantined rather than merely overloaded, and that matters because
`ReadClose::Overloaded`'s own doc comment (`frame_channel.rs:40-43`) asserts
"the peer and the transport are healthy" — false on a quarantined ring. Today
`connection.rs:401-404` collapses `Corrupt` and `Overloaded` into the same
`ReadExit::Peer`, so the gap is latent and becomes live only if that taxonomy is
split.
Open questions:
- Should the `Overloaded` and `Cancelled` paths release explicitly and upgrade a
  release failure to `Corrupt`? Investigation found this buys nothing until
  `connection.rs:401-404` stops collapsing the two causes into one `ReadExit`,
  so the two changes travel together or not at all.

### ring-a-reclamation-count-does-not-witness-charge-release

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — needs a connection that retires while the host is already
draining, plus a read of `accounting()` at the moment the counter increments.
Guarantee: The `reclamation.completed` value that `diagnostics()` reports is
never larger than the number of connections whose admission charge has actually
been returned.
Check: `always` — at every observation, `diagnostics()["reclamation"]["completed"]`
is at most the number of endpoint threads that have executed
`admission.release()`. `always` fits because the counter is a monotone
diagnostic: a single premature increment permanently overstates reclamation, and
`docs/mc-host-shm-transport.md:79` makes "active charges after reclamation" a
release gate, so an operator reading the count as a witness of release draws a
false conclusion.
Fault/timing angle: the ordering holds on the normal path and breaks on one
early return. Normally `serve_generation` awaits `io_task` at
`connection.rs:347`; `io` is `done_rx.await` (`ring_transport.rs:301-303`) and
`done_tx.send(())` runs at `:292`, after `admission.release()` at `:291`. So
`record_reclamation` at `connection.rs:209` follows the release. But
`connection.rs:273-276` returns from `serve_generation` without awaiting
`io_task`, and `io_task` is an `AbortOnDropHandle` (`connection.rs:190`), so the
awaiting task is aborted. Control returns to `connection.rs:209`, which
increments the counter while the endpoint thread may still be running. The
window is bounded only by how long `run_endpoint` takes to observe
`writer.discard()` (`connection.rs:353` via
`discard_unregistered_generation`), which the `received == true` branch can
defer indefinitely.
Required faults and enabling state: a connection that reaches
`serve_generation` and finds `shared.draining` already set or
`shared.shutdown` already cancelled — that is, a connection accepted and
authenticated during the shutdown sequence.
Confidence: high — [evidence](../evidence/ring-a-reclamation-count-does-not-witness-charge-release.md).
Verified by inspection: `connection.rs:208-209` places `record_reclamation`
after the `serve_generation` await, and an inner `return` at `:275` still
returns there; `AbortOnDropHandle` aborts on drop; `ring_transport.rs:291-292`
orders release before the done signal.
Existing check: `ring_transport.rs:804` asserts
`diagnostics["reclamation"]["completed"] == 1` after a direct
`record_reclamation()` call, which exercises the counter and not the ordering.
Status unaudited.
Impact: the exact metric a release gate would read as proof that charges came
back can be incremented before they did. The gate would pass on a host that is
in fact still holding the charge.
Open questions:
- Should `record_reclamation` move onto the endpoint thread, immediately after
  `admission.release()`, so the counter is release-witnessed by construction?

### ring-a-host-doctor-emits-one-of-five-declared-terminal-classes

Type: reachability
Reachability: default-production
Status: active
Exercised: partial — `ring_transport.rs:787-788` asserts the healthy shape;
nothing constructs a terminal shape.
Guarantee: Every terminal error class that the doctor contract declares has a
producer in the host's diagnostics path.
Check: `reachable` — each of `missing_addon`, `identity_mismatch`,
`setup_failure`, `peer_death`, `resource_exhaustion` is emitted as
`diagnostics()["error_class"]` by at least one host code path. `reachable` is
location coverage over five distinct emission points and is the right semantics
because the claim is about code that should execute; the finding is that four of
the five points do not exist at all.
Fault/timing angle: none. This is a static enumeration of the `match` at
`ring_transport.rs:176-190`, which has exactly two arms.
Required faults and enabling state: for the one existing producer, a poisoned
accounting mutex, since `AdmissionController::snapshot` returns `Err` only on
`Mutex` poisoning (`profile.rs:501-505`). That needs a panic while the
accounting lock is held, which no host path takes.
Confidence: high — [evidence](../evidence/ring-a-host-doctor-emits-one-of-five-declared-terminal-classes.md).
Verified by grepping the five literals across `crates` and `packages`:
`"setup_failure"` appears in Rust only at `ring_transport.rs:187`; the other
four appear only in TypeScript, at
`packages/plugin/src/shared/mc-host-client/types.ts:69-73` and
`shared-memory-failure.ts:14-30`, where they classify *client-side* errors.
`peer_death` and `resource_exhaustion` exist host-side only as counters
(`ring_transport.rs:203`, `:205`), and `state` stays `"healthy"` while
`exhaustion.observed` is non-zero because the `match` keys on `accounting()`
alone.
Existing check: `ring_transport.rs:787-805` covers the healthy branch and all
five counters. No check covers the terminal branch. Status unaudited.
Impact: `docs/mc-host-shm-transport.md:53-59` promises the operator a
five-class terminal taxonomy from `magic-context daemon doctor`. The host can
report only `setup_failure`, and only on a condition it never creates. A host
that has refused every connection for capacity, or lost every endpoint thread
to a hook panic, reports `state: "healthy"`.
Open questions:
- Is the five-class taxonomy the *client's* contract only, with the host
  intended to expose counters and let the client classify? The doc attributes it
  to `magic-context daemon doctor`, which is host-side.
  (needs human input)

### ring-a-rejected-drain-failure-close-has-no-producer

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — unconstructible; no test can reach it without a code
change.
Guarantee: Every `ReadClose` variant the connection engine handles is
producible by the transport, so the engine's close taxonomy has no dead arm and
`docs/mc-host-wire-protocol.md:321`'s authoritative-early-terminal guarantee
has a live carrier.
Check: `reachable` — the code location `connection.rs:397`
(`ReadExit::PeerKeepQueue`) is executed at least once per campaign.
`reachable` fits because the claim is location coverage over a specific branch,
and the finding is that no input can reach it.
Fault/timing angle: none. Static producer enumeration.
Required faults and enabling state: for the branch to be reachable at all, the
transport would have to emit `ReadClose::RejectedDrainFailed` after an
oversize channel-0 rejection whose realignment failed. On the ring there is no
realignment: a frame is one descriptor, and `receive_one:475-477` releases the
lease and returns `Ok(true)` with no drain step.
Confidence: high — [evidence](../evidence/ring-a-rejected-drain-failure-close-has-no-producer.md).
Verified by grepping both variants: `ReadClose::RejectedDrainFailed` appears at
`frame_channel.rs:47` (declaration) and `connection.rs:391` (consumer) and
nowhere else; `ReadClose::Io` appears at `frame_channel.rs:45` and
`connection.rs:403` and nowhere else. `ReadExit::PeerKeepQueue` is produced only
at `connection.rs:397`, so the `serve_generation` arm at
`connection.rs:304-308` and the `reject_written` bookkeeping at
`connection.rs:385` are dead. `#[allow(dead_code)]` on the `ReadClose` enum
(`frame_channel.rs:32`) is what keeps this compiling silently.
Existing check: none. Part 2a's
`the-client-body-budget-refusal-drain-is-never-entered` is the closest analogue
and was written against the deleted `frame_read.rs`.
Impact: the wire contract at `docs/mc-host-wire-protocol.md:321` promises that
an early oversize-control terminal "is authoritative for its correlation even
if the declared body then truncates, stalls, or EOFs". On the ring that
promise is satisfied vacuously, since there is no separate body to truncate,
but the engine still carries the machinery that would have honoured it. The
risk is not a current defect; it is that the dead arm looks like coverage.
Open questions:
- Should `RejectedDrainFailed` and `Io` be removed, or retained for a future
  transport? Removing them would make Part 2a's drain records genuinely closed
  rather than superseded.

### ring-a-segmented-inbound-body-has-no-production-producer

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — unconstructible from any host path.
Guarantee: The zero-copy segmented inbound path that the frame-channel
abstraction and the transport doc both describe has a production producer, so
the copy accounting and the wrap-around lease handling are exercised.
Check: `reachable` — the code location `InboundFrame::segmented`
(`frame_channel.rs:477`) is executed at least once per campaign.
`reachable` fits because this is location coverage; the derived state claim,
that every host inbound frame carries exactly one copy, is what a cheaper
screen would assert.
Fault/timing angle: none. Static producer enumeration. The interesting
consequence is that a body wrapping the arena end is copied twice on the peer
side of the in-process client (`client.rs:1878` charges then
`try_recv_with` calls `lease.to_vec()` at `ring_transport.rs:706`) and once on
the host side, and neither ever takes the segmented path.
Required faults and enabling state: for the segmented path to matter at all, a
body whose descriptor spans two arena ranges, which the transport produces when
`span_count == 2` (`ring.rs:816-823`). That is reachable: it needs a body that
straddles the arena wrap point. But `receive_one` collapses it with
`lease.to_vec()` (`:519`) before the host ever sees the span structure.
Confidence: high — [evidence](../evidence/ring-a-segmented-inbound-body-has-no-production-producer.md).
Verified by grepping: `InboundFrame::segmented` has zero call sites in the
tree, including tests. `ReceiveBody::Segmented` (`frame_channel.rs:448`) is
therefore unconstructible, so `with_lease` (`:506-513`) always takes the
`Owned` arm and `decode_contiguous`'s `None` arm (`connection.rs:586`) is dead.
`ring_transport.rs:528` is the only `InboundFrame` constructor call on the
host path and it uses `owned`.
Existing check: `frame_channel/contract_tests.rs:141` calls `with_lease` and
asserts `lease.segment(0)`, on a hand-built frame. Status unaudited.
Impact: two things. First, the attribute at `frame_channel.rs:476` reads
`#[allow(dead_code, reason = "shared-memory backends supply wrapped bodies")]`
and that reason is false at `HEAD`: the shared-memory backend supplies `owned`.
A stale suppression reason is how a genuinely dead branch survives review.
Second, `docs/mc-host-shm-transport.md:19` says the receiver "validates the
descriptor and header before exposing a scoped lease", which is true of the
transport but not of the host boundary: the host exposes a lease over its own
copy.
Open questions:
- Is the segmented path intended to return, or should
  `InboundFrame::segmented`, `ReceiveBody::Segmented`, and
  `frame_channel::LeaseTracker` be deleted together? `LeaseTracker`
  (`frame_channel.rs:398-444`), `frame_channel::ProducerReservation`
  (`:117`), and `ProducedBody` (`:231`) are in the same position: test-only,
  with `ProducedBody::into_charge` (`:283`) having no caller at all.

### ring-a-cancellation-close-requires-an-empty-inbound-observation

Type: liveness
Reachability: default-production
Status: active
Exercised: partial — `budget_wait_observes_read_cancellation`
(`ring_transport.rs:928-965`) covers cancellation observed *inside* the
ingress-budget wait, which is the one path that does not need an empty
observation. The main loop's path is uncovered.
Guarantee: After the generation is cancelled, the endpoint thread reports
`ReadClose::Cancelled` and exits within a bounded number of further inbound
frames.
Check: `always` — evaluated at the end of an explicit bounded window: run
sustained inbound traffic, cancel `read_cancel`, stop the peer's publication,
then poll until the endpoint thread has exited, and assert it exited within one
`POLL_INTERVAL` (`ring_transport.rs:33`, 50 microseconds) of the first empty
inbound observation and within the connection's `frame_deadline` overall.
`always` rather than `sometimes` because the assertion is a bound that must hold
every time the window closes, not a state to reach. The bound is stated in the
units the code bounds — one loop pass per received frame, one `POLL_INTERVAL`
sleep, and the absolute `frame_deadline` on the budget wait — so no unbounded
"eventually" is asserted, per the METHOD liveness rule.
Fault/timing angle: the whole property. `run_endpoint`'s `received == true`
branch (`:409-415`) checks neither `discard`, `finish`, `root`, nor
`read_cancel`; the `select!` at `:422-442` is the only observer and it is
skipped whenever `receive_one` returned `Ok(true)`. `read_cancel` is checked
only on the `Ok(false)` branch (`:394`) and inside the budget wait (`:492`,
`:513`). The comment at `:429-435` documents this as intent: drain
pre-cancellation frames, then report `Cancelled` "after the first empty
observation". The consequence is that a peer that keeps the peer-to-host ring
non-empty defers the cancellation report for as long as it keeps publishing.
The escape hatch is that the host also stops draining: once the connection task
drops the `BoxedReceiver`, `inbound.send` fails and `receive_one` returns
`Cancelled` (`:483`, `:532`). So the true bound is "until the inbound channel
closes or the ring goes empty", not "until cancellation".
Required faults and enabling state: an attached peer publishing continuously,
enough ingress budget that each `try_charge` succeeds immediately, and a
cancellation of `root` or `read_cancel` from the host side while that traffic
continues. `connection.rs:199-204`'s peer-death handler is one natural trigger,
since it cancels `peer_gen.token` — which is `root` — while frames may still be
queued in the ring.
Confidence: medium — [evidence](../evidence/ring-a-cancellation-close-requires-an-empty-inbound-observation.md).
The code structure is verified by inspection and the intent is stated in the
comment at `:429-435`. What I did not verify is the exact behaviour of
`read_loop` under cancellation, so I cannot state whether the host reliably
stops draining and closes the inbound channel promptly; that is why this is
medium and not high, and it is the open question below.
Existing check: `ring_transport.rs:928-965`
`budget_wait_observes_read_cancellation` covers only the budget-wait path, and
`mc-host` inline tests do not run in CI. Status unaudited.
Impact: a cancelled generation's endpoint thread can keep consuming and
forwarding peer frames after the close decision. Since the charge is released
only when the thread exits (`:291`), a peer that floods during teardown extends
the window in which a retiring connection still holds its full admission charge,
which is exactly the pressure that turns an ordinary retirement into
`RingUnavailable` for the next connect.
Open questions:
- Does `read_loop` stop draining the inbound channel promptly on
  `read_cancel`, closing the channel and bounding this window? That is in
  Part 2a's `connection.rs` scope and I did not resolve it.
- Should the `received == true` branch check `root.is_cancelled()`, at the cost
  of dropping frames the current comment deliberately drains?

### ring-a-ingress-wait-holds-a-lease-while-servicing-egress

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — no test holds a lease across a saturated ingress budget
while an outbound frame is published from inside that wait.
Guarantee: The state in which one receive lease is held across a saturated
ingress-budget wait while the same loop publishes a queued outbound frame occurs
at least once.
Check: `sometimes` — at least once per campaign, observe both preconditions
jointly: `receive_one` is inside the loop at `:488-518`, meaning a lease is held
and `try_charge` has failed at least once; and the publish branch at `:504-509`
executed during that same invocation. `sometimes` rather than `reachable`
because executing those lines is not the point: a campaign can run the
budget-wait branch and the publish-from-wait branch in separate invocations
without ever producing the operational state in which they coincide. Per the
METHOD coverage rule this asserts the independent preconditions, not a
violation, so the marker still fires on a correct implementation.
Fault/timing angle: this is the state where the ingress budget and the outbound
deadline interact. The ingress budget is process-wide, a single `ByteBudget`
built at `runtime.rs:896-902` and cloned into every connection at
`connection.rs:144`, so pressure originating elsewhere in the host stalls this
receive. The comment at `:501-503` states the design response: the wait services
queued outbound frames so "a slow ingress drain holds only this receive, not the
connection's sends, which would otherwise miss their deadlines behind it". The
wait can run for the full `frame_deadline` before the `Overloaded` exit at
`:495-500`, polling every `POLL_INTERVAL` (`:33`, 50 microseconds) when the
outbound queue is empty. Scoped after investigation: an earlier draft also
required `active_leases == max_leases` on the peer-to-host direction. That is
unreachable and the clause is dropped. `receive_one` holds at most one lease at
a time, every return path releases or drops it, and `run_endpoint` calls
`receive_one` serially, so the host's contribution to `active_leases` is bounded
by one against a budget of eight (`:32`, `:50`).
Required faults and enabling state: an ingress budget too small for the frame in
hand, so `try_charge` fails at least once; and at least one queued outbound
frame at the moment the loop polls, so `:504-509` runs. A second iteration with
an empty queue additionally covers the `POLL_INTERVAL` sleep at `:514`.
Confidence: high — [evidence](../evidence/ring-a-ingress-wait-holds-a-lease-while-servicing-egress.md).
Verified by inspection: the lease is bound at `:464` and not released until
`:524`, so it is live for the whole `:488-518` loop; the publish-from-wait
branch is `:504-509`; the deadline exit is `:495-500`; `run_endpoint` calls
`receive_one` serially at `:380-391`, and every `receive_one` return path
releases or drops its lease.
Existing check: two inline tests are each one precondition short.
`copied_control_frame_records_one_host_adapter_copy` (`:881-926`) uses
`ByteBudget::new(1024)` (`:915`), so the loop is never entered.
`budget_wait_observes_read_cancellation` (`:928-965`) uses `ByteBudget::new(0)`
(`:949`) and does enter it, but its sender queue is empty (`:944-945`), so
`:504-509` never runs. Neither runs in CI. Status unaudited.
Impact: if this state is never reached, three mechanisms are untested together.
The `Overloaded` exit at `:495-500`, whose `ReadClose::Overloaded` doc
(`frame_channel.rs:40-43`) asserts "the peer and the transport are healthy" — an
assertion this record's window can falsify. The outbound servicing the comment
at `:501-503` justifies. And the longest window in which host code holds a
reference into shared storage, which is where Part 1's
`quarantine-authority-survives-peer-writes` scenario has the most room. It is
also the enabling state for
`ring-a-lease-release-failure-is-observable-only-on-the-success-path` and for
observing the `Corrupt`-versus-`CleanEof` asymmetry in
`ring-a-publish-failure-is-reported-as-a-clean-peer-close`, so leaving it
unreached leaves both unfalsifiable.
Open questions:
- Should `receive_one` distinguish "ring empty" from "leases saturated"? Both
  arrive as `Ok(None)` from `try_receive` (`ring.rs:770-778`, `:783-785`) and
  both collapse to `Ok(false)` at `:468-470`. Investigation found this is moot
  under the current single-active-lease design and would matter only for a
  concurrently-leasing consumer, so it is a latent API gap rather than a live
  one.

## Contract-vs-code leads

The re-scope notes that the `mandatory-ring-architecture` grep gate
(`ci.yml:41-58`) now enforces the deletions, so the prose docs may lag the code.
Each lead below cites both sides and does not resolve in favour of the doc.

L1. **Scoped lease at the host boundary.**
`docs/mc-host-shm-transport.md:19` — "A receiver validates the descriptor and
header before exposing a scoped lease." `docs/mc-host-wire-protocol.md:294` —
"The receiver MUST validate all offsets, lengths, sequence metadata, header
fields, and descriptor identity before exposing a scoped receive lease."
Code: the transport does exactly this (`ring.rs:803-845`). The host does not
expose that lease. `receive_one:519-524` copies the body with
`lease.to_vec()` and then releases, and hands the connection engine
`InboundFrame::owned` (`:528`). The `ReceiveLease` the engine later sees
(`frame_channel.rs:309`, reached from `connection.rs:584`) is a lease over the
host's own `Vec`. Both readings can be true at different layers; the docs do not
distinguish them, and a reader would conclude the host consumer sees shared
storage.

L2. **Quarantined accounting presented as live.**
`docs/mc-host-shm-transport.md:21` — "Active and quarantined charges are
reported separately." `:65` — "active and quarantined accounting". `:79` —
"quarantined charges remain within the configured process bound."
Code: `diagnostics()` reports both fields (`ring_transport.rs:180-183`), but
`Admission::quarantine` (`profile.rs:566`) has no `mc-host` caller, so the
quarantined figure is structurally zero. See
`ring-a-host-never-quarantines-an-admission-charge`.

L3. **Doctor terminal taxonomy.**
`docs/mc-host-shm-transport.md:53-59` — `magic-context daemon doctor` "reports
either a healthy fixed ring or one terminal class", listing five.
Code: `ring_transport.rs:176-190` has two arms and can emit only
`"setup_failure"` (`:187`). The other four literals exist only in TypeScript
(`packages/plugin/src/shared/mc-host-client/types.ts:69-73`). See
`ring-a-host-doctor-emits-one-of-five-declared-terminal-classes`.

L4. **Two counts that cannot diverge.**
`docs/mc-host-shm-transport.md:66` — "completed attachment and activation
counts", presented as two values.
Code: `connection.rs:187-188` calls `record_attachment()` and
`record_activation()` back to back with no branch between them, so
`attachment.completed` and `activation.completed` are equal forever. The
lifecycle diagram at `docs/mc-host-shm-transport.md:26-36` has a distinct
`Attached -> Failed` edge for "validation, attach, or commit fails", which the
counters cannot witness. Not raised as its own record because the consequence is
confined to diagnostics; folded here and into
`ring-a-host-doctor-emits-one-of-five-declared-terminal-classes`'s open
questions.

L5. **Oversize-control drain on a transport with nothing to drain.**
`docs/mc-host-wire-protocol.md:321` — the host "MUST NOT buffer the oversize
body, and drains and discards the declared bytes under the frame's absolute
deadline to preserve stream alignment (deadline expiry closes the generation as
usual)".
Code: `receive_one:474-485` releases the single lease and returns; there is no
drain, no deadline on the rejection, and no stream to realign. The "MUST NOT
buffer" clause holds; the drain clause is inapplicable to a descriptor
transport, and the machinery that would have implemented it is dead. See
`ring-a-rejected-drain-failure-close-has-no-producer`.

L6. **Writer verifies header length.**
`docs/mc-host-wire-protocol.md:298` — "Writers MUST verify header `len` equals
body length".
Code: neither `publish_direct` (`:580-593`) nor `publish_owned` (`:595-606`)
compares the header's `len` field against the body it is about to write; the
header is opaque bytes. The check exists one layer down, in
`commit_reservation` (`ring.rs:1173-1182`, `ProducerError::WireHeaderMismatch`).
So the obligation is met, but the detection point is the ring commit, and
`publish_one` erases the cause to `()` (`:564-566`), which routes into
`ring-a-publish-failure-is-reported-as-a-clean-peer-close`.

L7. **Stale doc comments inside the code.**
`ring_transport.rs:626` calls `RingClientEndpoint` a "Thread-confined peer
endpoint for integration tests", but `client.rs:1855` uses it on the production
connect path. `frame_channel.rs:476` suppresses dead-code on
`InboundFrame::segmented` with `reason = "shared-memory backends supply wrapped
bodies"`, but `ring_transport.rs:528` supplies `owned`. Both were the evidence
that made the re-scope's reachability question look unresolvable; both are
simply out of date.

## Open questions

- Does `read_loop` (`connection.rs:387` onward) stop draining the inbound
  channel promptly on `read_cancel`? That is what bounds
  `ring-a-cancellation-close-requires-an-empty-inbound-observation`, and
  `connection.rs` is Part 2a scope, so I read only the close-classification
  match at `:387-405` and did not audit the loop's cancellation handling.
- Was host-side quarantine accounting deliberately dropped with
  `provider_recovery.rs`, or lost in the refactor? Part 1's
  `quarantine-charge-transition-is-atomic` and
  `custody-terminal-transition-exactly-once` both cited that file as the
  host-side driver. The transport-side machinery is intact; nothing in
  `mc-host` drives it. (needs human input)
- Should `publish_one`'s four distinct failure causes be preserved rather than
  erased to `()`? The information exists at each site and the connection engine
  already has a `ReadClose` taxonomy that could carry it. (needs human input)
- Is the doctor's five-class terminal taxonomy the client's contract only, with
  the host intended to expose counters? `docs/mc-host-shm-transport.md:53`
  attributes it to `magic-context daemon doctor`, which is host-side.
  (needs human input)
- What does `bun run check:shm-architecture` (`ci.yml:58`) actually assert? It
  is the gate keeping the deleted transports deleted, and several records here
  depend on nothing reintroducing a fallback path. I did not read
  `scripts/check-mc-shm-architecture.test.ts`; the re-scope raised the same
  question and it is still open.
- Are `RingClientEndpoint::send` and `recv` (`:659`, `:676`) used by any
  out-of-tree embedder? They are `pub` on a `#[doc(hidden)] pub mod`
  (`lib.rs:20-21`), which hides them from rustdoc but not from linkage. I
  inspected only this repository, so the `default-production` label on records
  touching them covers in-tree use only. (needs human input)
