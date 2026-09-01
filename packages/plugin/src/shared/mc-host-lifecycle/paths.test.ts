import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getTestBackstopDataRoot } from "../data-path";
import {
    admitLifecycleFilesystem,
    CONNECTION_FILE_NAME,
    connectionFilePath,
    coordinationDirPath,
    defaultConnectionFilePath,
    managedSubtreePath,
    parseMounts,
    redactLifecyclePath,
    resolveLifecycleDataRoot,
    runtimeDirPath,
    sensitiveRootsFor,
} from "./paths";

describe("data-root resolution (U3 scenario 1, Rust parity)", () => {
    test("absolute XDG_DATA_HOME wins", () => {
        expect(
            resolveLifecycleDataRoot({ XDG_DATA_HOME: "/xdg-root", HOME: "/home-root" }),
        ).toEqual({ ok: true, root: "/xdg-root" });
    });

    test("empty or relative XDG_DATA_HOME falls back to absolute HOME", () => {
        for (const xdg of ["", "relative/xdg", "./xdg"]) {
            expect(resolveLifecycleDataRoot({ XDG_DATA_HOME: xdg, HOME: "/home-root" })).toEqual({
                ok: true,
                root: path.join("/home-root", ".local", "share"),
            });
        }
    });

    test("unset XDG_DATA_HOME uses absolute HOME/.local/share", () => {
        expect(resolveLifecycleDataRoot({ HOME: "/home-root" })).toEqual({
            ok: true,
            root: "/home-root/.local/share",
        });
    });

    test("relative HOME is ignored: neither root resolves means no_data_dir", () => {
        expect(resolveLifecycleDataRoot({ HOME: "relative-home" })).toEqual({
            ok: false,
            reason: "no_data_dir",
        });
        expect(resolveLifecycleDataRoot({})).toEqual({ ok: false, reason: "no_data_dir" });
        expect(resolveLifecycleDataRoot({ XDG_DATA_HOME: "relative", HOME: "" })).toEqual({
            ok: false,
            reason: "no_data_dir",
        });
    });

    test("NODE_ENV=test backstops the root instead of reaching the real HOME", () => {
        // Without `MAGIC_CONTEXT_TEST_DATA_DIR`, resolution must not fall through to the real `HOME`.
        // Lifecycle policies could probe, start, stop, or stage in the user's live `~/.local/share` tree.
        const backstopped = resolveLifecycleDataRoot({ NODE_ENV: "test", HOME: "/home-root" });
        expect(backstopped.ok).toBe(true);
        if (backstopped.ok) {
            expect(backstopped.root).not.toBe(path.join("/home-root", ".local", "share"));
            expect(backstopped.root).toContain("mc-test-db-backstop-");
            // Memoization keeps each process on one root so a test's daemon state and database share a tree.
            expect(resolveLifecycleDataRoot({ NODE_ENV: "test" })).toEqual(backstopped);
            // `getTestBackstopDataRoot()` returns the storage resolver's backstop root.
            // The lifecycle and storage resolvers use the same backstop root when neither resolver is isolated.
            // `getMagicContextStorageDir()` cannot verify the shared backstop because it honors ambient isolation.
            expect(backstopped.root).toBe(getTestBackstopDataRoot());
        }
        expect(resolveLifecycleDataRoot({ NODE_ENV: "test", XDG_DATA_HOME: "/xdg-root" })).toEqual({
            ok: true,
            root: "/xdg-root",
        });
        expect(
            resolveLifecycleDataRoot({ NODE_ENV: "test", MAGIC_CONTEXT_TEST_DATA_DIR: "/iso" }),
        ).toEqual({ ok: true, root: "/iso" });
        expect(resolveLifecycleDataRoot({ HOME: "/home-root" })).toEqual({
            ok: true,
            root: path.join("/home-root", ".local", "share"),
        });
    });

    test("test-isolation data dir wins over HOME but not over absolute XDG", () => {
        expect(
            resolveLifecycleDataRoot({
                MAGIC_CONTEXT_TEST_DATA_DIR: "/isolated",
                HOME: "/home-root",
            }),
        ).toEqual({ ok: true, root: "/isolated" });
        expect(
            resolveLifecycleDataRoot({
                XDG_DATA_HOME: "/xdg-root",
                MAGIC_CONTEXT_TEST_DATA_DIR: "/isolated",
            }),
        ).toEqual({ ok: true, root: "/xdg-root" });
    });
});

describe("canonical lifecycle paths", () => {
    test("coordination, managed, runtime, and publication paths mirror Rust", () => {
        expect(coordinationDirPath("/root")).toBe("/root/.mc-host-coordination");
        expect(managedSubtreePath("/root")).toBe("/root/cortexkit");
        expect(runtimeDirPath("/root")).toBe("/root/cortexkit/run");
        expect(CONNECTION_FILE_NAME).toBe("subc-connection.json");
        expect(connectionFilePath("/root")).toBe("/root/cortexkit/run/subc-connection.json");
    });
});

describe("filesystem admission (KTD11)", () => {
    // These fixtures use nonexistent host paths, so `realpath` defaults to identity.
    // Identity canonicalization leaves mount selection to the fabricated mount table.
    const mounts = (text: string, realpath: (value: string) => string = (value) => value) => ({
        platform: "linux" as const,
        readMounts: () => text,
        realpath,
    });

    /**
     * The canonicalizer returns `ENOENT` for paths below `existing`, modeling a root that does not yet exist.
     */
    const resolvesOnly =
        (existing: string, canonical: string) =>
        (value: string): string => {
            if (value === existing) return canonical;
            const error = new Error(`ENOENT: ${value}`) as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
        };

    test("a local mount without noexec is admitted", () => {
        const verdict = admitLifecycleFilesystem(
            "/home/user/.local/share",
            mounts("/dev/root / ext4 rw,relatime 0 0\n/dev/sdb1 /home ext4 rw,relatime 0 0\n"),
        );
        expect(verdict).toEqual({ ok: true });
    });

    test("an unqualified platform is unsupported_platform, not a filesystem verdict", () => {
        // On non-Linux platforms, the resolver cannot classify a filesystem because it reads Linux mount tables.
        // Returning `unsupported_filesystem` or `set_data_directory` on non-Linux platforms would recommend an impossible directory change.
        for (const platform of ["win32", "freebsd", "aix"]) {
            const verdict = admitLifecycleFilesystem("/data", {
                platform,
                readMounts: () => {
                    throw new Error("the mount table must not be consulted");
                },
            });
            expect(verdict.ok).toBe(false);
            if (!verdict.ok) {
                expect(verdict.reason).toBe("unsupported_platform");
                expect(verdict.remediation).toBe("use_supported_platform");
            }
        }
    });

    test("a relative root is still a filesystem verdict on an unqualified platform", () => {
        // The resolver validates absoluteness before platform checks because absoluteness depends only on the input string.
        const verdict = admitLifecycleFilesystem("relative/data", {
            platform: "win32",
            readMounts: () => "",
        });
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.reason).toBe("unsupported_filesystem");
    });

    test("distributed and passthrough filesystems are rejected, not treated as local", () => {
        // The locality check fails open for filesystem types absent from the deny-list.
        for (const fsType of [
            "ceph",
            "cephfs",
            "fuse.ceph",
            "glusterfs",
            "fuse.glusterfs",
            "lustre",
            "beegfs",
            "gpfs",
            "orangefs",
            "gfs2",
            "ocfs2",
            "fuse.s3fs",
            "fuse.rclone",
            "fuse.gcsfuse",
            "vboxsf",
            "virtiofs",
            "smb3",
        ]) {
            const verdict = admitLifecycleFilesystem(
                "/home/user/.local/share",
                mounts(`/dev/root / ext4 rw 0 0\nremote:/x /home ${fsType} rw 0 0\n`),
            );
            expect(verdict.ok).toBe(false);
            if (!verdict.ok) expect(verdict.reason).toBe("unsupported_filesystem");
        }
        for (const fsType of ["ext4", "xfs", "btrfs", "zfs", "f2fs"]) {
            expect(
                admitLifecycleFilesystem(
                    "/home/user/.local/share",
                    mounts(`/dev/root / ext4 rw 0 0\n/dev/sdb1 /home ${fsType} rw 0 0\n`),
                ),
            ).toEqual({ ok: true });
        }
    });

    test("remote filesystem types are unsupported_filesystem / set_data_directory", () => {
        for (const fsType of ["nfs4", "cifs", "fuse.sshfs", "fuse.rclone", "9p"]) {
            const verdict = admitLifecycleFilesystem(
                "/home/user/.local/share",
                mounts(`/dev/root / ext4 rw 0 0\nremote:/x /home ${fsType} rw 0 0\n`),
            );
            expect(verdict.ok).toBe(false);
            if (!verdict.ok) {
                expect(verdict.reason).toBe("unsupported_filesystem");
                expect(verdict.remediation).toBe("set_data_directory");
            }
        }
    });

    test("a noexec data-root mount fails retained-object execution admission", () => {
        const verdict = admitLifecycleFilesystem(
            "/home/user/.local/share",
            mounts("/dev/root / ext4 rw 0 0\n/dev/sdb1 /home ext4 rw,nosuid,noexec 0 0\n"),
        );
        expect(verdict.ok).toBe(false);
    });

    test("a noexec mount elsewhere does not affect the selected root", () => {
        const verdict = admitLifecycleFilesystem(
            "/home/user/.local/share",
            mounts("/dev/root / ext4 rw 0 0\nproc /proc proc rw,noexec 0 0\n"),
        );
        expect(verdict).toEqual({ ok: true });
    });

    test("longest-prefix mount selection picks the nearest mount", () => {
        const verdict = admitLifecycleFilesystem(
            "/home/user/.local/share",
            mounts(
                "/dev/root / ext4 rw 0 0\nremote:/x /home nfs4 rw 0 0\n/dev/sdc1 /home/user ext4 rw 0 0\n",
            ),
        );
        expect(verdict).toEqual({ ok: true });
    });

    test("a relative root and an unreadable mount table fail closed", () => {
        expect(admitLifecycleFilesystem("relative", mounts("")).ok).toBe(false);
        expect(
            admitLifecycleFilesystem("/root", {
                platform: "linux",
                readMounts: () => {
                    throw new Error("denied");
                },
            }).ok,
        ).toBe(false);
    });

    test("darwin admits only a local executable APFS mount", () => {
        expect(
            admitLifecycleFilesystem("/Users/dev/.local/share", {
                platform: "darwin",
                readMounts: () =>
                    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n" +
                    "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled)\n",
            }),
        ).toEqual({ ok: true });
        for (const mount of [
            "server:/home on /Users (nfs, nodev, nosuid)\n",
            "rclone on /Users (osxfuse, local, nodev)\n",
            "/dev/disk3s5 on /Users (apfs, local, noexec)\n",
        ]) {
            expect(
                admitLifecycleFilesystem("/Users/dev/.local/share", {
                    platform: "darwin",
                    readMounts: () => mount,
                }).ok,
            ).toBe(false);
        }
    });

    test('darwin mount lines keep mount points containing " on " and need no option list', () => {
        // The nearest mount determines the verdict.
        // Entries without flags after their filesystem type must reach the classifier.
        expect(
            admitLifecycleFilesystem("/Volumes/Disk on Server/share", {
                platform: "darwin",
                readMounts: () =>
                    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n" +
                    "server:/export on /Volumes/Disk on Server (nfs, nodev)\n",
            }).ok,
        ).toBe(false);
        expect(
            admitLifecycleFilesystem("/Volumes/Backup/share", {
                platform: "darwin",
                readMounts: () =>
                    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n" +
                    "server:/export on /Volumes/Backup (nfs)\n",
            }).ok,
        ).toBe(false);
    });

    test("mount points with octal escapes decode before matching", () => {
        const entries = parseMounts("/dev/sdd1 /mnt/with\\040space ext4 rw 0 0\n");
        expect(entries[0]?.mountPoint).toBe("/mnt/with space");
    });

    test("a `..` segment is judged on the mount of the effective path", () => {
        // Literal matching would admit the ext4 mount the traversal never reaches.
        const table =
            "/dev/root / ext4 rw 0 0\n/dev/sdb1 /local ext4 rw 0 0\nremote:/x /remote-data nfs4 rw 0 0\n";
        const verdict = admitLifecycleFilesystem("/local/../remote-data/cortexkit", mounts(table));
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.detail).toBe("unsupported filesystem type nfs4");
    });

    test("a symlinked ancestor is canonicalized before mount lookup", () => {
        const table =
            "/dev/root / ext4 rw 0 0\n/dev/sdb1 /local ext4 rw 0 0\nremote:/x /remote-data nfs4 rw 0 0\n";
        const verdict = admitLifecycleFilesystem(
            "/local/link/share",
            mounts(table, (value) =>
                value === "/local/link" || value.startsWith("/local/link/")
                    ? `/remote-data${value.slice("/local/link".length)}`
                    : value,
            ),
        );
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.detail).toBe("unsupported filesystem type nfs4");
    });

    test("a missing multi-level tail rejoins deepest-last onto its resolved ancestor", () => {
        // `/remote-data/cortexkit` is remote while `/remote-data/deep` is local,
        // so a tail rejoined in the wrong order would be admitted.
        const table =
            "/dev/root / ext4 rw 0 0\nremote:/x /remote-data/cortexkit nfs4 rw 0 0\n/dev/sdc1 /remote-data/deep ext4 rw 0 0\n";
        const verdict = admitLifecycleFilesystem(
            "/local/store/cortexkit/run/deep",
            mounts(table, resolvesOnly("/local/store", "/remote-data")),
        );
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.detail).toBe("unsupported filesystem type nfs4");
    });

    test("the default canonicalizer resolves a symlinked ancestor of an absent root", () => {
        const base = mkdtempSync(path.join(os.tmpdir(), "mc-host-paths-"));
        try {
            const store = path.join(base, "store");
            mkdirSync(store);
            const link = path.join(base, "via-link");
            symlinkSync(store, link);
            // Only the canonical directory carries the remote mount.
            // symlinked spelling matches nothing but `/`.
            const table = `/dev/root / ext4 rw 0 0\nremote:/x ${realpathSync.native(store)} nfs4 rw 0 0\n`;
            const verdict = admitLifecycleFilesystem(path.join(link, "cortexkit", "run"), {
                platform: "linux",
                readMounts: () => table,
            });
            expect(verdict.ok).toBe(false);
            if (!verdict.ok) expect(verdict.detail).toBe("unsupported filesystem type nfs4");
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    test("a resolution failure other than a missing leaf fails closed", () => {
        const verdict = admitLifecycleFilesystem(
            "/denied/share",
            mounts("/dev/root / ext4 rw 0 0\n", () => {
                const error = new Error("EACCES") as NodeJS.ErrnoException;
                error.code = "EACCES";
                throw error;
            }),
        );
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.detail).toBe("data root cannot be resolved");
    });

    test("the latest mount at a shared point governs, shadowing earlier entries", () => {
        // The table lists stacked mounts in ascending mount order, so the last equal-length entry is on top.
        const shadowedByNoexec = admitLifecycleFilesystem(
            "/data/cortexkit",
            mounts(
                "/dev/root / ext4 rw 0 0\n/dev/sdb1 /data ext4 rw,relatime 0 0\n/dev/sdb1 /data ext4 rw,noexec 0 0\n",
            ),
        );
        expect(shadowedByNoexec.ok).toBe(false);
        if (!shadowedByNoexec.ok) {
            expect(shadowedByNoexec.detail).toBe("data root mount is noexec");
        }
        const shadowedByLocal = admitLifecycleFilesystem(
            "/data/cortexkit",
            mounts(
                "/dev/root / ext4 rw 0 0\nremote:/x /data nfs4 rw 0 0\n/dev/sdb1 /data ext4 rw 0 0\n",
            ),
        );
        expect(shadowedByLocal).toEqual({ ok: true });
    });
});

describe("path redaction roots (R35)", () => {
    test("sensitive roots cover the data root and HOME from the same resolver", () => {
        const roots = sensitiveRootsFor("/xdg-root", { HOME: "/home-root" });
        expect(roots).toEqual(["/xdg-root", "/home-root"]);
        expect(redactLifecyclePath("/xdg-root/cortexkit/run", roots)).toBe(
            "<data-root>/cortexkit/run",
        );
        expect(redactLifecyclePath("/elsewhere/file", roots)).toBe("/elsewhere/file");
    });

    test("the root itself redacts to the bare placeholder", () => {
        expect(redactLifecyclePath("/xdg-root", ["/xdg-root"])).toBe("<data-root>");
    });

    test("a sibling sharing the root's leading characters keeps its own name", () => {
        expect(redactLifecyclePath("/xdg-root-backup/secret", ["/xdg-root"])).toBe(
            "/xdg-root-backup/secret",
        );
        const roots = sensitiveRootsFor("/home/u/.local/share", { HOME: "/home/u" });
        expect(redactLifecyclePath("/home/u/.local/share-backup/secret", roots)).toBe(
            "<data-root>/.local/share-backup/secret",
        );
    });

    test("an already-redacted value is not measured against a later root", () => {
        // The placeholder is not a path.
        // Resolving the placeholder against cwd when the lifecycle root contains cwd would substitute a second placeholder.
        expect(redactLifecyclePath("/xdg-root/cortexkit", ["/xdg-root", path.resolve(".")])).toBe(
            "<data-root>/cortexkit",
        );
    });
});

describe("managed connection-file derivation", () => {
    test("the lifecycle root, not the fallback, names the published file", () => {
        // The daemon receives `XDG_DATA_HOME` set to the lifecycle root.
        // Readers must resolve the lifecycle root from `XDG_DATA_HOME`.
        expect(defaultConnectionFilePath("/legacy-root", { XDG_DATA_HOME: "/xdg-root" })).toBe(
            path.join("/xdg-root", "cortexkit", "run", CONNECTION_FILE_NAME),
        );
    });

    test("a relative XDG_DATA_HOME falls back to HOME, matching the daemon", () => {
        // The daemon ignores relative values, so the mount reader must also ignore relative values.
        expect(
            defaultConnectionFilePath("/legacy-root", {
                XDG_DATA_HOME: "./relative",
                HOME: "/home-root",
            }),
        ).toBe(
            path.join("/home-root", ".local", "share", "cortexkit", "run", CONNECTION_FILE_NAME),
        );
    });

    test("the fallback root applies only when no lifecycle root resolves", () => {
        expect(defaultConnectionFilePath("/legacy-root", { HOME: "relative-home" })).toBe(
            path.join("/legacy-root", "cortexkit", "run", CONNECTION_FILE_NAME),
        );
    });
});
