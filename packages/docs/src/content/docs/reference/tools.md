---
title: Tools
description: What Magic Context tools your agent calls mean in transcripts and how to read their output.
---

Magic Context registers tools for your agent, not for you. You will see `ctx_reduce`, `ctx_search`, and others in transcripts when the model trims context or looks something up. This page explains each tool, when the agent tends to use it, and how to read typical results.

For reduction behavior see [Context reduction](/concepts/context-reduction/). For durable facts vs session notes see [Memory](/concepts/memory/). Tool registration follows the active mode: `compaction.enabled: false` removes only `ctx_reduce`; `ctx_expand`, `ctx_note`, `ctx_search`, and `ctx_memory` keep their normal gates. With `memory.enabled: false`, `ctx_memory` is omitted while `ctx_search` still covers conversation and enabled git-commit sources. Pi's `todowrite` registration is controlled separately by `todowrite.enabled`.

## ctx_reduce

**What it does.** Drops tagged conversation content you no longer need. Parts of the transcript carry `§N§` tags (for example `§12§`). The agent lists tag IDs in `drop`; removed content is gone from the model view.

**When the agent reaches for it.** After large tool outputs or old results are processed and no longer needed for the current step.

| Param | Meaning |
| --- | --- |
| `drop` | Tag IDs to drop; ranges like `"3-5"`, `"1,2,9"`. |

```text
Agent: ctx_reduce({ "drop": "4-6" })
Tool: Dropped tags: 4, 5, 6. Changes take effect on next message.
```

:::note
`ctx_reduce` is part of the normal primary-session tool surface. It is not registered when `compaction.enabled` is `false`, and an agent's tool allow-list can deny it in either harness. When it is unavailable, Magic Context also hides `§N§` prefixes and reduce nudges for that session.
:::

## ctx_expand

**What it does.** Recovers raw transcript for message ordinals when history is compacted into `<compartment>` blocks in `<session-history>`. Use compartment `start`/`end` or a window around a `ctx_search` hit.

**When the agent reaches for it.** When a summary lacks exact wording, errors, values, or reasoning.

| Param | Meaning |
| --- | --- |
| `start` | First message ordinal (inclusive). |
| `end` | Last message ordinal (inclusive). |
| `verbose` | With `start`/`end`: list each message separately with its ordinal `[N]` and a per-part preview (each tool call shown with its output size). |
| `message` | Full untruncated recovery of one message by its ordinal — every text part and every tool call's complete input/output. |

Output is capped near 15K tokens. Ordinals after the last compartment are the live tail (already visible, not expandable). `ctx_expand` remains available in compaction-off mode.

```text
Agent: ctx_expand({ "start": 120, "end": 245 })
Tool: [120] U: Can we rename the handler?
[121] A: Updating command-handler.ts...
```

**Two recovery modes for finer detail.** The default range view returns a condensed digest. To drill in:

- `ctx_expand({ "start": 120, "end": 245, "verbose": true })` — each message listed separately with its ordinal `[N]`, so you can find the exact message or tool call you want.
- `ctx_expand({ "message": 138 })` — the full, untruncated content of the message at that ordinal. This is the cheap way to get back a tool output you dropped with `ctx_reduce`: the original is still in stored history even though the wire shows `[dropped §N§]`. If the message was deleted (session prune/revert), it says so.

## ctx_note

**What it does.** Session working notes: reminders and follow-ups for later in this session. Not [project memory](/concepts/memory/).

**When the agent reaches for it.** “Revisit later” items that are not durable memories and not active todos.

| Param | Meaning |
| --- | --- |
| `action` | `write`, `read`, `update`, `dismiss`. |
| `content` | Text for `write` / `update`. |
| `surface_condition` | Creates a **smart note** (hidden until an external condition is true). |
| `note_id` | Target for `update` / `dismiss`. |
| `filter` | For `read`: `all`, `active`, `pending`, `ready`, `dismissed`. |
| `limit` / `offset` | Page `read` results (newest first). |

**Smart notes** need Dreamer to be runnable (not `dreamer.disable: true`) and are evaluated only when the `evaluate-smart-notes` task is scheduled. Conditions must be externally checkable (GitHub, files, git, web) — not “when the user says X”.

**`@msg` anchor.** Notes tied to a message show `↳ @msg 512` on `read` so the agent can `ctx_expand` to that point.

```text
Agent: ctx_note({ "action": "write", "content": "Re-run benchmark after release",
  "surface_condition": "When the latest release tag is >= v0.23.0" })
Tool: Smart note #7 saved (pending).
```

## ctx_memory

**What it does.** Durable **project** knowledge across sessions. Active memories appear in `<project-memory>` with ids.

**When the agent reaches for it.** Rules, architecture facts, constraints, config values, naming — one fact per memory.

| Param | Meaning |
| --- | --- |
| `action` | `write`, `update`, `archive`, `merge`, `get` (primary); `list` is dreamer-only. |
| `content` | Text for `write`, `update`, `merge`. |
| `category` | Category for `write`. |
| `ids` | One id for `update`; one or more for `archive`; two or more for `merge`; 1–20 for `get`. |
| `reason` | Optional archive reason. |

| Action | Primary agent | Dreamer |
| --- | --- | --- |
| `write` | Yes | Yes |
| `update` | Yes | Yes |
| `archive` | Yes | Yes |
| `merge` | Yes | Yes |
| `get` | Yes | Yes |
| `list` | No | Yes |

`get` reads memories by id (own project, any status, plus shared categories of workspace neighbors). Not-visible or missing ids are reported per-id without distinguishing "foreign hidden" from "doesn't exist".

```text
Agent: ctx_memory({ "action": "write", "category": "CONSTRAINTS",
  "content": "Pi sessions are JSONL under ~/.pi/agent/sessions/" })
Tool: Memory #42 written (CONSTRAINTS).
```

Edit memories with `ctx_memory` or the CLI doctor; running sessions pick up changes automatically.

## ctx_search

**What it does.** Search project recall: memories, raw messages behind compacted history, indexed git commits, parked notes, and promoted primers. Skips content already visible in `<project-memory>` and the live tail.

**When the agent reaches for it.** Familiar problems, past decisions, regressions, or “where is X implemented?”. A whole-query id list (`#7234`, `12, 34`) bypasses text search and resolves those memories directly.

| Param | Meaning |
| --- | --- |
| `query` | Search string — or a list of memory ids (`#12`, `12, 34`). |
| `limit` | Max hits (default 10). |
| `sources` | `memory`, `message`, `git_commit`, `note`, `primer` — omit for all. |

| Question | Typical sources |
| --- | --- |
| When did this change? | `git_commit`, `message` |
| Did we discuss this? | `message` |
| Project rule for X? | `memory` |
| Did we leave a follow-up / parked decision? | `note` |
| Standing explanation for a recurring question? | `primer` |

```text
Agent: ctx_search({ "query": "chunk size", "sources": ["message"] })
Tool: ordinal 884: ... historianChunkTokens 12000 ...
```

Note hits carry a `@msg N` anchor when they are tied to a specific message; the agent can `ctx_expand(start=N-10, end=N)` to read the surrounding conversation. Anchors only render for the current session, so a stale anchor can't point at the wrong conversation.

:::tip
Historian **facts** in `<session-history>` are not a search source — they are already in context.
:::
