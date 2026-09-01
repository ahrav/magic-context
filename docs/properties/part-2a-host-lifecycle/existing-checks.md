# Part 2a existing-check inventory

Every claim-bearing check for `crates/mc-host/src/{lifecycle,generation,connection,frame_read,panic_boundary}.rs`
at `d90e7811`.

An existing check does not remove a property from the catalog. Every status below
is **unaudited**: test adequacy belongs to `/testing:invariant-test-review`, and
production assertion adequacy to
`/low-level-systems:defensive-assertions-and-invariant-guards`.

## The coverage fact that frames this inventory

Verified against `.github/workflows/`. `mc-host` has 26 integration test
binaries. CI names four things:

| Workflow line | Invocation |
| --- | --- |
| `ci.yml:122` | `cargo nextest run -p mc-host --lib --test shm_failure_modes --test shm_soak` |
| `ci.yml:167` | `cargo nextest run -p mc-host --test shm_transport --test transport_negotiation` (Linux) |
| `ci.yml:178` | `cargo nextest run -p mc-host --test shm_soak` (macOS) |
| `ci.yml:179` | `cargo test -p mc-host --lib` with a single filter (macOS) |
| `ci.yml:183` | `cargo test -p mc-host --doc` |

So `tests/lifecycle.rs` (36 tests, 1872 lines), `tests/activation.rs` (4), and
`tests/host_roundtrip.rs` (5) run in **no** CI job. They are the executed proof of
shutdown ordering, lock-release-after-callback, latch commit, fence overlap
refusal, and probe-across-an-incarnation. The only `--test lifecycle` match in any
workflow is `-p mc-module --test lifecycle_cli`, a different crate and file.

In-crate unit tests **are** gated through `--lib`. The macOS `--lib` step names
exactly one filter, so none of the 55 in-crate tests in this scope execute on
macOS, and a prior commit records that the `mc-host` library test target did not
compile on macOS on main.

## Integration tests

### `crates/mc-host/tests/lifecycle.rs` — 36 tests. Runs in no CI job.

Grouped by claim, since the per-test list is long:

- **Initialization ordering** (4): publication follows initialization; no
  publication while initialize blocks; an initialization timeout aborts and joins
  the callback; a returned failure prevents publication.
- **Capacity and flood** (3): saturated handshake capacity closes without reading
  client bytes; saturated connection capacity closes after authentication; an
  unauthenticated flood cannot starve established work.
- **Correlation and liveness** (2): ping and consumer correlations do not
  cross-settle; liveness is disabled by default.
- **Drain and refusal** (2): shutdown drains admitted work then says goodbye;
  shutdown refuses new routes and new routed work.
- **Callback fatality** (4): a panicking bind is cleaned before fatal shutdown; a
  hung route-gone callback is fatal rather than falsely graceful; a panicking
  route-gone callback is fatal; a close racing an in-flight bind never publishes
  the route.
- **Lock-release ordering** (8): release follows route-gone and handler drop; a
  successor starts only after release; the handler is retained past a callback
  deadline until it stops; a delayed callback runs shutdown once before the
  successor; and four variants covering abandoned runs, shutdown during
  initialization, initialization deadline expiry, and a failed initialization.
- **Shutdown commit** (6): commit after the full response then graceful stop;
  concurrent requests each settle exactly once; a dying requester cannot strand
  the stop; pipelined requests on one connection both settle; any role with the
  bearer key can shut down; authentication and shape are required.
- **Probe and fences** (4): running then stopped across an incarnation; shutdown
  during candidate setup reaps both channels; a replaced subtree cannot admit an
  overlapping incarnation; successive incarnations lock the same coordination
  inodes.

### `crates/mc-host/tests/activation.rs` — 4 tests. Runs in no CI job.

Publication precedes a blocked activation; an activation invariant failure reaches
the fatal channel with handler detail redacted; expected artifact faults degrade
only their lane; bootstrap precedes publication and activation follows it.

### `crates/mc-host/tests/host_roundtrip.rs` — 5 tests. Runs in no CI job.

The full profile composes over one connection; restart rotates credentials and
invalidates old state; concurrent clients settle independently; degraded storage
is an application error not a disconnect; a negotiated connection outlives the
candidate-setup deadline.

### `crates/mc-host/tests/transport_negotiation.rs` — 33 tests. Linux-only in CI.

Twelve codec tests (offer round-trip, ordering, documented fallback encodings,
version and name bounds, duplicate-key rejection at every depth, offer-list and
opaque-value bounds, closed field mixes, correlation and body pinning, bounded
parse-failure codes, encoder refusal of out-of-contract values) and 21 host tests.
The host half is the executed proof for most of Group A and B: exact TCP
selection; permanent absence selecting reasonless TCP; version mismatch retiring
while capability mismatch falls back; pre-negotiation traffic retiring without
side effects; repeated negotiation retiring; a stalled prepare failing inside the
deadline; terminal-then-retire on duplicate keys and malformed content; the full
grant, activate, commit, serve path; every mismatched binding field refusing
consumption; attachment failure leaving no candidate; queue admission not
promoting without local completion; a pipelined pre-promotion frame failing setup;
bootstrap liveness stopping and joining around the grant; both activation-failure
and activation-timeout paths retiring both channels; prepared candidates bounded
and released; one setup admitting one candidate; sentinel data staying off
diagnostic surfaces.

### `crates/mc-module/tests/lifecycle_cli.rs` — 12 tests. The only in-scope suite on both Linux and macOS.

Subprocess tests against the real binary, and the only executed path into the
store's staging, promotion, prune, and restart-preflight logic. Usage errors exit
without touching lifecycle state; metadata commands mutate nothing; an empty root
reports stopped and creates nothing; no staged payload fails closed; a start
failure from stopped reports both effect bits false; a held transaction lock
reports busy; a held lifetime fence with no runtime directory reports wedged; a
quarantined record is classified alike by every command; restart preflights the
successor before committing the stop (absent-path case only); a full dev-mode
roundtrip; SIGINT runs ordered teardown; a retained generation restarts after the
source payload is deleted.

### Other files touching this scope

**None found.** A search for the probe, the transaction lock, the store, the
namespace anchor, the shutdown latch, the lifetime lock, the panic boundary, and
the lifecycle phase across all crates' test directories returns only
`crates/mc-host/tests/lifecycle.rs` and `crates/mc-module/tests/lifecycle_cli.rs`.

## In-crate unit tests

Counts verified by listing: `lifecycle` 34, `generation` 18, `connection` 3,
`frame_read` **0**, `panic_boundary` **0**. All 55 run in the Linux library job;
none on macOS.

- **`lifecycle.rs`, 34 tests / 112 assertions**, in six clusters: record
  round-trip and fenced removal; strict decode (one test, ~20 assertions, covering
  unknown fields, every malformed identifier length, non-JSON, arrays, and the
  legacy empty-digest positive case); probe classification (8 tests, including
  expired and future-skewed timestamps, held-lock-with-bad-evidence, and
  crash-residue under starting versus running); coordination locks and namespace
  (8 tests, including hostile shapes at the lock names, with the FIFO sub-case
  Linux-gated); latch and commit hook (4 async tests, including the direct
  lost-wakeup unit test); hostile evidence shapes and fence coherence (9 tests).
- **`generation.rs`, 18 tests / 64 assertions**, in clusters: round-trip and
  capacity, including the fragment-size arithmetic and a predecessor manifest
  round-tripping byte-exactly; validation rejection, including noncanonical
  encodings, a symlinked directory, and the verified-descriptor position;
  quarantine and mutation refusal, including an unknown-schema occupant never
  repaired, an oversized manifest quarantined rather than pruned, and a symlinked
  directory name rejected without mutating its target.
- **`connection.rs`, 3 tests**: two shutdown-fence tests and one adjacent case.
  All hand-build a generation over a duplex pipe, so `run_connection`,
  `serve_generation`, and the read-exit match are unreachable from any in-crate
  test.

## Production assertions and guards

**Explicit `assert!` or `debug_assert!` in production paths: none found** in any
of the five files. All invariant enforcement is by `Result`-returning guards, plus
a set of `expect` and `unreachable!` that are assertions in effect.

Panicking assertions in effect, all unaudited: a runtime directory always has the
expected parent; every coordination lock name is materialized by the create path;
record, manifest, and profile serialization cannot fail; the latch mutex is not
poisoned (a poisoned latch panics *inside* the writer task); a promoted handoff
always carries its I/O task; negotiation is intercepted before control admission;
**18 mutex non-poisoning sites** across the connections, liveness, pings, and
handoff locks, where a panic under any one converts every later connection into a
panicking task; and two encode-cannot-fail sites.

Guard clusters, all unaudited: coordination-lock creation and probing; fence
acquisition; the quarantine gate; strict record decode; evidence sampling with
three separate reread budgets; the publication contract; the classification
ladder; the latch state machine; store trust with one shared root predicate;
generation validation; path and name validation; staging and promotion; storage
exhaustion mapping; prune; connection admission; close ordering; candidate setup;
negotiation; multi-span tolerance; bounded reads; panic redaction.

Two guards are silent by construction and worth naming: the manifest quarantine
check returns removable on four distinct failure modes, and the redaction
depth check falls back to *not* redacting if its thread-local is destroyed.

## Test support helpers

| Helper | Enables | Masks |
| --- | --- | --- |
| `support/mod.rs::TestHost` (948 lines) | A live in-process host on a fresh temp data root; a publication-bytes-changed startup wait; a finished-join short-circuit so init failures surface; `Drop` cancels | Every test gets a **fresh data root**, so cross-incarnation coordination is exercised by only a handful of tests. The wait keys on the publication, not the record, so no integration test observes the starting-to-running record transition or the absent-record grace window. `TestHost` never stages a generation, so **`generation.rs` is unreachable from every `mc-host` integration test**. `Drop` cancels but does not join, so post-panic teardown ordering is never asserted. |
| `support/fake_transport.rs` | An injected provider with a scripted one-shot prepare failure, a prepared-count observer, and a raw-frame candidate driver | Uses an in-process duplex stream, a **contiguous** byte stream, so it cannot produce a two-span body and the copying decode fallback has no executed check. Does not implement preflight, taking the serveable default, so the preflight unwind guard is never made to catch anything. Treats a read error as a close, so reset and orderly close are indistinguishable. |
| `support/echo_host.rs` | A real wire endpoint on its own two-worker runtime without a child process | Every callback is infallible, so no lifecycle-callback fatality path is reachable through it. Route-gone and shutdown are empty, so ordered-teardown claims cannot be made through it. |
| `support/raw_client.rs` (652 lines) | An **independent** oracle: framing, header layout, and the proof re-implemented from the protocol document rather than calling host encoders | It is a **third hand-maintained copy of the discovery contract**, alongside the transport's validator and the probe's publication summary, with nothing cross-checking the three. Two shipped defects were drift between the other two. Collapses reset and orderly close; its drain helper is budget-bounded, so a test cannot distinguish no-more-frames from budget-expired. |

## Concurrency verification tooling

**None found.** No loom, shuttle, Miri, or ThreadSanitizer configuration anywhere
in the repository.

**Correction, after portfolio evaluation.** An earlier revision of this section
claimed "every test in this scope is current-thread while production is
multi-thread". That is wrong. Multi-threaded tests do exist:
`tests/activation.rs` has four (`:143`, `:234`, `:272`, `:375`, four worker
threads each) and `tests/lifecycle.rs` has three (`:801`, `:963`, `:1779`), plus
`support/echo_host.rs` builds a two-worker runtime. What is accurate is narrower
and still worth stating: the **in-crate unit tests** in this scope are all
current-thread, including all four shutdown-latch tests and the three connection
tests, and `tests/transport_negotiation.rs` is current-thread throughout. So the
latch wake protocol, the pings reconciliation, and the drain snapshot are
exercised only under a scheduler that cannot interleave the writer task with the
read loop — but the claim does not extend to the whole suite, and three of the
multi-threaded tests are in the very file this inventory flags as ungated.

## Suspiciously quiet areas

1. `tests/lifecycle.rs`, `tests/activation.rs`, `tests/host_roundtrip.rs` — 45
   tests, ungated. The regression tests for ten repaired lifecycle defects are
   among them.
2. No in-crate lifecycle or generation test executes on macOS.
3. **`panic_boundary.rs` has zero tests of any kind.** Nothing asserts what is
   printed, that the prior hook is preserved, that the depth counter unwinds
   through a panic, or that a yielded callback cannot suppress an unrelated
   panic. Installation is once-only, so a later hook installed by another crate
   silently removes the boundary and nothing detects it.
4. **`frame_read.rs` has zero tests.** Its three loops are exercised only
   indirectly. The biased cancellation preference — one of the three properties
   its own doc calls load-bearing — is never exercised: every one of the 24
   frame-channel tests constructs a fresh token and never cancels it.
5. The body-read function's non-empty-buffer precondition is unstated and
   unchecked; a partially filled buffer silently under-reads.
6. The portable rename fallback never executes, because the flagged path always
   succeeds on Linux. That path is a check-then-act window justified only by a
   prose claim about the transaction lock.
7. The directory-exchange non-Linux, non-macOS stub is untested, and combined
   with (2) the macOS exchange path has never executed under observation.
8. Source verification has no in-crate test, and its hash-mismatch, size-mismatch,
   and type-mismatch branches have no test at any level; the one integration test
   passes a nonexistent path, so only the open-failure arm runs.
9. The umask hazard class is untested by construction: umask is process-global and
   the suite runs in parallel. Three separate commits fixed three instances of the
   same defect and no check prevents a fourth.
10. The namespace anchor has one in-crate test and no observed production driver.
11. The instance guard's field drop order is load-bearing and unasserted:
    reordering the struct fields would silently reclassify a teardown window as a
    pre-coordination incumbent.
12. The probe blocks the calling thread — up to six sleeps plus a bounded lock
    retry — and is called inline from two async test bodies. A repaired defect
    established that parking an executor thread on a lifecycle fence is a defect;
    the probe was not changed.
13. The 18 mutex sites have no poisoning check.
14. `run_connection`, `serve_generation`, and the read-exit match are unreachable
    from any in-crate test; the five-round close-disposition correction chain is
    proven only by the two ungated integration files.
15. The multi-span decode fallback never runs.
16. The preflight unwind guard never catches anything.
17. The commit hook's freeze-before-commit precondition is invisible to all four
    latch tests, which construct it with no registry.
18. `docs/AUDIT-KNOWN-ISSUES.md` contains **no** `mc-host` lifecycle, generation,
    connection, or panic-boundary entries. In beads, two related issues exist and
    are open: one recording that the transaction lock anchors no evidence
    namespace, and one recording a startup-budget flake in the ungated lifecycle
    suite.

## Two tracked issues that no longer exist

Two commits filed beads *rather than fixing* the defect they found: one for a
remaining pathname-following hazard in staging, one for matching authenticated
daemon identity to the published incarnation. Both now return no issue found, and
both were removed from the exported issue state by a backlog-realignment commit.
Either they were closed without the fix landing, or two known-open defects now
have no tracker entry and no check.
