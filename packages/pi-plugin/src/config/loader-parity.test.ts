import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginConfigDetailed } from "@magic-context/core/config/index";
import { loadPiConfigDetailed } from "./index";

/**
 * Loader parity: the OpenCode and Pi harnesses read the same
 * `cortexkit/magic-context.jsonc` files through two loader implementations.
 * Each fixture is written once and loaded by both; the effective config,
 * per-source outcomes, substitution failures, and recovered keys must agree,
 * or one harness silently applies a different configuration (including the
 * project-tier security stripping) than the other.
 */

let root: string;
let projectDir: string;
const savedEnv: Record<string, string | undefined> = {};

function writeUserConfig(text: string): void {
	const dir = join(root, "config", "cortexkit");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "magic-context.jsonc"), text);
}

function writeProjectConfig(text: string): void {
	const dir = join(projectDir, ".cortexkit");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "magic-context.jsonc"), text);
}

/** Both loaders over the same on-disk state, projected to the shared surface. */
function loadBoth() {
	const plugin = loadPluginConfigDetailed(projectDir);
	const pi = loadPiConfigDetailed({ cwd: projectDir });
	const pluginShared: Record<string, unknown> = { ...plugin.config };
	// Plugin-only extensions outside the shared MagicContextConfig surface.
	delete pluginShared.disabled_hooks;
	delete pluginShared.command;
	delete pluginShared.configWarnings;
	const piShared: Record<string, unknown> = { ...pi.config };
	delete piShared.configWarnings;
	return { plugin, pi, pluginShared, piShared };
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mc-loader-parity-"));
	projectDir = join(root, "project");
	mkdirSync(projectDir, { recursive: true });
	for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "HOME"]) {
		savedEnv[key] = process.env[key];
	}
	process.env.XDG_CONFIG_HOME = join(root, "config");
	process.env.XDG_DATA_HOME = join(root, "data");
	process.env.HOME = join(root, "home");
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

describe("config loader parity (OpenCode vs Pi)", () => {
	it("agrees on a well-formed JSONC config with comments and trailing commas", () => {
		writeUserConfig(`{
			// user tier
			"language": "pt",
			"execute_threshold_percentage": 70,
			"memory": {
				"enabled": true, /* inline */
			},
			"prompt_surface": {
				"guidance_override_path": "// not a comment /* neither */",
			},
		}`);
		const { plugin, pi, pluginShared, piShared } = loadBoth();
		expect(piShared).toEqual(pluginShared);
		// Comment markers inside a retained string value must survive both
		// grammars verbatim.
		expect(pi.config.prompt_surface?.guidance_override_path).toBe(
			"// not a comment /* neither */",
		);
		expect(pi.loadOutcome).toBe(plugin.loadOutcome);
		expect(pi.sources).toEqual(plugin.sources);
		expect(pi.substitutionFailures).toEqual(plugin.substitutionFailures);
		expect(pi.recoveredTopLevelKeys).toEqual(plugin.recoveredTopLevelKeys);
	});

	it("agrees on prototype-pollution rejection in both tiers", () => {
		writeUserConfig(`{
			"__proto__": { "polluted": true },
			"memory": { "constructor": { "x": 1 }, "enabled": true },
			"language": "pt"
		}`);
		writeProjectConfig(`{
			"prototype": { "y": 2 },
			"dreamer": { "__proto__": { "z": 3 } }
		}`);
		const { plugin, pi, pluginShared, piShared } = loadBoth();
		expect(piShared).toEqual(pluginShared);
		expect(pi.loadOutcome).toBe(plugin.loadOutcome);
		// Key rejection surfaces on the per-source outcome (the combined
		// outcome reflects Zod field recovery, not parse-time key rejection).
		expect(pi.sources.userConfig).toBe("schema-recovery");
		expect(plugin.sources.userConfig).toBe("schema-recovery");
		expect(pi.sources).toEqual(plugin.sources);
		// The rejected-key hook's observable output must fire on BOTH sides
		// for every planted pollution key.
		const pluginWarnings = plugin.config.configWarnings ?? [];
		for (const rejected of [
			"__proto__",
			"memory.constructor",
			"prototype",
			"dreamer.__proto__",
		]) {
			const needle = `Ignored unsafe config key "${rejected}"`;
			expect(
				pi.warnings.some((warning) => warning.includes(needle)),
				`pi missing ${needle}`,
			).toBe(true);
			expect(
				pluginWarnings.some((warning) => warning.includes(needle)),
				`plugin missing ${needle}`,
			).toBe(true);
		}
		expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
	});

	it("agrees on project-tier security stripping", () => {
		writeUserConfig(`{ "language": "pt" }`);
		writeProjectConfig(`{
			"language": "tr",
			"auto_update": false,
			"allow_home_project": true,
			"execute_threshold_percentage": 5
		}`);
		const { plugin, pi, pluginShared, piShared } = loadBoth();
		expect(piShared).toEqual(pluginShared);
		// The user tier wins over stripped project keys on both sides.
		expect(pi.config.language).toBe("pt");
		expect(plugin.config.language).toBe("pt");
	});

	it("agrees on substitution failures", () => {
		writeUserConfig(`{
			"note_text": "{env:MC_PARITY_UNSET_VARIABLE_XYZ}"
		}`);
		const { plugin, pi, pluginShared, piShared } = loadBoth();
		expect(piShared).toEqual(pluginShared);
		expect(pi.loadOutcome).toBe(plugin.loadOutcome);
		expect(pi.substitutionFailures.map((f) => f.keyPath)).toEqual(
			plugin.substitutionFailures.map((f) => f.keyPath),
		);
	});

	it("agrees on an unparseable config file", () => {
		writeUserConfig(`{ "language": `);
		const { plugin, pi, pluginShared, piShared } = loadBoth();
		expect(piShared).toEqual(pluginShared);
		expect(pi.loadOutcome).toBe(plugin.loadOutcome);
		expect(pi.sources).toEqual(plugin.sources);
	});

	it("agrees on schema recovery for invalid field values", () => {
		writeUserConfig(`{
			"execute_threshold_percentage": "not-a-number",
			"language": "pt"
		}`);
		const { plugin, pi, pluginShared, piShared } = loadBoth();
		expect(piShared).toEqual(pluginShared);
		expect(pi.loadOutcome).toBe(plugin.loadOutcome);
		expect(pi.recoveredTopLevelKeys).toEqual(plugin.recoveredTopLevelKeys);
	});
});
