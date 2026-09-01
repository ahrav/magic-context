/** @jsxImportSource @opentui/solid */
// @ts-nocheck
import { createMemo } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import {
    createSidebarContentSlot,
    kickRecompProgressRefresh,
    refreshSidebarSnapshot,
} from "./slots/sidebar-content"
import packageJson from "../../package.json"
import { closeRpc, dismissUpgradeReminder, getAnnouncement, getCompartmentCount, getRpcGeneration, initRpcClient, loadEmbedDetail, loadStatusDetail, loadToastDurationMs, markAnnounced, requestRecomp, requestUpgrade, type EmbedDetail, type StatusDetail } from "./data/context-db"
import { startNotificationSocket, stopNotificationSocket, type SocketNotification } from "./data/notification-socket"
import { formatThresholdPercent } from "../shared/format-threshold"
import { formatTailHygiene } from "../shared/tail-hygiene-status"
import { formatWindowDerivationLine } from "../shared/window-geometry"
import { compactionOffSidebarRows, nativeCompactionContextLabel } from "./compaction-off"
import { isCompactionEnabled } from "../config/agent-disable"
import { loadPluginConfig } from "../config"
import { detectConflicts } from "../shared/conflict-detector"
import { fixConflicts } from "../shared/conflict-fixer"

const DEFAULT_TOAST_DURATION_MS = 5000
let unifiedToastDurationMs = DEFAULT_TOAST_DURATION_MS

async function refreshToastDurationMs(): Promise<void> {
    try {
        const resolved = await loadToastDurationMs()
        if (typeof resolved === "number" && Number.isFinite(resolved)) {
            unifiedToastDurationMs = resolved
        }
    } catch {
        // The catch preserves the current value so later refreshes can retry.
    }
}

function getToastDurationMs(): number {
    return unifiedToastDurationMs
}

function showToast(
    api: TuiPluginApi,
    input: {
        message: string
        variant: "info" | "warning" | "error" | "success"
        durationOverrideMs?: number
    },
): void {
    const duration =
        typeof input.durationOverrideMs === "number" && Number.isFinite(input.durationOverrideMs)
            ? input.durationOverrideMs
            : getToastDurationMs()
    // A positive per-call override still shows a toast when toast_duration_ms is 0.
    if (!(duration > 0)) {
        return
    }
    api.ui.toast({
        message: input.message,
        variant: input.variant,
        duration,
    })
}

function showConflictDialog(api: TuiPluginApi, directory: string, reasons: string[], conflicts: ReturnType<typeof detectConflicts>["conflicts"]) {
    api.ui.dialog.replace(() => (
        <api.ui.DialogConfirm
            title="⚠️ Magic Context Disabled"
            message={`${reasons.join("\n")}\n\nFix these conflicts automatically?`}
            onConfirm={() => {
                const actions = fixConflicts(directory, conflicts)
                const actionSummary = actions.length > 0
                    ? actions.map(a => `• ${a}`).join("\n")
                    : "No changes needed"
                // DialogConfirm calls dialog.clear() after onConfirm, so defer the next dialog
                setTimeout(() => {
                    api.ui.dialog.replace(() => (
                        <api.ui.DialogAlert
                            title="✅ Configuration Fixed"
                            message={`${actionSummary}\n\nPlease restart OpenCode for changes to take effect.`}
                            onConfirm={() => {
                                showToast(api, {
                                    message: "Restart OpenCode to enable Magic Context",
                                    variant: "warning",
                                    durationOverrideMs: 10_000,
                                })
                            }}
                        />
                    ))
                }, 50)
            }}
            onCancel={() => {
                showToast(api, { message: "Magic Context remains disabled. Run: npx @cortexkit/opencode-magic-context@latest doctor", variant: "warning" })
            }}
        />
    ))
}

function fmt(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`
    return String(n)
}

function fmtBytes(n: number): string {
    if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`
    if (n >= 1_024) return `${Math.round(n / 1_024)} KB`
    return `${n} B`
}

function relTime(ms: number): string {
    const d = Date.now() - ms
    if (d < 60_000) return "just now"
    if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
    return `${Math.floor(d / 86_400_000)}d ago`
}

function getSessionId(api: TuiPluginApi): string | null {
    try {
        const route = api.route.current
        if (route?.name === "session" && route.params?.sessionID) {
            return route.params.sessionID
        }
    } catch {
        // ignore
    }
    return null
}

const R = (props: { t: TuiThemeCurrent; l: string; v: string; fg?: string }) => (
    <box width="100%" flexDirection="row" justifyContent="space-between">
        <text fg={props.t.textMuted}>{props.l}</text>
        <text fg={props.fg ?? props.t.text}>{props.v}</text>
    </box>
)

const StatusDialog = (props: { api: TuiPluginApi; s: StatusDetail }) => {
    const theme = createMemo(() => (props.api as any).theme.current)
    const t = () => theme()
    const s = () => props.s
    const compactionOff = () => s().compaction_enabled === false

    const contextLimit = () =>
        s().contextLimit > 0
            ? s().contextLimit
            : s().usagePercentage > 0
              ? Math.round(s().inputTokens / (s().usagePercentage / 100))
              : 0

    const elapsed = () => (s().lastResponseTime > 0 ? Date.now() - s().lastResponseTime : 0)

    const COLORS = {
        system: "#c084fc",
        docs: "#22d3ee",
        compartments: "#60a5fa",
        facts: "#fbbf24",
        memories: "#34d399",
        profile: "#a3e635",
        conversation: "#f87171",
        toolCalls: "#fb923c",
        toolDefs: "#f472b6",
    }

    const breakdownSegments = () => {
        const d = s()
        const total = d.inputTokens || 1
        const segs: Array<{ label: string; tokens: number; color: string; detail?: string }> = []

        if (d.systemPromptTokens > 0)
            segs.push({ label: "System", tokens: d.systemPromptTokens, color: COLORS.system })
        if (d.docsTokens > 0)
            segs.push({ label: "Docs", tokens: d.docsTokens, color: COLORS.docs })
        if (!compactionOff() && d.compartmentTokens > 0)
            segs.push({
                label: "Compartments",
                tokens: d.compartmentTokens,
                color: COLORS.compartments,
                detail: `(${d.compartmentCount})`,
            })
        if (d.factTokens > 0)
            segs.push({
                label: "Facts",
                tokens: d.factTokens,
                color: COLORS.facts,
            })
        if (d.memoryTokens > 0)
            segs.push({
                label: "Memories",
                tokens: d.memoryTokens,
                color: COLORS.memories,
                detail: `(${d.memoryBlockCount})`,
            })
        if (d.profileTokens > 0)
            segs.push({ label: "User Profile", tokens: d.profileTokens, color: COLORS.profile })

        if (d.conversationTokens > 0)
            segs.push({ label: "Conversation*", tokens: d.conversationTokens, color: COLORS.conversation })
        if (d.toolCallTokens > 0)
            segs.push({ label: "Tool Calls", tokens: d.toolCallTokens, color: COLORS.toolCalls })
        if (d.toolDefinitionTokens > 0)
            segs.push({ label: "Tool Defs", tokens: d.toolDefinitionTokens, color: COLORS.toolDefs })

        return { segs, total }
    }

    const barSegments = () => breakdownSegments().segs.filter((seg) => seg.tokens > 0)

    return (
        <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            {/* Title */}
            <box justifyContent="center" width="100%" marginBottom={1} flexDirection="row" gap={2}>
                <text fg={t().accent}><b>⚡ Magic Context Status</b></text>
                <text fg={t().textMuted}>v{packageJson.version}</text>
            </box>

            <box flexDirection="row" justifyContent="space-between" width="100%">
                {compactionOff() ? (
                    <text fg={t().accent}>
                        <b>{nativeCompactionContextLabel(s())}</b>
                    </text>
                ) : (
                    <text fg={s().usagePercentage >= 80 ? t().error : s().usagePercentage >= 65 ? t().warning : t().accent}>
                        <b>{s().usagePercentage.toFixed(1)}%</b> / {formatThresholdPercent(s().executeThreshold)}%{s().executeThresholdClamped ? "*" : ""}
                    </text>
                )}
                <text fg={compactionOff() ? t().accent : s().usagePercentage >= 80 ? t().error : s().usagePercentage >= 65 ? t().warning : t().accent}>
                    {fmt(s().inputTokens)} / {contextLimit() > 0 ? fmt(contextLimit()) : "?"} tokens
                </text>
            </box>
            {s().windowGeometry && (
                <text fg={t().textMuted}>
                    {formatWindowDerivationLine(s().inputTokens, s().windowGeometry!)}
                </text>
            )}

            {/* Segmented breakdown bar: flex row of colored boxes filling
                the dialog width. See barSegments comment above. */}
            <box width="100%" flexDirection="row" height={1}>
                {barSegments().map((seg) => (
                    <box
                        key={seg.label}
                        flexGrow={Math.max(1, seg.tokens)}
                        flexBasis={0}
                        height={1}
                        backgroundColor={seg.color}
                    />
                ))}
            </box>

            {/* Breakdown legend */}
            <box flexDirection="column">
                {breakdownSegments().segs.map((seg) => {
                    const pct = ((seg.tokens / breakdownSegments().total) * 100).toFixed(1)
                    return (
                        <box key={seg.label} width="100%" flexDirection="row" justifyContent="space-between">
                            <text fg={seg.color}>{seg.label} {seg.detail ?? ""}</text>
                            <text fg={t().textMuted}>{fmt(seg.tokens)} ({pct}%)</text>
                        </box>
                    )
                })}
                <text fg={t().textMuted}>* Conversation includes Reasoning; hygiene excludes it</text>
                {s().tailHygiene !== undefined && (
                    <R
                        t={t()}
                        l="Hygiene"
                        v={formatTailHygiene(s().tailHygiene!)}
                        fg={s().tailHygiene!.evaluable ? t().accent : t().warning}
                    />
                )}
            </box>

            {/* Recomp / session-upgrade live progress (full width, only while
                running or just finished — dogfood 2026-05-30). */}
            {!compactionOff() && s().recompProgress && (() => {
                const p = s().recompProgress!
                const verb = p.kind === "upgrade" ? "Upgrade" : p.kind === "embed" ? "Embed" : "Recomp"
                return (
                <box marginTop={1} width="100%" flexDirection="column">
                    <text fg={t().text}><b>{verb}</b></text>
                    {(() => {
                        if (p.phase === "recomp") {
                            const frac = p.totalMessages > 0 ? p.processedMessages / p.totalMessages : 0
                            const width = 24
                            const filled = Math.round(Math.max(0, Math.min(1, frac)) * width)
                            const bar = p.totalMessages > 0
                                ? `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`
                                : "(starting…)"
                            const activeLabel = p.kind === "upgrade" ? "upgrading" : p.kind === "embed" ? "embedding" : "comparting"
                            return (
                                <>
                                    <R t={t()} l={activeLabel} v={p.totalMessages > 0 ? `${bar} ${Math.round(frac * 100)}%` : bar} fg={t().warning} />
                                    {p.note ? <R t={t()} l="Status" v={p.note} fg={t().textMuted} /> : null}
                                    {p.kind === "embed"
                                        ? <R t={t()} l="Compartments" v={`${p.processedMessages}/${p.totalMessages} embedded`} fg={t().textMuted} />
                                        : <R t={t()} l="Compartments" v={`${p.compartmentsCreated} (${p.passCount} pass${p.passCount === 1 ? "" : "es"})`} fg={t().textMuted} />}
                                </>
                            )
                        }
                        if (p.phase === "migration") return <R t={t()} l="Status" v={p.note ?? "Migrating memories ⟳"} fg={t().warning} />
                        if (p.phase === "done") return <R t={t()} l="Status" v={`✓ ${verb} complete`} fg={t().accent} />
                        if (p.phase === "skipped") return <R t={t()} l="Status" v={p.message ?? `${verb} stopped early`} fg={t().textMuted} />
                        return <R t={t()} l="Status" v={`✗ ${verb} failed${p.message ? `: ${p.message}` : ""}`} fg={t().error} />
                    })()}
                </box>
                )
            })()}

            <box flexDirection="row" width="100%" marginTop={1} gap={4}>
                {compactionOff() ? (
                    <box flexDirection="column" flexGrow={1} flexBasis={0}>
                        <text fg={t().text}><b>Knowledge</b></text>
                        {compactionOffSidebarRows(s()).map((row) => (
                            <R
                                t={t()}
                                l={row.label}
                                v={row.value}
                                fg={row.label === "Memories" ? t().accent : t().textMuted}
                            />
                        ))}
                        {s().readySmartNoteCount > 0 && (
                            <R t={t()} l="Smart Notes" v={`${s().readySmartNoteCount} ready`} fg={t().accent} />
                        )}
                        {s().lastDreamerRunAt && (
                            <R t={t()} l="Dreamer" v={`last ${relTime(s().lastDreamerRunAt!)}`} fg={t().textMuted} />
                        )}
                    </box>
                ) : (
                    <>
                        <box flexDirection="column" flexGrow={1} flexBasis={0}>
                            <text fg={t().text}><b>Tags</b></text>
                            <R t={t()} l="Active" v={`${s().activeTags} (~${fmtBytes(s().activeBytes)})`} />
                            <R t={t()} l="Dropped" v={String(s().droppedTags)} />
                            <R t={t()} l="Total" v={String(s().totalTags)} fg={t().textMuted} />
                            <box marginTop={1}>
                                <text fg={t().text}><b>Pending Queue</b></text>
                            </box>
                            <R t={t()} l="Drops" v={String(s().pendingOpsCount)} fg={s().pendingOpsCount > 0 ? t().warning : t().textMuted} />
                            <box marginTop={1}>
                                <text fg={t().text}><b>Cache TTL</b></text>
                            </box>
                            <R t={t()} l="Configured" v={s().cacheTtl} />
                            <R t={t()} l="Last response" v={s().lastResponseTime > 0 ? `${Math.round(elapsed() / 1000)}s ago` : "never"} />
                            <R t={t()} l="Remaining" v={s().cacheExpired ? "expired" : s().cacheNeverExpires ? "never expires (always-warm lane)" : `${Math.round(s().cacheRemainingMs / 1000)}s`} fg={s().cacheExpired ? t().warning : t().textMuted} />
                            <R t={t()} l="Auto-execute" v={s().cacheExpired ? "yes (expired)" : s().cacheNeverExpires ? `at ≥${formatThresholdPercent(s().executeThreshold)}%` : `at TTL or ≥${formatThresholdPercent(s().executeThreshold)}%`} fg={t().textMuted} />
                            <box marginTop={1}>
                                <text fg={t().text}><b>Memory</b></text>
                            </box>
                            <R t={t()} l="Active" v={String(s().memoryCount)} fg={t().accent} />
                            <R t={t()} l="Injected" v={String(s().memoryBlockCount)} fg={t().textMuted} />
                        </box>
                        <box flexDirection="column" flexGrow={1} flexBasis={0}>
                            <text fg={t().text}><b>Reductions</b></text>
                            <R t={t()} l="Execute threshold" v={`${formatThresholdPercent(s().executeThreshold)}%${s().executeThresholdClamped ? "*" : ""}`} />
                            <R t={t()} l="Last reduce anchor" v={`${fmt(s().lastNudgeTokens)} tok`} />
                            <box marginTop={1}>
                                <text fg={t().text}><b>Context Details</b></text>
                            </box>
                            <R t={t()} l="Protected tags" v={String(s().protectedTagCount)} fg={t().textMuted} />
                            <R t={t()} l="Subagent" v={s().isSubagent ? "yes" : "no"} fg={t().textMuted} />
                            <box marginTop={1}>
                                <text fg={t().text}><b>History Compression</b></text>
                            </box>
                            {typeof s().boundaryPresent === "boolean" && (
                                <R t={t()} l="Boundary" v={s().boundaryPresent ? "present" : "absent"} />
                            )}
                            {s().coverageOrdinal !== undefined && (
                                <R t={t()} l="Coverage ordinal" v={s().coverageOrdinal == null ? "none" : String(s().coverageOrdinal)} />
                            )}
                            {typeof s().boundaryPresent === "boolean" && (
                                <R t={t()} l="Compartments" v={String(s().compartmentCount)} />
                            )}
                            <R t={t()} l="History block" v={`~${fmt(s().historyBlockTokens)} tok`} />
                            {s().compressionBudget != null && (
                                <R t={t()} l="Budget" v={`~${fmt(s().compressionBudget!)} tok (${s().compressionUsage} used)`} />
                            )}
                            {s().lastDreamerRunAt && (
                                <R t={t()} l="Dreamer" v={`last ${relTime(s().lastDreamerRunAt!)}`} fg={t().textMuted} />
                            )}
                        </box>
                    </>
                )}
            </box>

            {/* Error (full width, conditional) */}
            {s().lastTransformError && (
                <box marginTop={1} width="100%">
                    <text fg={t().error}>⚠ {s().lastTransformError}</text>
                </box>
            )}

            <box marginTop={1} width="100%">
                <text fg={t().text}><b>Logger</b></text>
                <R
                    t={t()}
                    l="Swallowed writes"
                    v={String(s().loggerDiagnostics?.swallowedWriteCount ?? 0)}
                    fg={(s().loggerDiagnostics?.swallowedWriteCount ?? 0) > 0 ? t().error : t().textMuted}
                />
                {s().loggerDiagnostics?.lastErrorMessage && (
                    <R t={t()} l="Last error" v={s().loggerDiagnostics.lastErrorMessage} fg={t().error} />
                )}
                {s().loggerDiagnostics?.lastErrorTime && (
                    <R t={t()} l="Last error time" v={s().loggerDiagnostics.lastErrorTime} fg={t().textMuted} />
                )}
            </box>

            {/* Footer */}
            <box marginTop={1} justifyContent="flex-end" width="100%">
                <text fg={t().textMuted}>Esc to close</text>
            </box>
        </box>
    )
}

function getModelKeyFromMessages(api: TuiPluginApi, sessionId: string): string | undefined {
    try {
        const msgs = api.state.session.messages(sessionId)
        for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i] as Record<string, unknown>
            if (msg.role === "assistant" && msg.providerID && msg.modelID) {
                return `${msg.providerID}/${msg.modelID}`
            }
            if (msg.role === "user") {
                const model = msg.model as Record<string, unknown> | undefined
                if (model?.providerID && model?.modelID) {
                    return `${model.providerID}/${model.modelID}`
                }
            }
        }
    } catch {
    }
    return undefined
}

async function showRecompDialog(api: TuiPluginApi, targetSessionId = getSessionId(api)): Promise<boolean> {
    const sessionId = targetSessionId
    if (!sessionId) {
        showToast(api, { message: "No active session", variant: "warning" })
        return false
    }

    const countResult = await getCompartmentCount(sessionId)
    if (getSessionId(api) !== sessionId) return false
    if (!countResult.ok) {
        showToast(api, { message: "Unable to load recomp details", variant: "error" })
        return false
    }
    const count = countResult.count

    api.ui.dialog.replace(() => (
        <api.ui.DialogConfirm
            title="⚠️ Recomp Confirmation"
            message={[
                count === 0
                    ? "This session has no compartments yet — recomp will build them from raw history."
                    : `You have ${count} compartments.`,
                "",
                "Recomp will regenerate all compartments and facts from raw history.",
                "This may take a long time and consume significant tokens.",
                "",
                "Proceed?",
            ].join("\n")}
            onConfirm={async () => {
                const requested = await requestRecomp(sessionId)
                if (!requested) {
                    showToast(api, { message: "Recomp request failed", variant: "error" })
                    return
                }
                kickRecompProgressRefresh()
                showToast(api, { message: "Recomp requested — historian will start shortly", variant: "info" })
            }}
            onCancel={() => {
                showToast(api, { message: "Recomp cancelled", variant: "info", durationOverrideMs: 3000 })
            }}
        />
    ))
    return true
}

function showUpgradeDialog(
    api: TuiPluginApi,
    resume?: { stagedCount: number; stagedThrough: number },
    targetSessionId = getSessionId(api),
): boolean {
    const sessionId = targetSessionId
    if (!sessionId) {
        return false
    }

    if (getSessionId(api) !== sessionId) return false

    const title = resume ? "🎆 Resume the interrupted upgrade?" : "🎆 Historian V2 is released!"
    const message = resume
        ? [
              `An earlier upgrade to the new historian format was interrupted. ${resume.stagedCount} compartment${resume.stagedCount === 1 ? " was" : "s were"} already rebuilt (through message ${resume.stagedThrough}). Resuming continues from where it left off — nothing already rebuilt is reprocessed.`,
              "",
              "Resuming will:",
              "• Rebuild the remaining compartments into the new layered format",
              "• Re-organize this project's memories into the new taxonomy (once per project)",
              "",
              "The historian runs in the background and you can keep working. You can also resume via /ctx-session-upgrade later.",
              "",
              "Resume the upgrade now?",
          ].join("\n")
        : [
              "This session's compartments are written by the old historian. The session is still usable with its old compartments, however it's strongly advised to upgrade them to the new format. This means every compartment needs to be reprocessed by the new historian, which might take a while depending on how big your session is.",
              "",
              "Running the upgrade will:",
              "• Rebuild this session's compartments into the new layered format",
              "• Re-organize this project's memories into the new taxonomy (once per project)",
              "",
              "The historian runs in the background and you can keep working while older compartments are reprocessed. You can also upgrade via /ctx-session-upgrade later.",
              "",
              "Run the upgrade now?",
          ].join("\n")

    api.ui.dialog.replace(
        () => (
            <api.ui.DialogConfirm
                title={title}
                message={message}
                onConfirm={async () => {
                    const started = await requestUpgrade(sessionId)
                    if (!started) {
                        showToast(api, { message: "Session upgrade request failed", variant: "error" })
                        return
                    }
                    kickRecompProgressRefresh()
                    showToast(api, {
                        message: resume
                            ? "Resuming session upgrade — running in the background"
                            : "Session upgrade started — running in the background",
                        variant: "info",
                    })
                    void dismissUpgradeReminder(sessionId)
                }}
                onCancel={() => {
                    void dismissUpgradeReminder(sessionId)
                    showToast(api, {
                        message: "Upgrade skipped — run /ctx-session-upgrade anytime",
                        variant: "info",
                        durationOverrideMs: 4000,
                    })
                }}
            />
        ),
    )
    return true
}

async function showStatusDialog(api: TuiPluginApi, targetSessionId = getSessionId(api)): Promise<boolean> {
    const sessionId = targetSessionId
    if (!sessionId) {
        showToast(api, { message: "No active session", variant: "warning" })
        return false
    }

    const directory = api.state.path.directory ?? ""
    const modelKey = getModelKeyFromMessages(api, sessionId)
    const detail = await loadStatusDetail(sessionId, directory, modelKey)
    if (getSessionId(api) !== sessionId) return false

    api.ui.dialog.replace(() => <StatusDialog api={api} s={detail} />)
    return true
}

const EmbedDialog = (props: { api: TuiPluginApi; detail: EmbedDetail }) => {
    const theme = createMemo(() => (props.api as any).theme.current)
    const t = () => theme()
    const lines = () => props.detail.statusText.split("\n")
    return (
        <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            <box justifyContent="center" width="100%" marginBottom={1}>
                <text fg={t().accent}><b>Embedding</b></text>
            </box>
            {lines().map((line) => (
                <text fg={t().text}>{line}</text>
            ))}
        </box>
    )
}

async function showEmbedDialog(api: TuiPluginApi, targetSessionId = getSessionId(api)): Promise<boolean> {
    const sessionId = targetSessionId
    if (!sessionId) {
        api.ui.toast({ message: "No active session", variant: "warning" })
        return false
    }
    const directory = api.state.path.directory ?? ""
    const detail = await loadEmbedDetail(sessionId, directory)
    if (getSessionId(api) !== sessionId) return false
    api.ui.dialog.replace(() => <EmbedDialog api={api} detail={detail} />)
    return true
}

function showResultDialog(api: TuiPluginApi, title: string, message: string): boolean {
    api.ui.dialog.replace(() => (
        <api.ui.DialogAlert
            title={title}
            message={message}
            onConfirm={() => {}}
        />
    ))
    return true
}

type TuiProbeResult = {
    hostConstructed: boolean
    hostThrew: string | null
    customThrew: string | null
    opencodeVersion: string
    hostPainted: boolean | null
    hostPaint: string
}

function probeErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return message.replace(/\s+/g, " ").trim() || "unknown error"
}

function probeVersion(api: TuiPluginApi): string {
    try {
        const version = api.app?.version
        return typeof version === "string" && version.length > 0 ? version : "unavailable"
    } catch {
        return "unavailable"
    }
}

function renderTuiProbeHostArm(api: TuiPluginApi, result: TuiProbeResult): void {
    try {
        api.ui.dialog.replace(() => {
            try {
                const element = (
                    <api.ui.DialogAlert
                        title="Magic Context TUI probe: host arm"
                        message="Host-owned dialog probe is rendering. It will be replaced after 500ms."
                        onConfirm={() => {}}
                    />
                )
                result.hostConstructed = true
                return element
            } catch (error) {
                result.hostThrew = probeErrorMessage(error)
                return null as unknown as JSX.Element
            }
        })
    } catch (error) {
        result.hostThrew ??= probeErrorMessage(error)
    }
}

function renderTuiProbeCustomArm(api: TuiPluginApi, result: TuiProbeResult): void {
    try {
        api.ui.dialog.replace(() => {
            try {
                return (
                    <box>
                        <text>probe</text>
                    </box>
                )
            } catch (error) {
                result.customThrew = probeErrorMessage(error)
                return null as unknown as JSX.Element
            }
        })
    } catch (error) {
        result.customThrew ??= probeErrorMessage(error)
    }
}

async function waitForTuiProbeHostPaint(api: TuiPluginApi, result: TuiProbeResult): Promise<void> {
    if (result.hostThrew !== null) {
        result.hostPainted = false
        result.hostPaint = "not_reached_host_threw"
        return
    }

    type ProbeRenderer = {
        once?: (event: string, listener: () => void) => unknown
        removeListener?: (event: string, listener: () => void) => unknown
    }
    let renderer: ProbeRenderer | undefined
    try {
        renderer = api.renderer as unknown as ProbeRenderer
    } catch {
    }
    if (!renderer || typeof renderer.once !== "function") {
        await new Promise<void>((resolve) => setTimeout(resolve, 500))
        result.hostPainted = null
        result.hostPaint = "no_frame_signal_after_500ms_visual_confirmation_required"
        return
    }

    await new Promise<void>((resolve) => {
        let settled = false
        const onFrame = () => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            renderer.removeListener?.("frame", onFrame)
            result.hostPainted = true
            result.hostPaint = "observed_renderer_frame"
            resolve()
        }
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            renderer?.removeListener?.("frame", onFrame)
            result.hostPainted = null
            result.hostPaint = "no_frame_after_500ms_visual_confirmation_required"
            resolve()
        }, 500)
        try {
            renderer.once("frame", onFrame)
        } catch (error) {
            if (settled) return
            settled = true
            clearTimeout(timer)
            renderer.removeListener?.("frame", onFrame)
            result.hostPainted = null
            result.hostPaint = `frame_signal_error_${probeErrorMessage(error)}`
            resolve()
        }
    })
}

function tuiProbeSummary(result: TuiProbeResult): string[] {
    return [
        `host_constructed=${String(result.hostConstructed)}`,
        `host_threw=${result.hostThrew ?? "false"}`,
        `custom_threw=${result.customThrew ?? "false"}`,
        `opencode_version=${result.opencodeVersion}`,
        `host_painted=${result.hostPainted === null ? "unknown" : String(result.hostPainted)}`,
        `host_paint=${result.hostPaint}`,
    ]
}

function reportTuiProbe(api: TuiPluginApi, result: TuiProbeResult): void {
    const lines = tuiProbeSummary(result)
    for (const line of lines) {
        console.error(`[mc-probe] ${line}`)
    }

    const summary = lines.join("\n")
    if (result.customThrew === null) {
        try {
            api.ui.dialog.replace(() => (
                <box>
                    <text>{summary}</text>
                </box>
            ))
            return
        } catch (error) {
            console.error(`[mc-probe] summary_custom_threw=${probeErrorMessage(error)}`)
        }
    }

    if (result.hostThrew === null) {
        try {
            api.ui.dialog.replace(() => (
                <api.ui.DialogAlert
                    title="Magic Context TUI probe"
                    message={summary}
                    onConfirm={() => {}}
                />
            ))
            return
        } catch (error) {
            console.error(`[mc-probe] summary_host_threw=${probeErrorMessage(error)}`)
        }
    }

    console.error("[mc-probe] summary_rendered=console_only")
}

async function runTuiProbe(api: TuiPluginApi): Promise<void> {
    const result: TuiProbeResult = {
        hostConstructed: false,
        hostThrew: null,
        customThrew: null,
        opencodeVersion: probeVersion(api),
        hostPainted: null,
        hostPaint: "not_checked",
    }

    renderTuiProbeHostArm(api, result)
    await waitForTuiProbeHostPaint(api, result)

    renderTuiProbeCustomArm(api, result)
    reportTuiProbe(api, result)
}

/**
 *
 *
 * Version coverage:
 */
function registerCommandPaletteEntries(api: TuiPluginApi): void {
    type ApiAny = {
        keymap?: {
            registerLayer?: (layer: {
                commands: Array<Record<string, unknown>>
                bindings: Array<Record<string, unknown>>
            }) => unknown
        }
        command?: {
            register?: (cb: () => Array<Record<string, unknown>>) => unknown
        }
    }
    const apiAny = api as unknown as ApiAny

    if (typeof apiAny.keymap?.registerLayer === "function") {
        try {
            apiAny.keymap.registerLayer({
                commands: [
                    {
                        namespace: "palette",
                        name: "magic-context.status",
                        title: "Magic Context: Status",
                        category: "Magic Context",
                        run() {
                            showStatusDialog(api)
                        },
                    },
                    {
                        namespace: "palette",
                        name: "magic-context.recomp",
                        title: "Magic Context: Recomp",
                        category: "Magic Context",
                        run() {
                            showRecompDialog(api)
                        },
                    },
                    {
                        namespace: "palette",
                        name: "ctx-tui-probe",
                        title: "Magic Context: TUI Probe",
                        category: "Magic Context",
                        run() {
                            void runTuiProbe(api)
                        },
                    },
                ],
                bindings: [],
            })
            return
        } catch (err) {
            console.debug(
                "[magic-context-tui] keymap.registerLayer threw; falling back to command.register",
                err,
            )
        }
    }

    if (typeof apiAny.command?.register === "function") {
        apiAny.command.register(() => [
            {
                title: "Magic Context: Status",
                value: "magic-context.status",
                category: "Magic Context",
                onSelect() {
                    showStatusDialog(api)
                },
            },
            {
                title: "Magic Context: Recomp",
                value: "magic-context.recomp",
                category: "Magic Context",
                onSelect() {
                    showRecompDialog(api)
                },
            },
            {
                title: "Magic Context: TUI Probe",
                value: "ctx-tui-probe",
                category: "Magic Context",
                onSelect() {
                    void runTuiProbe(api)
                },
            },
        ])
        return
    }

    // via RPC.
}

/**
 *
 */
/**
 */
async function showStartupAnnouncement(api: TuiPluginApi): Promise<void> {
    try {
        const ann = await getAnnouncement()
        if (!ann.show || !ann.version || !ann.features || ann.features.length === 0) return

        const title = `Magic Context v${ann.version}`
        const lines: string[] = [
            "What's new:",
            "",
            ...ann.features.map((line) => `  • ${line}`),
        ]
        if (ann.footer && ann.footer.trim().length > 0) {
            lines.push("", ann.footer)
        }
        const message = lines.join("\n")

        api.ui.dialog.replace(
            () => (
                <api.ui.DialogAlert
                    title={title}
                    message={message}
                    onConfirm={() => {
                        void markAnnounced()
                    }}
                />
            ),
            () => {
                // The user dismissed the dialog rather than confirming it.
                // The dismissal callback records the announcement even without confirmation.
                void markAnnounced()
            },
        )
    } catch {
        // The TUI ignores announcement RPC failures.
        // On announcement RPC failure, the next TUI start re-checks.
    }
}

const tui: TuiPlugin = async (api, _options, meta) => {
    const directory = api.state.path.directory ?? ""
    // The TUI gates RPC discovery and socket startup so disabled installations perform no idle work.
    // `isCompactionEnabled` receives the loaded config to avoid deriving compaction mode from `directory` alone.
    // `pluginConfig` remains undefined after config-load failure, so `isCompactionEnabled` defaults to `true`.
    let pluginConfig: ReturnType<typeof loadPluginConfig> | undefined
    try {
        pluginConfig = loadPluginConfig(directory)
    } catch {
    }
    const conflictResult = detectConflicts(directory, {
        compactionEnabled: isCompactionEnabled(pluginConfig ?? {}),
    })
    if (conflictResult.hasConflict) {
        showConflictDialog(api, directory, conflictResult.reasons, conflictResult.conflicts)
        return
    }

    initRpcClient(directory)
    await refreshToastDurationMs()

    const sidebarSlot = createSidebarContentSlot(api)
    api.slots.register(sidebarSlot)

    // The TUI omits slash fields because the server registers `/ctx-*` commands.
    // In TUI mode, the server sends dialog requests through RPC.
    // of sendIgnoredMessage.
    //
    // `api.command.register` is guarded because supported OpenCode versions can omit it.
    // `registerCommandPaletteEntries` prefers `api.keymap.registerLayer` and falls back to `api.command.register` when `registerLayer` is unavailable or throws.
    registerCommandPaletteEntries(api)

    // The server pushes queued notifications over one persistent WebSocket.
    // A persistent WebSocket avoids the idle CPU cost of a 500 ms HTTP poll.
    // The socket includes the active session in its hello so the server scopes delivery.
    // The notification handler rechecks the active session because it can change between queueing and delivery.
    const handleNotification = async (n: SocketNotification): Promise<boolean> => {
        const requestedSessionId = getSessionId(api)
        const generation = getRpcGeneration()
        // The notification handler returns `false` for another session so the notification remains unacknowledged.
        // gets it.
        if (n.sessionId !== undefined && n.sessionId !== requestedSessionId) {
            return false
        }
        if (n.type === "toast") {
            const p = n.payload
            showToast(api, {
                message: String(p.message ?? ""),
                variant: (p.variant as "info" | "warning" | "error" | "success") ?? "info",
                durationOverrideMs:
                    typeof p.duration === "number" && Number.isFinite(p.duration)
                        ? p.duration
                        : undefined,
            })
            return true
        }
        if (n.type !== "action") return false
        const action = n.payload?.action
        const stillActive = () =>
            getRpcGeneration() === generation && getSessionId(api) === requestedSessionId
        if (action === "show-status-dialog") {
            return stillActive() && (await showStatusDialog(api, requestedSessionId))
        }
        if (action === "show-recomp-dialog") {
            return stillActive() && (await showRecompDialog(api, requestedSessionId))
        }
        if (action === "show-upgrade-dialog") {
            const resume =
                n.payload?.resume === true
                    ? {
                          stagedCount: Number(n.payload?.stagedCount ?? 0),
                          stagedThrough: Number(n.payload?.stagedThrough ?? 0),
                      }
                    : undefined
            return stillActive() && showUpgradeDialog(api, resume, requestedSessionId)
        }
        if (action === "show-embed-dialog") {
            return stillActive() && (await showEmbedDialog(api, requestedSessionId))
        }
        if (action === "refresh-sidebar") {
            if (!stillActive()) return false
            refreshSidebarSnapshot()
            return true
        }
        if (action === "wrapup-progress-kick") {
            // The wrapup handler starts the fast progress poll after `/ctx-wrapup` because it emits no message events for the sidebar poll to observe.
            // The start toast arrives through the ignored-message notification path.
            if (!stillActive()) return false
            kickRecompProgressRefresh()
            return true
        }
        if (action === "show-flush-dialog") {
            const flushMsg = String(n.payload?.message ?? "Flushed.")
            return stillActive() && showResultDialog(api, "Flush", flushMsg)
        }
        if (action === "show-result-dialog") {
            const title = String(n.payload?.title ?? "Magic Context")
            const body = String(n.payload?.message ?? "")
            return stillActive() && showResultDialog(api, title, body)
        }
        return false
    }

    startNotificationSocket({
        getSessionId: () => getSessionId(api),
        onNotification: handleNotification,
    })

    api.lifecycle.onDispose(() => {
        sidebarSlot.dispose()
        stopNotificationSocket()
        closeRpc()
    })

    // The startup handler starts the announcement RPC without awaiting it; the TUI retries it on the next launch if the RPC fails or the server is unavailable.
    // After a successful `mark-announced`, the server can suppress the recorded `ANNOUNCEMENT_VERSION`.
    void showStartupAnnouncement(api)
}

const id = "opencode-magic-context"

export default {
    id,
    tui,
}
