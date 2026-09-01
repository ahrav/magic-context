//
// Run this script with `bun packages/plugin/scripts/test-mural-render.ts [projectIdentity ...]`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openDatabase } from "../src/features/magic-context/storage";
import { getMuralCoverage, resolveMural } from "../src/features/magic-context/mural/resolve-mural";
import { muralCoverageGate } from "../src/features/magic-context/mural/render-trigger";
import {
    readProjectMemoryCurrentState,
    resolveProjectIdsForIdentities,
} from "../src/features/magic-context/memory/storage-claim-current-state";
import {
    muralImageTokenEstimateForDimensions,
    renderMural,
} from "../src/features/magic-context/mural/render-mural";

const outDir = join(import.meta.dir, "mural-test-output");
mkdirSync(outDir, { recursive: true });

const db = openDatabase();
if (!db) {
    console.error("test-mural-render: could not open context.db");
    process.exit(1);
}
const requested = process.argv.slice(2);
const identities =
    requested.length > 0
        ? requested
        : (
              db
                  .prepare(
                      `SELECT DISTINCT projects.canonical_identity AS project_path
                       FROM claim_mural_cues
                       JOIN claims ON claims.id = claim_mural_cues.claim_id
                       JOIN projects ON projects.id = claims.project_id
                       WHERE claim_mural_cues.cue IS NOT NULL
                       UNION SELECT project_path FROM mural_manifest`,
                  )
                  .all() as { project_path: string }[]
          ).map((row) => row.project_path);

for (const identity of identities) {
    const projectIds = resolveProjectIdsForIdentities(db, [identity]);
    const state =
        projectIds.length > 0
            ? readProjectMemoryCurrentState(db, { projectIds, surface: "auto_inject" })
            : null;
    const pool = state?.status === "ok" ? state.items : [];
    const coverage = getMuralCoverage(db, identity, pool);
    const gatePassed = muralCoverageGate(coverage.cuedMemoryCount, coverage.activeMemoryCount);
    const header = `${identity} · active=${coverage.activeMemoryCount} cued=${coverage.cuedMemoryCount}`;
    if (!gatePassed) {
        console.log(`${header} → GATE SKIP (needs >=15 cued or >=50% coverage)`);
        continue;
    }
    const entries = resolveMural(db, identity, undefined, pool);
    if (entries.length === 0) {
        console.log(`${header} → NO MURAL (overflow pool empty; all memories fit the m0 budget)`);
        continue;
    }
    const result = renderMural(
        entries.map((entry) => ({
            id: entry.publicClaimId,
            category: entry.category,
            importance: entry.importance,
            cue: entry.cue,
        })),
    );
    const tokens = muralImageTokenEstimateForDimensions(result.width, result.height);
    const file = join(outDir, `${identity.replace(/[^a-z0-9]/gi, "_").slice(0, 60)}.png`);
    writeFileSync(file, result.png);
    console.log(
        `${header} → ${result.width}x${result.height} · ${tokens} tokens · rendered=${result.renderedIds.length} dropped=${result.droppedIds.length} · ${file}`,
    );
}
