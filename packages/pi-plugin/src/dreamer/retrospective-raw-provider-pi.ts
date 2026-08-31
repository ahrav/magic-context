import { resolve } from "node:path";

import type {
	RetrospectiveProjectSession,
	RetrospectiveRawMessage,
	RetrospectiveRawProvider,
	RetrospectiveSinceRead,
} from "@magic-context/core/features/magic-context/dreamer/retrospective-raw-provider";
import { loadDefaultPiSessionApi } from "./pi-session-api";

interface PiSessionInfoLike {
	id?: unknown;
	path?: unknown;
	cwd?: unknown;
	modified?: unknown;
}

interface PiMessageEntryLike {
	type?: unknown;
	id?: unknown;
	message?: unknown;
}

interface PiUserMessageLike {
	role?: unknown;
	timestamp?: unknown;
	content?: unknown;
}

export interface PiRetrospectiveRawProviderDeps {
	projectCwd: string;
	sessionDir?: string;
	listSessions?: (sessionDir?: string) => unknown[] | Promise<unknown[]>;
	loadEntriesFromFile?: (filePath: string) => unknown[] | Promise<unknown[]>;
}

export class PiRetrospectiveRawProvider implements RetrospectiveRawProvider {
	private readonly sessionPathById = new Map<string, string>();
	private resolvedDefaultDeps: Promise<
		Required<
			Pick<
				PiRetrospectiveRawProviderDeps,
				"listSessions" | "loadEntriesFromFile"
			>
		>
	> | null = null;

	constructor(private readonly deps: PiRetrospectiveRawProviderDeps) {}

	async listProjectSessions(
		_projectIdentity: string,
	): Promise<RetrospectiveProjectSession[]> {
		const deps = await this.resolveDeps();
		const sessions = await deps.listSessions(this.deps.sessionDir);
		const projectCwd = resolve(this.deps.projectCwd);
		const result: RetrospectiveProjectSession[] = [];
		this.sessionPathById.clear();

		for (const raw of sessions) {
			const info = raw as PiSessionInfoLike | null;
			if (!info || typeof info !== "object") continue;
			if (typeof info.id !== "string" || typeof info.path !== "string")
				continue;
			if (typeof info.cwd !== "string" || resolve(info.cwd) !== projectCwd)
				continue;

			this.sessionPathById.set(info.id, info.path);
			result.push({
				sessionId: info.id,
				path: info.path,
				updatedAt:
					typeof info.modified === "number" ? info.modified : undefined,
			});
		}

		return result.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
	}

	async readUserMessagesSince(
		sessionId: string,
		sinceMs: number,
		capPerSession: number,
	): Promise<RetrospectiveSinceRead> {
		const all = await this.loadUserEntries(sessionId);
		// Keeping the oldest eligible messages lets the watermark advance without skipping backlog entries.
		const limit = Math.max(1, Math.floor(capPerSession));
		const eligible = all
			.filter((entry) => entry.ts > sinceMs)
			.sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);
		return {
			messages: eligible.slice(0, limit),
			truncated: eligible.length > limit,
		};
	}

	async readOldestMessageTimesSince(
		sessionIds: readonly string[],
		sinceMs: number,
	): Promise<Map<string, number>> {
		const out = new Map<string, number>();
		for (const sessionId of sessionIds) {
			const oldest = (await this.loadUserEntries(sessionId))
				.filter((message) => message.ts > sinceMs)
				.sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal)[0];
			if (oldest) out.set(sessionId, oldest.ts);
		}
		return out;
	}

	async readUserMessagesBefore(
		sessionId: string,
		beforeMs: number,
		count: number,
	): Promise<RetrospectiveRawMessage[]> {
		const all = await this.loadUserEntries(sessionId);
		return all
			.filter((entry) => entry.ts <= beforeMs)
			.sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal)
			.slice(-Math.max(1, Math.floor(count)));
	}

	private async loadUserEntries(
		sessionId: string,
	): Promise<RetrospectiveRawMessage[]> {
		const filePath = this.sessionPathById.get(sessionId);
		if (!filePath) return [];
		const deps = await this.resolveDeps();
		let entries: unknown[];
		try {
			entries = await deps.loadEntriesFromFile(filePath);
		} catch {
			return [];
		}
		if (!Array.isArray(entries)) return [];
		return entries
			.map((entry, index) => normalizePiUserEntry(entry, sessionId, index + 1))
			.filter((entry): entry is RetrospectiveRawMessage => entry !== null);
	}

	private async resolveDeps(): Promise<
		Required<
			Pick<
				PiRetrospectiveRawProviderDeps,
				"listSessions" | "loadEntriesFromFile"
			>
		>
	> {
		if (this.deps.listSessions && this.deps.loadEntriesFromFile) {
			return {
				listSessions: this.deps.listSessions,
				loadEntriesFromFile: this.deps.loadEntriesFromFile,
			};
		}
		this.resolvedDefaultDeps ??= loadDefaultPiSessionApi();
		return this.resolvedDefaultDeps;
	}
}

function normalizePiUserEntry(
	entry: unknown,
	sessionId: string,
	ordinal: number,
): RetrospectiveRawMessage | null {
	const e = entry as PiMessageEntryLike | null;
	if (!e || typeof e !== "object" || e.type !== "message") return null;
	const message = e.message as PiUserMessageLike | null;
	if (!message || typeof message !== "object") return null;
	if (message.role !== "user" || typeof message.timestamp !== "number")
		return null;
	const text = extractPiTextContent(message.content).trim();
	if (!text) return null;
	return {
		sessionId,
		ordinal,
		role: "user",
		text,
		ts: message.timestamp,
	};
}

function extractPiTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (part === null || typeof part !== "object") return [];
			const record = part as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string"
				? [record.text]
				: [];
		})
		.join("\n");
}
