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

async function bundleText(entry: string): Promise<string> {
	const result = await Bun.build({
		entrypoints: [entry],
		target: "node",
		format: "esm",
		external: EXTERNALS,
		write: false,
	});
	expect(result.success).toBe(true);
	const texts = await Promise.all(result.outputs.map((output) => output.text()));
	return texts.join("\n");
}

/** Reports which specifiers a bundle names without echoing the bundle into a failure message. */
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
});
