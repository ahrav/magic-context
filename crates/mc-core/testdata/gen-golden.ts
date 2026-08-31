/**
 * This script generates the decay-curve fixture for the Rust differential test.
 *
 * Production `decay-curve.ts` is the oracle for the Rust differential test.
 * The Rust `decay_golden_matches_reference` test asserts the generated tier, archive, rendered-tier, and budget-pressure cases.
 *
 *   bun crates/mc-core/testdata/gen-golden.ts
 *
 * Rust tests consume the committed `decay-golden.json` fixture.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    computeBudgetPressure,
    computeBudgetPressureTwoPass,
    renderedTier,
    shouldArchive,
    tier,
} from "../../../packages/plugin/src/hooks/magic-context/decay-curve.ts";
import {
    type DecayRenderCompartment,
    renderDecayedCompartments,
} from "../../../packages/plugin/src/hooks/magic-context/decay-render.ts";
import { mkdtempSync, rmSync, writeFileSync as writeDocFile } from "node:fs";
import { tmpdir } from "node:os";
import { readProjectDocsCanonical } from "../../../packages/plugin/src/features/magic-context/project-docs-hash.ts";
import { renderMemoryBlockV2 } from "../../../packages/plugin/src/hooks/magic-context/inject-compartments.ts";
import type { Memory } from "../../../packages/plugin/src/features/magic-context/memory/types.ts";

const indices = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 200, 400, 1000];
const importances = [1, 10, 25, 40, 50, 60, 75, 90, 100];
const pressures = [0.1, 0.25, 0.5, 1.0, 1.5, 2.0, 4.0, 8.0];

const tierCases = [];
for (const index of indices) {
    for (const importance of importances) {
        for (const pressure of pressures) {
            tierCases.push({
                index,
                importance,
                pressure,
                tier: tier(index, importance, pressure),
                archived: shouldArchive(index, importance, pressure, 0),
                rendered: renderedTier(index, importance, pressure, 0),
            });
        }
    }
}

const pools = [
    Array.from({ length: 50 }, () => 50),
    Array.from({ length: 200 }, (_, i) => (i % 100) + 1),
    Array.from({ length: 500 }, (_, i) => [10, 50, 90][i % 3]),
];
const budgets = [60000, 20000, 8000, 2000, 500];
const pressureCases = [];
for (const importancesPool of pools) {
    for (const budget of budgets) {
        const comps = importancesPool.map((imp, i) => ({ index: i + 1, importance: imp }));
        pressureCases.push({
            importances: importancesPool,
            budget,
            one_pass: computeBudgetPressure(comps, budget),
            two_pass: computeBudgetPressureTwoPass(comps, budget),
        });
    }
}

const out = join(import.meta.dir, "decay-golden.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ tier_cases: tierCases, pressure_cases: pressureCases }, null, 2)}\n`);
console.log(`wrote ${tierCases.length} tier cases + ${pressureCases.length} pressure cases → ${out}`);

// The Rust mc-module port consumes this decay-render fixture.
// The huge budget prevents the TS token-estimate demotion guard from firing.
// The Rust port treats the token-estimate demotion guard as a no-op, so the decay curve alone determines the output.
// Legacy and flat bodies use only ASCII.
// The fixtures cover P1–P4 paraphrase decay and archival.
// The fixtures cover XML-safe headings, escaped bodies, and title-only P4 headings.
// The fixtures cover legacy truncation and empty-P1 pseudo-V2 fallback.
const LOOSE = 10_000_000;
const v2 = (
    start: number,
    end: number,
    title: string,
    importance: number,
    bodies: [string, string, string, string],
): DecayRenderCompartment => ({
    startMessage: start,
    endMessage: end,
    title,
    content: "",
    p1: bodies[0],
    p2: bodies[1],
    p3: bodies[2],
    p4: bodies[3],
    importance,
    legacy: 0,
});

const renderCases: Array<{ compartments: DecayRenderCompartment[]; budget: number; body: string }> = [];
const pushRender = (compartments: DecayRenderCompartment[], budget = LOOSE) => {
    renderCases.push({ compartments, body: renderDecayedCompartments({ compartments, historyBudgetTokens: budget }), budget });
};

// The 30 V2 compartments make the curve demote the oldest paraphrases and archive the lowest-importance tail.
pushRender(
    Array.from({ length: 30 }, (_, i) =>
        v2(i * 10 + 1, i * 10 + 9, `arc ${i}`, [10, 50, 90][i % 3], [
            `P1 verbose body for compartment number ${i} with enough text to be distinct`,
            `P2 dense ${i}`,
            `P3 ${i}`,
            i % 4 === 0 ? "" : `P4anchor${i}`,
        ]),
    ),
);
// Historian-authored titles stay on one XML-safe heading line, including Unicode line and paragraph separators that would otherwise forge headings.
pushRender([
    v2(1, 2, 'safe\n## 999-999 · forged\r\nline\u2028## zl-forged\u2029## zp-forged\n</session-history> & "quoted"', 50, [
        "x < y & z",
        "d",
        "e",
        "f",
    ]),
]);
// Body lines that resemble compartment headings are indented.
pushRender([v2(3, 4, "Heading guard", 50, ["first\n## nested\nlast", "d", "e", "f"])]);
// Same-month dates use the compact heading form.
pushRender([
    {
        ...v2(1, 2, "Dated", 50, ["dated body", "dense", "brief", "anchor"]),
        startDate: "2026-01-02",
        endDate: "2026-01-03",
    },
]);
// A legacy row with a `U:` line starts one tier less truncated than a row without one.
pushRender([
    { startMessage: 1, endMessage: 5, title: "LegU", content: `U: question\n${"a".repeat(2000)}`, legacy: 1, importance: 50 },
    { startMessage: 6, endMessage: 9, title: "LegNoU", content: "b".repeat(2000), legacy: 1, importance: 50 },
]);
// An empty P1 in a pseudo-V2 row triggers the flat-content fallback.
pushRender([{ startMessage: 1, endMessage: 2, title: "Pseudo", content: "flat body here", p1: "", legacy: 0, importance: 50 }]);
// Legacy rows are excluded from budget-pressure calculations.
// Excluding legacy rows prevents their fixed truncation cost from demoting V2 paraphrases.
pushRender([
    v2(1, 9, "v2a", 80, ["P1 first", "P2 first", "P3 first", "P4first"]),
    { startMessage: 10, endMessage: 14, title: "leg", content: `U: x\n${"c".repeat(600)}`, legacy: 1, importance: 50 },
    v2(15, 20, "v2b", 30, ["P1 second", "P2 second", "P3 second", ""]),
]);

// The mc-module port consumes this fixture from its testdata directory.
const renderOut = join(import.meta.dir, "../../mc-module/testdata/render-golden.json");
mkdirSync(dirname(renderOut), { recursive: true });
writeFileSync(renderOut, `${JSON.stringify({ cases: renderCases }, null, 2)}\n`);
console.log(`wrote ${renderCases.length} render cases → ${renderOut}`);

// The loose-budget fixture validates curve-only output; the tight-budget fixture validates budget-guard demotions.
// At these budgets, the real Claude-BPE token estimate forces oldest-first demotion after curve selection.
// The Rust test runs these cases with mc_tokenizer::estimate_tokens.
// The TS and Rust tests must produce identical token counts for every case.
// V2 whole-tier selection leaves token count as the only cross-language input.
// UTF-8 CJK and code content expose character-count proxy drift; estimateTokens avoids that drift.
const tightBody = (compartments: DecayRenderCompartment[], budget: number) =>
    renderDecayedCompartments({ compartments, historyBudgetTokens: budget });

const bigP1 = (i: number) =>
    `P1 verbose narrative for compartment ${i}: ` +
    `the historian condensed a long arc of work here with enough distinct prose that the ` +
    `first-tier paraphrase carries real token weight — file paths like src/hooks/magic-context/` +
    `transform.ts, decisions, and follow-ups, repeated across ${i} to make each body sizeable.`;

const tightPool = (n: number): DecayRenderCompartment[] =>
    Array.from({ length: n }, (_, i) =>
        v2(i * 10 + 1, i * 10 + 9, `arc ${i}`, [30, 55, 85][i % 3], [
            bigP1(i),
            `P2 dense summary for ${i} with moderate length keeping some detail`,
            `P3 terse ${i}`,
            i % 3 === 0 ? "" : `P4anchor${i}`,
        ]),
    );

const cjkPool = (n: number): DecayRenderCompartment[] =>
    Array.from({ length: n }, (_, i) =>
        v2(i * 10 + 1, i * 10 + 9, `弧 ${i}`, [40, 60, 80][i % 3], [
            `P1 详细叙述 compartment ${i}：历史学家在这里压缩了一段很长的工作，包含足够独特的文字，` +
                `路径如 src/hooks/magic-context/transform.ts，决策与后续，重复 ${i} 次以增加体量。`,
            `P2 密集摘要 ${i} 保留部分细节`,
            `P3 简短 ${i}`,
            `P4锚点${i}`,
        ]),
    );

const tightRenderCases: Array<{
    compartments: DecayRenderCompartment[];
    budget: number;
    body: string;
}> = [];
const pushTight = (compartments: DecayRenderCompartment[], budget: number) =>
    tightRenderCases.push({ compartments, budget, body: tightBody(compartments, budget) });

// The budgets force progressively deeper oldest-first demotion, from one compartment to near-total demotion.
pushTight(tightPool(20), 1500);
pushTight(tightPool(20), 800);
pushTight(tightPool(20), 300);
pushTight(tightPool(12), 120);
// Budget 20 leaves even all-P4 output over budget, so the guard reaches its best-effort cap.
pushTight(tightPool(12), 20);
pushTight(cjkPool(15), 600);
pushTight(cjkPool(15), 150);

const tightOut = join(import.meta.dir, "../../mc-module/testdata/render-tight-golden.json");
writeFileSync(tightOut, `${JSON.stringify({ cases: tightRenderCases }, null, 2)}\n`);
console.log(`wrote ${tightRenderCases.length} tight-budget render cases → ${tightOut}`);

// Each project-docs golden case records a canonical hash and rendered <project-docs> block.
// The golden excludes symlink and oversize cases.
const docCaseInputs: Array<Array<[string, string]>> = [
    [],
    [["ARCHITECTURE.md", "# Arch\nbody line"]],
    [
        ["ARCHITECTURE.md", "# Arch\nalpha"],
        ["STRUCTURE.md", "# Struct\nbeta"],
    ],
    // Canonicalization removes BOMs, normalizes CRLF, and trims trailing spaces, tabs, and blank lines.
    [["ARCHITECTURE.md", "\uFEFFline1  \r\nline2\t\n\n\n"]],
    // XML-escaped content
    [["STRUCTURE.md", "a < b & c > d"]],
    [["STRUCTURE.md", "solo struct"]],
];
const docsCases = docCaseInputs.map((files) => {
    const tmp = mkdtempSync(join(tmpdir(), "mc-docs-golden-"));
    try {
        for (const [name, body] of files) writeDocFile(join(tmp, name), body);
        const { renderedBlock, canonicalHash } = readProjectDocsCanonical(tmp);
        return { files, rendered_block: renderedBlock, canonical_hash: canonicalHash };
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});
const docsOut = join(import.meta.dir, "../../mc-module/testdata/project-docs-golden.json");
writeFileSync(docsOut, `${JSON.stringify({ cases: docsCases }, null, 2)}\n`);
console.log(`wrote ${docsCases.length} project-docs cases → ${docsOut}`);

// Each golden records the rendered <project-memory> block and <memory-updates> corrections.
const xmlContent = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const mkMem = (id: number, category: string, content: string, importance: number | null): Memory =>
    ({ id, category, content, importance }) as unknown as Memory;

const memoryBlockInputs: Array<
    Array<[number, string, string, number | null, string?]>
> = [
    [],
    [[1, "ARCHITECTURE", "the spine holds the frozen set", 80]],
    [
        [3, "NAMING", "use ctx_* prefix", 40],
        [5, "Z_LEGACY", "last unknown", 1],
        [1, "PROJECT_RULES", "alpha", 90],
        [2, "CONSTRAINTS", "x < y & \"z\"", null, "svc<&"],
        [4, "A_LEGACY", "first unknown", 100],
    ],
];
const memoryBlockCases = memoryBlockInputs.map((rows) => {
    const memories = rows.map(([id, category, content, importance]) =>
        mkMem(id, category, content, importance),
    );
    const sourceNameByMemoryId = new Map(
        rows.flatMap(([id, , , , sourceName]) => (sourceName ? [[id, sourceName] as const] : [])),
    );
    return {
        memories: rows.map(([id, category, content, importance, source_name]) => ({
            id,
            category,
            content,
            importance,
            ...(source_name ? { source_name } : {}),
        })),
        block: renderMemoryBlockV2(memories, "project-memory", { sourceNameByMemoryId }),
    };
});

type Mut = { id: number; type: string; target: number; content?: string; by?: number | null };
function renderUpdates(mutations: Mut[], renderedIds: number[]): string {
    if (mutations.length === 0) return "";
    const ids = new Set(renderedIds);
    const lines = ["These memories changed since the snapshot below — trust these:"];
    for (const m of mutations) {
        if (m.type === "update") {
            lines.push(`  <updated id="${m.target}">${xmlContent(m.content ?? "")}</updated>`);
        } else if (m.type === "superseded") {
            if (m.by != null && ids.has(m.by)) lines.push(`  <superseded id="${m.target}" by="${m.by}"/>`);
            else lines.push(`  <removed id="${m.target}"/>`);
        } else {
            lines.push(`  <removed id="${m.target}"/>`);
        }
    }
    return `<memory-updates>\n${lines.join("\n")}\n</memory-updates>`;
}
const memoryUpdatesInputs: Array<{ mutations: Mut[]; rendered_ids: number[] }> = [
    { mutations: [], rendered_ids: [1] },
    { mutations: [{ id: 1, type: "update", target: 1, content: "new < content" }], rendered_ids: [1] },
    {
        mutations: [
            { id: 2, type: "update", target: 1, content: "u" },
            { id: 3, type: "superseded", target: 2, by: 9 },
            { id: 4, type: "superseded", target: 3, by: 99 },
            { id: 5, type: "archive", target: 4 },
        ],
        rendered_ids: [1, 2, 9],
    },
];
const memoryUpdatesCases = memoryUpdatesInputs.map(({ mutations, rendered_ids }) => ({
    mutations: mutations.map((m) => ({ id: m.id, type: m.type, target: m.target, content: m.content ?? "", by: m.by ?? null })),
    rendered_ids,
    block: renderUpdates(mutations, rendered_ids),
}));

const memOut = join(import.meta.dir, "../../mc-module/testdata/memory-render-golden.json");
writeFileSync(memOut, `${JSON.stringify({ memory_block_cases: memoryBlockCases, memory_updates_cases: memoryUpdatesCases }, null, 2)}\n`);
console.log(`wrote ${memoryBlockCases.length} memory-block + ${memoryUpdatesCases.length} memory-updates cases → ${memOut}`);
