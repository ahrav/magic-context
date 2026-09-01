#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=${DRIVE_RIG_REPO_ROOT:-$(cd -- "$SCRIPT_DIR/../.." && pwd -P)}
SNAPSHOT=${DRIVE_RIG_SNAPSHOT:-"$HOME/.cache/mc-drive-rig/snapshot"}
BENCHMARKS_SOURCE=${DRIVE_RIG_BENCHMARKS:-"$HOME/Work/Projects/CortexKit/benchmarks"}
PLUGIN_DIST=${DRIVE_RIG_PLUGIN_DIST:-"$REPO_ROOT/packages/plugin/dist"}
CONNECTION_FILE=${DRIVE_RIG_CONNECTION_FILE:-"$HOME/.local/share/cortexkit/run/subc-connection.json"}
SESSION_ID=${DRIVE_RIG_SESSION_ID:-ses_OqknfoW2O3LTOcjLvOMQoREVPtz1}

require_file() {
    if [[ ! -f "$1" ]]; then
        printf 'required file is missing: %s\n' "$1" >&2
        exit 1
    fi
}
require_dir() {
    if [[ ! -d "$1" ]]; then
        printf 'required directory is missing: %s\n' "$1" >&2
        exit 1
    fi
}
require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        printf 'required command is missing: %s\n' "$1" >&2
        exit 1
    fi
}

require_command jq
require_command sqlite3
require_file "$HOME/.local/share/opencode/opencode.db"
require_file "$HOME/.local/share/cortexkit/magic-context/context.db"
require_file "$HOME/.local/share/opencode/auth.json"
require_file "$HOME/.config/cortexkit/magic-context.jsonc"
require_dir "$HOME/.config/opencode"
require_dir "$BENCHMARKS_SOURCE"
require_file "$CONNECTION_FILE"
require_dir "$PLUGIN_DIST"

rm -rf "$SNAPSHOT"
mkdir -p \
    "$SNAPSHOT/home/.local/share/opencode" \
    "$SNAPSHOT/home/.local/share/cortexkit/magic-context" \
    "$SNAPSHOT/home/.config/cortexkit" \
    "$SNAPSHOT/home/.config/opencode" \
    "$SNAPSHOT/home/.cache" \
    "$SNAPSHOT/plugin/dist"

vacuum_into() {
    local source=$1
    local destination=$2
    local escaped_destination=${destination//\'/\'\'}
    printf 'snapshotting %s\n' "$source"
    sqlite3 "$source" "PRAGMA busy_timeout=30000; VACUUM INTO '$escaped_destination';" >/dev/null
}

vacuum_into \
    "$HOME/.local/share/opencode/opencode.db" \
    "$SNAPSHOT/home/.local/share/opencode/opencode.db"
vacuum_into \
    "$HOME/.local/share/cortexkit/magic-context/context.db" \
    "$SNAPSHOT/home/.local/share/cortexkit/magic-context/context.db"

session_count=$(sqlite3 -readonly "$SNAPSHOT/home/.local/share/opencode/opencode.db" \
    "SELECT count(*) FROM session WHERE id = '$SESSION_ID';")
if [[ "$session_count" != 1 ]]; then
    printf 'required session is absent from the snapshot: %s\n' "$SESSION_ID" >&2
    exit 1
fi

cp "$HOME/.local/share/opencode/auth.json" \
    "$SNAPSHOT/home/.local/share/opencode/auth.json"
cp "$HOME/.config/cortexkit/magic-context.jsonc" \
    "$SNAPSHOT/home/.config/cortexkit/magic-context.jsonc"
cp -R "$HOME/.config/opencode/." "$SNAPSHOT/home/.config/opencode/"
if [[ -f "$HOME/.config/openrouter.key" ]]; then
    cp "$HOME/.config/openrouter.key" "$SNAPSHOT/home/.config/openrouter.key"
fi


rewrite_opencode_plugin_path() {
    local config_path=$1
    local contents
    local host_plugin_url="file://$REPO_ROOT/packages/plugin"
    contents=$(<"$config_path")
    contents=${contents//"$host_plugin_url"/"file://$SNAPSHOT/plugin"}
    contents=${contents//"$REPO_ROOT/packages/plugin"/"$SNAPSHOT/plugin"}
    printf '%s\n' "$contents" > "$config_path"
}
prune_dead_file_plugins() {
    local config_path=$1
    local config_tmp="$config_path.tmp"
    awk '
        BEGIN { in_plugins = 0 }
        /^[[:space:]]*"plugin"[[:space:]]*:[[:space:]]*\[/ { in_plugins = 1 }
        in_plugins && /file:\/\// && $0 !~ /file:\/\/\/snapshot\/plugin/ { next }
        in_plugins && /^[[:space:]]*\]/ { in_plugins = 0 }
        { print }
    ' "$config_path" > "$config_tmp"
    mv "$config_tmp" "$config_path"
}
for opencode_config in \
    "$SNAPSHOT/home/.config/opencode/opencode.json" \
    "$SNAPSHOT/home/.config/opencode/opencode.jsonc"; do
    if [[ -f "$opencode_config" ]]; then
        rewrite_opencode_plugin_path "$opencode_config"
        prune_dead_file_plugins "$opencode_config"
    fi
done

connection_tilde=$(printf '\176/.local/share/cortexkit/run/subc-connection.json')
contents=$(<"$magic_config")
contents=${contents//"$connection_tilde"/"$CONNECTION_FILE"}
printf '%s\n' "$contents" > "$magic_config"

printf 'cloning benchmark repository\n'
git clone --no-local "$BENCHMARKS_SOURCE" "$SNAPSHOT/repo" >/dev/null
if [[ -d "$BENCHMARKS_SOURCE/.cortexkit" ]]; then
    rm -rf "$SNAPSHOT/repo/.cortexkit"
    cp -R "$BENCHMARKS_SOURCE/.cortexkit" "$SNAPSHOT/repo/.cortexkit"
fi

cp -R "$PLUGIN_DIST/." "$SNAPSHOT/plugin/dist/"
plugin_version=$(jq -r '.version' "$REPO_ROOT/packages/plugin/package.json")
plugin_api_version=$(jq -r '.version' \
    "$REPO_ROOT/packages/plugin/node_modules/@opencode-ai/plugin/package.json")
jq -n --arg version "$plugin_version" --arg api "$plugin_api_version" '{
    name: "@cortexkit/opencode-magic-context",
    version: $version,
    type: "module",
    main: "dist/index.js",
    dependencies: { "@opencode-ai/plugin": $api }
}' > "$SNAPSHOT/plugin/package.json"
printf 'installing plugin runtime dependency\n'
(cd "$SNAPSHOT/plugin" && bun install --production >/dev/null 2>&1)
if [[ ! -d "$SNAPSHOT/plugin/node_modules/@opencode-ai/plugin" ]]; then
    printf 'plugin dependency install failed in %s\n' "$SNAPSHOT/plugin" >&2
    exit 1
fi

printf 'snapshot ready: %s\n' "$SNAPSHOT"
printf 'session preserved: %s\n' "$SESSION_ID"
printf 'transform config: %s\n' "$SNAPSHOT/repo/.cortexkit/magic-context.jsonc"
