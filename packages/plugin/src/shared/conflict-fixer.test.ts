/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "comment-json";
import { detectConflicts } from "./conflict-detector";
import { fixConflicts } from "./conflict-fixer";

const noOmoConflicts = {
    omoPreemptiveCompaction: false,
    omoContextWindowMonitor: false,
    omoAnthropicRecovery: false,
};

describe("fixConflicts", () => {
    let root: string;
    let projectDir: string;
    let userConfigDir: string;
    let homeDir: string;
    let originalEnv: Record<string, string | undefined>;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "mc-conflict-fixer-"));
        projectDir = join(root, "project");
        userConfigDir = join(root, "user-config", "opencode");
        homeDir = join(root, "home");
        mkdirSync(projectDir, { recursive: true });
        mkdirSync(userConfigDir, { recursive: true });
        mkdirSync(homeDir, { recursive: true });
        originalEnv = {
            OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
            HOME: process.env.HOME,
        };
        process.env.OPENCODE_CONFIG_DIR = userConfigDir;
        process.env.HOME = homeDir;
        delete process.env.XDG_CONFIG_HOME;
    });

    afterEach(() => {
        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        try {
            rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* */
        }
    });

    it("preserves JSONC comments and tuple plugin entries while removing canonical DCP", () => {
        const configPath = join(projectDir, "opencode.jsonc");
        writeFileSync(
            configPath,
            `{
  // The JSONC rewrite preserves this file-level comment.
  "plugin": [
    ["@plannotator/opencode@latest", { "workflow": "plan-agent" }],
    ["@tarquinen/opencode-dcp@latest", { "enabled": true }],
    "@cortexkit/opencode-magic-context@latest"
  ],
  "compaction": {
    // The JSONC rewrite preserves this compaction comment.
    "auto": true,
    "prune": true
  }
}
`,
        );

        const actions = fixConflicts(projectDir, {
            compactionAuto: true,
            compactionPrune: true,
            dcpPlugin: true,
            ...noOmoConflicts,
        });

        const updatedText = readFileSync(configPath, "utf-8");
        const updated = parseJsonc(updatedText) as Record<string, unknown>;
        expect(actions).toEqual(["Disabled auto-compaction", "Removed opencode-dcp plugin"]);
        expect(updatedText).toContain("keep this file-level comment");
        expect(updatedText).toContain("keep this compaction comment");
        expect(updated.compaction).toEqual({ auto: false, prune: false });
        expect(updated.plugin).toEqual([
            ["@plannotator/opencode@latest", { workflow: "plan-agent" }],
            "@cortexkit/opencode-magic-context@latest",
        ]);
    });

    it("skips non-existent target files instead of creating user config", () => {
        const actions = fixConflicts(projectDir, {
            compactionAuto: true,
            compactionPrune: true,
            dcpPlugin: true,
            ...noOmoConflicts,
        });

        expect(actions).toEqual([]);
        expect(existsSync(join(userConfigDir, "opencode.json"))).toBe(false);
        expect(existsSync(join(userConfigDir, "opencode.jsonc"))).toBe(false);
    });

    it("keeps DCP forks and substring-only names because matching is canonical", () => {
        const configPath = join(projectDir, "opencode.json");
        writeFileSync(
            configPath,
            JSON.stringify({
                plugin: [
                    "@some-fork/opencode-dcp-fork",
                    "file:///tmp/opencode-dcp-dev",
                    ["@other/opencode-dcp-slim@latest", { enabled: true }],
                ],
            }),
        );

        const actions = fixConflicts(projectDir, {
            compactionAuto: false,
            compactionPrune: false,
            dcpPlugin: true,
            ...noOmoConflicts,
        });

        const updated = parseJsonc(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
        expect(actions).toEqual([]);
        expect(updated.plugin).toEqual([
            "@some-fork/opencode-dcp-fork",
            "file:///tmp/opencode-dcp-dev",
            ["@other/opencode-dcp-slim@latest", { enabled: true }],
        ]);
    });

    // oh-my-openagent 4.19.0+ uses the unified OMO config format.

    describe("unified OMO config paths", () => {
        const omoConflicts = {
            compactionAuto: false,
            compactionPrune: false,
            dcpPlugin: false,
            omoPreemptiveCompaction: true,
            omoContextWindowMonitor: true,
            omoAnthropicRecovery: true,
        };

        it("disables hooks inside [opencode] block in ~/.omo/omo.jsonc, comments survive, detector confirms", () => {
            const omoDir = join(homeDir, ".omo");
            mkdirSync(omoDir, { recursive: true });
            const configPath = join(omoDir, "omo.jsonc");
            writeFileSync(
                configPath,
                `{
  // top-level comment
  "some-omo-setting": true,
  "[opencode]": {
    "other_setting": "value"
  }
}
`,
            );

            const actions = fixConflicts(projectDir, omoConflicts);

            expect(actions).toEqual(["Disabled conflicting oh-my-opencode hooks"]);

            const updatedText = readFileSync(configPath, "utf-8");
            expect(updatedText).toContain("top-level comment");
            expect(updatedText).toContain("opencode block comment");
            expect(updatedText).toContain("some-omo-setting");

            const updated = parseJsonc(updatedText) as Record<string, unknown>;
            const opencodeBlock = updated["[opencode]"] as Record<string, unknown>;
            expect(opencodeBlock.disabled_hooks).toEqual([
                "context-window-monitor",
                "preemptive-compaction",
                "anthropic-context-window-limit-recovery",
            ]);
            expect(opencodeBlock.other_setting).toBe("value");

            // detectConflicts requires a project-level opencode.json containing the OMO plugin.
            writeFileSync(
                join(projectDir, "opencode.json"),
                JSON.stringify({ plugin: ["oh-my-opencode"] }),
            );
            const result = detectConflicts(projectDir);
            expect(result.conflicts.omoPreemptiveCompaction).toBe(false);
            expect(result.conflicts.omoContextWindowMonitor).toBe(false);
            expect(result.conflicts.omoAnthropicRecovery).toBe(false);
        });

        it("creates [opencode] block when missing in unified omo.jsonc", () => {
            const omoDir = join(homeDir, ".omo");
            mkdirSync(omoDir, { recursive: true });
            const configPath = join(omoDir, "omo.jsonc");
            writeFileSync(
                configPath,
                `{
  "some-omo-setting": true
}
`,
            );

            const actions = fixConflicts(projectDir, omoConflicts);

            expect(actions).toEqual(["Disabled conflicting oh-my-opencode hooks"]);

            const updatedText = readFileSync(configPath, "utf-8");
            expect(updatedText).toContain("top-level setting");

            const updated = parseJsonc(updatedText) as Record<string, unknown>;
            const opencodeBlock = updated["[opencode]"] as Record<string, unknown>;
            expect(opencodeBlock.disabled_hooks).toEqual([
                "context-window-monitor",
                "preemptive-compaction",
                "anthropic-context-window-limit-recovery",
            ]);
        });

        it("writes to project-level .omo/omo.jsonc", () => {
            const omoDir = join(projectDir, ".omo");
            mkdirSync(omoDir, { recursive: true });
            const configPath = join(omoDir, "omo.jsonc");
            writeFileSync(
                configPath,
                JSON.stringify({
                    "[opencode]": {},
                }),
            );

            const actions = fixConflicts(projectDir, omoConflicts);

            expect(actions).toEqual(["Disabled conflicting oh-my-opencode hooks"]);

            const updated = parseJsonc(readFileSync(configPath, "utf-8")) as Record<
                string,
                unknown
            >;
            const opencodeBlock = updated["[opencode]"] as Record<string, unknown>;
            expect(opencodeBlock.disabled_hooks).toEqual([
                "context-window-monitor",
                "preemptive-compaction",
                "anthropic-context-window-limit-recovery",
            ]);
        });

        it("reads omo.json (fallback) when omo.jsonc does not exist", () => {
            const omoDir = join(homeDir, ".omo");
            mkdirSync(omoDir, { recursive: true });
            const configPath = join(omoDir, "omo.json");
            writeFileSync(
                configPath,
                JSON.stringify({
                    "[opencode]": {},
                }),
            );

            const actions = fixConflicts(projectDir, omoConflicts);

            expect(actions).toEqual(["Disabled conflicting oh-my-opencode hooks"]);

            const updated = JSON.parse(readFileSync(configPath, "utf-8"));
            expect(updated["[opencode]"].disabled_hooks).toEqual([
                "context-window-monitor",
                "preemptive-compaction",
                "anthropic-context-window-limit-recovery",
            ]);
        });

        it("updates both legacy and unified config when both exist", () => {
            // The fixer supports project-level oh-my-opencode.json as a legacy configuration format.
            const legacyPath = join(projectDir, "oh-my-opencode.json");
            writeFileSync(legacyPath, JSON.stringify({ disabled_hooks: [] }));

            // Unified: ~/.omo/omo.jsonc
            const omoDir = join(homeDir, ".omo");
            mkdirSync(omoDir, { recursive: true });
            const unifiedPath = join(omoDir, "omo.jsonc");
            writeFileSync(
                unifiedPath,
                JSON.stringify({
                    "[opencode]": {},
                }),
            );

            const actions = fixConflicts(projectDir, omoConflicts);

            expect(actions).toEqual(["Disabled conflicting oh-my-opencode hooks"]);

            // The legacy configuration stores disabled_hooks at the top level.
            const legacy = JSON.parse(readFileSync(legacyPath, "utf-8"));
            expect(legacy.disabled_hooks).toEqual([
                "context-window-monitor",
                "preemptive-compaction",
                "anthropic-context-window-limit-recovery",
            ]);

            // The unified configuration stores disabled_hooks in the [opencode] block.
            const unified = JSON.parse(readFileSync(unifiedPath, "utf-8"));
            expect(unified["[opencode]"].disabled_hooks).toEqual([
                "context-window-monitor",
                "preemptive-compaction",
                "anthropic-context-window-limit-recovery",
            ]);
        });

        it("skips non-existent unified paths (no create)", () => {
            // Without a .omo directory, the fixer finds no targets.
            const actions = fixConflicts(projectDir, omoConflicts);
            expect(actions).toEqual([]);
        });
    });

    describe("compaction-off mode parity (issue #266)", () => {
        it("does NOT flip compaction.auto to false when compaction-off", () => {
            const configPath = join(projectDir, "opencode.jsonc");
            const original = `{
  // keep comment
  "compaction": {
    "auto": true,
    "prune": true
  }
}
`;
            writeFileSync(configPath, original);

            const actions = fixConflicts(
                projectDir,
                {
                    compactionAuto: true,
                    compactionPrune: true,
                    dcpPlugin: false,
                    ...noOmoConflicts,
                },
                { compactionEnabled: false },
            );

            expect(actions).toEqual([]);
            expect(readFileSync(configPath, "utf-8")).toBe(original);
        });

        it("still removes DCP plugin in compaction-off mode (DCP policy is mode-independent)", () => {
            const configPath = join(projectDir, "opencode.jsonc");
            writeFileSync(
                configPath,
                JSON.stringify({
                    plugin: ["@tarquinen/opencode-dcp@latest"],
                    compaction: { auto: true, prune: true },
                }),
            );

            const actions = fixConflicts(
                projectDir,
                { compactionAuto: true, compactionPrune: true, dcpPlugin: true, ...noOmoConflicts },
                { compactionEnabled: false },
            );

            expect(actions).toEqual(["Removed opencode-dcp plugin"]);
            const updated = parseJsonc(readFileSync(configPath, "utf-8")) as Record<
                string,
                unknown
            >;
            expect(updated.compaction).toEqual({ auto: true, prune: true });
            expect(updated.plugin).toEqual([]);
        });

        it("still disables OMO hooks in compaction-off mode (OMO policy is mode-independent)", () => {
            const configPath = join(projectDir, "opencode.json");
            writeFileSync(configPath, JSON.stringify({ plugin: ["oh-my-opencode"] }));
            const omoDir = join(homeDir, ".omo");
            mkdirSync(omoDir, { recursive: true });
            const omoPath = join(omoDir, "omo.jsonc");
            writeFileSync(omoPath, JSON.stringify({ "[opencode]": {} }));

            const actions = fixConflicts(
                projectDir,
                {
                    compactionAuto: false,
                    compactionPrune: false,
                    dcpPlugin: false,
                    omoPreemptiveCompaction: true,
                    omoContextWindowMonitor: true,
                    omoAnthropicRecovery: true,
                },
                { compactionEnabled: false },
            );

            expect(actions).toEqual(["Disabled conflicting oh-my-opencode hooks"]);
        });

        it("mutation direction: same conflict IS repaired when mode forced on", () => {
            const configPath = join(projectDir, "opencode.jsonc");
            writeFileSync(configPath, JSON.stringify({ compaction: { auto: true, prune: true } }));

            const offActions = fixConflicts(
                projectDir,
                {
                    compactionAuto: true,
                    compactionPrune: true,
                    dcpPlugin: false,
                    ...noOmoConflicts,
                },
                { compactionEnabled: false },
            );
            const onActions = fixConflicts(
                projectDir,
                {
                    compactionAuto: true,
                    compactionPrune: true,
                    dcpPlugin: false,
                    ...noOmoConflicts,
                },
                { compactionEnabled: true },
            );

            expect(offActions).toEqual([]);
            expect(onActions).toEqual(["Disabled auto-compaction"]);
            const updated = parseJsonc(readFileSync(configPath, "utf-8")) as Record<
                string,
                unknown
            >;
            expect(updated.compaction).toEqual({ auto: false, prune: false });
        });
    });

    describe("JSONC byte preservation", () => {
        it("removes DCP and disables compaction without changing comments or formatting elsewhere", () => {
            const configPath = join(projectDir, "opencode.jsonc");
            const original =
                "// leading file comment\r\n" +
                "{\r\n" +
                '\t"plugin": [\r\n' +
                "\t\t// first plugin comment\r\n" +
                '\t\t"@keep/first",\r\n' +
                "\t\t// removed DCP comment\r\n" +
                '\t\t"@tarquinen/opencode-dcp@latest",\r\n' +
                "\t\t// second plugin comment\r\n" +
                '\t\t"@keep/second",\r\n' +
                "\t], // trailing array comment\r\n" +
                '\t"compaction": {\r\n' +
                "\t\t// nested compaction comment\r\n" +
                '\t\t"auto": true,\r\n' +
                '\t\t"prune": true,\r\n' +
                "\t},\r\n" +
                '\t"theme": "dark",\r\n' +
                "}\r\n";
            const expected =
                "// leading file comment\r\n" +
                "{\r\n" +
                '\t"plugin": [\r\n' +
                "\t\t// first plugin comment\r\n" +
                '\t\t"@keep/first",\r\n' +
                "\t\t// second plugin comment\r\n" +
                '\t\t"@keep/second",\r\n' +
                "\t], // trailing array comment\r\n" +
                '\t"compaction": {\r\n' +
                "\t\t// nested compaction comment\r\n" +
                '\t\t"auto": false,\r\n' +
                '\t\t"prune": false,\r\n' +
                "\t},\r\n" +
                '\t"theme": "dark",\r\n' +
                "}\r\n";
            writeFileSync(configPath, original);

            const actions = fixConflicts(projectDir, {
                compactionAuto: true,
                compactionPrune: true,
                dcpPlugin: true,
                ...noOmoConflicts,
            });

            expect(actions).toEqual(["Disabled auto-compaction", "Removed opencode-dcp plugin"]);
            expect(readFileSync(configPath, "utf-8")).toBe(expected);
            expect(readFileSync(configPath, "utf-8")).not.toContain("removed DCP comment");
        });

        it("keeps each survivor's own comment when removing a middle plugin entry", () => {
            const configPath = join(projectDir, "opencode.jsonc");
            const original = `{
    "plugin": [
        // first plugin
        "@keep/first",
        // removed plugin
        "@tarquinen/opencode-dcp@latest",
        // second plugin
        "@keep/second",
    ],
    "theme": "dark",
}
`;
            const expected = `{
    "plugin": [
        // first plugin
        "@keep/first",
        // second plugin
        "@keep/second",
    ],
    "theme": "dark",
}
`;
            writeFileSync(configPath, original);

            fixConflicts(projectDir, {
                compactionAuto: false,
                compactionPrune: false,
                dcpPlugin: true,
                ...noOmoConflicts,
            });

            expect(readFileSync(configPath, "utf-8")).toBe(expected);
        });

        it("preserves CRLF and the array's trailing comment when DCP is the final entry", () => {
            const configPath = join(projectDir, "opencode.jsonc");
            const original =
                "{\r\n" +
                '\t"plugin": [\r\n' +
                "\t\t// surviving plugin\r\n" +
                '\t\t"@keep/first",\r\n' +
                "\t\t// removed final plugin\r\n" +
                '\t\t"@tarquinen/opencode-dcp@latest",\r\n' +
                "\t], // array trailing comment\r\n" +
                "}\r\n";
            const expected =
                "{\r\n" +
                '\t"plugin": [\r\n' +
                "\t\t// surviving plugin\r\n" +
                '\t\t"@keep/first"\r\n' +
                "\t], // array trailing comment\r\n" +
                "}\r\n";
            writeFileSync(configPath, original);

            fixConflicts(projectDir, {
                compactionAuto: false,
                compactionPrune: false,
                dcpPlugin: true,
                ...noOmoConflicts,
            });

            expect(readFileSync(configPath, "utf-8")).toBe(expected);
        });

        it("leaves an already conflict-free config byte-identical", () => {
            const configPath = join(projectDir, "opencode.jsonc");
            const original = '// preserve every byte\r\n{\r\n\t"plugin": ["@keep/one",],\r\n}\r\n';
            writeFileSync(configPath, original);

            const actions = fixConflicts(projectDir, {
                compactionAuto: false,
                compactionPrune: false,
                dcpPlugin: true,
                ...noOmoConflicts,
            });

            expect(actions).toEqual([]);
            expect(readFileSync(configPath, "utf-8")).toBe(original);
        });

        it("appends OMO hooks without reformatting the existing JSONC", () => {
            const omoDir = join(homeDir, ".omo");
            mkdirSync(omoDir, { recursive: true });
            const configPath = join(omoDir, "omo.jsonc");
            const original = `{
    // The fixer preserves this leading comment.
    "[opencode]": {
        "disabled_hooks": [
            // The fixer preserves this custom-hook comment.
            "custom-hook",
        ], // preserve this array comment
    },
}
`;
            const expected = `{
    // The fixer preserves this leading comment.
    "[opencode]": {
        "disabled_hooks": [
            // The fixer preserves this custom-hook comment.
            "custom-hook",
            "context-window-monitor",
        ], // preserve this array comment
    },
}
`;
            writeFileSync(configPath, original);

            const actions = fixConflicts(projectDir, {
                compactionAuto: false,
                compactionPrune: false,
                dcpPlugin: false,
                omoPreemptiveCompaction: false,
                omoContextWindowMonitor: true,
                omoAnthropicRecovery: false,
            });

            expect(actions).toEqual(["Disabled conflicting oh-my-opencode hooks"]);
            expect(readFileSync(configPath, "utf-8")).toBe(expected);
        });
    });
});
