import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    closeSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildManagedStartupEnvelope } from "../packages/plugin/src/hooks/magic-context/module-transport";
import {
    BROCA_CREDENTIAL_NAMES,
    Deadline,
    McHostClient,
} from "../packages/plugin/src/shared/mc-host-client";
import { readConnectionFile } from "../packages/plugin/src/shared/mc-host-client/connection-file";
import { stageBootstrap } from "../packages/plugin/src/shared/mc-host-lifecycle/bootstrap";
import { releaseContract } from "../packages/plugin/src/shared/mc-host-lifecycle/generated-contract";
import {
    type NativeStartupEnvelope,
    runNativeLifecycle,
} from "../packages/plugin/src/shared/mc-host-lifecycle/native-launcher";
import { connectionFilePath } from "../packages/plugin/src/shared/mc-host-lifecycle/paths";

type OwnerMode = "opencode-start" | "pi-converge";
const MAX_OWNER_OUTPUT_BYTES = 1024 * 1024;

interface OwnerResult {
    start: Awaited<ReturnType<typeof runNativeLifecycle>>;
    stop?: Awaited<ReturnType<typeof runNativeLifecycle>>;
    demandStart?: Awaited<ReturnType<typeof runNativeLifecycle>>;
}

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function ownerEnvironment(dataRoot: string, node: string): Record<string, string> {
    return {
        XDG_DATA_HOME: dataRoot,
        HOME: dirname(dirname(node)),
        ...(process.env.CK_MC_HOST_TEST_PHASE_CAP_MS === undefined
            ? {}
            : { CK_MC_HOST_TEST_PHASE_CAP_MS: process.env.CK_MC_HOST_TEST_PHASE_CAP_MS }),
    };
}

function mergedEnvelope(
    opencode: NativeStartupEnvelope,
    pi: NativeStartupEnvelope,
): NativeStartupEnvelope {
    return {
        schema: 1,
        ...(opencode.opencode === undefined ? {} : { opencode: opencode.opencode }),
        ...(pi.pi === undefined ? {} : { pi: pi.pi }),
        credentials: {
            ...(opencode.credentials ?? {}),
            ...(pi.credentials ?? {}),
        },
    };
}

async function runOwner(mode: OwnerMode): Promise<void> {
    const dataRoot = required("MC_HOST_CANARY_DATA_ROOT");
    const launcher = required("MC_HOST_CANARY_LAUNCHER");
    const opencode = required("MC_HOST_CANARY_OPENCODE");
    const node = required("MC_HOST_CANARY_NODE");
    const piEntrypoint = required("MC_HOST_CANARY_PI_ENTRYPOINT");
    const payloadDir = join(dataRoot, "payload-source");
    const digest = createHash("sha256").update(readFileSync(launcher)).digest("hex");
    const retained = stageBootstrap({
        sourcePath: launcher,
        destDir: join(
            dataRoot,
            "cortexkit",
            "mc-host-bootstrap",
            releaseContract.release.version,
        ),
        expectedSha256: digest,
    });
    const opencodeEnvelope = buildManagedStartupEnvelope(
        "@cortexkit/opencode-magic-context",
        process.env,
        opencode,
    );
    const env = ownerEnvironment(dataRoot, node);
    try {
        if (mode === "opencode-start") {
            const start = await runNativeLifecycle(
                { kind: "retained-fd", fd: retained.fd },
                {
                    command: "start",
                    payloadDir,
                    envelope: opencodeEnvelope,
                    deadlineMs: 60_000,
                    env,
                },
            );
            console.log(JSON.stringify({ start } satisfies OwnerResult));
            return;
        }

        const piEnvelope = buildManagedStartupEnvelope(
            "@cortexkit/pi-magic-context",
            process.env,
            node,
            piEntrypoint,
        );
        const start = await runNativeLifecycle(
            { kind: "retained-fd", fd: retained.fd },
            {
                command: "start",
                envelope: piEnvelope,
                deadlineMs: 60_000,
                env,
            },
        );
        const stop = await runNativeLifecycle(
            { kind: "retained-fd", fd: retained.fd },
            {
                command: "stop",
                deadlineMs: 60_000,
                env,
            },
        );
        assert.equal(stop.ok, true, JSON.stringify(stop));
        const demandStart = await runNativeLifecycle(
            { kind: "retained-fd", fd: retained.fd },
            {
                command: "start",
                envelope: mergedEnvelope(opencodeEnvelope, piEnvelope),
                deadlineMs: 60_000,
                env,
            },
        );
        console.log(JSON.stringify({ start, stop, demandStart } satisfies OwnerResult));
    } finally {
        closeSync(retained.fd);
    }
}

function spawnOwner(mode: OwnerMode): Promise<OwnerResult> {
    const script = fileURLToPath(import.meta.url);
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, "--owner", mode], {
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let overflowed = false;
        const retain = (chunks: Buffer[], chunk: Buffer): void => {
            outputBytes += chunk.length;
            if (outputBytes > MAX_OWNER_OUTPUT_BYTES) {
                overflowed = true;
                child.kill("SIGKILL");
                return;
            }
            chunks.push(chunk);
        };
        child.stdout.on("data", (chunk: Buffer) => retain(stdout, chunk));
        child.stderr.on("data", (chunk: Buffer) => retain(stderr, chunk));
        child.on("error", reject);
        child.on("close", (code, signal) => {
            if (overflowed) {
                reject(new Error(`owner ${mode} exceeded its output cap`));
                return;
            }
            if (code !== 0 || signal !== null) {
                reject(
                    new Error(
                        `owner ${mode} failed (${signal ?? code}): ${Buffer.concat(stderr).toString("utf8")}`,
                    ),
                );
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as OwnerResult);
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function daemonIdentity(dataRoot: string): Promise<readonly number[]> {
    const connection = await readConnectionFile(connectionFilePath(dataRoot), {
        deadline: Deadline.start(5_000),
    });
    return Array.from(connection.daemonId);
}

/**
 * Narrows one replay item to its control unit, or undefined when the item is
 * not a `{kind: "control", unit}` envelope.
 */
function controlUnit(item: unknown): Record<string, unknown> | undefined {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
    const envelope = item as Record<string, unknown>;
    if (envelope.kind !== "control") return undefined;
    const unit = envelope.unit;
    if (unit === null || typeof unit !== "object" || Array.isArray(unit)) return undefined;
    return unit as Record<string, unknown>;
}

/**
 * Concatenates the assistant text the replay carries for one run.
 *
 * Mirrors the producer's nested `message.content[].text` shape, so a replay
 * that keeps its dispatch metadata but drops every response unit yields "".
 */
function assistantTextForRun(items: readonly unknown[], runId: string): string {
    let text = "";
    for (const item of items) {
        const unit = controlUnit(item);
        if (unit === undefined) continue;
        if (unit.type !== "assistant_message" || unit.run_id !== runId) continue;
        const message = unit.message;
        if (message === null || typeof message !== "object" || Array.isArray(message)) {
            continue;
        }
        const content = (message as Record<string, unknown>).content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
            if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
            const entry = block as Record<string, unknown>;
            if (entry.type === "text" && typeof entry.text === "string") text += entry.text;
        }
    }
    return text;
}

async function verifyBrocaRoutes(dataRoot: string): Promise<void> {
    const canonicalModel = required("MC_HOST_CANARY_BROCA_MODEL");
    const separator = canonicalModel.indexOf("/");
    assert.ok(separator > 0 && separator < canonicalModel.length - 1);
    const provider = canonicalModel.slice(0, separator);
    const model = canonicalModel.slice(separator + 1);
    const client = await McHostClient.connect({
        connectionFile: connectionFilePath(dataRoot),
        credentialSource: process.env,
    });
    try {
        const target = { kind: "management_surface", module_id: "broca" } as const;
        const opencode = await client.routeOpen(target, {
            project_root: dataRoot,
            harness: "opencode",
            session: "cross-harness-opencode",
        });
        const pi = await client.routeOpen(target, {
            project_root: dataRoot,
            harness: "pi",
            session: "cross-harness-pi",
        });
        assert.notEqual(opencode.channel, pi.channel);
        for (const [harness, handle] of [
            ["opencode", opencode],
            ["pi", pi],
        ] as const) {
            const sent = (await client.request(
                handle,
                {
                    method: "session.send",
                    params: {
                        prompt: "Reply with exactly OK.",
                        model: { provider, model },
                        tools: [],
                        generation: {
                            max_output_tokens: 16,
                            temperature: 0,
                        },
                    },
                },
                { timeoutMs: 60_000 },
            )) as { run_id?: unknown };
            assert.equal(typeof sent.run_id, "string", `${harness} did not return a run id`);
            const runId = sent.run_id as string;
            const deadline = Date.now() + 60_000;
            for (;;) {
                // Prove the deadline before dispatching. Clamping an expired
                // budget to 1 ms would fail the request as a client timeout and
                // throw before the deadline assertion below could name the real
                // cause, turning a slow run into an opaque transport error.
                const remainingMs = deadline - Date.now();
                assert.ok(
                    remainingMs > 0,
                    `${harness} did not complete before deadline`,
                );
                const status = (await client.request(
                    handle,
                    {
                        method: "run.status",
                        params: { run_id: runId },
                    },
                    { timeoutMs: remainingMs },
                )) as { state?: unknown };
                if (status.state === "completed") break;
                assert.ok(
                    status.state === "queued" || status.state === "running",
                    `${harness} terminated in state ${String(status.state)}`,
                );
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            const replay = await client.requestStream(
                handle,
                {
                    method: "session.subscribe",
                    params: { from: "start" },
                },
                { timeoutMs: 60_000 },
            );
            assert.ok(
                replay.some((item) => {
                    const control = controlUnit(item);
                    return (
                        control !== undefined &&
                        control.type === "harness_dispatch" &&
                        control.run_id === runId &&
                        control.harness === harness
                    );
                }),
                `${harness} replay did not prove concrete adapter dispatch`,
            );
            // Dispatch metadata alone does not prove the user got an answer: a
            // replay that retains the harness_dispatch control unit but loses
            // every response unit would still satisfy the check above while the
            // run reports completed. Require the assistant text for this run.
            const assistantText = assistantTextForRun(replay, runId);
            assert.ok(
                assistantText.trim() !== "",
                `${harness} replay carried no assistant text for run ${runId}`,
            );
        }
        await client.closeRoute(opencode);
        await client.closeRoute(pi);
    } finally {
        await client.closeAsync();
    }
}

async function stopDaemon(dataRoot: string, launcher: string, node: string): Promise<void> {
    const digest = createHash("sha256").update(readFileSync(launcher)).digest("hex");
    const retained = stageBootstrap({
        sourcePath: launcher,
        destDir: join(
            dataRoot,
            "cortexkit",
            "mc-host-bootstrap",
            releaseContract.release.version,
        ),
        expectedSha256: digest,
    });
    try {
        const result = await runNativeLifecycle(
            { kind: "retained-fd", fd: retained.fd },
            {
                command: "stop",
                deadlineMs: 30_000,
                env: ownerEnvironment(dataRoot, node),
            },
        );
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.state, "stopped");
        assert.equal(existsSync(connectionFilePath(dataRoot)), false);
    } finally {
        closeSync(retained.fd);
    }
}

async function main(): Promise<void> {
    const ownerIndex = process.argv.indexOf("--owner");
    if (ownerIndex >= 0) {
        const mode = process.argv[ownerIndex + 1];
        assert.ok(mode === "opencode-start" || mode === "pi-converge");
        await runOwner(mode);
        return;
    }

    const dataRoot = required("MC_HOST_CANARY_DATA_ROOT");
    const launcher = required("MC_HOST_CANARY_LAUNCHER");
    const node = required("MC_HOST_CANARY_NODE");
    const payloadDir = join(dataRoot, "payload-source");
    const payloadLauncher = join(payloadDir, "payload", "bin", "ck-mc-host");
    mkdirSync(dirname(payloadLauncher), { recursive: true, mode: 0o700 });
    copyFileSync(launcher, payloadLauncher);
    chmodSync(payloadLauncher, 0o700);

    let failure: unknown;
    try {
        const first = await spawnOwner("opencode-start");
        assert.equal(first.start.ok, true, JSON.stringify(first.start));
        assert.equal(first.start.reason, "started");
        const firstIdentity = await daemonIdentity(dataRoot);

        const second = await spawnOwner("pi-converge");
        assert.equal(second.start.ok, false, JSON.stringify(second.start));
        assert.equal(second.start.state, "running");
        assert.equal(second.start.reason, "harness_unavailable");
        assert.ok(second.stop);
        assert.equal(second.stop.ok, true, JSON.stringify(second.stop));
        assert.equal(second.stop.reason, "stopped");
        assert.ok(second.demandStart);
        assert.equal(second.demandStart.ok, true, JSON.stringify(second.demandStart));
        assert.equal(second.demandStart.reason, "started");
        assert.equal(second.demandStart.effects, null);
        assert.notDeepEqual(
            await daemonIdentity(dataRoot),
            firstIdentity,
            "explicit stop plus later demand-start must rotate daemon identity",
        );

        const selectionText = readFileSync(
            join(
                dataRoot,
                "cortexkit",
                "mc-host-harness-closures",
                "active-selection.json",
            ),
            "utf8",
        );
        const selection = JSON.parse(selectionText) as Record<string, unknown>;
        const opencodeEnvelope = buildManagedStartupEnvelope(
            "@cortexkit/opencode-magic-context",
            process.env,
            required("MC_HOST_CANARY_OPENCODE"),
        );
        const piEnvelope = buildManagedStartupEnvelope(
            "@cortexkit/pi-magic-context",
            process.env,
            node,
            required("MC_HOST_CANARY_PI_ENTRYPOINT"),
        );
        assert.equal(selection.opencode, opencodeEnvelope.opencode?.manifest_sha256);
        assert.equal(selection.pi, piEnvelope.pi?.manifest_sha256);
        assert.ok(
            selection.credential_identities === undefined ||
                typeof selection.credential_identities === "object",
        );
        for (const name of BROCA_CREDENTIAL_NAMES) {
            const value = process.env[name];
            if (value) assert.equal(selectionText.includes(value), false);
        }

        await verifyBrocaRoutes(dataRoot);
    } catch (error) {
        failure = error;
    }
    try {
        await stopDaemon(dataRoot, launcher, node);
    } catch (cleanupError) {
        if (failure === undefined) throw cleanupError;
        throw new AggregateError([failure, cleanupError], "smoke and cleanup both failed");
    }
    if (failure !== undefined) throw failure;
    console.log("mc-host cross-harness convergence smoke: PASS");
}

void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
