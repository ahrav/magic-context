#!/usr/bin/env bun

import { connectionFilePath } from "../src/shared/mc-host-lifecycle/paths";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import {
    AdmissionClass,
    Priority,
    McHostClient,
    type RequestOptions,
    type RouteHandle,
    type McHostDiagnosticsEvent,
} from "../src/shared/mc-host-client";

import { McHostModuleTransport } from "../src/hooks/magic-context/module-transport";
import { buildPagedModuleTransformPayloads } from "../src/hooks/magic-context/module-wire";

type JsonRecord = Record<string, unknown>;

type Scenario = {
    name: string;
    body: JsonRecord;
    options?: RequestOptions;
};

type SampleSummary = {
    count: number;
    min_ms: number;
    p50_ms: number;
    p95_ms: number;
    max_ms: number;
    mean_ms: number;
};

type PhaseTrace = {
    requestStartedAtMs: number;
    writeStartAtMs?: number;
    writeCompleteAtMs?: number;
    headerAtMs?: number;
    dispatchAtMs?: number;
};

type InstrumentedRequest = {
    response: JsonRecord;
    trace: Required<PhaseTrace>;
    roundTripMs: number;
};

const probeProcessStartedAt = new Date().toISOString();
const argv = process.argv.slice(2);

function option(name: string): string | undefined {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
}

function positiveInteger(name: string, fallback: number): number {
    const raw = option(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}

function round(value: number): number {
    return Number(value.toFixed(3));
}

function percentile(sorted: readonly number[], quantile: number): number {
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * quantile) - 1),
    );
    return sorted[index] ?? 0;
}

function summarize(samples: readonly number[]): SampleSummary {
    const values = summarizeScalars(samples);
    return {
        count: values.count,
        min_ms: values.min,
        p50_ms: values.p50,
        p95_ms: values.p95,
        max_ms: values.max,
        mean_ms: values.mean,
    };
}

function summarizeScalars(samples: readonly number[]): {
    count: number;
    min: number;
    p50: number;
    p95: number;
    max: number;
    mean: number;
} {
    const sorted = [...samples].sort((left, right) => left - right);
    const total = sorted.reduce((sum, value) => sum + value, 0);
    return {
        count: sorted.length,
        min: round(sorted[0] ?? 0),
        p50: round(percentile(sorted, 0.5)),
        p95: round(percentile(sorted, 0.95)),
        max: round(sorted.at(-1) ?? 0),
        mean: round(sorted.length === 0 ? 0 : total / sorted.length),
    };
}

function serializedBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value));
}

function echoBody(serializedTargetBytes: number): JsonRecord {
    const body = { method: "echo", probe: "" };
    const fixedBytes = serializedBytes(body);
    if (serializedTargetBytes < fixedBytes) {
        throw new Error(`serialized echo target must be at least ${fixedBytes} bytes`);
    }
    body.probe = "x".repeat(serializedTargetBytes - fixedBytes);
    if (serializedBytes(body) !== serializedTargetBytes) {
        throw new Error("failed to construct an exact-size echo body");
    }
    return body;
}

function codecProxy(value: unknown, samples: number): {
    bytes: number;
    stringify: SampleSummary;
    parse: SampleSummary;
} {
    const serialized = JSON.stringify(value);
    const stringifySamples: number[] = [];
    const parseSamples: number[] = [];
    for (let index = 0; index < samples; index += 1) {
        let startedAt = performance.now();
        JSON.stringify(value);
        stringifySamples.push(performance.now() - startedAt);
        startedAt = performance.now();
        try {
            JSON.parse(serialized);
        } catch {
        }
        parseSamples.push(performance.now() - startedAt);
    }
    return {
        bytes: Buffer.byteLength(serialized),
        stringify: summarize(stringifySamples),
        parse: summarize(parseSamples),
    };
}

function processStartedAt(pid: number): string | null {
    const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
    if (result.exitCode !== 0) return null;
    const raw = result.stdout.toString().trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.valueOf()) ? raw : parsed.toISOString();
}

function responseTiming(response: JsonRecord, name: string): number {
    const timings = response.timings;
    if (!timings || typeof timings !== "object") return 0;
    const value = (timings as JsonRecord)[name];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function responseCounter(response: JsonRecord, name: string): number {
    const value = responseTiming(response, name);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function textForMessage(bytesPerMessage: number, iteration: number): string {
    const suffix = `-${iteration.toString().padStart(8, "0")}`;
    return `${"x".repeat(Math.max(1, bytesPerMessage - suffix.length))}${suffix}`;
}

function realShapeMessage(
    sessionId: string,
    index: number,
    text: string,
): { ck: JsonRecord; native: JsonRecord } {
    const id = `transport-real-${index}`;
    return {
        ck: {
            mid: id,
            ordinal: index + 1,
            ck: {
                role: "user",
                content: [{ kind: { type: "text", text } }],
                meta: { harness_id: id },
            },
        },
        native: {
            info: { id, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text }],
        },
    };
}

function fullTransformBody(
    sessionId: string,
    messageCount: number,
    responseTargetBytes: number,
): { body: JsonRecord; bytesPerMessage: number; fingerprint: string } {
    const bytesPerMessage = Math.max(64, Math.floor(responseTargetBytes / messageCount));
    const messages = Array.from({ length: messageCount }, (_, index) =>
        realShapeMessage(sessionId, index, textForMessage(bytesPerMessage, 0)),
    );
    const fingerprint = `${sessionId}-fp-0`;
    return {
        bytesPerMessage,
        fingerprint,
        body: {
            method: "transform",
            kind: "transform",
            v: 2,
            serializer_profile: "opencode-aisdk",
            serve_native: true,
            session_id: sessionId,
            render_config: "transport-real-shape-v1",
            system_prompt_hash: "transport-real-shape",
            provider_id: "anthropic",
            model_key: "anthropic/transport-probe",
            full_array_fingerprint: fingerprint,
            messages: messages.map((message) => message.ck),
            native_messages: messages.map((message) => message.native),
            usage: { input_tokens: 1_000, percentage: 1, context_limit: 100_000 },
            effective_execute_threshold: 65,
            history_budget_tokens: 50_000,
            clear_reasoning_age: 50,
            cache_ttl: "5m",
            prompt_surface_preset: "light",
        },
    };
}

function tailTransformBody(args: {
    sessionId: string;
    messageCount: number;
    bytesPerMessage: number;
    previousFingerprint: string;
    iteration: number;
}): { body: JsonRecord; fingerprint: string } {
    const lastIndex = args.messageCount - 1;
    const message = realShapeMessage(
        args.sessionId,
        lastIndex,
        textForMessage(args.bytesPerMessage, 1),
    );
    const fingerprint = `${args.sessionId}-fp-${args.iteration}`;
    return {
        fingerprint,
        body: {
            method: "transform",
            kind: "transform",
            v: 2,
            serializer_profile: "opencode-aisdk",
            serve_native: true,
            session_id: args.sessionId,
            render_config: "transport-real-shape-v1",
            system_prompt_hash: "transport-real-shape",
            provider_id: "anthropic",
            model_key: "anthropic/transport-probe",
            full_array_fingerprint: fingerprint,
            tail_delta: {
                after: args.previousFingerprint,
                replace_from: lastIndex,
                native_replace_from: lastIndex,
            },
            messages: [message.ck],
            native_messages: [message.native],
            usage: { input_tokens: 1_000, percentage: 1, context_limit: 100_000 },
            effective_execute_threshold: 65,
            history_budget_tokens: 50_000,
            clear_reasoning_age: 50,
            cache_ttl: "5m",
            prompt_surface_preset: "light",
        },
    };
}

const FRAME_TYPE_REQUEST = 0;
const RESPONSE_TERMINAL_FRAME_TYPES = new Set<number>([1, 5]); // Response, Error

let activeTrace: PhaseTrace | null = null;
let activeChannel = -1;
let daemonPid: number | null = null;

function observeDiagnostics(event: McHostDiagnosticsEvent): void {
    if (event.type === "connected") {
        daemonPid = event.pid ?? null;
        return;
    }
    const trace = activeTrace;
    if (!trace || event.channel !== activeChannel) return;
    if (event.frameType === FRAME_TYPE_REQUEST) {
        if (event.type === "write_start" && trace.writeStartAtMs === undefined) {
            trace.writeStartAtMs = event.atMs;
        } else if (event.type === "write_complete" && trace.writeCompleteAtMs === undefined) {
            trace.writeCompleteAtMs = event.atMs;
        }
        return;
    }
    if (event.frameType === undefined || !RESPONSE_TERMINAL_FRAME_TYPES.has(event.frameType)) {
        return;
    }
    if (event.type === "header" && trace.headerAtMs === undefined) {
        trace.headerAtMs = event.atMs;
    } else if (event.type === "dispatch" && trace.dispatchAtMs === undefined) {
        trace.dispatchAtMs = event.atMs;
    }
}

async function instrumentedRequest(
    client: McHostClient,
    route: RouteHandle,
    body: JsonRecord,
    options: RequestOptions,
): Promise<InstrumentedRequest> {
    if (activeTrace) throw new Error("transport probe requests must remain sequential");
    body.request_observed_at_ms = Date.now();
    const trace: PhaseTrace = { requestStartedAtMs: Date.now() };
    const startedAt = performance.now();
    activeTrace = trace;
    activeChannel = route.channel;
    try {
        const response = (await client.request(route, body, options)) as JsonRecord;
        const roundTripMs = performance.now() - startedAt;
        if (
            trace.writeStartAtMs === undefined ||
            trace.writeCompleteAtMs === undefined ||
            trace.headerAtMs === undefined ||
            trace.dispatchAtMs === undefined
        ) {
            throw new Error("transport response missed a diagnostics boundary");
        }
        return {
            response,
            roundTripMs,
            trace: trace as Required<PhaseTrace>,
        };
    } finally {
        activeTrace = null;
        activeChannel = -1;
    }
}

if (argv.includes("--help")) {
    console.log(`usage: bun packages/plugin/scripts/probe-mc-host-transport.ts [options]

options:
  --connection-file <path>       daemon connection file
  --module-id <id>               module id (default: magic-context)
  --project-root <path>          route project root (default: cwd)
  --samples <n>                  measured requests per scenario (default: 50)
  --warmup <n>                   warmup requests per scenario (default: 5)
  --timeout-ms <n>               per-request deadline (default: 10000)
  --fifo-concurrency <n>         concurrent module-transport calls, max 16 (default: 8)
  --real-response-kib <n>        real transform response target KiB (default: 2048)
  --real-response-messages <n>   real transform response message count (default: 310)`);
    process.exit(0);
}

const connectionFile = resolve(
    option("--connection-file") ??
        connectionFilePath(join(homedir(), ".local", "share")),
);
const moduleId = option("--module-id") ?? "magic-context";
const projectRoot = resolve(option("--project-root") ?? process.cwd());
const samples = positiveInteger("--samples", 50);
if (samples < 30) throw new Error("--samples must be at least 30");
const warmup = positiveInteger("--warmup", 5);
const timeoutMs = positiveInteger("--timeout-ms", 10_000);
const fifoConcurrency = positiveInteger("--fifo-concurrency", 8);
if (fifoConcurrency > 16) throw new Error("--fifo-concurrency cannot exceed 16");
const realResponseTargetBytes = positiveInteger("--real-response-kib", 2_048) * 1_024;
const realResponseMessages = positiveInteger("--real-response-messages", 310);
const session = `transport-probe-${process.pid}-${randomUUID()}`;
const smallBody = { method: "health", v: 1 };
const payloadSizes = [1, 4, 8, 16, 32].map((kibibytes) => kibibytes * 1024);
const productionRequestOptions: RequestOptions = {
    priority: Priority.Background,
    admissionClass: AdmissionClass.Normal,
    timeoutMs,
};
const scenarios: Scenario[] = [
    { name: "health_interactive", body: smallBody, options: { timeoutMs } },
    { name: "health_background_normal", body: smallBody, options: productionRequestOptions },
    ...payloadSizes.map((bytes) => ({
        name: `echo_${bytes / 1024}k_background_normal`,
        body: echoBody(bytes),
        options: productionRequestOptions,
    })),
];

const eventLoopDelay = monitorEventLoopDelay({ resolution: 1 });
eventLoopDelay.enable();
const connectStartedAt = performance.now();
const client = await McHostClient.connect({
    connectionFile,
    handshakeTimeoutMs: timeoutMs,
    diagnostics: observeDiagnostics,
    maxDiagnosticEventsPerSecond: 100_000,
});
const connectMs = performance.now() - connectStartedAt;
const daemonProcessStartedAt = daemonPid === null ? null : processStartedAt(daemonPid);
const connectionFileMtime = statSync(connectionFile).mtime.toISOString();
let routeOpenMs = 0;
let routeCloseMs = 0;
const results: Array<{
    name: string;
    request_bytes: number;
    response_bytes: number;
    round_trip: SampleSummary;
}> = [];
let realResponse: JsonRecord | undefined;
const realPhases: Record<string, number[]> = {
    round_trip: [],
    request_encode_and_queue: [],
    request_write: [],
    request_ingress_and_queue: [],
    module_apply_once: [],
    module_post_attach: [],
    module_handler_dispatch_and_bookkeeping: [],
    module_handler_total: [],
    response_encode_and_router: [],
    socket_read: [],
};
const realResponseBytes: number[] = [];
const nativeReused: number[] = [];
const nativeEncoded: number[] = [];
const moduleStageSamples = new Map<string, number[]>();
const moduleCounters = new Set([
    "build_identity_messages",
    "cache_dirty_skips",
    "cache_hits",
    "cache_misses",
    "emergency_reasoning_exclusions",
    "frozen_units",
    "full_drop_tool_ids",
    "native_cache_encoded_messages",
    "native_cache_reused_messages",
    "projection_blocks",
    "tag_mint_candidates",
    "tag_mint_new",
    "tag_mint_tokenized_bytes",
    "tail_messages_emitted",
    "tail_units_matched",
    "tokenize_bytes",
    "tokenize_cache_bypassed",
    "tokenize_cache_hits",
    "tokenize_cache_misses",
    "tokenize_calls",
    "trigger_tokenized_blocks",
]);
const decisions = new Map<string, number>();
let realRequestBytes = 0;

try {
    const routeOpenStartedAt = performance.now();
    const route = await client.routeOpen(
        { kind: "tool_provider", module_id: moduleId },
        { project_root: projectRoot, harness: "transport-probe", session },
    );
    routeOpenMs = performance.now() - routeOpenStartedAt;
    try {
        for (const scenario of scenarios) {
            for (let index = 0; index < warmup; index += 1) {
                await client.request(route, scenario.body, scenario.options);
            }
            const roundTrips: number[] = [];
            let response: unknown;
            for (let index = 0; index < samples; index += 1) {
                const startedAt = performance.now();
                response = await client.request(route, scenario.body, scenario.options);
                roundTrips.push(performance.now() - startedAt);
            }
            results.push({
                name: scenario.name,
                request_bytes: serializedBytes(scenario.body),
                response_bytes: serializedBytes(response),
                round_trip: summarize(roundTrips),
            });
        }

        const realSessionId = session;
        const full = fullTransformBody(
            realSessionId,
            realResponseMessages,
            realResponseTargetBytes,
        );
        let previousFingerprint = full.fingerprint;
        for (const { page } of buildPagedModuleTransformPayloads(full.body)) {
            const response = (await client.request(
                route,
                page,
                productionRequestOptions,
            )) as JsonRecord;
            if (typeof response.full_array_fingerprint === "string") {
                previousFingerprint = response.full_array_fingerprint;
            }
        }
        for (let index = 1; index <= warmup + samples; index += 1) {
            const tail = tailTransformBody({
                sessionId: realSessionId,
                messageCount: realResponseMessages,
                bytesPerMessage: full.bytesPerMessage,
                previousFingerprint,
                iteration: index,
            });
            if (index <= warmup) {
                tail.body.request_observed_at_ms = Date.now();
                const response = (await client.request(
                    route,
                    tail.body,
                    productionRequestOptions,
                )) as JsonRecord;
                previousFingerprint =
                    typeof response.full_array_fingerprint === "string"
                        ? response.full_array_fingerprint
                        : tail.fingerprint;
                continue;
            }
            const measured = await instrumentedRequest(
                client,
                route,
                tail.body,
                productionRequestOptions,
            );
            realRequestBytes = serializedBytes(tail.body);
            realResponse = measured.response;
            previousFingerprint =
                typeof measured.response.full_array_fingerprint === "string"
                    ? measured.response.full_array_fingerprint
                    : tail.fingerprint;
            const { trace, roundTripMs, response } = measured;
            const requestEncodeAndQueueMs = trace.writeStartAtMs - trace.requestStartedAtMs;
            const requestWriteMs = trace.writeCompleteAtMs - trace.writeStartAtMs;
            const preHeaderMs = trace.headerAtMs - trace.writeStartAtMs;
            const socketReadMs = trace.dispatchAtMs - trace.headerAtMs;
            const ingressAndQueueMs = responseTiming(response, "request_observed_to_handler");
            const applyOnceMs = responseTiming(response, "total");
            const postAttachMs = responseTiming(response, "post_attach");
            const handlerTotalMs = responseTiming(response, "handler_total");
            const accountedHandlerMs =
                handlerTotalMs > 0 ? handlerTotalMs : applyOnceMs + postAttachMs;
            const handlerDispatchMs = Math.max(0, accountedHandlerMs - applyOnceMs - postAttachMs);
            const responseEncodeAndRouterMs = Math.max(
                0,
                preHeaderMs - ingressAndQueueMs - accountedHandlerMs,
            );
            realPhases.round_trip.push(roundTripMs);
            realPhases.request_encode_and_queue.push(requestEncodeAndQueueMs);
            realPhases.request_write.push(requestWriteMs);
            realPhases.request_ingress_and_queue.push(ingressAndQueueMs);
            realPhases.module_apply_once.push(applyOnceMs);
            realPhases.module_post_attach.push(postAttachMs);
            realPhases.module_handler_dispatch_and_bookkeeping.push(handlerDispatchMs);
            realPhases.module_handler_total.push(handlerTotalMs);
            realPhases.response_encode_and_router.push(responseEncodeAndRouterMs);
            realPhases.socket_read.push(socketReadMs);
            realResponseBytes.push(serializedBytes(response));
            nativeReused.push(responseCounter(response, "native_cache_reused_messages"));
            nativeEncoded.push(responseCounter(response, "native_cache_encoded_messages"));
            const decision =
                typeof response.decision === "string"
                    ? response.decision
                    : typeof response.action === "string"
                      ? response.action
                      : "unknown";
            decisions.set(decision, (decisions.get(decision) ?? 0) + 1);
            if (response.timings && typeof response.timings === "object") {
                for (const [name, value] of Object.entries(response.timings)) {
                    if (
                        moduleCounters.has(name) ||
                        typeof value !== "number" ||
                        !Number.isFinite(value)
                    ) {
                        continue;
                    }
                    const values = moduleStageSamples.get(name) ?? [];
                    values.push(value);
                    moduleStageSamples.set(name, values);
                }
            }
        }
    } finally {
        const routeCloseStartedAt = performance.now();
        await client.closeRoute(route);
        routeCloseMs = performance.now() - routeCloseStartedAt;
    }
} finally {
    await client.closeAsync();
}

if (!realResponse) throw new Error("real-shape transform arm returned no measured response");

const transport = new McHostModuleTransport(connectionFile, moduleId, timeoutMs);
const fifoSessions = Array.from(
    { length: fifoConcurrency },
    (_, index) => `${session}-fifo-${index}`,
);
const statusBody = (sessionId: string) => ({
    method: "session.status",
    v: 1,
    session_id: sessionId,
});
for (const sessionId of fifoSessions) {
    await transport.call({
        sessionId,
        projectRoot,
        method: "session.status",
        body: statusBody(sessionId),
    });
}
const fifoCallDurations = Array.from<number>({ length: fifoConcurrency });
const fifoCalls: Promise<void>[] = [];
fifoSessions.forEach((sessionId, index) => {
    const startedAt = performance.now();
    fifoCalls.push(
        transport
            .call({
                sessionId,
                projectRoot,
                method: "session.status",
                body: statusBody(sessionId),
            })
            .then(() => {
                fifoCallDurations[index] = performance.now() - startedAt;
            }),
    );
});
await Promise.all(fifoCalls);
for (const sessionId of fifoSessions) transport.closeSession(sessionId);
eventLoopDelay.disable();

const nanosecondsToMilliseconds = (value: number): number => round(value / 1_000_000);
console.log(
    JSON.stringify(
        {
            run: {
                timestamp: new Date().toISOString(),
                probe_process_started_at: probeProcessStartedAt,
                daemon_process_started_at: daemonProcessStartedAt,
                daemon_pid: daemonPid,
                daemon_version: client.daemonVer,
                connection_file_mtime: connectionFileMtime,
                connection_file: connectionFile,
                module_id: moduleId,
                project_root: projectRoot,
                samples,
                warmup,
                sequential: true,
                route_reused: true,
            },
            setup: {
                connect_ms: round(connectMs),
                route_open_ms: round(routeOpenMs),
                route_close_ms: round(routeCloseMs),
            },
            scenarios: results,
            codec_proxy: Object.fromEntries(
                scenarios.map((scenario) => [scenario.name, codecProxy(scenario.body, samples)]),
            ),
            real_shape_transform_response: {
                method:
                    "one full paged transform primes the live module; warm and measured one-message tail deltas return the full OpenCode-native array",
                request_messages: 1,
                reconstructed_session_messages: realResponseMessages,
                request_bytes: realRequestBytes,
                response_bytes: summarizeScalars(realResponseBytes),
                decisions: Object.fromEntries(decisions),
                phases: Object.fromEntries(
                    Object.entries(realPhases).map(([name, values]) => [name, summarize(values)]),
                ),
                queue_measurement:
                    "request_ingress_and_queue uses a wall timestamp written immediately before client.request and read at module handler entry; it includes request socket transit, daemon queue/dispatch, and module request JSON decode",
                socket_measurement:
                    "socket_read spans the facade's response frame-header diagnostics event to its dispatch event (full frame body received and handed to the client)",
                client_phase_measurement:
                    "request_encode_and_queue, request_write, and socket_read derive from the facade's redacted wall-clock diagnostics events (millisecond resolution); in-client dispatch/parse durations and promise settlement are not observable through diagnostics and are omitted rather than estimated",
                native_attach_cache: {
                    reused_messages: summarizeScalars(nativeReused),
                    encoded_messages: summarizeScalars(nativeEncoded),
                    second_pass_required: true,
                },
                module_stage_decomposition: Object.fromEntries(
                    [...moduleStageSamples.entries()]
                        .sort((left, right) => {
                            const leftP50 = summarize(left[1]).p50_ms;
                            const rightP50 = summarize(right[1]).p50_ms;
                            return rightP50 - leftP50;
                        })
                        .slice(0, 15)
                        .map(([name, values]) => [name, summarize(values)]),
                ),
                codec_proxy: codecProxy(realResponse, samples),
            },
            module_transport_fifo: {
                concurrency: fifoConcurrency,
                unrelated_session_status_calls: true,
                total_call: summarize(fifoCallDurations),
            },
            event_loop_delay: {
                p50_ms: nanosecondsToMilliseconds(eventLoopDelay.percentile(50)),
                p95_ms: nanosecondsToMilliseconds(eventLoopDelay.percentile(95)),
                max_ms: nanosecondsToMilliseconds(eventLoopDelay.max),
            },
        },
        null,
        2,
    ),
);

// process.exit() can truncate piped or file output, so wait for an empty stdout write callback.
await new Promise<void>((resolveFlush) => {
    process.stdout.write("", () => resolveFlush());
});
process.exit(0);
