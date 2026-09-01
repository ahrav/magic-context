/// Bun's test declarations require bun-types.

//
//

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_SRC = join(__dirname, "..", "..", "src");

/**
 * */
function walkSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist") continue;
        const full = join(dir, entry);
        const s = statSync(full);
        if (s.isDirectory()) {
            walkSourceFiles(full, out);
        } else if (
            s.isFile() &&
            entry.endsWith(".ts") &&
            !entry.endsWith(".test.ts") &&
            !entry.endsWith(".gen.ts")
        ) {
            out.push(full);
        }
    }
    return out;
}

/**
 * */
function findSessionMessagesCalls(source: string): string[] {
    const calls: string[] = [];
    const needle = "session.messages(";
    let i = 0;
    while (true) {
        const idx = source.indexOf(needle, i);
        if (idx === -1) break;
        const lineStart = source.lastIndexOf("\n", idx) + 1;
        const linePrefix = source.slice(lineStart, idx).trimStart();
        if (linePrefix.startsWith("//") || linePrefix.startsWith("*")) {
            i = idx + needle.length;
            continue;
        }
        // brace/bracket/paren nesting.
        let depth = 1;
        let j = idx + needle.length;
        while (j < source.length && depth > 0) {
            const ch = source[j];
            if (ch === "(" || ch === "{" || ch === "[") depth++;
            else if (ch === ")" || ch === "}" || ch === "]") depth--;
            j++;
        }
        if (depth === 0) {
            calls.push(source.slice(idx, j));
        }
        i = j;
    }
    return calls;
}

describe("session.messages() callsites must include query.limit", () => {
    const files = walkSourceFiles(PLUGIN_SRC);
    const violations: Array<{ file: string; callText: string }> = [];

    for (const file of files) {
        if (file.endsWith("session-messages-bounded.test.ts")) continue;
        const source = readFileSync(file, "utf-8");
        const calls = findSessionMessagesCalls(source);
        for (const call of calls) {
            // The static check accepts `limit` anywhere in the call text, not only in `query`.
            if (!/\blimit\b/.test(call)) {
                violations.push({ file: file.replace(PLUGIN_SRC, "<plugin>/src"), callText: call });
            }
        }
    }

    it("has no unbounded session.messages() calls in plugin code", () => {
        if (violations.length > 0) {
            const report = violations
                .map(
                    (v) =>
                        `\n  in ${v.file}:\n    ${v.callText.replace(/\n/g, "\n    ").slice(0, 300)}`,
                )
                .join("\n");
            throw new Error(
                `Found ${violations.length} unbounded session.messages() call(s). ` +
                    `Add \`limit: 50\` (or appropriate bound) to query.${report}`,
            );
        }
        expect(violations).toEqual([]);
    });
});
