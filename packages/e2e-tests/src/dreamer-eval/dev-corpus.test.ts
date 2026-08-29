import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDirectTestDatabase } from "../../../plugin/src/features/magic-context/test-database";
import { closeQuietly } from "../../../plugin/src/shared/sqlite-helpers";
import { parseScenario, type DreamerEvalScenario } from "./contract";
import { seedDreamerEvalTask } from "./seeder";

const CORPUS_DIR = join(import.meta.dir, "../../dreamer-eval/dev");

const CORPUS_FILES = readdirSync(CORPUS_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort();
const SCENARIOS: DreamerEvalScenario[] = CORPUS_FILES.map((file) =>
    parseScenario(JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8")), file),
);

describe("dreamer eval dev corpus", () => {
    test("every scenario validates and its filename matches its id", () => {
        expect(SCENARIOS.length).toBeGreaterThan(0);
        expect(CORPUS_FILES).toEqual(SCENARIOS.map((scenario) => `${scenario.id}.json`).sort());
    });

    test("core pool covers every required maintenance pressure", () => {
        const core = SCENARIOS.find((scenario) => scenario.id === "dme-core-pool");
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
        expect(contradictionPair.map((claimId) => claims.get(claimId)!.fixtureFiles)).toEqual([
            claims.get(contradictionPair[0]!)!.fixtureFiles,
            claims.get(contradictionPair[0]!)!.fixtureFiles,
        ]);
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
            importance: 95,
            fileIndependent: true,
            fixtureFiles: [],
        });
        expect(verdicts.get("claim-rejected-redis")?.verdict).toBe("verified");
        expect(verdicts.get("claim-release-branch")?.verdict).toBe("verified");

        const contents = core!.pool.claims.map((claim) => claim.content.toLowerCase()).join("\n");
        for (const leakedLabel of core!.pressureRoles.map((entry) => entry.role.replaceAll("-", " "))) {
            expect(contents).not.toContain(leakedLabel);
        }
        expect(contents).not.toContain("control");
        expect(contents).not.toContain("false side");
        expect(contents).not.toContain("stale fixture");
        expect(core!.tasks.map((task) => task.task).sort()).toEqual(["classify-memories", "map-memories", "verify"]);
    });

    test("verify-broad has seeded history and a declared broad partition", () => {
        const broad = SCENARIOS.find((scenario) => scenario.id === "dme-verify-broad-history");
        expect(broad?.tasks).toHaveLength(1);
        const task = broad!.tasks[0]!;
        expect(task.task).toBe("verify-broad");
        expect(task.expectedResultMode).toBe("broad");
        expect(task.preconditions.verifications.length).toBeGreaterThan(0);
        expect(task.expectedInScopeClaimIds.length + task.expectedSkippedClaimIds.length).toBe(
            broad!.pool.claims.length,
        );
    });

    test("production preflight accepts every declared scenario task", async () => {
        for (const scenario of SCENARIOS) {
            for (const task of scenario.tasks) {
                const database = createDirectTestDatabase().db;
                const workdir = mkdtempSync(join(tmpdir(), "dreamer-eval-corpus-"));
                try {
                    const seeded = await seedDreamerEvalTask({ db: database, scenario, task, workdir });
                    expect(seeded.preflight.inScopeClaimIds.sort()).toEqual([...task.expectedInScopeClaimIds].sort());
                    expect(seeded.pool.claims.map((claim) => claim.content)).toEqual(
                        scenario.pool.claims.map((claim) => claim.content),
                    );
                } finally {
                    closeQuietly(database);
                    rmSync(workdir, { recursive: true, force: true });
                }
            }
        }
    });
});
