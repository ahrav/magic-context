import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const gate = join(repoRoot, "scripts", "check-comments.sh");

// The short-form lookup only recognizes exported IDs, so the fixtures cite a real
// one drawn from the export rather than an invented token.
function exportedDottedId(): string {
    const export_ = readFileSync(join(repoRoot, ".beads", "issues.jsonl"), "utf8");
    for (const match of export_.matchAll(/magic-context-([a-z0-9]{2,4}\.[0-9]+)\b/g)) {
        return match[1]!;
    }
    throw new Error("the ID export holds no dotted short form");
}

function scan(files: Record<string, string>): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), "comment-gate-"));
    try {
        const paths = Object.entries(files).map(([name, body]) => {
            const path = join(dir, name);
            writeFileSync(path, body);
            return path;
        });
        const run = spawnSync("sh", [gate, ...paths], {
            cwd: repoRoot,
            encoding: "utf8",
        });
        return { code: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe("comment hygiene gate", () => {
    test("reads comment text past the line margin", () => {
        const result = scan({
            "a.rs": [
                "let value = 1; // tracked in magic-context-om3y",
                "/*",
                "   plan lives in magic-context-om3y",
                "*/",
            ].join("\n"),
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain("a.rs:1:");
        expect(result.out).toContain("a.rs:3:");
    });

    test("an allowed token elsewhere on the line cannot hide an ID", () => {
        const dotted = exportedDottedId();
        const result = scan({
            "b.rs": [
                `// see ${dotted} in resolve.rs for details`,
                "// tracked in magic-context-om3y, see rfc7231 and p99.9",
            ].join("\n"),
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain("b.rs:1:");
        expect(result.out).toContain("b.rs:2:");
    });

    test("a Rust lifetime does not hide the comment after it", () => {
        const result = scan({
            "life.rs": "fn borrow<'a>(value: &str) { // tracked in magic-context-om3y",
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain("life.rs:1:");
    });

    test("a dotted token sharing a real ID stem stays clean", () => {
        const stem = exportedDottedId().split(".")[0]!;
        const result = scan({ "stem.rs": `// the RFC cites ${stem}.999999 in the spec` });

        expect(result.out).toBe("");
        expect(result.code).toBe(0);
    });

    test("prose, product names, and string literals stay clean", () => {
        const result = scan({
            "c.ts": [
                "// config abc.12 defines a decimal field",
                "// rule 7, step 3, v2.1, sec2, and p99.9 are citations",
                "// `--magic-context-dreamer-actions` registers the dreamer surface",
                "// magic-context-owned lineage survives cleanup",
                'const u = "https://example.com/x/magic-context-om3y";',
            ].join("\n"),
        });

        expect(result.out).toBe("");
        expect(result.code).toBe(0);
    });

    test("workflow comments carry the same rules", () => {
        const result = scan({
            "d.yml": [
                "# a note with commentlint: allow(JUDGE)",
                'key: "a value with a # inside a string"',
            ].join("\n"),
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain("suppression on disk: ");
        expect(result.out).toContain("d.yml:1:");
        expect(result.out).not.toContain("d.yml:2:");
    });

    test("an unreadable input fails instead of reporting a clean scan", () => {
        const run = spawnSync("sh", [gate, "/nonexistent/path.rs"], {
            cwd: repoRoot,
            encoding: "utf8",
        });

        expect(run.status).toBe(2);
        expect(`${run.stdout}${run.stderr}`).toContain("cannot read");
    });

    test("the repository is clean", () => {
        const run = spawnSync("sh", [gate], { cwd: repoRoot, encoding: "utf8" });

        expect(`${run.stdout}${run.stderr}`).toBe("");
        expect(run.status).toBe(0);
    });
});
