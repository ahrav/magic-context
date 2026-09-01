/**
 * (packages/plugin/src/hooks/magic-context/heuristic-cleanup.ts).
 *
 *
 * Pi assistant messages represent tool calls as `"toolCall"` parts with `{ id, name, arguments }`.
 * `ctx_reduce` removal reads Pi message shape directly; only providers that can drop empty sentinels discover new stale calls.
 * `applyFlushedStatuses` replays existing dropped tags for every provider.
 *
 * `applyCavemanCleanup` and `stripSystemInjection` consume `TagTarget` and require no Pi-specific adaptation.
 *
 * The cleanup entry point executes unconditionally; callers enforce scheduler-execute, explicit-flush, and force-materialization gating.
 *
 * `tags.status`, `tags.drop_mode`, `source_contents`, and `tags.caveman_depth` persist cleanup state so defer passes preserve visible message bytes.
 * Defer passes read persisted cleanup state through `applyFlushedStatuses` and `replayCavemanCompression`.
 * across passes.
 */

import { CTX_REDUCE_KEEP } from "@magic-context/core/features/magic-context/reclaim-protection";
import {
	type ContextDatabase,
	getActiveTagsBySession,
	getMaxTagNumberBySession,
	replaceSourceContent,
	updateTagDropMode,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage";
import {
	getEmergencyInputSample,
	setEmergencyDropSample,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import type { TagEntry } from "@magic-context/core/features/magic-context/types";
import {
	applyCavemanCleanup,
	type CavemanCleanupConfig,
} from "@magic-context/core/hooks/magic-context/caveman-cleanup";
import {
	type EmergencyDropTag,
	planEmergencyDrop,
} from "@magic-context/core/hooks/magic-context/emergency-drop";
import { stripSystemInjection } from "@magic-context/core/hooks/magic-context/system-injection-stripper";
import type { TagTarget } from "@magic-context/core/hooks/magic-context/tag-messages";
import { stripTagPrefix } from "@magic-context/core/hooks/magic-context/tag-part-guards";
import { sessionLog } from "@magic-context/core/shared/logger";

/**
 * Keep budget for duplicate read-only tool outputs — one value shared with
 * the OpenCode plugin (`CTX_REDUCE_KEEP`).
 */
export const PI_CTX_REDUCE_KEEP = CTX_REDUCE_KEEP;

/**
 * Dedup applies only to read-only tools whose outputs are deterministic given
 * the same input — duplicate calls are wasted context. Anything mutating
 * (write/edit/bash/etc.) is intentionally excluded because two identical
 * calls may have different semantics in different positions of the
 * conversation.
 */
const DEDUP_SAFE_TOOLS = new Set([
	"mcp_grep",
	"mcp_read",
	"mcp_glob",
	"mcp_ast_grep_search",
	"mcp_lsp_diagnostics",
	"mcp_lsp_symbols",
	"mcp_lsp_find_references",
	"mcp_lsp_goto_definition",
	"mcp_lsp_prepare_rename",
]);

export interface PiHeuristicCleanupConfig {
	protectedTags: number;
	/**
	 * `staleReduceStripEnabled` permits discovery of new stale `ctx_reduce` strips; existing drops replay for every provider.
	 */
	staleReduceStripEnabled: boolean;
	/**
	 * `emergency` configures tiered target-headroom drops.
	 */
	emergency?: {
		currentTotalInputTokens: number;
		ceilingTokens: number;
	};
	/**
	 * Forward `caveman` only for primary sessions with caveman enabled.
	 */
	caveman?: CavemanCleanupConfig;
}

export interface PiHeuristicCleanupResult {
	droppedTools: number;
	deduplicatedTools: number;
	droppedInjections: number;
	droppedStaleReduceCalls: number;
	emergencyDroppedTools: number;
	compressedTextTags: number;
	mutatedTextTags: number;
}

/**
 *
 *
 */
function buildPiToolFingerprints(
	messages: readonly unknown[],
	resolveStableId: (msg: unknown, index: number) => string | undefined,
): Map<string, string> {
	const fingerprints = new Map<string, string>();
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		const msg = message as {
			role?: unknown;
			content?: unknown;
			timestamp?: number;
		};
		if (msg.role !== "assistant") continue;
		if (!Array.isArray(msg.content)) continue;
		// ownerMsgId MUST match the id the transcript tagged this message with
		const ownerMsgId = resolveStableId(message, i);
		if (!ownerMsgId) continue;
		for (const part of msg.content) {
			if (!part || typeof part !== "object") continue;
			const p = part as {
				type?: unknown;
				id?: unknown;
				name?: unknown;
				arguments?: unknown;
			};
			if (p.type !== "toolCall") continue;
			if (typeof p.name !== "string") continue;
			if (!DEDUP_SAFE_TOOLS.has(p.name)) continue;
			if (typeof p.id !== "string" || p.id.length === 0) continue;
			// Sentinel `toolCall` parts represent already-dropped tools; skip them.
			const args = p.arguments;
			if (
				args &&
				typeof args === "object" &&
				"__magic_context_dropped__" in (args as Record<string, unknown>)
			) {
				continue;
			}
			let serialized: string;
			try {
				serialized = JSON.stringify(args ?? {});
			} catch {
				continue; // unrepresentable args — skip dedup for this call
			}
			// Include `ownerMsgId` in both the key and fingerprint so tools from different assistant messages remain distinct.
			const fingerprint = `${ownerMsgId}:${p.name}:${serialized}`;
			const compositeKey = `${ownerMsgId}\x00${p.id}`;
			fingerprints.set(compositeKey, fingerprint);
		}
	}
	return fingerprints;
}

/**
 * Identify stale `ctx_reduce` tool calls by COMPOSITE (owner, callId) identity.
 *
 * A bare `callId` match is unsafe because Pi/OpenCode can reuse tool call IDs across assistant messages.
 *
 * The newest `ctx_reduce` calls remain visible even when they precede `toolAgeCutoff`.
 * Return composite IDs for owner-tagged rows and bare call IDs for legacy NULL-owner rows.
 * Match legacy NULL-owner rows by `callId` alone.
 */
function collectStaleReduceCallIds(
	messages: readonly unknown[],
	messageIdToMaxTag: Map<string, number>,
	ctxReduceTagNumbers: ReadonlyMap<string, number>,
	toolAgeCutoff: number,
	resolveStableId: (msg: unknown, index: number) => string | undefined,
): { composite: Set<string>; bareCallIds: Set<string> } {
	const reduceCalls = new Map<
		string,
		{ composite: string; callId: string; maxTag: number; messageIndex: number }
	>();
	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as {
			role?: unknown;
			content?: unknown;
			timestamp?: number;
		};
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const stableId = resolveStableId(raw, i);
		if (!stableId) continue;
		const ownerMaxTag = messageIdToMaxTag.get(stableId) ?? 0;

		for (const part of msg.content) {
			if (!part || typeof part !== "object") continue;
			const p = part as { type?: unknown; name?: unknown; id?: unknown };
			if (p.type !== "toolCall") continue;
			if (p.name !== "ctx_reduce") continue;
			if (typeof p.id !== "string" || p.id.length === 0) continue;
			const composite = `${stableId}\x00${p.id}`;
			const maxTag = ctxReduceTagNumbers.get(composite) ?? ownerMaxTag;
			if (maxTag === 0) continue;
			reduceCalls.set(composite, {
				composite,
				callId: p.id,
				maxTag,
				messageIndex: i,
			});
		}
	}

	const newestFirst = [...reduceCalls.values()].sort((left, right) => {
		const byPosition =
			right.maxTag - left.maxTag || right.messageIndex - left.messageIndex;
		if (byPosition !== 0) return byPosition;
		if (left.composite === right.composite) return 0;
		return left.composite < right.composite ? 1 : -1;
	});
	const protectedComposite = new Set(
		newestFirst.slice(0, PI_CTX_REDUCE_KEEP).map((call) => call.composite),
	);
	const composite = new Set<string>();
	const bareCallIds = new Set<string>();
	for (const call of newestFirst) {
		if (call.maxTag > toolAgeCutoff || protectedComposite.has(call.composite))
			continue;
		composite.add(call.composite);
		bareCallIds.add(call.callId);
	}
	return { composite, bareCallIds };
}

/**
 *
 *
 * Each cleanup pass uses its own transaction, so completed passes survive a later pass failure.
 */
export function applyPiHeuristicCleanup(
	sessionId: string,
	db: ContextDatabase,
	targets: Map<number, TagTarget>,
	piMessages: readonly unknown[],
	config: PiHeuristicCleanupConfig,
	preloadedTags?: TagEntry[],
	// Use the transcript's stable-ID resolver so owner IDs match `messageIdToMaxTag` keys.
	resolveId?: (msg: unknown, index: number) => string | undefined,
): PiHeuristicCleanupResult {
	const resolveStableId = (msg: unknown, index: number): string | undefined => {
		if (resolveId) return resolveId(msg, index);
		if (!msg || typeof msg !== "object") return undefined;
		const m = msg as { role?: unknown; timestamp?: number };
		const role = typeof m.role === "string" ? m.role : "unknown";
		return typeof m.timestamp === "number"
			? `pi-msg-${index}-${m.timestamp}-${role}`
			: `pi-msg-${index}-${role}`;
	};

	const tags = preloadedTags ?? getActiveTagsBySession(db, sessionId);
	// `maxTag` includes dropped and compacted tags so the protected window anchors to the latest tag regardless of status.
	const maxTag = getMaxTagNumberBySession(db, sessionId);
	const protectedCutoff = maxTag - config.protectedTags;
	const toolAgeCutoff = protectedCutoff;

	let droppedTools = 0;
	let emergencyDroppedTools = 0;
	let deduplicatedTools = 0;
	let droppedInjections = 0;
	let droppedStaleReduceCalls = 0;

	if (config.emergency) {
		const emergency = config.emergency;
		const priorInputSample = getEmergencyInputSample(db, sessionId);
		const droppableTags = tags.filter(
			(t) =>
				t.status === "active" &&
				t.type === "tool" &&
				targets.get(t.tagNumber)?.canDrop?.(),
		);
		const activeTags = tags.filter((t) => t.status === "active");
		const plan = planEmergencyDrop({
			tags: droppableTags as readonly EmergencyDropTag[],
			floorTags: activeTags as readonly EmergencyDropTag[],
			maxTag,
			protectedTags: config.protectedTags,
			currentTotalInputTokens: emergency.currentTotalInputTokens,
			ceilingTokens: emergency.ceilingTokens,
			priorInputSample,
			hasPriorDrop: priorInputSample > 0,
		});
		if (plan.shouldDrop) {
			const toDrop = new Set(plan.tagNumbers);
			const newestEmergencyTags = new Set(
				droppableTags
					.slice()
					.sort((left, right) => right.tagNumber - left.tagNumber)
					.slice(0, 20)
					.map((tag) => tag.tagNumber),
			);
			db.transaction(() => {
				for (const tag of tags) {
					if (!toDrop.has(tag.tagNumber)) continue;
					if (tag.status !== "active" || tag.type !== "tool") continue;
					const target = targets.get(tag.tagNumber);
					const recent = newestEmergencyTags.has(tag.tagNumber);
					const result = recent
						? (target?.truncate?.() ?? target?.drop?.() ?? "absent")
						: (target?.drop?.() ?? "absent");
					if (result === "removed" || result === "truncated") {
						updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
						updateTagDropMode(
							db,
							sessionId,
							tag.tagNumber,
							recent ? "truncated" : "full",
						);
						droppedTools++;
						emergencyDroppedTools++;
					}
				}
				// The emergency pass records its input sample after the transaction, even when it removes no target.
			})();
			sessionLog(sessionId, `emergency tiered drop: ${plan.reason}`);
		} else {
			sessionLog(sessionId, `emergency tiered drop skipped: ${plan.reason}`);
		}
		setEmergencyDropSample(db, sessionId, emergency.currentTotalInputTokens);
	}

	const staleReduce = config.staleReduceStripEnabled
		? collectStaleReduceCallIds(
				piMessages,
				buildMessageIdToMaxTagFromTargets(targets),
				buildCtxReduceTagNumbers(tags),
				toolAgeCutoff,
				resolveStableId,
			)
		: { composite: new Set<string>(), bareCallIds: new Set<string>() };
	if (
		config.staleReduceStripEnabled &&
		(staleReduce.composite.size > 0 || staleReduce.bareCallIds.size > 0)
	) {
		db.transaction(() => {
			for (const tag of tags) {
				if (tag.status !== "active") continue;
				if (tag.type !== "tool") continue;
				if (!tag.messageId) continue;
				const matched = tag.toolOwnerMessageId
					? staleReduce.composite.has(
							`${tag.toolOwnerMessageId}\x00${tag.messageId}`,
						)
					: staleReduce.bareCallIds.has(tag.messageId);
				if (!matched) continue;
				const target = targets.get(tag.tagNumber);
				const result = target?.drop?.() ?? "absent";
				if (result === "incomplete") continue;
				updateTagDropMode(db, sessionId, tag.tagNumber, "full");
				updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
				if (result === "removed" || result === "truncated") {
					droppedStaleReduceCalls++;
				}
			}
		})();
	}

	db.transaction(() => {
		for (const tag of tags) {
			if (tag.status !== "active") continue;
			if (tag.tagNumber > protectedCutoff) continue;
			if (tag.type !== "message") continue;

			const target = targets.get(tag.tagNumber);
			if (!target) continue;

			const content = target.getContent?.();
			if (!content) continue;

			const stripped = stripSystemInjection(content);
			if (stripped === null) continue;
			const strippedSource = stripTagPrefix(stripped);

			if (strippedSource.trim().length === 0) {
				const dropResult = target.drop?.() ?? "absent";
				const didReplace =
					dropResult === "absent"
						? target.setContent(`[dropped §${tag.tagNumber}§]`)
						: false;
				if (dropResult === "removed" || dropResult === "absent") {
					replaceSourceContent(db, sessionId, tag.tagNumber, "");
					updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
					if (dropResult === "removed" || didReplace) {
						droppedInjections++;
					}
				}
			} else {
				const didSet = target.setContent(stripped);
				if (didSet) {
					replaceSourceContent(db, sessionId, tag.tagNumber, strippedSource);
					droppedInjections++;
				}
			}
		}
	})();

	const toolFingerprints = buildPiToolFingerprints(piMessages, resolveStableId);
	if (toolFingerprints.size > 0) {
		const tagsByCompositeKey = new Map<string, TagEntry>();
		for (const tag of tags) {
			if (tag.type === "tool" && tag.status === "active" && tag.messageId) {
				const key = tag.toolOwnerMessageId
					? `${tag.toolOwnerMessageId}\x00${tag.messageId}`
					: tag.messageId; // legacy NULL-owner fallback
				tagsByCompositeKey.set(key, tag);
			}
		}

		const fingerprintGroups = new Map<string, TagEntry[]>();
		for (const [compositeKey, fingerprint] of toolFingerprints) {
			const tag = tagsByCompositeKey.get(compositeKey);
			if (!tag || tag.tagNumber > protectedCutoff) continue;
			const group = fingerprintGroups.get(fingerprint) ?? [];
			group.push(tag);
			fingerprintGroups.set(fingerprint, group);
		}

		db.transaction(() => {
			for (const [, group] of fingerprintGroups) {
				if (group.length <= 1) continue;
				group.sort((a, b) => a.tagNumber - b.tagNumber);
				// Deduplication retains the newest matching tag and drops older matches.
				for (let i = 0; i < group.length - 1; i++) {
					const tag = group[i];
					const target = targets.get(tag.tagNumber);
					const result = target?.drop?.() ?? "absent";
					if (result === "incomplete") continue;
					updateTagDropMode(db, sessionId, tag.tagNumber, "full");
					updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
					if (result === "removed" || result === "truncated") {
						deduplicatedTools++;
					}
				}
			}
		})();
	}

	if (
		droppedTools > 0 ||
		deduplicatedTools > 0 ||
		droppedInjections > 0 ||
		droppedStaleReduceCalls > 0
	) {
		sessionLog(
			sessionId,
			`heuristic cleanup: dropped ${droppedTools} tool tags, stale ctx_reduce=${droppedStaleReduceCalls}, deduplicated ${deduplicatedTools} tool calls, dropped ${droppedInjections} system injections`,
		);
	}

	let compressedTextTags = 0;
	let mutatedTextTags = 0;
	if (config.caveman?.enabled) {
		const cavemanResult = applyCavemanCleanup(sessionId, db, targets, tags, {
			enabled: true,
			minChars: config.caveman.minChars,
			protectedTags: config.protectedTags,
		});
		compressedTextTags =
			cavemanResult.compressedToLite +
			cavemanResult.compressedToFull +
			cavemanResult.compressedToUltra;
		mutatedTextTags = cavemanResult.mutatedTextTags;
	}

	return {
		droppedTools,
		deduplicatedTools,
		droppedInjections,
		droppedStaleReduceCalls,
		emergencyDroppedTools,
		compressedTextTags,
		mutatedTextTags,
	};
}

function buildCtxReduceTagNumbers(
	tags: readonly TagEntry[],
): Map<string, number> {
	const byComposite = new Map<string, number>();
	for (const tag of tags) {
		if (
			tag.status !== "active" ||
			tag.type !== "tool" ||
			tag.toolName !== "ctx_reduce" ||
			!tag.toolOwnerMessageId
		) {
			continue;
		}
		byComposite.set(
			`${tag.toolOwnerMessageId}\x00${tag.messageId}`,
			tag.tagNumber,
		);
	}
	return byComposite;
}

function buildMessageIdToMaxTagFromTargets(
	targets: Map<number, TagTarget>,
): Map<string, number> {
	const byMessage = new Map<string, number>();
	for (const [tagNumber, target] of targets) {
		const id = target.message?.info?.id;
		if (typeof id !== "string" || id.length === 0) continue;
		if (tagNumber > (byMessage.get(id) ?? 0)) byMessage.set(id, tagNumber);
	}
	return byMessage;
}
