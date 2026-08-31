# the-largest-lifecycle-proof-runs-in-ci

## Discovery trigger

A coverage lens applied in reverse: instead of asking what the tests prove, ask
where they run. Every claim in Parts A through G of this catalog leans on
`tests/lifecycle.rs`, so the question is whether any workflow names it. Grepping
`.github/workflows/` for `mc-host` answers it in one pass.

## Evidence trail

`.github/workflows/` holds five files: `ci.yml` (826 lines),
`claude-code-review.yml` (39), `historian-eval.yml` (150),
`retrieval-benchmark.yml` (216), `shm-hardening-optin.yml` (81). A grep for
`cargo (test|nextest|build|check)` across all five matches only `ci.yml` and
`shm-hardening-optin.yml`; the other three contain no cargo invocation. No
workflow runs `cargo clippy`, and no workflow runs a `--workspace` test.

**Every `mc-host` test invocation in `.github/workflows/`, exhaustively:**

| Location | Job / step | Exact command |
| --- | --- | --- |
| `ci.yml:122-123` | `shm-crash-recovery`, "Crash, recovery, and soak-smoke suites", ubuntu-latest | `cargo nextest run -p mc-host --lib --test shm_failure_modes --test shm_soak` |
| `ci.yml:167-168` | `shm-source-build`, "Rust contracts and lifecycle (Linux)", `if: runner.os == 'Linux'` | `cargo nextest run -p mc-host --test shm_transport --test transport_negotiation` |
| `ci.yml:178` | `shm-source-build`, "Contracts, observer self-tests, and omission proof (macOS)", `if: runner.os == 'macOS'` | `cargo nextest run -p mc-host --test shm_soak` |
| `ci.yml:179-180` | same macOS step | `cargo test -p mc-host --lib shm_provider::tests::platform_preflight_is_side_effect_free` |
| `ci.yml:183` | `shm-source-build`, "Rust lease non-escape" | `cargo test -p mc-host --doc` |
| `shm-hardening-optin.yml:38` | `full-soak`, `workflow_dispatch` only | `cargo nextest run -P shm-soak --run-ignored ignored-only` |

That is the complete list. Two nearby lines are not test invocations:
`ci.yml:156` is `cargo build -p mc-shm-transport -p mc-host -p mc-shm-native`,
which compiles the library but no test target, and `ci.yml:157` is
`cargo build -p mc-module --bin ck-mc-host`, a different crate.

The last row names no binary, but `.config/nextest.toml:18-19` gives profile
`shm-soak` a `default-filter` of
`package(mc-host) and binary(shm_soak) and test(full_soak_cycles_conserve_resources)`,
so it reaches exactly one test inside an already-named binary, and only on manual
dispatch.

**`--test lifecycle` in the workflows.** The single substring match is
`ci.yml:161`, `cargo test -p mc-module --test lifecycle_cli`, under the step
"Native lifecycle binary contract". Different crate, different target name.
`mc-host`'s `tests/lifecycle.rs` is named nowhere.

**All 26 `mc-host` integration binaries.** `cargo metadata --no-deps` reports 26
targets of kind `test` for the package, matching the 26 `.rs` files directly under
`crates/mc-host/tests/` (`fixtures/` and `support/` are directories, not targets;
`broca_subprocess` is a target with `harness = false` per `Cargo.toml:37-39`).

| # | Binary | CI |
| --- | --- | --- |
| 1 | `activation` | unnamed |
| 2 | `broca_protocol` | unnamed |
| 3 | `broca_subprocess` | unnamed |
| 4 | `broca_supervisor` | unnamed |
| 5 | `client` | unnamed |
| 6 | `composite_routing` | unnamed |
| 7 | `dispatch` | unnamed |
| 8 | `handler_contract` | unnamed |
| 9 | `harness_closure` | unnamed |
| 10 | `host_roundtrip` | unnamed |
| 11 | `instance_security` | unnamed |
| 12 | `ipc_budget_evidence` | unnamed |
| 13 | `ipc_budget_topology` | unnamed |
| 14 | `lifecycle` | unnamed |
| 15 | `perf_budget_runner` | unnamed |
| 16 | `perf_measurement` | unnamed |
| 17 | `protocol_vectors` | unnamed |
| 18 | `routing` | unnamed |
| 19 | `shm_failure_modes` | **named** — `ci.yml:123` |
| 20 | `shm_soak` | **named** — `ci.yml:123`, `:178` |
| 21 | `shm_transport` | **named** — `ci.yml:168` |
| 22 | `synapse_bundle` | unnamed |
| 23 | `synapse_jobs` | unnamed |
| 24 | `synapse_protocol` | unnamed |
| 25 | `synapse_roundtrip` | unnamed |
| 26 | `transport_negotiation` | **named** — `ci.yml:168` |

**Exactly 4 of 26 named; exactly 22 unnamed.** The catalog's counts are correct.
The three this record turns on are `lifecycle` (36 tests, 1872 lines),
`activation` (4 tests, 410 lines), and `host_roundtrip` (5 tests, 352 lines); test
counts are `#[test]` plus `#[tokio::test]` attribute counts, and `lifecycle.rs`
contains no `#[ignore]`.

**Where the ungated suites do execute.** There is no `justfile`, `Makefile`, or
`Taskfile` in the repository. The only runner is `package.json:32`,
`"test:rust": "sh scripts/test-rust.sh"`, reachable directly or through
`package.json:47`, `"check:all"`, which chains `bun run test:rust`.
`scripts/test-rust.sh:8-13` runs `cargo nextest run --workspace` plus
`cargo test --workspace --doc` when nextest is installed, and
`cargo test --workspace` otherwise. Neither branch passes `-p` or `--test`, so
both compile and run all 26 binaries. Commit `ad52aa3b` calls
`cargo nextest run --workspace` "the local release gate". Neither `test:rust` nor
`check:all` appears in any workflow: `ci.yml:246` runs `bun run test`, which
`package.json` defines as `sh scripts/test-shard.sh packages/plugin` plus three
Bun package suites, all TypeScript. So the 22 unnamed binaries execute only on a
developer machine, on demand.

**macOS.** The only `mc-host` library invocation on macOS is `ci.yml:179-180`,
which names a single filter, so no in-crate lifecycle, generation, connection,
`frame_read`, or `panic_boundary` test runs there. Commit `ad52aa3b`,
"fix(mc-host): restore the macOS build and the synapse_perf example", records the
consequence directly: `hostile_shapes_at_the_lock_names_fail_closed` planted its
FIFO with `rustix::fs::mkfifoat`, which rustix gates away from Apple targets, so
"the test compiled only on Linux even though it carries no cfg gate", and the
commit message says public CI could not see it because "the shared-memory matrix
stopped at an earlier failure before reaching the macOS test step".

## Failure scenario

1. A change lands in `lifecycle.rs`, `connection.rs`, `dispatch.rs`, or
   `runtime.rs` that breaks shutdown ordering, lock-release ordering, the latch
   commit, fence overlap refusal, or probe-across-an-incarnation.
2. Every workflow passes. The named binaries are shared-memory and negotiation
   suites plus doc tests, and none constructs a host lifecycle.
3. The regression tests for the repaired lifecycle defects — the class
   `0fe5eba1` and `86913952` belong to — are compiled and executed by nobody in
   the pipeline.
4. Detection waits for a contributor to run `bun run test:rust` locally, or for
   the defect to surface in a shipped configuration, since Part 2a's scope is
   production code on the default TCP path.

## Timing windows and dependencies

None. This is a configuration fact about files at a fixed commit, with no fault,
no concurrency, and no enabling state. The `d90e7811` snapshot in the catalog
header remains accurate for it: HEAD has since advanced to `1c193ae0`, and
`git diff d90e7811..HEAD -- crates/mc-host .github/workflows scripts` is empty, so
every line reference above is current.

## What a test must construct

Nothing runtime. The check is a static assertion over the workflow files: parse
every `run:` block in `.github/workflows/*.yml`, collect each `--test <name>`
argument paired with `-p mc-host` (and each nextest profile's `default-filter`),
and assert that `lifecycle`, `activation`, and `host_roundtrip` appear. To make it
resistant to the substring trap that produced `lifecycle_cli`, the extraction must
key on the package argument and match target names exactly, not by containment. A
stronger form asserts the complement — that the named set equals the full
`cargo metadata` target set for the package — so a newly added binary is unnamed
loudly rather than silently. The macOS half needs a separate assertion: that at
least one in-crate test from this scope executes under `runner.os == 'macOS'`,
which today would fail against the single filter at `ci.yml:179-180`.

## Investigation log

### Q: Is the exclusion deliberate or an oversight? (needs human input)

- Sources examined: all five workflow files, `.config/nextest.toml`,
  `scripts/test-rust.sh`, `package.json` scripts, `crates/mc-host/Cargo.toml`,
  and the commit messages of `ad52aa3b`, `5a91b29f`, `e38e7894`, and `c37b9bc1`.
- Findings: the shape argues oversight rather than targeted exclusion. 22 of 26
  binaries are unnamed, and the four that are named are exactly the shared-memory
  and negotiation suites — the subject of the two workflows that exist
  (`shm-crash-recovery`, `shm-source-build`, `shm-hardening-optin`). Both jobs are
  organized around shared memory, so `mc-host` is present in CI as a shared-memory
  dependency, not as a host. No comment anywhere states that lifecycle tests are
  excluded, and `ad52aa3b`'s message treats a break invisible to public CI as a
  defect to repair rather than an accepted gap. That is evidence about intent, not
  proof of it.
- Missing evidence: no workflow comment, plan document, or commit message
  addresses `tests/lifecycle.rs` coverage. Whether the author knows the file is
  ungated is not determinable from the repository.
- Conclusion: unresolved, as the catalog records. The pattern is consistent with
  incremental CI growth around shared memory; confirming that needs the author.
