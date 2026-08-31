import { readFile } from "node:fs/promises";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	type CloneCompartmentRow,
	type CloneSessionStateFilter,
	type CloneTagRow,
	type CopySessionStateForCloneResult,
	copySessionStateForClone,
	type PendingPiCompactionMarker,
} from "@magic-context/core/features/magic-context/storage";
import { log } from "@magic-context/core/shared/logger";
import { convertEntriesToRawMessages } from "./read-session-pi";

const CONTENT_ID_SUFFIX = /:(?:p|file)\d+$/;

type SessionManagerLike = {
	getSessionId?: () => string | undefined;
	getBranch?: () => unknown[];
};

type CloneContextLike = { sessionManager?: SessionManagerLike };
type CloneStartEventLike = { reason?: unknown; previousSessionFile?: unknown };

export interface PiCloneInheritanceDeps {
	db: ContextDatabase;
	signalPendingMarker: (sessionId: string) => void;
	writeLog?: (message: string) => void;
}

function entryId(entry: unknown): string | null {
	if (entry === null || typeof entry !== "object") return null;
	const id = (entry as { id?: unknown }).id;
	return typeof id === "string" && id.length > 0 ? id : null;
}

function branchPosition(entries: readonly unknown[], id: string): number {
	return entries.findIndex((entry) => entryId(entry) === id);
}

function latestCompactionFirstKept(entries: readonly unknown[]): string | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry === null || typeof entry !== "object") continue;
		const value = entry as { type?: unknown; firstKeptEntryId?: unknown };
		if (
			value.type === "compaction" &&
			typeof value.firstKeptEntryId === "string" &&
			value.firstKeptEntryId.length > 0
		) {
			return value.firstKeptEntryId;
		}
	}
	return null;
}

function parsePendingMarker(
	raw: string | null,
): PendingPiCompactionMarker | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<PendingPiCompactionMarker>;
		if (
			typeof value.firstKeptEntryId === "string" &&
			typeof value.endMessageId === "string" &&
			typeof value.ordinal === "number" &&
			Number.isFinite(value.ordinal) &&
			typeof value.tokensBefore === "number" &&
			Number.isFinite(value.tokensBefore) &&
			typeof value.summary === "string" &&
			typeof value.publishedAt === "number" &&
			Number.isFinite(value.publishedAt)
		) {
			return value as PendingPiCompactionMarker;
		}
	} catch {
		return null;
	}
	return null;
}

function createCloneFilter(
	entries: readonly unknown[],
): CloneSessionStateFilter {
	const rawMessages = convertEntriesToRawMessages([...entries]);
	const rawOrdinalById = new Map(
		rawMessages.map((message) => [message.id, message.ordinal]),
	);
	const validStateIds = new Set<string>(rawOrdinalById.keys());
	const validOrdinals = new Set<number>(rawOrdinalById.values());
	for (const entry of entries) {
		const id = entryId(entry);
		if (id) validStateIds.add(id);
	}
	const includeMessageId = (id: string) => validStateIds.has(id);

	return {
		resolveBoundaryOrdinal: (id) => rawOrdinalById.get(id),
		includeMessageId,
		copySessionNotesAndFacts: true,
		mapOrdinal: (ordinal) => (validOrdinals.has(ordinal) ? ordinal : undefined),
		includeTag: (tag: CloneTagRow) => {
			if (tag.type === "tool") {
				return (
					typeof tag.toolOwnerMessageId === "string" &&
					includeMessageId(tag.toolOwnerMessageId)
				);
			}
			return rawOrdinalById.has(tag.messageId.replace(CONTENT_ID_SUFFIX, ""));
		},
		selectPendingPiMarker: (
			rawState: string | null,
			copiedCompartments: readonly CloneCompartmentRow[],
		): string | null => {
			const pending = parsePendingMarker(rawState);
			if (!pending) return null;
			const pendingFirstKeptPosition = branchPosition(
				entries,
				pending.firstKeptEntryId,
			);
			if (pendingFirstKeptPosition < 0) return null;

			const mappedOrdinal = rawOrdinalById.get(pending.endMessageId);
			if (mappedOrdinal === undefined) return null;
			const matchingCompartment = copiedCompartments.find(
				(compartment) =>
					compartment.endMessageId === pending.endMessageId &&
					compartment.endMessage === mappedOrdinal,
			);
			if (!matchingCompartment) return null;

			const currentFirstKept = latestCompactionFirstKept(entries);
			if (currentFirstKept !== null) {
				const currentPosition = branchPosition(entries, currentFirstKept);
				if (currentPosition >= pendingFirstKeptPosition) return null;
			}

			return JSON.stringify({ ...pending, ordinal: mappedOrdinal });
		},
	};
}

export async function readPiSessionIdFromFile(
	filePath: string,
): Promise<string> {
	const contents = await readFile(filePath, "utf8");
	const newline = contents.indexOf("\n");
	const headerText = newline >= 0 ? contents.slice(0, newline) : contents;
	const header = JSON.parse(headerText) as { type?: unknown; id?: unknown };
	if (
		header.type !== "session" ||
		typeof header.id !== "string" ||
		header.id.length === 0
	) {
		throw new Error("previous session file has no valid session header");
	}
	return header.id;
}

/* */
export async function handlePiCloneSessionStart(
	event: CloneStartEventLike,
	ctx: CloneContextLike,
	deps: PiCloneInheritanceDeps,
): Promise<CopySessionStateForCloneResult | null> {
	if (
		event.reason !== "fork" ||
		typeof event.previousSessionFile !== "string"
	) {
		return null;
	}

	let stage = "resolve-destination";
	let sourceSessionId = "unknown";
	let destinationSessionId = "unknown";
	const writeLog = deps.writeLog ?? log;
	try {
		const manager = ctx.sessionManager;
		if (typeof manager?.getSessionId !== "function") {
			throw new Error("Pi session manager does not expose getSessionId");
		}
		destinationSessionId = manager.getSessionId() ?? "";
		if (destinationSessionId.length === 0) {
			throw new Error("Pi clone session id is empty");
		}

		stage = "read-source-header";
		sourceSessionId = await readPiSessionIdFromFile(event.previousSessionFile);

		stage = "read-clone-branch";
		if (typeof manager.getBranch !== "function") {
			throw new Error("Pi session manager does not expose getBranch");
		}
		const branchEntries = manager.getBranch();
		if (!Array.isArray(branchEntries)) {
			throw new Error("Pi clone branch is unavailable");
		}

		stage = "copy-state";
		const result = copySessionStateForClone(
			deps.db,
			sourceSessionId,
			destinationSessionId,
			createCloneFilter(branchEntries),
		);
		if (result.kind === "destination-not-empty") {
			writeLog(
				`[magic-context][pi] clone-inheritance: skipped source=${sourceSessionId} dest=${destinationSessionId} stage=destination-guard reason=destination-not-empty`,
			);
			return result;
		}

		stage = "signal-marker";
		if (result.pendingMarkerMigrated) {
			deps.signalPendingMarker(destinationSessionId);
		}
		writeLog(
			`[magic-context][pi] clone-inheritance: migrated compartments=${result.compartmentsCopied} tags=${result.tagsCopied} notes=${result.notesCopied} facts=${result.factsCopied} source=${sourceSessionId} dest=${destinationSessionId} reason=fork`,
		);
		return result;
	} catch (error) {
		writeLog(
			`[magic-context][pi] clone-inheritance: failed source=${sourceSessionId} dest=${destinationSessionId} stage=${stage} error=${error instanceof Error ? error.message : String(error)}; run /ctx-wrapup to rebuild, or re-clone`,
		);
		return null;
	}
}

export const __test = { createCloneFilter, parsePendingMarker };
