import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(join(here, ".mc-shm-node-"));
let exitCode = 1;
try {
    const build = await Bun.build({
        entrypoints: [join(here, "check-mc-shm.ts")],
        outdir: outDir,
        target: "node",
        format: "esm",
        external: ["@magic-context/mc-shm-native"],
    });
    if (!build.success) {
        console.error(build.logs.map(String).join("; "));
    } else {
        const artifact = build.outputs.find((output) => output.path.endsWith(".js"))?.path;
        if (!artifact) throw new Error("Node shared-memory check produced no JavaScript");
        const run = spawnSync("node", ["--experimental-transform-types", artifact], {
            stdio: "inherit",
        });
        exitCode = run.status ?? 1;
    }
} finally {
    rmSync(outDir, { recursive: true, force: true });
}
process.exit(exitCode);
