//
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "../src/tui/entry.mjs");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

try {
    const mod = (await import(entry)) as { default?: { id?: string; tui?: unknown } };
    check("TUI loader imports through the raw-TSX fallback", true);
    check(
        "exports the { id, tui } plugin shape",
        mod.default?.id === "opencode-magic-context" && typeof mod.default?.tui === "function",
        `got id=${mod.default?.id} tui=${typeof mod.default?.tui}`,
    );
} catch (error) {
    check(
        "TUI loader imports through the raw-TSX fallback",
        false,
        error instanceof Error ? error.message : String(error),
    );
}

if (failures > 0) {
    console.error(`\nsmoke-tui-import: ${failures} check(s) failed`);
    process.exit(1);
}
console.log("\nsmoke-tui-import: all checks passed");
