import { describe, expect, it } from "bun:test";

import { exitStatus, soakInvocation } from "./run-shm-soak";

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
        const invocation = soakInvocation(["--hours", "5"]);
        expect(invocation.command).toContain("--release");
        expect(invocation.command).toContain(
            "long_soak_keeps_fd_mapping_thread_and_rss_envelopes_bounded",
        );
        expect(invocation.command.slice(-3)).toEqual(["--", "--ignored", "--exact"]);
        expect(invocation.environment).toEqual({ MC_SHM_SOAK_SECONDS: "18000" });
    });

    it("defaults to a duration the six-hour hosted-runner limit can hold", () => {
        expect(soakInvocation([]).environment).toEqual({ MC_SHM_SOAK_SECONDS: "18000" });
    });

    it("rejects missing, zero, negative, and nonnumeric durations", () => {
        for (const args of [["--hours"], ["--hours", "0"], ["--hours", "-1"], ["--hours", "x"]]) {
            expect(() => soakInvocation(args)).toThrow("--hours must be a positive number");
        }
    });

    it("rejects fractional durations that round down to zero seconds", () => {
        for (const hours of ["0.0001", "0.00013"]) {
            expect(() => soakInvocation(["--hours", hours])).toThrow(
                "--hours must resolve to at least one second",
            );
        }
        expect(soakInvocation(["--hours", "0.001"]).environment).toEqual({
            MC_SHM_SOAK_SECONDS: "4",
        });
    });

    it("reports a signal-terminated soak as a failure", () => {
        expect(exitStatus({ exitCode: null, signalCode: "SIGKILL" })).toBe(1);
        expect(exitStatus({ exitCode: 0 })).toBe(0);
        expect(exitStatus({ exitCode: 101 })).toBe(101);
    });
});
