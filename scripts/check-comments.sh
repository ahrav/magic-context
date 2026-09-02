#!/usr/bin/env sh
# Usage: scripts/check-comments.sh [FILE...]
#
# Matching runs over extracted comment spans, not whole lines, because a trailing
# comment and an unstarred block-comment body also carry text.
# Short IDs resolve through an exact lookup against the ID export, so a
# shape-alike token in prose is never a finding.
set -eu

cd "$(dirname "$0")/.."

EXTS='rs ts tsx js mjs py sh yml yaml toml'
IDS_FILE=.beads/issues.jsonl

if [ ! -f "$IDS_FILE" ]; then
  echo >&2 "comment check: $IDS_FILE is missing, so short tracker IDs cannot be recognized"
  exit 2
fi

# The id-field filter prevents issue prose from contributing IDs.
BEAD_IDS=$(grep -o '"id":"magic-context-[a-z0-9.]*"' "$IDS_FILE" |
  sed 's/^"id":"magic-context-//; s/"$//' |
  sort -u |
  tr '\n' ' ')

if [ -z "$BEAD_IDS" ]; then
  echo >&2 "comment check: $IDS_FILE holds no recognizable IDs"
  exit 2
fi

list=$(mktemp) || exit 2
trap 'rm -f "$list"' EXIT HUP INT TERM

if [ "$#" -gt 0 ]; then
  printf '%s\n' "$@" > "$list"
else
  git ls-files > "$list" || exit 2
fi

status=0
awk -v LISTFILE="$list" -v EXTS="$EXTS" -v BEAD_IDS="$BEAD_IDS" '
function excluded(p) {
  if (p ~ /(^|\/)\.beads\//) return 1
  if (p ~ /(^|\/)node_modules\//) return 1
  if (p ~ /(^|\/)target\//) return 1
  return 0
}

function wanted(p,   i, c, ext) {
  ext = ""
  for (i = length(p); i > 0; i--) {
    c = substr(p, i, 1)
    if (c == ".") { ext = substr(p, i + 1); break }
    if (c == "/") break
  }
  return (ext in ok_ext)
}

# A hash-style file has line comments only; a c-style file has both forms.
function style_of(p) {
  if (p ~ /\.(py|sh|yml|yaml|toml)$/) return "hash"
  return "c"
}

# A Rust apostrophe introduces a lifetime, so string-delimiter handling there would consume the rest of the line.
function apostrophe_quotes(p) {
  return (p ~ /\.rs$/) ? 0 : 1
}

# Rust block comments nest, so a closing delimiter there ends only the innermost span.
function block_nests(p) {
  return (p ~ /\.rs$/) ? 1 : 0
}

# Quote tracking keeps a delimiter inside a string literal from opening a comment.
# Only block-comment state survives across lines, so an unbalanced quote cannot desync the next line.
function comment_of(line, st,   i, n, c, two, q, out) {
  out = ""
  n = length(line)
  i = 1
  q = ""
  while (i <= n) {
    if (depth > 0) {
      two = substr(line, i, 2)
      if (two == "*/") { depth--; i += 2; continue }
      if (blk_nest && two == "/*") { depth++; i += 2; continue }
      out = out substr(line, i, 1)
      i++
      continue
    }
    c = substr(line, i, 1)
    if (q != "") {
      if (c == BS) { i += 2; continue }
      if (c == q) q = ""
      i++
      continue
    }
    if (c == DQ || c == BT || (c == SQ && sq_quotes)) { q = c; i++; continue }
    if (st == "hash") {
      # A hash starts a comment only at line start or after whitespace, so a shell word or YAML scalar containing one stays runtime data.
      if (c == "#" && (i == 1 || substr(line, i - 1, 1) == " " || substr(line, i - 1, 1) == "\t")) {
        return out " " substr(line, i + 1)
      }
      i++
      continue
    }
    two = substr(line, i, 2)
    if (two == "//") return out " " substr(line, i + 2)
    if (two == "/*") { depth = 1; out = out " "; i += 2; continue }
    i++
  }
  return out
}

function check(p, lno, raw, txt,   lt, hit, count, i, toks, t, dot, base, rest, tok) {
  if (txt ~ /commentlint:[ \t]*allow[ \t]*\(/) {
    printf "comment-lint suppression on disk: %s:%d:%s\n", p, lno, raw
    status = 1
  }

  lt = tolower(txt) " "
  hit = 0
  # The prefix disambiguates, so a base lookup suffices here. A product name carrying an unknown base does not trigger.
  rest = lt
  while (match(rest, /magic-context-[a-z0-9]+(\.[0-9]+)*/)) {
    tok = substr(rest, RSTART + 14, RLENGTH - 14)
    dot = index(tok, ".")
    base = (dot > 0) ? substr(tok, 1, dot - 1) : tok
    if (base in bead_base) { hit = 1; break }
    rest = substr(rest, RSTART + RLENGTH)
  }
  if (!hit && lt ~ /(^|[^a-z0-9])(cr|pr|mr|sim|tt|jira)-[0-9]/) hit = 1
  if (!hit) {
    count = split(lt, toks, /[^a-z0-9.]+/)
    for (i = 1; i <= count; i++) {
      t = toks[i]
      # Sentence punctuation is not part of the ID.
      sub(/\.+$/, "", t)
      if (t == "") continue
      dot = index(t, ".")
      base = (dot > 0) ? substr(t, 1, dot - 1) : t
      if (!(t in bead_id)) continue
      # Some all-letter IDs are also ordinary words, so a bare one is exempt while the prefixed spelling still reports.
      if (dot > 0 || base ~ /[0-9]/) { hit = 1; break }
    }
  }

  if (hit) {
    printf "tracker id in comment: %s:%d:%s\n", p, lno, raw
    status = 1
  }
}

BEGIN {
  SQ = sprintf("%c", 39)
  DQ = sprintf("%c", 34)
  BT = sprintf("%c", 96)
  BS = sprintf("%c", 92)

  parts_n = split(EXTS, parts, " ")
  for (k = 1; k <= parts_n; k++) ok_ext[parts[k]] = 1

  parts_n = split(BEAD_IDS, parts, " ")
  for (k = 1; k <= parts_n; k++) {
    if (parts[k] == "") continue
    bead_id[parts[k]] = 1
    at = index(parts[k], ".")
    bead_base[(at > 0) ? substr(parts[k], 1, at - 1) : parts[k]] = 1
  }

  status = 0
  while ((lrc = (getline path < LISTFILE)) > 0) {
    if (path == "" || excluded(path) || !wanted(path)) continue
    style = style_of(path)
    sq_quotes = apostrophe_quotes(path)
    blk_nest = block_nests(path)
    depth = 0
    lno = 0
    while ((frc = (getline line < path)) > 0) {
      lno++
      if (depth == 0) {
        if (style == "hash") {
          if (index(line, "#") == 0) continue
        } else if (index(line, "/") == 0) continue
      }
      text = comment_of(line, style)
      if (text != "") check(path, lno, line, text)
    }
    close(path)
    # An unreadable input exits non-zero rather than passing as a clean scan.
    if (frc < 0) {
      printf "comment check: cannot read %s\n", path > "/dev/stderr"
      status = 2
    }
  }
  close(LISTFILE)
  if (lrc < 0) {
    print "comment check: cannot read the file list" > "/dev/stderr"
    status = 2
  }

  if (status != 0) {
    print "" > "/dev/stderr"
    print "Comments describe the mechanism in the present tense. Record tracking in bd, not in source." > "/dev/stderr"
  }
  exit status
}
' || status=$?

exit "$status"
