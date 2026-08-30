import { describe, expect, test } from "bun:test";

import { parseSharedMemoryDiagnostics } from "./client";

function diagnostics() {
    const resources = {
        descriptors: 0,
        arena_bytes: 0,
        leases: 0,
        mappings: 0,
        file_descriptors: 0,
        workers: 0,
        client_instances: 0,
        pinned_workers: 0,
    };
    return {
        state: "healthy",
        error_class: null,
        artifact: {
            profile: "mc-host-eventfd-ring-v2",
            wire_version: 2,
            descriptor_schema: 3,
        },
        bounds: resources,
        accounting: { active: resources, quarantined: resources },
        attachment: { completed: 0 },
        activation: { completed: 0 },
        peer_death: { observed: 0 },
        reclamation: { completed: 0 },
        exhaustion: { observed: 0 },
    };
}

describe("shared-memory diagnostic artifact contract", () => {
    test("accepts current eventfd ring identity", () => {
        expect(parseSharedMemoryDiagnostics(diagnostics()).artifact).toEqual({
            profile: "mc-host-eventfd-ring-v2",
            wire_version: 2,
            descriptor_schema: 3,
        });
    });

    test("rejects superseded profile and descriptor schema", () => {
        for (const artifact of [
            { profile: "mc-host-test-ring-v1", wire_version: 2, descriptor_schema: 3 },
            { profile: "mc-host-eventfd-ring-v2", wire_version: 2, descriptor_schema: 2 },
        ]) {
            expect(() => parseSharedMemoryDiagnostics({ ...diagnostics(), artifact })).toThrow(
                /shared_memory artifact identity mismatch/,
            );
        }
    });
});
