import type {
	CustomEntry,
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import { sessionLog } from "@magic-context/core/shared/logger";

export const CTX_STATUS_CUSTOM_TYPE = "ctx-status";

export type CtxStatusLevel = "info" | "success" | "warning" | "error";

export interface CtxStatusEntryData {
	title: string;
	text: string;
	level?: CtxStatusLevel;
	details?: unknown;
}

export type CtxStatusMessageContent = CtxStatusEntryData;

type CtxStatusEntryRenderer = (
	entry: CustomEntry<CtxStatusEntryData>,
	options: { expanded: boolean },
	theme: Theme,
) => Component | undefined;

type PiEntryRendererRegistration = {
	registerEntryRenderer?: <T = unknown>(
		customType: string,
		renderer: (
			entry: CustomEntry<T>,
			options: { expanded: boolean },
			theme: Theme,
		) => Component | undefined,
	) => void;
};

export type PiMessageSender = Pick<ExtensionAPI, "appendEntry"> &
	PiEntryRendererRegistration;

export function resolveSessionId(
	ctx: ExtensionCommandContext,
): string | undefined {
	const sm = ctx.sessionManager;
	const getSessionId = (sm as { getSessionId?: () => string | undefined })
		.getSessionId;
	if (typeof getSessionId !== "function") return undefined;
	try {
		const id = getSessionId.call(sm);
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

function statusTitleColor(level: CtxStatusLevel | undefined) {
	switch (level) {
		case "success":
			return "success" as const;
		case "warning":
			return "warning" as const;
		case "error":
			return "error" as const;
		default:
			return "accent" as const;
	}
}

const renderCtxStatusEntry: CtxStatusEntryRenderer = (
	entry,
	_options,
	theme,
) => {
	const data = entry?.data;
	if (
		!data ||
		typeof data !== "object" ||
		typeof data.title !== "string" ||
		typeof data.text !== "string"
	) {
		return undefined;
	}

	const title = theme.bold(
		theme.fg(statusTitleColor(data.level), `[${data.title}]`),
	);
	const body = theme.fg("customMessageText", data.text);
	const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(`${title}\n${body}`));
	return box;
};

/**
 * Register the model-invisible status-entry renderer when the Pi runtime supports it.
 * Older Pi versions still persist status entries through appendEntry; they simply do
 * not render those entries in the TUI.
 */
export function registerCtxStatusEntryRenderer(pi: PiMessageSender): boolean {
	if (typeof pi.registerEntryRenderer !== "function") return false;
	try {
		pi.registerEntryRenderer<CtxStatusEntryData>(
			CTX_STATUS_CUSTOM_TYPE,
			renderCtxStatusEntry,
		);
		return true;
	} catch {
		return false;
	}
}

export function sendCtxStatusMessage(
	pi: PiMessageSender,
	content: CtxStatusMessageContent,
	details?: unknown,
): void {
	const data: CtxStatusEntryData = {
		...content,
		details: details ?? content.details,
	};

	// Custom entries are persisted without entering model context. On older Pi
	// versions they may be invisible in the TUI, but model safety takes priority.
	if (typeof pi.appendEntry === "function") {
		pi.appendEntry<CtxStatusEntryData>(CTX_STATUS_CUSTOM_TYPE, data);
	}
	// Minimal non-interactive API shims may omit appendEntry; logging remains the
	// safe fallback and status text must never be routed through sendMessage.
	sessionLog("pi-status", `${content.title}: ${content.text}`);
}
