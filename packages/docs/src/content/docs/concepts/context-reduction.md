---
title: Context reduction
description: How the agent-facing reduction surface works — tagging, ctx_reduce, nudges, and the automatic safety nets that kick in at high pressure.
---

Context reduction is how Magic Context keeps the live conversation window small enough to stay fast and cheap. The agent marks spent tool outputs and stale messages for removal, and the system applies those drops at cache-safe moments.

## §N§ tags

Every message, file attachment, and tool output in your session gets a `§N§` tag prefix — a small numbered marker like `§42§` that identifies a trackable unit of content. Tags are the atoms of context management: the system uses them to track what's active, what's been dropped, and what's pending removal.

You see these tags in the conversation text. The agent uses them to tell `ctx_reduce` what to drop.

## ctx_reduce

The `ctx_reduce` tool lets the agent queue content for removal:

```text
ctx_reduce(drop="3-5,8,12-15")
```

Drops are **queued, not immediate**. The system applies them at the next cache-safe moment — typically when the prompt cache is already being rebuilt for other reasons. This means reduction never thrashes the cache.

Tags in the most recent conversation (the "protected tail") are deferred rather than dropped immediately, so the agent doesn't lose its bearings mid-task.

When a tag is dropped, the content is replaced with a `[dropped §N§]` placeholder. Recent drops keep a `[truncated]` skeleton so the agent can still see the shape of what was there.

## The nudge system

Magic Context nudges the agent to reduce context as pressure builds. Two channels deliver reminders:

**Channel 1 — gentle in-turn reminders.** A `<system-reminder>` is appended to tool outputs when reclaimable tool output accumulates. The severity scales with both the amount of unreduced output and how close context is to the execute threshold. Three levels escalate: gentle, firm, and urgent. A disciplined agent that reduces regularly never hears them.

**Channel 2 — ceiling nudge.** When reclaimable tool output reaches a third of the agent's usable working range, a stronger one-time synthetic message is delivered at the next step boundary. This is the "you really should reduce now" signal. It fires at most once per session.

Both channels suppress themselves after the agent calls `ctx_reduce` — no nagging an agent that's actively managing context.

## What happens without agent action

If the agent doesn't reduce and pressure keeps building, automatic safety nets kick in:

**Execute threshold.** At the configured execute threshold (default: 65% of context, configurable up to 90%), the system runs heuristic cleanup: deduplicating identical tool calls, stripping system injections, and clearing old reasoning. It also applies any `ctx_reduce` drops the agent already queued. Values above the 90% cap are rejected or clamped according to the threshold form. Crucially, the execute threshold does **not** drop tool outputs on its own — see [Why your token count can stay high after the threshold](#why-your-token-count-can-stay-high-after-the-threshold) below.

**85% — tiered emergency drop.** At 85% usage, a target-headroom eviction kicks in. Tool outputs are dropped oldest-first across three tiers: miscellaneous tools first (bash, web), then edit/search tools, then navigation tools last. The newest 20% of navigation and edit tools are reserved as continuation context. This is a cache-busting pass — the prompt cache rebuilds, but the system was heading there anyway.

**95% — block and recover.** At 95%, the session blocks new messages and runs emergency recovery. This is the last-resort safety net. In practice, the historian and emergency drop prevent sessions from reaching this point.

:::note
These thresholds are safety nets, not the normal path. A well-behaved session with an agent that uses `ctx_reduce` stays well below the execute threshold and never triggers emergency drops.
:::

## Why your token count can stay high after the threshold

A common surprise: you cross the execute threshold, you see the historian run, but the token count barely moves. This is usually working as intended — the two are different jobs.

**The execute threshold is not a "compact now to a lower number" button.** What reduces tokens is split across three independent mechanisms, each targeting a different part of the window:

| Source of bulk | What reclaims it | When |
|---|---|---|
| **Older conversation** (above the protected tail) | **Historian** — compresses it into compartments | At the execute threshold and as narratable history accumulates |
| **Tool outputs** (file reads, search results, command output) | **`ctx_reduce`** (agent marks spent outputs) — or the **85% emergency drop** | Continuously, as the agent works — or only at 85% |
| **Recent conversation + tool calls** (the protected tail) | Nothing — it is deliberately protected | Stays until it ages out of the protected window |

The key consequence: **tool outputs have no automatic reduction in the 65%–85% band.** Magic Context does not drop them by age. They are reclaimed either when the agent calls `ctx_reduce` to mark spent ones, or — as a safety net — by the tiered emergency drop at 85%.

So if your session's bulk is **tool calls** (common for heavy file-reading or build-running work), and your model isn't actively calling `ctx_reduce`, the historian will compress the older conversation but the tool outputs sit there until 85%. The percentage parks in the 65–85% range and looks "stuck."

**What to do about it:**

- **Let the agent reduce.** `ctx_reduce` is the primary lever for tool output. Capable models call it in response to the built-in nudges. `/ctx-status` shows how much reclaimable tool output is sitting unreduced.
- **Lower the emergency line is not configurable, but you can lower the execute threshold** so the historian compresses conversation earlier. Note this only helps the *conversation* portion, not tool outputs.
- **Check the breakdown.** In the TUI sidebar or `/ctx-status`, look at the token breakdown. If **Tool Calls** dominates, the fix is `ctx_reduce` usage (or waiting for 85%), not the threshold. If **Conversation** dominates and the historian is idle, the eligible history above the protected tail is already compressed — what remains is the protected recent window.

This division is intentional: the historian works safely in the background on settled history, while tool-output reduction stays under the agent's control (or the 85% net) so an in-progress task never loses the outputs it's still using.

## Smart drops (opt-in)

`smart_drops` is an opt-in content-aware reclaim that layers on top of the age-based auto-drop. When on, it drops provably-superseded tool output during a pass that is already rewriting the message array: superseded `todowrite` snapshots (keep newest 1), spent `ctx_reduce` outputs (keep newest 3), and zero-value meta outputs (`bash_status`, `bash_kill`, `ctx_note` read/dismiss) are dropped; older edits to the same file are compressed to a filePath-preserving marker while the newest edit per file stays full. It only acts on passes already busting the cache, so it never originates a cache bust on its own, and it honors the protected-tag reserve.

When `smart_drops` is off (the default), the messages sent to the model are byte-identical to the age-based-only behavior — the feature is entirely inert. It is opt-in and default off until cache stability is proven at scale; enable it in `magic-context.jsonc` and restart for the setting to take effect. See the [configuration reference](/reference/configuration/) for the full description.

## Hiding the reduce surface

To remove the agent-facing reduction machinery for a particular agent, deny or omit `ctx_reduce` in that agent's tool allow-list. Magic Context freezes that availability verdict per session and then omits:

- `§N§` tag prefixes in message text
- Channel 1 and Channel 2 reduce nudges
- Prompt guidance that tells the agent to call `ctx_reduce`

The deterministic parts keep running: the historian still compresses older conversation into compartments, heuristic cleanup still fires (dedup, system-injection stripping, reasoning clearing), the 85% emergency drop still sheds tool outputs, compartments still inject, and memory still works.

Without agent-driven `ctx_reduce`, **tool outputs are only reclaimed by the 85% emergency drop** (Magic Context does not drop tool output by age). Sessions whose bulk is tool output will run closer to the 85% line than sessions where the agent actively reduces. You can optionally enable caveman text compression for long user and assistant prose; it is independent of `ctx_reduce` availability. See the [configuration reference](/reference/configuration/) for the setting.

See [session modes](/concepts/session-modes/) for the full feature comparison across modes.

## How it connects

Context reduction is the agent's side of the [context pipeline](/concepts/overview/). The [historian](/concepts/historian/) handles the background side — compressing what reduction leaves behind. The [cache architecture](/concepts/cache-architecture/) ensures that drops and compartment renders don't thrash the prompt cache.
