import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureGitAnchor, type GitAnchorCapture } from "./git-anchor-reader";

const tempDirs: string[] = [];

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-git-anchor-"));
    tempDirs.push(dir);
    return dir;
}

afterAll(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function git(repo: string, args: string[]): string {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function initRepo(): string {
    const repo = makeTempDir();
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.name", "test"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    return repo;
}

function commitFile(repo: string, name: string, content: string, message: string): string {
    writeFileSync(join(repo, name), content);
    git(repo, ["add", "--", name]);
    git(repo, ["commit", "-m", message]);
    return git(repo, ["rev-parse", "HEAD"]).trim();
}

async function capture(repo: string, commitish?: string): Promise<GitAnchorCapture> {
    const result = await captureGitAnchor(repo, commitish);
    if (result.status !== "captured") {
        throw new Error(`expected capture, got unavailable: ${result.reason}`);
    }
    return result.capture;
}

describe("captureGitAnchor", () => {
    it("captures exact OID, tree, patch, and paths for a root commit", async () => {
        const repo = initRepo();
        const sha = commitFile(repo, "root.txt", "root\n", "root commit");

        const captured = await capture(repo);
        expect(captured.commitOid).toBe(sha);
        expect(captured.commitOid).toMatch(/^[0-9a-f]{40}$/);
        expect(captured.objectFormat).toBe("sha1");
        expect(captured.treeOid).toMatch(/^[0-9a-f]{40}$/);
        expect(captured.stablePatchId).not.toBeNull();
        expect(captured.patchIdProtocol).toBe("git-patch-id-stable-v1");
        expect(captured.changedPaths).toEqual(["root.txt"]);
        expect(captured.isMerge).toBe(false);
    });

    it("cherry-pick onto a different parent keeps the stable patch ID and paths", async () => {
        const repo = initRepo();
        commitFile(repo, "base.txt", "base\n", "base");
        git(repo, ["checkout", "-b", "feature"]);
        const featureSha = commitFile(repo, "feature.txt", "feature\n", "add feature");
        git(repo, ["checkout", "main"]);
        commitFile(repo, "other.txt", "other\n", "diverge");
        git(repo, ["cherry-pick", featureSha]);
        const pickedSha = git(repo, ["rev-parse", "HEAD"]).trim();

        const original = await capture(repo, featureSha);
        const picked = await capture(repo, pickedSha);
        expect(picked.commitOid).not.toBe(original.commitOid);
        expect(picked.treeOid).not.toBe(original.treeOid);
        expect(picked.stablePatchId).toBe(original.stablePatchId);
        expect(picked.stablePatchId).not.toBeNull();
        expect(picked.changedPaths).toEqual(original.changedPaths);
        expect(picked.changedPaths).toEqual(["feature.txt"]);
    });

    it("merge commit yields OID/tree/paths but no patch ID", async () => {
        const repo = initRepo();
        commitFile(repo, "base.txt", "base\n", "base");
        git(repo, ["checkout", "-b", "topic"]);
        commitFile(repo, "topic.txt", "topic\n", "topic change");
        git(repo, ["checkout", "main"]);
        commitFile(repo, "main.txt", "main\n", "main change");
        git(repo, ["merge", "--no-ff", "--no-edit", "topic"]);

        const captured = await capture(repo);
        expect(captured.isMerge).toBe(true);
        expect(captured.stablePatchId).toBeNull();
        expect(captured.commitOid).toMatch(/^[0-9a-f]{40}$/);
        expect(captured.treeOid).toMatch(/^[0-9a-f]{40}$/);
        expect(captured.changedPaths).toEqual(["topic.txt"]);
    });

    it("round-trips paths containing spaces, tabs, and newlines", async () => {
        const repo = initRepo();
        const names = ["with space.txt", "with\ttab.txt", "with\nnewline.txt"];
        for (const name of names) {
            writeFileSync(join(repo, name), "x\n");
        }
        git(repo, ["add", "--", ...names]);
        git(repo, ["commit", "-m", "odd paths"]);

        const captured = await capture(repo);
        expect([...captured.changedPaths].sort()).toEqual([...names].sort());
    });

    it("returns unavailable for a non-repo directory", async () => {
        const dir = makeTempDir();
        const result = await captureGitAnchor(dir);
        expect(result.status).toBe("unavailable");
    });

    it("rejects option-looking commitish without spawning", async () => {
        const repo = initRepo();
        commitFile(repo, "a.txt", "a\n", "a");
        const result = await captureGitAnchor(repo, "--upload-pack=x");
        expect(result.status).toBe("unavailable");
        if (result.status === "unavailable") {
            expect(result.reason).toContain("option");
        }
    });

    it("returns unavailable for an invalid revision", async () => {
        const repo = initRepo();
        commitFile(repo, "a.txt", "a\n", "a");
        const result = await captureGitAnchor(repo, "no-such-revision");
        expect(result.status).toBe("unavailable");
    });

    it("never returns abbreviated OIDs", async () => {
        const repo = initRepo();
        commitFile(repo, "a.txt", "a\n", "a");
        const captured = await capture(repo);
        expect([40, 64]).toContain(captured.commitOid.length);
        expect([40, 64]).toContain(captured.treeOid.length);
    });
});
