/**
 * Ranks kernel memory rows for an explicit search. The daemon serves the
 * project's visible rows; matching them against the query is local because
 * the row set is already budget-sized and the match must not depend on a
 * second round trip.
 */

import { createHash } from "node:crypto";

import {
    type AntiMemoryPayload,
    antiMemoryExpired,
    parseAntiMemoryContent,
} from "../../features/magic-context/memory/anti-memory-content";
import { ANTI_MEMORY_CATEGORY } from "../../features/magic-context/memory/constants";
import type {
    AntiMemorySearchResult,
    MemorySearchResult,
} from "../../features/magic-context/search";
import {
    isAvailable,
    isMemoryDecisionRow,
    type KernelClient,
    type MemoryState,
    type ReadRow,
    type Surface,
} from "../../shared/kernel-client";

export type KernelMemorySearchResult = MemorySearchResult | AntiMemorySearchResult;

/** How a result matched: `exact` for an object-id lookup, `lexical` for term-overlap ranking. */
export type KernelMemoryMatchType = "exact" | "lexical";

export type ChunkedObjectRead =
    | { ok: true; rows: ReadRow[]; knownAsOf: number; unresolvedObjectIds: string[] }
    | { ok: false; state: MemoryState };

/**
 * Reads the named objects through the daemon's id filter, halving any chunk
 * whose reply is truncated: the filter bypasses the daemon's row cap but not
 * its serialization byte budget, and the budget keeps a newest-first prefix,
 * so a truncated filtered read has silently dropped the oldest named rows.
 * The daemon's budget holds at least eight worst-case rows (each decision
 * text field is redaction-capped well under an eighth of the budget), so
 * halving reaches complete chunks before the single-id floor; a single id
 * whose read still reports truncated without serving its row lands in
 * `unresolvedObjectIds` instead of passing as proven-missing. commentlint: allow(JUDGE)
 */
export async function readObjectRowsChunked(args: {
    client: KernelClient;
    surface: Surface;
    gated: boolean;
    /** At most `MAX_READ_OBJECT_IDS` ids; the client rejects longer filters. */
    objectIds: readonly string[];
    signal?: AbortSignal;
}): Promise<ChunkedObjectRead> {
    const rows: ReadRow[] = [];
    const unresolvedObjectIds: string[] = [];
    let knownAsOf = 0;
    const pending: (readonly string[])[] = [args.objectIds];
    while (pending.length > 0) {
        const chunk = pending.pop() as readonly string[];
        const read = await args.client.read({
            surface: args.surface,
            gated: args.gated,
            objectIds: chunk,
            ...(args.signal ? { signal: args.signal } : {}),
        });
        if (!isAvailable(read)) return { ok: false, state: read.state };
        knownAsOf = Math.max(knownAsOf, read.known_as_of);
        if (read.truncated && chunk.length > 1) {
            const mid = Math.ceil(chunk.length / 2);
            pending.push(chunk.slice(0, mid), chunk.slice(mid));
            continue;
        }
        rows.push(...read.rows);
        if (
            read.truncated &&
            chunk.length === 1 &&
            !read.rows.some((row) => row.object.object_id === chunk[0])
        ) {
            unresolvedObjectIds.push(chunk[0] as string);
        }
    }
    return { ok: true, rows, knownAsOf, unresolvedObjectIds };
}

const OBJECT_ID = /^mem_[0-9a-f]{32}$/;
/** The `revisionLocator` shape search results emit: `<object id>@<created commit seq>`. */
const REVISION_LOCATOR = /^(mem_[0-9a-f]{32})@\d+$/;

/** The bare object id of an id or revision-locator token; `null` for ordinary text. */
function objectIdFromToken(token: string): string | null {
    if (OBJECT_ID.test(token)) return token;
    return REVISION_LOCATOR.exec(token)?.[1] ?? null;
}

/** Object ids when the whole query is a list of ids or revision locators; `null` for ordinary text. A pasted locator resolves its object's current row: the commit-seq suffix names the revision the result was read from, and the store serves one live row per id. commentlint: allow(JUDGE) */
export function parseObjectIdQuery(query: string): string[] | null {
    const tokens = query
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean);
    if (tokens.length === 0) return null;
    const ids: string[] = [];
    for (const token of tokens) {
        const id = objectIdFromToken(token);
        if (id === null) return null;
        ids.push(id);
    }
    return [...new Set(ids)];
}

function queryTerms(query: string): string[] {
    return [
        ...new Set(
            query
                .toLowerCase()
                .split(/[^\p{L}\p{N}_]+/u)
                .filter((term) => term.length >= 2),
        ),
    ];
}

function rowText(row: ReadRow): string {
    const decision = row.decision;
    return decision ? `${decision.payload.summary}\n${decision.payload.rationale}` : "";
}

/** `null` when the summary is not the field-labeled anti-memory text form. */
function antiMemoryPayloadFromSummary(summary: string): AntiMemoryPayload | null {
    try {
        return parseAntiMemoryContent(summary);
    } catch {
        return null;
    }
}

/** A rejected-approach row emits `anti_memory`, not `memory`: an unparseable stored summary becomes a conservative warning carrying the raw summary as the rejected strategy, so a legacy or malformed anti-memory cannot resurface as ordinary guidance. commentlint: allow(JUDGE) */
export function memoryResultFromRow(
    row: ReadRow,
    score: number,
    matchType: KernelMemoryMatchType,
): KernelMemorySearchResult {
    const decision = row.decision;
    const revisionLocator = `${row.object.object_id}@${row.object.created_commit_seq}`;
    if (decision?.decision_kind === ANTI_MEMORY_CATEGORY) {
        const payload = antiMemoryPayloadFromSummary(decision.payload.summary);
        // Kernel rows carry no claim-lane row: the digest of the served
        // summary stands in for both content hashes, and the sentinel claim
        // id marks the absence of a local rowid.
        const digest = createHash("sha256").update(decision.payload.summary, "utf8").digest("hex");
        return {
            source: "anti_memory",
            score,
            publicClaimId: row.object.object_id,
            revisionLocator,
            contentDigest: digest,
            claimId: -1,
            normalizedHash: digest,
            trigger: payload?.trigger ?? "",
            rejectedStrategy: payload?.rejectedStrategy ?? decision.payload.summary,
            rejectionReason:
                payload?.rejectionReason ??
                "stored anti-memory payload is unparseable; the approach stays rejected",
            saferAlternative: payload?.saferAlternative ?? null,
            // `rowText` ranks the rationale, so the warning carries it too; a hit matched only in the rationale would otherwise display none of the matched terms and read as unrelated. commentlint: allow(JUDGE)
            ...(decision.payload.rationale ? { rationale: decision.payload.rationale } : {}),
            matchType,
            ...(row.labeled ? { policyLabel: "labeled" } : {}),
        };
    }
    return {
        source: "memory",
        // `rowText` ranks the rationale, so the rationale renders too; a hit matched only in the rationale would otherwise display none of the matched terms and read as unrelated. commentlint: allow(JUDGE)
        content: decision?.payload.rationale
            ? `${decision.payload.summary}\n${decision.payload.rationale}`
            : (decision?.payload.summary ?? ""),
        score,
        publicClaimId: row.object.object_id,
        revisionLocator,
        category: decision?.decision_kind ?? row.object.object_kind,
        matchType,
        ...(row.labeled ? { policyLabel: "labeled" } : {}),
    };
}

export interface KernelMemorySearchArgs {
    rows: readonly ReadRow[];
    query: string;
    limit: number;
    /** Objects already rendered in the injected baseline; a hit on one spends budget on visible text. */
    excludeObjectIds?: ReadonlySet<string> | null;
    /** Expiry filtering compares timestamps against `nowMs`; defaults to the wall clock. */
    nowMs?: number;
}

/** An anti-memory past its rendered expiry never surfaces as a search hit; an unparseable summary never counts as expired. commentlint: allow(JUDGE) */
function isExpiredAntiMemoryRow(row: ReadRow, nowMs: number): boolean {
    const decision = row.decision;
    if (decision?.decision_kind !== ANTI_MEMORY_CATEGORY) return false;
    const payload = antiMemoryPayloadFromSummary(decision.payload.summary);
    return payload !== null && antiMemoryExpired(payload, nowMs);
}

/** An object-id query resolves exactly (in id order); text ranks rows by the share of query terms their summary and rationale contain, ties broken by newest first. `excludeObjectIds` applies only to lexical searches; object-id queries ignore `excludeObjectIds` because an explicit id names one object and resolves even when the injected baseline already renders it. Either path returns `null` when nothing matches so the caller can fall through to the other sources. commentlint: allow(JUDGE) */
export function searchKernelMemoryRows(
    args: KernelMemorySearchArgs,
): KernelMemorySearchResult[] | null {
    const nowMs = args.nowMs ?? Date.now();
    const decisionRows = args.rows.filter(
        (row) => isMemoryDecisionRow(row) && !isExpiredAntiMemoryRow(row, nowMs),
    );
    const ids = parseObjectIdQuery(args.query);
    if (ids) {
        const byId = new Map(decisionRows.map((row) => [row.object.object_id, row]));
        const hits = ids
            .map((id) => byId.get(id))
            .filter((row): row is ReadRow => row !== undefined)
            .slice(0, args.limit)
            .map((row) => memoryResultFromRow(row, 1, "exact"));
        return hits.length > 0 ? hits : null;
    }
    const candidates = decisionRows.filter(
        (row) => !args.excludeObjectIds?.has(row.object.object_id),
    );
    const terms = queryTerms(args.query);
    if (terms.length === 0) return null;
    const scored = candidates
        .map((row) => {
            const text = rowText(row).toLowerCase();
            const matched = terms.filter((term) => text.includes(term)).length;
            return { row, score: matched / terms.length };
        })
        .filter((entry) => entry.score > 0)
        .sort(
            (left, right) =>
                right.score - left.score ||
                right.row.object.created_commit_seq - left.row.object.created_commit_seq ||
                left.row.object.object_id.localeCompare(right.row.object.object_id),
        )
        .slice(0, args.limit)
        .map((entry) => memoryResultFromRow(entry.row, entry.score, "lexical"));
    return scored.length > 0 ? scored : null;
}
