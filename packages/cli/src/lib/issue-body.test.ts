import { describe, expect, it } from "bun:test";
import { capBodyToGithubLimit, extractRecentErrors, MAX_GITHUB_BODY_BYTES } from "./issue-body";

describe("extractRecentErrors", () => {
    it("matches the documented sessionLog error shapes", () => {
        const log = [
            "2026-05-20 12:00:00 [INFO] transform completed in 42ms",
            "2026-05-20 12:00:01 [INFO] historian: 12 compartments published; 0 failed", // telemetry, NOT an error
            "2026-05-20 12:00:02 transform failed: SQLITE_BUSY",
            "2026-05-20 12:00:03 historian prompt failed: connection refused",
            "2026-05-20 12:00:04 Error: Connection reset",
            "2026-05-20 12:00:05 TypeError: cannot read property 'foo' of undefined",
            "2026-05-20 12:00:06 EMERGENCY: aborting session ses_abc",
            "2026-05-20 12:00:07 some other info line",
            "2026-05-20 12:00:08 caught exception during cleanup",
        ].join("\n");

        const matches = extractRecentErrors(log, 20);

        // `extractRecentErrors` excludes `0 failed` telemetry.
        expect(matches).toContain("2026-05-20 12:00:02 transform failed: SQLITE_BUSY");
        expect(matches).toContain(
            "2026-05-20 12:00:03 historian prompt failed: connection refused",
        );
        expect(matches).toContain("2026-05-20 12:00:04 Error: Connection reset");
        expect(matches).toContain(
            "2026-05-20 12:00:05 TypeError: cannot read property 'foo' of undefined",
        );
        expect(matches).toContain("2026-05-20 12:00:06 EMERGENCY: aborting session ses_abc");
        expect(matches).toContain("2026-05-20 12:00:08 caught exception during cleanup");
        expect(matches).not.toContain(
            "2026-05-20 12:00:01 [INFO] historian: 12 compartments published; 0 failed",
        );
        expect(matches).not.toContain("2026-05-20 12:00:07 some other info line");
    });

    it("matches V8 stack-trace frames", () => {
        const log = [
            "Error: thing broke",
            "    at SomeFn (file:///foo.ts:42:5)",
            "    at processTransform (file:///bar.ts:13:9)",
            "    at file:///baz.ts:7:1",
        ].join("\n");

        const matches = extractRecentErrors(log, 20);
        expect(matches.length).toBe(4);
    });

    it("returns matches in chronological order", () => {
        const log = [
            "transform failed: first error",
            "info noise",
            "transform failed: second error",
            "info noise",
            "transform failed: third error",
        ].join("\n");

        const matches = extractRecentErrors(log, 10);
        expect(matches).toEqual([
            "transform failed: first error",
            "transform failed: second error",
            "transform failed: third error",
        ]);
    });

    it("caps at the requested limit (newest-first selection, oldest-first output)", () => {
        const lines: string[] = [];
        for (let i = 0; i < 50; i += 1) {
            lines.push(`transform failed: error ${i}`);
        }
        const matches = extractRecentErrors(lines.join("\n"), 5);
        expect(matches.length).toBe(5);
        expect(matches[0]).toBe("transform failed: error 45");
        expect(matches[4]).toBe("transform failed: error 49");
    });

    it("returns empty array when no errors found", () => {
        const log = ["info line 1", "info line 2", "transform completed in 42ms"].join("\n");
        expect(extractRecentErrors(log, 20)).toEqual([]);
    });

    it("handles empty input gracefully", () => {
        expect(extractRecentErrors("", 20)).toEqual([]);
    });
});

describe("capBodyToGithubLimit", () => {
    /**
     * Tests that require truncation use enough log lines to exceed the requested budget.
     */
    function makeBody(opts: { logLineCount: number; lineSize?: number }): string {
        const lineSize = opts.lineSize ?? 80;
        const logLines: string[] = [];
        for (let i = 0; i < opts.logLineCount; i += 1) {
            // Line indexes identify content retained after truncation.
            const prefix = `LINE${String(i).padStart(6, "0")}: `;
            const padding = "x".repeat(Math.max(0, lineSize - prefix.length));
            logLines.push(prefix + padding);
        }

        return [
            "## Description",
            "Test description for the cap helper.",
            "",
            "## Environment",
            "- Plugin: v0.21.5",
            "",
            "## Recent errors (last 20, sanitized)",
            "```",
            "transform failed: critical error 1",
            "transform failed: critical error 2",
            "```",
            "",
            "## Log (last 400 lines, sanitized)",
            "```",
            logLines.join("\n"),
            "```",
        ].join("\n");
    }

    it("returns body unchanged when already within budget", () => {
        const body = makeBody({ logLineCount: 20 });
        const capped = capBodyToGithubLimit(body, 100_000);
        expect(capped).toBe(body);
    });

    it("truncates the main log section when body exceeds budget", () => {
        const body = makeBody({ logLineCount: 5000, lineSize: 200 });
        const originalBytes = Buffer.byteLength(body, "utf8");

        const capped = capBodyToGithubLimit(body, 60_000);
        const cappedBytes = Buffer.byteLength(capped, "utf8");

        expect(cappedBytes).toBeLessThanOrEqual(60_000);
        expect(cappedBytes).toBeLessThan(originalBytes);
    });

    it("preserves the Recent errors section after truncation", () => {
        const body = makeBody({ logLineCount: 5000, lineSize: 200 });
        const capped = capBodyToGithubLimit(body, 60_000);

        // The errors section survives truncation.
        expect(capped).toContain("## Recent errors (last 20, sanitized)");
        expect(capped).toContain("transform failed: critical error 1");
        expect(capped).toContain("transform failed: critical error 2");
    });

    it("inserts the truncation marker when log lines are dropped", () => {
        const body = makeBody({ logLineCount: 5000, lineSize: 200 });
        const capped = capBodyToGithubLimit(body, 60_000);

        expect(capped).toContain("[truncated for GitHub 64KB limit");
    });

    it("drops oldest log lines first (keeps newest)", () => {
        const body = makeBody({ logLineCount: 5000, lineSize: 200 });
        const capped = capBodyToGithubLimit(body, 60_000);

        expect(capped).toContain("LINE004999:");

        // The first log line (LINE000000) should be gone — it's the oldest.
        expect(capped).not.toContain("LINE000000:");
    });

    it("preserves the Description and Environment sections", () => {
        const body = makeBody({ logLineCount: 5000, lineSize: 200 });
        const capped = capBodyToGithubLimit(body, 60_000);

        expect(capped).toContain("## Description");
        expect(capped).toContain("Test description for the cap helper.");
        expect(capped).toContain("## Environment");
        expect(capped).toContain("- Plugin: v0.21.5");
    });

    it("uses MAX_GITHUB_BODY_BYTES as the default budget", () => {
        // The 5000-line log exceeds the default 60 KB budget.
        const body = makeBody({ logLineCount: 5000, lineSize: 80 });
        const capped = capBodyToGithubLimit(body);
        expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(MAX_GITHUB_BODY_BYTES);
    });

    it("hard-truncates the tail when non-log sections alone exceed the budget", () => {
        const hugeDescription = "x".repeat(80_000);
        const body = [
            "## Description",
            hugeDescription,
            "",
            "## Recent errors (last 20, sanitized)",
            "```",
            "transform failed: critical error",
            "```",
            "",
            "## Log (last 1 lines, sanitized)",
            "```",
            "tiny log",
            "```",
        ].join("\n");

        const capped = capBodyToGithubLimit(body, 10_000);
        expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(10_000);
        expect(capped).toContain("[truncated further to fit GitHub body limit]");
    });
    it("falls back to raw byte truncation when log heading is missing", () => {
        // Non-ASCII padding verifies that UTF-8 boundary handling preserves valid text.
        const body = `## Other\n${"ü".repeat(50_000)}\n## End`;
        const capped = capBodyToGithubLimit(body, 10_000);
        expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(10_000);
        expect(capped).toContain("[truncated for GitHub 64KB limit]");
    });
});
