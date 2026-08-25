/**
 * Append-only incident lifecycle: whole-ledger atomic replay and
 * repository-baseline comparison (U1, R3, KTD1).
 *
 * Replay fails closed on ANY invalid event — it never skips an event to fold
 * a later baseline. Comparison rejects edits/deletions of accepted rows and
 * ledger-prefix rewrites; the sole destructive exception is a digest-bound
 * emergency-redaction event naming the protected base.
 */

import { createHash } from "node:crypto";
import {
    parseAdjudicationEvent,
    parseEmergencyRedaction,
    parseIncidentCatalog,
    parseSourceInventory,
    EXECUTABLE_LANES,
    type AdjudicationEvent,
    type EmergencyRedactionEvent,
    type IncidentCatalog,
    type IncidentFamily,
    type IncidentVariant,
    type RedactionScope,
    type SourceInventory,
    type SourceItem,
} from "./contract";

/** Deterministic serialization (sorted object keys) for row digests. */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(
            ([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`,
        );
    return `{${entries.join(",")}}`;
}

export function rowDigest(value: unknown): string {
    return createHash("sha256")
        .update(canonicalJson(value), "utf8")
        .digest("hex");
}

/** Split JSONL text into lines; a single trailing newline is tolerated. */
export function splitLedgerLines(text: string): string[] {
    const body = text.endsWith("\n") ? text.slice(0, -1) : text;
    return body === "" ? [] : body.split("\n");
}

function parseLedgerLine<T>(
    line: string,
    label: string,
    parse: (raw: unknown, label: string) => T,
): T {
    let raw: unknown;
    try {
        raw = JSON.parse(line) as unknown;
    } catch (error) {
        throw new Error(`${label} is not valid JSON: ${String(error)}`);
    }
    return parse(raw, label);
}

export interface IdentityHistory {
    events: AdjudicationEvent[];
    latestBaseline: AdjudicationEvent | null;
    retired: boolean;
}

export interface LedgerState {
    events: AdjudicationEvent[];
    byIdentity: Map<string, IdentityHistory>;
    byEventId: Map<string, AdjudicationEvent>;
}

/**
 * Atomic whole-ledger replay. Every rule failure throws immediately:
 * duplicate event IDs, per-identity sequence gaps, forward/cross-identity/
 * double supersession, baseline rebinding (a new baseline must supersede the
 * current unsuperseded baseline), and events after retirement.
 */
export function replayAdjudicationLedger(
    events: AdjudicationEvent[],
): LedgerState {
    const byEventId = new Map<string, AdjudicationEvent>();
    const byIdentity = new Map<string, IdentityHistory>();
    const superseded = new Set<string>();
    for (const [index, event] of events.entries()) {
        const label = `adjudications[${index}] (${event.event_id})`;
        if (byEventId.has(event.event_id))
            throw new Error(`${label}: duplicate event id`);
        let history = byIdentity.get(event.identity);
        if (!history) {
            history = { events: [], latestBaseline: null, retired: false };
            byIdentity.set(event.identity, history);
        }
        if (history.retired)
            throw new Error(`${label}: identity ${event.identity} is retired`);
        const expectedSeq = history.events.length + 1;
        if (event.seq !== expectedSeq) {
            throw new Error(
                `${label}: sequence gap for ${event.identity}; expected seq ${expectedSeq}, got ${event.seq}`,
            );
        }
        if (event.supersedes !== null) {
            const target = byEventId.get(event.supersedes);
            if (!target)
                throw new Error(
                    `${label}: supersedes unknown or later event ${event.supersedes}`,
                );
            if (target.identity !== event.identity) {
                throw new Error(
                    `${label}: cross-identity supersession of ${event.supersedes}`,
                );
            }
            if (superseded.has(target.event_id)) {
                throw new Error(
                    `${label}: event ${event.supersedes} is already superseded`,
                );
            }
            if (target.kind === "baseline" && event.kind !== "baseline") {
                throw new Error(
                    `${label}: only a baseline event may supersede baseline ${event.supersedes}`,
                );
            }
        }
        if (event.kind === "baseline") {
            const required = history.latestBaseline?.event_id ?? null;
            if (event.supersedes !== required) {
                throw new Error(
                    `${label}: baseline must supersede ${required ?? "nothing (first baseline)"}, got ${event.supersedes ?? "null"}`,
                );
            }
            history.latestBaseline = event;
        }
        if (event.supersedes !== null) superseded.add(event.supersedes);
        if (event.kind === "retirement") history.retired = true;
        history.events.push(event);
        byEventId.set(event.event_id, event);
    }
    return { events, byIdentity, byEventId };
}

export interface IncidentHistoryInput {
    inventoryText: string;
    catalogText: string;
    adjudicationLines: string[];
    redactionLines: string[];
}

export interface HistorySnapshot extends IncidentHistoryInput {
    /** Label the protected repository baseline; emergency redactions must
     *  name this base to authorize a byte change against it. */
    baseLabel: string;
}

export interface IncidentHistoryState {
    inventory: SourceInventory;
    catalog: IncidentCatalog;
    events: AdjudicationEvent[];
    ledger: LedgerState;
    redactions: EmergencyRedactionEvent[];
}

function parseRedactionLines(lines: string[]): EmergencyRedactionEvent[] {
    const ids = new Set<string>();
    return lines.map((line, index) => {
        const label = `emergency-redactions[${index}]`;
        const event = parseLedgerLine(line, label, parseEmergencyRedaction);
        if (ids.has(event.event_id))
            throw new Error(
                `${label}: duplicate redaction event id ${event.event_id}`,
            );
        ids.add(event.event_id);
        return event;
    });
}

function parseJsonArtifact<T>(
    text: string,
    label: string,
    parse: (raw: unknown) => T,
): T {
    let raw: unknown;
    try {
        raw = JSON.parse(text) as unknown;
    } catch (error) {
        throw new Error(`${label} is not valid JSON: ${String(error)}`);
    }
    return parse(raw);
}

/**
 * Parse and cross-check one full incident history: strict artifacts, atomic
 * ledger replay, and structural cross-checks (orphans, verifier bindings,
 * lane/baseline correspondence, fingerprint binding).
 */
export function validateIncidentHistory(
    input: IncidentHistoryInput,
): IncidentHistoryState {
    const inventory = parseJsonArtifact(
        input.inventoryText,
        "source-inventory.json",
        parseSourceInventory,
    );
    const catalog = parseJsonArtifact(
        input.catalogText,
        "catalog.json",
        parseIncidentCatalog,
    );
    const events = input.adjudicationLines.map((line, index) =>
        parseLedgerLine(
            line,
            `adjudications[${index}]`,
            parseAdjudicationEvent,
        ),
    );
    const ledger = replayAdjudicationLedger(events);
    const redactions = parseRedactionLines(input.redactionLines);

    const claimIds = new Set<string>();
    for (const item of inventory.items)
        for (const claim of item.claims) claimIds.add(claim.id);
    const familyIds = new Set(catalog.families.map((family) => family.id));
    const variantById = new Map<string, IncidentVariant>();
    for (const family of catalog.families) {
        for (const variant of family.variants)
            variantById.set(variant.id, variant);
    }
    const knownIdentities = new Set<string>([
        ...inventory.items.map((item) => item.id),
        ...claimIds,
        ...familyIds,
        ...variantById.keys(),
    ]);

    for (const item of inventory.items) {
        for (const claim of item.claims) {
            for (const familyId of claim.family_links) {
                if (!familyIds.has(familyId)) {
                    throw new Error(
                        `source claim ${claim.id} links unknown family ${familyId}`,
                    );
                }
            }
        }
    }
    for (const family of catalog.families) {
        for (const claimId of family.source_claims) {
            if (!claimIds.has(claimId)) {
                throw new Error(
                    `family ${family.id} references unknown source claim ${claimId}`,
                );
            }
        }
        for (const variant of family.variants) {
            // A variant inherits its incident from the enclosing family, so a
            // claim linked only to a DIFFERENT family would silently move the
            // variant's provenance out from under the family that owns it.
            for (const claimId of variant.source_claims) {
                if (!claimIds.has(claimId)) {
                    throw new Error(
                        `orphan variant ${variant.id}: unknown source claim ${claimId}`,
                    );
                }
                if (!family.source_claims.includes(claimId)) {
                    throw new Error(
                        `variant ${variant.id} claims ${claimId}, which is not linked to its family ${family.id}`,
                    );
                }
            }
        }
    }

    for (const event of events) {
        if (!knownIdentities.has(event.identity)) {
            throw new Error(
                `adjudication ${event.event_id} targets unknown identity ${event.identity}`,
            );
        }
        if (event.kind === "baseline" && !variantById.has(event.identity)) {
            throw new Error(
                `adjudication ${event.event_id} binds a baseline to non-variant identity ${event.identity}`,
            );
        }
    }

    for (const variant of variantById.values()) {
        const history = ledger.byIdentity.get(variant.id);
        if (EXECUTABLE_LANES.includes(variant.lane)) {
            const baseline = history?.latestBaseline ?? null;
            if (baseline === null) {
                throw new Error(
                    `executable variant ${variant.id} has no baseline adjudication`,
                );
            }
            const expectedVerdict = variant.lane === "green" ? "green" : "red";
            if (baseline.baseline_verdict !== expectedVerdict) {
                throw new Error(
                    `variant ${variant.id} lane ${variant.lane} disagrees with latest baseline verdict ${baseline.baseline_verdict}`,
                );
            }
            if (
                baseline.semantic_fingerprint !==
                variant.semantic_revision.fingerprint
            ) {
                throw new Error(
                    `variant ${variant.id} semantic revision ${variant.semantic_revision.id} is not bound by a fingerprint-matching baseline adjudication`,
                );
            }
            if (baseline.baseline_verdict === "red") {
                const declared = new Set(variant.normative_checks);
                for (const checkId of baseline.expected_failed_checks ?? []) {
                    if (!declared.has(checkId)) {
                        throw new Error(
                            `variant ${variant.id} red baseline expects unknown check ${checkId}`,
                        );
                    }
                }
            }
        } else if (history?.latestBaseline) {
            throw new Error(
                `adjudication-only variant ${variant.id} must not have a baseline adjudication`,
            );
        }
    }

    return { inventory, catalog, events, ledger, redactions };
}

/** Scalar row of a source item (claims are compared individually). */
function itemRow(item: SourceItem): Record<string, unknown> {
    return {
        id: item.id,
        source_path: item.source_path,
        content_digest: item.content_digest,
    };
}

/** Scalar row of a family (variants are compared individually). */
function familyRow(family: IncidentFamily): Record<string, unknown> {
    return {
        id: family.id,
        title: family.title,
        source_claims: family.source_claims,
    };
}

interface ComparisonContext {
    authorizes: (
        scope: RedactionScope,
        targetId: string,
        oldRow: unknown,
        newRow: unknown,
    ) => boolean;
    appendedIdentities: Set<string>;
    appendedBaselineIdentities: Set<string>;
}

function requireOrderedRow<T extends { id: string }>(
    acceptedRows: T[],
    candidateRows: T[],
    kind: string,
    visit: (accepted: T, candidate: T) => void,
): void {
    for (const [index, accepted] of acceptedRows.entries()) {
        const candidate = candidateRows[index];
        if (!candidate || candidate.id !== accepted.id) {
            if (candidateRows.some((row) => row.id === accepted.id)) {
                throw new Error(
                    `accepted ${kind} reordered or preceded by an insertion: ${accepted.id}`,
                );
            }
            throw new Error(`accepted ${kind} deleted: ${accepted.id}`);
        }
        visit(accepted, candidate);
    }
}

function requireRowIntegrity(
    context: ComparisonContext,
    scope: RedactionScope,
    id: string,
    acceptedRow: unknown,
    candidateRow: unknown,
    appendedAuthority: Set<string>,
    kind: string,
): void {
    if (canonicalJson(acceptedRow) === canonicalJson(candidateRow)) return;
    if (appendedAuthority.has(id)) return;
    if (context.authorizes(scope, id, acceptedRow, candidateRow)) return;
    throw new Error(
        `accepted ${kind} edited without an appended adjudication or emergency redaction: ${id}`,
    );
}

/**
 * Compare a candidate history against the accepted repository-baseline
 * snapshot (U1 approach step 4). Accepted rows and the ledger prefix are
 * immutable; ordinary changes must append events, and only a digest-bound
 * emergency-redaction event naming the accepted base authorizes a byte
 * rewrite. Identities absent from the accepted snapshot remain editable.
 */
export function compareWithAcceptedSnapshot(
    accepted: HistorySnapshot,
    candidate: HistorySnapshot,
): { accepted: IncidentHistoryState; candidate: IncidentHistoryState } {
    const acceptedState = validateIncidentHistory(accepted);
    const candidateState = validateIncidentHistory(candidate);

    // The emergency-redaction ledger itself is strictly append-only.
    if (candidate.redactionLines.length < accepted.redactionLines.length) {
        throw new Error("emergency-redaction ledger shortened");
    }
    for (const [index, line] of accepted.redactionLines.entries()) {
        if (candidate.redactionLines[index] !== line) {
            throw new Error(
                `emergency-redaction ledger prefix changed at line ${index + 1}`,
            );
        }
    }

    const authorized = candidateState.redactions.filter(
        (event) => event.protected_base === accepted.baseLabel,
    );
    const context: ComparisonContext = {
        authorizes: (scope, targetId, oldRow, newRow) => {
            const oldDigest = rowDigest(oldRow);
            const newDigest = rowDigest(newRow);
            return authorized.some(
                (event) =>
                    event.scope === scope &&
                    event.target_id === targetId &&
                    event.old_digest === oldDigest &&
                    event.new_digest === newDigest,
            );
        },
        appendedIdentities: new Set<string>(),
        appendedBaselineIdentities: new Set<string>(),
    };

    // Adjudication ledger: byte-exact prefix, except a digest-bound redaction
    // that preserves the event's logical identity and position.
    if (
        candidate.adjudicationLines.length < accepted.adjudicationLines.length
    ) {
        throw new Error("adjudication ledger prefix shortened");
    }
    for (const [index, line] of accepted.adjudicationLines.entries()) {
        if (candidate.adjudicationLines[index] === line) continue;
        const before = acceptedState.events[index]!;
        const after = candidateState.events[index]!;
        if (
            after.event_id !== before.event_id ||
            after.identity !== before.identity ||
            after.seq !== before.seq ||
            after.kind !== before.kind
        ) {
            throw new Error(
                `adjudication ledger prefix rewrote logical identity at line ${index + 1}`,
            );
        }
        const {
            rationale: beforeRationale,
            source_revision: beforeRevision,
            ...beforePinned
        } = before;
        const {
            rationale: afterRationale,
            source_revision: afterRevision,
            ...afterPinned
        } = after;
        void beforeRationale;
        void beforeRevision;
        void afterRationale;
        void afterRevision;
        if (canonicalJson(beforePinned) !== canonicalJson(afterPinned)) {
            throw new Error(
                `adjudication emergency redaction at line ${index + 1} may change only rationale and source_revision`,
            );
        }
        if (
            !context.authorizes(
                "adjudication_event",
                before.event_id,
                before,
                after,
            )
        ) {
            throw new Error(
                `adjudication ledger prefix changed at line ${index + 1} without a matching emergency redaction`,
            );
        }
    }
    for (const event of candidateState.events.slice(
        accepted.adjudicationLines.length,
    )) {
        context.appendedIdentities.add(event.identity);
        if (event.kind === "baseline")
            context.appendedBaselineIdentities.add(event.identity);
    }

    requireOrderedRow(
        acceptedState.inventory.items,
        candidateState.inventory.items,
        "source item",
        (before, after) => {
            requireRowIntegrity(
                context,
                "source_item",
                before.id,
                itemRow(before),
                itemRow(after),
                context.appendedIdentities,
                "source item",
            );
            requireOrderedRow(
                before.claims,
                after.claims,
                `source claim of ${before.id}`,
                (claimBefore, claimAfter) => {
                    requireRowIntegrity(
                        context,
                        "source_claim",
                        claimBefore.id,
                        claimBefore,
                        claimAfter,
                        context.appendedIdentities,
                        "source claim",
                    );
                },
            );
        },
    );

    requireOrderedRow(
        acceptedState.catalog.families,
        candidateState.catalog.families,
        "family",
        (before, after) => {
            requireRowIntegrity(
                context,
                "family",
                before.id,
                familyRow(before),
                familyRow(after),
                context.appendedIdentities,
                "family",
            );
            // A variant's semantic content may change only through a NEW
            // fingerprint-bound baseline adjudication (KTD9) or a redaction.
            requireOrderedRow(
                before.variants,
                after.variants,
                `variant of ${before.id}`,
                (variantBefore, variantAfter) => {
                    requireRowIntegrity(
                        context,
                        "variant",
                        variantBefore.id,
                        variantBefore,
                        variantAfter,
                        context.appendedBaselineIdentities,
                        "variant",
                    );
                },
            );
        },
    );

    return { accepted: acceptedState, candidate: candidateState };
}
