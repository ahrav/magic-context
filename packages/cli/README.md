# Magic Context CLI

The `@cortexkit/magic-context` CLI configures Magic Context, checks installed
harnesses, and controls the shared `mc-host` process.

## Daemon lifecycle

```bash
npx @cortexkit/magic-context@latest daemon start
npx @cortexkit/magic-context@latest daemon status
npx @cortexkit/magic-context@latest daemon doctor
npx @cortexkit/magic-context@latest daemon restart
npx @cortexkit/magic-context@latest daemon stop
```

Add `--json` after an action to emit one `magic-context.daemon/v1` object:

```bash
npx @cortexkit/magic-context@latest daemon status --json
```

`status` and `doctor` are read-only. They do not start, stage, repair, or stop
the daemon. `restart` is one serialized lifecycle transaction, not separate
CLI stop and start calls. `stop` uses authenticated lifecycle control and does
not signal a publication PID.

Exit code `0` means the v1 result has `ok: true`. Exit code `1` means an
operational lifecycle failure. Exit code `2` means invalid CLI arguments and
does not invoke lifecycle policy.

Run `npx @cortexkit/magic-context@latest --help` for setup, doctor, migration,
and daemon command help.
