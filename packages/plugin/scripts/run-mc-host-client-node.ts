import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRIES = {
    smoke: "smoke-mc-host-client.ts",
    synapse: "smoke-mc-host-synapse.ts",
} as const;

const mode = process.argv[2] ?? "smoke";
if (mode !== "smoke" && mode !== "synapse" && mode !== "all") {
    console.error(
        `usage: run-mc-host-client-node.ts [smoke|synapse|all] (got "${mode}")`,
    );
    process.exit(2);
}
// `synapse` requires a native ONNX Runtime library, so the default launcher runs only `smoke`. commentlint: allow(JUDGE)
const selected = mode === "all" ? (["smoke", "synapse"] as const) : ([mode] as const);

const here = dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(join(here, ".mc-host-client-node-"));
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
            external: ["@cortexkit/mc-shm-native"],
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
