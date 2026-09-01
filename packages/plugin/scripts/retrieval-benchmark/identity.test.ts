import { describe, expect, it } from "bun:test";

import {
    AliasIndexError,
    RELEVANCE_PROJECTION_VERSION,
    buildAliasIndex,
    relevanceIdentity,
    resolveRankedLocators,
} from "./identity";
import { canonicalFingerprint } from "./canonical-json";
import type { CorpusDocument } from "./contract";
import { FIXTURE_PROJECT_SCOPE, makeDocument } from "./test-support";

const SCOPE = { projectScope: FIXTURE_PROJECT_SCOPE, sessionScope: null };

describe("relevanceIdentity", () => {
    it("derives the same identity for equivalent payloads with different key order", () => {
        const a = { kind: "memory", title: "t", body: "b" };
        const b = { body: "b", title: "t", kind: "memory" };
        expect(relevanceIdentity(a)).toBe(relevanceIdentity(b));
    });

    it("changes with payload content and binds the projection version", () => {
        const payload = { kind: "memory", title: "t", body: "b" };
        expect(relevanceIdentity(payload)).not.toBe(
            relevanceIdentity({ ...payload, body: "different" }),
        );
        expect(relevanceIdentity(payload)).toBe(
            `relevance:v1:${canonicalFingerprint({
                projection: RELEVANCE_PROJECTION_VERSION,
                payload,
            })}`,
        );
    });
});

describe("buildAliasIndex", () => {
    it("rejects one alias tuple mapping to multiple documents", () => {
        const a = makeDocument("a", "memory", "42", "body a");
        const b = makeDocument("b", "memory", "42", "body b");
        expect(() => buildAliasIndex([a, b])).toThrow(AliasIndexError);
    });

    it("allows the same physical locator under different scopes", () => {
        const a = makeDocument("a", "memory", "42", "body a");
        const b = makeDocument("b", "memory", "42", "body b");
        b.aliases[0] = { ...b.aliases[0], projectScope: "git:other-project" };
        const index = buildAliasIndex([a, b]);
        expect(index.byAlias.size).toBe(2);
    });

    it("rejects unknown alias namespaces", () => {
        const doc = makeDocument("a", "memory", "42", "body a");
        doc.aliases[0] = { ...doc.aliases[0], namespace: "mystery" };
        expect(() => buildAliasIndex([doc])).toThrow(AliasIndexError);
    });

    it("rejects prototype-named alias namespaces instead of matching Object.prototype", () => {
        for (const namespace of ["constructor", "toString", "hasOwnProperty"]) {
            const doc = makeDocument("a", "memory", "42", "body a");
            doc.aliases[0] = { ...doc.aliases[0], namespace };
            expect(() => buildAliasIndex([doc])).toThrow(AliasIndexError);
        }
        const index = buildAliasIndex([makeDocument("a", "memory", "42", "body a")]);
        expect(resolveRankedLocators(["constructor:42"], SCOPE, index)[0].status).toBe(
            "unresolved",
        );
    });

    it("credits one canonical identity once even across distinct documents", () => {
        const a = makeDocument("a", "memory", "1", "identical body");
        const b = makeDocument("b", "memory", "2", "identical body");
        b.semanticPayload = { ...a.semanticPayload };
        const index = buildAliasIndex([a, b]);
        const resolved = resolveRankedLocators(["memory:1", "memory:2"], SCOPE, index);
        expect(resolved[0].status).toBe("resolved");
        expect(resolved[1].status).toBe("duplicate");
    });
});

describe("resolveRankedLocators", () => {
    function chunkDocumentWithMigrationAliases(): CorpusDocument {
        const doc = makeDocument("chunk-a", "compartment", "42", "chunk body");
        doc.aliases.push(
            {
                namespace: "retrieval-document",
                locator: "rdoc-00042",
                projectScope: FIXTURE_PROJECT_SCOPE,
                sessionScope: null,
            },
            {
                namespace: "claim",
                locator: "claim-7",
                projectScope: FIXTURE_PROJECT_SCOPE,
                sessionScope: null,
            },
        );
        return doc;
    }

    it("resolves production, characterization, and post-migration spellings to one identity with single credit", () => {
        const index = buildAliasIndex([chunkDocumentWithMigrationAliases()]);
        const resolved = resolveRankedLocators(
            ["chunk:42", "compartment:42", "retrieval-document:rdoc-00042", "claim:claim-7"],
            SCOPE,
            index,
        );
        expect(resolved[0].status).toBe("resolved");
        expect(resolved.slice(1).map((r) => r.status)).toEqual([
            "duplicate",
            "duplicate",
            "duplicate",
        ]);
        // Ranks are one-based because reciprocal rank and nDCG consume them directly.
        expect(resolved.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
        const ids = new Set(
            resolved.map((r) => (r.status === "unresolved" ? "" : r.canonicalId)),
        );
        expect(ids.size).toBe(1);
    });

    it("requires the correct project scope", () => {
        const index = buildAliasIndex([makeDocument("a", "memory", "42", "body")]);
        const wrongScope = { projectScope: "git:elsewhere", sessionScope: null };
        expect(resolveRankedLocators(["memory:42"], wrongScope, index)[0].status).toBe(
            "unresolved",
        );
    });

    it("prefers a session-scoped alias and falls back to the project scope", () => {
        const sessionDoc = makeDocument("sess", "compartment", "9", "session body");
        sessionDoc.aliases[0] = { ...sessionDoc.aliases[0], sessionScope: "fixture-session-1" };
        const projectDoc = makeDocument("proj", "memory", "9", "project body");
        const index = buildAliasIndex([sessionDoc, projectDoc]);
        const scoped = resolveRankedLocators(
            ["chunk:9", "memory:9"],
            { projectScope: FIXTURE_PROJECT_SCOPE, sessionScope: "fixture-session-1" },
            index,
        );
        expect(scoped[0]).toMatchObject({ status: "resolved", documentId: "d-sess" });
        expect(scoped[1]).toMatchObject({ status: "resolved", documentId: "d-proj" });
        const unsessioned = resolveRankedLocators(["chunk:9"], SCOPE, index);
        expect(unsessioned[0].status).toBe("unresolved");
    });

    it("reports malformed and unknown locators without inventing matches", () => {
        const index = buildAliasIndex([makeDocument("a", "memory", "42", "body")]);
        const resolved = resolveRankedLocators(
            ["", "memory", "memory:", "mystery:42", "memory:404"],
            SCOPE,
            index,
        );
        expect(resolved.map((r) => r.status)).toEqual([
            "unresolved",
            "unresolved",
            "unresolved",
            "unresolved",
            "unresolved",
        ]);
        expect(resolved.map((r) => (r.status === "unresolved" ? r.reason : ""))).toEqual([
            "malformed",
            "malformed",
            "malformed",
            "malformed",
            "unknown-alias",
        ]);
    });
});
