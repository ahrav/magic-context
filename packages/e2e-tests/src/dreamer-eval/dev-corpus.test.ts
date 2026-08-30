import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDirectTestDatabase } from "../../../plugin/src/features/magic-context/test-database";
import { closeQuietly } from "../../../plugin/src/shared/sqlite-helpers";
import { parseScenario, type DreamerEvalScenario } from "./contract";
import { seedDreamerEvalTask } from "./seeder";

const CORPUS_DIR = join(import.meta.dir, "../../dreamer-eval/dev");

function corpusFiles(): string[] {
    return readdirSync(CORPUS_DIR)
        .filter((file) => file.endsWith(".json"))
        .sort();
}

function parseCorpus(): DreamerEvalScenario[] {
    return corpusFiles().map((file) => parseScenario(JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8")), file));
}

describe("dreamer eval dev corpus", () => {
    test("every scenario validates and its filename matches its id", () => {
        const scenarios = parseCorpus();
        expect(scenarios.length).toBeGreaterThan(0);
        expect(corpusFiles()).toEqual(scenarios.map((scenario) => `${scenario.id}.json`).sort());
    });

    test("core pool covers every required maintenance pressure", () => {
        const core = parseCorpus().find((scenario) => scenario.id === "dme-core-pool");
        expect(core).toBeDefined();
        const pressureClaims = Object.fromEntries(core!.pressureRoles.map((entry) => [entry.role, entry.claimIds]));
        expect(pressureClaims).toEqual({
            "semantic-duplicate-pair": ["claim-cache-primary", "claim-cache-duplicate"],
            "near-duplicate-pair": ["claim-retry-attempts", "claim-retry-backoff"],
            stale: ["claim-worker-stale"],
            "contradiction-pair": ["claim-feature-enabled", "claim-feature-disabled"],
            "false-fluent": ["claim-legacy-queue"],
            "high-value-file-independent": ["claim-tls-constraint"],
            "rejected-alternative": ["claim-rejected-redis"],
            "branch-specific": ["claim-release-branch"],
        });

        const claims = new Map(core!.pool.claims.map((claim) => [claim.id, claim]));
        const verify = core!.tasks.find((task) => task.task === "verify")!;
        if (verify.gold.kind !== "verify") throw new Error("verify task has non-verify gold");
        const verdicts = new Map(verify.gold.claims.map((claim) => [claim.claimId, claim]));

        const semanticPair = pressureClaims["semantic-duplicate-pair"]!.map((claimId) => claims.get(claimId)!);
        expect(semanticPair[0]!.fixtureFiles).toEqual(semanticPair[1]!.fixtureFiles);
        expect(semanticPair.map((claim) => verdicts.get(claim.id)?.verdict)).toEqual(["verified", "verified"]);
        const nearPair = pressureClaims["near-duplicate-pair"]!.map((claimId) => claims.get(claimId)!);
        expect(nearPair[0]!.fixtureFiles).toEqual(nearPair[1]!.fixtureFiles);
        expect(nearPair[0]!.content).not.toBe(nearPair[1]!.content);
        expect(nearPair.map((claim) => verdicts.get(claim.id)?.verdict)).toEqual(["verified", "verified"]);
        const contradictionPair = pressureClaims["contradiction-pair"]!;
        expect(claims.get(contradictionPair[1]!)!.fixtureFiles).toEqual(
            claims.get(contradictionPair[0]!)!.fixtureFiles,
        );
        expect(contradictionPair.map((claimId) => verdicts.get(claimId)?.verdict).sort()).toEqual(["archive", "verified"]);

        const stale = claims.get("claim-worker-stale")!;
        const staleGold = verdicts.get(stale.id)!;
        expect(staleGold).toMatchObject({ verdict: "update" });
        expect(staleGold.requiredUpdateAnchors.some((anchor) => {
            const value = anchor.match(/\d+/)?.[0];
            return value !== undefined && stale.fixtureFiles.some((file) => file.content.includes(value));
        })).toBe(true);
        expect(staleGold.forbiddenUpdateAnchors.some((anchor) => stale.content.includes(anchor))).toBe(true);
        expect(verdicts.get("claim-feature-disabled")?.verdict).toBe("archive");
        expect(verdicts.get("claim-legacy-queue")?.verdict).toBe("archive");
        expect(claims.get("claim-tls-constraint")).toMatchObject({
            fileIndependent: true,
            fixtureFiles: [],
        });
        const classify = core!.tasks.find((task) => task.task === "classify-memories")!;
        if (classify.gold.kind !== "classify") throw new Error("classify task has non-classify gold");
        expect(classify.gold.claims.find((claim) => claim.claimId === "claim-tls-constraint")?.importance.min).toBe(85);
        expect(verdicts.get("claim-rejected-redis")?.verdict).toBe("verified");
        expect(verdicts.get("claim-release-branch")?.verdict).toBe("verified");

        const contents = core!.pool.claims.map((claim) => claim.content.toLowerCase()).join("\n");
        expect(contents).not.toContain("control");
        expect(contents).not.toContain("false side");
        expect(contents).not.toContain("stale fixture");
        expect(core!.tasks.map((task) => task.task).sort()).toEqual(["classify-memories", "map-memories", "verify"]);
    });

    test("verify-broad has seeded history and a declared broad partition", () => {
        const broad = parseCorpus().find((scenario) => scenario.id === "dme-verify-broad-history");
        expect(broad?.tasks).toHaveLength(1);
        const task = broad!.tasks[0]!;
        expect(task.task).toBe("verify-broad");
        expect(task.expectedResultMode).toBe("broad");
        expect(task.preconditions.verifications.length).toBeGreaterThan(0);
        expect(task.expectedInScopeClaimIds.length + task.expectedSkippedClaimIds.length).toBe(
            broad!.pool.claims.length,
        );
    });

    test("classify gold is unreachable by inheriting the seeded classification", () => {
        const core = parseCorpus().find((scenario) => scenario.id === "dme-core-pool");
        const task = core!.tasks.find((entry) => entry.task === "classify-memories");
        const gold = task!.gold;
        expect(gold.kind).toBe("classify");
        if (gold.kind !== "classify") return;
        const seededById = new Map(core!.pool.claims.map((claim) => [claim.id, claim]));
        expect(gold.claims.length).toBe(core!.pool.claims.length);
        for (const expected of gold.claims) {
            const seeded = seededById.get(expected.claimId);
            expect(seeded).toBeDefined();
            // `scoreClassifyManifest` resolves an attribute the manifest omits
            // from the claim's stored value — production-valid behaviour, since
            // production preserves what an entry leaves out. So any attribute
            // seeded already inside gold can be scored PASS by a model that
            // never classified it, and a pool seeded entirely at gold makes the
            // whole experiment green for a model that echoes the prompt. Every
            // attribute below therefore starts off gold, which is what forces a
            // manifest to state all three.
            expect(
                seeded!.importance >= expected.importance.min && seeded!.importance <= expected.importance.max,
            ).toBe(false);
            expect(seeded!.memoryScope).not.toBe(expected.scope);
            expect(seeded!.sharing === "shareable").not.toBe(expected.shareable);
        }
    });

    test("production preflight accepts every declared scenario task", async () => {
        for (const scenario of parseCorpus()) {
            for (const task of scenario.tasks) {
                const database = createDirectTestDatabase().db;
                const workdir = mkdtempSync(join(tmpdir(), "dreamer-eval-corpus-"));
                try {
                    const seeded = await seedDreamerEvalTask({ db: database, scenario, task, workdir });
                    // Copy before sorting: `sort` is in place, and asserting
                    // against a preflight field the assertion itself reordered
                    // proves nothing about what production returned.
                    expect([...seeded.preflight.inScopeClaimIds].sort()).toEqual(
                        [...task.expectedInScopeClaimIds].sort(),
                    );
                    // `preflightDreamerEvalTask` already refuses a partition or
                    // mode mismatch with gate-mismatch, so these restate that
                    // contract where the test names it rather than leaving the
                    // skipped set and the gate branch proven only by the absence
                    // of a throw inside the seeder.
                    expect([...seeded.preflight.skippedClaimIds].sort()).toEqual(
                        [...task.expectedSkippedClaimIds].sort(),
                    );
                    expect(seeded.preflight.mode).toEqual(task.expectedResultMode);
                } finally {
                    closeQuietly(database);
                    rmSync(workdir, { recursive: true, force: true });
                }
            }
        }
    });
});
