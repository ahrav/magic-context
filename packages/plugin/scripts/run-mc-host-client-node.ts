import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRIES = {
    adversarial: "run-mc-host-client-adversarial.ts",
    smoke: "smoke-mc-host-client.ts",
} as const;

const mode = process.argv[2] ?? "all";
if (mode !== "adversarial" && mode !== "smoke" && mode !== "all") {
    console.error(`usage: run-mc-host-client-node.ts [adversarial|smoke|all] (got "${mode}")`);
    process.exit(2);
}
const selected = mode === "all" ? (["adversarial", "smoke"] as const) : ([mode] as const);

const here = dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), "mc-host-client-node-"));
let exitCode = 0;
try {
    for (const name of selected) {
        const entry = join(here, ENTRIES[name]);
        console.log(`node-launcher: bundling ${ENTRIES[name]}`);
        const result = await Bun.build({
            entrypoints: [entry],
            outdir: join(outDir, name),
            target: "node",
            format: "esm",
        });
        if (!result.success) {
            console.error(`node-launcher: bundle failed: ${result.logs.map(String).join("; ")}`);
            exitCode = 1;
            break;
        }
        const artifact = result.outputs.find((output) => output.path.endsWith(".js"))?.path;
        if (!artifact) {
            console.error("node-launcher: bundle produced no .js artifact");
            exitCode = 1;
            break;
        }
        console.log(`node-launcher: running ${basename(artifact)} (${name}) under node`);
        const run = spawnSync("node", [artifact], { stdio: "inherit" });
        if (run.status !== 0) {
            console.error(
                `node-launcher: ${name} failed under node (status=${run.status}, signal=${run.signal})`,
            );
            exitCode = run.status ?? 1;
            break;
        }
    }
} finally {
    rmSync(outDir, { recursive: true, force: true });
}
process.exit(exitCode);
