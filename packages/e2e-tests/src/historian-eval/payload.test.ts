/**
 * Round-trip proof for the historian-eval payload path: what
 * `buildMockHistorianOutput` emits is what the PRODUCTION parser reads back.
 * Guards the format-drift class documented in mock-historian.ts — a validator
 * or parser tightening must fail here, not silently zero the eval lane.
 */

import { describe, expect, test } from "bun:test";
import { buildMockHistorianOutput } from "../mock-historian";
import { parseCompartmentOutput } from "../../../plugin/src/hooks/magic-context/compartment-parser";
import { goldFacts, goldenRawOutput, validScenario } from "./test-support";

describe("buildMockHistorianOutput", () => {
    test("golden output round-trips through the production parser", () => {
        const scenario = validScenario();
        const parsed = parseCompartmentOutput(goldenRawOutput(scenario));

        expect(parsed.compartments).toHaveLength(1);
        expect(parsed.compartments[0].startMessage).toBe(1);
        expect(parsed.compartments[0].endMessage).toBe(scenario.transcript.turns.length * 2);
        expect(parsed.compartments[0].p1).toBeTruthy();
        expect(parsed.facts).toEqual(goldFacts());
        expect(parsed.unprocessedFrom).toBe(scenario.transcript.turns.length * 2 + 1);
    });

    test("multi-compartment output with escaped prose round-trips", () => {
        const raw = buildMockHistorianOutput({
            compartments: [
                { start: 1, end: 4, title: 'Cache <decision> & "quotes"', body: "a < b && c > d" },
                { start: 5, end: 8, title: "Second", body: "plain", importance: 90, episodeType: "decision" },
            ],
            facts: [{ category: "ARCHITECTURE", content: "uses <p1>-style markers & entities" }],
        });
        const parsed = parseCompartmentOutput(raw);

        expect(parsed.compartments).toHaveLength(2);
        expect(parsed.compartments[0].title).toBe('Cache <decision> & "quotes"');
        expect(parsed.compartments[0].p1).toBe("a < b && c > d");
        expect(parsed.compartments[1].importance).toBe(90);
        expect(parsed.compartments[1].episodeType).toBe("decision");
        expect(parsed.facts).toEqual([{ category: "ARCHITECTURE", content: "uses <p1>-style markers & entities" }]);
        expect(parsed.unprocessedFrom).toBe(9);
    });

    test("empty compartments without explicit unprocessedFrom throws instead of emitting -Infinity", () => {
        expect(() => buildMockHistorianOutput({ compartments: [] })).toThrow(/unprocessedFrom is required/);
    });

    test("empty compartments with explicit unprocessedFrom emits a parseable marker", () => {
        const raw = buildMockHistorianOutput({ compartments: [], unprocessedFrom: 1 });
        const parsed = parseCompartmentOutput(raw);
        expect(parsed.compartments).toHaveLength(0);
        expect(parsed.unprocessedFrom).toBe(1);
    });

    test("non-tag-shaped fact category throws instead of corrupting the facts block", () => {
        for (const category of ["bad-category", "A><B", "ARCH</facts>", "", "lower_case"]) {
            expect(() =>
                buildMockHistorianOutput({
                    compartments: [{ start: 1, end: 2, title: "t", body: "b" }],
                    facts: [{ category, content: "x" }],
                }),
            ).toThrow(/not tag-shaped/);
        }
    });

    test("multi-line fact content throws instead of silently changing the fact set", () => {
        // The production parser reads one bullet line at a time and its `m` flag
        // honors all four ECMAScript line terminators, so an unprefixed
        // continuation is dropped and a `* `-prefixed one becomes an extra fact —
        // either way the parsed set differs from the authored one.
        const separators = ["\n", "\r", "\u2028", "\u2029"];
        for (const separator of separators) {
            for (const content of [`first${separator}second`, `first${separator}* smuggled second fact`]) {
                expect(() =>
                    buildMockHistorianOutput({
                        compartments: [{ start: 1, end: 2, title: "t", body: "b" }],
                        facts: [{ category: "ARCHITECTURE", content }],
                    }),
                ).toThrow(/must be single-line/);
            }
        }
    });

    test("fact content that is blank or padded throws instead of round-tripping changed", () => {
        // The parser reads each item as `unescapeXml(match.trim())` and drops
        // empty results, so padding round-trips shorter than authored and blank
        // content vanishes from the fact set.
        for (const content of ["", " ", "  padded  ", "trailing "]) {
            expect(() =>
                buildMockHistorianOutput({
                    compartments: [{ start: 1, end: 2, title: "t", body: "b" }],
                    facts: [{ category: "ARCHITECTURE", content }],
                }),
            ).toThrow(/must be non-empty and trimmed/);
        }
    });

    test("single-line fact content round-trips byte-for-byte through the parser", () => {
        const content = "Sessions use the in-process LRU cache; capacity 4096.";
        const parsed = parseCompartmentOutput(
            buildMockHistorianOutput({
                compartments: [{ start: 1, end: 2, title: "t", body: "b" }],
                facts: [{ category: "ARCHITECTURE", content }],
            }),
        );
        expect(parsed.facts).toEqual([{ category: "ARCHITECTURE", content }]);
    });

    test("wrong-but-well-formed category is allowed for the mutation battery and not promoted", () => {        const raw = buildMockHistorianOutput({
            compartments: [{ start: 1, end: 2, title: "t", body: "b" }],
            facts: [{ category: "WORKFLOW_RULES", content: "outside taxonomy" }],
        });
        const parsed = parseCompartmentOutput(raw);
        // The production parser only extracts the 5-category taxonomy, so the
        // wrong-category mutation manifests as a non-promoted fact — the
        // payload stays structurally intact.
        expect(parsed.facts).toEqual([]);
        expect(parsed.compartments).toHaveLength(1);
        expect(parsed.unprocessedFrom).toBe(3);
    });
});
