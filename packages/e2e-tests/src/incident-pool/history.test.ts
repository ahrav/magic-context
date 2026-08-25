import { describe, expect, it } from "bun:test";
import {
    compareWithAcceptedSnapshot,
    replayAdjudicationLedger,
    rowDigest,
    splitLedgerLines,
    validateIncidentHistory,
    type HistorySnapshot,
} from "./history";
import {
    parseAdjudicationEvent,
    ADJUDICATION_EVENT_SCHEMA,
    EMERGENCY_REDACTION_SCHEMA,
    INCIDENT_CATALOG_SCHEMA,
    SOURCE_INVENTORY_SCHEMA,
    type AdjudicationEvent,
    type EmergencyRedactionEvent,
    type IncidentVariant,
} from "./contract";

const HEX = (fill: string): string => fill.repeat(64);
const FP_GREEN = HEX("a");
const FP_RED = HEX("b");
const FP_RED_OLD = HEX("e");
const SIGNATURE = HEX("d");

function event(
    overrides: Partial<AdjudicationEvent> & {
        event_id: string;
        identity: string;
        seq: number;
    },
): AdjudicationEvent {
    return {
        schema: ADJUDICATION_EVENT_SCHEMA,
        kind: "correction",
        baseline_verdict: null,
        semantic_fingerprint: null,
        expected_failed_checks: null,
        observation_signature: null,
        rationale: "reviewed",
        source_revision: "audit-2026-08-24",
        supersedes: null,
        ...overrides,
    };
}

function greenBaseline(
    eventId: string,
    identity: string,
    seq: number,
    fingerprint: string,
): AdjudicationEvent {
    return event({
        event_id: eventId,
        identity,
        seq,
        kind: "baseline",
        baseline_verdict: "green",
        semantic_fingerprint: fingerprint,
    });
}

function redBaseline(
    eventId: string,
    identity: string,
    seq: number,
    fingerprint: string,
    overrides: Partial<AdjudicationEvent> = {},
): AdjudicationEvent {
    return event({
        event_id: eventId,
        identity,
        seq,
        kind: "baseline",
        baseline_verdict: "red",
        semantic_fingerprint: fingerprint,
        expected_failed_checks: ["check-red-holds"],
        observation_signature: SIGNATURE,
        ...overrides,
    });
}

function variantFixture(
    id: string,
    overrides: Partial<IncidentVariant> = {},
): IncidentVariant {
    return {
        id,
        lane: "known-red",
        source_claims: ["claim-red-one"],
        applicability: { harness: "opencode", omitted: [] },
        semantic_revision: { id: "rev-red-one", fingerprint: FP_RED },
        normative_checks: ["check-red-holds", "check-red-durable"],
        verifier_binding: {
            driver: "demo/driver",
            verifier: "demo/verifier",
            binding_status: "declared",
            invalid_state_evidence: ["stale-plus-current coexistence fixture"],
        },
        blocked_by: [],
        evidence_refs: [],
        ...overrides,
    };
}

interface FixtureData {
    inventory: Record<string, unknown>;
    catalog: Record<string, unknown>;
    events: AdjudicationEvent[];
    redactions: EmergencyRedactionEvent[];
}

function fixture(): FixtureData {
    return {
        inventory: {
            schema: SOURCE_INVENTORY_SCHEMA,
            items: [
                {
                    id: "src-audit",
                    source_path: "docs/AUDIT-KNOWN-ISSUES.md",
                    content_digest: HEX("f"),
                    claims: [
                        {
                            id: "claim-green-one",
                            content_digest: HEX("1"),
                            disposition: "executable_accepted_behavior",
                            rationale:
                                "accepted behavior with a behavioral contract",
                            family_links: ["fam-demo"],
                        },
                        {
                            id: "claim-red-one",
                            content_digest: HEX("2"),
                            disposition: "executable_known_defect",
                            rationale: "demonstrated defect reproduction",
                            family_links: ["fam-demo"],
                        },
                    ],
                },
            ],
        },
        catalog: {
            schema: INCIDENT_CATALOG_SCHEMA,
            families: [
                {
                    id: "fam-demo",
                    title: "Demo incident family",
                    source_claims: ["claim-green-one", "claim-red-one"],
                    variants: [
                        variantFixture("var-green-one", {
                            lane: "green",
                            source_claims: ["claim-green-one"],
                            semantic_revision: {
                                id: "rev-green-one",
                                fingerprint: FP_GREEN,
                            },
                            normative_checks: ["check-green-holds"],
                        }),
                        variantFixture("var-red-one"),
                    ],
                },
            ],
        },
        events: [
            greenBaseline("adj-green-one", "var-green-one", 1, FP_GREEN),
            redBaseline("adj-red-one", "var-red-one", 1, FP_RED_OLD),
            redBaseline("adj-red-two", "var-red-one", 2, FP_RED, {
                supersedes: "adj-red-one",
            }),
        ],
        redactions: [],
    };
}

function snapshot(data: FixtureData, baseLabel = "base-1"): HistorySnapshot {
    return {
        baseLabel,
        inventoryText: JSON.stringify(data.inventory),
        catalogText: JSON.stringify(data.catalog),
        adjudicationLines: data.events.map((entry) => JSON.stringify(entry)),
        redactionLines: data.redactions.map((entry) => JSON.stringify(entry)),
    };
}

function claims(data: FixtureData): Record<string, unknown>[] {
    return (data.inventory.items as Record<string, unknown>[])[0]!
        .claims as Record<string, unknown>[];
}

function variants(data: FixtureData): IncidentVariant[] {
    return (data.catalog.families as Record<string, unknown>[])[0]!
        .variants as IncidentVariant[];
}

function redactionFor(
    scope: EmergencyRedactionEvent["scope"],
    targetId: string,
    oldRow: unknown,
    newRow: unknown,
    overrides: Partial<EmergencyRedactionEvent> = {},
): EmergencyRedactionEvent {
    return {
        schema: EMERGENCY_REDACTION_SCHEMA,
        event_id: "red-one",
        protected_base: "base-1",
        scope,
        target_id: targetId,
        old_digest: rowDigest(oldRow),
        new_digest: rowDigest(newRow),
        prohibited_data_class: "credential",
        preserves_logical_ids_and_order: true,
        review_reference: "CR-12345678",
        ...overrides,
    };
}

describe("adjudication ledger replay", () => {
    it("loads a valid family with two variants and the expected latest baselines", () => {
        const state = validateIncidentHistory(snapshot(fixture()));
        expect(
            state.ledger.byIdentity.get("var-green-one")!.latestBaseline!
                .event_id,
        ).toBe("adj-green-one");
        expect(
            state.ledger.byIdentity.get("var-red-one")!.latestBaseline!
                .event_id,
        ).toBe("adj-red-two");
        expect(state.ledger.byIdentity.get("var-red-one")!.events).toHaveLength(
            2,
        );
    });

    it("rejects duplicate event ids", () => {
        const data = fixture();
        data.events.push(
            redBaseline("adj-red-two", "var-red-one", 3, FP_RED, {
                supersedes: "adj-red-two",
            }),
        );
        expect(() => validateIncidentHistory(snapshot(data))).toThrow(
            /duplicate event id/,
        );
    });

    it("rejects an event for an unknown variant identity", () => {
        const data = fixture();
        data.events.push(
            event({ event_id: "adj-ghost", identity: "var-ghost", seq: 1 }),
        );
        expect(() => validateIncidentHistory(snapshot(data))).toThrow(
            /unknown identity var-ghost/,
        );
    });

    it("rejects per-identity sequence gaps", () => {
        const data = fixture();
        data.events.push(
            event({ event_id: "adj-gap", identity: "var-red-one", seq: 4 }),
        );
        expect(() => validateIncidentHistory(snapshot(data))).toThrow(
            /sequence gap/,
        );
    });

    it("rejects forward supersession", () => {
        const events = [
            redBaseline("adj-red-one", "var-red-one", 1, FP_RED_OLD, {
                supersedes: "adj-red-two",
            }),
            redBaseline("adj-red-two", "var-red-one", 2, FP_RED, {
                supersedes: "adj-red-one",
            }),
        ];
        expect(() => replayAdjudicationLedger(events)).toThrow(
            /supersedes unknown or later event/,
        );
    });

    it("rejects cross-identity supersession", () => {
        const data = fixture();
        data.events.push(
            event({
                event_id: "adj-cross",
                identity: "var-red-one",
                seq: 3,
                supersedes: "adj-green-one",
            }),
        );
        expect(() => validateIncidentHistory(snapshot(data))).toThrow(
            /cross-identity supersession/,
        );
    });

    it("rejects superseding an already superseded event", () => {
        const data = fixture();
        data.events.push(
            event({
                event_id: "adj-again",
                identity: "var-red-one",
                seq: 3,
                supersedes: "adj-red-one",
            }),
        );
        expect(() => validateIncidentHistory(snapshot(data))).toThrow(
            /already superseded/,
        );
    });

    it("rejects correction, resolution, or retirement superseding a baseline", () => {
        for (const kind of [
            "correction",
            "resolution",
            "retirement",
        ] as const) {
            const data = fixture();
            data.events.push(
                event({
                    event_id: `adj-${kind}`,
                    identity: "var-red-one",
                    seq: 3,
                    kind,
                    supersedes: "adj-red-two",
                }),
            );
            expect(() => validateIncidentHistory(snapshot(data))).toThrow(
                /only a baseline event may supersede baseline adj-red-two/,
            );
        }
    });

    it("rejects a baseline that does not supersede the current baseline", () => {
        const data = fixture();
        data.events.push(
            redBaseline("adj-rebind", "var-red-one", 3, FP_RED, {
                supersedes: null,
            }),
        );
        expect(() => validateIncidentHistory(snapshot(data))).toThrow(
            /baseline must supersede adj-red-two/,
        );
    });

    it("rejects events after a retirement", () => {
        const events = [
            event({
                event_id: "adj-retire",
                identity: "var-red-one",
                seq: 1,
                kind: "retirement",
            }),
            event({ event_id: "adj-late", identity: "var-red-one", seq: 2 }),
        ];
        expect(() => replayAdjudicationLedger(events)).toThrow(/is retired/);
    });

    it("fails the whole replay on any invalid line instead of skipping it", () => {
        const data = fixture();
        const lines = snapshot(data).adjudicationLines;
        lines[1] = "{not json";
        expect(() =>
            validateIncidentHistory({
                ...snapshot(data),
                adjudicationLines: lines,
            }),
        ).toThrow(/adjudications\[1\] is not valid JSON/);
    });
});

describe("incident history cross-checks", () => {
    it("rejects a known-red variant without a non-empty adjudication", () => {
        const data = fixture();
        data.events = data.events.filter(
            (entry) => entry.identity !== "var-red-one",
        );
        expect(() => validateIncidentHistory(snapshot(data))).toThrow(
            /executable variant var-red-one has no baseline adjudication/,
        );
    });

    it("rejects a lane that disagrees with the latest baseline verdict", () => {
        const data = fixture();
        variants(data)[1] = variantFixture("var-red-one", { lane: "green" });
        expect(() => validateIncidentHistory(snapshot(data))).toThrow(
            /lane green disagrees with latest baseline verdict red/,
        );
    });

    it("rejects a semantic revision change without a new fingerprint-bound adjudication", () => {
        const data = fixture();
        variants(data)[1] = variantFixture("var-red-one", {
            semantic_revision: { id: "rev-red-two", fingerprint: HEX("9") },
        });
        expect(() => validateIncidentHistory(snapshot(data))).toThrow(
            /rev-red-two is not bound by a fingerprint-matching baseline adjudication/,
        );
    });

    it("rejects a red baseline expecting a check the variant does not declare", () => {
        const data = fixture();
        data.events[2] = redBaseline("adj-red-two", "var-red-one", 2, FP_RED, {
            supersedes: "adj-red-one",
            expected_failed_checks: ["check-red-holds", "check-unknown"],
        });
        expect(() => validateIncidentHistory(snapshot(data))).toThrow(
            /red baseline expects unknown check check-unknown/,
        );
    });

    it("rejects a baseline bound to an adjudication-only variant", () => {
        const data = fixture();
        variants(data).push(
            variantFixture("var-note-only", {
                lane: "adjudication-only",
                applicability: null,
                normative_checks: [],
                verifier_binding: null,
                source_claims: ["claim-red-one"],
            }),
        );
        data.events.push(
            greenBaseline("adj-note", "var-note-only", 1, FP_GREEN),
        );
        expect(() => validateIncidentHistory(snapshot(data))).toThrow(
            /adjudication-only variant var-note-only must not have a baseline adjudication/,
        );
    });

    it("rejects orphan variant and family claim references", () => {
        const data = fixture();
        variants(data)[1] = variantFixture("var-red-one", {
            source_claims: ["claim-ghost"],
        });
        expect(() => validateIncidentHistory(snapshot(data))).toThrow(
            /orphan variant var-red-one: unknown source claim claim-ghost/,
        );
        const familyData = fixture();
        (
            familyData.catalog.families as Record<string, unknown>[]
        )[0]!.source_claims = ["claim-green-one", "claim-ghost"];
        expect(() => validateIncidentHistory(snapshot(familyData))).toThrow(
            /family fam-demo references unknown source claim claim-ghost/,
        );
    });

    it("rejects a variant claim that is not linked to its own family", () => {
        const data = fixture();
        // claim-red-one still exists, but no longer belongs to the family that
        // encloses the variant claiming it.
        (
            data.catalog.families as Record<string, unknown>[]
        )[0]!.source_claims = ["claim-green-one"];
        expect(() => validateIncidentHistory(snapshot(data))).toThrow(
            /variant var-red-one claims claim-red-one, which is not linked to its family fam-demo/,
        );
    });

    it("rejects a claim link to an unknown family", () => {
        const data = fixture();
        claims(data)[0]!.family_links = ["fam-ghost"];
        expect(() => validateIncidentHistory(snapshot(data))).toThrow(
            /claim-green-one links unknown family fam-ghost/,
        );
    });
});

describe("repository-baseline comparison", () => {
    it("accepts an unchanged candidate and pure event appends", () => {
        const accepted = snapshot(fixture());
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(fixture())),
        ).not.toThrow();

        const appended = fixture();
        appended.events.push(
            event({
                event_id: "adj-note-one",
                identity: "var-red-one",
                seq: 3,
                kind: "resolution",
            }),
            event({
                event_id: "adj-note-two",
                identity: "claim-red-one",
                seq: 1,
                kind: "correction",
            }),
        );
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(appended)),
        ).not.toThrow();
    });

    it("rejects editing an accepted claim without an appended event and accepts it with one", () => {
        const accepted = snapshot(fixture());
        const edited = fixture();
        claims(edited)[1]!.disposition = "informational";
        claims(edited)[1]!.rationale = "reclassified after review";
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(edited)),
        ).toThrow(
            /accepted source claim edited without an appended adjudication or emergency redaction: claim-red-one/,
        );
        edited.events.push(
            event({
                event_id: "adj-reclass",
                identity: "claim-red-one",
                seq: 1,
                kind: "correction",
            }),
        );
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(edited)),
        ).not.toThrow();
    });

    it("rejects deleting accepted inventory and catalog rows", () => {
        // Event-free rows isolate the row-deletion guards; deleting an
        // executable variant would trip the ledger-prefix guard first.
        const acceptedData = fixture();
        claims(acceptedData).push({
            id: "claim-info-one",
            content_digest: HEX("3"),
            disposition: "informational",
            rationale: "documented cost note with no behavioral contract",
            family_links: ["fam-demo"],
        });
        (
            acceptedData.catalog.families as Record<string, unknown>[]
        )[0]!.source_claims = [
            "claim-green-one",
            "claim-red-one",
            "claim-info-one",
        ];
        variants(acceptedData).push(
            variantFixture("var-info-only", {
                lane: "adjudication-only",
                source_claims: ["claim-info-one"],
                applicability: null,
                normative_checks: [],
                verifier_binding: null,
            }),
        );
        const accepted = snapshot(acceptedData);

        const noClaim = structuredClone(acceptedData);
        claims(noClaim).splice(2, 1);
        (
            noClaim.catalog.families as Record<string, unknown>[]
        )[0]!.source_claims = ["claim-green-one", "claim-red-one"];
        variants(noClaim).splice(2, 1);
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(noClaim)),
        ).toThrow(/accepted source claim of src-audit deleted: claim-info-one/);

        const noVariant = structuredClone(acceptedData);
        variants(noVariant).splice(2, 1);
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(noVariant)),
        ).toThrow(/accepted variant of fam-demo deleted: var-info-only/);
    });

    it("rejects reordering accepted rows", () => {
        const accepted = snapshot(fixture());
        const reordered = fixture();
        claims(reordered).reverse();
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(reordered)),
        ).toThrow(/reordered/);
    });

    it("rejects inserting a new row before the accepted prefix", () => {
        const accepted = snapshot(fixture());
        const inserted = fixture();
        claims(inserted).unshift({
            id: "claim-new-one",
            content_digest: HEX("9"),
            disposition: "informational",
            rationale:
                "new appended provenance was inserted in the wrong position",
            family_links: ["fam-demo"],
        });
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(inserted)),
        ).toThrow(/preceded by an insertion/);
    });

    it("rejects a variant edit without a new baseline and accepts a fingerprint-bound revision", () => {
        const accepted = snapshot(fixture());
        const edited = fixture();
        variants(edited)[1] = variantFixture("var-red-one", {
            normative_checks: [
                "check-red-holds",
                "check-red-durable",
                "check-red-extra",
            ],
        });
        // A non-baseline correction is not enough authority for a variant edit.
        edited.events.push(
            event({
                event_id: "adj-note-one",
                identity: "var-red-one",
                seq: 3,
                kind: "correction",
            }),
        );
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(edited)),
        ).toThrow(
            /accepted variant edited without an appended adjudication or emergency redaction: var-red-one/,
        );

        const revised = fixture();
        const nextFingerprint = HEX("9");
        variants(revised)[1] = variantFixture("var-red-one", {
            semantic_revision: {
                id: "rev-red-two",
                fingerprint: nextFingerprint,
            },
        });
        revised.events.push(
            redBaseline("adj-red-three", "var-red-one", 3, nextFingerprint, {
                supersedes: "adj-red-two",
            }),
        );
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(revised)),
        ).not.toThrow();
    });

    it("allows a newly introduced identity to change until it is accepted", () => {
        const accepted = fixture();
        const withNew = fixture();
        variants(withNew).push(
            variantFixture("var-new-one", {
                source_claims: ["claim-red-one"],
                semantic_revision: { id: "rev-new-one", fingerprint: HEX("7") },
            }),
        );
        withNew.events.push(
            redBaseline("adj-new-one", "var-new-one", 1, HEX("7")),
        );
        expect(() =>
            compareWithAcceptedSnapshot(snapshot(accepted), snapshot(withNew)),
        ).not.toThrow();

        const reworked = structuredClone(withNew);
        variants(reworked)[2] = variantFixture("var-new-one", {
            source_claims: ["claim-red-one"],
            semantic_revision: { id: "rev-new-two", fingerprint: HEX("8") },
        });
        reworked.events[3] = redBaseline(
            "adj-new-one",
            "var-new-one",
            1,
            HEX("8"),
        );
        expect(() =>
            compareWithAcceptedSnapshot(snapshot(accepted), snapshot(reworked)),
        ).not.toThrow();
        expect(() =>
            compareWithAcceptedSnapshot(snapshot(withNew), snapshot(reworked)),
        ).toThrow(
            /adjudication ledger prefix changed|accepted variant edited|may change only rationale and source_revision/,
        );
    });

    it("rejects a ledger prefix change without a redaction and accepts an exact digest-bound one", () => {
        const acceptedData = fixture();
        const accepted = snapshot(acceptedData);
        const redactedData = fixture();
        const before = redactedData.events[1]!;
        const after = {
            ...before,
            rationale: "redacted: prohibited bytes removed",
        };
        redactedData.events[1] = after;
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(redactedData)),
        ).toThrow(
            /adjudication ledger prefix changed at line 2 without a matching emergency redaction/,
        );
        redactedData.redactions.push(
            redactionFor(
                "adjudication_event",
                before.event_id,
                before,
                parseAdjudicationEvent(after, "fixture"),
            ),
        );
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(redactedData)),
        ).not.toThrow();
    });

    it("rejects an exact digest-bound redaction that changes baseline oracle fields", () => {
        const acceptedData = fixture();
        const accepted = snapshot(acceptedData);
        const before = acceptedData.events[1]!;
        const after = {
            ...before,
            observation_signature: HEX("8"),
        };
        const redacted = fixture();
        redacted.events[1] = after;
        redacted.redactions.push(
            redactionFor("adjudication_event", before.event_id, before, after),
        );
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(redacted)),
        ).toThrow(/may change only rationale and source_revision/);
    });

    it("rejects a redaction with the wrong base, digests, or rewritten logical identity", () => {
        const acceptedData = fixture();
        const accepted = snapshot(acceptedData);
        const before = acceptedData.events[1]!;
        const after = { ...before, rationale: "redacted" };

        const wrongBase = fixture();
        wrongBase.events[1] = after;
        wrongBase.redactions.push(
            redactionFor("adjudication_event", before.event_id, before, after, {
                protected_base: "base-0",
            }),
        );
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(wrongBase)),
        ).toThrow(/without a matching emergency redaction/);

        const wrongOld = fixture();
        wrongOld.events[1] = after;
        wrongOld.redactions.push(
            redactionFor(
                "adjudication_event",
                before.event_id,
                { forged: true },
                after,
            ),
        );
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(wrongOld)),
        ).toThrow(/without a matching emergency redaction/);

        const wrongNew = fixture();
        wrongNew.events[1] = after;
        wrongNew.redactions.push(
            redactionFor("adjudication_event", before.event_id, before, {
                forged: true,
            }),
        );
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(wrongNew)),
        ).toThrow(/without a matching emergency redaction/);

        const rewritten = fixture();
        const renamed = { ...before, event_id: "adj-renamed" };
        rewritten.events[1] = renamed;
        rewritten.events[2] = {
            ...rewritten.events[2]!,
            supersedes: "adj-renamed",
        };
        rewritten.redactions.push(
            redactionFor(
                "adjudication_event",
                before.event_id,
                before,
                renamed,
            ),
        );
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(rewritten)),
        ).toThrow(/rewrote logical identity/);
    });

    it("rejects shortening either ledger and editing the redaction prefix", () => {
        const acceptedData = fixture();
        acceptedData.redactions.push(
            redactionFor(
                "source_claim",
                "claim-red-one",
                { a: 1 },
                { a: 2 },
                { protected_base: "base-0" },
            ),
        );
        const accepted = snapshot(acceptedData);

        const shortened = structuredClone(acceptedData);
        shortened.events.pop();
        const shortenedVariants = variants(shortened);
        shortenedVariants[1] = variantFixture("var-red-one", {
            semantic_revision: { id: "rev-red-one", fingerprint: FP_RED_OLD },
        });
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(shortened)),
        ).toThrow(/adjudication ledger prefix shortened/);

        const redactionEdited = structuredClone(acceptedData);
        redactionEdited.redactions[0] = {
            ...redactionEdited.redactions[0]!,
            review_reference: "CR-99999999",
        };
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(redactionEdited)),
        ).toThrow(/emergency-redaction ledger prefix changed/);

        const redactionShortened = structuredClone(acceptedData);
        redactionShortened.redactions.pop();
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(redactionShortened)),
        ).toThrow(/emergency-redaction ledger shortened/);
    });

    it("authorizes an accepted claim rewrite through an exact digest-bound redaction", () => {
        const acceptedData = fixture();
        const accepted = snapshot(acceptedData);
        const redacted = fixture();
        const before = structuredClone(claims(redacted)[1]!);
        claims(redacted)[1]!.rationale = "redacted: prohibited bytes removed";
        redacted.redactions.push(
            redactionFor(
                "source_claim",
                "claim-red-one",
                before,
                claims(redacted)[1],
            ),
        );
        expect(() =>
            compareWithAcceptedSnapshot(accepted, snapshot(redacted)),
        ).not.toThrow();
    });
});

describe("ledger line splitting", () => {
    it("handles empty files and a single trailing newline", () => {
        expect(splitLedgerLines("")).toEqual([]);
        expect(splitLedgerLines("\n")).toEqual([]);
        expect(splitLedgerLines('{"a":1}\n{"b":2}\n')).toEqual([
            '{"a":1}',
            '{"b":2}',
        ]);
    });
});
