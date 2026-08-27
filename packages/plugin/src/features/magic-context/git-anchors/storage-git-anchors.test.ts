import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "../../../shared/sqlite";
import { ensureProject } from "../memory/storage-claims";
import { createDirectTestDatabase } from "../test-database";
import { captureGitAnchor, type GitAnchorCapture } from "./git-anchor-reader";
import {
    anchorRepresentationsFromCapture,
    appendGitAnchorRepresentationsInCurrentTransaction,
    createGitAnchorInCurrentTransaction,
    GIT_OID_PROTOCOL,
    type GitAnchorRepresentationInput,
    resolveGitAnchor,
} from "./storage-git-anchors";

const tempDirs: string[] = [];

afterAll(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function openTestDb(): Database {
    const db = createDirectTestDatabase().db;
    db.exec("PRAGMA foreign_keys=ON");
    return db;
}

function makeCapture(overrides: Partial<GitAnchorCapture> = {}): GitAnchorCapture {
    return {
        commitOid: "a".repeat(40),
        objectFormat: "sha1",
        treeOid: "b".repeat(40),
        stablePatchId: "c".repeat(40),
        patchIdProtocol: "git-patch-id-stable-v1",
        changedPaths: ["src/a.ts"],
        isMerge: false,
        ...overrides,
    };
}

function createAnchor(
    db: Database,
    projectId: number,
    representations: GitAnchorRepresentationInput[],
): number {
    return db
        .transaction(() => createGitAnchorInCurrentTransaction(db, { projectId, representations }))
        .immediate();
}

describe("storage-git-anchors", () => {
    let db: Database;
    let projectId: number;

    beforeEach(() => {
        db = openTestDb();
        projectId = ensureProject(db, "git:anchor-test");
    });

    it("resolves a unique commit OID without consulting colliding tree/patch evidence", () => {
        const captureA = makeCapture();
        const captureB = makeCapture({ commitOid: "d".repeat(40) });
        const anchorA = createAnchor(db, projectId, anchorRepresentationsFromCapture(captureA));
        const anchorB = createAnchor(db, projectId, anchorRepresentationsFromCapture(captureB));

        const resolvedA = resolveGitAnchor(db, { projectId, capture: captureA });
        expect(resolvedA).toEqual({ status: "resolved", anchorId: anchorA });
        const resolvedB = resolveGitAnchor(db, { projectId, capture: captureB });
        expect(resolvedB).toEqual({ status: "resolved", anchorId: anchorB });
    });

    it("rejects duplicate full commit OIDs per project but allows another project", () => {
        const capture = makeCapture();
        createAnchor(db, projectId, anchorRepresentationsFromCapture(capture));
        expect(() =>
            createAnchor(db, projectId, anchorRepresentationsFromCapture(capture)),
        ).toThrow();

        const otherProjectId = ensureProject(db, "git:anchor-other");
        expect(otherProjectId).not.toBe(projectId);
        const otherAnchor = createAnchor(
            db,
            otherProjectId,
            anchorRepresentationsFromCapture(capture),
        );
        expect(otherAnchor).toBeGreaterThan(0);
    });

    it("returns ambiguous when only shared tree or patch evidence is given", () => {
        const captureA = makeCapture();
        const captureB = makeCapture({ commitOid: "d".repeat(40) });
        const anchorA = createAnchor(db, projectId, anchorRepresentationsFromCapture(captureA));
        const anchorB = createAnchor(db, projectId, anchorRepresentationsFromCapture(captureB));

        const byTree = resolveGitAnchor(db, {
            projectId,
            representations: [
                {
                    kind: "tree_oid",
                    objectFormat: "sha1",
                    protocol: GIT_OID_PROTOCOL,
                    value: captureA.treeOid,
                },
            ],
        });
        expect(byTree).toEqual({
            status: "ambiguous",
            kind: "tree_oid",
            candidates: [anchorA, anchorB],
        });

        const byPatch = resolveGitAnchor(db, {
            projectId,
            representations: [
                {
                    kind: "patch_id",
                    protocol: "git-patch-id-stable-v1",
                    value: captureA.stablePatchId as string,
                },
            ],
        });
        expect(byPatch).toEqual({
            status: "ambiguous",
            kind: "patch_id",
            candidates: [anchorA, anchorB],
        });
    });

    it("returns unresolved when no level matches", () => {
        createAnchor(db, projectId, anchorRepresentationsFromCapture(makeCapture()));
        const result = resolveGitAnchor(db, {
            projectId,
            capture: makeCapture({
                commitOid: "1".repeat(40),
                treeOid: "2".repeat(40),
                stablePatchId: "3".repeat(40),
            }),
        });
        expect(result).toEqual({ status: "unresolved" });
    });

    it("retains object format for sha1 and sha256 OIDs and rejects abbreviations", () => {
        const sha256Capture = makeCapture({
            commitOid: "e".repeat(64),
            objectFormat: "sha256",
            treeOid: "f".repeat(64),
        });
        const anchorId = createAnchor(
            db,
            projectId,
            anchorRepresentationsFromCapture(sha256Capture),
        );
        const rows = db
            .prepare(
                `SELECT kind, object_format FROM git_anchor_representations
                 WHERE anchor_id = ? AND kind IN ('commit_oid', 'tree_oid')`,
            )
            .all(anchorId) as Array<{ kind: string; object_format: string }>;
        expect(rows).toHaveLength(2);
        for (const row of rows) expect(row.object_format).toBe("sha256");

        expect(() =>
            anchorRepresentationsFromCapture(makeCapture({ commitOid: "a".repeat(12) })),
        ).toThrow(/abbreviations are rejected/);
        expect(() =>
            anchorRepresentationsFromCapture(
                makeCapture({ commitOid: "e".repeat(40), objectFormat: "sha256" }),
            ),
        ).toThrow(/abbreviations are rejected/);
    });

    it("both tables are append-only and re-appends are idempotent no-ops", () => {
        const capture = makeCapture();
        const representations = anchorRepresentationsFromCapture(capture);
        const anchorId = createAnchor(db, projectId, representations);

        expect(() =>
            db.prepare("UPDATE git_anchors SET created_at = 1 WHERE id = ?").run(anchorId),
        ).toThrow(/append-only/);
        expect(() => db.prepare("DELETE FROM git_anchors WHERE id = ?").run(anchorId)).toThrow(
            /append-only/,
        );
        expect(() =>
            db
                .prepare("UPDATE git_anchor_representations SET value = 'x' WHERE anchor_id = ?")
                .run(anchorId),
        ).toThrow(/append-only/);
        expect(() =>
            db.prepare("DELETE FROM git_anchor_representations WHERE anchor_id = ?").run(anchorId),
        ).toThrow(/append-only/);

        const countBefore = db
            .prepare("SELECT COUNT(*) AS n FROM git_anchor_representations WHERE anchor_id = ?")
            .get(anchorId) as { n: number };
        db.transaction(() =>
            appendGitAnchorRepresentationsInCurrentTransaction(db, anchorId, representations),
        ).immediate();
        const countAfter = db
            .prepare("SELECT COUNT(*) AS n FROM git_anchor_representations WHERE anchor_id = ?")
            .get(anchorId) as { n: number };
        expect(countAfter.n).toBe(countBefore.n);
    });

    it("rejects a representation whose project differs from the anchor project", () => {
        const anchorId = createAnchor(db, projectId, []);
        const otherProjectId = ensureProject(db, "git:anchor-mismatch");
        expect(() =>
            db
                .prepare(
                    `INSERT INTO git_anchor_representations
                        (anchor_id, project_id, kind, object_format, protocol, namespace, value, created_at)
                     VALUES (?, ?, 'path', '', ?, '', 'src/x.ts', 1)`,
                )
                .run(anchorId, otherProjectId, GIT_OID_PROTOCOL),
        ).toThrow(/project must match the anchor project/);
    });

    it("integration: cherry-pick resolves the same anchor; duplicate patch id turns ambiguous", async () => {
        const repo = mkdtempSync(join(tmpdir(), "mc-git-anchor-db-"));
        tempDirs.push(repo);
        const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
        git(["init", "--initial-branch=main"]);
        git(["config", "user.name", "test"]);
        git(["config", "user.email", "test@example.com"]);
        git(["config", "commit.gpgsign", "false"]);
        const commit = (name: string, content: string, message: string): string => {
            writeFileSync(join(repo, name), content);
            git(["add", "--", name]);
            git(["commit", "-m", message]);
            return git(["rev-parse", "HEAD"]).trim();
        };
        commit("base.txt", "base\n", "base");
        git(["checkout", "-b", "feature"]);
        const featureSha = commit("feature.txt", "feature\n", "add feature");
        git(["checkout", "main"]);
        commit("other.txt", "other\n", "diverge");
        git(["cherry-pick", featureSha]);
        const pickedSha = git(["rev-parse", "HEAD"]).trim();

        const originalResult = await captureGitAnchor(repo, featureSha);
        const pickedResult = await captureGitAnchor(repo, pickedSha);
        if (originalResult.status !== "captured" || pickedResult.status !== "captured") {
            throw new Error("expected both captures to succeed");
        }
        const original = originalResult.capture;
        const picked = pickedResult.capture;
        expect(picked.stablePatchId).toBe(original.stablePatchId);

        const anchorId = createAnchor(db, projectId, anchorRepresentationsFromCapture(original));
        expect(resolveGitAnchor(db, { projectId, capture: original })).toEqual({
            status: "resolved",
            anchorId,
        });
        expect(resolveGitAnchor(db, { projectId, capture: picked })).toEqual({
            status: "resolved",
            anchorId,
        });

        const secondAnchorId = createAnchor(
            db,
            projectId,
            anchorRepresentationsFromCapture(picked),
        );
        const byPatchOnly = resolveGitAnchor(db, {
            projectId,
            representations: [
                {
                    kind: "patch_id",
                    protocol: original.patchIdProtocol,
                    value: original.stablePatchId as string,
                },
            ],
        });
        expect(byPatchOnly).toEqual({
            status: "ambiguous",
            kind: "patch_id",
            candidates: [anchorId, secondAnchorId],
        });
    });
});
