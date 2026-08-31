import { describe, expect, it } from "bun:test";
import { buildMagicContextSection } from "./magic-context-prompt";

const CAVEMAN_MARKER = "BEWARE";
const CAVEMAN_PHRASE_TAIL = "consciously revert to full sentences";

const KNOWN_AGENT_IDENTITIES = [
    "sisyphus",
    "atlas",
    "hephaestus",
    "sisyphus-junior",
    "oracle",
    "athena",
    "athena-junior",
] as const;

describe("buildMagicContextSection — generic guidance", () => {
    it("emits the same generic guidance for all known agent identities", () => {
        const generic = buildMagicContextSection(null, 20, true, false, false, false);

        for (const agent of KNOWN_AGENT_IDENTITIES) {
            expect(buildMagicContextSection(agent, 20, true, false, false, false)).toBe(generic);
        }
    });

    it("does not emit legacy agent-tailored guidance", () => {
        const out = buildMagicContextSection("atlas", 20, true, false, false, false);

        expect(out).toContain("### Reduction Triggers");
        expect(out).toContain("Your current task requirements and constraints");
        expect(out).not.toContain("CRITICAL — you run long sessions");
        expect(out).not.toContain("delegation tool outputs from completed waves");
        expect(out).not.toContain("council member response outputs");
    });

    it("opens with the long-term-partner frame in BOTH ctx_reduce availability variants", () => {
        const reduce = buildMagicContextSection(null, 20, true, false, false, false);
        const noReduce = buildMagicContextSection(null, 20, false, false, false, false);

        for (const out of [reduce, noReduce]) {
            expect(out).toContain("long-term partner on this project");
            expect(out).toContain("weeks, months, or even years");
            expect(out).toContain("effectively unbounded");
            expect(out).toContain("never a reason to wrap up, cut scope, rush, or defer");
            expect(out).toContain("Finishing a task does not end the session");
            expect(out).toContain("no compaction pauses");
            expect(out.indexOf("long-term partner")).toBeLessThan(out.indexOf("ctx_note"));
        }
    });

    it("uses the mode-specific partner-frame closer", () => {
        const reduce = buildMagicContextSection(null, 20, true, false, false, false);
        const noReduce = buildMagicContextSection(null, 20, false, false, false, false);

        expect(reduce).toContain("Reduction prompts are routine housekeeping");
        expect(reduce).not.toContain("there's nothing to prune");
        expect(noReduce).toContain("there's nothing to prune and no warnings to act on");
        expect(noReduce).not.toContain("Reduction prompts are routine housekeeping");
        for (const out of [reduce, noReduce]) {
            expect(out).toContain("never let context size change");
        }
    });

    it("no longer emits the scarcity-flavored 'compress early and often, don't wait for warnings' line", () => {
        const reduce = buildMagicContextSection(null, 20, true, false, false, false);
        expect(reduce).not.toContain("don't wait for warnings");
    });
});

describe("buildMagicContextSection — subagent mode", () => {
    const subagent = () => buildMagicContextSection(null, 20, true, false, false, false, true);

    it("emits ONLY the minimal §N§ + ctx_reduce mechanics", () => {
        const out = subagent();
        expect(out).toContain("## Magic Context");
        expect(out).toContain("§N§ identifiers");
        expect(out).toContain("ctx_reduce");
        expect(out).toContain("The last 20 tags are protected");
    });

    it("OMITS the long-term-partner frame and primary-only guidance", () => {
        const out = subagent();
        expect(out).not.toContain("long-term partner");
        expect(out).not.toContain("weeks, months, or even years");
        expect(out).not.toContain("### Reduction Triggers");
        expect(out).not.toContain("ctx_memory");
        expect(out).not.toContain("ctx_search");
        expect(out).not.toContain("ctx_note");
        expect(out).not.toContain("ctx_expand");
    });

    it("threads protectedTags into the protected-count line", () => {
        const out = buildMagicContextSection(null, 7, true, false, false, false, true);
        expect(out).toContain("The last 7 tags are protected");
    });

    it("is much shorter than the full primary block", () => {
        const full = buildMagicContextSection(null, 20, true, false, false, false, false);
        expect(subagent().length).toBeLessThan(full.length / 2);
    });

    it("defaults subagentMode=false (legacy callers unaffected)", () => {
        const sixArg = buildMagicContextSection(null, 20, true, false, false, false);
        const explicitFalse = buildMagicContextSection(null, 20, true, false, false, false, false);
        expect(sixArg).toBe(explicitFalse);
        expect(sixArg).toContain("long-term partner");
    });
});

describe("buildMagicContextSection: memory gating", () => {
    // memoryEnabled defaults to true; 7-argument legacy calls rely on that default.
    it("memory ON (default) keeps claim-native ctx_memory guidance", () => {
        const legacy = buildMagicContextSection(null, 20, true, false, false, false, false);
        const memOn = buildMagicContextSection(
            null,
            20,
            true,
            false,
            false,
            false,
            false,
            undefined,
            true,
        );
        expect(memOn).toBe(legacy);
        expect(memOn).toContain("Use `ctx_memory`");
        expect(memOn).toContain("**Save durable knowledge proactively**");
        expect(memOn).toContain("opaque `mcm_…` public IDs");
    });

    it("memory OFF drops ALL ctx_memory guidance but keeps ctx_search", () => {
        const off = buildMagicContextSection(
            null,
            20,
            true,
            false,
            false,
            false,
            false,
            undefined,
            false,
        );
        expect(off).not.toContain("ctx_memory");
        expect(off).not.toContain("Save durable knowledge proactively");
        expect(off).toContain("Use `ctx_search`");
        expect(off).not.toContain("\n\nUse `ctx_search`");
    });

    it("memory OFF gates the guidance in no-reduce mode too", () => {
        const off = buildMagicContextSection(
            null,
            20,
            false,
            false,
            false,
            false,
            false,
            undefined,
            false,
        );
        expect(off).not.toContain("ctx_memory");
        expect(off).toContain("Use `ctx_search`");
    });
});

describe("buildMagicContextSection — caveman compression warning", () => {
    it("emits the warning when caveman is enabled and ctx_reduce is unavailable", () => {
        const out = buildMagicContextSection(
            null, // agent
            20, // protectedTags (ignored in no-reduce path)
            false, // ctx_reduce is unavailable in this session.
            false, // dreamerEnabled
            false, // temporalAwarenessEnabled
            true, // cavemanTextCompressionEnabled
        );
        expect(out).toContain(CAVEMAN_MARKER);
        expect(out).toContain(CAVEMAN_PHRASE_TAIL);
        expect(out).toContain("DO NOT mimic this style");
    });

    it("omits the warning when caveman is disabled", () => {
        const out = buildMagicContextSection(
            null,
            20,
            false, // ctx_reduce is unavailable in this session.
            false, // dreamerEnabled
            false, // temporalAwarenessEnabled
            false, // cavemanTextCompressionEnabled = false
        );
        expect(out).not.toContain(CAVEMAN_MARKER);
        expect(out).not.toContain(CAVEMAN_PHRASE_TAIL);
    });

    it("emits the warning when ctx_reduce is callable and caveman is enabled", () => {
        // Primary guidance warns that caveman compression can rewrite prose even when ctx_reduce is available.
        const out = buildMagicContextSection(
            null,
            20,
            true, // ctx_reduce is callable in this session.
            false, // dreamerEnabled
            false, // temporalAwarenessEnabled
            true, // cavemanTextCompressionEnabled
        );
        expect(out).toContain(CAVEMAN_MARKER);
        expect(out).toContain(CAVEMAN_PHRASE_TAIL);
    });

    it("omits the warning by default (parameter optional)", () => {
        const out = buildMagicContextSection(null, 20, false, false, false);
        expect(out).not.toContain(CAVEMAN_MARKER);
    });
});

describe("buildMagicContextSection — compaction-off guidance variant (#266 S4)", () => {

    it("the compaction-off variant is byte-identical to the existing no-reduce variant", () => {
        const existingNoReduce = buildMagicContextSection(null, 20, false, false, false, false);
        const compactionOff = buildMagicContextSection(null, 20, false, false, false, false);
        expect(compactionOff).toBe(existingNoReduce);
    });

    it("does not advertise ctx_reduce, §N§ prefixes, or tag-based recovery", () => {
        const out = buildMagicContextSection(null, 20, false, false, false, false);
        expect(out).not.toContain("ctx_reduce");
        expect(out).not.toContain("tagged with §N§ identifiers");
        expect(out).not.toContain("Use `ctx_reduce`");
        expect(out).not.toMatch(/recover.*tag|tag.*recover/i);
        expect(out).not.toContain("§N§ identifiers (e.g.");
    });

    it("still covers memory, search, notes, and ctx_expand guidance", () => {
        const out = buildMagicContextSection(null, 20, false, false, false, false);
        expect(out).toContain("ctx_search");
        expect(out).toContain("ctx_expand");
        expect(out).toContain("ctx_note");
        expect(out).toContain("ctx_memory");
    });

    it("frames ctx_expand as recovery for summaries / ctx_search hits, not tag-based recovery", () => {
        const out = buildMagicContextSection(null, 20, false, false, false, false);
        expect(out).toContain("ctx_expand");
        expect(out).toContain("session-history");
        expect(out).toContain("message ordinals");
    });

    it("the reduce variant DOES advertise §N§ and ctx_reduce (contrast for the off-mode assertion)", () => {
        // `compactionEnabled=false` omits `ctx_reduce` guidance.
        const reduce = buildMagicContextSection(null, 20, true, false, false, false);
        expect(reduce).toContain("ctx_reduce");
        expect(reduce).toContain("tagged with §N§ identifiers");
    });
});

describe("buildMagicContextSection — prompt-surface composition", () => {
    it("keeps full bytes stable while serving compressed light guidance", () => {
        const implicit = buildMagicContextSection(
            null,
            20,
            true,
            true,
            true,
            true,
            false,
            "tr",
            true,
        );
        const explicitFull = buildMagicContextSection(
            null,
            20,
            true,
            true,
            true,
            true,
            false,
            "tr",
            true,
            "full",
        );
        const light = buildMagicContextSection(
            null,
            20,
            true,
            true,
            true,
            true,
            false,
            "tr",
            true,
            "light",
        );

        expect(explicitFull).toBe(implicit);
        expect(light).not.toBe(implicit);
        expect(light).toContain("In primary sessions with ctx_reduce");
        expect(light).toContain("NEVER narrate ctx_reduce");
        expect(light).toContain("DO NOT mimic this style");
        expect(light).toContain("Keep code, identifiers, file paths");
        expect(light).not.toContain("### Reduction Triggers");
    });

    it("keeps feature-gated and shared fragments orthogonal to light", () => {
        const light = (options: {
            reduce?: boolean;
            dreamer?: boolean;
            temporal?: boolean;
            caveman?: boolean;
            subagent?: boolean;
            language?: string;
            memory?: boolean;
        }) =>
            buildMagicContextSection(
                null,
                20,
                options.reduce ?? true,
                options.dreamer ?? false,
                options.temporal ?? false,
                options.caveman ?? false,
                options.subagent ?? false,
                options.language,
                options.memory ?? true,
                "light",
            );

        const memoryOff = light({ memory: false });
        expect(memoryOff).not.toContain("Use `ctx_memory`");
        expect(memoryOff).toContain("ctx_search");

        const noReduce = light({ reduce: false });
        expect(noReduce).not.toContain("In primary sessions with ctx_reduce");
        expect(noReduce).not.toContain("drop grammar");

        const gatedOff = light({ dreamer: false, temporal: false, caveman: false });
        expect(gatedOff).not.toContain("surface_condition creates");
        expect(gatedOff).not.toContain("**Temporal awareness**");
        expect(gatedOff).not.toContain("**BEWARE**");

        const gatedOn = light({ dreamer: true, temporal: true, caveman: true, language: "tr" });
        expect(gatedOn).toContain("surface_condition creates");
        expect(gatedOn).toContain("**Temporal awareness**");
        expect(gatedOn).toContain("**BEWARE**");
        expect(gatedOn).toContain("Keep code, identifiers, file paths");

        const subagent = light({ subagent: true });
        expect(subagent).toContain("In bounded subagent sessions");
        expect(subagent).toContain("[dropped §N§]");
        expect(subagent).not.toContain("long-term partner");
        expect(subagent).not.toContain("ctx_search");
    });

    it("appends shared runtime fragments after a complete primary override", () => {
        const override = "## Magic Context\n\nUser-owned primary guidance.";
        const output = buildMagicContextSection(
            null,
            20,
            true,
            true,
            true,
            true,
            false,
            "tr",
            true,
            "full",
            override,
        );

        expect(output.startsWith(override)).toBe(true);
        expect(output.match(/^## Magic Context$/gm)).toHaveLength(1);
        expect(output).toContain("**Temporal awareness**");
        expect(output).toContain("**BEWARE**: History compression is on");
        expect(output).toContain("Use Turkish (Türkçe) for your natural-language replies");
        expect(output.indexOf("**Temporal awareness**")).toBeGreaterThan(
            output.indexOf("User-owned primary guidance."),
        );
        expect(output).not.toContain("### Reduction Triggers");
        expect(output).not.toContain("surface_condition");
    });

    it("keeps subagent guidance independent from a primary override", () => {
        const output = buildMagicContextSection(
            null,
            20,
            true,
            false,
            false,
            false,
            true,
            undefined,
            true,
            "full",
            "## Magic Context\n\nPrimary override must not reach subagents.",
        );

        expect(output).toContain("§N§ identifiers");
        expect(output).not.toContain("Primary override must not reach subagents");
    });
});
