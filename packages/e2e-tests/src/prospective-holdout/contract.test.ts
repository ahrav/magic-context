import { describe, expect, it } from "bun:test";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { parseCloseManifest, parseFreezeManifest, parsePolicyOwnerDocument, type ReleaseFreezeManifest } from "./contract";
import { closeManifest, freezeManifest } from "./test-fixtures";

/**
 * Restates the freeze around one intake window. Approvals carry the body's fingerprint, so
 * they are re-derived: a manifest reaching the instant check has to be otherwise acceptable,
 * or a stale subject would decide the outcome instead. Both ends are supplied because a
 * normalised instant can land on either side of the window-order rule, and that rule would
 * otherwise answer for a calendar date the round-trip is what refuses.
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
        // A day past the end of February. The parser answers with a finite instant by carrying
        // the surplus days into March, so the shape passes the pattern and, without the
        // round-trip, an impossible date is signed into the approval subject and every ordering
        // comparison downstream reads March instead of what the artifact states. The window is
        // stated around it so the carried instant still opens before the cutoff: the
        // window-order rule would otherwise answer first and hide the calendar defect.
        expect(() => parseFreezeManifest(freezeWithWindow({
            opensAt: "2026-02-31T00:00:00Z",
            closesAt: "2026-09-08T00:00:00Z",
        }))).toThrow(/freeze\.body\.intakeWindow\.opensAt: instant-invalid/);
        // A February 29 in a year that has no February 29.
        expect(() => parseFreezeManifest(freezeWithWindow({
            opensAt: "2026-09-01T00:00:00Z",
            closesAt: "2027-02-29T00:00:00Z",
        }))).toThrow(/freeze\.body\.intakeWindow\.closesAt: instant-invalid/);
        // A day past the end of a thirty-day month.
        expect(() => parseFreezeManifest(freezeWithWindow({
            opensAt: "2026-09-01T00:00:00Z",
            closesAt: "2026-09-31T00:00:00Z",
        }))).toThrow(/freeze\.body\.intakeWindow\.closesAt: instant-invalid/);
        // Hour 24 names the same instant as the next day's midnight, so it too reaches the
        // ordering checks as an instant the artifact does not spell.
        expect(() => parseFreezeManifest(freezeWithWindow({
            opensAt: "2026-09-01T00:00:00Z",
            closesAt: "2026-09-30T24:00:00Z",
        }))).toThrow(/freeze\.body\.intakeWindow\.closesAt: instant-invalid/);
    });

    it("accepts every instant spelling the pattern admits and a real leap day", () => {
        // Seconds precision is the spelling the artifacts in this tree use, and the renderer
        // always writes milliseconds, so comparing its output against the input verbatim
        // would reject this.
        expect(parseFreezeManifest(freezeWithWindow({
            opensAt: "2026-09-01T00:00:00Z",
            closesAt: "2026-09-08T00:00:00Z",
        })).body.intakeWindow.closesAt).toBe("2026-09-08T00:00:00Z");
        // The pattern also admits exactly three fractional digits, on either end, and both
        // survive unchanged.
        expect(parseFreezeManifest(freezeWithWindow({
            opensAt: "2026-09-01T00:00:00.125Z",
            closesAt: "2026-09-08T00:00:00.500Z",
        })).body.intakeWindow).toEqual({
            opensAt: "2026-09-01T00:00:00.125Z",
            closesAt: "2026-09-08T00:00:00.500Z",
        });
        // A February 29 in a year that has one: the boundary the rejected spelling above sits
        // one year away from.
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
