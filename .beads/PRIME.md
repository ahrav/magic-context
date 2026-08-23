# Beads Workflow

- Track all shared work with `bd`; do not use TodoWrite, TaskCreate, or markdown task lists.
- Before editing code, create or claim an issue and mark it in progress.
- Use `bd remember` for durable project knowledge. Do not create memory files.
- Use `bd ready`, `bd list`, and `bd show <id>` to inspect work.
- Use `bd create`, `bd update <id> --claim`, and `bd close <id>` to manage work.
- Do not use `bd edit` because it opens an interactive editor.
- Do not commit, push, or run `bd dolt push` unless the user, orchestrator, or active repository profile explicitly authorizes it.

Before reporting completion:

1. Close completed issues with `bd close <id...>`.
2. Run relevant tests, linters, and builds.
3. Run `git status` and report the resulting state.
4. Follow the active repository profile for handoff or authorized synchronization.
