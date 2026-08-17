# Agent Instructions

## Task tracking

This repo uses **beads (bd)**. Run `bd prime` for workflow context; condensed
reference in [docs/beads.md](docs/beads.md).

- All task tracking goes through `bd` — no TodoWrite or markdown TODO lists.
- Persistent knowledge goes in `bd remember`, not memory files.
- Do not commit, push, or `bd dolt push` unless explicitly asked.

## Non-interactive shell

`cp`/`mv`/`rm` may be aliased to `-i` here and will hang an agent waiting for
y/n. Always force: `rm -f` / `rm -rf`, `cp -f` / `cp -rf`, `mv -f`. Use
`-o BatchMode=yes` for `ssh`/`scp`, `-y` for `apt-get`.
