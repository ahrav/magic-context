import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseIncidentCatalog } from "../contract";
import { E2E_ROOT } from "../evidence";
import * as regressions from "./source-linked-regressions";
import {
    failedCheckIds,
    FIRST_RENDER_A1_CHECKS,
    FIRST_RENDER_A3_CHECKS,
    THINKING_DROPPED_SHELL_CHECKS,
    THINKING_IMAGE_SURVIVAL_CHECKS,
    THINKING_NUDGE_ANCHOR_CHECKS,
    verifyAgedCtxReduceSurvival,
    verifyFirstRenderPureDeferStability,
    verifyThinkingDroppedShell,
    verifyThinkingImageSurvival,
    verifyThinkingNudgeAnchor,
    type AgedCtxReduceObservation,
    type FirstRenderDeferObservation,
    type ThinkingDroppedShellObservation,
    type ThinkingImageSurvivalObservation,
    type ThinkingNudgeAnchorObservation,
} from "./source-linked-regressions";

const MODULE_PATH = "src/incident-pool/scenarios/source-linked-regressions.ts";

function a1Observation(
    overrides: Partial<FirstRenderDeferObservation> = {},
): FirstRenderDeferObservation {
    return { mainRequestCount: 6, bustCount: 0, bustReport: "", ...overrides };
}

function a3Observation(
    overrides: Partial<AgedCtxReduceObservation> = {},
): AgedCtxReduceObservation {
    return {
        sawReduceOnWire: true,
        bustCount: 0,
        bustReport: "",
        finalWireHasCtxReduce: true,
        ...overrides,
    };
}

function nudgeObservation(
    overrides: Partial<ThinkingNudgeAnchorObservation> = {},
): ThinkingNudgeAnchorObservation {
    return {
        rustMode: false,
        mainRequestCount: 3,
        inspectedSignedAssistants: 2,
        nudgeMarkerFound: false,
        thinkingByteStable: true,
        rustThinkingBlockCount: 0,
        ...overrides,
    };
}

function shellObservation(
    overrides: Partial<ThinkingDroppedShellObservation> = {},
): ThinkingDroppedShellObservation {
    return {
        rustMode: false,
        dropEmitted: true,
        pasteBodyAbsent: true,
        shellPreserved: true,
        signedReplayIntact: true,
        turnBoundaryPreserved: true,
        ...overrides,
    };
}

function imageObservation(
    overrides: Partial<ThinkingImageSurvivalObservation> = {},
): ThinkingImageSurvivalObservation {
    return {
        rustMode: false,
        dropEmitted: true,
        droppedTextAbsent: true,
        coveredByRustHistory: false,
        imageBlockCount: 1,
        placeholderPresent: true,
        userWithImagePresent: true,
        ...overrides,
    };
}

describe("first-render tag stability verifiers (parity A1/A3)", () => {
    it("passes a clean pure-defer observation and emits the catalog check ids", () => {
        const result = verifyFirstRenderPureDeferStability(a1Observation());
        expect(result.verdict).toBe("pass");
        expect(result.checks.map((check) => check.id)).toEqual([
            ...FIRST_RENDER_A1_CHECKS,
        ]);
    });

    it("rejects a crafted bust observation and a below-floor request count", () => {
        const busted = verifyFirstRenderPureDeferStability(
            a1Observation({ bustCount: 1 }),
        );
        expect(busted.verdict).toBe("assertion_fail");
        expect(failedCheckIds(busted)).toEqual(["check-a1-zero-prefix-busts"]);

        const thin = verifyFirstRenderPureDeferStability(
            a1Observation({ mainRequestCount: 5 }),
        );
        expect(failedCheckIds(thin)).toEqual(["check-a1-defer-request-floor"]);
    });

    it("passes a surviving aged ctx_reduce arc and emits the catalog check ids", () => {
        const result = verifyAgedCtxReduceSurvival(a3Observation());
        expect(result.verdict).toBe("pass");
        expect(result.checks.map((check) => check.id)).toEqual([
            ...FIRST_RENDER_A3_CHECKS,
        ]);
    });

    it("rejects a vanished ctx_reduce call, a bust, and a never-on-wire call", () => {
        expect(
            failedCheckIds(
                verifyAgedCtxReduceSurvival(
                    a3Observation({ finalWireHasCtxReduce: false }),
                ),
            ),
        ).toEqual(["check-a3-reduce-retained-final-wire"]);
        expect(
            failedCheckIds(
                verifyAgedCtxReduceSurvival(a3Observation({ bustCount: 2 })),
            ),
        ).toEqual(["check-a3-zero-prefix-busts"]);
        expect(
            failedCheckIds(
                verifyAgedCtxReduceSurvival(
                    a3Observation({ sawReduceOnWire: false }),
                ),
            ),
        ).toEqual(["check-a3-reduce-on-wire"]);
    });
});

describe("thinking-block successor verifiers", () => {
    it("passes clean nudge-anchor observations in both modes", () => {
        const ts = verifyThinkingNudgeAnchor(nudgeObservation());
        expect(ts.verdict).toBe("pass");
        expect(ts.checks.map((check) => check.id)).toEqual([
            ...THINKING_NUDGE_ANCHOR_CHECKS,
        ]);

        const rust = verifyThinkingNudgeAnchor(
            nudgeObservation({
                rustMode: true,
                inspectedSignedAssistants: 0,
                rustThinkingBlockCount: 0,
            }),
        );
        expect(rust.verdict).toBe("pass");
    });

    it("rejects nudge text in a signed assistant even when every other field reads healthy", () => {
        const result = verifyThinkingNudgeAnchor(
            nudgeObservation({ nudgeMarkerFound: true }),
        );
        expect(failedCheckIds(result)).toEqual([
            "check-thinking-a-no-nudge-in-signed-assistant",
        ]);
    });

    it("rejects vacuous inspection and mutated thinking bytes", () => {
        expect(
            failedCheckIds(
                verifyThinkingNudgeAnchor(
                    nudgeObservation({ inspectedSignedAssistants: 0 }),
                ),
            ),
        ).toEqual(["check-thinking-a-nonvacuous-inspection"]);
        expect(
            failedCheckIds(
                verifyThinkingNudgeAnchor(
                    nudgeObservation({ thinkingByteStable: false }),
                ),
            ),
        ).toEqual(["check-thinking-a-signature-byte-stable"]);
        expect(
            failedCheckIds(
                verifyThinkingNudgeAnchor(
                    nudgeObservation({
                        rustMode: true,
                        inspectedSignedAssistants: 0,
                        rustThinkingBlockCount: 1,
                    }),
                ),
            ),
        ).toEqual(["check-thinking-a-signature-byte-stable"]);
    });

    it("passes a clean dropped-shell observation and rejects crafted invalid states", () => {
        const clean = verifyThinkingDroppedShell(shellObservation());
        expect(clean.verdict).toBe("pass");
        expect(clean.checks.map((check) => check.id)).toEqual([
            ...THINKING_DROPPED_SHELL_CHECKS,
        ]);

        expect(
            failedCheckIds(
                verifyThinkingDroppedShell(
                    shellObservation({ pasteBodyAbsent: false }),
                ),
            ),
        ).toEqual(["check-thinking-b-paste-body-absent"]);
        expect(
            failedCheckIds(
                verifyThinkingDroppedShell(
                    shellObservation({ turnBoundaryPreserved: false }),
                ),
            ),
        ).toEqual(["check-thinking-b-turn-boundary-preserved"]);
        expect(
            failedCheckIds(
                verifyThinkingDroppedShell(
                    shellObservation({ dropEmitted: false }),
                ),
            ),
        ).toEqual(["check-thinking-b-drop-emitted"]);
    });

    it("passes clean image-survival observations and rejects a stripped image", () => {
        const ts = verifyThinkingImageSurvival(imageObservation());
        expect(ts.verdict).toBe("pass");
        expect(ts.checks.map((check) => check.id)).toEqual([
            ...THINKING_IMAGE_SURVIVAL_CHECKS,
        ]);

        expect(
            failedCheckIds(
                verifyThinkingImageSurvival(
                    imageObservation({ imageBlockCount: 0 }),
                ),
            ),
        ).toEqual(["check-thinking-c-image-part-survives"]);
        const rustCovered = verifyThinkingImageSurvival(
            imageObservation({
                rustMode: true,
                coveredByRustHistory: true,
                imageBlockCount: 0,
                placeholderPresent: false,
                userWithImagePresent: false,
            }),
        );
        expect(rustCovered.verdict).toBe("pass");
        expect(
            failedCheckIds(
                verifyThinkingImageSurvival(
                    imageObservation({
                        rustMode: true,
                        coveredByRustHistory: true,
                        imageBlockCount: 1,
                    }),
                ),
            ),
        ).toEqual(["check-thinking-c-image-part-survives"]);
        expect(
            failedCheckIds(
                verifyThinkingImageSurvival(
                    imageObservation({ droppedTextAbsent: false }),
                ),
            ),
        ).toEqual(["check-thinking-c-dropped-text-absent"]);
    });
});

describe("registry binding surface", () => {
    it("resolves every committed live binding to a real exported function of this module", () => {
        const catalog = parseIncidentCatalog(
            JSON.parse(
                readFileSync(
                    join(E2E_ROOT, "incidents", "catalog.json"),
                    "utf8",
                ),
            ),
        );
        const moduleExports = regressions as Record<string, unknown>;
        let liveBindings = 0;
        for (const family of catalog.families) {
            for (const variant of family.variants) {
                const binding = variant.verifier_binding;
                if (binding === null || binding.binding_status !== "live")
                    continue;
                for (const reference of [binding.driver, binding.verifier]) {
                    const [path, symbol] = reference.split("#") as [
                        string,
                        string,
                    ];
                    expect(path).toBe(MODULE_PATH);
                    expect(resolve(E2E_ROOT, path)).toBe(
                        resolve(
                            import.meta.dir,
                            "source-linked-regressions.ts",
                        ),
                    );
                    expect(typeof moduleExports[symbol]).toBe("function");
                }
                liveBindings++;
            }
        }
        expect(liveBindings).toBe(5);
    });

    it("keeps the committed normative checks equal to the verifier-emitted check ids", () => {
        const catalog = parseIncidentCatalog(
            JSON.parse(
                readFileSync(
                    join(E2E_ROOT, "incidents", "catalog.json"),
                    "utf8",
                ),
            ),
        );
        const expectedChecks: Record<string, readonly string[]> = {
            "var-parity-a1-pure-defer-stability": FIRST_RENDER_A1_CHECKS,
            "var-parity-a3-ctx-reduce-survival": FIRST_RENDER_A3_CHECKS,
            "var-thinking-nudge-anchor": THINKING_NUDGE_ANCHOR_CHECKS,
            "var-thinking-dropped-shell": THINKING_DROPPED_SHELL_CHECKS,
            "var-thinking-image-survival": THINKING_IMAGE_SURVIVAL_CHECKS,
        };
        for (const family of catalog.families) {
            for (const variant of family.variants) {
                const expected = expectedChecks[variant.id];
                if (!expected) continue;
                expect(variant.normative_checks).toEqual([...expected]);
            }
        }
    });

    it("returns a structured registry result, not a bare test outcome", () => {
        const result = verifyFirstRenderPureDeferStability(
            a1Observation({ bustCount: 3 }),
        );
        expect(result).toEqual({
            verdict: "assertion_fail",
            checks: [
                { id: "check-a1-defer-request-floor", passed: true },
                { id: "check-a1-zero-prefix-busts", passed: false },
            ],
        });
    });
});
