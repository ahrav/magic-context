import { estimateTokens } from "../../../hooks/magic-context/read-session-formatting";
import type { Database } from "../../../shared/sqlite";
import { escapeXmlAttr, escapeXmlContent } from "../compartment-storage";
import type { SnapshotVector } from "./claim-operation-contract";
import { V2_MEMORY_CATEGORIES } from "./constants";
import {
    type ProjectMemoryClaimSnapshot,
    readProjectMemoryCurrentState,
    resolveProjectIdsForIdentities,
} from "./storage-claim-current-state";

export interface AuthorizedClaimMemorySnapshot {
    items: ProjectMemoryClaimSnapshot[];
    projectIds: number[];
    ownProjectIds: number[];
    identityByProjectId: Map<number, string>;
    snapshotVector: SnapshotVector;
}

export function readAuthorizedClaimMemorySnapshot(
    db: Database,
    args: {
        authorizedIdentities: readonly string[];
        ownIdentities: readonly string[];
        sharedCategories: readonly string[];
        workspaceEpoch: string;
        /**
         * `workspaceIdentities` identifies the identities used to derive `workspaceEpoch` and the authorization.
         */
        workspaceIdentities?: readonly string[];
        nowMs?: number;
    },
): AuthorizedClaimMemorySnapshot | null {
    const projectIds = resolveProjectIdsForIdentities(db, args.authorizedIdentities);
    const ownProjectIds = resolveProjectIdsForIdentities(db, args.ownIdentities);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = readProjectMemoryCurrentState(db, {
            projectIds,
            workspaceAuthorization: {
                ownProjectIds,
                sharedCategories: args.sharedCategories,
            },
            surface: "auto_inject",
            lifecycleStates: ["active"],
            workspaceEpoch: args.workspaceEpoch,
            ...(args.workspaceIdentities === undefined
                ? {}
                : { workspaceIdentities: args.workspaceIdentities }),
            ...(args.nowMs === undefined ? {} : { nowMs: args.nowMs }),
        });
        if (result.status === "ok") {
            return {
                items: result.items,
                projectIds,
                ownProjectIds,
                identityByProjectId: readProjectIdentityMap(db, projectIds),
                snapshotVector: result.snapshotVector,
            };
        }
    }
    return null;
}

export interface ClaimMemoryRenderOptions {
    /* */
    sourceNameByClaimId?: ReadonlyMap<string, string>;
}

/** Importance affects selection but is omitted so classification-only changes preserve rendered bytes.
 * */
export function renderClaimMemoryLine(
    item: ProjectMemoryClaimSnapshot,
    sourceName?: string,
): string {
    const source = sourceName ? ` [${escapeXmlContent(sourceName)}]` : "";
    return `${item.publicClaimId}${source}: ${escapeXmlContent(item.content)}`;
}

export function claimSelectionOrder(
    left: ProjectMemoryClaimSnapshot,
    right: ProjectMemoryClaimSnapshot,
): number {
    const importanceDiff = right.importance - left.importance;
    if (importanceDiff !== 0) return importanceDiff;
    return left.publicClaimId < right.publicClaimId ? -1 : 1;
}

export function claimRenderOrder(
    left: ProjectMemoryClaimSnapshot,
    right: ProjectMemoryClaimSnapshot,
): number {
    const leftPriority = V2_MEMORY_CATEGORIES.indexOf(
        left.category as (typeof V2_MEMORY_CATEGORIES)[number],
    );
    const rightPriority = V2_MEMORY_CATEGORIES.indexOf(
        right.category as (typeof V2_MEMORY_CATEGORIES)[number],
    );
    if (leftPriority >= 0 || rightPriority >= 0) {
        if (leftPriority < 0) return 1;
        if (rightPriority < 0) return -1;
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    } else if (left.category !== right.category) {
        return left.category < right.category ? -1 : 1;
    }
    return left.publicClaimId < right.publicClaimId ? -1 : 1;
}

export function renderClaimMemoryBlock(
    items: readonly ProjectMemoryClaimSnapshot[],
    wrapper = "project-memory",
    renderOptions: ClaimMemoryRenderOptions = {},
): string {
    if (items.length === 0) return "";
    const ordered = [...items].sort(claimRenderOrder);
    const lines = [`<${wrapper}>`];
    let openCategory: string | undefined;
    for (const item of ordered) {
        if (item.category !== openCategory) {
            if (openCategory !== undefined) lines.push(`</${escapeXmlAttr(openCategory)}>`);
            openCategory = item.category;
            lines.push(`<${escapeXmlAttr(openCategory)}>`);
        }
        lines.push(
            renderClaimMemoryLine(item, renderOptions.sourceNameByClaimId?.get(item.publicClaimId)),
        );
    }
    if (openCategory !== undefined) lines.push(`</${escapeXmlAttr(openCategory)}>`);
    lines.push(`</${wrapper}>`);
    return lines.join("\n");
}

/**
 * Token accounting measures the wrapper, each candidate line, and each category's tags once.
 * BPE merges across newline joins can only reduce the whole token count relative to the sum of its parts.
 * The additive account is an upper bound.
 * stay conservative.
 */
function createClaimBlockAccounting(renderOptions: ClaimMemoryRenderOptions) {
    const seenCategories = new Set<string>();
    const categoryCost = new Map<string, number>();
    return {
        usedTokens: estimateTokens("<project-memory>\n</project-memory>"),
        candidateCost(item: ProjectMemoryClaimSnapshot): number {
            const line = renderClaimMemoryLine(
                item,
                renderOptions.sourceNameByClaimId?.get(item.publicClaimId),
            );
            let cost = estimateTokens(`${line}\n`);
            if (!seenCategories.has(item.category)) {
                let tags = categoryCost.get(item.category);
                if (tags === undefined) {
                    tags = estimateTokens(
                        `<${escapeXmlAttr(item.category)}>\n</${escapeXmlAttr(item.category)}>\n`,
                    );
                    categoryCost.set(item.category, tags);
                }
                cost += tags;
            }
            return cost;
        },
        admit(item: ProjectMemoryClaimSnapshot, cost: number): void {
            this.usedTokens += cost;
            seenCategories.add(item.category);
        },
    };
}

export interface TrimClaimSnapshotsResult {
    selected: ProjectMemoryClaimSnapshot[];
    renderOrder: ProjectMemoryClaimSnapshot[];
}

export function trimClaimSnapshotsToBudget(
    items: readonly ProjectMemoryClaimSnapshot[],
    budgetTokens: number,
    renderOptions: ClaimMemoryRenderOptions = {},
): TrimClaimSnapshotsResult {
    const selectionOrder = [...items].sort(claimSelectionOrder);
    const selected: ProjectMemoryClaimSnapshot[] = [];
    const accounting = createClaimBlockAccounting(renderOptions);
    for (const item of selectionOrder) {
        const cost = accounting.candidateCost(item);
        if (accounting.usedTokens + cost > budgetTokens) continue;
        accounting.admit(item, cost);
        selected.push(item);
    }
    return { selected, renderOrder: [...selected].sort(claimRenderOrder) };
}

/** The map associates each numeric project ID with its canonical project identity. */
export function readProjectIdentityMap(
    db: Database,
    projectIds: readonly number[],
): Map<number, string> {
    const out = new Map<number, string>();
    const ids = [...new Set(projectIds)];
    if (ids.length === 0) return out;
    const rows = db
        .prepare(
            // Interpolation is a compile-time placeholder list, not caller input.
            // pi-lens-ignore: sql-injection
            `SELECT id, canonical_identity AS identity FROM projects
              WHERE id IN (${ids.map(() => "?").join(", ")})`,
        )
        .all(...ids) as Array<{ id: number; identity: string }>;
    for (const row of rows) out.set(row.id, row.identity);
    return out;
}
