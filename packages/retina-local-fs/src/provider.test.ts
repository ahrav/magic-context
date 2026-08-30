import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import {
    type ProviderConfig,
    ProviderError,
    type ProviderScalar,
    runProvider,
    validateProviderConfig,
} from "./provider";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

async function temporaryDirectory(prefix = "retina-local-fs-"): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
});

async function poll(
    config: ProviderConfig,
    scalar: ProviderScalar | null = null,
    homeDirectory?: string,
    dataDirectory?: string,
) {
    return runProvider(
        { scalar, config },
        {
            homeDirectory,
            dataDirectory:
                dataDirectory ??
                (homeDirectory ? join(homeDirectory, ".local", "share") : undefined),
            now: () => 1_786_320_000_000,
        },
    );
}

async function git(repo: string, ...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", repo, ...args], { encoding: "utf8" });
    return stdout.trim();
}

async function createRepository(): Promise<{ repo: string; firstSha: string }> {
    const repo = await temporaryDirectory("retina-local-fs-git-");
    await git(repo, "init", "--initial-branch=main");
    await git(repo, "config", "user.name", "Retina Test");
    await git(repo, "config", "user.email", "retina@example.invalid");
    await writeFile(join(repo, "state.txt"), "one\n");
    await git(repo, "add", "state.txt");
    await git(repo, "commit", "-m", "first");
    return { repo, firstSha: await git(repo, "rev-parse", "HEAD") };
}

async function commit(repo: string, content: string): Promise<string> {
    await writeFile(join(repo, "state.txt"), content);
    await git(repo, "add", "state.txt");
    await git(repo, "commit", "-m", content.trim());
    return git(repo, "rev-parse", "HEAD");
}

describe("filesystem predicates", () => {
    test("file_contains fires in the requested direction and stays quiet when unchanged", async () => {
        const directory = await temporaryDirectory();
        const path = join(directory, "status.txt");
        await writeFile(path, "ready\n");
        const config = { kind: "file_contains", path, needle: "ready" } as const;

        const first = await poll(config);
        expect(first.events).toHaveLength(1);
        expect(first.events[0]?.observed).toEqual({ contains: true });
        expect((await poll(config, first.scalar)).events).toHaveLength(0);

        await writeFile(path, "waiting\n");
        expect((await poll(config, first.scalar)).events).toHaveLength(0);

        const absent = await poll({ ...config, absent: true });
        expect(absent.events).toHaveLength(1);
        expect(absent.events[0]?.observed).toEqual({ contains: false });
    });

    test("path_exists treats missing as an observation and supports gone", async () => {
        const directory = await temporaryDirectory();
        const path = join(directory, "result.json");
        const existsConfig = { kind: "path_exists", path } as const;

        const missing = await poll(existsConfig);
        expect(missing.events).toHaveLength(0);
        await writeFile(path, "{}\n");
        const appeared = await poll(existsConfig, missing.scalar);
        expect(appeared.events).toHaveLength(1);
        expect((await poll(existsConfig, appeared.scalar)).events).toHaveLength(0);

        await rm(path);
        const gone = await poll({ ...existsConfig, gone: true }, appeared.scalar);
        expect(gone.events).toHaveLength(1);
        expect(gone.events[0]?.observed).toEqual({ exists: false });
    });

    test("mtime_after emits each later mtime once", async () => {
        const directory = await temporaryDirectory();
        const path = join(directory, "build.out");
        await writeFile(path, "one");
        const firstTime = new Date("2026-08-10T00:00:00.000Z");
        await utimes(path, firstTime, firstTime);

        const quiet = await poll({ kind: "mtime_after", path, since_ms: firstTime.getTime() + 1 });
        expect(quiet.events).toHaveLength(0);

        const config = { kind: "mtime_after", path, since_ms: firstTime.getTime() - 1 } as const;
        const first = await poll(config);
        expect(first.events).toHaveLength(1);
        expect((await poll(config, first.scalar)).events).toHaveLength(0);

        const secondTime = new Date(firstTime.getTime() + 10_000);
        await utimes(path, secondTime, secondTime);
        const second = await poll(config, first.scalar);
        expect(second.events).toHaveLength(1);
        expect(second.events[0]?.id).not.toBe(first.events[0]?.id);
    });

    test("boolean occurrences have stable replay ids and distinct transition ids", async () => {
        const directory = await temporaryDirectory();
        const path = join(directory, "flag");
        await writeFile(path, "yes");
        const config = { kind: "path_exists", path } as const;

        const replayA = await poll(config);
        const replayB = await poll(config);
        expect(replayA.events[0]?.id).toBe(replayB.events[0]?.id);

        await rm(path);
        const absent = await poll(config, replayA.scalar);
        await writeFile(path, "again");
        const repeated = await poll(config, absent.scalar);
        expect(repeated.events[0]?.id).not.toBe(replayA.events[0]?.id);
    });
});

describe("git predicates", () => {
    test("git_commit_after fires for strict descendants and each new commit", async () => {
        const { repo, firstSha } = await createRepository();
        const equal = await poll({
            kind: "git_commit_after",
            repo_path: repo,
            sha: firstSha.slice(0, 10),
        });
        expect(equal.events).toHaveLength(0);

        const secondSha = await commit(repo, "two\n");
        const config = { kind: "git_commit_after", repo_path: repo, sha: firstSha } as const;
        const second = await poll(config, equal.scalar);
        expect(second.events).toHaveLength(1);
        expect(second.events[0]?.observed.sha).toBe(secondSha);
        expect((await poll(config, second.scalar)).events).toHaveLength(0);

        const thirdSha = await commit(repo, "three\n");
        const third = await poll(config, second.scalar);
        expect(third.events[0]?.observed.sha).toBe(thirdSha);
        expect(third.events[0]?.id).not.toBe(second.events[0]?.id);
    });

    test("git_tag_matching tracks new matching tags and semver thresholds", async () => {
        const { repo } = await createRepository();
        await git(repo, "tag", "other-1.0.0");
        const config = {
            kind: "git_tag_matching",
            repo_path: repo,
            pattern: "v*",
            above: "1.0.0",
        } as const;
        const quiet = await poll(config);
        expect(quiet.events).toHaveLength(0);

        await git(repo, "tag", "v1.0.0");
        const thresholdQuiet = await poll(config, quiet.scalar);
        expect(thresholdQuiet.events).toHaveLength(0);
        await git(repo, "tag", "v1.1.0");
        const matching = await poll(config, thresholdQuiet.scalar);
        expect(matching.events).toHaveLength(1);
        expect(matching.events[0]?.observed).toEqual({ tag: "v1.1.0" });
        expect((await poll(config, matching.scalar)).events).toHaveLength(0);

        await git(repo, "tag", "v2.0.0");
        const next = await poll(config, matching.scalar);
        expect(next.events[0]?.id).not.toBe(matching.events[0]?.id);
    });
});

describe("compound scalar behavior", () => {
    test("OR evaluates up to four independent predicates and round-trips its scalar", async () => {
        const directory = await temporaryDirectory();
        const present = join(directory, "present");
        const missing = join(directory, "missing");
        await writeFile(present, "needle");
        const config = {
            any: [
                { kind: "path_exists", path: present },
                { kind: "path_exists", path: missing },
                { kind: "file_contains", path: present, needle: "needle" },
                { kind: "file_contains", path: present, needle: "absent" },
            ],
        } as const;

        const first = await poll(config);
        expect(first.events).toHaveLength(2);
        expect(Object.keys(first.scalar.predicates)).toHaveLength(4);
        expect((await poll(config, first.scalar)).events).toHaveLength(0);
    });

    test("accepts the authoring audit marker but still rejects unknown fields", () => {
        expect(
            validateProviderConfig({
                kind: "path_exists",
                path: "/tmp/future",
                resolved_path_exists: false,
            }),
        ).toEqual({
            success: true,
            config: {
                kind: "path_exists",
                path: "/tmp/future",
                resolved_path_exists: false,
            },
        });
        expect(
            validateProviderConfig({ kind: "path_exists", path: "/tmp/future", guessed: true }),
        ).toMatchObject({ success: false, reason: expect.stringContaining("unknown field") });
    });

    test("rejects compounds larger than four", async () => {
        const config = {
            any: Array.from({ length: 5 }, (_, index) => ({
                kind: "path_exists",
                path: `/tmp/${index}`,
            })),
        };
        await expect(runProvider({ scalar: null, config })).rejects.toMatchObject({
            code: "invalid_config",
        });
    });
});

describe("path fence", () => {
    test("refuses every sensitive CortexKit data root", async () => {
        const home = await temporaryDirectory("retina-local-fs-home-");
        for (const root of ["plexus", "claustrum", "staging", "run", "magic-context"]) {
            const path = join(home, ".local", "share", "cortexkit", root, "secret.txt");
            await mkdir(join(path, ".."), { recursive: true });
            await writeFile(path, "secret");
            await expect(poll({ kind: "path_exists", path }, null, home)).rejects.toMatchObject({
                code: "fenced_path",
            });
        }
    });

    test("refuses Magic Context databases and RPC bearer discovery files", async () => {
        const home = await temporaryDirectory("retina-local-fs-home-");
        const root = join(home, ".local", "share", "cortexkit", "magic-context");
        const paths = [
            join(root, "context.db"),
            join(root, "store.db-wal"),
            join(root, "rpc", "project", "port-123-instance.json"),
        ];
        for (const path of paths) {
            await mkdir(join(path, ".."), { recursive: true });
            await writeFile(path, "credential-bearing data");
            await expect(poll({ kind: "path_exists", path }, null, home)).rejects.toMatchObject({
                code: "fenced_path",
            });
        }
    });

    test("refuses the default subc connection file by name", async () => {
        const home = await temporaryDirectory("retina-local-fs-home-");
        const path = join(home, ".local", "share", "cortexkit", "run", "subc-connection.json");
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, JSON.stringify({ key: "secret" }));

        await expect(
            poll({ kind: "file_contains", path, needle: "secret" }, null, home),
        ).rejects.toMatchObject({ code: "fenced_path" });
    });

    test("refuses an XDG-relocated subc connection file", async () => {
        const home = await temporaryDirectory("retina-local-fs-home-");
        const dataDirectory = await temporaryDirectory("retina-local-fs-xdg-");
        const path = join(dataDirectory, "cortexkit", "run", "subc-connection.json");
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, JSON.stringify({ key: "secret" }));

        process.env.XDG_DATA_HOME = dataDirectory;
        await expect(
            runProvider(
                { scalar: null, config: { kind: "path_exists", path } },
                { homeDirectory: home },
            ),
        ).rejects.toMatchObject({ code: "fenced_path" });
    });

    test("ignores a relative XDG_DATA_HOME and keeps fencing the home-derived root", async () => {
        // The daemon and the lifecycle resolver both reject a relative
        // XDG_DATA_HOME and fall back to $HOME/.local/share, so the real
        // managed tree lives under home. A fence that resolved the relative
        // value against cwd would compute its root elsewhere and admit the
        // very files it exists to refuse.
        const home = await temporaryDirectory("retina-local-fs-home-");
        const path = join(home, ".local", "share", "cortexkit", "run", "subc-connection.json");
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, JSON.stringify({ key: "secret" }));

        process.env.XDG_DATA_HOME = "./poisoned-relative-data";
        await expect(
            runProvider(
                { scalar: null, config: { kind: "path_exists", path } },
                { homeDirectory: home },
            ),
        ).rejects.toMatchObject({ code: "fenced_path" });
    });

    test("still fences the cwd-relative tree a relative XDG_DATA_HOME makes storage write to", async () => {
        // The plugin's storage resolver accepts a raw XDG_DATA_HOME, so under
        // a relative value its writes land in a cwd-relative tree. The fence
        // covers that root too — rejecting the relative value must not trade
        // one admitted managed tree for another.
        const home = await temporaryDirectory("retina-local-fs-home-");
        const dataDirectory = await temporaryDirectory("retina-local-fs-relative-xdg-");
        const path = join(dataDirectory, "cortexkit", "magic-context", "context.db");
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "credential-bearing data");

        process.env.XDG_DATA_HOME = relative(process.cwd(), dataDirectory);
        expect(isAbsolute(process.env.XDG_DATA_HOME)).toBe(false);
        await expect(
            runProvider(
                { scalar: null, config: { kind: "path_exists", path } },
                { homeDirectory: home },
            ),
        ).rejects.toMatchObject({ code: "fenced_path" });
    });

    test("ignores an empty XDG_DATA_HOME and keeps fencing the home-derived root", async () => {
        const home = await temporaryDirectory("retina-local-fs-home-");
        const path = join(home, ".local", "share", "cortexkit", "magic-context", "context.db");
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "credential-bearing data");

        process.env.XDG_DATA_HOME = "";
        await expect(
            runProvider(
                { scalar: null, config: { kind: "path_exists", path } },
                { homeDirectory: home },
            ),
        ).rejects.toMatchObject({ code: "fenced_path" });
    });

    test("admits a non-secret file under the CortexKit data root", async () => {
        const home = await temporaryDirectory("retina-local-fs-home-");
        const dataDirectory = await temporaryDirectory("retina-local-fs-xdg-");
        const path = join(dataDirectory, "cortexkit", "docs", "notice.txt");
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "public notice");

        const result = await poll(
            { kind: "file_contains", path, needle: "public" },
            null,
            home,
            dataDirectory,
        );
        expect(result.events).toHaveLength(1);
    });

    test("refuses a symlink swap after canonicalization", async () => {
        const home = await temporaryDirectory("retina-local-fs-home-");
        const path = join(home, "watched.txt");
        const original = join(home, "watched-original.txt");
        const sensitive = join(home, ".local", "share", "cortexkit", "run", "subc-connection.json");
        await writeFile(path, "safe");
        await mkdir(join(sensitive, ".."), { recursive: true });
        await writeFile(sensitive, JSON.stringify({ key: "secret" }));
        await expect(
            runProvider(
                {
                    scalar: null,
                    config: { kind: "file_contains", path, needle: "secret" },
                },
                {
                    homeDirectory: home,
                    dataDirectory: join(home, ".local", "share"),
                    beforePathUseForTests: async () => {
                        await rename(path, original);
                        await symlink(sensitive, path);
                    },
                },
            ),
        ).rejects.toMatchObject({ code: "fenced_path" });
    });

    test("refuses sensitive basenames outside fenced roots", async () => {
        const home = await temporaryDirectory("retina-local-fs-home-");
        for (const name of ["prod-binding-key-v2", "operator.handle"]) {
            const path = join(home, "safe", name);
            await mkdir(join(path, ".."), { recursive: true });
            await writeFile(path, "secret");
            await expect(poll({ kind: "path_exists", path }, null, home)).rejects.toMatchObject({
                code: "fenced_path",
            });
        }
    });

    test("resolves symlinks before refusing a fenced target", async () => {
        const home = await temporaryDirectory("retina-local-fs-home-");
        const target = join(home, ".local", "share", "cortexkit", "plexus", "secret.txt");
        const link = join(home, "innocent-link");
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, "secret");
        await symlink(target, link);

        await expect(poll({ kind: "path_exists", path: link }, null, home)).rejects.toMatchObject({
            code: "fenced_path",
        });

        const missingTarget = join(
            home,
            ".local",
            "share",
            "cortexkit",
            "claustrum",
            "missing-secret",
        );
        const danglingLink = join(home, "dangling-link");
        await mkdir(join(missingTarget, ".."), { recursive: true });
        await symlink(missingTarget, danglingLink);
        await expect(
            poll({ kind: "path_exists", path: danglingLink, gone: true }, null, home),
        ).rejects.toMatchObject({ code: "fenced_path" });
    });

    test("admits every documented file-granular carve-in", async () => {
        const home = await temporaryDirectory("retina-local-fs-home-");
        const cortexkit = join(home, ".local", "share", "cortexkit");
        const carveIns = [
            join(cortexkit, "plexus", "catalog", "provider.json"),
            join(cortexkit, "claustrum", "bin", "supervisor"),
            join(cortexkit, "staging", "engram-catalog.json"),
            join(home, "project", "catalog", "dev-binding-key"),
        ];
        for (const path of carveIns) {
            await mkdir(join(path, ".."), { recursive: true });
            await writeFile(path, "allowed");
            const result = await poll({ kind: "path_exists", path }, null, home);
            expect(result.events).toHaveLength(1);
        }

        const binDirectory = join(cortexkit, "claustrum", "bin");
        const binMtime = await poll(
            { kind: "mtime_after", path: binDirectory, since_ms: 0 },
            null,
            home,
        );
        expect(binMtime.events).toHaveLength(1);
    });

    test("fences plexus store variants", async () => {
        const home = await temporaryDirectory("retina-local-fs-home-");
        const path = join(home, ".local", "share", "cortexkit", "plexus", "store.db-wal");
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "events");
        await expect(poll({ kind: "path_exists", path }, null, home)).rejects.toMatchObject({
            code: "fenced_path",
        });
    });
});

describe("CLI exit discipline", () => {
    async function invoke(input: unknown, home: string) {
        const cli = new URL("./cli.ts", import.meta.url).pathname;
        const child = Bun.spawn({
            cmd: ["bun", cli],
            cwd: import.meta.dir,
            env: {
                ...process.env,
                HOME: home,
                XDG_DATA_HOME: join(home, ".local", "share"),
            },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
    }

    test("returns zero and empty events for a readable unmatched file", async () => {
        const home = await temporaryDirectory("retina-local-fs-home-");
        const path = join(home, "readable.txt");
        await writeFile(path, "waiting");
        const result = await invoke(
            { scalar: null, config: { kind: "file_contains", path, needle: "ready" } },
            home,
        );
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).events).toEqual([]);
        expect(result.stderr).toBe("");
    });

    test("returns nonzero JSON error when a path cannot be read", async () => {
        const home = await temporaryDirectory("retina-local-fs-home-");
        const directory = join(home, "not-a-file");
        await mkdir(directory);
        const result = await invoke(
            {
                scalar: null,
                config: { kind: "file_contains", path: directory, needle: "ready" },
            },
            home,
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(JSON.parse(result.stderr)).toMatchObject({ code: "unreadable_path" });
        expect(result.stderr.trim().split("\n")).toHaveLength(1);
    });

    test("returns nonzero for invalid config and fence refusal", async () => {
        const home = await temporaryDirectory("retina-local-fs-home-");
        const invalidResult = await invoke(
            {
                scalar: null,
                config: { kind: "path_exists", path: home, token: "must-not-be-accepted" },
            },
            home,
        );
        expect(JSON.parse(invalidResult.stderr)).toMatchObject({ code: "invalid_config" });

        const fenced = join(home, ".local", "share", "cortexkit", "plexus", "secret");
        await mkdir(join(fenced, ".."), { recursive: true });
        await writeFile(fenced, "secret");
        const fencedResult = await invoke(
            { scalar: null, config: { kind: "path_exists", path: fenced } },
            home,
        );
        expect(JSON.parse(fencedResult.stderr)).toMatchObject({ code: "fenced_path" });
    });
});

test("ProviderError remains machine distinguishable", () => {
    expect(new ProviderError("example", "message")).toMatchObject({
        name: "ProviderError",
        code: "example",
        message: "message",
    });
});
