import { describe, expect, test } from "bun:test";

import {
    decodeCachedM0UpgradeIdentity,
    encodeCachedM0UpgradeIdentity,
} from "./compartment-render-epoch";

describe("legacy upgrade-identity crossing (R3 F7)", () => {
    test("a legacy encoded identity without mural/budget components decodes to null components", () => {
        const legacy = encodeCachedM0UpgradeIdentity("upgrade-v2", "cre2");
        const decoded = decodeCachedM0UpgradeIdentity(legacy);
        expect(decoded.muralEnabled).toBeNull();
        expect(decoded.renderBudgetIdentity).toBeNull();
    });

    test("a recorded mural component round-trips and discriminates", () => {
        const recorded = encodeCachedM0UpgradeIdentity("upgrade-v2", "cre2", true, "m15000-h96000");
        const decoded = decodeCachedM0UpgradeIdentity(recorded);
        expect(decoded.muralEnabled).toBe(true);
        expect(decoded.renderBudgetIdentity).toBe("m15000-h96000");
    });
});
