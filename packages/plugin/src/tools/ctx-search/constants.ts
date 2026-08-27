export const CTX_SEARCH_TOOL_NAME = "ctx_search";
export const CTX_SEARCH_DESCRIPTION = `Your long-term recall for this project — search everything that ever happened here, not just what's currently visible.

Reach for it when something feels familiar but isn't in view: "did we solve this before?", "what did we reject?", "when did this break?", "where does Y live?". Results only contain things you CANNOT currently see — claims already shown in <project-memory> and the live conversation tail are filtered out. Rejected-approach claims are text-searchable warnings. A query that is entirely opaque public claim ids (\`mcm_<32hex>\`) or full revision locators resolves claims directly; a numeric id is ordinary search text.

Sources (omit for a broad search across all):
- message: the raw conversation behind your compacted history. Hits include message ordinals — expand the surrounding exchange with ctx_expand(start=N-10, end=N+5).
- git_commit: this repository's commit history.
- note: parked decisions, follow-ups, and dismissed notes with their recorded text.
- memory: rejected-approach warnings plus exact positive-memory locators. Broad positive-memory text retrieval remains disabled.

Picking sources:
- "when did this change / was this working before" → ["git_commit", "message"]
- "did we discuss this earlier" → ["message"]
- "did we decide something about this / leave a follow-up" → ["note"]
- "did we reject this approach" → ["memory"]
- "what's our convention / rule for X" → use the positive claim's locator`;
