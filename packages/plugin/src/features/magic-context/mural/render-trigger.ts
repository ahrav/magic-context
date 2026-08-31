import { createHash } from "node:crypto";

import { piModelRefToCanonical } from "../../../shared/harness-provider-map";
import { log } from "../../../shared/logger";
import { modelSupportsVision } from "../../../shared/models-dev-cache";
import type { Database } from "../../../shared/sqlite";
import type { ProjectMemoryClaimSnapshot } from "../memory/storage-claim-current-state";
import {
    readProjectMemoryCurrentState,
    readProjectMemorySnapshotVector,
    resolveProjectIdsForIdentities,
    snapshotVectorChanges,
} from "../memory/storage-claim-current-state";
import { computeWorkspaceEpochFingerprint } from "../workspaces";
import { DEFAULT_MURAL_MEMORY_BUDGET } from "./mural-selection";
import { renderMural } from "./render-mural";
import type { MuralWireOptions } from "./resolve-mural";
import { getMuralCoverage, resolveMural } from "./resolve-mural";
import { getMural, upsertMural } from "./storage-mural";

/**
 * The m0 injection path renders the deterministic mural on demand.
 * The mural is a pure function of the compressed cue pool.
 * Change detection resolves the mural and compares a text-assembly hash without encoding a PNG.
 * An unchanged cue pool requires one resolve and one hash comparison.
 * The code encodes and upserts a PNG when the resolved text is new or differs from the stored text.
 * actually changed.
 *
 * The stored row supplies `mural_manifest` for `get_mural`.
 * The row's `model` column is `"deterministic"` because no compressor model renders the mural.
 * The code records the compressor model per cue, not per render.
 */

export const DETERMINISTIC_MURAL_MODEL = "deterministic";
export const MIN_MURAL_CUED_MEMORIES = 15;
export const MIN_MURAL_COVERAGE = 0.5;

export interface EnsureMuralResult {
    /** `hasMural` is true when a resolved cue pool exists, so the mural block should be injected. */
    hasMural: boolean;
    /** `dataUrl` contains the current mural PNG data URL when `hasMural` is true. */
    dataUrl?: string;
    /** `contentHash` is the SHA-256 of the mural PNG bytes and identifies the m0 mural fold. */
    contentHash?: string;
    /** `rerendered` is true when this call re-rendered and upserted because the text was new or changed. */
    rerendered: boolean;
    /** `skipReason` is set when the coverage gate intentionally omits the mural. */
    skipReason?: string;
    width?: number;
    height?: number;
}

/* */
export function muralCoverageGate(cuedMemoryCount: number, activeMemoryCount: number): boolean {
    return (
        cuedMemoryCount >= MIN_MURAL_CUED_MEMORIES ||
        cuedMemoryCount >= MIN_MURAL_COVERAGE * activeMemoryCount
    );
}

/**
 * The function updates the stored mural when the resolved mural text is new or differs from the stored text.
 * The function returns wire data for the injection path.
 *
 * `budgetTokens` sets the project memory injection budget used to select the overflow set.
 * The overflow set matches the memories dropped by the m0 path.
 */
export function ensureMuralRendered(
    db: Database,
    projectIdentity: string,
    budgetTokens: number = DEFAULT_MURAL_MEMORY_BUDGET,
): EnsureMuralResult {
    // The mural uses the same `auto_inject` policy decision as the m[0] text pool.
    // The current-state provider applies policy before limits.
    // The current-state provider rechecks its snapshot vector against a fresh snapshot.
    // A quarantine committed during hydration returns `stale`.
    // A `stale` result retries against fresh state to avoid rendering hidden content.
    const projectIds = resolveProjectIdsForIdentities(db, [projectIdentity]);
    if (projectIds.length === 0) {
        log(`[mural] skipped for ${projectIdentity}: no active memories`);
        return { hasMural: false, rerendered: false, skipReason: "no active memories" };
    }
    const workspaceEpoch = computeWorkspaceEpochFingerprint(db, [projectIdentity]);
    let pool: ProjectMemoryClaimSnapshot[] | null = null;
    let baseVector: ReturnType<typeof readProjectMemorySnapshotVector> | null = null;
    for (let attempt = 0; attempt < 2 && pool === null; attempt += 1) {
        const result = readProjectMemoryCurrentState(db, {
            projectIds,
            workspaceEpoch,
            workspaceIdentities: [projectIdentity],
            surface: "auto_inject",
        });
        if (result.status === "ok") {
            pool = result.items;
            baseVector = result.snapshotVector;
        }
    }
    if (pool === null || baseVector === null) {
        // If both attempts observe changed claim or policy generations, skip rendering.
        // A changed claim or policy generation rebuilds the pool.
        log(
            `[mural] skipped for ${projectIdentity}: memory pool unstable (generations kept moving)`,
        );
        return { hasMural: false, rerendered: false, skipReason: "memory pool unstable" };
    }
    const coverage = getMuralCoverage(db, projectIdentity, pool);
    if (
        coverage.activeMemoryCount === 0 ||
        !muralCoverageGate(coverage.cuedMemoryCount, coverage.activeMemoryCount)
    ) {
        const skipReason =
            coverage.activeMemoryCount === 0
                ? "no active memories"
                : `only ${coverage.cuedMemoryCount}/${coverage.activeMemoryCount} active memories have current cues (requires ${MIN_MURAL_CUED_MEMORIES} cues or ${MIN_MURAL_COVERAGE * 100}% coverage)`;
        log(`[mural] skipped for ${projectIdentity}: ${skipReason}`);
        return { hasMural: false, rerendered: false, skipReason };
    }

    const entries = resolveMural(db, projectIdentity, budgetTokens, pool);
    if (entries.length === 0) {
        // When the overflow pool is empty, omit the mural block but retain any stored row for the dashboard.
        return { hasMural: false, rerendered: false };
    }

    const rendered = renderMural(
        entries.map((entry) => ({
            id: entry.publicClaimId,
            category: entry.category,
            importance: entry.importance,
            cue: entry.cue,
        })),
    );
    // The resolved mural text is the change-detection key, avoiding PNG encoding when it is unchanged.
    const textHash = createHash("sha256").update(rendered.sha256Input).digest("hex");

    // Return no mural when the memory snapshot changes during rendering.
    // rebuild.
    const freshVector = readProjectMemorySnapshotVector(db, projectIds, workspaceEpoch);
    if (snapshotVectorChanges(baseVector, freshVector).length > 0) {
        log(`[mural] skipped for ${projectIdentity}: memory pool changed during render`);
        return {
            hasMural: false,
            rerendered: false,
            skipReason: "memory pool changed during render",
        };
    }

    const existing = getMural(db, projectIdentity);
    if (
        existing &&
        existing.contentHash === textHash &&
        existing.width === rendered.width &&
        existing.height === rendered.height
    ) {
        return {
            hasMural: true,
            dataUrl: `data:image/png;base64,${existing.image.toString("base64")}`,
            contentHash: existing.contentHash,
            rerendered: false,
            width: existing.width,
            height: existing.height,
        };
    }

    upsertMural(db, {
        projectPath: projectIdentity,
        image: Buffer.from(rendered.png),
        // content_hash is the resolved mural text hash used for change detection, not the PNG hash.
        contentHash: textHash,
        renderedAt: Date.now(),
        model: DETERMINISTIC_MURAL_MODEL,
        memoryIds: rendered.renderedIds,
        width: rendered.width,
        height: rendered.height,
    });

    return {
        hasMural: true,
        dataUrl: rendered.dataUrl,
        contentHash: textHash,
        rerendered: true,
        width: rendered.width,
        height: rendered.height,
    };
}

/** Return false unless the canonical model key has a provider/model separator and supports vision.
 * The first `/` separates the provider from the model.
 * */
function modelKeyAcceptsImages(modelKey: string | undefined): boolean {
    if (!modelKey) return false;
    const canonical = piModelRefToCanonical(modelKey);
    const separator = canonical.indexOf("/");
    if (separator <= 0) return false;
    return modelSupportsVision(canonical.slice(0, separator), canonical.slice(separator + 1));
}

/**
 *
 */
export function resolveMuralWire(
    db: Database,
    projectIdentity: string | undefined,
    modelKey: string | undefined,
    enabled: boolean,
    budgetTokens: number = DEFAULT_MURAL_MEMORY_BUDGET,
): MuralWireOptions {
    if (!enabled || !projectIdentity || !modelKeyAcceptsImages(modelKey)) {
        return { enabled, supportsVision: false };
    }
    const result = ensureMuralRendered(db, projectIdentity, budgetTokens);
    if (!result.hasMural) return { enabled: true, supportsVision: true };
    return {
        enabled: true,
        supportsVision: true,
        dataUrl: result.dataUrl,
        contentHash: result.contentHash,
    };
}
