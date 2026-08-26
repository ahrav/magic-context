import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
    admitLifecycleFilesystem,
    CONNECTION_FILE_NAME,
    connectionFilePath,
    coordinationDirPath,
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
    const mounts = (text: string) => ({ platform: "linux" as const, readMounts: () => text });

    test("a local mount without noexec is admitted", () => {
        const verdict = admitLifecycleFilesystem(
            "/home/user/.local/share",
            mounts("/dev/root / ext4 rw,relatime 0 0\n/dev/sdb1 /home ext4 rw,relatime 0 0\n"),
        );
        expect(verdict).toEqual({ ok: true });
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

    test("mount points with octal escapes decode before matching", () => {
        const entries = parseMounts("/dev/sdd1 /mnt/with\\040space ext4 rw 0 0\n");
        expect(entries[0]?.mountPoint).toBe("/mnt/with space");
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
});
