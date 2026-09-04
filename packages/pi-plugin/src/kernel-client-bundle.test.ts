import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

/** The `build` script's externals, so the bundle under test resolves the way the shipped one does. */
const EXTERNALS = [
	"@cortexkit/mc-shm-native",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@huggingface/transformers",
	"node:sqlite",
];

/** The shared client Pi imports through the `@magic-context/core/*` alias. */
const CLIENT_ENTRY = resolve(
	import.meta.dir,
	"../../plugin/src/shared/kernel-client/index.ts",
);
const PI_ENTRY = resolve(import.meta.dir, "kernel-client-pi.ts");

/** The `build` script's real entry points, asserted only to bundle: both reach claim storage through sanctioned lanes (the claim-lane importer, the historian's lane staging, and the `kernel-claim-usage` retrieval-telemetry bridge), so a no-storage-claim scan over them fails on code the ban permits. The reachability invariant this file owns is narrower: the shared kernel client and Pi's client resolver stay free of SQLite bindings and claim storage, because they are the modules that must load where no database exists. commentlint: allow(JUDGE) */
const BUILD_ENTRIES = ["src/index.ts", "src/subagent-entry.ts"].map((entry) =>
	resolve(import.meta.dir, "..", entry),
);

async function bundle(entry: string): Promise<{ success: boolean; text: string }> {
	const result = await Bun.build({
		entrypoints: [entry],
		target: "node",
		format: "esm",
		external: EXTERNALS,
		write: false,
	});
	const texts = await Promise.all(result.outputs.map((output) => output.text()));
	return { success: result.success, text: texts.join("\n") };
}

async function bundleText(entry: string): Promise<string> {
	const { success, text } = await bundle(entry);
	expect(success).toBe(true);
	return text;
}

/** Reports which specifiers a bundle names without echoing the bundle into a failure message. The scan reads unminified `Bun.build` output, where module paths survive as per-module comments and external import specifiers; a minified or path-rewritten bundle would defeat it, so the in-test build stays unminified even if the shipped one changes. commentlint: allow(JUDGE) */
function specifiersFound(text: string, specifiers: readonly string[]): string[] {
	return specifiers.filter((specifier) => text.includes(specifier));
}

describe("Pi kernel-client bundle reachability", () => {
	it("reaches no SQLite binding or claim storage from the kernel-client entry", async () => {
		const text = await bundleText(CLIENT_ENTRY);
		expect(
			specifiersFound(text, [
				"node:sqlite",
				"bun:sqlite",
				"better-sqlite3",
				"storage-claim",
			]),
		).toEqual([]);
	});

	it("reaches no claim storage from Pi's resolver and leaves the native host module external", async () => {
		const text = await bundleText(PI_ENTRY);
		expect(specifiersFound(text, ["storage-claim"])).toEqual([]);
		expect(text).toMatch(/from\s+["']@cortexkit\/mc-shm-native["']/);
	});

	it("the shipped entry points bundle under the build script's externals", async () => {
		for (const entry of BUILD_ENTRIES) {
			const { success } = await bundle(entry);
			expect(success).toBe(true);
		}
	});
});
