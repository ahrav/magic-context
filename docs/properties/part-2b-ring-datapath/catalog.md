# Sub-part 2b property catalog: the ring datapath in the host

Scope: the host-side ring datapath, 3,447 lines across four files.
`crates/mc-host/src/ring_transport.rs` (966 lines) owns the process-level
transport, the per-connection `DuplexRing`, the endpoint thread, and both
publication and receive loops. `wire.rs` (973) is the frame codec and the byte
budget. `frame_channel.rs` (807) is the transport-neutral channel boundary the
connection engine sees. `frame_channel/contract_tests.rs` (701) is the semantic
contract suite. All four counts were re-derived with `wc -l` at `HEAD`.

Boundary context, read but not cataloged: `connection.rs` for the prepare and
close call sites, `runtime.rs` for construction and the ingress budget,
`client.rs` for the in-process peer, and `crates/mc-shm-transport` for the ring
itself. Part 1 covers the transport crate and Part 2a the connection engine;
both are cited rather than re-derived.

**This is a post-refactor surface, and nothing had ever been cataloged against
it before.** `ring_transport.rs` is what the ring-transport refactor produced by
renaming `shm_provider.rs`, and the refactor also deleted five files. Four
commits carry it, all dated 2026-08-30 and all verified by
`git log -1` at authoring time:

| Commit | Subject |
| --- | --- |
| `0f336d3c` | `refactor(shm): collapse to fixed ring transport` |
| `d8bde128` | `feat(host): add authenticated ring setup socket` |
| `793a973e` | `build(shm): require packaged native transport` |
| `ed487e11` | `refactor(host): make ring transport mandatory` |

Provenance in [../README.md](../README.md). System
`/local/home/ahrav/scratch/magic-context`, branch
`feat/shared-memory-release-gate-audit`, `HEAD` = `e447c927`
("refactor(shm): trim final review leftovers"). Both lens agents read and
verified their line references at that commit, and this synthesis re-verified
every citation it repeats. Scope and CI findings come from
[../part-2-rescope/scope-map-and-risk-ranking.md](../part-2-rescope/scope-map-and-risk-ranking.md).

Two corrections to the lens files are carried in this catalog rather than left
in the working material, per METHOD.md rule 1.

- `Admission::quarantine` is `crates/mc-shm-transport/src/profile.rs:568`, not
  `:566`. Lens B has the correct line and lens A is off by two. The private
  `AdmissionController::quarantine` is `:522`. The finding is unaffected: a
  repository-wide search for `quarantine()` under `crates/mc-host/src` returns
  zero call sites.
- The `#[doc(hidden)]` attribute on the module sits at `lib.rs:20` (post-#131: `:17`) and
  `pub mod ring_transport` at `:21`. Both lenses noted this refinement to the
  re-scope and both are right.

## Eventfd reconciliation pass, 2026-08-31

This catalog, `fault-map.md`, and `portfolio-evaluation.md` were reconciled
against HEAD `ec0f1bbe1` after PR #131 (merge `5d638e3e8`) replaced polling
with sparse eventfd delivery. `crates/mc-host/src/ring_transport.rs` was
rewritten (966 to 1,045 lines): `POLL_INTERVAL` no longer exists in the file
(an inline test, `shared_memory_workers_have_no_periodic_polling` at
`ring_transport.rs:798-806`, now asserts its absence), the endpoint loop parks
on an eventfd doorbell (`arm_data_wait` at `:429`, readiness at `:459-471`),
and the ingress-budget wait awaits an async semaphore charge
(`ByteBudget::charge`, `wire.rs:397-407`) instead of polling `try_charge`.
`crates/mc-shm-transport/src/backend/ring.rs` was rewritten too (2,374 lines),
and `wire.rs` shrank from 973 to 937 lines. Two records were re-derived
against the new mechanics,
`ring-a-cancellation-close-requires-an-empty-inbound-observation` and
`ring-a-ingress-wait-holds-a-lease-while-servicing-egress`, and every
`ring_transport.rs:`, `ring.rs:`, and `lib.rs:` citation in this catalog and
in `evidence/` was re-verified at that HEAD, with stale numbers corrected in
place and removed constructs marked as removed. Citations to other files
(`connection.rs`, `profile.rs`, `frame_channel.rs`, `wire.rs`, `runtime.rs`,
`client.rs`, `lease.rs`, `raw_client.rs`) were not swept in this pass; PR #131
rewrote several of them, so their pre-merge line numbers are suspect and need
their own pass. The scope paragraph and refactor table above are the original
authoring-time provenance and are kept as history; the line counts they state
are pre-#131.

## What this part is about

Four facts frame every record below, and one of them is the reason this sub-part
was cataloged at all.

**Admission-quarantine accounting is owned by nothing.** This is the central
finding, and it is narrower than the claim this catalog first made. The earlier
wording, "recovery is owned by nothing", is withdrawn: it was refuted by an
independent evaluation and the refutation holds. Two recovery duties that the
broad claim swept up do have owners, and both were re-read at `HEAD` for this
correction. **Peer-death teardown** is owned by the sentinel task at
`connection.rs:195-207`: `observe_peer` returns, a non-`Goodbye` close calls
`record_peer_death()` (`:200-202`), and the generation's token and read-cancel
are both cancelled (`:203-204`). **Capacity reclamation** is owned by the
endpoint thread at `ring_transport.rs:264-277`: `admission.release()` (`:276`)
and `done_tx.send(())` (`:277`) sit outside the `catch_unwind` at `:264-275`, so
they run on every exit including a swallowed panic, and `record_reclamation()`
follows at `connection.rs:209`. The charge comes back unconditionally, which is
also this catalog's own guarantee in
[ring-a-admission-charge-releases-on-every-endpoint-thread-exit](#ring-a-admission-charge-releases-on-every-endpoint-thread-exit);
the broad claim contradicted it.

What genuinely has no owner is **admission-quarantine accounting**, and only
that. The refactor deleted `crates/mc-host/src/provider_recovery.rs` in
`ed487e11`, and `git ls-tree` over `crates/mc-host/src` at `HEAD` shows no
successor: no file whose name contains `provider` or `recovery` survives. The
transport-side machinery is intact. `Admission::quarantine` (`profile.rs:568`)
still exists and still works, and Part 1 verified its atomicity. What is gone is
anything in the host that calls it. A search for `quarantine` under
`crates/mc-host/src` returns no call to it; the only mentions are the unrelated
`LeaseTracker` flag (`frame_channel.rs:392`, `:420-433`), two unrelated
`instance.rs` doc comments (`:67`, `:250`), the diagnostics reporter that emits
the field (`ring_transport.rs:171`), and two in-crate assertions that the value
is zero (`:855`, `:880`). So host quarantined accounting is **structurally**
zero, not incidentally zero, and the two assertions that touch it pass
vacuously. Meanwhile `docs/mc-host-shm-transport.md` presents it as live in
three places: `:21` "Active and quarantined charges are reported separately",
`:65` "active and quarantined accounting", and `:79` "quarantined charges remain
within the configured process bound". The last is satisfied by having no
quarantined charges at all.

The consequence is a policy gap, not an absent owner: because
`admission.release()` at `:276` is unconditional, a connection that exited
because its ring was condemned returns its charge on exactly the same line as a
clean one, so the two cases are accounted identically and nothing distinguishes
them. Part 1 anchored `quarantine-charge-transition-is-atomic` to
`provider_recovery.rs:187`; that anchor has no replacement. Whether a condemned
ring's arena bytes should be released or retained against the process bound is
the sub-part's sharpest open question, it is a release-versus-quarantine policy
decision rather than a missing mechanism, and it needs a human. It must be
settled before the charge records can be made consistent with each other.

**A host that cannot create shared-memory objects refuses every connection while
reporting healthy.** Ring unavailability fails closed, which is the important
half and it holds: `connection.rs:149-164` is a straight-line
`let Ok(Ok(Ok(PreparedRing { .. }))) = timeout_at(..) else { return; }`, and the
`activate_server` call is at `:170`, after it. So a failed `prepare` refuses the
connection before activation and no application frame can flow. The reportability
half is where it fails. `prepare` has five `Err(RingUnavailable)` returns and
only the first touches a counter: admission rejection (`ring_transport.rs:223-226`)
increments `exhaustions`, while runtime-or-ring creation failure (`:249-255`),
descriptor marshalling failure (`:256-259`), thread-spawn failure (`:279-281`),
and initialization-channel loss (`:282`) increment nothing. `diagnostics()`
derives `state` exclusively from `self.accounting()` (`:165-179`), which reads
the admission snapshot and cannot observe a failed `prepare` at all, so it
reports `state: "healthy"` with `error_class: null`. `RingUnavailable`
(`:103-112`) is a unit struct with a fixed `Display` string and no cause field,
and the `else` branch emits no `ServerMessage`, so the peer sees only a closed
setup socket and reports the generic `setup_failed`. A host whose `/dev/shm` is
full therefore presents as a healthy host that refuses every connection for no
stated reason. That is a silent total outage of the only datapath.

**No caller retains a committed release identity.** All nine `commit` call sites
in this surface discard the `ReleaseIdentity` that
`ProducerReservation::commit` returns. The three non-test producers are
`ring_transport.rs:615`, `:628`, and `:696`; the first two are
`reservation.commit(body_len).map_err(|_| ())?`, verified by printing them. The
three inline tests (`:935`, `:985`, `:1022`) and the three integration helpers
(`tests/support/raw_client.rs:698`, `:743`, `:799`) discard it too. This was
verified independently by two passes, lens A by enumerating every `.commit(`
call in the tree and this synthesis by re-printing the six sites in
`ring_transport.rs`. The consequence is a verdict that carries over rather than
one that needs re-deriving: **Part 1's judgement that the producer-side release
hazard is latent survives the refactor.** Part 1 judged `Ring::release`'s
producer-facing form latent precisely because every non-test `commit` caller
discarded the identity. The refactor rewrote all of those callers and they still
discard it, so Part 1's `release-authority-bound-to-lease-ownership` and
`release-exactly-once-per-sequence` keep their reachability labels on the
producer side. Only the line numbers move, from `shm_provider.rs:365` to
`ring_transport.rs:615` and `:628`. See
[ring-a-no-producer-retains-a-committed-release-identity](#ring-a-no-producer-retains-a-committed-release-identity)
for the record and Part 1 for the underlying verdict.

**Reachability is `default-production`, and three signals argued otherwise.**
The re-scope left the class open because three things looked like test markers.
All three are misleading and each was resolved against code.

- The profile name `RING_PROFILE = "mc-host-test-ring-v1"`
  (`ring_transport.rs:30`) has "test" in it, but it is a descriptor field
  compared for equality at attach, and `docs/mc-host-shm-transport.md:11` names
  that exact literal as the release-fixed profile identity. It gates nothing.
- `RingClientEndpoint` is doc-commented "Thread-confined peer endpoint for
  integration tests" (`ring_transport.rs:650`). That comment is simply wrong.
  `client.rs:1855` constructs it inside `start_ring_bridge`, which
  `Client::connect_info` reaches on the ordinary connect path
  (`client.rs:346-375`), with no `cfg(test)` and no config gate.
- `lib.rs:17-18` exports the module as `#[doc(hidden)] pub mod ring_transport`.
  `#[doc(hidden)]` hides a module from rustdoc and does not restrict linkage.

What decides it is that there is no gate anywhere. `RingTransport` is
constructed unconditionally during host startup at `runtime.rs:876`, and this
synthesis printed the surrounding lines to confirm it: `process_limits` failure
becomes a hard `HostError::InitFailed` (`:872-875`) and the transport is stored
non-optionally as `HostShared.ring` (`:104`). Every authenticated connection
calls `ring.prepare(...)` at `connection.rs:148`. There is no `Option`, no
`if config`, and no alternative branch, which matches
`docs/mc-host-shm-transport.md:7`: "There is no runtime transport selector,
alternate shared-memory backend, compatibility reader, or degraded data path."

Two named sub-surfaces inside the same file are genuinely test-only, and they
are labelled where they appear rather than in a blanket claim. `PublishHook`
(`ring_transport.rs:36`, `#[doc(hidden)]` at `:35`) and `set_publish_hook`
(`:213`) are reached only through `run_with_publish_hook`
(`runtime.rs:641`, `#[doc(hidden)]` at `:640`), whose only callers are
`tests/support/mod.rs:597`, `:614`, and `:650`. One correction to lens A here:
it announced two non-default sub-surfaces but then resolved the second,
`RingClientEndpoint::try_recv_with` (`:723`), as `default-production`, because
`client.rs:1878` reaches it in production. That resolution is correct, so the
test-only surface is the publish hook and its two entry points, not two
independent surfaces. **No record in this catalog carries a `test-only` label.**
The one record that touches the hook,
[ring-a-endpoint-thread-panic-is-reported-as-orderly-completion](#ring-a-endpoint-thread-panic-is-reported-as-orderly-completion),
is `default-production` because the production `written` completion hook shares
the same unprotected window; the test-only hook is merely the cheapest way to
enter it.

One reachability limit is not resolved and is not guessed.
`RingClientEndpoint::send` and `recv` (`:684`, `:702`) are `pub` on a
`#[doc(hidden)] pub mod`, which hides them from rustdoc but not from linkage.
Only this repository was inspected, so `default-production` on records touching
them covers in-tree use only.

### Coverage: 35 in-crate tests, and a correction that adds two

**35 in-crate tests reach this sub-part. None of them runs in CI.** Every count
below was re-derived here by grepping `#[test]` and `#[tokio::test]` in the four
files at `HEAD`, and all four match lens B exactly. **Post-#131 update
(2026-08-31): `ring_transport.rs`'s inline module is now `mod tests` at
`:783-1044` and holds 9 tests** — the seven below plus
`shared_memory_workers_have_no_periodic_polling` (`:798-806`) and
`finish_wakes_after_read_cancellation_with_unread_peer_data` (`:809-846`) —
and `wire.rs`'s module moved to `:614` (the file is now 937 lines). The
wire.rs and contract-test counts were not re-derived in the eventfd pass, so
the table below is kept as the authoring-time census.

| Unit | Tests | Executed in CI |
| --- | --- | --- |
| `wire.rs`, `mod tests` at `:646-973` (post-#131: `:614-937`) | **14** | **No** |
| `frame_channel/contract_tests.rs` | **14** | **No** |
| `ring_transport.rs`, `mod tests` at `:753-966` (post-#131: `:783-1044`, **9**) | **7** | **No** |
| `frame_channel.rs` | **0** | n/a |
| **Total in-crate** | **35** | **No** |

The reason is structural rather than an omission. Every `-p mc-host` invocation
in `ci.yml` carries a `--test <name>` filter, which selects one integration
binary and never builds the lib target. The 13 `mc-host` hits are `:87`, `:132`,
`:133`, `:134`, `:168`, `:169`, `:178`, `:187`, `:190`, `:211`, `:361`, `:442`,
and `:461`, and none is an unfiltered or `--lib` run.

**One correction to the re-scope belongs here, and it changes the headline.**
The re-scope's statement that no in-crate check executes in CI is true of
`#[test]` and `#[tokio::test]` functions and false of doctests.
`cargo test -p mc-host --doc` runs at `ci.yml:190` under the step name "Rust
lease non-escape" (`:189`), and this sub-part has exactly two doctests, both
`compile_fail`, at `frame_channel.rs:296-301` and `:303-308`. Both were printed
and confirmed: they assert that `ReceiveLease` is neither `Send` nor `'static`.
**They are this sub-part's only CI-executed source-resident checks.** So the
correct statement is that no inline unit test in this sub-part runs in CI, and
two doctests do. `wire.rs:4-14` is a ```text``` fence and is not compiled.

Coverage does arrive from integration tests, indirectly. **Ten of the 24
integration binaries use `support::TestHost`, which starts a real host and
therefore a real ring, and four of the ten are named in CI.** This synthesis
re-derived the membership by testing each of the 24 for `TestHost` use, and the
result is exactly lens B's list: `client.rs` (6 tests), `lifecycle.rs` (35),
`shm_failure_modes.rs` (6), `shm_soak.rs` (2), `protocol_vectors.rs` (15),
`dispatch.rs` (20), `routing.rs` (12), `handler_contract.rs` (12),
`host_roundtrip.rs` (4), and `instance_security.rs` (15). The four named are
`client`, `lifecycle`, `shm_failure_modes`, and one of `shm_soak`'s two tests
under `--exact`. Details are in
[existing-checks.md](existing-checks.md).

## Index

Fourteen records from this sub-part's own lens passes, in the order lens A
proposed them. Lens B proposed none by design; it built the claim register and
the check inventory. **Four further records were carried into this sub-part in a
later pass**, from the superseded pre-refactor `part-2b-wire-and-channels`; they
are the last four rows and they live in
[Group G](#group-g-the-wire-header-decode-contract). Eighteen records in total.

| Slug | Type | Confidence |
| --- | --- | --- |
| [ring-a-endpoint-thread-solely-owns-both-ring-endpoints](#ring-a-endpoint-thread-solely-owns-both-ring-endpoints) | safety | high |
| [ring-a-no-producer-retains-a-committed-release-identity](#ring-a-no-producer-retains-a-committed-release-identity) | safety | high |
| [ring-a-admission-charge-releases-on-every-endpoint-thread-exit](#ring-a-admission-charge-releases-on-every-endpoint-thread-exit) | safety | high |
| [ring-a-host-never-quarantines-an-admission-charge](#ring-a-host-never-quarantines-an-admission-charge) | reachability | high |
| [ring-a-publish-failure-is-reported-as-a-clean-peer-close](#ring-a-publish-failure-is-reported-as-a-clean-peer-close) | safety | high |
| [ring-a-endpoint-thread-panic-is-reported-as-orderly-completion](#ring-a-endpoint-thread-panic-is-reported-as-orderly-completion) | safety | high |
| [ring-a-ring-unavailability-fails-closed-without-a-classified-reason](#ring-a-ring-unavailability-fails-closed-without-a-classified-reason) | safety | high |
| [ring-a-lease-release-failure-is-observable-only-on-the-success-path](#ring-a-lease-release-failure-is-observable-only-on-the-success-path) | safety | high |
| [ring-a-reclamation-count-does-not-witness-charge-release](#ring-a-reclamation-count-does-not-witness-charge-release) | safety | high |
| [ring-a-host-doctor-emits-one-of-five-declared-terminal-classes](#ring-a-host-doctor-emits-one-of-five-declared-terminal-classes) | reachability | high |
| [ring-a-rejected-drain-failure-close-has-no-producer](#ring-a-rejected-drain-failure-close-has-no-producer) | reachability | high |
| [ring-a-segmented-inbound-body-has-no-production-producer](#ring-a-segmented-inbound-body-has-no-production-producer) | reachability | high |
| [ring-a-cancellation-close-requires-an-empty-inbound-observation](#ring-a-cancellation-close-requires-an-empty-inbound-observation) | liveness | medium |
| [ring-a-ingress-wait-holds-a-lease-while-servicing-egress](#ring-a-ingress-wait-holds-a-lease-while-servicing-egress) | reachability | high |
| [decode-header-is-total-over-arbitrary-bytes](#decode-header-is-total-over-arbitrary-bytes) | safety | high |
| [accepted-header-decode-is-a-bijection-on-twenty-one-bytes](#accepted-header-decode-is-a-bijection-on-twenty-one-bytes) | safety | high |
| [reserved-encodings-and-identity-pairings-reject-at-decode](#reserved-encodings-and-identity-pairings-reject-at-decode) | safety | high |
| [encoder-never-emits-a-frame-its-own-decoder-rejects](#encoder-never-emits-a-frame-its-own-decoder-rejects) | safety | high |

The last four rows are the carried records. They keep their original unprefixed
slugs so the carry stays visible against the fourteen `ring-a-` records this
sub-part derived itself.

The six group headings below are this synthesis's own, chosen by shared
mechanism rather than by the order records were proposed. Grouping reorders the
records relative to the index; the index is the record-order artifact.

Distribution after the portfolio disposition in
[portfolio-evaluation.md](portfolio-evaluation.md): **8 safety, 5 reachability,
1 liveness**, and semantics **8 `always`, 1 `always-or-unreached`, 2
`sometimes`, 2 `reachable`, 1 `unreachable`**. `always(!X)` counts as `always`.
Two records changed under that disposition and both are recorded at the record:
the release-identity record moved from `reachability`/`unreachable` to
`safety`/`always`, and the doctor record moved from `reachable` to `sometimes`.

The four carried records add **4 safety** and semantics **4 `always`**, none of
which passed through that disposition, so the eighteen-record totals are
**12 safety, 5 reachability, 1 liveness** and **12 `always`, 1
`always-or-unreached`, 2 `sometimes`, 2 `reachable`, 1 `unreachable`**.
Reachability: all four carried records are `default-production`, verified per
record at carry time. Confidence: four high.

---

## Group A: thread confinement and the unused release identity

Two records on what the endpoint thread owns and what it throws away. The first
is the premise every other ring property rests on, that exactly one OS thread
ever touches either `Ring`. The second is the observation that the producer half
of the transport's release contract has no host caller, which is what lets
Part 1's producer-side verdict carry over unchanged. They are grouped together
because both are static ownership facts about the same thread, provable without
any fault.

### ring-a-endpoint-thread-solely-owns-both-ring-endpoints

Type: safety
Reachability: default-production — the thread is spawned by `prepare`
(`ring_transport.rs:238-240`), which every authenticated connection calls at
`connection.rs:148`; `RingTransport` is constructed unconditionally at
`runtime.rs:876` and stored non-optionally as `HostShared.ring` (`:104`), so
there is no `Option`, no `cfg`, and no config branch on this path.
Status: active
Exercised: partial — `construction_has_no_ring_side_effects`
(`ring_transport.rs:851-856`) proves the process-level owner holds no ring, and
the `RingFactory` contract suite drives a real `prepare`, but nothing asserts
that no `Ring` value is ever observed from a second thread.
Guarantee: For the whole life of one connection, exactly one OS thread ever
holds either `Ring` of its `DuplexRing`, and no ring handle, mapping pointer, or
arena reference crosses a thread boundary.
Check: `always` — for every prepared connection, the set of thread ids that
touch either `Ring` has cardinality one, and `PreparedRing` contains no field
whose type transitively owns a `Ring`. `always` fits because this is the
premise every other ring property rests on: the transport's single-producer and
single-consumer cursors are unsynchronized between peers of the same direction,
so a second local thread is immediate undefined behaviour, not a degradation.
Fault/timing angle: the window is the whole connection. The specific risk is a
future refactor returning a ring from `prepare` or storing one in
`PreparedRing`; `Ring` is `!Send`, so the compiler catches the direct move, but
a raw pointer, an index into a shared arena, or a `ReceiveLease` smuggled out
through an `unsafe` block would not be caught. `#![deny(unsafe_code)]`
(`lib.rs:5`) currently forecloses that inside `mc-host`.
Required faults and enabling state: none for the structural check. For a
runtime check, an active connection with both directions carrying traffic, so
that a second thread would actually contend.
Confidence: high — [evidence](evidence/ring-a-endpoint-thread-solely-owns-both-ring-endpoints.md).
Verified by inspection: `DuplexRing::create` at `ring_transport.rs:248` is
inside the thread closure opened at `:240`; `rings` is moved into
`run_endpoint` by value at `:265`; `PreparedRing` (`:93-101`) has seven fields
and none is a `Ring`; the only values crossing the `sync_channel` at `:231` are
a `serde_json::Value` and `[OwnedFd; RING_DESCRIPTOR_COUNT]` — six descriptors
post-#131, up from two, still no ring — sent at `:261`.
Existing check: `ring_transport.rs:851-856`
`construction_has_no_ring_side_effects` — covers the process owner only, and
does not run in CI. Status unaudited.
Impact: two threads driving one direction's cursors is a data race on the shared
control page, which the transport's `try_receive` would surface as descriptor
validation failure and quarantine at best, and as torn payload delivery at
worst.
Open questions:
- Should `PreparedRing` carry a negative marker, or a compile-fail doctest like
  the two on `frame_channel::ReceiveLease` (`frame_channel.rs:296-308`), so the
  confinement is enforced rather than reviewed?

### ring-a-no-producer-retains-a-committed-release-identity

Type: safety
Reachability: default-production — the three producer call sites are on the
host's publication path, which every activated connection runs:
`ring_transport.rs:615` and `:628` are inside `publish_one`'s helpers
`publish_direct` (`:604`) and `publish_owned` (`:619`), reached from
`run_endpoint` (`:479-484`) and from the charge wait (`:533-540`), and
`:696` is inside `RingClientEndpoint::send` (`:684`), reached in production from
`client.rs:1878` on the ordinary connect path. No `cfg` gate and no config gate
stands on any of the three. The `Ring::release` end of the property is likewise
production: `ring_release_callback` (`ring.rs:1670-1677`) runs on every lease
drop.
Status: active
Exercised: not yet — no test asserts the absence, and the value is dropped at
every call site, so observing the provenance at all needs a
`#[cfg(debug_assertions)]` counter that does not exist.
Guarantee: No host or client producer path retains the `ReleaseIdentity`
returned by `ProducerReservation::commit`, so `Ring::release` is never called
with a producer-derived identity, and the producer-side half of Part 1's
release contract stays unreachable.
Check: `always` — `always(!X)` where X is "`Ring::release` (`ring.rs:1175`) is
entered with an identity that originated from `ProducerReservation::commit`
(`ring.rs:1769`)". Discharged today by enumerating every `.commit(` site and
showing each discards its `Ok` value; optionally backed by a
`#[cfg(debug_assertions)]` counter on the producer-identity path that must stay
at zero. **This record previously claimed `unreachable`, which was wrong and is
corrected here.** `unreachable` is reserved for a code location that must never
execute, and `Ring::release` executes on every lease drop in production, through
`ring_release_callback` (`ring.rs:1670-1677`) carrying a lease-derived identity.
What the property forbids is not the location but the *provenance of an
argument* at a shared function, which is a state with no dedicated detection
point, and METHOD.md's rule for that is `always(!X)`. The type moves from
`reachability` to `safety` for the same reason: the claim is an authority
invariant on who may release a sequence, not coverage of a code point.
Fault/timing angle: none. This is a static call-graph and provenance property;
the interleaving risk it *forecloses* is a producer releasing a sequence a
consumer still holds a lease on.
Required faults and enabling state: none. The enumeration needs no fault. A
runtime form needs only the debug counter and any connection that publishes.
Confidence: high — [evidence](evidence/ring-a-no-producer-retains-a-committed-release-identity.md).
Verified by enumerating every `.commit(` call in the tree: the three non-test
producers are `ring_transport.rs:615`, `:628`, `:696`, all of which apply
`map_err(..)?` and discard the `Ok` value; the inline tests `:935`, `:985`,
`:1022` and `tests/support/raw_client.rs:698`, `:743`, `:799` also discard it;
`contract_tests.rs:567` and `:600` call the unrelated
`frame_channel::ProducerReservation::commit`, which returns `ProducedBody`. Also
re-verified for this disposition: `commit` is
`pub fn commit(mut self, body_len: usize) -> Result<ReleaseIdentity, ProducerError>`
at `ring.rs:1769`, and `ring.rs:1175` `Ring::release` is entered in production by
`ring_release_callback` at `:1670-1677`.
Existing check: none.
Impact: **Part 1's latency verdict on the producer-side release survives the
refactor.** Part 1 judged `Ring::release`'s producer-facing form latent because
every non-test `commit` caller discarded the identity. The refactor rewrote all
of those callers, and they still discard it. So Part 1's
`release-authority-bound-to-lease-ownership` and
`release-exactly-once-per-sequence` keep their reachability labels on the
producer side, and no re-anchoring of the verdict is needed — only of the line
numbers, from `shm_provider.rs:365` to `ring_transport.rs:615`/`:628`.
Open questions:
- Is the producer-side `ReleaseIdentity` return value intended to stay unused?
  If so, `#[must_use]` on `commit` is currently misleading, and the simpler
  contract would be for `commit` to return `()` and for identities to exist
  only on the consumer side. (needs human input)

---

## Group B: admission accounting with no quarantine owner

Two records on the charge that bounds how many connections the host can carry.
The first is the obligation that every exit path returns it, which rests on
`Admission`'s `Drop` for three initialization paths that never call `release()`
explicitly. The second is the central finding of the sub-part, and it is narrow:
no host path raises a quarantine, so a condemned ring returns its charge on
exactly the same line as a clean one and the documented quarantined figure is
structurally zero. Note what the second does **not** say. The charge itself has a
clear owner and it does come back; peer-death teardown has an owner too
(`connection.rs:195-207`). What is missing is the accounting distinction between
a clean recycle and a condemned one, and whether that distinction should exist is
a policy question this catalog does not settle. They share one mechanism, the
`Admission` guard moved into the thread closure at `:240`.

### ring-a-admission-charge-releases-on-every-endpoint-thread-exit

Type: safety
Reachability: default-production — `admit` (`ring_transport.rs:223`) runs on
every `prepare`, and `prepare` runs on every authenticated connection
(`connection.rs:148`). All five exit paths this record enumerates are on that
same unconditional path; none is behind a `cfg` or a config gate.
Status: active
Exercised: partial — `docs/mc-host-shm-transport.md:79` states the obligation
("Repeated peer crashes must not increase active charges after reclamation")
and `tests/shm_failure_modes` exists, but no test in the 2b file set asserts
per-exit-path charge return.
Guarantee: Every path out of the endpoint thread returns the connection's full
admission charge exactly once, including the initialization-failure paths that
exit before `run_endpoint` is entered.
Check: `always` — after the endpoint thread for a connection has terminated,
`AdmissionController::snapshot().active` has decreased by exactly
`per_connection_limits()` relative to the value just after that connection's
`admit`. `always` fits because a charge stranded on any path is monotone: the
controller has no sweeper, so the leak persists for the host's lifetime and
each occurrence permanently lowers `max_connections`.
Fault/timing angle: the interesting paths are the ones that exit *before* the
`Admission` guard is consumed at `:276`. Two return early inside the closure:
runtime or `DuplexRing::create` failure (`:249-255`) and `worker_descriptor`
failure (`:256-259`). Both drop `admission` rather than calling `release()`, so
correctness depends on `Admission`'s `Drop` (`profile.rs:581-586`; not re-swept
post-#131) which
releases when the state is still `Active`. A third path, `initialized_tx.send`
failing at `:261-263`, likewise relies on `Drop`.
Required faults and enabling state: one fault per path. `DuplexRing::create`
failure needs shared-memory object creation to fail, reachable by exhausting
`/dev/shm` or the fd limit. `worker_descriptor` failure needs
`Ring::attachment()` to fail. Thread-spawn failure (`:279-281`) exits before
`admit`'s guard leaves the caller, so it needs the guard's `Drop` on the
`prepare` side. A panic inside `run_endpoint` needs the `catch_unwind` at `:264`
to still reach `:276`.
Confidence: high — [evidence](evidence/ring-a-admission-charge-releases-on-every-endpoint-thread-exit.md).
Verified by inspection: `Admission` carries an `AdmissionState`
(`profile.rs:546-557`) and its `Drop` releases when `Active`
(`profile.rs:581-586`); the explicit `release()` at `ring_transport.rs:276` is
outside the `catch_unwind`, so a panic inside `run_endpoint` still reaches it;
`AdmissionController::release` (`profile.rs:512-520`) is a `checked_sub` that
silently no-ops on underflow, so a double release cannot go negative but also
cannot be detected.
Existing check: none in the 2b file set. `crates/mc-shm-transport/tests/contract.rs:472`
covers `Admission::release` at the transport layer. Status unaudited.
Impact: a stranded charge is permanent. Since `process_limits` multiplies the
per-connection charge by the connection count — post-#131 additionally capped
by `MAX_RING_RESIDENT_BYTES` (`ring_transport.rs:60-80`) — one
stranded connection's worth of arena bytes permanently removes one connection
slot, and the failure presents much later as `RingUnavailable` on an unrelated
connect with `state: "healthy"` in diagnostics (see
`ring-a-host-doctor-emits-one-of-five-declared-terminal-classes`).
Open questions:
- `AdmissionController::release` swallows a `checked_sub` underflow
  (`profile.rs:516-519`). Is a double release meant to be silent, or should it
  be a detectable accounting fault?

### ring-a-host-never-quarantines-an-admission-charge

Type: reachability
Reachability: default-production for the release path this record contrasts
against, and **compiled-with-no-production-caller** for the subject itself.
`admission.release()` (`ring_transport.rs:276`) runs on every endpoint exit of
every authenticated connection (`connection.rs:148`), with no gate.
`Admission::quarantine` (`profile.rs:568`) is compiled into every host build
because `mc-shm-transport` is a non-optional dependency, and it has **no caller
anywhere in `crates/mc-host/src`**, in production or in test. That is stated
here rather than defaulted: the label is neither `default-production` nor
`test-only` for the quarantine half, because the path is reachable from no host
code at all.
Status: active
Exercised: not yet — nothing in `mc-host` can construct the state, so no host
test can reach it.
Guarantee: The host's quarantined-charge accounting is structurally always
zero, because no `mc-host` path calls `Admission::quarantine`; every endpoint
exit, including one caused by ring corruption or a swallowed panic, releases the
charge as if the storage were cleanly recycled.
Check: `unreachable` — the code location `Admission::quarantine`
(`profile.rs:568`) is never entered from any `mc-host` call path.
`unreachable` fits because the subject is a specific unentered function, not a
forbidden state; the derived state claim (`snapshot().quarantined ==
ResourceCharges::ZERO` for every host process) follows from it and is the
cheaper screen. **One caveat is recorded rather than resolved.** METHOD.md
reserves `unreachable` for a *forbidden* code location, and nobody forbids
`Admission::quarantine`: `docs/mc-host-shm-transport.md:21`, `:65`, and `:79`
say it should be live. So this record is closer to a static architecture
assertion than to a forbidden-location claim, and whether such assertions belong
in this catalog at all is bias 1 in
[portfolio-evaluation.md](portfolio-evaluation.md). The independent evaluation
raised the same objection against the release-identity record and it was applied
there; it was not extended here, because that record's subject is an argument
provenance at an *executed* function and this one's is a function that never
executes. Resolving the bias decides this semantics choice.
Fault/timing angle: the window that matters is a `Corrupt` exit. When
`Ring::try_receive` fails descriptor validation it calls `enter_quarantine()`
inside the transport (`ring.rs:1098`), so the ring is terminally quarantined per
Part 1's `quarantine-authority-survives-peer-writes`. The host maps that to
`ReadClose::Corrupt` (`ring_transport.rs:499`), exits `run_endpoint` at
`:406-411`, and still calls `admission.release()` at `:276`. The process-wide
accounting therefore shows the arena bytes as free while the ring that held
them is condemned.
Required faults and enabling state: a quarantined peer-to-host ring plus an
inspection of `accounting().quarantined` afterwards. Two producers reach it, and
the second is cheaper than this record originally recorded: a
descriptor-validation failure inside `try_receive` (`ring.rs:1098`), or a peer
that calls the public `Ring::enter_quarantine` (`ring.rs:1373-1378`) directly on
the endpoint it already holds (`RingClientEndpoint.to_host` is a `pub` field,
`ring_transport.rs:651-656`). See
[ring-a-lease-release-failure-is-observable-only-on-the-success-path](#ring-a-lease-release-failure-is-observable-only-on-the-success-path).
Confidence: high — [evidence](evidence/ring-a-host-never-quarantines-an-admission-charge.md).
Verified by enumerating `Admission::quarantine` calls in the tree: the only two
are `crates/mc-shm-transport/tests/contract.rs:368` and `:479`. A `quarantine`
grep over `crates/mc-host/src` at `HEAD` returns only unrelated hits: the
`LeaseTracker` flag (`frame_channel.rs:392`, `:420-433`), two `instance.rs` doc
comments (`:67`, `:250`), and one contract test on the tracker
(`contract_tests.rs:690`). `RingTransport` holds no `Admission` value after
`prepare` returns, because the guard moved into the thread closure at `:240`.
Existing check: `ring_transport.rs:880` asserts
`accounting.quarantined.arena_bytes == 0` on a fresh transport, which is the
same value the property says can never change. A second assertion of the same
fact is at `:855`. Status unaudited.
Impact: the quarantine accounting that
`docs/mc-host-shm-transport.md:21`, `:65`, and `:79` present as a live safety
mechanism is inert on the host. Because the mapping is genuinely unmapped when
`run_endpoint` drops the `DuplexRing`, releasing the charge is arguably correct
and the doc is what is wrong; but the two readings differ on whether a
quarantined ring's arena bytes should be retained against the process bound,
and only a human can settle which was intended. This is the
release-versus-quarantine policy question, and it is bias 2 in
[portfolio-evaluation.md](portfolio-evaluation.md); it must be settled before
this record and
[ring-a-admission-charge-releases-on-every-endpoint-thread-exit](#ring-a-admission-charge-releases-on-every-endpoint-thread-exit)
can both be right, because one requires the charge to come back on every exit
and the other asks whether a condemned ring is an exception.
Open questions:
- Was host-side quarantine accounting deliberately dropped with
  `provider_recovery.rs`, or lost? Part 1's
  `quarantine-charge-transition-is-atomic` cited
  `provider_recovery.rs:187` as its host-side driver, and that file has no
  successor. (needs human input)

---

## Group C: failure attribution on every exit path

Three records on what the host tells the connection engine when the transport
itself fails. A publication failure arrives as a clean peer EOF, an endpoint
panic arrives as orderly completion, and a failed `prepare` arrives as nothing
at all. Each is a distinct mechanism reaching the same shape: a host-caused
fault indexed as something else, or as silence. Grouped because all three turn
on the erasure of a cause that existed at the failure site.

### ring-a-publish-failure-is-reported-as-a-clean-peer-close

Type: safety
Reachability: default-production — `publish_one` (`ring_transport.rs:560`) is
called from `run_endpoint` (`:479-484`) and from the charge wait (`:533-540`),
both on the endpoint thread every authenticated connection runs
(`connection.rs:148`). `ShmReceiver::recv`'s `CleanEof` mapping (`:354`) and its
consumer (`connection.rs:401-404`) are on the same ungated path.
Status: active
Exercised: not yet — needs an outbound publication that fails while the
connection is otherwise healthy, plus an assertion on the resulting close
disposition rather than on liveness.
Guarantee: An outbound publication failure is reported to the connection engine
with a close cause distinct from a clean peer EOF, so a host-side transport
fault is never attributed to the peer.
Check: `always` — whenever `publish_one` returns `Err`, the cause delivered on
the inbound channel is not `ReadClose::CleanEof`. `always` fits because the
close disposition is a total function of the cause (Part 2a,
`close-disposition-is-a-total-function-of-the-read-exit-cause`) and a
misclassified cause silently selects the wrong teardown every time it occurs.
Fault/timing angle: no interleaving is needed; the misreport is the
straight-line behaviour. `run_endpoint:479-484` cancels `queue.retired` and
`root` and returns without sending on `inbound`. Dropping the sender closes the
channel, and `ShmReceiver::recv` maps a closed channel to
`Err(ReadClose::CleanEof)` (`:354`), which `connection.rs:401-404` maps to
`ReadExit::Peer` — a silent retirement with no terminals and no Goodbye
(`connection.rs:309-315`). The one exception is a publish failure raised from
inside the charge wait, which does return a distinguishable cause,
`ReadClose::Corrupt("shared-memory publish failed")` (`:535-537`). So the same
fault classifies two different ways depending on which loop observed it.
Required faults and enabling state: an outbound publish failure. Four
mechanisms reach it: reservation deadline expiry under a full host-to-peer ring
(`reserve_until`, `ring.rs:980`, deadline exits at `:989`, `:1005`, `:1024`,
`:1044`), a wire-header/length disagreement rejected by
`commit_reservation` (`ring.rs:1577-1593`), a panic in the direct serializer
caught at `:584-587`, and `ReservationWriter` exhaustion (`:635-643`). The
cheapest to construct is a peer that attaches and then never receives, filling
the host-to-peer ring until `reserve_until` hits its deadline.
Confidence: high — [evidence](evidence/ring-a-publish-failure-is-reported-as-a-clean-peer-close.md).
Verified by inspection: `publish_one` returns `Result<(), ()>` (`:560-565`), so
every distinct cause is erased to a unit before `run_endpoint` sees it; the
`:479-484` block sends nothing; `:354` is the only `CleanEof` producer in the
crate; `connection.rs:401` is the only `CleanEof` consumer.
Existing check: none. `connection.rs:401-404` is the consuming match, not a
check.
Impact: two consequences. Operationally, a host-side ring fault is indexed as a
peer disconnect, so the diagnostics counters and any operator narrative blame
the client. Protocol-wise, `ReadExit::Peer` retires silently and discards the
queued frames (`connection.rs:315-318`), which is the correct handling for a
peer-caused close but means a host-caused close also produces no terminal, so
every pending correlation becomes `outcome_unknown` with no recorded reason.
Open questions:
- Should `publish_one` carry a cause enum rather than `()`? The information
  exists at each of the four failure sites and is discarded at `:588-590`.
- Is the asymmetry between `:535-537` (`Corrupt`) and `:479-484` (`CleanEof`)
  for the identical fault deliberate? (needs human input)

### ring-a-endpoint-thread-panic-is-reported-as-orderly-completion

Type: safety
Reachability: default-production — the unprotected window at
`ring_transport.rs:587-600` is entered on every publication, and the hook that
runs inside it at `:598` is the production `written` completion hook supplied
through `frame_channel.rs:630` by `dispatch.rs`. The `PublishHook` at `:594` is
test-only (reached only via `run_with_publish_hook`, `runtime.rs:641`, whose
callers are `tests/support/mod.rs:597`, `:614`, `:650`), and it is named here as
the cheapest injection point rather than as the record's subject.
Status: active
Exercised: not yet — needs an induced panic on the endpoint thread. The publish
hook (`test-only`) is the cheapest injection point, but the property is about
the production `written` hook too.
Guarantee: A panic that escapes `run_endpoint` is distinguishable by the
connection engine from an orderly endpoint exit, and the frame it was
publishing is not left recorded as complete.
Check: `always-or-unreached` — if the outer `catch_unwind` at
`ring_transport.rs:264` observes `Err`, then the connection observes a cause
other than a clean completion, and no `QueuedOutboundFrame` remains in state
`COMPLETE` without having reached the ring. `always-or-unreached` fits because
a panic on this thread is an optional path that a correct build never takes, but
it must be safe when it does; `always` would overstate a requirement that the
path be exercised.
Fault/timing angle: the exposed window is between `:587` and `:600`. The inner
`catch_unwind` protects only the reserve-fill-commit block. A panic in the
publish hook (`:594`), or in the `written` local-completion hook (`:598`),
unwinds `publish_one` and `run_endpoint`, is swallowed by `let _ =` at `:264`,
and then `admission.release()` (`:276`) and `done_tx.send(())` (`:277`) run
exactly as on an orderly exit. Neither `queue.retired` nor `root` is cancelled,
so `FrameSender::send_ticket_before` keeps admitting frames until its own
admission timeout fires (`frame_channel.rs:742-750`), and the `io` future
completes successfully, which `connection.rs:347` reads as a clean join. A
second, narrower window: a panic inside `on_publish()` (`frame_channel.rs:653-655`)
leaves the ticket state at `PUBLISHED` with the frame never written, so a
later `FrameSendTicket::cancel` returns `PossibleSend` for a frame that was
provably not sent, contradicting
`docs/mc-host-wire-protocol.md:60`.
Required faults and enabling state: a panicking hook. `written` is the
production one; `dispatch.rs` supplies it through `OutboundFrame::written`
(`frame_channel.rs:630`). Part 2a owns writer-hook panics on the writer task
(`no-writer-hook-panic-poisons-a-generation-lock`); this is the ring thread, a
different owner, and the panic there has no boundary at all.
Confidence: high — [evidence](evidence/ring-a-endpoint-thread-panic-is-reported-as-orderly-completion.md).
Verified by inspection: `:264` discards the `catch_unwind` result; the inner
`catch_unwind` closes at `:587`; `:591` stores `COMPLETE` before the hooks run
at `:592-598`; `panic_boundary::redact_sync` wraps only the direct serializer
(`:610-613`) and not the hooks.
Existing check: none for the ring thread. `panic_boundary.rs` is Part 2a scope.
Impact: the host loses its only transport thread and reports success. Frames
admitted after the panic sit in the queue until each hits its admission
deadline, so the connection degrades over `frame_deadline` per frame rather than
retiring, and diagnostics records nothing at all: no `peer_death`, no
`exhaustion`, and `state: "healthy"`.
Open questions:
- Should `:591`'s `COMPLETE` store move after the hooks, or should the hooks
  move inside the inner `catch_unwind`? The two answers differ on whether a
  hook panic should retire the connection.

### ring-a-ring-unavailability-fails-closed-without-a-classified-reason

Type: safety
Reachability: default-production — all five `Err(RingUnavailable)` returns are
inside `prepare` (`ring_transport.rs:217-303`), which every authenticated
connection calls at `connection.rs:148`, and the refusal is consumed by the
straight-line `let ... else` at `connection.rs:149-164`. `diagnostics()`
(`:142-196`) is reached from the daemon's own status surface with no gate.
Status: active
Exercised: partial — the exhaustion sub-case is covered by
`docs/mc-host-shm-transport.md:79`'s stated gate and is counted at
`ring_transport.rs:224`; the other four causes are uncounted and untested.
Guarantee: When the ring cannot be prepared the host refuses the connection
before any application frame can flow, and the refusal is attributable to a
cause rather than presenting as an unexplained socket close.
Check: `always` — for every `prepare` returning `Err(RingUnavailable)`, no
`activate_server` runs on that connection, and exactly one host-observable
record names the cause. The first clause is the fail-closed half and holds; the
second is the reportability half and is where the property is expected to fail.
`always` fits because there is no fallback path to degrade onto: after the
refactor, `docs/mc-host-shm-transport.md:7` makes ring failure terminal for the
connection, so every occurrence must be attributable or the operator has no
signal at all.
Fault/timing angle: none for the fail-closed half; `connection.rs:149-164` is a
straight-line `let ... else { return; }` placed before the
`activate_server` call at `connection.rs:170`. The reportability half has a
timing wrinkle: `connection.rs:158-164` wraps `prepare` in `timeout_at`, and
`spawn_blocking` work cannot be cancelled, so on timeout the blocking task
continues, `prepare` succeeds, and the resulting `PreparedRing` is dropped
inside the blocking task. Dropping a `CancellationToken` does not cancel it, so
teardown falls to the mpsc-closure path at `:455-458`, and that path is only reached
through the `select!`, which requires `receive_one` to have returned
`Ok(false)`.
Required faults and enabling state: one fault per cause. Admission exhaustion
needs `max_connections` concurrent live rings. `DuplexRing::create` failure
needs shared-memory creation to fail. `worker_descriptor` failure needs
`Ring::attachment()` to fail. Thread-spawn failure needs the thread limit.
`initialized_rx.recv` failure needs the endpoint thread to die between spawn and
handshake. The timeout path needs `prepare` to exceed
`transport_setup_deadline`.
Confidence: high — [evidence](evidence/ring-a-ring-unavailability-fails-closed-without-a-classified-reason.md).
Verified by inspection: `RingUnavailable` (`:103-112`) is a unit struct with a
fixed `Display` string and no cause field; only `:224` increments a counter;
`connection.rs:149-164`'s `else` branch is a bare `return` that emits no
`ServerMessage`, so the peer observes a closed setup socket and
`activate_client` (`client.rs:367`) reports the generic
`ClientError::new("setup_failed", ...)` at `client.rs:368`.
Existing check: `ring_transport.rs:884` asserts
`diagnostics["exhaustion"]["observed"] == 0` on a transport with no admissions. Nothing
covers the other four causes. Status unaudited.
Impact: the host fails closed, which is the important half and holds. But four
of five causes are invisible: a host that cannot create shared-memory objects at
all refuses every connection while reporting `state: "healthy"` with all five
counters at zero, and the client sees only `setup_failed`. That is a silent
total outage of the only datapath.
Open questions:
- Should `RingUnavailable` carry a closed cause class matching the doctor's
  five terminal classes (`docs/mc-host-shm-transport.md:53-59`)?
- On the `prepare` timeout path, should the connection task cancel the ring it
  abandoned? It currently relies on sender-drop, which the `received == true`
  branch can defer (see
  `ring-a-cancellation-close-requires-an-empty-inbound-observation`).

---

## Group D: what diagnostics can and cannot witness

Two records on the observability surface an operator actually reads. The first
is a counter that can advance before the thing it is read as proving has
happened. The second is a five-class terminal taxonomy that the host does not
own at all: the classes are synthesized client-side from an observed error, and
the host's own `diagnostics()` cannot leave `state: "healthy"` on any condition
short of a poisoned mutex. Grouped because both are read as `diagnostics()`
claims, and because together they explain why the failures in Group C leave no
trace.

### ring-a-reclamation-count-does-not-witness-charge-release

Type: safety
Reachability: default-production — `record_reclamation` (`connection.rs:209`)
runs at the end of every `run_connection`, and the early return that skips the
`io_task` await (`:273-276`) is on the ordinary drain path, reached whenever
`shared.draining` is set or `shared.shutdown` is cancelled. Both are shipped
states, not configured ones.
Status: active
Exercised: not yet — needs a connection that retires while the host is already
draining, plus a read of `accounting()` at the moment the counter increments.
Guarantee: The `reclamation.completed` value that `diagnostics()` reports is
never larger than the number of connections whose admission charge has actually
been returned.
Check: `always` — at every observation, `diagnostics()["reclamation"]["completed"]`
is at most the number of endpoint threads that have executed
`admission.release()`. `always` fits because the counter is a monotone
diagnostic: a single premature increment permanently overstates reclamation, and
`docs/mc-host-shm-transport.md:79` makes "active charges after reclamation" a
release gate, so an operator reading the count as a witness of release draws a
false conclusion.
Fault/timing angle: the ordering holds on the normal path and breaks on one
early return. Normally `serve_generation` awaits `io_task` at
`connection.rs:347`; `io` is `done_rx.await` (`ring_transport.rs:286-288`) and
`done_tx.send(())` runs at `:277`, after `admission.release()` at `:276`. So
`record_reclamation` at `connection.rs:209` follows the release. But
`connection.rs:273-276` returns from `serve_generation` without awaiting
`io_task`, and `io_task` is an `AbortOnDropHandle` (`connection.rs:190`), so the
awaiting task is aborted. Control returns to `connection.rs:209`, which
increments the counter while the endpoint thread may still be running. The
window is bounded only by how long `run_endpoint` takes to observe
`writer.discard()` (`connection.rs:353` via
`discard_unregistered_generation`), which the `received == true` branch can
defer indefinitely.
Required faults and enabling state: a connection that reaches
`serve_generation` and finds `shared.draining` already set or
`shared.shutdown` already cancelled — that is, a connection accepted and
authenticated during the shutdown sequence.
Confidence: high — [evidence](evidence/ring-a-reclamation-count-does-not-witness-charge-release.md).
Verified by inspection: `connection.rs:208-209` places `record_reclamation`
after the `serve_generation` await, and an inner `return` at `:275` still
returns there; `AbortOnDropHandle` aborts on drop; `ring_transport.rs:276-277`
orders release before the done signal.
Existing check: `ring_transport.rs:883` asserts
`diagnostics["reclamation"]["completed"] == 1` after a direct
`record_reclamation()` call, which exercises the counter and not the ordering.
Status unaudited.
Impact: the exact metric a release gate would read as proof that charges came
back can be incremented before they did. The gate would pass on a host that is
in fact still holding the charge.
Open questions:
- Should `record_reclamation` move onto the endpoint thread, immediately after
  `admission.release()`, so the counter is release-witnessed by construction?

### ring-a-host-doctor-emits-one-of-five-declared-terminal-classes

Type: reachability
Reachability: default-production for the host counters and the healthy arm; the
terminal classification itself is **client-side production code**, not host
code. `diagnostics()` (`ring_transport.rs:142-196`) is ungated, and the plugin
path that classifies is `packages/plugin/src/shared/mc-host-client/shared-memory-failure.ts:10-30`
reached from `packages/plugin/src/shared/mc-host-lifecycle/policy.ts:648-672`,
neither behind a flag. See the `Check:` line for why that relocates the whole
record.
Status: active
Exercised: partial — `ring_transport.rs:867-868` asserts the healthy shape end
to end; no campaign drives the doctor to a terminal outcome in any of the five
classes.
Guarantee: A campaign reaches at least one end-to-end `daemon doctor` outcome in
each declared terminal class, so the five-class taxonomy the operator contract
promises is a set of situations that actually occur rather than a set of names.
Check: `sometimes` — at least once per campaign, for each of `missing_addon`,
`identity_mismatch`, `setup_failure`, `peer_death`, and `resource_exhaustion`,
observe a completed `daemon doctor` report whose `shared_memory.error_class`
equals that class, produced by the real classification path from a real host or
addon condition rather than by constructing the value. **This record previously
claimed `reachable` over "five distinct emission points" in the host, and both
the boundary and the semantics were wrong.** There are no five host emission
points to reach, and there never were: the terminal report is synthesized
**client-side**. `classifySharedMemoryFailure`
(`packages/plugin/src/shared/mc-host-client/shared-memory-failure.ts:10-30`) maps
an observed error into `SharedMemoryTerminalClass` (`types.ts:68-73`), and
`policy.ts:648-672` feeds that into `terminalSharedMemoryDiagnostics`
(`policy.ts:854-872`), which builds the entire terminal object including
`error_class`, `bounds`, `peer_death`, and `exhaustion` without consulting the
host at all. Exactly one of the five literals exists in Rust, `"setup_failure"`
at `ring_transport.rs:176`, and it is the host's own poisoned-mutex arm rather
than a member of the client taxonomy. So `reachable` was location coverage over
locations that do not exist. The five classes are **situations** — an addon that
will not load, an identity that does not match, a setup that failed, a peer that
died, a resource that ran out — and METHOD.md's rule is that situation coverage
is `sometimes`. Reaching the classifier's lines proves nothing: a campaign can
execute `classifySharedMemoryFailure` on a constructed error and never produce
the operational state the class names, which is exactly what the existing
TypeScript coverage does.
Fault/timing angle: none for the classification itself, which is a total
function on an observed error. The window that matters is per class: each needs
its own host or addon condition to exist while the doctor runs.
Required faults and enabling state: one condition per class, and they do not
share a mechanism. `missing_addon` needs a load that fails to find the packaged
addon, which is 2c's S6 and is structurally suppressed in CI by `ci.yml:193`'s
`build:source`. `identity_mismatch` needs a `connect_setup` failure carrying
that message. PR #131 split `mc-shm-native`'s `lib.rs` into `lifecycle`,
`napi_buffers`, `scheduling`, and `setup` modules; the pre-merge citation
`lib.rs:579-587` now lands in `RingGrant` decode code, and the identity check
lives at `packages/mc-shm-native/src/setup.rs:229`, with the message itself
built at `setup.rs:413-416`. `setup_failure` is the classifier's default arm and is
reachable from any other native startup failure. `peer_death` needs an `ECONNRESET`, `EPIPE`, or unexpected-EOF error
from a peer that died, which the coarse kill harness already produces. And
`resource_exhaustion` needs a `memory_cap` code or a capacity message, which
admission exhaustion produces at `ring_transport.rs:223-226`.
Confidence: high — [evidence](evidence/ring-a-host-doctor-emits-one-of-five-declared-terminal-classes.md).
Verified by grepping the five literals across `crates` and `packages` and then
reading the client path end to end for this disposition: `"setup_failure"`
appears in Rust only at `ring_transport.rs:176`; the other four appear only in
TypeScript, at
`packages/plugin/src/shared/mc-host-client/types.ts:68-73` and
`shared-memory-failure.ts:14-30`. `policy.ts:669-671` calls
`terminalSharedMemoryDiagnostics(classifySharedMemoryFailure(error))`, and
`terminalSharedMemoryDiagnostics` (`policy.ts:854-872`) hard-codes `state:
"terminal"`, zeroes `bounds`, sets `accounting: null`, and derives
`peer_death.observed` and `exhaustion.observed` from the class it was handed. So
the terminal shape is not a host projection at all. `peer_death` and
`resource_exhaustion` do exist host-side, but only as counters
(`ring_transport.rs:191`, `:193`), and `state` stays `"healthy"` while
`exhaustion.observed` is non-zero because the host `match` keys on
`accounting()` alone.
Existing check: `ring_transport.rs:859-897` covers the host's healthy branch and
its lifecycle counters — four post-#131, since `record_attachment` and the
`attachment` field were removed with the eventfd rewrite — and it is a
host-side check that cannot reach the client
taxonomy at all. On the client side,
`packages/plugin/src/shared/mc-host-client/shm-frame-channel.test.ts:47-58`
`shared-memory failures collapse to five terminal diagnostic classes` reaches
all five classes, but every one of its nine cases is a hand-constructed `new
NativeStartupError(...)` or `new Error(...)` (`:49-57`) rather than a produced
condition, so it is location coverage of the classifier and not situation
coverage of the classes. Status unaudited.
Impact: `docs/mc-host-shm-transport.md:53-59` promises the operator a five-class
terminal taxonomy from `magic-context daemon doctor`. That contract is real and
it is met by the client, not by the host, and this record's earlier framing —
that four of five producers "do not exist at all" — was an artifact of looking
for them in Rust. What remains true and matters is narrower: a host that has
refused every connection for capacity, or lost every endpoint thread to a hook
panic, still reports `state: "healthy"` from `diagnostics()`, so the client's
classifier only ever sees a terminal condition when its *own* call fails. A host
that is unhealthy but still answering produces no terminal class from either
side.
Open questions:
- The five-class taxonomy is the client's, and the doc attributes it to
  `magic-context daemon doctor`. Should the host's `diagnostics()` also derive a
  class from its own counters, so an unhealthy-but-answering host is
  classifiable? Today `state` keys on `accounting()` alone
  (`ring_transport.rs:165-179`) and no counter can move it. (needs human input)

---

## Group E: the inbound loop, its lease, and its cancellation bound

Three records on `receive_one` and the loop that drives it. One is the
asymmetry that a lease-release failure is reported only on the paths that go on
to deliver a frame. One is the bound on how long a cancelled generation keeps
consuming. One is the operational state in which a held lease and an outbound
publication coincide, which is the enabling state for the other two. Grouped
because all three live inside the same `:380-533` region and the third is a
precondition of the first.

### ring-a-lease-release-failure-is-observable-only-on-the-success-path

Type: safety
Reachability: default-production — `receive_one` (`ring_transport.rs:487`) runs
on the endpoint thread of every authenticated connection, and all five
lease-holding return points (`:509`, `:525`, `:531`, `:539`, `:548`) are on that
ungated path. `ReceiveLease::Drop` (`lease.rs:201-206` post-#131) is likewise
unconditional.
Status: active
Exercised: not yet — needs a `release` that fails, which needs a quarantined or
identity-mismatched ring while a lease is held. **Constructible today**; see
`Required faults` for the mechanism, which this record originally recorded as
unavailable.
Guarantee: A receive-lease completion failure is reported on every inbound path
that holds a lease, not only on the paths that go on to deliver a frame.
Check: `always` — for every `receive_one` invocation that acquired a lease, if
the underlying `Ring::release` returns `Err` then the invocation returns a
`ReadClose` other than the cause it would have returned had the release
succeeded. `always` fits because a lease that fails to release does not free
its slot, so the loss is cumulative against `max_leases` = 8
(profile-pinned post-#131; asserted at `ring_transport.rs:904`) and eight
silent failures wedge the direction.
Fault/timing angle: the two explicit release calls (`:507-509` for the oversize
rejection and `:546-548` on the delivery path) map `Err` to
`ReadClose::Corrupt("shared-memory completion failed")`. The three early
returns that hold a lease do not: `Cancelled` at `:525`, `Overloaded` at
`:531`, and `Cancelled` at `:539` all drop the lease, and
`ReceiveLease::Drop` (`crates/mc-shm-transport/src/lease.rs:201-206`) calls
`release_once` and discards its `Result`. So exactly the paths taken under
cancellation and overload — the paths most likely to coincide with a stressed or
quarantined ring — are the ones that cannot report a completion failure.
Required faults and enabling state: a held lease **and** a release failure.
`Ring::release` returns `Err` on quarantine (`ring.rs:1176-1178`), wrong incarnation
(`:1179-1181`), wrong lane (`:1182-1184`), stale sequence (`:1193-1196`), and duplicate
release (`lease.rs:186`). **Quarantine is reachable directly from the peer, and
this record previously said it was not.** The original text required "a peer that
publishes a malformed descriptor" so `try_receive` would quarantine from inside
the transport, and recorded that as unavailable. It is not the only route.
`Ring::enter_quarantine` is a **public** method (`ring.rs:1373-1378`, in
`crates/mc-shm-transport/src/backend/ring.rs`) that stores the flag on the shared
lifecycle page, and a peer already holds the ring it needs: `RingClientEndpoint`
exposes `to_host` and `from_host` as `pub` fields (`ring_transport.rs:651-656`),
and the existing fixture at `tests/support/raw_client.rs` attaches one and
already reaches through those fields (`:691`, `:738`, `:781`). So the whole fault
is `endpoint.to_host.enter_quarantine()` from the test peer, one line, no seam
and no malformed producer. `Ring::release` checks `is_quarantined()` before any
other validation (`ring.rs:1176-1178`), so the host's next release on that
direction fails. Held-lease timing still needs the ingress-wait state below: park
the host inside the budget wait with a lease held, quarantine from the peer, then
let the wait exit on `Cancelled` or `Overloaded`.
Confidence: high — [evidence](evidence/ring-a-lease-release-failure-is-observable-only-on-the-success-path.md).
Verified by inspection: `receive_one`'s return points that follow a
successful `try_receive` are `:509`, `:516`, `:525`, `:531`, `:536`, `:539`,
`:545`, `:548`, `:556`, `:557`; of those, only `:509` and `:548` route a release
error;
`lease.rs:201-206` discards the drop-path `Result` with `let _ =`. Re-verified
for this disposition: `pub fn enter_quarantine(&self)` at `ring.rs:1373` writes
`quarantined` on the lifecycle page with `Ordering::Release`, `is_quarantined`
reads it with `Ordering::Acquire` (`:1381-1388`), and both directions of one
duplex pair map the same object, so the peer's store is visible to the host's
consumer.
Existing check: `crates/mc-shm-transport/tests/ring.rs:240`
`quarantine_rejects_all_operations_and_reports_conservation` covers the
transport-side `Err(Quarantined)` from `release`, not the host's handling of it.
Status unaudited.
Impact: this is the host-side counterpart of Part 1's
`release-failure-is-observable`, which Part 1 marked `medium` confidence with
its host anchor at `shm_provider.rs:365`. That anchor is gone; the surviving
host behaviour is the asymmetry above. Scoped correctly after investigation: all
three untracked paths return an `Err(ReadClose::..)` that ends the read loop
(`:406-411`), so a silent release failure always coincides with the connection
retiring and cannot accumulate across its life. What is lost is the signal that
the ring was quarantined rather than merely overloaded, and that matters because
`ReadClose::Overloaded`'s own doc comment (`frame_channel.rs:40-43`) asserts
"the peer and the transport are healthy" — false on a quarantined ring. Today
`connection.rs:401-404` collapses `Corrupt` and `Overloaded` into the same
`ReadExit::Peer`, so the gap is latent and becomes live only if that taxonomy is
split.
Open questions:
- Should the `Overloaded` and `Cancelled` paths release explicitly and upgrade a
  release failure to `Corrupt`? Investigation found this buys nothing until
  `connection.rs:401-404` stops collapsing the two causes into one `ReadExit`,
  so the two changes travel together or not at all.
- A peer can condemn the shared ring unilaterally through the public
  `Ring::enter_quarantine` (`ring.rs:1373`) while the host holds a lease. Is that
  intended peer authority, or should quarantine be host-initiated only? It is the
  cheapest route to this record's fault and simultaneously a capability the
  threat model may not want. (needs human input)

### ring-a-cancellation-close-requires-an-empty-inbound-observation

Type: liveness
Reachability: default-production — the `received == true` branch
(`ring_transport.rs:415-421`) and the `select!` at `:441-474` are the endpoint
loop every authenticated connection runs, and `read_cancel` is a child token of
the generation root created in `prepare` (`:227-228`) for every connection.
`frame_deadline` (`config.rs:165`, 30 seconds) ships with a default.
Status: active
Exercised: partial — `budget_wait_observes_read_cancellation`
(`ring_transport.rs:1008-1043`) covers cancellation observed *inside* the
ingress-charge wait, which is the one path that does not need an empty
observation, and the post-#131 test
`finish_wakes_after_read_cancellation_with_unread_peer_data` (`:809-846`)
drives the main loop's report once: it cancels `read_cancel` on an empty ring,
asserts the receiver observes `Err(ReadClose::Cancelled)`, then proves the
finishing loop still wakes with unread peer data. Neither asserts the
frame-count drain bound under sustained traffic.
Guarantee: After the generation is cancelled and the peer stops publishing, the
endpoint thread reports `ReadClose::Cancelled` and exits within a bounded number
of further inbound frames, provided the connection task is still draining the
inbound channel.
Check: `always` — evaluated at the end of an explicit bounded window: run
sustained inbound traffic, cancel `read_cancel`, **stop the peer's publication
and let the peer-to-host ring drain**, then poll until the endpoint thread has
exited. Assert two bounds, both counted in frames rather than in wall-clock
time. First, the thread performs at most `N + 1` further `receive_one`
invocations, where `N` is the number of frames the peer committed before the
cancellation edge: each committed frame costs one `Ok(true)` pass through
`:415-421`, and the first empty observation returns `Ok(false)` and reaches the
`read_cancel` check at `:400`, which takes the `inbound` sender (`:401`) and
sends `Cancelled` (`:402`). Second, no frame committed *after* the cancellation
edge is forwarded on the inbound channel. `always` rather than `sometimes`
because the assertion is a bound that must hold every time the window closes,
not a state to reach.
**Re-derived 2026-08-31 against the eventfd transport (PR #131), which removed
`POLL_INTERVAL`.** The polling-era record had already withdrawn its invented
wall-clock bound; the rewrite makes the frame-count unit the only honest one
left, because the empty-ring wait is now event-driven rather than periodic.
`frame_deadline` still bounds exactly one thing inside `receive_one`, now the
charge wait: `let deadline = Instant::now() + frame_deadline` at `:519` is
consumed by the `sleep_until` arm at `:527-532`, exiting `Overloaded` at
`:531`. It bounds nothing else in the loop. The cancellation report itself is
still an unbounded await: `:402` does
`inbound.send(Err(ReadClose::Cancelled)).await` on a bounded `mpsc` channel of
`queue_frames` capacity (`:230`), and if the connection task is not draining,
that send parks with no deadline. The rejection and frame-delivery sends at
`:510-515` and `:551-556` have the same shape. So the residual wall-clock
question is unchanged by the rewrite and stays recorded as unresolved in the
open questions.
Fault/timing angle: the drain-before-report design survived the rewrite. The
`received == true` branch (`:415-421`) checks neither `discard`, `finish`,
`root`, nor `read_cancel`; `read_cancel` is observed in exactly three places:
the `Ok(false)` branch (`:400-404`), the biased `select!` arm at `:448-454`
(whose comment restates the intent: re-enter the receive path once, drain
frames committed before the cancellation edge, then report `Cancelled` "after
the first empty observation"), and the charge wait inside `receive_one`
(`:525`). The consequence is unchanged: a peer that keeps the peer-to-host ring
non-empty defers the cancellation report for as long as it keeps publishing.
What the rewrite changed is the empty-ring wait. Instead of sleeping
`POLL_INTERVAL`, the loop arms the transport's wake protocol
(`rings.second.arm_data_wait()` at `:429`, `ring.rs:828-854`) and parks on the
duplicated doorbell descriptor (`duplicate_data_ready` wrapped in an `AsyncFd`
at `:371-380`; the `readiness.readable()` arm at `:459-471` clears readiness
and calls `complete_data_wait`). The wake protocol is the new timing surface:
`arm_data_wait` publishes a parked epoch and re-checks data availability before
returning `true`, and the producer's `signal_wake` (`ring.rs:1418-1432`) rings
the doorbell only when a parked epoch is visible, so a frame committed between
the host's arm and its park is delivered by the doorbell rather than lost. A
lost or racing wake would not defer the cancellation *report* — the
`read_cancel.cancelled()` arm is a `CancellationToken`, not an eventfd, and the
post-cancellation drain calls `try_receive` directly (`:496-498`) — but it
would strand committed pre-cancellation frames the drain contract says to
deliver. That failure mode is new with #131 and is covered in the evidence
file's failure scenario.
Required faults and enabling state: an attached peer publishing continuously,
enough ingress budget that each `charge` future (`:520-521`) resolves
immediately, and a cancellation of `root` or `read_cancel` from the host side
while that traffic continues. `connection.rs:183-189`'s peer-death handler is
one natural trigger, since it cancels `peer_gen.token` — the ring's `root` —
while frames may still be queued in the ring. Closing the window additionally
needs the peer to stop publishing, which is a fixture choice, and the
connection task to keep draining, which is the assumption the bound is
conditional on.
Confidence: medium — [evidence](evidence/ring-a-cancellation-close-requires-an-empty-inbound-observation.md).
The code structure is verified by inspection at post-#131 HEAD and the intent
is stated in the comment at `:449-453`. Re-verified for this pass:
`frame_deadline` is consumed only at `:519` and `:527-532` inside `receive_one`
and at `publish_one`'s own reservation deadline (`:583`), and all three
`inbound.send(..).await` sites (`:402`, `:510-515`, `:551-556`) are
undeadlined. What I did not verify is the exact behaviour of `read_loop` under
cancellation, so I cannot state whether the host reliably stops draining and
closes the inbound channel promptly; that is why this is medium and not high,
and it is the first open question below.
Existing check: `ring_transport.rs:1008-1043`
`budget_wait_observes_read_cancellation` covers the charge-wait path, and
`:809-846` `finish_wakes_after_read_cancellation_with_unread_peer_data` covers
the empty-ring report plus the post-cancellation finishing wake. `mc-host`
inline tests do not run in CI. Status unaudited.
Impact: a cancelled generation's endpoint thread can keep consuming and
forwarding peer frames after the close decision. Since the charge is released
only when the thread exits (`:276`), a peer that floods during teardown extends
the window in which a retiring connection still holds its full admission
charge, which is exactly the pressure that turns an ordinary retirement into
`RingUnavailable` for the next connect.
Open questions:
- Does `read_loop` stop draining the inbound channel promptly on
  `read_cancel`, closing the channel and bounding this window? That is in
  Part 2a's `connection.rs` scope and I did not resolve it. Until it is resolved,
  the case where the channel neither closes nor drains has **no bound at all**:
  the `Cancelled` report parks on `inbound.send(..).await` at `:402`. That
  residual is recorded as unresolved rather than given a wall-clock stand-in.
- Should the `received == true` branch check `root.is_cancelled()`, at the cost
  of dropping frames the current comment deliberately drains?
- Should the three `inbound.send(..).await` sites carry a deadline, so a report
  cannot outlive the generation that produced it? Today only the charge wait is
  deadlined (`:519`, `:527-532`).


### ring-a-ingress-wait-holds-a-lease-while-servicing-egress

Type: reachability
Reachability: default-production — the charge wait
(`ring_transport.rs:519-542`) is entered whenever `ingress.charge(header.len)`
(`:520`) cannot resolve immediately against the process-wide `ByteBudget` built
at `runtime.rs:761-767` and cloned into every connection at
`connection.rs:113`. The budget is derived from `max_resident_bytes` with
shipped defaults, so no opt-in is needed to reach the wait; sustained ingress
pressure is sufficient.
Status: active
Exercised: not yet — no test holds a lease across a saturated ingress budget
while an outbound frame is published from inside that wait.
Guarantee: The state in which one receive lease is held across a saturated
ingress-budget wait while the same loop publishes a queued outbound frame occurs
at least once.
Check: `sometimes` — at least once per campaign, observe both preconditions
jointly: `receive_one` is parked inside the charge `select!` at `:522-542`,
meaning a lease is held (bound at `:496-501`) and the `charge` future
(`:520-521`) has been polled pending at least once; and the publish arm at
`:533-540` executed during that same invocation. `sometimes` rather than
`reachable` because executing those lines is not the point: a campaign can run
the charge-wait branch and the publish-from-wait branch in separate invocations
without ever producing the operational state in which they coincide. Per the
METHOD coverage rule this asserts the independent preconditions, not a
violation, so the marker still fires on a correct implementation.
**Re-derived 2026-08-31 against the eventfd transport (PR #131), which removed
`POLL_INTERVAL`.** The wait is no longer a 50-microsecond poll loop over
`try_charge`: `ByteBudget::charge` (`wire.rs:397-407`) queues on a tokio
semaphore and resolves when another holder's `ByteCharge` drops, so the wait
parks instead of spinning, and the third polling-era precondition (covering the
`POLL_INTERVAL` sleep on a second, empty-queue iteration) no longer exists.
Fault/timing angle: this is the state where the ingress budget and the outbound
deadline interact. The ingress budget is process-wide, a single `ByteBudget`
built at `runtime.rs:761-767` from `config.limits.max_resident_bytes` minus the
egress, scratch, catalog, and retained reservations, and cloned into every
connection at `connection.rs:113`, so pressure originating elsewhere in the
host stalls this receive. The `select!` at `:522-542` is biased: `read_cancel`
first (`:525`, exiting `Cancelled`), then the `charge` future, then the
absolute deadline (`:527-532`, `sleep_until` on the `Instant` taken at `:519`,
exiting `Overloaded` at `:531`), then queued outbound frames through
`queue.recv()` (`:533-540`), whose publish failure exits
`Corrupt("shared-memory publish failed")` at `:536`. The polling-era comment
that justified servicing egress from inside the wait was removed with the
rewrite; the surviving statement of the same intent is `run_endpoint`'s
alternation comment at `:416-420`. Scoped after investigation: an earlier draft
also required `active_leases == max_leases` on the peer-to-host direction. That
is unreachable and the clause is dropped. `receive_one` holds at most one lease
at a time, every return path releases or drops it, and `run_endpoint` calls
`receive_one` serially, so the host's contribution to `active_leases` is
bounded by one against a budget of eight — pinned post-#131 by the profile
rather than by file-local constants, and asserted by
`ring_profile_pins_per_connection_grant_geometry` (`:901-907`).
Required faults and enabling state: an ingress budget too small for the frame
in hand, so the `charge` future stays pending; and at least one queued outbound
frame while it is pending, so `:533-540` runs. No fault at all: both are
fixture parameters.
Confidence: high — [evidence](evidence/ring-a-ingress-wait-holds-a-lease-while-servicing-egress.md).
Verified by inspection at post-#131 HEAD: the lease is bound at `:496-501` and
not released until `:546-548`, so it is live for the whole `:519-542` wait; the
publish-from-wait arm is `:533-540`; the deadline exit is `:527-532`;
`run_endpoint` calls `receive_one` serially at `:386-397`, and every
`receive_one` return path releases or drops its lease.
Existing check: two inline tests are each one precondition short.
`copied_control_frame_records_one_host_adapter_copy` (`:961-1005`) uses
`ByteBudget::new(1024)` (`:994`), so the charge resolves immediately and the
wait is never entered. `budget_wait_observes_read_cancellation` (`:1008-1043`)
uses `ByteBudget::new(0)` (`:1028`) and does park in the wait, but its sender
queue is empty (`:1024-1026`), so `:533-540` never runs. Neither runs in CI.
Status unaudited.
Impact: if this state is never reached, three mechanisms are untested together.
The `Overloaded` exit at `:527-532`, whose `ReadClose::Overloaded` doc
(`frame_channel.rs:40-43`) asserts "the peer and the transport are healthy" — an
assertion this record's window can falsify. The outbound servicing whose intent
the alternation comment at `:416-420` states. And the longest window in which
host code holds a reference into shared storage, which is where Part 1's
`quarantine-authority-survives-peer-writes` scenario has the most room. It is
also the enabling state for
`ring-a-lease-release-failure-is-observable-only-on-the-success-path` and for
observing the `Corrupt`-versus-`CleanEof` asymmetry in
`ring-a-publish-failure-is-reported-as-a-clean-peer-close`, so leaving it
unreached leaves both unfalsifiable.
Open questions:
- Should `receive_one` distinguish "ring empty" from "leases saturated"? Both
  arrive as `Ok(None)` from `try_receive` (`ring.rs:1063-1068`, `:1073-1074`)
  and both collapse to `Ok(false)` at `:500-501`. Investigation found this is
  moot under the current single-active-lease design and would matter only for a
  concurrently-leasing consumer, so it is a latent API gap rather than a live
  one.

---

## Group F: taxonomy arms with no producer

Two records on machinery the refactor left behind. One `ReadClose` variant and
one `InboundFrame` constructor have no producer at `HEAD`, and each keeps a
downstream branch alive that no input can reach. Neither is a current defect.
Both are catalogued because a dead arm behind an `#[allow(dead_code)]` or a
stale `reason` string reads as coverage, which is how it survives review.

### ring-a-rejected-drain-failure-close-has-no-producer

Type: reachability
Reachability: **compiled with no production producer.** Stated rather than
defaulted. The consumer side is `default-production`: `connection.rs:391` and
`:397` are on the ungated read-exit match every connection runs. The subject,
`ReadClose::RejectedDrainFailed` (`frame_channel.rs:47`), has no producer
anywhere in the tree, in production or in test, so `ReadExit::PeerKeepQueue`
(`connection.rs:397`) and the `serve_generation` arm at `:304-308` are compiled
and unreachable. `#[allow(dead_code)]` on the enum (`frame_channel.rs:32`) is
what keeps that compiling silently.
Status: active
Exercised: not yet — unconstructible; no test can reach it without a code
change.
Guarantee: Every `ReadClose` variant the connection engine handles is
producible by the transport, so the engine's close taxonomy has no dead arm and
`docs/mc-host-wire-protocol.md:321`'s authoritative-early-terminal guarantee
has a live carrier.
Check: `reachable` — the code location `connection.rs:397`
(`ReadExit::PeerKeepQueue`) is executed at least once per campaign.
`reachable` fits because the claim is location coverage over a specific branch,
and the finding is that no input can reach it.
Fault/timing angle: none. Static producer enumeration.
Required faults and enabling state: for the branch to be reachable at all, the
transport would have to emit `ReadClose::RejectedDrainFailed` after an
oversize channel-0 rejection whose realignment failed. On the ring there is no
realignment: a frame is one descriptor, and `receive_one:475-477` releases the
lease and returns `Ok(true)` with no drain step.
Confidence: high — [evidence](evidence/ring-a-rejected-drain-failure-close-has-no-producer.md).
Verified by grepping both variants: `ReadClose::RejectedDrainFailed` appears at
`frame_channel.rs:47` (declaration) and `connection.rs:391` (consumer) and
nowhere else; `ReadClose::Io` appears at `frame_channel.rs:45` and
`connection.rs:403` and nowhere else. `ReadExit::PeerKeepQueue` is produced only
at `connection.rs:397`, so the `serve_generation` arm at
`connection.rs:304-308` plus the `reject_written` bookkeeping at
`connection.rs:385` are dead. `#[allow(dead_code)]` on the `ReadClose` enum
(`frame_channel.rs:32`) is what keeps this compiling silently.
Existing check: none. Part 2a's
`the-client-body-budget-refusal-drain-is-never-entered` is the closest analogue
and was written against the deleted `frame_read.rs`.
Impact: the wire contract at `docs/mc-host-wire-protocol.md:321` promises that
an early oversize-control terminal "is authoritative for its correlation even
if the declared body then truncates, stalls, or EOFs". On the ring that
promise is satisfied vacuously, since there is no separate body to truncate,
but the engine still carries the machinery that would have honoured it. The
risk is not a current defect; it is that the dead arm looks like coverage.
Open questions:
- Should `RejectedDrainFailed` and `Io` be removed, or retained for a future
  transport? Removing them would make Part 2a's drain records genuinely closed
  rather than superseded.

### ring-a-segmented-inbound-body-has-no-production-producer

Type: reachability
Reachability: **compiled with no production producer.** Stated rather than
defaulted. The host inbound path is `default-production` and always takes the
`owned` constructor (`ring_transport.rs:552`). The subject,
`InboundFrame::segmented` (`frame_channel.rs:477`), has zero call sites
tree-wide including tests, so `ReceiveBody::Segmented` (`:448`) is
unconstructible and `decode_contiguous`'s `None` arm (`connection.rs:586`) is
compiled and unreachable.
Status: active
Exercised: not yet — unconstructible from any host path.
Guarantee: The zero-copy segmented inbound path that the frame-channel
abstraction and the transport doc both describe has a production producer, so
the copy accounting and the wrap-around lease handling are exercised.
Check: `reachable` — the code location `InboundFrame::segmented`
(`frame_channel.rs:477`) is executed at least once per campaign.
`reachable` fits because this is location coverage; the derived state claim,
that every host inbound frame carries exactly one copy, is what a cheaper
screen would assert.
Fault/timing angle: none. Static producer enumeration. The interesting
consequence is that a body wrapping the arena end is copied twice on the peer
side of the in-process client (`client.rs:1878` charges then
`try_recv_with` calls `lease.to_vec()` at `ring_transport.rs:735`) and once on
the host side, and neither ever takes the segmented path.
Required faults and enabling state: for the segmented path to matter at all, a
body whose descriptor spans two arena ranges, which the transport produces when
`span_count == 2` (`ring.rs:1105-1112`). That is reachable: it needs a body that
straddles the arena wrap point. But `receive_one` collapses it with
`lease.to_vec()` (`:544`) before the host ever sees the span structure.
Confidence: high — [evidence](evidence/ring-a-segmented-inbound-body-has-no-production-producer.md).
Verified by grepping: `InboundFrame::segmented` has zero call sites in the
tree, including tests. `ReceiveBody::Segmented` (`frame_channel.rs:448`) is
therefore unconstructible, so `with_lease` (`:506-513`) always takes the
`Owned` arm and `decode_contiguous`'s `None` arm (`connection.rs:586`) is dead.
`ring_transport.rs:552` is the only `InboundFrame` constructor call on the
host path and it uses `owned`.
Existing check: `frame_channel/contract_tests.rs:141` calls `with_lease` and
asserts `lease.segment(0)`, on a hand-built frame. Status unaudited.
Impact: two things. First, the attribute at `frame_channel.rs:476` reads
`#[allow(dead_code, reason = "shared-memory backends supply wrapped bodies")]`
and that reason is false at `HEAD`: the shared-memory backend supplies `owned`.
A stale suppression reason is how a genuinely dead branch survives review.
Second, `docs/mc-host-shm-transport.md:19` says the receiver "validates the
descriptor and header before exposing a scoped lease", which is true of the
transport but not of the host boundary: the host exposes a lease over its own
copy.
Open questions:
- Is the segmented path intended to return, or should
  `InboundFrame::segmented`, `ReceiveBody::Segmented`, and
  `frame_channel::LeaseTracker` be deleted together? `LeaseTracker`
  (`frame_channel.rs:398-444`), `frame_channel::ProducerReservation`
  (`:117`), and `ProducedBody` (`:231`) are in the same position: test-only,
  with `ProducedBody::into_charge` (`:283`) having no caller at all.

---

## Relationship map

Grouped by shared mechanism rather than by the headings above, because the
sharpest relationships cross groups. **Every dominance statement below is a
hypothesis** about which oracle subsumes which, offered to order the work, not a
verified claim. None has been tested, because no check in this sub-part executes
in CI beyond the two `compile_fail` doctests, and neither doctest touches any of
these records.

- **One charge, four ways to lose track of it.**
  [ring-a-admission-charge-releases-on-every-endpoint-thread-exit](#ring-a-admission-charge-releases-on-every-endpoint-thread-exit),
  [ring-a-host-never-quarantines-an-admission-charge](#ring-a-host-never-quarantines-an-admission-charge),
  [ring-a-reclamation-count-does-not-witness-charge-release](#ring-a-reclamation-count-does-not-witness-charge-release),
  [ring-a-cancellation-close-requires-an-empty-inbound-observation](#ring-a-cancellation-close-requires-an-empty-inbound-observation).
  All four turn on `admission.release()` at `ring_transport.rs:276` being the
  single point where the charge comes back, and on that line sitting outside the
  `catch_unwind` at `:264-275`. That line is an owner, not an absence: the charge
  returns on every exit including a swallowed panic. The release record is about
  whether it returns on *every* path, the quarantine record about whether
  returning it is even the right answer for a condemned ring, the reclamation
  record about a counter that can claim it returned before it did, and the
  cancellation record about how long the return can be deferred. **These four are
  not mutually consistent until the release-versus-quarantine policy question is
  answered**, because the release record requires an unconditional return and the
  quarantine record asks whether a condemned ring is an exception to it. That is
  bias 2 in [portfolio-evaluation.md](portfolio-evaluation.md). Hypothesis: an
  oracle that reads `snapshot().active` before and after each connection
  *dominates* the reclamation record, because a release-witnessed delta makes the
  counter's ordering observable as a side effect. It dominates neither the
  quarantine record, which is a call-graph absence no runtime delta can reveal,
  nor the cancellation record, which is a bound on frames rather than a claim
  about a total.
- **A cause that existed and was thrown away.**
  [ring-a-publish-failure-is-reported-as-a-clean-peer-close](#ring-a-publish-failure-is-reported-as-a-clean-peer-close),
  [ring-a-endpoint-thread-panic-is-reported-as-orderly-completion](#ring-a-endpoint-thread-panic-is-reported-as-orderly-completion),
  [ring-a-ring-unavailability-fails-closed-without-a-classified-reason](#ring-a-ring-unavailability-fails-closed-without-a-classified-reason),
  [ring-a-host-doctor-emits-one-of-five-declared-terminal-classes](#ring-a-host-doctor-emits-one-of-five-declared-terminal-classes).
  This is one finding attacked from four sides, and it is the cluster an operator
  would feel first. `publish_one` erases four distinct failure causes to `()`
  (`:560-565`, discarded at `:588-590`); the outer `catch_unwind` erases a panic
  with `let _ =` (`:264`); `RingUnavailable` is a unit struct with no cause field
  (`:103-112`); and `diagnostics()` has two arms and no counter can move `state`
  off `"healthy"` (`:165-179`), so the client classifier that owns the five-class
  taxonomy only ever sees a terminal condition when its own call fails.
  Hypothesis: giving `RingUnavailable` and `publish_one` a shared cause enum,
  surfaced through `diagnostics()`, would dominate all four, because each
  record's oracle reduces to "a host-observable record names this cause". Fixing
  the client taxonomy alone dominates none of them: the classes already exist and
  are already reachable client-side, and nothing host-side populates them.
- **The lease and the window that makes its failure visible.**
  [ring-a-ingress-wait-holds-a-lease-while-servicing-egress](#ring-a-ingress-wait-holds-a-lease-while-servicing-egress),
  [ring-a-lease-release-failure-is-observable-only-on-the-success-path](#ring-a-lease-release-failure-is-observable-only-on-the-success-path),
  [ring-a-publish-failure-is-reported-as-a-clean-peer-close](#ring-a-publish-failure-is-reported-as-a-clean-peer-close).
  The ordering here is not a preference, it is a dependency the ingress-wait
  record states in its own `Impact:` line. Reaching the state where a lease is
  held across a saturated budget while an outbound frame publishes is the
  enabling state for observing a release failure on a cancellation or overload
  path, and it is also where the `Corrupt`-versus-`CleanEof` asymmetry becomes
  observable, because `:535-537` is the one publish-failure site that returns a
  distinguishable cause. Hypothesis: constructing the ingress-wait state
  *dominates* the enabling half of the other two, in the specific sense that
  neither is falsifiable until it exists. It does not dominate their oracles: a
  release failure additionally needs a quarantined ring. That is now known to be
  cheap rather than blocked — a peer calls the public `Ring::enter_quarantine`
  (`ring.rs:1373`) through `RingClientEndpoint`'s `pub` ring fields
  (`ring_transport.rs:651-656`) — so the two records compose into one fixture
  rather than two capabilities.
- **Ownership as the premise, not a finding.**
  [ring-a-endpoint-thread-solely-owns-both-ring-endpoints](#ring-a-endpoint-thread-solely-owns-both-ring-endpoints),
  [ring-a-no-producer-retains-a-committed-release-identity](#ring-a-no-producer-retains-a-committed-release-identity).
  Both are static and both currently hold. They are in the catalog as premises
  the other twelve records assume: single-thread confinement is what makes the
  transport's unsynchronized cursors safe, and the discarded release identity is
  what keeps the producer-side release contract unreachable. Both are now
  `safety`/`always`; the second was retyped from `reachability`/`unreachable`
  under the portfolio disposition, because a provenance restriction on an
  *executed* function is a state and not a forbidden location. Hypothesis: a
  compile-time enforcement of confinement, on the model of the two `ReceiveLease`
  `compile_fail` doctests at `frame_channel.rs:296-308`, would dominate the
  runtime form of the first record, since those doctests are the only checks here
  CI already runs. Nothing dominates the second: a call-graph absence is proved
  by enumeration, and the only alternative is a debug counter on a path that
  should stay unentered.
- **Machinery with no input that reaches it.**
  [ring-a-rejected-drain-failure-close-has-no-producer](#ring-a-rejected-drain-failure-close-has-no-producer),
  [ring-a-segmented-inbound-body-has-no-production-producer](#ring-a-segmented-inbound-body-has-no-production-producer).
  Two unproducible surfaces, each hidden by a different suppression: an
  `#[allow(dead_code)]` on the `ReadClose` enum (`frame_channel.rs:32`) and an
  `#[allow(dead_code, reason = ...)]` whose reason is false at `HEAD` (`:476`).
  The doctor record was the third member of this cluster and **has left it**: its
  five classes are not unproducible machinery, they are client-side situations
  with a live classifier, and the third suppression the cluster named
  (`docs/mc-host-shm-transport.md:53-59`, a documentation claim with no compiler
  involvement) is a doc that the client satisfies rather than a dead branch. No
  dominance relation holds between the two that remain; they are grouped because
  the same review reflex misses both. The shared oracle is a producer-enumeration
  check rather than a test, and it costs one pass over the tree per variant. Note
  what that means for their `Exercised` lines: a census proves the absence, and
  **no campaign can satisfy their `reachable` checks at all**, which is why their
  fault-map rows moved from `Yes` to `No` under the portfolio disposition.

---

## Group G: the wire header decode contract

Four records on `crates/mc-host/src/wire.rs`, the 21-byte envelope header, its
decoder and its encoders. **All four were carried into this sub-part from the
superseded pre-refactor sub-part `part-2b-wire-and-channels`**, where they were
records 1, 2, 3 and 6 of `_lenses/lens-a-wire-format.md`. See
[../part-2b-wire-and-channels/README.md](../part-2b-wire-and-channels/README.md)
for that directory's disposition.

They were orphaned rather than retired, and the mechanism was a scope move that
no lens followed. The re-scope retired the `wire-and-channels` label, moved
`wire.rs` into this sub-part's declared scope, and routed these four forward
expecting them to be carried unmodified. This sub-part's two lens passes then
looked at the ring transport: all fourteen records above carry the `ring-a-`
prefix and every one of their `Guarantee:` lines is about endpoint-thread
ownership, release identities, admission charges, publication failure, leases,
reclamation counts or close classification. Not one is about the codec.
`wire.rs` appears in the rest of this catalog only twice, in the scope sentence
and in the test inventory that counts its 14 in-file tests. So the codec was in
scope and uncataloged, and the absorbing sub-part's lenses never re-derived
these properties.

**This group sits after the relationship map because it was carried in a later
pass, and the relationship map above does not cover it.** No dominance relation
is claimed between these four and the fourteen. Within the group, the first
three are readings of one function and the fourth is the encode-side mirror
that nothing enforces.

**Why these four and not the other eight lens A records.** `wire.rs` is
byte-identical between the lens-era commit and `HEAD`: `git rev-parse` returns
blob `fd0bb178` for `crates/mc-host/src/wire.rs` at `1c193ae0`, `793a973e` and
`e447c927` alike, and `wc -l` gives 973 at all three. These four cite nothing
outside `wire.rs`, `tests/protocol_vectors.rs`, and the encoder call graph. The
other eight lens A records each enumerate a consumer set the ring-transport
refactor rewrote, and they stay salvage.

**These are not Part 1's decode records, and the distinction is load-bearing.**
`part-1-shm-transport` holds `decoder-totality-over-arbitrary-bytes` and
`accepted-decode-consumes-its-declared-width`, and both are scoped by their own
`Confidence:` and `Fault/timing angle:` lines to the `crates/mc-shm-transport`
decoders: `descriptor.rs`, `sample.rs`, `ring.rs` and `harness.rs`. That family
guards the ring's own metadata, the descriptors and samples the transport reads
before it hands anything to the host. `wire::decode_header` (`wire.rs:306`) is a
different function in a different crate over a different byte layout: the 21-byte
envelope header two hosts exchange, whose frozen prefix is specified at
`wire.rs:16-18` and whose eleven gates are listed in the first record below. The
two families meet at exactly one line, `ring_transport.rs:503`, where
`decode_header` is handed the `[u8; 21]` that `Lease::wire_header`
(`crates/mc-shm-transport/src/lease.rs:152` post-#131) returns *after* the transport's own
decoder has already validated the descriptor. Verified at carry time:
`WIRE_V2_HEADER_BYTES` is 21 (`crates/mc-shm-transport/src/descriptor.rs:10`)
and `wire::HEADER_LEN` is 21 (`wire.rs:28`), so the two layouts are the same
width and still different content. Part 1's records end where this group begins.
Lens A excluded Part 1's records from its own scope on exactly this ground in
its "Not re-reported here" preamble, and counting either family as cover for the
other would double-count in the wrong direction.

**Reachability for all four rests on one chain, re-verified at carry time
rather than inherited.** `decode_header` has three production call sites and one
behind a test-only hook. Production: `ring_transport.rs:503` in `receive_one`,
paired with `validate_inbound_header` at `:505`; `ring_transport.rs:729` in
`RingClientEndpoint::try_recv_with`; and `client.rs:1978` in `decode_outbound`.
The fourth, `ring_transport.rs:593`, is inside the `if let Some(hook)` branch at
`:592` and so is reached only through the test-only `PublishHook` this catalog
already labels. The ungated chain under the first of those is the one this
sub-part established against three misleading signals, in
[Reachability is `default-production`, and three signals argued
otherwise](#what-this-part-is-about): the profile literal containing "test", the
wrong `RingClientEndpoint` doc comment, and `#[doc(hidden)]` on the module. Its
anchors were re-printed here: `RingTransport` is constructed unconditionally at
`runtime.rs:876` and stored non-optionally as `HostShared.ring` (`:104`), and
every authenticated connection calls `ring.prepare(...)` at `connection.rs:148`.
`wire.rs` contains exactly two `#[cfg]` attributes, `:541` and `:646`, and
neither is on the decode path; `:541` gates the test-only `encode_frame`, which
matters to the fourth record and is recorded there.

**Citations repaired at carry time, per METHOD rule 1.** Six, across three of
the four records; the bijection record needed none. They are listed at each
record and collected here: the `reject_unknown_frame_type_and_reserved_flag_encodings`
span is `:745-774` and not `:745-773` (two records cited the short form, the
closing brace is at 774); `structural_corruption_closes_silently` was renamed to
`structural_corruption_is_rejected_before_dispatch` and moved from
`tests/protocol_vectors.rs:512` to `:351`; `pure_header_frames_accept_any_valid_priority`
moved from `:656` to `:504`; the count of production `decode_header` callers is
three and not two; `wire.rs:548` is inside a `#[cfg(test)]` encoder rather than a
production one; and the wire protocol's retirement clause is
`docs/mc-host-wire-protocol.md:296`, not `:293`. Two cited files changed and
neither is a subject file: `tests/protocol_vectors.rs` went from 976 lines at
`1c193ae0` to 762 at `e447c927` under `63c4d277` ("refactor(shm): enforce
ring-only architecture"), which is what the earlier triage predicted for the
third record; and `docs/mc-host-wire-protocol.md` went from 1,031 lines to 936,
which the triage did not predict and which the fourth record cited. One open
question was also resolved rather than repaired, in the fourth record: the route
allocator cannot mint an epoch-0 handle.

### decode-header-is-total-over-arbitrary-bytes

Type: safety
Reachability: default-production — `decode_header` (`wire.rs:306`) has three
production call sites, all on ungated paths: `ring_transport.rs:503` in
`receive_one`, `ring_transport.rs:729` in `RingClientEndpoint::try_recv_with`,
and `client.rs:1978` in `decode_outbound`. The first is under the chain this
catalog established against three misleading signals: `RingTransport` built
unconditionally at `runtime.rs:876`, stored non-optionally at `:104`,
`ring.prepare` called by every authenticated connection at `connection.rs:148`.
A fourth call site, `ring_transport.rs:593`, is inside the test-only
`PublishHook` branch at `:592` and is not counted. Neither `#[cfg]` in the file
(`:541`, `:646`) is on this path.
Status: active
Exercised: partial — `wire.rs:722-742` covers three specific short and
bad-version inputs, and `wire.rs:745-774` covers four bad flag or type bytes.
Missing: any sweep over arbitrary bytes, any exhaustive length sweep from 0 to
21, and any structured mutation of an accepted seed. There is no fuzz target for
this decoder anywhere in the repository (`crates/mc-shm-transport/fuzz` is the
only fuzz directory; its three targets are `frame_descriptor.rs`,
`provider_grant.rs` and `provider_sample.rs`, all transport decoders).
Guarantee: For every byte slice, `decode_header` returns either an
`EnvelopeHeader` satisfying all eleven gate postconditions or a typed
`DecodeError`; it never panics and never allocates.
Check: `always` — call `decode_header` on arbitrary bytes of arbitrary length;
assert the call returns, and that on `Ok` every one of the eleven gate
conditions holds on the returned value. A panic is a forbidden state with no
dedicated detection point, so this is `always(!panic)`; `unreachable` is wrong
because no code location must never execute.
Fault/timing angle: none. The function is pure over one immutable slice. The
structural exposure is that every index past the first is a constant index
(`bytes[4]`, `bytes[5]`, `bytes[6]`, `bytes[7..9]`, `bytes[9..13]`,
`bytes[13..21]`) whose in-bounds-ness rests entirely on the single
`bytes.len() < need` gate at [wire.rs:312] and on `header_len_for_version`
returning 21 [wire.rs:294]. Narrowing that constant, or adding a version whose
`header_len_for_version` value is smaller than the largest constant index,
converts [wire.rs:355-357] into a panic.
Required faults and enabling state: none. Arbitrary bytes are the entire
enabling state. The property holds at `HEAD` and is under-evidenced, not
violated.
Confidence: high — [evidence](evidence/decode-header-is-total-over-arbitrary-bytes.md).
Every gate and every index was read directly, and re-read at carry time: the
eleven gates are `:307`, `:311`, `:312`, `:321`, `:323`, `:326`, `:329-331`,
`:332-339`, `:340`, `:345` and `:352`. `EnvelopeHeader` is constructed once,
after all eleven, at [wire.rs:359-367], and its fields are public but the value
cannot escape a rejected path. No allocation occurs: the function returns a
`Copy` struct.
Existing check: `wire.rs:722` `reject_truncated_headers_and_unsupported_versions`
and `wire.rs:745` `reject_unknown_frame_type_and_reserved_flag_encodings`, both
table-driven over single hand-picked inputs. Neither runs in CI, under this
sub-part's `R0`. Status unaudited. **One citation repaired at carry time:** the
second test's span is `:745-774`, not `:745-773`; the closing brace is at 774
and the lens range truncated it by one line.
Impact: today, none observable, and the reason was refreshed at carry time. All
three production callers pass an exactly-21-byte array, not a variable-length
slice: `ring_transport.rs:503` and `:730` pass `&lease.wire_header()`, typed
`[u8; WIRE_V2_HEADER_BYTES]` at `crates/mc-shm-transport/src/lease.rs:163` with
that constant equal to 21 at `descriptor.rs:10`, and `client.rs:1978` passes
`header_bytes: &[u8; HEADER_LEN]` narrowed at `:1977`. **The lens said "both
production callers" and there are three; the count is repaired and the
conclusion is unchanged.** The value of the record is that the reasoning keeping
totality true lives nowhere in the tree, and the moment a caller passes a
variable-length slice — a coalescing reader, a batched shared-memory descriptor,
a future version with a shorter header — the constant indexes become the only
thing between a peer and a panic in the read loop.
Open questions:
- Should `header_len_for_version` be required to return at least the largest
  constant index used by the parse body, so a future version cannot silently
  make the parse out of bounds? (needs human input)

### accepted-header-decode-is-a-bijection-on-twenty-one-bytes

Type: safety
Reachability: default-production — the decode direction is the three production
`decode_header` call sites named in the record above. The encode direction is
`EnvelopeHeader::encode` (`wire.rs:205-216`), reached from both production
encoders: `encode_owned_frame`, whose `EnvelopeHeader { .. }.encode()` chain is `:584-593`,
and `encode_split_frame`, whose chain is `:622-631` and which also delegates
small bodies to `encode_owned_frame` at `:615`. Those
encoders are called from `dispatch.rs:292`, `:329`, `:723`, `:802`, `:1458`,
`connection.rs:779`, `:866`, and `client.rs:1329`, `:2092`, none `cfg`-gated.
Status: active
Exercised: partial — `wire.rs:703-719` pins all seven field offsets with
distinctive byte values, and `wire.rs:680-690` round-trips one header. Missing:
a per-bit influence oracle, and any assertion that `decode_header` reads nothing
past `HEADER_LEN`.
Guarantee: For every accepted header, `encode` and `decode_header` are mutually
inverse, every one of the 21 bytes influences exactly one decoded field, and no
byte at or beyond offset 21 is consumed.
Check: `always` — for every accepted 21-byte input, `decode_header(bytes)` then
`.encode()` reproduces `bytes` exactly; flipping any single bit inside the 21
bytes either changes the decoded value or causes rejection; and appending
arbitrary trailing bytes changes nothing about the result. `always` rather than
`reachable`: the condition is evaluated on every accepted decode, and the
forbidden state is an accepted header with an inert or aliased byte, which has
no dedicated detection point.
Fault/timing angle: none. The interesting axis is that `encode` writes its seven
fields by hand-written literal ranges [wire.rs:207-213] and `decode_header`
reads them back by independently hand-written literal ranges
[wire.rs:319], [:343], [:344], [:355-357]. Nothing ties the two sets of offsets
together, and a same-width transposition — `channel` against the low half of
`epoch`, or two bytes inside `corr` — is invisible to a round-trip test whose
fixture uses non-distinctive values.
Required faults and enabling state: none. Any accepted input suffices; what is
missing is the oracle.
Confidence: high — [evidence](evidence/accepted-header-decode-is-a-bijection-on-twenty-one-bytes.md).
`encode` covers `0..4`, `4`, `5`, `6`, `7..9`, `9..13`, `13..21` with no gaps and
no overlaps, and the decode side reads the identical seven ranges. Both sides
were re-printed at carry time and every citation in this record verified
unchanged; this is the one carried record that needed no repair. The
`little_endian_and_frozen_prefix_layout` test at `wire.rs:703` does use
distinctive ascending values, so it would catch a transposition today; nothing
forbids a future fixture from losing that property, and the test asserts on
`encode` only, never on the decode direction's offsets.
Existing check: `wire.rs:703` `little_endian_and_frozen_prefix_layout` (encode
direction, distinctive values, plus `buf.len() == HEADER_LEN` at `:718`);
`wire.rs:680` `round_trip_request`; `wire.rs:693` `round_trip_all_frame_types`.
None runs in CI, under this sub-part's `R0`. Status unaudited.
Impact: this bijection is what makes the frozen-prefix promise in the module
header [wire.rs:16-18] mean anything, and it is the only reason a peer's
independently written codec can interoperate. A drifted offset that still
satisfies the eleven gates produces a frame both sides accept and interpret
differently.
Open questions:
- Should `encode` and `decode_header` be generated from one offset table so a
  transposition is impossible by construction? (needs human input)

### reserved-encodings-and-identity-pairings-reject-at-decode

Type: safety
Reachability: default-production — same three production `decode_header` call
sites as the two records above. The reserved-encoding gates are unconditional
statements inside `decode_header`, at `:323`, `:326`, `:329-331`, `:332-339`,
`:345` and `:352`, with no `cfg`, no feature and no config branch between the
call site and any of them.
Status: active
Exercised: partial — `wire.rs:745-774` covers reserved flag bit 7, reserved
priority, reserved admission, and type byte 99; `wire.rs:836-862` covers
Sheddable on all ten illegal types and both legal ones; `wire.rs:795-833` covers
both halves of the channel-and-epoch pairing. Missing: an exhaustive sweep of
all 256 flag bytes and all 256 type bytes, and any check that a rejected
encoding is never masked, defaulted, or silently normalized.
Guarantee: A header carrying a reserved flag bit, a reserved priority or
admission value, an unassigned type byte, Sheddable on a delivery-required type,
or a mismatched channel-and-epoch pairing is rejected, never accepted with the
offending field cleared or defaulted.
Check: `always` — sweep all 256 values of the flags byte crossed with all 256
values of the type byte and both channel-and-epoch classes; assert every
combination the protocol calls invalid returns the specific `DecodeError`
variant for it, and that no accepted result has reserved bits set or a reserved
enum value. `always` because the obligation is per-frame and the forbidden
state — an accepted header whose reserved region was normalized rather than
refused — has no dedicated detection point.
Fault/timing angle: none. The exposure is that `Flags::priority` and
`Flags::admission_class` return `Option` [wire.rs:169-176] while
`Flags::is_binary` and `Flags::is_last` return `bool` [wire.rs:159-166]. A
future accessor written in the `bool` style over a widened bit field would mask
rather than reject, and the only thing forcing rejection today is that
`decode_header` propagates the `None` at [wire.rs:326] and [wire.rs:329-331].
Required faults and enabling state: a peer-authored header, which is the
baseline trust model. No concurrency, no timing.
Confidence: high — [evidence](evidence/reserved-encodings-and-identity-pairings-reject-at-decode.md).
Every gate read directly and re-read at carry time. The channel-and-epoch
pairing is a true biconditional: `channel == 0 && epoch != 0` at [wire.rs:345]
and `channel != 0 && epoch == 0` at [wire.rs:352], matching protocol section
6.1's "0 on channel 0; routed epochs are nonzero".
Existing check: `wire.rs:745` `reject_unknown_frame_type_and_reserved_flag_encodings`,
`wire.rs:836` `sheddable_rejected_on_every_illegal_frame_type`, `wire.rs:795`
`epoch_boundaries_round_trip_and_control_channel_epoch_is_reserved`, plus the
end-to-end `tests/protocol_vectors.rs:351`
`structural_corruption_is_rejected_before_dispatch` and `:504`
`pure_header_frames_accept_any_valid_priority`. None runs in CI. Status
unaudited. **Three citations repaired at carry time**, and this is the record the
earlier triage predicted would need a refresh because
`tests/protocol_vectors.rs` changed (976 lines at `1c193ae0`, 762 at `HEAD`,
under `63c4d277`). First, the in-file span is `:745-774`, not `:745-773`.
Second, `structural_corruption_closes_silently` at `:512` no longer exists: it
was **renamed** to `structural_corruption_is_rejected_before_dispatch` and moved
to `:351`. The rename is not a rewrite — the doc comment above it is unchanged
("Each structurally illegal frame retires the generation with no `Error` frame
and no resynchronization (protocol §6.3, AE2, V13-V15, V17, V42)") and so is the
`Case { name, bytes }` table that follows, so the check the record cited is the
check that still exists. Third, `pure_header_frames_accept_any_valid_priority`
kept its name and moved from `:656` to `:504`.
Impact: the reserved regions are the whole forward-compatibility budget. Any
implementation that masks instead of rejecting spends that budget silently: a
version-3 field placed in bits 6-7 would be ignored by a version-2 peer that
should have closed the generation.
Open questions: None.

### encoder-never-emits-a-frame-its-own-decoder-rejects

Type: safety
Reachability: default-production — the two production encoders are
`encode_owned_frame` (`wire.rs:571`) and `encode_split_frame` (`:608`), called
from `dispatch.rs:292`, `:329`, `:723`, `:802`, `:1458`, `connection.rs:779`,
`:866`, and `client.rs:1329`, `:2092`, none of them `cfg`-gated and all on the
terminal-emission path this catalog's siblings in 2e describe. The illegal
argument region is reachable from outside the crate: `pub mod wire` (`lib.rs:36`;
post-#131 it carries `#[doc(hidden)]` at `:35`, which hides it from rustdoc but
not from linkage)
exposes both encoders and `FrameId::routed`, and `pub mod handler` (`:14`)
exposes `RouteHandle` with both fields `pub` (`handler.rs:36-40`).
Status: active
Exercised: not yet — no test feeds encoder output back through
`decode_header` plus `validate_inbound_header` over anything but hand-chosen
legal inputs. The existing round-trips at `wire.rs:680` and `:693` construct
`EnvelopeHeader` directly, and `hdr` derives a legal epoch from the channel
(`wire.rs:650-652`, `u32::from(channel != 0)`), so they cannot reach the illegal
region.
Guarantee: For every argument tuple the production encoders accept, the emitted
bytes decode successfully and pass inbound validation on a conforming peer.
Check: `always` — for arbitrary `(ty, flags, id, body)`, either
`encode_owned_frame` returns `Err`, or `decode_header` on its output returns
`Ok` and the result satisfies the pure-header, Sheddable, channel-and-epoch, and
reserved-bit rules. `always` because it must hold on every emission, and the
forbidden state — a frame the local decoder would reject — has no detection
point on the emitting side.
Fault/timing angle: none; this is a static contract gap. Four concrete holes,
all re-verified at carry time and all reachable from the crate's public surface
(O7): `Flags(0b1100_0000)` sets reserved bits, which [wire.rs:323] rejects;
`Flags(0b0000_0110)` sets reserved priority, which [wire.rs:326] rejects;
`encode_owned_frame(FrameType::Ping, .., body)` with a nonempty body emits
`len != 0` on a pure-header type, since `Ping` is in `is_pure_header`'s set
[wire.rs:86-88] and `encode_owned_frame` [wire.rs:571-602] tests only
`body.len() > MAX_BODY_LEN` at [:577], which [wire.rs:340] rejects; and
`FrameId::routed` [wire.rs:525-531] copies `RouteHandle`'s channel and epoch
without checking that a nonzero channel carries a nonzero epoch, which
[wire.rs:352] rejects.
Required faults and enabling state: none beyond a caller passing an
out-of-contract value. For the `FrameId::routed` hole specifically, a
`RouteHandle` with a nonzero channel and epoch 0. **The lens left whether the
route allocator can mint one open, and it is resolved here: it cannot.**
`RouteRegistry::reserve` (`routing.rs:113-156`) skips channel 0 with
`if candidate != 0` at `:123`, initializes a fresh slot with `last_epoch: 0` at
`:125`, and mints `epoch = slot.last_epoch + 1` at `:129-130`, so the least epoch
it can produce is 1 and the least channel is 1. That is pinned by
`reserved_channels_are_nonzero_distinct_and_start_at_epoch_one`
(`routing.rs:512`), whose asserts at `:522-526` require both channels nonzero and
both epochs equal to 1. So the enabling state is a **hand-constructed**
`RouteHandle`, which the public fields at `handler.rs:36-40` permit. Hand-building
a handle the allocator would never mint is already established practice in-tree,
though not with epoch 0: `routing.rs:715-718` builds a stale-epoch handle and
`:750-753` builds `epoch: handle.epoch + 1`, both to drive registry rejection
paths.
Confidence: high — [evidence](evidence/encoder-never-emits-a-frame-its-own-decoder-rejects.md).
The gap is high confidence and unchanged: all encoders were read end to end and
the only rejection in either production encoder is the body-length cap, at
[wire.rs:577] and [:618]. `Flags::new` [wire.rs:146-156] cannot produce the
illegal flag values, and the two host flag helpers `response_flags`
[wire.rs:636-638] and `pure_header_flags` [wire.rs:642-644] both go through it,
so the in-tree host emission paths are safe today by construction rather than by
enforcement. **Two things the lens recorded are corrected here.** First, the
lens counted three production encoders and cited a third cap at [wire.rs:548];
that cap is inside `encode_frame`, which carries `#[cfg(test)]` at
[wire.rs:541] and whose only two callers are
`frame_channel/contract_tests.rs:93` and `:163`. So there are two production
encoders and one test-only one, and the guarantee is stated over the two.
Second, the lens's `medium on reachability` rested on not having audited route
allocation; that audit is done above and the allocator is closed, which leaves
the hole reachable only through a hand-built handle. The finding survives both
corrections: nothing on either production encoder checks the pure-header,
Sheddable, reserved-bit or channel-and-epoch rules its own decoder enforces.
Existing check: none. `tests/protocol_vectors.rs:143`
`committed_header_vectors_decode_to_their_documented_fields` asserts the
document's byte vectors against the independent `raw_client::decode_header`
oracle (`tests/support/raw_client.rs:286`), which is the decode direction over
fixed inputs and not encoder refusal. Status: none found.
Impact: this is the encode side of the framing contract, and it is entirely
unenforced. A host that emits a frame its own decoder would reject produces
stream-alignment corruption at the peer, which the protocol requires the peer to
answer by retiring the connection without resynchronization and with no error
frame (`docs/mc-host-wire-protocol.md:296`, which lists "unsupported version,
unknown type, invalid flags, nonzero channel-0 epoch, zero epoch on a routed
channel, pure-header body" — three of this record's four holes by name) — an
unattributable connection drop. **One citation repaired at carry time:** the lens
cited `:293`, which was correct at `1c193ae0`, where that line began "Clean EOF
before any byte of the next header is orderly connection close. EOF after the
first header byte, truncated header/body, unsupported version, unknown t...".
The document shrank from 1,031 lines to 936 and that sentence was rewritten;
both its clean-close and its retirement clauses now sit in `:296`. `:293` is
blank at `HEAD`.
Open questions:
- Should the encoders validate, or should the illegal region be made
  unconstructible by removing the public field from `Flags` and by giving
  pure-header types a body-free encoder? (needs human input)
- Should `encode_frame`'s `#[cfg(test)]` gate be reconsidered? It is the only
  encoder that takes `&[u8]` rather than an owned body, and its existence means
  the contract-test suite exercises an encoder the production path never uses.
  (needs human input)
