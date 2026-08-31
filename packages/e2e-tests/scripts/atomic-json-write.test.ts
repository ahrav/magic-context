import { describe, expect, it } from "bun:test";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stagingPathFor, writeJsonAtomically } from "./atomic-json-write";

function withRoot<T>(body: (root: string) => T): T {
    const root = mkdtempSync(join(tmpdir(), "atomic-json-"));
    try {
        return body(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

describe("writeJsonAtomically", () => {
    it("publishes the value and leaves no staging file behind", () => {
        withRoot((root) => {
            const destination = join(root, "nested", "out.json");
            writeJsonAtomically(destination, { b: 1, a: 2 }, "manifest");
            expect(readFileSync(destination, "utf8")).toBe("{\n  \"b\": 1,\n  \"a\": 2\n}\n");
            expect(existsSync(stagingPathFor(destination))).toBe(false);
        });
    });

    it("replaces a stale staging file left by an interrupted run", () => {
        withRoot((root) => {
            const destination = join(root, "out.json");
            writeFileSync(stagingPathFor(destination), "{ partial");
            writeJsonAtomically(destination, { ok: true }, "manifest");
            expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual({ ok: true });
        });
    });

    /** The reason for lstat over existsSync: following the link would overwrite the target and then publish the link itself. commentlint: allow(JUDGE) */
    it("removes a staging symlink instead of writing through it", () => {
        withRoot((root) => {
            const destination = join(root, "out.json");
            const victim = join(root, "victim.txt");
            writeFileSync(victim, "untouched");
            symlinkSync(victim, stagingPathFor(destination));
            writeJsonAtomically(destination, { ok: true }, "manifest");
            expect(readFileSync(victim, "utf8")).toBe("untouched");
            expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual({ ok: true });
            expect(existsSync(stagingPathFor(destination))).toBe(false);
        });
    });

    it("refuses a staging path occupied by a directory and names the artifact", () => {
        withRoot((root) => {
            const destination = join(root, "out.json");
            mkdirSync(stagingPathFor(destination));
            expect(() => writeJsonAtomically(destination, { ok: true }, "manifest"))
                .toThrow(/manifest staging path is not a regular file/);
            expect(existsSync(destination)).toBe(false);
            expect(lstatSync(stagingPathFor(destination)).isDirectory()).toBe(true);
        });
    });

    it("clears the staging file when publication fails", () => {
        withRoot((root) => {
            const destination = join(root, "occupied");
            mkdirSync(destination);
            writeFileSync(join(destination, "child"), "blocks rename");
            expect(() => writeJsonAtomically(destination, { ok: true }, "report")).toThrow();
            expect(existsSync(stagingPathFor(destination))).toBe(false);
        });
    });

    it("gives distinct staging paths to destinations differing only by extension", () => {
        expect(stagingPathFor("/x/foo")).not.toBe(stagingPathFor("/x/foo.json"));
    });
});
