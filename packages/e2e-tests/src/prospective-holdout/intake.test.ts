import { describe, expect, it } from "bun:test";
import { reviewSanitizedIntake, staticPrivacyRejection } from "./intake";
import { H3, sanitizedIntakeFixture, frozenEventFixture } from "./test-fixtures";

const key = new TextEncoder().encode("k".repeat(32));
const reviewOptions = {
    commitmentKey: key,
    expectedRubricFingerprint: H3,
    frozenEvent: frozenEventFixture(),
    intakeOpensAt: "2026-09-01T00:00:00Z",
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
            frozenEvent: frozenEventFixture("2026-09-03T00:00:00Z"),
        })).toThrow(/not-prospective/);
        expect(() => reviewSanitizedIntake(sanitizedIntakeFixture(), {
            ...reviewOptions,
            intakeClosesAt: "2026-09-01T12:00:00Z",
        })).toThrow(/after-frozen-cutoff/);
        expect(staticPrivacyRejection(
            `intake-${"e".repeat(32)}`,
            sanitizedIntakeFixture().submittedAt,
            sanitizedIntakeFixture().deletionEvidence,
        ).reasonCode).toBe("privacy-rejected");
        // Privacy rejections reject deletion evidence completed before their carried submission instant.
        expect(() => staticPrivacyRejection(
            `intake-${"e".repeat(32)}`,
            "2026-09-04T00:00:00Z",
            sanitizedIntakeFixture().deletionEvidence,
        )).toThrow(/before-submission/);
    });

    it("rejects a submission before the frozen window opens and admits one at the opening", () => {
        // A submission after freeze publication but before `intakeOpensAt` is rejected.
        expect(() => reviewSanitizedIntake(sanitizedIntakeFixture(), {
            ...reviewOptions,
            intakeOpensAt: "2026-09-03T00:00:00Z",
        })).toThrow(/before-frozen-opening/);
        // A submission at `intakeOpensAt` and after freeze publication is admitted.
        expect(reviewSanitizedIntake(sanitizedIntakeFixture(), {
            ...reviewOptions,
            intakeOpensAt: sanitizedIntakeFixture().submittedAt,
        }).status).toBe("admitted");
    });

    it("rejects deletion evidence completed before the submission it belongs to", () => {
        const early = sanitizedIntakeFixture();
        // Deletion evidence completed before its submission is rejected.
        for (const evidence of early.deletionEvidence) evidence.completedAt = "2026-09-01T00:00:00Z";
        expect(() => reviewSanitizedIntake(early, reviewOptions)).toThrow(/before-submission/);
        const atSubmission = sanitizedIntakeFixture();
        for (const evidence of atSubmission.deletionEvidence) {
            evidence.completedAt = atSubmission.submittedAt;
        }
        expect(reviewSanitizedIntake(atSubmission, reviewOptions).status).toBe("admitted");
    });
});
