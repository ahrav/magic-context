---
title: Cache architecture
description: How Magic Context's message layout preserves prompt cache stability so background work never re-bills your cached prefix.
---

This page is for the curious and the cost-conscious. It explains why Magic Context's internal message layout looks the way it does, and how it avoids the prompt-cache thrashing that a naive implementation would cause.

## The problem

LLM providers cache the prefix of your prompt. If the first 100,000 tokens of your prompt are byte-identical to the last request, the provider reuses the cached computation and charges you less (Anthropic, for example, bills cached tokens at 10% of the normal rate).

The catch: if you change even one byte early in the prompt, everything after it re-bills at full price. A system that mutates the conversation history on every turn — dropping tool outputs, re-compressing summaries, injecting new memories — would invalidate the cache constantly and cost more than no context management at all.

## The solution: stable baseline + volatile delta

Magic Context renders the compacted history into **two synthetic message slots** instead of one. Internally these are called **m[0]** and **m[1]**:

**m[0] — the cumulative baseline.** This holds project docs, the baseline user profile, and the decay-rendered compartment history as of the last materialization. It is treated like a frozen prefix: it does **not** change on routine turns, so its prompt-cache bytes persist across requests.

**m[1] — the volatile delta.** This holds everything added since the last m[0] materialization: new user-profile additions, new memories (surfaced via a **watermark** — memories with IDs above the last materialized max), and the newest compartments rendered at full fidelity. When there's nothing new, m[1] renders a minimal placeholder.

The system prompt, m[0], and m[1] form a prefix that stays byte-identical across most turns. Only the conversation tail (the raw messages after the last compartment boundary) changes on every request. The component that assigns `§N§` tags to messages (internally called the **tagger**) runs on every pass but its output is replayed byte-identically, so it doesn't bust the cache either.

## The bust taxonomy

Not all cache invalidations are equal. Magic Context classifies them into three tiers:

**SOFT+ (no bust).** A defer pass with nothing new. Both m[0] and m[1] replay byte-identical. The entire `system + m[0] + m[1]` prefix stays cached. Only the conversation tail moves as `ctx_reduce` drops or age-based cleanup land.

**SOFT (m[1] bust).** An execute or cache-busting pass. m[1] re-renders with new compartments, memories, or user-profile additions. m[0] stays byte-identical. The `system + m[0]` prefix stays cached; the bust happens at m[1].

**HARD (m[0] bust).** A materialization event. m[0] re-materializes, folding m[1] into the new decayed baseline and resetting m[1] to the placeholder. Everything rebuilds — but this only fires when the provider cache was already dead (model change, idle timeout, system prompt change) or when m[0] content genuinely changed (a project memory epoch bump from an external repair, structural compartment operations).

## What triggers a HARD bust

m[0] re-materializes only for events where the cache was already invalidated or the baseline content genuinely changed:

- **Provider-side eviction:** model or provider change, system prompt hash change, idle timeout past the TTL.
- **Content change:** first render, project memory epoch change (external edits, such as a CLI doctor repair path), pending structural mutations (compartment delete/merge/recomp), project docs hash change.

Deliberately **not** triggers: new compartments (those ride the m[1] delta), new memories from in-session writes (those surface via the watermark in m[1]), and new user-profile additions (additive, also in m[1]). Triggering on any of these would bust m[0] on routine background work and defeat the design.

## The decay and fold cycle

The [historian](/concepts/historian/) publishes new compartments continuously. They render in m[1] at full fidelity (P1). On a HARD bust, m[1] folds into m[0] — and during that fold, the decay renderer re-tiers all compartments based on their current age, importance, and budget pressure. Older compartments demote to lower tiers; very old ones archive entirely.

Between HARD busts, the decay tiers are frozen. A SOFT pass never re-tiers — that would change m[0] bytes. This means the rendered history is stable until the next natural materialization.

A **pressure backstop** forces a fold when m[1] grows too large relative to m[0] — gated by the size ratio, an absolute token cap (around 20% of the history budget), or a large memory-mutation count. This prevents marathon sessions from accumulating an oversized delta.

## Memory mutations route through m[1]

When the agent writes a memory via `ctx_memory`, it does **not** trigger an m[0] rebuild. Additive writes surface in m[1] via the watermark. Non-additive mutations (update, delete, archive) record a mutation log entry that renders as a `<memory-updates>` delta in m[1]. Both reconcile into m[0] on the next natural HARD bust.

Only **external** memory edits — made outside the running session, such as the CLI `doctor drain-authority` repair path or `doctor merge-identity` — bump the project memory epoch, forcing an immediate m[0] re-materialize. An external editor can't otherwise signal a running session.

## Honest framing

Occasional full re-materializations are by design. They happen when:

- The model or provider changes (the cache was dead anyway).
- The session has been idle past the TTL (the cache expired).
- Memories change outside the session (an external change the session needs to pick up).
- The m[1] delta grows too large (the pressure backstop fires).

In a steady-state working session, m[0] stays stable for hours or days. The prompt cache survives the whole session, and you pay cached-token rates for the large prefix.

## How it connects

The cache architecture is the foundation that makes the rest of the [pipeline](/concepts/overview/) affordable. The [historian](/concepts/historian/) publishes compartments that ride the m[1] delta. [Memory](/concepts/memory/) writes surface through m[1] watermarks. [Context reduction](/concepts/context-reduction/) drops land on the conversation tail without touching m[0] or m[1]. And the [session mode](/concepts/session-modes/) determines which features participate in the cache-stable layout.
