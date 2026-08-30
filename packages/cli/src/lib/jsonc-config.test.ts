import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readJsoncConfig, readJsoncLenient } from "./jsonc-config";

describe("readJsoncConfig prototype-pollution hardening", () => {
    it("refuses dangerous keys recursively before config mutation", () => {
        const directory = mkdtempSync(join(tmpdir(), "mc-cli-jsonc-"));
        const path = join(directory, "config.jsonc");
        writeFileSync(
            path,
            `{
                "nested": { "prototype": { "hidden": true } },
                "items": [{ "__proto__": { "plugin": ["attacker"] } }]
            }`,
        );

        try {
            const result = readJsoncConfig(path);
            expect(result.kind).toBe("parse-error");
            if (result.kind === "parse-error") {
                expect(result.error.message).toContain("prototype-pollution");
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

describe("readJsoncConfig I/O failure boundary", () => {
    it("reports an existing-but-unreadable path as parse-error instead of throwing", () => {
        const directory = mkdtempSync(join(tmpdir(), "mc-cli-jsonc-io-"));
        // A directory passes the existsSync probe but readFileSync(EISDIR) fails.
        const path = join(directory, "config.jsonc");
        mkdirSync(path);

        try {
            const result = readJsoncConfig(path);
            expect(result.kind).toBe("parse-error");
            if (result.kind === "parse-error") {
                expect(result.error.path).toBe(path);
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("keeps readJsoncLenient lenient on read failures (returns parseError, never throws)", () => {
        const directory = mkdtempSync(join(tmpdir(), "mc-cli-jsonc-io-"));
        const path = join(directory, "settings.json");
        mkdirSync(path);

        try {
            const result = readJsoncLenient(path);
            expect(result.value).toEqual({});
            expect(typeof result.parseError).toBe("string");
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
