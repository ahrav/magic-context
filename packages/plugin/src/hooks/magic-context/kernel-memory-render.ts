/**
 * Renders a `KernelMemorySnapshot` into the m[0] `<project-memory>` block.
 * Row rendering and budget trimming live here, next to the injector that owns
 * the budget; the state marker line comes from the shared client so every
 * surface words a state the same way.
 */

import { escapeXmlAttr, escapeXmlContent } from "../../features/magic-context/compartment-storage";
import { V2_MEMORY_CATEGORIES } from "../../features/magic-context/memory/constants";
import {
    type KernelMemorySnapshot,
    type MemoryState,
    type ReadRow,
    renderMemoryStateMarker,
    stateKey,
    unavailable,
} from "../../shared/kernel-client";
import { estimateTokens } from "../../shared/token-estimator";

export const PROJECT_MEMORY_WRAPPER = "project-memory";

/** The snapshot an injector renders when no client can be reached at all. */
export function daemonAbsentSnapshot(): KernelMemorySnapshot {
    return { state: unavailable("daemon_absent"), rows: [], knownAsOf: null };
}

/**
 * One string that changes whenever the rendered memory could: the state, the
 * snapshot position, and the row count. Cache keys embed it so a state flip
 * with identical rows still busts the cached block.
 */
export function memorySnapshotKey(snapshot: KernelMemorySnapshot): string {
    return `${stateKey(snapshot.state)}@${snapshot.knownAsOf ?? "-"}#${snapshot.rows.length}`;
}

/** Rows with a decision payload are the only ones that render as memory text. */
export function memoryRows(snapshot: KernelMemorySnapshot): ReadRow[] {
    return snapshot.rows.filter((row) => row.decision !== undefined);
}

/** The identity a rendered row is tracked by in cache manifests and search exclusion. */
export function memoryRowLocator(row: ReadRow): string {
    return row.object.object_id;
}

export function memoryRowCategory(row: ReadRow): string {
    return row.decision?.decision_kind ?? row.object.object_kind;
}

export function renderKernelMemoryLine(row: ReadRow): string {
    const summary = row.decision?.payload.summary ?? "";
    const label = row.labeled ? " [labeled]" : "";
    return `${row.object.object_id}${label}: ${escapeXmlContent(summary)}`;
}

/** Unlabeled rows first, then newer rows, then object id, so a budget cut drops the least trusted and oldest rows. */
function selectionOrder(left: ReadRow, right: ReadRow): number {
    if (left.labeled !== right.labeled) return left.labeled ? 1 : -1;
    const seqDiff = right.object.created_commit_seq - left.object.created_commit_seq;
    if (seqDiff !== 0) return seqDiff;
    return left.object.object_id < right.object.object_id ? -1 : 1;
}

/** Taxonomy categories in their declared order, other categories alphabetically after them, ids tie-break. */
function renderOrder(left: ReadRow, right: ReadRow): number {
    const leftCategory = memoryRowCategory(left);
    const rightCategory = memoryRowCategory(right);
    const leftPriority = (V2_MEMORY_CATEGORIES as readonly string[]).indexOf(leftCategory);
    const rightPriority = (V2_MEMORY_CATEGORIES as readonly string[]).indexOf(rightCategory);
    if (leftPriority >= 0 || rightPriority >= 0) {
        if (leftPriority < 0) return 1;
        if (rightPriority < 0) return -1;
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    } else if (leftCategory !== rightCategory) {
        return leftCategory < rightCategory ? -1 : 1;
    }
    return left.object.object_id < right.object.object_id ? -1 : 1;
}

/**
 * Token accounting sums the wrapper, each admitted line, and each category's
 * tags once. Tokenizer merges across newline joins only lower the whole-block
 * count, so the additive sum is an upper bound and the budget holds.
 */
export function trimKernelRowsToBudget(rows: readonly ReadRow[], budgetTokens: number): ReadRow[] {
    const seenCategories = new Set<string>();
    let usedTokens = estimateTokens(`<${PROJECT_MEMORY_WRAPPER}>\n</${PROJECT_MEMORY_WRAPPER}>`);
    const selected: ReadRow[] = [];
    for (const row of [...rows].sort(selectionOrder)) {
        const category = memoryRowCategory(row);
        let cost = estimateTokens(`${renderKernelMemoryLine(row)}\n`);
        if (!seenCategories.has(category)) {
            cost += estimateTokens(`<${escapeXmlAttr(category)}>\n</${escapeXmlAttr(category)}>\n`);
        }
        if (usedTokens + cost > budgetTokens) continue;
        usedTokens += cost;
        seenCategories.add(category);
        selected.push(row);
    }
    return selected.sort(renderOrder);
}

/**
 * The block carries the rows grouped by category and, when the state is not a
 * clean `available` with rows, the state marker line. An `available` snapshot
 * with zero rows renders the empty-project marker so the model learns the
 * project has no memories rather than inferring the block was cut.
 */
export function renderKernelMemoryBlock(
    rows: readonly ReadRow[],
    state: MemoryState,
    wrapper = PROJECT_MEMORY_WRAPPER,
): string {
    const marker = renderMemoryStateMarker(state, rows.length);
    if (rows.length === 0 && marker.length === 0) return "";
    const lines = [`<${wrapper}>`];
    if (marker.length > 0) lines.push(escapeXmlContent(marker));
    let openCategory: string | undefined;
    for (const row of [...rows].sort(renderOrder)) {
        const category = memoryRowCategory(row);
        if (category !== openCategory) {
            if (openCategory !== undefined) lines.push(`</${escapeXmlAttr(openCategory)}>`);
            openCategory = category;
            lines.push(`<${escapeXmlAttr(openCategory)}>`);
        }
        lines.push(renderKernelMemoryLine(row));
    }
    if (openCategory !== undefined) lines.push(`</${escapeXmlAttr(openCategory)}>`);
    lines.push(`</${wrapper}>`);
    return lines.join("\n");
}
