import { describe, expect, it } from "bun:test";
import {
    ADAPTER_CATEGORIES,
    FROZEN_STATUS,
    redactTupleId,
    validateCommittedMatrix,
    validateHardeningMatrix,
    type AdapterCategory,
} from "./validate-shm-hardening-matrix";

interface Tuple {
    os: string;
    runtime: string;
    provider: string;
    profile: string;
    descriptor_geometry: Record<string, number>;
    host_limits: {
        active: Record<string, number>;
        quarantine: Record<string, number>;
    };
    expectation: string;
}

const CAPS = {
    arena_bytes: 1048576,
    descriptors: 64,
    mappings: 4,
    pinned_workers: 2,
};

function tuple(overrides: Partial<Tuple> = {}): Tuple {
    return {
        os: "linux",
        runtime: "rust",
        provider: "ring",
        profile: "small_latency",
        descriptor_geometry: {
            slot_size: 64,
            slot_count: 32,
            arena_bytes: 1048576,
            lane_count: 1,
        },
        host_limits: { active: { ...CAPS }, quarantine: { ...CAPS } },
        expectation: "active",
        ...overrides,
    };
}

function identityOf(entry: Tuple): string {
    return [entry.os, entry.runtime, entry.provider, entry.profile].join("/");
}

function manifestWith(
    tuples: Tuple[],
    section: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        arms: { selectable: ["ring", "iceoryx_0_9_3"] },
        failure_hardening: {
            status: FROZEN_STATUS,
            active_platforms: [],
            retained_tuples: tuples,
            ...section,
        },
    };
}

function fullInventory(
    tuples: Tuple[],
): Record<string, readonly AdapterCategory[]> {
    return Object.fromEntries(
        tuples.map((entry) => [identityOf(entry), ADAPTER_CATEGORIES]),
    );
}

describe("shm hardening matrix validator", () => {
    it("reports the committed manifest as unresolved and fails fast", () => {
        const result = validateCommittedMatrix();
        expect(result.outcome).toBe("unresolved");
        expect(result.errors.join(" ")).toMatch(/tuple execution is blocked/);
    });

    it("accepts a frozen matrix with full adapter coverage", () => {
        const tuples = [tuple(), tuple({ os: "macos" })];
        const result = validateHardeningMatrix(
            manifestWith(tuples, { active_platforms: ["linux", "macos"] }),
            fullInventory(tuples),
        );
        expect(result).toEqual({ outcome: "valid", errors: [] });
    });

    it("reports an UNSET status as unresolved", () => {
        const result = validateHardeningMatrix(
            manifestWith([], {
                status: "UNSET_REQUIRES_YMC12_RETAINED_RESULT",
            }),
            {},
        );
        expect(result.outcome).toBe("unresolved");
    });

    it("reports an UNSET tuple field as unresolved", () => {
        const entry = tuple({ profile: "UNSET" });
        const result = validateHardeningMatrix(
            manifestWith([entry]),
            fullInventory([entry]),
        );
        expect(result.outcome).toBe("unresolved");
    });

    it("rejects a duplicate tuple identity", () => {
        const entry = tuple();
        const result = validateHardeningMatrix(
            manifestWith([entry, tuple()]),
            fullInventory([entry]),
        );
        expect(result.outcome).toBe("invalid");
        expect(result.errors.join(" ")).toMatch(/duplicate tuple identity/);
    });

    it("rejects a provider outside arms.selectable without leaking its name", () => {
        const entry = tuple({ provider: "rogue_provider_text" });
        const result = validateHardeningMatrix(
            manifestWith([entry]),
            fullInventory([entry]),
        );
        expect(result.outcome).toBe("invalid");
        expect(result.errors.join(" ")).toMatch(
            /provider outside arms.selectable/,
        );
        expect(result.errors.join(" ")).not.toContain("rogue_provider_text");
    });

    it("rejects missing adapter categories and names only the categories", () => {
        const entry = tuple();
        const partial = { [identityOf(entry)]: ["decoder", "crash"] as const };
        const result = validateHardeningMatrix(manifestWith([entry]), partial);
        expect(result.outcome).toBe("invalid");
        const text = result.errors.join(" ");
        expect(text).toMatch(/lacks adapter coverage for: .*native-boundary/);
        expect(text).toContain(redactTupleId(identityOf(entry)));
        expect(text).not.toContain("ring");
    });

    it("fails when a retained tuple is omitted from the adapter inventory (seeded defect)", () => {
        const covered = tuple();
        const omitted = tuple({ os: "macos" });
        const result = validateHardeningMatrix(
            manifestWith([covered, omitted]),
            fullInventory([covered]),
        );
        expect(result.outcome).toBe("invalid");
        expect(result.errors.join(" ")).toContain(
            redactTupleId(identityOf(omitted)),
        );
    });

    it("rejects a dead adapter mapping", () => {
        const entry = tuple();
        const inventory = {
            ...fullInventory([entry]),
            "linux/rust/ring/no_such_profile": ADAPTER_CATEGORIES,
        };
        const result = validateHardeningMatrix(
            manifestWith([entry]),
            inventory,
        );
        expect(result.outcome).toBe("invalid");
        expect(result.errors.join(" ")).toMatch(/dead adapter mapping/);
    });

    it("rejects an omission expectation and a macos tuple without active coverage", () => {
        const entry = tuple({ os: "macos", expectation: "omission" });
        const result = validateHardeningMatrix(
            manifestWith([entry]),
            fullInventory([entry]),
        );
        expect(result.outcome).toBe("invalid");
        const text = result.errors.join(" ");
        expect(text).toMatch(/declares omission/);
        expect(text).toMatch(/retained macos tuple without active coverage/);
    });

    it("rejects a claimed active platform with no retained provider", () => {
        const entry = tuple();
        const result = validateHardeningMatrix(
            manifestWith([entry], { active_platforms: ["linux", "macos"] }),
            fullInventory([entry]),
        );
        expect(result.outcome).toBe("invalid");
        expect(result.errors.join(" ")).toMatch(
            /claimed active platform macos has no retained provider/,
        );
    });

    it("rejects malformed geometry, host limits, os, runtime, and expectation", () => {
        const entry = tuple({
            os: "windows",
            runtime: "deno",
            expectation: "maybe",
            descriptor_geometry: {
                slot_size: 0,
                slot_count: 32,
                arena_bytes: 1,
                lane_count: 1,
            },
            host_limits: {
                active: { ...CAPS },
                quarantine: { arena_bytes: 1 },
            },
        });
        const result = validateHardeningMatrix(
            manifestWith([entry]),
            fullInventory([entry]),
        );
        expect(result.outcome).toBe("invalid");
        const text = result.errors.join(" ");
        expect(text).toMatch(/os outside linux\|macos/);
        expect(text).toMatch(/runtime outside rust\|bun\|node/);
        expect(text).toMatch(/expectation outside active\|omission/);
        expect(text).toMatch(/descriptor_geometry must have positive/);
        expect(text).toMatch(
            /host_limits must have active and quarantine caps/,
        );
    });

    it("rejects a manifest missing the failure_hardening section", () => {
        const result = validateHardeningMatrix(
            { arms: { selectable: ["ring"] } },
            {},
        );
        expect(result.outcome).toBe("invalid");
        expect(result.errors.join(" ")).toMatch(
            /must declare status and retained_tuples/,
        );
    });
});
