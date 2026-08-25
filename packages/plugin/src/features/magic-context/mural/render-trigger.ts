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
 * On-demand deterministic mural render. The weekly author task is gone: the
 * mural is now a pure function of the compressed cue pool, rendered when the m0
 * injection path needs it. Change detection is CHEAP — resolveMural plus a text
 * assembly hash, no PNG work — so an unchanged cue pool costs one resolve and a
 * hash compare. The PNG is only encoded and upserted when the resolved text
 * actually changed.
 *
 * The stored row still feeds `mural_manifest` for the dashboard (`get_mural`);
 * its `model` column becomes "deterministic" since no compressor model rendered
 * it (the compressor model is recorded per-cue, not per-render).
 */

export const DETERMINISTIC_MURAL_MODEL = "deterministic";
export const MIN_MURAL_CUED_MEMORIES = 15;
export const MIN_MURAL_COVERAGE = 0.5;

export interface EnsureMuralResult {
    /** True when a resolved cue pool exists (the mural block should be injected). */
    hasMural: boolean;
    /** data URL of the current mural PNG, when hasMural. */
    dataUrl?: string;
    /** sha256 of the mural PNG bytes — the m0 mural fold identity. */
    contentHash?: string;
    /** True when this call re-rendered + upserted (the text changed or was new). */
    rerendered: boolean;
    /** Set when the coverage gate intentionally omitted the mural. */
    skipReason?: string;
    width?: number;
    height?: number;
}

/** A mural is useful with enough cues or broad enough pool coverage. */
export function muralCoverageGate(cuedMemoryCount: number, activeMemoryCount: number): boolean {
    return (
        cuedMemoryCount >= MIN_MURAL_CUED_MEMORIES ||
        cuedMemoryCount >= MIN_MURAL_COVERAGE * activeMemoryCount
    );
}

/**
 * Ensure the stored mural reflects the current compressed cue pool, rendering
 * and upserting only when the deterministic mural TEXT changed since the stored
 * render. Returns the wire data for the injection path.
 *
 * @param budgetTokens the project memory injection budget, so the overflow set
 *   matches exactly what the m0 path dropped.
 */
export function ensureMuralRendered(
    db: Database,
    projectIdentity: string,
    budgetTokens: number = DEFAULT_MURAL_MEMORY_BUDGET,
): EnsureMuralResult {
    // The mural is folded into m[0] as an image, so it is an AUTOMATIC
    // injection channel and must use the same `auto_inject` decision the m[0]
    // text pool uses. The current-state provider applies policy before any
    // limit and rechecks its snapshot vector from a fresh snapshot, so a
    // quarantine landing mid-hydration reads as `stale` and retries against
    // fresh state instead of rendering hidden content.
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
            surface: "auto_inject",
        });
        if (result.status === "ok") {
            pool = result.items;
            baseVector = result.snapshotVector;
        }
    }
    if (pool === null || baseVector === null) {
        // Fail closed: the claim/policy generations moved during both
        // attempts, so a quarantine committed after the last policy read
        // could sit in this pool. Skip the render this pass; the next
        // generation-driven pass rebuilds.
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
        // Empty overflow pool → no mural block. Leave any stale stored row alone
        // so the dashboard can still show the last render.
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
    // The mural TEXT (not the PNG) is the change-detection key: it's cheap to
    // assemble and deterministic, so an unchanged pool re-derives the same hash
    // and we skip PNG re-encode + DB write entirely.
    const textHash = createHash("sha256").update(rendered.sha256Input).digest("hex");

    // Post-render revalidation: coverage, resolution, and PNG encoding all
    // ran after the provider's fresh-snapshot recheck, and the image carries
    // no trust label to demote. A quarantine, rejection, or rewrite landing
    // in that window must not be reused, upserted, or returned for the
    // current prompt — fail closed and let the next generation-driven pass
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
        // Unchanged: reuse the stored PNG (already the right bytes) without re-encoding.
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
        // content_hash is the TEXT hash (the change-detection key), not a PNG
        // hash: identical text always yields identical PNG bytes, and hashing the
        // text is what lets the unchanged-pool fast path above skip re-encoding.
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

/** True only when the given model's cached provider metadata accepts images. A
 *  model key is `provider/model`; unknown capability means no image.
 *  Pi-native prefixes (`openai-codex/…`, `google-antigravity/…`) are translated
 *  to the canonical OpenCode form before the models.dev lookup so both harnesses
 *  share one vision gate. Missing cache entries fail closed (no image). */
function modelKeyAcceptsImages(modelKey: string | undefined): boolean {
    if (!modelKey) return false;
    const canonical = piModelRefToCanonical(modelKey);
    const separator = canonical.indexOf("/");
    if (separator <= 0) return false;
    return modelSupportsVision(canonical.slice(0, separator), canonical.slice(separator + 1));
}

/**
 * Resolve the mural WIRE options for the m0 injection path: gate on the mural
 * feature flag AND the outgoing model's vision capability, then ensure the
 * deterministic mural is rendered and return its data URL + content hash. This
 * is the on-demand render trigger — called from the HARD-fold materialization so
 * the injected data-url only swaps on a natural fold (defer passes replay the
 * baked-in bytes), matching the existing inject-compartments cache rule.
 *
 * Returns `{ enabled: false }` (no image) when the feature is off, the model
 * can't take images, or the cue pool is empty.
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
