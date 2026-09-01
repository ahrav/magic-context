/**
 *
 * `ctx_expand` returns the original compacted U:/A: transcript for the N–M range in a rendered heading.
 *
 *
 * The expansion is limited to the shared 15,000-token budget.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getLastCompartmentEndMessage } from "@magic-context/core/features/magic-context/compartment-storage";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	readSessionChunk,
	setRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import {
	CTX_EXPAND_DESCRIPTION,
	CTX_EXPAND_TOKEN_BUDGET,
} from "@magic-context/core/tools/ctx-expand/constants";
import {
	renderMessageByOrdinal,
	renderVerboseRange,
} from "@magic-context/core/tools/ctx-expand/render";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";
import { readPiSessionMessages } from "../read-session-pi";

const ParamsSchema = Type.Object(
	{
		start: Type.Optional(
			Type.Number({
				description:
					'First message ordinal to expand — a compartment\'s start="N" attribute, or an ordinal from a ctx_search message hit',
			}),
		),
		end: Type.Optional(
			Type.Number({
				description:
					'Last message ordinal to expand (inclusive) — a compartment\'s end="M" attribute',
			}),
		),
		verbose: Type.Optional(
			Type.Boolean({
				description:
					"With start/end: list each message separately with its ordinal [N] and per-part preview, so you can recover one in full by ordinal.",
			}),
		),
		message: Type.Optional(
			Type.Number({
				description:
					"Full untruncated recovery of ONE message by its ordinal (every text part + every tool call's complete input/output). Use an ordinal from a compartment, ctx_search hit, or verbose range. Recovers a tool output you dropped with ctx_reduce.",
			}),
		),
	},
	{ additionalProperties: true },
);

type CtxExpandParams = Static<typeof ParamsSchema>;

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function err(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined,
		isError: true,
	};
}

export interface CtxExpandToolDeps {
	db: ContextDatabase;
}

export function createCtxExpandTool(
	deps: CtxExpandToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	return {
		name: "ctx_expand",
		label: "Magic Context: Expand",
		description: CTX_EXPAND_DESCRIPTION,
		parameters: ParamsSchema,
		async execute(
			_toolCallId,
			params: CtxExpandParams,
			_signal,
			_onUpdate,
			ctx,
		) {
			params = unwrapImitatedReducedArgs(params, ["message", "start"], {
				start: "number",
				end: "number",
				verbose: "boolean",
				message: "number",
			});
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) {
				return err("Error: no active Pi session.");
			}

			// `ctx_expand` registers Pi's provider because shared readers resolve raw messages through the session provider.
			// `finally` unregisters Pi's provider when `execute` completes or throws.
			const unregister = setRawMessageProvider(sessionId, {
				readMessages: () => readPiSessionMessages(ctx),
			});

			try {
				// By-ordinal mode recovers every part and tool input/output for one JSONL message.
				if (typeof params.message === "number" && params.message >= 1) {
					return ok(renderMessageByOrdinal(sessionId, params.message));
				}

				if (
					typeof params.start !== "number" ||
					typeof params.end !== "number" ||
					params.start < 1 ||
					params.end < params.start
				) {
					return err(
						"Error: provide either message=<ordinal>, or start and end (positive integers, start <= end).",
					);
				}

				// The expansion stops at the last compartment boundary because later messages remain visible in the live tail.
				// `-1` means no compartments exist, so do not clamp.
				const lastCompartmentEnd = getLastCompartmentEndMessage(
					deps.db,
					sessionId,
				);
				if (lastCompartmentEnd >= 0 && params.start > lastCompartmentEnd) {
					return ok(
						`Range ${params.start}-${params.end} is entirely within the live tail (after the last compacted message ${lastCompartmentEnd}); those messages are already visible in context.`,
					);
				}
				const effectiveEnd =
					lastCompartmentEnd >= 0
						? Math.min(params.end, lastCompartmentEnd)
						: params.end;

				if (params.verbose === true) {
					const v = renderVerboseRange(
						sessionId,
						params.start,
						effectiveEnd,
						CTX_EXPAND_TOKEN_BUDGET,
					);
					if (!v.text) {
						return ok(
							`No messages found in range ${params.start}-${effectiveEnd}. The range may be outside this session's history.`,
						);
					}
					const out = [
						`Messages ${params.start}-${v.lastOrdinal} (verbose). Recover any one in full with ctx_expand(message=<ordinal>):`,
						"",
						v.text,
					];
					if (v.truncated) {
						out.push(
							"",
							`Truncated at message ${v.lastOrdinal} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${v.lastOrdinal + 1} end=${effectiveEnd} verbose=true for more.`,
						);
					}
					return ok(out.join("\n"));
				}

				const chunk = readSessionChunk(
					sessionId,
					CTX_EXPAND_TOKEN_BUDGET,
					params.start,
					effectiveEnd + 1, // readSessionChunk uses exclusive end
				);

				if (!chunk.text || chunk.messageCount === 0) {
					return ok(
						`No messages found in range ${params.start}-${params.end}. The range may be outside this session's history.`,
					);
				}

				const lines: string[] = [];
				lines.push(
					`Messages ${chunk.startIndex}-${chunk.endIndex} (${chunk.messageCount} messages, ~${chunk.tokenEstimate} tokens):`,
				);
				lines.push("");
				lines.push(chunk.text);

				if (chunk.endIndex < effectiveEnd) {
					lines.push("");
					lines.push(
						`Truncated at message ${chunk.endIndex} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${chunk.endIndex + 1} end=${effectiveEnd} for more.`,
					);
				}

				return ok(lines.join("\n"));
			} finally {
				unregister();
			}
		},
	};
}
