import { describe, expect, it } from "bun:test";
import {
    countQueryAtoms,
    MAX_QUERY_ATOMS,
    MAX_QUERY_BYTES,
    MAX_QUERY_TOKENS,
} from "../../features/magic-context/search-bounds";
import { estimateTokens } from "../../shared/token-estimator";
import { collectStrippedPromptPrefix, extractBoundedAutoSearchQuery } from "./auto-search-prompt";

describe("collectStrippedPromptPrefix", () => {
    it("drops plugin-owned blocks with their content", () => {
        const raw = [
            "<system-reminder>internal reminder</system-reminder>",
            "<ctx-search-hint>old hint body</ctx-search-hint>",
            "<ctx-search-auto>auto body</ctx-search-auto>",
            "<sidekick-augmentation>augment body</sidekick-augmentation>",
            '<instruction name="deferred_notes">nudge body</instruction>',
            "real user text",
        ].join("\n");
        const stripped = collectStrippedPromptPrefix(raw);
        expect(stripped).not.toContain("internal reminder");
        expect(stripped).not.toContain("old hint body");
        expect(stripped).not.toContain("auto body");
        expect(stripped).not.toContain("augment body");
        expect(stripped).not.toContain("nudge body");
        expect(stripped).toContain("real user text");
    });

    it("handles nested system reminders without leaking the outer close", () => {
        const raw =
            "before <system-reminder>outer <system-reminder>inner</system-reminder> tail</system-reminder> after";
        expect(collectStrippedPromptPrefix(raw).replace(/\s+/g, " ").trim()).toBe("before after");
    });

    it("drops orphan closing tags silently", () => {
        expect(collectStrippedPromptPrefix("text </system-reminder> more").trim()).toBe(
            "text more",
        );
    });

    it("keeps text between user-pasted paired tags while removing the tags", () => {
        const stripped = collectStrippedPromptPrefix(
            "see <custom-tag>kept data</custom-tag> and <Component props={x} /> usage",
        );
        expect(stripped).toContain("kept data");
        expect(stripped).toContain("usage");
        expect(stripped).not.toContain("<");
        expect(stripped).not.toContain(">");
    });

    it("does not treat instructions-prefixed tags as the instruction block", () => {
        const stripped = collectStrippedPromptPrefix("<instructions>keep me</instructions>");
        expect(stripped).toBe("keep me");
    });

    it("does not open a drop block for a self-closing attributed drop tag", () => {
        expect(
            collectStrippedPromptPrefix(
                '<instruction name="x"/> why does the retry loop deadlock?',
            ).trim(),
        ).toBe("why does the retry loop deadlock?");
        expect(
            collectStrippedPromptPrefix('<system-reminder foo="1"/> question survives').trim(),
        ).toBe("question survives");
    });

    it("does not open a drop block for a bare self-closing drop tag", () => {
        expect(collectStrippedPromptPrefix("<instruction/> question survives").trim()).toBe(
            "question survives",
        );
    });

    it("does not open a drop block for a self-closing drop tag with a quoted > attribute", () => {
        expect(
            collectStrippedPromptPrefix('<instruction data=">"/> question survives').trim(),
        ).toBe("question survives");
        expect(
            collectStrippedPromptPrefix("<system-reminder note='a>b'/> question survives").trim(),
        ).toBe("question survives");
    });

    it("finds the drop-block close across bare < characters in dropped content", () => {
        expect(
            collectStrippedPromptPrefix(
                "<instruction>x < y and a<b comparisons</instruction> keep this",
            ).trim(),
        ).toBe("keep this");
    });

    it("removes HTML comments including multiline content", () => {
        expect(collectStrippedPromptPrefix("a <!-- note\nacross lines --> b").trim()).toBe("a b");
    });

    it("keeps a bare < that is not markup", () => {
        expect(collectStrippedPromptPrefix("x < 5 and y > 3")).toBe("x < 5 and y > 3");
    });

    it("retains at most the query byte cap of stripped text", () => {
        const stripped = collectStrippedPromptPrefix("word ".repeat(100_000));
        expect(Buffer.byteLength(stripped, "utf8")).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    });

    it("keeps user text that follows a huge run of leading plugin markup", () => {
        const markup = "<system-reminder>noise</system-reminder>".repeat(3000);
        const stripped = collectStrippedPromptPrefix(`${markup}\nthe real question survives`);
        expect(stripped).toContain("the real question survives");
    });

    it("pops the drop stack for closing tags padded with whitespace before the delimiter", () => {
        expect(
            collectStrippedPromptPrefix(
                "<instruction>noise</instruction >real searchable question",
            ).trim(),
        ).toBe("real searchable question");
        expect(
            collectStrippedPromptPrefix(
                "<system-reminder>noise</system-reminder\t > question survives",
            ).trim(),
        ).toBe("question survives");
        expect(
            collectStrippedPromptPrefix(
                "<instruction>noise</instruction\n> question survives",
            ).trim(),
        ).toBe("question survives");
    });

    it("drops blocks whose opening tag breaks to a new line before its attributes", () => {
        const stripped = collectStrippedPromptPrefix(
            '<instruction\nname="deferred_notes">SECRET NOISE</instruction> real question',
        );
        expect(stripped).not.toContain("SECRET NOISE");
        expect(stripped.trim()).toBe("real question");
    });

    it("handles a large run of orphan closers after nested openers without stalling", () => {
        // n openers of one drop tag followed by n closers of another: orphan
        // rejection must be constant-time or this input is quadratic.
        const n = 16_000;
        const raw = `${"<instruction>".repeat(n)}${"</system-reminder>".repeat(n)}question survives`;
        const startedAt = performance.now();
        const stripped = collectStrippedPromptPrefix(raw);
        const elapsedMs = performance.now() - startedAt;
        expect(stripped).toBe("");
        // Linear stripping finishes in single-digit milliseconds; the removed
        // quadratic path took ~1s. The bound is generous for slow CI hosts.
        expect(elapsedMs).toBeLessThan(500);
    });

    it("does not let separator whitespace between dropped blocks consume the byte budget", () => {
        // 20k newline separators exceed MAX_QUERY_BYTES on their own; they must
        // collapse instead of crowding out the trailing user text.
        const blocks = "<system-reminder>x</system-reminder>\n".repeat(20_000);
        const stripped = collectStrippedPromptPrefix(`${blocks}real searchable question`);
        expect(stripped).toBe("real searchable question");
    });
});

describe("extractBoundedAutoSearchQuery", () => {
    it("strips markers, collapses whitespace, and trims", () => {
        const query = extractBoundedAutoSearchQuery("§12§ hello   \nworld\n\n\n\nagain");
        expect(query).toBe("hello\nworld\n\nagain");
    });

    it("satisfies every query cap for oversized marked-up multibyte prompts", () => {
        const raw = [
            "<system-reminder>reminder</system-reminder>",
            `question about 🎉 ${"context ".repeat(30_000)}`,
        ].join("\n");
        const query = extractBoundedAutoSearchQuery(raw);
        expect(Buffer.byteLength(query, "utf8")).toBeLessThanOrEqual(MAX_QUERY_BYTES);
        expect(countQueryAtoms(query)).toBeLessThanOrEqual(MAX_QUERY_ATOMS);
        expect(estimateTokens(query)).toBeLessThanOrEqual(MAX_QUERY_TOKENS);
        expect(Buffer.from(query, "utf8").toString("utf8")).toBe(query);
        expect(query).toContain("question about 🎉");
    });

    it("is deterministic for identical prompts", () => {
        const raw = `<ctx-search-auto>x</ctx-search-auto> question ${"🎉".repeat(9000)}`;
        expect(extractBoundedAutoSearchQuery(raw)).toBe(extractBoundedAutoSearchQuery(raw));
    });
});
