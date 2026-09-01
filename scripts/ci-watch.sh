#!/usr/bin/env bash
#
# The watcher exits after detecting a failed job.
# The watcher classifies failures whose logs match TRANSIENT_RE as TRANSIENT.
# A failure whose log matches no transient signature is REAL.
#
#
# Usage:
# scripts/ci-watch.sh                 # newest CI run for HEAD
#   scripts/ci-watch.sh <run-id>        # a specific run
#   scripts/ci-watch.sh --sha <sha>     # newest run for a commit sha
#
# Env:
# GH_BIN     gh binary to use (default: gh). Set GH_BIN to an authentication wrapper.
#   REPO       owner/repo (default: parsed from the `origin` remote).
#   POLL_SECS  poll interval seconds (default: 15).
#
# Exit codes:
#   0  every job succeeded (or was skipped)
# 1  a failed job whose log matches no transient signature
# 2  a failed job whose log matches TRANSIENT_RE
# 3  usage or setup error

set -uo pipefail

GH_BIN="${GH_BIN:-gh}"
POLL_SECS="${POLL_SECS:-15}"

die() { echo "ci-watch: $*" >&2; exit 3; }
command -v "$GH_BIN" >/dev/null 2>&1 || die "gh binary '$GH_BIN' not found (set GH_BIN)"

if [[ -z "${REPO:-}" ]]; then
    origin_url="$(git remote get-url origin 2>/dev/null || true)"
    REPO="$(printf '%s' "$origin_url" | sed -E 's#^.*github\.com[/:]([^/]+/[^/]+?)(\.git)?$#\1#')"
fi
[[ -n "${REPO:-}" && "$REPO" == */* ]] || die "could not resolve owner/repo (set REPO=owner/repo)"

gh_json() { "$GH_BIN" "$@" -R "$REPO" 2>/dev/null; }

RUN_ID=""
if [[ "${1:-}" == "--sha" ]]; then
    [[ -n "${2:-}" ]] || die "--sha needs a commit sha"
    RUN_ID="$(gh_json run list --commit "$2" --workflow CI --limit 1 --json databaseId \
        | python3 -c 'import sys,json;r=json.load(sys.stdin);print(r[0]["databaseId"] if r else "")')"
elif [[ -n "${1:-}" ]]; then
    RUN_ID="$1"
else
    sha="$(git rev-parse HEAD)"
    # Retry six times at 5-second intervals because GitHub may not list a run immediately after a push.
    for _ in 1 2 3 4 5 6; do
        RUN_ID="$(gh_json run list --commit "$sha" --workflow CI --limit 1 --json databaseId \
            | python3 -c 'import sys,json;r=json.load(sys.stdin);print(r[0]["databaseId"] if r else "")')"
        [[ -n "$RUN_ID" ]] && break
        sleep 5
    done
fi
[[ -n "$RUN_ID" ]] || die "no CI run found (push first, or pass a run id)"

echo "ci-watch: watching run $RUN_ID on $REPO (poll ${POLL_SECS}s, fail-fast)"

TRANSIENT_RE='Fail extracting tarball|failed to download|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|503 Service|502 Bad Gateway|429 Too Many|TLS connection|SSL_ERROR|network error|The runner has received a shutdown|lost communication|Received request to deprovision|Could not resolve host|Temporary failure in name resolution|registry\.npmjs\.org.*(reset|timeout)'

dump_job_failure() {
    local job_name="$1"
    local log
    log="$("$GH_BIN" run view "$RUN_ID" -R "$REPO" --log-failed 2>/dev/null \
        | grep -F "$job_name	" | tail -60)"
    echo "──────── failing job: $job_name ────────"
    if [[ -n "$log" ]]; then
        printf '%s\n' "$log" | sed -E 's/^[^	]*	[^	]*	[0-9T:.Z-]+ ?//' | tail -40
    else
        echo "(no --log-failed output yet; check the run page)"
    fi
    echo "─────────────────────────────────────────"
    printf '%s' "$log"   # return for classification
}

while true; do
    state="$(gh_json run view "$RUN_ID" --json status,conclusion,jobs)"
    [[ -n "$state" ]] || { echo "ci-watch: transient API read miss, retrying"; sleep "$POLL_SECS"; continue; }

    # The parser emits one value per line so job names containing spaces are not split by whitespace.
    parsed="$(printf '%s' "$state" | python3 -c '
import sys,json
d=json.load(sys.stdin)
failed=""
inprog=0
for j in d.get("jobs",[]):
    c=j.get("conclusion"); s=j.get("status")
    if c=="failure" and not failed:
        failed=j["name"]
    if s in ("in_progress","queued","waiting","pending"):
        inprog+=1
print(d.get("status","") or "-")
print(failed or "-")
print(inprog)
' )"
    run_status="$(sed -n 1p <<<"$parsed")"
    failed_job="$(sed -n 2p <<<"$parsed")"
    inprogress="$(sed -n 3p <<<"$parsed")"

    if [[ "$failed_job" != "-" ]]; then
        echo ""
        echo "ci-watch: ✗ FAIL detected — $failed_job"
        joblog="$(dump_job_failure "$failed_job")"
        if printf '%s' "$joblog" | grep -qiE "$TRANSIENT_RE"; then
            echo "ci-watch: classification = TRANSIENT (retryable infra). Re-run: $GH_BIN run rerun --failed $RUN_ID -R $REPO"
            exit 2
        fi
        echo "ci-watch: classification = REAL (code/test/build). Fix before re-running."
        exit 1
    fi

    if [[ "$run_status" == "completed" ]]; then
        echo "ci-watch: ✓ all jobs passed (run $RUN_ID)"
        exit 0
    fi

    echo "ci-watch: in progress ($inprogress job(s) running)…"
    sleep "$POLL_SECS"
done
