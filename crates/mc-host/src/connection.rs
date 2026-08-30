//! One authenticated connection generation: admission, per-generation state,
//! the frame read loop, and consumer liveness.
//!
//! A generation owns its correlation watermark, membership lookups, pending
//! correlation index, ping namespace, and writer — but never a route's
//! cleanup, which stays with the global registry (plan KTD5).

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use crate::wire::{FrameType, HEADER_LEN};
use tokio::net::UnixStream;
use tokio::sync::OwnedSemaphorePermit;
use tokio::time::{timeout_at, Instant};
use tokio_util::sync::CancellationToken;
use tokio_util::task::{AbortOnDropHandle, TaskTracker};

use crate::control::{parse_control, ControlAction, CODE_INVALID_CONTROL_REQUEST};
use crate::dispatch::{
    close_generation, dispatch_request, emit_error_terminal, handle_cancel, open_route,
};
use crate::frame_channel::{
    FrameReceiver, FrameSender, InboundEvent, OutboundFrame, ReadClose, RejectedFrame,
};
use crate::handler::McHostHandler;
use crate::ring_transport::PreparedRing;
use crate::routing::CloseDecision;
use crate::runtime::HostShared;
use crate::wire::{encode_owned_frame, pure_header_flags, FrameId};

/// Key of one pending consumer request: (channel, epoch, correlation).
/// Direction is implied — this map holds only consumer-originated requests;
/// host Pings live in their own namespace (protocol §8.3, V43).
pub type PendingKey = (u16, u32, u64);

/// Concurrent off-reader `server_busy` rejection emissions per generation.
/// Small: rejections only queue this deep when global pending capacity is
/// exhausted AND egress is contended. Past the bound the generation is
/// retired (token cancelled, writer discarded) rather than stalling the sole
/// reader on contended egress, which is what this bound exists to prevent.
const MAX_INFLIGHT_BUSY_REJECTS: usize = 32;

/// One outstanding host Ping.
///
/// Acceptance is decided by comparing WHEN the Pong was observed against WHEN
/// the Ping's write COMPLETED — never by which side won the `pings` mutex.
/// The writer captures `completed_at` the instant `write_all` returns, before
/// taking any lock, so:
///
/// * a Pong observed at-or-after `completed_at` is accepted even if the read
///   loop won the mutex race or the writer task was preempted for longer than
///   a round trip (the bytes were demonstrably on the wire); and
/// * a Pong observed before `completed_at` is a pre-answer for a Ping whose
///   bytes did not yet exist, so it is discarded and the probe still demands
///   a real answer.
///
/// Comparing against write START (rather than completion) would admit
/// pre-answers; requiring the mutex transition to precede the Pong would drop
/// legitimate ones. The residual case — a peer that received the bytes but
/// answers without reading them — is indistinguishable from a real answer to
/// any observer, and is still caught by the writer's per-frame stall deadline
/// once that peer stops draining its socket.
pub struct PingProbe {
    pub flags: u8,
    pub sent: Instant,
    pub written_at: Option<Instant>,
    pub answered_at: Option<Instant>,
}

pub struct PendingEntry {
    pub cancel: CancellationToken,
    pub settlement: Arc<crate::dispatch::Settlement>,
}

/// Generation-owned state shared with the registry and dispatch tasks.
pub struct GenerationCore {
    pub id: u64,
    /// Cancelling retires the generation: reads stop, admitted work settles as
    /// cancelled, emits fail closed.
    pub token: CancellationToken,
    /// Stops the read side and generation-local frame producers without
    /// retiring the writer needed to flush already-started terminals.
    pub read_cancel: CancellationToken,
    /// Read-loop work that can enqueue frames independently of route drains.
    /// Shutdown closes and joins this set before queuing connection Goodbye.
    pub read_tasks: TaskTracker,
    /// Releases the connection owner after shutdown has queued Goodbye, so it
    /// cannot tear down the writer while the producer fence is draining.
    pub shutdown_complete: CancellationToken,
    pub writer: FrameSender,
    /// channel -> epoch for routes this generation may dispatch on. Lookup
    /// only; the registry owns insertion at bind and removal at close.
    pub membership: Mutex<HashMap<u16, u32>>,
    pub pending: Mutex<HashMap<PendingKey, PendingEntry>>,
    /// Outstanding host-originated Pings: correlation -> (flags byte, sent at).
    pub pings: Mutex<HashMap<u64, PingProbe>>,
    /// Bounds concurrent off-reader `server_busy` rejection emissions so a
    /// client flooding control frames past global capacity cannot grow
    /// unbounded tasks through them.
    pub busy_rejects: Arc<tokio::sync::Semaphore>,
    pub next_ping_corr: std::sync::atomic::AtomicU64,
}

/// Runs one accepted setup socket to completion: authenticate, transfer the
/// fixed ring descriptors, commit activation, then retain the socket only as
/// peer-lifetime evidence while application frames use the ring.
///
/// `handshake_permit` is held from before the first byte is read; it releases
/// on every exit path once authenticated capacity is acquired or the socket
/// dies (protocol §5.1).
///
/// This task owns the setup socket and ring candidate together. Any setup
/// failure or unexpected socket closure retires that exact ring generation.
pub async fn run_connection<H: McHostHandler>(
    shared: Arc<HostShared<H>>,
    mut stream: UnixStream,
    handshake_permit: OwnedSemaphorePermit,
) {
    let auth = crate::auth::authenticate_server(
        &mut stream,
        shared.auth_key.bytes(),
        &shared.daemon_id,
        &shared.daemon_ver,
        shared.timing.auth_deadline,
    )
    .await;
    // `role` is unverified reporting metadata; every valid proof gets identical
    // admission regardless of it (protocol §5.2).
    if auth.is_err() {
        return;
    }

    // Authentication promotion linearizes here: authenticated capacity is
    // acquired before the generation becomes visible anywhere, and only then
    // is the handshake slot released (plan KTD10).
    let Ok(connection_permit) = shared.connection_permits.clone().try_acquire_owned() else {
        return;
    };
    drop(handshake_permit);
    let _connection_permit = connection_permit;

    let ring = Arc::clone(&shared.ring);
    let ingress = shared.ingress_budget.clone();
    let queue_frames = shared.limits.writer_queue_frames;
    let frame_deadline = shared.timing.frame_deadline;
    let prepared =
        tokio::task::spawn_blocking(move || ring.prepare(ingress, queue_frames, frame_deadline));
    let Ok(Ok(Ok(PreparedRing {
        descriptor,
        descriptors,
        sender,
        receiver,
        io,
        root,
        read_cancel,
    }))) = timeout_at(
        Instant::now() + shared.timing.transport_setup_deadline,
        prepared,
    )
    .await
    else {
        return;
    };
    let Ok(token) = activation_token() else {
        sender.discard();
        root.cancel();
        return;
    };
    if crate::setup_socket::activate_server(
        &mut stream,
        &descriptors,
        &descriptor,
        crate::wire::PROTOCOL_VERSION,
        mc_shm_transport::descriptor::DESCRIPTOR_SCHEMA_VERSION,
        token.as_str(),
        shared.timing.transport_setup_deadline,
    )
    .await
    .is_err()
    {
        sender.discard();
        root.cancel();
        return;
    }
    drop(descriptors);
    shared.ring.record_attachment();
    shared.ring.record_activation();

    let io_task = AbortOnDropHandle::new(shared.tracker.spawn(io));
    let gen = new_generation(&shared, root.clone(), read_cancel.clone(), sender);
    let peer_gen = Arc::clone(&gen);
    let peer_read_cancel = read_cancel.clone();
    let peer_ring = Arc::clone(&shared.ring);
    shared.spawn_tracked(gen.read_tasks.track_future(async move {
        tokio::select! {
            biased;
            () = peer_read_cancel.cancelled() => {}
            close = crate::setup_socket::observe_peer(&mut stream) => {
                if close != crate::setup_socket::PeerClose::Goodbye {
                    peer_ring.record_peer_death();
                }
                peer_gen.token.cancel();
                peer_gen.read_cancel.cancel();
            }
        }
    }));
    serve_generation(&shared, gen, receiver, io_task).await;
    shared.ring.record_reclamation();
}

fn activation_token() -> Result<String, ()> {
    activation_token_with(|bytes| getrandom::getrandom(bytes).map_err(|_| ()))
}

fn activation_token_with(fill: impl FnOnce(&mut [u8; 32]) -> Result<(), ()>) -> Result<String, ()> {
    let mut bytes = [0u8; 32];
    fill(&mut bytes)?;
    Ok(bytes
        .iter()
        .fold(String::with_capacity(64), |mut text, byte| {
            use std::fmt::Write;
            let _ = write!(text, "{byte:02x}");
            text
        }))
}

fn new_generation<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    token: CancellationToken,
    read_cancel: CancellationToken,
    writer: FrameSender,
) -> Arc<GenerationCore> {
    Arc::new(GenerationCore {
        id: shared.gen_counter.fetch_add(1, Ordering::SeqCst),
        token,
        read_cancel,
        read_tasks: TaskTracker::new(),
        shutdown_complete: CancellationToken::new(),
        writer,
        membership: Mutex::new(HashMap::new()),
        pending: Mutex::new(HashMap::new()),
        pings: Mutex::new(HashMap::new()),
        busy_rejects: Arc::new(tokio::sync::Semaphore::new(MAX_INFLIGHT_BUSY_REJECTS)),
        next_ping_corr: std::sync::atomic::AtomicU64::new(1),
    })
}

/// Serves one finalized frame channel to retirement: register, read, drain,
/// close. Returns the candidate handoff if the read loop granted one, so the
/// caller can promote or reap it after this channel is fully torn down.
async fn serve_generation<H: McHostHandler, C: FrameReceiver>(
    shared: &Arc<HostShared<H>>,
    gen: Arc<GenerationCore>,
    channel: C,
    mut io_task: AbortOnDropHandle<()>,
) {
    // Retained past `gen`: the writer must be told to stop even when a
    // handler still holds a sender clone through a retained RequestCtx.
    let writer_finish = gen.writer.clone();
    // Register the read loop before publishing the generation. Its tracker
    // token prevents shutdown from observing an empty producer set between
    // insertion and the first read-loop poll.
    let read_task = gen
        .read_tasks
        .track_future(read_loop(shared, &gen, channel));
    {
        let mut connections = shared.connections.lock().expect("connections lock");
        // The token check closes the window between a committed
        // `host.shutdown` (which cancels the token) and the shutdown
        // sequence storing `draining`: a socket accepted just before the
        // commit must not register a new generation after it.
        if shared.draining.load(Ordering::SeqCst) || shared.shutdown.is_cancelled() {
            discard_unregistered_generation(&gen);
            return;
        }
        connections.insert(gen.id, Arc::clone(&gen));
    }
    if let Some(policy) = shared.liveness.clone() {
        // A child of `read_cancel` so retirement still stops the loop; the
        // grant path cancels only this child to stop Pings alone.
        let stop = gen.read_cancel.child_token();
        let gen_ping = Arc::clone(&gen);
        shared.spawn_tracked(gen.read_tasks.track_future(liveness_loop(
            gen_ping,
            policy,
            stop.clone(),
        )));
    }

    let read_exit = read_task.await;
    gen.read_cancel.cancel();
    match read_exit {
        // Graceful shutdown stopped the reader directly: everything keeps
        // draining in protocol order. A cancellation INHERITED from the
        // generation token (liveness invalidation, emission failure) is a
        // retirement, not a drain — fall through to the silent close.
        ReadExit::HostCancelled if !gen.token.is_cancelled() => {}
        // Oversized-control drain failure: wait for exactly the promised
        // authoritative terminal to reach the socket (protocol §7.1) — the
        // emission self-bounds via its admission and write deadlines, and a
        // failed emission drops the sender — then retire silently like every
        // other peer exit, discarding whatever else is queued.
        ReadExit::PeerKeepQueue(terminal_written) => {
            let _ = terminal_written.await;
            gen.token.cancel();
            gen.writer.discard();
        }
        // Peer-initiated or error retirement closes silently — even while
        // the host is draining: cancelling the generation token makes queued
        // off-reader emissions fail closed, and discarding the writer drops
        // frames already queued, so a client that sent a corrupt frame never
        // receives terminals or a Goodbye after the close decision
        // (protocol §6.3).
        ReadExit::HostCancelled | ReadExit::Peer => {
            gen.token.cancel();
            gen.writer.discard();
        }
    }
    // Mark generation-owned routes closing BEFORE waiting for in-flight
    // binds: the route.open wrappers below run inside `read_tasks`, and a
    // bind completing during that wait must observe `close_requested`
    // (finishing through CloseWins) instead of installing a route onto a
    // generation that is about to retire.
    let begun_closes = shared.registry.begin_close_generation(gen.id);
    gen.read_tasks.close();
    gen.read_tasks.wait().await;
    if shared.draining.load(Ordering::SeqCst) {
        gen.shutdown_complete.cancelled().await;
    }

    close_generation(shared, &gen, begun_closes).await;
    // The candidate driver (tracked in `read_tasks`, so already joined) is
    // the only writer of the promotion slot; taking the handoff after the
    // wait is what makes the transfer race-free.
    drop(gen);
    // Every legitimate producer is done (read tasks joined, routes closed,
    // generation dropped); any surviving sender is an inert handler-held
    // clone, so close the queue explicitly rather than waiting for it.
    writer_finish.finish();
    // The writer drains queued terminals and Goodbye after the handles drop.
    // Its own per-frame stall deadline (`frame_deadline`, enforced inside the
    // writer task) already bounds this join, so no extra budget applies here:
    // the old `route_close_budget` cap could abort a drain that graceful
    // shutdown promised to flush, while a stalled peer still cannot hold the
    // join beyond the writer's self-retirement.
    let _ = (&mut io_task).await;
}

fn discard_unregistered_generation(gen: &GenerationCore) {
    gen.read_cancel.cancel();
    gen.token.cancel();
    gen.writer.discard();
}

/// Why the read side of a connection stopped. Only a host-cancelled read may
/// keep the writer draining: every peer-driven exit (EOF, corruption, peer
/// Goodbye, protocol violation) retires silently, even mid-shutdown.
/// `PeerKeepQueue` marks the one exception: an oversized-control drain
/// failure whose early terminal is authoritative for its correlation
/// (protocol §7.1) and must flush despite the otherwise-silent close.
enum ReadExit {
    HostCancelled,
    Peer,
    /// An oversized-control drain failure whose early terminal is
    /// authoritative for its correlation (protocol §7.1): the receiver fires
    /// when exactly that frame is on the socket, letting the close fence the
    /// one promised frame and then discard everything else.
    PeerKeepQueue(tokio::sync::oneshot::Receiver<()>),
}

/// Serves validated frames until close. Returning retires the generation.
async fn read_loop<H: McHostHandler, C: FrameReceiver>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    mut channel: C,
) -> ReadExit {
    // Highest consumer Request correlation seen; any non-increasing Request
    // closes the generation before dispatch (protocol §8.3, V44). A promoted
    // candidate starts at 2 so application correlations begin at 3 (§7.7.4).
    let mut watermark: u64 = 0;
    // Written-signal of the most recent rejected-frame terminal: if the
    // transport's realignment then fails, the close fences exactly that
    // authoritative frame (protocol §7.1).
    let mut reject_written: Option<tokio::sync::oneshot::Receiver<()>> = None;

    loop {
        let event = match channel.recv().await {
            Ok(event) => event,
            Err(ReadClose::Cancelled) => return ReadExit::HostCancelled,
            Err(ReadClose::RejectedDrainFailed) => {
                // The queued early terminal is authoritative for its
                // correlation even when the declared body then fails
                // (protocol §7.1): the close stays silent otherwise, but
                // that one frame must survive to flush.
                return match reject_written.take() {
                    Some(terminal_rx) => ReadExit::PeerKeepQueue(terminal_rx),
                    None => ReadExit::Peer,
                };
            }
            Err(ReadClose::CleanEof)
            | Err(ReadClose::Corrupt(_))
            | Err(ReadClose::Io(_))
            | Err(ReadClose::Overloaded) => return ReadExit::Peer,
        };

        match event {
            InboundEvent::Rejected(RejectedFrame { corr }) => {
                // The correlation is trustworthy from the header alone; the
                // early terminal is authoritative even if the transport's
                // drain then fails (protocol §7.1). The watermark still
                // applies first. Emitted off-reader (bounded) like the other
                // no-permit rejections so contended egress cannot block this
                // reader from a queued Pong while the declared body waits to
                // be drained.
                if corr <= watermark {
                    return ReadExit::Peer;
                }
                watermark = corr;
                // Off-reader like the other rejections (contended egress
                // must not block this reader from a queued Pong), but with a
                // written-signal: if the transport's body drain on the next
                // `recv` fails, the close fences exactly this authoritative
                // frame (protocol §7.1). Rejected frames consume no pending
                // permit, so the per-generation rejection semaphore is what
                // bounds these emissions. Acquired BEFORE spawning: past the
                // bound a peer streaming oversize bodies would otherwise
                // accumulate tasks, oneshots, and captured Arcs, so
                // exhaustion retires instead.
                let Ok(reject_permit) = gen.busy_rejects.clone().try_acquire_owned() else {
                    gen.token.cancel();
                    gen.writer.discard();
                    return ReadExit::Peer;
                };
                let (terminal_tx, terminal_rx) = tokio::sync::oneshot::channel();
                reject_written = Some(terminal_rx);
                let shared_task = Arc::clone(shared);
                let gen_task = Arc::clone(gen);
                shared.spawn_tracked(gen.read_tasks.track_future(async move {
                    let _reject_permit = reject_permit;
                    crate::dispatch::emit_authoritative_rejection(
                        &shared_task,
                        &gen_task,
                        FrameId::control(corr),
                        CODE_INVALID_CONTROL_REQUEST,
                        "control body exceeds profile cap",
                        terminal_tx,
                    )
                    .await;
                }));
            }
            InboundEvent::Frame(frame) => {
                let header = frame.header;
                match header.ty {
                    FrameType::Request => {
                        if header.corr <= watermark {
                            return ReadExit::Peer;
                        }
                        watermark = header.corr;
                        if header.channel == 0 {
                            let (corr, action) = decode_control_frame(frame, &shared.targets);
                            handle_control(shared, gen, corr, action).await;
                        } else {
                            if header.epoch == 0 {
                                return ReadExit::Peer;
                            }
                            dispatch_request(shared, gen, frame.into_owned()).await;
                        }
                    }
                    FrameType::Cancel => {
                        // Structural shape: current nonzero route, nonzero
                        // correlation (protocol §6.2 table).
                        if header.channel == 0 || header.epoch == 0 || header.corr == 0 {
                            return ReadExit::Peer;
                        }
                        handle_cancel(gen, (header.channel, header.epoch, header.corr));
                    }
                    FrameType::Pong => {
                        if header.channel != 0 || header.corr == 0 {
                            return ReadExit::Peer;
                        }
                        let now = Instant::now();
                        let mut pings = gen.pings.lock().expect("pings lock");
                        match pings.get_mut(&header.corr) {
                            // The echo must match what we sent exactly
                            // (protocol V35). A matching Pong for a probe the
                            // writer has not yet confirmed written is retained
                            // for the write-completion hook to reconcile.
                            Some(probe) if probe.flags == header.flags.0 => {
                                match probe.written_at {
                                    // Completion recorded: `sent` is the
                                    // completion instant, so the deadline
                                    // applies here. Scheduler delay must not
                                    // extend it — a late Pong leaves the
                                    // probe for expiry.
                                    Some(_) => {
                                        let in_deadline =
                                            shared.liveness.as_ref().is_none_or(|p| {
                                                now.duration_since(probe.sent) < p.pong_deadline
                                            });
                                        if in_deadline {
                                            pings.remove(&header.corr);
                                        }
                                    }
                                    // Completion unknown: `sent` is only the
                                    // provisional enqueue instant, so no
                                    // deadline can be evaluated yet (a Ping
                                    // queued behind large frames would
                                    // otherwise have its answer rejected
                                    // before it was even written). Park the
                                    // arrival; the hook decides against the
                                    // completion instant.
                                    None => probe.answered_at = Some(now),
                                }
                            }
                            _ => {}
                        }
                    }
                    FrameType::Goodbye => {
                        if header.channel == 0 {
                            if header.corr != 0 {
                                return ReadExit::Peer;
                            }
                            // Orderly connection close (protocol §9.4).
                            return ReadExit::Peer;
                        }
                        if header.epoch == 0 || header.corr != 0 {
                            return ReadExit::Peer;
                        }
                        // The Closing transition is synchronous, so any later
                        // frame on this route observes `unknown_channel`; the
                        // drain and route-gone callback run on a tracked task
                        // because awaiting them here would stall every other
                        // frame on this connection — including Pong replies,
                        // which missed-Pong invalidation would misread as a
                        // dead peer.
                        let handle = crate::handler::RouteHandle {
                            channel: header.channel,
                            epoch: header.epoch,
                        };
                        let decision = shared.registry.begin_close_owned(handle, gen.id);
                        // Duplicate, stale, or mid-bind Goodbyes carry no
                        // cleanup work; spawning for them would let a client
                        // pipeline unbounded no-op tasks past the pure-header
                        // frames' zero capacity cost.
                        if matches!(decision, CloseDecision::Owner { .. }) {
                            let shared_task = Arc::clone(shared);
                            shared.spawn_tracked(gen.read_tasks.track_future(async move {
                                crate::dispatch::close_route_decision(
                                    &shared_task,
                                    handle,
                                    decision,
                                )
                                .await;
                            }));
                        }
                    }
                    // Consumer-originated role violations close the generation
                    // rather than extend the profile (protocol §6.2). Ping is
                    // host-to-consumer only; a consumer Ping would demand an
                    // implicit host-Pong extension, so it closes too.
                    FrameType::Response
                    | FrameType::StreamData
                    | FrameType::StreamEnd
                    | FrameType::Error
                    | FrameType::Push
                    | FrameType::Hello
                    | FrameType::HelloAck
                    | FrameType::Ping => return ReadExit::Peer,
                }
            }
        }
    }
}

/// Runs `decode` over the frame's body as one contiguous byte slice. A body
/// that wraps the ring arena end flattens through the explicit copying adapter
/// first. Only decoded values leave the lease scope.
fn decode_contiguous<T>(
    frame: &crate::frame_channel::InboundFrame,
    decode: impl FnOnce(&[u8]) -> T,
) -> T {
    let copies = frame.copy_counter();
    frame.with_lease(|lease| match lease.contiguous_bytes() {
        Some(body) => decode(body),
        None => decode(&lease.to_owned(&copies)),
    })
}

fn decode_control_frame(
    frame: crate::frame_channel::InboundFrame,
    targets: &crate::control::TargetIndex,
) -> (u64, ControlAction) {
    let corr = frame.header.corr;
    let binary = frame.header.flags.is_binary();
    let action = decode_contiguous(&frame, |body| parse_control(body, binary, targets));
    (corr, action)
}

async fn handle_control<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    corr: u64,
    action: ControlAction,
) {
    // Every channel-0 request — including semantic rejections — is one
    // consumer request against the global unsettled bound; at capacity the
    // no-dispatch `server_busy` terminal takes precedence over the semantic
    // error (protocol §8.3).
    //
    // A reserved-class target's `route.open` draws on ITS pool, matching
    // routed dispatch: charging route establishment to the general pool
    // would make the carve-out unreachable under exactly the general-load
    // saturation it exists to survive — the reserved permits would sit idle
    // while the module could not open the route needed to use them.
    let pending_pool = match &action {
        ControlAction::RouteOpen { target, .. }
            if shared.targets.class_of(&target.module_id)
                == Some(crate::handler::RouteClass::Reserved) =>
        {
            &shared.reserved_pending_permits
        }
        _ => &shared.pending_permits,
    };
    let Ok(pending_permit) = pending_pool.clone().try_acquire_owned() else {
        crate::dispatch::emit_rejection(
            shared,
            gen,
            FrameId::control(corr),
            crate::control::CODE_SERVER_BUSY,
            "pending request capacity exhausted",
        )
        .await;
        return;
    };

    match action {
        ControlAction::Reject { code, message } => {
            // Emission can wait on shared egress budget; queue it off the
            // read loop so a contended budget cannot stall Pong reads into a
            // liveness false-kill. Bounded: the permit was acquired above.
            let shared_task = Arc::clone(shared);
            let gen_task = Arc::clone(gen);
            shared.spawn_tracked(gen.read_tasks.track_future(async move {
                let _pending_permit = pending_permit;
                emit_error_terminal(
                    &shared_task.egress_budget,
                    &gen_task,
                    FrameId::control(corr),
                    code,
                    &message,
                )
                .await;
            }));
        }
        ControlAction::CatalogList { module_id_filter } => {
            // Catalog stays serviceable during drain (protocol §12 step 1
            // freezes routes and dispatch, not control reads). Emitted off
            // the read loop for the same liveness reason as rejections.
            let shared_task = Arc::clone(shared);
            let gen_task = Arc::clone(gen);
            shared.spawn_tracked(gen.read_tasks.track_future(async move {
                let _pending_permit = pending_permit;
                let body = shared_task.catalog.body(module_id_filter.as_deref());
                if emit_catalog_response(
                    &shared_task.egress_budget,
                    &gen_task,
                    FrameId::control(corr),
                    body,
                )
                .await
                .is_err()
                {
                    gen_task.token.cancel();
                }
            }));
        }
        ControlAction::HostShutdown => {
            let shared_task = Arc::clone(shared);
            let gen_task = Arc::clone(gen);
            shared.spawn_tracked(gen.read_tasks.track_future(async move {
                let _pending_permit = pending_permit;
                crate::dispatch::handle_host_shutdown(&shared_task, &gen_task, corr).await;
            }));
        }
        ControlAction::HostStatus => {
            let shared_task = Arc::clone(shared);
            let gen_task = Arc::clone(gen);
            shared.spawn_tracked(gen.read_tasks.track_future(async move {
                let _pending_permit = pending_permit;
                let report = shared_task
                    .health_snapshot
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone();
                let body = crate::control::host_status_response_json(
                    &report,
                    shared_task.ring.diagnostics(),
                );
                if emit_catalog_response(
                    &shared_task.egress_budget,
                    &gen_task,
                    FrameId::control(corr),
                    &body,
                )
                .await
                .is_err()
                {
                    gen_task.token.cancel();
                }
            }));
        }
        ControlAction::RouteOpen { target, identity } => {
            // Bind callbacks may be slow; never stall the read loop on them.
            // Abort-exempt: this wrapper owns its route's cleanup (rejected
            // or close-raced binds still get exactly-once route-gone), so the
            // forced shutdown path must let it finish; every await inside is
            // self-bounded.
            let shared_task = Arc::clone(shared);
            let gen_task = Arc::clone(gen);
            shared.spawn_lifecycle(gen.read_tasks.track_future(async move {
                let _pending_permit = pending_permit;
                open_route(shared_task, gen_task, corr, target, identity).await;
            }));
        }
    }
}

/// Clones a startup-cached catalog only after its encoded size is charged,
/// then transfers that charge unchanged to the connection writer.
async fn emit_catalog_response(
    budget: &crate::wire::ByteBudget,
    gen: &GenerationCore,
    id: FrameId,
    body: &[u8],
) -> Result<(), ()> {
    if body.len() > crate::wire::MAX_BODY_LEN as usize
        || gen.writer.is_retired()
        || gen.token.is_cancelled()
    {
        return Err(());
    }
    let deadline = gen.writer.admission_deadline();
    let frame = reserve_catalog_frame(budget, gen, deadline, id, body).await?;
    gen.writer
        .send_before(frame, deadline)
        .await
        .map_err(|_| ())
}

async fn reserve_catalog_frame(
    budget: &crate::wire::ByteBudget,
    gen: &GenerationCore,
    deadline: Instant,
    id: FrameId,
    body: &[u8],
) -> Result<OutboundFrame, ()> {
    let frame_bytes = body.len().checked_add(HEADER_LEN).ok_or(())?;
    let charged_bytes = u32::try_from(frame_bytes).map_err(|_| ())?;
    let charge = tokio::select! {
        biased;
        () = gen.token.cancelled() => return Err(()),
        charge = timeout_at(deadline, budget.charge(charged_bytes)) => match charge {
            Ok(charge) => charge,
            Err(_) => {
                gen.token.cancel();
                return Err(());
            }
        },
    };
    if gen.token.is_cancelled() {
        return Err(());
    }

    // Capacity includes the eventual header, so encoding does not need a
    // second allocation while the cached bytes are copied.
    let mut owned_body = Vec::with_capacity(frame_bytes);
    owned_body.extend_from_slice(body);
    let bytes = encode_owned_frame(
        FrameType::Response,
        crate::wire::response_flags(false, true),
        id,
        owned_body,
    )
    .map_err(|_| ())?;
    Ok(OutboundFrame {
        bytes,
        tail: Vec::new(),
        direct: None,
        charge,
        written: None,
    })
}

/// Host-side Ping issuance. The correlation namespace is host-owned and
/// independent of consumer correlations (protocol §8.3): a Ping correlation
/// numerically equal to a pending consumer correlation cannot cross-settle
/// because Pongs only match this map.
async fn liveness_loop(
    gen: Arc<GenerationCore>,
    policy: crate::config::LivenessPolicy,
    stop: CancellationToken,
) {
    let mut next_ping_at = Instant::now() + policy.ping_interval;
    loop {
        // Wake at the sooner of the next Ping tick and the earliest
        // outstanding Pong deadline: the deadline wake honors
        // `pong_deadline` exactly, and the tick wake notices an answered
        // Pong so the next Ping is not delayed until the old deadline.
        let wake_at = {
            let pings = gen.pings.lock().expect("pings lock");
            pings
                .values()
                .filter(|probe| probe.written_at.is_some())
                .map(|probe| probe.sent + policy.pong_deadline)
                .min()
                .map_or(next_ping_at, |deadline| deadline.min(next_ping_at))
        };
        tokio::select! {
            () = stop.cancelled() => return,
            () = tokio::time::sleep_until(wake_at) => {}
        }
        let now = Instant::now();
        let expired = {
            let pings = gen.pings.lock().expect("pings lock");
            pings.values().any(|probe| {
                probe.written_at.is_some() && now.duration_since(probe.sent) >= policy.pong_deadline
            })
        };
        if expired && policy.invalidate_on_missed {
            gen.token.cancel();
            return;
        }
        {
            let mut pings = gen.pings.lock().expect("pings lock");
            if expired {
                pings.clear();
            } else if !pings.is_empty() {
                // An unexpired Ping is outstanding; no new Ping is added
                // beside it. Advance the tick so the next wake makes
                // progress — re-arming a past tick would spin this task
                // until the Pong arrived or its deadline expired.
                next_ping_at = now + policy.ping_interval;
                continue;
            }
        }
        if now < next_ping_at {
            // Woke for a Pong deadline that was answered in time; the next
            // Ping still waits for its tick.
            continue;
        }
        next_ping_at = now + policy.ping_interval;
        let corr = gen.next_ping_corr.fetch_add(1, Ordering::SeqCst);
        let flags = pure_header_flags();
        // The entry must exist before the Ping can reach the wire, or the
        // read loop would drop a fast Pong as unmatched.
        gen.pings.lock().expect("pings lock").insert(
            corr,
            PingProbe {
                flags: flags.0,
                sent: Instant::now(),
                written_at: None,
                answered_at: None,
            },
        );
        let bytes = crate::wire::encode_owned_frame(
            FrameType::Ping,
            flags,
            crate::wire::FrameId::control(corr),
            Vec::new(),
        )
        .expect("header-only Ping always encodes");
        let (written_tx, written_rx) = tokio::sync::oneshot::channel();
        // The hook runs inside the writer task at write completion, so the
        // probe is answerable the instant the Ping can reach the peer — an
        // async notification would leave a gap where a fast (or adversarial
        // pre-answering) Pong races the flag update.
        let gen_probe = Arc::clone(&gen);
        let pong_deadline = policy.pong_deadline;
        let written_hook = Box::new(move |completed_at: Instant| {
            let mut pings = gen_probe.pings.lock().expect("pings lock");
            if let Some(probe) = pings.get_mut(&corr) {
                match probe.answered_at {
                    // A Pong the read loop parked while completion was
                    // unrecorded: accept it only if it followed the bytes and
                    // landed inside the deadline measured from completion.
                    Some(answered_at)
                        if answered_at >= completed_at
                            && answered_at.duration_since(completed_at) < pong_deadline =>
                    {
                        pings.remove(&corr);
                    }
                    // No answer yet, or a pre-answer: arm the deadline from
                    // completion so the peer owes a real Pong.
                    _ => {
                        probe.answered_at = None;
                        probe.sent = completed_at;
                        probe.written_at = Some(completed_at);
                    }
                }
            }
            let _ = written_tx.send(());
        });
        let send = gen.writer.send(crate::frame_channel::OutboundFrame {
            bytes,
            tail: Vec::new(),
            direct: None,
            charge: crate::wire::ByteCharge::none(),
            written: Some(written_hook),
        });
        let sent = tokio::select! {
            biased;
            () = stop.cancelled() => return,
            sent = send => sent,
        };
        if sent.is_err() {
            return;
        }
        // Wait for write completion before arming expiry: the hook above
        // already anchored the deadline and flipped `written` inside the
        // writer task; this await only paces the loop.
        tokio::select! {
            () = stop.cancelled() => return,
            written = written_rx => {
                if written.is_err() {
                    // Writer retired before the Ping reached the socket.
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame_channel::frame_sender;
    use std::time::Duration;

    #[test]
    fn activation_entropy_failure_is_redacted_without_panicking() {
        let result = std::panic::catch_unwind(|| activation_token_with(|_| Err(())));
        assert!(matches!(result, Ok(Err(()))));
    }

    #[tokio::test]
    async fn shutdown_registration_rejection_leaves_no_graceful_drain_work() {
        let token = CancellationToken::new();
        let read_cancel = token.child_token();
        let (writer, queue) = frame_sender(1, token.clone(), Duration::from_secs(1));
        let gen = GenerationCore {
            id: 1,
            token,
            read_cancel,
            read_tasks: TaskTracker::new(),
            shutdown_complete: CancellationToken::new(),
            writer,
            membership: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            pings: Mutex::new(HashMap::new()),
            busy_rejects: Arc::new(tokio::sync::Semaphore::new(1)),
            next_ping_corr: std::sync::atomic::AtomicU64::new(1),
        };

        discard_unregistered_generation(&gen);

        assert!(gen.read_cancel.is_cancelled());
        assert!(gen.token.is_cancelled());
        assert!(queue.discard.is_cancelled());
        gen.read_tasks.close();
        tokio::time::timeout(Duration::from_millis(10), gen.read_tasks.wait())
            .await
            .expect("never-started read loop must not force shutdown");
    }
}
