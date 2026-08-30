import { describe, expect, test } from "bun:test";

import { CACHE_DIR, PACKAGE_NAME } from "./constants";

describe("auto-update-checker/constants", () => {
    test("PACKAGE_NAME matches the published package identity", async () => {
        const pkg = (await import("../../../package.json")) as { name: string };
        expect(PACKAGE_NAME).toBe(pkg.name);
    });

    test("points at OpenCode packages cache", () => {
        expect(CACHE_DIR).toContain("opencode");
        expect(CACHE_DIR).toEndWith("packages");
    });
});
