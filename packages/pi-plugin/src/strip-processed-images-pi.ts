import {
	addProcessedImageStrippedIds,
	type ContextDatabase,
	getProcessedImageStrippedIds,
} from "@magic-context/core/features/magic-context/storage";
import { sessionLog } from "@magic-context/core/shared/logger";

interface PiImagePart {
	type: "image";
	data: string;
	mimeType: string;
}

export interface StripPiProcessedImagesResult {
	stripped: number;
	newlyStrippedIds: string[];
}

const STRIPPED_IMAGE_MARKER = "[image stripped]";

function isLargeImagePart(value: unknown): value is PiImagePart {
	if (!value || typeof value !== "object") return false;
	const part = value as Record<string, unknown>;
	return (
		part.type === "image" &&
		typeof part.mimeType === "string" &&
		part.mimeType.startsWith("image/") &&
		typeof part.data === "string" &&
		part.data.length > 200
	);
}

/**
 */
export function stripPiProcessedImages(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	detect: boolean;
	watermark: number;
	messageIdToMaxTag: ReadonlyMap<string, number>;
	stableId: (message: unknown, index: number) => string | undefined;
	addIds?: typeof addProcessedImageStrippedIds;
}): StripPiProcessedImagesResult {
	const frozenIds = getProcessedImageStrippedIds(args.db, args.sessionId);
	const newlyStrippedIds: string[] = [];
	let hasAssistantResponse = false;

	if (args.detect && args.watermark > 0) {
		for (let i = args.messages.length - 1; i >= 0; i--) {
			const raw = args.messages[i];
			if (!raw || typeof raw !== "object") continue;
			const message = raw as { role?: unknown; content?: unknown };
			if (message.role === "assistant") {
				hasAssistantResponse = true;
				continue;
			}
			if (
				(message.role !== "user" && message.role !== "toolResult") ||
				!hasAssistantResponse ||
				!Array.isArray(message.content) ||
				!message.content.some(isLargeImagePart)
			) {
				continue;
			}
			const id = args.stableId(raw, i);
			if (!id || frozenIds.has(id)) continue;
			const maxTag = args.messageIdToMaxTag.get(id) ?? 0;
			if (maxTag <= args.watermark) newlyStrippedIds.push(id);
		}
	}

	if (newlyStrippedIds.length > 0) {
		const persisted = (args.addIds ?? addProcessedImageStrippedIds)(
			args.db,
			args.sessionId,
			newlyStrippedIds,
		);
		if (persisted) {
			for (const id of newlyStrippedIds) frozenIds.add(id);
		} else {
			newlyStrippedIds.length = 0;
			sessionLog(
				args.sessionId,
				"processed-image strip: persistence failed; leaving newly detected images intact",
			);
		}
	}

	let stripped = 0;
	for (let i = 0; i < args.messages.length; i++) {
		const raw = args.messages[i];
		if (!raw || typeof raw !== "object") continue;
		const id = args.stableId(raw, i);
		if (!id || !frozenIds.has(id)) continue;
		const message = raw as { content?: unknown };
		if (!Array.isArray(message.content)) continue;
		for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
			if (!isLargeImagePart(message.content[partIndex])) continue;
			message.content[partIndex] = {
				type: "text",
				text: STRIPPED_IMAGE_MARKER,
			};
			stripped++;
		}
	}

	return { stripped, newlyStrippedIds };
}
