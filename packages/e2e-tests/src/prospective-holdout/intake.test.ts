import { describe, expect, it } from "bun:test";
import { reviewSanitizedIntake, staticPrivacyRejection } from "./intake";
import { H3, sanitizedIntakeFixture } from "./test-fixtures";

const key = new TextEncoder().encode("k".repeat(32));
const reviewOptions = {
    commitmentKey: key,
    expectedRubricFingerprint: H3,
    freezePublishedAt: "2026-09-01T00:00:00Z",
    intakeClosesAt: "2026-09-08T00:00:00Z",
};

describe("privacy-first prospective intake", () => {
    it("derives stable opaque identity from approved synthetic bytes", () => {
        const input = sanitizedIntakeFixture();
        const first = reviewSanitizedIntake(input, reviewOptions);
        const second = reviewSanitizedIntake(input, reviewOptions);
        expect(first).toEqual(second);
        expect(first.status).toBe("admitted");
    });

    it("rejects sensitive bytes before schema diagnostics without echoing them", () => {
        const secret = "AKIAIOSFODNN7EXAMPLE";
        const input = { ...sanitizedIntakeFixture(), unknown: secret };
        const error = (() => {
            try {
                reviewSanitizedIntake(input, reviewOptions);
            } catch (failure) {
                return String(failure);
            }
            return "";
        })();
        expect(error).toContain("privacy.");
        expect(error).not.toContain(secret);
    });

    it("rejects outcome access and submissions outside the frozen window", () => {
        const contaminated = sanitizedIntakeFixture() as unknown as Record<string, unknown>;
        contaminated.outcome = { releaseN: "pass" };
        expect(() => reviewSanitizedIntake(contaminated, reviewOptions)).toThrow(/fields-invalid/);
        expect(() => reviewSanitizedIntake(sanitizedIntakeFixture(), {
            ...reviewOptions,
            freezePublishedAt: "2026-09-03T00:00:00Z",
        })).toThrow(/not-prospective/);
        expect(() => reviewSanitizedIntake(sanitizedIntakeFixture(), {
            ...reviewOptions,
            intakeClosesAt: "2026-09-01T12:00:00Z",
        })).toThrow(/after-frozen-cutoff/);
        expect(staticPrivacyRejection(
            `intake-${"e".repeat(32)}`,
            sanitizedIntakeFixture().deletionEvidence,
        ).reasonCode).toBe("privacy-rejected");
    });
});
