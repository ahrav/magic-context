# @cortexkit/mc-host-darwin-x64

Native `ck-mc-host` payload package for macOS x64 (macOS >= 13.5,
host-only). Installed as an exact-version optional dependency of the Magic
Context parent packages (`@cortexkit/magic-context`,
`@cortexkit/opencode-magic-context`, `@cortexkit/pi-magic-context`). Never
install or run this package directly.

## Platform floor

- macOS >= 13.5, x64 only
- `/dev/fd/<n>` retained-descriptor execution is required before any native
  byte runs; below-floor hosts return `unsupported_platform`

## Payload layout

Every shipped file is listed (relative path, type, size, mode, SHA-256) in the
canonical per-target payload manifest whose digest names the staged generation.
Files not listed in the manifest are rejected.

```text
payload/
  bin/ck-mc-host    daemon launcher binary
```

Synapse is unsupported on this target (`synapse_unsupported`): the package
contains no ONNX Runtime and no model bytes, and cannot claim Synapse ready.

## Trust

Parent packages bundle a current-release trust index binding this package
name, exact version, target tuple, platform floor, payload-manifest digest,
and bootstrap launcher digest. Installation is filtering only (`os`/`cpu`);
no `preinstall`/`install`/`postinstall` script exists and no network access
ever occurs at install or runtime.
