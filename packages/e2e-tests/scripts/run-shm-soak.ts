#!/usr/bin/env bun

import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

const SHORT_SOAK = "short_soak_keeps_fd_mapping_thread_and_rss_envelopes_bounded";
const LONG_SOAK = "long_soak_keeps_fd_mapping_thread_and_rss_envelopes_bounded";
const DEFAULT_HOURS = 5;

export type SoakInvocation = {
    command: string[];
    environment: Record<string, string>;
};

export type SoakResult = {
    exitCode: number | null;
    signalCode?: string | number | null;
};

export function soakInvocation(args: string[]): SoakInvocation {
    const smoke = args.includes("--smoke");
    const hoursAt = args.indexOf("--hours");
    const hours = hoursAt >= 0 ? Number(args[hoursAt + 1]) : DEFAULT_HOURS;
    if (!smoke) {
        if (!Number.isFinite(hours) || hours <= 0) {
            throw new Error("--hours must be a positive number");
        }
        // `Math.round` maps values below 0.5 seconds to zero, which the test
        // binary rejects.
        if (Math.round(hours * 3600) < 1) {
            throw new Error("--hours must resolve to at least one second");
        }
    }

    return {
        command: smoke
            ? ["cargo", "test", "-p", "mc-host", "--test", "shm_soak", SHORT_SOAK]
            : [
                  "cargo",
                  "test",
                  "--release",
                  "-p",
                  "mc-host",
                  "--test",
                  "shm_soak",
                  LONG_SOAK,
                  "--",
                  "--ignored",
                  "--exact",
              ],
        environment: smoke
            ? {}
            : { MC_SHM_SOAK_SECONDS: String(Math.round(hours * 3600)) },
    };
}

/**
 * A signal-terminated child reports a null exit code. `process.exit(null)`
 * exits 0, so signal-terminated children return 1.
 */
export function exitStatus(result: SoakResult): number {
    if (typeof result.exitCode === "number") {
        return result.exitCode;
    }
    return 1;
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
    if (typeof result.exitCode !== "number") {
        console.error(`soak terminated by signal ${String(result.signalCode)}`);
    }
    process.exit(exitStatus(result));
}
