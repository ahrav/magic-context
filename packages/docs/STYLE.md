# Magic Context docs — style guide

Read this before writing or editing any page. It is the contract reviewers hold pages to.

## Voice

- Write for a developer who installed a coding agent yesterday. No prior knowledge of Magic Context internals.
- Second person ("you"), present tense, active voice. Concise — no marketing filler, no "simply", no "powerful".
- US English. Sentence-case headings.
- The agent is "the agent" or "your agent". The user is "you". Magic Context is "Magic Context" (never "MC", "the plugin", or "magic-context" in prose; `magic-context` only in code/paths).
- OpenCode and Pi are "harnesses". When behavior differs, show both explicitly — never describe OpenCode behavior as universal.

## Truth rules (hard)

- Every behavioral claim must be true of CURRENT source on main. When unsure, read the source — never write from memory of how it "probably" works.
- Internal jargon is allowed ONLY where the concept page defines it first (e.g. "compartment" is defined in concepts/historian). Never use undefined internal terms: m[0]/m[1], SOFT/HARD bust, watermark, tagger, sentinel — these may appear ONLY in concepts/cache-architecture, defined inline.
- No internal process references: no audit/council/Oracle/plan-version mentions, no issue numbers as explanation, no commit hashes.
- Config keys, defaults, and ranges must match `packages/plugin/src/config/schema/magic-context.ts` exactly. The configuration reference page is GENERATED — do not hand-write config tables on other pages; link to the reference instead.
- Tool and command names exactly as registered: `ctx_reduce`, `ctx_expand`, `ctx_note`, `ctx_memory`, `ctx_search`; `/ctx-status`, `/ctx-flush`, `/ctx-recomp`, `/ctx-wrapup`, `/ctx-aug`, `/ctx-dream`, `/ctx-session-upgrade`.

## Structure

- Frontmatter: `title` (short, sentence case) + `description` (one sentence, used by SEO and hover previews).
- Open every page with 1-3 sentences of "what this is and when you care" before the first heading.
- Prefer short sections with task-oriented headings ("Pin a memory permanently") over encyclopedic ones ("Memory status semantics").
- Use Starlight components where they help: `:::note`, `:::tip`, `:::caution` asides; `<Tabs>` with `<TabItem label="OpenCode">` / `<TabItem label="Pi">` for harness-split instructions (import from '@astrojs/starlight/components').
- Code blocks always carry a language tag (`bash`, `jsonc`, `text`). Session transcripts use `text`.
- Cross-link generously: first mention of another page's concept links to it. Relative links with trailing slash: `/concepts/memory/`.

## What docs do NOT cover

- Internal architecture for contributors (that's ARCHITECTURE.md in the repo).
- Pi↔OpenCode implementation divergences (PARITY.md) unless user-visible.
- Anything experimental/unreleased. Document the latest released version's behavior; gate "coming in next release" content behind explicit callouts only when asked.
