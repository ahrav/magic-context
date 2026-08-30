import { describe, expect, it } from "bun:test";

import { soakInvocation } from "./run-shm-soak";

describe("shared-memory soak runner", () => {
    it("selects the checked short smoke without a duration override", () => {
        const invocation = soakInvocation(["--smoke"]);
        expect(invocation.command).toEqual([
            "cargo",
            "test",
            "-p",
            "mc-host",
            "--test",
            "shm_soak",
            "short_soak_keeps_fd_mapping_thread_and_rss_envelopes_bounded",
        ]);
        expect(invocation.environment).toEqual({});
    });

    it("selects the release soak and converts hours to seconds", () => {
        const invocation = soakInvocation(["--hours", "8"]);
        expect(invocation.command).toEqual([
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
        ]);
        expect(invocation.environment).toEqual({ MC_SHM_SOAK_SECONDS: "28800" });
    });

    it("rejects missing, zero, negative, and nonnumeric durations", () => {
        for (const args of [["--hours"], ["--hours", "0"], ["--hours", "-1"], ["--hours", "x"]]) {
            expect(() => soakInvocation(args)).toThrow("--hours must be a positive number");
        }
    });
});
