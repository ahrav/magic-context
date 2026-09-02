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

function scan(
    files: Record<string, string>,
    env?: Record<string, string>,
): { code: number; out: string } {
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
            env: { ...process.env, ...env },
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

    test("a nested Rust block comment stays open until its outer close", () => {
        const result = scan({
            "nest.rs": "/* outer /* nested */ tracked in magic-context-om3y */",
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain("nest.rs:1:");
    });

    test("a product name whose suffix names no task stays clean", () => {
        const result = scan({
            "prod.ts": [
                "// Configure magic-context-pi before startup",
                "// The magic-context-next module handles it",
                "// `--magic-context-dreamer-actions` registers the dreamer surface",
            ].join("\n"),
        });

        expect(result.out).toBe("");
        expect(result.code).toBe(0);
    });

    test("sentence punctuation does not hide a short ID", () => {
        const result = scan({ "dot.rs": `// tracked in ${exportedDottedId()}.` });

        expect(result.code).toBe(1);
        expect(result.out).toContain("dot.rs:1:");
    });

    test("a hash inside a word or scalar is runtime data", () => {
        const result = scan({
            "word.sh": 'printf "%s" foo#magic-context-om3y',
            "scalar.yml": "key: foo#magic-context-om3y",
        });

        expect(result.out).toBe("");
        expect(result.code).toBe(0);
    });

    test("a label followed by a comment is still a comment", () => {
        const result = scan({ "label.ts": "outer:// tracked in magic-context-om3y" });

        expect(result.code).toBe(1);
        expect(result.out).toContain("label.ts:1:");
    });

    test("manifest comments and single-digit tickets are in scope", () => {
        const result = scan({
            "probe.toml": "# tracked in magic-context-om3y",
            "tick.rs": "// tracked in PR-7",
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain("probe.toml:1:");
        expect(result.out).toContain("tick.rs:1:");
    });

    test("a lowercase external tracker reference matches", () => {
        const result = scan({ "lower.rs": "// see jira-4821, pr-42 fixed this" });

        expect(result.code).toBe(1);
        expect(result.out).toContain("lower.rs:1:");
    });

    test("a name appearing only in issue prose is not an ID", () => {
        const result = scan({ "prose.rs": "// the magic-context-native ring is separate" });

        expect(result.out).toBe("");
        expect(result.code).toBe(0);
    });

    test("a bare all-letter ID is exempt but its prefixed spelling is not", () => {
        const result = scan({
            "word.rs": [
                "// `inherit_fds` retains descriptors referenced by child path arguments",
                "// tracked in magic-context-fds",
            ].join("\n"),
        });

        expect(result.code).toBe(1);
        expect(result.out).not.toContain("word.rs:1:");
        expect(result.out).toContain("word.rs:2:");
    });

    test("Python and TOML need no whitespace before the delimiter", () => {
        const result = scan({
            "inline.py": "value = 1# tracked in magic-context-om3y",
            "inline.toml": "key = 1# tracked in magic-context-om3y",
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain("inline.py:1:");
        expect(result.out).toContain("inline.toml:1:");
    });

    test("a Rust raw string keeps its contents out of scope", () => {
        const result = scan({
            "raw.rs": [
                'let fixture = r#"runtime " // magic-context-om3y"#;',
                'let plain = r"also // magic-context-om3y";',
            ].join("\n"),
        });

        expect(result.out).toBe("");
        expect(result.code).toBe(0);
    });

    test("a Rust character literal does not hide the comment after it", () => {
        const result = scan({
            "char.rs": [
                `let quote = '"'; // tracked in magic-context-om3y`,
                `let esc = '\\''; // tracked in magic-context-om3y`,
            ].join("\n"),
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain("char.rs:1:");
        expect(result.out).toContain("char.rs:2:");
    });

    test("an escaped shell apostrophe does not hide the comment after it", () => {
        const result = scan({
            "esc.sh": "value='can'\\''t' # tracked in magic-context-om3y",
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain("esc.sh:1:");
    });

    test("a multi-line template literal keeps its contents out of scope", () => {
        const result = scan({
            "multi.ts": [
                "const s = `line one",
                "// see magic-context-om3y here",
                "still string`;",
                "// tracked in magic-context-om3y",
            ].join("\n"),
        });

        expect(result.code).toBe(1);
        expect(result.out).not.toContain("multi.ts:2:");
        expect(result.out).toContain("multi.ts:4:");
    });

    test("an external tracker reference needs an end boundary", () => {
        const result = scan({
            "tok.rs": [
                "// the sim-2d transform is stable",
                "// decode jira-2fa as hexadecimal",
                "// the pr-7zip archive",
            ].join("\n"),
        });

        expect(result.out).toBe("");
        expect(result.code).toBe(0);
    });

    test("CommonJS sources are in scope", () => {
        const result = scan({ "probe.cjs": "// tracked in magic-context-om3y" });

        expect(result.code).toBe(1);
        expect(result.out).toContain("probe.cjs:1:");
    });

    test("a multi-line Rust raw string keeps its contents out of scope", () => {
        const result = scan({
            "rawmulti.rs": [
                'let json = r#"{',
                "// see magic-context-om3y inside runtime data",
                '}"#;',
                "// tracked in magic-context-om3y",
            ].join("\n"),
        });

        expect(result.code).toBe(1);
        expect(result.out).not.toContain("rawmulti.rs:2:");
        expect(result.out).toContain("rawmulti.rs:4:");
    });

    test("a comment inside a template substitution is in scope", () => {
        const result = scan({
            "subst.ts": [
                "const s = `a${",
                "// tracked in magic-context-om3y",
                "x}b`;",
            ].join("\n"),
            "block.ts": "const v = `${1 /* tracked in magic-context-om3y */}`;",
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain("subst.ts:2:");
        expect(result.out).toContain("block.ts:1:");
    });

    test("the caller can supply the ID export", () => {
        const dir = mkdtempSync(join(tmpdir(), "comment-gate-ids-"));
        try {
            const ids = join(dir, "issues.jsonl");
            writeFileSync(ids, '{"id":"magic-context-zz9.7","title":"probe"}\n');
            const cite = { "ids.rs": "// see zz9.7 for the plan" };

            expect(scan(cite).code).toBe(0);

            const supplied = scan(cite, { COMMENT_CHECK_IDS: ids });
            expect(supplied.code).toBe(1);
            expect(supplied.out).toContain("ids.rs:1:");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("a shell comment may follow a control operator", () => {
        const result = scan({
            "op.sh": "true;# tracked in magic-context-om3y",
            "op.ps1": 'Write-Host "x";# tracked in magic-context-om3y',
            "scalar.yml": "key: foo#magic-context-om3y",
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain("op.sh:1:");
        expect(result.out).toContain("op.ps1:1:");
        expect(result.out).not.toContain("scalar.yml:1:");
    });

    test("JSONC and CSS comments are in scope, and a CSS url is not one", () => {
        const result = scan({
            "w.jsonc": '{\n  // tracked in magic-context-om3y\n  "a": 1\n}',
            "s.css": "/* tracked in magic-context-om3y */",
            "url.css": ".a { background: url(https://example.com/x/magic-context-om3y) }",
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain("w.jsonc:2:");
        expect(result.out).toContain("s.css:1:");
        expect(result.out).not.toContain("url.css:1:");
    });

    test("a regex literal holding a block delimiter does not open a comment", () => {
        const result = scan({
            "re.ts": [
                "const P = /(?:^|[^\\w./*-])((?:\\/[^/\\r\\n]+)+)/g;",
                'const id = "magic-context-om3y";',
                "// tracked in magic-context-om3y",
            ].join("\n"),
            "div.ts": "const r = (a + b) / 2; // tracked in magic-context-om3y",
        });

        expect(result.code).toBe(1);
        expect(result.out).not.toContain("re.ts:2:");
        expect(result.out).toContain("re.ts:3:");
        expect(result.out).toContain("div.ts:1:");
    });

    test("an apostrophe in markup text does not hide a trailing comment", () => {
        const result = scan({
            "jsx.tsx": "return <p>Don't ship this</p>; // tracked in magic-context-om3y",
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain("jsx.tsx:1:");
    });

    test("the suppression ban ignores casing", () => {
        const result = scan({ "case.rs": "// CommentLint: Allow(JUDGE)" });

        expect(result.code).toBe(1);
        expect(result.out).toContain("suppression on disk: ");
    });

    test("multi-line literal bodies in hash-comment languages are out of scope", () => {
        const result = scan({
            "tq.py": 'S = """\n# see magic-context-om3y in runtime data\n"""\n# tracked in magic-context-om3y',
            "tq.toml": 's = """\n# see magic-context-om3y in runtime data\n"""\n# tracked in magic-context-om3y',
            "hd.sh": "cat <<EOF\n# see magic-context-om3y in runtime data\nEOF\n# tracked in magic-context-om3y",
        });

        expect(result.code).toBe(1);
        for (const name of ["tq.py", "tq.toml", "hd.sh"]) {
            expect(result.out).not.toContain(`${name}:2:`);
            expect(result.out).toContain(`${name}:4:`);
        }
    });

    test("a plain number matching a legacy ID is not a citation", () => {
        const result = scan({
            "num.rs": [
                "// retry after 456 requests",
                "// timeout 237ms, port 515",
                "// tracked in magic-context-456",
            ].join("\n"),
        });

        expect(result.code).toBe(1);
        expect(result.out).not.toContain("num.rs:1:");
        expect(result.out).not.toContain("num.rs:2:");
        expect(result.out).toContain("num.rs:3:");
    });

    test("a shell apostrophe does not escape, so the comment after it is read", () => {
        const result = scan({ "bs.sh": "sep='\\' # commentlint: allow(JUDGE)" });

        expect(result.code).toBe(1);
        expect(result.out).toContain("suppression on disk: ");
        expect(result.out).toContain("bs.sh:1:");
    });

    test("an arithmetic shift is not a heredoc operator", () => {
        const result = scan({
            "shift.sh": "value=$((1 << 2))\n# tracked in magic-context-om3y",
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain("shift.sh:2:");
    });

    test("a regex may follow an expression keyword", () => {
        const result = scan({
            "kw.ts": 'function quote() { return /"/; } // tracked in magic-context-om3y',
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain("kw.ts:1:");
    });

    test("closing a nested template leaves the outer one open", () => {
        const result = scan({
            "nest.ts": "const v = `outer ${`inner`} rest`; // tracked in magic-context-om3y",
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain("nest.ts:1:");
    });

    test("PowerShell block comments and here-strings are handled", () => {
        const result = scan({
            "blk.ps1": "<#\n tracked in magic-context-om3y\n#>",
            "here.ps1": '$f = @"\n# runtime magic-context-om3y\n"@\n# tracked in magic-context-om3y',
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain("blk.ps1:2:");
        expect(result.out).not.toContain("here.ps1:2:");
        expect(result.out).toContain("here.ps1:4:");
    });

    test("a raw C-string and an unquoted locator are runtime data", () => {
        const result = scan({
            "crs.rs": 'let _ = cr#"runtime " // magic-context-om3y"#;',
            "url.tsx": "return <p>See https://magic-context-om3y/docs</p>;",
        });

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

    // A whole-tree scan needs a bound above the per-test default on a slow host.
    test("the repository is clean", () => {
        const run = spawnSync("sh", [gate], { cwd: repoRoot, encoding: "utf8" });

        expect(`${run.stdout}${run.stderr}`).toBe("");
        expect(run.status).toBe(0);
    }, 120_000);
});
