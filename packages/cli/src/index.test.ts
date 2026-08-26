import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliDispatchDependencies, dispatchCli, usageText } from "./dispatch";

const builtCliRoot = mkdtempSync(join(tmpdir(), "magic-context-cli-built-"));

afterAll(() => {
    rmSync(builtCliRoot, { recursive: true, force: true });
});

function dependencies() {
    const daemonArgs: string[][] = [];
    let sqliteCalls = 0;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const deps: CliDispatchDependencies = {
        runDaemon: async (args) => {
            daemonArgs.push(args);
            return 0;
        },
        runSqlitePreflight: async () => {
            sqliteCalls += 1;
            return false;
        },
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
    };
    return {
        deps,
        daemonArgs,
        stdout,
        stderr,
        sqliteCalls: () => sqliteCalls,
    };
}

describe("import-safe CLI dispatch", () => {
    test("help lists all daemon actions and --json", async () => {
        const h = dependencies();

        const exit = await dispatchCli(["--help"], h.deps);

        expect(exit).toBe(0);
        expect(h.stdout).toEqual([usageText()]);
        for (const action of ["start", "stop", "restart", "status", "doctor"]) {
            expect(h.stdout[0]).toContain(`daemon ${action}`);
        }
        expect(h.stdout[0]).toContain("--json");
    });

    test.each([
        "start",
        "stop",
        "restart",
        "status",
        "doctor",
    ])("daemon %s bypasses SQLite preflight", async (action) => {
        const h = dependencies();

        const exit = await dispatchCli(["daemon", action, "--json"], h.deps);

        expect(exit).toBe(0);
        expect(h.daemonArgs).toEqual([[action, "--json"]]);
        expect(h.sqliteCalls()).toBe(0);
    });

    test("legacy doctor still uses SQLite preflight", async () => {
        const h = dependencies();

        const exit = await dispatchCli(["doctor"], h.deps);

        expect(exit).toBe(1);
        expect(h.sqliteCalls()).toBe(1);
        expect(h.daemonArgs).toEqual([]);
    });

    test("importing the executable module does not run or exit", async () => {
        const cliRoot = join(import.meta.dir, "..");
        const child = Bun.spawn({
            cmd: [
                process.execPath,
                "-e",
                'await import("./src/index.ts"); console.log("IMPORT_SAFE")',
            ],
            cwd: cliRoot,
            stdout: "pipe",
            stderr: "pipe",
        });

        const [exit, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);

        expect(exit).toBe(0);
        expect(stdout.trim()).toBe("IMPORT_SAFE");
        expect(stderr).toBe("");
    });

    test("Node dispatches a built CLI invoked through an npm-style bin symlink", async () => {
        const cliRoot = join(import.meta.dir, "..");
        const built = spawnSync("bun", ["run", "build"], {
            cwd: cliRoot,
            encoding: "utf8",
        });
        expect(built.status).toBe(0);
        const entry = join(cliRoot, "dist", "index.js");
        const bin = join(builtCliRoot, "magic-context");
        symlinkSync(entry, bin);

        const child = Bun.spawn({
            cmd: ["node", bin, "--help"],
            stdout: "pipe",
            stderr: "pipe",
        });
        const [exit, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);

        expect(exit).toBe(0);
        expect(stdout).toContain("daemon start");
        expect(stderr).toBe("");
    });

    test.each([
        "start",
        "stop",
        "restart",
        "status",
        "doctor",
    ])("subprocess entrypoint dispatches daemon %s as one JSON result", async (action) => {
        const cliRoot = join(import.meta.dir, "..");
        const child = Bun.spawn({
            cmd: [process.execPath, "src/index.ts", "daemon", action, "--json"],
            cwd: cliRoot,
            env: {
                ...process.env,
                XDG_DATA_HOME: "relative",
                MAGIC_CONTEXT_TEST_DATA_DIR: "relative",
                HOME: "/tmp/magic-context-cli-entrypoint-test",
            },
            stdout: "pipe",
            stderr: "pipe",
        });

        const [exit, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);

        expect(exit).toBe(1);
        expect(stderr).toBe("");
        const lines = stdout.trim().split("\n");
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0] ?? "")).toMatchObject({
            schema: "magic-context.daemon/v1",
            command: action,
            ok: false,
        });
    });
});
