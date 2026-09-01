# rt-a-a-closure-store-open-failure-is-classified-not-swallowed

## Discovery trigger

`harness_closure.rs` is 1,122 lines, 35 percent of this sub-part's scope, and I
could not find a single constructor for `HarnessClosureStore` anywhere under
`crates/mc-host/src`. Finding the real constructor led to two call sites that
discard the error.

## Evidence trail

Zero in-crate constructors. Repository-wide search for `HarnessClosureStore`,
`ClosureCandidate`, and `ValidatedHarnessClosure` across all Rust sources
produces:

| Site | Kind |
| --- | --- |
| `crates/mc-host/src/harness_closure.rs` | the definitions |
| `crates/mc-host/src/broca/pi.rs:24`, `:49` | holds an `Arc<ValidatedHarnessClosure>` field |
| `crates/mc-host/src/broca/opencode.rs:23`, `:40` | holds an `Arc<ValidatedHarnessClosure>` field |
| `crates/mc-module/src/bin/ck_mc_host/serve.rs:162`, `:349` | **the only production `open` calls** |
| `crates/mc-host/tests/harness_closure.rs` | 10 `open` calls |
| `crates/mc-host/tests/broca_subprocess.rs:853` | 1 `open` call |
| `crates/mc-module/tests/release_contract_conformance.rs:14`, `:132` | manifest parsing only |

So `runtime::run` never touches the store. The two production sites, verified
verbatim:

`serve.rs:161-162`, inside `materialize_into_startup`:

```
let closure_root = data_dir.join("cortexkit").join("mc-host-harness-closures");
let store = HarnessClosureStore::open(&closure_root).ok();
```

`serve.rs:345-349`, inside `harness_backend`:

```
let closure_root = envelope
    .data_dir
    .join("cortexkit")
    .join("mc-host-harness-closures");
let store = HarnessClosureStore::open(&closure_root).ok();
```

Both `.ok()`. `Result<HarnessClosureStore, HarnessClosureError>` becomes
`Option<HarnessClosureStore>`, and the error is dropped.

What is discarded is specific. `HarnessClosureStore::open` (`harness_closure.rs:491-497`)
delegates to `open_or_create_store_path` (`:1019-1086`), which produces six
distinct `&'static str` reasons:

| Reason | Site |
| --- | --- |
| `"closure store path is not normalized"` | `:1044` |
| `"closure store anchor open failed"` | `:1052` |
| `"closure store directory creation failed"` | `:1067` |
| `"closure store directory open failed"` | `:1074` |
| `"closure store path traversal failed"` | `:1076` |
| `"closure store ancestor is insecure"` | `verify_safe_ancestor`, `:1095` |
| `"closure directory is not owner-only"` | `verify_owned_directory`, `:923` |

`HarnessClosureError::detail` is `pub` (`:169-171`) and `Display` renders it
(`:174-178`), so the reasons are deliberately exposed for reporting. Both call
sites throw them away.

The security checks that produce the last two are not incidental. `verify_safe_ancestor`
(`:1088-1098`) rejects any ancestor that is not a directory, not owned by the
effective uid or root, or world/group-writable without the sticky bit.
`verify_owned_directory` (`:919-926`) requires mode exactly `0o700` and the
effective uid. The whole walk uses `OFlags::NOFOLLOW` on every component
(`:1049`, `:1061`, `:1071`) so a symlinked path component fails rather than
resolving. That is a hostile-path defence, and its verdict is discarded.

Downstream, the `None` collapses into a single string. `serve.rs:344`
`harness_backend` passes `store.as_ref()` to `open_snapshot` (`:394-417`), which
does:

```
let store = store.ok_or("closure_incomplete")?;
let closure = store
    .validate(manifest_sha256)
    .map_err(|_| "closure_incomplete")?;
```

`:405` maps the absent store to `"closure_incomplete"`, and `:406-408` maps every
`validate` failure to the *same* string. `validate`
(`harness_closure.rs:571-609`) has its own distinct reasons — a digest mismatch
(`:578`), a non-canonical retained manifest (`:585`), a missing listed node
(`:597`), an unlisted entry (`:601`), plus everything `validate_manifest` and
`validate_tree` produce. All of them, plus all seven `open` reasons, arrive at
the operator as one word.

So an insecure store path and a corrupted closure are indistinguishable, even
though the two demand opposite responses: fix a permission, or re-materialize the
harness.

`serve.rs:150-153` shows the same module *does* have a validation path that
returns errors (`validate_candidate`, `validate_credentials`), and `:400` and
`:403` show `open_snapshot` itself is capable of carrying distinct strings
(`"descriptor_absent"`, and a snapshot's own `reason`). So the collapse is a local
choice, not an absence of machinery.

## Failure scenario

An operator's data root is on a path with a group-writable ancestor — a shared
`/opt` tree, or a home directory relaxed to `0o775`. Or `${dataDir}/cortexkit` is
a symlink to a volume mount, which is a routine deployment shape.

`verify_safe_ancestor` rejects at `:1095` with `"closure store ancestor is
insecure"`, or the `NOFOLLOW` open fails at `:1076` with `"closure store path
traversal failed"`. `.ok()` turns either into `None`.

`harness_backend` then finds no store, `open_snapshot` returns
`Err("closure_incomplete")` at `:405`, and the host starts with a different or
absent harness backend. What an operator sees is one word that also means
"the closure's bytes are corrupt". What is actually wrong is a filesystem
permission on a directory two levels above the one named in any message they will
read.

They will investigate the harness, the manifest, the qualification script, and
the release inputs. The one piece of evidence that would have pointed at the
permission was computed, formatted into a `&'static str`, and dropped at
`serve.rs:162`.

This is the shape Part 4f named: a malformed configuration silently resolving to
a default that disables a subsystem.

## Timing windows and dependencies

No concurrency window. `open` runs once per call, at startup, before `run`.

Both sites are on the same startup path and compute the same `closure_root` from
the same `data_dir`, so they fail identically. `serve.rs:162` additionally uses
the store for `prune` (`:175`, `let _ = store.prune(&protected)`), which is
also error-discarded, with a comment at `:163-168` explaining that pruning
reclaims superseded harness runtimes "hundreds of megabytes" each. So an
unopenable store also silently stops reclaiming disk, and `prune`'s own
`Result` is discarded a second time.

Dependency on `data_dir`: it comes from `HostConfig`-adjacent plumbing in the
binary, and `config.rs` performs no validation on `data_dir` at all. So the path
that decides whether the store opens is unvalidated at both ends.

Note the asymmetry with `runtime.rs`'s own directory handling.
`InstanceGuard::acquire` (`runtime.rs:659-673`) returns a typed
`InstanceError` that becomes `HostError::Instance`, and
`bind_owner_only` (`:836`) returns an `io::Error` that becomes `HostError::Io`.
The host runtime propagates directory failures. Only the closure store's does not.

Scope note: `serve.rs` is in `crates/mc-module`, outside this sub-part's declared
file list (`part-2-rescope/scope-map-and-risk-ranking.md:643`). I read
`:150-178`, `:340-360`, and `:394-417`, enough to establish the call shape and the
error collapse. I did not trace what `harness_backend`'s caller ultimately reports
to an operator, which is why this record's confidence is medium.

## What a test must construct

A `closure_root` whose ancestor is insecure, then an assertion that startup
reports a reason naming it.

The fixtures already exist for the sibling walk. `tests/instance_security.rs`
builds hostile-path cases against `instance.rs`'s `secure_runtime_dir`, and the
`docs/research/dry-audit-2026-08-29/mc-host-and-crates.md:254` note establishes
that `harness_closure::verify_safe_ancestor` (`:1088`) is a byte-equivalent copy
of `instance::is_safe_ancestor` (`instance.rs:774`), so the same fixture shapes
apply: a group-writable ancestor without sticky, a symlinked component, a
foreign-uid directory, and a `0o755` final directory.

Two assertions, in order of value:

1. Unit level, inside this footprint: for each of the seven reasons, construct the
   condition and assert `open` returns that exact `detail`. That is cheap and
   needs only `tempfile`. It proves the reasons are distinguishable at the source.
2. Integration level, outside this footprint: assert the reason survives to
   something an operator reads. That requires changing `serve.rs`, which is not
   this pass's business, and is why the record's confidence is medium.

The check asserts the precondition — that a distinguishable cause exists and is
carried — rather than the swallowing itself.

## Investigation log

### Q: does `harness_closure.rs` have any test module of its own?

- Sources examined: the full 1,122 lines.
- Findings: no `#[cfg(test)]` block. The file ends at `hex` (`:1114-1122`). All
  coverage is external: `crates/mc-host/tests/harness_closure.rs` (10 `open` calls,
  covering `materialize`, `validate`, `prune`, and many rejection paths) and one
  ignored test `production_closures_from_environment_materialize` driven by
  `scripts/run-mc-host-closure-qualification.ts` with three environment roots.
- Missing evidence: none.
- Conclusion: resolved with answer — well covered as a library, entirely
  unexercised as part of host startup, and its `open` failure paths are the
  uncovered part even in the library tests.

### Q: does `open_snapshot` distinguish an absent store from a failed validation?

- Sources examined: `serve.rs:394-417` in full.
- Findings: **no.** `:405` is `let store = store.ok_or("closure_incomplete")?;`
  and `:406-408` is `.validate(..).map_err(|_| "closure_incomplete")?`. Both
  produce the identical string. The function *is* capable of distinct strings —
  `"descriptor_absent"` at `:400`, the snapshot's own `reason` at `:403`,
  `"descriptor_invalid"` at `:410`, `"argument_variant_invalid"` at `:413` — so
  the collapse is deliberate at exactly these two lines.
- Missing evidence: none.
- Conclusion: resolved with answer, and it strengthens the record. The operator
  cannot distinguish an insecure store path from corrupt closure content, and the
  two demand opposite remedies.

### Q: is the discarded `prune` failure a separate property?

- Sources examined: `serve.rs:169-176`, `harness_closure.rs:554-568`.
- Findings: `:175` `let _ = store.prune(&protected)` discards a `Result`, and `prune`'s
  doc at `:548-553` says unreferenced digests "otherwise accumulate without bound
  in the user data root", each holding "an entire harness runtime (hundreds of
  megabytes)". So a silently failing prune is an unbounded-growth path.
- Missing evidence: whether any operator-visible signal exists for it elsewhere.
- Conclusion: unresolved. This is a genuinely separate property — bounded disk
  growth in the closure store — and it belongs to whoever catalogs `serve.rs`.
  Recorded here so it is not lost; not claimed as this record's scope.
