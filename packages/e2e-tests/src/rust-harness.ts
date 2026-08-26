/**
 * RustTestHarness drives OpenCode through U5's directly composed mc-host fixture.
 *
 * Fixture and OpenCode share one isolated data root. Fixture starts before
 * OpenCode so plugin discovery reaches a published, authenticated host.
 * OpenCode restarts preserve database and module-store state.
 *
 * Assertion surface: wire captures come from the model mock's full request
 * bodies (the same source the TS lane asserts on). Rust transform decisions are
 * ALSO surfaced from the plugin diagnostic log (redirected per-suite via
 * MAGIC_CONTEXT_LOG_PATH) as a secondary signal — `readRustPasses()` parses the
 * `rust pass: decision=… served_from=… applied=…` lines the Rust transform emits.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MockProvider, type MockResponse } from "./mock-provider/server";
import {
    createIsolatedEnv,
    type IsolatedEnv,
    type SpawnedOpencode,
    spawnOpencode,
} from "./opencode-runner/spawn";
import {
    buildDirectHostFixture,
    detectRustModePrereqs,
    HermeticMcHostStack,
    type RustModePrereqs,
} from "./rust-runner/hermetic-mc-host";

export interface RustTestHarnessOptions {
    /** magic-context USER-tier config overrides (thresholds, memory, etc.). */
    magicContextConfig?: Record<string, unknown>;
    /** Extra opencode.json config. Merged onto test defaults. */
    openCodeConfigExtra?: Record<string, unknown>;
    /** Override the mock model's context token limit. Default 200000. */
    modelContextLimit?: number;
    /** Default response used when the mock queue is empty. */
    mockDefault?: MockResponse;
    /**
     * Start opencode in TS mode instead of Rust mode. Direct host still
     * runs (so a later `restart({ rust: true })` can flip to Rust against the
     * same data dir) but the plugin transforms in TS on this boot. Used by the
     * cold-start-drop-seed scenario to build TS-mode state, then restart in Rust.
     * Default: false (boot straight into Rust mode).
     */
    startInTsMode?: boolean;
}

export interface SdkClient {
    session: {
        create: (opts: {
            query: { directory: string };
            body?: { parentID?: string; title?: string };
        }) => Promise<{ data?: { id: string } }>;
        prompt: (opts: {
            path: { id: string };
            body: {
                model: { providerID: string; modelID: string };
                parts: Array<{ type: "text"; text: string }>;
                agent?: string;
            };
        }) => Promise<{ data?: unknown }>;
        revert: (opts: {
            path: { id: string };
            body: { messageID: string; partID?: string };
        }) => Promise<{ data?: unknown }>;
        messages: (opts: {
            path: { id: string };
        }) => Promise<{ data?: unknown }>;
    };
}

const DEFAULT_MOCK_RESPONSE: MockResponse = {
    text: "ok",
    usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 0,
    },
};

/** One parsed `rust pass:` diagnostic line. */
export interface RustPassLine {
    decision: string;
    reason: string;
    servedFrom: string;
    inputCount: number;
    outputCount: number;
    applied: boolean;
    elapsedMs: number;
    moduleElapsedMs: number;
    adapterElapsedMs: number;
    prefixGuardMs: number;
    stateSyncMs: number;
    wireBuildMs: number;
    wireMessages: number;
    transportMs: number;
    transportPages: number;
    transportBytes: number;
    rowVersion: number;
    raw: string;
}

export class RustTestHarness {
    readonly mock: MockProvider;
    readonly env: IsolatedEnv;
    readonly mcHost: HermeticMcHostStack;
    readonly logPath: string;

    private opencodeInstance: SpawnedOpencode;
    private clientInstance: SdkClient;
    private contextDbCached: Database | null = null;
    private modelContextLimit: number | undefined;
    private readonly mockBaseURL: string;

    private constructor(args: {
        mock: MockProvider;
        mockBaseURL: string;
        env: IsolatedEnv;
        mcHost: HermeticMcHostStack;
        opencode: SpawnedOpencode;
        client: SdkClient;
        logPath: string;
        modelContextLimit: number | undefined;
    }) {
        this.mock = args.mock;
        this.mockBaseURL = args.mockBaseURL;
        this.env = args.env;
        this.mcHost = args.mcHost;
        this.opencodeInstance = args.opencode;
        this.clientInstance = args.client;
        this.logPath = args.logPath;
        this.modelContextLimit = args.modelContextLimit;
    }

    /** Preflight current repository and Cargo. */
    static detectPrereqs(): RustModePrereqs {
        return detectRustModePrereqs();
    }

    static async create(
        options: RustTestHarnessOptions = {},
    ): Promise<RustTestHarness> {
        const prereqs = detectRustModePrereqs();
        if (!prereqs.ok) {
            throw new Error(
                `RustTestHarness prerequisites unmet: ${prereqs.skipReason ?? "unknown"}. ` +
                    "Guard the suite with RustTestHarness.detectPrereqs() and skip instead of creating.",
            );
        }

        const fixtureBin = await buildDirectHostFixture();

        const mock = new MockProvider();
        const { baseURL } = await mock.start();
        const mockDefault = options.mockDefault ?? DEFAULT_MOCK_RESPONSE;
        mock.setDefault(mockDefault);

        const env = createIsolatedEnv();
        const mcHost = await HermeticMcHostStack.start({
            dataDir: env.dataDir,
            fixtureBin,
        });

        const logPath = join(env.dataDir, "cortexkit", "magic-context-e2e.log");

        let opencode: SpawnedOpencode;
        try {
            opencode = await RustTestHarness.spawnServe({
                env,
                mockURL: baseURL,
                connectionFile: mcHost.connectionFile,
                logPath,
                options,
                rustMode: !options.startInTsMode,
            });
        } catch (error) {
            // Independent steps: a failing teardown neither skips the ones
            // after it — the mock's HTTP listener outlives this scope
            // otherwise — nor replaces the spawn failure being reported.
            try {
                await mcHost.stop();
            } catch {
                // ignore
            }
            try {
                await mock.stop();
            } catch {
                // ignore
            }
            throw error;
        }

        const sdk = await import("@opencode-ai/sdk");
        // SAFETY: SdkClient is bounded subset of createOpencodeClient used by this harness.
        const client = sdk.createOpencodeClient({
            baseUrl: opencode.url,
        }) as unknown as SdkClient;

        return new RustTestHarness({
            mock,
            mockBaseURL: baseURL,
            env,
            mcHost,
            opencode,
            client,
            logPath,
            modelContextLimit: options.modelContextLimit,
        });
    }

    private static spawnServe(args: {
        env: IsolatedEnv;
        mockURL: string;
        connectionFile: string;
        logPath: string;
        options: RustTestHarnessOptions;
        rustMode: boolean;
    }): Promise<SpawnedOpencode> {
        return spawnOpencode({
            mockProviderURL: args.mockURL,
            existingEnv: args.env,
            modelContextLimit: args.options.modelContextLimit,
            openCodeConfigExtra: args.options.openCodeConfigExtra,
            magicContextConfig: args.options.magicContextConfig,
            userMcHostConnectionFile: args.connectionFile,
            projectMagicContextConfig: {
                transform_mode: args.rustMode ? "rust" : "ts",
            },
            extraEnv: { MAGIC_CONTEXT_LOG_PATH: args.logPath },
        });
    }

    get opencode(): SpawnedOpencode {
        return this.opencodeInstance;
    }

    get client(): SdkClient {
        return this.clientInstance;
    }

    /**
     * Restart `opencode serve` against the SAME data dir (opencode.db, context.db,
     * module store, and the running direct host all persist). Optionally flip the
     * project transform_mode (ts↔rust) — the cold-start-drop-seed scenario builds
     * TS-mode state then restarts in Rust to prove drop-tag state seeds correctly.
     */
    async restart(
        opts: {
            rust?: boolean;
            magicContextConfig?: Record<string, unknown>;
        } = {},
    ): Promise<void> {
        if (this.contextDbCached) {
            try {
                this.contextDbCached.close();
            } catch {
                // ignore
            }
            this.contextDbCached = null;
        }
        await this.opencodeInstance.kill();
        this.opencodeInstance = await RustTestHarness.spawnServe({
            env: this.env,
            mockURL: this.mockBaseURL,
            connectionFile: this.mcHost.connectionFile,
            logPath: this.logPath,
            options: {
                modelContextLimit: this.modelContextLimit,
                magicContextConfig: opts.magicContextConfig,
            },
            rustMode: opts.rust ?? true,
        });
        const sdk = await import("@opencode-ai/sdk");
        // SAFETY: SdkClient is bounded subset of createOpencodeClient used by this harness.
        this.clientInstance = sdk.createOpencodeClient({
            baseUrl: this.opencodeInstance.url,
        }) as unknown as SdkClient;
    }

    /** Create a session bound to the isolated workdir. Throws on failure. */
    async createSession(): Promise<string> {
        const maxAttempts = 5;
        for (let i = 1; i <= maxAttempts; i++) {
            const res = await this.clientInstance.session.create({
                query: { directory: this.env.workdir },
            });
            if (res.data) return res.data.id;
            if (i < maxAttempts) {
                await Bun.sleep(200 * i);
                continue;
            }
            throw new Error(
                `session.create failed after ${maxAttempts} attempts. stderr:\n${this.opencodeInstance.stderr()}`,
            );
        }
        throw new Error("session.create failed");
    }

    /**
     * Generate ~`tokens` tokens of varied prose ballast. Copied from the TS
     * harness: the protected-tail boundary measures true-raw content, so pressure
     * turns must carry real mass, and varied prose tokenizes at a stable rate.
     */
    ballast(tokens: number): string {
        const words = [
            "boundary",
            "historian",
            "compartment",
            "schedule",
            "pressure",
            "tokens",
            "window",
            "publish",
            "transform",
            "session",
            "marker",
            "budget",
            "eligible",
            "protected",
            "ordinal",
            "snapshot",
            "replay",
            "decision",
            "threshold",
            "baseline",
            "measure",
            "archive",
            "deliver",
        ];
        const target = Math.max(0, Math.round(tokens * 4));
        const parts: string[] = [];
        let length = 0;
        let i = 0;
        while (length < target) {
            const w = words[i % words.length]!;
            parts.push(`${w}${i % 17 === 0 ? "." : ""}`);
            length += w.length + 1;
            i += 1;
        }
        return parts.join(" ");
    }

    /**
     * Append persisted messages through OpenCode's production database shape. This keeps
     * large-session transport tests fast while the next prompt still traverses the real
     * OpenCode → plugin → direct host → McHandler path.
     */
    appendSyntheticHistory(
        sessionId: string,
        options: { count: number; textBytes: number },
    ): void {
        const dbPath = join(this.env.dataDir, "opencode", "opencode.db");
        const db = new Database(dbPath);
        try {
            db.exec("PRAGMA busy_timeout = 30000");
            const row = db
                .prepare(
                    "SELECT COALESCE(MAX(time_created), 0) AS latest FROM message WHERE session_id = ?",
                )
                .get(sessionId) as { latest: number };
            const templateRow = db
                .prepare(
                    "SELECT m.data AS message_data, p.data AS part_data FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user' AND json_extract(p.data, '$.type') = 'text' ORDER BY m.time_created DESC LIMIT 1",
                )
                .get(sessionId) as
                | { message_data: string; part_data: string }
                | undefined;
            if (!templateRow) {
                throw new Error(
                    "synthetic history requires an existing user text message",
                );
            }
            const messageTemplate = JSON.parse(
                templateRow.message_data,
            ) as Record<string, unknown>;
            const partTemplate = JSON.parse(templateRow.part_data) as Record<
                string,
                unknown
            >;
            const insertMessage = db.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            );
            const insertPart = db.prepare(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
            );
            // OpenCode orders message IDs generated from descending timestamps. Place the
            // fixture immediately before the live seed messages so a later prompt remains
            // newest while both OpenCode and the raw ordinal reader agree on history order.
            const firstTimestamp = Math.max(1, row.latest - options.count - 1);
            const descendingId = (
                prefix: "msg" | "prt",
                timestamp: number,
                counter: number,
            ): string => {
                const encoded = ~(
                    BigInt(timestamp) * 0x1000n +
                    BigInt(counter)
                );
                const timeBytes = Buffer.alloc(6);
                for (let byte = 0; byte < timeBytes.length; byte += 1) {
                    timeBytes[byte] = Number(
                        (encoded >> BigInt(40 - 8 * byte)) & 0xffn,
                    );
                }
                return `${prefix}_${timeBytes.toString("hex")}${counter.toString(36).padStart(14, "0")}`;
            };
            const append = db.transaction(() => {
                for (let index = 0; index < options.count; index += 1) {
                    const suffix = index.toString().padStart(4, "0");
                    const timestamp = firstTimestamp + index;
                    const messageId = descendingId("msg", timestamp, 1);
                    const partId = descendingId("prt", timestamp, 2);
                    const prefix = `synthetic history message ${suffix}: `;
                    const text = `${prefix}${"x".repeat(Math.max(0, options.textBytes - prefix.length))}`;
                    insertMessage.run(
                        messageId,
                        sessionId,
                        timestamp,
                        timestamp,
                        JSON.stringify({
                            ...messageTemplate,
                            id: messageId,
                            sessionID: sessionId,
                            time: {
                                ...((messageTemplate.time as
                                    | Record<string, unknown>
                                    | undefined) ?? {}),
                                created: timestamp,
                            },
                        }),
                    );
                    insertPart.run(
                        partId,
                        messageId,
                        sessionId,
                        timestamp,
                        timestamp,
                        JSON.stringify({
                            ...partTemplate,
                            id: partId,
                            messageID: messageId,
                            sessionID: sessionId,
                            text,
                        }),
                    );
                }
            });
            append();
        } finally {
            db.close();
        }
    }

    async sendPrompt(
        sessionId: string,
        text: string,
        options: { agent?: string; timeoutMs?: number } = {},
    ): Promise<unknown> {
        const timeoutMs = options.timeoutMs ?? 180_000;
        const promptPromise = this.clientInstance.session.prompt({
            path: { id: sessionId },
            body: {
                model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
                parts: [{ type: "text", text }],
                ...(options.agent ? { agent: options.agent } : {}),
            },
        });
        const timeout = new Promise<null>((r) =>
            setTimeout(() => r(null), timeoutMs),
        );
        const result = await Promise.race([promptPromise, timeout]);
        if (result === null) {
            throw new Error(
                `sendPrompt did not complete within ${timeoutMs}ms. stderr:\n${this.opencodeInstance
                    .stderr()
                    .slice(
                        -2000,
                    )}\nmc-host log:\n${this.mcHost.hostLog().slice(-2000)}`,
            );
        }
        return result;
    }

    /**
     * Remove a message from the session the way session.revert does — the
     * message.removed event path the ordinal resolver must self-heal from. Reverts
     * TO the given message (dropping it and everything after), then unshares so the
     * revert is applied as a real removal opencode persists to its DB.
     */
    async revertMessage(sessionId: string, messageId: string): Promise<void> {
        await this.clientInstance.session.revert({
            path: { id: sessionId },
            body: { messageID: messageId },
        });
    }

    /** Fetch the session's messages via the SDK (for choosing a mid-session id to remove). */
    async listMessages(
        sessionId: string,
    ): Promise<Array<{ info?: { id?: string; role?: string } }>> {
        const res = await this.clientInstance.session.messages({
            path: { id: sessionId },
        });
        const data = (res as { data?: unknown }).data;
        return Array.isArray(data)
            ? (data as Array<{ info?: { id?: string; role?: string } }>)
            : [];
    }

    // ── wire captures (from the fake provider) ────────────────────────────────

    /** Full captured provider request bodies for the main agent (Magic Context system prompt present). */
    mainRequests() {
        return this.mock
            .requests()
            .filter((r) =>
                JSON.stringify(r.body.system ?? "").includes(
                    "## Magic Context",
                ),
            );
    }

    /** The messages array of the most recent main-agent request. */
    lastMainMessages(): Array<{ role?: string; content?: unknown }> {
        const req = this.mainRequests().at(-1);
        const messages = req?.body.messages;
        return Array.isArray(messages)
            ? (messages as Array<{ role?: string; content?: unknown }>)
            : [];
    }

    /**
     * Byte size of the full serialized messages array of the most recent
     * main-agent request, with `cache_control` stripped (it is provider cache
     * bookkeeping that varies pass to pass and is not part of the logical wire).
     */
    lastMainWireBytes(): number {
        const req = this.mainRequests().at(-1);
        if (!req) return 0;
        return Buffer.byteLength(stableSerialize(req.body.messages ?? []));
    }

    /** Stable serialization of the most recent main-agent messages array (cache_control stripped). */
    lastMainWireSerialized(): string {
        const req = this.mainRequests().at(-1);
        return stableSerialize(req?.body.messages ?? []);
    }

    // ── plugin-log rust-pass decisions (secondary signal) ─────────────────────

    /**
     * Wait until at least `minCount` rust-pass lines are visible, then return
     * them. The plugin logger buffers and flushes every ~500ms, so a read
     * immediately after a prompt returns can miss the just-emitted pass. Polling
     * removes that race without a fixed sleep (the no-sleeps-as-sync rule).
     */
    async waitForRustPasses(
        minCount: number,
        timeoutMs = 15_000,
    ): Promise<RustPassLine[]> {
        return this.waitFor(
            () => {
                const passes = this.readRustPasses();
                return passes.length >= minCount ? passes : null;
            },
            { timeoutMs, label: `>= ${minCount} rust passes` },
        );
    }

    /** Read the subprocess diagnostic log for assertions about the active lineage. */
    diagnosticLog(): string {
        if (!existsSync(this.logPath)) return "";
        return readFileSync(this.logPath, "utf8");
    }

    /** Parse every `rust pass:` diagnostic line the Rust transform emitted so far. */
    readRustPasses(): RustPassLine[] {
        if (!existsSync(this.logPath)) return [];
        const lines = readFileSync(this.logPath, "utf8").split("\n");
        const parsed: RustPassLine[] = [];
        for (const line of lines) {
            const idx = line.indexOf("rust pass: ");
            if (idx < 0) continue;
            const body = line.slice(idx + "rust pass: ".length);
            const elapsedMs = Number(field(body, "elapsed") || "0");
            const moduleElapsedMs = Number(field(body, "module") || "0");
            parsed.push({
                decision: field(body, "decision"),
                reason: field(body, "reason"),
                servedFrom: field(body, "served_from"),
                inputCount: Number(field(body, "in") || "0"),
                outputCount: Number(field(body, "out") || "0"),
                applied: field(body, "applied") === "true",
                elapsedMs,
                moduleElapsedMs,
                adapterElapsedMs: Math.max(0, elapsedMs - moduleElapsedMs),
                prefixGuardMs: Number(stageField(body, "prefix_guard") || "0"),
                stateSyncMs: Number(stageField(body, "state_sync") || "0"),
                wireBuildMs: Number(stageField(body, "wire_build") || "0"),
                wireMessages: Number(stageField(body, "wire_messages") || "0"),
                transportMs: Number(stageField(body, "transport") || "0"),
                transportPages: Number(
                    stageField(body, "transport_pages") || "0",
                ),
                transportBytes: Number(
                    stageField(body, "transport_bytes") || "0",
                ),
                rowVersion: Number(field(body, "row_version") || "0"),
                raw: line,
            });
        }
        return parsed;
    }

    /** Poll until `predicate` returns truthy or `timeoutMs` elapses. */
    async waitFor<T>(
        predicate: () => T | null | undefined | false,
        opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
    ): Promise<T> {
        const timeoutMs = opts.timeoutMs ?? 60_000;
        const intervalMs = opts.intervalMs ?? 100;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const value = predicate();
            if (value) return value as T;
            await Bun.sleep(intervalMs);
        }
        throw new Error(
            `waitFor timed out after ${timeoutMs}ms${opts.label ? ` (${opts.label})` : ""}`,
        );
    }

    // ── context.db access (plugin state) ──────────────────────────────────────

    private contextDbPath(): string {
        return join(
            this.env.dataDir,
            "cortexkit",
            "magic-context",
            "context.db",
        );
    }

    contextDb(): Database {
        if (this.contextDbCached) return this.contextDbCached;
        const dbPath = this.contextDbPath();
        if (!existsSync(dbPath)) {
            throw new Error(
                `context.db not found at ${dbPath} — plugin may not have initialized yet.`,
            );
        }
        this.contextDbCached = new Database(dbPath, { readonly: true });
        return this.contextDbCached;
    }

    hasContextDb(): boolean {
        return existsSync(this.contextDbPath());
    }

    countTagsByStatus(sessionId: string, status: string): number {
        try {
            const row = this.contextDb()
                .prepare(
                    "SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = ?",
                )
                .get(sessionId, status) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    /**
     * Override one session's cache TTL for a deterministic cache-busting probe.
     * The regular config path only refreshes this value on a new session; tests
     * that preserve a warm module session need to change it without recreating
     * the queued module-side drop.
     */
    setSessionCacheTtl(sessionId: string, cacheTtl: string): void {
        if (this.contextDbCached) {
            try {
                this.contextDbCached.close();
            } catch {
                // Best-effort close: a failure must not prevent reopening the database below.
            }
            this.contextDbCached = null;
        }
        const dbPath = this.contextDbPath();
        const db = new Database(dbPath);
        try {
            const result = db
                .prepare(
                    "UPDATE session_meta SET cache_ttl = ? WHERE session_id = ?",
                )
                .run(cacheTtl, sessionId) as { changes?: number };
            if (result.changes !== 1) {
                throw new Error(
                    `session cache TTL update affected ${result.changes ?? 0} rows`,
                );
            }
        } finally {
            db.close();
        }
    }

    /** All mock requests received in this suite. */
    requests() {
        return this.mock.requests();
    }

    async dispose(): Promise<void> {
        if (this.contextDbCached) {
            try {
                this.contextDbCached.close();
            } catch {
                // ignore
            }
            this.contextDbCached = null;
        }
        // OpenCode owns client connections, so stop it before fixture.
        try {
            await this.opencodeInstance.kill();
        } catch {
            // ignore
        }
        try {
            await this.mcHost.stop();
        } catch {
            // ignore
        }
        try {
            await this.mock.stop();
        } catch {
            // ignore
        }
        // Reclaim the per-suite temp tree (best-effort).
        try {
            rmSync(join(this.env.dataDir, ".."), {
                recursive: true,
                force: true,
            });
        } catch {
            // ignore
        }
    }
}

/** Extract `key=value` (value = up to the next space) from a rust-pass log body. */
function field(body: string, key: string): string {
    const match = body.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`));
    return match ? match[1]! : "";
}

function stageField(body: string, key: string): string {
    const match = body.match(new RegExp(`(?:^|\\s)${key}:([^\\s]+)`));
    return match ? match[1]! : "";
}

/** Serialize a value with every `cache_control` key stripped, for byte-identity checks. */
export function stableSerialize(value: unknown): string {
    return JSON.stringify(stripCacheControl(value));
}

type CacheStrippedValue =
    | null
    | boolean
    | number
    | string
    | CacheStrippedValue[]
    | { [key: string]: CacheStrippedValue | undefined };

function stripCacheControl(value: unknown): CacheStrippedValue | undefined {
    if (Array.isArray(value))
        return value
            .map(stripCacheControl)
            .filter((item) => item !== undefined);
    if (value && typeof value === "object") {
        const out: { [key: string]: CacheStrippedValue | undefined } = {};
        for (const [key, child] of Object.entries(value)) {
            if (key === "cache_control") continue;
            out[key] = stripCacheControl(child);
        }
        return out;
    }
    if (
        value === null ||
        ["boolean", "number", "string"].includes(typeof value)
    ) {
        return value as null | boolean | number | string;
    }
    return undefined;
}
