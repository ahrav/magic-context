/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server, Socket } from "node:net";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McHostClient } from "@magic-context/core/shared/mc-host-client";
import { verifyReleaseRoot } from "../prospective-holdout/release-root";
import { releaseRootFixture } from "../prospective-holdout/test-fixtures";
import {
    __hermeticMcHostTest,
    buildDirectHostFixture,
    HermeticMcHostStack,
} from "./hermetic-mc-host";

const temporaryRoots: string[] = [];

function mode(path: string): number {
    return lstatSync(path).mode & 0o777;
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 20_000;
    for (;;) {
        const value = await read();
        if (predicate(value)) return value;
        if (Date.now() >= deadline) throw new Error("fixture state did not converge");
        await Bun.sleep(10);
    }
}

function brocaCall(client: McHostClient, prompt: string): Promise<Record<string, unknown>> {
    return client.call<Record<string, unknown>>(
        "broca",
        "session.send",
        {
            prompt,
            model: { provider: "fixture", model: "deterministic" },
            tools: [],
            generation: { max_output_tokens: 1_024, temperature: 0.1 },
        },
        { targetKind: "management_surface" },
    );
}

async function rawControl(path: string, request: Buffer): Promise<Record<string, unknown>> {
    const socket = await new Promise<Socket>((resolveSocket, rejectSocket) => {
        const candidate = new Socket();
        candidate.once("error", rejectSocket);
        candidate.connect(path, () => {
            candidate.off("error", rejectSocket);
            resolveSocket(candidate);
        });
    });
    socket.write(request);
    const response = await new Promise<Buffer>((resolveResponse, rejectResponse) => {
        let bytes = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
            bytes = Buffer.concat([bytes, chunk]);
            const newline = bytes.indexOf(0x0a);
            if (newline >= 0) resolveResponse(bytes.subarray(0, newline));
            if (bytes.byteLength > __hermeticMcHostTest.maxLineBytes + 1) {
                rejectResponse(new Error("raw fixture response exceeded cap"));
            }
        });
        socket.once("error", rejectResponse);
    });
    socket.destroy();
    return JSON.parse(response.toString("utf8")) as Record<string, unknown>;
}

async function mockControl(
    responder: (request: Record<string, unknown>, socket: Socket) => void,
): Promise<{ client: InstanceType<typeof __hermeticMcHostTest.FixtureControlClient>; server: Server }> {
    const root = mkdtempSync(join(tmpdir(), "mc-control-client-"));
    temporaryRoots.push(root);
    const path = join(root, "control.sock");
    const server = createServer((socket) => {
        socket.on("data", (chunk: Buffer) => {
            const line = chunk.toString("utf8").trim();
            responder(JSON.parse(line) as Record<string, unknown>, socket);
        });
    });
    await new Promise<void>((resolveListen) => server.listen(path, resolveListen));
    const client = new __hermeticMcHostTest.FixtureControlClient(path, 500);
    await client.connect();
    return { client, server };
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("direct mc-host fixture contract", () => {
    it("selects frozen host artifact without a workspace build", async () => {
        const release = realpathSync(mkdtempSync(join(tmpdir(), "rust-release-root-")));
        const active = mkdtempSync(join(tmpdir(), "rust-active-root-"));
        temporaryRoots.push(release, active);
        const manifest = releaseRootFixture(release);
        const verified = verifyReleaseRoot(release, manifest, {
            expectedRootFingerprint: manifest.rootFingerprint,
            activeCheckout: active,
        });
        expect(await buildDirectHostFixture(verified)).toBe(join(release, "bin/mc-host"));
    });

    it("parses only the bounded readiness schema and reaps only stale PID records", () => {
        const valid = Buffer.from(
            JSON.stringify({
                status: "ready",
                wire_version: 2,
                catalog: ["magic-context", "synapse", "broca"],
            }),
        );
        expect(__hermeticMcHostTest.parseReadyRecord(valid).status).toBe("ready");
        expect(() =>
            __hermeticMcHostTest.parseReadyRecord(
                Buffer.from('{"status":"ready","wire_version":2,"catalog":[],"key":"secret"}'),
            ),
        ).toThrow();
        expect(() =>
            __hermeticMcHostTest.parseReadyRecord(
                Buffer.alloc(__hermeticMcHostTest.maxLineBytes + 1, 0x78),
            ),
        ).toThrow();

        const nowMs = 10 * __hermeticMcHostTest.stalePidAgeMs;
        expect(
            __hermeticMcHostTest.isStaleRustE2ePidRecord(
                nowMs - __hermeticMcHostTest.stalePidAgeMs + 1,
                nowMs,
            ),
        ).toBe(false);
        expect(
            __hermeticMcHostTest.isStaleRustE2ePidRecord(
                nowMs - __hermeticMcHostTest.stalePidAgeMs,
                nowMs,
            ),
        ).toBe(true);
        expect(__hermeticMcHostTest.isStaleRustE2ePidRecord(nowMs + 1, nowMs)).toBe(false);
    });

    it("rejects readiness emitted before control and secure publication exist", async () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-e2e-early-ready-"));
        temporaryRoots.push(root);
        const fixtureBin = join(root, "early-ready-fixture.sh");
        writeFileSync(
            fixtureBin,
            `#!/bin/sh\nprintf '%s\\n' '{"status":"ready","wire_version":2,"catalog":["magic-context","synapse","broca"]}'\nsleep 1\nmkdir -p "$2/cortexkit/run"\n: > "$2/direct-host-control.sock"\n: > "$2/cortexkit/run/subc-connection.json"\nsleep 60\n`,
            { mode: 0o700 },
        );

        const startupError = await HermeticMcHostStack.start({
            dataDir: root,
            fixtureBin,
            startTimeoutMs: 2_000,
        }).catch((error: unknown) => error);
        expect(String(startupError)).toContain(
            "direct mc-host readiness preceded secure publication",
        );
        expect(existsSync(root)).toBe(false);
        temporaryRoots.splice(temporaryRoots.indexOf(root), 1);
    }, 15_000);

    it("rejects malformed, unknown, oversized, mismatched, and duplicate responses", async () => {
        const cases: Array<(request: Record<string, unknown>, socket: Socket) => void> = [
            (_request, socket) => socket.write("not-json\n"),
            (request, socket) =>
                socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { accepted: true }, extra: true })}\n`),
            (_request, socket) => socket.write(`${"x".repeat(__hermeticMcHostTest.maxLineBytes + 1)}\n`),
            (_request, socket) => socket.write(`${JSON.stringify({ id: 999, ok: true, result: { accepted: true } })}\n`),
        ];
        for (const responder of cases) {
            const { client, server } = await mockControl(responder);
            expect(await client.backendSuccess().catch((error: unknown) => error)).toBeInstanceOf(
                Error,
            );
            client.close();
            await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        }

        const { client, server } = await mockControl((request, socket) => {
            const response = `${JSON.stringify({ id: request.id, ok: true, result: { accepted: true } })}\n`;
            socket.write(response + response);
        });
        await client.backendSuccess();
        await Bun.sleep(20);
        expect(await client.counters().catch((error: unknown) => error)).toBeInstanceOf(Error);
        client.close();
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    });

    it(
        "proves permissions, controls, managed readiness, redaction, and JSONL shutdown",
        async () => {
            const fixtureBin = await buildDirectHostFixture();
            const root = mkdtempSync(join(tmpdir(), "opencode-e2e-direct-host-"));
            temporaryRoots.push(root);
            chmodSync(root, 0o700);
            const stack = await HermeticMcHostStack.start({ dataDir: root, fixtureBin });
            const sentinel = "u7-request-sentinel-DO-NOT-LOG";
            try {
                expect(mode(root)).toBe(0o700);
                expect(mode(stack.controlPath)).toBe(0o600);
                expect(mode(stack.connectionFile)).toBe(0o600);

                const publicationText = readFileSync(stack.connectionFile, "utf8");
                const publication = JSON.parse(publicationText) as {
                    key: number[];
                    daemon_id: number[];
                };
                const secretRenderings = [
                    publication.key.join(","),
                    publication.key.join(", "),
                    Buffer.from(publication.key).toString("hex"),
                    Buffer.from(publication.key).toString("hex").toUpperCase(),
                    Buffer.from(publication.key).toString("base64"),
                    publication.daemon_id.join(","),
                    publication.daemon_id.join(", "),
                    Buffer.from(publication.daemon_id).toString("hex"),
                    Buffer.from(publication.daemon_id).toString("hex").toUpperCase(),
                    Buffer.from(publication.daemon_id).toString("base64"),
                    publicationText,
                    JSON.stringify(publication),
                ];

                const before = await stack.backendCounters();
                const controlResponses: string[] = [];
                const thrownErrors: string[] = [];
                const malformedControls = [
                    Buffer.from(`{"id":30,"sentinel":"${sentinel}","command":\n`),
                    Buffer.from(
                        `${JSON.stringify({ id: 31, sentinel, command: { name: "unknown" } })}\n`,
                    ),
                    Buffer.concat([
                        Buffer.from(`{"id":32,"sentinel":"${sentinel}","padding":"`),
                        Buffer.alloc(__hermeticMcHostTest.maxLineBytes + 1, 0x78),
                        Buffer.from('"}\n'),
                    ]),
                ];
                for (const bytes of malformedControls) {
                    try {
                        const response = await rawControl(stack.controlPath, bytes);
                        expect(response.ok).toBe(false);
                        controlResponses.push(JSON.stringify(response));
                    } catch (error) {
                        thrownErrors.push(String(error));
                    }
                }
                expect(controlResponses.length + thrownErrors.length).toBe(malformedControls.length);
                expect(await stack.backendCounters()).toEqual(before);

                const callFor = async (session: string, prompt: string): Promise<void> => {
                    const client = await McHostClient.connect({
                        connectionFile: stack.connectionFile,
                        identity: { project_root: root, harness: "opencode", session },
                        targetKind: "management_surface",
                    });
                    try {
                        expect((await brocaCall(client, prompt)).run_id).toBeString();
                    } finally {
                        await client.closeAsync();
                    }
                };

                await stack.backendSuccess();
                await callFor("fixture-success", sentinel);
                await waitFor(
                    () => stack.backendCounters(),
                    (counters) => counters.completed === before.completed + 1,
                );

                expect(await stack.releaseBlockedBackendCall()).toBe(false);
                await stack.blockNextBackendCall();
                await callFor("fixture-blocked", "blocked request body");
                await waitFor(
                    () => stack.backendCounters(),
                    (counters) => counters.blocked === before.blocked + 1,
                );
                expect(await stack.releaseBlockedBackendCall()).toBe(true);
                await waitFor(
                    () => stack.backendCounters(),
                    (counters) => counters.released === before.released + 1,
                );

                await stack.failNextBackendCall();
                await callFor("fixture-failure", "typed outage");
                await waitFor(
                    () => stack.backendCounters(),
                    (counters) => counters.failed === before.failed + 1,
                );
                const diagnostics = __hermeticMcHostTest.diagnostics(stack);
                const observedOutputs = [
                    ...controlResponses,
                    ...thrownErrors,
                    diagnostics.stdout,
                    diagnostics.stderr,
                    diagnostics.retainedLog,
                    stack.hostLog(),
                ];
                const forbidden = [sentinel, ...secretRenderings];
                expect(
                    observedOutputs.some((output) =>
                        forbidden.some((secret) => secret.length > 0 && output.includes(secret)),
                    ),
                ).toBe(false);
                await stack.stop();
                expect(existsSync(root)).toBe(false);
                temporaryRoots.splice(temporaryRoots.indexOf(root), 1);
            } finally {
                await stack.stop();
            }
        },
        180_000,
    );

    it(
        "routes SIGTERM through fixture cleanup",
        async () => {
            const fixtureBin = await buildDirectHostFixture();
            const root = mkdtempSync(join(tmpdir(), "opencode-e2e-direct-host-term-"));
            temporaryRoots.push(root);
            const stack = await HermeticMcHostStack.start({ dataDir: root, fixtureBin });
            await stack.blockNextBackendCall();
            const client = await McHostClient.connect({
                connectionFile: stack.connectionFile,
                identity: { project_root: root, harness: "opencode", session: "sigterm" },
                targetKind: "management_surface",
            });
            await brocaCall(client, "sigterm sentinel request");
            await waitFor(
                () => stack.backendCounters(),
                (counters) => counters.blocked >= 1,
            );
            await client.closeAsync().catch(() => undefined);
            await stack.terminateHost();
            expect(existsSync(stack.controlPath)).toBe(false);
            expect(existsSync(stack.connectionFile)).toBe(false);
            await stack.stop();
            expect(existsSync(root)).toBe(false);
            temporaryRoots.splice(temporaryRoots.indexOf(root), 1);
        },
        180_000,
    );
});
