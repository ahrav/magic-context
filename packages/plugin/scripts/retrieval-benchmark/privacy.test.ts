import { describe, expect, it } from "bun:test";
import { userInfo } from "node:os";

import { type PrivacyViolation, scanForSensitiveContent } from "./privacy";
import { makeValidRelease } from "./test-support";

describe("scanForSensitiveContent", () => {
    it("passes a clean release", () => {
        expect(scanForSensitiveContent(makeValidRelease())).toEqual([]);
    });

    it("rejects seeded sensitive canaries by category", () => {
        const cases: Array<[unknown, PrivacyViolation["category"]]> = [
            [{ q: "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789AB" }, "secret-or-path"],
            [{ q: "file at /home/someone/project/notes.txt" }, "source-path"],
            [{ q: "file at C:\\Users\\someone\\notes.txt" }, "source-path"],
            [{ q: "endpoint http://192.168.1.10:8080/api" }, "shareability"],
            [{ q: "control\u0000char" }, "control-character"],
            [
                {
                    q: "hash 4ec9599fc203d176a301536c2e091a19bc852759b255bd6818810a42c5fed14a",
                },
                "hash-like",
            ],
            [{ q: "session ses_331acff95fferWZOYF1pG0cjOn" }, "session-id"],
        ];
        for (const [artifact, category] of cases) {
            const violations = scanForSensitiveContent(artifact);
            expect(violations.map((v) => v.category)).toContain(category);
        }
    });

    it("rejects the current OS username", () => {
        const username = userInfo().username;
        const violations = scanForSensitiveContent({ q: `written by ${username} today` });
        expect(violations.length).toBeGreaterThan(0);
    });

    it("rejects seeded corpus-specific identifying tokens", () => {
        const violations = scanForSensitiveContent(
            { q: "the ACME-INTERNAL-CODENAME launch" },
            { forbiddenTokens: ["acme-internal-codename"] },
        );
        expect(violations.map((v) => v.category)).toContain("forbidden-token");
    });

    it("scans object keys and nested arrays", () => {
        const violations = scanForSensitiveContent({
            list: [{ "ses_0123456789abcdef": "value" }],
        });
        expect(violations.map((v) => v.category)).toContain("session-id");
    });

    it("never echoes raw or encoded canary values in violations", () => {
        const canary = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789AB";
        const violations = scanForSensitiveContent({ q: `key ${canary}` });
        const serialized = JSON.stringify(violations);
        expect(serialized).not.toContain(canary);
        expect(serialized).not.toContain(Buffer.from(canary).toString("base64"));
        expect(serialized).not.toContain(Buffer.from(canary).toString("hex"));
    });

    it("never echoes a sensitive object key through violation paths", () => {
        const sensitiveKey = "ses_0123456789abcdefSECRETKEY";
        const violations = scanForSensitiveContent({ nested: { [sensitiveKey]: "value" } });
        expect(violations.length).toBeGreaterThan(0);
        expect(JSON.stringify(violations)).not.toContain(sensitiveKey);
    });

    it("allows declared fingerprint fields but not hash-shaped text elsewhere", () => {
        const hash = "4ec9599fc203d176a301536c2e091a19bc852759b255bd6818810a42c5fed14a";
        expect(scanForSensitiveContent({ corpusFingerprint: hash })).toEqual([]);
        expect(scanForSensitiveContent({ note: hash })).toHaveLength(1);
    });

    it("still applies every non-hash check to fingerprint-named fields", () => {
        const violations = scanForSensitiveContent({
            streamHash: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789AB",
        });
        expect(violations.map((v) => v.category)).toContain("secret-or-path");
    });
});
