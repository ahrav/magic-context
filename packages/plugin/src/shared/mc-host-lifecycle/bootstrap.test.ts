import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    closeSync,
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    BootstrapError,
    checkCapacity,
    checkPlatform,
    containedWithin,
    copyExactBytes,
    loadTrustIndex,
    MAX_TRUST_INDEX_BYTES,
    type PlatformReaders,
    resolvePayloadPackageDir,
    revalidateRetainedBootstrap,
    stageBootstrap,
} from "./bootstrap";

function tempDir(prefix: string): string {
    return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(bytes: Buffer | string): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Run `body` without `process.getuid` to simulate a host whose ownership checks cannot determine a UID.
 * Run `body` without `process.getuid` to simulate a host whose ownership checks cannot determine a UID.
 */
function withoutGetuid<T>(body: () => T): T {
    const holder = process as { getuid?: () => number };
    const original = holder.getuid;
    holder.getuid = undefined;
    try {
        return body();
    } finally {
        holder.getuid = original;
    }
}

/* */
function reasonOf(body: () => unknown): string | null {
    try {
        body();
        return null;
    } catch (error) {
        return (error as BootstrapError).reason;
    }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

function linuxReaders(overrides: Partial<PlatformReaders> = {}): PlatformReaders {
    return {
        platform: "linux",
        arch: "x64",
        kernelRelease: () => "5.10.230-generic",
        glibcVersion: () => "2.34",
        procSelfFdUsable: () => true,
        ...overrides,
    };
}

describe("platform gate (U3 scenario 5)", () => {
    test("exact-floor Linux passes: kernel 4.18, glibc 2.28, real self-fd", () => {
        const gate = checkPlatform(
            linuxReaders({ kernelRelease: () => "4.18.0", glibcVersion: () => "2.28" }),
        );
        expect(gate).toEqual({ ok: true, target: "linux-x64-gnu" });
    });

    test("below-floor, musl-like, capability-missing, and unverifiable hosts fail", () => {
        const rejected: Array<[string, PlatformReaders]> = [
            ["kernel 4.17", linuxReaders({ kernelRelease: () => "4.17.19" })],
            ["glibc 2.27", linuxReaders({ glibcVersion: () => "2.27" })],
            ["musl (no glibc runtime)", linuxReaders({ glibcVersion: () => null })],
            ["no procfs self-fd", linuxReaders({ procSelfFdUsable: () => false })],
            ["non-x64", linuxReaders({ arch: "arm64" })],
            ["unparseable kernel", linuxReaders({ kernelRelease: () => "next" })],
        ];
        for (const [name, readers] of rejected) {
            const gate = checkPlatform(readers);
            expect({ name, ok: gate.ok }).toEqual({ name, ok: false });
            if (!gate.ok) expect(gate.reason).toBe("unsupported_platform");
        }
    });

    test("unknown operating systems are unsupported before any package byte", () => {
        expect(checkPlatform(linuxReaders({ platform: "darwin" })).ok).toBe(false);
        expect(checkPlatform(linuxReaders({ platform: "win32" })).ok).toBe(false);
        expect(checkPlatform(linuxReaders({ platform: "freebsd" })).ok).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe("install layout resolution (U3 scenario 4)", () => {
    const PKG = "@cortexkit/mc-host-linux-x64-gnu";

    test("a nested physical directory resolves as npm_nested", () => {
        const root = tempDir("mc-layout-nested-");
        try {
            const pkgDir = path.join(root, "node_modules", PKG);
            mkdirSync(pkgDir, { recursive: true });
            const resolved = resolvePayloadPackageDir({
                declaringParentRoot: root,
                packageName: PKG,
            });
            expect(resolved).toEqual({ ok: true, layout: "npm_nested", packageDir: pkgDir });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a hoisted physical directory within eight parent segments resolves", () => {
        const root = tempDir("mc-layout-hoist-");
        try {
            const parent = path.join(root, "node_modules", "@cortexkit", "magic-context");
            mkdirSync(parent, { recursive: true });
            const pkgDir = path.join(root, "node_modules", PKG);
            mkdirSync(pkgDir, { recursive: true });
            const resolved = resolvePayloadPackageDir({
                declaringParentRoot: parent,
                packageName: PKG,
            });
            expect(resolved).toEqual({ ok: true, layout: "npm_hoisted", packageDir: pkgDir });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("an over-depth hoist is not found: native_payload_missing, no wider search", () => {
        const root = tempDir("mc-layout-deep-");
        try {
            let parent = root;
            for (let i = 0; i < 10; i++) parent = path.join(parent, `level-${i}`);
            mkdirSync(parent, { recursive: true });
            mkdirSync(path.join(root, "node_modules", PKG), { recursive: true });
            const resolved = resolvePayloadPackageDir({
                declaringParentRoot: parent,
                packageName: PKG,
            });
            expect(resolved.ok).toBe(false);
            if (!resolved.ok) expect(resolved.reason).toBe("native_payload_missing");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a Bun same-install .bun link resolves as bun_physical_link", () => {
        const root = tempDir("mc-layout-bun-");
        try {
            const store = path.join(
                root,
                "node_modules",
                ".bun",
                "@cortexkit+mc-host-linux-x64-gnu@0.38.0",
                "node_modules",
                PKG,
            );
            mkdirSync(store, { recursive: true });
            mkdirSync(path.join(root, "node_modules", "@cortexkit"), { recursive: true });
            symlinkSync(store, path.join(root, "node_modules", PKG));
            const resolved = resolvePayloadPackageDir({
                declaringParentRoot: root,
                packageName: PKG,
            });
            expect(resolved.ok).toBe(true);
            if (resolved.ok) expect(resolved.layout).toBe("bun_physical_link");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a cross-install or arbitrary symlink is unsupported_install_layout", () => {
        const root = tempDir("mc-layout-cross-");
        const other = tempDir("mc-layout-other-");
        try {
            const foreign = path.join(other, "node_modules", PKG);
            mkdirSync(foreign, { recursive: true });
            mkdirSync(path.join(root, "node_modules", "@cortexkit"), { recursive: true });
            symlinkSync(foreign, path.join(root, "node_modules", PKG));
            const resolved = resolvePayloadPackageDir({
                declaringParentRoot: root,
                packageName: PKG,
            });
            expect(resolved.ok).toBe(false);
            if (!resolved.ok) expect(resolved.reason).toBe("unsupported_install_layout");
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(other, { recursive: true, force: true });
        }
    });

    test("an explicit external compiled-host root resolves only its physical shape", () => {
        const external = tempDir("mc-layout-external-");
        try {
            const pkgDir = path.join(external, "node_modules", PKG);
            mkdirSync(pkgDir, { recursive: true });
            const resolved = resolvePayloadPackageDir({
                declaringParentRoot: "/nonexistent-parent",
                packageName: PKG,
                explicitExternalRoot: external,
            });
            expect(resolved).toEqual({
                ok: true,
                layout: "compiled_bun_external",
                packageDir: pkgDir,
            });
            const missing = resolvePayloadPackageDir({
                declaringParentRoot: "/nonexistent-parent",
                packageName: PKG,
                explicitExternalRoot: path.join(external, "empty"),
            });
            expect(missing.ok).toBe(false);
            if (!missing.ok) expect(missing.reason).toBe("unsupported_install_layout");
        } finally {
            rmSync(external, { recursive: true, force: true });
        }
    });

    test("a regular file at the package path is unsupported_install_layout", () => {
        const root = tempDir("mc-layout-file-");
        try {
            mkdirSync(path.join(root, "node_modules", "@cortexkit"), { recursive: true });
            writeFileSync(path.join(root, "node_modules", PKG), "not a dir");
            const resolved = resolvePayloadPackageDir({
                declaringParentRoot: root,
                packageName: PKG,
            });
            expect(resolved.ok).toBe(false);
            if (!resolved.ok) expect(resolved.reason).toBe("unsupported_install_layout");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a store directory whose name merely ends in node_modules is not certified", () => {
        const root = tempDir("mc-layout-bun-suffix-");
        try {
            // `xnode_modules` is not a `node_modules` path component, so the link is not a Bun store path.
            // `xnode_modules` is not a `node_modules` path component, so the link is not a Bun store path.
            // `xnode_modules` is not a `node_modules` path component, so the link is not a Bun store path.
            const store = path.join(
                root,
                "node_modules",
                ".bun",
                "@cortexkit+mc-host-linux-x64-gnu@0.38.0",
                "xnode_modules",
                ...PKG.split("/"),
            );
            mkdirSync(store, { recursive: true });
            mkdirSync(path.join(root, "node_modules", "@cortexkit"), { recursive: true });
            symlinkSync(store, path.join(root, "node_modules", PKG));
            const resolved = resolvePayloadPackageDir({
                declaringParentRoot: root,
                packageName: PKG,
            });
            expect(resolved.ok).toBe(false);
            if (!resolved.ok) expect(resolved.reason).toBe("unsupported_install_layout");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("an uninspectable nearer candidate stops the walk, never yielding to an ancestor", () => {
        const root = tempDir("mc-layout-inaccessible-");
        try {
            // The ancestor contains a real payload directory, but the nearer candidate is behind a self-referential `node_modules` symlink, which fails with `ELOOP` rather than absence and therefore prevents climbing to the ancestor.
            // The ancestor contains a real payload directory, but the nearer candidate is behind a self-referential `node_modules` symlink, which fails with `ELOOP` rather than absence and therefore prevents climbing to the ancestor.
            // The ancestor contains a real payload directory, but the nearer candidate is behind a self-referential `node_modules` symlink, which fails with `ELOOP` rather than absence and therefore prevents climbing to the ancestor.
            // The ancestor contains a real payload directory, but the nearer candidate is behind a self-referential `node_modules` symlink, which fails with `ELOOP` rather than absence and therefore prevents climbing to the ancestor.
            mkdirSync(path.join(root, "node_modules", PKG), { recursive: true });
            const child = path.join(root, "child");
            mkdirSync(child);
            symlinkSync("node_modules", path.join(child, "node_modules"));
            const resolved = resolvePayloadPackageDir({
                declaringParentRoot: child,
                packageName: PKG,
            });
            expect(resolved.ok).toBe(false);
            if (!resolved.ok) expect(resolved.reason).toBe("unsupported_install_layout");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a non-directory ancestor component is absence, so the walk still climbs", () => {
        const root = tempDir("mc-layout-notdir-");
        try {
            mkdirSync(path.join(root, "node_modules", PKG), { recursive: true });
            const child = path.join(root, "child");
            mkdirSync(child);
            // A regular file at `node_modules` produces `ENOTDIR`, which counts as absence.
            // A regular file at `node_modules` produces `ENOTDIR`, which counts as absence.
            writeFileSync(path.join(child, "node_modules"), "not a dir");
            const resolved = resolvePayloadPackageDir({
                declaringParentRoot: child,
                packageName: PKG,
            });
            expect(resolved).toEqual({
                ok: true,
                layout: "npm_hoisted",
                packageDir: path.join(root, "node_modules", PKG),
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe("capacity preflight (U3 scenario 7)", () => {
    const MIB = 1024n * 1024n;

    test("exactly required + reserve passes; one byte below fails", () => {
        const required = 100n * MIB;
        const reserve = 256n * MIB;
        expect(checkCapacity(required, required + reserve)).toEqual({ ok: true });
        const below = checkCapacity(required, required + reserve - 1n);
        expect(below.ok).toBe(false);
        if (!below.ok) expect(below.reason).toBe("insufficient_storage");
    });

    test("ten-percent reserve governs above the 256 MiB floor with ceiling division", () => {
        const required = 4000n * MIB;
        const reserve = 400n * MIB;
        expect(checkCapacity(required, required + reserve)).toEqual({ ok: true });
        expect(checkCapacity(required, required + reserve - 1n).ok).toBe(false);
        const odd = 2561n * MIB + 3n;
        const oddReserve = (odd + 9n) / 10n;
        expect(checkCapacity(odd, odd + oddReserve)).toEqual({ ok: true });
        expect(checkCapacity(odd, odd + oddReserve - 1n).ok).toBe(false);
    });

    test("impossible requirements are native_payload_invalid, not storage failures", () => {
        for (const bad of [-1n, 1n << 61n]) {
            const verdict = checkCapacity(bad, 1n << 62n);
            expect(verdict.ok).toBe(false);
            if (!verdict.ok) expect(verdict.reason).toBe("native_payload_invalid");
        }
        const negativeAvailable = checkCapacity(1n, -1n);
        expect(negativeAvailable.ok).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe("payload trust index", () => {
    const digest = "a".repeat(64);
    const validIndex = {
        schema: "magic-context.mc-host-payload-index/v1",
        release: { id: "mc-host-release", version: "0.38.0" },
        entries: [
            {
                package: "@cortexkit/mc-host-linux-x64-gnu",
                version: "0.38.0",
                target: "linux-x64-gnu",
                qualified: true,
                payload_manifest_digest: digest,
                bootstrap_launcher_digest: digest,
            },
        ],
    };

    test("an absent index is null (native_payload_missing at staging time)", () => {
        expect(loadTrustIndex("/nonexistent/mc-host-payload-index.json")).toBeNull();
    });

    test("a valid index decodes strictly", () => {
        const dir = tempDir("mc-trust-");
        try {
            const indexPath = path.join(dir, "index.json");
            writeFileSync(indexPath, JSON.stringify(validIndex));
            const index = loadTrustIndex(indexPath);
            expect(index?.entries.length).toBe(1);
            expect(index?.entries[0]?.bootstrap_launcher_digest).toBe(digest);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("wrong schema, wrong release, and noncanonical digests are invalid", () => {
        const dir = tempDir("mc-trust-bad-");
        try {
            const cases = [
                { ...validIndex, schema: "other/v1" },
                {
                    ...validIndex,
                    release: { id: "mc-host-release", version: "0.37.0" },
                },
                {
                    ...validIndex,
                    entries: [
                        {
                            ...validIndex.entries[0],
                            bootstrap_launcher_digest: "ZZ",
                        },
                    ],
                },
                "not-json{",
            ];
            cases.forEach((body, i) => {
                const indexPath = path.join(dir, `index-${i}.json`);
                writeFileSync(indexPath, typeof body === "string" ? body : JSON.stringify(body));
                expect(() => loadTrustIndex(indexPath)).toThrow(BootstrapError);
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("file shape decides provenance before the schema is parsed", () => {
        const dir = tempDir("mc-trust-shape-");
        try {
            // Identical schema-valid contents, file type, link count, write bits, and size do not distinguish indexes this process could have written.
            // Identical schema-valid contents, file type, link count, write bits, and size do not distinguish indexes this process could have written.
            // Identical schema-valid contents, file type, link count, write bits, and size do not distinguish indexes this process could have written.
            const body = JSON.stringify(validIndex);
            const target = path.join(dir, "target.json");
            writeFileSync(target, body);
            const symlinked = path.join(dir, "symlinked.json");
            symlinkSync(target, symlinked);

            const shared = path.join(dir, "shared.json");
            writeFileSync(shared, body);
            linkSync(shared, path.join(dir, "shared-alias.json"));
            expect(lstatSync(shared).nlink).toBe(2);

            const writable = path.join(dir, "writable.json");
            writeFileSync(writable, body);
            chmodSync(writable, 0o666);

            // JSON parsing ignores trailing whitespace, so the byte cap alone rejects an oversize index.
            // JSON parsing ignores trailing whitespace, so the byte cap alone rejects an oversize index.
            const oversize = path.join(dir, "oversize.json");
            writeFileSync(oversize, `${body}${" ".repeat(MAX_TRUST_INDEX_BYTES + 1)}`);

            const cases: Array<[string, string]> = [
                ["symlinked", symlinked],
                ["shared link", shared],
                ["group/world writable", writable],
                ["oversize", oversize],
            ];
            for (const [name, candidate] of cases) {
                expect({ name, reason: reasonOf(() => loadTrustIndex(candidate)) }).toEqual({
                    name,
                    reason: "native_payload_invalid",
                });
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("a host without process.getuid cannot certify an index at all", () => {
        const dir = tempDir("mc-trust-nouid-");
        try {
            const indexPath = path.join(dir, "index.json");
            writeFileSync(indexPath, JSON.stringify(validIndex));
            expect(loadTrustIndex(indexPath)?.entries.length).toBe(1);
            const reason = withoutGetuid(() => reasonOf(() => loadTrustIndex(indexPath)));
            expect(reason).toBe("unsupported_platform");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe("bootstrap staging (U3 scenarios 3 and 6)", () => {
    test("a regular source stages into a single-link owner-only executable", () => {
        const dir = tempDir("mc-stage-");
        try {
            const source = path.join(dir, "launcher");
            const bytes = Buffer.from("#!/bin/true\nlauncher-bytes\n");
            writeFileSync(source, bytes, { mode: 0o755 });
            const staged = stageBootstrap({
                sourcePath: source,
                destDir: path.join(dir, "store"),
                expectedSha256: sha256(bytes),
                availableBytesOverride: 1n << 40n,
            });
            closeSync(staged.fd);
            const stat = lstatSync(staged.path);
            expect(stat.nlink).toBe(1);
            expect(stat.mode & 0o777).toBe(0o500);
            expect(readFileSync(staged.path)).toEqual(bytes);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("a hardlinked package-cache source is accepted and yields independent bytes", () => {
        const dir = tempDir("mc-stage-hardlink-");
        try {
            const original = path.join(dir, "cache-object");
            const bytes = Buffer.from("hardlinked-launcher\n");
            writeFileSync(original, bytes, { mode: 0o644 });
            const linked = path.join(dir, "pkg-launcher");
            linkSync(original, linked);
            expect(lstatSync(linked).nlink).toBe(2);
            const staged = stageBootstrap({
                sourcePath: linked,
                destDir: path.join(dir, "store"),
                expectedSha256: sha256(bytes),
                availableBytesOverride: 1n << 40n,
            });
            closeSync(staged.fd);
            const stagedStat = lstatSync(staged.path);
            expect(stagedStat.nlink).toBe(1);
            expect(stagedStat.ino).not.toBe(lstatSync(original).ino);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("symlink and FIFO sources are rejected before any output exists", () => {
        const dir = tempDir("mc-stage-hazard-");
        try {
            const real = path.join(dir, "real");
            writeFileSync(real, "bytes");
            const link = path.join(dir, "link");
            symlinkSync(real, link);
            expect(() =>
                stageBootstrap({
                    sourcePath: link,
                    destDir: path.join(dir, "store"),
                    expectedSha256: "b".repeat(64),
                    availableBytesOverride: 1n << 40n,
                }),
            ).toThrow(BootstrapError);
            const fifo = path.join(dir, "fifo");
            execFileSync("mkfifo", [fifo]);
            let fifoError: BootstrapError | null = null;
            try {
                stageBootstrap({
                    sourcePath: fifo,
                    destDir: path.join(dir, "store"),
                    expectedSha256: "b".repeat(64),
                    availableBytesOverride: 1n << 40n,
                });
            } catch (error) {
                fifoError = error as BootstrapError;
            }
            expect(fifoError).toBeInstanceOf(BootstrapError);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("a digest mismatch stages nothing at the final name", () => {
        const dir = tempDir("mc-stage-digest-");
        try {
            const source = path.join(dir, "launcher");
            writeFileSync(source, "actual-bytes");
            const wrong = "c".repeat(64);
            expect(() =>
                stageBootstrap({
                    sourcePath: source,
                    destDir: path.join(dir, "store"),
                    expectedSha256: wrong,
                    availableBytesOverride: 1n << 40n,
                }),
            ).toThrow(BootstrapError);
            expect(() => lstatSync(path.join(dir, "store", wrong))).toThrow();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("insufficient capacity fails before the temp is created", () => {
        const dir = tempDir("mc-stage-capacity-");
        try {
            const source = path.join(dir, "launcher");
            writeFileSync(source, "bytes");
            let reason: string | null = null;
            try {
                stageBootstrap({
                    sourcePath: source,
                    destDir: path.join(dir, "store"),
                    expectedSha256: sha256("bytes"),
                    availableBytesOverride: 0n,
                });
            } catch (error) {
                reason = (error as BootstrapError).reason;
            }
            expect(reason).toBe("insufficient_storage");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("a present but unopenable launcher source is invalid, not missing", () => {
        // Only true absence returns `native_payload_missing` / `install_native_payload`; a present source that cannot be opened safely is untrustworthy rather than missing.
        // Only true absence returns `native_payload_missing` / `install_native_payload`; a present source that cannot be opened safely is untrustworthy rather than missing.
        // Only true absence returns `native_payload_missing` / `install_native_payload`; a present source that cannot be opened safely is untrustworthy rather than missing.
        // Only true absence returns `native_payload_missing` / `install_native_payload`; a present source that cannot be opened safely is untrustworthy rather than missing.
        // Only true absence returns `native_payload_missing` / `install_native_payload`; a present source that cannot be opened safely is untrustworthy rather than missing.
        const dir = tempDir("mc-stage-present-invalid-");
        try {
            const real = path.join(dir, "real-launcher");
            writeFileSync(real, "bytes");
            const link = path.join(dir, "launcher-link");
            symlinkSync(real, link);
            const reasonFor = (sourcePath: string): string | null => {
                try {
                    stageBootstrap({
                        sourcePath,
                        destDir: path.join(dir, "store"),
                        expectedSha256: sha256("bytes"),
                        availableBytesOverride: 1n << 40n,
                    });
                } catch (error) {
                    return (error as BootstrapError).reason;
                }
                return null;
            };
            // O_NOFOLLOW rejects the symlink with ELOOP: present, untrustworthy.
            expect(reasonFor(link)).toBe("native_payload_invalid");
            expect(reasonFor(path.join(dir, "no-such-launcher"))).toBe("native_payload_missing");
            // ENOTDIR — a file used as a directory component — is also absence.
            expect(reasonFor(path.join(real, "under-a-file"))).toBe("native_payload_missing");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("containment holds at the filesystem root and at name boundaries", () => {
        // Containment failures and missing candidates bypass `resolvePayloadPackageDir`, so tests pass direct paths.
        // Direct paths distinguish containment failures from missing candidates.
        const dir = tempDir("mc-contained-");
        try {
            const fsRoot = path.parse(dir).root;
            // `realpath("/")` is `/`; appending a separator produces `//`, so a string-prefix containment test rejects every descendant.
            // `realpath("/")` is `/`; appending a separator produces `//`, so a string-prefix containment test rejects every descendant.
            // `realpath("/")` is `/`; appending a separator produces `//`, so a string-prefix containment test rejects every descendant.
            expect(containedWithin(fsRoot, "/tmp")).toBe(true);
            expect(containedWithin(fsRoot, fsRoot)).toBe(true);

            // A sibling whose name merely starts with the root's name is outside the root.
            // Containment requires the root itself or a path beginning with the root followed by a separator; a sibling sharing the root's prefix is outside.
            // all.
            const app = path.join(dir, "app");
            const application = path.join(dir, "application");
            mkdirSync(path.join(app, "inside"), { recursive: true });
            mkdirSync(path.join(application, "inside"), { recursive: true });
            expect(containedWithin(app, path.join(app, "inside"))).toBe(true);
            expect(containedWithin(app, app)).toBe(true);
            expect(containedWithin(app, path.join(application, "inside"))).toBe(false);
            // A parent is not contained in its own child.
            expect(containedWithin(path.join(app, "inside"), app)).toBe(false);
            // An unresolvable side is not containment.
            expect(containedWithin(app, path.join(app, "no-such-entry"))).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("a payload reached through a symlinked ancestor is not certified", () => {
        // classifyEntry lstat calls follow ancestor symlinks before classifying the final component.
        // A node_modules or scope symlink to another install would certify a foreign package as local.
        const dir = tempDir("mc-layout-ancestor-");
        try {
            const pkg = "@cortexkit/mc-host-linux-x64-gnu";
            const foreign = path.join(dir, "foreign");
            mkdirSync(path.join(foreign, "node_modules", ...pkg.split("/")), { recursive: true });

            const viaNodeModules = path.join(dir, "root-nm");
            mkdirSync(viaNodeModules, { recursive: true });
            symlinkSync(
                path.join(foreign, "node_modules"),
                path.join(viaNodeModules, "node_modules"),
            );
            const nmVerdict = resolvePayloadPackageDir({
                declaringParentRoot: viaNodeModules,
                packageName: pkg,
            });
            expect(nmVerdict.ok).toBe(false);
            if (!nmVerdict.ok) expect(nmVerdict.reason).toBe("unsupported_install_layout");

            const viaScope = path.join(dir, "root-scope");
            mkdirSync(path.join(viaScope, "node_modules"), { recursive: true });
            symlinkSync(
                path.join(foreign, "node_modules", "@cortexkit"),
                path.join(viaScope, "node_modules", "@cortexkit"),
            );
            const scopeVerdict = resolvePayloadPackageDir({
                declaringParentRoot: viaScope,
                packageName: pkg,
            });
            expect(scopeVerdict.ok).toBe(false);

            // An external root may not escape its declared root.
            const extRoot = path.join(dir, "ext");
            mkdirSync(extRoot, { recursive: true });
            symlinkSync(path.join(foreign, "node_modules"), path.join(extRoot, "node_modules"));
            const extVerdict = resolvePayloadPackageDir({
                declaringParentRoot: path.join(dir, "unused"),
                packageName: pkg,
                explicitExternalRoot: extRoot,
            });
            expect(extVerdict.ok).toBe(false);

            // Containment, rather than canonical equality, permits ancestor symlinks that resolve inside the install.
            const honest = path.join(dir, "root-ok");
            mkdirSync(path.join(honest, "real", "node_modules", ...pkg.split("/")), {
                recursive: true,
            });
            symlinkSync(
                path.join(honest, "real", "node_modules"),
                path.join(honest, "node_modules"),
            );
            const okVerdict = resolvePayloadPackageDir({
                declaringParentRoot: honest,
                packageName: pkg,
            });
            expect(okVerdict.ok).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("the staging copy is bounded by the preflighted size, not the live EOF", () => {
        // expectedBytes must equal the source's current size; a mismatch indicates mutation after preflight.
        // A source larger than expectedBytes grew after preflight; a smaller source was truncated.
        // Reject size mismatches because the source changed after preflight.
        const dir = tempDir("mc-copy-exact-");
        try {
            const source = path.join(dir, "launcher");
            writeFileSync(source, "a".repeat(8192));
            const sink = path.join(dir, "sink");

            const grownIn = openSync(source, "r");
            const grownOut = openSync(sink, "w");
            try {
                expect(() => copyExactBytes(grownIn, grownOut, 4096, createHash("sha256"))).toThrow(
                    /grew during staging/,
                );
                // The copy wrote no bytes beyond the preflighted size.
                expect(lstatSync(sink).size).toBe(4096);
            } finally {
                closeSync(grownIn);
                closeSync(grownOut);
            }

            const shrunkIn = openSync(source, "r");
            const shrunkOut = openSync(sink, "w");
            try {
                expect(() =>
                    copyExactBytes(shrunkIn, shrunkOut, 16384, createHash("sha256")),
                ).toThrow(/shrank during staging/);
            } finally {
                closeSync(shrunkIn);
                closeSync(shrunkOut);
            }

            // An exact match copies the bytes and hashes what it copied.
            const okIn = openSync(source, "r");
            const okOut = openSync(sink, "w");
            try {
                const hash = createHash("sha256");
                copyExactBytes(okIn, okOut, 8192, hash);
                expect(hash.digest("hex")).toBe(sha256("a".repeat(8192)));
                expect(lstatSync(sink).size).toBe(8192);
            } finally {
                closeSync(okIn);
                closeSync(okOut);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("an unmapped filesystem error still becomes a closed lifecycle reason", () => {
        // A dangling-symlink destination makes mkdirSync throw EEXIST.
        // An unhandled EEXIST escapes as a bare Error with no reason.
        // Callers branch on a closed union, so EEXIST must map to a union member.
        // mishandles it.
        const dir = tempDir("mc-stage-unmapped-");
        try {
            const source = path.join(dir, "launcher");
            writeFileSync(source, "bytes");
            const dest = path.join(dir, "store");
            symlinkSync(path.join(dir, "nonexistent-target"), dest);
            let error: unknown = null;
            try {
                stageBootstrap({
                    sourcePath: source,
                    destDir: dest,
                    expectedSha256: sha256("bytes"),
                    availableBytesOverride: 1n << 40n,
                });
            } catch (caught) {
                error = caught;
            }
            expect(error).toBeInstanceOf(BootstrapError);
            expect((error as BootstrapError).reason).toBe("native_payload_invalid");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("a byte-invalid trust index is rejected, not silently repaired", () => {
        // Lossy UTF-8 decoding lets byte-corrupt metadata pass all trust-index shape checks.
        // Byte-corrupt package metadata must not cross the trust boundary as trusted metadata.
        // valid index.
        const dir = tempDir("mc-trust-utf8-");
        try {
            const valid = JSON.stringify({
                schema: "magic-context.payload-index/v1",
                package: "@cortexkit/mc-host-linux-x64-gnu",
                version: "0.38.0",
                launcher_rel_path: "bin/ck-mc-host",
                launcher_sha256: "a".repeat(64),
                payload_manifest_digest: "b".repeat(64),
            });
            const marker = '"package":"@cortexkit/mc-host-linux-x64-gnu"';
            expect(valid).toContain(marker);
            const [head, tail] = valid.split(marker) as [string, string];
            const corrupt = Buffer.concat([
                Buffer.from(head, "utf8"),
                Buffer.from('"package":"@cortexkit/mc-host', "utf8"),
                Buffer.from([0xff]),
                Buffer.from('-linux-x64-gnu"', "utf8"),
                Buffer.from(tail, "utf8"),
            ]);
            expect(() => JSON.parse(corrupt.toString("utf8"))).not.toThrow();

            const indexPath = path.join(dir, "mc-host-payload-index.json");
            writeFileSync(indexPath, corrupt, { mode: 0o600 });
            let reason: string | null = null;
            let message = "";
            try {
                loadTrustIndex(indexPath);
            } catch (error) {
                reason = (error as BootstrapError).reason;
                message = (error as Error).message;
            }
            expect(reason).toBe("native_payload_invalid");
            expect(message).toContain("not valid UTF-8");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("a present but unopenable retained bootstrap is invalid, not missing", () => {
        // An O_NOFOLLOW rejection means the retained path exists but is untrustworthy; report native_payload_invalid, not native_payload_missing.
        // An O_NOFOLLOW rejection means the retained path exists but is untrustworthy; report native_payload_invalid, not native_payload_missing.
        // An O_NOFOLLOW rejection means the retained path exists but is untrustworthy; report native_payload_invalid, not native_payload_missing.
        // An O_NOFOLLOW rejection means the retained path exists but is untrustworthy; report native_payload_invalid, not native_payload_missing.
        const dir = tempDir("mc-retained-present-invalid-");
        try {
            const bytes = Buffer.from("retained-launcher\n");
            const digest = sha256(bytes);
            const store = path.join(dir, "store");
            mkdirSync(store, { recursive: true });
            const real = path.join(dir, "elsewhere");
            writeFileSync(real, bytes, { mode: 0o500 });
            // The digest-addressed name is a symlink: present, untrustworthy.
            symlinkSync(real, path.join(store, digest));
            let reason: string | null = null;
            try {
                revalidateRetainedBootstrap(path.join(store, digest), digest);
            } catch (error) {
                reason = (error as BootstrapError).reason;
            }
            expect(reason).toBe("native_payload_invalid");

            let absentReason: string | null = null;
            try {
                revalidateRetainedBootstrap(path.join(store, "f".repeat(64)), "f".repeat(64));
            } catch (error) {
                absentReason = (error as BootstrapError).reason;
            }
            expect(absentReason).toBe("native_payload_missing");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("an owner-writable retained bootstrap is rejected before its digest is trusted", () => {
        // Reject writable retained objects because their bytes can change after hashing.
        // Reject writable retained objects because their bytes can change after hashing.
        // The retained inode can change between hashing and use because nothing snapshots it.
        // An in-place overwrite preserves dev/ino, so the identity re-check cannot detect mutations between hashing and exec.
        // An in-place overwrite preserves dev/ino, so the identity re-check cannot detect mutations between hashing and exec.
        const dir = tempDir("mc-retained-writable-");
        try {
            const bytes = Buffer.from("retained-launcher\n");
            const source = path.join(dir, "launcher");
            writeFileSync(source, bytes, { mode: 0o755 });
            const staged = stageBootstrap({
                sourcePath: source,
                destDir: path.join(dir, "store"),
                expectedSha256: sha256(bytes),
                availableBytesOverride: 1n << 40n,
            });
            closeSync(staged.fd);
            expect(lstatSync(staged.path).mode & 0o777).toBe(0o500);
            closeSync(revalidateRetainedBootstrap(staged.path, staged.sha256).fd);

            // revalidateRetainedBootstrap rejects owner-writable retained objects even when their digest matches.
            // An owner-writable retained object's digest does not guarantee the bytes executed.
            execFileSync("chmod", ["0700", staged.path]);
            let reason: string | null = null;
            let message = "";
            try {
                revalidateRetainedBootstrap(staged.path, staged.sha256);
            } catch (error) {
                reason = (error as BootstrapError).reason;
                message = (error as Error).message;
            }
            expect(reason).toBe("native_payload_invalid");
            expect(message).toContain("owner-writable");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("retained revalidation rejects post-copy mutation, extra links, and open modes", () => {
        const dir = tempDir("mc-retained-");
        try {
            const bytes = Buffer.from("retained-launcher\n");
            const source = path.join(dir, "launcher");
            writeFileSync(source, bytes, { mode: 0o755 });
            const staged = stageBootstrap({
                sourcePath: source,
                destDir: path.join(dir, "store"),
                expectedSha256: sha256(bytes),
                availableBytesOverride: 1n << 40n,
            });
            closeSync(staged.fd);

            const revalidated = revalidateRetainedBootstrap(staged.path, staged.sha256);
            closeSync(revalidated.fd);

            linkSync(staged.path, path.join(dir, "extra-link"));
            expect(() => revalidateRetainedBootstrap(staged.path, staged.sha256)).toThrow(
                BootstrapError,
            );
            rmSync(path.join(dir, "extra-link"));

            execFileSync("chmod", ["0755", staged.path]);
            expect(() => revalidateRetainedBootstrap(staged.path, staged.sha256)).toThrow(
                BootstrapError,
            );
            execFileSync("chmod", ["0700", staged.path]);
            writeFileSync(staged.path, "mutated");
            expect(() => revalidateRetainedBootstrap(staged.path, staged.sha256)).toThrow(
                BootstrapError,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("an absent retained bootstrap is native_payload_missing, never a fallback", () => {
        let reason: string | null = null;
        try {
            revalidateRetainedBootstrap("/nonexistent/bootstrap", "d".repeat(64));
        } catch (error) {
            reason = (error as BootstrapError).reason;
        }
        expect(reason).toBe("native_payload_missing");
    });

    test("a symlinked or group-writable destination is rejected before any output exists", () => {
        const dir = tempDir("mc-stage-dest-");
        try {
            const source = path.join(dir, "launcher");
            const bytes = Buffer.from("destination-hardening\n");
            writeFileSync(source, bytes, { mode: 0o755 });
            const digest = sha256(bytes);
            const stage = (destDir: string): string | null =>
                reasonOf(() =>
                    stageBootstrap({
                        sourcePath: source,
                        destDir,
                        expectedSha256: digest,
                        availableBytesOverride: 1n << 40n,
                    }),
                );

            // Destination symlinks redirect staged creation and rename into the link target.
            // Destination symlinks redirect staged creation and rename into the link target.
            const realStore = path.join(dir, "real-store");
            mkdirSync(realStore, { mode: 0o700 });
            const symlinkedStore = path.join(dir, "symlinked-store");
            symlinkSync(realStore, symlinkedStore);
            expect(stage(symlinkedStore)).toBe("native_payload_invalid");
            expect(readdirSync(realStore)).toEqual([]);

            // Existing destination directories retain their mode because mkdirSync applies mode only on creation.
            // Existing 0o777 destination directories are rejected before staged creation.
            const openStore = path.join(dir, "open-store");
            mkdirSync(openStore, { mode: 0o700 });
            chmodSync(openStore, 0o777);
            expect(stage(openStore)).toBe("native_payload_invalid");
            expect(readdirSync(openStore)).toEqual([]);

            const fileStore = path.join(dir, "file-store");
            writeFileSync(fileStore, "not a dir");
            expect(stage(fileStore)).not.toBeNull();

            const goodStore = path.join(dir, "good-store");
            const staged = stageBootstrap({
                sourcePath: source,
                destDir: goodStore,
                expectedSha256: digest,
                availableBytesOverride: 1n << 40n,
            });
            closeSync(staged.fd);
            expect(readFileSync(staged.path)).toEqual(bytes);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("a host without process.getuid is unsupported_platform before any staging effect", () => {
        const dir = tempDir("mc-stage-nouid-");
        try {
            const source = path.join(dir, "launcher");
            const bytes = Buffer.from("no-uid-launcher\n");
            writeFileSync(source, bytes, { mode: 0o755 });
            const digest = sha256(bytes);

            const destDir = path.join(dir, "store");
            const stageReason = withoutGetuid(() =>
                reasonOf(() =>
                    stageBootstrap({
                        sourcePath: source,
                        destDir,
                        expectedSha256: digest,
                        availableBytesOverride: 1n << 40n,
                    }),
                ),
            );
            expect(stageReason).toBe("unsupported_platform");
            expect(existsSync(destDir)).toBe(false);

            const staged = stageBootstrap({
                sourcePath: source,
                destDir: path.join(dir, "ok-store"),
                expectedSha256: digest,
                availableBytesOverride: 1n << 40n,
            });
            closeSync(staged.fd);
            const retainedReason = withoutGetuid(() =>
                reasonOf(() => revalidateRetainedBootstrap(staged.path, staged.sha256)),
            );
            expect(retainedReason).toBe("unsupported_platform");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
