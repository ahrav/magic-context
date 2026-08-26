/**
 * Focused real-host Synapse smoke: starts the `synapse_host` example over a
 * model bundle, then drives all four application operations through the
 * managed McHostClient — discovery, one query, an ambiguous batch replay, a
 * host restart with resubmission, and the degraded (unconfigured) lane.
 *
 * Hermetic mode (default) uses the committed synapse-tiny bundle and needs a
 * native ONNX Runtime shared library:
 *   MC_SYNAPSE_TEST_ORT_LIBRARY=/path/to/libonnxruntime.so \
 *     bun scripts/smoke-mc-host-synapse.ts
 *
 * Production mode certifies the exact owner-provisioned bundle and refuses
 * the toy fixture, placeholder hashes, and unexpected identity:
 *   MC_SYNAPSE_SMOKE_MODE=production \
 *   MC_SYNAPSE_SMOKE_BUNDLE=/path/to/bundle \
 *   MC_SYNAPSE_TEST_ORT_LIBRARY=/path/to/libonnxruntime.so \
 *   [MC_SYNAPSE_SMOKE_FINGERPRINT=… MC_SYNAPSE_SMOKE_DIMS=… MC_SYNAPSE_SMOKE_EPOCH=…] \
 *     bun scripts/smoke-mc-host-synapse.ts
 */

import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { insertMemory } from "../src/features/magic-context/memory/storage-memory";
import { SynapseEmbeddingProvider } from "../src/features/magic-context/memory/embedding-synapse";
import { runMigrations } from "../src/features/magic-context/migrations";
import {
    applySynapseReceiptGroup,
    getSynapseLedgerPage,
} from "../src/features/magic-context/storage-embedding-measurements";
import { initializeDatabase } from "../src/features/magic-context/storage-db";
import { Database } from "../src/shared/sqlite";
import { McHostClient } from "../src/shared/mc-host-client";

const OVERALL_DEADLINE_MS = 180_000;
const READY_DEADLINE_MS = 20_000;
const CHILD_EXIT_DEADLINE_MS = 10_000;
const POLL_DEADLINE_MS = 30_000;

function log(line: string): void {
    console.log(`synapse-smoke: ${line}`);
}

function fail(message: string): never {
    console.error(`synapse-smoke: FAIL — ${message}`);
    process.exit(1);
}

function findRepoRoot(): string {
    let dir = realpathSync(process.cwd());
    for (;;) {
        if (existsSync(join(dir, "crates", "mc-host", "Cargo.toml"))) return dir;
        const parent = resolve(dir, "..");
        if (parent === dir) throw new Error("could not locate repo root above cwd");
        dir = parent;
    }
}

function sha256File(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function buildExample(repoRoot: string, binary: string): Promise<void> {
    log("synapse_host binary missing; running cargo build -p mc-host --example synapse_host");
    return new Promise((resolvePromise, rejectPromise) => {
        const build = spawn("cargo", ["build", "-p", "mc-host", "--example", "synapse_host"], {
            cwd: repoRoot,
            stdio: ["ignore", "inherit", "inherit"],
        });
        build.on("error", rejectPromise);
        build.on("exit", (code) => {
            if (code !== 0 || !existsSync(binary)) {
                rejectPromise(new Error(`cargo build failed (code ${code})`));
                return;
            }
            resolvePromise();
        });
    });
}

function waitForReady(child: ChildProcess, deadlineMs: number): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
        let settled = false;
        let stdout = "";
        const finish = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
        };
        const timer = setTimeout(() => {
            finish(() => rejectPromise(new Error(`synapse_host not READY within ${deadlineMs}ms`)));
        }, deadlineMs);
        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
            const match = /^READY ([^\r\n]+)\r?\n/m.exec(stdout);
            if (match?.[1]) finish(() => resolvePromise(match[1]));
        });
        child.on("error", (error) => finish(() => rejectPromise(error)));
        child.on("exit", (code, signal) => {
            finish(() =>
                rejectPromise(new Error(`synapse_host exited before READY (${code}/${signal})`)),
            );
        });
    });
}

function waitForExit(child: ChildProcess, deadlineMs: number): Promise<number | null> {
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
            rejectPromise(new Error(`synapse_host did not exit within ${deadlineMs}ms`));
        }, deadlineMs);
        child.once("exit", (code) => {
            clearTimeout(timer);
            resolvePromise(code);
        });
    });
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function requestKey(
    lane: { model: string; fingerprint: string; epoch: number },
    items: readonly { id: string; text: string }[],
): string {
    return createHash("sha256")
        .update(
            stableJson({
                op: "embed.batch",
                model: lane.model,
                required_fingerprint: lane.fingerprint,
                required_epoch: lane.epoch,
                allow_equivalent: false,
                accept_declared: false,
                ids: items.map((item) => item.id),
                content_sha256: items.map((item) =>
                    createHash("sha256").update(item.text).digest("hex"),
                ),
            }),
        )
        .digest("hex");
}

// ---------------------------------------------------------------------------
// Configuration.
// ---------------------------------------------------------------------------

const repoRoot = findRepoRoot();
const mode = process.env.MC_SYNAPSE_SMOKE_MODE === "production" ? "production" : "hermetic";
const ortLibrary = process.env.MC_SYNAPSE_TEST_ORT_LIBRARY;
if (!ortLibrary || !existsSync(ortLibrary)) {
    fail(
        "MC_SYNAPSE_TEST_ORT_LIBRARY must point at a native ONNX Runtime shared library; " +
            "the smoke never substitutes or downloads one",
    );
}
const bundleDir =
    mode === "production"
        ? (process.env.MC_SYNAPSE_SMOKE_BUNDLE ??
          fail("production mode requires MC_SYNAPSE_SMOKE_BUNDLE"))
        : join(repoRoot, "crates", "mc-host", "tests", "fixtures", "synapse-tiny");
if (!existsSync(join(bundleDir, "manifest.json"))) {
    fail(`bundle manifest missing at ${bundleDir}`);
}
interface BundleManifest {
    model?: unknown;
    dims?: unknown;
    table_epoch?: unknown;
    fingerprint?: unknown;
    corpus?: { name?: unknown };
    provenance?: { production?: unknown };
    model_file?: { name?: unknown; sha256?: unknown };
}

interface BundleCorpus {
    tolerance: number;
    items: { text: string; expected: number[] }[];
}

function readBundleJson<T>(name: string): T {
    try {
        return JSON.parse(readFileSync(join(bundleDir, name), "utf8")) as T;
    } catch (error) {
        fail(`bundle file ${name} is unreadable or not JSON: ${String(error)}`);
    }
}

const manifest = readBundleJson<BundleManifest>("manifest.json");
const corpus = readBundleJson<BundleCorpus>(String(manifest.corpus?.name ?? "corpus.json"));

if (mode === "production") {
    // The release smoke must never silently pass on the toy bundle or a
    // placeholder identity. Only the positive assertion counts: an omitted or
    // non-boolean provenance flag is refused, not waved through.
    if (manifest.provenance?.production !== true) {
        fail("production mode requires provenance.production === true");
    }
    const placeholder = /^(.)\1{63}$/;
    for (const value of [manifest.fingerprint, manifest.model_file?.sha256]) {
        if (typeof value !== "string" || placeholder.test(value)) {
            fail("production manifest carries a placeholder hash");
        }
    }
    for (const [envName, field] of [
        ["MC_SYNAPSE_SMOKE_FINGERPRINT", manifest.fingerprint],
        ["MC_SYNAPSE_SMOKE_DIMS", manifest.dims],
        ["MC_SYNAPSE_SMOKE_EPOCH", manifest.table_epoch],
    ] as const) {
        const expected = process.env[envName];
        if (expected !== undefined && expected !== String(field)) {
            fail(`${envName}=${expected} does not match the bundle manifest (${field})`);
        }
    }
}

const lane = {
    model: String(manifest.model),
    fingerprint: String(manifest.fingerprint),
    epoch: Number(manifest.table_epoch),
    dims: Number(manifest.dims),
};
const constraints = {
    model: lane.model,
    required_fingerprint: lane.fingerprint,
    required_epoch: lane.epoch,
    allow_equivalent: false,
    accept_declared: false,
};

const binary =
    process.env.SYNAPSE_HOST_BIN ?? join(repoRoot, "target", "debug", "examples", "synapse_host");
if (!existsSync(binary)) {
    await buildExample(repoRoot, binary);
}
const ortSha = sha256File(ortLibrary);

// ---------------------------------------------------------------------------
// Host lifecycle.
// ---------------------------------------------------------------------------

const dataDir = mkdtempSync(join(tmpdir(), "mc-host-synapse-smoke-"));
let child: ChildProcess | null = null;
let torndown = false;

function teardown(): void {
    if (torndown) return;
    torndown = true;
    if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
    }
    rmSync(dataDir, { recursive: true, force: true });
}
process.on("exit", teardown);
const onSignal = (signal: NodeJS.Signals): void => {
    teardown();
    process.exit(signal === "SIGINT" ? 130 : 143);
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

const watchdog = setTimeout(() => {
    console.error(`synapse-smoke: FAIL — overall ${OVERALL_DEADLINE_MS}ms deadline exceeded`);
    teardown();
    process.exit(1);
}, OVERALL_DEADLINE_MS);

async function startHost(bundle: string): Promise<string> {
    child = spawn(binary, [dataDir, bundle, ortLibrary as string, ortSha], {
        stdio: ["ignore", "pipe", "inherit"],
    });
    return waitForReady(child, READY_DEADLINE_MS);
}

async function stopHost(expectClean: boolean): Promise<void> {
    if (!child) return;
    child.kill("SIGINT");
    const exitCode = await waitForExit(child, CHILD_EXIT_DEADLINE_MS);
    if (expectClean) {
        assert.equal(exitCode, 0, `synapse_host must exit cleanly (got ${exitCode})`);
    }
    child = null;
}

const identity = {
    project_root: realpathSync(dataDir),
    harness: "mc-host-synapse-smoke",
    session: randomUUID(),
};
const callOptions = { targetKind: "management_surface" as const, identity, timeoutMs: 15_000 };

function body(value: unknown): Record<string, unknown> {
    const record = value as Record<string, unknown>;
    const result = record?.result as Record<string, unknown> | undefined;
    return result ?? record ?? {};
}

async function pollJob(
    client: McHostClient,
    jobId: string,
    key: string,
): Promise<{ id: string; vector: number[] }[]> {
    const collected: { id: string; vector: number[] }[] = [];
    let cursor: unknown = null;
    const deadline = Date.now() + POLL_DEADLINE_MS;
    for (;;) {
        assert.ok(Date.now() < deadline, "job did not become ready in time");
        const response = body(
            await client.call(
                "synapse",
                "embed.result",
                { ...constraints, job_id: jobId, request_key: key, cursor },
                callOptions,
            ),
        );
        if (!Array.isArray(response.vectors)) {
            assert.equal(response.done, false, "pending responses are explicit");
            await new Promise((r) => setTimeout(r, Number(response.retry_after_ms ?? 50)));
            continue;
        }
        for (const item of response.vectors as { id: string; vector: number[] }[]) {
            collected.push({ id: item.id, vector: item.vector });
        }
        if (response.done === true) return collected;
        cursor = response.next_cursor;
        assert.ok(typeof cursor === "string", "non-final pages carry a cursor");
    }
}

function assertClose(got: number[], expected: number[], what: string): void {
    assert.equal(got.length, expected.length, `${what}: dimension mismatch`);
    for (let index = 0; index < got.length; index += 1) {
        const error = Math.abs(got[index] - expected[index]);
        maxAbsError = Math.max(maxAbsError, error);
        assert.ok(
            error <= corpus.tolerance,
            `${what}: component ${index} beyond tolerance`,
        );
    }
}

let maxAbsError = 0;
const observedOperations = new Set<string>();
let observedVectors = 0;
let observedExecutionProvider: string | null = null;
let restartFenced = false;
let degradedIsolated = false;
let durableReceipts = false;

try {
    // ---------------- Degraded lane first: no bundle configured. -----------
    log("starting synapse_host with no bundle (degraded lane)");
    let connectionFile = await startHost("-");
    {
        const client = await McHostClient.connect({ connectionFile });
        try {
            await client.call("synapse", "models.list", {}, callOptions);
            fail("a degraded lane must reject its bind");
        } catch (error) {
            const code = (error as { code?: string }).code;
            assert.equal(code, "artifact_invalid", `degraded bind code was ${code}`);
            log("degraded lane rejected with artifact_invalid (no retry storm)");
        }
        // Magic Context stays routable beside the degraded lane.
        const handle = await client.routeOpen(
            { kind: "tool_provider", module_id: "magic-context" },
            identity,
        );
        const echoed = await client.request(handle, { echo: true });
        assert.deepEqual(echoed, { echo: true });
        degradedIsolated = true;
        log("magic-context echo still works beside the degraded lane");
        await client.closeAsync();
    }
    await stopHost(true);

    // ---------------- Certified lane: all four operations. -----------------
    log(`starting synapse_host with bundle ${bundleDir} (${mode} mode)`);
    connectionFile = await startHost(bundleDir);
    const client = await McHostClient.connect({ connectionFile });
    let jobId: string;
    let key: string;
    const batchItems = corpus.items.slice(0, 3).map((item, index) => ({
        id: `item:${index}`,
        text: item.text,
    }));
    try {
        const models = body(await client.call("synapse", "models.list", {}, callOptions));
        observedOperations.add("models.list");
        const entry = (models.models as Record<string, unknown>[])[0];
        assert.equal(entry.model, lane.model);
        assert.equal(entry.fingerprint, lane.fingerprint);
        assert.equal(entry.table_epoch, lane.epoch);
        assert.equal(entry.dims, lane.dims);
        assert.equal(entry.certified, true);
        assert.equal(entry.execution_provider, "cpu");
        observedExecutionProvider = String(entry.execution_provider);
        log("models.list pinned the certified identity");

        const query = body(
            await client.call(
                "synapse",
                "embed.query",
                { ...constraints, text: corpus.items[0].text, deadline_ms: 10_000 },
                callOptions,
            ),
        );
        observedOperations.add("embed.query");
        const queryVector = (query.vectors as { vector: number[] }[])[0].vector;
        assertClose(queryVector, corpus.items[0].expected, "embed.query");
        log("embed.query matched the certified corpus vector");

        key = requestKey(lane, batchItems);
        const batchParams = {
            ...constraints,
            request_key: key,
            items: batchItems.map((item) => ({
                id: item.id,
                text: item.text,
                content_sha256: createHash("sha256").update(item.text).digest("hex"),
            })),
        };
        const first = body(await client.call("synapse", "embed.batch", batchParams, callOptions));
        observedOperations.add("embed.batch");
        jobId = String(first.job_id);
        assert.equal(first.done, false);
        // An ambiguous send replays the same canonical page and must reuse
        // the retained job.
        const replay = body(await client.call("synapse", "embed.batch", batchParams, callOptions));
        assert.equal(replay.job_id, jobId, "an equal replay must reuse the job");
        log(`embed.batch admitted job ${jobId}; replay reused it`);

        const vectors = await pollJob(client, jobId, key);
        observedOperations.add("embed.result");
        observedVectors = vectors.length;
        assert.deepEqual(
            vectors.map((item) => item.id),
            batchItems.map((item) => item.id),
            "result pages preserve request order",
        );
        for (const [index, item] of vectors.entries()) {
            assertClose(item.vector, corpus.items[index].expected, `embed.result ${item.id}`);
        }
        log("embed.result returned every certified vector in order");
    } finally {
        await client.closeAsync();
    }

    // ---------------- Host restart: module_restarted then resubmit. --------
    log("restarting the host to fence the retained job");
    await stopHost(true);
    connectionFile = await startHost(bundleDir);
    const restarted = await McHostClient.connect({ connectionFile });
    try {
        try {
            await restarted.call(
                "synapse",
                "embed.result",
                { ...constraints, job_id: jobId, request_key: key, cursor: null },
                callOptions,
            );
            fail("an old job must not survive a restart");
        } catch (error) {
            const code = (error as { code?: string }).code;
            assert.equal(code, "module_restarted", `restart fence code was ${code}`);
        }
        const resubmitted = body(
            await restarted.call(
                "synapse",
                "embed.batch",
                {
                    ...constraints,
                    request_key: key,
                    items: batchItems.map((item) => ({
                        id: item.id,
                        text: item.text,
                        content_sha256: createHash("sha256").update(item.text).digest("hex"),
                    })),
                },
                callOptions,
            ),
        );
        const newJob = String(resubmitted.job_id);
        assert.notEqual(newJob, jobId, "the replacement incarnation issues a fresh job");
        const vectors = await pollJob(restarted, newJob, key);
        assert.equal(vectors.length, batchItems.length);
        restartFenced = true;
        log("restart returned module_restarted; resubmission completed the page");
    } finally {
        await restarted.closeAsync();
    }

    // ---------------- Durable application into a real SQLite file. ---------
    log("running the durable ledger application against a file-backed database");
    {
        const dbPath = join(dataDir, "smoke.sqlite");
        const db = new Database(dbPath);
        db.exec("PRAGMA foreign_keys=ON");
        initializeDatabase(db);
        runMigrations(db);

        const projectPath = identity.project_root;
        const memories = corpus.items.slice(0, 2).map((item) =>
            insertMemory(db, {
                projectPath,
                category: "CONSTRAINTS",
                content: item.text,
            }),
        );
        const provider = new SynapseEmbeddingProvider({
            connectionFile,
            projectRoot: projectPath,
            session: identity.session,
            model: lane.model,
        });
        assert.ok(await provider.initialize(), "provider must discover the certified lane");
        const detailedItems = memories.map((memory, index) => ({
            id: `memory:${memory.id}`,
            text: corpus.items[index].text,
            contentSha256: createHash("sha256").update(corpus.items[index].text).digest("hex"),
            applicationGroup: "smoke-memory-group",
        }));
        const detailed = await provider.embedItemsDetailed(detailedItems, {
            db,
            projectPath,
            sessionId: identity.session,
            scope: "memory",
            laneRole: "primary",
        });
        assert.deepEqual(detailed.failures, [], "the detailed embed must not fail");
        assert.ok(detailed.receipts.length >= 1, "the page must produce a receipt");

        const hashById = new Map(detailedItems.map((item) => [item.id, item.contentSha256]));
        applySynapseReceiptGroup(db, {
            receipts: detailed.receipts,
            expectation: {
                scope: "memory",
                laneRole: "primary",
                destinationModel: provider.modelId,
            },
            readCurrentHashes: (ids) =>
                new Map(ids.map((id) => [id, hashById.get(id) as string])),
            writeDestination: () => {
                const insert = db.prepare(
                    "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?, ?, ?)",
                );
                for (const receipt of detailed.receipts) {
                    for (const [id, vector] of receipt.vectors) {
                        const memoryId = Number(id.slice("memory:".length));
                        insert.run(
                            memoryId,
                            Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
                            provider.modelId,
                        );
                    }
                }
            },
        });
        const destinationCount = (
            db
                .prepare("SELECT COUNT(*) AS count FROM memory_embeddings WHERE model_id = ?")
                .get(provider.modelId) as { count: number }
        ).count;
        assert.equal(destinationCount, memories.length);
        for (const receipt of detailed.receipts) {
            const page = getSynapseLedgerPage(db, receipt.rowId);
            assert.equal(page?.state, "complete", "receipts complete with their destination");
        }
        durableReceipts = true;
        await provider.dispose();
        db.close();
        log("vectors and complete receipts committed in one transaction");
    }
    await stopHost(true);
} catch (error) {
    console.error(
        `synapse-smoke: FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    teardown();
    process.exit(1);
} finally {
    clearTimeout(watchdog);
    teardown();
}
console.log(`synapse-smoke: PASS (${mode} mode, all four operations, restart fence, degraded lane)`);

const reportPath = process.env.MC_SYNAPSE_SMOKE_REPORT;
if (mode === "production" && reportPath !== undefined) {
    const kernel = execFileSync("uname", ["-r"], { encoding: "utf8" })
        .trim()
        .match(/^(\d+\.\d+)/)?.[1];
    const glibc = execFileSync("ldd", ["--version"], { encoding: "utf8" })
        .match(/(\d+\.\d+)/)?.[1];
    if (process.platform !== "linux" || process.arch !== "x64" || !kernel || !glibc) {
        fail("production smoke report requires a Linux x64 kernel and glibc identity");
    }
    const modelName = manifest.model_file?.name;
    const corpusName = manifest.corpus?.name;
    if (typeof modelName !== "string" || typeof corpusName !== "string") {
        fail("production smoke report requires named model and corpus files");
    }
    const report = {
        schema: "magic-context.mc-host-synapse-smoke/v1",
        mode: "production",
        model_fingerprint: lane.fingerprint,
        table_epoch: lane.epoch,
        execution_provider:
            observedExecutionProvider ?? fail("models.list did not report an execution provider"),
        host: {
            target: "linux-x64-gnu",
            kernel,
            glibc,
            exact_floor: kernel === "4.18" && glibc === "2.28",
        },
        inputs: {
            ort_runtime: ortSha,
            model_onnx: sha256File(join(bundleDir, modelName)),
            bundle_manifest: sha256File(join(bundleDir, "manifest.json")),
            semantic_corpus: sha256File(join(bundleDir, corpusName)),
        },
        observed_vectors: observedVectors,
        max_abs_error: maxAbsError,
        tolerance: corpus.tolerance,
        operations: [...observedOperations].sort(),
        restart_fenced: restartFenced,
        degraded_isolated: degradedIsolated,
        durable_receipts: durableReceipts,
        network_access: (() => {
            const routes = readFileSync("/proc/net/route", "utf8")
                .split("\n")
                .slice(1)
                .some((line) => line.trim().split(/\s+/)[1] === "00000000");
            return routes ? "available" : "none";
        })(),
    };
    writeFileSync(reportPath, `${stableJson(report)}\n`, { mode: 0o600 });
    log(`wrote production smoke report ${reportPath}`);
}
