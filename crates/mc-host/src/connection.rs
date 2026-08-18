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
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;

use crate::control::{parse_control, ControlAction, CODE_INVALID_CONTROL_REQUEST};
use crate::dispatch::{
    close_generation, close_route_owned, dispatch_request, emit_error_terminal, emit_frame,
    handle_cancel, open_route,
};
use crate::handler::McHostHandler;
use crate::runtime::HostShared;
use crate::wire::{
    drain_declared_body, pure_header_flags, read_frame, FrameId, ReadClose, ReadEvent, WriterHandle,
};

/// Key of one pending consumer request: (channel, epoch, correlation).
/// Direction is implied — this map holds only consumer-originated requests;
/// host Pings live in their own namespace (protocol §8.3, V43).
pub type PendingKey = (u16, u32, u64);

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
    pub writer: WriterHandle,
    /// channel -> epoch for routes this generation may dispatch on. Lookup
    /// only; the registry owns insertion at bind and removal at close.
    pub membership: Mutex<HashMap<u16, u32>>,
    pub pending: Mutex<HashMap<PendingKey, PendingEntry>>,
    /// Outstanding host-originated Pings: correlation -> (flags byte, sent at).
    pub pings: Mutex<HashMap<u64, (u8, Instant)>>,
    pub next_ping_corr: std::sync::atomic::AtomicU64,
}

/// Runs one accepted socket to completion: authenticate, promote into
/// authenticated capacity, then serve frames until retirement.
///
/// `handshake_permit` is held from before the first byte is read; it releases
/// on every exit path once authenticated capacity is acquired or the socket
/// dies (protocol §5.1).
pub async fn run_connection<H: McHostHandler>(
    shared: Arc<HostShared<H>>,
    mut stream: TcpStream,
    handshake_permit: OwnedSemaphorePermit,
) {
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
    let (read_half, write_half) = stream.into_split();
    let (writer, writer_task) = crate::wire::spawn_writer_tracked(
        write_half,
        shared.limits.writer_queue_frames,
        gen_token.clone(),
        shared.timing.frame_deadline,
        &shared.tracker,
    );
    let mut writer_task = AbortOnDropHandle::new(writer_task);

    let gen = Arc::new(GenerationCore {
        id: shared.gen_counter.fetch_add(1, Ordering::SeqCst),
        token: gen_token,
        writer,
        membership: Mutex::new(HashMap::new()),
        pending: Mutex::new(HashMap::new()),
        pings: Mutex::new(HashMap::new()),
        next_ping_corr: std::sync::atomic::AtomicU64::new(1),
    });
    {
        let mut connections = shared.connections.lock().expect("connections lock");
        if shared.draining.load(Ordering::SeqCst) {
            return;
        }
        connections.insert(gen.id, Arc::clone(&gen));
    }

    if let Some(liveness) = shared.liveness.clone() {
        let gen_ping = Arc::clone(&gen);
        let budget = shared.egress_budget.clone();
        shared.spawn_tracked(async move {
            liveness_loop(gen_ping, budget, liveness).await;
        });
    }

    read_loop(&shared, &gen, read_half).await;

    close_generation(&shared, &gen).await;
    drop(gen);
    if tokio::time::timeout(shared.timing.route_close_budget, &mut writer_task)
        .await
        .is_err()
    {
        writer_task.abort();
        let _ = writer_task.await;
    }
}

/// Serves validated frames until close. Returning retires the generation.
async fn read_loop<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    mut reader: tokio::net::tcp::OwnedReadHalf,
) {
    // Highest consumer Request correlation seen; any non-increasing Request
    // closes the generation before dispatch (protocol §8.3, V44).
    let mut watermark: u64 = 0;

    loop {
        let event = match read_frame(
            &mut reader,
            shared.timing.frame_deadline,
            &shared.ingress_budget,
            &gen.token,
        )
        .await
        {
            Ok(event) => event,
            Err(ReadClose::CleanEof) => return,
            Err(ReadClose::Cancelled) => return,
            Err(ReadClose::Corrupt(_)) | Err(ReadClose::Io(_)) => return,
        };

        match event {
            ReadEvent::OversizeControl { header, deadline } => {
                // The correlation is trustworthy from the header alone; the
                // early terminal is authoritative even if the drain then fails
                // (protocol §7.1). The watermark still applies first.
                if header.corr <= watermark {
                    return;
                }
                watermark = header.corr;
                emit_error_terminal(
                    &shared.egress_budget,
                    gen,
                    FrameId::control(header.corr),
                    CODE_INVALID_CONTROL_REQUEST,
                    "control body exceeds profile cap",
                )
                .await;
                if drain_declared_body(&mut reader, header.len, deadline, &gen.token)
                    .await
                    .is_err()
                {
                    return;
                }
            }
            ReadEvent::Frame(frame) => {
                let header = frame.header;
                match header.ty {
                    FrameType::Request => {
                        if header.corr <= watermark {
                            return;
                        }
                        watermark = header.corr;
                        if header.channel == 0 {
                            handle_control(shared, gen, frame).await;
                        } else {
                            if header.epoch == 0 {
                                return;
                            }
                            dispatch_request(shared, gen, frame).await;
                        }
                    }
                    FrameType::Cancel => {
                        // Structural shape: current nonzero route, nonzero
                        // correlation (protocol §6.2 table).
                        if header.channel == 0 || header.epoch == 0 || header.corr == 0 {
                            return;
                        }
                        handle_cancel(gen, (header.channel, header.epoch, header.corr));
                    }
                    FrameType::Pong => {
                        if header.channel != 0 || header.corr == 0 {
                            return;
                        }
                        let mut pings = gen.pings.lock().expect("pings lock");
                        match pings.get(&header.corr) {
                            // The echo must match what we sent exactly
                            // (protocol V35); anything else is unmatched and
                            // dropped (protocol §6.2 table).
                            Some((flags, _)) if *flags == header.flags.0 => {
                                pings.remove(&header.corr);
                            }
                            _ => {}
                        }
                    }
                    FrameType::Goodbye => {
                        if header.channel == 0 {
                            if header.corr != 0 {
                                return;
                            }
                            // Orderly connection close (protocol §9.4).
                            return;
                        }
                        if header.epoch == 0 || header.corr != 0 {
                            return;
                        }
                        close_route_owned(
                            shared,
                            crate::handler::RouteHandle {
                                channel: header.channel,
                                epoch: header.epoch,
                            },
                            gen.id,
                        )
                        .await;
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
                    | FrameType::Ping => return,
                }
            }
        }
    }
}

async fn handle_control<H: McHostHandler>(
    shared: &Arc<HostShared<H>>,
    gen: &Arc<GenerationCore>,
    frame: crate::wire::InboundFrame,
) {
    let corr = frame.header.corr;
    let action = parse_control(
        &frame.body,
        frame.header.flags.is_binary(),
        &shared.manifest.module_id,
    );
    // The body and its charge are done: validation is complete.
    drop(frame);

    match action {
        ControlAction::Reject { code, message } => {
            emit_error_terminal(
                &shared.egress_budget,
                gen,
                FrameId::control(corr),
                code,
                &message,
            )
            .await;
        }
        ControlAction::CatalogList { module_id_filter } => {
            // Catalog stays serviceable during drain (protocol §12 step 1
            // freezes routes and dispatch, not control reads).
            let body = crate::control::catalog_response_json(
                &shared.manifest,
                module_id_filter.as_deref(),
            );
            if emit_frame(
                &shared.egress_budget,
                gen,
                FrameType::Response,
                crate::wire::response_flags(false, true),
                FrameId::control(corr),
                body,
            )
            .await
            .is_err()
            {
                gen.token.cancel();
            }
        }
        ControlAction::RouteOpen { identity } => {
            let Ok(pending_permit) = shared.pending_permits.clone().try_acquire_owned() else {
                emit_error_terminal(
                    &shared.egress_budget,
                    gen,
                    FrameId::control(corr),
                    crate::control::CODE_SERVER_BUSY,
                    "pending request capacity exhausted",
                )
                .await;
                return;
            };
            // Bind callbacks may be slow; never stall the read loop on them.
            let shared_task = Arc::clone(shared);
            let gen_task = Arc::clone(gen);
            shared.spawn_tracked(async move {
                let _pending_permit = pending_permit;
                open_route(shared_task, gen_task, corr, identity).await;
            });
        }
    }
}

/// Host-side Ping issuance. The correlation namespace is host-owned and
/// independent of consumer correlations (protocol §8.3): a Ping correlation
/// numerically equal to a pending consumer correlation cannot cross-settle
/// because Pongs only match this map.
async fn liveness_loop(
    gen: Arc<GenerationCore>,
    budget: crate::wire::ByteBudget,
    policy: crate::config::LivenessPolicy,
) {
    let mut next_ping_at = Instant::now() + policy.ping_interval;
    loop {
        // Wake at the sooner of the next Ping tick and the earliest
        // outstanding Pong deadline, so invalidation honors `pong_deadline`
        // rather than overshooting to the next `ping_interval` tick.
        let wake_at = {
            let pings = gen.pings.lock().expect("pings lock");
            pings
                .values()
                .map(|(_, sent)| *sent + policy.pong_deadline)
                .min()
                .map_or(next_ping_at, |deadline| deadline.min(next_ping_at))
        };
        tokio::select! {
            () = gen.token.cancelled() => return,
            () = tokio::time::sleep_until(wake_at) => {}
        }
        let now = Instant::now();
        let expired = {
            let pings = gen.pings.lock().expect("pings lock");
            pings
                .values()
                .any(|(_, sent)| now.duration_since(*sent) >= policy.pong_deadline)
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
                // An unexpired Ping is outstanding; wake again at its deadline.
                continue;
            }
        }
        if now < next_ping_at {
            // Woke for a Pong deadline that was answered (or cleared) in time;
            // the next Ping still waits for its tick.
            continue;
        }
        next_ping_at = now + policy.ping_interval;
        let corr = gen.next_ping_corr.fetch_add(1, Ordering::SeqCst);
        let flags = pure_header_flags();
        gen.pings
            .lock()
            .expect("pings lock")
            .insert(corr, (flags.0, Instant::now()));
        if emit_frame(
            &budget,
            &gen,
            FrameType::Ping,
            flags,
            FrameId::control(corr),
            Vec::new(),
        )
        .await
        .is_err()
        {
            return;
        }
    }
}
