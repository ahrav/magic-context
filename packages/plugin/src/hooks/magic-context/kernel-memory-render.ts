/**
 * Renders a `KernelMemorySnapshot` into the m[0] `<project-memory>` block.
 * Row rendering and budget trimming live here, next to the injector that owns
 * the budget; the state marker line comes from the shared client so every
 * surface words a state the same way.
 */

import { escapeXmlAttr, escapeXmlContent } from "../../features/magic-context/compartment-storage";
import {
    ANTI_MEMORY_CATEGORY,
    V2_MEMORY_CATEGORIES,
} from "../../features/magic-context/memory/constants";
import {
    abstained,
    disabled,
    isAvailable,
    isMemoryDecisionRow,
    type KernelClient,
    type KernelClientResolver,
    type KernelMemorySnapshot,
    kernelMemorySnapshotFrom,
    type MemoryState,
    type ReadRow,
    renderMemoryStateMarker,
    sha256Hex,
    stateKey,
    unavailable,
} from "../../shared/kernel-client";
import { sessionLog } from "../../shared/logger";
import { estimateTokens } from "../../shared/token-estimator";

export const PROJECT_MEMORY_WRAPPER = "project-memory";

/** The daemon's automatic surfaces hide every `kernel.commit`-written row; `explicit_search` serves them as `labeled`. commentlint: allow(JUDGE) */
export const MEMORY_READ_SURFACE = "explicit_search";

/** The host waits at most this long for a memory read before the model call. */
export const INJECTION_READ_DEADLINE_MS = 3_000;

/** The snapshot an injector renders when no client can be reached at all. */
export function daemonAbsentSnapshot(): KernelMemorySnapshot {
    return { state: unavailable("daemon_absent"), rows: [], knownAsOf: null };
}

function disabledSnapshot(): KernelMemorySnapshot {
    return { state: disabled(), rows: [], knownAsOf: null };
}

export async function readInjectionMemorySnapshot(args: {
    kernelClient: KernelClientResolver | undefined;
    memoryEnabled: boolean;
    projectIdentity: string | undefined;
    sessionId: string;
    projectRoot: string;
}): Promise<KernelMemorySnapshot> {
    if (!args.memoryEnabled || !args.projectIdentity) return disabledSnapshot();
    if (!args.kernelClient) return daemonAbsentSnapshot();
    const client = args.kernelClient({ sessionId: args.sessionId, projectRoot: args.projectRoot });
    return withoutSensitiveRows(
        withholdLaggingMemory(
            kernelMemorySnapshotFrom(
                await client.read({
                    surface: MEMORY_READ_SURFACE,
                    gated: true,
                    deadlineMs: INJECTION_READ_DEADLINE_MS,
                }),
            ),
        ),
    );
}

/** The daemon hides `sensitive` rows on its automatic surfaces; `explicit_search` serves them, so automatic consumers re-impose that rule client-side. commentlint: allow(JUDGE) */
export function withoutSensitiveRows(snapshot: KernelMemorySnapshot): KernelMemorySnapshot {
    return {
        ...snapshot,
        rows: snapshot.rows.filter((row) => row.object.sensitivity !== "sensitive"),
    };
}

/** Automatic consumers treat a `stale` read as `abstained` and surface none of its rows. */
export function withholdLaggingMemory(snapshot: KernelMemorySnapshot): KernelMemorySnapshot {
    if (snapshot.state.kind !== "stale") return snapshot;
    const { lag_positions, oldest_unconsumed_age_ms } = snapshot.state;
    return {
        state: abstained({ lag_positions, oldest_unconsumed_age_ms }),
        rows: [],
        knownAsOf: null,
    };
}

/**
 * The historian deduplicates against the block the model saw; a non-`available`
 * read — including a gated read's `stale` answer — yields no baseline.
 */
export async function readHistorianMemoryBlock(args: {
    client: KernelClient | undefined;
    sessionId: string;
}): Promise<string> {
    if (!args.client) return "";
    const read = await args.client.read({
        surface: MEMORY_READ_SURFACE,
        gated: true,
        deadlineMs: INJECTION_READ_DEADLINE_MS,
    });
    if (!isAvailable(read)) {
        sessionLog(
            args.sessionId,
            `historian memory read answered ${stateKey(read.state)}; omitting memories`,
        );
        return "";
    }
    const snapshot = withoutSensitiveRows(kernelMemorySnapshotFrom(read));
    return renderKernelMemoryBlock(memoryRows(snapshot), read.state);
}

/** Excludes the store-wide `known_as_of`, which every commit to any project advances; a changed key rematerializes m[0] and the prompt prefix. commentlint: allow(JUDGE) */
export function memorySnapshotKey(snapshot: KernelMemorySnapshot): string {
    const rows = memoryRows(snapshot)
        .map(
            (row) =>
                `${row.object.object_id}\u001f${row.labeled ? 1 : 0}\u001f${memoryRowCategory(row)}\u001f${row.decision?.payload.summary ?? ""}`,
        )
        .sort();
    return `${stateKey(snapshot.state)}#${rows.length}@${sha256Hex(rows.join("\u001e")).slice(0, 16)}`;
}

/** Rows the automatic surfaces (m[0] injection, historian baseline) render. Anti-memories are excluded because rewriting can drop the negation and recreate a rejected strategy as guidance; they stay visible to search and the explicit ctx_memory actions, which read the snapshot rows directly. commentlint: allow(JUDGE) */
export function memoryRows(snapshot: KernelMemorySnapshot): ReadRow[] {
    return snapshot.rows.filter(
        (row) => isMemoryDecisionRow(row) && row.decision?.decision_kind !== ANTI_MEMORY_CATEGORY,
    );
}

/** The identity a rendered row is tracked by in cache manifests and search exclusion. */
export function memoryRowLocator(row: ReadRow): string {
    return row.object.object_id;
}

export function memoryRowCategory(row: ReadRow): string {
    return row.decision?.decision_kind ?? row.object.object_kind;
}

/** The taxonomy categories all match; the store also holds free-form kinds from other producers. commentlint: allow(JUDGE) */
const XML_ELEMENT_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;

/** A category that is a legal XML element name opens as itself; any other value rides as an escaped attribute on a fixed element so it cannot corrupt the block's markup. commentlint: allow(JUDGE) */
export function memoryCategoryOpenTag(category: string): string {
    return XML_ELEMENT_NAME.test(category)
        ? `<${category}>`
        : `<memory-category name="${escapeXmlAttr(category)}">`;
}

export function memoryCategoryCloseTag(category: string): string {
    return XML_ELEMENT_NAME.test(category) ? `</${category}>` : "</memory-category>";
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
            cost += estimateTokens(
                `${memoryCategoryOpenTag(category)}\n${memoryCategoryCloseTag(category)}\n`,
            );
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
 * `totalRowCount` records the row count before budget trimming so the marker
 * can report when trimming removes every row.
 */
export function renderKernelMemoryBlock(
    rows: readonly ReadRow[],
    state: MemoryState,
    totalRowCount: number = rows.length,
    wrapper = PROJECT_MEMORY_WRAPPER,
): string {
    const marker = renderMemoryStateMarker(state, rows.length, totalRowCount);
    if (rows.length === 0 && marker.length === 0) return "";
    const lines = [`<${wrapper}>`];
    if (marker.length > 0) lines.push(escapeXmlContent(marker));
    let openCategory: string | undefined;
    for (const row of [...rows].sort(renderOrder)) {
        const category = memoryRowCategory(row);
        if (category !== openCategory) {
            if (openCategory !== undefined) lines.push(memoryCategoryCloseTag(openCategory));
            openCategory = category;
            lines.push(memoryCategoryOpenTag(openCategory));
        }
        lines.push(renderKernelMemoryLine(row));
    }
    if (openCategory !== undefined) lines.push(memoryCategoryCloseTag(openCategory));
    lines.push(`</${wrapper}>`);
    return lines.join("\n");
}
