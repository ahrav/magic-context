import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    __setEmbeddingRuntimeTestHooks,
    checkLocalEmbeddingRuntime,
    checkLocalEmbeddingRuntimeAt,
    checkLocalEmbeddingRuntimeByResolution,
    formatLocalEmbeddingRuntimeDoctorWarning,
} from "./embedding-runtime";

afterEach(() => {
    __setEmbeddingRuntimeTestHooks({});
});

function makeRoot(): string {
    return mkdtempSync(join(tmpdir(), "mc-embruntime-"));
}

function installPackage(root: string, withBinary: boolean): void {
    const pkgDir = join(root, "node_modules", "onnxruntime-node");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "onnxruntime-node", main: "index.js" }),
    );
    writeFileSync(join(pkgDir, "index.js"), "module.exports = {};\n");
    if (withBinary) {
        const binDir = join(pkgDir, "bin", "napi-v6", "win32", "x64");
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(binDir, "onnxruntime_binding.node"), "stub");
    }
}

describe("checkLocalEmbeddingRuntimeAt", () => {
    test("package + matching binary present → ok", () => {
        const root = makeRoot();
        try {
            installPackage(root, true);
            const status = checkLocalEmbeddingRuntimeAt(root, "win32", "x64");
            expect(status.state).toBe("ok");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("package missing entirely → package-missing (the #128 Windows case)", () => {
        const root = makeRoot();
        try {
            const status = checkLocalEmbeddingRuntimeAt(root, "win32", "x64");
            expect(status.state).toBe("package-missing");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("package present but platform binary missing → binary-missing", () => {
        const root = makeRoot();
        try {
            installPackage(root, false); // no .node binary
            const status = checkLocalEmbeddingRuntimeAt(root, "win32", "x64");
            expect(status.state).toBe("binary-missing");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("unknown platform/arch with package present → ok (don't false-alarm)", () => {
        const root = makeRoot();
        try {
            installPackage(root, false);
            const status = checkLocalEmbeddingRuntimeAt(
                root,
                "freebsd" as NodeJS.Platform,
                "ppc64",
            );
            expect(status.state).toBe("ok");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("child probe parses JSON load failures without requiring onnxruntime in-process", () => {
        const root = makeRoot();
        try {
            installPackage(root, true);
            __setEmbeddingRuntimeTestHooks({
                runOnnxRuntimeNodeLoadProbeChild: () => ({
                    stdout: JSON.stringify({
                        ok: false,
                        reason: "ERR_DLOPEN_FAILED: native binding failed",
                    }),
                    stderr: "",
                    status: 0,
                    signal: null,
                }),
            });

            const status = checkLocalEmbeddingRuntimeAt(root, "win32", "x64");

            expect(status.state).toBe("load-failed");
            if (status.state === "load-failed") {
                expect(status.reason).toContain("ERR_DLOPEN_FAILED");
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("child probe treats nonzero exits and stderr as load failures", () => {
        const root = makeRoot();
        try {
            installPackage(root, true);
            __setEmbeddingRuntimeTestHooks({
                runOnnxRuntimeNodeLoadProbeChild: () => ({
                    stdout: "",
                    stderr: "dyld: abort loading onnxruntime_binding.node",
                    status: 134,
                    signal: null,
                }),
            });

            const status = checkLocalEmbeddingRuntimeAt(root, "win32", "x64");

            expect(status.state).toBe("load-failed");
            if (status.state === "load-failed") {
                expect(status.reason).toContain("134");
                expect(status.reason).toContain("dyld: abort");
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("child probe treats timeouts as load failures with captured stderr", () => {
        const root = makeRoot();
        try {
            installPackage(root, true);
            const timeout = Object.assign(new Error("spawnSync node ETIMEDOUT"), {
                code: "ETIMEDOUT",
            });
            __setEmbeddingRuntimeTestHooks({
                runOnnxRuntimeNodeLoadProbeChild: () => ({
                    stdout: "",
                    stderr: "probe hung while loading native addon",
                    status: null,
                    signal: "SIGTERM",
                    error: timeout,
                }),
            });

            const status = checkLocalEmbeddingRuntimeAt(root, "win32", "x64");

            expect(status.state).toBe("load-failed");
            if (status.state === "load-failed") {
                expect(status.reason).toContain("timed out");
                expect(status.reason).toContain("probe hung");
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("checkLocalEmbeddingRuntime (multi-root)", () => {
    test("no candidate root exists → unknown (stay silent)", () => {
        const status = checkLocalEmbeddingRuntime([
            join(tmpdir(), "does-not-exist-mc-1"),
            join(tmpdir(), "does-not-exist-mc-2"),
        ]);
        expect(status.state).toBe("unknown");
    });

    test("first root broken, second ok → returns ok", () => {
        const broken = makeRoot();
        const good = makeRoot();
        try {
            installPackage(good, true);
            const status = checkLocalEmbeddingRuntime([broken, good], "win32", "x64");
            expect(status.state).toBe("ok");
        } finally {
            rmSync(broken, { recursive: true, force: true });
            rmSync(good, { recursive: true, force: true });
        }
    });

    test("existing root with missing package → package-missing", () => {
        const root = makeRoot();
        try {
            const status = checkLocalEmbeddingRuntime([root], "win32", "x64");
            expect(status.state).toBe("package-missing");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

function installResolvablePlugin(
    withPackage: boolean,
    withBinary: boolean,
    indexSource = "module.exports = {};\n",
): string {
    const pluginDir = mkdtempSync(join(tmpdir(), "mc-pi-plugin-"));
    writeFileSync(
        join(pluginDir, "package.json"),
        JSON.stringify({ name: "@cortexkit/pi-magic-context", version: "0.0.0" }),
    );
    if (withPackage) {
        const pkgDir = join(pluginDir, "node_modules", "onnxruntime-node");
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(
            join(pkgDir, "package.json"),
            JSON.stringify({ name: "onnxruntime-node", main: "index.js" }),
        );
        writeFileSync(join(pkgDir, "index.js"), indexSource);
        if (withBinary) {
            const binDir = join(pkgDir, "bin", "napi-v6", "win32", "x64");
            mkdirSync(binDir, { recursive: true });
            writeFileSync(join(binDir, "onnxruntime_binding.node"), "stub");
        }
    }
    return pluginDir;
}

describe("checkLocalEmbeddingRuntimeByResolution", () => {
    test("resolvable package + matching binary → ok (dev-path/hoisted layout)", () => {
        const dir = installResolvablePlugin(true, true);
        try {
            expect(checkLocalEmbeddingRuntimeByResolution(dir, "win32", "x64").state).toBe("ok");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("resolvable package + matching binary that fails to load → load-failed", () => {
        const dir = installResolvablePlugin(
            true,
            true,
            "const err = new Error('onnxruntime_binding.node failed to load');\n" +
                "err.code = 'ERR_DLOPEN_FAILED';\n" +
                "throw err;\n",
        );
        try {
            const status = checkLocalEmbeddingRuntimeByResolution(dir, "win32", "x64");
            expect(status.state).toBe("load-failed");
            if (status.state === "load-failed") {
                expect(status.reason).toContain("ERR_DLOPEN_FAILED");
                expect(formatLocalEmbeddingRuntimeDoctorWarning(status)).toContain(
                    "onnxruntime-node native binding missing",
                );
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("resolvable package but missing platform binary → binary-missing", () => {
        const dir = installResolvablePlugin(true, false);
        try {
            expect(checkLocalEmbeddingRuntimeByResolution(dir, "win32", "x64").state).toBe(
                "binary-missing",
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("plugin exists but onnxruntime-node not resolvable → package-missing (#128)", () => {
        const dir = installResolvablePlugin(false, false);
        try {
            expect(checkLocalEmbeddingRuntimeByResolution(dir, "win32", "x64").state).toBe(
                "package-missing",
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("plugin dir does not exist → unknown (stay silent, never false-alarm)", () => {
        expect(
            checkLocalEmbeddingRuntimeByResolution(
                join(tmpdir(), "mc-pi-plugin-nonexistent-xyz"),
                "win32",
                "x64",
            ).state,
        ).toBe("unknown");
    });

    test("unknown platform/arch with package resolvable → ok (don't guess a binary)", () => {
        const dir = installResolvablePlugin(true, false);
        try {
            expect(
                checkLocalEmbeddingRuntimeByResolution(dir, "freebsd" as NodeJS.Platform, "ppc64")
                    .state,
            ).toBe("ok");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
