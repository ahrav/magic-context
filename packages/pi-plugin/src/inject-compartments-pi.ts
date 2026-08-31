/**
 * (packages/plugin/src/hooks/magic-context/inject-compartments.ts).
 *
 * Pi differences:
 * Pi messages use `content` instead of OpenCode's `parts`.
 * The MessageLike view lets `prepareCompartmentInjection` read storage, use its cache, and trim the boundary.
 * Pi `AgentMessage` values lack stable per-message IDs.
 * Boundary trimming uses `pi-msg-${index}-${ts}-${role}` IDs to match `transcript-pi.ts`.
 * The boundary-trim cutoff comparison uses the same synthesized ID across passes.
 *
 * Cache safety:
 * `isCacheBusting=false` reuses the prepared block and reapplies boundary trimming.
 * Deferred passes write the cached block to `piMessages[0]` to preserve the provider prompt cache.
 * Cache-busting passes rebuild the prepared block.
 * The caller derives `isCacheBusting` from `historyRefreshSessions`.
 *     historyRefreshSessions signal.
 */

import { renderClaimMemoryBlock } from "@magic-context/core/features/magic-context/memory/claim-memory-render";
import {
	canonicalSnapshotVector,
	type SnapshotVector,
} from "@magic-context/core/features/magic-context/memory/claim-operation-contract";
import {
	type ProjectMemoryClaimSnapshot,
	readProjectMemorySnapshotVector,
	snapshotVectorChanges,
} from "@magic-context/core/features/magic-context/memory/storage-claim-current-state";
import { resolveMuralWire } from "@magic-context/core/features/magic-context/mural/render-trigger";
import type { MuralWireOptions } from "@magic-context/core/features/magic-context/mural/resolve-mural";
import {
	type ContextDatabase,
	clearCachedM0M1,
	escapeXmlContent,
	GLOBAL_USER_PROFILE_PROJECT_PATH,
	getCompartments,
	getMaxM0MutationId,
	getOrCreateSessionMeta,
	getProjectState,
	persistCachedM0,
	readProjectDocsCanonical,
} from "@magic-context/core/features/magic-context/storage";
import { DIRECT_FORMAT_EPOCH } from "@magic-context/core/features/magic-context/storage-format-epoch";
import {
	getActiveUserMemories,
	type UserMemory,
} from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import {
	computeWorkspaceEpochFingerprint,
	expandWorkspaceIdentitySetWithAliases,
	resolveWorkspaceIdentitySet,
	resolveWorkspaceShareCategories,
} from "@magic-context/core/features/magic-context/workspaces";
import {
	COMPARTMENT_RENDER_EPOCH,
	decodeCachedM0UpgradeIdentity,
	encodeCachedM0UpgradeIdentity,
} from "@magic-context/core/hooks/magic-context/compartment-render-epoch";
import {
	DEFAULT_HISTORY_BUDGET_TOKENS,
	extractM0Block,
	renderCompartmentAtTier,
	renderDecayedCompartments,
} from "@magic-context/core/hooks/magic-context/decay-render";
import {
	type ClaimLaneSnapshot,
	DEFAULT_MEMORY_BUDGET_TOKENS,
	DEFAULT_USER_PROFILE_BUDGET_TOKENS,
	readClaimLaneSnapshot,
	stripMemoryMuralBlock,
	stripProjectMemoryBlock,
	trimClaimLane,
	trimUserMemoriesToBudget,
	type WorkspaceRenderContext,
} from "@magic-context/core/hooks/magic-context/inject-compartments";

import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { piModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";
import { sessionLog as logSession } from "@magic-context/core/shared/logger";
import { resolvePiStableId, SYNTH_USER_ID_PREFIX } from "./read-session-pi";

/**
 * Pi message shapes structurally match the `AgentMessage` subset used by `transcript-pi.ts`.
 */
type PiTextContent = { type: "text"; text: string; textSignature?: string };
type PiImageContent = { type: "image"; data: string; mimeType: string };
type PiUserMessage = {
	role: "user";
	content: string | (PiTextContent | PiImageContent)[];
	timestamp?: number;
};
type PiAssistantMessage = {
	role: "assistant";
	content: unknown[];
	timestamp?: number;
};
type PiToolResultMessage = {
	role: "toolResult";
	content: unknown[];
	timestamp?: number;
};
type PiAgentMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

/* */
function resolveStableId(
	msg: PiAgentMessage,
	index: number,
	entryIds: readonly (string | undefined)[] | undefined,
): string {
	return resolvePiStableId(msg, index, entryIds) ?? "";
}

/**
 *
 *
 * Synthetic-user cutoffs use the first folded `toolResult` entry ID.
 *
 * `convertEntriesToRawMessages` records folded `toolResult` runs as synthetic-user IDs, while live Pi messages retain individual `toolResult` IDs.
 * Synthetic-user cutoffs resolve to the first folded `toolResult` ID before live Pi message comparison.
 * When the cutoff is synthetic, the function strips its prefix and matches the first folded `toolResult` entry ID.
 * The suffix is the first folded `toolResult` entry ID, which remains visible in `piMessages`.
 * Trimming through the first folded `toolResult` removes the folded run because the orphan sweep removes its remaining entries.
 * The bidirectional orphan sweep removes the remaining entries in the folded run.
 *
 */
function trimPiMessagesToBoundary(
	piMessages: PiAgentMessage[],
	entryIds: readonly (string | undefined)[] | undefined,
	cutoffMessageId: string,
	trimMutableEntryIds = false,
): number {
	if (cutoffMessageId.length === 0) return 0;
	const effectiveCutoffId = cutoffMessageId.startsWith(SYNTH_USER_ID_PREFIX)
		? cutoffMessageId.slice(SYNTH_USER_ID_PREFIX.length)
		: cutoffMessageId;
	if (effectiveCutoffId.length === 0) return 0;
	let cutoffIndex = -1;
	for (let i = 0; i < piMessages.length; i++) {
		const msg = piMessages[i];
		if (msg && resolveStableId(msg, i, entryIds) === effectiveCutoffId) {
			cutoffIndex = i;
			break;
		}
	}
	if (cutoffIndex < 0) return 0;

	// The function applies the OpenCode prefix trim before sweeping Pi's split tool-call pairs in both directions.
	// Pi represents tool calls and results as separate messages, so the function sweeps pairs in both directions.
	// The sweep scopes pairs by their owning assistant-message index, not by `callId` alone.
	// Pi and OpenCode can reuse `callId` values across turns, so a global `callId` match can remove a kept-tail pair from a later turn.
	// Assistant-index ownership preserves same-turn cleanup without removing pairs from later turns.
	// Pair scoping uses the assistant-message index because `callId` values can repeat across turns.
	// Assistant-index ownership preserves non-contiguous same-turn cleanup without cross-turn removal.
	// over-removal.
	const remove = new Set<number>();
	for (let i = 0; i <= cutoffIndex; i++) remove.add(i);

	let changed = true;
	while (changed) {
		changed = false;
		const removedCallKeys = new Set<string>();
		const removedResultKeys = new Set<string>();

		for (const index of remove) {
			const msg = piMessages[index];
			if (!msg) continue;
			if (msg.role === "assistant") {
				for (const callId of getPiToolCallIds(msg)) {
					removedCallKeys.add(toolPairKey(callId, index));
				}
			} else if (msg.role === "toolResult") {
				const callId = getPiToolResultCallId(msg);
				const ownerIndex = callId
					? findToolResultOwnerAssistantIndex(piMessages, index, callId)
					: null;
				if (callId && ownerIndex !== null) {
					removedResultKeys.add(toolPairKey(callId, ownerIndex));
				}
			}
		}

		for (let i = 0; i < piMessages.length; i++) {
			if (remove.has(i)) continue;
			const msg = piMessages[i];
			if (!msg) continue;
			if (msg.role === "toolResult") {
				const callId = getPiToolResultCallId(msg);
				const ownerIndex = callId
					? findToolResultOwnerAssistantIndex(piMessages, i, callId)
					: null;
				if (
					callId &&
					ownerIndex !== null &&
					removedCallKeys.has(toolPairKey(callId, ownerIndex))
				) {
					remove.add(i);
					changed = true;
				}
				continue;
			}
			if (msg.role === "assistant") {
				const callIds = getPiToolCallIds(msg);
				if (
					callIds.some((callId) =>
						removedResultKeys.has(toolPairKey(callId, i)),
					)
				) {
					remove.add(i);
					changed = true;
				}
			}
		}
	}

	const kept = piMessages.filter((_, index) => !remove.has(index));
	const removed = piMessages.length - kept.length;
	piMessages.splice(0, piMessages.length, ...kept);
	if (trimMutableEntryIds && Array.isArray(entryIds)) {
		const keptIds = entryIds.filter((_, index) => !remove.has(index));
		entryIds.splice(0, entryIds.length, ...keptIds);
	}
	return removed;
}

function toolPairKey(callId: string, assistantIndex: number): string {
	return `${callId}\0${assistantIndex}`;
}

function findToolResultOwnerAssistantIndex(
	messages: readonly PiAgentMessage[],
	resultIndex: number,
	callId: string,
): number | null {
	for (let i = resultIndex - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "assistant" && getPiToolCallIds(msg).includes(callId)) {
			return i;
		}
	}
	for (let i = resultIndex + 1; i < messages.length; i++) {
		const msg = messages[i];
		if (msg?.role === "assistant" && getPiToolCallIds(msg).includes(callId)) {
			return i;
		}
	}
	return null;
}

function getPiToolCallIds(message: PiAssistantMessage): string[] {
	if (!Array.isArray(message.content)) return [];
	const ids: string[] = [];
	for (const part of message.content) {
		if (
			part &&
			typeof part === "object" &&
			(part as Record<string, unknown>).type === "toolCall" &&
			typeof (part as Record<string, unknown>).id === "string"
		) {
			ids.push((part as Record<string, unknown>).id as string);
		}
	}
	return ids;
}

function getPiToolResultCallId(message: PiToolResultMessage): string | null {
	const callId = (message as Record<string, unknown>).toolCallId;
	return typeof callId === "string" && callId.length > 0 ? callId : null;
}

export const __test = {
	trimPiMessagesToBoundary,
	renderFreshM0PiNonPersisted,
	clearPiMuralProcessCache,
};

const PI_M1_PLACEHOLDER =
	"<session-history-since>(no new content since last materialization)</session-history-since>";
// Pi's static marker does not change per session.
// Pi has no per-session upgrade-state transition for m[0] markers.
// A static marker keeps the stored and current markers equal.
// TODO: Invalidate m[0] when Pi adds a session-upgrade flow.
const PI_M0_UPGRADE_STATE = "pi-m0m1-v2";
const EMPTY_MAX_COMPARTMENT_SEQ = -1;

type PiCompartment = ReturnType<typeof getCompartments>[number];

type PiProjectDocsRender = ReturnType<typeof readProjectDocsCanonical>;

interface FrozenM0Inputs {
	docs: PiProjectDocsRender;
	markers: PiM0SnapshotMarkers;
	compartments: PiCompartment[];
	claims: ProjectMemoryClaimSnapshot[];
	claimLane: ClaimLaneSnapshot;
	userProfile: UserMemory[];
	workspace: WorkspaceRenderContext;
}

/**
 * The value measures only the `<session-history>` slice of rendered `m[0]` with the real tokenizer.
 * The history budget applies only to the `<session-history>` block, not all of `m[0]`.
 * `m[0]` also carries `<project-docs>`, `<user-profile>`, and `<project-memory>`, each with its own budget.
 * `<project-docs>`, `<user-profile>`, and `<project-memory>` have separate budgets; charging them to the history budget over-tightens decay.
 */
function historySliceTokensPi(m0Text: string): number {
	const slice = extractM0Block(m0Text, "session-history");
	return slice ? estimateTokens(slice) : 0;
}

/**
 * An absent `user_memories` table must not abort m[0] materialization.
 */
function safeGetActiveUserMemoriesPi(db: ContextDatabase): UserMemory[] {
	try {
		return getActiveUserMemories(db);
	} catch (error) {
		if (String(error).includes("no such table: user_memories")) return [];
		throw error;
	}
}

export interface PiM0M1State {
	sessionId: string;
	projectIdentity: string;
	projectDirectory: string;
	/** When `memory.enabled` is false, project memories are not read or rendered into `m[0]` or `m[1]`.
	 * When `memoryEnabled=false`, `memoryProjectPath` returns `undefined`, so memory reads return their empty values.
	 * `injectDocs` unset or true does not disable project-memory injection. */
	memoryEnabled?: boolean;
	/** `injectDocs` defaults to true; when false, `m[0]` omits the `<project-docs>` block and docs hash. */
	injectDocs?: boolean;
	/** The memory trim budget limits the `<project-memory>` block to approximately 4K tokens. */
	injectionBudgetTokens?: number;
	/** The v2 decay-render history budget is approximately 60K tokens and drives compartment tier demotion.
	 * Using injectionBudgetTokens here would over-demote every compartment.
	 * */
	historyBudgetTokens?: number;
	/** renderM1 trims the m[1] new-user-profile delta to 25% of this budget.
	 * */
	userProfileBudgetTokens?: number;
	/** `hardSignals` provides provider-side cache-eviction signals for HARD-bust detection. */
	hardSignals?: PiM0HardSignals;
	/**
	 * When `muralEnabled` is true and the fold's model accepts images, HARD materialization resolves the mural on demand.
	 * HARD materialization renders the deterministic mural and stores its image in the cached baseline.
	 * Defer passes replay the mural bytes stored in the cached baseline. */
	muralEnabled?: boolean;
	/** `mural` supplies explicit wire options and skips on-demand mural resolution.
	 * */
	mural?: MuralWireOptions;
	/** `compactionOff` keeps memory and docs injection while suppressing compartment history rendering and trimming. */
	compactionOff?: boolean;
}

const EMPTY_PI_PROJECT_DOCS: PiProjectDocsRender = {
	renderedBlock: "",
	canonicalHash: "",
};

function getRenderableCompartmentsPi(
	db: ContextDatabase,
	state: PiM0M1State,
): PiCompartment[] {
	return state.compactionOff ? [] : getCompartments(db, state.sessionId);
}

function readProjectDocsForPiM0(state: PiM0M1State): PiProjectDocsRender {
	return state.injectDocs !== false
		? readProjectDocsCanonical(state.projectDirectory)
		: EMPTY_PI_PROJECT_DOCS;
}

/**
 * `memory.enabled=false` makes memory reads return their empty values; `injectDocs` controls project docs independently.
 */
function memoryProjectPath(state: PiM0M1State): string | undefined {
	return state.memoryEnabled === false ? undefined : state.projectIdentity;
}

function resolveWorkspaceRenderContextPi(
	state: PiM0M1State,
	db: ContextDatabase,
): WorkspaceRenderContext {
	const memPath = memoryProjectPath(state);
	if (!memPath) {
		return {
			identities: [],
			expandedIdentities: [],
			ownIdentities: [],
			shareCategories: null,
			namesByIdentity: new Map(),
			canonicalIdentityByStoredPath: new Map(),
			isWorkspaced: false,
		};
	}
	const identitySet = resolveWorkspaceIdentitySet(db, memPath);
	const isWorkspaced = identitySet.identities.length > 1;
	const expanded = expandWorkspaceIdentitySetWithAliases(
		db,
		identitySet.identities,
	);
	const expandedIdentities = isWorkspaced
		? expanded.expandedIdentities
		: identitySet.identities;
	const canonicalIdentityByStoredPath = isWorkspaced
		? expanded.canonicalIdentityByStoredPath
		: new Map(identitySet.identities.map((identity) => [identity, identity]));
	let ownIdentities = expandedIdentities.filter(
		(identity) => canonicalIdentityByStoredPath.get(identity) === memPath,
	);
	if (ownIdentities.length === 0 && expandedIdentities.includes(memPath)) {
		ownIdentities = [memPath];
	}
	return {
		identities: identitySet.identities,
		expandedIdentities,
		ownIdentities,
		shareCategories: isWorkspaced
			? resolveWorkspaceShareCategories(db, memPath)
			: null,
		namesByIdentity: identitySet.namesByIdentity,
		canonicalIdentityByStoredPath,
		isWorkspaced,
	};
}

export interface PiM0SnapshotMarkers {
	claimFormatEpoch: number;
	claimSnapshotVector: SnapshotVector;
	renderedRevisionLocators: string[];
	maxCompartmentSeq: number;
	maxMutationId: number;
	projectUserProfileVersion: number;
	projectDocsHash: string;
	sessionFactsVersion: number;
	materializedAt: number;
	upgradeState: string;
	compartmentRenderEpoch: string | null;
	lastBaselineEndMessageId: string | null;
	// HARD-bust markers record provider-side cache-eviction signals.
	systemHash: string;
	modelKey: string;
	// Pi sessions can switch projects in-process (`/cd`). Legacy cached rows with NULL projectIdentity are unknown/lazy-adopted and must not force a HARD fold.
	projectIdentity: string | null;
	muralEnabled: boolean;
	renderBudgetIdentity: string;
}

/**
 */
export interface PiM0HardSignals {
	systemHash: string;
	modelKey: string;
	cacheExpired: boolean;
	lastResponseTime: number;
}

const EMPTY_PI_HARD_SIGNALS: PiM0HardSignals = {
	systemHash: "",
	modelKey: "",
	cacheExpired: false,
	lastResponseTime: 0,
};

function renderBudgetIdentityPi(state: PiM0M1State): string {
	return `m${state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS}-h${state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS}`;
}

export interface PiMaterializeMismatch {
	signal: string;
	cached: string | number | boolean | null;
	current: string | number | boolean | null;
}

export interface PiMaterializeDecision {
	value: boolean;
	reason: string | null;
	/** HARD-bust markers record the values compared when a HARD-bust signal fires. */
	mismatch?: PiMaterializeMismatch;
}

function piMaterializeMismatch(
	reason: string,
	signal: string,
	cached: PiMaterializeMismatch["cached"],
	current: PiMaterializeMismatch["current"],
): PiMaterializeDecision {
	return { value: true, reason, mismatch: { signal, cached, current } };
}

interface PiInjectionTokenCountCache {
	m0: string;
	m0Tokens: number;
	m1: string;
	m1Tokens: number;
}

const injectionTokenCountsBySession = new Map<
	string,
	PiInjectionTokenCountCache
>();

/** The cache stores mural payloads only within one process. */
interface CachedPiMural {
	dataUrl: string | null;
	contentHash: string | null;
}

const cachedMuralBySession = new Map<string, CachedPiMural>();

function clearPiMuralProcessCache(sessionId?: string): void {
	if (sessionId) cachedMuralBySession.delete(sessionId);
	else cachedMuralBySession.clear();
}

function rememberPiMuralPayload(
	sessionId: string,
	dataUrl: string | null | undefined,
	contentHash: string | null | undefined,
): void {
	cachedMuralBySession.set(sessionId, {
		dataUrl: dataUrl ?? null,
		contentHash: contentHash ?? null,
	});
}

function rememberPiMural(
	sessionId: string,
	mural: MuralWireOptions | undefined,
): void {
	rememberPiMuralPayload(
		sessionId,
		mural?.enabled && mural.supportsVision ? mural.dataUrl : null,
		mural?.enabled && mural.supportsVision ? mural.contentHash : null,
	);
}

function muralForWire(sessionId: string): MuralWireOptions | undefined {
	const cached = cachedMuralBySession.get(sessionId);
	if (!cached?.dataUrl) return undefined;
	return {
		enabled: true,
		supportsVision: true,
		dataUrl: cached.dataUrl,
		contentHash: cached.contentHash ?? undefined,
	};
}

/* */
function piImageFromDataUrl(dataUrl: string): PiImageContent | null {
	const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl);
	if (!match) return null;
	return { type: "image", mimeType: match[1], data: match[2] };
}

/**
 */
function resolveMuralForM0Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	modelKey: string,
	budgetTokens: number,
): MuralWireOptions | undefined {
	if (state.mural) return state.mural;
	if (!state.muralEnabled) return undefined;
	return resolveMuralWire(
		db,
		memoryProjectPath(state),
		modelKey,
		true,
		budgetTokens,
	);
}

function cachedInjectionTokenCounts(
	sessionId: string,
	m0: string,
	m1: string,
): { m0Tokens: number; m1Tokens: number } {
	const cached = injectionTokenCountsBySession.get(sessionId);
	if (cached?.m0 === m0 && cached.m1 === m1) return cached;
	const counts = {
		m0,
		m0Tokens: estimateTokens(m0),
		m1,
		m1Tokens: m1 === PI_M1_PLACEHOLDER ? 0 : estimateTokens(m1),
	};
	injectionTokenCountsBySession.set(sessionId, counts);
	return counts;
}

export function clearPiInjectionTokenCountCache(sessionId: string): void {
	injectionTokenCountsBySession.delete(sessionId);
}

export interface PiRenderedCompartmentBoundary {
	endMessageId: string | null;
	ordinal: number | null;
}

export interface PiM0M1InjectionResult extends PiInjectionResult {
	m0Materialized: boolean;
	m0Reason: string | null;
	m0Bytes: number;
	m1Bytes: number;
	/**
	 * Deferred marker signals remain armed because fallback content may not match the latest saved compartment snapshot.
	 */
	contentionExhausted: boolean;
	/** The sent m[0]/m[1] pair represents the recorded compartment boundary. */
	renderedBoundary: PiRenderedCompartmentBoundary;
	/**
	 * m1RenderedCoverage records coverage from m[1] freshly recomputed from this pass's snapshot.
	 * The watermark is the maximum end ordinal or end message ID among compartments in m[1].
	 * m1RenderedCoverage uses the snapshot that rendered m[1].
	 * m1RenderedCoverage is null unless this pass freshly recomputed m[1] without contention fallback.
	 * Sibling fallback leaves recomputed false and contentionExhausted false.
	 * Pure replay serves bytes rendered by an earlier pass.
	 * Replayed or sibling-fallback bytes cannot certify coverage of unrendered compartments.
	 * The deferred-marker drain keeps its signal armed until a fresh render.
	 * m1RenderedCoverage is memory-only and is never persisted.
	 * The drain reads this watermark only on busting passes with freshly recomputed m[1].
	 */
	m1RenderedCoverage: PiRenderedCompartmentBoundary | null;
	/**
	 * The synthetic-message injection prepends two synthetic m[0]/m[1] messages with no SessionEntry IDs.
	 * The synthetic m[0]/m[1] messages never resolve to SessionEntry IDs.
	 * Anchor GC must exclude the synthetic m[0]/m[1] messages because they have no SessionEntry IDs.
	 * Anchor GC excludes synthetic messages from the resolved-message denominator; otherwise it never prunes.
	 */
	syntheticLeadingCount: number;
}

function decodeCachedM0(value: Buffer | Uint8Array | null): string | null {
	if (!value) return null;
	return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
		"utf8",
	);
}

// `session_facts` does not supply render input.
// `sessionFactsVersion` never triggers re-materialization.
// Fact changes do not affect rendered bytes.
function getSessionFactsVersion(
	_db: ContextDatabase,
	_sessionId: string,
): number {
	return 0;
}

function normalizeCachedMaxCompartmentSeq(
	stored: number,
	compartments: readonly PiCompartment[],
): number {
	// `stored === 0` denotes the legacy empty-session sentinel only when `compartments` is empty.
	// `0` remains a real sequence number when a seq-0 compartment exists.
	if (stored === 0 && compartments.length === 0) {
		return EMPTY_MAX_COMPARTMENT_SEQ;
	}
	return stored;
}

function getCachedBoundary(
	db: ContextDatabase,
	sessionId: string,
): string | null {
	const row = db
		.prepare(
			"SELECT cached_m0_last_baseline_end_message_id AS boundary FROM session_meta WHERE session_id = ?",
		)
		.get(sessionId) as { boundary?: unknown } | undefined;
	return typeof row?.boundary === "string" && row.boundary.length > 0
		? row.boundary
		: null;
}

export function trimPiMessagesToCachedBoundary(
	db: ContextDatabase,
	sessionId: string,
	piMessages: PiAgentMessage[],
	entryIds: (string | undefined)[] | undefined,
): number {
	const row = db
		.prepare(
			`SELECT cached_m0_bytes AS m0, cached_m1_bytes AS m1,
			        cached_m0_last_baseline_end_message_id AS boundary
			 FROM session_meta WHERE session_id = ?`,
		)
		.get(sessionId) as
		| { m0?: unknown; m1?: unknown; boundary?: unknown }
		| undefined;
	if (!row?.m0 || !row.m1 || typeof row.boundary !== "string") return 0;
	const boundary = row.boundary;
	if (boundary.length === 0) return 0;
	const boundaryIsLive = getCompartments(db, sessionId).some(
		(compartment) => compartment.endMessageId === boundary,
	);
	if (!boundaryIsLive) return 0;
	return trimPiMessagesToBoundary(piMessages, entryIds, boundary, true);
}

function setCachedBoundary(
	db: ContextDatabase,
	sessionId: string,
	boundary: string | null,
): void {
	db.prepare(
		"UPDATE session_meta SET cached_m0_last_baseline_end_message_id = ? WHERE session_id = ?",
	).run(boundary, sessionId);
}

function isPiGenerationRecord(value: unknown): value is Record<string, number> {
	return (
		value !== null &&
		typeof value === "object" &&
		Object.entries(value).every(
			([key, generation]) =>
				/^\d+$/.test(key) && Number.isSafeInteger(generation),
		)
	);
}

function parsePiSnapshotVector(raw: string | null): SnapshotVector | null {
	if (raw === null) return null;
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		if (
			value.vectorVersion !== 1 ||
			typeof value.databaseIncarnationId !== "string" ||
			typeof value.workspaceEpoch !== "string" ||
			!isPiGenerationRecord(value.projectGenerations) ||
			!isPiGenerationRecord(value.policyGenerations)
		) {
			return null;
		}
		return {
			vectorVersion: 1,
			databaseIncarnationId: value.databaseIncarnationId,
			workspaceEpoch: value.workspaceEpoch,
			projectGenerations: value.projectGenerations,
			policyGenerations: value.policyGenerations,
		};
	} catch {
		return null;
	}
}

function parsePiRevisionLocators(raw: string | null): string[] | null {
	if (raw === null) return null;
	try {
		const value = JSON.parse(raw) as unknown;
		return Array.isArray(value) &&
			value.every((item) => typeof item === "string")
			? value
			: null;
	} catch {
		return null;
	}
}

function getCachedMarkers(
	db: ContextDatabase,
	state: PiM0M1State,
	compartmentsForNormalization?: readonly PiCompartment[],
): PiM0SnapshotMarkers | null {
	const meta = getOrCreateSessionMeta(db, state.sessionId);
	if (!meta.cachedM0Bytes) return null;
	const claimSnapshotVector = parsePiSnapshotVector(
		meta.cachedM0ClaimSnapshotVector,
	);
	const renderedRevisionLocators = parsePiRevisionLocators(
		meta.cachedM0RenderedRevisionLocators,
	);
	if (
		meta.cachedM0ClaimFormatEpoch === null ||
		claimSnapshotVector === null ||
		renderedRevisionLocators === null ||
		meta.cachedM0MaxCompartmentSeq === null ||
		meta.cachedM0MaxMutationId === null ||
		meta.cachedM0ProjectUserProfileVersion === null ||
		meta.cachedM0ProjectDocsHash === null ||
		meta.cachedM0SessionFactsVersion === null ||
		meta.cachedM0MaterializedAt === null ||
		meta.cachedM0UpgradeState === null
	) {
		return null;
	}
	const compartments =
		compartmentsForNormalization ?? getRenderableCompartmentsPi(db, state);
	const cachedUpgradeIdentity = decodeCachedM0UpgradeIdentity(
		meta.cachedM0UpgradeState,
	);
	const maxCompartmentSeq = normalizeCachedMaxCompartmentSeq(
		meta.cachedM0MaxCompartmentSeq,
		compartments,
	);
	const cachedBoundary = getCachedBoundary(db, state.sessionId);
	// Cache validation invalidates a null cached boundary only when the live snapshot has a usable boundary.
	// An empty `end_message_id` is valid and disables visible-prefix trimming.
	// A boundaryless baseline may persist a null boundary.
	// The cache remains valid when the live snapshot has no usable boundary.
	// The cache is reused when the live snapshot has no usable boundary.
	const liveBoundary = lastBaselineEndMessageId(compartments);
	if (
		maxCompartmentSeq >= 0 &&
		cachedBoundary === null &&
		liveBoundary !== null
	) {
		return null;
	}
	return {
		claimFormatEpoch: meta.cachedM0ClaimFormatEpoch,
		claimSnapshotVector,
		renderedRevisionLocators,
		maxCompartmentSeq,
		maxMutationId: meta.cachedM0MaxMutationId,
		projectUserProfileVersion: meta.cachedM0ProjectUserProfileVersion,
		projectDocsHash: meta.cachedM0ProjectDocsHash,
		sessionFactsVersion: meta.cachedM0SessionFactsVersion,
		materializedAt: meta.cachedM0MaterializedAt,
		upgradeState: cachedUpgradeIdentity.upgradeState ?? "",
		compartmentRenderEpoch: cachedUpgradeIdentity.compartmentRenderEpoch,
		lastBaselineEndMessageId: cachedBoundary,
		systemHash: meta.cachedM0SystemHash ?? "",
		modelKey: meta.cachedM0ModelKey ?? "",
		projectIdentity: meta.cachedM0ProjectIdentity ?? null,
		muralEnabled: cachedUpgradeIdentity.muralEnabled ?? false,
		renderBudgetIdentity: cachedUpgradeIdentity.renderBudgetIdentity ?? "",
	};
}

function lastBaselineEndMessageId(
	compartments: readonly PiCompartment[],
): string | null {
	const last = compartments.at(-1);
	return last?.endMessageId && last.endMessageId.length > 0
		? last.endMessageId
		: null;
}

function readCurrentMarkersFromCompartments(
	db: ContextDatabase,
	state: PiM0M1State,
	compartments: readonly PiCompartment[],
	projectDocsHash?: string,
): PiM0SnapshotMarkers {
	const memPath = memoryProjectPath(state);
	const workspace = resolveWorkspaceRenderContextPi(state, db);
	const claimLane = readClaimLaneSnapshot({
		db,
		projectPath: memPath,
		workspace,
	});
	if (claimLane === null) {
		throw new PiMaterializeContentionError("claim snapshot kept moving");
	}
	const claims = trimClaimLane(
		claimLane,
		state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
		workspace,
	);
	const globalState = getProjectState(db, GLOBAL_USER_PROFILE_PROJECT_PATH);
	return {
		claimFormatEpoch: DIRECT_FORMAT_EPOCH,
		claimSnapshotVector: claimLane.snapshotVector,
		renderedRevisionLocators: claims.map((item) => item.revisionLocator),
		maxCompartmentSeq:
			compartments.length > 0
				? compartments.reduce(
						(max, compartment) =>
							compartment.sequence > max ? compartment.sequence : max,
						EMPTY_MAX_COMPARTMENT_SEQ,
					)
				: EMPTY_MAX_COMPARTMENT_SEQ,
		maxMutationId: getMaxM0MutationId(db, state.sessionId) ?? 0,
		projectUserProfileVersion: globalState?.projectUserProfileVersion ?? 0,
		projectDocsHash:
			projectDocsHash ?? readProjectDocsForPiM0(state).canonicalHash,
		sessionFactsVersion: getSessionFactsVersion(db, state.sessionId),
		materializedAt: Date.now(),
		// Changes to `upgradeState` invalidate legacy-rendered m[0].
		// A static upgrade state would retain legacy-rendered m[0] after conversion.
		upgradeState: `${PI_M0_UPGRADE_STATE}:${
			compartments.some((c) => c.legacy === 1) ? "legacy" : "ready"
		}`,
		compartmentRenderEpoch: COMPARTMENT_RENDER_EPOCH,
		lastBaselineEndMessageId: lastBaselineEndMessageId(compartments),
		systemHash: (state.hardSignals ?? EMPTY_PI_HARD_SIGNALS).systemHash,
		modelKey: piModelRefToCanonical(
			(state.hardSignals ?? EMPTY_PI_HARD_SIGNALS).modelKey,
		),
		projectIdentity: state.projectIdentity,
		muralEnabled: state.muralEnabled === true,
		renderBudgetIdentity: renderBudgetIdentityPi(state),
	};
}

export function mustMaterializePi(
	state: PiM0M1State,
	db: ContextDatabase,
	currentCompartmentsOverride?: readonly PiCompartment[],
): PiMaterializeDecision {
	const meta = getOrCreateSessionMeta(db, state.sessionId);
	// The caller snapshot keeps materialization and cached-marker reload on the same compartment set.
	// A reread can observe a changed compartment count and produce null markers.
	const currentCompartments =
		currentCompartmentsOverride ?? getRenderableCompartmentsPi(db, state);
	const current = readCurrentMarkersFromCompartments(
		db,
		state,
		currentCompartments,
		// The cache decision reuses the persisted hash so deferred passes do not read or fingerprint docs they cannot materialize.
		meta.cachedM0ProjectDocsHash ?? undefined,
	);
	if (!meta.cachedM0Bytes) return { value: true, reason: "first_render" };
	if (!meta.cachedM1Bytes) return { value: true, reason: "cached_m1_missing" };
	// The guarded materialize path retains invalid cached baselines because `cache_invalid` has no contention fallback.
	// Detecting missing required markers and empty decoded bytes prevents lease-contention false negatives from dropping m[0]/m[1].
	if (!decodeCachedM0(meta.cachedM0Bytes)) {
		return { value: true, reason: "cache_invalid" };
	}
	const cached = getCachedMarkers(db, state, currentCompartments);
	if (cached === null) {
		return { value: true, reason: "cache_invalid" };
	}
	// A renderer-format change folds cached m[0] exactly once because the fold persists `compartmentRenderEpoch` with the rendered bytes.
	if (cached.compartmentRenderEpoch !== current.compartmentRenderEpoch) {
		return piMaterializeMismatch(
			"compartment_render_epoch",
			"compartmentRenderEpoch",
			cached.compartmentRenderEpoch,
			current.compartmentRenderEpoch,
		);
	}
	if (cached.muralEnabled !== current.muralEnabled) {
		return piMaterializeMismatch(
			"render_config",
			"muralEnabled",
			cached.muralEnabled,
			current.muralEnabled,
		);
	}
	if (cached.renderBudgetIdentity !== current.renderBudgetIdentity) {
		return piMaterializeMismatch(
			"render_config",
			"renderBudgetIdentity",
			cached.renderBudgetIdentity,
			current.renderBudgetIdentity,
		);
	}
	// Pi treats `toolSetHash` as unknown for the pass and never as a change.
	// Pi has no `tool.definition` hook, so it never produces `toolSetHash` and the `toolSetHash` comparison branch is inert.
	const hard = state.hardSignals ?? EMPTY_PI_HARD_SIGNALS;
	const canonicalHardModelKey = piModelRefToCanonical(hard.modelKey);
	const canonicalCachedModelKey = piModelRefToCanonical(
		meta.cachedM0ModelKey ?? "",
	);
	if (
		canonicalHardModelKey !== "" &&
		canonicalHardModelKey !== canonicalCachedModelKey
	) {
		return piMaterializeMismatch(
			"model_change",
			"modelKey",
			canonicalCachedModelKey,
			canonicalHardModelKey,
		);
	}
	if (
		hard.systemHash !== "" &&
		hard.systemHash !== (meta.cachedM0SystemHash ?? "")
	) {
		return piMaterializeMismatch(
			"system_hash",
			"systemHash",
			meta.cachedM0SystemHash ?? "",
			hard.systemHash,
		);
	}
	// Pi can switch projects within the same session (`/cd`).
	// Legacy cached rows with a `NULL` marker are treated as unknown/MATCH for lazy adoption.
	// Treating a `NULL` project marker as MATCH avoids HARD-folding an existing session until its project changes.
	if (
		meta.cachedM0ProjectIdentity !== null &&
		meta.cachedM0ProjectIdentity !== state.projectIdentity
	) {
		return piMaterializeMismatch(
			"project_change",
			"projectIdentity",
			meta.cachedM0ProjectIdentity,
			state.projectIdentity,
		);
	}
	// Idle periods exceeding TTL use `cachedM0MaterializedAt` to prevent repeated invalidation.
	// OpenCode's `cacheExpired` remains true until `lastResponseTime` changes.
	// The fold sets `cachedM0MaterializedAt` to `now`, blocking repeated invalidation until `lastResponseTime` advances.
	// The next idle period after a response rearms the `cachedM0MaterializedAt` guard.
	if (
		hard.cacheExpired &&
		hard.lastResponseTime > 0 &&
		hard.lastResponseTime > (meta.cachedM0MaterializedAt ?? 0)
	) {
		return piMaterializeMismatch(
			"ttl_idle",
			"lastResponseTimeAfterMaterialization",
			meta.cachedM0MaterializedAt ?? 0,
			hard.lastResponseTime,
		);
	}

	// An m[0] content change requires a HARD fold.
	if (cached.upgradeState !== current.upgradeState) {
		return piMaterializeMismatch(
			"renderer_upgrade",
			"upgradeState",
			cached.upgradeState,
			current.upgradeState,
		);
	}
	if (
		current.claimFormatEpoch !== DIRECT_FORMAT_EPOCH ||
		current.claimSnapshotVector === undefined ||
		current.renderedRevisionLocators === undefined ||
		meta.cachedM0ClaimFormatEpoch !== current.claimFormatEpoch ||
		meta.cachedM0ClaimSnapshotVector !==
			canonicalSnapshotVector(current.claimSnapshotVector) ||
		meta.cachedM0RenderedRevisionLocators !==
			JSON.stringify([...current.renderedRevisionLocators].sort())
	) {
		return piMaterializeMismatch(
			"project_memory_change",
			"claimSnapshotVector",
			meta.cachedM0ClaimSnapshotVector,
			canonicalSnapshotVector(current.claimSnapshotVector as SnapshotVector),
		);
	}
	// The comparison uses `!==` because a max ID decrease invalidates m[0].
	// A max ID decrease from a revert or `message.removed` must still invalidate m[0].
	// A `>` comparison would miss a max ID decrease and serve a stale cached baseline.
	if (current.maxMutationId !== (meta.cachedM0MaxMutationId ?? 0)) {
		return piMaterializeMismatch(
			"pending_mutations",
			"maxMutationId",
			meta.cachedM0MaxMutationId ?? 0,
			current.maxMutationId,
		);
	}
	// A new compartment is an m[1] delta, not a HARD trigger.
	// Compartments fold into m[0] only on HARD busts.
	// project_user_profile_version never triggers a fold; additive user profiles are an m[1] delta.
	// projectDocsHash does not trigger a fold; a HARD fold reads fresh docs and persists the rendered hash.
	// session_facts is not a render source because facts are promoted memories.
	// session_facts is pinned to version 0 and never triggers a fold.
	return { value: false, reason: null };
}

function renderUserProfileBlock(
	db: ContextDatabase,
	wrapper = "user-profile",
	memoriesOverride?: UserMemory[],
): string {
	const memories = memoriesOverride ?? safeGetActiveUserMemoriesPi(db);
	if (memories.length === 0) return "";
	return `<${wrapper}>\n${memories
		.map((memory) => `- ${escapeXmlContent(memory.content)}`)
		.join("\n")}\n</${wrapper}>`;
}

export function renderM0Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	projectDocs = readProjectDocsForPiM0(state).renderedBlock,
	decayPressureMultiplier = 1,
	claimsOverride?: ProjectMemoryClaimSnapshot[],
	compartmentsOverride?: PiCompartment[],
	userProfileOverride?: UserMemory[],
	workspaceOverride?: WorkspaceRenderContext,
	/** Pi emits mural output only for HARD folds when enabled and vision-capable.
	 * The string contains the `<memory-mural>` marker block; the PNG is a separate image part. */
	mural?: { enabled: boolean; supportsVision: boolean; dataUrl?: string },
	claimLaneOverride?: ClaimLaneSnapshot | null,
): string {
	const memPath = memoryProjectPath(state);
	const workspace =
		workspaceOverride ?? resolveWorkspaceRenderContextPi(state, db);
	const claimLane =
		claimLaneOverride ??
		(memPath
			? readClaimLaneSnapshot({ db, projectPath: memPath, workspace })
			: null);
	const claims =
		claimsOverride ??
		(claimLane === null
			? []
			: trimClaimLane(
					claimLane,
					state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
					workspace,
				));
	const memoryBlock = renderClaimMemoryBlock(claims, "project-memory", {
		sourceNameByClaimId: claimLane?.sourceNameByClaimId,
	});
	// Facts render through <project-memory>, not through decayed compartments.
	// `decayPressureMultiplier` values above `1` reduce `historyBudgetTokens` and increase decay pressure.
	const baseHistoryBudget =
		state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS;
	const decayed = renderDecayedCompartments({
		compartments:
			compartmentsOverride ?? getRenderableCompartmentsPi(db, state),
		// The renderer uses `historyBudgetTokens` rather than the memory injection budget to avoid over-demoting compartments.
		historyBudgetTokens:
			baseHistoryBudget / Math.max(1, decayPressureMultiplier),
	});
	// Pi preserves the sibling-block order used by OpenCode `renderM0`.
	// <session-history> contains only decayed compartments.
	const sections: string[] = [];
	if (projectDocs.length > 0) sections.push(projectDocs);
	// The renderer trims the baseline user profile to the budget to match OpenCode `renderM0`.
	const trimmedProfile = trimUserMemoriesToBudget(
		userProfileOverride ?? safeGetActiveUserMemoriesPi(db),
		state.userProfileBudgetTokens ?? DEFAULT_USER_PROFILE_BUDGET_TOKENS,
	);
	const userProfile = renderUserProfileBlock(
		db,
		"user-profile",
		trimmedProfile,
	);
	if (userProfile.length > 0) sections.push(userProfile);
	if (!state.compactionOff) {
		sections.push(
			decayed.length > 0
				? `<session-history>\n${decayed}\n</session-history>`
				: "<session-history></session-history>",
		);
	}
	if (memoryBlock) sections.push(memoryBlock);
	// The renderer places the mural marker after memory blocks to match OpenCode `renderM0`.
	if (mural?.enabled && mural.supportsVision && mural.dataUrl) {
		sections.push(
			"<memory-mural>\nThe project memory mural image follows.\n</memory-mural>",
		);
	}
	return sections.join("\n\n").trim();
}

/** The renderer throws when m[0] changes between marker reads and persistence.
 * */
function isTransientSqliteLockError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const { code, message } = error as { code?: unknown; message?: unknown };
	if (typeof code === "string") {
		if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
	}
	if (typeof message === "string") {
		return (
			/database is locked/i.test(message) ||
			/sqlite_(busy|locked)/i.test(message)
		);
	}
	return false;
}

export class PiMaterializeContentionError extends Error {
	constructor(reason: string) {
		super(`pi m[0] materialization contention: ${reason}`);
		this.name = "PiMaterializeContentionError";
	}
}

function readFrozenM0InputsPi(
	state: PiM0M1State,
	db: ContextDatabase,
	docs = readProjectDocsForPiM0(state),
	memoryCutoff?: number,
): FrozenM0Inputs {
	const memPath = memoryProjectPath(state);
	const workspace = resolveWorkspaceRenderContextPi(state, db);
	const compartments = getRenderableCompartmentsPi(db, state);
	const claimLane = readClaimLaneSnapshot({
		db,
		projectPath: memPath,
		workspace,
		nowMs: memoryCutoff,
	});
	if (claimLane === null) {
		throw new PiMaterializeContentionError("claim snapshot kept moving");
	}
	const claims = trimClaimLane(
		claimLane,
		state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
		workspace,
	);
	const userProfile = safeGetActiveUserMemoriesPi(db);
	const globalState = getProjectState(db, GLOBAL_USER_PROFILE_PROJECT_PATH);
	const markers: PiM0SnapshotMarkers = {
		claimFormatEpoch: DIRECT_FORMAT_EPOCH,
		claimSnapshotVector: claimLane.snapshotVector,
		renderedRevisionLocators: claims.map((item) => item.revisionLocator),
		maxCompartmentSeq: compartments.reduce(
			(max, compartment) =>
				compartment.sequence > max ? compartment.sequence : max,
			EMPTY_MAX_COMPARTMENT_SEQ,
		),
		maxMutationId: getMaxM0MutationId(db, state.sessionId) ?? 0,
		projectUserProfileVersion: globalState?.projectUserProfileVersion ?? 0,
		projectDocsHash: docs.canonicalHash,
		sessionFactsVersion: getSessionFactsVersion(db, state.sessionId),
		materializedAt: memoryCutoff ?? Date.now(),
		upgradeState: `${PI_M0_UPGRADE_STATE}:${
			compartments.some((c) => c.legacy === 1) ? "legacy" : "ready"
		}`,
		compartmentRenderEpoch: COMPARTMENT_RENDER_EPOCH,
		lastBaselineEndMessageId: lastBaselineEndMessageId(compartments),
		systemHash: (state.hardSignals ?? EMPTY_PI_HARD_SIGNALS).systemHash,
		modelKey: piModelRefToCanonical(
			(state.hardSignals ?? EMPTY_PI_HARD_SIGNALS).modelKey,
		),
		projectIdentity: state.projectIdentity,
		muralEnabled: state.muralEnabled === true,
		renderBudgetIdentity: renderBudgetIdentityPi(state),
	};
	const freshVector = readProjectMemorySnapshotVector(
		db,
		claimLane.projectIds,
		claimLane.workspaceEpoch,
	);
	if (
		snapshotVectorChanges(claimLane.snapshotVector, freshVector).length > 0 ||
		canonicalSnapshotVector(markers.claimSnapshotVector) !==
			canonicalSnapshotVector(claimLane.snapshotVector)
	) {
		throw new PiMaterializeContentionError(
			"claim snapshot changed before render",
		);
	}
	return {
		docs,
		markers,
		compartments,
		claims,
		claimLane,
		userProfile,
		workspace,
	};
}

function renderFreshM0PiNonPersisted(
	state: PiM0M1State,
	db: ContextDatabase,
): {
	m0: string;
	snapshotMarkers: PiM0SnapshotMarkers;
	renderedRevisionLocators: string[];
} {
	const docs = readProjectDocsForPiM0(state);
	const cachedMaterializedAt =
		getOrCreateSessionMeta(db, state.sessionId).cachedM0MaterializedAt ?? 0;
	const frozen = readFrozenM0InputsPi(state, db, docs, cachedMaterializedAt);
	frozen.markers.materializedAt = cachedMaterializedAt;
	const historyBudget =
		state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS;
	const memoryBudget =
		state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;
	const mural = resolveMuralForM0Pi(
		state,
		db,
		frozen.markers.modelKey,
		memoryBudget,
	);
	rememberPiMural(state.sessionId, mural);
	const render = (claims: ProjectMemoryClaimSnapshot[], dpm: number): string =>
		renderM0Pi(
			state,
			db,
			docs.renderedBlock,
			dpm,
			claims,
			frozen.compartments,
			frozen.userProfile,
			frozen.workspace,
			mural,
			frozen.claimLane,
		);
	let dpm = 1;
	let m0 = render(frozen.claims, dpm);
	let attempts = 0;
	while (
		historyBudget > 0 &&
		historySliceTokensPi(m0) > historyBudget * 1.05 &&
		attempts < 3
	) {
		dpm *= 1.15;
		m0 = render(frozen.claims, dpm);
		attempts += 1;
	}
	const freshVector = readProjectMemorySnapshotVector(
		db,
		frozen.claimLane.projectIds,
		frozen.claimLane.workspaceEpoch,
	);
	if (
		snapshotVectorChanges(frozen.claimLane.snapshotVector, freshVector).length >
		0
	) {
		m0 = render([], dpm);
		frozen.markers.claimSnapshotVector = freshVector;
		frozen.markers.renderedRevisionLocators = [];
	}
	return {
		m0,
		snapshotMarkers: frozen.markers,
		renderedRevisionLocators: frozen.markers.renderedRevisionLocators ?? [],
	};
}

export function materializeM0Pi(
	state: PiM0M1State,
	db: ContextDatabase,
): {
	m0: string;
	m1: string;
	snapshotMarkers: PiM0SnapshotMarkers;
	renderedRevisionLocators: string[];
} {
	// The fold reads markers and renders outside the write lock because rendering can be slow.
	const docs = readProjectDocsForPiM0(state);
	const foldMaterializedAt = Date.now();
	const frozen = readFrozenM0InputsPi(state, db, docs, foldMaterializedAt);
	const snapshotMarkers = frozen.markers;

	const snapshotClaims = frozen.claims;
	const snapshotCompartments = frozen.compartments;
	const snapshotUserProfile = frozen.userProfile;
	const renderedRevisionLocators = snapshotClaims.map(
		(item) => item.revisionLocator,
	);
	// On-demand murals run only during HARD folds, not deferrals.
	// When no on-demand mural is supplied, mural resolution uses `muralEnabled` and the HARD fold's model key.
	// cachedMuralBySession replays on deferral.
	const memoryBudget =
		state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;
	const mural = resolveMuralForM0Pi(
		state,
		db,
		snapshotMarkers.modelKey,
		memoryBudget,
	);
	const frozenMuralDataUrl =
		mural?.enabled && mural.supportsVision ? (mural.dataUrl ?? null) : null;
	const frozenMuralHash =
		mural?.enabled && mural.supportsVision ? (mural.contentHash ?? null) : null;
	// The renderer rerenders only when m[0] exceeds 105% of the history budget.
	let decayPressureMultiplier = 1;
	let m0 = renderM0Pi(
		state,
		db,
		docs.renderedBlock,
		decayPressureMultiplier,
		snapshotClaims,
		snapshotCompartments,
		snapshotUserProfile,
		frozen.workspace,
		mural,
		frozen.claimLane,
	);
	const historyBudget =
		state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS;
	let attempts = 0;
	while (
		historyBudget > 0 &&
		historySliceTokensPi(m0) > historyBudget * 1.05 &&
		attempts < 3
	) {
		decayPressureMultiplier *= 1.15;
		m0 = renderM0Pi(
			state,
			db,
			docs.renderedBlock,
			decayPressureMultiplier,
			snapshotClaims,
			snapshotCompartments,
			snapshotUserProfile,
			frozen.workspace,
			mural,
			frozen.claimLane,
		);
		attempts += 1;
	}
	const m0Bytes = Buffer.from(m0, "utf8");
	const phase3ProjectDocsHash = readProjectDocsForPiM0(state).canonicalHash;

	// The transaction rereads markers under `BEGIN IMMEDIATE`; changed markers invalidate the rendered output.
	// The m[0] transaction renders and persists m[1] so `cached_m0_bytes`, `cached_m1_bytes`, markers, and `memory_block_ids` remain paired.
	try {
		db.exec("BEGIN IMMEDIATE");
	} catch (error) {
		if (isTransientSqliteLockError(error)) {
			throw new PiMaterializeContentionError("begin immediate locked");
		}
		throw error;
	}
	try {
		const claimLane = frozen.claimLane;
		if (claimLane === undefined) {
			throw new PiMaterializeContentionError("missing frozen claim lane");
		}
		const currentWorkspace = resolveWorkspaceRenderContextPi(state, db);
		const currentWorkspaceEpoch =
			currentWorkspace.identities.length === 0
				? "project-memory-disabled"
				: computeWorkspaceEpochFingerprint(db, currentWorkspace.identities);
		const freshVector = readProjectMemorySnapshotVector(
			db,
			claimLane.projectIds,
			currentWorkspaceEpoch,
		);
		const currentCompartments = getRenderableCompartmentsPi(db, state);
		const currentMaxCompartmentSeq = currentCompartments.reduce(
			(max, compartment) =>
				compartment.sequence > max ? compartment.sequence : max,
			EMPTY_MAX_COMPARTMENT_SEQ,
		);
		const currentUpgradeState = `${PI_M0_UPGRADE_STATE}:${
			currentCompartments.some((compartment) => compartment.legacy === 1)
				? "legacy"
				: "ready"
		}`;
		const currentProfileVersion =
			getProjectState(db, GLOBAL_USER_PROFILE_PROJECT_PATH)
				?.projectUserProfileVersion ?? 0;
		const stale =
			snapshotVectorChanges(claimLane.snapshotVector, freshVector).length > 0 ||
			currentProfileVersion !== snapshotMarkers.projectUserProfileVersion ||
			currentMaxCompartmentSeq !== snapshotMarkers.maxCompartmentSeq ||
			(getMaxM0MutationId(db, state.sessionId) ?? 0) !==
				snapshotMarkers.maxMutationId ||
			state.projectIdentity !== snapshotMarkers.projectIdentity ||
			getSessionFactsVersion(db, state.sessionId) !==
				snapshotMarkers.sessionFactsVersion ||
			currentUpgradeState !== snapshotMarkers.upgradeState ||
			phase3ProjectDocsHash !== snapshotMarkers.projectDocsHash;
		if (stale) {
			db.exec("ROLLBACK");
			throw new PiMaterializeContentionError("snapshot changed before persist");
		}
		snapshotMarkers.materializedAt = foldMaterializedAt;

		const m1Render = renderM1PiWithMetadata(state, db, snapshotMarkers, []);
		const m1Bytes = Buffer.from(m1Render.text, "utf8");

		persistCachedM0(db, state.sessionId, {
			m0Bytes,
			muralDataUrl: frozenMuralDataUrl,
			muralHash: frozenMuralHash,
			claimFormatEpoch: DIRECT_FORMAT_EPOCH,
			claimSnapshotVector: canonicalSnapshotVector(
				frozen.claimLane.snapshotVector,
			),
			renderedRevisionLocators: JSON.stringify(
				[...renderedRevisionLocators].sort(),
			),
			projectUserProfileVersion: snapshotMarkers.projectUserProfileVersion,
			maxCompartmentSeq: snapshotMarkers.maxCompartmentSeq,
			maxMutationId: snapshotMarkers.maxMutationId,
			m1Bytes,
			projectDocsHash: snapshotMarkers.projectDocsHash,
			materializedAt: snapshotMarkers.materializedAt,
			sessionFactsVersion: snapshotMarkers.sessionFactsVersion,
			upgradeState: encodeCachedM0UpgradeIdentity(
				snapshotMarkers.upgradeState,
				snapshotMarkers.compartmentRenderEpoch,
				snapshotMarkers.muralEnabled,
				snapshotMarkers.renderBudgetIdentity,
			),
			systemHash: snapshotMarkers.systemHash,
			modelKey: snapshotMarkers.modelKey,
			projectIdentity: snapshotMarkers.projectIdentity,
		});
		db.prepare(
			"UPDATE session_meta SET memory_block_count = ?, memory_block_ids = ?, memory_block_hashes = ? WHERE session_id = ?",
		).run(
			renderedRevisionLocators.length,
			JSON.stringify([...renderedRevisionLocators].sort()),
			JSON.stringify(snapshotClaims.map((item) => item.contentDigest)),
			state.sessionId,
		);

		// Writing the trim boundary after COMMIT allows a crash to leave fresh m[0] and maxCompartmentSeq paired with a stale or null boundary.
		// A stale or null trim boundary causes the next pass to under-trim or over-trim.
		// The transaction persists the boundary with m[0], its markers, and m[1].
		setCachedBoundary(
			db,
			state.sessionId,
			snapshotMarkers.lastBaselineEndMessageId,
		);

		db.exec("COMMIT");
		rememberPiMuralPayload(
			state.sessionId,
			frozenMuralDataUrl,
			frozenMuralHash,
		);
		return {
			m0,
			m1: m1Render.text,
			snapshotMarkers,
			renderedRevisionLocators,
		};
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
		}
		throw error;
	}
}

/* */
export function materializeM0PiWithRetry(
	state: PiM0M1State,
	db: ContextDatabase,
	maxRetries = 3,
): {
	m0: string;
	m1: string;
	snapshotMarkers: PiM0SnapshotMarkers;
	renderedRevisionLocators: string[];
} {
	let lastError: PiMaterializeContentionError | null = null;
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			return materializeM0Pi(state, db);
		} catch (error) {
			if (!(error instanceof PiMaterializeContentionError)) throw error;
			lastError = error;
		}
	}
	throw (
		lastError ??
		new PiMaterializeContentionError("materialization contention exhausted")
	);
}

interface RenderM1PiResult {
	text: string;
	memoryUpdateCount: number;
}

function renderM1PiWithMetadata(
	state: PiM0M1State,
	db: ContextDatabase,
	markers: PiM0SnapshotMarkers,
	_renderedRevisionLocators: readonly string[],
	compartmentsOverride?: readonly PiCompartment[],
): RenderM1PiResult {
	if (markers.claimSnapshotVector === undefined) {
		throw new PiMaterializeContentionError("missing claim snapshot vector");
	}
	const workspace = resolveWorkspaceRenderContextPi(state, db);
	const workspaceEpoch =
		workspace.identities.length === 0
			? "project-memory-disabled"
			: computeWorkspaceEpochFingerprint(db, workspace.identities);
	const freshVector = readProjectMemorySnapshotVector(
		db,
		Object.keys(markers.claimSnapshotVector.projectGenerations).map(Number),
		workspaceEpoch,
	);
	if (
		snapshotVectorChanges(markers.claimSnapshotVector, freshVector).length > 0
	) {
		throw new PiMaterializeContentionError(
			"claim snapshot changed before m1 render",
		);
	}

	const sections: string[] = [];
	const newCompartments = (
		compartmentsOverride ?? getRenderableCompartmentsPi(db, state)
	).filter((compartment) => compartment.sequence > markers.maxCompartmentSeq);
	if (newCompartments.length > 0) {
		const body = newCompartments
			.map((compartment) => renderCompartmentAtTier(compartment, 1))
			.join("\n\n");
		sections.push(`<new-compartments>\n${body}\n</new-compartments>`);
	}

	const currentUserProfileVersion =
		getProjectState(db, GLOBAL_USER_PROFILE_PROJECT_PATH)
			?.projectUserProfileVersion ?? 0;
	if (currentUserProfileVersion !== markers.projectUserProfileVersion) {
		const profileBudget =
			state.userProfileBudgetTokens ?? DEFAULT_USER_PROFILE_BUDGET_TOKENS;
		const trimmedProfile = trimUserMemoriesToBudget(
			safeGetActiveUserMemoriesPi(db),
			Math.max(1, Math.floor(profileBudget * 0.25)),
		);
		const profileBlock = renderUserProfileBlock(
			db,
			"new-user-profile",
			trimmedProfile,
		);
		if (profileBlock) sections.push(profileBlock);
	}

	if (sections.length === 0) {
		return { text: PI_M1_PLACEHOLDER, memoryUpdateCount: 0 };
	}
	return {
		text: state.compactionOff
			? `<knowledge-updates>\n${sections.join("\n")}\n</knowledge-updates>`
			: `<session-history-since>\n${sections.join("\n")}\n</session-history-since>`,
		memoryUpdateCount: 0,
	};
}

export function renderM1Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	markers: PiM0SnapshotMarkers,
	renderedRevisionLocators: readonly string[] = [],
): string {
	return renderM1PiWithMetadata(state, db, markers, renderedRevisionLocators)
		.text;
}

interface CachedPiM0M1Row {
	cached_m0_bytes: Buffer | Uint8Array | null;
	cached_m0_mural_data_url: string | null;
	cached_m0_mural_hash: string | null;
	cached_m1_bytes: Buffer | Uint8Array | null;
	cached_m0_claim_format_epoch: number | null;
	cached_m0_claim_snapshot_vector: string | null;
	cached_m0_rendered_revision_locators: string | null;
	cached_m0_project_user_profile_version: number | null;
	cached_m0_max_compartment_seq: number | null;
	cached_m0_max_mutation_id: number | null;
	cached_m0_project_docs_hash: string | null;
	cached_m0_materialized_at: number | null;
	cached_m0_session_facts_version: number | null;
	cached_m0_upgrade_state: string | null;
	cached_m0_system_hash: string | null;
	cached_m0_model_key: string | null;
	cached_m0_project_identity: string | null;
	cached_m0_last_baseline_end_message_id: string | null;
}

function toCachedBuffer(value: Buffer | Uint8Array): Buffer {
	return Buffer.isBuffer(value)
		? value
		: Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function bufferEqualsNullable(
	left: Buffer | Uint8Array | null,
	right: Buffer | Uint8Array | null,
): boolean {
	if (left === null || right === null) return left === right;
	return toCachedBuffer(left).equals(toCachedBuffer(right));
}

function readCachedPiM0M1Row(
	db: ContextDatabase,
	sessionId: string,
): CachedPiM0M1Row | null {
	return db
		.prepare(
			`SELECT cached_m0_bytes, cached_m0_mural_data_url,
					cached_m0_mural_hash, cached_m1_bytes,
					cached_m0_claim_format_epoch,
					cached_m0_claim_snapshot_vector,
					cached_m0_rendered_revision_locators,
					cached_m0_project_user_profile_version,
					cached_m0_max_compartment_seq,
					cached_m0_max_mutation_id,
					cached_m0_project_docs_hash,
					cached_m0_materialized_at,
					cached_m0_session_facts_version,
					cached_m0_upgrade_state,
					cached_m0_system_hash,
					cached_m0_model_key,
					cached_m0_project_identity,
					cached_m0_last_baseline_end_message_id
			   FROM session_meta
			  WHERE session_id = ?`,
		)
		.get(sessionId) as CachedPiM0M1Row | null;
}

function markersFromCachedPiRow(
	row: CachedPiM0M1Row,
	compartmentsForNormalization: readonly PiCompartment[],
): PiM0SnapshotMarkers | null {
	if (!row.cached_m0_bytes) return null;
	const cachedUpgradeIdentity = decodeCachedM0UpgradeIdentity(
		row.cached_m0_upgrade_state,
	);
	const claimSnapshotVector = parsePiSnapshotVector(
		row.cached_m0_claim_snapshot_vector,
	);
	const renderedRevisionLocators = parsePiRevisionLocators(
		row.cached_m0_rendered_revision_locators,
	);
	if (row.cached_m0_claim_format_epoch === null) return null;
	if (claimSnapshotVector === null || renderedRevisionLocators === null)
		return null;
	if (row.cached_m0_project_user_profile_version === null) return null;
	if (row.cached_m0_max_compartment_seq === null) return null;
	if (row.cached_m0_max_mutation_id === null) return null;
	if (row.cached_m0_session_facts_version === null) return null;
	if (row.cached_m0_materialized_at === null) return null;
	if (row.cached_m0_upgrade_state === null) return null;
	return {
		claimFormatEpoch: row.cached_m0_claim_format_epoch,
		claimSnapshotVector,
		renderedRevisionLocators,
		maxCompartmentSeq: normalizeCachedMaxCompartmentSeq(
			row.cached_m0_max_compartment_seq,
			compartmentsForNormalization,
		),
		maxMutationId: row.cached_m0_max_mutation_id,
		projectUserProfileVersion: row.cached_m0_project_user_profile_version,
		projectDocsHash: row.cached_m0_project_docs_hash ?? "",
		materializedAt: row.cached_m0_materialized_at,
		sessionFactsVersion: row.cached_m0_session_facts_version,
		upgradeState: cachedUpgradeIdentity.upgradeState ?? "",
		compartmentRenderEpoch: cachedUpgradeIdentity.compartmentRenderEpoch,
		lastBaselineEndMessageId:
			typeof row.cached_m0_last_baseline_end_message_id === "string" &&
			row.cached_m0_last_baseline_end_message_id.length > 0
				? row.cached_m0_last_baseline_end_message_id
				: null,
		systemHash: row.cached_m0_system_hash ?? "",
		modelKey: row.cached_m0_model_key ?? "",
		projectIdentity: row.cached_m0_project_identity ?? null,
		muralEnabled: cachedUpgradeIdentity.muralEnabled ?? false,
		renderBudgetIdentity: cachedUpgradeIdentity.renderBudgetIdentity ?? "",
	};
}

function cachedPiRowMatchesSnapshot(args: {
	row: CachedPiM0M1Row;
	m0Bytes: Buffer;
	markers: PiM0SnapshotMarkers;
	compartmentsForNormalization: readonly PiCompartment[];
}): boolean {
	const rowMarkers = markersFromCachedPiRow(
		args.row,
		args.compartmentsForNormalization,
	);
	if (!rowMarkers) return false;
	return (
		bufferEqualsNullable(args.row.cached_m0_bytes, args.m0Bytes) &&
		rowMarkers.claimFormatEpoch === args.markers.claimFormatEpoch &&
		rowMarkers.claimSnapshotVector !== undefined &&
		args.markers.claimSnapshotVector !== undefined &&
		canonicalSnapshotVector(rowMarkers.claimSnapshotVector) ===
			canonicalSnapshotVector(args.markers.claimSnapshotVector) &&
		JSON.stringify([...(rowMarkers.renderedRevisionLocators ?? [])].sort()) ===
			JSON.stringify(
				[...(args.markers.renderedRevisionLocators ?? [])].sort(),
			) &&
		rowMarkers.projectUserProfileVersion ===
			args.markers.projectUserProfileVersion &&
		rowMarkers.maxCompartmentSeq === args.markers.maxCompartmentSeq &&
		rowMarkers.maxMutationId === args.markers.maxMutationId &&
		rowMarkers.materializedAt === args.markers.materializedAt &&
		rowMarkers.sessionFactsVersion === args.markers.sessionFactsVersion &&
		(rowMarkers.upgradeState ?? null) === (args.markers.upgradeState ?? null) &&
		rowMarkers.compartmentRenderEpoch === args.markers.compartmentRenderEpoch &&
		// A new system, tool, or model identity invalidates this process's cached row so the soft-refresh CAS adopts a sibling's m[0].
		(rowMarkers.systemHash ?? "") === (args.markers.systemHash ?? "") &&
		piModelRefToCanonical(rowMarkers.modelKey ?? "") ===
			piModelRefToCanonical(args.markers.modelKey ?? "") &&
		(rowMarkers.projectIdentity ?? null) ===
			(args.markers.projectIdentity ?? null)
	);
}

function adoptCachedPiProjectIdentity(
	db: ContextDatabase,
	state: PiM0M1State,
): void {
	db.prepare(
		"UPDATE session_meta SET cached_m0_project_identity = ? WHERE session_id = ? AND cached_m0_project_identity IS NULL",
	).run(state.projectIdentity, state.sessionId);
}

function decodeCachedM1(row: CachedPiM0M1Row, sessionId: string): string {
	if (!row.cached_m1_bytes) {
		throw new PiMaterializeContentionError(
			`missing cached m[1] for ${sessionId}`,
		);
	}
	return decodeCachedM0(row.cached_m1_bytes) ?? PI_M1_PLACEHOLDER;
}

function applyCachedPiRow(args: {
	row: CachedPiM0M1Row;
	state: PiM0M1State;
	compartmentsForNormalization: readonly PiCompartment[];
}): { m0: string; m1: string; markers: PiM0SnapshotMarkers } {
	const markers = markersFromCachedPiRow(
		args.row,
		args.compartmentsForNormalization,
	);
	const m0 = decodeCachedM0(args.row.cached_m0_bytes);
	if (!m0 || !markers || !args.row.cached_m1_bytes) {
		throw new PiMaterializeContentionError(
			`invalid cached m[0]/m[1] for ${args.state.sessionId}`,
		);
	}
	rememberPiMuralPayload(
		args.state.sessionId,
		args.row.cached_m0_mural_data_url,
		args.row.cached_m0_mural_hash,
	);
	return {
		m0,
		m1: decodeCachedM1(args.row, args.state.sessionId),
		markers,
	};
}

function replayCachedM1Pi(
	db: ContextDatabase,
	state: PiM0M1State,
	compartmentsForNormalization: readonly PiCompartment[],
): { m0: string; m1: string; markers: PiM0SnapshotMarkers } {
	const row = readCachedPiM0M1Row(db, state.sessionId);
	if (!row) {
		throw new PiMaterializeContentionError(
			`missing cached m[0]/m[1] for ${state.sessionId}`,
		);
	}
	return applyCachedPiRow({ row, state, compartmentsForNormalization });
}

function softRefreshCachedM1Pi(args: {
	state: PiM0M1State;
	db: ContextDatabase;
	m0Bytes: Buffer;
	markers: PiM0SnapshotMarkers;
	compartmentsForNormalization: readonly PiCompartment[];
}): {
	m0: string;
	m1: string;
	markers: PiM0SnapshotMarkers;
	memoryUpdateCount: number;
	recomputed: boolean;
} {
	args.db.exec("BEGIN IMMEDIATE");
	try {
		const row = readCachedPiM0M1Row(args.db, args.state.sessionId);
		if (
			!row ||
			!cachedPiRowMatchesSnapshot({
				row,
				m0Bytes: args.m0Bytes,
				markers: args.markers,
				compartmentsForNormalization: args.compartmentsForNormalization,
			})
		) {
			args.db.exec("ROLLBACK");
			const sibling = readCachedPiM0M1Row(args.db, args.state.sessionId);
			if (!sibling) {
				throw new PiMaterializeContentionError(
					`missing sibling cached m[0]/m[1] for ${args.state.sessionId}`,
				);
			}
			const siblingCompartments = getRenderableCompartmentsPi(
				args.db,
				args.state,
			);
			return {
				...applyCachedPiRow({
					row: sibling,
					state: args.state,
					compartmentsForNormalization: siblingCompartments,
				}),
				memoryUpdateCount: 0,
				recomputed: false,
			};
		}

		const markers = markersFromCachedPiRow(
			row,
			args.compartmentsForNormalization,
		);
		if (!markers) {
			throw new PiMaterializeContentionError(
				`invalid cached m[0] markers for ${args.state.sessionId}`,
			);
		}
		const rendered = renderM1PiWithMetadata(
			args.state,
			args.db,
			markers,
			markers.renderedRevisionLocators ?? [],
			// New compartments use the snapshot that advances the trim boundary, preventing a concurrent publish from placing a compartment in m[1] while its raw messages remain in the tail.
			args.compartmentsForNormalization,
		);
		const m1Bytes = Buffer.from(rendered.text, "utf8");
		// The transaction advances the trim boundary with m[1] so summarized raw messages do not remain in the tail.
		// The cache persists the boundary with cached_m1_bytes so replay reads a consistent trim point.
		const latestCompartment = args.compartmentsForNormalization.at(-1);
		const advancedBoundary =
			latestCompartment?.endMessageId &&
			latestCompartment.endMessageId.length > 0
				? latestCompartment.endMessageId
				: markers.lastBaselineEndMessageId;
		args.db
			.prepare(
				"UPDATE session_meta SET cached_m1_bytes = ?, cached_m0_last_baseline_end_message_id = ? WHERE session_id = ?",
			)
			.run(m1Bytes, advancedBoundary, args.state.sessionId);
		args.db.exec("COMMIT");
		return {
			m0: decodeCachedM0(row.cached_m0_bytes) ?? "",
			m1: rendered.text,
			markers: { ...markers, lastBaselineEndMessageId: advancedBoundary },
			memoryUpdateCount: rendered.memoryUpdateCount,
			recomputed: true,
		};
	} catch (error) {
		try {
			args.db.exec("ROLLBACK");
		} catch {
		}
		throw error;
	}
}

function findCompartmentBoundaryForSnapshot(
	markers: PiM0SnapshotMarkers,
): string | null {
	if (markers.maxCompartmentSeq < 0) return null;
	return markers.lastBaselineEndMessageId;
}

function resolveRenderedCompartmentBoundary(
	compartments: readonly PiCompartment[],
	boundaryId: string | null,
): PiRenderedCompartmentBoundary {
	if (!boundaryId) return { endMessageId: null, ordinal: null };
	const boundary = compartments.find(
		(compartment) => compartment.endMessageId === boundaryId,
	);
	return {
		endMessageId: boundaryId,
		ordinal:
			typeof boundary?.endMessage === "number" ? boundary.endMessage : null,
	};
}

function prependM0M1Messages(
	piMessages: PiAgentMessage[],
	m0: string,
	m1: string,
	mural?: { enabled: boolean; supportsVision: boolean; dataUrl?: string },
): void {
	const firstTimestamp = piMessages[0]?.timestamp;
	const baseTimestamp =
		typeof firstTimestamp === "number" ? firstTimestamp : Date.now();
	// Pi's native image part is `{ type: "image", data: base64, mimeType }`.
	// Pi treats a file part containing a data URL differently from its native image envelope, even when both contain the same PNG bytes.
	const muralImage =
		mural?.enabled && mural.supportsVision && mural.dataUrl
			? piImageFromDataUrl(mural.dataUrl)
			: null;
	const m0Content: (PiTextContent | PiImageContent)[] = [
		{ type: "text", text: m0 },
		...(muralImage ? [muralImage] : []),
	];
	piMessages.unshift(
		{
			role: "user",
			content: m0Content,
			timestamp: baseTimestamp - 2,
		},
		{
			role: "user",
			content: [{ type: "text", text: m1 }],
			timestamp: baseTimestamp - 1,
		},
	);
}

export function injectM0M1Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	piMessages: PiAgentMessage[],
	entryIds?: readonly (string | undefined)[],
	recomputeM1ThisPass = false,
): PiM0M1InjectionResult {
	// The materialization decision and marker reloads use one snapshot so concurrent count changes cannot bypass the guarded fallback.
	const currentCompartments = getRenderableCompartmentsPi(db, state);
	let decision = mustMaterializePi(state, db, currentCompartments);
	if (decision.value) {
		const mismatch = decision.mismatch
			? ` mismatch=${JSON.stringify(decision.mismatch)}`
			: "";
		logSession(
			state.sessionId,
			`pi m[0] HARD fold firing: reason=${decision.reason ?? "unknown"}${mismatch}`,
		);
	}
	let m0 = "";
	let m1 = PI_M1_PLACEHOLDER;
	let markers: PiM0SnapshotMarkers | null = null;
	let materialized = false;
	let contentionExhausted = false;
	let memoryUpdateCount = 0;
	let m1Recomputed = false;
	let freshFallbackRenderedRevisionLocators: string[] | null = null;

	if (decision.value) {
		// On contention exhaustion, the renderer serves the cached m[0]/m[1] pair so injection retains the history block.
		try {
			const result = materializeM0PiWithRetry(state, db);
			m0 = result.m0;
			m1 = result.m1;
			markers = result.snapshotMarkers;
			materialized = true;
			m1Recomputed = true;
		} catch (error) {
			if (!(error instanceof PiMaterializeContentionError)) throw error;
			try {
				const cached = replayCachedM1Pi(db, state, currentCompartments);
				contentionExhausted = true;
				m0 = cached.m0;
				m1 = cached.m1;
				markers = cached.markers;
				logSession(
					state.sessionId,
					"pi m[0] materialization contention exhausted; reusing cached m[0]/m[1]",
				);
			} catch {
				// When a cache-bust clears the baseline before contention, the renderer produces an uncached pair instead of omitting the history block.
				const fresh = renderFreshM0PiNonPersisted(state, db);
				m0 = fresh.m0;
				markers = fresh.snapshotMarkers;
				freshFallbackRenderedRevisionLocators = fresh.renderedRevisionLocators;
				contentionExhausted = true;
				logSession(
					state.sessionId,
					"pi m[0] materialization contention exhausted with no cached fallback; rendered fresh non-persisted m[0]/m[1]",
				);
			}
		}
	} else {
		const meta = getOrCreateSessionMeta(db, state.sessionId);
		m0 = decodeCachedM0(meta.cachedM0Bytes) ?? "";
		rememberPiMuralPayload(
			state.sessionId,
			meta.cachedM0MuralDataUrl,
			meta.cachedM0MuralHash,
		);
		markers = getCachedMarkers(db, state, currentCompartments);
		if (!m0 || !markers) {
			decision = { value: true, reason: "cache_invalid" };
			try {
				const result = materializeM0PiWithRetry(state, db);
				m0 = result.m0;
				m1 = result.m1;
				markers = result.snapshotMarkers;
				materialized = true;
				m1Recomputed = true;
			} catch (error) {
				if (!(error instanceof PiMaterializeContentionError)) throw error;
				// When lock contention leaves no usable cached pair, the renderer produces a non-persisted pair to retain the history block.
				const fresh = renderFreshM0PiNonPersisted(state, db);
				m0 = fresh.m0;
				markers = fresh.snapshotMarkers;
				freshFallbackRenderedRevisionLocators = fresh.renderedRevisionLocators;
				contentionExhausted = true;
				logSession(
					state.sessionId,
					"pi m[0] cache_invalid materialization contention exhausted; rendered fresh non-persisted m[0]/m[1]",
				);
			}
		}
	}

	if (!markers) {
		throw new PiMaterializeContentionError(
			`missing m[0] markers for ${state.sessionId}`,
		);
	}
	if (!materialized && markers.projectIdentity === null) {
		adoptCachedPiProjectIdentity(db, state);
		markers = { ...markers, projectIdentity: state.projectIdentity };
	}

	if (materialized) {
	} else if (contentionExhausted && freshFallbackRenderedRevisionLocators) {
		const freshM1 = renderM1PiWithMetadata(state, db, markers, []);
		m1 = freshM1.text;
		memoryUpdateCount = freshM1.memoryUpdateCount;
		m1Recomputed = true;
	} else if (contentionExhausted) {
	} else if (recomputeM1ThisPass) {
		const refreshed = softRefreshCachedM1Pi({
			state,
			db,
			m0Bytes: Buffer.from(m0, "utf8"),
			markers,
			compartmentsForNormalization: currentCompartments,
		});
		m0 = refreshed.m0;
		m1 = refreshed.m1;
		markers = refreshed.markers;
		memoryUpdateCount = refreshed.memoryUpdateCount;
		m1Recomputed = refreshed.recomputed;
	} else {
		const replayed = replayCachedM1Pi(db, state, currentCompartments);
		m0 = replayed.m0;
		m1 = replayed.m1;
		markers = replayed.markers;
	}

	// The ratio requires m[0] to contain at least 500 tokens so small early snapshots do not trigger refolds.
	// The absolute cap bounds m[1] while the ratio check is disabled below 500 m[0] tokens.
	// The ratio compares token counts on both sides, not character lengths.
	const M0_DRIFT_RATIO_FLOOR_TOKENS = 500;
	const M1_DRIFT_RATIO = 0.15;
	const M1_ABSOLUTE_CAP_RATIO = 0.2;
	const m1AbsoluteBudget =
		(state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS) *
		M1_ABSOLUTE_CAP_RATIO;
	const m1HasContent = m1 !== PI_M1_PLACEHOLDER;
	const { m0Tokens, m1Tokens } = cachedInjectionTokenCounts(
		state.sessionId,
		m0,
		m1,
	);
	const m1OverAbsoluteCap = m1HasContent && m1Tokens > m1AbsoluteBudget;
	if (
		!materialized &&
		!contentionExhausted &&
		m1Recomputed &&
		recomputeM1ThisPass &&
		(memoryUpdateCount > 40 ||
			m1OverAbsoluteCap ||
			(m1HasContent &&
				m0Tokens >= M0_DRIFT_RATIO_FLOOR_TOKENS &&
				m1Tokens > m0Tokens * M1_DRIFT_RATIO))
	) {
		decision = { value: true, reason: "drift" };
		try {
			const result = materializeM0PiWithRetry(state, db);
			m0 = result.m0;
			m1 = result.m1;
			markers = result.snapshotMarkers;
			materialized = true;
		} catch (error) {
			if (!(error instanceof PiMaterializeContentionError)) throw error;
		}
	}

	const boundaryId = findCompartmentBoundaryForSnapshot(markers);
	const renderedBoundary = resolveRenderedCompartmentBoundary(
		currentCompartments,
		boundaryId,
	);
	// The drain may apply only when m[1] rendered the compartment during the current pass.
	// The coverage watermark must derive from rendered compartments, not live DB rows.
	// Keep the coverage watermark null when m[1] is replayed or borrowed; neither branch rendered compartments eligible for draining.
	let m1RenderedCoverage: PiRenderedCompartmentBoundary | null = null;
	if (m1Recomputed && !contentionExhausted) {
		const latestM1Compartment = currentCompartments.at(-1);
		if (
			latestM1Compartment &&
			latestM1Compartment.sequence > markers.maxCompartmentSeq &&
			latestM1Compartment.endMessageId.length > 0
		) {
			m1RenderedCoverage = {
				endMessageId: latestM1Compartment.endMessageId,
				ordinal:
					typeof latestM1Compartment.endMessage === "number"
						? latestM1Compartment.endMessage
						: null,
			};
		}
	}
	const skippedVisibleMessages = boundaryId
		? trimPiMessagesToBoundary(piMessages, entryIds, boundaryId)
		: 0;
	const publishWorkspace = resolveWorkspaceRenderContextPi(state, db);
	const publishedVector = markers.claimSnapshotVector;
	const publishWorkspaceEpoch =
		publishWorkspace.identities.length === 0
			? "project-memory-disabled"
			: computeWorkspaceEpochFingerprint(db, publishWorkspace.identities);
	const claimLaneMoved =
		publishedVector === undefined ||
		snapshotVectorChanges(
			publishedVector,
			readProjectMemorySnapshotVector(
				db,
				Object.keys(publishedVector?.projectGenerations ?? {}).map(Number),
				publishWorkspaceEpoch,
			),
		).length > 0;
	if (claimLaneMoved) {
		m0 = stripProjectMemoryBlock(m0);
		rememberPiMuralPayload(state.sessionId, null, null);
		db.prepare(
			"UPDATE session_meta SET memory_block_count = 0, memory_block_ids = '[]', memory_block_hashes = '[]' WHERE session_id = ?",
		).run(state.sessionId);
	}
	const muralWire = m0.includes("<memory-mural>")
		? muralForWire(state.sessionId)
		: undefined;
	if (!muralWire) m0 = stripMemoryMuralBlock(m0);
	prependM0M1Messages(piMessages, m0, m1, muralWire);
	logSession(
		state.sessionId,
		`injected m[0]/m[1] into Pi messages (${m0.length} + ${m1.length} bytes, materialized=${materialized}${decision.reason ? ` reason=${decision.reason}` : ""})`,
	);
	const memPath = memoryProjectPath(state);
	const claimLane = readClaimLaneSnapshot({
		db,
		projectPath: memPath,
		workspace: publishWorkspace,
	});
	const memoryCount = claimLane?.items.length ?? 0;
	return {
		injected: true,
		compartmentCount: currentCompartments.length,
		factCount: 0, // v2: facts retired as a render source (facts = promoted memories)
		memoryCount,
		skippedVisibleMessages,
		m0Materialized: materialized,
		m0Reason: decision.reason,
		m0Bytes: m0.length,
		m1Bytes: m1.length,
		contentionExhausted,
		renderedBoundary,
		m1RenderedCoverage,
		syntheticLeadingCount: 2,
	};
}

export function clearM0M1PiCache(
	db: ContextDatabase,
	sessionId: string,
	reason: string,
): void {
	clearCachedM0M1(db, sessionId);
	setCachedBoundary(db, sessionId, null);
	cachedMuralBySession.delete(sessionId);
	logSession(sessionId, `cleared cached m[0] (${reason})`);
}

export interface PiInjectionResult {
	injected: boolean;
	compartmentCount: number;
	factCount: number;
	memoryCount: number;
	skippedVisibleMessages: number;
}
