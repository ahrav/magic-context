import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	bundleModuleGraph,
	reachableModules,
} from "@magic-context/core/shared/kernel-client-testing/module-graph";

/** The shared client Pi imports through the `@magic-context/core/*` alias. */
const CLIENT_ENTRY = resolve(
	import.meta.dir,
	"../../plugin/src/shared/kernel-client/index.ts",
);
const PI_ENTRY = resolve(import.meta.dir, "kernel-client-pi.ts");
const CLAIM_STORAGE = resolve(
	import.meta.dir,
	"../../plugin/src/features/magic-context/memory/storage-claim-applicability.ts",
);
const CLAIM_STORAGE_PATTERN = /storage-claim/;
/** The runtime-selected sqlite adapter, whose backend specifiers are concatenated at runtime and so never appear as import edges. */
const SQLITE_ADAPTER = resolve(import.meta.dir, "../../plugin/src/shared/sqlite.ts");
/** A binding left external (`node:sqlite`, `bun:sqlite`, `better-sqlite3`) or a source module under a `sqlite` path segment. */
const SQLITE_PATTERN =
	/(?:^|\/)(?:node:sqlite|bun:sqlite|better-sqlite3)(?:$|\/)|\/sqlite(?:\.|-|\/)/;

/** The `build` script's real entry points, asserted only to bundle: both reach claim storage through sanctioned lanes (the claim-lane importer, the historian's lane staging, and the `kernel-claim-usage` retrieval-telemetry bridge), so a no-storage-claim scan over them fails on code the ban permits. The reachability invariant this file owns is narrower: the shared kernel client and Pi's client resolver stay free of SQLite bindings and claim storage, because they are the modules that must load where no database exists. commentlint: allow(JUDGE) */
const BUILD_ENTRIES = ["src/index.ts", "src/subagent-entry.ts"].map((entry) =>
	resolve(import.meta.dir, "..", entry),
);

/** The graph of a throwaway entry that imports `specifier`: the positive control for a reachability check. */
async function graphOfEntryImporting(specifier: string) {
	const directory = mkdtempSync(join(tmpdir(), "mc-bundle-positive-control-"));
	try {
		const entry = join(directory, "entry.ts");
		writeFileSync(
			entry,
			`import * as m from ${JSON.stringify(specifier)};\nexport const keep = Object.keys(m).length;\n`,
		);
		return await bundleModuleGraph(entry);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("Pi kernel-client bundle reachability", () => {
	it("reaches no SQLite binding or claim storage from the kernel-client entry", async () => {
		const graph = await bundleModuleGraph(CLIENT_ENTRY);
		expect(graph.inputs.length).toBeGreaterThan(0);
		expect(reachableModules(graph, SQLITE_PATTERN)).toEqual([]);
		expect(reachableModules(graph, CLAIM_STORAGE_PATTERN)).toEqual([]);
	});

	it("reaches no claim storage from Pi's resolver and leaves the native host module external", async () => {
		const graph = await bundleModuleGraph(PI_ENTRY);
		expect(graph.inputs.length).toBeGreaterThan(0);
		expect(reachableModules(graph, CLAIM_STORAGE_PATTERN)).toEqual([]);
		expect(graph.text).toMatch(/from\s+["']@cortexkit\/mc-shm-native["']/);
	});

	it("the reachability check fails on an entry that imports claim storage", async () => {
		const graph = await graphOfEntryImporting(CLAIM_STORAGE);
		expect(reachableModules(graph, CLAIM_STORAGE_PATTERN)).not.toEqual([]);
	});

	it("the reachability check fails on an entry that imports a sqlite binding or the sqlite adapter", async () => {
		const external = await graphOfEntryImporting("node:sqlite");
		expect(reachableModules(external, SQLITE_PATTERN)).toEqual(["node:sqlite"]);
		const adapter = await graphOfEntryImporting(SQLITE_ADAPTER);
		expect(reachableModules(adapter, SQLITE_PATTERN)).toEqual([
			expect.stringMatching(/\/shared\/sqlite\.ts$/),
		]);
	});

	it("the shipped entry points bundle under the build script's externals", async () => {
		for (const entry of BUILD_ENTRIES) {
			const graph = await bundleModuleGraph(entry);
			expect(graph.inputs.length).toBeGreaterThan(0);
		}
	});
});
