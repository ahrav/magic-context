import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 *
 */
export interface PiSessionApi {
	listSessions: (sessionDir?: string) => unknown[] | Promise<unknown[]>;
	loadEntriesFromFile: (filePath: string) => unknown[] | Promise<unknown[]>;
}

const PI_CODING_AGENT_MODULE = "@earendil-works/pi-coding-agent";

export interface ModuleLoader {
	name: string;
	load: () => Promise<unknown>;
}

const defaultLoaders: ModuleLoader[] = [
	{
		name: "Bare import",
		load: async () => await import(/* @vite-ignore */ PI_CODING_AGENT_MODULE),
	},
	{
		name: "Resolve from running Pi binary entry",
		load: async () => {
			if (!process.argv[1]) {
				throw new Error("process.argv[1] is undefined");
			}
			const require = createRequire(process.argv[1]);
			const resolved = require.resolve(PI_CODING_AGENT_MODULE);
			return await import(pathToFileURL(resolved).href);
		},
	},
];

let cachedModulePromise: Promise<unknown> | null = null;

export function clearCachedModule(): void {
	cachedModulePromise = null;
}

async function resolvePiCodingAgentModule(
	loaders?: ModuleLoader[],
): Promise<unknown> {
	if (cachedModulePromise) {
		return cachedModulePromise;
	}

	const activeLoaders = loaders ?? defaultLoaders;
	const promise = (async () => {
		const errors: Error[] = [];
		for (const loader of activeLoaders) {
			try {
				return await loader.load();
			} catch (err: unknown) {
				errors.push(err as Error);
			}
		}
		throw new Error(
			`Failed to resolve ${PI_CODING_AGENT_MODULE} via all strategies:\n` +
				errors
					.map((e, i) => `  - ${activeLoaders[i].name}: ${e.message || e}`)
					.join("\n") +
				"\nLikely cause: symlinked or nonstandard install layout.",
		);
	})();

	cachedModulePromise = promise;
	promise.catch(() => {
		if (cachedModulePromise === promise) {
			cachedModulePromise = null;
		}
	});

	return promise;
}

export async function loadDefaultPiSessionApi(
	loaders?: ModuleLoader[],
): Promise<PiSessionApi> {
	const mod = (await resolvePiCodingAgentModule(loaders)) as {
		SessionManager?: {
			listAll?: (sessionDir?: string) => unknown[] | Promise<unknown[]>;
		};
		loadEntriesFromFile?: (filePath: string) => unknown[] | Promise<unknown[]>;
		parseSessionEntries?: (content: string) => unknown[];
	};
	const listSessions = mod.SessionManager?.listAll;
	if (typeof listSessions !== "function") {
		throw new Error(
			"Pi session APIs unavailable: expected SessionManager.listAll on pi-coding-agent",
		);
	}
	const loadEntriesFromFile: PiSessionApi["loadEntriesFromFile"] =
		mod.loadEntriesFromFile ??
		((filePath: string) => {
			const content = readFileSync(filePath, "utf8");
			return mod.parseSessionEntries?.(content) ?? [];
		});
	return {
		listSessions: listSessions.bind(mod.SessionManager),
		loadEntriesFromFile,
	};
}
