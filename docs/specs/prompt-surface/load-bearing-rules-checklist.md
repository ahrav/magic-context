# Load-bearing rules checklist

Artifact: `prompt-surface-load-bearing-checklist` · revision `s2-r1` · status **PENDING-RATIFICATION**

Mapping status: **PRE-LIGHT-AUTHORING**. This is the pre-light extraction required before S3 authorship. `compressed` rows are intentionally awaiting exact light-line targets; `shared` rows name byte-identity fragments; `not-present` rows are derived source absences.

## Authority and composition variants

- `.cortexkit/alfonso/prompts/prompt-surface-final.md`
- `.cortexkit/alfonso/prompts/prompt-surface-raw-r3.md`
- `packages/plugin/src/agents/magic-context-prompt.ts`
- `packages/plugin/src/agents/language-directive.ts`
- `packages/plugin/src/tools/*/constants.ts`
- `packages/plugin/src/tools/*/tools.ts`

| Variant | Kind | Feature flags |
| --- | --- | --- |
| `primary-full-reduce-memory-on` | guidance | {"reduce":true,"memory":true,"dreamer":true,"temporal":true,"caveman":false,"language":false,"subagent":false} |
| `primary-full-reduce-memory-off` | guidance | {"reduce":true,"memory":false,"dreamer":true,"temporal":true,"caveman":false,"language":false,"subagent":false} |
| `primary-full-no-reduce-memory-on` | guidance | {"reduce":false,"memory":true,"dreamer":true,"temporal":true,"caveman":false,"language":false,"subagent":false} |
| `primary-full-no-reduce-memory-off` | guidance | {"reduce":false,"memory":false,"dreamer":true,"temporal":true,"caveman":false,"language":false,"subagent":false} |
| `primary-full-reduce-dreamer-off` | guidance | {"reduce":true,"memory":true,"dreamer":false,"temporal":true,"caveman":false,"language":false,"subagent":false} |
| `primary-full-reduce-temporal-off` | guidance | {"reduce":true,"memory":true,"dreamer":true,"temporal":false,"caveman":false,"language":false,"subagent":false} |
| `primary-full-reduce-caveman-on` | guidance | {"reduce":true,"memory":true,"dreamer":true,"temporal":true,"caveman":true,"language":false,"subagent":false} |
| `primary-full-reduce-language-on` | guidance | {"reduce":true,"memory":true,"dreamer":true,"temporal":true,"caveman":false,"language":true,"subagent":false} |
| `subagent-reduce` | guidance | {"reduce":true,"memory":false,"dreamer":false,"temporal":false,"caveman":false,"language":false,"subagent":true} |
| `tool-all-active` | tools | {"ctx_reduce":true,"ctx_expand":true,"ctx_note":true,"ctx_memory":true,"ctx_search":true} |
| `tool-memory-disabled` | tools | {"ctx_reduce":true,"ctx_expand":true,"ctx_note":true,"ctx_memory":false,"ctx_search":true} |

Applicability is calculated from the fragment's `composedIn`/`statusByVariant` map in `checklist.json`. The checker rejects a status that disagrees with that composition map.

## Stable rules

### G-001 — Tagged conversation contract

- **Source fragment:** `guidance-reduce-intro`
- **Scope:** primary sessions with ctx_reduce
- **Polarity:** contract
- **Operative condition:** A primary session can see tagged messages or tool outputs.
- **Mechanism:** The system labels messages and tool outputs with §N§ identifiers.
- **Consequence:** Tag references are the only valid handles for reduction.
- **Source evidence:** `Messages and tool outputs are tagged with §N§ identifiers`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **compressed** |
| `primary-full-reduce-memory-off` | **compressed** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **compressed** |
| `primary-full-reduce-temporal-off` | **compressed** |
| `primary-full-reduce-caveman-on` | **compressed** |
| `primary-full-reduce-language-on` | **compressed** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-002 — Reduction is queued reclamation

- **Source fragment:** `guidance-reduce-intro`
- **Scope:** primary sessions with ctx_reduce
- **Polarity:** contract
- **Operative condition:** Tagged content is spent and its useful information has been extracted.
- **Mechanism:** ctx_reduce marks content discardable and queues it for release instead of deleting it immediately.
- **Consequence:** The agent can reclaim space without treating the action as immediate erasure.
- **Source evidence:** `mark spent tagged content as discardable and reclaim space`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **compressed** |
| `primary-full-reduce-memory-off` | **compressed** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **compressed** |
| `primary-full-reduce-temporal-off` | **compressed** |
| `primary-full-reduce-caveman-on` | **compressed** |
| `primary-full-reduce-language-on` | **compressed** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-003 — Protected recent tail

- **Source fragment:** `guidance-reduce-intro`
- **Scope:** primary sessions with ctx_reduce
- **Polarity:** mechanism
- **Operative condition:** A requested tag is within the newest protected window.
- **Mechanism:** The last protectedTags tags remain protected; marking only queues them until they age out.
- **Consequence:** A recent mark is harmless and cannot immediately release the protected tail.
- **Source evidence:** `The last ${protectedTags} tags are protected`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **compressed** |
| `primary-full-reduce-memory-off` | **compressed** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **compressed** |
| `primary-full-reduce-temporal-off` | **compressed** |
| `primary-full-reduce-caveman-on` | **compressed** |
| `primary-full-reduce-language-on` | **compressed** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-004 — Reduction range grammar

- **Source fragment:** `guidance-reduce-intro`
- **Scope:** primary sessions with ctx_reduce
- **Polarity:** contract
- **Operative condition:** The agent calls ctx_reduce.
- **Mechanism:** The drop argument uses comma-separated IDs and inclusive ranges such as 3-5, 1,2,9, or 1-5,8,12-15.
- **Consequence:** Other range spellings are not part of the documented contract.
- **Source evidence:** `Syntax: "3-5", "1,2,9", or "1-5,8,12-15"`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **compressed** |
| `primary-full-reduce-memory-off` | **compressed** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **compressed** |
| `primary-full-reduce-temporal-off` | **compressed** |
| `primary-full-reduce-caveman-on` | **compressed** |
| `primary-full-reduce-language-on` | **compressed** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-005 — Drops are silent

- **Source fragment:** `guidance-reduce-intro`
- **Scope:** primary sessions with ctx_reduce
- **Polarity:** prohibition
- **Operative condition:** The agent decides to queue a reduction.
- **Mechanism:** Call ctx_reduce without narrating the drop in assistant prose.
- **Consequence:** The conversation contains no redundant drop announcement.
- **Source evidence:** `Do not announce or narrate`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **compressed** |
| `primary-full-reduce-memory-off` | **compressed** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **compressed** |
| `primary-full-reduce-temporal-off` | **compressed** |
| `primary-full-reduce-caveman-on` | **compressed** |
| `primary-full-reduce-language-on` | **compressed** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-006 — Review before broad drops

- **Source fragment:** `guidance-reduce-intro`
- **Scope:** all sessions with reduction guidance
- **Polarity:** prohibition
- **Operative condition:** A large range could be dropped.
- **Mechanism:** Inspect each tag before selecting a range; never blanket-mark a large range.
- **Consequence:** Unreviewed evidence is not discarded accidentally.
- **Source evidence:** `NEVER drop large ranges blindly`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **compressed** |
| `primary-full-reduce-memory-off` | **compressed** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **compressed** |
| `primary-full-reduce-temporal-off` | **compressed** |
| `primary-full-reduce-caveman-on` | **compressed** |
| `primary-full-reduce-language-on` | **compressed** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-007 — Drop only extracted material

- **Source fragment:** `guidance-reduce-intro`
- **Scope:** primary sessions with ctx_reduce
- **Polarity:** contract
- **Operative condition:** A tag is being considered for discard.
- **Mechanism:** Keep unresolved errors, unextracted raw evidence, and wording whose exact form may matter; drop only genuinely finished outputs.
- **Consequence:** Reduction preserves information that still affects the task.
- **Source evidence:** `only large tool outputs are worth dropping`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **compressed** |
| `primary-full-reduce-memory-off` | **compressed** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **compressed** |
| `primary-full-reduce-temporal-off` | **compressed** |
| `primary-full-reduce-caveman-on` | **compressed** |
| `primary-full-reduce-language-on` | **compressed** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-008 — Preserve user intent

- **Source fragment:** `guidance-reduce-intro`
- **Scope:** primary sessions with ctx_reduce
- **Polarity:** prohibition
- **Operative condition:** An old user message contains instructions or intent.
- **Mechanism:** Never drop a user message for its directive; only an extracted large pasted block may be marked.
- **Consequence:** Historical user requirements remain authoritative.
- **Source evidence:** `Keep your user's instructions and intent`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **compressed** |
| `primary-full-reduce-memory-off` | **compressed** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **compressed** |
| `primary-full-reduce-temporal-off` | **compressed** |
| `primary-full-reduce-caveman-on` | **compressed** |
| `primary-full-reduce-language-on` | **compressed** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-009 — Retain assistant conversation text

- **Source fragment:** `guidance-reduce-intro`
- **Scope:** primary sessions with ctx_reduce
- **Polarity:** contract
- **Operative condition:** Assistant prose is present in context.
- **Mechanism:** Keep assistant text unless it is exceptionally large; prioritize large tool outputs for reduction.
- **Consequence:** Conversation reasoning remains available while tool bloat is reclaimed.
- **Source evidence:** `NEVER drop assistant text messages unless they are exceptionally large`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **compressed** |
| `primary-full-reduce-memory-off` | **compressed** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **compressed** |
| `primary-full-reduce-temporal-off` | **compressed** |
| `primary-full-reduce-caveman-on` | **compressed** |
| `primary-full-reduce-language-on` | **compressed** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-010 — Routine reduction timing

- **Source fragment:** `guidance-generic-reduction`
- **Scope:** primary sessions with ctx_reduce
- **Polarity:** mechanism
- **Operative condition:** The agent has finished using a large output, logical step, or context area.
- **Mechanism:** Consider ctx_reduce after acted-on reads, completed logical steps, before major context switches, and before the turn ends.
- **Consequence:** The working set stays lean without changing task scope.
- **Source evidence:** `After completing a logical step — drop intermediate outputs from that step.`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **compressed** |
| `primary-full-reduce-memory-off` | **compressed** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **compressed** |
| `primary-full-reduce-temporal-off` | **compressed** |
| `primary-full-reduce-caveman-on` | **compressed** |
| `primary-full-reduce-language-on` | **compressed** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-011 — Long-term continuity

- **Source fragment:** `guidance-long-term-frame`
- **Scope:** primary sessions
- **Polarity:** contract
- **Operative condition:** The session continues after one task or across compaction.
- **Mechanism:** Treat the session as a durable project relationship with retrievable history and persistent knowledge.
- **Consequence:** Finishing one task does not terminate the working relationship.
- **Source evidence:** `This session is a durable working relationship`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **shared** |
| `primary-full-reduce-memory-off` | **shared** |
| `primary-full-no-reduce-memory-on` | **shared** |
| `primary-full-no-reduce-memory-off` | **shared** |
| `primary-full-reduce-dreamer-off` | **shared** |
| `primary-full-reduce-temporal-off` | **shared** |
| `primary-full-reduce-caveman-on` | **shared** |
| `primary-full-reduce-language-on` | **shared** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-012 — No context-scarcity behavior

- **Source fragment:** `guidance-long-term-frame`
- **Scope:** primary sessions
- **Polarity:** prohibition
- **Operative condition:** Context usage is high or history is compacted.
- **Mechanism:** Continue at full depth instead of wrapping up, cutting scope, rushing, or deferring because of context size.
- **Consequence:** Context management cannot silently reduce task thoroughness.
- **Source evidence:** `never a reason to wrap up, cut scope, rush, or defer work`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **shared** |
| `primary-full-reduce-memory-off` | **shared** |
| `primary-full-no-reduce-memory-on` | **shared** |
| `primary-full-no-reduce-memory-off` | **shared** |
| `primary-full-reduce-dreamer-off` | **shared** |
| `primary-full-reduce-temporal-off` | **shared** |
| `primary-full-reduce-caveman-on` | **shared** |
| `primary-full-reduce-language-on` | **shared** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-013 — Search and expansion recovery

- **Source fragment:** `guidance-reduce-intro`
- **Scope:** primary sessions
- **Polarity:** contract
- **Operative condition:** A summary lacks exact wording, values, errors, or decision reasoning.
- **Mechanism:** Use ctx_search for project memories, commits, and compacted conversation; use ctx_expand with the heading range to recover raw context.
- **Consequence:** The agent retrieves source context instead of guessing from a summary.
- **Source evidence:** `recover the raw conversation behind a summary`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **compressed** |
| `primary-full-reduce-memory-off` | **compressed** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **compressed** |
| `primary-full-reduce-temporal-off` | **compressed** |
| `primary-full-reduce-caveman-on` | **compressed** |
| `primary-full-reduce-language-on` | **compressed** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-014 — Search before asking

- **Source fragment:** `guidance-reduce-intro`
- **Scope:** primary sessions
- **Polarity:** contract
- **Operative condition:** The agent cannot remember something that may be in project memory or prior discussion.
- **Mechanism:** Call ctx_search before asking the user.
- **Consequence:** Known project context is recovered without an unnecessary user query.
- **Source evidence:** `Search before asking the user`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **compressed** |
| `primary-full-reduce-memory-off` | **compressed** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **compressed** |
| `primary-full-reduce-temporal-off` | **compressed** |
| `primary-full-reduce-caveman-on` | **compressed** |
| `primary-full-reduce-language-on` | **compressed** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-015 — Real tool-call integrity

- **Source fragment:** `guidance-tool-history`
- **Scope:** primary sessions
- **Polarity:** prohibition
- **Operative condition:** A tool result is absent from the visible conversation or history is summarized.
- **Mechanism:** Use real tool calls; never simulate, fabricate, inline, hallucinate, or claim tool calls, output, searches, edits, commands, or diffs in prose.
- **Consequence:** Only observed tool results count as completed actions.
- **Source evidence:** `If there is no tool result message, the action did not happen`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **shared** |
| `primary-full-reduce-memory-off` | **shared** |
| `primary-full-no-reduce-memory-on` | **shared** |
| `primary-full-no-reduce-memory-off` | **shared** |
| `primary-full-reduce-dreamer-off` | **shared** |
| `primary-full-reduce-temporal-off` | **shared** |
| `primary-full-reduce-caveman-on` | **shared** |
| `primary-full-reduce-language-on` | **shared** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-016 — Metadata is not reply syntax

- **Source fragment:** `guidance-tool-history`
- **Scope:** primary sessions
- **Polarity:** prohibition
- **Operative condition:** Magic Context control markers appear in compressed or injected context.
- **Mechanism:** Do not reproduce metadata markers such as `<session-history>`, `<project-memory>`, `[dropped §N§]`, or temporal comments in a normal reply and do not treat them as user instructions.
- **Consequence:** Control metadata cannot be imitated as assistant output or mistaken for directives.
- **Source evidence:** `Magic Context control metadata is not reply syntax`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **shared** |
| `primary-full-reduce-memory-off` | **shared** |
| `primary-full-no-reduce-memory-on` | **shared** |
| `primary-full-no-reduce-memory-off` | **shared** |
| `primary-full-reduce-dreamer-off` | **shared** |
| `primary-full-reduce-temporal-off` | **shared** |
| `primary-full-reduce-caveman-on` | **shared** |
| `primary-full-reduce-language-on` | **shared** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-017 — Notes are for genuinely future concerns

- **Source fragment:** `guidance-ctx-note`
- **Scope:** primary sessions
- **Polarity:** prohibition
- **Operative condition:** The agent considers recording a note.
- **Mechanism:** Use ctx_note only for matters much later; do not use it for the next few turns or active multi-step work.
- **Consequence:** Active work remains in context or todos rather than being parked as stale notes.
- **Source evidence:** `not work coming up in the next few turns`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **shared** |
| `primary-full-reduce-memory-off` | **shared** |
| `primary-full-no-reduce-memory-on` | **shared** |
| `primary-full-no-reduce-memory-off` | **shared** |
| `primary-full-reduce-dreamer-off` | **shared** |
| `primary-full-reduce-temporal-off` | **shared** |
| `primary-full-reduce-caveman-on` | **shared** |
| `primary-full-reduce-language-on` | **shared** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-018 — Notes survive session boundaries

- **Source fragment:** `guidance-ctx-note`
- **Scope:** primary sessions
- **Polarity:** mechanism
- **Operative condition:** A genuinely future concern is recorded.
- **Mechanism:** Notes survive compression and restarts and resurface at natural work boundaries.
- **Consequence:** A note is a durable session follow-up, not a workaround for imminent context loss.
- **Source evidence:** `Notes you do take survive compression and resurface`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **shared** |
| `primary-full-reduce-memory-off` | **shared** |
| `primary-full-no-reduce-memory-on` | **shared** |
| `primary-full-no-reduce-memory-off` | **shared** |
| `primary-full-reduce-dreamer-off` | **shared** |
| `primary-full-reduce-temporal-off` | **shared** |
| `primary-full-reduce-caveman-on` | **shared** |
| `primary-full-reduce-language-on` | **shared** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-019 — Claims are durable project knowledge

- **Source fragment:** `guidance-memory`
- **Scope:** primary sessions with memory enabled
- **Polarity:** contract
- **Operative condition:** A fact must be available to future sessions.
- **Mechanism:** Use ctx_memory to create durable claims and revise, archive, restore, or merge them when facts drift.
- **Consequence:** Future sessions start with maintained project knowledge.
- **Source evidence:** `Claims persist across sessions`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **shared** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **shared** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **shared** |
| `primary-full-reduce-temporal-off` | **shared** |
| `primary-full-reduce-caveman-on` | **shared** |
| `primary-full-reduce-language-on` | **shared** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-020 — Proactive durable-claim capture

- **Source fragment:** `guidance-memory`
- **Scope:** primary sessions with memory enabled
- **Polarity:** mechanism
- **Operative condition:** Several turns were spent discovering a path, command, pattern, or hard-won constraint.
- **Mechanism:** Create the reusable claim with its category and content.
- **Consequence:** Future sessions do not repeat the same discovery work.
- **Source evidence:** `Save durable knowledge proactively`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **shared** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **shared** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **shared** |
| `primary-full-reduce-temporal-off` | **shared** |
| `primary-full-reduce-caveman-on` | **shared** |
| `primary-full-reduce-language-on` | **shared** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-021 — Reduction trigger taxonomy

- **Source fragment:** `guidance-generic-reduction`
- **Scope:** primary sessions with ctx_reduce
- **Polarity:** mechanism
- **Operative condition:** The agent has acted on raw exploration or changes task area.
- **Mechanism:** Reduce after acted-on reads/searches, completed logical steps, and before major context switches.
- **Consequence:** Intermediate evidence is reclaimed at meaningful boundaries.
- **Source evidence:** `Between major context switches`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **compressed** |
| `primary-full-reduce-memory-off` | **compressed** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **compressed** |
| `primary-full-reduce-temporal-off` | **compressed** |
| `primary-full-reduce-caveman-on` | **compressed** |
| `primary-full-reduce-language-on` | **compressed** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-022 — Drop large consumed outputs

- **Source fragment:** `guidance-generic-reduction`
- **Scope:** primary sessions with ctx_reduce
- **Polarity:** contract
- **Operative condition:** A large read, search, diagnostic, build, or test output has already been analyzed.
- **Mechanism:** Drop the raw output after acting on it; retain unresolved errors and current work context.
- **Consequence:** Useful evidence remains while redundant volume is removed.
- **Source evidence:** `Large build/test output after you analyzed and acted on it`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **compressed** |
| `primary-full-reduce-memory-off` | **compressed** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **compressed** |
| `primary-full-reduce-temporal-off` | **compressed** |
| `primary-full-reduce-caveman-on` | **compressed** |
| `primary-full-reduce-language-on` | **compressed** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-023 — Keep active task context

- **Source fragment:** `guidance-generic-reduction`
- **Scope:** primary sessions with ctx_reduce
- **Polarity:** contract
- **Operative condition:** The agent is selecting content to retain.
- **Mechanism:** Keep task requirements, constraints, recent errors, unresolved decisions, active work, and files being edited.
- **Consequence:** The current task remains grounded after reduction.
- **Source evidence:** `Your current task requirements and constraints`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **compressed** |
| `primary-full-reduce-memory-off` | **compressed** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **compressed** |
| `primary-full-reduce-temporal-off` | **compressed** |
| `primary-full-reduce-caveman-on` | **compressed** |
| `primary-full-reduce-language-on` | **compressed** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-024 — Prefer targeted operations

- **Source fragment:** `guidance-generic-reduction`
- **Scope:** primary sessions with ctx_reduce
- **Polarity:** contract
- **Operative condition:** The agent can choose between broad and focused context operations.
- **Mechanism:** Prefer many small targeted operations and keep the working set tidy as routine maintenance.
- **Consequence:** Reduction avoids broad irreversible-looking guesses.
- **Source evidence:** `Prefer many small targeted operations over one large blanket operation`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **compressed** |
| `primary-full-reduce-memory-off` | **compressed** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **compressed** |
| `primary-full-reduce-temporal-off` | **compressed** |
| `primary-full-reduce-caveman-on` | **compressed** |
| `primary-full-reduce-language-on` | **compressed** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-025 — Memory guidance is feature-gated

- **Source fragment:** `guidance-memory`
- **Scope:** primary sessions with memory enabled
- **Polarity:** mechanism
- **Operative condition:** The memory block is enabled and project-memory is injected.
- **Mechanism:** Compose the memory instructions only when memory is enabled; omit them when disabled.
- **Consequence:** The prompt does not advertise a memory surface that is unavailable.
- **Source evidence:** `Gated out when `memory.enabled: false``

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **shared** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **shared** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **shared** |
| `primary-full-reduce-temporal-off` | **shared** |
| `primary-full-reduce-caveman-on` | **shared** |
| `primary-full-reduce-language-on` | **shared** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-026 — Temporal boundary interpretation

- **Source fragment:** `guidance-temporal`
- **Scope:** primary sessions with temporal awareness enabled
- **Polarity:** contract
- **Operative condition:** Temporal HTML comments or session-history date attributes are present.
- **Mechanism:** Use elapsed-time comments and start-date/end-date boundaries when reasoning about pacing and durations.
- **Consequence:** Workflow timing is based on real session boundaries.
- **Source evidence:** `Use these when reasoning about workflow pacing`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **shared** |
| `primary-full-reduce-memory-off` | **shared** |
| `primary-full-no-reduce-memory-on` | **shared** |
| `primary-full-no-reduce-memory-off` | **shared** |
| `primary-full-reduce-dreamer-off` | **shared** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **shared** |
| `primary-full-reduce-language-on` | **shared** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-027 — Caveman compression is not a style

- **Source fragment:** `guidance-caveman`
- **Scope:** primary sessions with caveman compression enabled
- **Polarity:** prohibition
- **Operative condition:** Older compressed text uses terse caveman style.
- **Mechanism:** Write new turns in normal prose and consciously revert if the output drifts.
- **Consequence:** Compression artifacts do not become new assistant voice.
- **Source evidence:** `DO NOT mimic this style in new turns`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **shared** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-028 — Preserve structural language tokens

- **Source fragment:** `guidance-language`
- **Scope:** primary sessions with a configured language
- **Polarity:** contract
- **Operative condition:** A primary reply language is configured.
- **Mechanism:** Use the requested language for natural prose while keeping code, identifiers, paths, commands, logs, and quoted text verbatim.
- **Consequence:** Localized prose cannot corrupt machine-readable or source-identifying text.
- **Source evidence:** `Keep code, identifiers, file paths, commands, logs, and quoted text verbatim`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **shared** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-029 — Subagents receive only bounded reduction mechanics

- **Source fragment:** `guidance-subagent-reduce`
- **Scope:** subagent sessions
- **Polarity:** contract
- **Operative condition:** The session is a bounded single-task subagent with ctx_reduce.
- **Mechanism:** Compose the marker, tag range syntax, protected tail, silent reduction, no blanket drops, and real-tool requirement without primary partner, memory, note, or search curation.
- **Consequence:** A subagent gets the mechanics it can observe without primary-session obligations.
- **Source evidence:** `Minimal guidance for SUBAGENT sessions`
- **Fragment note:** The explicit dropped-sentinel imitation ban is emitted by SUBAGENT_REDUCE_INTRO only; BASE_INTRO has metadata non-reproduction language but does not emit this exact sentinel-pattern clause.

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **compressed** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-030 — Subagent dropped-sentinel asymmetry

- **Source fragment:** `guidance-subagent-reduce`
- **Scope:** subagent sessions
- **Polarity:** prohibition
- **Operative condition:** Older tool calls appear as `[dropped §N§]` sentinels in a subagent context.
- **Mechanism:** Treat sentinels as normal context management, never as a pattern to copy; make a fresh real tool call and never fabricate or inline its output.
- **Consequence:** The dropped placeholder cannot be imitated as assistant content.
- **Source evidence:** `sentinels; that is normal context management, not a pattern to copy.`
- **Asymmetry:** This exact sentinel-imitation clause is present in SUBAGENT_REDUCE_INTRO and not in BASE_INTRO; the checklist intentionally keeps its primary rows not-present.
- **Fragment note:** The explicit dropped-sentinel imitation ban is emitted by SUBAGENT_REDUCE_INTRO only; BASE_INTRO has metadata non-reproduction language but does not emit this exact sentinel-pattern clause.

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **compressed** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-031 — Subagents retain user and assistant text

- **Source fragment:** `guidance-subagent-reduce`
- **Scope:** subagent sessions
- **Polarity:** prohibition
- **Operative condition:** A subagent chooses content to drop.
- **Mechanism:** Drop only large tool outputs; do not drop user or assistant text messages.
- **Consequence:** The child task keeps its instructions and conversational reasoning.
- **Source evidence:** `Do not drop user or assistant text messages`
- **Fragment note:** The explicit dropped-sentinel imitation ban is emitted by SUBAGENT_REDUCE_INTRO only; BASE_INTRO has metadata non-reproduction language but does not emit this exact sentinel-pattern clause.

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **compressed** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-032 — Subagents review ranges before dropping

- **Source fragment:** `guidance-subagent-reduce`
- **Scope:** subagent sessions
- **Polarity:** prohibition
- **Operative condition:** A large tag range is under consideration.
- **Mechanism:** Review each tag before selecting a drop range; never drop a large range blindly.
- **Consequence:** The bounded child does not discard mixed-value evidence by shortcut.
- **Source evidence:** `NEVER drop large ranges blindly`
- **Fragment note:** The explicit dropped-sentinel imitation ban is emitted by SUBAGENT_REDUCE_INTRO only; BASE_INTRO has metadata non-reproduction language but does not emit this exact sentinel-pattern clause.

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **compressed** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-033 — Reduction prompts are housekeeping, not scarcity

- **Source fragment:** `guidance-reduce-closer`
- **Scope:** primary sessions with ctx_reduce
- **Polarity:** prohibition
- **Operative condition:** Context usage or a reduction prompt is visible.
- **Mechanism:** Treat reduction as routine maintenance and never reduce task scope or depth because context is large.
- **Consequence:** Cache maintenance cannot cause the agent to rush, defer, or omit work.
- **Source evidence:** `never let context size change *what* work you take on or *how thoroughly*`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **compressed** |
| `primary-full-reduce-memory-off` | **compressed** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **compressed** |
| `primary-full-reduce-temporal-off` | **compressed** |
| `primary-full-reduce-caveman-on` | **compressed** |
| `primary-full-reduce-language-on` | **compressed** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-034 — No-reduce sessions are automatically managed

- **Source fragment:** `guidance-no-reduce-closer`
- **Scope:** primary sessions without ctx_reduce
- **Polarity:** prohibition
- **Operative condition:** The reduction tool is unavailable.
- **Mechanism:** Rely on automatic context management; do not prune, heed reduction warnings, or cut task scope or depth.
- **Consequence:** An unavailable reduction tool cannot create false manual housekeeping obligations.
- **Source evidence:** `there's nothing to prune and no warnings to act on`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **compressed** |
| `primary-full-no-reduce-memory-off` | **compressed** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### G-035 — No-reduce sessions retain recovery guidance without pruning instructions

- **Source fragment:** `guidance-no-reduce-intro`
- **Scope:** primary sessions without ctx_reduce
- **Polarity:** contract
- **Operative condition:** Prior project or compacted-session context is needed while ctx_reduce is unavailable.
- **Mechanism:** Keep note, memory, search, expansion, and real-tool guidance while omitting tag and reduction mechanics.
- **Consequence:** The agent can recover hidden context without being told to call an unavailable tool.
- **Source evidence:** `when ctx_reduce is unavailable`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **compressed** |
| `primary-full-no-reduce-memory-off` | **compressed** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **not-present** |
| `tool-memory-disabled` | **not-present** |

### T-001 — ctx_reduce queues release

- **Source fragment:** `tool-ctx-reduce`
- **Scope:** ctx_reduce tool users
- **Polarity:** contract
- **Operative condition:** A spent tagged output should leave the working set.
- **Mechanism:** Mark it discardable; release is queued and delayed until context space is needed.
- **Consequence:** The original remains visible until the system releases it.
- **Source evidence:** `Marking QUEUES content for release`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **compressed** |
| `tool-memory-disabled` | **compressed** |

### T-002 — ctx_reduce protects newest tags

- **Source fragment:** `tool-ctx-reduce`
- **Scope:** ctx_reduce tool users
- **Polarity:** mechanism
- **Operative condition:** A requested tag is in the recent window.
- **Mechanism:** The newest tags are protected and age out before release.
- **Consequence:** Marking recent output is harmless.
- **Source evidence:** `The newest tags are protected`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **compressed** |
| `tool-memory-disabled` | **compressed** |

### T-003 — ctx_reduce recovery is explicit

- **Source fragment:** `tool-ctx-reduce`
- **Scope:** ctx_reduce tool users
- **Polarity:** contract
- **Operative condition:** Content has finally been released.
- **Mechanism:** It becomes a short placeholder; rerun the recovery tool to get it back, and mark only content that is genuinely done.
- **Consequence:** The agent does not treat an unrecovered output as safely disposable.
- **Source evidence:** `re-running the tool is the only way to get it back`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **compressed** |
| `tool-memory-disabled` | **compressed** |

### T-004 — ctx_reduce eligible output boundary

- **Source fragment:** `tool-ctx-reduce`
- **Scope:** ctx_reduce tool users
- **Polarity:** contract
- **Operative condition:** Choosing output to mark.
- **Mechanism:** Prefer summarized, repeated, redundant, persisted, or merely confirmatory status output; keep user messages, unresolved errors, raw evidence, and exact wording that matters.
- **Consequence:** Reduction preserves unresolved and authoritative evidence.
- **Source evidence:** `Keep: user messages, unresolved errors, raw evidence you haven't extracted yet`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **compressed** |
| `tool-memory-disabled` | **compressed** |

### T-005 — ctx_reduce rejects blind ranges

- **Source fragment:** `tool-ctx-reduce`
- **Scope:** ctx_reduce tool users
- **Polarity:** prohibition
- **Operative condition:** A large range is under consideration.
- **Mechanism:** Review every tag before calling the drop parameter.
- **Consequence:** A blanket range cannot silently discard mixed-value content.
- **Source evidence:** `Never blanket-mark large ranges`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **compressed** |
| `tool-memory-disabled` | **compressed** |

### T-006 — ctx_expand uses compacted headings

- **Source fragment:** `tool-ctx-expand`
- **Scope:** ctx_expand tool users
- **Polarity:** contract
- **Operative condition:** A summary under session-history lacks required detail.
- **Mechanism:** Pass the heading's start/end ordinal range to recover the original conversation.
- **Consequence:** Exact historical context can be restored from the summary boundary.
- **Source evidence:** `expand the range`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **compressed** |
| `tool-memory-disabled` | **compressed** |

### T-007 — ctx_expand has a bounded range result

- **Source fragment:** `tool-ctx-expand`
- **Scope:** ctx_expand tool users
- **Polarity:** mechanism
- **Operative condition:** The requested transcript exceeds the recovery budget.
- **Mechanism:** Return a raw transcript capped at about 15K tokens and identify where to continue.
- **Consequence:** The agent can continue recovery without receiving an unbounded result.
- **Source evidence:** `capped at ~15K tokens; an oversized range returns the head`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **compressed** |
| `tool-memory-disabled` | **compressed** |

### T-008 — ctx_expand verbose mode identifies parts

- **Source fragment:** `tool-ctx-expand`
- **Scope:** ctx_expand tool users
- **Polarity:** contract
- **Operative condition:** The agent needs to choose one message or tool call from a range.
- **Mechanism:** Use verbose mode to list each message ordinal separately with per-part previews and tool output sizes.
- **Consequence:** The agent can select a precise ordinal before full recovery.
- **Source evidence:** `lists each message SEPARATELY with its ordinal`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **compressed** |
| `tool-memory-disabled` | **compressed** |

### T-009 — ctx_expand ordinal mode recovers one message

- **Source fragment:** `tool-ctx-expand`
- **Scope:** ctx_expand tool users
- **Polarity:** contract
- **Operative condition:** One exact message or dropped tool output is needed.
- **Mechanism:** Pass message=N to return all text parts and complete tool input/output for that ordinal.
- **Consequence:** A previously dropped output is recovered from storage rather than fabricated.
- **Source evidence:** `returns the FULL untruncated content of the message`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **compressed** |
| `tool-memory-disabled` | **compressed** |

### T-010 — ctx_expand does not reread the live tail

- **Source fragment:** `tool-ctx-expand`
- **Scope:** ctx_expand tool users
- **Polarity:** contract
- **Operative condition:** A requested range is after the last compacted compartment.
- **Mechanism:** Treat that range as already visible live context and do not expand it.
- **Consequence:** The tool does not duplicate visible content and burn output tokens.
- **Source evidence:** `Ranges after the last compartment are your live tail`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **compressed** |
| `tool-memory-disabled` | **compressed** |

### T-011 — ctx_note action contract

- **Source fragment:** `tool-ctx-note`
- **Scope:** ctx_note tool users
- **Polarity:** contract
- **Operative condition:** The agent has a future session concern.
- **Mechanism:** write saves, read lists, update changes, and dismiss retires notes; smart notes use surface_condition.
- **Consequence:** Each note action has an explicit lifecycle operation.
- **Source evidence:** `Actions:`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **compressed** |
| `tool-memory-disabled` | **compressed** |

### T-012 — ctx_note smart conditions are external-only

- **Source fragment:** `tool-ctx-note`
- **Scope:** ctx_note tool users
- **Polarity:** prohibition
- **Operative condition:** A smart note is requested.
- **Mechanism:** Use only externally verifiable signals from GitHub, disk, git history, or web pages; never a condition that depends on this conversation or an unobservable future action.
- **Consequence:** The background checker can evaluate the condition without conversation access.
- **Source evidence:** `using ONLY externally verifiable signals`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **compressed** |
| `tool-memory-disabled` | **compressed** |

### T-013 — ctx_memory stores durable project claims

- **Source fragment:** `tool-ctx-memory`
- **Scope:** ctx_memory tool users
- **Polarity:** contract
- **Operative condition:** A fact must survive this session.
- **Mechanism:** Create one durable project claim with category and content.
- **Consequence:** Future sessions can use the memory without reconstructing this conversation.
- **Source evidence:** `create a claim (content + category)`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **compressed** |
| `tool-memory-disabled` | **not-present** |

### T-014 — ctx_memory action and privilege boundary

- **Source fragment:** `tool-ctx-memory`
- **Scope:** ctx_memory tool users
- **Polarity:** contract
- **Operative condition:** A memory must be changed or fetched.
- **Mechanism:** Use create, get, revise, archive, restore, or merge; list remains dreamer-only.
- **Consequence:** Primary agents cannot assume the dreamer-only list action is available.
- **Source evidence:** `list: enumerate visible active claims (dreamer maintenance only)`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **compressed** |
| `tool-memory-disabled` | **not-present** |

### T-015 — ctx_search returns only hidden history

- **Source fragment:** `tool-ctx-search`
- **Scope:** ctx_search tool users
- **Polarity:** contract
- **Operative condition:** The agent needs project recall.
- **Mechanism:** Search compacted messages, git commits, and notes while filtering claims already rendered in project-memory and the live conversation tail; broad project-memory retrieval stays disabled until the claim retrieval projection is active.
- **Consequence:** Search fills missing context rather than duplicating visible context.
- **Source evidence:** `Results only contain things you CANNOT currently see`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **compressed** |
| `tool-memory-disabled` | **compressed** |

### T-016 — ctx_memory identity and mutation boundary

- **Source fragment:** `tool-ctx-memory`
- **Scope:** ctx_memory tool users
- **Polarity:** contract
- **Operative condition:** A known claim must be fetched or changed.
- **Mechanism:** Use get with opaque public IDs and the current mutation token for changes; list remains dreamer-only.
- **Consequence:** Primary agents use canonical claim identities and cannot assume dreamer browsing privileges.
- **Source evidence:** `Reuse the exact token returned by create/get/list`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **compressed** |
| `tool-memory-disabled` | **not-present** |

### T-017 — ctx_search source routing and locator lookup

- **Source fragment:** `tool-ctx-search`
- **Scope:** ctx_search tool users
- **Polarity:** contract
- **Operative condition:** A recall query needs a source boundary or a direct claim lookup.
- **Mechanism:** Omit sources for broad search, select message/git_commit/note sources for targeted retrieval, or pass opaque public claim ids or full revision locators to bypass text search; the memory source is accepted but returns nothing, and message hits continue through ctx_expand.
- **Consequence:** Search scope and exact-claim lookup are explicit rather than guessed.
- **Source evidence:** `Sources (omit for a broad search across all):`

| Variant | Applicability status |
| --- | --- |
| `primary-full-reduce-memory-on` | **not-present** |
| `primary-full-reduce-memory-off` | **not-present** |
| `primary-full-no-reduce-memory-on` | **not-present** |
| `primary-full-no-reduce-memory-off` | **not-present** |
| `primary-full-reduce-dreamer-off` | **not-present** |
| `primary-full-reduce-temporal-off` | **not-present** |
| `primary-full-reduce-caveman-on` | **not-present** |
| `primary-full-reduce-language-on` | **not-present** |
| `subagent-reduce` | **not-present** |
| `tool-all-active` | **compressed** |
| `tool-memory-disabled` | **compressed** |

## Review notes

- The `[dropped §N§]` imitation prohibition is deliberately listed as `G-030` with `compressed` only for `subagent-reduce`; primary variants are `not-present` for this exact SUBAGENT_REDUCE_INTRO clause.
- Tool descriptions are included as load-bearing contract/mechanism rules, with active and memory-disabled tool compositions represented separately.
- No light prose is authored by this artifact. S3 must replace pending compressed targets with exact light lines after ratification.
