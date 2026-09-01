import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe("ensureTuiPluginEntry", () => {
    it("preserves tuple dev-path plugin entry and does not add @latest", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-tui-"));
        roots.push(root);
        const devPath = "/Work/magic-context/packages/plugin";
        const tuiPath = join(root, "tui.json");
        writeFileSync(
            tuiPath,
            `${JSON.stringify({ plugin: [[devPath, { sidebar: true }], "other-plugin"] }, null, 2)}\n`,
        );

        const { ensureTuiPluginEntry } = await import("./tui-config");
        const changed = ensureTuiPluginEntry({ configDir: root });
        expect(changed).toBe(false);
        const parsed = JSON.parse(readFileSync(tuiPath, "utf-8")) as { plugin: unknown[] };
        expect(parsed.plugin).toHaveLength(2);
        expect(Array.isArray(parsed.plugin[0])).toBe(true);
        expect((parsed.plugin[0] as unknown[])[0]).toBe(devPath);
        expect(parsed.plugin[1]).toBe("other-plugin");
        expect(existsSync(`${tuiPath}.tmp`)).toBe(false);
    });

    it("upgrades bare npm name to @latest while preserving tuple options", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-tui-npm-"));
        roots.push(root);
        const tuiPath = join(root, "tui.json");
        writeFileSync(
            tuiPath,
            `${JSON.stringify(
                {
                    plugin: [["@cortexkit/opencode-magic-context", { enabled: true }]],
                },
                null,
                2,
            )}\n`,
        );

        const { ensureTuiPluginEntry } = await import("./tui-config");
        expect(ensureTuiPluginEntry({ configDir: root })).toBe(true);
        const parsed = JSON.parse(readFileSync(tuiPath, "utf-8")) as { plugin: unknown[] };
        const entry = parsed.plugin[0] as unknown[];
        expect(entry[0]).toBe("@cortexkit/opencode-magic-context@latest");
        expect(entry[1]).toEqual({ enabled: true });
    });

    it("creates tui.jsonc (not tui.json) on a fresh install", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-tui-fresh-"));
        roots.push(root);

        const { ensureTuiPluginEntry } = await import("./tui-config");
        expect(ensureTuiPluginEntry({ configDir: root })).toBe(true);

        // Creating tui.jsonc avoids leaving a tui.json stub beside a later tui.jsonc.
        expect(existsSync(join(root, "tui.jsonc"))).toBe(true);
        expect(existsSync(join(root, "tui.json"))).toBe(false);
        const parsed = JSON.parse(readFileSync(join(root, "tui.jsonc"), "utf-8")) as {
            plugin: unknown[];
        };
        expect(parsed.plugin).toContain("@cortexkit/opencode-magic-context@latest");
    });

    it("writes into the existing tui.jsonc when both files exist", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-tui-both-"));
        roots.push(root);
        writeFileSync(
            join(root, "tui.jsonc"),
            `${JSON.stringify({ keybinds: { x: "y" } }, null, 2)}\n`,
        );
        writeFileSync(join(root, "tui.json"), "{}\n");

        const { ensureTuiPluginEntry } = await import("./tui-config");
        expect(ensureTuiPluginEntry({ configDir: root })).toBe(true);

        // tui.jsonc takes precedence over tui.json.
        const jsonc = JSON.parse(readFileSync(join(root, "tui.jsonc"), "utf-8")) as {
            plugin: unknown[];
            keybinds: Record<string, string>;
        };
        expect(jsonc.plugin).toContain("@cortexkit/opencode-magic-context@latest");
        expect(jsonc.keybinds).toEqual({ x: "y" });
        expect(readFileSync(join(root, "tui.json"), "utf-8")).toBe("{}\n");
    });
});
