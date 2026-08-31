/** @jsxImportSource @opentui/solid */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { TuiSlotPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import packageJson from "../../../package.json"
import { badgeTextColor } from '../badge-contrast';
import { loadSidebarSnapshot, type SidebarSnapshot } from "../data/context-db"
import { formatThresholdPercent } from "../../shared/format-threshold"
import { formatTailHygiene } from "../../shared/tail-hygiene-status"
import { compactionOffSidebarRows, nativeCompactionContextLabel } from "../compaction-off"
import {
    computeEffectiveOrder,
    DEFAULT_SLOT_ORDER,
    type MagicContextTuiPrefs,
    PLUGIN_KEY,
    queueTuiPreferenceUpdate,
    readTuiPreferencesFile,
    readTuiPreferencesFileSync,
    resolveMagicContextPrefs,
    watchTuiPreferences,
} from "../../shared/tui-preferences"

// External callers can trigger the mounted sidebar's recomp refresh.
// mounted SidebarContent registers its refresh here.
let activeRecompPollKick: (() => void) | null = null
let activeSidebarRefresh: (() => void) | null = null
export function kickRecompProgressRefresh(): void {
    activeRecompPollKick?.()
}

/** External callers can request an out-of-band sidebar status update. */
export function refreshSidebarSnapshot(): void {
    activeSidebarRefresh?.()
}

const SINGLE_BORDER = { type: "single" } as any
const REFRESH_DEBOUNCE_MS = 150

export interface SidebarController {
    prefs: () => MagicContextTuiPrefs
    collapsed: () => boolean
    toggleCollapsed: () => void
    dispose: () => void
}

// The TUI may unmount and remount sidebar_content when the user switches views
// (main -> subagent -> main). A remount re-runs the component body, so a signal
// created inside the component would reset to its seed. The controller lives in
// the slot-factory closure (plugin/process lifetime) and owns the durable
// prefs/collapse signals plus the single shared file watcher, so collapse state
// and live pref reloads survive remounts. No Solid effects/memos here — those
// need an owner; the poll-interval effect stays inside the component.
function createSidebarController(initialPrefs: MagicContextTuiPrefs): SidebarController {
    const [prefs, setPrefs] = createSignal<MagicContextTuiPrefs>(initialPrefs)
    const seedCollapsed =
        initialPrefs.rememberCollapsed && initialPrefs.collapsed != null
            ? initialPrefs.collapsed
            : initialPrefs.startCollapsed
    const [collapsed, setCollapsed] = createSignal(seedCollapsed)
    let lastPersistedCollapsed: boolean | null = initialPrefs.collapsed
    let lastApplied = JSON.stringify(initialPrefs)

    // The watcher applies `next.collapsed` only when it differs from `lastPersistedCollapsed`, so unrelated preference reloads cannot overwrite an unpersisted click.
    const stopWatchingPreferences = watchTuiPreferences(() => {
        void (async () => {
            const next = resolveMagicContextPrefs(await readTuiPreferencesFile())
            const serialized = JSON.stringify(next)
            if (serialized === lastApplied) return
            lastApplied = serialized
            setPrefs(next)
            if (
                next.rememberCollapsed &&
                next.collapsed != null &&
                next.collapsed !== lastPersistedCollapsed
            ) {
                lastPersistedCollapsed = next.collapsed
                setCollapsed(next.collapsed)
            }
        })()
    })

    function toggleCollapsed() {
        const next = !collapsed()
        setCollapsed(next)
        if (prefs().rememberCollapsed) {
            void queueTuiPreferenceUpdate(PLUGIN_KEY, ["collapsed"], next).then(() => {
                lastPersistedCollapsed = next
            })
        }
    }

    return {
        prefs,
        collapsed,
        toggleCollapsed,
        dispose: stopWatchingPreferences,
    }
}

function compactTokens(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`
    return String(value)
}

function relativeTime(ms: number): string {
    const diff = Date.now() - ms
    if (diff < 60_000) return "just now"
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
    return `${Math.floor(diff / 86_400_000)}d ago`
}

function progressBar(fraction: number, width = 14): string {
    const clamped = Math.max(0, Math.min(1, fraction))
    const filled = Math.round(clamped * width)
    return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`
}

const COLORS = {
    // Plugin-injected structured traffic occupies `message[0]`.
    system: "#c084fc", // Purple
    docs: "#22d3ee", // Cyan — <project-docs>
    compartments: "#60a5fa", // Blue
    facts: "#fbbf24", // Yellow/orange
    memories: "#34d399", // Green
    profile: "#a3e635", // Lime — <user-profile>
    conversation: "#f87171", // Red
    toolCalls: "#fb923c", // Orange
    toolDefs: "#f472b6", // Pink
}

interface TokenSegment {
    key: string
    tokens: number
    color: string
    label: string
}

const TokenBreakdown = (props: {
    theme: TuiThemeCurrent
    snapshot: SidebarSnapshot
    // Collapsed mode renders only the proportional bar (no per-category legend
    // rows) so the sidebar shrinks to the progress bar + a few summary lines.
    collapsed?: boolean
}) => {
    // OpenTUI uses `flexGrow` with `flexBasis={0}` to fill the sidebar proportionally.
    const segments = createMemo<TokenSegment[]>(() => {
        const s = props.snapshot
        const total = s.inputTokens || 1
        const result: TokenSegment[] = []

        if (s.systemPromptTokens > 0) {
            result.push({
                key: "sys",
                tokens: s.systemPromptTokens,
                color: COLORS.system,
                label: "System",
            })
        }

        // Docs represents the injected `<project-docs>` block.
        if (s.docsTokens > 0) {
            result.push({
                key: "docs",
                tokens: s.docsTokens,
                color: COLORS.docs,
                label: "Docs",
            })
        }

        // Compartments (blue)
        if (s.compartmentTokens > 0) {
            result.push({
                key: "comp",
                tokens: s.compartmentTokens,
                color: COLORS.compartments,
                label: "Compartments",
            })
        }

        // Facts (yellow/orange)
        if (s.factTokens > 0) {
            result.push({
                key: "fact",
                tokens: s.factTokens,
                color: COLORS.facts,
                label: "Facts",
            })
        }

        // Memories (green)
        if (s.memoryTokens > 0) {
            result.push({
                key: "mem",
                tokens: s.memoryTokens,
                color: COLORS.memories,
                label: "Memories",
            })
        }

        // The injected `<user-profile>` block contains promoted user memories.
        if (s.profileTokens > 0) {
            result.push({
                key: "profile",
                tokens: s.profileTokens,
                color: COLORS.profile,
                label: "User Profile",
            })
        }

        // `Conversation` contains user and assistant text, reasoning, and images.
        // `Conversation` excludes injected session history and tool-call I/O.
        //
        // The `Conversation` row remains visible when its token count is zero.
        result.push({
            key: "conv",
            tokens: s.conversationTokens,
            color: COLORS.conversation,
            label: "Conversation*",
        })

        // `Tool Calls` includes `tool_use`, `tool_result`, `tool`, and `tool-invocation` message parts.
        if (s.toolCallTokens > 0) {
            result.push({
                key: "tool-calls",
                tokens: s.toolCallTokens,
                color: COLORS.toolCalls,
                label: "Tool Calls",
            })
        }

        // `Tool Definitions` measures tool descriptions and JSON-schema parameters.
        // OpenCode sends each tool in the `tools` request parameter.
        // The `tool.definition` plugin hook records definitions by `{provider, model, agent}`.
        // `toolDefinitionTokens` remains zero until the first turn measures the active agent's tool set.
        if (s.toolDefinitionTokens > 0) {
            result.push({
                key: "tool-defs",
                tokens: s.toolDefinitionTokens,
                color: COLORS.toolDefs,
                label: "Tool Defs",
            })
        }

        return result
    })

    const totalTokens = createMemo(() => props.snapshot.inputTokens || 1)

    // The legend retains zero-token segments to keep its rows stable.
    const barSegments = createMemo(() =>
        segments().filter((seg) => seg.tokens > 0),
    )

    return (
        <box width="100%" flexDirection="column">
            {/* Segmented bar: a width="100%" flex row of colored boxes,
                each with flexGrow proportional to its token count and
                flexBasis=0. opentui distributes the parent's full width
                proportionally, so the bar always fills the sidebar
                regardless of terminal size. Height is fixed at 1 row;
                backgroundColor renders the colored bar. */}
            <box width="100%" flexDirection="row" height={1}>
                {barSegments().map((seg) => (
                    <box
                        key={seg.key}
                        flexGrow={Math.max(1, seg.tokens)}
                        flexBasis={0}
                        height={1}
                        backgroundColor={seg.color}
                    />
                ))}
            </box>

            {/* Legend rows — suppressed in collapsed mode (bar only) */}
            {!props.collapsed && (
                <box flexDirection="column" marginTop={0}>
                    {segments().map((seg) => {
                        const pct = ((seg.tokens / totalTokens()) * 100).toFixed(0)
                        return (
                            <box
                                key={seg.key}
                                width="100%"
                                flexDirection="row"
                                justifyContent="space-between"
                            >
                                <text fg={seg.color}>{seg.label}</text>
                                <text fg={props.theme.textMuted}>
                                    {compactTokens(seg.tokens)} ({pct}%)
                                </text>
                            </box>
                        )
                    })}
                    <text fg={props.theme.textMuted}>* includes Reasoning; hygiene excludes it</text>
                </box>
            )}
        </box>
    )
}

const StatRow = (props: {
    theme: TuiThemeCurrent
    label: string
    value: string
    accent?: boolean
    warning?: boolean
    dim?: boolean
}) => {
    const fg = createMemo(() => {
        if (props.warning) return props.theme.warning
        if (props.accent) return props.theme.accent
        if (props.dim) return props.theme.textMuted
        return props.theme.text
    })

    return (
        <box width="100%" flexDirection="row" justifyContent="space-between">
            <text fg={props.theme.textMuted}>{props.label}</text>
            <text fg={fg()}>
                <b>{props.value}</b>
            </text>
        </box>
    )
}

const SectionHeader = (props: { theme: TuiThemeCurrent; title: string }) => (
    <box width="100%" marginTop={1}>
        <text fg={props.theme.text}>
            <b>{props.title}</b>
        </text>
    </box>
)

const RecompProgressSection = (props: {
    theme: TuiThemeCurrent
    progress: NonNullable<SidebarSnapshot["recompProgress"]>
}) => {
    const phase = () => props.progress.phase
    const fraction = () =>
        props.progress.totalMessages > 0
            ? props.progress.processedMessages / props.progress.totalMessages
            : 0
    const pct = () => Math.round(fraction() * 100)

    const verb = () =>
        props.progress.kind === "upgrade"
            ? "Upgrade"
            : props.progress.kind === "embed"
              ? "Embed"
              : props.progress.kind === "wrapup"
                ? "Wrapup"
                : "Recomp"
    const activeText = () =>
        props.progress.kind === "upgrade"
            ? "upgrading ⟳"
            : props.progress.kind === "embed"
              ? "embedding ⟳"
              : props.progress.kind === "wrapup"
                ? "wrapping ⟳"
                : "comparting ⟳"
    const label = createMemo(() => {
        switch (props.progress.phase) {
            case "recomp":
                return {
                    text: activeText(),
                    color: props.theme.warning,
                }
            case "migration":
                return { text: "Migrating memories ⟳", color: props.theme.warning }
            case "done":
                return { text: `✓ ${verb()} complete`, color: props.theme.success ?? props.theme.accent }
            case "skipped":
                return { text: "stopped", color: props.theme.textMuted }
            case "failed":
                return { text: `✗ ${verb()} failed`, color: props.theme.error }
        }
    })

    return (
        <>
            <box width="100%" marginTop={1} flexDirection="row" justifyContent="space-between">
                <text fg={props.theme.text}>
                    <b>{verb()}</b>
                </text>
                <text fg={label().color}>{label().text}</text>
            </box>
            {/* Determinate bar during the compartment-rebuild phase. */}
            {phase() === "recomp" && props.progress.totalMessages > 0 && (
                <box width="100%" flexDirection="row" justifyContent="space-between">
                    <text fg={props.theme.accent}>{progressBar(fraction())}</text>
                    <text fg={props.theme.textMuted}>{pct()}%</text>
                </box>
            )}
            {/* Transient status note (e.g. "Starting…", "Trying fallback
                sonnet-4-6…", "Repair retry…") — surfaces live activity during a
                long pass, including before the determinate range is known. */}
            {(phase() === "recomp" || phase() === "migration") && props.progress.note && (
                <text fg={props.theme.textMuted}>{props.progress.note}</text>
            )}
            {phase() === "recomp" && props.progress.kind !== "embed" && (
                <StatRow
                    theme={props.theme}
                    label="Compartments"
                    value={`${props.progress.compartmentsCreated} (${props.progress.passCount} pass${props.progress.passCount === 1 ? "" : "es"})`}
                    dim
                />
            )}
            {phase() === "recomp" && props.progress.kind === "embed" && (
                <StatRow
                    theme={props.theme}
                    label="Compartments"
                    value={`${props.progress.processedMessages}/${props.progress.totalMessages} embedded`}
                    dim
                />
            )}
            {/* Terminal reason (failed/skipped) — kept visible so the user sees
                WHY (a failure, or the transient "retry shortly" skip cause). */}
            {(phase() === "failed" || phase() === "skipped") && props.progress.message && (
                <text fg={props.theme.textMuted}>{props.progress.message}</text>
            )}
        </>
    )
}

const SidebarContent = (props: {
    api: TuiPluginApi
    sessionID: () => string
    theme: TuiThemeCurrent
    controller: SidebarController
}) => {
    const [snapshot, setSnapshot] = createSignal<SidebarSnapshot | null>(null)
    const collapsed = props.controller.collapsed
    const sections = () => props.controller.prefs().sections
    const headerLabel = () => props.controller.prefs().header.label
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    let recompPollTimer: ReturnType<typeof setTimeout> | undefined
    const RECOMP_POLL_MS = 1200
    let recompActive = false
    let recompSawPhase = false
    let recompPollCount = 0
    let recompConsecutiveAbsent = 0
    let recompSessionId: string | null = null
    let snapshotRequestSequence = 0
    const RECOMP_PROBE_MAX = 12 // ~15s for the server's "Starting…" to land
    // FIRST absent-after-active.
    const RECOMP_ABSENT_GIVEUP = 40 // ~48s of continuous absence → stop
    const RECOMP_MAX_POLLS = 1500 // ~30min absolute safety cap

    const refresh = () => {
        const sid = props.sessionID()
        if (!sid) return
        const sequence = ++snapshotRequestSequence
        const directory = props.api.state.path.directory ?? ""
        void loadSidebarSnapshot(sid, directory)
            .then((data) => {
                if (props.sessionID() !== sid || sequence !== snapshotRequestSequence) return
                setSnapshot(data)
                try {
                    props.api.renderer.requestRender()
                } catch {
                }
                const phase = data?.recompProgress?.phase
                if ((phase === "recomp" || phase === "migration") && !recompActive) {
                    kickRecompPoll()
                } else if (recompActive && recompSessionId === sid) {
                    scheduleRecompTick()
                }
            })
            .catch(() => {
                if (recompActive && recompSessionId === sid && props.sessionID() === sid) {
                    scheduleRecompTick()
                }
            })
    }

    const scheduleRefresh = () => {
        if (refreshTimer) clearTimeout(refreshTimer)
        refreshTimer = setTimeout(() => {
            refreshTimer = undefined
            refresh()
        }, REFRESH_DEBOUNCE_MS)
    }

    const stopRecompPoll = () => {
        recompActive = false
        recompSessionId = null
        snapshotRequestSequence += 1
        if (recompPollTimer) clearTimeout(recompPollTimer)
        recompPollTimer = undefined
    }

    const scheduleRecompTick = () => {
        if (!recompActive) return
        if (recompPollTimer) clearTimeout(recompPollTimer)
        recompPollTimer = setTimeout(recompTick, RECOMP_POLL_MS)
    }

    function recompTick(): void {
        const sid = recompSessionId
        if (!recompActive || !sid || props.sessionID() !== sid) {
            stopRecompPoll()
            return
        }
        recompPollCount += 1
        if (recompPollCount > RECOMP_MAX_POLLS) {
            stopRecompPoll()
            return
        }
        const sequence = ++snapshotRequestSequence
        const directory = props.api.state.path.directory ?? ""
        void loadSidebarSnapshot(sid, directory)
            .then((data) => {
                if (
                    !recompActive ||
                    recompSessionId !== sid ||
                    props.sessionID() !== sid ||
                    sequence !== snapshotRequestSequence
                ) return
                const phase = data?.recompProgress?.phase
                const prevProgress = snapshot()?.recompProgress
                const merged =
                    !phase && recompSawPhase && prevProgress
                        ? { ...data, recompProgress: prevProgress }
                        : data
                setSnapshot(merged)
                try {
                    props.api.renderer.requestRender()
                } catch {
                }
                if (phase === "recomp" || phase === "migration") {
                    recompSawPhase = true
                    recompConsecutiveAbsent = 0
                    scheduleRecompTick()
                } else if (phase === "done" || phase === "failed" || phase === "skipped") {
                    stopRecompPoll()
                } else {
                    recompConsecutiveAbsent += 1
                    if (!recompSawPhase) {
                        if (recompPollCount < RECOMP_PROBE_MAX) scheduleRecompTick()
                        else {
                            stopRecompPoll()
                        }
                    } else if (recompConsecutiveAbsent < RECOMP_ABSENT_GIVEUP) {
                        scheduleRecompTick()
                    } else {
                        stopRecompPoll()
                    }
                }
            })
            .catch(() => {
                if (
                    recompActive &&
                    recompSessionId === sid &&
                    props.sessionID() === sid &&
                    sequence === snapshotRequestSequence
                ) scheduleRecompTick()
            })
    }

    // The server emits "Starting…" immediately after it detects an active recomp.
    // The probe window covers the RPC race before the server emits the immediate "Starting…" entry.
    function kickRecompPoll(): void {
        const sid = props.sessionID()
        if (!sid) return
        if (recompActive && recompSessionId === sid) return
        stopRecompPoll()
        recompActive = true
        recompSessionId = sid
        recompSawPhase = false
        recompPollCount = 0
        recompConsecutiveAbsent = 0
        recompTick()
    }

    activeRecompPollKick = kickRecompPoll
    activeSidebarRefresh = refresh

    onCleanup(() => {
        if (refreshTimer) clearTimeout(refreshTimer)
        stopRecompPoll()
        if (activeRecompPollKick === kickRecompPoll) activeRecompPollKick = null
        if (activeSidebarRefresh === refresh) activeSidebarRefresh = null
    })

    createEffect(
        on(props.sessionID, () => {
            stopRecompPoll()
            setSnapshot(null)
            refresh()
        }),
    )

    createEffect(
        on(
            props.sessionID,
            (sessionID) => {
                const unsubs = [
                    props.api.event.on("message.updated", (event) => {
                        if (event.properties.info.sessionID !== sessionID) return
                        scheduleRefresh()
                    }),
                    props.api.event.on("session.updated", (event) => {
                        if (event.properties.info.id !== sessionID) return
                        scheduleRefresh()
                    }),
                    props.api.event.on("message.removed", (event) => {
                        if (event.properties.sessionID !== sessionID) return
                        scheduleRefresh()
                    }),
                ]

                onCleanup(() => {
                    for (const unsub of unsubs) unsub()
                })
            },
            { defer: false },
        ),
    )

    const s = createMemo(() => snapshot())
    const compactionOff = () => s()?.compaction_enabled === false
    const contextSummaryColor = createMemo(() => {
        if (compactionOff()) return props.theme.accent
        const usage = s()?.usagePercentage ?? 0
        if (usage >= 80) return props.theme.error
        if (usage >= 65) return props.theme.warning
        return props.theme.accent
    })

    return (
        <box
            width="100%"
            flexDirection="column"
            border={SINGLE_BORDER}
            borderColor={props.theme.borderActive}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={1}
            paddingRight={1}
        >
            {/* Header: triangle toggle + badge + version. Clicking the row
                collapses/expands the panel (mirrors OpenCode's native MCP
                sidebar section and AFT's sidebar). */}
            <box
                flexDirection="row"
                justifyContent="space-between"
                alignItems="center"
                onMouseDown={() => props.controller.toggleCollapsed()}
            >
                <box paddingLeft={1} paddingRight={1} backgroundColor={props.theme.accent}>
                    <text fg={badgeTextColor(props.theme.accent, props.theme.background)}>
                        <b>{collapsed() ? "▶ " : "▼ "}{headerLabel()}</b>
                    </text>
                </box>
                <text fg={props.theme.textMuted}>v{packageJson.version}</text>
            </box>

            {/* The fence probe writes the failure into the server-owned snapshot,
                so this survives sidebar refreshes and is visible independently of
                the one-shot toast. */}
            {s()?.lastTransformError && (
                <box marginTop={1} width="100%">
                    <text fg={props.theme.error}>⚠ {s()!.lastTransformError}</text>
                </box>
            )}

            {s()?.dreamerProgress && (
                <box marginTop={1} width="100%">
                    <text fg={props.theme.warning}>
                        Dreamer {s()!.dreamerProgress!.task}: {s()!.dreamerProgress!.processed}/{s()!.dreamerProgress!.total} processed
                    </text>
                </box>
            )}

            {/* Token breakdown bar. In collapsed mode the header, bar and the
                3 summary rows stack with no vertical padding for a compact look;
                expanded mode keeps the 1-row gap above the bar. */}
            {s() && s()!.inputTokens > 0 && (
                <box marginTop={collapsed() ? 0 : 1} flexDirection="column">
                    {(s()?.contextLimit ?? 0) > 0 && (
                        <box width="100%" flexDirection="row" justifyContent="space-between">
                            {compactionOff() ? (
                                <text fg={contextSummaryColor()}>
                                    <b>{nativeCompactionContextLabel(s()!)}</b>
                                </text>
                            ) : (
                                <text fg={contextSummaryColor()}>
                                    <b>{s()!.usagePercentage.toFixed(1)}%</b> / {formatThresholdPercent(s()!.executeThreshold)}%{s()!.executeThresholdClamped ? "*" : ""}
                                </text>
                            )}
                            {/* Right: absolute token usage against the usable
                                scheduler window — the same denominator as the
                                percentage and nudge/trigger scheduling. */}
                            <text fg={contextSummaryColor()}>
                                {compactTokens(s()!.inputTokens)} / {compactTokens(s()!.contextLimit)}
                            </text>
                        </box>
                    )}
                    <TokenBreakdown theme={props.theme} snapshot={s()!} collapsed={collapsed()} />
                    {!collapsed() && (
                        <text fg={props.theme.textMuted}>Conversation includes reasoning estimates; hygiene excludes reasoning.</text>
                    )}
                    {s()!.tailHygiene !== undefined && (
                        <StatRow
                            theme={props.theme}
                            label="Hygiene"
                            value={formatTailHygiene(s()!.tailHygiene!)}
                            warning={!s()!.tailHygiene!.evaluable}
                        />
                    )}
                </box>
            )}

            {/* Collapsed view — progress bar (above) + 3 summary lines:
                Historian (with compartment count), Memories (injected/total),
                Status (Q=queued ops, N=session notes). */}
            {collapsed() && (
                <box width="100%" flexDirection="column">
                    {compactionOff() ? (
                        compactionOffSidebarRows(s()!).map((row) => (
                            <StatRow
                                theme={props.theme}
                                label={row.label}
                                value={row.value}
                                accent={row.label === "Memories"}
                                dim={row.label !== "Memories"}
                            />
                        ))
                    ) : (
                        <>
                            <box width="100%" flexDirection="row" justifyContent="space-between">
                                <text fg={props.theme.textMuted}>Historian</text>
                                {s()?.historianRunning ? (
                                    <text fg={props.theme.warning}>comparting ⟳</text>
                                ) : (
                                    <text fg={props.theme.textMuted}>idle</text>
                                )}
                            </box>
                            <Show when={s()?.dreamerProgress}>
                                {(progress) => (
                                    <box width="100%" flexDirection="row" justifyContent="space-between">
                                        <text fg={props.theme.textMuted}>Dreamer</text>
                                        <text fg={props.theme.warning}>
                                            {progress().task} {progress().processed}/{progress().total}
                                        </text>
                                    </box>
                                )}
                            </Show>
                            <box width="100%" flexDirection="row" justifyContent="space-between">
                                <text fg={props.theme.textMuted}>Memories</text>
                                <text fg={props.theme.textMuted}>
                                    {(s()?.memoryBlockCount ?? 0) > 0
                                        ? `${s()!.memoryBlockCount}/${s()?.memoryCount ?? 0}`
                                        : String(s()?.memoryCount ?? 0)}
                                </text>
                            </box>
                            <box width="100%" flexDirection="row" justifyContent="space-between">
                                <text fg={props.theme.textMuted}>Status</text>
                                <text fg={props.theme.textMuted}>
                                    C:{s()?.compartmentCount ?? 0} Q:{s()?.pendingOpsCount ?? 0} N:{s()?.sessionNoteCount ?? 0}
                                </text>
                            </box>
                            <Show when={s()?.recompProgress}>
                                {(progress) => (
                                    <RecompProgressSection theme={props.theme} progress={progress()} />
                                )}
                            </Show>
                        </>
                    )}
                </box>
            )}

            {/* Expanded view — full section grid. */}
            {!collapsed() && (
                <>
            {/* Historian section */}
            {!compactionOff() && sections().historian && (
                <>
            <box width="100%" marginTop={1} flexDirection="row" justifyContent="space-between">
                <text fg={props.theme.text}>
                    <b>Historian</b>
                </text>
                {s()?.historianRunning ? (
                    <text fg={props.theme.warning}>comparting ⟳</text>
                ) : (
                    <text fg={props.theme.textMuted}>idle</text>
                )}
            </box>
            <StatRow
                theme={props.theme}
                label="Compartments"
                value={String(s()?.compartmentCount ?? 0)}
            />

            {/* Recomp / session-upgrade live progress */}
            <Show when={s()?.recompProgress}>
                {(progress) => (
                    <RecompProgressSection theme={props.theme} progress={progress()} />
                )}
            </Show>
                </>
            )}

            {/* Memory section */}
            {sections().memory && (
                <>
            <SectionHeader theme={props.theme} title="Memory" />
            {compactionOff() ? (
                compactionOffSidebarRows(s()!)
                    .filter((row) => row.label === "Memories")
                    .map((row) => (
                        <StatRow theme={props.theme} label={row.label} value={row.value} accent />
                    ))
            ) : (
                <>
                    <StatRow
                        theme={props.theme}
                        label="Memories"
                        value={String(s()?.memoryCount ?? 0)}
                        accent
                    />
                    {(s()?.memoryBlockCount ?? 0) > 0 && (
                        <StatRow
                            theme={props.theme}
                            label="Injected"
                            value={String(s()!.memoryBlockCount)}
                            dim
                        />
                    )}
                </>
            )}
                </>
            )}

            {/* Queue & Status */}
            {sections().status &&
                (compactionOff() ||
                    (s()?.pendingOpsCount ?? 0) > 0 ||
                    (s()?.sessionNoteCount ?? 0) > 0 ||
                    (s()?.readySmartNoteCount ?? 0) > 0) && (
                    <>
                        <SectionHeader theme={props.theme} title="Status" />
                        {compactionOff() ? (
                            compactionOffSidebarRows(s()!)
                                .filter((row) => row.label !== "Memories")
                                .map((row) => (
                                    <StatRow
                                        theme={props.theme}
                                        label={row.label}
                                        value={row.value}
                                        dim
                                    />
                                ))
                        ) : (
                            <>
                                {(s()?.pendingOpsCount ?? 0) > 0 && (
                                    <StatRow
                                        theme={props.theme}
                                        label="Queue"
                                        value={`${s()!.pendingOpsCount} pending`}
                                        warning
                                    />
                                )}
                                {(s()?.sessionNoteCount ?? 0) > 0 && (
                                    <StatRow
                                        theme={props.theme}
                                        label="Notes"
                                        value={String(s()!.sessionNoteCount)}
                                    />
                                )}
                                {(s()?.readySmartNoteCount ?? 0) > 0 && (
                                    <StatRow
                                        theme={props.theme}
                                        label="Smart Notes"
                                        value={`${s()!.readySmartNoteCount} ready`}
                                        accent
                                    />
                                )}
                            </>
                        )}
                    </>
                )}

            {/* Dreamer */}
            {sections().dreamer && (s()?.lastDreamerRunAt || s()?.dreamerProgress) && (
                <>
                    <SectionHeader theme={props.theme} title="Dreamer" />
                    <Show when={s()?.dreamerProgress}>
                        {(progress) => (
                            <StatRow
                                theme={props.theme}
                                label="Current"
                                value={`${progress().task} ${progress().processed}/${progress().total}`}
                                warning
                            />
                        )}
                    </Show>
                    <Show when={s()?.lastDreamerRunAt}>
                        {(lastRunAt) => (
                            <StatRow
                                theme={props.theme}
                                label="Last run"
                                value={relativeTime(lastRunAt())}
                                dim
                            />
                        )}
                    </Show>
                    <For each={Object.entries(s()?.dreamerBacklog ?? {})}>
                        {([task, backlog]) => (
                            <StatRow
                                theme={props.theme}
                                label={task}
                                value={`${backlog.pending}/${backlog.total}`}
                                dim
                            />
                        )}
                    </For>
                </>
            )}

            {/* Stats — v0.21.8 ships a single "Total tokens" number while we
                figure out how to present the new-work / reprocessed
                categorization without confusing users. The underlying
                snapshot fields (newWorkTokens, totalInputTokens) and the
                session_meta columns are still populated; only the UI is
                simplified for now. */}
            {sections().stats && s()?.totalInputTokens != null && (
                <>
                    <SectionHeader theme={props.theme} title="Stats" />
                    <StatRow
                        theme={props.theme}
                        label="Total tokens"
                        value={compactTokens(s()!.totalInputTokens ?? 0)}
                        dim
                    />
                </>
            )}
                </>
            )}
        </box>
    )
}

export function createSidebarContentSlot(api: TuiPluginApi): TuiSlotPlugin & { dispose: () => void } {
    const seedRoot = readTuiPreferencesFileSync()
    const controller = createSidebarController(resolveMagicContextPrefs(seedRoot))
    const effectiveOrder = computeEffectiveOrder(seedRoot, PLUGIN_KEY, DEFAULT_SLOT_ORDER)
    return {
        order: effectiveOrder,
        dispose: controller.dispose,
        slots: {
            sidebar_content: (ctx, value) => {
                const theme = createMemo(() => ctx.theme.current)
                return (
                    <SidebarContent
                        api={api}
                        sessionID={() => value.session_id}
                        theme={theme()}
                        controller={controller}
                    />
                )
            },
        },
    }
}
