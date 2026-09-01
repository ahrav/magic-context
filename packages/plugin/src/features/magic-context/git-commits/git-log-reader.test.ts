import { describe, expect, it } from "bun:test";
import { classifyGitLogFailure, parseGitLogOutput, readGitCommits } from "./git-log-reader";

// FS uses US (0x1f) because Node's child_process.execFile rejects argv elements containing NUL bytes.
const FS = "\x1f";
const RS = "\x1e";

describe("parseGitLogOutput", () => {
    it("parses a single commit record", () => {
        const sha = "a".repeat(40);
        const out = `${sha}${FS}fix: wire bun runtime${FS}me@example.com${FS}1700000000${FS}${RS}`;

        const commits = parseGitLogOutput(out);
        expect(commits).toHaveLength(1);
        expect(commits[0]).toMatchObject({
            sha,
            shortSha: sha.slice(0, 7),
            message: "fix: wire bun runtime",
            author: "me@example.com",
            committedAtMs: 1700000000_000,
        });
    });

    it("joins subject and body with blank line when body present", () => {
        const sha = "b".repeat(40);
        const out = `${sha}${FS}subject${FS}me${FS}1700000001${FS}body line 1\nbody line 2${RS}`;

        const commits = parseGitLogOutput(out);
        expect(commits).toHaveLength(1);
        expect(commits[0].message).toBe("subject\n\nbody line 1\nbody line 2");
    });

    it("skips records with invalid SHA length", () => {
        const out = `short${FS}subject${FS}me${FS}1700000000${FS}${RS}`;
        expect(parseGitLogOutput(out)).toHaveLength(0);
    });

    it("skips records with non-finite or zero timestamps", () => {
        const sha = "c".repeat(40);
        const bad = `${sha}${FS}subject${FS}me${FS}NaN${FS}${RS}`;
        const zero = `${sha}${FS}subject${FS}me${FS}0${FS}${RS}`;
        expect(parseGitLogOutput(bad)).toHaveLength(0);
        expect(parseGitLogOutput(zero)).toHaveLength(0);
    });

    it("handles multiple records", () => {
        const s1 = "a".repeat(40);
        const s2 = "b".repeat(40);
        const s3 = "c".repeat(40);
        const out =
            `${s1}${FS}first${FS}a@a${FS}1700000000${FS}${RS}` +
            `${s2}${FS}second${FS}b@b${FS}1700000100${FS}body${RS}` +
            `${s3}${FS}third${FS}${FS}1700000200${FS}${RS}`;

        const commits = parseGitLogOutput(out);
        expect(commits).toHaveLength(3);
        expect(commits[0].sha).toBe(s1);
        expect(commits[1].message).toBe("second\n\nbody");
        expect(commits[2].author).toBeNull();
    });

    it("ignores empty trailing record after separator", () => {
        const sha = "d".repeat(40);
        const out = `${sha}${FS}s${FS}a${FS}1700000000${FS}${RS}\n`;
        expect(parseGitLogOutput(out)).toHaveLength(1);
    });
});

describe("readGitCommits (smoke)", () => {
    it("returns empty array for a non-git directory without throwing", async () => {
        const commits = await readGitCommits("/tmp", { maxCommits: 5 });
        expect(Array.isArray(commits)).toBe(true);
    });
});

describe("classifyGitLogFailure", () => {
    it("classifies structural failures that cannot succeed on retry", () => {
        expect(
            classifyGitLogFailure(
                "Command failed: git log HEAD\nfatal: not a git repository (or any of the parent directories): .git",
            ),
        ).toBe("not_a_repo");
        expect(
            classifyGitLogFailure(
                "Command failed: git log HEAD\nfatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
            ),
        ).toBe("no_head");
        expect(
            classifyGitLogFailure(
                "fatal: your current branch 'main' does not have any commits yet",
            ),
        ).toBe("no_head");
    });

    it("keeps everything else transient so normal retries continue", () => {
        expect(classifyGitLogFailure("spawn git ENOENT")).toBe("transient");
        expect(classifyGitLogFailure("Command failed: git log HEAD (timeout)")).toBe("transient");
    });
});
