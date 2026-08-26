# @cortexkit/mc-host-linux-x64-gnu

Native `ck-mc-host` payload package for Linux x64 glibc. Installed as an
exact-version optional dependency of the Magic Context parent packages
(`@cortexkit/magic-context`, `@cortexkit/opencode-magic-context`,
`@cortexkit/pi-magic-context`). Never install or run this package directly.

## Platform floor

- Linux kernel >= 4.18, glibc >= 2.28, x64 only (musl unsupported)
- Real procfs self-fd execution (`/proc/self/fd/<n>`) is required before any
  native byte runs; below-floor hosts return `unsupported_platform`

## Payload layout

Every shipped file is listed (relative path, type, size, mode, SHA-256) in the
canonical per-target payload manifest whose digest names the staged generation.
Files not listed in the manifest are rejected.

```text
payload/
  bin/ck-mc-host                                   daemon launcher binary
  ort/libonnxruntime.so                            CPU ONNX Runtime (U9-gated slot)
  model/gte-modernbert-base-f16/model.onnx         production model (U9-gated slot)
  model/gte-modernbert-base-f16/tokenizer.json               (U9-gated slot)
  model/gte-modernbert-base-f16/tokenizer_config.json        (U9-gated slot)
  model/gte-modernbert-base-f16/special_tokens_map.json      (U9-gated slot)
  model/gte-modernbert-base-f16/config.json                  (U9-gated slot)
```

The ORT/model slots are populated only from the qualified production inputs
locked in `release/mc-host-production-inputs.lock.json`
(`production_qualified: true`). No model bytes are committed to this
repository; `bun scripts/build-mc-host-payload.ts` fails closed until release
engineering qualifies those inputs. The committed tiny test fixture and
developer caches can never qualify.

## Trust

Parent packages bundle a current-release trust index binding this package
name, exact version, target tuple, platform floor, payload-manifest digest,
and bootstrap launcher digest. Installation is filtering only (`os`/`cpu`/
`libc`); no `preinstall`/`install`/`postinstall` script exists and no network
access ever occurs at install or runtime.
