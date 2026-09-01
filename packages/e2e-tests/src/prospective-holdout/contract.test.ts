import { describe, expect, it } from "bun:test";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { parseCloseManifest, parseFreezeManifest, parsePolicyOwnerDocument, type ReleaseFreezeManifest } from "./contract";
import { closeManifest, freezeManifest } from "./test-fixtures";

/**
 * The helper recomputes approval.subjectFingerprint values so stale-subject validation cannot mask instant validation.
 * Callers must set closesAt after normalized opensAt so window-order validation cannot mask instant validation.
 * An invalid instant can normalize across the intakeWindow ordering boundary.
 */
function freezeWithWindow(window: { opensAt: string; closesAt: string }): ReleaseFreezeManifest {
    const manifest = freezeManifest();
    manifest.body.intakeWindow = { ...window };
    const subjectFingerprint = canonicalFingerprint(manifest.body);
    for (const approval of manifest.approvals) approval.subjectFingerprint = subjectFingerprint;
    return manifest;
}

describe("prospective holdout contracts", () => {
    it("accepts exact freeze and close schemas", () => {
        const freeze = parseFreezeManifest(freezeManifest());
        const close = parseCloseManifest(closeManifest(freeze));
        expect(close.body.freezeManifestFingerprint).toBe(canonicalFingerprint(freeze));
    });

    it("rejects unknown fields and policy or approval drift", () => {
        const freeze = freezeManifest() as unknown as Record<string, unknown>;
        expect(() => parseFreezeManifest({ ...freeze, extra: true })).toThrow(/fields-invalid/);

        const changed = freezeManifest();
        changed.body.executionMatrix.seeds = [8];
        expect(() => parseFreezeManifest(changed)).toThrow(/stale-subject/);

        const close = closeManifest();
        close.body.freezeManifestFingerprint = "f".repeat(64);
        expect(() => parseCloseManifest(close)).toThrow(/stale-subject/);
    });

    it("rejects an instant the parser normalises into a different calendar date", () => {
        // The parser normalizes an invalid February day into March while matching the timestamp pattern.
        // Round-trip validation rejects invalid calendar spellings.
        // Downstream ordering compares the normalized instant, not the input spelling.
        // closesAt must follow normalized opensAt so window-order validation cannot mask instant-invalid.
        expect(() => parseFreezeManifest(freezeWithWindow({
            opensAt: "2026-02-31T00:00:00Z",
            closesAt: "2026-09-08T00:00:00Z",
        }))).toThrow(/freeze\.body\.intakeWindow\.opensAt: instant-invalid/);
        expect(() => parseFreezeManifest(freezeWithWindow({
            opensAt: "2026-09-01T00:00:00Z",
            closesAt: "2027-02-29T00:00:00Z",
        }))).toThrow(/freeze\.body\.intakeWindow\.closesAt: instant-invalid/);
        expect(() => parseFreezeManifest(freezeWithWindow({
            opensAt: "2026-09-01T00:00:00Z",
            closesAt: "2026-09-31T00:00:00Z",
        }))).toThrow(/freeze\.body\.intakeWindow\.closesAt: instant-invalid/);
        // Hour 24 normalizes to the next day's midnight.
        // Round-trip validation rejects input spellings that normalize before ordering checks.
        expect(() => parseFreezeManifest(freezeWithWindow({
            opensAt: "2026-09-01T00:00:00Z",
            closesAt: "2026-09-30T24:00:00Z",
        }))).toThrow(/freeze\.body\.intakeWindow\.closesAt: instant-invalid/);
    });

    it("accepts every instant spelling the pattern admits and a real leap day", () => {
        // Artifacts use second precision, but the renderer emits milliseconds.
        expect(parseFreezeManifest(freezeWithWindow({
            opensAt: "2026-09-01T00:00:00Z",
            closesAt: "2026-09-08T00:00:00Z",
        })).body.intakeWindow.closesAt).toBe("2026-09-08T00:00:00Z");
        // The pattern accepts exactly three fractional digits in opensAt and closesAt.
        // survive unchanged.
        expect(parseFreezeManifest(freezeWithWindow({
            opensAt: "2026-09-01T00:00:00.125Z",
            closesAt: "2026-09-08T00:00:00.500Z",
        })).body.intakeWindow).toEqual({
            opensAt: "2026-09-01T00:00:00.125Z",
            closesAt: "2026-09-08T00:00:00.500Z",
        });
        // A leap-day date is valid; a non-leap-year February 29 is not.
        expect(parseFreezeManifest(freezeWithWindow({
            opensAt: "2026-09-01T00:00:00Z",
            closesAt: "2028-02-29T00:00:00Z",
        })).body.intakeWindow.closesAt).toBe("2028-02-29T00:00:00Z");
    });

    it("keeps sibling policy ownership explicit and pending documents empty", () => {
        expect(
            parsePolicyOwnerDocument(
                {
                    schema: "prospective-policy-owner/v1",
                    owner: "magic-context-x4l.14",
                    status: "pending",
                    policy: null,
                    policyFingerprint: null,
                },
                "magic-context-x4l.14",
            ).status,
        ).toBe("pending");
        expect(() =>
            parsePolicyOwnerDocument(
                {
                    schema: "prospective-policy-owner/v1",
                    owner: "magic-context-x4l.14",
                    status: "pending",
                    policy: { fabricated: true },
                    policyFingerprint: null,
                },
                "magic-context-x4l.14",
            ),
        ).toThrow(/pending-must-be-empty/);
    });
});
