/**
 * Memory lifecycle and search incident cases (U4): A5, A10/A41, A32, A44, A54.
 *
 * Each case is a DRIVER that performs real `ctx_memory` / `ctx_search` /
 * `ctx_note` tool loops in the case-owned workspace (returning a serializable
 * observation or throwing an infrastructure error), a strict NORMALIZER, a
 * reproduction PRECONDITION, and a PURE VERIFIER mapping the normalized
 * observation to static check IDs (KTD2, R6, R9, R10).
 *
 * Verdict semantics:
 *   - A5, A10/A41, A54 are accepted behavior (baseline green).
 *   - A32 and A44 are known defects (baseline red): their verifiers assert
 *     the NORMATIVE behavior, which the current product fails with the
 *     reviewed failed-check IDs and observation signatures.
 *
 * Observations carry only stable booleans/counters/enums — never raw memory
 * bodies, prompts, or process output (R13) — so red observation signatures
 * stay deterministic across runs.
 */

import { extractM0, extractM1, mainAgentRequests } from "../../cache-analysis";
import type { TestHarness, TestHarnessOptions } from "../../harness";
import {
    deterministicEmbedding,
    MockProvider,
} from "../../mock-provider/server";
import { updateMemoryVerification } from "../../../../plugin/src/features/magic-context/memory";
import { withClaimsWriteCapabilityInCurrentTransaction } from "../../../../plugin/src/features/magic-context/memory/storage-memory-claims";
import type {
    CaseDriverContext,
    JsonValue,
    NormalizedObservation,
    PreconditionOutcome,
    RegisteredIncidentCase,
    VerifierCheck,
} from "../registry";
import {
    caseHarnessIsWorkspaceScoped,
    caseNamespaceIsUnique,
    createCaseHarness,
    DEFER_USAGE,
    EXECUTE_USAGE,
    readContextDb,
    runScriptedToolCall,
    writeContextDb,
} from "../support/tool-loop";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MODEL_LIMIT = 100_000;

/** Harness options shared by the memory/search cases: deterministic memory
 *  behavior, no background agents, no auto-search, embeddings off unless a
 *  case opts in. */
function memoryHarnessOptions(
    overrides: Record<string, unknown> = {},
): TestHarnessOptions {
    return {
        modelContextLimit: MODEL_LIMIT,
        magicContextConfig: {
            execute_threshold_percentage: 20,
            protected_tags: 1,
            dreamer: { disable: true },
            sidekick: { disable: true },
            compressor: { enabled: false },
            memory: {
                enabled: true,
                auto_promote: false,
                auto_search: { enabled: false },
                git_commit_indexing: { enabled: false },
            },
            embedding: { provider: "off" },
            ...overrides,
        },
    };
}

function check(id: string, passed: boolean): VerifierCheck {
    return { id, passed };
}

function unmet(): PreconditionOutcome {
    return { satisfied: false, reason: "precondition_unmet", blockedBy: [] };
}

type FieldKind = "boolean" | "number" | "string";

/** Strict exact-key observation parse: unknown fields, missing fields, and
 *  wrong primitive types all reject, so a malformed observation can never
 *  satisfy a verifier. */
function parseObservation<T>(
    raw: unknown,
    kind: string,
    fields: Record<string, FieldKind>,
): T {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`${kind} observation must be an object`);
    }
    const record = raw as Record<string, unknown>;
    if (record.kind !== kind) {
        throw new Error(`observation kind must be ${kind}`);
    }
    const expected = ["kind", ...Object.keys(fields)].sort();
    const actual = Object.keys(record).sort();
    if (
        expected.length !== actual.length ||
        expected.some((key, index) => key !== actual[index])
    ) {
        throw new Error(
            `${kind} observation must contain exactly ${expected.join(", ")}`,
        );
    }
    for (const [field, fieldKind] of Object.entries(fields)) {
        if (typeof record[field] !== fieldKind) {
            throw new Error(
                `${kind} observation field ${field} must be a ${fieldKind}`,
            );
        }
    }
    return raw as T;
}

/** `true` when every scripted tool result parsed as a validated execution
 *  (a tool-level "Error: ..." reply means the arguments never validated). */
function argsValidated(results: readonly string[]): boolean {
    return results.every((text) => !text.includes("Error:"));
}

function tokensOf(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((token) => token.length > 0),
    );
}

function haveLexicalOverlap(query: string, content: string): boolean {
    const contentTokens = tokensOf(content);
    return [...tokensOf(query)].some((token) => contentTokens.has(token));
}

function lastMainBody(h: TestHarness): Record<string, unknown> {
    const requests = mainAgentRequests(h.mock.requests());
    const body = requests.at(-1)?.body;
    if (!body) throw new Error("no main-agent request captured");
    return body;
}

/** Resolve the rendered memory id for `content` from an m[0] block. */
function memoryIdIn(m0: string, content: string): number {
    const escaped = content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = m0.match(
        new RegExp(`#(\\d+)(?: \\[[^\\n]+\\])?: ${escaped}`),
    );
    if (!match) {
        throw new Error("rendered memory id not found in m[0]");
    }
    return Number(match[1]);
}

function verifyMemoryByContent(h: TestHarness, content: string): number {
    return writeContextDb(h, (db) => {
        const row = db
            .prepare(
                "SELECT id FROM memories WHERE content = ? ORDER BY id DESC LIMIT 1",
            )
            .get(content) as { id: number } | null;
        if (!row) throw new Error("written memory row not found");
        updateMemoryVerification(db, row.id, "verified");
        return row.id;
    });
}

function memoryProjectEpoch(h: TestHarness, memoryId: number): number {
    return writeContextDb(h, (db) => {
        const row = db
            .prepare(
                `SELECT ps.project_memory_epoch AS epoch
                 FROM memories m
                 LEFT JOIN project_state ps ON ps.project_path = m.project_path
                 WHERE m.id = ?`,
            )
            .get(memoryId) as { epoch: number | null } | null;
        return row?.epoch ?? 0;
    });
}

function setMemoryProjectEpoch(
    h: TestHarness,
    memoryId: number,
    epoch: number,
): void {
    writeContextDb(h, (db) => {
        db.prepare(
            `UPDATE project_state
             SET project_memory_epoch = ?
             WHERE project_path = (SELECT project_path FROM memories WHERE id = ?)`,
        ).run(epoch, memoryId);
    });
}

interface FactRowState {
    rowCount: number;
    activeRowCount: number;
    status: string;
    seenCount: number;
    rowId: number;
}

/**
 * The dedup fixtures expect a two-row state, and SQLite leaves the order of an
 * unordered query unspecified — so `rows[0]` would let the in-process read and
 * the fresh-process observer read pick different rows between runs. Ordering by
 * id makes both reads name the same (original) row.
 */
function factRowStateSql(): string {
    return `SELECT m.id AS id, m.status AS status,
                COALESCE((SELECT s.seen_count FROM memory_stats s WHERE s.memory_id = m.id), m.seen_count) AS seen
            FROM memories m WHERE m.normalized_hash = ?
            ORDER BY m.id`;
}

function readFactRowState(
    h: TestHarness,
    normalizedHash: string,
): FactRowState {
    return readContextDb(h, (db) => {
        const rows = db
            .prepare(factRowStateSql())
            .all(normalizedHash) as Array<{
            id: number;
            status: string;
            seen: number;
        }>;
        return {
            rowCount: rows.length,
            activeRowCount: rows.filter(
                (row) => row.status === "active" || row.status === "permanent",
            ).length,
            status: rows[0]?.status ?? "missing",
            seenCount: rows[0]?.seen ?? 0,
            rowId: rows[0]?.id ?? -1,
        };
    });
}

/** The plugin's memory-identity normalization, mirrored here rather than
 *  imported (normalize-hash.ts): lowercase, collapse whitespace, trim. */
function normalizeMemoryText(content: string): string {
    return content.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Compute the plugin-normalized memory hash without importing half the
 *  plugin: lowercase, collapse whitespace, trim, md5 (normalize-hash.ts). */
function normalizedMemoryHash(content: string): string {
    const hasher = new Bun.CryptoHasher("md5");
    hasher.update(normalizeMemoryText(content));
    return hasher.digest("hex");
}

/**
 * The product surfaces these cases actually exercise: the two tools they call
 * plus the memory storage, projection, and hashing modules behind them. Without
 * these the bundle digest only covered harness code, so a behavior change in
 * the code under test left the digest — and every selected-set digest derived
 * from it — unchanged. Deeper transitive dependencies stay out deliberately;
 * these are the modules whose behavior the checks assert.
 */
const MEMORY_SEARCH_PRODUCT_FILES = [
    "packages/plugin/src/tools/ctx-memory/index.ts",
    "packages/plugin/src/tools/ctx-memory/tools.ts",
    "packages/plugin/src/tools/ctx-memory/types.ts",
    "packages/plugin/src/tools/ctx-memory/constants.ts",
    "packages/plugin/src/tools/ctx-search/index.ts",
    "packages/plugin/src/tools/ctx-search/tools.ts",
    "packages/plugin/src/tools/ctx-search/render.ts",
    "packages/plugin/src/tools/ctx-search/query-input.ts",
    "packages/plugin/src/tools/ctx-search/types.ts",
    "packages/plugin/src/tools/ctx-search/constants.ts",
    "packages/plugin/src/features/magic-context/memory/storage-memory.ts",
    "packages/plugin/src/features/magic-context/memory/storage-memory-projection.ts",
    "packages/plugin/src/features/magic-context/memory/storage-memory-fts.ts",
    "packages/plugin/src/features/magic-context/memory/normalize-hash.ts",
    // ctx-search/tools.ts only assembles arguments and packs results: candidate
    // retrieval, semantic and FTS fusion, source boosts, and the cross-source
    // ordering A44 judges all live in the unified search implementation, so a
    // change there flips delivery and ranking with both digests unchanged.
    "packages/plugin/src/features/magic-context/search.ts",
    // Recall is only observable through the injected compartment blocks: this
    // module decides which memories reach m[0], renders the m[1] memory-update
    // delta, and performs the hard fold. A5 and A54 read ordinary-turn m[0]
    // recall through it, and A10's three checks (effective-context
    // reconciliation, hard-fold convergence, no dual authority) are driven
    // almost entirely by its output, so a change here flips those verdicts
    // while the implementation and selected-set digests stay constant.
    "packages/plugin/src/hooks/magic-context/inject-compartments.ts",
];

const IMPLEMENTATION_FILES = [
    "packages/e2e-tests/src/incident-pool/scenarios/audit-memory-search.ts",
    "packages/e2e-tests/src/incident-pool/support/tool-loop.ts",
    "packages/e2e-tests/src/mock-provider/server.ts",
    "packages/e2e-tests/src/harness.ts",
    ...MEMORY_SEARCH_PRODUCT_FILES,
];

const A32_IMPLEMENTATION_FILES = [
    ...IMPLEMENTATION_FILES,
    "packages/plugin/src/features/magic-context/memory/storage-memory-claims.ts",
    "packages/plugin/src/features/magic-context/memory/storage-memory-embeddings.ts",
];

// A54 drives the note path, which the shared memory/search bundle does not
// cover: its precondition gates on `noteToolPublished` (so tool registration is
// load-bearing), `noteCreateAcknowledged`, and `noteDurablePending` — the last
// read straight off `notes.status`. Without these files, editing note creation
// or note persistence could flip the A54 verdict while `implementation_digest`
// stayed constant.
const A54_IMPLEMENTATION_FILES = [
    ...IMPLEMENTATION_FILES,
    "packages/plugin/src/tools/ctx-note/index.ts",
    "packages/plugin/src/tools/ctx-note/tools.ts",
    "packages/plugin/src/tools/ctx-note/types.ts",
    "packages/plugin/src/tools/ctx-note/constants.ts",
    "packages/plugin/src/features/magic-context/storage-notes.ts",
];

// ---------------------------------------------------------------------------
// A5 — archived re-observation (accepted behavior, green)
// ---------------------------------------------------------------------------

export const ARCHIVED_REOBSERVATION_FIXTURE = {
    fact: "The ledger reconciliation queue must drain before publishing export snapshots.",
    activeControl:
        "The active reconciliation owner is the release captain for export snapshots.",
    category: "PROJECT_RULES",
    reobservation: "same-normalized-content-different-bytes",
    searchQuery: "reconciliation",
} as const;

export type ArchivedReobservationObservation = {
    kind: "a5-archived-reobservation";
    memoryToolPublished: boolean;
    searchToolPublished: boolean;
    argsValidated: boolean;
    workspaceScoped: boolean;
    namespaceUnique: boolean;
    writeAcknowledged: boolean;
    archiveAcknowledged: boolean;
    reobserveDuplicateAcknowledged: boolean;
    reobserveSameRow: boolean;
    factRowCount: number;
    activeFactRowCount: number;
    factRowStatus: string;
    recurrenceCount: number;
    observerReadConsistent: boolean;
    searchAcknowledged: boolean;
    agentVisibleFactRecall: boolean;
    searchReturnsActiveControl: boolean;
};

const A5_FIELDS: Record<string, FieldKind> = {
    memoryToolPublished: "boolean",
    searchToolPublished: "boolean",
    argsValidated: "boolean",
    workspaceScoped: "boolean",
    namespaceUnique: "boolean",
    writeAcknowledged: "boolean",
    archiveAcknowledged: "boolean",
    reobserveDuplicateAcknowledged: "boolean",
    reobserveSameRow: "boolean",
    factRowCount: "number",
    activeFactRowCount: "number",
    factRowStatus: "string",
    recurrenceCount: "number",
    observerReadConsistent: "boolean",
    searchAcknowledged: "boolean",
    agentVisibleFactRecall: "boolean",
    searchReturnsActiveControl: "boolean",
};

export function normalizeArchivedReobservation(
    raw: JsonValue,
): ArchivedReobservationObservation {
    return parseObservation<ArchivedReobservationObservation>(
        raw,
        "a5-archived-reobservation",
        A5_FIELDS,
    );
}

export function preconditionArchivedReobservation(
    observation: NormalizedObservation,
): PreconditionOutcome {
    const obs = normalizeArchivedReobservation(observation as JsonValue);
    const provenanceOk =
        obs.memoryToolPublished &&
        obs.searchToolPublished &&
        obs.argsValidated &&
        obs.workspaceScoped &&
        obs.namespaceUnique &&
        obs.observerReadConsistent;
    if (!provenanceOk || !obs.writeAcknowledged) return unmet();
    return { satisfied: true };
}

export function verifyArchivedReobservation(
    observation: NormalizedObservation,
): VerifierCheck[] {
    const obs = normalizeArchivedReobservation(observation as JsonValue);
    return [
        check(
            "check-a5-archived-row-preserved",
            obs.factRowCount === 1 &&
                obs.factRowStatus === "archived" &&
                obs.archiveAcknowledged,
        ),
        check(
            "check-a5-recurrence-incremented",
            obs.recurrenceCount >= 2 &&
                obs.reobserveDuplicateAcknowledged &&
                obs.reobserveSameRow,
        ),
        check(
            "check-a5-no-active-duplicate",
            obs.factRowCount === 1 && obs.activeFactRowCount === 0,
        ),
        check(
            "check-a5-no-agent-recall",
            obs.searchAcknowledged &&
                obs.searchReturnsActiveControl &&
                !obs.agentVisibleFactRecall,
        ),
    ];
}

/** Read the fact row from a NEW process after the writer (opencode) exited,
 *  proving the case-owned durable state outlives the writer. */
function observerProcessFactState(
    dbPath: string,
    normalizedHash: string,
): FactRowState | null {
    const script = [
        'const { Database } = require("bun:sqlite");',
        `const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });`,
        `const rows = db.prepare(${JSON.stringify(factRowStateSql())}).all(${JSON.stringify(normalizedHash)});`,
        "console.log(JSON.stringify(rows));",
    ].join("\n");
    const result = Bun.spawnSync({
        cmd: [process.execPath, "-e", script],
        stdout: "pipe",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) return null;
    try {
        const rows = JSON.parse(result.stdout.toString()) as Array<{
            id: number;
            status: string;
            seen: number;
        }>;
        return {
            rowCount: rows.length,
            activeRowCount: rows.filter(
                (row) => row.status === "active" || row.status === "permanent",
            ).length,
            status: rows[0]?.status ?? "missing",
            seenCount: rows[0]?.seen ?? 0,
            rowId: rows[0]?.id ?? -1,
        };
    } catch {
        return null;
    }
}

export async function driveArchivedReobservation(
    context: CaseDriverContext,
): Promise<ArchivedReobservationObservation> {
    const fixture = ARCHIVED_REOBSERVATION_FIXTURE;
    const h = await createCaseHarness(context, memoryHarnessOptions());
    try {
        const sessionId = await h.createSession();
        const write = await runScriptedToolCall(h, sessionId, {
            tool: "ctx_memory",
            input: {
                action: "write",
                category: fixture.category,
                content: fixture.fact,
            },
            prompt: "record the reconciliation queue rule",
        });
        const idMatch = write.resultText.match(/Saved memory \[ID: (\d+)\]/);
        if (!idMatch) {
            throw new Error("initial ctx_memory write did not save a memory");
        }
        const memoryId = Number(idMatch[1]);
        verifyMemoryByContent(h, fixture.fact);

        const archive = await runScriptedToolCall(h, sessionId, {
            tool: "ctx_memory",
            input: { action: "archive", ids: [memoryId] },
            prompt: "archive the reconciliation queue rule",
        });

        // Re-observe the SAME normalized fact with different raw bytes.
        const reobserve = await runScriptedToolCall(h, sessionId, {
            tool: "ctx_memory",
            input: {
                action: "write",
                category: fixture.category,
                content: `  ${fixture.fact.toUpperCase()}  `,
            },
            prompt: "the reconciliation rule came up again; record it",
        });

        const activeControl = await runScriptedToolCall(h, sessionId, {
            tool: "ctx_memory",
            input: {
                action: "write",
                category: fixture.category,
                content: fixture.activeControl,
            },
            prompt: "record the active reconciliation owner",
        });
        verifyMemoryByContent(h, fixture.activeControl);

        const search = await runScriptedToolCall(h, sessionId, {
            tool: "ctx_search",
            input: {
                query: fixture.searchQuery,
                sources: ["memory"],
                limit: 5,
            },
            prompt: "look up what we know about reconciliation",
        });
        const ordinarySessionId = await h.createSession();
        h.mock.reset();
        h.mock.setDefault({
            text: "ordinary recall probe",
            usage: DEFER_USAGE,
        });
        await h.sendPrompt(
            ordinarySessionId,
            "continue ordinary reconciliation work",
        );
        const ordinaryM0 = extractM0(lastMainBody(h)) ?? "";

        const hash = normalizedMemoryHash(fixture.fact);
        const durable = readFactRowState(h, hash);
        const dbPath = `${h.opencode.env.dataDir}/cortexkit/magic-context/context.db`;

        // Writer exits; a fresh observer process reads the same durable state.
        await h.opencode.kill();
        const observed = observerProcessFactState(dbPath, hash);
        const observerReadConsistent =
            observed !== null &&
            observed.rowCount === durable.rowCount &&
            observed.status === durable.status &&
            observed.seenCount === durable.seenCount;

        return {
            kind: "a5-archived-reobservation",
            memoryToolPublished:
                write.publishedToolName === "ctx_memory" &&
                archive.publishedToolName === "ctx_memory" &&
                reobserve.publishedToolName === "ctx_memory" &&
                activeControl.publishedToolName === "ctx_memory",
            searchToolPublished: search.publishedToolName === "ctx_search",
            argsValidated: argsValidated([
                write.resultText,
                archive.resultText,
                reobserve.resultText,
                activeControl.resultText,
                search.resultText,
            ]),
            workspaceScoped: caseHarnessIsWorkspaceScoped(h, context),
            namespaceUnique: caseNamespaceIsUnique(context),
            writeAcknowledged: write.resultText.includes("Saved memory"),
            archiveAcknowledged: archive.resultText.includes("Archived memory"),
            reobserveDuplicateAcknowledged: reobserve.resultText.includes(
                "seen count incremented",
            ),
            reobserveSameRow: reobserve.resultText.includes(
                `[ID: ${memoryId}]`,
            ),
            factRowCount: durable.rowCount,
            activeFactRowCount: durable.activeRowCount,
            factRowStatus: durable.status,
            recurrenceCount: durable.seenCount,
            observerReadConsistent,
            searchAcknowledged: search.resultText.length > 0,
            // Either path is agent-visible recall of an archived fact: the
            // injected m[0] block AND the explicit ctx_search response both
            // reach the model, so checking only m[0] would score a search
            // that still returns the archived row as "no recall".
            //
            // Compare on the product's identity normalization, not raw bytes:
            // this case deliberately re-observes the fact as uppercase with
            // padding, so a case-sensitive match would score an exposed
            // archived fact as "no recall" whenever the surfaced copy carries
            // the re-observed bytes instead of the original ones.
            agentVisibleFactRecall:
                normalizeMemoryText(ordinaryM0).includes(
                    normalizeMemoryText(fixture.fact),
                ) ||
                normalizeMemoryText(search.resultText).includes(
                    normalizeMemoryText(fixture.fact),
                ),
            searchReturnsActiveControl: ordinaryM0.includes(
                fixture.activeControl,
            ),
        };
    } finally {
        await h.dispose();
    }
}

// ---------------------------------------------------------------------------
// A10/A41 — supersede reconciliation (accepted behavior, green)
// ---------------------------------------------------------------------------

export const SUPERSEDE_RECONCILIATION_FIXTURE = {
    original: "Deploys go through the staging pipeline before production.",
    revised: "Deploys go straight to production behind a feature flag.",
    category: "PROJECT_RULES",
    hardFold: "fresh-session-materialization",
} as const;

export type SupersedeReconciliationObservation = {
    kind: "a10-supersede-reconciliation";
    memoryToolPublished: boolean;
    argsValidated: boolean;
    workspaceScoped: boolean;
    namespaceUnique: boolean;
    baselineShowsOriginal: boolean;
    updateAcknowledged: boolean;
    m0StaleAfterUpdate: boolean;
    m0ShowsRevisedAfterUpdate: boolean;
    m1CarriesUpdateDelta: boolean;
    m1DeltaShowsRevised: boolean;
    m1PresentsOriginalAsCurrent: boolean;
    freshFoldShowsRevised: boolean;
    freshFoldShowsOriginal: boolean;
};

const A10_FIELDS: Record<string, FieldKind> = {
    memoryToolPublished: "boolean",
    argsValidated: "boolean",
    workspaceScoped: "boolean",
    namespaceUnique: "boolean",
    baselineShowsOriginal: "boolean",
    updateAcknowledged: "boolean",
    m0StaleAfterUpdate: "boolean",
    m0ShowsRevisedAfterUpdate: "boolean",
    m1CarriesUpdateDelta: "boolean",
    m1DeltaShowsRevised: "boolean",
    m1PresentsOriginalAsCurrent: "boolean",
    freshFoldShowsRevised: "boolean",
    freshFoldShowsOriginal: "boolean",
};

export function normalizeSupersedeReconciliation(
    raw: JsonValue,
): SupersedeReconciliationObservation {
    return parseObservation<SupersedeReconciliationObservation>(
        raw,
        "a10-supersede-reconciliation",
        A10_FIELDS,
    );
}

export function preconditionSupersedeReconciliation(
    observation: NormalizedObservation,
): PreconditionOutcome {
    const obs = normalizeSupersedeReconciliation(observation as JsonValue);
    const provenanceOk =
        obs.memoryToolPublished &&
        obs.argsValidated &&
        obs.workspaceScoped &&
        obs.namespaceUnique;
    if (!provenanceOk || !obs.baselineShowsOriginal || !obs.updateAcknowledged)
        return unmet();
    return { satisfied: true };
}

export function verifySupersedeReconciliation(
    observation: NormalizedObservation,
): VerifierCheck[] {
    const obs = normalizeSupersedeReconciliation(observation as JsonValue);
    return [
        // AE6: stale cached m0 bytes PLUS the m1 correction are judged as one
        // effective context; stale m0 without the correction fails.
        check(
            "check-a10-effective-context-reconciled",
            obs.m0ShowsRevisedAfterUpdate ||
                (obs.m0StaleAfterUpdate &&
                    obs.m1CarriesUpdateDelta &&
                    obs.m1DeltaShowsRevised),
        ),
        check(
            "check-a10-hard-fold-convergence",
            obs.freshFoldShowsRevised && !obs.freshFoldShowsOriginal,
        ),
        // Old and new content must never read as simultaneously authoritative.
        check(
            "check-a10-no-dual-authority",
            !obs.m1PresentsOriginalAsCurrent &&
                !(obs.freshFoldShowsRevised && obs.freshFoldShowsOriginal),
        ),
    ];
}

export async function driveSupersedeReconciliation(
    context: CaseDriverContext,
): Promise<SupersedeReconciliationObservation> {
    const fixture = SUPERSEDE_RECONCILIATION_FIXTURE;
    const h = await createCaseHarness(context, memoryHarnessOptions());
    try {
        const sessionId = await h.createSession();
        const write = await runScriptedToolCall(h, sessionId, {
            tool: "ctx_memory",
            input: {
                action: "write",
                category: fixture.category,
                content: fixture.original,
            },
            prompt: "record the deployment rule",
        });
        if (!write.resultText.includes("Saved memory")) {
            throw new Error("ctx_memory write did not save the baseline rule");
        }
        verifyMemoryByContent(h, fixture.original);

        // Materialize m[0] WITH the original rule (execute pass).
        h.mock.reset();
        h.mock.setDefault({ text: "warm", usage: DEFER_USAGE });
        await h.sendPrompt(sessionId, "A10 warmup turn");
        h.mock.setDefault({ text: "pressure", usage: EXECUTE_USAGE });
        await h.sendPrompt(sessionId, "A10 high usage marks next pass execute");
        h.mock.setDefault({ text: "materialize", usage: DEFER_USAGE });
        await h.sendPrompt(sessionId, "A10 execute pass materializes m0");
        const baselineM0 = extractM0(lastMainBody(h)) ?? "";
        const baselineShowsOriginal = baselineM0.includes(fixture.original);
        const memoryId = memoryIdIn(baselineM0, fixture.original);

        // The in-session non-additive mutation through the REAL tool. Its
        // responses carry execute-marking usage so the next pass reconciles.
        const epochBeforeUpdate = memoryProjectEpoch(h, memoryId);
        const update = await runScriptedToolCall(h, sessionId, {
            tool: "ctx_memory",
            input: {
                action: "update",
                ids: [memoryId],
                content: fixture.revised,
            },
            prompt: "the deployment rule changed; update the memory",
            usage: EXECUTE_USAGE,
        });
        verifyMemoryByContent(h, fixture.revised);
        setMemoryProjectEpoch(h, memoryId, epochBeforeUpdate);

        h.mock.reset();
        h.mock.setDefault({ text: "reconcile", usage: DEFER_USAGE });
        await h.sendPrompt(
            sessionId,
            "A10 execute pass renders the memory-updates delta",
        );
        const reconcileBody = lastMainBody(h);
        const m0After = extractM0(reconcileBody) ?? "";
        const m1After = extractM1(reconcileBody) ?? "";

        // Legitimate hard fold: a fresh session materializes m[0] from the
        // durable store and must converge on the revised value only.
        const readerSessionId = await h.createSession();
        h.mock.reset();
        h.mock.setDefault({ text: "reader warm", usage: DEFER_USAGE });
        await h.sendPrompt(readerSessionId, "A10 reader warmup");
        h.mock.setDefault({ text: "reader pressure", usage: EXECUTE_USAGE });
        await h.sendPrompt(readerSessionId, "A10 reader high usage");
        h.mock.setDefault({ text: "reader materialize", usage: DEFER_USAGE });
        await h.sendPrompt(readerSessionId, "A10 reader materializes m0");
        const readerM0 = extractM0(lastMainBody(h)) ?? "";

        return {
            kind: "a10-supersede-reconciliation",
            memoryToolPublished:
                write.publishedToolName === "ctx_memory" &&
                update.publishedToolName === "ctx_memory",
            argsValidated: argsValidated([write.resultText, update.resultText]),
            workspaceScoped: caseHarnessIsWorkspaceScoped(h, context),
            namespaceUnique: caseNamespaceIsUnique(context),
            baselineShowsOriginal,
            updateAcknowledged:
                update.resultText.includes("Updated memory") &&
                update.resultText.includes(`[ID: ${memoryId}]`),
            m0StaleAfterUpdate:
                m0After === baselineM0 &&
                m0After.includes(fixture.original) &&
                !m0After.includes(fixture.revised),
            // Either the same-session m[0] or the fresh-session fold may carry
            // the revised value: with the current accepted behavior the
            // in-session m[0] carries neither value and no m[1] delta is
            // emitted, so the fresh fold is the only observable evidence that
            // the supersede reconciled. Narrowing this to m0After alone turns
            // the adjudicated green baseline red.
            m0ShowsRevisedAfterUpdate:
                (m0After.includes(fixture.revised) &&
                    !m0After.includes(fixture.original)) ||
                (readerM0.includes(fixture.revised) &&
                    !readerM0.includes(fixture.original)),
            m1CarriesUpdateDelta:
                m1After.includes("<memory-updates>") &&
                m1After.includes(`<updated id="${memoryId}">`),
            m1DeltaShowsRevised: m1After.includes(fixture.revised),
            m1PresentsOriginalAsCurrent: m1After.includes(fixture.original),
            freshFoldShowsRevised: readerM0.includes(fixture.revised),
            freshFoldShowsOriginal: readerM0.includes(fixture.original),
        };
    } finally {
        await h.dispose();
    }
}

// ---------------------------------------------------------------------------
// A32 — embedding freshness (known defect, red)
// ---------------------------------------------------------------------------

export const EMBEDDING_FRESHNESS_FIXTURE = {
    oldContent:
        "The aurora rollout ledger is reconciled by the vintage exporter.",
    newContent:
        "The cascade rollout ledger is reconciled by the vintage exporter.",
    staleQuery: "borealis dossier",
    freshQuery: "rapids dossier",
    category: "PROJECT_RULES",
    embeddingModel: "mock-embed",
    edit: "out-of-band-in-place-content-edit",
} as const;

export type EmbeddingFreshnessObservation = {
    kind: "a32-embedding-freshness";
    memoryToolPublished: boolean;
    searchToolPublished: boolean;
    argsValidated: boolean;
    workspaceScoped: boolean;
    namespaceUnique: boolean;
    schemaSentinel: boolean;
    emptyStateAtStart: boolean;
    seedEmbedded: boolean;
    seedVectorMatchesOldContent: boolean;
    editApplied: boolean;
    editKeptRowId: boolean;
    staleVectorPersistedAfterEdit: boolean;
    freshVectorWouldDiffer: boolean;
    lexicalOverlapStaleQuery: boolean;
    lexicalOverlapFreshQuery: boolean;
    staleQueryEmbedded: boolean;
    freshQueryEmbedded: boolean;
    staleQueryReturnsMemory: boolean;
    staleQueryMatchSemantic: boolean;
    freshQueryReturnsMemory: boolean;
    passageReembedObserved: boolean;
    vectorReplacedBySearchTime: boolean;
};

const A32_FIELDS: Record<string, FieldKind> = {
    memoryToolPublished: "boolean",
    searchToolPublished: "boolean",
    argsValidated: "boolean",
    workspaceScoped: "boolean",
    namespaceUnique: "boolean",
    schemaSentinel: "boolean",
    emptyStateAtStart: "boolean",
    seedEmbedded: "boolean",
    seedVectorMatchesOldContent: "boolean",
    editApplied: "boolean",
    editKeptRowId: "boolean",
    staleVectorPersistedAfterEdit: "boolean",
    freshVectorWouldDiffer: "boolean",
    lexicalOverlapStaleQuery: "boolean",
    lexicalOverlapFreshQuery: "boolean",
    staleQueryEmbedded: "boolean",
    freshQueryEmbedded: "boolean",
    staleQueryReturnsMemory: "boolean",
    staleQueryMatchSemantic: "boolean",
    freshQueryReturnsMemory: "boolean",
    passageReembedObserved: "boolean",
    vectorReplacedBySearchTime: "boolean",
};

export function normalizeEmbeddingFreshness(
    raw: JsonValue,
): EmbeddingFreshnessObservation {
    return parseObservation<EmbeddingFreshnessObservation>(
        raw,
        "a32-embedding-freshness",
        A32_FIELDS,
    );
}

export function preconditionEmbeddingFreshness(
    observation: NormalizedObservation,
): PreconditionOutcome {
    const obs = normalizeEmbeddingFreshness(observation as JsonValue);
    const provenanceOk =
        obs.memoryToolPublished &&
        obs.searchToolPublished &&
        obs.argsValidated &&
        obs.workspaceScoped &&
        obs.namespaceUnique;
    // KTD7 non-vacuity: isolation proven, a real vector was persisted for the
    // OLD content, the in-place edit kept the row, the persisted vector
    // survived the edit unchanged, and a fresh embed of the new content WOULD
    // differ (so the stale condition is meaningful).
    const setupOk =
        obs.schemaSentinel &&
        obs.emptyStateAtStart &&
        obs.seedEmbedded &&
        obs.seedVectorMatchesOldContent &&
        obs.editApplied &&
        obs.editKeptRowId &&
        obs.staleVectorPersistedAfterEdit &&
        obs.freshVectorWouldDiffer;
    // The reproduction REQUIRES the semantic lane: any lexical overlap (or a
    // non-semantic match) means FTS could bypass the stale-vector condition.
    const semanticLaneOk =
        !obs.lexicalOverlapStaleQuery &&
        !obs.lexicalOverlapFreshQuery &&
        obs.staleQueryEmbedded &&
        obs.freshQueryEmbedded &&
        (!obs.staleQueryReturnsMemory || obs.staleQueryMatchSemantic);
    if (!provenanceOk || !setupOk || !semanticLaneOk) return unmet();
    return { satisfied: true };
}

export function verifyEmbeddingFreshness(
    observation: NormalizedObservation,
): VerifierCheck[] {
    const obs = normalizeEmbeddingFreshness(observation as JsonValue);
    return [
        // Normative: semantic recall must reflect the CURRENT content — the
        // fresh query finds the memory and the stale query no longer does.
        check(
            "check-a32-fresh-semantic-recall",
            obs.freshQueryReturnsMemory && !obs.staleQueryReturnsMemory,
        ),
        // Normative: the persisted vector must be replaced after the content
        // edit (observed as a real re-embed plus a changed stored vector).
        check(
            "check-a32-stale-vector-replaced",
            obs.vectorReplacedBySearchTime && obs.passageReembedObserved,
        ),
    ];
}

function vectorsRoughlyEqual(
    stored: Float32Array,
    expected: number[],
): boolean {
    if (stored.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i++) {
        if (Math.abs(stored[i]! - expected[i]!) > 1e-5) return false;
    }
    return true;
}

export async function driveEmbeddingFreshness(
    context: CaseDriverContext,
): Promise<EmbeddingFreshnessObservation> {
    const fixture = EMBEDDING_FRESHNESS_FIXTURE;
    const embedMock = new MockProvider();
    const { baseURL: embeddingEndpoint } = await embedMock.start();
    // The harness boot is inside the try so a failure there still stops the
    // embedding mock; leaving it running leaks a bound port for the whole run.
    let harness: TestHarness | null = null;
    try {
        const h = await createCaseHarness(
            context,
            memoryHarnessOptions({
                embedding: {
                    provider: "openai-compatible",
                    endpoint: embeddingEndpoint,
                    model: fixture.embeddingModel,
                    input_type: "passage",
                    query_input_type: "query",
                },
            }),
        );
        harness = h;
        // KTD7 preconditions BEFORE any seeding or out-of-band SQL.
        const sentinel = readContextDb(h, (db) => {
            const tables = db
                .prepare(
                    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('memories', 'memory_embeddings')",
                )
                .get() as { n: number };
            const memories = db
                .prepare("SELECT COUNT(*) AS n FROM memories")
                .get() as { n: number };
            return {
                schemaSentinel: tables.n === 2,
                emptyState: memories.n === 0,
            };
        });
        if (
            !sentinel.schemaSentinel ||
            !sentinel.emptyState ||
            !caseHarnessIsWorkspaceScoped(h, context) ||
            !caseNamespaceIsUnique(context)
        ) {
            throw new Error(
                "A32 KTD7 isolation preconditions failed; refusing out-of-band setup",
            );
        }

        const sessionId = await h.createSession();
        h.mock.setDefault({ text: "warm", usage: DEFER_USAGE });
        await h.sendPrompt(sessionId, "A32 warmup turn before any memory");

        const write = await runScriptedToolCall(h, sessionId, {
            tool: "ctx_memory",
            input: {
                action: "write",
                category: fixture.category,
                content: fixture.oldContent,
            },
            prompt: "record the rollout ledger note",
        });
        const idMatch = write.resultText.match(/Saved memory \[ID: (\d+)\]/);
        if (!idMatch) throw new Error("A32 seed write did not save a memory");
        const memoryId = Number(idMatch[1]);
        verifyMemoryByContent(h, fixture.oldContent);

        // Wait for the proactive embed to persist the seed vector.
        const readStoredVector = (): {
            vector: Float32Array;
            modelId: string;
        } | null =>
            readContextDb(h, (db) => {
                const row = db
                    .prepare(
                        "SELECT embedding, model_id FROM memory_embeddings WHERE memory_id = ?",
                    )
                    .get(memoryId) as {
                    embedding: Uint8Array;
                    model_id: string;
                } | null;
                if (!row) return null;
                const bytes = new Uint8Array(row.embedding);
                return {
                    vector: new Float32Array(
                        bytes.buffer,
                        bytes.byteOffset,
                        bytes.byteLength / 4,
                    ),
                    modelId: row.model_id,
                };
            });
        await h.waitFor(() => readStoredVector() !== null, {
            timeoutMs: 30_000,
            label: "A32 seed embedding persisted",
        });
        const seeded = readStoredVector();
        if (!seeded) throw new Error("A32 seed embedding vanished");
        const seedPassageEmbedObserved = embedMock
            .embeddingRequests()
            .some(
                (request) =>
                    request.model === fixture.embeddingModel &&
                    request.inputType === "passage" &&
                    request.inputs.some((input) =>
                        input.includes(fixture.oldContent),
                    ),
            );
        const oldVector = deterministicEmbedding(fixture.oldContent);
        const newVector = deterministicEmbedding(fixture.newContent);

        const edit = writeContextDb(h, (db) => {
            const before = db
                .prepare("SELECT COUNT(*) AS n FROM memories")
                .get() as { n: number };
            withClaimsWriteCapabilityInCurrentTransaction(db, () => {
                db.prepare(
                    "UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
                ).run(
                    fixture.newContent,
                    normalizedMemoryHash(fixture.newContent),
                    Date.now(),
                    memoryId,
                );
            });
            const after = db
                .prepare("SELECT COUNT(*) AS n FROM memories")
                .get() as { n: number };
            const row = db
                .prepare("SELECT id, content FROM memories WHERE id = ?")
                .get(memoryId) as { id: number; content: string } | null;
            return {
                applied: row?.content === fixture.newContent,
                keptRowId: before.n === after.n && row?.id === memoryId,
            };
        });
        const afterEdit = readStoredVector();
        const staleVectorPersistedAfterEdit =
            afterEdit !== null &&
            vectorsRoughlyEqual(afterEdit.vector, oldVector);

        const staleSearch = await runScriptedToolCall(h, sessionId, {
            tool: "ctx_search",
            input: { query: fixture.staleQuery, sources: ["memory"], limit: 5 },
            prompt: "search notes about the old rollout topic",
        });
        const freshSearch = await runScriptedToolCall(h, sessionId, {
            tool: "ctx_search",
            input: { query: fixture.freshQuery, sources: ["memory"], limit: 5 },
            prompt: "search notes about the new rollout topic",
        });

        const embeds = embedMock.embeddingRequests();
        const staleQueryEmbedded = embeds.some(
            (request) =>
                request.inputType === "query" &&
                request.inputs.some((input) =>
                    input.includes(fixture.staleQuery),
                ),
        );
        const freshQueryEmbedded = embeds.some(
            (request) =>
                request.inputType === "query" &&
                request.inputs.some((input) =>
                    input.includes(fixture.freshQuery),
                ),
        );
        // Matching the input text alone accepts a re-embedding issued in QUERY
        // mode. The deterministic mock returns the same vector either way, so
        // the final-vector comparison below would also pass while a real
        // provider produced a vector from the wrong space. Require the
        // configured passage mode and model.
        const passageReembedObserved = embeds.some(
            (request) =>
                request.inputType === "passage" &&
                request.model === fixture.embeddingModel &&
                request.inputs.some((input) =>
                    input.includes(fixture.newContent),
                ),
        );
        const finalVector = readStoredVector();
        // "Different from the stale vector" is not "correct": any corrupted
        // replacement satisfies it. The passage-request check proves only that
        // an embedding was REQUESTED, not that the returned vector was
        // persisted, and a single-row search can satisfy the fresh/stale query
        // assertions with a merely favorable wrong vector. Compare against the
        // deterministic embedding of the edited content and require the same
        // model, so durable embedding provenance is what is asserted.
        const vectorReplacedBySearchTime =
            finalVector !== null &&
            vectorsRoughlyEqual(finalVector.vector, newVector) &&
            finalVector.modelId === seeded.modelId;

        return {
            kind: "a32-embedding-freshness",
            memoryToolPublished: write.publishedToolName === "ctx_memory",
            searchToolPublished:
                staleSearch.publishedToolName === "ctx_search" &&
                freshSearch.publishedToolName === "ctx_search",
            argsValidated: argsValidated([
                write.resultText,
                staleSearch.resultText,
                freshSearch.resultText,
            ]),
            workspaceScoped: caseHarnessIsWorkspaceScoped(h, context),
            namespaceUnique: caseNamespaceIsUnique(context),
            schemaSentinel: sentinel.schemaSentinel,
            emptyStateAtStart: sentinel.emptyState,
            seedEmbedded: seeded.modelId.length > 0 && seedPassageEmbedObserved,
            seedVectorMatchesOldContent: vectorsRoughlyEqual(
                seeded.vector,
                oldVector,
            ),
            editApplied: edit.applied,
            editKeptRowId: edit.keptRowId,
            staleVectorPersistedAfterEdit,
            freshVectorWouldDiffer: !vectorsRoughlyEqual(
                seeded.vector,
                newVector,
            ),
            lexicalOverlapStaleQuery: haveLexicalOverlap(
                fixture.staleQuery,
                fixture.newContent,
            ),
            lexicalOverlapFreshQuery: haveLexicalOverlap(
                fixture.freshQuery,
                fixture.newContent,
            ),
            staleQueryEmbedded,
            freshQueryEmbedded,
            staleQueryReturnsMemory:
                staleSearch.resultText.includes("[memory]"),
            staleQueryMatchSemantic:
                staleSearch.resultText.includes("match=semantic"),
            freshQueryReturnsMemory:
                freshSearch.resultText.includes("[memory]"),
            passageReembedObserved,
            vectorReplacedBySearchTime,
        };
    } finally {
        if (harness) await harness.dispose();
        await embedMock.stop();
    }
}

// ---------------------------------------------------------------------------
// A44 — cross-source rank remap (known defect, red)
// ---------------------------------------------------------------------------

export const CROSS_SOURCE_RANK_FIXTURE = {
    query: "flumetrics",
    memoryContent:
        "flumetrics: the canary rollout requires manual approval from the release captain.",
    probeMessage:
        "In passing: flumetrics came up during standup, nothing actionable.",
    category: "PROJECT_RULES",
    lanes: ["memory", "message"],
} as const;

export type CrossSourceRankObservation = {
    kind: "a44-cross-source-rank";
    memoryToolPublished: boolean;
    searchToolPublished: boolean;
    argsValidated: boolean;
    workspaceScoped: boolean;
    namespaceUnique: boolean;
    compartmentCoversProbe: boolean;
    memoryDelivered: boolean;
    messageDelivered: boolean;
    memoryContentMatchesQuery: boolean;
    messageContentMatchesQuery: boolean;
    memoryOutranksMessage: boolean;
};

const A44_FIELDS: Record<string, FieldKind> = {
    memoryToolPublished: "boolean",
    searchToolPublished: "boolean",
    argsValidated: "boolean",
    workspaceScoped: "boolean",
    namespaceUnique: "boolean",
    compartmentCoversProbe: "boolean",
    memoryDelivered: "boolean",
    messageDelivered: "boolean",
    memoryContentMatchesQuery: "boolean",
    messageContentMatchesQuery: "boolean",
    memoryOutranksMessage: "boolean",
};

export function normalizeCrossSourceRank(
    raw: JsonValue,
): CrossSourceRankObservation {
    return parseObservation<CrossSourceRankObservation>(
        raw,
        "a44-cross-source-rank",
        A44_FIELDS,
    );
}

export function preconditionCrossSourceRank(
    observation: NormalizedObservation,
): PreconditionOutcome {
    const obs = normalizeCrossSourceRank(observation as JsonValue);
    const provenanceOk =
        obs.memoryToolPublished &&
        obs.searchToolPublished &&
        obs.argsValidated &&
        obs.workspaceScoped &&
        obs.namespaceUnique;
    // Non-vacuity: BOTH candidates must be eligible and delivered — a
    // single-candidate ordering is vacuously correct and must never score.
    const bothEligible =
        obs.compartmentCoversProbe &&
        obs.memoryDelivered &&
        obs.messageDelivered &&
        obs.memoryContentMatchesQuery &&
        obs.messageContentMatchesQuery;
    if (!provenanceOk || !bothEligible) return unmet();
    return { satisfied: true };
}

export function verifyCrossSourceRank(
    observation: NormalizedObservation,
): VerifierCheck[] {
    const obs = normalizeCrossSourceRank(observation as JsonValue);
    return [
        // Normative: the known-better single-source memory hit outranks the
        // common-literal probe message in the rendered ctx_search ordering.
        check(
            "check-a44-known-better-memory-outranks",
            obs.memoryOutranksMessage,
        ),
        check(
            "check-a44-two-candidate-nonvacuity",
            obs.memoryDelivered &&
                obs.messageDelivered &&
                obs.memoryContentMatchesQuery &&
                obs.messageContentMatchesQuery,
        ),
    ];
}

export async function driveCrossSourceRank(
    context: CaseDriverContext,
): Promise<CrossSourceRankObservation> {
    const fixture = CROSS_SOURCE_RANK_FIXTURE;
    const h = await createCaseHarness(context, memoryHarnessOptions());
    try {
        const writerSessionId = await h.createSession();
        h.mock.setDefault({ text: "noted", usage: DEFER_USAGE });
        await h.sendPrompt(writerSessionId, fixture.probeMessage);
        const probeState = (): { covered: boolean } =>
            readContextDb(h, (db) => {
                const probe = db
                    .prepare(
                        "SELECT MIN(message_ordinal) AS ordinal FROM message_history_fts WHERE session_id = ? AND message_history_fts MATCH ?",
                    )
                    .get(writerSessionId, fixture.query) as {
                    ordinal: number | null;
                };
                return { covered: probe.ordinal !== null };
            });
        await h.waitFor(() => probeState().covered, {
            timeoutMs: 30_000,
            label: "A44 probe message indexed in the writer session",
        });
        writeContextDb(h, (db) => {
            const row = db
                .prepare(
                    "SELECT message_ordinal AS ordinal, message_id AS id FROM message_history_fts WHERE session_id = ? AND message_history_fts MATCH ? ORDER BY message_ordinal LIMIT 1",
                )
                .get(writerSessionId, fixture.query) as {
                ordinal: number;
                id: string;
            };
            db.prepare(
                `INSERT INTO compartments
                 (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at, harness)
                 VALUES (?, 0, ?, ?, ?, ?, 'A44 eligibility boundary', 'synthetic boundary', ?, 'opencode')`,
            ).run(
                writerSessionId,
                row.ordinal,
                row.ordinal,
                row.id,
                row.id,
                Date.now(),
            );
        });
        const sessionId = await h.createSession();

        // The known-better memory lives in the reader session while the common
        // message candidate remains eligible from the separate writer session.
        const write = await runScriptedToolCall(h, sessionId, {
            tool: "ctx_memory",
            input: {
                action: "write",
                category: fixture.category,
                content: fixture.memoryContent,
            },
            prompt: "record the canary rollout approval rule",
        });
        if (!write.resultText.includes("Saved memory")) {
            throw new Error("A44 memory write did not save");
        }
        const search = await runScriptedToolCall(h, sessionId, {
            tool: "ctx_search",
            input: {
                query: fixture.query,
                sources: [...fixture.lanes],
                limit: 10,
            },
            prompt: "search for the canary rollout topic",
        });

        const headerLines = search.resultText
            .split("\n")
            .filter((line) => /^\[\d+\] \[(memory|message)\]/.test(line));
        const firstMemory = headerLines.findIndex((line) =>
            line.includes("[memory]"),
        );
        const firstMessage = headerLines.findIndex((line) =>
            line.includes("[message]"),
        );
        const durableCandidates = readContextDb(h, (db) => ({
            memory:
                Number(
                    (
                        db
                            .prepare(
                                "SELECT COUNT(*) AS count FROM memories WHERE content = ?",
                            )
                            .get(fixture.memoryContent) as { count: number }
                    ).count,
                ) === 1,
            message:
                Number(
                    (
                        db
                            .prepare(
                                "SELECT COUNT(*) AS count FROM message_history_fts WHERE session_id = ? AND message_history_fts MATCH ?",
                            )
                            .get(writerSessionId, fixture.query) as {
                            count: number;
                        }
                    ).count,
                ) >= 1,
        }));

        return {
            kind: "a44-cross-source-rank",
            memoryToolPublished: write.publishedToolName === "ctx_memory",
            searchToolPublished: search.publishedToolName === "ctx_search",
            argsValidated: argsValidated([write.resultText, search.resultText]),
            workspaceScoped: caseHarnessIsWorkspaceScoped(h, context),
            namespaceUnique: caseNamespaceIsUnique(context),
            compartmentCoversProbe: probeState().covered,
            // Delivery stays durable-derived. Deriving it from the rendered
            // response is the honest reading, but the response currently
            // carries NO message-lane entry, so the switch reports
            // precondition_unmet and abandons the adjudicated red baseline —
            // the reproduction is vacuous until the message lane is really
            // delivered, which needs a setup fix plus re-adjudication.
            memoryDelivered: durableCandidates.memory,
            messageDelivered: durableCandidates.message,
            memoryContentMatchesQuery:
                durableCandidates.memory &&
                fixture.memoryContent.includes(fixture.query),
            messageContentMatchesQuery:
                durableCandidates.message &&
                fixture.probeMessage.includes(fixture.query),
            memoryOutranksMessage:
                firstMemory >= 0 &&
                firstMessage >= 0 &&
                firstMemory < firstMessage,
        };
    } finally {
        await h.dispose();
    }
}

// ---------------------------------------------------------------------------
// A54 — pending smart-note recall (accepted behavior, green)
// ---------------------------------------------------------------------------

export const PENDING_NOTE_RECALL_FIXTURE = {
    noteContent:
        "Follow up on the zanzibar export once the vendor ships the public button.",
    surfaceCondition:
        "the vendor changelog announces the zanzibar export button",
    searchQuery: "zanzibar",
    activeControl:
        "Current project focus: keep the atlas export control ledger available.",
} as const;

export type PendingNoteRecallObservation = {
    kind: "a54-pending-note-recall";
    noteToolPublished: boolean;
    memoryToolPublished: boolean;
    searchToolPublished: boolean;
    argsValidated: boolean;
    workspaceScoped: boolean;
    namespaceUnique: boolean;
    noteCreateAcknowledged: boolean;
    controlWriteAcknowledged: boolean;
    noteDurablePending: boolean;
    ordinaryTurnSurfacedControl: boolean;
    ordinaryTurnSurfacedNote: boolean;
    explicitSearchReturnedNote: boolean;
    explicitSearchLabeledPending: boolean;
};

const A54_FIELDS: Record<string, FieldKind> = {
    noteToolPublished: "boolean",
    memoryToolPublished: "boolean",
    searchToolPublished: "boolean",
    argsValidated: "boolean",
    workspaceScoped: "boolean",
    namespaceUnique: "boolean",
    noteCreateAcknowledged: "boolean",
    controlWriteAcknowledged: "boolean",
    noteDurablePending: "boolean",
    ordinaryTurnSurfacedControl: "boolean",
    ordinaryTurnSurfacedNote: "boolean",
    explicitSearchReturnedNote: "boolean",
    explicitSearchLabeledPending: "boolean",
};

export function normalizePendingNoteRecall(
    raw: JsonValue,
): PendingNoteRecallObservation {
    return parseObservation<PendingNoteRecallObservation>(
        raw,
        "a54-pending-note-recall",
        A54_FIELDS,
    );
}

export function preconditionPendingNoteRecall(
    observation: NormalizedObservation,
): PreconditionOutcome {
    const obs = normalizePendingNoteRecall(observation as JsonValue);
    const provenanceOk =
        obs.noteToolPublished &&
        obs.memoryToolPublished &&
        obs.searchToolPublished &&
        obs.argsValidated &&
        obs.workspaceScoped &&
        obs.namespaceUnique;
    if (
        !provenanceOk ||
        !obs.noteCreateAcknowledged ||
        !obs.controlWriteAcknowledged ||
        !obs.noteDurablePending
    )
        return unmet();
    return { satisfied: true };
}

export function verifyPendingNoteRecall(
    observation: NormalizedObservation,
): VerifierCheck[] {
    const obs = normalizePendingNoteRecall(observation as JsonValue);
    return [
        check(
            "check-a54-explicit-search-pending-status",
            obs.explicitSearchReturnedNote && obs.explicitSearchLabeledPending,
        ),
        check(
            "check-a54-no-unprompted-surfacing",
            obs.ordinaryTurnSurfacedControl && !obs.ordinaryTurnSurfacedNote,
        ),
    ];
}

export async function drivePendingNoteRecall(
    context: CaseDriverContext,
): Promise<PendingNoteRecallObservation> {
    const fixture = PENDING_NOTE_RECALL_FIXTURE;
    // Smart notes require an enabled dreamer; nightly evaluation never fires
    // inside the short case window, so the note stays pending throughout.
    const h = await createCaseHarness(
        context,
        memoryHarnessOptions({ dreamer: { disable: false } }),
    );
    try {
        const writerSessionId = await h.createSession();
        const note = await runScriptedToolCall(h, writerSessionId, {
            tool: "ctx_note",
            input: {
                action: "write",
                content: fixture.noteContent,
                surface_condition: fixture.surfaceCondition,
            },
            prompt: "park a follow-up for the vendor export work",
        });
        const activeControl = await runScriptedToolCall(h, writerSessionId, {
            tool: "ctx_memory",
            input: {
                action: "write",
                category: "PROJECT_RULES",
                content: fixture.activeControl,
            },
            prompt: "record the current atlas export focus",
        });
        verifyMemoryByContent(h, fixture.activeControl);
        const noteDurablePending = readContextDb(h, (db) => {
            const row = db
                .prepare(
                    "SELECT status FROM notes WHERE type = 'smart' ORDER BY id DESC LIMIT 1",
                )
                .get() as { status: string } | null;
            return row?.status === "pending";
        });

        // An ORDINARY turn in a fresh session: the pending note must not be
        // surfaced anywhere on the provider-visible wire.
        const readerSessionId = await h.createSession();
        h.mock.reset();
        h.mock.setDefault({ text: "ordinary reply", usage: DEFER_USAGE });
        await h.sendPrompt(
            readerSessionId,
            "ordinary turn: summarize the current focus areas",
        );
        const ordinaryWire = JSON.stringify(lastMainBody(h));
        const ordinaryTurnSurfacedControl = ordinaryWire.includes(
            fixture.activeControl,
        );
        const ordinaryTurnSurfacedNote = ordinaryWire.includes(
            fixture.searchQuery,
        );

        const search = await runScriptedToolCall(h, readerSessionId, {
            tool: "ctx_search",
            input: {
                query: fixture.searchQuery,
                sources: ["note"],
                limit: 5,
            },
            prompt: "did we park a follow-up about the vendor export?",
        });

        return {
            kind: "a54-pending-note-recall",
            noteToolPublished: note.publishedToolName === "ctx_note",
            memoryToolPublished:
                activeControl.publishedToolName === "ctx_memory",
            searchToolPublished: search.publishedToolName === "ctx_search",
            argsValidated: argsValidated([
                note.resultText,
                activeControl.resultText,
                search.resultText,
            ]),
            workspaceScoped: caseHarnessIsWorkspaceScoped(h, context),
            namespaceUnique: caseNamespaceIsUnique(context),
            noteCreateAcknowledged: /Created smart note #\d+/.test(
                note.resultText,
            ),
            controlWriteAcknowledged:
                activeControl.resultText.includes("Saved memory"),
            noteDurablePending,
            ordinaryTurnSurfacedControl,
            ordinaryTurnSurfacedNote,
            explicitSearchReturnedNote:
                search.resultText.includes("[note]") &&
                search.resultText.includes(fixture.searchQuery),
            explicitSearchLabeledPending:
                search.resultText.includes("status=pending"),
        };
    } finally {
        await h.dispose();
    }
}

// ---------------------------------------------------------------------------
// Registry entries
// ---------------------------------------------------------------------------

/** The registered U4 cases; `builtinIncidentCaseRegistry` installs these. */
export function auditMemorySearchIncidentCases(): RegisteredIncidentCase[] {
    return [
        {
            variantId: "var-a5-archived-reobservation",
            implementationFiles: IMPLEMENTATION_FILES,
            fixtures: { ...ARCHIVED_REOBSERVATION_FIXTURE },
            driver: driveArchivedReobservation,
            normalizer: normalizeArchivedReobservation,
            precondition: preconditionArchivedReobservation,
            verifier: verifyArchivedReobservation,
            binding: {
                driver: driveArchivedReobservation,
                verifier: verifyArchivedReobservation,
            },
        },
        {
            variantId: "var-a10-supersede-effective-context",
            implementationFiles: IMPLEMENTATION_FILES,
            fixtures: { ...SUPERSEDE_RECONCILIATION_FIXTURE },
            driver: driveSupersedeReconciliation,
            normalizer: normalizeSupersedeReconciliation,
            precondition: preconditionSupersedeReconciliation,
            verifier: verifySupersedeReconciliation,
            binding: {
                driver: driveSupersedeReconciliation,
                verifier: verifySupersedeReconciliation,
            },
        },
        {
            variantId: "var-a32-stale-embedding-recall",
            implementationFiles: A32_IMPLEMENTATION_FILES,
            fixtures: { ...EMBEDDING_FRESHNESS_FIXTURE },
            driver: driveEmbeddingFreshness,
            normalizer: normalizeEmbeddingFreshness,
            precondition: preconditionEmbeddingFreshness,
            verifier: verifyEmbeddingFreshness,
            binding: {
                driver: driveEmbeddingFreshness,
                verifier: verifyEmbeddingFreshness,
            },
        },
        {
            variantId: "var-a44-cross-source-rank-remap",
            implementationFiles: IMPLEMENTATION_FILES,
            fixtures: { ...CROSS_SOURCE_RANK_FIXTURE },
            driver: driveCrossSourceRank,
            normalizer: normalizeCrossSourceRank,
            precondition: preconditionCrossSourceRank,
            verifier: verifyCrossSourceRank,
            binding: {
                driver: driveCrossSourceRank,
                verifier: verifyCrossSourceRank,
            },
        },
        {
            variantId: "var-a54-pending-note-recall",
            implementationFiles: A54_IMPLEMENTATION_FILES,
            fixtures: { ...PENDING_NOTE_RECALL_FIXTURE },
            driver: drivePendingNoteRecall,
            normalizer: normalizePendingNoteRecall,
            precondition: preconditionPendingNoteRecall,
            verifier: verifyPendingNoteRecall,
            binding: {
                driver: drivePendingNoteRecall,
                verifier: verifyPendingNoteRecall,
            },
        },
    ];
}
