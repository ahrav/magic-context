# every-declared-cli-reason-id-has-a-producer

Scope note: the reason ids are the CLI's closed failure vocabulary. Where the
generation store appears below, "generation" is the on-disk content-addressed
payload generation, not the connection generation of `connection.rs`.

## Discovery trigger

`remediation_for` (`crates/mc-module/src/bin/ck-mc-host.rs:86-118`) is pinned to
the release contract by a test, so every declared id has a remediation. Reading
the table for what emits each id, rather than what maps it, separates the two
questions.

## Evidence trail

The declared list is `cli.reasons.failing_by_precedence` in
`release/mc-host-release.json:71`, 31 entries. Surveying `crates/` for a Rust site
that emits each, excluding test code and excluding the `remediation_for` table
itself, splits them cleanly.

Seventeen have a Rust producer. `internal_error`, `no_data_dir`,
`unsupported_platform`, `unsupported_state_schema`, `lifecycle_busy`, and `wedged`
come from `instance_failure` (`ck-mc-host.rs:330-342`), with
`unsupported_platform` also at `:823` and `:962`. `insufficient_storage`,
`native_payload_invalid`, and `unsupported_state_schema` come from
`generation_failure` (`:344-350`), with `native_payload_invalid` also at `:899`
and `:902`. `native_payload_missing` is at `:1003` and `:1024`;
`startup_timeout` at `:714` and `:793`; `incompatible_daemon` at `:764` and
`:1309`; `not_running` at `:602`; `authentication_failed` at `:500`, `:1303`,
`:1404` and in `crates/mc-host/src/client.rs:383`; `shutdown_timeout` in
`client.rs:683-722` and `:1389`; `harness_unavailable` in
`crates/mc-host/src/broca/mod.rs:262` and `:274`; `starting` and `stopping` are
phase strings from `crates/mc-host/src/lifecycle.rs:299` and `:307`.

Fourteen appear in `crates/` only as their arm of `remediation_for` and nowhere
else: `unsupported_filesystem` (`:89`), `unsupported_install_layout` (`:91`),
`native_probe_unavailable` (`:96`), `publication_invalid` (`:98`),
`publication_stale` (`:99`), `publication_missing` (`:100`),
`unsupported_proof_version` (`:104`), `incompatible_control` (`:105`),
`incompatible_module` (`:107`), `incompatible_epochs` (`:108`),
`storage_starting` and `synapse_starting` (`:109`), `storage_unavailable`
(`:112`), and `synapse_degraded` (`:113`).

For `unsupported_filesystem` the survey was completed outside `crates/`, and it
corrects the catalog. A producer does exist, in TypeScript:
`admitLifecycleFilesystem`
(`packages/plugin/src/shared/mc-host-lifecycle/paths.ts:382-438`) returns
`reason: "unsupported_filesystem"` with `remediation: "set_data_directory"` at
`:386-390`, for a non-absolute root, an unresolvable root, a mount in
`UNSUPPORTED_FS_TYPES` (`:183` onward) or matching the `nfs`/`fuse` prefix tests
(`:424-430`), a non-local non-APFS mount on darwin (`:433`), or a `noexec` mount
(`:435-436`). `managed-policy.ts:189-202` runs it before anything is prepared, and
its comment says `preflight()` re-runs admission so "the caller still sees
`unsupported_filesystem` rather than a substitute". So the accurate statement is
that no *Rust* site produces the id, not that nothing in the workspace does.

## Failure scenario

The mis-mapping is in the Rust store, where the same physical conditions arrive
after admission has passed. Three sites turn a filesystem-capability failure into
a payload verdict.

The atomic exchange is the first. On Linux and macOS
`exchange_dirs` (`crates/mc-host/src/generation.rs:1195-1198`) maps every
`renameat_with(..., RenameFlags::EXCHANGE)` error through
`.map_err(|_| invalid("atomic digest-target exchange failed"))`, so `EINVAL`,
`ENOSYS`, and `EOPNOTSUPP` from a filesystem without `RENAME_EXCHANGE` or
`RENAME_SWAP` all become `NativePayloadInvalid`. On any other platform the cfg
arm at `:1200-1205` returns
`invalid("atomic digest-target exchange is unsupported on this platform")`,
which is the same class — though `unsupported_platform` fires earlier there, so
that arm is unlikely to be the observed reason.

The portable rename fallback is the second. `rename_no_replace` (`:1216-1242`)
handles missing `renameat2` flags gracefully: `EINVAL`, `ENOSYS`, and
`EOPNOTSUPP` fall through to an occupancy check (`:1225-1227`). But the fallback's
own `renameat` at `:1236` collapses `Err(_)` to
`invalid("generation rename failed")` at `:1240`, which is where a cross-device
`EXDEV` or a read-only-mount `EPERM` lands, and the preceding `statat` failure at
`:1234` becomes `invalid("generation target stat failed")`.

All of these are `GenerationError::NativePayloadInvalid`, which
`generation_failure` maps at `ck-mc-host.rs:347` to
`("stopped", "native_payload_invalid")`. Its remediation, per both the contract
and `remediation_for` at `:93`, is **`reinstall_magic_context`**. A user whose
payload bytes are entirely intact, and whose only problem is a data root on a
filesystem that cannot perform an atomic same-directory exchange or a same-device
rename, is told to reinstall magic-context. The precedence table makes the
substitution worse rather than neutral: `unsupported_filesystem` sits at index 2
and `native_payload_invalid` at index 6, so the correct diagnosis is also the
higher-precedence one.

## Timing windows and dependencies

No timing angle. The enabling state is structural: the exchange at `:905` is
reached only when `rename_no_replace` reported the digest name occupied (`:882`),
validation of that occupant failed (`:887`, falling to `:900`), and the digest is
not protected (`:902`). So the fault needs a corrupt unprotected occupant at the
digest name, on a filesystem lacking atomic exchange. Groups with
`current-profile-never-names-an-unvalidatable-generation`, which owns the same
promotion path.

## What a test must construct

A data root on a filesystem without `RENAME_EXCHANGE` — or an injected
`EOPNOTSUPP` at `exchange_dirs` — plus a corrupt unprotected occupant at the
digest name, asserting the emitted reason is not `native_payload_invalid`. Nothing
constructs it. The one adjacent test,
`remediation_mapping_matches_release_contract` (`ck-mc-host.rs:1753-1785`), pins
reason to remediation in both directions and skips `harness_unavailable`
explicitly; it proves the table matches the contract and says nothing about
whether any id can be emitted.

## Investigation log

### Q: None recorded in the catalog. Verified here instead: does every declared id have a producer, and what do the conditions for `unsupported_filesystem` actually map to?

- Sources examined: `release/mc-host-release.json:71` onward, all 31 entries;
  a per-id grep of `crates/` for each; `ck-mc-host.rs:86-118`, `:330-350`,
  `:1753-1785`; `generation.rs:1195-1205`, `:1216-1242`, `:876-912`;
  `packages/plugin/src/shared/mc-host-lifecycle/paths.ts:178-196`, `:355-438`;
  `managed-policy.ts:185-202`.
- Findings: 17 ids have Rust producers, 14 do not. `unsupported_filesystem` has a
  TypeScript producer at `paths.ts:388`, so the catalog's "nothing in the
  workspace produces it" is an overstatement of a true narrower claim. The
  mis-mapping is confirmed at three sites, all landing on `native_payload_invalid`
  and therefore on `reinstall_magic_context`.
- Missing evidence: the other 13 ids with no Rust producer were surveyed only
  within `crates/`. A partial sweep showed `unsupported_install_layout` and
  `native_probe_unavailable` referenced from plugin and CLI TypeScript, and the
  three `publication_*` ids appearing only in the contract, the generator script
  `scripts/generate-mc-host-release-manifest.ts:325-329`, and the generated
  `release/generated/mc-host-release-contract.rs`. I did not complete that sweep,
  so I cannot say whether those 13 are producible.
- Conclusion: partially resolved. The property is false for at least one id on
  the Rust side and the misdiagnosis is verified end to end. Whether it is false
  for the other 13, and in which language each is meant to be produced, needs the
  TypeScript half of the survey finished before any count is asserted.
