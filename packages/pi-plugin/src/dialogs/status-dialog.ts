import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { parseCacheTtl } from "@magic-context/core/features/magic-context/scheduler";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import {
	getOverflowState,
	getSessionWorkMetrics,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { getNotes } from "@magic-context/core/features/magic-context/storage-notes";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import {
	MAX_EXECUTE_THRESHOLD,
	resolveExecuteThresholdDetail,
} from "@magic-context/core/hooks/magic-context/event-resolvers";
import { readProjectClaimLaneSnapshot } from "@magic-context/core/hooks/magic-context/inject-compartments";
import { computeM0BlockTokens } from "@magic-context/core/hooks/magic-context/m0-token-breakdown";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { countCompartmentsNeedingUpgrade } from "@magic-context/core/hooks/magic-context/upgrade-reminder";
import { formatBytes } from "@magic-context/core/shared/format-bytes";
import {
	formatThresholdClampNote,
	formatThresholdPercent,
} from "@magic-context/core/shared/format-threshold";
import type { TailHygieneStatus } from "@magic-context/core/shared/rpc-types";
import {
	formatTailHygiene,
	resolveTailHygieneStatus,
} from "@magic-context/core/shared/tail-hygiene-status";
import {
	formatWindowDerivationLine,
	type WindowGeometryResult,
} from "@magic-context/core/shared/window-geometry";
import packageJson from "../../package.json";
import { resolveSessionId } from "../commands/pi-command-utils";
import { getPiChannel1Baseline } from "../ctx-reduce-nudge-pi";
import { resolvePiWindowGeometry } from "../pi-context-limit";
import { isPiRecompInFlight } from "../pi-recomp-runner";

// `COLORS` mirrors `packages/plugin/src/tui/slots/sidebar-content.tsx` so Pi and OpenCode use the same category palette.
const COLORS = {
	system: "#c084fc", // Purple
	docs: "#22d3ee", // Cyan — <project-docs>
	compartments: "#60a5fa", // Blue
	memories: "#34d399", // Green
	profile: "#a3e635", // Lime — <user-profile>
	conversation: "#f87171", // Red
	toolCalls: "#fb923c", // Orange
	toolDefs: "#f472b6", // Pink
};

/** The dialog refreshes every 1,000 ms while open. */
const REFRESH_INTERVAL_MS = 1000;

export interface StatusDialogDeps {
	db: ContextDatabase;
	projectIdentity: string;
	protectedTags?: number;
	executeThresholdPercentage?:
		| number
		| { default: number; [modelKey: string]: number };
	historyBudgetPercentage?: number;
	injectionBudgetTokens?: number;
	executeThresholdTokens?: {
		default?: number;
		[modelKey: string]: number | undefined;
	};
}

interface StatusDialogDetail {
	sessionId: string;
	usagePercentage: number;
	inputTokens: number;
	systemPromptTokens: number;
	compartmentCount: number;
	memoryCount: number;
	memoryBlockCount: number;
	sessionNoteCount: number;
	readySmartNoteCount: number;
	pendingOpsCount: number;
	historianRunning: boolean;
	historianFailureCount: number;
	historianLastFailureAt: number | null;
	historianLastError: string | null;
	cacheTtl: string;
	lastResponseTime: number;
	cacheRemainingMs: number;
	cacheExpired: boolean;
	lastNudgeTokens: number;
	lastNudgeBand: string;
	lastTransformError: string | null;
	isSubagent: boolean;
	contextLimit: number;
	windowGeometry?: WindowGeometryResult;
	executeThreshold: number;
	/** `executeThresholdMode` identifies whether tokens or a percentage produced `executeThreshold`. */
	executeThresholdMode: "percentage" | "tokens";
	/** `executeThresholdClamped` is true when `executeThreshold` is lower than its configured value. */
	executeThresholdClamped?: boolean;
	/** `executeThresholdConfigured` retains the configured value before clamping. */
	executeThresholdConfigured?: number;
	protectedTagCount: number;
	historyBlockTokens: number;
	compressionBudget: number | null;
	compressionUsage: string | null;
	activeTags: number;
	droppedTags: number;
	totalTags: number;
	activeBytes: number;
	compartmentTokens: number;
	factTokens: number;
	memoryTokens: number;
	docsTokens: number;
	profileTokens: number;
	conversationTokens: number;
	toolCallTokens: number;
	toolDefinitionTokens: number;
	tailHygiene?: TailHygieneStatus;
	newWorkTokens: number;
	totalInputTokens: number;
	/** `upgradeNeededCount` counts legacy and tierless compartments that require a v2 upgrade. */
	upgradeNeededCount: number;
	/** `recompInFlight` is true while a detached `/ctx-recomp` or `/ctx-session-upgrade` runs. */
	recompInFlight: boolean;
}

export async function showStatusDialog(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	deps: StatusDialogDeps,
): Promise<void> {
	const sessionId = resolveSessionId(ctx);
	if (!sessionId) throw new Error("No active Pi session is available.");

	await ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) =>
			new StatusDialogComponent({
				pi,
				ctx,
				deps,
				sessionId,
				theme,
				tui,
				done,
			}),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: 78 },
		},
	);
}

interface StatusDialogProps {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	deps: StatusDialogDeps;
	sessionId: string;
	theme: Theme;
	tui: TUI;
	done: (value: undefined) => void;
}

/**
 * `handleInput` closes the dialog on Escape, Enter, and Ctrl+C.
 */
class StatusDialogComponent implements Component {
	private readonly props: StatusDialogProps;
	private detail: StatusDialogDetail;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	private closed = false;

	constructor(props: StatusDialogProps) {
		this.props = props;
		this.detail = buildPiStatusDetail(
			props.pi,
			props.ctx,
			props.deps,
			props.sessionId,
		);
		this.refreshTimer = setInterval(() => {
			if (this.closed) return;
			try {
				this.detail = buildPiStatusDetail(
					this.props.pi,
					this.props.ctx,
					this.props.deps,
					this.props.sessionId,
				);
				this.props.tui.requestRender();
			} catch {
				// On refresh failure, retain the previous detail.
			}
		}, REFRESH_INTERVAL_MS);
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "ctrl+c") ||
			matchesKey(data, "return")
		) {
			this.close();
		}
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.props.done(undefined);
	}

	invalidate(): void {
		// Rendering is stateless, so no invalidation is required.
	}

	render(width: number): string[] {
		// `drawBorder` reserves two columns for borders and one for padding.
		// `renderInner` receives the remaining width so the segmented bar fills each row.
		// `renderInner` avoids a fixed 56-character cap so the segmented bar fills the available width.
		const innerWidth = Math.max(20, width - 4);
		const inner = renderInner(this.detail, this.props.theme, innerWidth);
		return drawBorder(inner, width, this.props.theme);
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}
}

function renderInner(
	s: StatusDialogDetail,
	theme: Theme,
	innerWidth: number,
): string[] {
	const pctColor =
		s.usagePercentage >= 80
			? "error"
			: s.usagePercentage >= 65
				? "warning"
				: "accent";
	const lines: string[] = [];

	// Header
	lines.push(
		`${theme.fg("accent", theme.bold("⚡ Magic Context Status"))}   ${theme.fg(
			"muted",
			`v${packageJson.version}`,
		)}`,
	);
	lines.push("");

	// Context summary
	lines.push(
		`Context  ${theme.fg(
			pctColor,
			theme.bold(`${s.usagePercentage.toFixed(1)}%`),
		)} · ${fmt(s.inputTokens)} / ${s.contextLimit > 0 ? fmt(s.contextLimit) : "?"} tokens`,
	);
	if (s.windowGeometry) {
		lines.push(
			formatWindowDerivationLine(s.inputTokens, s.windowGeometry).replace(
				/^Context:.* — window /,
				"Window ",
			),
		);
	}
	lines.push(
		`Work tokens ${fmt(s.newWorkTokens)} new · ${fmt(s.totalInputTokens)} total input`,
	);
	if (s.tailHygiene !== undefined) {
		lines.push(`Hygiene ${formatTailHygiene(s.tailHygiene)}`);
	}

	lines.push(renderBar(s, innerWidth));

	// Legend
	for (const seg of breakdownSegments(s)) {
		const pct = ((seg.tokens / (s.inputTokens || 1)) * 100).toFixed(1);
		const left = colorHex(
			seg.color,
			`${seg.label}${seg.detail ? ` ${seg.detail}` : ""}`,
		);
		const right = theme.fg("muted", `${fmt(seg.tokens)} (${pct}%)`);
		lines.push(`${left}   ${right}`);
	}
	lines.push("* Conversation includes model Reasoning; hygiene excludes it.");
	lines.push("");

	lines.push(
		`Counts: ${s.compartmentCount} compartments · ${s.memoryCount} memories (${s.memoryBlockCount} injected) · ${
			s.sessionNoteCount + s.readySmartNoteCount
		} notes`,
	);
	lines.push(
		`Historian: ${
			s.historianRunning
				? theme.fg("warning", "running")
				: theme.fg("accent", "idle")
		}${
			s.historianFailureCount > 0
				? ` · ${theme.fg("error", `last failure ${s.historianLastFailureAt ? relTime(s.historianLastFailureAt) : "unknown"}`)}`
				: ""
		}`,
	);
	if (s.recompInFlight) {
		lines.push(`Upgrade: ${theme.fg("warning", "recomp/upgrade running…")}`);
	} else if (s.upgradeNeededCount > 0) {
		lines.push(
			`Upgrade: ${theme.fg("warning", `${s.upgradeNeededCount} compartment${s.upgradeNeededCount === 1 ? "" : "s"} need upgrade`)} · run /ctx-session-upgrade`,
		);
	} else {
		lines.push(`Upgrade: ${theme.fg("accent", "up to date")}`);
	}
	lines.push(`Pending drops: ${s.pendingOpsCount}`);
	lines.push(
		`Cache TTL: ${s.cacheTtl} · last response ${
			s.lastResponseTime > 0
				? `${Math.round((Date.now() - s.lastResponseTime) / 1000)}s ago`
				: "never"
		} · ${
			s.cacheExpired
				? theme.fg("warning", "expired")
				: s.cacheRemainingMs === Number.POSITIVE_INFINITY
					? "never expires (always-warm lane)"
					: `${Math.round(s.cacheRemainingMs / 1000)}s remaining`
		}`,
	);
	lines.push("");

	// Tags
	lines.push(theme.fg("muted", "Tags"));
	lines.push(
		`Active ${s.activeTags} (~${formatBytes(s.activeBytes)}) · Dropped ${s.droppedTags} · Total ${s.totalTags}`,
	);

	lines.push(theme.fg("muted", "Context"));
	lines.push(
		`Execute threshold ${formatThresholdPercent(s.executeThreshold)}%${formatThresholdClampNote(
			{
				clamped: s.executeThresholdClamped,
				mode: s.executeThresholdMode,
				configuredValue: s.executeThresholdConfigured,
				contextLimit: s.contextLimit,
				maxPercentage: MAX_EXECUTE_THRESHOLD,
			},
		)}`,
	);
	lines.push(
		`Protected tags ${s.protectedTagCount} · Subagent ${s.isSubagent ? "yes" : "no"} · History block ~${fmt(s.historyBlockTokens)} tok${
			s.compressionBudget
				? ` · Budget ~${fmt(s.compressionBudget)} tok (${s.compressionUsage} used)`
				: ""
		}`,
	);

	if (s.lastTransformError)
		lines.push(theme.fg("error", `⚠ ${s.lastTransformError}`));
	if (s.historianLastError)
		lines.push(theme.fg("error", `⚠ ${s.historianLastError}`));

	lines.push("");
	lines.push(theme.fg("muted", "Press Escape to close"));
	return lines;
}

/**
 * The `borderMuted` border distinguishes the overlay from its background.
 */
function drawBorder(inner: string[], width: number, theme: Theme): string[] {
	const innerWidth = Math.max(20, width - 4); // 2 chars border + 1 padding each side
	const border = (s: string) => theme.fg("borderMuted", s);

	const top = border(`╭${"─".repeat(innerWidth + 2)}╮`);
	const bottom = border(`╰${"─".repeat(innerWidth + 2)}╯`);
	const side = border("│");

	const out: string[] = [];
	out.push(top);
	for (const raw of inner) {
		const line = truncateToWidth(raw, innerWidth, "…");
		const visible = visibleWidth(line);
		const pad = " ".repeat(Math.max(0, innerWidth - visible));
		out.push(`${side} ${line}${pad} ${side}`);
	}
	out.push(bottom);
	return out;
}

export function buildPiStatusDetail(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	deps: StatusDialogDeps,
	sessionId: string,
): StatusDialogDetail {
	const usage = ctx.getContextUsage?.();
	const meta = getOrCreateSessionMeta(deps.db, sessionId);
	const hasPersistedPressure =
		meta.lastInputTokens > 0 && meta.lastContextPercentage > 0;
	const inputTokens = hasPersistedPressure
		? meta.lastInputTokens
		: typeof usage?.tokens === "number"
			? usage.tokens
			: 0;
	let detectedContextLimit: number | undefined;
	try {
		const detected = getOverflowState(deps.db, sessionId).detectedContextLimit;
		if (detected > 0) detectedContextLimit = detected;
	} catch {
		// Status remains available when overflow metadata cannot be read.
	}
	const windowGeometry = resolvePiWindowGeometry({
		rawContextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
		model: ctx.model,
		detectedContextLimit,
		persistedInputTokens: meta.lastInputTokens,
		persistedPercentage: meta.lastContextPercentage,
	});
	const contextLimit = windowGeometry?.usableSoft ?? 0;
	const usagePercentage =
		contextLimit > 0 && inputTokens > 0
			? (inputTokens / contextLimit) * 100
			: meta.lastContextPercentage;

	const compartments = getCompartments(deps.db, sessionId);
	const metaRow = readSessionMetaRow(deps.db, sessionId);
	const memoryBlockCount = Number(metaRow?.memory_block_count ?? 0);
	const claimLane = safeRead(
		() => readProjectClaimLaneSnapshot(deps.db, deps.projectIdentity),
		null,
	);

	const m0Bytes = metaRow?.cached_m0_bytes;
	const m0Text =
		m0Bytes instanceof Uint8Array
			? Buffer.from(m0Bytes).toString("utf8")
			: typeof m0Bytes === "string"
				? m0Bytes
				: "";
	const m0Blocks = computeM0BlockTokens(deps.db, sessionId, {
		m0Text,
		projectIdentity: deps.projectIdentity,
		injectionBudgetTokens: deps.injectionBudgetTokens,
		memoryBlockCount,
	});
	const compartmentTokens = m0Blocks.compartmentTokens;
	const factTokens = m0Blocks.factTokens;
	const memoryTokens = m0Blocks.memoryTokens;
	const docsTokens = m0Blocks.docsTokens;
	const profileTokens = m0Blocks.profileTokens;

	let systemPromptTokens = meta.systemPromptTokens;
	try {
		const sysPrompt =
			typeof ctx.getSystemPrompt === "function"
				? ctx.getSystemPrompt()
				: undefined;
		if (typeof sysPrompt === "string" && sysPrompt.length > 0) {
			systemPromptTokens = estimateTokens(sysPrompt);
		}
	} catch {}

	const tags = getTagsBySession(deps.db, sessionId);
	const activeTags = tags.filter((tag) => tag.status === "active");
	const droppedTags = tags.filter((tag) => tag.status === "dropped");
	const activeBytes = activeTags.reduce((sum, tag) => sum + tag.byteSize, 0);
	const pendingOps = readPendingOpsCount(deps.db, sessionId);

	//
	const toolCallTokens = meta.toolCallTokens;

	// Provider tool-definition token counts are estimates, not wire-payload counts.
	let toolDefinitionTokens = 0;
	try {
		const tools = pi.getAllTools?.() ?? [];
		for (const tool of tools) {
			toolDefinitionTokens += estimateTokens(
				`${tool.name ?? ""}\n${tool.description ?? ""}\n${safeStringify(tool.parameters)}`,
			);
		}
	} catch {
		// best effort
	}

	const conversationTokens = Math.max(
		0,
		inputTokens -
			systemPromptTokens -
			compartmentTokens -
			factTokens -
			memoryTokens -
			docsTokens -
			profileTokens -
			toolCallTokens -
			toolDefinitionTokens,
	);
	const workMetrics = getSessionWorkMetrics(deps.db, sessionId);
	const tailHygiene = resolveTailHygieneStatus(
		getPiChannel1Baseline(sessionId),
	);

	const modelKey = ctx.model
		? `${ctx.model.provider}/${ctx.model.id}`
		: undefined;
	const threshold = resolveExecuteThresholdDetail(
		deps.executeThresholdPercentage ?? 65,
		modelKey,
		65,
		{
			tokensConfig: deps.executeThresholdTokens,
			contextLimit: contextLimit || undefined,
			sessionId,
		},
	);
	const cacheTtl = meta.cacheTtl || "5m";
	let cacheTtlMs: number;
	try {
		cacheTtlMs = parseCacheTtl(cacheTtl);
	} catch {
		cacheTtlMs = 5 * 60 * 1000;
	}
	const neverExpires = cacheTtlMs === Number.POSITIVE_INFINITY;
	const elapsed =
		meta.lastResponseTime > 0 ? Date.now() - meta.lastResponseTime : 0;
	const cacheRemainingMs = neverExpires
		? Number.POSITIVE_INFINITY
		: meta.lastResponseTime > 0
			? Math.max(0, cacheTtlMs - elapsed)
			: cacheTtlMs;
	const cacheExpired = meta.lastResponseTime > 0 && cacheRemainingMs === 0;
	const historyBlockTokens = compartmentTokens + factTokens;
	const historyBudgetPercentage = deps.historyBudgetPercentage ?? 0.15;
	const compressionBudget =
		contextLimit > 0
			? Math.floor(
					contextLimit *
						(Math.min(threshold.percentage, 80) / 100) *
						historyBudgetPercentage,
				)
			: null;

	return {
		sessionId,
		usagePercentage,
		inputTokens,
		systemPromptTokens,
		compartmentCount: compartments.length,
		memoryCount: claimLane?.items.length ?? 0,
		memoryBlockCount,
		sessionNoteCount: safeRead(
			() =>
				getNotes(deps.db, {
					sessionId,
					type: "session",
					status: "active",
				}).length,
			0,
		),
		readySmartNoteCount: safeRead(
			() =>
				getNotes(deps.db, {
					projectPath: deps.projectIdentity,
					type: "smart",
					status: "ready",
				}).length,
			0,
		),
		pendingOpsCount: pendingOps,
		historianRunning: meta.compartmentInProgress,
		historianFailureCount: Number(metaRow?.historian_failure_count ?? 0),
		historianLastFailureAt:
			typeof metaRow?.historian_last_failure_at === "number"
				? metaRow.historian_last_failure_at
				: null,
		historianLastError: metaRow?.historian_last_error ?? null,
		cacheTtl,
		lastResponseTime: meta.lastResponseTime,
		cacheRemainingMs,
		cacheExpired,
		lastNudgeTokens: meta.lastNudgeTokens,
		lastNudgeBand: meta.lastNudgeBand ?? "",
		lastTransformError: meta.lastTransformError,
		isSubagent: meta.isSubagent,
		contextLimit,
		windowGeometry,
		executeThreshold: threshold.percentage,
		executeThresholdMode: threshold.mode,
		executeThresholdClamped: threshold.clamped,
		executeThresholdConfigured: threshold.configuredValue,
		protectedTagCount: deps.protectedTags ?? 20,
		historyBlockTokens,
		compressionBudget,
		compressionUsage:
			compressionBudget && compressionBudget > 0
				? `${((historyBlockTokens / compressionBudget) * 100).toFixed(0)}%`
				: null,
		activeTags: activeTags.length,
		droppedTags: droppedTags.length,
		totalTags: tags.length,
		activeBytes,
		compartmentTokens,
		factTokens,
		memoryTokens,
		docsTokens,
		profileTokens,
		conversationTokens,
		toolCallTokens,
		toolDefinitionTokens,
		...(tailHygiene === undefined ? {} : { tailHygiene }),
		newWorkTokens: workMetrics.newWorkTokens,
		totalInputTokens: workMetrics.totalInputTokens,
		upgradeNeededCount: safeRead(
			() => countCompartmentsNeedingUpgrade(deps.db, sessionId),
			0,
		),
		recompInFlight: isPiRecompInFlight(sessionId),
	};
}

function safeStringify(value: unknown): string {
	try {
		if (value === undefined || value === null) return "";
		return typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		return "";
	}
}

function breakdownSegments(s: StatusDialogDetail): Array<{
	label: string;
	tokens: number;
	color: string;
	detail?: string;
}> {
	const segs: Array<{
		label: string;
		tokens: number;
		color: string;
		detail?: string;
	}> = [];
	if (s.systemPromptTokens > 0)
		segs.push({
			label: "System",
			tokens: s.systemPromptTokens,
			color: COLORS.system,
		});
	if (s.docsTokens > 0)
		segs.push({ label: "Docs", tokens: s.docsTokens, color: COLORS.docs });
	if (s.compartmentTokens > 0)
		segs.push({
			label: "Compartments",
			tokens: s.compartmentTokens,
			color: COLORS.compartments,
			detail: `(${s.compartmentCount})`,
		});
	if (s.memoryTokens > 0)
		segs.push({
			label: "Memories",
			tokens: s.memoryTokens,
			color: COLORS.memories,
			detail: `(${s.memoryBlockCount})`,
		});
	if (s.profileTokens > 0)
		segs.push({
			label: "User Profile",
			tokens: s.profileTokens,
			color: COLORS.profile,
		});
	if (s.conversationTokens > 0)
		segs.push({
			label: "Conversation*",
			tokens: s.conversationTokens,
			color: COLORS.conversation,
		});
	if (s.toolCallTokens > 0)
		segs.push({
			label: "Tool Calls",
			tokens: s.toolCallTokens,
			color: COLORS.toolCalls,
		});
	if (s.toolDefinitionTokens > 0)
		segs.push({
			label: "Tool Defs",
			tokens: s.toolDefinitionTokens,
			color: COLORS.toolDefs,
		});
	return segs;
}

function renderBar(s: StatusDialogDetail, innerWidth: number): string {
	// The 20-column minimum keeps segments visible in narrow terminals.
	const barWidth = Math.max(20, innerWidth);
	const segs = breakdownSegments(s);
	if (segs.length === 0) return "";
	const widths = segs.map((seg) =>
		Math.max(1, Math.round((seg.tokens / (s.inputTokens || 1)) * barWidth)),
	);
	let sum = widths.reduce((a, b) => a + b, 0);
	while (sum > barWidth) {
		const maxIdx = widths.indexOf(Math.max(...widths));
		if ((widths[maxIdx] ?? 0) > 1) {
			widths[maxIdx] -= 1;
			sum--;
		} else break;
	}
	while (sum < barWidth) {
		const maxIdx = widths.indexOf(Math.max(...widths));
		widths[maxIdx] = (widths[maxIdx] ?? 0) + 1;
		sum++;
	}
	return segs
		.map((seg, i) => colorHex(seg.color, "█".repeat(widths[i] ?? 0)))
		.join("");
}

function readSessionMetaRow(db: ContextDatabase, sessionId: string) {
	return db
		.prepare<
			[string],
			{
				memory_block_cache: string | null;
				memory_block_count: number | null;
				cached_m0_bytes: Buffer | Uint8Array | string | null;
				historian_failure_count: number | null;
				historian_last_failure_at: number | null;
				historian_last_error: string | null;
			}
		>(
			"SELECT memory_block_cache, memory_block_count, cached_m0_bytes, historian_failure_count, historian_last_failure_at, historian_last_error FROM session_meta WHERE session_id = ?",
		)
		.get(sessionId);
}

function readPendingOpsCount(db: ContextDatabase, sessionId: string): number {
	try {
		const row = db
			.prepare<[string], { count: number }>(
				"SELECT COUNT(*) as count FROM pending_ops WHERE session_id = ?",
			)
			.get(sessionId);
		return row?.count ?? 0;
	} catch {
		return 0;
	}
}

function safeRead<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

function fmt(n: number): string {
	const abs = Math.abs(n);
	if (abs >= 1_000_000) return `${trim1(n / 1_000_000)}M`;
	if (abs >= 1_000) return `${trim1(n / 1_000)}K`;
	return String(Math.round(n));
}

function trim1(n: number): string {
	const rounded = n.toFixed(1);
	return rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded;
}

function colorHex(hex: string, text: string): string {
	const clean = hex.replace("#", "");
	const r = Number.parseInt(clean.slice(0, 2), 16);
	const g = Number.parseInt(clean.slice(2, 4), 16);
	const b = Number.parseInt(clean.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

function relTime(ts: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	return `${hours}h ago`;
}
