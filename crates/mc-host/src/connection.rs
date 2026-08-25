//! One authenticated connection generation: admission, per-generation state,
//! the frame read loop, and consumer liveness.
//!
//! A generation owns its correlation watermark, membership lookups, pending
//! correlation index, ping namespace, and writer — but never a route's
//! cleanup, which stays with the global registry (plan KTD5).

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use subc_protocol::FrameType;
use tokio::net::TcpStream;
use tokio::sync::OwnedSemaphorePermit;
use tokio::time::{timeout_at, Instant};
use tokio_util::sync::CancellationToken;
use tokio_util::task::{AbortOnDropHandle, TaskTracker};

use crate::control::{parse_control, ControlAction, CODE_INVALID_CONTROL_REQUEST};
use crate::dispatch::{
    close_generation, dispatch_request, emit_error_terminal, emit_frame, handle_cancel, open_route,
};
use crate::frame_channel::{
    BoxedReceiver, FrameReceiver, FrameSender, InboundEvent, OutboundFrame, ReadClose,
    RejectedFrame,
};
use crate::handler::McHostHandler;
use crate::routing::CloseDecision;
use crate::runtime::HostShared;
use crate::tcp_frame_channel::TcpFrameChannel;
use crate::transport_negotiation::{
    activate_response_json, commit_response_json, decode_activate_request, decode_commit_request,
    encode_negotiate_response, FallbackReason, NegotiateRequest, NegotiateResponse,
    NegotiationError, SelectedTransport, ACTIVATION_CORRELATION, COMMIT_CORRELATION,
    NEGOTIATION_VERSION, TRANSPORT_TCP,
};
use crate::transport_provider::{
    fresh_activation_token, Candidate, GrantBinding, GrantRecord, InjectedProvider,
    PreflightEligibility, PreparedCandidate, ProviderContext, TCP_CAPABILITY_VERSION,
};
use crate::wire::{encode_owned_frame, pure_header_flags, response_flags, FrameId};

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

/// A running liveness loop and the token that stops only it, so a grant can
/// stop and join bootstrap Pings without retiring the rest of the
/// generation.
pub struct LivenessHandle {
    pub stop: CancellationToken,
    pub task: tokio::task::JoinHandle<()>,
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
    /// The generation's liveness loop, if one runs. Taken by the grant path
    /// to stop and join it before publishing a selection.
    pub liveness: Mutex<Option<LivenessHandle>>,
}

/// Runs one accepted socket to completion: authenticate, promote into
/// authenticated capacity, then serve frames until retirement.
///
/// `handshake_permit` is held from before the first byte is read; it releases
/// on every exit path once authenticated capacity is acquired or the socket
/// dies (protocol §5.1).
///
/// This task is the connection's setup owner: it holds the authenticated
/// connection permit for the whole setup (bounding prepared candidates by
/// `max_connections`), owns the bootstrap and candidate cancellation roots,
/// keeps the generation visible to shutdown through the connection registry,
/// and reaps the unpromoted candidate and its I/O task. A TCP selection
/// (explicit or by omission) keeps serving the bootstrap channel directly; a
/// committed grant retires the bootstrap and serves the promoted candidate
/// with a fresh generation whose application correlations start at 3.
pub async fn run_connection<H: McHostHandler>(
    shared: Arc<HostShared<H>>,
    mut stream: TcpStream,
    handshake_permit: OwnedSemaphorePermit,
) {
    let _ = stream.set_nodelay(true);
    let auth = subc_transport::authenticate_server(
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

    // Generation tokens are independent roots rather than children of the
    // shutdown token. Admission stops when `shutdown` fires, but the drain must
    // still emit terminals and a Goodbye on a live generation, so only
    // `shutdown_sequence` may retire these — in protocol order.
    let gen_token = CancellationToken::new();
    let read_cancel = gen_token.child_token();
    let (read_half, write_half) = stream.into_split();
    let (writer, channel, channel_io) = TcpFrameChannel::start(
        read_half,
        write_half,
        shared.limits.writer_queue_frames,
        shared.timing.frame_deadline,
        shared.ingress_budget.clone(),
        gen_token.clone(),
        read_cancel.clone(),
    );
    let writer_task = AbortOnDropHandle::new(shared.tracker.spawn(channel_io));
    let gen = new_generation(&shared, gen_token, read_cancel, writer);
    let handoff = serve_generation(
        &shared,
        gen,
        channel,
        writer_task,
        ConnectionSetup::bootstrap(),
    )
    .await;

    let Some(handoff) = handoff else {
        return;
    };
    let io_task = handoff.io.lock().expect("candidate io lock").take();
    let promoted = handoff
        .promoted
        .lock()
        .expect("candidate promotion lock")
        .take();
    match promoted {
        Some(receiver) => {
            let io_task =
                AbortOnDropHandle::new(io_task.expect("candidate io is spawned at grant"));
            let gen = new_generation(
                &shared,
                handoff.root.clone(),
                handoff.read_cancel.clone(),
                handoff.sender.clone(),
            );
            serve_generation(
                &shared,
                gen,
                receiver,
                io_task,
                ConnectionSetup::provider_active(),
            )
            .await;
        }
        None => {
            // The candidate never promoted: reap it here so the setup owner
            // — not the provider — is what guarantees resource release.
            handoff.sender.discard();
            handoff.root.cancel();
            if let Some(io) = io_task {
                let _ = io.await;
            }
        }
    }
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
        liveness: Mutex::new(None),
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
    mut setup: ConnectionSetup,
) -> Option<Arc<CandidateHandoff>> {
    // Retained past `gen`: the writer must be told to stop even when a
    // handler still holds a sender clone through a retained RequestCtx.
    let writer_finish = gen.writer.clone();
    // Register the read loop before publishing the generation. Its tracker
    // token prevents shutdown from observing an empty producer set between
    // insertion and the first read-loop poll.
    let read_task = gen
        .read_tasks
        .track_future(read_loop(shared, &gen, channel, &mut setup));
    {
        let mut connections = shared.connections.lock().expect("connections lock");
        // The token check closes the window between a committed
        // `host.shutdown` (which cancels the token) and the shutdown
        // sequence storing `draining`: a socket accepted just before the
        // commit must not register a new generation after it.
        if shared.draining.load(Ordering::SeqCst) || shared.shutdown.is_cancelled() {
            return None;
        }
        connections.insert(gen.id, Arc::clone(&gen));
    }

    if let Some(policy) = shared.liveness.clone() {
        // A child of `read_cancel` so retirement still stops the loop; the
        // grant path cancels only this child to stop Pings alone.
        let stop = gen.read_cancel.child_token();
        let gen_ping = Arc::clone(&gen);
        let task = shared.spawn_tracked(gen.read_tasks.track_future(liveness_loop(
            gen_ping,
            policy,
            stop.clone(),
        )));
        *gen.liveness.lock().expect("liveness lock") = Some(LivenessHandle { stop, task });
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
    let handoff = setup.handoff.take();
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
    handoff
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
    setup: &mut ConnectionSetup,
) -> ReadExit {
    // Highest consumer Request correlation seen; any non-increasing Request
    // closes the generation before dispatch (protocol §8.3, V44). A promoted
    // candidate starts at 2 so application correlations begin at 3 (§7.7.4).
    let mut watermark: u64 = setup.initial_watermark;
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
                // An over-cap channel-0 Request is still a consumer request:
                // it commits the generation to TCP, and during candidate
                // setup it is a protocol failure (protocol §7.7.5), exactly
                // like the requests that pass the cap.
                if commit_transport(setup).is_err() {
                    return ReadExit::Peer;
                }
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
                            match handle_control(shared, gen, corr, action, setup).await {
                                ControlFlow::Continue => {}
                                ControlFlow::Close(exit) => return exit,
                            }
                        } else {
                            if header.epoch == 0 {
                                return ReadExit::Peer;
                            }
                            // A routed request is application-bearing: it
                            // commits the generation to TCP, and during
                            // candidate setup it is a protocol failure
                            // (protocol §7.7.5).
                            if commit_transport(setup).is_err() {
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
                        if matches!(setup.state, TransportState::CandidateSetup) {
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
                        if matches!(setup.state, TransportState::CandidateSetup) {
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

/// Runs `decode` over the frame's body as one contiguous byte slice. TCP
/// frames arrive contiguous; a ring backend delivers a body as two spans
/// when it wraps the arena end, so that shape flattens through the explicit
/// copying adapter first. Only decoded values leave the lease scope.
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
    setup: &mut ConnectionSetup,
) -> ControlFlow {
    // Negotiation bypasses pending-request admission because it is setup
    // traffic: exhausted global capacity must not turn a negotiation into a
    // `server_busy` terminal.
    let action = match action {
        ControlAction::TransportNegotiate(decoded) => {
            return handle_negotiate(shared, gen, corr, decoded, setup).await;
        }
        action => action,
    };
    // Non-negotiation channel-0 requests commit the generation to TCP;
    // during candidate setup they are a protocol failure (protocol §7.7.5).
    if commit_transport(setup).is_err() {
        return ControlFlow::Close(ReadExit::Peer);
    }

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
        return ControlFlow::Continue;
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
        ControlAction::TransportNegotiate(_) => {
            unreachable!("negotiation is intercepted before control admission")
        }
    }
    ControlFlow::Continue
}

/// What the setup-aware control path tells the read loop to do next.
enum ControlFlow {
    Continue,
    Close(ReadExit),
}

/// Transport-setup state for one served channel (protocol §7.7.5).
/// `Retired` has no variant: it is the read loop returning a [`ReadExit`].
/// The candidate-side stages (`CandidatePrepared`, `Activating`,
/// `AwaitingCommit`) are the sequential control flow of
/// [`run_candidate_setup`]; the bootstrap observes them all as
/// [`TransportState::CandidateSetup`].
enum TransportState {
    /// Authenticated bootstrap; nothing selected or committed yet.
    BootstrapTcp,
    /// The generation is committed to TCP. `late_used` is false only while
    /// the one allowed late negotiation (a first negotiation arriving after
    /// a non-negotiation request implicitly committed TCP) remains
    /// available; a negotiation that itself selects TCP consumes the
    /// allowance, so any further negotiation is a protocol failure.
    TcpCommitted { late_used: bool },
    /// A candidate is being activated; the bootstrap accepts no further
    /// requests.
    CandidateSetup,
    /// Serving a promoted candidate; selection is sticky until retirement.
    ProviderActive,
}

pub(crate) struct ConnectionSetup {
    state: TransportState,
    initial_watermark: u64,
    handoff: Option<Arc<CandidateHandoff>>,
}

impl ConnectionSetup {
    fn bootstrap() -> Self {
        Self {
            state: TransportState::BootstrapTcp,
            initial_watermark: 0,
            handoff: None,
        }
    }

    /// Correlations 1 and 2 were consumed by activation and commit, so the
    /// first application request on a promoted candidate is 3 (§7.7.4).
    fn provider_active() -> Self {
        Self {
            state: TransportState::ProviderActive,
            initial_watermark: COMMIT_CORRELATION,
            handoff: None,
        }
    }
}

/// Shared handle for one prepared candidate: the sender and cancellation
/// roots both the driver and the setup owner can reach, plus the promotion
/// slot the driver fills after the commit response reaches local completion.
pub(crate) struct CandidateHandoff {
    sender: FrameSender,
    root: CancellationToken,
    read_cancel: CancellationToken,
    promoted: Mutex<Option<BoxedReceiver>>,
    io: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// The first consumer request that is not `transport.negotiate` commits the
/// generation to TCP (protocol §7.7); during candidate setup any such
/// request is a protocol failure.
fn commit_transport(setup: &mut ConnectionSetup) -> Result<(), ()> {
    match setup.state {
        TransportState::BootstrapTcp => {
            setup.state = TransportState::TcpCommitted { late_used: false };
            Ok(())
        }
        TransportState::CandidateSetup => Err(()),
        TransportState::TcpCommitted { .. } | TransportState::ProviderActive => Ok(()),
    }
}

async fn handle_negotiate<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    corr: u64,
    decoded: Result<NegotiateRequest, NegotiationError>,
    setup: &mut ConnectionSetup,
) -> ControlFlow {
    match setup.state {
        // Selection is sticky (§7.7.5): a repeated negotiation, or any
        // negotiation while a candidate is being set up or after promotion,
        // is a protocol failure.
        TransportState::CandidateSetup
        | TransportState::ProviderActive
        | TransportState::TcpCommitted { late_used: true } => {
            return ControlFlow::Close(ReadExit::Peer);
        }
        TransportState::BootstrapTcp | TransportState::TcpCommitted { late_used: false } => {}
    }
    let request = match decoded {
        Ok(request) => request,
        Err(_) => {
            // §7.7.1: the documented terminal, then retirement. The close
            // fences exactly this authoritative frame, like the
            // oversized-control path. Liveness stops first: the generation
            // is closing with exactly this frame, and a missed-Pong
            // invalidation during the bounded egress wait below would
            // cancel the generation and abort the terminal the contract
            // requires.
            let liveness = gen.liveness.lock().expect("liveness lock").take();
            if let Some(handle) = liveness {
                handle.stop.cancel();
                let _ = handle.task.await;
            }
            let (terminal_tx, terminal_rx) = tokio::sync::oneshot::channel();
            crate::dispatch::emit_authoritative_rejection(
                shared,
                gen,
                FrameId::control(corr),
                CODE_INVALID_CONTROL_REQUEST,
                "malformed transport negotiation",
                terminal_tx,
            )
            .await;
            return ControlFlow::Close(ReadExit::PeerKeepQueue(terminal_rx));
        }
    };
    // Fallback always names the exact offered tcp entry (§7.7.3); with tcp
    // offered only at versions this host does not speak, no offered entry is
    // serveable and the setup fails closed.
    if !request.offers.iter().any(|offer| {
        offer.transport == TRANSPORT_TCP && offer.capability_version == TCP_CAPABILITY_VERSION
    }) {
        return ControlFlow::Close(ReadExit::Peer);
    }
    if matches!(setup.state, TransportState::TcpCommitted { .. }) {
        setup.state = TransportState::TcpCommitted { late_used: true };
        return respond_tcp(
            shared,
            gen,
            corr,
            request.negotiation_version,
            Some(FallbackReason::ConnectionInUse),
        )
        .await;
    }
    if request.negotiation_version != NEGOTIATION_VERSION {
        // Negotiation itself selected TCP, so the late-negotiation
        // allowance (implicit-commit-first only, §7.7.5) is consumed.
        setup.state = TransportState::TcpCommitted { late_used: true };
        return respond_tcp(
            shared,
            gen,
            corr,
            request.negotiation_version,
            Some(FallbackReason::NegotiationVersionMismatch),
        )
        .await;
    }
    // The first serveable offer in client preference order wins.
    let mut capability_mismatch = false;
    let mut dynamically_unavailable = false;
    for offer in &request.offers {
        if offer.transport == TRANSPORT_TCP {
            if offer.capability_version == TCP_CAPABILITY_VERSION {
                break;
            }
            continue;
        }
        // Provider identity is `(transport, capability_version)`: a
        // name-only lookup would hide a serveable provider behind a
        // mismatched sibling at the same name.
        match shared
            .providers
            .find(&offer.transport, offer.capability_version)
        {
            Some(provider) => {
                // A panicking preflight fails toward static omission: reasonless TCP and no client probe (KTD6). commentlint: allow(JUDGE)
                let eligibility = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    crate::panic_boundary::redact_sync(|| {
                        provider.preflight(offer.parameters.as_ref())
                    })
                }))
                .unwrap_or(PreflightEligibility::StaticallyOmitted);
                match eligibility {
                    PreflightEligibility::Serveable => {
                        let provider = Arc::clone(provider);
                        let selected = SelectedTransport {
                            transport: offer.transport.clone(),
                            capability_version: offer.capability_version,
                        };
                        return grant_candidate(
                            shared,
                            gen,
                            corr,
                            request.negotiation_version,
                            selected,
                            provider,
                            offer.parameters.clone(),
                            setup,
                        )
                        .await;
                    }
                    // Exact `unavailable` is reserved for an installed, statically eligible provider's dynamic readiness or admission pressure (KTD6). commentlint: allow(JUDGE)
                    PreflightEligibility::DynamicallyUnavailable => {
                        dynamically_unavailable = true;
                    }
                    PreflightEligibility::StaticallyOmitted => {}
                }
            }
            // Known transport at another version: name the real cause
            // (§7.7.3) rather than reporting it as unavailable.
            None if shared.providers.serves_transport(&offer.transport) => {
                capability_mismatch = true;
            }
            // Permanent absence selects reasonless TCP, never `unavailable`, so a client cannot probe for a provider that cannot appear (KTD6). commentlint: allow(JUDGE)
            None => {}
        }
    }
    let reason = if capability_mismatch {
        Some(FallbackReason::CapabilityVersionMismatch)
    } else if dynamically_unavailable {
        Some(FallbackReason::Unavailable)
    } else {
        None
    };
    // Negotiation itself selected TCP: the late-negotiation allowance is
    // consumed, so a repeated negotiation is a protocol failure (§7.7.5).
    setup.state = TransportState::TcpCommitted { late_used: true };
    respond_tcp(shared, gen, corr, request.negotiation_version, reason).await
}

async fn respond_tcp<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    corr: u64,
    negotiation_version: u32,
    reason: Option<FallbackReason>,
) -> ControlFlow {
    let body = encode_negotiate_response(
        &NegotiateResponse::Tcp { reason },
        negotiation_version,
        TCP_CAPABILITY_VERSION,
    )
    .expect("a tcp selection always encodes");
    // Emission can wait on the shared egress budget; queue it off the read
    // loop so a contended budget cannot stall Pong reads into a liveness
    // false-kill. Bounded without a pending permit: the setup state machine
    // admits at most two TCP negotiation responses per generation.
    let shared_task = Arc::clone(shared);
    let gen_task = Arc::clone(gen);
    shared.spawn_tracked(gen.read_tasks.track_future(async move {
        if emit_frame(
            &shared_task.egress_budget,
            &gen_task,
            FrameType::Response,
            response_flags(false, true),
            FrameId::control(corr),
            body,
        )
        .await
        .is_err()
        {
            gen_task.token.cancel();
        }
    }));
    ControlFlow::Continue
}

#[expect(
    clippy::too_many_arguments,
    reason = "candidate grant keeps authenticated setup inputs explicit"
)]
async fn grant_candidate<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    corr: u64,
    negotiation_version: u32,
    selected: SelectedTransport,
    provider: Arc<dyn InjectedProvider>,
    offer_parameters: Option<serde_json::Value>,
    setup: &mut ConnectionSetup,
) -> ControlFlow {
    let ctx = ProviderContext::new(
        shared.ingress_budget.clone(),
        shared.limits.writer_queue_frames,
        shared.timing.frame_deadline,
        offer_parameters,
    );
    // The setup deadline exists before any provider code runs, and the
    // KTD9 attachment gate inside `prepare` executes on the registry's one
    // dedicated worker thread: a provider that stalls cannot pin the read
    // loop, hold the connection permit past the configured setup budget,
    // or occupy a fresh blocking-pool worker per reconnect. On timeout the
    // job's eventual result is dropped, releasing the candidate.
    let deadline = Instant::now() + shared.timing.transport_setup_deadline;
    // KTD4 order: bootstrap liveness is stopped AND joined before the
    // selection is published — no bootstrap Ping can race the client onto
    // two live channels. It stops HERE, before the preparation wait,
    // because that wait blocks this generation's sole read loop: a
    // `prepare` slower than `ping_interval + pong_deadline` would
    // otherwise leave a timely Pong unread and let liveness invalidate a
    // healthy generation. Every path past this point either publishes the
    // selection or closes the generation, so no bootstrap needs probing
    // again.
    let liveness = gen.liveness.lock().expect("liveness lock").take();
    if let Some(handle) = liveness {
        handle.stop.cancel();
        let _ = handle.task.await;
    }
    let reply = shared.providers.prepare_on_worker(provider, ctx);
    // A provider failure — including a stalled gate — is not fallback
    // evidence (§7.7.3): the setup fails closed with no same-generation
    // TCP continuation.
    let PreparedCandidate {
        descriptor,
        candidate_id,
        candidate,
    } = match timeout_at(deadline, reply).await {
        Ok(Ok(Ok(prepared))) => prepared,
        _ => return ControlFlow::Close(ReadExit::Peer),
    };
    let token = fresh_activation_token();
    let binding = GrantBinding {
        daemon_id: shared.daemon_id,
        bootstrap_generation: gen.id,
        negotiation_correlation: corr,
        transport: selected.transport.clone(),
        capability_version: selected.capability_version,
        candidate_id,
    };
    let grant = GrantRecord::new(binding.clone(), token.clone());
    let body = match encode_negotiate_response(
        &NegotiateResponse::Grant {
            selected,
            activation_token: token,
            descriptor,
        },
        negotiation_version,
        TCP_CAPABILITY_VERSION,
    ) {
        Ok(body) => body,
        // An out-of-bounds provider descriptor fails closed before any
        // candidate task exists; dropping the candidate releases its
        // resources.
        Err(_) => return ControlFlow::Close(ReadExit::Peer),
    };
    let Candidate {
        sender,
        receiver,
        io,
        root,
        read_cancel,
    } = candidate;
    let io_task = shared.spawn_tracked(io);
    let handoff = Arc::new(CandidateHandoff {
        sender,
        root,
        read_cancel,
        promoted: Mutex::new(None),
        io: Mutex::new(Some(io_task)),
    });
    let shared_task = Arc::clone(shared);
    let gen_task = Arc::clone(gen);
    let handoff_task = Arc::clone(&handoff);
    // Tracked in `read_tasks` so both connection teardown and shutdown wait
    // for the driver before reading the promotion slot.
    shared.spawn_tracked(gen.read_tasks.track_future(run_candidate_setup(
        shared_task,
        gen_task,
        handoff_task,
        receiver,
        grant,
        binding,
        deadline,
    )));
    setup.state = TransportState::CandidateSetup;
    setup.handoff = Some(handoff);
    // Publishing the selection is the last step. A failed emission retires
    // the bootstrap; the driver observes `read_cancel` and reaps the
    // candidate.
    if emit_frame(
        &shared.egress_budget,
        gen,
        FrameType::Response,
        response_flags(false, true),
        FrameId::control(corr),
        body,
    )
    .await
    .is_err()
    {
        gen.token.cancel();
    }
    ControlFlow::Continue
}

/// Drives one candidate's activation (correlation 1) and commit
/// (correlation 2) exchanges (protocol §7.7.4). Success stores the receiver
/// in the promotion slot and retires the bootstrap without touching the
/// candidate; every other outcome — wrong token, wrong correlation, an
/// application frame before commit, deadline expiry, channel loss, bootstrap
/// retirement — retires both channels with no TCP continuation.
async fn run_candidate_setup<H: McHostHandler>(
    shared: Arc<HostShared<H>>,
    bootstrap: Arc<GenerationCore>,
    handoff: Arc<CandidateHandoff>,
    mut receiver: BoxedReceiver,
    grant: GrantRecord,
    binding: GrantBinding,
    deadline: Instant,
) {
    let exchange = async {
        let frame = expect_candidate_request(&mut receiver, ACTIVATION_CORRELATION).await?;
        let request = decode_candidate_activate(frame)?;
        grant
            .consume(&request.activation_token, &binding)
            .map_err(|_| ())?;
        send_candidate_response(
            &shared,
            &handoff,
            ACTIVATION_CORRELATION,
            activate_response_json(),
            None,
        )
        .await?;

        let frame = expect_candidate_request(&mut receiver, COMMIT_CORRELATION).await?;
        decode_candidate_commit(frame)?;
        // Promotion is gated on this exact frame's local completion — not
        // queue admission, not an aggregate flush (KTD4). The receiver is
        // deliberately NOT polled while waiting: an un-promoted host never
        // consumes candidate frames, so a request pipelined ahead of the
        // commit response stays buffered and is observed only by the
        // promoted generation, where every setup invariant already holds.
        let (written_tx, written_rx) = tokio::sync::oneshot::channel();
        send_candidate_response(
            &shared,
            &handoff,
            COMMIT_CORRELATION,
            commit_response_json(),
            Some(written_tx),
        )
        .await?;
        written_rx.await.map_err(|_| ())
    };
    let outcome = tokio::select! {
        biased;
        // A completed exchange must win over a simultaneous bootstrap
        // retirement: after the commit response reaches local completion
        // the client may promote and retire the bootstrap before this task
        // is polled again, and that healthy grant must not be discarded.
        outcome = timeout_at(deadline, exchange) => outcome.unwrap_or(Err(())),
        // Bootstrap retirement (including host shutdown) reaps a candidate
        // whose exchange is still pending.
        () = bootstrap.read_cancel.cancelled() => Err(()),
    };
    match outcome {
        Ok(()) => {
            *handoff.promoted.lock().expect("candidate promotion lock") = Some(receiver);
            // Atomic transfer: retire the bootstrap without touching the
            // candidate.
            bootstrap.token.cancel();
            bootstrap.writer.discard();
        }
        Err(()) => {
            handoff.sender.discard();
            handoff.root.cancel();
            bootstrap.token.cancel();
            bootstrap.writer.discard();
        }
    }
}

fn decode_candidate_activate(
    frame: crate::frame_channel::InboundFrame,
) -> Result<crate::transport_negotiation::ActivateRequest, ()> {
    decode_contiguous(&frame, decode_activate_request).map_err(|_| ())
}

fn decode_candidate_commit(frame: crate::frame_channel::InboundFrame) -> Result<(), ()> {
    decode_contiguous(&frame, decode_commit_request).map_err(|_| ())
}

async fn expect_candidate_request(
    receiver: &mut BoxedReceiver,
    corr: u64,
) -> Result<crate::frame_channel::InboundFrame, ()> {
    match receiver.recv().await {
        Ok(InboundEvent::Frame(frame))
            if frame.header.ty == FrameType::Request
                && frame.header.channel == 0
                && frame.header.epoch == 0
                && frame.header.corr == corr
                && !frame.header.flags.is_binary() =>
        {
            Ok(frame)
        }
        // Anything else — a wrong correlation, a nonzero epoch, an
        // application frame before commit, a rejected oversize declaration,
        // or channel loss — fails the whole setup (§7.7.4).
        _ => Err(()),
    }
}

async fn send_candidate_response<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    handoff: &CandidateHandoff,
    corr: u64,
    body: Vec<u8>,
    written_tx: Option<tokio::sync::oneshot::Sender<()>>,
) -> Result<(), ()> {
    let deadline = handoff.sender.admission_deadline();
    let frame_bytes = u32::try_from(body.len() + subc_protocol::HEADER_LEN).map_err(|_| ())?;
    let charge = tokio::select! {
        biased;
        () = handoff.root.cancelled() => return Err(()),
        charge = timeout_at(deadline, shared.egress_budget.charge(frame_bytes)) => {
            charge.map_err(|_| ())?
        }
    };
    let bytes = encode_owned_frame(
        FrameType::Response,
        response_flags(false, true),
        FrameId::control(corr),
        body,
    )
    .map_err(|_| ())?;
    handoff
        .sender
        .send_before(
            OutboundFrame {
                bytes,
                tail: Vec::new(),
                direct: None,
                charge,
                written: written_tx.map(|tx| {
                    Box::new(move |_completed_at: Instant| {
                        let _ = tx.send(());
                    }) as Box<dyn FnOnce(Instant) + Send>
                }),
            },
            deadline,
        )
        .await
        .map_err(|_| ())
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
    let frame_bytes = body
        .len()
        .checked_add(subc_protocol::HEADER_LEN)
        .ok_or(())?;
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
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, DuplexStream};

    #[derive(Clone, Copy)]
    enum FencedProducer {
        Catalog,
        CapacityRejection,
    }

    async fn read_frame_from(stream: &mut DuplexStream) -> subc_protocol::EnvelopeHeader {
        let mut header_bytes = [0; subc_protocol::HEADER_LEN];
        stream
            .read_exact(&mut header_bytes)
            .await
            .expect("frame header");
        let header = subc_protocol::decode_header(&header_bytes).expect("valid frame header");
        let mut body = vec![0; header.len as usize];
        stream.read_exact(&mut body).await.expect("frame body");
        header
    }

    async fn assert_started_producer_precedes_goodbye(producer: FencedProducer) {
        let generation = CancellationToken::new();
        let read_cancel = generation.child_token();
        let (server, mut client) = tokio::io::duplex(4096);
        let (writer, writer_task) = crate::tcp_frame_channel::spawn_writer(
            server,
            4,
            generation.clone(),
            Duration::from_secs(1),
        );
        let gen = Arc::new(GenerationCore {
            id: 1,
            token: generation,
            read_cancel,
            read_tasks: TaskTracker::new(),
            shutdown_complete: CancellationToken::new(),
            writer,
            membership: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            pings: Mutex::new(HashMap::new()),
            busy_rejects: Arc::new(tokio::sync::Semaphore::new(MAX_INFLIGHT_BUSY_REJECTS)),
            next_ping_corr: std::sync::atomic::AtomicU64::new(1),
            liveness: Mutex::new(None),
        });
        let budget = crate::wire::ByteBudget::new(4096);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let producer_gen = Arc::clone(&gen);
        let producer_budget = budget.clone();
        let task = tokio::spawn(gen.read_tasks.track_future(async move {
            let _ = started_tx.send(());
            let _ = release_rx.await;
            match producer {
                FencedProducer::Catalog => {
                    emit_catalog_response(
                        &producer_budget,
                        &producer_gen,
                        FrameId::control(7),
                        br#"{"op":"catalog.list","modules":[]}"#,
                    )
                    .await
                    .expect("catalog queued");
                }
                FencedProducer::CapacityRejection => {
                    crate::dispatch::emit_error_terminal(
                        &producer_budget,
                        &producer_gen,
                        FrameId::control(7),
                        crate::control::CODE_SERVER_BUSY,
                        "pending request capacity exhausted",
                    )
                    .await;
                }
            }
        }));
        started_rx.await.expect("producer started");

        gen.read_cancel.cancel();
        gen.read_tasks.close();
        let tracker = gen.read_tasks.clone();
        let (wait_started_tx, wait_started_rx) = tokio::sync::oneshot::channel();
        let fence = tokio::spawn(async move {
            let _ = wait_started_tx.send(());
            tracker.wait().await;
        });
        wait_started_rx.await.expect("fence started");
        tokio::task::yield_now().await;
        assert!(
            !fence.is_finished(),
            "shutdown must wait for an already-started producer"
        );

        release_tx.send(()).expect("release producer");
        fence.await.expect("producer fence");
        task.await.expect("producer task");
        crate::dispatch::send_connection_goodbye(&gen).await;

        let terminal = read_frame_from(&mut client).await;
        assert_eq!(terminal.corr, 7);
        assert!(matches!(
            terminal.ty,
            FrameType::Response | FrameType::Error
        ));
        let goodbye = read_frame_from(&mut client).await;
        assert_eq!(goodbye.ty, FrameType::Goodbye);
        assert_eq!((goodbye.channel, goodbye.epoch, goodbye.corr), (0, 0, 0));

        drop(gen);
        drop(client);
        writer_task.await.expect("writer task");
    }

    #[tokio::test]
    async fn shutdown_fence_queues_started_catalog_before_goodbye() {
        assert_started_producer_precedes_goodbye(FencedProducer::Catalog).await;
    }

    #[tokio::test]
    async fn shutdown_fence_queues_started_capacity_rejection_before_goodbye() {
        assert_started_producer_precedes_goodbye(FencedProducer::CapacityRejection).await;
    }

    #[tokio::test]
    async fn cached_catalog_clone_holds_one_full_frame_charge() {
        let body = br#"{"op":"catalog.list","modules":[]}"#;
        let frame_bytes = subc_protocol::HEADER_LEN + body.len();
        let budget = crate::wire::ByteBudget::new(frame_bytes as u64);
        let generation = CancellationToken::new();
        let (server, client) = tokio::io::duplex(64);
        let (writer, writer_task) = crate::tcp_frame_channel::spawn_writer(
            server,
            1,
            generation.clone(),
            Duration::from_secs(1),
        );
        let gen = GenerationCore {
            id: 1,
            token: generation,
            read_cancel: CancellationToken::new(),
            read_tasks: TaskTracker::new(),
            shutdown_complete: CancellationToken::new(),
            writer,
            membership: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            pings: Mutex::new(HashMap::new()),
            busy_rejects: Arc::new(tokio::sync::Semaphore::new(MAX_INFLIGHT_BUSY_REJECTS)),
            next_ping_corr: std::sync::atomic::AtomicU64::new(1),
            liveness: Mutex::new(None),
        };

        let frame = reserve_catalog_frame(
            &budget,
            &gen,
            Instant::now() + Duration::from_secs(1),
            FrameId::control(7),
            body,
        )
        .await
        .expect("catalog frame reservation");

        assert_eq!(budget.available(), 0);
        assert_eq!(&frame.bytes[subc_protocol::HEADER_LEN..], body);
        drop(frame);
        assert_eq!(budget.available(), frame_bytes);

        drop(gen);
        drop(client);
        writer_task.await.expect("writer task");
    }
}
