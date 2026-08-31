/**
 * `injectTemporalMarkers` (packages/plugin/src/hooks/magic-context/temporal-awareness.ts).
 *
 * The gap runs from the previous timestamped message to the current user message timestamp.
 * injectPiTemporalMarkers injects only when the gap exceeds 300 seconds.
 * The marker is prepended to the first text content.
 * Markers use the `<!-- +<gap> -->\n` format.
 *
 * Pi differences:
 * Pi messages use a millisecond-epoch `timestamp`.
 * Pi uses `timestamp` as both the previous end time and current creation time.
 * The marker precedes the first text part.
 *
 * Existing markers are skipped.
 */

import {
	peelLeadingMcTagNotation,
	stripTagPrefix,
} from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import {
	TEMPORAL_MARKER_PATTERN,
	temporalMarkerPrefix,
} from "@magic-context/core/hooks/magic-context/temporal-awareness";

type PiTextContent = { type: "text"; text: string; textSignature?: string };
type PiImageContent = { type: "image"; data: string; mimeType: string };
type PiUserMessage = {
	role: "user";
	content: string | (PiTextContent | PiImageContent)[];
	timestamp?: number;
};
type PiOtherMessage = {
	role: "assistant" | "toolResult" | string;
	timestamp?: number;
};
type PiAgentMessage = PiUserMessage | PiOtherMessage;

/** `withoutPiLeadingTemporalMarker` removes one derived gap marker while preserving leading MC tag notation. */
export function withoutPiLeadingTemporalMarker(text: string): string {
	const { tagPrefix, body } = peelLeadingMcTagNotation(text);
	return tagPrefix + body.replace(TEMPORAL_MARKER_PATTERN, "");
}

export function stripPiLeadingTemporalMarker(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const userMessage = message as PiUserMessage;
	if (userMessage.role !== "user") return false;

	if (typeof userMessage.content === "string") {
		const stripped = withoutPiLeadingTemporalMarker(userMessage.content);
		if (stripped === userMessage.content) return false;
		userMessage.content = stripped;
		return true;
	}
	if (!Array.isArray(userMessage.content)) return false;
	const firstTextIndex = userMessage.content.findIndex(
		(part) => part?.type === "text",
	);
	if (firstTextIndex < 0) return false;
	const firstText = userMessage.content[firstTextIndex] as PiTextContent;
	const stripped = withoutPiLeadingTemporalMarker(firstText.text);
	if (stripped === firstText.text) return false;
	const content = userMessage.content.slice();
	content[firstTextIndex] = { ...firstText, text: stripped };
	userMessage.content = content;
	return true;
}

/**
 *
 * `injectPiTemporalMarkers` returns the number of user messages that received a new marker.
 */
export function injectPiTemporalMarkers(messages: unknown[]): number {
	let injected = 0;
	let prevTimestampMs: number | undefined;

	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAgentMessage;
		const role = msg.role;

		const currTimestamp = msg.timestamp;
		// `injectPiTemporalMarkers` computes the gap from the previous timestamped message of any role to the current user message.
		if (
			prevTimestampMs !== undefined &&
			role === "user" &&
			typeof currTimestamp === "number"
		) {
			const gapSec = (currTimestamp - prevTimestampMs) / 1000;
			const prefix = temporalMarkerPrefix(gapSec);
			if (prefix !== null) {
				const userMsg = msg as PiUserMessage;
				if (typeof userMsg.content === "string") {
					if (!TEMPORAL_MARKER_PATTERN.test(stripTagPrefix(userMsg.content))) {
						const { tagPrefix, body } = peelLeadingMcTagNotation(
							userMsg.content,
						);
						(messages as PiAgentMessage[])[i] = {
							...userMsg,
							content: tagPrefix + prefix + body,
						};
						injected++;
					}
				} else if (Array.isArray(userMsg.content)) {
					const firstTextIndex = userMsg.content.findIndex(
						(p) =>
							p &&
							typeof p === "object" &&
							(p as { type?: unknown }).type === "text",
					);
					if (firstTextIndex >= 0) {
						const existing = userMsg.content[firstTextIndex] as PiTextContent;
						const { tagPrefix, body } = peelLeadingMcTagNotation(existing.text);
						if (!TEMPORAL_MARKER_PATTERN.test(body)) {
							const newContent = userMsg.content.slice();
							newContent[firstTextIndex] = {
								...existing,
								text: tagPrefix + prefix + body,
							};
							(messages as PiAgentMessage[])[i] = {
								...userMsg,
								content: newContent,
							};
							injected++;
						}
					}
				}
			}
		}

		// A timestamped message resets the baseline for subsequent messages, regardless of role.
		// Messages without timestamps preserve the previous timestamp baseline.
		if (typeof currTimestamp === "number") {
			prevTimestampMs = currTimestamp;
		}
	}

	return injected;
}
