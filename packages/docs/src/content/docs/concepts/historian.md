---
title: Historian
description: How the background historian compresses your session history into tiered compartments that render at the right fidelity for the moment.
---

The historian is a background agent that condenses older conversation into **compartments** — chronological summaries that stand in for raw messages. Each compartment carries an importance score and four paraphrase tiers, so the system can render old history at high detail or low detail depending on how much room is left, with no extra LLM calls.

## When the historian fires

The historian runs when enough new conversation has accumulated since the last compartment. Three signals can trigger it:

- **Pressure.** Context usage is approaching the execute threshold and pending drops aren't enough to bring it back down. The trigger budget is around 5% of your context ceiling (clamped between 5k and 50k tokens).
- **Commit clusters.** Multiple distinct work phases with git commits and enough narratable content — a sign that a meaningful episode of work just finished.
- **Tail size.** Enough raw conversation has accumulated regardless of pressure, so the historian has material to produce a properly-sized compartment.

The historian always protects the most recent conversation (the "live tail") from being summarized. Only messages before the protected boundary are eligible.

## What a compartment is

A compartment is a condensed episode of session history. Each one stores:

- **Four paraphrase tiers** — from verbose (P1, full detail) down to anchor-only (P4, a single line). The historian writes all four in one pass.
- **An importance score** (1–100) — semantically a decay rate. Higher importance means the compartment stays at high fidelity longer.
- **An episode type** — what kind of work the compartment covers.
- **A facts block** — durable knowledge extracted during compression, promoted to [project memory](/concepts/memory/).

The original messages are **never deleted**. The historian reads them, produces compartments, and the raw transcript stays in the database. You can always recover the exact conversation with `ctx_expand`.

## How rendering picks fidelity

When Magic Context builds the prompt for each turn, it selects a render tier per compartment using a deterministic formula based on three inputs:

1. **Age** — how many compartments ago this one was created (newer = higher fidelity).
2. **Importance** — the historian-emitted score (higher = stays detailed longer).
3. **Budget pressure** — how tight the history budget is this turn (tighter = more aggressive demotion).

The formula uses an exponential half-life curve. At default settings, a compartment with importance 50 has a half-life of about 24 compartments. Higher importance doubles or quadruples that; lower importance halves it. Budget pressure scales the half-life inversely — when the window is tight, everything fades faster.

The result: old, low-importance history gracefully compresses to a single line or drops entirely, while critical decisions stay detailed. The same history always renders the same way given the same budget — no randomness, no extra LLM calls.

:::note
The renderer adapts automatically when you switch to a model with a different context window. A larger window means more budget, which means compartments stay at higher fidelity. No re-compression needed.
:::

## What the agent sees

The agent receives compartment history inside a `<session-history>` block injected into the conversation. Each compartment is an XML element with a message range, title, and the rendered tier body:

```xml
<session-history>
<compartment start="1" end="42" title="Initial project setup">
  Set up the project scaffold with TypeScript, configured ESLint and Prettier...
</compartment>
<compartment start="43" end="98" title="Authentication implementation">
  Implemented JWT auth with refresh tokens. Chose jose library over jsonwebtoken...
</compartment>
<compartment start="99" end="115" />
</session-history>
```

Older compartments render at lower tiers or self-close (empty). The agent sees a natural gradient from detailed recent history to compressed older history.

## What you see

In OpenCode's TUI, the sidebar shows compartment count and coverage. The `/ctx-status` command reports historian progress, compartment coverage, and history budget.

## Rebuilding and upgrading

Two commands let you rebuild compartment state:

- **`/ctx-recomp`** — rebuilds compartments from raw history. Accepts an optional `start-end` range for partial rebuilds. Use this when stored state seems wrong.
- **`/ctx-wrapup [messages_to_keep]`** — advances the historian over older live history now while keeping the newest N messages raw. This is useful before switching to a smaller-context model.
- **`/ctx-session-upgrade`** — upgrades a session to the latest history format: rebuilds compartments with the current tiered format. It upgrades session history only and does not migrate project memories.

See the [commands reference](/reference/commands/) for full syntax.

## How it connects

The historian is the engine that drives [memory capture](/concepts/memory/) — every compartment run extracts durable facts and promotes them to project memory. The [dreamer](/concepts/dreamer/) maintains memory quality overnight. And the whole pipeline is structured to [preserve prompt caching](/concepts/cache-architecture/).
