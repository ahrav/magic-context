import { describe, expect, it } from "bun:test";
import { reviewSanitizedIntake, staticPrivacyRejection } from "./intake";
import { H3, sanitizedIntakeFixture } from "./test-fixtures";

const key = new TextEncoder().encode("k".repeat(32));

describe("privacy-first prospective intake", () => {
    it("derives stable opaque identity from approved synthetic bytes", () => {
        const input = sanitizedIntakeFixture();
        const first = reviewSanitizedIntake(input, {
            commitmentKey: key,
            expectedRubricFingerprint: H3,
            freezePublishedAt: "2026-09-01T00:00:00Z",
        });
        const second = reviewSanitizedIntake(input, {
            commitmentKey: key,
            expectedRubricFingerprint: H3,
            freezePublishedAt: "2026-09-01T00:00:00Z",
        });
        expect(first).toEqual(second);
        expect(first.status).toBe("admitted");
    });

    it("rejects sensitive bytes before schema diagnostics without echoing them", () => {
        const secret = "AKIAIOSFODNN7EXAMPLE";
        const input = { ...sanitizedIntakeFixture(), unknown: secret };
        const error = (() => {
            try {
                reviewSanitizedIntake(input, {
                    commitmentKey: key,
                    expectedRubricFingerprint: H3,
                    freezePublishedAt: "2026-09-01T00:00:00Z",
                });
            } catch (failure) {
                return String(failure);
            }
            return "";
        })();
        expect(error).toContain("privacy.");
        expect(error).not.toContain(secret);
    });

    it("rejects outcome access, pre-freeze cases, and emits static privacy rejection", () => {
        const contaminated = sanitizedIntakeFixture() as unknown as Record<string, unknown>;
        contaminated.outcome = { releaseN: "pass" };
        expect(() => reviewSanitizedIntake(contaminated, {
            commitmentKey: key,
            expectedRubricFingerprint: H3,
            freezePublishedAt: "2026-09-01T00:00:00Z",
        })).toThrow(/fields-invalid/);
        expect(() => reviewSanitizedIntake(sanitizedIntakeFixture(), {
            commitmentKey: key,
            expectedRubricFingerprint: H3,
            freezePublishedAt: "2026-09-03T00:00:00Z",
        })).toThrow(/not-prospective/);
        expect(staticPrivacyRejection(
            `intake-${"e".repeat(32)}`,
            sanitizedIntakeFixture().deletionEvidence,
        ).reasonCode).toBe("privacy-rejected");
    });
});
