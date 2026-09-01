/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import type { execFileSync } from "node:child_process";
import type { readFileSync } from "node:fs";
import {
    __resetRpcIdentityTestHooks,
    __setRpcIdentityTestHooks,
    classifyProcessKind,
    discoverLivePiProcessIds,
    inspectLivePiProcesses,
    isPidAlive,
    isPidIdentityPlausible,
    type RpcPortFileRecord,
} from "./rpc-utils";

const PID = 1234;
const NOW_MS = 2_000_000;
const UPTIME_SECONDS = 1_000;

function record(startedAt: number): RpcPortFileRecord {
    return { port: 43123, pid: PID, started_at: startedAt };
}

function procStat(startTimeTicks: number): string {
    // After the command-name closing parenthesis, field 3 is `state`.
    // Field 22 is the twentieth value after the command-name parenthesis.
    return `${PID} (opencode) S ${Array.from({ length: 18 }, () => "0").join(" ")} ${startTimeTicks}`;
}

function linuxFiles(files: Record<string, string | Error>): typeof readFileSync {
    return ((path: string | URL) => {
        const value = files[String(path)];
        if (value instanceof Error) throw value;
        if (value === undefined) throw new Error(`unexpected read: ${String(path)}`);
        return value;
    }) as typeof readFileSync;
}

function psOutput(output: string | Error): typeof execFileSync {
    return (() => {
        if (output instanceof Error) throw output;
        return output;
    }) as typeof execFileSync;
}

function tasklistOutput(entries: Array<[number, string]>): string {
    return [
        '"Image Name","PID","Session Name","Session#","Mem Usage"',
        ...entries.map(([pid, command]) => `"${command}","${pid}","Console","1","10,000 K"`),
    ].join("\r\n");
}

afterEach(() => {
    __resetRpcIdentityTestHooks();
});

describe("classifyProcessKind", () => {
    test("classifies OpenCode server, OpenCode instance, Pi, and unknown commands", () => {
        expect(classifyProcessKind("/usr/local/bin/opencode serve --hostname 127.0.0.1")).toBe(
            "OpenCode server",
        );
        expect(classifyProcessKind("node /opt/opencode/bin/opencode --continue")).toBe(
            "OpenCode instance (TUI/CLI)",
        );
        expect(
            classifyProcessKind(
                "bun /workspace/node_modules/@mariozechner/pi-coding-agent/dist/cli.js",
            ),
        ).toBe("Pi");
        expect(classifyProcessKind("/usr/bin/other --flag")).toBe("process");
        expect(classifyProcessKind(null)).toBe("process");
    });

    test("recognizes serve flags and Windows-style executable paths", () => {
        expect(classifyProcessKind("opencode --serve=true")).toBe("OpenCode server");
        expect(classifyProcessKind("C:\\Tools\\opencode.exe")).toBe("OpenCode instance (TUI/CLI)");
        expect(classifyProcessKind("pi.cmd --model test")).toBe("Pi");
    });
});

describe("discoverLivePiProcessIds", () => {
    test("finds Pi-family harness commands while excluding the current process", () => {
        __setRpcIdentityTestHooks({
            processListExecFileSync: (() =>
                [
                    ` ${process.pid} /usr/local/bin/pi`,
                    " 41001 /usr/local/bin/pi --model test",
                    " 41002 node /opt/node_modules/@mariozechner/pi-coding-agent/dist/cli.js",
                    " 41003 bun /opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
                    " 41004 /Applications/OpenCode.app/Contents/MacOS/opencode",
                    " 41005 node /workspace/pi-plugin/src/index.ts",
                    " 41006 npm install @earendil-works/pi-coding-agent",
                    " 41007 /usr/local/bin/omp --model test",
                ].join("\n")) as typeof execFileSync,
        });

        expect(discoverLivePiProcessIds()).toEqual([41001, 41002, 41003, 41007]);
    });

    test("reports uncertainty instead of treating an unavailable process list as empty", () => {
        __setRpcIdentityTestHooks({
            processListExecFileSync: (() => {
                throw new Error("ps unavailable");
            }) as typeof execFileSync,
        });

        expect(inspectLivePiProcesses()).toEqual({
            state: "unreadable",
            processIds: [],
            error: "ps unavailable",
        });
    });

    test("uses tasklist instead of ps on Windows", () => {
        const calls: string[] = [];
        __setRpcIdentityTestHooks({
            platform: "win32",
            processListExecFileSync: ((file: string | URL) => {
                calls.push(String(file));
                return tasklistOutput([
                    [process.pid, "pi.exe"],
                    [41001, "pi.exe"],
                    [41002, "opencode.exe"],
                ]);
            }) as typeof execFileSync,
        });

        expect(inspectLivePiProcesses()).toEqual({
            state: "known",
            processIds: [41001],
        });
        expect(calls).toEqual(["tasklist"]);
    });
});

describe("isPidAlive", () => {
    test("distinguishes confirmed, dead, and inaccessible PID probes", () => {
        const probeFailure = (code: string): NodeJS.ErrnoException => {
            const error = new Error(`kill failed: ${code}`) as NodeJS.ErrnoException;
            error.code = code;
            return error;
        };

        __setRpcIdentityTestHooks({
            processKill: (() => true) as typeof process.kill,
        });
        expect(isPidAlive(PID)).toBe("alive");

        __setRpcIdentityTestHooks({
            processKill: (() => {
                throw probeFailure("ESRCH");
            }) as typeof process.kill,
        });
        expect(isPidAlive(PID)).toBe("dead");

        __setRpcIdentityTestHooks({
            processKill: (() => {
                throw probeFailure("EPERM");
            }) as typeof process.kill,
        });
        expect(isPidAlive(PID)).toBe("inconclusive");
    });

    test("uses tasklist for Windows liveness and captures probe stderr", () => {
        const calls: Array<{ file: string; args: readonly string[]; stdio: unknown }> = [];
        __setRpcIdentityTestHooks({
            platform: "win32",
            execFileSync: ((
                file: string | URL,
                args: readonly string[] = [],
                options: { stdio?: unknown } = {},
            ) => {
                calls.push({ file: String(file), args, stdio: options.stdio });
                if (String(file) === "ps") throw new Error("ps must not run on Windows");
                return tasklistOutput([[PID, "OpenCode.exe"]]);
            }) as typeof execFileSync,
        });

        expect(isPidAlive(PID)).toBe("alive");
        expect(calls).toEqual([
            {
                file: "tasklist",
                args: ["/FO", "CSV", "/FI", `PID eq ${PID}`],
                stdio: ["ignore", "pipe", "pipe"],
            },
        ]);
    });

    test("treats a successful tasklist no-match response as dead", () => {
        __setRpcIdentityTestHooks({
            platform: "win32",
            execFileSync: (() =>
                "INFO: No tasks are running which match the specified criteria.") as typeof execFileSync,
        });

        expect(isPidAlive(PID)).toBe("dead");
    });

    test("returns inconclusive when the Windows tasklist probe cannot spawn", () => {
        __setRpcIdentityTestHooks({
            platform: "win32",
            execFileSync: (() => {
                throw new Error("tasklist unavailable");
            }) as typeof execFileSync,
        });

        expect(isPidAlive(PID)).toBe("inconclusive");
        expect(isPidIdentityPlausible(record(0))).toBe("inconclusive");
    });
});

describe("isPidIdentityPlausible", () => {
    test("rejects a reused Linux PID when proc start time is substantially newer", () => {
        const readPaths: string[] = [];
        __setRpcIdentityTestHooks({
            platform: "linux",
            nowMs: () => NOW_MS,
            readFileSync: ((path: string | URL) => {
                readPaths.push(String(path));
                const files = {
                    [`/proc/${PID}/stat`]: procStat(10_000),
                    "/proc/uptime": `${UPTIME_SECONDS}.0 0.0`,
                };
                return files[String(path) as keyof typeof files];
            }) as typeof readFileSync,
            execFileSync: (() => {
                throw new Error("ps must not run on Linux");
            }) as typeof execFileSync,
        });

        expect(isPidIdentityPlausible(record(500_000))).toBe("implausible");
        expect(readPaths).toEqual([`/proc/${PID}/stat`, "/proc/uptime"]);
    });

    test("accepts a genuine Linux record when the process started no later than the record", () => {
        __setRpcIdentityTestHooks({
            platform: "linux",
            nowMs: () => NOW_MS,
            readFileSync: linuxFiles({
                [`/proc/${PID}/stat`]: procStat(10_000),
                "/proc/uptime": `${UPTIME_SECONDS}.0 0.0`,
            }),
        });

        // The 120-second tolerance accounts for port-file creation after process startup.
        expect(isPidIdentityPlausible(record(1_000_000))).toBe("plausible");
    });

    test("reports an unreadable Linux start-time probe as inconclusive", () => {
        __setRpcIdentityTestHooks({
            platform: "linux",
            readFileSync: linuxFiles({
                [`/proc/${PID}/stat`]: new Error("procfs unavailable"),
            }),
        });

        expect(isPidIdentityPlausible(record(500_000))).toBe("inconclusive");
    });

    test("uses the legacy Linux command fallback and distinguishes probe errors", () => {
        __setRpcIdentityTestHooks({
            platform: "linux",
            readFileSync: linuxFiles({
                [`/proc/${PID}/cmdline`]: "/usr/sbin/opendkim --config /etc/opendkim.conf",
            }),
        });
        expect(isPidIdentityPlausible(record(0))).toBe("implausible");

        __setRpcIdentityTestHooks({
            platform: "linux",
            readFileSync: linuxFiles({
                [`/proc/${PID}/cmdline`]: "/usr/local/bin/opencode serve",
            }),
        });
        expect(isPidIdentityPlausible(record(0))).toBe("plausible");

        __setRpcIdentityTestHooks({
            platform: "linux",
            readFileSync: linuxFiles({
                [`/proc/${PID}/cmdline`]: new Error("procfs unavailable"),
            }),
        });
        expect(isPidIdentityPlausible(record(0))).toBe("inconclusive");
    });

    test("uses ps start time and command probes on non-Linux platforms", () => {
        __setRpcIdentityTestHooks({
            platform: "darwin",
            execFileSync: psOutput("Mon Aug  7 00:00:00 1970"),
        });
        expect(
            isPidIdentityPlausible(record(Date.parse("Mon Aug  7 00:00:00 1970") - 121_000)),
        ).toBe("implausible");

        __setRpcIdentityTestHooks({
            platform: "darwin",
            execFileSync: psOutput("Mon Aug  7 00:00:00 1970"),
        });
        expect(
            isPidIdentityPlausible(record(Date.parse("Mon Aug  7 00:00:00 1970") - 120_000)),
        ).toBe("plausible");

        __setRpcIdentityTestHooks({
            platform: "darwin",
            execFileSync: psOutput("/usr/sbin/opendkim -f"),
        });
        expect(isPidIdentityPlausible(record(0))).toBe("implausible");

        __setRpcIdentityTestHooks({
            platform: "darwin",
            execFileSync: psOutput("/Applications/OpenCode.app/Contents/MacOS/opencode"),
        });
        expect(isPidIdentityPlausible(record(0))).toBe("plausible");

        __setRpcIdentityTestHooks({
            platform: "darwin",
            execFileSync: psOutput(new Error("ps unavailable")),
        });
        expect(isPidIdentityPlausible(record(0))).toBe("inconclusive");
    });

    test("uses tasklist for the Windows command fallback and skips unavailable start time", () => {
        const calls: Array<{ file: string; args: readonly string[] }> = [];
        __setRpcIdentityTestHooks({
            platform: "win32",
            execFileSync: ((file: string | URL, args: readonly string[] = []) => {
                calls.push({ file: String(file), args });
                if (String(file) === "ps") throw new Error("ps must not run on Windows");
                return tasklistOutput([[PID, "OpenCode.exe"]]);
            }) as typeof execFileSync,
        });

        expect(isPidIdentityPlausible(record(0))).toBe("plausible");
        expect(calls).toEqual([{ file: "tasklist", args: ["/FO", "CSV", "/FI", `PID eq ${PID}`] }]);

        calls.length = 0;
        expect(isPidIdentityPlausible(record(NOW_MS))).toBe("inconclusive");
        expect(calls).toEqual([]);
    });
});
