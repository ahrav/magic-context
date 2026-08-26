import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = JSON.parse(
    readFileSync(
        join(root, "release/mc-host-production-input-sources.json"),
        "utf8",
    ),
) as {
    harnesses?: {
        opencode?: { closure_verify_roots?: Record<string, string> };
        pi?: { closure_verify_roots?: Record<string, string> };
    };
};
const opencode = source.harnesses?.opencode?.closure_verify_roots?.runtime;
const piInstall = source.harnesses?.pi?.closure_verify_roots?.["pi-install"];
const piRuntime = source.harnesses?.pi?.closure_verify_roots?.runtime;
if (
    typeof opencode !== "string" ||
    typeof piInstall !== "string" ||
    typeof piRuntime !== "string"
) {
    console.error("qualified closure source roots are missing");
    process.exit(1);
}

const result = Bun.spawnSync(
    [
        "cargo",
        "test",
        "-p",
        "mc-host",
        "--test",
        "harness_closure",
        "production_closures_from_environment_materialize",
        "--",
        "--ignored",
        "--exact",
        "--nocapture",
    ],
    {
        cwd: root,
        env: {
            ...process.env,
            MC_OPENCODE_CLOSURE_RUNTIME_ROOT: opencode,
            MC_PI_CLOSURE_INSTALL_ROOT: piInstall,
            MC_PI_CLOSURE_RUNTIME_ROOT: piRuntime,
        },
        stdout: "inherit",
        stderr: "inherit",
    },
);
process.exit(result.exitCode);
