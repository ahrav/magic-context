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
        // The privacy-rejected path has no sanitized intake to bound its deletion
        // completions, so the instant it carries is what rejects evidence for a retention
        // run that finished before the report existed.
        expect(() => staticPrivacyRejection(
            `intake-${"e".repeat(32)}`,
            "2026-09-04T00:00:00Z",
            sanitizedIntakeFixture().deletionEvidence,
        )).toThrow(/before-submission/);
    });

    it("rejects a submission before the frozen window opens and admits one at the opening", () => {
        // A freeze published before its window opens leaves a span in which a report is
        // prospective relative to publication and still outside the declared window, so
        // the lower bound the freeze published is what rejects it.
        expect(() => reviewSanitizedIntake(sanitizedIntakeFixture(), {
            ...reviewOptions,
            intakeOpensAt: "2026-09-03T00:00:00Z",
        })).toThrow(/before-frozen-opening/);
        // The opening instant is inside the window, and the fixture is still strictly
        // after publication, so both lower bounds admit this submission.
        expect(reviewSanitizedIntake(sanitizedIntakeFixture(), {
            ...reviewOptions,
            intakeOpensAt: sanitizedIntakeFixture().submittedAt,
        }).status).toBe("admitted");
    });

    it("rejects deletion evidence completed before the submission it belongs to", () => {
        const early = sanitizedIntakeFixture();
        // Every store stays inside its own deadline, so the deadline test admits this
        // evidence and the submission bound is the only rule that rejects it.
        for (const evidence of early.deletionEvidence) evidence.completedAt = "2026-09-01T00:00:00Z";
        expect(() => reviewSanitizedIntake(early, reviewOptions)).toThrow(/before-submission/);
        const atSubmission = sanitizedIntakeFixture();
        for (const evidence of atSubmission.deletionEvidence) {
            evidence.completedAt = atSubmission.submittedAt;
        }
        expect(reviewSanitizedIntake(atSubmission, reviewOptions).status).toBe("admitted");
    });
});
