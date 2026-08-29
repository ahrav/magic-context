---
title: Your first session
description: A guided tour of what you see and what happens during a long session with Magic Context active.
---

Once Magic Context is installed and your harness is restarted, the session starts differently. This page walks through what you see and what is happening in the background.

## The status display

<details>
<summary><strong>OpenCode TUI / Desktop</strong></summary>

A live sidebar updates after every message. It shows:

- Context usage as a percentage of the model's window
- Active tag count and pending drop queue
- Historian status (idle / running / last run time)
- Compartment count and coverage
- Project memory count

You can also run `/ctx-status` at any time for a detailed debug view.

</details>

<details>
<summary><strong>Pi</strong></summary>

A status line in the footer shows context usage and Magic Context state. Run `/ctx-status` for the full debug view.

</details>

## §N§ tags

Every message in your session is assigned a tag — a short identifier like `§1§`, `§42§` — that Magic Context uses to track and manage content. These tags appear on messages in the context.

Tags serve two purposes:

- **Reference points** for the agent when calling `ctx_reduce` to mark stale content for removal
- **Bookkeeping** for Magic Context's automatic cleanup, which tracks every piece of content by tag

You will see tag references in the `/ctx-status` output and in `ctx_reduce` nudges. They are internal tracking identifiers; you do not need to interact with them directly.

## What "comparting" looks like

"Comparting" is what happens when the historian compresses older parts of your session into compartments. Here is what a session looks like after a few hours of work:

```text
[you]        Build me a new auth middleware for the API
[agent]      I'll create a JWT middleware for Express. Let me look at the existing...
             <tool calls: read files, create files, run tests>
             Done — the middleware is in src/middleware/auth.ts. Tests pass.

[you]        Can you also add a refresh token endpoint?
[agent]      Looking at the current token structure...
             <tool calls: read, edit, test>
             Done. POST /auth/refresh at src/routes/auth.ts.

-- [Historian ran. Earlier messages compartmented] --

[you]        Looks good. Can we add rate limiting next?
[agent]      I'll add rate limiting. First let me check what we've built so far...
             <ctx_search: "auth middleware decisions">
             I see from earlier we used JWT with RS256 and 15-minute expiry...
```

After the historian runs, the older messages are replaced by a compact compartment in `<session-history>`. The session keeps flowing — you see the compartment summary, not the original detail. But if the agent needs the original, it calls `ctx_expand` to pull it back.

## What the agent sees vs what you see

When the historian creates a compartment, two things happen:

1. The raw messages are stored in the database (never deleted)
2. A compact summary replaces them in the active context window

**From your side:** the session continues. You may notice `/ctx-status` shows a new compartment and the token count drops.

**From the agent's side:** it sees the compartment summary instead of the raw messages. If it needs more detail, it can call `ctx_expand` with the compartment range to retrieve the original transcript.

**Nothing is lost.** Every message, tool call, and response is persisted. The compression is reversible.

## Memories being written

As the historian compresses your history, it extracts durable knowledge — decisions you made, constraints you set, architecture choices — and writes these as project memories. You will see them in `/ctx-status` under "project memories."

At the start of the next session, these memories are injected automatically into the agent's context. Your agent starts already knowing what was decided in previous sessions.

You can also have the agent view and manage memories directly with `ctx_memory`.

## The ctx_reduce nudge

When context is getting full and `ctx_reduce` is available to the agent, it receives a nudge prompting it to call `ctx_reduce` and mark stale tool outputs or long messages for removal. This happens before context pressure gets critical.

The agent calls `ctx_reduce` with specific tag identifiers. Drops are queued — not applied immediately — so they happen at a moment that doesn't invalidate the provider's prompt cache. The session keeps flowing without interruption.

If you prefer a specific agent to stay out of context management, deny or omit `ctx_reduce` in that agent's tool allow-list. Compartmenting and heuristic cleanup continue automatically.

## Setting expectations

- **Comparting happens in the background.** The session never pauses for it. You will notice the context window shrinking and compartment count rising between your messages.
- **First compartment takes a few turns.** The historian fires when context pressure builds or after a cluster of commits. Short sessions may not trigger it at all.
- **Memory appears next session.** Memories written by the historian during this session show up in `<project-memory>` the next time you start a session on the same project.
- **Deeper concepts** are covered in the [Historian](/concepts/historian/) and [Memory](/concepts/memory/) concept pages.
