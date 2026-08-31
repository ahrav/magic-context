/**
 *
 *
 */

import { textMentionsRecentCommit } from "@magic-context/core/shared/commit-detection";


const COMMIT_LOOKBACK = 5;

/**
 */
export function detectRecentCommit(messages: unknown[]): boolean {
	let assistantsScanned = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (
			!message ||
			typeof message !== "object" ||
			!("role" in message) ||
			message.role !== "assistant"
		) {
			continue;
		}
		assistantsScanned++;
		if (assistantsScanned > COMMIT_LOOKBACK) break;

		if (!("content" in message)) continue;
		const content = (message as { content: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (
				part &&
				typeof part === "object" &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string"
			) {
				if (textMentionsRecentCommit(part.text)) {
					return true;
				}
			}
		}
	}
	return false;
}
