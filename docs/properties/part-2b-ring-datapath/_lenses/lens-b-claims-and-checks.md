# Part 2b lens B: claim register and existing-check inventory

Attention focus: what the sub-part *promises*, and what mechanically holds each
promise. Claim sources are the doc comments in the four scope files, the error
and close-reason strings they emit, and the two normative documents
`docs/mc-host-shm-transport.md` and `docs/mc-host-wire-protocol.md`. No property
records; no evidence files. Method contract in [../../METHOD.md](../../METHOD.md).

Scope: `crates/mc-host/src/ring_transport.rs` (966), `wire.rs` (973),
`frame_channel.rs` (807), `frame_channel/contract_tests.rs` (701). 3,447 lines,
re-derived with `wc -l` at `HEAD`.

Provenance. Code read from `/local/home/ahrav/scratch/magic-context`, branch
`feat/shared-memory-release-gate-audit`, `HEAD` = `e447c927` ("refactor(shm):
trim final review leftovers"). Both facts confirmed with `git branch
--show-current` and `git log -1`, matching the re-scope map
(`../../part-2-rescope/scope-map-and-risk-ranking.md:7-9`). Every line reference
below was printed from that tree before being written.

**The docs may lag the refactor, and on this surface they do.** Per METHOD rule
3 the documentation establishes the obligation and never the satisfaction, so
each claim below carries its implementing code or the marker `NOT FOUND`. A doc
statement about a mechanism the refactor deleted is recorded in its own section
as a finding, not as a stale-doc footnote.

## Shared context, verified rather than restated

The re-scope's CI findings were re-derived here, not copied. All five hold, with
two line-level refinements.

| Re-scope claim | Verdict at `HEAD` |
| --- | --- |
| `--test client` at `ci.yml:132`, `:179`, `:187` | confirmed; `:178-179` is one wrapped command |
| `--test shm_failure_modes` at `:133` | confirmed |
| `--test shm_soak` with one `--exact` test at `:134-135` | confirmed; the test is `short_soak_keeps_fd_mapping_thread_and_rss_envelopes_bounded` |
| `--test lifecycle` at `:179`, `:187` | confirmed |
| doctests at `:190` | confirmed; the step is named "Rust lease non-escape" |
| job `shm-crash-recovery` at `:111` | confirmed, `needs: [shm-hardening-gate]`, Linux only |
| job `shm-source-build` at `:137` | confirmed, matrix `ubuntu-latest`/`macos-latest`/`macos-15-intel` |
| 4 of 24 integration binaries named | confirmed; `ls crates/mc-host/tests/*.rs` returns 24 |
| every `-p mc-host` run carries a `--test` filter | confirmed; the 13 `mc-host` hits are `:87`, `:132`, `:133`, `:134`, `:168`, `:169`, `:178`, `:187`, `:190`, `:211`, `:361`, `:442`, `:461`, and none is an unfiltered or `--lib` run |
| clippy deliberately absent | confirmed; the reason comment is at `:481-483` and the `check-rust` job (`:463`) runs only `cargo fmt --check` (`:485`) and `cargo check -p mc-core --no-default-features` (`:492`). The re-scope's `:481-493` is the enclosing block |
| grep gate `mandatory-ring-architecture` at `:41`, `:55`, `:58` | confirmed |

**One correction, and it changes the headline.** The re-scope's statement that
inline unit tests never execute in CI is true of `#[test]` and `#[tokio::test]`
functions, but `cargo test -p mc-host --doc` (`:190`) *does* build and run the
lib target's doctests. This sub-part has exactly two, both `compile_fail`
(`frame_channel.rs:296-301` and `:303-308`), and they are therefore **the only
checks in this sub-part's own source that CI executes at all**. The step name
"Rust lease non-escape" names them precisely: they assert that `ReceiveLease` is
neither `Send` nor `'static`. So the correct statement is "no inline unit test in
this sub-part runs in CI; two doctests do."

The re-scope's two carried leads were also verified.

- **`Admission::quarantine` has zero `mc-host` callers.** Confirmed. The function
  is `crates/mc-shm-transport/src/profile.rs:568` (with the private
  `AdmissionController::quarantine` at `:522`). A repository-wide grep for
  `quarantine` under `crates/mc-host/` returns only: the unrelated
  lifecycle-record quarantine in `instance.rs`, `lifecycle.rs` and
  `generation.rs`; the unrelated `LeaseTracker` quarantine in
  `frame_channel.rs:392-433`; the diagnostics reporter at
  `ring_transport.rs:182`; and two in-crate assertions that the value is zero
  (`:774`, `:800`). Host quarantined accounting is structurally zero. Engaged as
  claim C4 and lead L1 below.
- **Ring unavailability fails closed while `diagnostics()` still reports
  `state: "healthy"`.** Confirmed. `prepare` returns `Err(RingUnavailable)` on
  five distinct causes and only the first touches a counter
  (`ring_transport.rs:239-242`). `diagnostics()` derives `state` solely from
  `self.accounting()` (`:176-190`), which reads the admission snapshot and knows
  nothing about a failed `prepare`. Engaged as claim C7 and lead L2.

## Claims register

19 claims, ordered by consequence. `Where stated` is the claim source; `Implementing
code` is where the obligation is discharged, or `NOT FOUND`.

### C1 — the ring is the only application transport, and no selector survives

Where stated: `docs/mc-host-shm-transport.md:5` ("The fixed ring is the only
application transport"), `:7` ("There is no runtime transport selector, alternate
shared-memory backend, compatibility reader, or degraded data path"),
`docs/mc-host-wire-protocol.md:28` ("Production application transport is the
local shared-memory ring"), `:559-561` (§7.7, "The ring is the only application
frame channel"), and `frame_channel/contract_tests.rs:5-7` ("The sole
instantiation below uses the production ring transport").

Implementing code: `frame_channel/contract_tests.rs:524`,
`frame_channel_contract_suite!(RingFactory)` — one registration, no second
factory. `ring_transport.rs:350-361` is the sole `impl FrameReceiver`.
`lib.rs:21` exports `ring_transport` as the only transport module.

Mechanical enforcement: the `mandatory-ring-architecture` job (`ci.yml:41`,
`:55`, `:58`) running `scripts/check-mc-shm-architecture.ts`. See
"Conventionally-enforced-only" for what that gate can and cannot see.

### C2 — one dedicated OS thread creates and owns both `!Send` ring endpoints

Where stated: `ring_transport.rs:3-4`, the module's load-bearing design claim.

Implementing code: `prepare` spawns the named thread at `:254-256`,
`DuplexRing::create` runs inside it at `:263`, and `run_endpoint` (`:364`)
receives `rings` by value at `:365`. Nothing else takes a reference to
`DuplexRing` outside that closure. The `Send` boundary is crossed only by
`[OwnedFd; 2]` and a `serde_json::Value` through `initialized_tx` (`:276`).

Existing check: none. No test asserts thread confinement; the two `compile_fail`
doctests cover `ReceiveLease`, not the ring endpoints.

### C3 — a transport failure is terminal for the affected connection and replays nothing

Where stated: `docs/mc-host-shm-transport.md:7` ("A transport failure is
terminal for the affected connection"), `:47`,
`docs/mc-host-wire-protocol.md:563` ("No setup or runtime failure changes
transport or replays an uncertain request"), `contract_tests.rs:265-266`
("Publication failure after admission retires the whole channel ... nothing is
replayed").

Implementing code: the two retirement sites in `run_endpoint`,
`ring_transport.rs:400-405` (receive error) and `:447-451` (publish failure),
each doing `queue.retired.cancel(); root.cancel(); return`.

Existing check: `contract_failure_after_publication_begins_retires_without_replay`
(`contract_tests.rs:436-439` via the macro, body at `:267`). In-crate, never runs
in CI.

### C4 — active and quarantined charges are reported separately

Where stated: `docs/mc-host-shm-transport.md:21` ("Active and quarantined
charges are reported separately"), `:65` ("active and quarantined accounting"),
`:79` ("quarantined charges remain within the configured process bound").

Implementing code: the *reporting* half exists at `ring_transport.rs:180-183`.
The *producing* half is **NOT FOUND**: no `mc-host` call site reaches
`Admission::quarantine`. See lead L1 and the deleted-mechanism section.

Existing check: `ring_transport.rs:774` and `:800` assert the quarantined charge
is `ZERO`, which is what a never-called quarantine path produces. Both in-crate.

### C5 — inbound structural validation happens on the header alone, before body admission

Where stated: `frame_channel.rs:50-57`, explicitly: "Classification uses the
header alone, BEFORE any body admission: a role-invalid type with a large
declared body must not hold ingress budget or an allocation through the frame
deadline".

Implementing code: `validate_inbound_header` (`frame_channel.rs:58-77`) is
called at `ring_transport.rs:473`, before the ingress-charge loop at `:487-518`
and before `lease.to_vec()` at `:519-521`. The ordering discharges the claim.

Existing check: none direct. No test drives a role-invalid type with a large
declared `len` and asserts that no budget was held.

### C6 — the ingress-budget wait services queued outbound frames

Where stated: `ring_transport.rs:501-503` and `:410-414`, and
`contract_tests.rs:107-109` ("Concurrent sends and receives both make
progress").

Implementing code: `ring_transport.rs:504-509` inside the charge loop, plus the
`received`/`try_recv` alternation at `:409-415`.

Existing check: `contract_concurrent_send_receive_preserves_fifo_admission`
(`contract_tests.rs:417-420`, body at `:110`). In-crate. This is the record the
re-scope flagged as transferring directly onto the new file
(`scope-map-and-risk-ranking.md:262-265`); the citation fix it names
(`POLL_INTERVAL` now `ring_transport.rs:33`) is confirmed.

### C7 — the doctor reports either healthy or one of five terminal classes

Where stated: `docs/mc-host-shm-transport.md:53-59` (the five: `missing_addon`,
`identity_mismatch`, `setup_failure`, `peer_death`, `resource_exhaustion`) and
`:71` ("Client diagnostics use the same terminal-class set").

Implementing code: split across languages, and unevenly. The Rust host can emit
exactly one of the five — `"setup_failure"` at `ring_transport.rs:187` is the
only occurrence of any of the five string literals anywhere under `crates/`. The
other four exist only in TypeScript: `types.ts:69-73` declares the closed set,
`shared-memory-failure.ts:10-30` produces four of them, `client.ts:1588-1592`
lists all five, and `mc-host-lifecycle/policy.ts:869`, `:871` maps two into
report fields. See lead L3.

Existing check: `shm-frame-channel.test.ts:49-57` covers nine
error-to-class mappings and runs in CI (`ci.yml:211`). The Rust side has
`ring_transport.rs:788`, which asserts `error_class` is `Null` on the healthy
path only.

### C8 — a healthy report includes only bounded, aggregate data, and never secrets

Where stated: `docs/mc-host-shm-transport.md:61-69` (the seven permitted
fields) and `:73` (the never-included list: setup-socket paths, native handles,
mapping descriptors, grants, activation tokens, authentication keys or proofs,
payload bytes, mapped addresses, provider error text).

Implementing code: `diagnostics()` (`ring_transport.rs:153-207`) constructs a
closed JSON object from atomics and the admission snapshot; no argument reaches
it and no peer-controlled string is interpolated.

Existing check:
`diagnostics_report_fixed_identity_bounds_accounting_and_lifecycle_counts`
(`ring_transport.rs:778`) asserts all seven present fields and then greps the
encoded output for seven forbidden substrings (`:807-818`). In-crate, never runs
in CI. Note the negative check is a substring scan over field *names*, so it
would not catch a grant value emitted under an innocuous key.

### C9 — the fixed profile charges both directions with the stated numbers

Where stated: `docs/mc-host-shm-transport.md:77` — "16 descriptors, 128 MiB of
arena storage, 16 receive leases, two mappings, two mapping file descriptors,
one endpoint worker, one client instance, and no pinned workers".

Implementing code: **verified exact.** `ring_profile()`
(`ring_transport.rs:41-58`) sets `descriptor_depth: 8`,
`arena_bytes: MIN_ARENA_BYTES`, `max_leases: 8`, `mappings: 2`,
`pinned_workers: 0`, `worker_topology: Fused`. `TargetProfile::new`
(`mc-shm-transport/src/profile.rs:180-203`) doubles descriptors and leases for
the two directions, doubles arena bytes, sets `file_descriptors` equal to
`mappings`, maps `Fused` to `workers: 1`, and hardcodes `client_instances: 1`.
`MIN_ARENA_BYTES` is `64 * 1024 * 1024` (`mc-shm-transport/src/arena.rs:4-6`),
so 2 x 64 MiB = 128 MiB. Every one of the eight numbers matches.

Existing check: `ring_profile_pins_per_connection_grant_geometry`
(`ring_transport.rs:822`) pins depth, leases and arena bytes but not the derived
charge vector. In-crate.

### C10 — process bounds multiply the profile with checked arithmetic

Where stated: `docs/mc-host-shm-transport.md:77` ("checked arithmetic"), `:21`
("Every configured limit is finite and validated at startup").

Implementing code: `process_limits` (`ring_transport.rs:75-88`), eight
`checked_mul` calls returning `Option`.

Existing check: none in this sub-part. Nothing exercises the overflow return.

### C11 — a conforming implementation accepts one valid maximum-size frame

Where stated: `docs/mc-host-wire-protocol.md:290` (§6.3) — "MUST be able to
accept one otherwise valid maximum-size frame on an admitted authenticated
connection", and "MUST NOT advertise v2 conformance while rejecting an otherwise
valid frame solely because its declared length is at or below 64 MiB".

Implementing code: `MAX_BODY_LEN` is `MAX_FRAME_BODY_LEN` (`wire.rs:371`) and
the arena is exactly 64 MiB per direction, so a 64 MiB body fits — with zero
bytes to spare. `validate_inbound_header` rejects only `> MAX_BODY_LEN`
(`frame_channel.rs:59-61`).

Existing check: `exact_commit_covers_empty_boundary_segmented_and_maximum_bodies`
(`contract_tests.rs:673`) drives `MAX_BODY_LEN` through
`ProducerReservation` over synthetic spans, not through a real ring. No check
publishes a 64 MiB frame through `DuplexRing`. See quiet area Q3.

### C12 — an oversize channel-0 control request is rejected, not closed

Where stated: `wire.rs:373` ("Profile cap for a channel-0 control body (protocol
§7.1)") and `docs/mc-host-wire-protocol.md:296-298` (aggregate limits take
effect after framing accepts the body).

Implementing code: `ring_transport.rs:474-485` — releases the lease, sends
`InboundEvent::Rejected` carrying only `corr`, and returns `Ok(true)`. The cap
is `MAX_CONTROL_BODY_LEN = 65_536` (`wire.rs:374`).

Existing check: none in this sub-part. No in-crate or contract-suite test drives
the rejection branch.

### C13 — decode never panics on malformed input

Where stated: `wire.rs:305` — "Never panics on malformed input — returns a typed
[`DecodeError`]".

Implementing code: `decode_header` (`wire.rs:299` onward) with
`header_len_for_version` (`:292-298`) and the eleven `DecodeError` variants
(`:218-241`).

Existing check: the wire test module (`wire.rs:646-973`, 14 tests) is the
densest coverage in the sub-part, and `tests/protocol_vectors.rs` (15 tests)
pins committed byte vectors. The re-scope carries four lens-A records over this
surface unchanged (`scope-map-and-risk-ranking.md:188-192`).

### C14 — the frozen prefix keeps fixed meaning and position in every version

Where stated: `wire.rs:16-18` — "**Frozen prefix:** `len` (u32 @ 0) and `ver`
(u8 @ 4) keep fixed meaning and position in every future version;
`decode_header` enforces that discipline", and
`docs/mc-host-wire-protocol.md:242-244`.

Implementing code: `FROZEN_PREFIX_LEN` (`wire.rs:30-32`) and the read-prefix-then-
dispatch order in `decode_header`. `header_len_for_version` (`:292`) returns
`Some(HEADER_LEN)` for `PROTOCOL_VERSION` and `None` otherwise, so there is
exactly one version to dispatch to today.

Existing check: covered by the wire test module and `protocol_vectors.rs`. Note
the re-scope's finding that the record on this surface names "the production TCP
reader" as its consumer, which no longer exists
(`scope-map-and-risk-ranking.md:244-249`).

### C15 — one permit is one byte, charges travel with moves, and a failed split creates no permits

Where stated: `wire.rs:376-384` (the `ByteBudget` contract, including "Tokio's
semaphore is FIFO, so a queued maximum-size acquisition cannot be starved by
later small ones"), `:466-468` ("a failed split can never create or destroy
permits"), `:486-488` ("a charge can never be inflated after acquisition"),
`:493-497` (deferred release must not happen under an unrelated mutex).

Implementing code: `wire.rs:376-500`, the `ByteBudget` and `ByteCharge` block.

Existing check: the last wire test (`wire.rs:954`, a `#[tokio::test]`) asserts
budget return to 100. `inbound_materialization_cannot_exceed_its_byte_budget`
(`ring_transport.rs:839`) drives a synthetic charge closure through
`try_recv_with`. Both in-crate. The FIFO no-starvation claim has no check.

### C16 — a committed body always owns its charge, and charge return is an ownership property

Where stated: `frame_channel.rs:110-115` — "This makes charge return an
ownership property instead of a caller convention" — and `:228-230`.

Implementing code: `ProducerReservation` (`frame_channel.rs:110-227`) and
`ProducedBody` (`:228-289`), with the `.expect("a committed body always owns its
charge")` at `:286`.

Existing check: `producer_failures_never_publish_and_return_each_charge_once`
(`contract_tests.rs:689`) covers underfill, overflow, double-drop and abort.
In-crate.

### C17 — receive bytes are visible only through a lexical, `!Send`, non-`'static` lease

Where stated: `frame_channel.rs:8-10` and `:290-295`.

Implementing code: the `Rc` marker on `ReceiveLease` (`frame_channel.rs:290`
onward) plus the two `compile_fail` doctests at `:296-301` and `:303-308`.

Existing check: **the two doctests, and they are the only checks in this
sub-part CI executes** (`ci.yml:190`). Also
`owned_adapter_copies_once_and_releases_lease_before_return`
(`contract_tests.rs:673` region, at `:673`) and
`close_with_active_lease_quarantines_and_never_reopens_storage` (`:689`),
both in-crate.

### C18 — one explicit copy per flattened body, zero on direct and leased paths

Where stated: `frame_channel.rs:78-81` and `:368-369` ("One call records one
body copy even when the body is empty").

Implementing code: `CopyCounter` (`frame_channel.rs:78` onward);
`ring_transport.rs:525-526` records exactly one copy for the owned inbound path.

Existing check: `copied_control_frame_records_one_host_adapter_copy`
(`ring_transport.rs:882`) and `owned_adapter_copies_once_...`
(`contract_tests.rs:673`). Both in-crate.

### C19 — in-band Goodbye is a complete frame; transport loss is never reclassified as orderly shutdown

Where stated: `contract_tests.rs:384-386`,
`docs/mc-host-wire-protocol.md:294` ("Clean `Goodbye` followed by joined
teardown is orderly connection close"), `docs/mc-host-shm-transport.md:49`
("Clean `Goodbye` and unexpected setup-socket closure are distinct").

Implementing code: on the ring side, `ShmReceiver::recv` maps a closed inbound
channel to `Err(ReadClose::CleanEof)` (`ring_transport.rs:359`) — which is the
*same* classification a clean in-band Goodbye reaches through
`connection.rs:401-404`. The distinction the doc claims is carried by
`observe_peer` on the setup socket, which is 2c scope. See lead L4.

Existing check: `contract_goodbye_at_a_frame_boundary_is_delivered`
(`contract_tests.rs:457-460`, body at `:386`). In-crate.

## Contract-vs-code leads

Recorded with both sides cited, not resolved. Four leads.

**L1 — quarantined accounting is documented as a live signal and is structurally
zero.** Three documentation lines present it as operational
(`docs/mc-host-shm-transport.md:21`, `:65`, `:79`), the diagnostics reporter
emits the field (`ring_transport.rs:182`), and no `mc-host` code path can make it
nonzero because `Admission::quarantine`
(`mc-shm-transport/src/profile.rs:568`) has no `mc-host` caller. The doc is the
claim source, so the finding is a contract-versus-code disagreement, not a dead
field. Note that `:79`'s promise — "quarantined charges remain within the
configured process bound" — is satisfied vacuously, which is the shape that
makes this hard to notice from the test side: the two assertions that touch it
(`ring_transport.rs:774`, `:800`) assert `ZERO` and pass.

**L2 — the host fails closed on ring unavailability while `diagnostics()` still
says `healthy`.** `prepare` has five `Err(RingUnavailable)` returns:
admission rejection (`ring_transport.rs:239-242`), runtime-or-ring creation
failure (`:264-270`), descriptor marshalling failure (`:271-275`), thread-spawn
failure (`:294-296`), and initialization-channel loss (`:297`). Only the first
increments a counter. `diagnostics()` derives `state` exclusively from
`self.accounting()` (`:176-190`), which cannot observe any of the five. So a host
that has refused every connection for four of the five reasons reports
`state: "healthy"`, `error_class: null`, and all-zero counters. Sibling lens A
raised the same disagreement from the fail-closed side.

**L3 — the five-class terminal contract is asserted as one set and implemented in
two languages with a 1:4 split.** `docs/mc-host-shm-transport.md:53-59` states
the set without naming an owner, and `:71` says client diagnostics "use the same
terminal-class set". In code, `crates/` contains exactly one of the five literals
(`ring_transport.rs:187`, `"setup_failure"`); the other four are produced only by
`packages/plugin/src/shared/mc-host-client/shared-memory-failure.ts:10-30`. Worse
for auditability, that producer classifies by regular expression over error
*message text* (`:19` `/identity mismatch/i`, `:20`
`/(?:capacity|resource).*(?:exhaust|limit)/i`, `:26`
`/unexpected eof|peer.*(?:died|closed)/i`), matching strings minted in Rust
(`packages/mc-shm-native/src/setup.rs:360`, `:366`, `:373`). Nothing ties the two
sides. Listed again under conventionally-enforced-only.

**L4 — the attachment and activation counters can never differ, but the doctor
reports them as two facts.** `docs/mc-host-shm-transport.md:66` promises
"completed attachment and activation counts" as separate report fields, and
`diagnostics()` emits them separately (`ring_transport.rs:201-202`). Their only
call sites are adjacent and unconditional: `connection.rs:187-188` calls
`record_attachment()` then `record_activation()` with no branch between them. So
`attachment.completed` and `activation.completed` are provably equal for every
host incarnation, and the lifecycle distinction the connection-state diagram
draws (`docs/mc-host-shm-transport.md:26-36`, `Attached --> Active: activation
commits`) has no observable counterpart. This lead was not raised by sibling lens
A.

## Documentation describing deleted mechanisms

The refactor removed five files and renamed a sixth
(`scope-map-and-risk-ranking.md:40-48`). Checked both normative documents plus
all four scope files' doc comments against that deletion set.

**In the normative documents: none found, and that is a real result rather than
an absence of looking.** `docs/mc-host-shm-transport.md` was audited line by
line; its transport-selector, alternate-backend, compatibility-reader and
degraded-path statements are all *negative* claims (`:7`) that the deletion made
true, not descriptions of surviving machinery.
`docs/mc-host-wire-protocol.md:583-585` explicitly states "There is no provider
registration socket or transport-selection handshake", `:250-286` retains
`Hello`/`HelloAck` only as reserved-and-role-invalid numeric assignments, and
`:932-936` files the historical package behaviour as provenance with the
sentence "Any disagreement with old published or private behavior is migration
history, not permission to add a compatibility branch". The wire document was
written to survive this deletion.

**In the scope files' doc comments: none found.** No doc comment in
`ring_transport.rs`, `wire.rs`, `frame_channel.rs` or
`frame_channel/contract_tests.rs` names `provider_recovery`,
`tcp_frame_channel`, `transport_negotiation`, `transport_provider`,
`frame_read`, or `shm_provider`. The architecture gate would fail the build if
one did, since `scripts/check-mc-shm-architecture.ts:34` matches those names in
file *paths* and `:29` matches `provider_recovery` in source text over
`crates/mc-host/src`.

**One residual, and it is the opposite shape.** `contract_tests.rs:53-55` still
describes the `PeerDriver` trait's purpose as keeping the suite honest across
implementations — "Implementations must encode and decode independently of the
channel so the suite never uses the implementation to verify itself" — and
`:72-74` says "Each provider supplies one factory". The plural framing survives a
world with one factory (`:524`). This is not a deleted *mechanism*; it is a
rationale whose premise the deletion removed, which the re-scope already
identified as needing reframing rather than re-checking
(`scope-map-and-risk-ranking.md:255-259`). Recorded here so a synthesis pass does
not count it in either category by mistake.

## Conventionally-enforced-only claims

Seven claims stated somewhere and checked mechanically nowhere, or checked only
by name.

1. **The architecture gate is a text grep, and it is the only thing keeping the
   deleted transports deleted.** `scripts/check-mc-shm-architecture.ts` reads
   five source roots (`:7-13`), one file (`:15`) and six manifests (`:16-23`),
   and applies six source patterns (`:25-32`) plus a path pattern (`:34`) and a
   dependency pattern (`:35`). Three limits matter. It skips `.test.ts` files
   (`:48`) and never walks `crates/mc-host/tests/`, so a test could reintroduce
   `TcpListener` unseen. It matches names, not semantics: a reintroduced
   negotiation under any other identifier passes. And it never reads `docs/`, so
   no documentation drift is in its reach. Its one non-grep property is
   worth naming: `:59` fails when a required audit input is *missing*, so the
   gate also pins the continued existence of `packages/mc-shm-native/index.ts`
   and the five source roots.
2. **`RING_PROFILE` is a string literal shared across three languages by copy.**
   `ring_transport.rs:31` is `"mc-host-test-ring-v1"`;
   `packages/mc-shm-native/src/lib.rs:27` restates it as `PROFILE`;
   `packages/mc-shm-native/index.ts:8` restates it as
   `QUALIFIED_TEST_PROFILE`. Three definitions, no cross-check. The value is the
   release identity `docs/mc-host-shm-transport.md:11` fixes.
3. **`HEADER_LEN` and `MAX_FRAME_BODY_LEN` are re-declared in TypeScript as
   literals.** `protocol.ts:14` is `21` and `:18` is `67_108_864`, against
   `wire.rs:27` and `wire.rs:371`. `protocol.ts:4` names
   `docs/mc-host-wire-protocol.md` §6 as its authority in prose. No test parses
   the Rust constants, so the two sides agree by discipline.
4. **`POLL_INTERVAL` is one 50-microsecond literal serving three different
   waits.** `ring_transport.rs:33` is used as the outer-loop idle sleep (`:441`),
   the ingress-budget backoff (`:514`), and the peer endpoint's receive poll
   (`:685`). Nothing states that one value is correct for all three, and no test
   varies it.
5. **`DESCRIPTOR_DEPTH = 8` doubles into the documented 16 through a derivation
   in another crate.** `ring_transport.rs:32` feeds
   `mc-shm-transport/src/profile.rs:185-188`, which multiplies by 2. The doc
   states the post-doubling number (`docs/mc-host-shm-transport.md:77`).
   Nothing in `mc-host` asserts the derived charge vector, so a change to the
   doubling rule would silently invalidate the documented profile.
6. **The `ReadClose` enum carries `#[allow(dead_code)]`, which suppresses the
   compiler's own report on unproduced variants.**    `frame_channel.rs:32`, on the enum
   declared at `:33`. Two variants have no producer anywhere in
   `crates/mc-host/src`: `Io` (`frame_channel.rs:44-45`, consumed at
   `connection.rs:403`) and `RejectedDrainFailed` (`:46-47`, consumed nowhere).
   The `allow` is the reason nothing flags it.
7. **The five-class error-string coupling of lead L3.** Renaming a Rust error
   string reclassifies a TypeScript terminal class with no build failure on
   either side.

## Existing-check inventory

Every status is `unaudited`. Per METHOD an existing check never removes a
property from the catalog; adequacy belongs to
`/testing:invariant-test-review` for tests and
`/low-level-systems:defensive-assertions-and-invariant-guards` for guards.

### In-crate tests (clustered, counts, line ranges; note they never run in CI)

**35 in-crate tests reach this sub-part. None of them runs in CI.** The reason is
structural, not an omission: every `-p mc-host` invocation in `ci.yml` carries a
`--test <name>` filter, which selects one integration binary and excludes the lib
target entirely.

| Unit | Test module | Lines | Tests |
| --- | --- | --- | --- |
| `wire.rs` | `mod tests`, `:646-973` | 328 | **14** (`:673`, `:679`, `:692`, `:702`, `:721`, `:744`, `:776`, `:794`, `:835`, `:864`, `:888`, `:906`, `:938`, `:954`) |
| `frame_channel/contract_tests.rs` | whole file, gated at `frame_channel.rs:27-28` | 701 | **14** = 9 macro scenarios + 5 `mod ownership_contract` |
| `ring_transport.rs` | `mod tests`, `:753-966` | 214 | **7** (`:769`, `:777`, `:821`, `:829`, `:838`, `:881`, `:928`) |
| `frame_channel.rs` | none | 0 | **0** |

The contract-suite split, since the two halves have different reach:

- **9 semantic scenarios** defined in `frame_channel_contract_suite!`
  (`:415-473`) and instantiated once at `:524` against `RingFactory`. Bodies at
  `:110` (FIFO), `:149` (saturation and reserved control capacity), `:203`
  (completion hooks), `:247` (pre-admission cancellation), `:267`
  (post-publication failure), `:306` (graceful finish), `:330` (discard), `:353`
  (inbound ownership), `:386` (Goodbye). These drive a real `DuplexRing`.
- **5 in-process ownership tests** in `mod ownership_contract` (`:526-701`) at
  `:583`, `:591`, `:630`, `:673`, `:689`. These use synthetic spans and a
  `LeaseTracker`, not a ring. `:6-7` states they "cannot be selected as a
  production transport".

**Doctests: 2, and they are the only source-resident checks CI runs.**
`frame_channel.rs:296-301` and `:303-308`, both `compile_fail`, executed by
`cargo test -p mc-host --doc` (`ci.yml:190`, step "Rust lease non-escape").
`wire.rs:4-14` is a ```text``` fence and is not compiled.

**`#[ignore]`: none found. `should_panic`: none found.** Grepped all four scope
files. `ring_transport.rs:834` uses `catch_unwind` inside a test to assert a
non-panic, which is the inverse construction.

### Integration tests (with CI named/unnamed status and workflow line refs)

No integration binary is dedicated to this sub-part. Coverage arrives through the
shared harness: `tests/support/mod.rs` starts a real host (and therefore a real
ring) and `tests/support/raw_client.rs` drives the peer side through
`RingClientEndpoint::attach_with_descriptors` (`raw_client.rs:644`, with helpers
at `:765` and `:814`).

**10 of the 24 binaries use `support::TestHost` and therefore exercise the ring
datapath. 4 are named in CI; 6 are not.**

| Binary | Tests | CI status |
| --- | --- | --- |
| `client.rs` | 6 | **named** — `ci.yml:132`, `:179`, `:187` |
| `lifecycle.rs` | 35 | **named** — `ci.yml:179`, `:187` |
| `shm_failure_modes.rs` | 6 | **named** — `ci.yml:133`, `--test-threads=1` |
| `shm_soak.rs` | 2 | **partial** — `ci.yml:134-135` names `short_soak_keeps_fd_mapping_thread_and_rss_envelopes_bounded` with `--exact`; `release_eight_hour_source_tree_soak` (`:123`) additionally carries `#[ignore = "eight-hour source-tree resource soak"]` (`:122`) |
| `protocol_vectors.rs` | 15 | unnamed |
| `dispatch.rs` | 20 | unnamed |
| `routing.rs` | 12 | unnamed |
| `handler_contract.rs` | 12 | unnamed |
| `host_roundtrip.rs` | 4 | unnamed |
| `instance_security.rs` | 15 | unnamed |

The two publication-observability seams live here too:
`support/mod.rs:597` (`start_with_publish_hook`), `:614`, `:650`
(`mc_host::run_with_publish_hook`), against the production hook installer
`RingTransport::set_publish_hook` (`ring_transport.rs:229`) and its invocation
site (`:568-572`).

`tests/perf_measurement.rs` (23) and `tests/ipc_budget_evidence.rs` (14) name the
setup socket but are measurement and evidence-format suites; neither is named in
`ci.yml`. `tests/perf_budget_runner.rs` (10) and
`tests/ipc_budget_topology.rs` (9) are likewise unnamed.

### TypeScript-side gates

Four CI-run gates touch this sub-part's contract, all inside `shm-source-build`
(`ci.yml:137`).

| Gate | Command | Line | What it covers here |
| --- | --- | --- | --- |
| Plugin shared-memory contracts | `bun test packages/plugin/src/shared/mc-host-client` | `:211` | `protocol.test.ts` (32 tests) pins the 21-byte header, frozen-prefix decode order and the 64 MiB cap against literals in `protocol.ts:14`, `:18`. `shm-frame-channel.test.ts` (15) covers the nine terminal-class mappings at `:49-57` |
| Architecture audit | `bun test scripts/check-mc-shm-architecture.test.ts` and `bun run check:shm-architecture` | `:55`, `:58` | the deleted-transport grep gate of claim C1 |
| Plugin shared-memory lifetime (Node 24) | `bun run --cwd packages/plugin test:mc-shm:node` | `:214` | native lease and channel lifetime across the runtime boundary |
| Native behaviour | `bun run --cwd packages/mc-shm-native test:bun` and `test:node` | `:196`, `:203` | the peer half's mechanism gate, under `MC_SHM_NATIVE_CLAIMED_TARGET: "1"` |

**One TypeScript gate has no Rust counterpart and it belongs in the register.**
`ci.yml:219-223`, "Reject prebuilt native modules", runs
`test -z "$(git ls-files '*.node')"`, then removes
`packages/mc-shm-native/mc_shm_native.node` and asserts its absence. Verified:
`git ls-files '*.node'` returns zero paths at `HEAD`. Because the removal runs
*after* the four native and plugin test steps, every CI TypeScript test executes
against a locally built addon.

### Production assertions and guards (clustered)

**Assertion density in this sub-part is near zero, and the enforcement is
type-and-return-value rather than assertion.**

**`assert!` / `assert_eq!` / `panic!` / `unreachable!` / `todo!` in production
halves: none found.** All four scope files.

**`debug_assert!`: 1.** `frame_channel.rs:188-191`, "validated span capacity must
cover write", inside `ProducerReservation::write` after the span walk. It is a
`debug_assertions` gate, so it is present in a debug shipped binary and absent
from a release one. CI builds debug (`ci.yml:168-169` carry no `--release`), but
`packages/mc-shm-native/index.ts:189-191` rejects a non-release addon with
`NativeStartupError("debug_build")`, so the shipped host and the shipped addon do
not share a profile assumption. Which profile the distributed `mc-host` binary
uses is unresolved; see open questions.

**`.expect(`: 7, in three clusters.**

| Cluster | Sites | Labels |
| --- | --- | --- |
| Static profile construction | 2 | `ring_transport.rs:45` `"static hardware profile is valid"`, `:57` `"static shared-memory profile is valid"` |
| Mutex acquisition | 6 | `ring_transport.rs:230`, `:252` `"publish hook lock"`; `frame_channel.rs:419`, `:429`, `:433`, `:441` `"lease tracker lock"` |
| Ownership invariant | 1 | `frame_channel.rs:286` `"a committed body always owns its charge"` |
| Semaphore invariant | 1 | `wire.rs:418` `"byte budget semaphore is never closed"` |

The two ownership and semaphore labels state contracts. `frame_channel.rs:286` is
covered by `producer_failures_never_publish_and_return_each_charge_once`
(`contract_tests.rs:689`); `wire.rs:418` has no check that closes the semaphore.

**`.unwrap()`: none found** in any production half. Every `unwrap` in the four
files is inside a `#[cfg(test)]` module.

**`catch_unwind`: 2, both load-bearing and both on the endpoint thread.**
`ring_transport.rs:279-290` wraps the whole `run_endpoint` future, so an endpoint
panic falls through to `admission.release()` (`:291`) and
`done_tx.send(())` (`:292`) — a panicking worker is reported to the host as
orderly completion. `:560-563` wraps one publication, converting a panic into
`Err(())` and thus into channel retirement (`:447-451`). Sibling lens A's
`ring-a-endpoint-thread-panic-is-reported-as-orderly-completion` owns the first.
`publish_direct` adds a third layer through
`crate::panic_boundary::redact_sync` (`:586`).

**`let _ =` (discarded results): 8.** `ring_transport.rs:267`, `:273`
(initialization-channel sends on the two failure paths), `:279`
(the `catch_unwind` result itself), `:292` (`done_tx`), `:302` (`done_rx`),
`:345` (a `write!` into a `String`), `:396`, `:401` (inbound close
notifications). The two at `:396` and `:401` discard a send failure on the path
that reports a close reason, so a full inbound channel silently drops the
classification.

**Typed rejection guards.** Enforcement here is entirely by returned value.
`ReadClose::Corrupt` carries nine distinct `&'static str` reasons: six in
`ring_transport.rs` (`:467`, `:472`, `:477`, `:507`, `:521`, `:524`) and three in
`frame_channel.rs` (`:60` `"body over interoperability cap"`, `:67` `"invalid
pure-header flags"`, `:73` `"role-invalid frame type"`). Note that `:477` and
`:524` share one string, `"shared-memory completion failed"`, on two different
release sites. `RingUnavailable` (`ring_transport.rs:114-122`) and
`RingClientError` (`:737-751`) both collapse every cause into one opaque value
with a hand-written redacting `Debug` (`:739-743`).

## Suspiciously quiet areas

Ranked by the gap between what the code decides and what any check proves.

1. **The whole semantic contract suite runs nowhere but a developer's laptop.**
   14 tests over the neutral frame-channel boundary
   (`contract_tests.rs`), including the only checks on FIFO admission ordering,
   saturation and reserved control capacity, completion-hook exactly-once
   ordering, discard charge release and graceful drain. All are `#[cfg(test)]` in
   the lib target (`frame_channel.rs:27-28`), and no `ci.yml` step builds the
   `mc-host` lib test target. This is the quietest thing in the sub-part not
   because coverage is thin but because it is *good* and unexecuted, which is the
   failure mode a coverage count cannot show.

2. **`prepare`'s four uncounted failure paths.** `ring_transport.rs:264-270`,
   `:271-275`, `:294-296` and `:297` each return `RingUnavailable` without
   touching `exhaustions` or any other counter, and `diagnostics()` cannot
   observe them (lead L2). No test drives any of the four: there is no seam to
   fail `tokio::runtime::Builder::build`, `DuplexRing::create`,
   `worker_descriptor`, or `thread::Builder::spawn`. So the branch that turns a
   host into a connection-refusing black box with a healthy diagnostic report is
   both unobservable in production and unreachable in test.

3. **Nothing publishes a maximum-size frame through a real ring.** The 64 MiB
   conformance obligation (claim C11) is checked only over synthetic spans
   (`contract_tests.rs:673-679`). Against the real geometry it is tight in a way
   worth stating: the arena is exactly `MIN_ARENA_BYTES` = 64 MiB per direction
   (`ring_transport.rs:48`, `mc-shm-transport/src/arena.rs:4-6`), so one in-flight
   maximum body consumes the entire arena and the profile's eight descriptor
   slots collapse to a single usable frame. Whether `reserve_until` then blocks
   until the frame deadline or fails immediately is undetermined by any check in
   this sub-part.

4. **The oversize channel-0 rejection path has no test at all.**
   `ring_transport.rs:474-485` releases the lease, synthesizes
   `InboundEvent::Rejected` and continues the generation — the one inbound branch
   that neither delivers a frame nor closes the connection. `MAX_CONTROL_BODY_LEN`
   (`wire.rs:374`) appears in no test in the sub-part. The re-scope predicted this
   mechanism differs from the drain it replaced
   (`scope-map-and-risk-ranking.md:266-271`); it is also unexercised.

5. **`ReadClose::RejectedDrainFailed` has no producer and no consumer, and
   `#[allow(dead_code)]` hides it.** The variant is `frame_channel.rs:47`, and
   its doc comment at `:46` reads "Realignment after a rejected frame failed",
   which describes a resynchronization step the ring cannot need: a published
   descriptor names one complete header and body
   (`docs/mc-host-wire-protocol.md:292`). Sibling lens A's
   `ring-a-rejected-drain-failure-close-has-no-producer` owns the producer half.
   `ReadClose::Io` (`:45`) is similar in shape — consumed at
   `connection.rs:403`, produced nowhere. Both survive only because of the
   `allow` at `frame_channel.rs:32`.

6. **The publish hook is a `#[doc(hidden)]` production mutex on the hot path,
   and only the harness reads it.** `RingTransport::publish_hook`
   (`ring_transport.rs:100`) is locked once per `prepare` (`:252`) and the hook
   runs on the endpoint thread after every commit (`:568-572`), decoding the
   header a second time to do so (`:569`). Its only callers are
   `set_publish_hook` (`:229`) and the test harness
   (`support/mod.rs:597`, `:614`, `:650`). No check asserts that a `None` hook
   costs nothing, and the doc comment's promise that it "receives no descriptors,
   payloads, or provider data" (`:36-37`) is held by the `Fn(FrameType, u16)`
   signature alone.

7. **`process_limits`'s overflow returns are unreachable from any test.**
   Eight `checked_mul` calls (`ring_transport.rs:75-88`) implement the
   "checked arithmetic" the doc promises (`docs/mc-host-shm-transport.md:77`).
   Nothing calls `process_limits` with a connection count large enough to
   overflow, so the `None` path — which a caller must translate into a startup
   refusal — is never observed.

8. **`macos-15-intel` builds this code and runs none of its tests.** The
   `shm-source-build` matrix (`ci.yml:137-145`) includes three targets, but the
   Rust test steps are gated `if: runner.os == 'Linux'` (`:175`) and
   `if: runner.os == 'macOS'` (`:182`). `macos-15-intel` reports
   `runner.os == 'macOS'`, so it does run the macOS leg; what no leg runs is the
   `mc-host` lib target on any platform. Recorded because the platform contract
   (`docs/mc-host-shm-transport.md:85`) makes macOS ring behaviour the one
   explicitly unresolved release risk, and the checks that would exercise it are
   the unexecuted in-crate ones.

## Open questions

- Does the distributed `mc-host` artifact ship debug or release? It decides
  whether the single `debug_assert!` (`frame_channel.rs:188`) is present in
  production. CI builds debug (`ci.yml:168-169`, no `--release`), while the addon
  loader refuses a non-release addon
  (`packages/mc-shm-native/index.ts:189-191`), so the two halves of one
  deployment disagree about the profile. Needs the release pipeline, not this
  tree. (needs human input)
- Is a never-executed test `Exercised: partial` or `Exercised: not yet`? It
  governs all 35 in-crate checks above, which is the majority of this sub-part's
  coverage. The 4e inventory records the same question as unresolved across five
  sub-parts (`../../part-4e-rendering/existing-checks.md:840-846`). A synthesis
  pass must not decide it silently. (needs human input)
- Are `shm-crash-recovery` (`ci.yml:111`) and `shm-source-build` (`:137`)
  required status checks for merge? Unverifiable from workflow content; it is
  repository settings. Carried forward from
  `scope-map-and-risk-ranking.md:750-752`.
- Should lead L4 (attachment and activation counters are provably equal) be a
  property record, a documentation correction, or a signal that one of the two
  call sites at `connection.rs:187-188` was meant to move? `connection.rs` is
  Part 2a scope, so the answer crosses a part boundary. Unresolved.
- Is the ring `default-production` or `explicit-config-only`? Carried forward
  unresolved from `scope-map-and-risk-ranking.md:732-737`. This lens adds two
  data points without settling it: `RingClientEndpoint` is doc-commented
  "Thread-confined peer endpoint for integration tests"
  (`ring_transport.rs:626`) yet `lib.rs:21` exports the module `pub` and
  `tests/support/raw_client.rs:644` reaches it, while the profile string
  `"mc-host-test-ring-v1"` (`:31`) is what
  `docs/mc-host-shm-transport.md:11` names as the *release* identity. A
  test-named profile that the release contract pins is the reachability question
  in one sentence.
- Does `ReadClose::RejectedDrainFailed` describe an obligation the ring
  inherited from the deleted TCP reader, or one it still owes? If the former, the
  variant and its `#[allow(dead_code)]` are refactor residue; if the latter,
  there is a missing producer. `frame_channel.rs:46-47` alone cannot distinguish
  them.
