//! Shared harness for Broca tests: a deterministic scriptable backend
//! (KTD5/R14 — replaces subprocess execution without changing supervisor
//! behavior) and a real-loopback composite host whose tertiary is a
//! `BrocaComponent`.

#![allow(dead_code)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use mc_host::broca::backend::{
    BackendError, BackendEvent, BackendFuture, BackendRequest, BackendTerminal, ErrorClass,
    EventSink, FinishReason, LlmExecutionBackend,
};
use mc_host::broca::{BrocaComponent, BROCA_MODULE_ID};
use mc_host::{CancellationToken, StaticComposite};

use super::raw_client::{self, RawFrame};

pub const ROOT: &str = "/workspace/project";
pub const BUDGET: Duration = Duration::from_secs(5);

type RunFn = dyn Fn(BackendRequest, EventSink, CancellationToken) -> BackendFuture + Send + Sync;

/// Deterministic backend whose behavior is a supplied closure, plus start
/// and cancellation counters so tests can prove exactly one backend start
/// (AE2) and that waiter detach never reaches the backend (R9).
pub struct ScriptedBackend {
    starts: AtomicUsize,
    cancels: Arc<AtomicUsize>,
    run: Box<RunFn>,
}

impl ScriptedBackend {
    pub fn with_behavior(
        run: impl Fn(BackendRequest, EventSink, CancellationToken) -> BackendFuture
            + Send
            + Sync
            + 'static,
    ) -> Arc<Self> {
        Self::assemble(Arc::new(AtomicUsize::new(0)), Box::new(run))
    }

    fn assemble(cancels: Arc<AtomicUsize>, run: Box<RunFn>) -> Arc<Self> {
        Arc::new(Self {
            starts: AtomicUsize::new(0),
            cancels,
            run,
        })
    }

    pub fn starts(&self) -> usize {
        self.starts.load(Ordering::SeqCst)
    }

    pub fn cancels_observed(&self) -> usize {
        self.cancels.load(Ordering::SeqCst)
    }

    /// Emits one text unit and completes immediately.
    pub fn completing(text: &'static str) -> Arc<Self> {
        Self::with_behavior(move |_request, events, _cancel| {
            Box::pin(async move {
                events.emit(BackendEvent::AssistantText {
                    text: text.to_owned(),
                    finish_reason: None,
                });
                BackendTerminal::Completed {
                    finish_reason: FinishReason::Completed,
                }
            })
        })
    }

    /// Resolves to one classified failure without emitting anything.
    pub fn failing(error: BackendError) -> Arc<Self> {
        Self::with_behavior(move |_request, _events, _cancel| {
            let error = error.clone();
            Box::pin(async move { BackendTerminal::Failed(error) })
        })
    }

    /// Each run pauses at the returned gate. One released permit lets one
    /// run emit its unit and complete; a cancellation is observed instead
    /// and the run returns promptly, which is what keeps cancel/delete/
    /// shutdown waits bounded (R10).
    pub fn gated(text: &'static str) -> (Arc<Self>, Arc<tokio::sync::Semaphore>) {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let cancels = Arc::new(AtomicUsize::new(0));
        let run_gate = Arc::clone(&gate);
        let run_cancels = Arc::clone(&cancels);
        let backend = Self::assemble(
            Arc::clone(&cancels),
            Box::new(move |_request, events, cancel| {
                let gate = Arc::clone(&run_gate);
                let cancels = Arc::clone(&run_cancels);
                Box::pin(async move {
                    tokio::select! {
                        biased;
                        () = cancel.cancelled() => {
                            cancels.fetch_add(1, Ordering::SeqCst);
                            return BackendTerminal::Failed(BackendError {
                                class: ErrorClass::Permanent,
                                message: "backend observed cancellation".to_owned(),
                                retry_after_secs: None,
                                provider_code: None,
                            });
                        }
                        permit = gate.acquire() => permit.expect("gate stays open").forget(),
                    }
                    events.emit(BackendEvent::AssistantText {
                        text: text.to_owned(),
                        finish_reason: None,
                    });
                    BackendTerminal::Completed {
                        finish_reason: FinishReason::Completed,
                    }
                })
            }),
        );
        (backend, gate)
    }

    /// Like [`ScriptedBackend::gated`] but deliberately blind to the cancel
    /// token: the run resolves only when the gate releases. This is the
    /// fixture that blocks `run.cancel` settlement for the 32-command
    /// saturation test and proves completion cannot overwrite a committed
    /// cancellation.
    pub fn gated_ignoring_cancel(text: &'static str) -> (Arc<Self>, Arc<tokio::sync::Semaphore>) {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let run_gate = Arc::clone(&gate);
        let backend = Self::with_behavior(move |_request, events, _cancel| {
            let gate = Arc::clone(&run_gate);
            Box::pin(async move {
                gate.acquire().await.expect("gate stays open").forget();
                events.emit(BackendEvent::AssistantText {
                    text: text.to_owned(),
                    finish_reason: None,
                });
                BackendTerminal::Completed {
                    finish_reason: FinishReason::Completed,
                }
            })
        });
        (backend, gate)
    }

    /// Emits `units` text units of `unit_bytes` each, then claims success —
    /// the overflow fixture (AE10): the supervisor must stop retention at
    /// one failed terminal regardless of what the backend claims.
    pub fn flooding(unit_bytes: usize, units: usize) -> Arc<Self> {
        Self::with_behavior(move |_request, events, _cancel| {
            Box::pin(async move {
                for _ in 0..units {
                    events.emit(BackendEvent::AssistantText {
                        text: "x".repeat(unit_bytes),
                        finish_reason: None,
                    });
                }
                BackendTerminal::Completed {
                    finish_reason: FinishReason::Completed,
                }
            })
        })
    }
}

impl LlmExecutionBackend for ScriptedBackend {
    fn execute(
        &self,
        request: BackendRequest,
        events: EventSink,
        cancel: CancellationToken,
    ) -> BackendFuture {
        self.starts.fetch_add(1, Ordering::SeqCst);
        (self.run)(request, events, cancel)
    }
}

/// Real-loopback host whose tertiary is the supplied Broca component, with
/// the fixed direct-profile catalog shape (magic-context, synapse, broca).
///
/// The host requires Linux because `support::synapse::EchoPrimary` is Linux-gated and Synapse ships only for `linux-x64-gnu`. commentlint: allow(JUDGE)
#[cfg(target_os = "linux")]
pub async fn start_broca_host(component: BrocaComponent) -> super::CompositeTestHost {
    let composite = StaticComposite::new(
        super::synapse::EchoPrimary,
        super::StubComponent::new("synapse", "management_surface"),
        component,
    )
    .expect("distinct component ids");
    super::CompositeTestHost::start(composite, |config| {
        config.timing.lifecycle_callback_deadline = Duration::from_secs(3);
    })
    .await
}

pub async fn open_broca_route(
    client: &mut raw_client::RawClient,
    harness: &str,
    session: &str,
) -> (u16, u32) {
    client
        .route_open_target(
            "management_surface",
            BROCA_MODULE_ID,
            ROOT,
            harness,
            session,
        )
        .await
        .expect("broca route binds")
}

/// One `{method, params}` application call over an open Broca route,
/// returning the terminal frame.
pub async fn call(
    client: &mut raw_client::RawClient,
    channel: u16,
    epoch: u32,
    method: &str,
    params: serde_json::Value,
) -> RawFrame {
    let corr = send_call(client, channel, epoch, method, params).await;
    let (_skipped, frame) = client
        .frames_until_corr(corr, BUDGET)
        .await
        .expect("terminal");
    frame
}

/// Sends the call without waiting, returning its correlation — for
/// subscriptions and detach tests that need the correlation later.
pub async fn send_call(
    client: &mut raw_client::RawClient,
    channel: u16,
    epoch: u32,
    method: &str,
    params: serde_json::Value,
) -> u64 {
    let corr = client.next_corr();
    let body = serde_json::to_vec(&serde_json::json!({"method": method, "params": params}))
        .expect("request serializes");
    client
        .send_frame(
            raw_client::TY_REQUEST,
            raw_client::FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &body,
        )
        .await
        .expect("send request");
    corr
}

/// The `session.send` params `HistorianProducer` emits today: nested
/// provider/model object, empty tools, explicit generation values.
pub fn send_params(prompt: &str, system: Option<&str>, model: &str) -> serde_json::Value {
    let (provider, model_name) = model.split_once('/').expect("canonical provider/model");
    let mut params = serde_json::json!({
        "prompt": prompt,
        "model": { "provider": provider, "model": model_name },
        "tools": [],
        "generation": { "max_output_tokens": 32_000, "temperature": 0.1 },
    });
    if let Some(system) = system {
        params["system"] = system.into();
    }
    params
}

/// Drains one subscription's stream: every `StreamData` body in order, then
/// the transport terminal frame (`StreamEnd` on the happy path).
pub async fn drain_subscribe(
    client: &mut raw_client::RawClient,
    corr: u64,
) -> (Vec<serde_json::Value>, RawFrame) {
    let mut units = Vec::new();
    loop {
        let frame = client.frame_within(BUDGET).await.expect("stream frame");
        if frame.corr != corr || frame.ty == raw_client::TY_PING {
            continue;
        }
        if frame.ty == raw_client::TY_STREAM_DATA {
            units.push(frame.json());
            continue;
        }
        return (units, frame);
    }
}
