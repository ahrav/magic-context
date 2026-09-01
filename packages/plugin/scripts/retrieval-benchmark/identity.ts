/**
 * Aliases resolve to canonical relevance identities within project and session scopes.
 *
 * The canonical identity depends on `semanticPayload`, not document storage fields.
 * Only the highest-ranked occurrence of each canonical identity earns metric credit.
 */

import {
    PHYSICAL_LOCATOR_KINDS,
    parsePhysicalResultLocator,
} from "./physical-locator";
import { canonicalFingerprint } from "./canonical-json";
import type { CorpusDocument } from "./contract";

export const RELEVANCE_PROJECTION_VERSION = "relevance-payload/v1";

/* */
export function relevanceIdentity(semanticPayload: unknown): string {
    return `relevance:v1:${canonicalFingerprint({
        projection: RELEVANCE_PROJECTION_VERSION,
        payload: semanticPayload,
    })}`;
}

/**
 * Changes to `PHYSICAL_LOCATOR_KINDS` also update `NAMESPACE_DIALECTS`. */
const BENCHMARK_DIALECTS: Record<string, string> = {
    compartment: "chunk",
    git_commit: "commit",
    claim: "claim",
    revision: "revision",
    "retrieval-document": "retrieval-document",
};

/** `NAMESPACE_DIALECTS` treats each key and its value as names for the same physical store.
 *  `dialectNamespace` uses `Object.hasOwn` to reject prototype-named inputs
 *  (`constructor`, `toString`). */
const NAMESPACE_DIALECTS: Record<string, string> = {
    ...Object.fromEntries(PHYSICAL_LOCATOR_KINDS.map((kind) => [kind, kind])),
    ...BENCHMARK_DIALECTS,
};

/**
 * */
export function dialectNamespace(raw: string): string | null {
    return Object.hasOwn(NAMESPACE_DIALECTS, raw) ? NAMESPACE_DIALECTS[raw] : null;
}

export interface ScenarioScope {
    projectScope: string;
    sessionScope: string | null;
}

function aliasKey(namespace: string, locator: string, scope: ScenarioScope): string {
    return JSON.stringify([namespace, locator, scope.projectScope, scope.sessionScope]);
}

export interface AliasIndex {
    /* */
    byAlias: Map<string, { documentId: string; canonicalId: string }>;
    /* */
    canonicalByDocument: Map<string, string>;
}

export class AliasIndexError extends Error {}

/**
 * Each `(namespace, locator, projectScope, sessionScope)` tuple must map to exactly one document.
 */
export function buildAliasIndex(documents: readonly CorpusDocument[]): AliasIndex {
    const byAlias = new Map<string, { documentId: string; canonicalId: string }>();
    const canonicalByDocument = new Map<string, string>();
    for (const document of documents) {
        const canonicalId = relevanceIdentity(document.semanticPayload);
        canonicalByDocument.set(document.id, canonicalId);
        for (const alias of document.aliases) {
            const namespace = dialectNamespace(alias.namespace);
            if (!namespace) {
                throw new AliasIndexError(`unknown alias namespace on ${document.id}`);
            }
            const key = aliasKey(namespace, alias.locator, {
                projectScope: alias.projectScope,
                sessionScope: alias.sessionScope,
            });
            const existing = byAlias.get(key);
            if (existing && existing.documentId !== document.id) {
                throw new AliasIndexError(
                    `alias maps to multiple documents (${existing.documentId}, ${document.id})`,
                );
            }
            byAlias.set(key, { documentId: document.id, canonicalId });
        }
    }
    return { byAlias, canonicalByDocument };
}

export type ResolvedRankedResult =
    | { status: "resolved"; rank: number; canonicalId: string; documentId: string }
    | { status: "duplicate"; rank: number; canonicalId: string; documentId: string }
    | { status: "unresolved"; rank: number; reason: "malformed" | "unknown-alias" };

/**
 * The resolver applies aliases only within the supplied `ScenarioScope`.
 * Later occurrences of a credited canonical identity return `duplicate`.
 * IR metrics consume one-based `rank` values directly, so they need no off-by-one adjustment.
 */
export function resolveRankedLocators(
    ranked: readonly string[],
    scope: ScenarioScope,
    index: AliasIndex,
): ResolvedRankedResult[] {
    const seen = new Set<string>();
    return ranked.map((raw, position) => {
        const rank = position + 1;
        const parsed = parsePhysicalResultLocator(raw);
        let namespace: string;
        let locator: string;
        if (parsed.ok) {
            namespace = parsed.value.kind;
            locator = parsed.value.locator;
        } else if (parsed.reason === "unknown-kind") {
            const separator = raw.indexOf(":");
            if (separator === raw.length - 1) {
                return { status: "unresolved", rank, reason: "malformed" };
            }
            const dialect = dialectNamespace(raw.slice(0, separator));
            if (!dialect) return { status: "unresolved", rank, reason: "malformed" };
            namespace = dialect;
            locator = raw.slice(separator + 1);
        } else {
            return { status: "unresolved", rank, reason: "malformed" };
        }
        const scoped =
            scope.sessionScope !== null
                ? index.byAlias.get(aliasKey(namespace, locator, scope))
                : undefined;
        const target =
            scoped ??
            index.byAlias.get(
                aliasKey(namespace, locator, {
                    projectScope: scope.projectScope,
                    sessionScope: null,
                }),
            );
        if (!target) return { status: "unresolved", rank, reason: "unknown-alias" };
        if (seen.has(target.canonicalId)) {
            return { status: "duplicate", rank, ...target };
        }
        seen.add(target.canonicalId);
        return { status: "resolved", rank, ...target };
    });
}
