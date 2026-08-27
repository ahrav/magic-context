/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    DIRECT_FORMAT_FENCE_MIGRATION_VERSION,
    DIRECT_FORMAT_SUPERSEDED_MIGRATION_HEAD,
    FORK_MIGRATION_VERSION_FLOOR,
} from "./migrations";
import {
    formatSchemaFenceBootLog,
    getPersistedSchemaVersion,
    LATEST_SUPPORTED_VERSION,
} from "./storage-db";
import { DIRECT_FORMAT_EPOCH, MC_APPLICATION_ID } from "./storage-format-epoch";
import { createDirectTestDatabase } from "./test-database";

describe("direct-format version fence", () => {
    it("pins the supported version to the direct-format fence row", () => {
        expect(LATEST_SUPPORTED_VERSION).toBe(DIRECT_FORMAT_FENCE_MIGRATION_VERSION);
        expect(DIRECT_FORMAT_FENCE_MIGRATION_VERSION).toBe(
            DIRECT_FORMAT_SUPERSEDED_MIGRATION_HEAD + 1,
        );
    });

    it("keeps the fence below the downstream floor", () => {
        expect(DIRECT_FORMAT_FENCE_MIGRATION_VERSION).toBeLessThan(FORK_MIGRATION_VERSION_FLOOR);
        expect(DIRECT_FORMAT_SUPERSEDED_MIGRATION_HEAD).toBeLessThan(FORK_MIGRATION_VERSION_FLOOR);
    });

    it("stamps a fresh direct database at exactly the supported fence", () => {
        const { db } = createDirectTestDatabase();
        try {
            expect(getPersistedSchemaVersion(db)).toBe(LATEST_SUPPORTED_VERSION);
        } finally {
            db.close();
        }
    });

    it("logs the live version lane and supported fence at boot", () => {
        expect(formatSchemaFenceBootLog(90, 90)).toBe(
            "[magic-context] upstream migration lane at boot: database=v90, supported_fence=v90",
        );
    });
});

describe("direct-format vocabulary", () => {
    it("keeps the direct-format vocabulary disjoint from the retired migration lane", () => {
        expect(DIRECT_FORMAT_EPOCH).toBeGreaterThanOrEqual(1);
        expect(MC_APPLICATION_ID).toBe(0x4d435458);
        expect(DIRECT_FORMAT_FENCE_MIGRATION_VERSION).toBeGreaterThan(
            DIRECT_FORMAT_SUPERSEDED_MIGRATION_HEAD,
        );
    });
});
