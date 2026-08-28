import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NativeLaunchError, runNativeLifecycle } from "./native-launcher";

const SECRET = "hunter2-credential-canary";

let counter = 0;

function scriptBinary(dir: string, body: string): string {
    counter += 1;
    const file = path.join(dir, `fake-ck-mc-host-${counter}.sh`);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o700);
    return file;
}

function probeResultJson(ok: boolean): string {
    return JSON.stringify({
        schema: "magic-context.daemon/v1",
        // The `probe` argv is answered as `status`: that is the contracted name
        // for the read-only observation, and the command union has no `probe`.
        command: "status",
        ok,
        state: ok ? "running" : "stopped",
        reason: ok ? "healthy" : "not_running",
        remediation: ok ? null : "run_daemon_start",
        effects: null,
        readiness: null,
        checks: [],
        versions: {
            release: "0.38.0",
            proof: null,
            daemon: null,
            magic_context: null,
            synapse: null,
            broca: null,
        },
    });
}

describe("native launcher output handling (U3 scenario 17)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mc-native-launcher-"));
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

    test("a conforming single JSON object with agreeing exit parses", async () => {
        const binary = scriptBinary(dir, `echo '${probeResultJson(false)}'\nexit 1`);
        const result = await runNativeLifecycle(
            { kind: "test-binary", path: binary },
            { command: "probe", deadlineMs: 10_000 },
        );
        expect(result.state).toBe("stopped");
        expect(result.reason).toBe("not_running");
    });

    test("extra stdout bytes after the object fail closed", async () => {
        const binary = scriptBinary(
            dir,
            `echo '${probeResultJson(false)}'\necho '{"second":1}'\nexit 1`,
        );
        let error: NativeLaunchError | null = null;
        try {
            await runNativeLifecycle(
                { kind: "test-binary", path: binary },
                { command: "probe", deadlineMs: 10_000 },
            );
        } catch (caught) {
            error = caught as NativeLaunchError;
        }
        expect(error?.code).toBe("malformed_output");
    });

    test("unknown fields, empty output, and non-JSON output fail closed", async () => {
        const bodies = [
            `echo '{"schema":"magic-context.daemon/v1","surprise":1}'\nexit 1`,
            `exit 1`,
            `echo 'plain text failure'\nexit 1`,
        ];
        for (const body of bodies) {
            const binary = scriptBinary(dir, body);
            let error: NativeLaunchError | null = null;
            try {
                await runNativeLifecycle(
                    { kind: "test-binary", path: binary },
                    { command: "probe", deadlineMs: 10_000 },
                );
            } catch (caught) {
                error = caught as NativeLaunchError;
            }
            expect(error?.code).toBe("malformed_output");
        }
    });

    test("exit/result disagreement is rejected even when the JSON is valid", async () => {
        const binary = scriptBinary(dir, `echo '${probeResultJson(false)}'\nexit 0`);
        let error: NativeLaunchError | null = null;
        try {
            await runNativeLifecycle(
                { kind: "test-binary", path: binary },
                { command: "probe", deadlineMs: 10_000 },
            );
        } catch (caught) {
            error = caught as NativeLaunchError;
        }
        expect(error?.code).toBe("exit_disagreement");
    });

    test("stderr is tainted: its bytes never appear in the typed failure", async () => {
        const binary = scriptBinary(dir, `echo "${SECRET}" >&2\necho 'not json'\nexit 1`);
        let error: NativeLaunchError | null = null;
        try {
            await runNativeLifecycle(
                { kind: "test-binary", path: binary },
                { command: "probe", deadlineMs: 10_000 },
            );
        } catch (caught) {
            error = caught as NativeLaunchError;
        }
        expect(error).toBeInstanceOf(NativeLaunchError);
        expect(error?.message).not.toContain(SECRET);
        expect(error?.stack ?? "").not.toContain(SECRET);
    });

    test("a signal exit is typed, never parsed", async () => {
        const binary = scriptBinary(dir, `kill -KILL $$`);
        let error: NativeLaunchError | null = null;
        try {
            await runNativeLifecycle(
                { kind: "test-binary", path: binary },
                { command: "probe", deadlineMs: 10_000 },
            );
        } catch (caught) {
            error = caught as NativeLaunchError;
        }
        expect(error?.code).toBe("signal_exit");
    });

    test("a hung child is killed at the deadline (KTD22 bound)", async () => {
        const binary = scriptBinary(dir, `sleep 30`);
        const started = Date.now();
        let error: NativeLaunchError | null = null;
        try {
            await runNativeLifecycle(
                { kind: "test-binary", path: binary },
                { command: "probe", deadlineMs: 500 },
            );
        } catch (caught) {
            error = caught as NativeLaunchError;
        }
        expect(error?.code).toBe("timeout");
        expect(Date.now() - started).toBeLessThan(5_000);
    }, 10_000);

    test("usage exits (2) are a typed contract failure with no lifecycle result", async () => {
        const binary = scriptBinary(dir, `exit 2`);
        let error: NativeLaunchError | null = null;
        try {
            await runNativeLifecycle(
                { kind: "test-binary", path: binary },
                { command: "probe", deadlineMs: 10_000 },
            );
        } catch (caught) {
            error = caught as NativeLaunchError;
        }
        expect(error?.code).toBe("usage_error");
    });

    test("the child receives the envelope on stdin and a minimal environment", async () => {
        const binary = scriptBinary(
            dir,
            `input=$(cat)\nif [ "$input" = '{"probe":true}' ] && [ -z "$HOME" ] && [ -z "$LD_PRELOAD" ]; then\n  echo '${probeResultJson(false)}'\n  exit 1\nfi\nexit 2`,
        );
        const result = await runNativeLifecycle(
            { kind: "test-binary", path: binary },
            { command: "probe", deadlineMs: 10_000, envelope: { probe: true } },
        );
        expect(result.reason).toBe("not_running");
    });

    test("an envelope that cannot be serialized fails before a child exists", async () => {
        const sentinel = path.join(dir, "unserializable-envelope-child-ran");
        const binary = scriptBinary(dir, `: > "${sentinel}"\nsleep 2`);
        const envelope: Record<string, unknown> = {};
        envelope.self = envelope;
        let error: NativeLaunchError | null = null;
        try {
            await runNativeLifecycle(
                { kind: "test-binary", path: binary },
                { command: "probe", deadlineMs: 250, envelope },
            );
        } catch (caught) {
            error = caught as NativeLaunchError;
        }
        expect(error).toBeInstanceOf(NativeLaunchError);
        expect(error?.code).toBe("usage_error");
        // Serializing after the spawn would let the raw serialization throw
        // escape with a live child that nothing collects or kills; the absent
        // marker proves no child ever ran.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(existsSync(sentinel)).toBe(false);
    }, 10_000);

    test("an envelope with no JSON form is typed, not a silently empty stdin", async () => {
        const binary = scriptBinary(dir, `echo '${probeResultJson(false)}'\nexit 1`);
        let error: NativeLaunchError | null = null;
        try {
            await runNativeLifecycle(
                { kind: "test-binary", path: binary },
                { command: "probe", deadlineMs: 10_000, envelope: () => "no json form" },
            );
        } catch (caught) {
            error = caught as NativeLaunchError;
        }
        expect(error).toBeInstanceOf(NativeLaunchError);
        expect(error?.code).toBe("usage_error");
    });

    test("stderr past the cap is discarded without killing a healthy child", async () => {
        // Stderr must stay drained, not closed: this child writes far past the
        // cap and then its conforming object, so a closed read end would take
        // the write side down with EPIPE/SIGPIPE before stdout ever arrives.
        const binary = scriptBinary(
            dir,
            [
                "chunk=xxxxxxxxxxxxxxxx",
                "chunk=$chunk$chunk$chunk$chunk",
                "chunk=$chunk$chunk$chunk$chunk",
                "chunk=$chunk$chunk$chunk$chunk",
                "i=0",
                "while [ $i -lt 512 ]; do",
                '  echo "$chunk" >&2',
                "  i=$((i + 1))",
                "done",
                `echo '${probeResultJson(false)}'`,
                "exit 1",
            ].join("\n"),
        );
        const result = await runNativeLifecycle(
            { kind: "test-binary", path: binary },
            { command: "probe", deadlineMs: 10_000 },
        );
        expect(result.reason).toBe("not_running");
    }, 15_000);

    test("spawn failure for a missing binary is typed", async () => {
        let error: NativeLaunchError | null = null;
        try {
            await runNativeLifecycle(
                { kind: "test-binary", path: path.join(dir, "does-not-exist") },
                { command: "probe", deadlineMs: 10_000 },
            );
        } catch (caught) {
            error = caught as NativeLaunchError;
        }
        expect(error?.code).toBe("spawn_failed");
    });

    test("a platform with no descriptor exec path is a platform failure, not a spawn error", async () => {
        let error: NativeLaunchError | null = null;
        try {
            await runNativeLifecycle(
                { kind: "retained-fd", fd: 0 },
                { command: "probe", deadlineMs: 10_000, platform: "win32" },
            );
        } catch (caught) {
            error = caught as NativeLaunchError;
        }
        // Neither procfs_self_fd_exec nor dev_fd_exec: report the real reason
        // instead of spawning a path that cannot exist.
        expect(error?.code).toBe("unsupported_platform");
    });

    test("darwin resolves the retained descriptor through /dev/fd, not procfs", async () => {
        // The contract gives darwin `dev_fd_exec` and linux
        // `procfs_self_fd_exec`; a darwin launch must not reach /proc.
        let error: NativeLaunchError | null = null;
        try {
            await runNativeLifecycle(
                { kind: "retained-fd", fd: 0 },
                { command: "probe", deadlineMs: 10_000, platform: "darwin" },
            );
        } catch (caught) {
            error = caught as NativeLaunchError;
        }
        // On this linux host /dev/fd/3 is not an executable image, so the
        // spawn fails; the point is that it was attempted at all rather than
        // rejected as an unsupported platform.
        expect(error).toBeInstanceOf(NativeLaunchError);
        expect(error?.code).not.toBe("unsupported_platform");
    });
});
