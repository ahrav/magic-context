import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 *
 */

const PLUGIN_SRC = join(import.meta.dir, "..");
const SCAN_ROOTS = [
    PLUGIN_SRC,
    join(PLUGIN_SRC, "../../pi-plugin/src"),
    join(PLUGIN_SRC, "../../cli/src"),
].filter((dir) => existsSync(dir));
const ALLOWED = new Set(["shared/sqlite.ts", "shared/sqlite-bind-style.test.ts"]);
const BIND_PATTERN = /\.(run|get|all)\(\[/;

function collectTsFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            collectTsFiles(full, acc);
        } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
            acc.push(full);
        }
    }
    return acc;
}

describe("sqlite bind style", () => {
    it("uses spread positional binds, never the array form", () => {
        const violations: string[] = [];
        for (const root of SCAN_ROOTS) {
            for (const file of collectTsFiles(root)) {
                const rel = file.slice(root.length + 1);
                if (ALLOWED.has(rel)) continue;
                const lines = readFileSync(file, "utf8").split("\n");
                lines.forEach((line, i) => {
                    if (!BIND_PATTERN.test(line)) return;
                    // Promise.all([...]) is not a SQLite statement bind.
                    if (line.includes("Promise.all(")) return;
                    const trimmed = line.trim();
                    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
                    const pkg = root.includes("pi-plugin")
                        ? "pi-plugin"
                        : root.includes("cli")
                          ? "cli"
                          : "plugin";
                    violations.push(`${pkg}/${rel}:${i + 1}  ${trimmed}`);
                });
            }
        }
        expect(
            violations,
            `Array-form SQLite binds found — use spread positional .run(a, b) ` +
                `instead of .run([a, b]) (breaks under node:sqlite on Pi/Desktop):\n` +
                violations.join("\n"),
        ).toEqual([]);
    });
});
