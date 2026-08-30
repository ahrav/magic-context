#!/usr/bin/env bun

import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

export type SoakInvocation = {
    command: string[];
    environment: Record<string, string>;
};

export function soakInvocation(args: string[]): SoakInvocation {
    const smoke = args.includes("--smoke");
    const hoursAt = args.indexOf("--hours");
    const hours = hoursAt >= 0 ? Number(args[hoursAt + 1]) : 8;
    if (!smoke && (!Number.isFinite(hours) || hours <= 0)) {
        throw new Error("--hours must be a positive number");
    }

    return {
        command: smoke
            ? [
                  "cargo",
                  "test",
                  "-p",
                  "mc-host",
                  "--test",
                  "shm_soak",
                  "short_soak_keeps_fd_mapping_thread_and_rss_envelopes_bounded",
              ]
            : [
                  "cargo",
                  "test",
                  "--release",
                  "-p",
                  "mc-host",
                  "--test",
                  "shm_soak",
                  "release_eight_hour_source_tree_soak",
                  "--",
                  "--ignored",
                  "--exact",
              ],
        environment: smoke
            ? {}
            : { MC_SHM_SOAK_SECONDS: String(Math.round(hours * 3600)) },
    };
}

if (import.meta.main) {
    let invocation: SoakInvocation;
    try {
        invocation = soakInvocation(Bun.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(2);
    }
    const result = Bun.spawnSync({
        cmd: invocation.command,
        cwd: repoRoot,
        env: { ...process.env, ...invocation.environment },
        stdout: "inherit",
        stderr: "inherit",
    });
    process.exit(result.exitCode);
}
