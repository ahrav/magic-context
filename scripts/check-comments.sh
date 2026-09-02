#!/usr/bin/env sh
# Usage: scripts/check-comments.sh [FILE...]
set -eu

cd "$(dirname "$0")/.."

# The patterns match Beads and CR/JIRA-style IDs only on comment lines; string
# literals may contain runtime IDs.
BEAD='magic-context-[a-z0-9]{2,4}(\.[0-9]+)?\b|\b[a-z][a-z0-9]{2}\.[0-9]{1,2}\b'
TICKET='\b(CR|PR|MR|SIM|TT|JIRA)-[0-9]{2,}\b'
COMMENT_LINE='^\s*(//|/\*|\*|#)'

# A suppression directive on disk records that the guard was bypassed.
DIRECTIVE='commentlint:\s*allow\('

GLOBS="--glob=*.rs --glob=*.ts --glob=*.tsx --glob=*.js --glob=*.mjs --glob=*.py --glob=*.sh"
EXCLUDES="--glob=!target --glob=!node_modules --glob=!.beads --glob=!**/*.lock"

status=0

# shellcheck disable=SC2086
if out=$(rg -n --no-heading --with-filename $GLOBS $EXCLUDES -e "$DIRECTIVE" -- "$@" 2>/dev/null); then
  echo "$out" | sed 's/^/comment-lint suppression on disk: /'
  status=1
fi

# shellcheck disable=SC2086
if out=$(rg -n --no-heading --with-filename --pcre2 $GLOBS $EXCLUDES \
      -e "${COMMENT_LINE}.*(${BEAD}|${TICKET})" -- "$@" 2>/dev/null); then
  # Ignore file names and cited version or rule tokens. Match only comment
  # text so a filename in the path cannot exempt it.
  filtered=$(echo "$out" | awk '{
    text = $0; sub(/^[^:]*:[0-9]+:/, "", text)
    if (text ~ /\.(rs|ts|js|md|toml|json|yml|sh|py)([^a-z]|$)/) next
    if (text ~ /(^|[^a-z0-9])p[0-9][0-9]\.[0-9]/) next
    if (tolower(text) ~ /(^|[^a-z])(v|rfc|sec|section|fig|table|step|rule|r)[0-9]/) next
    print
  }')
  if [ -n "$filtered" ]; then
    echo "$filtered" | sed 's/^/tracker id in comment: /'
    status=1
  fi
fi

if [ "$status" -ne 0 ]; then
  echo >&2
  echo >&2 "Comments describe the mechanism in the present tense. Record tracking in bd, not in source."
fi
exit "$status"
