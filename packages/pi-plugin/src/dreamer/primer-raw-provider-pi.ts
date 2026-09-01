import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import { convertEntriesToRawMessages } from "../read-session-pi";
import { loadDefaultPiSessionApi } from "./pi-session-api";

/**
 *
 */
export interface PiPrimerRawProviderDeps {
	listSessions?: (sessionDir?: string) => unknown[] | Promise<unknown[]>;
	loadEntriesFromFile?: (filePath: string) => unknown[] | Promise<unknown[]>;
	sessionDir?: string;
}

interface PiSessionInfoLike {
	id?: unknown;
	path?: unknown;
}

export function createPiPrimerRawProviderFactory(
	deps: PiPrimerRawProviderDeps = {},
): (sessionId: string) => Promise<RawMessageProvider | null> {
	let resolved: Promise<
		Required<
			Pick<PiPrimerRawProviderDeps, "listSessions" | "loadEntriesFromFile">
		>
	> | null = null;

	const resolveDeps = async () => {
		if (deps.listSessions && deps.loadEntriesFromFile) {
			return {
				listSessions: deps.listSessions,
				loadEntriesFromFile: deps.loadEntriesFromFile,
			};
		}
		resolved ??= loadDefaultPiSessionApi();
		return resolved;
	};

	return async (sessionId: string): Promise<RawMessageProvider | null> => {
		try {
			const { listSessions, loadEntriesFromFile } = await resolveDeps();
			const sessions = (await listSessions(
				deps.sessionDir,
			)) as PiSessionInfoLike[];
			const match = sessions.find(
				(s) =>
					s &&
					typeof s === "object" &&
					s.id === sessionId &&
					typeof s.path === "string",
			);
			if (!match || typeof match.path !== "string") return null;
			const entries = await loadEntriesFromFile(match.path);
			const messages = convertEntriesToRawMessages(entries);
			if (messages.length === 0) return null;
			return {
				readMessages(): RawMessage[] {
					return messages;
				},
				getMessageCount() {
					return messages.length;
				},
			};
		} catch {
			return null;
		}
	};
}
