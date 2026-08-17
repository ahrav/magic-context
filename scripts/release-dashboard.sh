#!/usr/bin/env bash
set -euo pipefail

# release-dashboard.sh — Tag and push a new dashboard release
#
# Usage:
#   ./scripts/release-dashboard.sh 0.2.2                           # release dashboard-v0.2.2
#   ./scripts/release-dashboard.sh 0.2.2 --dry                     # preview without committing/pushing
#   ./scripts/release-dashboard.sh 0.2.2 --notes-file NOTES.md     # release with notes non-interactively
#
# What it does:
#   1. Validates the version is semver
#   2. Checks for clean working tree
#   3. Bumps version in tauri.conf.json
#   4. Runs Rust check (cargo check)
#   5. Commits the version bump
#   6. Creates a git tag (dashboard-v0.2.2)
#   7. Pushes commit + tag to origin
#   8. Waits for CI to build all platforms and finish the workflow
#   9. Reads release notes from /dev/tty or --notes-file
#  10. Publishes the draft release

VERSION=""
DRY=""
NOTES_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry)
      DRY="--dry"
      shift
      ;;
    --notes-file)
      NOTES_FILE="${2:-}"
      if [[ -z "$NOTES_FILE" ]]; then
        echo "Error: --notes-file requires a path"
        exit 1
      fi
      shift 2
      ;;
    -*)
      echo "Error: unknown option '$1'"
      exit 1
      ;;
    *)
      if [[ -n "$VERSION" ]]; then
        echo "Error: unexpected argument '$1'"
        exit 1
      fi
      VERSION="$1"
      shift
      ;;
  esac
done

have_tty() {
  [[ -e /dev/tty ]] && { : </dev/tty >/dev/tty; } 2>/dev/null
}

if [[ -z "$VERSION" ]]; then
  echo "Usage: ./scripts/release-dashboard.sh <version> [--dry] [--notes-file FILE]"
  echo "  e.g. ./scripts/release-dashboard.sh 0.2.2"
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not valid semver (expected X.Y.Z)"
  exit 1
fi

if [[ -n "$NOTES_FILE" ]]; then
  if [[ ! -r "$NOTES_FILE" ]]; then
    echo "Error: notes file '$NOTES_FILE' is not readable"
    exit 1
  fi
  if ! grep -q '[^[:space:]]' "$NOTES_FILE"; then
    echo "Error: notes file '$NOTES_FILE' is empty"
    exit 1
  fi
fi

TAG="dashboard-v$VERSION"
TAURI_CONF="packages/dashboard/src-tauri/tauri.conf.json"

# Check if tag already exists
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: tag '$TAG' already exists"
  exit 1
fi

# Check for clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean — commit or stash changes first"
  git status --short
  exit 1
fi

# Check we're on main
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo "Warning: releasing from '$BRANCH' (not main)"
  # Audit Finding #9 hardening: an interactive `read -rp` here would hang
  # forever when the script is invoked without a controlling TTY (CI, nohup,
  # background task). Refuse the release explicitly in that case — the user
  # has to either switch to main or re-run from a real terminal.
  if ! have_tty; then
    echo "Error: refusing to release from non-main branch in non-interactive mode."
    echo "       Re-run from a TTY, or switch to main first."
    exit 1
  fi
  read -rp "Continue? [y/N] " confirm </dev/tty
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo ""
echo "  Releasing Magic Context Dashboard $TAG"
echo "  ───────────────────────────────────────"
echo ""

# Read current version from tauri.conf.json
CURRENT_VERSION=$(python3 -c "import json; print(json.load(open('$TAURI_CONF'))['version'])")
echo "  Current version: $CURRENT_VERSION"
echo "  New version:     $VERSION"
echo ""

# Dry run
if [[ "$DRY" == "--dry" ]]; then
  echo "[DRY RUN] Would:"
  echo "  1. Update $TAURI_CONF version to $VERSION"
  echo "  2. Run cargo check"
  echo "  3. Commit, tag $TAG, push to origin"
  echo "  4. Wait for CI and all platform builds to finish"
  if [[ -n "$NOTES_FILE" ]]; then
    echo "  5. Publish release with notes from $NOTES_FILE"
  else
    echo "  5. Prompt for release notes before publishing"
  fi
  exit 0
fi

# Step 1: Bump version in tauri.conf.json and update README download link
echo "→ Bumping version in tauri.conf.json..."
python3 -c "
import json
with open('$TAURI_CONF', 'r') as f:
    conf = json.load(f)
conf['version'] = '$VERSION'
with open('$TAURI_CONF', 'w') as f:
    json.dump(conf, f, indent=2)
    f.write('\n')
"
echo "  ✓ Updated to $VERSION"

echo "→ Updating README download link..."
sed -i '' "s|releases/tag/dashboard-v[0-9]*\.[0-9]*\.[0-9]*|releases/tag/$TAG|g" README.md
echo "  ✓ README points to $TAG"
echo ""

# Step 2: Cargo check
echo "→ Running cargo check..."
cd packages/dashboard
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 || { echo "Error: Cargo check failed"; exit 1; }
cd ../..
echo "  ✓ Rust compiles"
echo ""

# Step 3: Commit
echo "→ Committing version bump..."
git add -A
if git diff --cached --quiet; then
  echo "  (no changes — version already at $VERSION)"
else
  git commit -m "dashboard: bump version to $VERSION"
fi

# Step 4: Tag
echo "→ Creating tag $TAG..."
git tag -a "$TAG" -m "Dashboard Release $TAG"
echo ""

# Step 5: Push
echo "→ Pushing to origin..."
git push origin "$BRANCH"
git push origin "$TAG"
echo ""

echo "  ✓ Tagged and pushed $TAG"
echo "  → CI is now building all platforms"
echo "  → Watch: https://github.com/cortexkit/magic-context/actions"
echo ""

# Step 6: Wait for the Dashboard Release workflow — FAIL FAST.
#
# The build is a 6-platform matrix (fail-fast:false, so every leg runs to its
# own end). The release is only valid if the WHOLE run succeeds. The old code
# had three sequential 60-min poll loops (draft-exists → asset-count → workflow-
# conclusion) and only detected a failed leg in the LAST one — so a leg that
# died 23s in still cost ~10min of waiting behind the slow legs before the script
# noticed. Instead: poll the run's conclusion directly and ABORT THE INSTANT it
# concludes failure, regardless of how many legs are still nominally "running"
# (a concluded run means GitHub already stopped scheduling). One loop, one
# concern: did the run succeed?
echo "→ Waiting for the Dashboard Release workflow (fail-fast on any leg)..."
echo "  (checking every 15s for up to 60 minutes)"
RUN_ID=""
DEADLINE=$(( $(date +%s) + 3600 ))
while [[ $(date +%s) -lt $DEADLINE ]]; do
  RUN_INFO=$(gh run list --repo cortexkit/magic-context --workflow "Dashboard Release" --limit 20 \
    --json databaseId,status,conclusion,headBranch \
    --jq ".[] | select(.headBranch == \"$TAG\") | \"\(.databaseId) \(.status) \(.conclusion)\"" 2>/dev/null | head -n 1 || true)

  if [[ -n "$RUN_INFO" ]]; then
    read -r RUN_ID RUN_STATUS RUN_CONCLUSION <<<"$RUN_INFO"

    # Surface a failed leg the moment the run reports it, even while sibling legs
    # are still finishing — `gh run view --json jobs` shows per-leg conclusions
    # before the overall run flips to completed.
    if [[ -n "$RUN_ID" ]]; then
      FAILED_LEG=$(gh run view "$RUN_ID" --repo cortexkit/magic-context --json jobs \
        --jq '.jobs[] | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out") | .name' 2>/dev/null | head -n 1 || true)
      if [[ -n "$FAILED_LEG" ]]; then
        echo ""
        echo "  ✗ Build leg failed: $FAILED_LEG"
        echo "  → https://github.com/cortexkit/magic-context/actions/runs/$RUN_ID"
        echo "  Release NOT published. Fix the leg (or re-run it if transient), then re-run this script."
        exit 1
      fi
    fi

    if [[ "$RUN_STATUS" == "completed" ]]; then
      if [[ "$RUN_CONCLUSION" == "success" ]]; then
        echo "  ✓ Workflow completed successfully"
        break
      fi
      echo ""
      echo "  ✗ Workflow concluded: $RUN_CONCLUSION"
      echo "  → https://github.com/cortexkit/magic-context/actions/runs/$RUN_ID"
      exit 1
    fi
  fi

  printf "\r  ... %s (run %s)        " "${RUN_STATUS:-waiting for run}" "${RUN_ID:-?}"
  sleep 15
done

if [[ $(date +%s) -ge $DEADLINE ]]; then
  echo ""
  echo "  ⚠ Timed out waiting for workflow. Check CI manually."
  echo "  → https://github.com/cortexkit/magic-context/actions"
  exit 1
fi

# Sanity: the run succeeded, so every leg uploaded its asset. Confirm the count
# before publishing (a defensive check, not a wait — the run is already green).
ASSET_COUNT=$(gh release view "$TAG" --repo cortexkit/magic-context --json assets --jq '.assets | length' 2>/dev/null || echo "0")
# A full run produces 25 assets (6 platforms × installers/sigs + latest.json).
# A floor of 24 catches an architecture split (which yields ~12-14), the failure
# mode where the matrix legs landed on two separate releases. The single
# create-release job now prevents that, but keep the count as a backstop.
MIN_ASSETS=24
if [[ "$ASSET_COUNT" -lt "$MIN_ASSETS" ]]; then
  echo "  ⚠ Workflow succeeded but only $ASSET_COUNT/$MIN_ASSETS assets are attached."
  echo "  → https://github.com/cortexkit/magic-context/releases/tag/$TAG"
  exit 1
fi
echo "  ✓ $ASSET_COUNT assets attached"

# Step 9: Prompt for release notes
echo ""
NOTES=""
if [[ -n "$NOTES_FILE" ]]; then
  echo "→ Using release notes from $NOTES_FILE"
  NOTES=$(cat "$NOTES_FILE")
elif have_tty; then
  echo "→ Enter release notes (end with Ctrl-D or empty line):"
  echo "  (markdown supported)"
  echo ""
  while IFS= read -r line </dev/tty; do
    [[ -z "$line" ]] && break
    NOTES="$NOTES$line
"
  done
else
  echo "→ No tty available and no --notes-file provided."
  echo "  Skipping publish so the release is not published with empty notes."
  echo "  Run manually: gh release edit $TAG --repo cortexkit/magic-context --notes-file NOTES.md --draft=false"
  exit 0
fi

# Step 10: Publish the release
echo ""
echo "→ Publishing release..."
if [[ -n "$NOTES" ]]; then
  gh release edit "$TAG" --repo cortexkit/magic-context --draft=false --notes "$NOTES"
else
  gh release edit "$TAG" --repo cortexkit/magic-context --draft=false
fi

echo ""
echo "  ✓ Dashboard $TAG released!"
echo "  → https://github.com/cortexkit/magic-context/releases/tag/$TAG"
