/**
 * Generate the differential historian USER-prompt golden for the Rust mc-module port.
 *
 * Run:        bun crates/mc-module/gen/gen-historian-prompt-golden.ts
 * Drift check: bun crates/mc-module/gen/gen-historian-prompt-golden.ts --check
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const resolve = (m: string) => Bun.resolveSync(m, pluginDir);

const promptMod = await import(resolve("./src/hooks/magic-context/compartment-prompt"));
const referenceMod = await import(resolve("./src/hooks/magic-context/reference-retrieval"));
const claimRenderMod = await import(
    resolve("./src/features/magic-context/memory/claim-memory-render"),
);
const seedsMod = await import(resolve("./src/hooks/magic-context/reference-seeds.generated"));

const { buildCompartmentAgentPrompt } = promptMod as {
    buildCompartmentAgentPrompt: (inputs: {
        seedExamples: string;
        sessionReferences: string;
        projectMemory: string;
        inputSource: string;
        memoryEnabled?: boolean;
        extractionFree?: boolean;
    }) => string;
};
const { buildReferenceBlocks, selectSeeds, renderSeedExamplesBlock } = referenceMod as {
    buildReferenceBlocks: (args: {
        sessionId: string;
        chunkStart: number;
        sessionCompartments: TsReferenceCompartment[];
    }) => { seedExamples: string; sessionReferences: string };
    selectSeeds: (
        sessionId: string,
        chunkStart: number,
        count?: number,
    ) => Array<{ importance: number; block: string }>;
    renderSeedExamplesBlock: (seeds: Array<{ importance: number; block: string }>) => string;
};
const { renderClaimMemoryBlock } = claimRenderMod as {
    renderClaimMemoryBlock: (claims: TsClaimMemory[]) => string;
};
const { REFERENCE_SEEDS } = seedsMod as {
    REFERENCE_SEEDS: ReadonlyArray<{ importance: number; block: string }>;
};

interface ReferenceCompartmentJson {
    start_message: number;
    end_message: number;
    title: string;
    content: string;
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    importance?: number | null;
    episode_type?: string | null;
}

interface TsReferenceCompartment {
    startMessage: number;
    endMessage: number;
    title: string;
    content: string;
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    importance?: number | null;
    episodeType?: string | null;
}

interface MemoryJson {
    id: number;
    category: string;
    content: string;
}

interface TsClaimMemory {
    publicClaimId: string;
    revisionLocator: string;
    projectId: number;
    category: string;
    content: string;
    importance: number;
}

interface SeedCaseSpec {
    label: string;
    session_id: string;
    chunk_start: number;
    count: number;
}

interface SeedCase extends SeedCaseSpec {
    selected_indices: number[];
    seed_examples: string;
}

interface PromptCaseSpec {
    label: string;
    session_id: string;
    chunk_start: number;
    session_compartments: ReferenceCompartmentJson[];
    memories: MemoryJson[];
    input_source: string;
    memory_enabled: boolean;
    extraction_free: boolean;
}

interface PromptCase extends PromptCaseSpec {
    selected_seed_indices: number[];
    seed_examples: string;
    session_references: string;
    project_memory: string;
    prompt: string;
}

function toTsCompartment(c: ReferenceCompartmentJson): TsReferenceCompartment {
    return {
        startMessage: c.start_message,
        endMessage: c.end_message,
        title: c.title,
        content: c.content,
        p1: c.p1 ?? null,
        p2: c.p2 ?? null,
        p3: c.p3 ?? null,
        p4: c.p4 ?? null,
        importance: c.importance ?? null,
        episodeType: c.episode_type ?? null,
    };
}

function toTsClaim(m: MemoryJson): TsClaimMemory {
    const publicClaimId = `mcm_${m.id.toString(16).padStart(32, "0")}`;
    return {
        publicClaimId,
        revisionLocator: `${publicClaimId}/r1/${"a".repeat(64)}`,
        projectId: 1,
        category: m.category,
        content: m.content,
        importance: 50,
    };
}

function selectedSeedIndices(sessionId: string, chunkStart: number, count: number): number[] {
    return selectSeeds(sessionId, chunkStart, count).map((seed) => {
        const idx = REFERENCE_SEEDS.indexOf(seed);
        if (idx < 0) {
            throw new Error(`selected seed was not from REFERENCE_SEEDS for ${sessionId}:${chunkStart}`);
        }
        return idx;
    });
}

const matureCompartments: ReferenceCompartmentJson[] = [
    {
        start_message: 1,
        end_message: 5,
        title: "old omitted one",
        content: "old content one",
        importance: 10,
    },
    {
        start_message: 6,
        end_message: 12,
        title: "old omitted two",
        content: "old content two",
        importance: 20,
    },
    {
        start_message: 13,
        end_message: 20,
        title: "Escaped title & \"quotes\" 'apostrophe' <tag>",
        content: "unused v2 content",
        p1: "P1 says A & B < C > D",
        p2: "P2 uses \"quotes\" & ampersand",
        p3: "P3 keeps 'apostrophe' <tag>",
        p4: "",
        importance: null,
        episode_type: "design&bug\"triage'",
    },
    {
        start_message: 21,
        end_message: 27,
        title: "Legacy <flat> & row",
        content: "Legacy content & <xml> > \"quote\" 'apostrophe'",
        p1: null,
        p2: null,
        p3: null,
        p4: null,
        importance: 77,
        episode_type: null,
    },
    {
        start_message: 28,
        end_message: 31,
        title: "Pseudo v2 empty p1 falls back",
        content: "Fallback content because p1 is empty & visible",
        p1: "",
        p2: "ignored p2",
        p3: "ignored p3",
        p4: "ignored p4",
        importance: 66,
        episode_type: "investigation",
    },
    {
        start_message: 32,
        end_message: 40,
        title: "Tiered p4 body",
        content: "unused content",
        p1: "Full tier body",
        p2: "Short tier body",
        p3: "Outcome tier body",
        p4: "Anchor & <p4>",
        importance: 5,
        episode_type: "release",
    },
    {
        start_message: 41,
        end_message: 45,
        title: "Legacy empty episode type",
        content: "Episode type is empty string, so the attribute is omitted.",
        p1: null,
        importance: 50,
        episode_type: "",
    },
    {
        start_message: 46,
        end_message: 52,
        title: "Tiered null lower tiers",
        content: "unused",
        p1: "Only P1 is populated",
        p2: null,
        p3: null,
        p4: null,
        importance: 88,
        episode_type: "feature",
    },
];

const promptCaseSpecs: PromptCaseSpec[] = [
    {
        label: "young session seed floor only",
        session_id: "young-session",
        chunk_start: 0,
        session_compartments: [],
        memories: [],
        input_source: "Messages 1-3:\n\n[1] U: Start <feature> & check \"quotes\"\n[2] A: Done\n[3] U: thanks",
        memory_enabled: true,
        extraction_free: false,
    },
    {
        label: "mature session refs and category memory",
        session_id: "mature-<&\"'-🚀",
        chunk_start: 42,
        session_compartments: matureCompartments,
        memories: [
            { id: 1, category: "NAMING", content: "Use Foo & Bar <Baz> in examples" },
            { id: 2, category: "PROJECT_RULES", content: "Never rewrite generated files > their source" },
            { id: 3, category: "ARCHITECTURE", content: "Core path is crates/mc-module" },
            { id: 4, category: "CONSTRAINTS", content: "Escape \"quotes\" but content leaves them literal" },
            { id: 5, category: "CONFIG_VALUES", content: "timeout_ms=5000 & mode=fast" },
            { id: 6, category: "USER_DIRECTIVES", content: "Legacy user directive survives" },
            // Two categories outside the five-entry render order, so the golden pins the
            // alphabetical tie-break both renderers fall back to. Both are allow-listed
            // project-memory categories: a category outside the allow-list never reaches
            // either renderer, so pinning one here would assert bytes the surfaces refuse
            // to produce.
            { id: 7, category: "KNOWN_ISSUES", content: "Legacy known issue survives" },
        ],
        input_source: "Messages 53-56:\n\n[53] U: continue with XML chars & < >\n[54] A: implementing\n[55] TC: read(src/lib.rs)\n[56] A: finished",
        memory_enabled: true,
        extraction_free: false,
    },
    {
        label: "memory disabled toggle",
        session_id: "toggle-memory-off",
        chunk_start: 99,
        session_compartments: [],
        memories: [],
        input_source: "Messages 10-11:\n\n[10] U: no durable memory please\n[11] A: ok",
        memory_enabled: false,
        extraction_free: false,
    },
    {
        label: "extraction free toggle",
        session_id: "toggle-extraction-free",
        chunk_start: 100,
        session_compartments: [],
        memories: [],
        input_source: "Messages 20-21:\n\n[20] U: rebuild structure only\n[21] A: ok",
        memory_enabled: true,
        extraction_free: true,
    },
    {
        label: "both toggles order",
        session_id: "toggle-both",
        chunk_start: 101,
        session_compartments: [],
        memories: [],
        input_source: "Messages 30-31:\n\n[30] U: structure only and memory disabled\n[31] A: ok",
        memory_enabled: false,
        extraction_free: true,
    },
];

const seedCaseSpecs: SeedCaseSpec[] = [
    { label: "default rotation a", session_id: "rot-a", chunk_start: 0, count: 4 },
    { label: "default rotation b", session_id: "rot-b", chunk_start: 1, count: 4 },
    { label: "unicode utf16 rotation", session_id: "emoji-🚀-session", chunk_start: 7, count: 4 },
    { label: "flat fallback count above band guard", session_id: "fallback", chunk_start: 12345, count: 25 },
];

const seedCases: SeedCase[] = seedCaseSpecs.map((spec) => {
    const seeds = selectSeeds(spec.session_id, spec.chunk_start, spec.count);
    return {
        ...spec,
        selected_indices: selectedSeedIndices(spec.session_id, spec.chunk_start, spec.count),
        seed_examples: renderSeedExamplesBlock(seeds),
    };
});

const promptCases: PromptCase[] = promptCaseSpecs.map((spec) => {
    const sessionCompartments = spec.session_compartments.map(toTsCompartment);
    const refs = buildReferenceBlocks({
        sessionId: spec.session_id,
        chunkStart: spec.chunk_start,
        sessionCompartments,
    });
    const projectMemory = renderClaimMemoryBlock(spec.memories.map(toTsClaim));
    const prompt = buildCompartmentAgentPrompt({
        seedExamples: refs.seedExamples,
        sessionReferences: refs.sessionReferences,
        projectMemory,
        inputSource: spec.input_source,
        memoryEnabled: spec.memory_enabled,
        extractionFree: spec.extraction_free,
    });
    return {
        ...spec,
        selected_seed_indices: selectedSeedIndices(spec.session_id, spec.chunk_start, 4),
        seed_examples: refs.seedExamples,
        session_references: refs.sessionReferences,
        project_memory: projectMemory,
        prompt,
    };
});

const distinctDefaultSelections = new Set(
    seedCases.filter((c) => c.count === 4).map((c) => JSON.stringify(c.selected_indices)),
);
if (distinctDefaultSelections.size <= 1) {
    throw new Error("seed rotation cases are vacuous; distinct inputs produced the same selection");
}
if (!seedCases.some((c) => c.count > 20 && c.selected_indices.length > 20)) {
    throw new Error("seed cases stopped exercising flat-corpus fallback after the band-walk guard");
}
if (!promptCases.some((c) => c.seed_examples.length > 0)) {
    throw new Error("prompt cases never emitted seeds");
}
if (!promptCases.some((c) => c.session_references.length > 0)) {
    throw new Error("prompt cases never emitted session references");
}
if (!promptCases.some((c) => c.project_memory.length > 0)) {
    throw new Error("prompt cases never emitted project memory");
}

const golden = { seed_cases: seedCases, prompt_cases: promptCases };
const rendered = `${JSON.stringify(golden, null, 2)}\n`;
const outPath = join(import.meta.dir, "..", "testdata", "historian-prompt-golden.json");

if (process.argv.includes("--check")) {
    if (!existsSync(outPath)) {
        console.error(`missing historian prompt golden: ${outPath}`);
        process.exit(1);
    }
    const current = readFileSync(outPath, "utf8");
    if (current !== rendered) {
        console.error(`historian prompt golden drifted; regenerate ${outPath}`);
        process.exit(1);
    }
    console.log(`historian prompt golden up to date: ${outPath}`);
} else {
    writeFileSync(outPath, rendered);
    console.log(`wrote ${promptCases.length} historian prompt cases + ${seedCases.length} seed cases → ${outPath}`);
}
