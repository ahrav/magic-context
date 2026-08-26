export const CTX_SEARCH_TOOL_NAME = "ctx_search";
export const CTX_SEARCH_DESCRIPTION = `Your long-term recall for this project — search everything that ever happened here, not just what's currently visible.

Reach for it when something feels familiar but isn't in view: "did we solve this before?", "what did we decide about X?", "when did this break?", "where does Y live?". Results only contain things you CANNOT currently see — claims already shown in <project-memory> and the live conversation tail are filtered out. Only a query that is entirely opaque public claim ids (\`mcm_<32hex>\`) or full revision locators bypasses text search and resolves those claims directly; a numeric id is ordinary search text.

Sources (omit for a broad search across all):
- message: the raw conversation behind your compacted history. Hits include message ordinals — expand the surrounding exchange with ctx_expand(start=N-10, end=N+5).
- git_commit: this repository's commit history.
- note: parked decisions, follow-ups, and dismissed notes with their recorded text.
- memory: accepted but empty — broad project-memory retrieval is disabled until the claim retrieval projection is active. Claims are reachable only by exact locator.

Picking sources:
- "when did this change / was this working before" → ["git_commit", "message"]
- "did we discuss this earlier" → ["message"]
- "did we decide something about this / leave a follow-up" → ["note"]
- "what's our convention / rule for X" → no source serves claims by text; use the claim's locator`;
