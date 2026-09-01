/**
 *
 *
 *
 */

import { stripPersistedAssistantText } from "@magic-context/core/hooks/magic-context/tag-content-primitives";

/**
 * `stripTagPrefixFromAssistantMessage` mutates text parts in `assistant` messages in place.
 *
 * `stripTagPrefixFromAssistantMessage` returns `true` after modifying at least one text part.
 */

export function stripTagPrefixFromAssistantMessage(message: {
	role: string;

	content: unknown;
}): boolean {
	if (message.role !== "assistant") return false;

	if (!Array.isArray(message.content)) return false;

	let mutated = false;

	for (const part of message.content) {
		if (
			part === null ||
			typeof part !== "object" ||
			(part as { type?: unknown }).type !== "text"
		) {
			continue;
		}

		const textPart = part as { type: "text"; text: unknown };

		if (typeof textPart.text !== "string") continue;

		const stripped = stripPersistedAssistantText(textPart.text);

		if (stripped !== textPart.text) {
			textPart.text = stripped;

			mutated = true;
		}
	}

	return mutated;
}
