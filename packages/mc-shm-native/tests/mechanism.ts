import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { probeCapabilities } from "../index.ts";

const scratch = mkdtempSync(join(tmpdir(), "mc-shm-native-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("native mechanism gate", () => {
    test("proves every required runtime mechanism or omits capability", () => {
        const result = probeCapabilities();
        expect(result.napiVersion === null || result.napiVersion >= 1).toBe(
            true,
        );
        if (result.available) {
            expect(result.napiVersion).toBeGreaterThanOrEqual(8);
            expect(result.externalArrayBuffer).toBe(true);
            expect(result.exactBounds).toBe(true);
            expect(result.detachment).toBe(true);
            expect(result.transferPrevention).toBe(true);
            expect(result.cleanupHooks).toBe(true);
        } else {
            expect(typeof result.reason).toBe("string");
            expect(result.reason?.length).toBeGreaterThan(0);
        }
    });

    test("environment cleanup hook runs at runtime exit when addon loads", () => {
        const marker = join(scratch, "cleanup.marker");
        const script = join(scratch, "cleanup.mjs");
        const addon = resolve(
            dirname(fileURLToPath(import.meta.url)),
            "../mc_shm_native.node",
        );
        writeFileSync(
            script,
            `import { createRequire } from "node:module";\n` +
                `const addon = createRequire(import.meta.url)(${JSON.stringify(addon)});\n` +
                `addon.registerCleanupProbe(${JSON.stringify(marker)});\n` +
                `if (process.platform === "linux") addon.createTestPair();\n`,
        );
        const child = spawnSync(process.execPath, [script], {
            encoding: "utf8",
        });
        expect(child.status).toBe(0);
        expect(readFileSync(marker, "utf8")).toBe("clean");
    });
});
