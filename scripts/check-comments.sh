#!/usr/bin/env sh
# Usage: scripts/check-comments.sh [FILE...]
#
# Matching runs over extracted comment spans, not whole lines, because a trailing
# comment and an unstarred block-comment body also carry text.
# Short IDs resolve through an exact lookup against the ID export, so a
# shape-alike token in prose is never a finding.
set -eu

cd "$(dirname "$0")/.."

EXTS='rs ts tsx js mjs cjs py sh ps1 yml yaml toml jsonc css'
# A caller validating staged content supplies the matching staged export.
IDS_FILE=${COMMENT_CHECK_IDS:-.beads/issues.jsonl}

if [ ! -f "$IDS_FILE" ]; then
  echo >&2 "comment check: $IDS_FILE is missing, so short tracker IDs cannot be recognized"
  exit 2
fi

# The id-field filter prevents issue prose from contributing IDs.
BEAD_IDS=$(grep -oE '"id" *: *"magic-context-[a-z0-9.]*"' "$IDS_FILE" |
  sed -E 's/.*"magic-context-//; s/"$//' |
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
  # -z keeps a non-ASCII path unquoted, so its extension is still recognized.
  git ls-files -z | tr '\0' '\n' > "$list" || exit 2
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

function style_of(p) {
  if (p ~ /\.(py|sh|ps1|yml|yaml|toml)$/) return "hash"
  # CSS supports block comments but not line comments.
  if (p ~ /\.css$/) return "block"
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

# Rust raw strings and character literals need their own delimiters.
function rust_literals(p) {
  return (p ~ /\.rs$/) ? 1 : 0
}

# A slash can open a regular expression, whose body may contain a comment delimiter.
function regex_literals(p) {
  return (p ~ /\.(ts|tsx|js|mjs|cjs)$/) ? 1 : 0
}

# Python and TOML share the triple-quote form.
function triple_literals(p) {
  return (p ~ /\.(py|toml)$/) ? 1 : 0
}

function heredoc_literals(p) {
  return (p ~ /\.sh$/) ? 1 : 0
}

# A single-quoted body processes backslash escapes only in these languages.
function apostrophe_escapes(p) {
  return (p ~ /\.(ts|tsx|js|mjs|cjs|py)$/) ? 1 : 0
}

# JavaScript template literals permit unescaped line breaks; quoted strings do not.
function template_quotes(p) {
  return (p ~ /\.(ts|tsx|js|mjs|cjs)$/) ? 1 : 0
}

function hash_boundary(p) {
  if (p ~ /\.(sh|ps1)$/) return 2
  if (p ~ /\.(yml|yaml)$/) return 1
  return 0
}

# Quote tracking keeps a delimiter inside a string literal from opening a comment.
# Only block-comment state survives across lines, so an unbalanced quote cannot desync the next line.
function comment_of(line, st, nosq,   i, n, c, two, three, q, out, j, k, m, hashes, e, prev) {
  out = ""
  unterm = 0
  n = length(line)
  i = 1
  # `litend` holds the delimiter of a literal opened on a prior line.
  if (litend != "") {
    e = index(line, litend)
    if (e == 0) return ""
    i = e + length(litend)
    litend = ""
  }
  q = (tq && tsub == 0) ? BT : ""
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
      if (c == BS && (q != SQ || sq_escapes)) { i += 2; continue }
      if (q == BT && substr(line, i, 2) == "${") { tsub = 1; q = ""; i += 2; continue }
      if (c == q) { q = ""; if (c == BT) tq = 0 }
      i++
      continue
    }
    # An escape outside a string covers the shell form that embeds an apostrophe.
    if (c == BS) { i += 2; continue }
    # Substitution contents are code, so its braces decide where the template resumes.
    if (tq && tsub > 0) {
      if (c == "{") { tsub++; i++; continue }
      if (c == "}") { tsub--; if (tsub == 0) q = BT; i++; continue }
    }
    if (rust_lit && (c == "r" || c == "b")) {
      j = (c == "b") ? i + 1 : i
      prev = (i > 1) ? substr(line, i - 1, 1) : ""
      if (substr(line, j, 1) == "r" && prev !~ /[A-Za-z0-9_]/) {
        k = j + 1
        hashes = 0
        while (substr(line, k, 1) == "#") { hashes++; k++ }
        if (substr(line, k, 1) == DQ) {
          litend = DQ
          for (m = 0; m < hashes; m++) litend = litend "#"
          e = index(substr(line, k + 1), litend)
          if (e == 0) return out
          i = k + e + length(litend)
          litend = ""
          continue
        }
      }
    }
    if (rust_lit && c == SQ) {
      # An apostrophe closing a one-character or escaped body is a character literal; any other is a lifetime.
      if (substr(line, i + 1, 1) == BS) {
        if (substr(line, i + 3, 1) == SQ) { i += 4; continue }
      } else if (substr(line, i + 2, 1) == SQ && substr(line, i + 1, 1) != "") {
        i += 3
        continue
      }
      i++
      continue
    }
    if (triple_lit && (c == DQ || c == SQ)) {
      three = substr(line, i, 3)
      if (three == DQ DQ DQ || three == SQ SQ SQ) {
        litend = three
        e = index(substr(line, i + 3), three)
        if (e == 0) return out
        i = i + 3 + e + 2
        litend = ""
        continue
      }
    }
    if (regex_lit && c == "/" && substr(line, i + 1, 1) != "/" && substr(line, i + 1, 1) != "*") {
      e = regex_end(line, i, n)
      if (e > 0) { i = e; continue }
    }
    if (c == DQ || (c == SQ && sq_quotes && !nosq)) { q = c; i++; continue }
    if (c == BT && tmpl_quotes) { q = BT; tq = 1; i++; continue }
    if (st == "hash") {
      if (heredoc_lit && substr(line, i, 2) == "<<") {
        e = heredoc_word(line, i)
        if (e > 0) { i = e; continue }
      }
      if (c == "#" && hash_opens(line, i)) return out " " substr(line, i + 1)
      i++
      continue
    }
    two = substr(line, i, 2)
    if (st != "block" && two == "//") return out " " substr(line, i + 2)
    if (two == "/*") { depth = 1; out = out " "; i += 2; continue }
    i++
  }
  if (q != "" && q != BT) unterm = 1
  return out
}

# Only scan a slash-delimited body where an expression can begin; elsewhere a slash is division or a path.
function regex_end(line, i, n,   j, c, prev, in_class) {
  prev = prev_code_char(line, i)
  if (prev != "" && index("(,=:[!&|?{};+-*%~^", prev) == 0) return 0
  in_class = 0
  j = i + 1
  while (j <= n) {
    c = substr(line, j, 1)
    if (c == BS) { j += 2; continue }
    if (c == "[") in_class = 1
    else if (c == "]") in_class = 0
    else if (c == "/" && !in_class) {
      j++
      while (substr(line, j, 1) ~ /^[a-z]$/) j++
      return j
    }
    j++
  }
  return 0
}

function prev_code_char(line, i,   j, c) {
  for (j = i - 1; j > 0; j--) {
    c = substr(line, j, 1)
    if (c != " " && c != "\t") return c
  }
  return ""
}

# A heredoc body ends at a line holding only its delimiter, so the word is retained rather than matched as a substring.
function heredoc_word(line, i,   j, c, w) {
  j = i + 2
  if (substr(line, j, 1) == "-") j++
  while (substr(line, j, 1) == " ") j++
  c = substr(line, j, 1)
  if (c == DQ || c == SQ) j++
  w = ""
  while (j <= length(line)) {
    c = substr(line, j, 1)
    if (c !~ /^[A-Za-z0-9_]$/) break
    w = w c
    j++
  }
  if (w == "") return 0
  heredoc = w
  if (substr(line, j, 1) == DQ || substr(line, j, 1) == SQ) j++
  return j
}

# Boundary 0 accepts any position, 1 also requires whitespace or line start, and 2 additionally accepts a control operator.
function hash_opens(line, i,   prev) {
  if (hash_bound == 0 || i == 1) return 1
  prev = substr(line, i - 1, 1)
  if (prev == " " || prev == "\t") return 1
  if (hash_bound == 2 && index(";&|()", prev) > 0) return 1
  return 0
}

function check(p, lno, raw, txt,   lt, hit, count, i, toks, t, dot, base, rest, tok) {
  lt = tolower(txt) " "
  if (lt ~ /commentlint:[ \t]*allow[ \t]*\(/) {
    printf "comment-lint suppression on disk: %s:%d:%s\n", p, lno, raw
    status = 1
  }

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
  if (!hit && lt ~ /(^|[^a-z0-9])(cr|pr|mr|sim|tt|jira)-[0-9]+[^a-z0-9]/) hit = 1
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
      # A bare ID needs a letter and either a digit or a dot, so an ordinary word or a plain number is not a match.
      if (base ~ /[a-z]/ && (dot > 0 || base ~ /[0-9]/)) { hit = 1; break }
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
    sq_escapes = apostrophe_escapes(path)
    blk_nest = block_nests(path)
    rust_lit = rust_literals(path)
    tmpl_quotes = template_quotes(path)
    hash_bound = hash_boundary(path)
    regex_lit = regex_literals(path)
    triple_lit = triple_literals(path)
    heredoc_lit = heredoc_literals(path)
    depth = 0
    tq = 0
    tsub = 0
    litend = ""
    heredoc = ""
    lno = 0
    while ((frc = (getline line < path)) > 0) {
      lno++
      if (heredoc != "") {
        if (line ~ ("^[ \t]*" heredoc "[ \t]*$")) heredoc = ""
        continue
      }
      if (depth == 0 && !tq && litend == "") {
        if (style == "hash") {
          if (index(line, "#") == 0 &&
              !(triple_lit && (index(line, DQ DQ DQ) > 0 || index(line, SQ SQ SQ) > 0)) &&
              !(heredoc_lit && index(line, "<<") > 0)) continue
        } else if (index(line, "/") == 0 &&
                   !(tmpl_quotes && index(line, BT) > 0) &&
                   !(rust_lit && index(line, DQ) > 0)) continue
      }
      text = comment_of(line, style, 0)
      # An apostrophe left open is prose rather than a string, so retry without it.
      if (text == "" && unterm) text = comment_of(line, style, 1)
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
