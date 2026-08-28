//! Request dispatch: correlation fencing, at-most-once handler invocation,
//! ordered streaming, and first-terminal-wins settlement under races.

mod support;

use std::collections::HashSet;
use std::process::Command;
use std::time::Duration;

use mc_host::{ResourceDeclaration, RouteClass, StaticComposite};
use support::raw_client::{
    RawFrame, FLAGS_INTERACTIVE, FLAGS_PURE_HEADER, TY_CANCEL, TY_ERROR, TY_GOODBYE, TY_REQUEST,
    TY_RESPONSE, TY_STREAM_DATA, TY_STREAM_END,
};
use support::{mode_body, CompositeTestHost, TestHost, LINKED_MODULE_ID};

const BUDGET: Duration = Duration::from_secs(5);
const ROOT: &str = "/workspace/project";
const PANIC_CHILD_ENV: &str = "MC_HOST_PANIC_REDACTION_CHILD";
const REDACTED_PANIC_DIAGNOSTIC: &str = "mc-host handler callback panicked (details redacted)";

#[tokio::test]
async fn a_unary_request_dispatches_once_with_one_matching_terminal() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "unary")
        .await
        .expect("route");

    let corr = client.next_corr();
    let body = support::echo_body("hello-host");
    client
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, channel, epoch, corr, &body)
        .await
        .expect("send request");

    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.ty, TY_RESPONSE);
    assert_eq!(frame.channel, channel, "terminals echo their channel");
    assert_eq!(frame.epoch, epoch, "terminals echo their epoch");
    assert_eq!(frame.corr, corr, "terminals echo their correlation");
    assert_eq!(frame.body, body, "the opaque body round-trips unchanged");
    assert_eq!(host.handler.dispatch_count(), 1);

    // No second terminal follows.
    assert!(
        tokio::time::timeout(Duration::from_millis(300), client.expect_frame())
            .await
            .is_err(),
        "exactly one terminal per correlation"
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn an_application_error_is_a_terminal_for_its_correlation_only() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "errors")
        .await
        .expect("route");

    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &mode_body(serde_json::json!({
                "mode": "error",
                "code": "store_unavailable",
                "message": "storage still opening"
            })),
        )
        .await
        .expect("send");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.ty, TY_ERROR);
    assert_eq!(frame.error_code(), "store_unavailable");

    // The transport stays connected and the next request succeeds.
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &support::echo_body("still-alive"),
        )
        .await
        .expect("send");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.ty, TY_RESPONSE);
    assert_eq!(frame.corr, corr);

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn streams_are_ordered_and_end_with_exactly_one_terminal() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "stream")
        .await
        .expect("route");

    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &mode_body(serde_json::json!({"mode": "stream", "items": 5})),
        )
        .await
        .expect("send");

    let mut items = Vec::new();
    let terminal = loop {
        let frame = client.frame_within(BUDGET).await.expect("stream frame");
        assert_eq!(frame.corr, corr);
        assert_eq!(frame.channel, channel);
        assert_eq!(frame.epoch, epoch);
        match frame.ty {
            TY_STREAM_DATA => items.push(frame.json()["item"].as_u64().expect("item index")),
            _ => break frame,
        }
    };

    assert_eq!(items, vec![0, 1, 2, 3, 4], "stream items must stay ordered");
    assert_eq!(terminal.ty, TY_STREAM_END);
    assert!(terminal.body.is_empty(), "StreamEnd carries no body");
    assert!(
        tokio::time::timeout(Duration::from_millis(300), client.expect_frame())
            .await
            .is_err(),
        "nothing may follow the stream terminal"
    );

    host.shutdown_gracefully().await;
}

/// Each generation owns its correlation namespace, and within one generation
/// correlations must strictly increase (protocol §8.3, V18, V44).
#[tokio::test]
async fn correlation_namespaces_are_per_generation_and_strictly_increasing() {
    let host = TestHost::start().await;

    // Two generations may both use correlation 1 without colliding.
    let mut first = host.client().await;
    let mut second = host.client().await;
    let (first_channel, first_epoch) = first
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "gen-a")
        .await
        .expect("route a");
    let (second_channel, second_epoch) = second
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "gen-b")
        .await
        .expect("route b");

    // route_open already consumed correlation 1 on each generation, so send the
    // next correlation on both and confirm terminals do not cross.
    let first_corr = first.next_corr();
    first
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            first_channel,
            first_epoch,
            first_corr,
            &support::echo_body("from-a"),
        )
        .await
        .expect("send a");
    let second_corr = second.next_corr();
    second
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            second_channel,
            second_epoch,
            second_corr,
            &support::echo_body("from-b"),
        )
        .await
        .expect("send b");
    assert_eq!(
        first_corr, second_corr,
        "the fixture must exercise the same numeric correlation on both"
    );

    let a = first.frame_within(BUDGET).await.expect("terminal a");
    let b = second.frame_within(BUDGET).await.expect("terminal b");
    assert_eq!(a.body, support::echo_body("from-a"));
    assert_eq!(b.body, support::echo_body("from-b"));

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn a_non_increasing_correlation_closes_the_generation_before_dispatch() {
    for reuse in ["repeat", "lower"] {
        let host = TestHost::start().await;
        let mut client = host.client().await;
        let (channel, epoch) = client
            .route_open(LINKED_MODULE_ID, ROOT, "opencode", "watermark")
            .await
            .expect("route");

        let corr = client.next_corr();
        client
            .send_frame(
                TY_REQUEST,
                FLAGS_INTERACTIVE,
                channel,
                epoch,
                corr,
                &support::echo_body("first"),
            )
            .await
            .expect("send first");
        let frame = client.frame_within(BUDGET).await.expect("terminal");
        assert_eq!(frame.corr, corr);
        let dispatches = host.handler.dispatch_count();

        let violating = if reuse == "repeat" { corr } else { corr - 1 };
        client
            .send_frame(
                TY_REQUEST,
                FLAGS_INTERACTIVE,
                channel,
                epoch,
                violating,
                &support::echo_body("duplicate"),
            )
            .await
            .expect("send violating");

        assert!(
            client
                .drain_until_close(Duration::from_secs(2))
                .await
                .is_empty(),
            "{reuse}: a watermark violation must not produce a terminal"
        );
        assert!(
            client.closed_within(Duration::from_secs(2)).await,
            "{reuse}: the generation must close"
        );
        assert_eq!(
            host.handler.dispatch_count(),
            dispatches,
            "{reuse}: the duplicate must never dispatch"
        );

        host.shutdown_gracefully().await;
    }
}

#[tokio::test]
async fn an_unknown_route_is_refused_with_zero_dispatch() {
    let host = TestHost::start().await;
    let mut client = host.client().await;

    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            4242,
            7,
            corr,
            &support::echo_body("nowhere"),
        )
        .await
        .expect("send");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.error_code(), "unknown_channel");
    assert_eq!(host.handler.dispatch_count(), 0);

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn saturated_request_capacity_returns_server_busy_without_dispatch() {
    let host = TestHost::start_with(|config| {
        config.limits.max_pending_requests = 1;
    })
    .await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "busy")
        .await
        .expect("route");

    // Occupy the only pending slot with a request that never completes.
    let holding = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            holding,
            &mode_body(serde_json::json!({"mode": "hang"})),
        )
        .await
        .expect("send holding");

    // Wait until the handler is actually holding the slot.
    let deadline = tokio::time::Instant::now() + BUDGET;
    while host.handler.dispatch_count() == 0 {
        assert!(tokio::time::Instant::now() < deadline, "handler never ran");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let dispatches = host.handler.dispatch_count();

    let rejected = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            rejected,
            &support::echo_body("overflow"),
        )
        .await
        .expect("send overflow");
    let (skipped, frame) = client
        .frames_until_corr(rejected, BUDGET)
        .await
        .expect("busy terminal");
    assert!(skipped.is_empty());
    assert_eq!(frame.error_code(), "server_busy");
    assert_eq!(
        host.handler.dispatch_count(),
        dispatches,
        "server_busy must prove no handler dispatch"
    );

    host.shutdown_gracefully().await;
}

/// Cancel and completion race on one settlement object; exactly one terminal
/// may reach the wire (protocol §9.2, V33, V34).
#[tokio::test]
async fn cancel_and_completion_settle_exactly_once() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "cancel")
        .await
        .expect("route");

    // Cancel wins: the handler waits for cancellation before returning.
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &mode_body(serde_json::json!({"mode": "await_cancel"})),
        )
        .await
        .expect("send");
    let deadline = tokio::time::Instant::now() + BUDGET;
    while host.handler.dispatch_count() == 0 {
        assert!(tokio::time::Instant::now() < deadline, "handler never ran");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    client
        .send_frame(TY_CANCEL, FLAGS_PURE_HEADER, channel, epoch, corr, &[])
        .await
        .expect("cancel");

    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.corr, corr);
    assert_eq!(
        frame.error_code(),
        "cancelled",
        "cancellation won the arbiter"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(300), client.expect_frame())
            .await
            .is_err(),
        "the handler's late completion must not settle a second time"
    );

    // Completion wins: a late Cancel against a settled correlation is a no-op.
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &support::echo_body("fast"),
        )
        .await
        .expect("send");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.ty, TY_RESPONSE);
    client
        .send_frame(TY_CANCEL, FLAGS_PURE_HEADER, channel, epoch, corr, &[])
        .await
        .expect("late cancel");
    assert!(
        tokio::time::timeout(Duration::from_millis(300), client.expect_frame())
            .await
            .is_err(),
        "a late Cancel must be an idempotent no-op"
    );

    // An unknown correlation is likewise inert, and the connection survives.
    client
        .send_frame(TY_CANCEL, FLAGS_PURE_HEADER, channel, epoch, 99_999, &[])
        .await
        .expect("unknown cancel");
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &support::echo_body("after"),
        )
        .await
        .expect("send");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.corr, corr);

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn simultaneous_cancel_and_completion_still_emit_one_terminal() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "race")
        .await
        .expect("route");

    for iteration in 0..20 {
        let corr = client.next_corr();
        client
            .send_frame(
                TY_REQUEST,
                FLAGS_INTERACTIVE,
                channel,
                epoch,
                corr,
                &mode_body(serde_json::json!({"mode": "await_completion"})),
            )
            .await
            .expect("send raced request");
        let expected_dispatches = iteration + 1;
        let deadline = tokio::time::Instant::now() + BUDGET;
        while host.handler.dispatch_count() < expected_dispatches {
            assert!(tokio::time::Instant::now() < deadline, "handler never ran");
            tokio::time::sleep(Duration::from_millis(1)).await;
        }

        let release = async {
            tokio::task::yield_now().await;
            host.handler.release_completion();
        };
        let cancel = client.send_frame(TY_CANCEL, FLAGS_PURE_HEADER, channel, epoch, corr, &[]);
        let (_, sent) = tokio::join!(release, cancel);
        sent.expect("send cancel");

        let frame = client.frame_within(BUDGET).await.expect("one terminal");
        assert_eq!(frame.corr, corr);
        assert!(matches!(frame.ty, TY_RESPONSE | TY_ERROR));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), client.expect_frame())
                .await
                .is_err(),
            "iteration {iteration} emitted a duplicate terminal"
        );
    }

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn cancelling_a_stream_stops_it_with_one_terminal() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "stream-cancel")
        .await
        .expect("route");

    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &mode_body(serde_json::json!({"mode": "stream_then_hang", "items": 2})),
        )
        .await
        .expect("send");

    // Consume the emitted items, then cancel mid-stream.
    let mut seen = 0;
    while seen < 2 {
        let frame = client.frame_within(BUDGET).await.expect("stream item");
        assert_eq!(frame.ty, TY_STREAM_DATA);
        assert_eq!(frame.corr, corr);
        seen += 1;
    }
    client
        .send_frame(TY_CANCEL, FLAGS_PURE_HEADER, channel, epoch, corr, &[])
        .await
        .expect("cancel");

    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.error_code(), "cancelled");
    assert!(
        tokio::time::timeout(Duration::from_millis(300), client.expect_frame())
            .await
            .is_err(),
        "no frame may follow the selected terminal"
    );

    host.shutdown_gracefully().await;
}

/// A request-handler panic is correlation-local and redacted (plan KTD9).
#[tokio::test]
async fn a_handler_panic_maps_to_one_redacted_internal_error() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "panic")
        .await
        .expect("route");

    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &mode_body(serde_json::json!({"mode": "panic"})),
        )
        .await
        .expect("send");

    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.error_code(), "internal_error");
    let rendered = String::from_utf8_lossy(&frame.body);
    let canary = String::from_utf8_lossy(support::CANARY_BODY);
    assert!(
        !rendered.contains(canary.as_ref()),
        "the panic payload must not reach the wire: {rendered}"
    );

    // The route and connection survive; an unrelated request still completes.
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &support::echo_body("after-panic"),
        )
        .await
        .expect("send");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.ty, TY_RESPONSE);
    assert_eq!(frame.corr, corr);

    host.shutdown_gracefully().await;
}

#[test]
fn handler_panic_payload_is_redacted_from_process_stderr() {
    let output = Command::new(std::env::current_exe().expect("test executable"))
        .args(["--exact", "panic_redaction_subprocess_child", "--nocapture"])
        .env(PANIC_CHILD_ENV, "1")
        .output()
        .expect("run panic redaction subprocess");
    assert!(
        output.status.success(),
        "subprocess failed:\nstdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(REDACTED_PANIC_DIAGNOSTIC),
        "fixed redacted diagnostic missing: {stderr}"
    );
    assert!(
        !stderr.contains(String::from_utf8_lossy(support::CANARY_BODY).as_ref()),
        "handler panic payload reached stderr: {stderr}"
    );
    assert!(
        stderr.contains("UNRELATED-PANIC-CANARY"),
        "unrelated panic did not chain to the prior hook: {stderr}"
    );
}

#[tokio::test]
async fn panic_redaction_subprocess_child() {
    if std::env::var_os(PANIC_CHILD_ENV).is_none() {
        return;
    }
    std::panic::set_hook(Box::new(|info| eprintln!("prior panic hook: {info}")));

    let host = TestHost::start().await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "panic-stderr")
        .await
        .expect("route");
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &mode_body(serde_json::json!({"mode": "panic"})),
        )
        .await
        .expect("send");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.error_code(), "internal_error");
    host.shutdown_gracefully().await;

    let _ = std::panic::catch_unwind(|| panic!("UNRELATED-PANIC-CANARY"));
}

#[tokio::test]
async fn oversized_handler_output_cannot_corrupt_framing() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "output-limits")
        .await
        .expect("route");

    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &mode_body(serde_json::json!({"mode": "oversize_response"})),
        )
        .await
        .expect("send");
    let frame = client.frame_within(BUDGET).await.expect("bounded terminal");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.error_code(), "internal_error");

    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &mode_body(serde_json::json!({"mode": "oversize_stream"})),
        )
        .await
        .expect("send");
    // An oversized stream item fails the request outright: the handler's
    // later unary response loses to the already-settled error terminal, so
    // the client can never observe a truncated-but-successful stream.
    let frame = client.frame_within(BUDGET).await.expect("bounded terminal");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.error_code(), "internal_error");

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn concurrent_handler_output_is_reserved_before_allocation() {
    let host = TestHost::start_with(|config| {
        // The cached catalog subtracts from the resident budget at startup;
        // 64 KiB of headroom keeps the egress budget at its one-frame floor.
        config.limits.max_resident_bytes = mc_host::config::MIN_RESIDENT_BYTES + 64 * 1024;
    })
    .await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "egress")
        .await
        .expect("route");

    let mut corrs = Vec::new();
    for _ in 0..2 {
        let corr = client.next_corr();
        client
            .send_frame(
                TY_REQUEST,
                FLAGS_INTERACTIVE,
                channel,
                epoch,
                corr,
                &mode_body(serde_json::json!({
                    "mode": "reserve_then_await_completion",
                    "bytes": 40 * 1024 * 1024
                })),
            )
            .await
            .expect("send large response request");
        corrs.push(corr);
    }

    let deadline = tokio::time::Instant::now() + BUDGET;
    while host.handler.dispatch_count() < 2 || host.handler.output_reservation_count() < 1 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "handlers did not start"
        );
        tokio::task::yield_now().await;
    }
    assert_eq!(
        host.handler.output_reservation_count(),
        1,
        "the egress budget cannot reserve two 40 MiB handler buffers"
    );

    host.handler.release_completion();
    let first = client
        .frame_within(Duration::from_secs(30))
        .await
        .expect("first large response");
    assert_eq!(first.ty, TY_RESPONSE);
    corrs.retain(|corr| *corr != first.corr);

    let deadline = tokio::time::Instant::now() + BUDGET;
    while host.handler.output_reservation_count() < 2 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "second reservation stayed blocked after the first body flushed"
        );
        tokio::task::yield_now().await;
    }
    host.handler.release_completion();
    let second = client
        .frame_within(Duration::from_secs(30))
        .await
        .expect("second large response");
    assert_eq!(second.ty, TY_RESPONSE);
    corrs.retain(|corr| *corr != second.corr);
    assert!(corrs.is_empty());

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn egress_budget_deadline_retires_the_generation() {
    let host = TestHost::start_with(|config| {
        config.limits.max_resident_bytes = mc_host::config::MIN_RESIDENT_BYTES + 64 * 1024;
        config.timing.frame_deadline = Duration::from_millis(100);
    })
    .await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "egress-deadline")
        .await
        .expect("route");

    for _ in 0..2 {
        let corr = client.next_corr();
        client
            .send_frame(
                TY_REQUEST,
                FLAGS_INTERACTIVE,
                channel,
                epoch,
                corr,
                &mode_body(serde_json::json!({
                    "mode": "reserve_then_await_completion",
                    "bytes": 40 * 1024 * 1024
                })),
            )
            .await
            .expect("send large response request");
    }

    let deadline = tokio::time::Instant::now() + BUDGET;
    while host.handler.dispatch_count() < 2 || host.handler.output_reservation_count() < 1 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "handlers did not start"
        );
        tokio::task::yield_now().await;
    }
    assert!(
        client.closed_within(BUDGET).await,
        "the blocked second reservation must retire the generation"
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn closing_a_route_settles_its_admitted_work() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "close")
        .await
        .expect("route");

    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &mode_body(serde_json::json!({"mode": "hang"})),
        )
        .await
        .expect("send");
    let deadline = tokio::time::Instant::now() + BUDGET;
    while host.handler.dispatch_count() == 0 {
        assert!(tokio::time::Instant::now() < deadline, "handler never ran");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    client
        .send_frame(TY_GOODBYE, FLAGS_PURE_HEADER, channel, epoch, 0, &[])
        .await
        .expect("route goodbye");

    // The in-flight request settles as cancelled while the writer is still live.
    let (_, frame) = client
        .frames_until_corr(corr, BUDGET)
        .await
        .expect("terminal for the closed route's work");
    assert_eq!(frame.error_code(), "cancelled");

    // Cleanup completed exactly once for the route.
    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        let gones = host.handler.route_gones();
        if gones.iter().any(|handle| handle.channel == channel) {
            assert_eq!(
                gones.iter().filter(|h| h.channel == channel).count(),
                1,
                "route-gone must fire once"
            );
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "route-gone missing");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn concurrent_requests_never_interleave_frame_bytes() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "concurrent")
        .await
        .expect("route");

    // Overlap streams and unary work so the single writer is contended.
    let mut expected = HashSet::new();
    for _ in 0..6 {
        let corr = client.next_corr();
        expected.insert(corr);
        client
            .send_frame(
                TY_REQUEST,
                FLAGS_INTERACTIVE,
                channel,
                epoch,
                corr,
                &mode_body(serde_json::json!({"mode": "stream", "items": 4})),
            )
            .await
            .expect("send stream");
        let corr = client.next_corr();
        expected.insert(corr);
        client
            .send_frame(
                TY_REQUEST,
                FLAGS_INTERACTIVE,
                channel,
                epoch,
                corr,
                &support::echo_body("unary"),
            )
            .await
            .expect("send unary");
    }

    // Every frame must decode cleanly, which is only true if no two frames'
    // bytes interleaved on the socket.
    let mut settled = HashSet::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while settled.len() < expected.len() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "settled {settled:?} of {expected:?}"
        );
        let frame: RawFrame = client.frame_within(BUDGET).await.expect("frame");
        assert_eq!(frame.ver, 2, "a torn frame would decode a bogus version");
        assert!(
            expected.contains(&frame.corr),
            "unexpected correlation {}",
            frame.corr
        );
        match frame.ty {
            TY_STREAM_DATA => {}
            TY_RESPONSE | TY_STREAM_END => {
                assert!(settled.insert(frame.corr), "duplicate terminal");
            }
            other => panic!("unexpected frame type {other}"),
        }
    }

    host.shutdown_gracefully().await;
}

/// The direct profile's Broca declaration (R13): 96 reserved pending slots
/// and 96 reserved handler tasks on the reserved class.
fn broca_reservation() -> ResourceDeclaration {
    ResourceDeclaration {
        reserved_handler_tasks: 96,
        reserved_pending_requests: 96,
        retained_resident_bytes: 0,
        general_task_hold_bound: 0,
        route_class: RouteClass::Reserved,
    }
}

/// Saturating every reserved permit through blocked settlement rejects the
/// next reserved-class request while a general request still dispatches and
/// settles (plan KTD2, AE9).
#[tokio::test]
async fn saturated_broca_reserve_cannot_consume_a_general_slot() {
    let (mc, synapse, broca) = support::stub_trio();
    let broca = broca.with_resources(broca_reservation());
    let composite = StaticComposite::new(mc.clone(), synapse, broca.clone()).expect("distinct ids");
    let host = CompositeTestHost::start(composite, |config| {
        // Exactly one general slot in each pool beside the 96-slot reserve.
        config.limits.max_pending_requests = 97;
        config.limits.max_handler_tasks = 97;
    })
    .await;
    let mut client = host.client().await;
    let (br_channel, br_epoch) = client
        .route_open_target("management_surface", "broca", ROOT, "opencode", "s1")
        .await
        .expect("broca binds");
    let (mc_channel, mc_epoch) = client
        .route_open_target("tool_provider", "magic-context", ROOT, "opencode", "s1")
        .await
        .expect("magic-context binds");

    // 64 subscription-shaped plus 32 command-shaped unsettled requests: all
    // 96 reserved pending and task permits held by hanging handler tasks.
    for _ in 0..96 {
        let corr = client.next_corr();
        client
            .send_frame(
                TY_REQUEST,
                FLAGS_INTERACTIVE,
                br_channel,
                br_epoch,
                corr,
                &mode_body(serde_json::json!({"mode": "hang"})),
            )
            .await
            .expect("send reserved hang");
    }
    let deadline = tokio::time::Instant::now() + BUDGET;
    while broca.dispatch_count() < 96 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "reserved handlers never occupied their permits"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    // Request 97 on the reserved class fails fast without dispatch.
    let rejected = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            br_channel,
            br_epoch,
            rejected,
            &mode_body(serde_json::json!({"mode": "echo"})),
        )
        .await
        .expect("send overflow");
    let (skipped, frame) = client
        .frames_until_corr(rejected, BUDGET)
        .await
        .expect("busy terminal");
    assert!(skipped.is_empty());
    assert_eq!(frame.error_code(), "server_busy");
    assert_eq!(
        broca.dispatch_count(),
        96,
        "the rejected reserved request must never dispatch"
    );

    // The general class is untouched: a Magic Context request settles.
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            mc_channel,
            mc_epoch,
            corr,
            &mode_body(serde_json::json!({"mode": "echo"})),
        )
        .await
        .expect("send general request");
    let (skipped, frame) = client
        .frames_until_corr(corr, BUDGET)
        .await
        .expect("general terminal");
    assert!(skipped.is_empty());
    assert_eq!(frame.ty, TY_RESPONSE);
    assert_eq!(frame.json()["served_by"], "magic-context");

    host.shutdown().await.expect("graceful shutdown");
}

/// The converse isolation: exhausting the general class rejects further
/// general requests while a reserved-class request still dispatches.
#[tokio::test]
async fn saturated_general_capacity_cannot_consume_the_broca_reserve() {
    let (mc, synapse, broca) = support::stub_trio();
    let broca = broca.with_resources(broca_reservation());
    let composite = StaticComposite::new(mc.clone(), synapse, broca.clone()).expect("distinct ids");
    let host = CompositeTestHost::start(composite, |config| {
        config.limits.max_pending_requests = 97;
        config.limits.max_handler_tasks = 97;
    })
    .await;
    let mut client = host.client().await;
    let (mc_channel, mc_epoch) = client
        .route_open_target("tool_provider", "magic-context", ROOT, "opencode", "s1")
        .await
        .expect("magic-context binds");
    let (br_channel, br_epoch) = client
        .route_open_target("management_surface", "broca", ROOT, "opencode", "s1")
        .await
        .expect("broca binds");

    // Occupy the single general slot with a request that never settles.
    let holding = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            mc_channel,
            mc_epoch,
            holding,
            &mode_body(serde_json::json!({"mode": "hang"})),
        )
        .await
        .expect("send general hang");
    let deadline = tokio::time::Instant::now() + BUDGET;
    while mc.dispatch_count() == 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the general handler never occupied its permit"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let rejected = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            mc_channel,
            mc_epoch,
            rejected,
            &mode_body(serde_json::json!({"mode": "echo"})),
        )
        .await
        .expect("send general overflow");
    let (skipped, frame) = client
        .frames_until_corr(rejected, BUDGET)
        .await
        .expect("busy terminal");
    assert!(skipped.is_empty());
    assert_eq!(frame.error_code(), "server_busy");
    assert_eq!(mc.dispatch_count(), 1);

    // The reserved class stays available to Broca.
    let corr = client.next_corr();
    client
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            br_channel,
            br_epoch,
            corr,
            &mode_body(serde_json::json!({"mode": "echo"})),
        )
        .await
        .expect("send reserved request");
    let (skipped, frame) = client
        .frames_until_corr(corr, BUDGET)
        .await
        .expect("reserved terminal");
    assert!(skipped.is_empty());
    assert_eq!(frame.ty, TY_RESPONSE);
    assert_eq!(frame.json()["served_by"], "broca");

    host.shutdown().await.expect("graceful shutdown");
}
