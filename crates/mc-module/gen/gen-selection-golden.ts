/**
 * This script generates a differential selection golden for mc-module.
 *
 * The generator records whether each tool is dropped or receives `edit_marker`.
 * The generator emits equivalent `SelItem[]` tails and expected arc-level decisions.
 * The Rust `selection_golden` test runs `select_reductions` on the generated tail.
 * The test projects per-block output to arc-level decisions.
 * The test compares projected arc-level decisions with the expected decisions.
 *
 *
 * Each TS tool tag maps to one CK arc; `tag.byteSize` maps to ToolResult bytes.
 * The generator maps `tag.inputByteSize` to ToolCall bytes and `tag.reasoningByteSize` to a Reasoning block.
 * `n` maps the tag number to the block ordinal used as the age key.
 * The generator assigns ToolCall, ToolResult, and Reasoning IDs as `${id}#0`, `${id}#1`, and `${id}#2`.
 * The generator sets `arc_id` to the paired ToolCall FlatBlock id.
 * the arc's reclaim bytes (call+result+reasoning) == the TS tagReclaimBytes exactly.
 *
 * The generator runs with `bun crates/mc-module/gen/gen-selection-golden.ts`.
 * The command resolves TypeScript selectors from `packages/plugin`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const resolve = (m: string) => Bun.resolveSync(m, pluginDir);

const storage = await import(resolve("./src/features/magic-context/storage"));
const supersession = await import(resolve("./src/hooks/magic-context/supersession-reclaim"));
const toolReclaim = await import(resolve("./src/hooks/magic-context/tool-reclaim"));
const emergency = await import(resolve("./src/hooks/magic-context/emergency-drop"));

const { openDatabase, closeDatabase, insertTag } = storage as {
    openDatabase: () => unknown;
    closeDatabase: () => void;
    insertTag: (...a: unknown[]) => number;
};


interface TagFixture {
    /** The generator derives the ToolCall id and `arc_id` from `id` as `${id}#0`. */
    id: string;
    toolName: string;
    /** `n` maps the tag number to the block ordinal used as the age key. */
    n: number;
    /** `byteSize` provides ToolResult output bytes. */
    byteSize: number;
    /** Undefined omits the persisted ToolResult token estimate. */
    tokenCount?: number;
    /** `inputByteSize` provides ToolCall input bytes. */
    inputByteSize?: number;
    /* */
    inputTokenCount?: number;
    /** A `reasoningByteSize` of `0` omits the Reasoning block. */
    reasoningByteSize?: number;
    /** `input` supplies ToolCall JSON fields such as `filePath`, `action`, diffs, and edit content. */
    input?: Record<string, unknown>;
    /** `providerExecuted` prevents selectors from targeting this arc's blocks. */
    providerExecuted?: boolean;
}

type SelectorKind = "supersession" | "edit" | "two_pass" | "emergency";

interface CaseSpec {
    label: string;
    selector: SelectorKind;
    tags: TagFixture[];
    /** passClass sets the Rust context pass class. */
    passClass: "Execute" | "EmergencyForce";
    smartDrops: boolean;
    /** lastExecuteOrdinal sets the two_pass watermark ordinal. */
    lastExecuteOrdinal?: number;
    /** emergency inputs. */
    emergency?: {
        currentTotalInputTokens: number;
        ceilingTokens: number;
        protectedTags: number;
        priorInputSample?: number;
        hasPriorDrop?: boolean;
    };
    /** frozen excludes the listed FlatBlock IDs, such as "c2#1". */
    frozen?: string[];
}


interface SelItemJson {
    id: string;
    ordinal: number;
    kind: Record<string, unknown>;
    provider_executed: boolean;
    byte_size: number;
    token_count: number | null;
    arc_id: string | null;
}

interface GoldenCase {
    label: string;
    items: SelItemJson[];
    ctx: Record<string, unknown>;
    smart_drops: boolean;
    frozen: string[];
    /** `arc_id` maps each arc to the TS selector's `drop` or `edit_marker` decision. */
    expected: Record<string, string>;
}

/** `readInput` exposes a droppable target's input, including `ctx_note` action and `filePath`. */
function makeTarget(input: Record<string, unknown> | undefined) {
    return {
        setContent: () => true,
        drop: () => "removed",
        truncate: () => "truncated",
        editMarker: () => "truncated",
        canDrop: () => true,
        readInput: () => input ?? null,
    };
}

function callBlockId(arcId: string): string {
    return `${arcId}#0`;
}

function resultBlockId(arcId: string): string {
    return `${arcId}#1`;
}

function reasoningBlockId(arcId: string): string {
    return `${arcId}#2`;
}

function remapLegacyBlockId(id: string): string {
    if (id.endsWith("#call")) return `${id.slice(0, -"#call".length)}#0`;
    if (id.endsWith("#result")) return `${id.slice(0, -"#result".length)}#1`;
    if (id.endsWith("#reasoning")) return `${id.slice(0, -"#reasoning".length)}#2`;
    return id;
}

function remapExpectedArcs(expected: Record<string, string>): Record<string, string> {
    const remapped: Record<string, string> = {};
    for (const [legacyArc, kind] of Object.entries(expected)) {
        remapped[callBlockId(legacyArc)] = kind;
    }
    return remapped;
}

function assertDecisionSetIdentity(
    label: string,
    legacy: Record<string, string>,
    remapped: Record<string, string>,
) {
    for (const [legacyArc, kind] of Object.entries(legacy)) {
        const flatArc = callBlockId(legacyArc);
        if (remapped[flatArc] !== kind) {
            throw new Error(`${label}: remap changed decision for ${legacyArc} → ${flatArc}`);
        }
    }
    if (Object.keys(legacy).length !== Object.keys(remapped).length) {
        throw new Error(`${label}: remap changed decision count`);
    }
    if (Object.keys(legacy).length > 0 && JSON.stringify(legacy) === JSON.stringify(remapped)) {
        throw new Error(`${label}: remap was vacuous; arc ids did not change to FlatBlock ids`);
    }
}

/* */
function buildItems(tags: TagFixture[]): SelItemJson[] {
    const items: SelItemJson[] = [];
    for (const t of tags) {
        const providerExecuted = t.providerExecuted ?? false;
        // ToolCall block
        items.push({
            id: callBlockId(t.id),
            ordinal: t.n,
            kind: { ToolCall: { name: t.toolName, input: t.input ?? {} } },
            provider_executed: providerExecuted,
            byte_size: t.inputByteSize ?? 0,
            token_count: null,
            arc_id: callBlockId(t.id),
        });
        // ToolResult block
        const reclaimableTokens =
            t.tokenCount === undefined && t.inputTokenCount === undefined
                ? null
                : (t.tokenCount ?? 0) + (t.inputTokenCount ?? 0);
        items.push({
            id: resultBlockId(t.id),
            ordinal: t.n,
            kind: { ToolResult: { tool_name: t.toolName } },
            provider_executed: providerExecuted,
            byte_size: t.byteSize,
            token_count: reclaimableTokens,
            arc_id: callBlockId(t.id),
        });
        if ((t.reasoningByteSize ?? 0) > 0) {
            items.push({
                id: reasoningBlockId(t.id),
                ordinal: t.n,
                kind: "Reasoning",
                provider_executed: false,
                byte_size: t.reasoningByteSize ?? 0,
                token_count: null,
                arc_id: callBlockId(t.id),
            });
        }
    }
    return items;
}

/* */
function runTsSelector(spec: CaseSpec): Record<string, string> {
    const expected: Record<string, string> = {};
    const targets = new Map<number, ReturnType<typeof makeTarget>>();
    const tagNumberToArc = new Map<number, string>();

    if (spec.selector === "emergency") {
        const tags = spec.tags.map((t) => ({
            tagNumber: t.n,
            type: "tool" as const,
            status: "active" as const,
            toolName: t.toolName,
            byteSize: t.byteSize,
            inputByteSize: t.inputByteSize ?? 0,
            reasoningByteSize: t.reasoningByteSize ?? 0,
        }));
        for (const t of spec.tags) tagNumberToArc.set(t.n, t.id);
        const maxTag = Math.max(...spec.tags.map((t) => t.n));
        const em = spec.emergency ?? { currentTotalInputTokens: 0, ceilingTokens: 0, protectedTags: 0 };
        const plan = emergency.planEmergencyDrop({
            tags,
            floorTags: tags,
            maxTag,
            protectedTags: em.protectedTags,
            currentTotalInputTokens: em.currentTotalInputTokens,
            ceilingTokens: em.ceilingTokens,
            priorInputSample: em.priorInputSample ?? 0,
            hasPriorDrop: em.hasPriorDrop ?? false,
        });
        for (const tagNum of plan.tagNumbers) {
            const arc = tagNumberToArc.get(tagNum);
            if (arc) expected[arc] = "drop";
        }
        return expected;
    }

    // Tests for DB-backed selectors seed an isolated database.
    process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "sel-golden-"));
    const db = openDatabase();
    if (!db) throw new Error("db open failed");
    const SES = "ses-golden";
    try {
        for (const t of spec.tags) {
            insertTag(
                db,
                SES,
                t.id,
                "tool",
                t.byteSize,
                t.n,
                t.reasoningByteSize ?? 0,
                t.toolName,
                t.inputByteSize ?? 0,
                null,
                null,
                t.tokenCount === undefined && t.inputTokenCount === undefined
                    ? null
                    : {
                          tokenCount: t.tokenCount ?? 0,
                          inputTokenCount: t.inputTokenCount ?? 0,
                          reasoningTokenCount: 0,
                      },
            );
            targets.set(t.n, makeTarget(t.input));
            tagNumberToArc.set(t.n, t.id);
        }

        if (spec.selector === "supersession") {
            const ops = supersession.buildSupersessionReclaimOps({ db, sessionId: SES, targets });
            for (const op of ops) {
                const arc = tagNumberToArc.get(op.tagId);
                if (arc) expected[arc] = "drop";
            }
        } else if (spec.selector === "edit") {
            const res = supersession.buildEditSupersessionReclaim({ db, sessionId: SES, targets });
            for (const op of res.ops) {
                const arc = tagNumberToArc.get(op.tagId);
                if (arc) expected[arc] = "edit_marker";
            }
        } else if (spec.selector === "two_pass") {
            const ops = toolReclaim.buildSyntheticToolReclaimOps({
                db,
                sessionId: SES,
                targets,
                watermark: spec.lastExecuteOrdinal ?? 0,
            });
            for (const op of ops) {
                const arc = tagNumberToArc.get(op.tagId);
                if (arc) expected[arc] = "drop";
            }
        }
    } finally {
        closeDatabase();
    }
    return expected;
}

function buildCtx(spec: CaseSpec): Record<string, unknown> {
    const maxN = spec.tags.length ? Math.max(...spec.tags.map((t) => t.n)) : 0;
    const em = spec.emergency;
    return {
        pass_class: spec.passClass,
        current_total_input_tokens: em?.currentTotalInputTokens ?? 0,
        ceiling_tokens: em?.ceilingTokens ?? 0,
        // protected tail cutoff = maxTag − protectedTags (ordinal space == tag space).
        protected_cutoff_ordinal: em ? Math.max(maxN - em.protectedTags, 0) : 0,
        last_execute_ordinal: spec.lastExecuteOrdinal ?? 0,
        scheduler_pressure_execute: spec.passClass === "Execute",
        pass_already_busting: spec.selector === "two_pass",
        prior_input_sample: em?.priorInputSample ?? 0,
        has_prior_drop: em?.hasPriorDrop ?? false,
        agent_drop_ids: [],
    };
}


const cases: CaseSpec[] = [
    {
        label: "supersession: todowrite keep-1",
        selector: "supersession",
        smartDrops: true,
        passClass: "Execute",
        tags: [
            { id: "c1", toolName: "todowrite", n: 1, byteSize: 100 },
            { id: "c2", toolName: "todowrite", n: 2, byteSize: 100 },
            { id: "c3", toolName: "todowrite", n: 3, byteSize: 100 },
        ],
    },
    {
        label: "supersession: ctx_reduce keep-3 exemplars",
        selector: "supersession",
        smartDrops: true,
        passClass: "Execute",
        tags: Array.from({ length: 5 }, (_, i) => ({
            id: `c${i + 1}`,
            toolName: "ctx_reduce",
            n: i + 1,
            byteSize: 40,
        })),
    },
    {
        label: "supersession: zero-value meta drop-all",
        selector: "supersession",
        smartDrops: true,
        passClass: "Execute",
        tags: [
            { id: "c1", toolName: "bash_status", n: 1, byteSize: 30 },
            { id: "c2", toolName: "bash_kill", n: 2, byteSize: 30 },
            { id: "c3", toolName: "bash", n: 3, byteSize: 30 },
        ],
    },
    {
        label: "supersession: ctx_note read+dismiss drop, write keep",
        selector: "supersession",
        smartDrops: true,
        passClass: "Execute",
        tags: [
            { id: "c1", toolName: "ctx_note", n: 1, byteSize: 50, input: { action: "read" } },
            { id: "c2", toolName: "ctx_note", n: 2, byteSize: 50, input: { action: "dismiss" } },
            { id: "c3", toolName: "ctx_note", n: 3, byteSize: 50, input: { action: "write", content: "x" } },
        ],
    },
    {
        label: "edit: older-per-file → edit_marker, newest full",
        selector: "edit",
        smartDrops: true,
        passClass: "Execute",
        tags: [
            { id: "c1", toolName: "edit", n: 1, byteSize: 500, input: { filePath: "a.ts", oldString: "x".repeat(80), newString: "y".repeat(80) } },
            { id: "c2", toolName: "edit", n: 2, byteSize: 500, input: { filePath: "a.ts", oldString: "p".repeat(80), newString: "q".repeat(80) } },
            { id: "c3", toolName: "write", n: 3, byteSize: 500, input: { filePath: "b.ts", content: "z".repeat(80) } },
        ],
    },
    {
        label: "edit: no filePath → skip (fail-safe)",
        selector: "edit",
        smartDrops: true,
        passClass: "Execute",
        tags: [
            { id: "c1", toolName: "edit", n: 1, byteSize: 500, input: { oldString: "x", newString: "y" } },
            { id: "c2", toolName: "edit", n: 2, byteSize: 500, input: { oldString: "p", newString: "q" } },
        ],
    },
    {
        label: "two_pass: drop tools at/under watermark",
        selector: "two_pass",
        smartDrops: false,
        passClass: "Execute",
        lastExecuteOrdinal: 3,
        tags: [
            { id: "c1", toolName: "bash", n: 1, byteSize: 200 },
            { id: "c2", toolName: "read", n: 2, byteSize: 200 },
            { id: "c3", toolName: "grep", n: 3, byteSize: 200 },
            { id: "c4", toolName: "bash", n: 4, byteSize: 200 },
            { id: "c5", toolName: "edit", n: 5, byteSize: 200 },
        ],
    },
    {
        label: "two_pass: ctx_reduce keep-3 exemplars",
        selector: "two_pass",
        smartDrops: false,
        passClass: "Execute",
        lastExecuteOrdinal: 5,
        tags: Array.from({ length: 5 }, (_, i) => ({
            id: `c${i + 1}`,
            toolName: "ctx_reduce",
            n: i + 1,
            byteSize: 4_000,
            tokenCount: 1_000,
        })),
    },
    {
        label: "two_pass: skip sub-floor arcs",
        selector: "two_pass",
        smartDrops: false,
        passClass: "Execute",
        lastExecuteOrdinal: 2,
        tags: [
            { id: "c1", toolName: "bash", n: 1, byteSize: 2000, tokenCount: 249 },
            { id: "c2", toolName: "read", n: 2, byteSize: 2000, tokenCount: 250 },
        ],
    },
    {
        label: "two_pass: keep newest todowrite",
        selector: "two_pass",
        smartDrops: false,
        passClass: "Execute",
        lastExecuteOrdinal: 2,
        tags: [
            { id: "c1", toolName: "todowrite", n: 1, byteSize: 2000, tokenCount: 300 },
            { id: "c2", toolName: "todowrite", n: 2, byteSize: 2000, tokenCount: 300 },
        ],
    },
    {
        label: "emergency: tier order T3→T2→T1 to headroom",
        selector: "emergency",
        smartDrops: false,
        passClass: "EmergencyForce",
        emergency: { currentTotalInputTokens: 200000, ceilingTokens: 160000, protectedTags: 0 },
        tags: [
            { id: "c1", toolName: "read", n: 1, byteSize: 40000 },   // T1
            { id: "c2", toolName: "grep", n: 2, byteSize: 40000 },   // T2
            { id: "c3", toolName: "bash", n: 3, byteSize: 40000 },   // T3
            { id: "c4", toolName: "web", n: 4, byteSize: 40000 },    // T3
        ],
    },
    {
        label: "emergency: ctx_reduce keep-3 exemplars",
        selector: "emergency",
        smartDrops: false,
        passClass: "EmergencyForce",
        emergency: { currentTotalInputTokens: 6000, ceilingTokens: 1000, protectedTags: 0 },
        tags: Array.from({ length: 5 }, (_, i) => ({
            id: `c${i + 1}`,
            toolName: "ctx_reduce",
            n: i + 1,
            byteSize: 4_000,
        })),
    },
    {
        label: "emergency: protected tail excluded",
        selector: "emergency",
        smartDrops: false,
        passClass: "EmergencyForce",
        emergency: { currentTotalInputTokens: 200000, ceilingTokens: 160000, protectedTags: 2 },
        tags: [
            { id: "c1", toolName: "bash", n: 1, byteSize: 80000 },
            { id: "c2", toolName: "bash", n: 2, byteSize: 80000 },
            { id: "c3", toolName: "bash", n: 3, byteSize: 80000 },   // protected (n > max-2)
            { id: "c4", toolName: "bash", n: 4, byteSize: 80000 },   // protected
        ],
    },
    {
        label: "emergency: idempotence latch (same sample → noop)",
        selector: "emergency",
        smartDrops: false,
        passClass: "EmergencyForce",
        emergency: { currentTotalInputTokens: 200000, ceilingTokens: 160000, protectedTags: 0, priorInputSample: 200000, hasPriorDrop: true },
        tags: [{ id: "c1", toolName: "bash", n: 1, byteSize: 80000 }],
    },
    {
        // The emergency selector does not drop when reclaiming at most EMERGENCY_REARM_MIN tokens.
        label: "emergency: reclaim below min → noop",
        selector: "emergency",
        smartDrops: false,
        passClass: "EmergencyForce",
        emergency: { currentTotalInputTokens: 160500, ceilingTokens: 160000, protectedTags: 0 },
        tags: [{ id: "c1", toolName: "bash", n: 1, byteSize: 8000 }],
    },
];

const golden: GoldenCase[] = cases.map((spec) => {
    const legacyExpected = runTsSelector(spec);
    const expected = remapExpectedArcs(legacyExpected);
    assertDecisionSetIdentity(spec.label, legacyExpected, expected);
    return {
        label: spec.label,
        items: buildItems(spec.tags),
        ctx: buildCtx(spec),
        smart_drops: spec.smartDrops,
        frozen: (spec.frozen ?? []).map(remapLegacyBlockId),
        expected,
    };
});

const outPath = join(import.meta.dir, "..", "testdata", "selection-golden.json");
writeFileSync(outPath, `${JSON.stringify(golden, null, 2)}\n`);
const totalDecisions = golden.reduce((n, g) => n + Object.keys(g.expected).length, 0);
// eslint-disable-next-line no-console
console.log(`wrote ${golden.length} selection cases (${totalDecisions} arc decisions) → ${outPath}`);
