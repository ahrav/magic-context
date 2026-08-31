// This smoke test verifies that the bundled smart-note sandbox loads QuickJS.
//
// `bun test` cannot detect a missing `emscripten-module.wasm` beside the bundle because it resolves QuickJS from `node_modules`.
// The `wasmfile` variant loads sibling `emscripten-module.wasm` through `new URL(..., import.meta.url)`.
// `new URL(..., import.meta.url)` in `dist/index.js` resolves to `dist/emscripten-module.wasm`.
// The missing file causes sandbox runs to fail with ENOENT.
//
// The smoke fails when the bundle omits the QuickJS wasm.
// An import or execution error fails the smoke.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "../src/features/magic-context/smart-notes/sandbox-runner.ts");
const outDir = mkdtempSync(join(tmpdir(), "mc-smartnote-wasm-smoke-"));

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
    // The production ESM/Node build settings make QuickJS use the production bundling transform.
    const result = await Bun.build({
        entrypoints: [entry],
        outdir: outDir,
        target: "node",
        format: "esm",
    });
    check("sandbox-runner bundles cleanly", result.success, result.logs.map(String).join("; "));
    if (!result.success) throw new Error("bundle failed");

    const bundlePath = result.outputs.find((o) => o.path.endsWith(".js"))?.path;
    check("bundle emitted a js file", Boolean(bundlePath));
    if (!bundlePath) throw new Error("no bundle output");

    // The bundle must not require a sibling `.wasm` file at runtime.
    // The `singlefile` variant inlines the WASM in the bundle.
    const mod = (await import(bundlePath)) as {
        runCompiledSmartNoteCheck: (opts: unknown) => Promise<{ ok: boolean; result?: unknown }>;
    };
    check("runCompiledSmartNoteCheck is exported from bundle", typeof mod.runCompiledSmartNoteCheck === "function");

    const fakeCap = {
        readFile: async (path: string) => (path === "ready.txt" ? "ready" : null),
        gitHeadSha: async () => "abc123",
        gitTag: async () => "v1.2.3",
        gitLog: async () => [],
        httpGet: async () => ({ status: 200, body: "ok" }),
    };
    const res = await mod.runCompiledSmartNoteCheck({
        compiledCheck: `function check(cap) { return { met: cap.readFile("ready.txt") === "ready" }; }`,
        capabilities: fakeCap,
    });
    check(
        "bundled sandbox runs a check (wasm loads from the bundle, no ENOENT)",
        res.ok === true && JSON.stringify(res.result) === JSON.stringify({ met: true }),
        JSON.stringify(res),
    );
} catch (error) {
    failures++;
    console.log(`FAIL  bundle-path smoke threw — ${error instanceof Error ? error.message : String(error)}`);
} finally {
    rmSync(outDir, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`\n${failures} smoke check(s) failed`);
    process.exit(1);
}
console.log("\nAll smart-note wasm bundle-path smoke checks passed.");
