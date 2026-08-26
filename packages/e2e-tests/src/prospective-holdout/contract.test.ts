import { describe, expect, it } from "bun:test";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { parseCloseManifest, parseFreezeManifest, parsePolicyOwnerDocument } from "./contract";
import { closeManifest, freezeManifest } from "./test-fixtures";

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
