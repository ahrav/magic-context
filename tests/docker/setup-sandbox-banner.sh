cat <<'BANNER'

  Magic Context: setup/doctor sandbox  (published @latest)
  =========================================================
  Project:  /test/project   (git repo)

  OpenCode setup:   magic-context setup --harness opencode
  Pi setup:         magic-context setup --harness pi
  Doctor:           magic-context doctor --harness opencode
                    magic-context doctor --harness pi
  Non-interactive:  magic-context doctor --harness opencode --force

  Verify the new CortexKit config location after setup:
    cat ~/.config/cortexkit/magic-context.jsonc          # user config
    cat /test/project/.cortexkit/magic-context.jsonc      # project config
    ls -la ~/.local/share/cortexkit/magic-context/        # shared DB + models
    cat ~/.config/opencode/opencode.json                  # plugin registration
    cat ~/.pi/agent/settings.json                          # pi extension reg.

  Versions:  magic-context --version ; opencode --version ; pi --version

BANNER
