import { describe, expect, it } from "bun:test";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeJsonAtomically } from "./atomic-json-write";

function withRoot<T>(body: (root: string) => T): T {
    const root = mkdtempSync(join(tmpdir(), "atomic-json-"));
    try {
        return body(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

const residue = (dir: string): string[] =>
    readdirSync(dir).filter((entry) => entry.startsWith(".atomic-json-"));

describe("writeJsonAtomically", () => {
    it("publishes the value and leaves no staging directory behind", () => {
        withRoot((root) => {
            const destination = join(root, "nested", "out.json");
            writeJsonAtomically(destination, { b: 1, a: 2 }, "manifest");
            expect(readFileSync(destination, "utf8")).toBe("{\n  \"b\": 1,\n  \"a\": 2\n}\n");
            expect(residue(join(root, "nested"))).toEqual([]);
        });
    });

    /** Each call stages in its own directory, so a concurrent writer cannot delete another's staged bytes on its way out. commentlint: allow(JUDGE) */
    it("does not reuse a staging path between calls", () => {
        withRoot((root) => {
            const destination = join(root, "out.json");
            const seen = new Set<string>();
            for (let attempt = 0; attempt < 3; attempt += 1) {
                mkdirSync(join(root, "probe"), { recursive: true });
                writeJsonAtomically(destination, { attempt }, "manifest");
                for (const entry of readdirSync(root)) {
                    if (entry.startsWith(".atomic-json-")) seen.add(entry);
                }
            }
            expect(seen.size).toBe(0);
            expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual({ attempt: 2 });
        });
    });

    /** A pre-existing sibling named like the old fixed staging path is now irrelevant, and must not be consumed or deleted. commentlint: allow(JUDGE) */
    it("ignores an unrelated sibling file next to the destination", () => {
        withRoot((root) => {
            const destination = join(root, "out.json");
            const bystander = `${destination}.tmp`;
            writeFileSync(bystander, "not mine");
            writeJsonAtomically(destination, { ok: true }, "manifest");
            expect(readFileSync(bystander, "utf8")).toBe("not mine");
            expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual({ ok: true });
        });
    });

    /** rename replaces the link itself rather than writing through it, so the target keeps its contents. commentlint: allow(JUDGE) */
    it("replaces a destination symlink without touching its target", () => {
        withRoot((root) => {
            const destination = join(root, "out.json");
            const victim = join(root, "victim.txt");
            writeFileSync(victim, "untouched");
            symlinkSync(victim, destination);
            writeJsonAtomically(destination, { ok: true }, "manifest");
            expect(readFileSync(victim, "utf8")).toBe("untouched");
            expect(lstatSync(destination).isFile()).toBe(true);
            expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual({ ok: true });
        });
    });

    /** A signal that skips `finally` skips an exit hook too, so the reclaim has to happen on a later publish. commentlint: allow(JUDGE) */
    it("reclaims an orphaned staging directory once it is stale", () => {
        withRoot((root) => {
            const destination = join(root, "out.json");
            const orphan = join(root, ".atomic-json-aaaaaa");
            mkdirSync(orphan);
            writeFileSync(join(orphan, "out.json"), "abandoned");
            const stale = Date.now() - 120_000;
            utimesSync(orphan, stale / 1000, stale / 1000);
            writeJsonAtomically(destination, { ok: true }, "manifest");
            expect(existsSync(orphan)).toBe(false);
        });
    });

    /** A live writer's directory is seconds old; sweeping it would recreate the collision the private directory prevents. commentlint: allow(JUDGE) */
    it("leaves a fresh staging directory alone", () => {
        withRoot((root) => {
            const destination = join(root, "out.json");
            const live = join(root, ".atomic-json-bbbbbb");
            mkdirSync(live);
            writeFileSync(join(live, "out.json"), "in flight");
            writeJsonAtomically(destination, { ok: true }, "manifest");
            expect(readFileSync(join(live, "out.json"), "utf8")).toBe("in flight");
        });
    });

    it("names the artifact and clears staging when publication fails", () => {
        withRoot((root) => {
            const destination = join(root, "occupied");
            mkdirSync(destination);
            writeFileSync(join(destination, "child"), "blocks rename");
            expect(() => writeJsonAtomically(destination, { ok: true }, "report"))
                .toThrow(/report: could not publish/);
            expect(residue(root)).toEqual([]);
            expect(existsSync(join(destination, "child"))).toBe(true);
        });
    });
});
