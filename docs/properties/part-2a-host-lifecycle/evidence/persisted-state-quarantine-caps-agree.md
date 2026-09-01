# persisted-state-quarantine-caps-agree

Scope note: the two persisted objects are the lifecycle record and the payload
generation manifest, plus the current-profile selector, which shares the
generation cap. "Generation" is the on-disk content-addressed payload generation,
not the in-process connection generation of `connection.rs`.

## Discovery trigger

A comment that asserts an equality. Reading the generation store's constant block
and following the claim to the constant it names.

## Evidence trail

Both constants, quoted at HEAD:

`crates/mc-host/src/lifecycle.rs:64-65`

```rust
/// Snapshot cap shared with the publication reader.
const MAX_EVIDENCE_BYTES: usize = 65_536;
```

`crates/mc-host/src/generation.rs:48-49`

```rust
/// Manifest and evidence read cap, matching the lifecycle evidence cap.
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
```

The claim is the words "matching the lifecycle evidence cap" at
`generation.rs:48`. The values are 65,536 and 1,048,576. The ratio is exactly 16:
1,048,576 / 65,536 = 16. The comment is false as written.

The more consequential half is what each cap gates, because the two are not
symmetric. `MAX_EVIDENCE_BYTES` has three uses, and exceeding it is conservative
at all three. In `quarantined_record_present` (`lifecycle.rs:278`) a failing or
oversize read returns `Ok(true)`, quarantined, refusing the start. In
`remove_lifecycle_record` (`lifecycle.rs:467`, read at `:482`) the same failure
returns early, so the record is not unlinked. In `read_evidence_file`
(`lifecycle.rs:803`, read at `:826`) it yields `EvidenceFile::Insecure`, which the
comment at `:812-819` explains is what stops a hostile shape from downgrading a
`wedged` verdict. Oversize means "cannot decide, so hold" everywhere.

`MAX_MANIFEST_BYTES` has four uses in `generation.rs`, and only one of them
quarantines. `is_quarantined_schema` tests `st_size` against the cap at `:957` and
returns quarantined. But `read_current` reads the current-profile selector under
the same cap at `:585`, and an over-cap read becomes
`invalid("current profile read failed")`; `validate_in_dir` reads the manifest at
`:632`, and an over-cap read becomes
`invalid("generation manifest read failed")`. Both are
`GenerationError::NativePayloadInvalid`, which
`crates/mc-module/src/bin/ck-mc-host.rs:347` maps to `native_payload_invalid`,
whose contract remediation is `reinstall_magic_context`. The fourth use is the
pre-write refusal at `:851`, which stops this release writing such a manifest at
all.

So exceeding the cap means quarantine on the lifecycle side and corrupt payload on
the two generation read paths that actually decide whether the daemon runs.

## Failure scenario

Two distinct consequences follow, and only the first is the one the catalog
states.

A future release writing a 100 KiB lifecycle record is quarantined by this
release: the gate at `lifecycle.rs:278` returns `Ok(true)` and the start is
refused with `unsupported_state_schema` and `align_versions`, which is the
intended forward-compatibility behaviour. A 100 KiB manifest sits well under
1 MiB, so it is decoded normally and is quarantined only if its schema is unknown
— a different mechanism entirely. The size threshold that is supposed to be one
value is two, and the maintainer who moves one on the comment's authority moves
only one.

The second consequence is a contradiction inside one release. A future manifest
above 1 MiB is preserved by `prune`, which classifies it undecidable at `:957`,
while `read_current` and `validate` reject it as `native_payload_invalid`. The
generation is retained on disk and unusable, and the operator is told to reinstall
the payload for a file that is intact. The same applies to the selector itself:
`current-profile.json` is read under `MAX_MANIFEST_BYTES`, so the profile's
threshold is 1 MiB while the lifecycle record's is 64 KiB, even though both are
trusted persisted selectors.

One aggravator is verified and worth naming: `MAX_MANIFEST_BYTES` is an overloaded
identifier inside `mc-host`. `crates/mc-host/src/synapse/bundle.rs:12` declares
`const MAX_MANIFEST_BYTES: u64 = 64 * 1024`, and
`crates/mc-host/src/harness_closure.rs:25` declares
`const MAX_MANIFEST_BYTES: usize = 16 * 1024 * 1024`. Three constants share one
name in one crate with values 64 KiB, 1 MiB, and 16 MiB, so "the manifest cap" is
ambiguous before the equality question is even asked.

## Timing windows and dependencies

No fault and no window; both values are compile-time constants and the whole
record is statically checkable. Depends on
`an-undecidable-quarantine-witness-fails-closed`, whose single closed arm is the
`:957` size test against this cap.

## What a test must construct

Nothing to inject. Either an equality assertion over the two constants, or —
since the two caps gate different decisions — separate assertions that an
over-cap record quarantines and an over-cap manifest quarantines on every read
path rather than only in `prune`. No test exists.

## Investigation log

### Q: None recorded in the catalog. Verified here instead: what does each cap actually gate, and is the stated consequence the real one?

- Sources examined: `lifecycle.rs:64-65`, `:257-284`, `:467-491`, `:803-830`;
  `generation.rs:48-49`, `:585`, `:632`, `:851-853`, `:956-963`;
  `crates/mc-host/src/instance.rs:852-865` for `read_all_fd`'s over-cap error;
  `ck-mc-host.rs:344-350` for the error-to-reason mapping; every workspace
  occurrence of both identifiers.
- Findings: the values and the false comment are as quoted, ratio 16. The
  asymmetry is the finding the catalog does not state: on the lifecycle side all
  three uses treat over-cap as undecidable and hold, while on the generation side
  only `prune`'s classifier does, and the two read paths that gate execution
  report corrupt payload with a reinstall remediation. `read_all_fd` returns
  `InvalidData` when the accumulated length passes the cap, so the read paths
  cannot distinguish oversize from any other read error.
- Missing evidence: none for the mismatch. Not established is which of the two
  values is the intended one, or whether the profile's threshold was ever meant
  to be the manifest's — that is a design question, not a readable fact.
- Conclusion: resolved as to fact, and broader than stated. The caps differ 16x,
  the comment asserting otherwise is false, and the two thresholds also differ in
  what exceeding them means, so making the numbers equal would not by itself make
  the property true.
