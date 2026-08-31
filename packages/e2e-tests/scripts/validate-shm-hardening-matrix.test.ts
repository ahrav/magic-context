import { describe, expect, it } from "bun:test";
import {
    validateCommittedMatrix,
    validateHardeningMatrix,
} from "./validate-shm-hardening-matrix";

describe("fixed ring manifest validator", () => {
    it("accepts the committed manifest", () => {
        expect(validateCommittedMatrix()).toEqual({
            outcome: "valid",
            errors: [],
        });
    });

    it("accepts one fixed ring transport", () => {
        expect(
            validateHardeningMatrix({ arms: { transport: ["ring"] } }),
        ).toEqual({ outcome: "valid", errors: [] });
    });

    it("rejects missing, alternate, or multiple transports", () => {
        for (const manifest of [
            {},
            { arms: {} },
            { arms: { transport: [] } },
            { arms: { transport: ["alternate"] } },
            { arms: { transport: ["ring", "alternate"] } },
        ]) {
            expect(validateHardeningMatrix(manifest).outcome).toBe("invalid");
        }
    });

    it("rejects provider-selection and retained-tuple fields", () => {
        const result = validateHardeningMatrix({
            arms: { transport: ["ring"], selectable: ["ring"] },
            failure_hardening: { retained_tuples: [] },
        });

        expect(result.outcome).toBe("invalid");
        expect(result.errors.join(" ")).toMatch(/selectable/);
        expect(result.errors.join(" ")).toMatch(/retained tuples/);
    });
});
