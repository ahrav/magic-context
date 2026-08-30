# mc-host release gates

`bun run release:check` is the aggregate release gate. It is the single command a
release owner runs before publishing mc-host payload and parent packages.

```
bun run release:check
```

It chains, in order:

| Sub-gate | Script | Proves |
|---|---|---|
| `test:release` | four `scripts/*.test.ts` suites | the generator, qualifier, payload builder, and evidence verifier behave |
| `release:contract:check` | `generate-mc-host-release-manifest.ts --check` | the committed release contract matches its generator, and the synchronized version is still unpublished |
| `release:evidence:schema` | `verify-mc-host-release-evidence.ts --check-schema` | the evidence schema itself is well formed before any evidence is read against it |
| `release:qualify:check` | `qualify-mc-host-production-inputs.ts --check` | the committed qualification artifacts match what the qualifier would emit now |
| `release:closures:check` | `run-mc-host-closure-qualification.ts` | each harness closure manifest still resolves against its real source tree |
| `release:payload:check` | `build-mc-host-payload.ts --check` | `release/mc-host-payload-index.json` matches the built payloads |
| `release:evidence:check` | `verify-mc-host-release-evidence.ts --check` | installed-release evidence is attested, commit-bound, and internally consistent |
| `release:smoke` | `smoke-mc-host-retained-fd.ts`, then `smoke-mc-host-cross-harness.ts` | a real daemon survives source-payload deletion, and two harness owners share one daemon across start/stop/demand-start |

`release:contract:check` and `release:evidence:schema` are part of the chain
because the contract is the single pre-build source of truth: a drifted contract
or malformed evidence schema invalidates every gate downstream of it, so neither
belongs outside the aggregate.

## Why this is not a public CI job

Every sub-gate except `test:release` needs inputs a public runner does not have,
so wiring `release:check` into `.github/workflows/ci.yml` would fail the gate for
missing inputs rather than for a real regression:

- `release:contract:check` queries the npm registry to confirm the synchronized
  version is still unpublished.
- `release:qualify:check` and `release:closures:check` hash the real OpenCode and
  Pi closure source trees. The repository carries only the manifests, not the
  hundreds of megabytes of harness binaries they describe.
- `release:payload:check` needs the compiled per-target native payloads.
- `release:evidence:check` reads `tmp/mc-host-installed-release-evidence.json`
  and calls the GitHub attestation API for the release run.
- Both smokes hard-fail on a missing input (`required()` throws) and need a
  qualified canary environment:
  `MC_HOST_CANARY_DATA_ROOT`, `MC_HOST_CANARY_LAUNCHER`,
  `MC_HOST_CANARY_OPENCODE`, `MC_HOST_CANARY_NODE`,
  `MC_HOST_CANARY_PI_ENTRYPOINT`, and, for the cross-harness smoke,
  `MC_HOST_CANARY_BROCA_MODEL` plus live Broca provider credentials in the
  environment.

`test:release` is the portion that does run on every push: `bun run test` ends in
it, so the gate scripts' own unit suites are covered by CI even though the
artifact and smoke gates are not.

## Release owner checklist

1. Provision the canary environment and export the `MC_HOST_CANARY_*` inputs.
2. Regenerate artifacts if the contract literal changed:
   `bun run release:contract` and `bun run release:qualify`.
3. Run `bun run release:check`. Treat any non-zero exit as a release blocker.
4. Keep the smoke results with the release evidence; the cross-harness smoke is
   the only gate that proves two harness owners can share one daemon, so a
   release that skips it has no evidence for that property.
