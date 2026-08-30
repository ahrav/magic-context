# Changelog

## Unreleased

- Made the fixed shared-memory ring mandatory for every local `mc-host` application frame. The owner-only Unix socket performs authentication, descriptor transfer, activation, and peer-lifetime observation only. Setup or runtime transport failure is terminal; TCP application transport, transport fallback, provider selection, alternate backends, and compatibility lanes are unsupported.
- Added CI architecture checks and mandatory Bun, Node, Rust, Linux, and macOS gates. Missing native support or omitted capability is a failure, not a degraded success.

Fork-specific changes are recorded in [Git history](https://github.com/ahrav/magic-context/commits/main) and [GitHub Releases](https://github.com/ahrav/magic-context/releases).

For release history predating this fork, see the [upstream releases](https://github.com/cortexkit/magic-context/releases).
