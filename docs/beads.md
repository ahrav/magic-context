# Beads (bd) Task Tracking

All work in this repo is tracked in beads. `bd prime` is the source of
truth for workflow context; this is the condensed local reference.

## Quick reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd dolt push            # Push beads data to the remote
```

## Rules for agents

- Use `bd` for all task tracking — no TodoWrite, TaskCreate, or markdown
  TODO lists.
- Use `bd remember` for persistent knowledge — no MEMORY.md or ad hoc
  memory files.
- File follow-up work as beads before ending a session; close what you
  finished.
- Do not commit, push, or `bd dolt push` unless explicitly asked.

## Storage and sync

Issues live in a local Dolt database under `.beads/` (server mode).
Cross-machine sync is `bd dolt push/pull` via `refs/dolt/data` on the git
remote. `.beads/issues.jsonl` is a passive git-tracked export — never the
source of truth, and never `bd import` it during normal operation. Details:
[upstream SYNC_CONCEPTS.md](https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md).
