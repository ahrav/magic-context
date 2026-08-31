import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as logger from "../../shared/logger";

let importCounter = 0;
const tempDirs: string[] = [];
const PACKAGE_NAME = "@cortexkit/opencode-magic-context";

function freshCheckerImport() {
    return import(`./checker.ts?test=${importCounter++}`);
}

afterEach(() => {
    mock.restore();
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
    delete process.env.OPENCODE_CONFIG_DIR;
});

function makeProjectFixture(): string {
    const root = mkdtempSync(join(tmpdir(), "mc-checker-fixture-"));
    tempDirs.push(root);
    mkdirSync(join(root, ".opencode"), { recursive: true });
    return root;
}

function writePluginConfig(path: string, entry: string): void {
    writeFileSync(path, `{\n  // plugin origin\n  "plugin": [${JSON.stringify(entry)}]\n}\n`);
}

async function freshCheckerWithGlobalRoot(root: string) {
    const constants = await import("./constants");
    mock.module("./constants", () => ({
        ...constants,
        USER_OPENCODE_CONFIG: join(root, "opencode.json"),
        USER_OPENCODE_CONFIG_JSONC: join(root, "opencode.jsonc"),
    }));
    return import(`./checker.ts?global-fixture=${importCounter++}`);
}

describe("auto-update-checker/checker", () => {
    describe("extractChannel", () => {
        test("returns latest for null, empty, and normal semver", async () => {
            const { extractChannel } = await freshCheckerImport();

            expect(extractChannel(null)).toBe("latest");
            expect(extractChannel("")).toBe("latest");
            expect(extractChannel("1.0.0")).toBe("latest");
        });

        test("keeps dist-tags and extracts common prerelease channels", async () => {
            const { extractChannel } = await freshCheckerImport();

            expect(extractChannel("beta")).toBe("beta");
            expect(extractChannel("next")).toBe("next");
            expect(extractChannel("1.0.0-alpha.1")).toBe("alpha");
            expect(extractChannel("2.3.4-beta.5")).toBe("beta");
            expect(extractChannel("0.1.0-rc.1")).toBe("rc");
            expect(extractChannel("1.0.0-canary.0")).toBe("canary");
        });
    });

    describe("findPluginEntry", () => {
        test("detects bare and @latest entries as unpinned", async () => {
            const existsSpy = spyOn(fs, "existsSync").mockImplementation((p: fs.PathLike) =>
                String(p).includes("opencode.json"),
            );
            const readSpy = spyOn(fs, "readFileSync").mockReturnValue(
                JSON.stringify({ plugin: ["@cortexkit/opencode-magic-context"] }),
            );
            const { findPluginEntry } = await freshCheckerImport();

            expect(findPluginEntry("/test")).toEqual({
                entry: "@cortexkit/opencode-magic-context",
                isPinned: false,
                pinnedVersion: null,
                configPath: "/test/.opencode/opencode.jsonc",
            });

            readSpy.mockReturnValue(
                JSON.stringify({ plugin: ["@cortexkit/opencode-magic-context@latest"] }),
            );
            expect(findPluginEntry("/test")?.isPinned).toBe(false);

            existsSpy.mockRestore();
            readSpy.mockRestore();
        });

        test("detects pinned tuple entries and ignores other scoped packages", async () => {
            const existsSpy = spyOn(fs, "existsSync").mockImplementation((p: fs.PathLike) =>
                String(p).includes("opencode.json"),
            );
            const readSpy = spyOn(fs, "readFileSync").mockReturnValue(
                JSON.stringify({
                    plugin: [
                        "@cortexkit/other@1.0.0",
                        ["@cortexkit/opencode-magic-context@0.15.6", {}],
                    ],
                }),
            );
            const { findPluginEntry } = await freshCheckerImport();

            const entry = findPluginEntry("/test");
            expect(entry?.entry).toBe("@cortexkit/opencode-magic-context@0.15.6");
            expect(entry?.isPinned).toBe(true);
            expect(entry?.pinnedVersion).toBe("0.15.6");

            existsSpy.mockRestore();
            readSpy.mockRestore();
        });
    });

    describe("getLocalDevVersion", () => {
        test("returns null when no local plugin path is configured", async () => {
            const existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);
            const { getLocalDevVersion } = await freshCheckerImport();

            expect(getLocalDevVersion("/test")).toBeNull();

            existsSpy.mockRestore();
        });

        test("returns version from a configured file:// local package", async () => {
            const existsSpy = spyOn(fs, "existsSync").mockImplementation((p: fs.PathLike) => {
                const value = String(p);
                return (
                    value.includes("opencode.json") || value === "/dev/magic-context/package.json"
                );
            });
            const statSpy = spyOn(fs, "statSync").mockImplementation(
                () => ({ isDirectory: () => true }) as fs.Stats,
            );
            const readSpy = spyOn(fs, "readFileSync").mockImplementation(
                (p: fs.PathOrFileDescriptor) => {
                    const value = String(p);
                    if (value.includes("opencode.json")) {
                        return JSON.stringify({ plugin: ["file:///dev/magic-context"] });
                    }
                    if (value === "/dev/magic-context/package.json") {
                        return JSON.stringify({
                            name: "@cortexkit/opencode-magic-context",
                            version: "1.2.3-dev",
                        });
                    }
                    return "";
                },
            );
            const { getLocalDevVersion } = await freshCheckerImport();

            expect(getLocalDevVersion("/test")).toBe("1.2.3-dev");

            existsSpy.mockRestore();
            statSpy.mockRestore();
            readSpy.mockRestore();
        });
    });

    describe("getCachedVersion and updatePinnedVersion", () => {
        test("does not derive package versions from guessed npm cache paths", async () => {
            const { getCachedVersion } = await freshCheckerImport();
            expect(getCachedVersion("@cortexkit/opencode-magic-context@latest")).toBeTruthy();
        });

        test("updates exact quoted pinned entry while preserving surrounding JSONC", async () => {
            const existsSpy = spyOn(fs, "existsSync").mockReturnValue(true);
            const readSpy = spyOn(fs, "readFileSync").mockReturnValue(
                '{\n  // plugins\n  "plugin": ["@cortexkit/opencode-magic-context@0.15.5"]\n}',
            );
            const writes: Array<{ path: string; data: string }> = [];
            const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(
                (path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView) => {
                    writes.push({ path: String(path), data: String(data) });
                },
            );
            const renames: Array<{ from: string; to: string }> = [];
            const renameSpy = spyOn(fs, "renameSync").mockImplementation(
                (from: fs.PathLike, to: fs.PathLike) => {
                    renames.push({ from: String(from), to: String(to) });
                },
            );
            const { updatePinnedVersion } = await freshCheckerImport();

            expect(
                updatePinnedVersion(
                    "/config/opencode.jsonc",
                    "@cortexkit/opencode-magic-context@0.15.5",
                    "0.15.6",
                ),
            ).toBe(true);
            expect(writes[0]?.data).toContain('"@cortexkit/opencode-magic-context@0.15.6"');
            expect(writes[0]?.data).toContain("// plugins");
            expect(writes[0]?.path).not.toBe("/config/opencode.jsonc");
            expect(writes[0]?.path).toContain("/config/opencode.jsonc.mc-tmp-");
            expect(renames[0]).toEqual({ from: writes[0]!.path, to: "/config/opencode.jsonc" });

            existsSpy.mockRestore();
            readSpy.mockRestore();
            writeSpy.mockRestore();
            renameSpy.mockRestore();
        });

        test("refuses to pin an invalid (non-semver) version and writes nothing", async () => {
            const existsSpy = spyOn(fs, "existsSync").mockReturnValue(true);
            const readSpy = spyOn(fs, "readFileSync").mockReturnValue(
                '{\n  "plugin": ["@cortexkit/opencode-magic-context@0.15.5"]\n}',
            );
            const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(() => {});
            const { updatePinnedVersion } = await freshCheckerImport();

            for (const bad of ["latest", "0.15", "1.2.3; rm -rf", '0.15.6"]} evil', ""]) {
                expect(
                    updatePinnedVersion(
                        "/config/opencode.jsonc",
                        "@cortexkit/opencode-magic-context@0.15.5",
                        bad,
                    ),
                ).toBe(false);
            }
            expect(writeSpy).not.toHaveBeenCalled();

            existsSpy.mockRestore();
            readSpy.mockRestore();
            writeSpy.mockRestore();
        });
    });

    describe("config winner transactions", () => {
        test("project bare spec shadows global exact spec and only project wins are edited", async () => {
            const project = makeProjectFixture();
            const global = makeProjectFixture();
            const projectServer = join(project, "opencode.json");
            const projectTui = join(project, "tui.json");
            const globalServer = join(global, "opencode.json");
            const globalTui = join(global, "tui.json");
            writePluginConfig(projectServer, PACKAGE_NAME);
            writePluginConfig(projectTui, PACKAGE_NAME);
            writePluginConfig(globalServer, `${PACKAGE_NAME}@0.15.5`);
            writePluginConfig(globalTui, `${PACKAGE_NAME}@0.15.5`);
            const globalServerBefore = readFileSync(globalServer, "utf-8");
            const checker = await freshCheckerWithGlobalRoot(global);

            const result = await checker.preparePluginUpdate(
                project,
                {
                    entry: PACKAGE_NAME,
                    isPinned: false,
                    pinnedVersion: null,
                    configPath: projectServer,
                },
                "0.15.6",
            );

            expect(result?.configPaths).toEqual([projectServer, projectTui]);
            expect(readFileSync(projectServer, "utf-8")).toContain(`${PACKAGE_NAME}@0.15.6`);
            expect(readFileSync(globalServer, "utf-8")).toBe(globalServerBefore);
        });

        test("leaves an explicit @latest winner unpinned", async () => {
            const root = makeProjectFixture();
            const override = join(root, "override");
            mkdirSync(override, { recursive: true });
            const projectServer = join(root, "opencode.json");
            const projectTui = join(root, "tui.json");
            const overrideServer = join(override, "opencode.json");
            const overrideTui = join(override, "tui.json");
            writePluginConfig(projectServer, PACKAGE_NAME);
            writePluginConfig(projectTui, PACKAGE_NAME);
            writePluginConfig(overrideServer, `${PACKAGE_NAME}@latest`);
            writePluginConfig(overrideTui, `${PACKAGE_NAME}@latest`);
            process.env.OPENCODE_CONFIG_DIR = override;

            const { preparePluginUpdate } = await freshCheckerImport();
            const result = await preparePluginUpdate(
                root,
                {
                    entry: PACKAGE_NAME,
                    isPinned: false,
                    pinnedVersion: null,
                    configPath: projectServer,
                },
                "0.15.6",
            );

            expect(result).toBeNull();
            expect(readFileSync(overrideServer, "utf-8")).toContain(`${PACKAGE_NAME}@latest`);
            expect(readFileSync(overrideTui, "utf-8")).toContain(`${PACKAGE_NAME}@latest`);
            expect(readFileSync(projectServer, "utf-8")).toContain(`"plugin": ["${PACKAGE_NAME}"]`);
        });

        test("repins an exact winning version and leaves shadowed entries unchanged", async () => {
            const root = makeProjectFixture();
            const projectServer = join(root, "opencode.json");
            const projectTui = join(root, "tui.json");
            const shadowedServer = join(root, ".opencode", "opencode.json");
            const shadowedTui = join(root, ".opencode", "tui.json");
            writePluginConfig(projectServer, `${PACKAGE_NAME}@latest`);
            writePluginConfig(projectTui, `${PACKAGE_NAME}@latest`);
            writePluginConfig(shadowedServer, `${PACKAGE_NAME}@0.15.5`);
            writePluginConfig(shadowedTui, `${PACKAGE_NAME}@0.15.5`);
            const projectBefore = readFileSync(projectServer, "utf-8");
            const logSpy = spyOn(logger, "log");

            const { preparePluginUpdate } = await freshCheckerImport();
            const result = await preparePluginUpdate(
                root,
                {
                    entry: `${PACKAGE_NAME}@0.15.5`,
                    isPinned: true,
                    pinnedVersion: "0.15.5",
                    configPath: shadowedServer,
                },
                "0.15.6",
            );

            expect(result?.configPaths).toEqual([shadowedServer, shadowedTui]);
            expect(readFileSync(shadowedServer, "utf-8")).toContain(`${PACKAGE_NAME}@0.15.6`);
            expect(readFileSync(projectServer, "utf-8")).toBe(projectBefore);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(shadowedServer));
        });

        test("leaves an explicit version range unpinned", async () => {
            const root = makeProjectFixture();
            const server = join(root, "opencode.json");
            const tui = join(root, "tui.json");
            writePluginConfig(server, `${PACKAGE_NAME}@^0.15.0`);
            writePluginConfig(tui, `${PACKAGE_NAME}@^0.15.0`);
            const serverBefore = readFileSync(server, "utf-8");
            const tuiBefore = readFileSync(tui, "utf-8");

            const { preparePluginUpdate } = await freshCheckerImport();
            const result = await preparePluginUpdate(
                root,
                {
                    entry: `${PACKAGE_NAME}@^0.15.0`,
                    isPinned: true,
                    pinnedVersion: "^0.15.0",
                    configPath: server,
                },
                "0.15.6",
            );

            expect(result).toBeNull();
            expect(readFileSync(server, "utf-8")).toBe(serverBefore);
            expect(readFileSync(tui, "utf-8")).toBe(tuiBefore);
        });

        test("restores both files when the second config write fails", async () => {
            const root = makeProjectFixture();
            const server = join(root, "opencode.json");
            const tui = join(root, "tui.json");
            writePluginConfig(server, PACKAGE_NAME);
            writePluginConfig(tui, PACKAGE_NAME);
            const serverBefore = readFileSync(server, "utf-8");
            const tuiBefore = readFileSync(tui, "utf-8");
            const originalRename = fs.renameSync;
            let renameCount = 0;
            spyOn(fs, "renameSync").mockImplementation((from, to) => {
                renameCount += 1;
                if (renameCount === 2) throw new Error("injected tui write failure");
                return originalRename(from, to);
            });

            const { preparePluginUpdate } = await freshCheckerImport();
            const result = await preparePluginUpdate(
                root,
                { entry: PACKAGE_NAME, isPinned: false, pinnedVersion: null, configPath: server },
                "0.15.6",
            );

            expect(result).toBeNull();
            expect(readFileSync(server, "utf-8")).toBe(serverBefore);
            expect(readFileSync(tui, "utf-8")).toBe(tuiBefore);
        });

        test("falls back to manual config updates when opencode is ENOENT", async () => {
            const root = makeProjectFixture();
            const server = join(root, "opencode.json");
            const tui = join(root, "tui.json");
            writePluginConfig(server, PACKAGE_NAME);
            writePluginConfig(tui, PACKAGE_NAME);
            const checker = await freshCheckerWithGlobalRoot(root);
            const proc = new EventEmitter();
            spyOn(fs, "renameSync");
            const childProcess = await import("node:child_process");
            spyOn(childProcess, "spawn").mockImplementation(() => {
                queueMicrotask(() =>
                    proc.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
                );
                return proc as childProcess.ChildProcess;
            });

            const result = await checker.preparePluginUpdate(
                root,
                { entry: PACKAGE_NAME, isPinned: false, pinnedVersion: null, configPath: server },
                "0.15.6",
            );

            expect(result?.spec).toBe(`${PACKAGE_NAME}@0.15.6`);
            expect(readFileSync(server, "utf-8")).toContain(`${PACKAGE_NAME}@0.15.6`);
            expect(readFileSync(tui, "utf-8")).toContain(`${PACKAGE_NAME}@0.15.6`);
        });

        test("rolls back a CLI install that patches only one global file", async () => {
            const root = makeProjectFixture();
            const server = join(root, "opencode.json");
            const tui = join(root, "tui.json");
            writePluginConfig(server, PACKAGE_NAME);
            writePluginConfig(tui, PACKAGE_NAME);
            const beforeServer = readFileSync(server, "utf-8");
            const beforeTui = readFileSync(tui, "utf-8");
            const checker = await freshCheckerWithGlobalRoot(root);
            const proc = new EventEmitter();
            const childProcess = await import("node:child_process");
            spyOn(childProcess, "spawn").mockImplementation(() => {
                writePluginConfig(server, `${PACKAGE_NAME}@0.15.6`);
                queueMicrotask(() => proc.emit("exit", 0));
                return proc as childProcess.ChildProcess;
            });

            const result = await checker.preparePluginUpdate(
                root,
                { entry: PACKAGE_NAME, isPinned: false, pinnedVersion: null, configPath: server },
                "0.15.6",
            );

            expect(result).toBeNull();
            expect(readFileSync(server, "utf-8")).toBe(beforeServer);
            expect(readFileSync(tui, "utf-8")).toBe(beforeTui);
        });
    });

    describe("getLatestVersion", () => {
        test("fetches channel dist-tag from npm registry package envelope", async () => {
            const fetchMock = mock(async () =>
                Response.json({ "dist-tags": { latest: "0.15.6", beta: "0.16.0-beta.1" } }),
            );
            const originalFetch = globalThis.fetch;
            globalThis.fetch = fetchMock;
            const { getLatestVersion } = await freshCheckerImport();

            expect(
                await getLatestVersion("beta", { registryUrl: "https://registry.example.test" }),
            ).toBe("0.16.0-beta.1");
            expect(fetchMock).toHaveBeenCalledWith(
                "https://registry.example.test/%40cortexkit/opencode-magic-context",
                expect.objectContaining({ headers: { Accept: "application/json" } }),
            );

            globalThis.fetch = originalFetch;
        });
    });
});
