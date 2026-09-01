import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	type ContextDatabase,
	clearPendingPiCompactionMarkerStateIf,
	setPendingPiCompactionMarkerState,
} from "@magic-context/core/features/magic-context/storage";
import { applyDeferredPiCompactionMarker } from "./compaction-marker-manager-pi";
import { signalPiDeferredHistoryRefresh } from "./context-handler";
import {
	buildPiCompactionSummary,
	findFirstKeptEntryId,
} from "./pi-historian-runner";

/**
 *
 *
 */
/**
 *
 */
export function stagePiRecompMarker(args: {
	db: ContextDatabase;
	sessionId: string;
	ctx: unknown;
}): void {
	const readBranchEntries = resolvePiReadBranchEntries(args.ctx);
	if (!readBranchEntries) return;

	const compartments = getCompartments(args.db, args.sessionId);
	const last = compartments[compartments.length - 1];
	if (!last) return;

	let firstKeptEntryId: string | null = null;
	try {
		firstKeptEntryId = findFirstKeptEntryId(
			readBranchEntries(),
			last.endMessage,
		);
	} catch {
		firstKeptEntryId = null;
	}
	if (!firstKeptEntryId || last.endMessageId.length === 0) return;

	setPendingPiCompactionMarkerState(args.db, args.sessionId, {
		firstKeptEntryId,
		endMessageId: last.endMessageId,
		ordinal: last.endMessage,
		tokensBefore: 0,
		summary: buildPiCompactionSummary(compartments),
		publishedAt: Date.now(),
	});
	signalPiDeferredHistoryRefresh(args.sessionId);
}

/**
 * Call `queueAndApplyPiRecompMarker` only after same-pass rendering covers every entry the marker trims.
 * Calling `queueAndApplyPiRecompMarker` without same-pass rendered coverage can trim history the model has not seen.
 */
export function queueAndApplyPiRecompMarker(args: {
	db: ContextDatabase;
	sessionId: string;
	ctx: unknown;
}): void {
	const appendCompaction = resolvePiAppendCompaction(args.ctx);
	const readBranchEntries = resolvePiReadBranchEntries(args.ctx);
	if (!appendCompaction || !readBranchEntries) return;

	const compartments = getCompartments(args.db, args.sessionId);
	const last = compartments[compartments.length - 1];
	if (!last) return;

	let firstKeptEntryId: string | null = null;
	try {
		firstKeptEntryId = findFirstKeptEntryId(
			readBranchEntries(),
			last.endMessage,
		);
	} catch {
		firstKeptEntryId = null;
	}
	if (!firstKeptEntryId || last.endMessageId.length === 0) return;

	const pending = {
		firstKeptEntryId,
		endMessageId: last.endMessageId,
		ordinal: last.endMessage,
		tokensBefore: 0,
		summary: buildPiCompactionSummary(compartments),
		publishedAt: Date.now(),
	};

	setPendingPiCompactionMarkerState(args.db, args.sessionId, pending);
	const outcome = applyDeferredPiCompactionMarker(
		{ db: args.db, appendCompaction, readBranchEntries },
		args.sessionId,
		pending,
	);
	if (outcome.kind === "retryable-failure") {
		signalPiDeferredHistoryRefresh(args.sessionId);
		return;
	}
	if (
		!clearPendingPiCompactionMarkerStateIf(args.db, args.sessionId, pending)
	) {
		signalPiDeferredHistoryRefresh(args.sessionId);
	}
}

function resolvePiAppendCompaction(
	ctx: unknown,
):
	| ((
			summary: string,
			firstKeptEntryId: string,
			tokensBefore: number,
			details?: unknown,
			fromHook?: boolean,
	  ) => string | undefined)
	| undefined {
	const sm = (ctx as { sessionManager?: unknown })?.sessionManager as
		| {
				appendCompaction?: (
					summary: string,
					firstKeptEntryId: string,
					tokensBefore: number,
					details?: unknown,
					fromHook?: boolean,
				) => string | undefined;
		  }
		| undefined;
	if (typeof sm?.appendCompaction !== "function") return undefined;
	return sm.appendCompaction.bind(sm);
}

function resolvePiReadBranchEntries(
	ctx: unknown,
): (() => unknown[]) | undefined {
	const sm = (ctx as { sessionManager?: unknown })?.sessionManager as
		| { getBranch?: () => unknown[] }
		| undefined;
	if (typeof sm?.getBranch !== "function") return undefined;
	return () => {
		try {
			const entries = sm.getBranch?.call(sm);
			return Array.isArray(entries) ? entries : [];
		} catch {
			return [];
		}
	};
}
