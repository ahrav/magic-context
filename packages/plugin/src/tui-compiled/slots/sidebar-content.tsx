import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createTextNode as _$createTextNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { effect as _$effect } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insertNode as _$insertNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { memo as _$memo } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insert as _$insert } from "opentui:runtime-module:%40opentui%2Fsolid";
import { setProp as _$setProp } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createElement as _$createElement } from "opentui:runtime-module:%40opentui%2Fsolid";
/** @jsxImportSource @opentui/solid */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "opentui:runtime-module:solid-js";
import packageJson from "../../../package.json";
import { badgeTextColor } from "../badge-contrast";
import { loadSidebarSnapshot } from "../data/context-db";
import { formatThresholdPercent } from "../../shared/format-threshold";
import { formatTailHygiene } from "../../shared/tail-hygiene-status";
import { compactionOffSidebarRows, nativeCompactionContextLabel } from "../compaction-off";
import { computeEffectiveOrder, DEFAULT_SLOT_ORDER, PLUGIN_KEY, queueTuiPreferenceUpdate, readTuiPreferencesFile, readTuiPreferencesFileSync, resolveMagicContextPrefs, watchTuiPreferences } from "../../shared/tui-preferences";

// The upgrade/recomp dialog starts sidebar polling immediately after confirmation, before a parent-session message arrives.
// Mounted SidebarContent assigns its refresh callback to activeRecompPollKick.
let activeRecompPollKick = null;
let activeSidebarRefresh = null;
export function kickRecompProgressRefresh() {
  activeRecompPollKick?.();
}

/** refreshSidebarSnapshot asks the mounted sidebar to fetch an out-of-band status update now. */
export function refreshSidebarSnapshot() {
  activeSidebarRefresh?.();
}
const SINGLE_BORDER = {
  type: "single"
};
const REFRESH_DEBOUNCE_MS = 150;
// SidebarContent remounts when users switch main → subagent → main.
// A component-local signal resets to its seed when SidebarContent remounts.
// The slot-factory controller keeps its signals across SidebarContent remounts.
// The controller exists for the plugin lifetime.
// The controller shares one preference watcher and preserves prefs and collapse state across remounts.
// Create Solid effects and memos only under an owner.
// Keep the poll-interval effect in SidebarContent, which has a Solid owner.
function createSidebarController(initialPrefs) {
  const [prefs, setPrefs] = createSignal(initialPrefs);
  const seedCollapsed = initialPrefs.rememberCollapsed && initialPrefs.collapsed != null ? initialPrefs.collapsed : initialPrefs.startCollapsed;
  const [collapsed, setCollapsed] = createSignal(seedCollapsed);
  let lastPersistedCollapsed = initialPrefs.collapsed;
  let lastApplied = JSON.stringify(initialPrefs);

  // Update `lastPersistedCollapsed` after persistence succeeds so watcher echoes preserve the user's selection.
  // The `!== lastPersistedCollapsed` check prevents watcher echoes from reverting a user click.
  const stopWatchingPreferences = watchTuiPreferences(() => {
    void (async () => {
      const next = resolveMagicContextPrefs(await readTuiPreferencesFile());
      const serialized = JSON.stringify(next);
      if (serialized === lastApplied) return;
      lastApplied = serialized;
      setPrefs(next);
      if (next.rememberCollapsed && next.collapsed != null && next.collapsed !== lastPersistedCollapsed) {
        lastPersistedCollapsed = next.collapsed;
        setCollapsed(next.collapsed);
      }
    })();
  });
  function toggleCollapsed() {
    const next = !collapsed();
    setCollapsed(next);
    if (prefs().rememberCollapsed) {
      void queueTuiPreferenceUpdate(PLUGIN_KEY, ["collapsed"], next).then(() => {
        lastPersistedCollapsed = next;
      });
    }
  }
  return {
    prefs,
    collapsed,
    toggleCollapsed,
    dispose: stopWatchingPreferences
  };
}
function compactTokens(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}
function relativeTime(ms) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// The recomp/upgrade indicator uses █ for completed units and ░ for remaining units.
function progressBar(fraction, width = 14) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

const COLORS = {
  system: "#c084fc",
  // Purple
  docs: "#22d3ee",
  compartments: "#60a5fa",
  // Blue
  facts: "#fbbf24",
  // Yellow/orange
  memories: "#34d399",
  // Green
  profile: "#a3e635",
  // Use the same hue for regular chat and tool traffic to group user-facing content.
  conversation: "#f87171",
  // Red
  toolCalls: "#fb923c",
  // Orange
  toolDefs: "#f472b6" // Pink
};
const TokenBreakdown = props => {
  // flexGrow: tokens and flexBasis: 0 allocate the bar width proportionally.
  // The proportional allocation fills the parent width.
  // The bar fills the available width on narrow and wide sidebars.
  const segments = createMemo(() => {
    const s = props.snapshot;
    const total = s.inputTokens || 1;
    const result = [];

    if (s.systemPromptTokens > 0) {
      result.push({
        key: "sys",
        tokens: s.systemPromptTokens,
        color: COLORS.system,
        label: "System"
      });
    }

    // The injected <project-docs> block supplies architecture and structure documentation.
    if (s.docsTokens > 0) {
      result.push({
        key: "docs",
        tokens: s.docsTokens,
        color: COLORS.docs,
        label: "Docs"
      });
    }

    // Compartments (blue)
    if (s.compartmentTokens > 0) {
      result.push({
        key: "comp",
        tokens: s.compartmentTokens,
        color: COLORS.compartments,
        label: "Compartments"
      });
    }

    // Facts (yellow/orange)
    if (s.factTokens > 0) {
      result.push({
        key: "fact",
        tokens: s.factTokens,
        color: COLORS.facts,
        label: "Facts"
      });
    }

    // Memories (green)
    if (s.memoryTokens > 0) {
      result.push({
        key: "mem",
        tokens: s.memoryTokens,
        color: COLORS.memories,
        label: "Memories"
      });
    }

    // The lime User Profile segment represents the injected `<user-profile>` block of promoted user memories.
    if (s.profileTokens > 0) {
      result.push({
        key: "profile",
        tokens: s.profileTokens,
        color: COLORS.profile,
        label: "User Profile"
      });
    }

    // Conversation includes user and assistant text, reasoning, and images.
    // Conversation excludes injected session history and tool-call I/O.
    //
    // The legend shows Conversation when calibration rounds `conversationTokens` to 0.
    // tokenizer-calibration.ts can distribute residual tokens away from conversationTokens.
    // Residual distribution can round conversationTokens to 0 when toolCallsLocal dominates conversationLocal.
    // A zero conversationTokens value is a calibration artifact, not an empty conversation.
    // Retain Conversation when calibration rounds its token count to 0.
    // Exclude zero-token segments so `Math.max(1, ...)` cannot render them.
    result.push({
      key: "conv",
      tokens: s.conversationTokens,
      color: COLORS.conversation,
      label: "Conversation*"
    });

    // Tool Calls = tool_use/tool_result/tool/tool-invocation parts in messages
    if (s.toolCallTokens > 0) {
      result.push({
        key: "tool-calls",
        tokens: s.toolCallTokens,
        color: COLORS.toolCalls,
        label: "Tool Calls"
      });
    }

    if (s.toolDefinitionTokens > 0) {
      result.push({
        key: "tool-defs",
        tokens: s.toolDefinitionTokens,
        color: COLORS.toolDefs,
        label: "Tool Defs"
      });
    }
    return result;
  });
  const totalTokens = createMemo(() => props.snapshot.inputTokens || 1);

  // Filtering zero-token segments prevents them from receiving flex space or rendering a box.
  const barSegments = createMemo(() => segments().filter(seg => seg.tokens > 0));
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("box");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$2, "width", "100%");
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "height", 1);
    _$insert(_el$2, () => barSegments().map(seg => (() => {
      var _el$3 = _$createElement("box");
      _$setProp(_el$3, "flexBasis", 0);
      _$setProp(_el$3, "height", 1);
      _$effect(_p$ => {
        var _v$ = seg.key,
          _v$2 = Math.max(1, seg.tokens),
          _v$3 = seg.color;
        _v$ !== _p$.e && (_p$.e = _$setProp(_el$3, "key", _v$, _p$.e));
        _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "flexGrow", _v$2, _p$.t));
        _v$3 !== _p$.a && (_p$.a = _$setProp(_el$3, "backgroundColor", _v$3, _p$.a));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined
      });
      return _el$3;
    })()));
    _$insert(_el$, (() => {
      var _c$ = _$memo(() => !!!props.collapsed);
      return () => _c$() && (() => {
        var _el$4 = _$createElement("box"),
          _el$5 = _$createElement("text");
        _$insertNode(_el$4, _el$5);
        _$setProp(_el$4, "flexDirection", "column");
        _$setProp(_el$4, "marginTop", 0);
        _$insert(_el$4, () => segments().map(seg => {
          const pct = (seg.tokens / totalTokens() * 100).toFixed(0);
          return (() => {
            var _el$7 = _$createElement("box"),
              _el$8 = _$createElement("text"),
              _el$9 = _$createElement("text"),
              _el$0 = _$createTextNode(` (`),
              _el$1 = _$createTextNode(`%)`);
            _$insertNode(_el$7, _el$8);
            _$insertNode(_el$7, _el$9);
            _$setProp(_el$7, "width", "100%");
            _$setProp(_el$7, "flexDirection", "row");
            _$setProp(_el$7, "justifyContent", "space-between");
            _$insert(_el$8, () => seg.label);
            _$insertNode(_el$9, _el$0);
            _$insertNode(_el$9, _el$1);
            _$insert(_el$9, () => compactTokens(seg.tokens), _el$0);
            _$insert(_el$9, pct, _el$1);
            _$effect(_p$ => {
              var _v$4 = seg.key,
                _v$5 = seg.color,
                _v$6 = props.theme.textMuted;
              _v$4 !== _p$.e && (_p$.e = _$setProp(_el$7, "key", _v$4, _p$.e));
              _v$5 !== _p$.t && (_p$.t = _$setProp(_el$8, "fg", _v$5, _p$.t));
              _v$6 !== _p$.a && (_p$.a = _$setProp(_el$9, "fg", _v$6, _p$.a));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined
            });
            return _el$7;
          })();
        }), _el$5);
        _$insertNode(_el$5, _$createTextNode(`* includes Reasoning; hygiene excludes it`));
        _$effect(_$p => _$setProp(_el$5, "fg", props.theme.textMuted, _$p));
        return _el$4;
      })();
    })(), null);
    return _el$;
  })();
};
const StatRow = props => {
  const fg = createMemo(() => {
    if (props.warning) return props.theme.warning;
    if (props.accent) return props.theme.accent;
    if (props.dim) return props.theme.textMuted;
    return props.theme.text;
  });
  return (() => {
    var _el$10 = _$createElement("box"),
      _el$11 = _$createElement("text"),
      _el$12 = _$createElement("text"),
      _el$13 = _$createElement("b");
    _$insertNode(_el$10, _el$11);
    _$insertNode(_el$10, _el$12);
    _$setProp(_el$10, "width", "100%");
    _$setProp(_el$10, "flexDirection", "row");
    _$setProp(_el$10, "justifyContent", "space-between");
    _$insert(_el$11, () => props.label);
    _$insertNode(_el$12, _el$13);
    _$insert(_el$13, () => props.value);
    _$effect(_p$ => {
      var _v$7 = props.theme.textMuted,
        _v$8 = fg();
      _v$7 !== _p$.e && (_p$.e = _$setProp(_el$11, "fg", _v$7, _p$.e));
      _v$8 !== _p$.t && (_p$.t = _$setProp(_el$12, "fg", _v$8, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$10;
  })();
};
const SectionHeader = props => (() => {
  var _el$14 = _$createElement("box"),
    _el$15 = _$createElement("text"),
    _el$16 = _$createElement("b");
  _$insertNode(_el$14, _el$15);
  _$setProp(_el$14, "width", "100%");
  _$setProp(_el$14, "marginTop", 1);
  _$insertNode(_el$15, _el$16);
  _$insert(_el$16, () => props.title);
  _$effect(_$p => _$setProp(_el$15, "fg", props.theme.text, _$p));
  return _el$14;
})();

const RecompProgressSection = props => {
  const phase = () => props.progress.phase;
  const fraction = () => props.progress.totalMessages > 0 ? props.progress.processedMessages / props.progress.totalMessages : 0;
  const pct = () => Math.round(fraction() * 100);

  const verb = () => props.progress.kind === "upgrade" ? "Upgrade" : props.progress.kind === "embed" ? "Embed" : props.progress.kind === "wrapup" ? "Wrapup" : "Recomp";
  const activeText = () => props.progress.kind === "upgrade" ? "upgrading ⟳" : props.progress.kind === "embed" ? "embedding ⟳" : props.progress.kind === "wrapup" ? "wrapping ⟳" : "comparting ⟳";
  const label = createMemo(() => {
    switch (props.progress.phase) {
      case "recomp":
        return {
          text: activeText(),
          color: props.theme.warning
        };
      case "migration":
        return {
          text: "Migrating memories ⟳",
          color: props.theme.warning
        };
      case "done":
        return {
          text: `✓ ${verb()} complete`,
          color: props.theme.success ?? props.theme.accent
        };
      case "skipped":
        return {
          text: "stopped",
          color: props.theme.textMuted
        };
      case "failed":
        return {
          text: `✗ ${verb()} failed`,
          color: props.theme.error
        };
    }
  });
  return [(() => {
    var _el$17 = _$createElement("box"),
      _el$18 = _$createElement("text"),
      _el$19 = _$createElement("b"),
      _el$20 = _$createElement("text");
    _$insertNode(_el$17, _el$18);
    _$insertNode(_el$17, _el$20);
    _$setProp(_el$17, "width", "100%");
    _$setProp(_el$17, "marginTop", 1);
    _$setProp(_el$17, "flexDirection", "row");
    _$setProp(_el$17, "justifyContent", "space-between");
    _$insertNode(_el$18, _el$19);
    _$insert(_el$19, verb);
    _$insert(_el$20, () => label().text);
    _$effect(_p$ => {
      var _v$9 = props.theme.text,
        _v$0 = label().color;
      _v$9 !== _p$.e && (_p$.e = _$setProp(_el$18, "fg", _v$9, _p$.e));
      _v$0 !== _p$.t && (_p$.t = _$setProp(_el$20, "fg", _v$0, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$17;
  })(), _$memo(() => _$memo(() => !!(phase() === "recomp" && props.progress.totalMessages > 0))() && (() => {
    var _el$21 = _$createElement("box"),
      _el$22 = _$createElement("text"),
      _el$23 = _$createElement("text"),
      _el$24 = _$createTextNode(`%`);
    _$insertNode(_el$21, _el$22);
    _$insertNode(_el$21, _el$23);
    _$setProp(_el$21, "width", "100%");
    _$setProp(_el$21, "flexDirection", "row");
    _$setProp(_el$21, "justifyContent", "space-between");
    _$insert(_el$22, () => progressBar(fraction()));
    _$insertNode(_el$23, _el$24);
    _$insert(_el$23, pct, _el$24);
    _$effect(_p$ => {
      var _v$1 = props.theme.accent,
        _v$10 = props.theme.textMuted;
      _v$1 !== _p$.e && (_p$.e = _$setProp(_el$22, "fg", _v$1, _p$.e));
      _v$10 !== _p$.t && (_p$.t = _$setProp(_el$23, "fg", _v$10, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$21;
  })()), _$memo(() => _$memo(() => !!((phase() === "recomp" || phase() === "migration") && props.progress.note))() && (() => {
    var _el$25 = _$createElement("text");
    _$insert(_el$25, () => props.progress.note);
    _$effect(_$p => _$setProp(_el$25, "fg", props.theme.textMuted, _$p));
    return _el$25;
  })()), _$memo(() => _$memo(() => !!(phase() === "recomp" && props.progress.kind !== "embed"))() && _$createComponent(StatRow, {
    get theme() {
      return props.theme;
    },
    label: "Compartments",
    get value() {
      return `${props.progress.compartmentsCreated} (${props.progress.passCount} pass${props.progress.passCount === 1 ? "" : "es"})`;
    },
    dim: true
  })), _$memo(() => _$memo(() => !!(phase() === "recomp" && props.progress.kind === "embed"))() && _$createComponent(StatRow, {
    get theme() {
      return props.theme;
    },
    label: "Compartments",
    get value() {
      return `${props.progress.processedMessages}/${props.progress.totalMessages} embedded`;
    },
    dim: true
  })), _$memo(() => _$memo(() => !!((phase() === "failed" || phase() === "skipped") && props.progress.message))() && (() => {
    var _el$26 = _$createElement("text");
    _$insert(_el$26, () => props.progress.message);
    _$effect(_$p => _$setProp(_el$26, "fg", props.theme.textMuted, _$p));
    return _el$26;
  })())];
};
const SidebarContent = props => {
  const [snapshot, setSnapshot] = createSignal(null);
  const collapsed = props.controller.collapsed;
  const sections = () => props.controller.prefs().sections;
  const headerLabel = () => props.controller.prefs().header.label;
  let refreshTimer;
  let recompPollTimer;
  const RECOMP_POLL_MS = 1200;
  let recompActive = false;
  let recompSawPhase = false;
  let recompPollCount = 0;
  let recompConsecutiveAbsent = 0;
  let recompSessionId = null;
  let snapshotRequestSequence = 0;
  const RECOMP_PROBE_MAX = 12; // ~15s for the server's "Starting…" to land
  // FIRST absent-after-active.
  const RECOMP_ABSENT_GIVEUP = 40; // ~48s of continuous absence → stop
  const RECOMP_MAX_POLLS = 1500; // ~30min absolute safety cap

  const refresh = () => {
    const sid = props.sessionID();
    if (!sid) return;
    const sequence = ++snapshotRequestSequence;
    const directory = props.api.state.path.directory ?? "";
    void loadSidebarSnapshot(sid, directory).then(data => {
      if (props.sessionID() !== sid || sequence !== snapshotRequestSequence) return;
      setSnapshot(data);
      try {
        props.api.renderer.requestRender();
      } catch {
      }
      const phase = data?.recompProgress?.phase;
      if ((phase === "recomp" || phase === "migration") && !recompActive) {
        kickRecompPoll();
      } else if (recompActive && recompSessionId === sid) {
        scheduleRecompTick();
      }
    }).catch(() => {
      if (recompActive && recompSessionId === sid && props.sessionID() === sid) {
        scheduleRecompTick();
      }
    });
  };
  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refresh();
    }, REFRESH_DEBOUNCE_MS);
  };
  const stopRecompPoll = () => {
    recompActive = false;
    recompSessionId = null;
    snapshotRequestSequence += 1;
    if (recompPollTimer) clearTimeout(recompPollTimer);
    recompPollTimer = undefined;
  };
  const scheduleRecompTick = () => {
    if (!recompActive) return;
    if (recompPollTimer) clearTimeout(recompPollTimer);
    recompPollTimer = setTimeout(recompTick, RECOMP_POLL_MS);
  };
  function recompTick() {
    const sid = recompSessionId;
    if (!recompActive || !sid || props.sessionID() !== sid) {
      stopRecompPoll();
      return;
    }
    recompPollCount += 1;
    if (recompPollCount > RECOMP_MAX_POLLS) {
      stopRecompPoll();
      return;
    }
    const sequence = ++snapshotRequestSequence;
    const directory = props.api.state.path.directory ?? "";
    void loadSidebarSnapshot(sid, directory).then(data => {
      if (!recompActive || recompSessionId !== sid || props.sessionID() !== sid || sequence !== snapshotRequestSequence) return;
      const phase = data?.recompProgress?.phase;
      const prevProgress = snapshot()?.recompProgress;
      const merged = !phase && recompSawPhase && prevProgress ? {
        ...data,
        recompProgress: prevProgress
      } : data;
      setSnapshot(merged);
      try {
        props.api.renderer.requestRender();
      } catch {
      }
      if (phase === "recomp" || phase === "migration") {
        recompSawPhase = true;
        recompConsecutiveAbsent = 0;
        scheduleRecompTick();
      } else if (phase === "done" || phase === "failed" || phase === "skipped") {
        stopRecompPoll();
      } else {
        recompConsecutiveAbsent += 1;
        if (!recompSawPhase) {
          if (recompPollCount < RECOMP_PROBE_MAX) scheduleRecompTick();else {
            stopRecompPoll();
          }
        } else if (recompConsecutiveAbsent < RECOMP_ABSENT_GIVEUP) {
          scheduleRecompTick();
        } else {
          stopRecompPoll();
        }
      }
    }).catch(() => {
      if (recompActive && recompSessionId === sid && props.sessionID() === sid && sequence === snapshotRequestSequence) scheduleRecompTick();
    });
  }

  function kickRecompPoll() {
    const sid = props.sessionID();
    if (!sid) return;
    if (recompActive && recompSessionId === sid) return;
    stopRecompPoll();
    recompActive = true;
    recompSessionId = sid;
    recompSawPhase = false;
    recompPollCount = 0;
    recompConsecutiveAbsent = 0;
    recompTick();
  }
  activeRecompPollKick = kickRecompPoll;
  activeSidebarRefresh = refresh;
  onCleanup(() => {
    if (refreshTimer) clearTimeout(refreshTimer);
    stopRecompPoll();
    if (activeRecompPollKick === kickRecompPoll) activeRecompPollKick = null;
    if (activeSidebarRefresh === refresh) activeSidebarRefresh = null;
  });

  createEffect(on(props.sessionID, () => {
    stopRecompPoll();
    setSnapshot(null);
    refresh();
  }));

  createEffect(on(props.sessionID, sessionID => {
    const unsubs = [props.api.event.on("message.updated", event => {
      if (event.properties.info.sessionID !== sessionID) return;
      scheduleRefresh();
    }), props.api.event.on("session.updated", event => {
      if (event.properties.info.id !== sessionID) return;
      scheduleRefresh();
    }), props.api.event.on("message.removed", event => {
      if (event.properties.sessionID !== sessionID) return;
      scheduleRefresh();
    })];
    onCleanup(() => {
      for (const unsub of unsubs) unsub();
    });
  }, {
    defer: false
  }));
  const s = createMemo(() => snapshot());
  const compactionOff = () => s()?.compaction_enabled === false;
  const contextSummaryColor = createMemo(() => {
    if (compactionOff()) return props.theme.accent;
    const usage = s()?.usagePercentage ?? 0;
    if (usage >= 80) return props.theme.error;
    if (usage >= 65) return props.theme.warning;
    return props.theme.accent;
  });
  return (() => {
    var _el$27 = _$createElement("box"),
      _el$28 = _$createElement("box"),
      _el$29 = _$createElement("box"),
      _el$30 = _$createElement("text"),
      _el$31 = _$createElement("b"),
      _el$32 = _$createElement("text"),
      _el$33 = _$createTextNode(`v`);
    _$insertNode(_el$27, _el$28);
    _$setProp(_el$27, "width", "100%");
    _$setProp(_el$27, "flexDirection", "column");
    _$setProp(_el$27, "border", SINGLE_BORDER);
    _$setProp(_el$27, "paddingTop", 1);
    _$setProp(_el$27, "paddingBottom", 1);
    _$setProp(_el$27, "paddingLeft", 1);
    _$setProp(_el$27, "paddingRight", 1);
    _$insertNode(_el$28, _el$29);
    _$insertNode(_el$28, _el$32);
    _$setProp(_el$28, "flexDirection", "row");
    _$setProp(_el$28, "justifyContent", "space-between");
    _$setProp(_el$28, "alignItems", "center");
    _$setProp(_el$28, "onMouseDown", () => props.controller.toggleCollapsed());
    _$insertNode(_el$29, _el$30);
    _$setProp(_el$29, "paddingLeft", 1);
    _$setProp(_el$29, "paddingRight", 1);
    _$insertNode(_el$30, _el$31);
    _$insert(_el$31, () => collapsed() ? "▶ " : "▼ ", null);
    _$insert(_el$31, headerLabel, null);
    _$insertNode(_el$32, _el$33);
    _$insert(_el$32, () => packageJson.version, null);
    _$insert(_el$27, (() => {
      var _c$2 = _$memo(() => !!s()?.lastTransformError);
      return () => _c$2() && (() => {
        var _el$34 = _$createElement("box"),
          _el$35 = _$createElement("text"),
          _el$36 = _$createTextNode(`⚠ `);
        _$insertNode(_el$34, _el$35);
        _$setProp(_el$34, "marginTop", 1);
        _$setProp(_el$34, "width", "100%");
        _$insertNode(_el$35, _el$36);
        _$insert(_el$35, () => s().lastTransformError, null);
        _$effect(_$p => _$setProp(_el$35, "fg", props.theme.error, _$p));
        return _el$34;
      })();
    })(), null);
    _$insert(_el$27, (() => {
      var _c$3 = _$memo(() => !!s()?.dreamerProgress);
      return () => _c$3() && (() => {
        var _el$37 = _$createElement("box"),
          _el$38 = _$createElement("text"),
          _el$39 = _$createTextNode(`Dreamer `),
          _el$40 = _$createTextNode(`: `),
          _el$41 = _$createTextNode(`/`),
          _el$42 = _$createTextNode(` processed`);
        _$insertNode(_el$37, _el$38);
        _$setProp(_el$37, "marginTop", 1);
        _$setProp(_el$37, "width", "100%");
        _$insertNode(_el$38, _el$39);
        _$insertNode(_el$38, _el$40);
        _$insertNode(_el$38, _el$41);
        _$insertNode(_el$38, _el$42);
        _$insert(_el$38, () => s().dreamerProgress.task, _el$40);
        _$insert(_el$38, () => s().dreamerProgress.processed, _el$41);
        _$insert(_el$38, () => s().dreamerProgress.total, _el$42);
        _$effect(_$p => _$setProp(_el$38, "fg", props.theme.warning, _$p));
        return _el$37;
      })();
    })(), null);
    _$insert(_el$27, (() => {
      var _c$4 = _$memo(() => !!(s() && s().inputTokens > 0));
      return () => _c$4() && (() => {
        var _el$43 = _$createElement("box");
        _$setProp(_el$43, "flexDirection", "column");
        _$insert(_el$43, (() => {
          var _c$7 = _$memo(() => (s()?.contextLimit ?? 0) > 0);
          return () => _c$7() && (() => {
            var _el$44 = _$createElement("box"),
              _el$45 = _$createElement("text"),
              _el$46 = _$createTextNode(` / `);
            _$insertNode(_el$44, _el$45);
            _$setProp(_el$44, "width", "100%");
            _$setProp(_el$44, "flexDirection", "row");
            _$setProp(_el$44, "justifyContent", "space-between");
            _$insert(_el$44, (() => {
              var _c$0 = _$memo(() => !!compactionOff());
              return () => _c$0() ? (() => {
                var _el$47 = _$createElement("text"),
                  _el$48 = _$createElement("b");
                _$insertNode(_el$47, _el$48);
                _$insert(_el$48, () => nativeCompactionContextLabel(s()));
                _$effect(_$p => _$setProp(_el$47, "fg", contextSummaryColor(), _$p));
                return _el$47;
              })() : (() => {
                var _el$49 = _$createElement("text"),
                  _el$50 = _$createElement("b"),
                  _el$51 = _$createTextNode(`%`),
                  _el$52 = _$createTextNode(` / `),
                  _el$53 = _$createTextNode(`%`);
                _$insertNode(_el$49, _el$50);
                _$insertNode(_el$49, _el$52);
                _$insertNode(_el$49, _el$53);
                _$insertNode(_el$50, _el$51);
                _$insert(_el$50, () => s().usagePercentage.toFixed(1), _el$51);
                _$insert(_el$49, () => formatThresholdPercent(s().executeThreshold), _el$53);
                _$insert(_el$49, () => s().executeThresholdClamped ? "*" : "", null);
                _$effect(_$p => _$setProp(_el$49, "fg", contextSummaryColor(), _$p));
                return _el$49;
              })();
            })(), _el$45);
            _$insertNode(_el$45, _el$46);
            _$insert(_el$45, () => compactTokens(s().inputTokens), _el$46);
            _$insert(_el$45, () => compactTokens(s().contextLimit), null);
            _$effect(_$p => _$setProp(_el$45, "fg", contextSummaryColor(), _$p));
            return _el$44;
          })();
        })(), null);
        _$insert(_el$43, _$createComponent(TokenBreakdown, {
          get theme() {
            return props.theme;
          },
          get snapshot() {
            return s();
          },
          get collapsed() {
            return collapsed();
          }
        }), null);
        _$insert(_el$43, (() => {
          var _c$8 = _$memo(() => !!!collapsed());
          return () => _c$8() && (() => {
            var _el$54 = _$createElement("text");
            _$insertNode(_el$54, _$createTextNode(`Conversation includes reasoning estimates; hygiene excludes reasoning.`));
            _$effect(_$p => _$setProp(_el$54, "fg", props.theme.textMuted, _$p));
            return _el$54;
          })();
        })(), null);
        _$insert(_el$43, (() => {
          var _c$9 = _$memo(() => s().tailHygiene !== undefined);
          return () => _c$9() && _$createComponent(StatRow, {
            get theme() {
              return props.theme;
            },
            label: "Hygiene",
            get value() {
              return formatTailHygiene(s().tailHygiene);
            },
            get warning() {
              return !s().tailHygiene.evaluable;
            }
          });
        })(), null);
        _$effect(_$p => _$setProp(_el$43, "marginTop", collapsed() ? 0 : 1, _$p));
        return _el$43;
      })();
    })(), null);
    _$insert(_el$27, (() => {
      var _c$5 = _$memo(() => !!collapsed());
      return () => _c$5() && (() => {
        var _el$56 = _$createElement("box");
        _$setProp(_el$56, "width", "100%");
        _$setProp(_el$56, "flexDirection", "column");
        _$insert(_el$56, (() => {
          var _c$1 = _$memo(() => !!compactionOff());
          return () => _c$1() ? compactionOffSidebarRows(s()).map(row => _$createComponent(StatRow, {
            get theme() {
              return props.theme;
            },
            get label() {
              return row.label;
            },
            get value() {
              return row.value;
            },
            get accent() {
              return row.label === "Memories";
            },
            get dim() {
              return row.label !== "Memories";
            }
          })) : [(() => {
            var _el$57 = _$createElement("box"),
              _el$58 = _$createElement("text");
            _$insertNode(_el$57, _el$58);
            _$setProp(_el$57, "width", "100%");
            _$setProp(_el$57, "flexDirection", "row");
            _$setProp(_el$57, "justifyContent", "space-between");
            _$insertNode(_el$58, _$createTextNode(`Historian`));
            _$insert(_el$57, (() => {
              var _c$10 = _$memo(() => !!s()?.historianRunning);
              return () => _c$10() ? (() => {
                var _el$71 = _$createElement("text");
                _$insertNode(_el$71, _$createTextNode(`comparting ⟳`));
                _$effect(_$p => _$setProp(_el$71, "fg", props.theme.warning, _$p));
                return _el$71;
              })() : (() => {
                var _el$73 = _$createElement("text");
                _$insertNode(_el$73, _$createTextNode(`idle`));
                _$effect(_$p => _$setProp(_el$73, "fg", props.theme.textMuted, _$p));
                return _el$73;
              })();
            })(), null);
            _$effect(_$p => _$setProp(_el$58, "fg", props.theme.textMuted, _$p));
            return _el$57;
          })(), _$createComponent(Show, {
            get when() {
              return s()?.dreamerProgress;
            },
            children: progress => (() => {
              var _el$75 = _$createElement("box"),
                _el$76 = _$createElement("text"),
                _el$78 = _$createElement("text"),
                _el$79 = _$createTextNode(` `),
                _el$80 = _$createTextNode(`/`);
              _$insertNode(_el$75, _el$76);
              _$insertNode(_el$75, _el$78);
              _$setProp(_el$75, "width", "100%");
              _$setProp(_el$75, "flexDirection", "row");
              _$setProp(_el$75, "justifyContent", "space-between");
              _$insertNode(_el$76, _$createTextNode(`Dreamer`));
              _$insertNode(_el$78, _el$79);
              _$insertNode(_el$78, _el$80);
              _$insert(_el$78, () => progress().task, _el$79);
              _$insert(_el$78, () => progress().processed, _el$80);
              _$insert(_el$78, () => progress().total, null);
              _$effect(_p$ => {
                var _v$19 = props.theme.textMuted,
                  _v$20 = props.theme.warning;
                _v$19 !== _p$.e && (_p$.e = _$setProp(_el$76, "fg", _v$19, _p$.e));
                _v$20 !== _p$.t && (_p$.t = _$setProp(_el$78, "fg", _v$20, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$75;
            })()
          }), (() => {
            var _el$60 = _$createElement("box"),
              _el$61 = _$createElement("text"),
              _el$63 = _$createElement("text");
            _$insertNode(_el$60, _el$61);
            _$insertNode(_el$60, _el$63);
            _$setProp(_el$60, "width", "100%");
            _$setProp(_el$60, "flexDirection", "row");
            _$setProp(_el$60, "justifyContent", "space-between");
            _$insertNode(_el$61, _$createTextNode(`Memories`));
            _$insert(_el$63, (() => {
              var _c$11 = _$memo(() => (s()?.memoryBlockCount ?? 0) > 0);
              return () => _c$11() ? `${s().memoryBlockCount}/${s()?.memoryCount ?? 0}` : String(s()?.memoryCount ?? 0);
            })());
            _$effect(_p$ => {
              var _v$15 = props.theme.textMuted,
                _v$16 = props.theme.textMuted;
              _v$15 !== _p$.e && (_p$.e = _$setProp(_el$61, "fg", _v$15, _p$.e));
              _v$16 !== _p$.t && (_p$.t = _$setProp(_el$63, "fg", _v$16, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$60;
          })(), (() => {
            var _el$64 = _$createElement("box"),
              _el$65 = _$createElement("text"),
              _el$67 = _$createElement("text"),
              _el$68 = _$createTextNode(`C:`),
              _el$69 = _$createTextNode(` Q:`),
              _el$70 = _$createTextNode(` N:`);
            _$insertNode(_el$64, _el$65);
            _$insertNode(_el$64, _el$67);
            _$setProp(_el$64, "width", "100%");
            _$setProp(_el$64, "flexDirection", "row");
            _$setProp(_el$64, "justifyContent", "space-between");
            _$insertNode(_el$65, _$createTextNode(`Status`));
            _$insertNode(_el$67, _el$68);
            _$insertNode(_el$67, _el$69);
            _$insertNode(_el$67, _el$70);
            _$insert(_el$67, () => s()?.compartmentCount ?? 0, _el$69);
            _$insert(_el$67, () => s()?.pendingOpsCount ?? 0, _el$70);
            _$insert(_el$67, () => s()?.sessionNoteCount ?? 0, null);
            _$effect(_p$ => {
              var _v$17 = props.theme.textMuted,
                _v$18 = props.theme.textMuted;
              _v$17 !== _p$.e && (_p$.e = _$setProp(_el$65, "fg", _v$17, _p$.e));
              _v$18 !== _p$.t && (_p$.t = _$setProp(_el$67, "fg", _v$18, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$64;
          })(), _$createComponent(Show, {
            get when() {
              return s()?.recompProgress;
            },
            children: progress => _$createComponent(RecompProgressSection, {
              get theme() {
                return props.theme;
              },
              get progress() {
                return progress();
              }
            })
          })];
        })());
        return _el$56;
      })();
    })(), null);
    _$insert(_el$27, (() => {
      var _c$6 = _$memo(() => !!!collapsed());
      return () => _c$6() && [_$memo(() => _$memo(() => !!(!compactionOff() && sections().historian))() && [(() => {
        var _el$81 = _$createElement("box"),
          _el$82 = _$createElement("text"),
          _el$83 = _$createElement("b");
        _$insertNode(_el$81, _el$82);
        _$setProp(_el$81, "width", "100%");
        _$setProp(_el$81, "marginTop", 1);
        _$setProp(_el$81, "flexDirection", "row");
        _$setProp(_el$81, "justifyContent", "space-between");
        _$insertNode(_el$82, _el$83);
        _$insertNode(_el$83, _$createTextNode(`Historian`));
        _$insert(_el$81, (() => {
          var _c$12 = _$memo(() => !!s()?.historianRunning);
          return () => _c$12() ? (() => {
            var _el$85 = _$createElement("text");
            _$insertNode(_el$85, _$createTextNode(`comparting ⟳`));
            _$effect(_$p => _$setProp(_el$85, "fg", props.theme.warning, _$p));
            return _el$85;
          })() : (() => {
            var _el$87 = _$createElement("text");
            _$insertNode(_el$87, _$createTextNode(`idle`));
            _$effect(_$p => _$setProp(_el$87, "fg", props.theme.textMuted, _$p));
            return _el$87;
          })();
        })(), null);
        _$effect(_$p => _$setProp(_el$82, "fg", props.theme.text, _$p));
        return _el$81;
      })(), _$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        label: "Compartments",
        get value() {
          return String(s()?.compartmentCount ?? 0);
        }
      }), _$createComponent(Show, {
        get when() {
          return s()?.recompProgress;
        },
        children: progress => _$createComponent(RecompProgressSection, {
          get theme() {
            return props.theme;
          },
          get progress() {
            return progress();
          }
        })
      })]), _$memo(() => _$memo(() => !!sections().memory)() && [_$createComponent(SectionHeader, {
        get theme() {
          return props.theme;
        },
        title: "Memory"
      }), _$memo(() => _$memo(() => !!compactionOff())() ? compactionOffSidebarRows(s()).filter(row => row.label === "Memories").map(row => _$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        get label() {
          return row.label;
        },
        get value() {
          return row.value;
        },
        accent: true
      })) : [_$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        label: "Memories",
        get value() {
          return String(s()?.memoryCount ?? 0);
        },
        accent: true
      }), _$memo(() => _$memo(() => (s()?.memoryBlockCount ?? 0) > 0)() && _$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        label: "Injected",
        get value() {
          return String(s().memoryBlockCount);
        },
        dim: true
      }))])]), _$memo(() => _$memo(() => !!(sections().status && (compactionOff() || (s()?.pendingOpsCount ?? 0) > 0 || (s()?.sessionNoteCount ?? 0) > 0 || (s()?.readySmartNoteCount ?? 0) > 0)))() && [_$createComponent(SectionHeader, {
        get theme() {
          return props.theme;
        },
        title: "Status"
      }), _$memo(() => _$memo(() => !!compactionOff())() ? compactionOffSidebarRows(s()).filter(row => row.label !== "Memories").map(row => _$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        get label() {
          return row.label;
        },
        get value() {
          return row.value;
        },
        dim: true
      })) : [_$memo(() => _$memo(() => (s()?.pendingOpsCount ?? 0) > 0)() && _$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        label: "Queue",
        get value() {
          return `${s().pendingOpsCount} pending`;
        },
        warning: true
      })), _$memo(() => _$memo(() => (s()?.sessionNoteCount ?? 0) > 0)() && _$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        label: "Notes",
        get value() {
          return String(s().sessionNoteCount);
        }
      })), _$memo(() => _$memo(() => (s()?.readySmartNoteCount ?? 0) > 0)() && _$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        label: "Smart Notes",
        get value() {
          return `${s().readySmartNoteCount} ready`;
        },
        accent: true
      }))])]), _$memo(() => _$memo(() => !!(sections().dreamer && (s()?.lastDreamerRunAt || s()?.dreamerProgress)))() && [_$createComponent(SectionHeader, {
        get theme() {
          return props.theme;
        },
        title: "Dreamer"
      }), _$createComponent(Show, {
        get when() {
          return s()?.dreamerProgress;
        },
        children: progress => _$createComponent(StatRow, {
          get theme() {
            return props.theme;
          },
          label: "Current",
          get value() {
            return `${progress().task} ${progress().processed}/${progress().total}`;
          },
          warning: true
        })
      }), _$createComponent(Show, {
        get when() {
          return s()?.lastDreamerRunAt;
        },
        children: lastRunAt => _$createComponent(StatRow, {
          get theme() {
            return props.theme;
          },
          label: "Last run",
          get value() {
            return relativeTime(lastRunAt());
          },
          dim: true
        })
      }), _$createComponent(For, {
        get each() {
          return Object.entries(s()?.dreamerBacklog ?? {});
        },
        children: ([task, backlog]) => _$createComponent(StatRow, {
          get theme() {
            return props.theme;
          },
          label: task,
          get value() {
            return `${backlog.pending}/${backlog.total}`;
          },
          dim: true
        })
      })]), _$memo(() => _$memo(() => !!(sections().stats && s()?.totalInputTokens != null))() && [_$createComponent(SectionHeader, {
        get theme() {
          return props.theme;
        },
        title: "Stats"
      }), _$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        label: "Total tokens",
        get value() {
          return compactTokens(s().totalInputTokens ?? 0);
        },
        dim: true
      })])];
    })(), null);
    _$effect(_p$ => {
      var _v$11 = props.theme.borderActive,
        _v$12 = props.theme.accent,
        _v$13 = badgeTextColor(props.theme.accent, props.theme.background),
        _v$14 = props.theme.textMuted;
      _v$11 !== _p$.e && (_p$.e = _$setProp(_el$27, "borderColor", _v$11, _p$.e));
      _v$12 !== _p$.t && (_p$.t = _$setProp(_el$29, "backgroundColor", _v$12, _p$.t));
      _v$13 !== _p$.a && (_p$.a = _$setProp(_el$30, "fg", _v$13, _p$.a));
      _v$14 !== _p$.o && (_p$.o = _$setProp(_el$32, "fg", _v$14, _p$.o));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined
    });
    return _el$27;
  })();
};
export function createSidebarContentSlot(api) {
  const seedRoot = readTuiPreferencesFileSync();
  const controller = createSidebarController(resolveMagicContextPrefs(seedRoot));
  const effectiveOrder = computeEffectiveOrder(seedRoot, PLUGIN_KEY, DEFAULT_SLOT_ORDER);
  return {
    order: effectiveOrder,
    dispose: controller.dispose,
    slots: {
      sidebar_content: (ctx, value) => {
        const theme = createMemo(() => ctx.theme.current);
        return _$createComponent(SidebarContent, {
          api: api,
          sessionID: () => value.session_id,
          get theme() {
            return theme();
          },
          controller: controller
        });
      }
    }
  };
}