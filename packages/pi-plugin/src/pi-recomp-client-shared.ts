import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";

/**
 * `createPiHistorianClient` adapts a Pi `SubagentRunner` to the OpenCode client interface required by `executeContextRecompWithResult`.
 *
 * `executeContextRecompWithResult` requires `client.session.{create,prompt,messages,delete}`.
 */
export function createPiHistorianClient(args: {
	runner: SubagentRunner;
	model: string;
	systemPrompt: string;
	fallbackModels?: readonly string[];
	timeoutMs?: number;
	thinkingLevel?: string;
	directory: string;
	accountingSessionId: string;
	notify: (text: string) => void;
}) {
	const sessions = new Map<string, unknown[]>();
	let counter = 0;
	async function prompt(input: unknown): Promise<Record<string, never>> {
		const body = readBody(input);
		const sessionId = readPathId(input);
		if (body.noReply) {
			const text = extractPromptText(body.parts);
			if (text.length > 0) args.notify(text);
			return {};
		}
		const promptText = extractPromptText(body.parts);
		const modelOverride = readBodyModel(body);
		const result = await args.runner.run({
			agent: "magic-context-historian",
			systemPrompt: args.systemPrompt,
			userMessage: promptText,
			model: modelOverride ?? args.model,
			fallbackModels: modelOverride ? undefined : args.fallbackModels,
			timeoutMs: args.timeoutMs,
			cwd: args.directory,
			thinkingLevel: args.thinkingLevel,
			accountingSessionId: args.accountingSessionId,
			accountingSubagent: "recomp",
		});
		if (!result.ok) {
			throw new Error(
				`Pi recomp historian failed (${result.reason}): ${result.error}`,
			);
		}
		sessions.set(sessionId, [makeMessage("assistant", result.assistantText)]);
		return {};
	}
	return {
		session: {
			get: async () => ({ directory: args.directory }),
			create: async () => {
				const id = `magic-context-pi-recomp-${++counter}`;
				sessions.set(id, []);
				return { id };
			},
			prompt,
			promptAsync: prompt,
			messages: async (input: unknown) => ({
				data: sessions.get(readPathId(input)) ?? [],
			}),
			delete: async (input: unknown) => {
				sessions.delete(readPathId(input));
				return {};
			},
		},
	};
}

function readPathId(input: unknown): string {
	if (typeof input !== "object" || input === null) return "";
	const path = (input as { path?: { id?: unknown } }).path;
	return typeof path?.id === "string" ? path.id : "";
}

function readBody(input: unknown): {
	noReply?: boolean;
	parts?: unknown;
	model?: unknown;
} {
	if (typeof input !== "object" || input === null) return {};
	const body = (input as { body?: unknown }).body;
	return typeof body === "object" && body !== null
		? (body as { noReply?: boolean; parts?: unknown; model?: unknown })
		: {};
}

/**
 */
function readBodyModel(body: { model?: unknown }): string | undefined {
	const model = body.model;
	if (typeof model !== "object" || model === null) return undefined;
	const { providerID, modelID } = model as {
		providerID?: unknown;
		modelID?: unknown;
	};
	if (
		typeof providerID === "string" &&
		providerID.length > 0 &&
		typeof modelID === "string" &&
		modelID.length > 0
	) {
		return `${providerID}/${modelID}`;
	}
	return undefined;
}

function extractPromptText(parts: unknown): string {
	if (!Array.isArray(parts)) return "";
	return parts
		.map((part) =>
			typeof part === "object" && part !== null
				? (part as { text?: unknown }).text
				: undefined,
		)
		.filter(
			(text): text is string => typeof text === "string" && text.length > 0,
		)
		.join("\n");
}

function makeMessage(role: "assistant", text: string): unknown {
	return {
		info: { role, time: { created: Date.now() } },
		parts: [{ type: "text", text }],
		role,
		content: [{ type: "text", text }],
	};
}
