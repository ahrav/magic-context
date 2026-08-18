/**
 * Content-addressed canonical relevance identities and scoped alias
 * resolution (KTD3, R41).
 *
 * Relevance truth follows the immutable semantic payload, not the storage
 * row: `relevance:v1:<sha256(projection)>`. Physical locators — current
 * production strings, characterization-test spellings, and future
 * claim/revision/retrieval-document locators — are aliases that resolve onto
 * one canonical identity, and only the first ranked occurrence of an
 * identity earns metric credit.
 */

import {
    PHYSICAL_LOCATOR_KINDS,
    parsePhysicalResultLocator,
} from "../../src/features/magic-context/search-result-locator";
import { canonicalFingerprint } from "./canonical-json";
import type { CorpusDocument } from "./contract";

export const RELEVANCE_PROJECTION_VERSION = "relevance-payload/v1";

/** Derive the canonical relevance identity for a semantic payload. */
export function relevanceIdentity(semanticPayload: unknown): string {
    return `relevance:v1:${canonicalFingerprint({
        projection: RELEVANCE_PROJECTION_VERSION,
        payload: semanticPayload,
    })}`;
}

/** Benchmark-only namespace spellings (characterization tests, simulated
 *  post-migration locators). Production spellings are NOT listed here — they
 *  come straight from `PHYSICAL_LOCATOR_KINDS`, so a production prefix change
 *  propagates into the dialect table instead of silently diverging. */
const BENCHMARK_DIALECTS: Record<string, string> = {
    compartment: "chunk",
    git_commit: "commit",
    claim: "claim",
    revision: "revision",
    "retrieval-document": "retrieval-document",
};

/** Locator-namespace spellings that name the same physical store. Keys are
 *  accepted dialects (production, characterization tests, future migration);
 *  values canonicalize dialect-specific namespace spellings.
 *  `dialectNamespace` uses `Object.hasOwn` to reject prototype-named inputs
 *  (`constructor`, `toString`). */
const NAMESPACE_DIALECTS: Record<string, string> = {
    ...Object.fromEntries(PHYSICAL_LOCATOR_KINDS.map((kind) => [kind, kind])),
    ...BENCHMARK_DIALECTS,
};

function dialectNamespace(raw: string): string | null {
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
    /** aliasKey -> document. */
    byAlias: Map<string, { documentId: string; canonicalId: string }>;
    /** documentId -> canonical relevance identity. */
    canonicalByDocument: Map<string, string>;
}

export class AliasIndexError extends Error {}

/**
 * Build the scoped alias index for a corpus. Each (namespace, locator,
 * project scope, session scope) tuple must map to exactly one document.
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
 * Resolve a ranked physical result list against the alias index under one
 * scenario scope. Session-scoped aliases are tried first, then the
 * project-only scope, so a chunk alias bound to its session does not leak
 * across sessions. Later occurrences of an already-credited canonical
 * identity come back as `duplicate` (AE5: aliases earn credit once).
 */
export function resolveRankedLocators(
    ranked: readonly string[],
    scope: ScenarioScope,
    index: AliasIndex,
): ResolvedRankedResult[] {
    const seen = new Set<string>();
    return ranked.map((raw, rank) => {
        // Production spellings go through the frozen production parser;
        // benchmark-only dialect spellings fall back to the dialect table.
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
