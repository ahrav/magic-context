import { describe, expect, it } from "bun:test";
import {
    parseAdjudicationEvent,
    parseEmergencyRedaction,
    parseIncidentCatalog,
    parseSourceInventory,
    ADJUDICATION_EVENT_SCHEMA,
    EMERGENCY_REDACTION_SCHEMA,
    INCIDENT_CATALOG_SCHEMA,
    SOURCE_INVENTORY_SCHEMA,
    type AdjudicationEvent,
    type EmergencyRedactionEvent,
    type IncidentVariant,
    type SourceClaim,
} from "./contract";

const HEX = (fill: string): string => fill.repeat(64);

function claim(id: string, overrides: Partial<SourceClaim> = {}): SourceClaim {
    return {
        id,
        content_digest: HEX("a"),
        disposition: "executable_known_defect",
        rationale: "demonstrated in the named source",
        family_links: [],
        ...overrides,
    };
}

function inventory(claims: SourceClaim[] = [claim("claim-red-one")]): unknown {
    return {
        schema: SOURCE_INVENTORY_SCHEMA,
        items: [
            {
                id: "src-audit",
                source_path: "docs/AUDIT-KNOWN-ISSUES.md",
                content_digest: HEX("b"),
                claims,
            },
        ],
    };
}

function variant(id: string, overrides: Partial<IncidentVariant> = {}): IncidentVariant {
    return {
        id,
        lane: "known-red",
        source_claims: ["claim-red-one"],
        applicability: {
            harness: "opencode",
            omitted: [{ harness: "rust", reason: "opencode owns this storage authority" }],
        },
        semantic_revision: { id: "rev-one", fingerprint: HEX("c") },
        normative_checks: ["check-durable-state", "check-tool-result"],
        verifier_binding: {
            driver: "audit-memory-search/driver",
            verifier: "audit-memory-search/verifier",
            binding_status: "declared",
            invalid_state_evidence: ["false success narration with wrong lifecycle state"],
        },
        blocked_by: [],
        evidence_refs: ["ev-mutation-one"],
        ...overrides,
    };
}

function adjudicationOnlyVariant(id: string): IncidentVariant {
    return variant(id, {
        lane: "adjudication-only",
        applicability: null,
        normative_checks: [],
        verifier_binding: null,
        blocked_by: [],
    });
}

function catalog(variants: IncidentVariant[] = [variant("var-red-one")]): unknown {
    return {
        schema: INCIDENT_CATALOG_SCHEMA,
        families: [
            {
                id: "fam-demo",
                title: "Demo incident family",
                source_claims: ["claim-red-one"],
                variants,
            },
        ],
    };
}

function event(overrides: Partial<AdjudicationEvent> = {}): unknown {
    return {
        schema: ADJUDICATION_EVENT_SCHEMA,
        event_id: "adj-one",
        identity: "var-red-one",
        seq: 1,
        kind: "baseline",
        baseline_verdict: "red",
        semantic_fingerprint: HEX("c"),
        expected_failed_checks: ["check-durable-state"],
        observation_signature: HEX("d"),
        rationale: "reviewed red baseline",
        source_revision: "audit-2026-08-24",
        supersedes: null,
        ...overrides,
    };
}

function redaction(overrides: Partial<EmergencyRedactionEvent> = {}): unknown {
    return {
        schema: EMERGENCY_REDACTION_SCHEMA,
        event_id: "red-one",
        protected_base: "base-1",
        scope: "source_claim",
        target_id: "claim-red-one",
        old_digest: HEX("1"),
        new_digest: HEX("2"),
        prohibited_data_class: "credential",
        preserves_logical_ids_and_order: true,
        review_reference: "CR-12345678",
        ...overrides,
    };
}

describe("source inventory contract", () => {
    it("accepts a valid inventory and preserves its rows", () => {
        const parsed = parseSourceInventory(inventory());
        expect(parsed.items).toHaveLength(1);
        expect(parsed.items[0]!.claims[0]!.id).toBe("claim-red-one");
    });

    it("accepts a guide-level item with no claims", () => {
        const parsed = parseSourceInventory(inventory([]));
        expect(parsed.items[0]!.claims).toHaveLength(0);
    });

    it("rejects unknown fields at every level", () => {
        const root = { ...(inventory() as Record<string, unknown>), extra: true };
        expect(() => parseSourceInventory(root)).toThrow(/must contain exactly/);
        const badItem = inventory() as { items: Record<string, unknown>[] };
        badItem.items[0]!.surprise = "x";
        expect(() => parseSourceInventory(badItem)).toThrow(/must contain exactly/);
        const badClaim = inventory([{ ...claim("claim-red-one"), note: "x" } as never]);
        expect(() => parseSourceInventory(badClaim)).toThrow(/must contain exactly/);
    });

    it("rejects a wrong schema version", () => {
        const raw = { ...(inventory() as Record<string, unknown>), schema: "incident-source-inventory/v2" };
        expect(() => parseSourceInventory(raw)).toThrow(/schema/);
    });

    it("rejects duplicate item and claim ids", () => {
        const raw = inventory() as { items: unknown[] };
        raw.items.push(structuredClone(raw.items[0]));
        expect(() => parseSourceInventory(raw)).toThrow(/duplicate source item id/);
        expect(() =>
            parseSourceInventory(inventory([claim("claim-red-one"), claim("claim-red-one")])),
        ).toThrow(/duplicate source claim id/);
    });

    it("rejects a free-form disposition outside the closed enum", () => {
        expect(() =>
            parseSourceInventory(inventory([claim("claim-red-one", { disposition: "probably-broken" as never })])),
        ).toThrow(/disposition: must be one of/);
    });

    it("rejects malformed ids, digests, and empty rationale", () => {
        expect(() => parseSourceInventory(inventory([claim("Claim One" as never)]))).toThrow(/static lowercase id/);
        expect(() =>
            parseSourceInventory(inventory([claim("claim-red-one", { content_digest: "beef" })])),
        ).toThrow(/sha-256/);
        expect(() =>
            parseSourceInventory(inventory([claim("claim-red-one", { rationale: "  " })])),
        ).toThrow(/rationale: must be a non-empty string/);
    });
});

describe("incident catalog contract", () => {
    it("accepts a valid executable variant and an adjudication-only variant", () => {
        const parsed = parseIncidentCatalog(
            catalog([variant("var-red-one"), adjudicationOnlyVariant("var-note-only")]),
        );
        expect(parsed.families[0]!.variants).toHaveLength(2);
    });

    it("rejects duplicate family and variant ids", () => {
        const raw = catalog() as { families: unknown[] };
        raw.families.push(structuredClone(raw.families[0]));
        expect(() => parseIncidentCatalog(raw)).toThrow(/duplicate family id/);
        expect(() => parseIncidentCatalog(catalog([variant("var-red-one"), variant("var-red-one")]))).toThrow(
            /duplicate variant id/,
        );
    });

    it("rejects unknown variant fields", () => {
        expect(() =>
            parseIncidentCatalog(catalog([{ ...variant("var-red-one"), lucky: 7 } as never])),
        ).toThrow(/must contain exactly/);
    });

    it("rejects an adjudication-only record with a driver binding", () => {
        expect(() =>
            parseIncidentCatalog(
                catalog([
                    variant("var-note-only", {
                        lane: "adjudication-only",
                        applicability: null,
                        normative_checks: [],
                        blocked_by: [],
                    }),
                ]),
            ),
        ).toThrow(/must not carry a driver or verifier binding/);
    });

    it("rejects invalid lane/applicability combinations", () => {
        expect(() =>
            parseIncidentCatalog(catalog([variant("var-red-one", { applicability: null })])),
        ).toThrow(/requires harness applicability/);
        expect(() =>
            parseIncidentCatalog(
                catalog([
                    adjudicationOnlyVariant("var-note-only"),
                    variant("var-red-one"),
                ].map((entry) =>
                    entry.id === "var-note-only"
                        ? { ...entry, applicability: variant("var-red-one").applicability }
                        : entry,
                ) as IncidentVariant[]),
            ),
        ).toThrow(/must not declare harness applicability/);
    });

    it("rejects an executable record without a verifier binding or invalid-state evidence", () => {
        expect(() =>
            parseIncidentCatalog(catalog([variant("var-red-one", { verifier_binding: null })])),
        ).toThrow(/requires a verifier binding/);
        expect(() =>
            parseIncidentCatalog(
                catalog([
                    variant("var-red-one", {
                        verifier_binding: {
                            driver: "d",
                            verifier: "v",
                            binding_status: "declared",
                            invalid_state_evidence: [],
                        },
                    }),
                ]),
            ),
        ).toThrow(/at least one crafted invalid state/);
    });

    it("rejects a binding status outside declared/live", () => {
        expect(() =>
            parseIncidentCatalog(
                catalog([
                    variant("var-red-one", {
                        verifier_binding: {
                            driver: "d",
                            verifier: "v",
                            binding_status: "pending_unit" as never,
                            invalid_state_evidence: ["crafted invalid state"],
                        },
                    }),
                ]),
            ),
        ).toThrow(/binding_status: must be one of declared, live/);
        expect(() =>
            parseIncidentCatalog(
                catalog([
                    variant("var-red-one", {
                        verifier_binding: {
                            driver: "d",
                            verifier: "v",
                            invalid_state_evidence: ["crafted invalid state"],
                        } as never,
                    }),
                ]),
            ),
        ).toThrow(/must contain exactly/);
    });

    it("rejects dynamic check labels that could carry fixture data", () => {
        for (const bad of ["check-${fixture}", "Check One", "check-", "assert stale row"]) {
            expect(() =>
                parseIncidentCatalog(catalog([variant("var-red-one", { normative_checks: [bad] })])),
            ).toThrow(/static lowercase id/);
        }
    });

    it("rejects an executable variant without normative checks", () => {
        expect(() =>
            parseIncidentCatalog(catalog([variant("var-red-one", { normative_checks: [] })])),
        ).toThrow(/requires at least one normative check/);
    });

    it("rejects omitting the declared harness and duplicate omissions", () => {
        expect(() =>
            parseIncidentCatalog(
                catalog([
                    variant("var-red-one", {
                        applicability: {
                            harness: "opencode",
                            omitted: [{ harness: "opencode", reason: "nope" }],
                        },
                    }),
                ]),
            ),
        ).toThrow(/cannot omit the declared canonical harness/);
        expect(() =>
            parseIncidentCatalog(
                catalog([
                    variant("var-red-one", {
                        applicability: {
                            harness: "opencode",
                            omitted: [
                                { harness: "rust", reason: "a" },
                                { harness: "rust", reason: "b" },
                            ],
                        },
                    }),
                ]),
            ),
        ).toThrow(/duplicate omitted harness/);
    });

    it("rejects self and unknown blocked_by dependencies", () => {
        expect(() =>
            parseIncidentCatalog(catalog([variant("var-red-one", { blocked_by: ["var-red-one"] })])),
        ).toThrow(/cannot depend on itself/);
        expect(() =>
            parseIncidentCatalog(catalog([variant("var-red-one", { blocked_by: ["var-ghost"] })])),
        ).toThrow(/blocked_by references unknown variant var-ghost/);
    });

    it("rejects a malformed semantic revision fingerprint", () => {
        expect(() =>
            parseIncidentCatalog(
                catalog([variant("var-red-one", { semantic_revision: { id: "rev-one", fingerprint: "xyz" } })]),
            ),
        ).toThrow(/sha-256/);
    });
});

describe("adjudication event contract", () => {
    it("accepts green and red baselines and plain corrections", () => {
        expect(parseAdjudicationEvent(event(), "e").baseline_verdict).toBe("red");
        expect(
            parseAdjudicationEvent(
                event({
                    baseline_verdict: "green",
                    expected_failed_checks: null,
                    observation_signature: null,
                }),
                "e",
            ).baseline_verdict,
        ).toBe("green");
        expect(
            parseAdjudicationEvent(
                event({
                    kind: "correction",
                    baseline_verdict: null,
                    semantic_fingerprint: null,
                    expected_failed_checks: null,
                    observation_signature: null,
                }),
                "e",
            ).kind,
        ).toBe("correction");
    });

    it("rejects unknown fields", () => {
        expect(() => parseAdjudicationEvent({ ...(event() as Record<string, unknown>), extra: 1 }, "e")).toThrow(
            /must contain exactly/,
        );
    });

    it("rejects a red baseline without failed-check ids or an observation signature", () => {
        expect(() => parseAdjudicationEvent(event({ expected_failed_checks: [] }), "e")).toThrow(
            /at least one expected failed check/,
        );
        expect(() => parseAdjudicationEvent(event({ expected_failed_checks: null }), "e")).toThrow(
            /expected_failed_checks/,
        );
        expect(() => parseAdjudicationEvent(event({ observation_signature: null }), "e")).toThrow(
            /observation_signature/,
        );
    });

    it("rejects a green baseline carrying red-only fields", () => {
        expect(() =>
            parseAdjudicationEvent(event({ baseline_verdict: "green", observation_signature: null }), "e"),
        ).toThrow(/green baseline must not carry/);
    });

    it("rejects non-baseline events carrying baseline fields", () => {
        expect(() =>
            parseAdjudicationEvent(
                event({ kind: "resolution", expected_failed_checks: null, observation_signature: null }),
                "e",
            ),
        ).toThrow(/resolution event must not carry/);
    });

    it("rejects malformed sequence numbers, ids, and empty rationale", () => {
        expect(() => parseAdjudicationEvent(event({ seq: 0 }), "e")).toThrow(/positive integer/);
        expect(() => parseAdjudicationEvent(event({ seq: 1.5 }), "e")).toThrow(/positive integer/);
        expect(() => parseAdjudicationEvent(event({ event_id: "ADJ-1" as never }), "e")).toThrow(
            /static lowercase id/,
        );
        expect(() => parseAdjudicationEvent(event({ identity: "mystery" }), "e")).toThrow(/identity/);
        expect(() => parseAdjudicationEvent(event({ rationale: "" }), "e")).toThrow(/rationale/);
    });
});

describe("emergency redaction contract", () => {
    it("accepts a fully bound redaction event", () => {
        expect(parseEmergencyRedaction(redaction(), "r").scope).toBe("source_claim");
    });

    it("rejects unknown fields", () => {
        expect(() => parseEmergencyRedaction({ ...(redaction() as Record<string, unknown>), why: "" }, "r")).toThrow(
            /must contain exactly/,
        );
    });

    it("rejects identical old/new digests and a false preservation flag", () => {
        expect(() => parseEmergencyRedaction(redaction({ new_digest: HEX("1") }), "r")).toThrow(
            /old and new digests must differ/,
        );
        expect(() =>
            parseEmergencyRedaction(redaction({ preserves_logical_ids_and_order: false as never }), "r"),
        ).toThrow(/must be exactly true/);
    });

    it("rejects a missing review reference, bad scope, or bad data class", () => {
        expect(() => parseEmergencyRedaction(redaction({ review_reference: " " }), "r")).toThrow(
            /review_reference/,
        );
        expect(() => parseEmergencyRedaction(redaction({ scope: "everything" as never }), "r")).toThrow(
            /scope: must be one of/,
        );
        expect(() =>
            parseEmergencyRedaction(redaction({ prohibited_data_class: "meh" as never }), "r"),
        ).toThrow(/prohibited_data_class: must be one of/);
    });
});
