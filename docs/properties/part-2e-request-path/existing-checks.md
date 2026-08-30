# Sub-part 2e existing-check inventory

Every claim-bearing check for admission, dispatch, and the response obligation:
`crates/mc-host/src/dispatch.rs` (1,539 lines), `control.rs` (1,180),
`routing.rs` (833), `handler.rs` (604), `composite.rs` (390), the six
integration binaries whose subject is the request path, the four
`compile_fail` doctests, and the CI steps that reach any of them.

Provenance: system `/local/home/ahrav/scratch/magic-context`, branch
`feat/shared-memory-release-gate-audit`, `HEAD` = `e447c927`. Counts come from
lens B, which derived each by extracting the production half of each file and
grepping it so no test-module hit is included. This synthesis re-derived the
file lengths with `wc -l`, the `#[cfg(test)]` boundaries by grep, the
`routing.rs` panic sites by grep, and the `ci.yml` hit list by grep, and
records each correction where it lands.

**Every status below is `unaudited`.** An existing check never removes a
property from the catalog. Test adequacy belongs to
`/testing:invariant-test-review`; production guard adequacy belongs to
`/low-level-systems:defensive-assertions-and-invariant-guards`.

## The coverage fact that frames this inventory

**37 in-crate tests and 84 integration tests reach this sub-part. Of the binaries
that carry them CI names none, and four `compile_fail` doctests do run, so 2e owns
four of the six CI-executed source-resident checks in the whole `mc-host`
library. One catalog record additionally has a CI-executed check in a binary
outside the six; see the correction under "Integration tests".**

| Unit | Where | Lines | Tests | Executed in CI |
| --- | --- | --- | --- | --- |
| `control.rs`, `mod tests` at `:710-1180` | one module | 471 | **23** | **No** |
| `routing.rs`, `mod tests` at `:454-833` | one module | 380 | **12** | **No** |
| `dispatch.rs`, `mod tests` at `:1498-1539` | one module | 42 | **2** | **No** |
| `handler.rs` | no test module | 0 | **0** | n/a |
| `composite.rs` | no test module | 0 | **0** | n/a |
| Six integration binaries | `tests/` | 4,993 | **84** | **No** |
| `handler.rs` doctests | four `compile_fail` fences | — | **4** | **Yes**, `ci.yml:190` |

The reason the 121 tests do not run is structural rather than an omission. Every
`-p mc-host` test invocation in `ci.yml` carries a `--test <name>` filter, which
selects one integration binary and never builds the lib target: `:132`, `:133`,
`:134-135`, `:178-179`, `:187`. Re-verified at `HEAD`: the 13 `mc-host` hits are
`:87` (a Bun drift gate), `:132`, `:133`, `:134`, `:168`, `:169` (both
`cargo build`), `:178`, `:187`, `:190` (the doctest step), `:211`, `:361`,
`:442`, and `:461`. None is an unfiltered `cargo nextest run -p mc-host` or a
`--lib` run, and none names any 2e binary.

> **Correction to lens A's heading count.** Lens A's reachability evidence 3
> says "Only two of this sub-part's five test binaries run in CI", and then its
> own body lists the CI-named binaries as `client`, `lifecycle`,
> `shm_failure_modes`, and `shm_soak`, none of which is a 2e binary. Lens B
> enumerates six binaries whose subject is the request path and finds zero
> named. Lens B is right, and lens A's per-record `Not in CI.` lines agree with
> lens B; only the heading count was wrong. Re-verified here from the `ci.yml`
> hit list above.

### In-crate tests, 37 in five clusters

**The distribution is the finding.** The file that owns settlement, terminal
arbitration, and all five silent exits carries **2** of the 37, and both test a
length-arithmetic helper.

| Cluster | Tests | Sites |
| --- | --- | --- |
| Channel-0 parse bounds, strictness, and classification | **17** | `control.rs:824`, `:830`, `:838`, `:845`, `:851`, `:863`, `:876`, `:883`, `:908`, `:937`, `:964`, `:978`, `:990`, `:1010`, `:1020`, `:1027`, plus one in the same span |
| Route slot lifecycle, epoch advance, close and bind races | **12** | `routing.rs:511`, `:530`, `:546`, `:570`, `:598`, `:619`, `:642`, `:671`, `:689`, `:728`, `:774`, `:801` |
| Catalog and response-shape fidelity | **4** | `control.rs:1045`, `:1085`, `:1103`, `:1112` |
| Route-open parse and identity bounds | **2** | `control.rs:765`, `:780` |
| Error-body length model | **2** | `dispatch.rs:1502`, `:1524` |
| **Total in-crate** | **37** | |

The full `control.rs` site list is `:765`, `:780`, `:812`, `:824`, `:830`,
`:838`, `:845`, `:851`, `:863`, `:876`, `:883`, `:908`, `:937`, `:964`, `:978`,
`:990`, `:1010`, `:1020`, `:1027`, `:1045`, `:1085`, `:1103`, `:1112`, which is
23.

The tests named by catalog records are:

| Line | Test | What it covers |
| --- | --- | --- |
| `dispatch.rs:1502` | (error-body length model) | `error_body_len` (`:115`), the hand-written escaping model. Touches no terminal |
| `dispatch.rs:1524` | `diagnostic_limit_substitution_drops_retry_hint` | `bounded_terminal_error` (`:82`) only. Does **not** cover the `BindOutcome::Reject` copy of the same policy at `:1206-1218` |
| `routing.rs:570` | (channel reuse) | reuse permitted only after prior work settles and the epoch advances |
| `routing.rs:598` | (epoch retirement) | permanent retirement at `u32::MAX` |
| `routing.rs:619` | (close racing bind) | the legal close-versus-bind transitions |
| `routing.rs:642` | (route-gone claiming) | exactly one racing closer claims route-gone; `:667` asserts `won == 1` |
| `routing.rs:689` | (idempotent duplicate close) | duplicate route `Goodbye` is a no-op |

**`#[ignore]`, `should_panic`, `loom`, `shuttle`, `miri`, `proptest`,
`quickcheck`, `arbitrary`: none found** in any of the five files. There is no
coverage instrumentation, so every placement statement in this file is
structural rather than measured.

## Integration tests

**Six of the 24 binaries are the natural home for this sub-part's claims, and CI
names none of them.**

| Binary | Tests | Lines | CI status |
| --- | --- | --- | --- |
| `tests/dispatch.rs` | 20 | 1,157 | **unnamed** |
| `tests/composite_routing.rs` | 16 | 1,049 | **unnamed** |
| `tests/protocol_vectors.rs` | 15 | 762 | **unnamed** |
| `tests/handler_contract.rs` | 12 | 672 | **unnamed** |
| `tests/routing.rs` | 12 | 640 | **unnamed** |
| `tests/broca_protocol.rs` | 9 | 713 | **unnamed** |
| **Total** | **84** | 4,993 | **0 named** |

The four binaries CI does name are `client` (`ci.yml:132`, `:179`, `:187`),
`lifecycle` (`:179`, `:187`), `shm_failure_modes` (`:133`, with
`--test-threads=1`), and `shm_soak` (`:134-135`, one test by `--exact`). So
**4 of 24 named, 20 unnamed**, and every binary whose subject is the request
path falls in the unnamed 20.

This is the load-bearing coverage observation. The sub-part is *well tested* and
*barely gated*: 84 integration tests plus 37 in-crate tests is 121 claim-bearing
checks, and the number CI executes is zero.

> **Correction applied during disposition: one catalog record does have a
> CI-executed check, and this inventory's own table above contains the evidence.**
> The sentence "the number CI executes is zero" is true of the 121 checks counted
> here. It is false as a statement about record coverage, which is how it was read
> by the catalog and the fault map. `tests/lifecycle.rs:576-657`
> `shutdown_refuses_new_routes_and_new_routed_work` sends a `route.open` and a
> routed request into one draining host and asserts `target_unavailable` at `:638`
> and `server_busy` at `:657` — which is
> [req-a-shutdown-rejects-routed-and-control-work-under-divergent-codes](catalog.md#req-a-shutdown-rejects-routed-and-control-work-under-divergent-codes)
> in full, in the record's own shape, including the parked handler that holds the
> drain open (`:582`, `:590-606`). `lifecycle` is named at `ci.yml:178-179`
> (Linux) and `:187` (macOS), so the check runs on two platforms. It is not in the
> six-binary count because that count is by binary *subject*, and `lifecycle`'s
> subject is the host lifecycle; the record it happens to assert belongs to 2e.
> Counting by subject rather than by assertion is the mechanism of the error.
> Status `unaudited`.

The integration tests named by catalog records:

| Site | Test | Record it serves |
| --- | --- | --- |
| `tests/dispatch.rs:271` | `an_unknown_route_is_refused_with_zero_dispatch` | pre-dispatch rejection |
| `:295` | `saturated_request_capacity_returns_server_busy_without_dispatch` | pre-dispatch rejection, permit-pair bound, parked handler, saturation |
| `:358` | `cancel_and_completion_settle_exactly_once` | at-most-one terminal |
| `:453` | `simultaneous_cancel_and_completion_still_emit_one_terminal` | at-most-one terminal |
| `:504` | `cancelling_a_stream_stops_it_with_one_terminal` | at-most-one terminal |
| `:665` | `oversized_handler_output_cannot_corrupt_framing` | the response ceiling, not the emptiness gap |
| `:788` | (egress budget saturation) | the precondition of `busy_rejects` exhaustion |
| `:835` | `closing_a_route_settles_its_admitted_work` | no emission after retirement |
| `:976` | `saturated_broca_reserve_cannot_consume_a_general_slot` | class separation |
| `:1074` | `saturated_general_capacity_cannot_consume_the_broca_reserve` | class separation |
| `tests/routing.rs:98` | `unsupported_operations_leave_the_generation_usable` | control rejection paths |
| `:212` | `malformed_control_bodies_are_refused_before_handler_work` | control rejection paths |
| `:396` | `rejected_bind_never_publishes_and_still_reports_route_gone` | route.open answering exits |
| `:435` | `closed_route_requests_are_unknown_and_cleanup_is_idempotent` | no emission after retirement |
| `:570` | `route_capacity_exhaustion_is_refused_without_binding` | route.open answering exits |
| `tests/handler_contract.rs:229` | `a_rejected_bind_carries_the_handler_code_to_the_client` | route.open answering exits |
| `:323` | `reservations_must_leave_one_general_slot_in_each_pool` | permit-pair bound |
| `:636` | `zero_reservation_handlers_keep_single_pool_admission` | permit-pair bound |
| `tests/lifecycle.rs:576` | `shutdown_refuses_new_routes_and_new_routed_work` | the divergent shutdown codes, in full and **in CI** (`ci.yml:178-179`, `:187`). Added during disposition; the record's `Existing check:` read `none` |

One inventory note carried forward from lens B for a later pass:
`tests/broca_subprocess.rs` is 3,220 lines and a grep for `#[test]` or
`#[tokio::test]` returns **zero**, so it is either a shared-helper binary or
uses a macro-generated form. Not resolved here, and it affects the integration
count if it is a test binary.

## Doctests

**Four, all `compile_fail`, all in `handler.rs`, and all executed by CI.** This
is the one place 2e beats both siblings, and it is why the sub-part is worth
separating from 2b and 2d in every coverage statement.

| Site | Forbids |
| --- | --- |
| `handler.rs:213-219` | `RequestOutcome::Response { body: Vec::<u8>::new(), .. }` |
| `handler.rs:425-427` | `ctx.corr` |
| `handler.rs:429-431` | `ctx.socket` |
| `handler.rs:433-435` | `ctx.credentials` |

They run because `handler.rs` is `pub mod` (`lib.rs:17`) and `ci.yml:190` runs
`cargo test -p mc-host --doc` under the step name "Rust lease non-escape",
printed and confirmed here.

The crate-wide picture, derived by grepping every doc fence under
`crates/mc-host/src/`: **six compiled doctests exist in the whole library**, all
`compile_fail` — these four plus `frame_channel.rs:296-301` and `:303-308`,
which are 2b's and are that sub-part's only CI-executed source-resident checks.
2d has zero. Two further fences are `text` and are not compiled
(`wire.rs:4-14`, `generation.rs:6-11`).

Two qualifications on what the four prove.

- **The three `RequestCtx` doctests are negative structural checks.** Each
  asserts that a field name does not resolve, so a field renamed rather than
  removed still fails them. They pin absence, not privacy.
- **`handler.rs:213-219` is stronger and is load-bearing for a contract
  disagreement.** `OutputBuffer`'s `pub(crate)` fields (`:332-335`) make the
  failure a type error no rename can satisfy, and the construction it forbids is
  exactly the one protocol `:673` describes ("Handler `Response(Vec<u8>)`
  becomes `Response`"). So a CI-executed check fails the build if the documented
  API ever becomes possible.

**`control.rs`, `dispatch.rs`, `routing.rs`, and `composite.rs` contain zero doc
fences of any kind.** Four of the five files, including the one that decides
every terminal, do not use the sub-part's only CI lane.

## Production assertions and guards, clustered

Enforcement in this sub-part is overwhelmingly by returned value and typed
state. Counts were derived from each file's production half only.

**`.expect(`: 34, in four clusters. The distribution is the finding: 30 of the
34 are mutex-poisoning labels, not contracts.**

| Cluster | Sites | Label |
| --- | --- | --- |
| Registry and membership locks | 16 | `routing.rs:114`, `:163`, `:174`, `:192`, `:210`, `:237`, `:262`, `:277`, `:300`, `:331`, `:345`, `:361`, `:378`, `:399`, `:421`, `:437` — `"registry lock"` / `"membership lock"` |
| Pending, connections, and composite maps | 9 | `dispatch.rs:916`, `:1098`, `:1335`, `:1376`, `:1412`, `:1490`; `composite.rs:141`, `:268`, `:301` |
| Infallible serialization | 6 | `dispatch.rs:235`, `:237`, `:241`, `:717`, `:1464`; `control.rs:261`, `:531`, `:604` |
| Real stated contracts | 1 | `dispatch.rs:1126` `"validated route.open target is indexed"` |

`dispatch.rs:1126` is the only one that states a cross-module invariant:
`open_route` expects `parse_control` to have already indexed the target, so a
validation path that admits an unindexed target converts a rejection into a
panic. Nothing couples the two sites. Status unaudited for all 34.

**Unlike `client.rs`, which routes every poisoning through `lock_unpoisoned`,
these 30 lock sites propagate the panic.** `composite.rs` is the only file in
the sub-part with a panic boundary (`catch_unwind` at `:165`, entered from
`:374`, `:378`, `:382`), and it wraps child polls rather than lock acquisition.

**Production panic sites: 3.** Re-verified here by grepping `routing.rs` for the
panic family: `:184`, `:446`, and `:447` are the only hits in the production
half, and `:506-507`'s two `panic!` calls are inside the test module.

| Site | Form | Reachability |
| --- | --- | --- |
| `routing.rs:184` | `unreachable!("bind completion found route in {state:?}")` | Catch-all arm of the bind-completion state match |
| `routing.rs:446-450` | `panic!("{op}: registry lost route it owns")` then `assert_eq!(occupant.epoch, handle.epoch, "{op}: registry occupant epoch diverged")` | `expect_occupant`, called on every occupant mutation |
| `composite.rs:387` | `panic!("{}", failures.join("; "))` | Deliberate: converts child shutdown failure into a failed callback the runtime can classify |

`routing.rs:441-451` is the densest guard pair in the sub-part and the only
place where a `panic!` and an `assert_eq!` guard the same read. Both fire
unconditionally in release. `composite.rs:387` is a designed signal, not a
defect, and the comment at `:363-369` says so; its payload is already redacted,
because `shutdown_failure_note` (`:182-186`) emits only `err.0.len()` for an
error and drops panic payloads entirely. Worth recording because prior lens
material flagged shutdown-error formatting as defeating its own redaction
contract; in the current code it does not. Status unaudited for all three.

**`debug_assert`: 1.** `dispatch.rs:212`,
`debug_assert_eq!(body.len(), body_len, "escaped length model diverged")`.
Compiled out of a release profile without `debug-assertions`, and its two
supporting tests (`:1502`, `:1524`) never run in CI, so in a release host the
model at `:101-124` is unchecked and it feeds a byte charge. Status unaudited.

**`let _ =` discarded results: 12, in three clusters.**

| What is discarded | Sites |
| --- | --- |
| Write-completion and start signals where the receiver may be gone | `dispatch.rs:679`, `:815`, `:1074`, `:1475` |
| Cancellation and pending-map calls | `dispatch.rs:735`, `:806`, `:1003` |
| The bounded Goodbye completion wait | `dispatch.rs:1483` |

`handler.rs`'s four `let _ =` occurrences are all inside the doctests (`:215`,
`:426`, `:430`, `:434`); its production half has none. `control.rs`,
`routing.rs`, and `composite.rs` have none. Status unaudited.

**Checked and saturating arithmetic: 6.** `checked_` once and `saturating_` four
times in `dispatch.rs` (the length model and the terminal budgets),
`saturating_` once in `control.rs`, and once in `handler.rs:382`
(`OutputBuffer::extend_from_slice`'s remaining-capacity computation, which is
what makes the reservation a hard ceiling). Status unaudited.

**Typed rejection guards.** This is where the real enforcement lives.
`control.rs:13-20` mints eight channel-0 rejection codes as `pub const`, and
`control.rs:22-25` mints the four operation names (`route.open`, `catalog.list`,
`host.shutdown`, `host.status`) as byte literals. `dispatch.rs:79-80` bounds
handler-authored diagnostics at `MAX_TERMINAL_CODE_LEN` = 128 and
`MAX_TERMINAL_MESSAGE_LEN` = 4096 through `bounded_terminal_error` (`:82`), with
a second hand-written copy at `:1211`. Status unaudited.

**Explicit "none found".** No fuzz target reaches any of the five files. No
benchmark asserts a behavioural claim here. No snapshot or golden fixture in the
five files. No differential harness against the TypeScript peer. No coverage
instrumentation. No `catch_unwind` outside `composite.rs`. No `todo!` or
`unimplemented!` anywhere in the sub-part. No `assert!`, `assert_eq!`, or
`.unwrap()` in the production half of `dispatch.rs`, `control.rs`, or
`handler.rs`.

## Claims stated somewhere and checked mechanically nowhere

Six, each held by discipline rather than by a build step.

1. **The two terminal-diagnostic caps are stated nowhere normative.**
   `MAX_TERMINAL_CODE_LEN` = 128 and `MAX_TERMINAL_MESSAGE_LEN` = 4096
   (`dispatch.rs:79-80`) bound every handler-authored terminal and every bind
   rejection. Conformance vector V24 requires bounded observability but fixes no
   number. The client's independent equivalents are 128 and **512**
   (`client.rs:112-113`), so a handler message between 513 and 4,096 bytes is
   inside the host's cap and outside the client's, and nothing compares the two.
2. **The bind-rejection cap is coupled to the terminal cap by comment only.**
   `dispatch.rs:1205-1209` says "Same caps as request-error terminals" and then
   restates the comparison inline at `:1211` rather than calling
   `bounded_terminal_error`. Two sites, one stated invariant, no shared
   definition.
3. **The eight control codes are duplicated on the TypeScript side.**
   `control.rs:13-20` mints them as `pub const`; the managed TypeScript client is
   bound by the same normative vocabulary and carries its own literals.
   `ci.yml:211`'s Bun suite tests the TypeScript client against its own
   constants, so nothing cross-checks the two spellings.
4. **The four operation names are byte literals on both sides.**
   `control.rs:22-25` against the document's Sections 7.2, 7.3, 7.6, and the
   `host.shutdown` request and response examples at `:541` and `:545`. A rename
   on either side changes the wire and fails no build.
5. **The `unreachable!` at `routing.rs:184` states a coupling nothing
   enforces.** It is sound only while every state that reaches bind completion is
   enumerated above it. Adding a state to the slot machine without extending
   that match turns a registry bug into a production panic under the registry
   mutex.
6. **`escaped_json_len` is a hand-written length model for a serializer it does
   not call.** `dispatch.rs:101` computes the encoded length of an error body and
   `:212` checks the result with a `debug_assert_eq!`. Because it is a
   `debug_assert`, the check is compiled out of any release profile that leaves
   `debug-assertions` off, and the two in-crate tests that exercise the model
   never run in CI.

## Documentation describing deleted mechanisms

**One, and it is in the normative document rather than in source.** Protocol
`:673`'s "Handler `Response(Vec<u8>)` becomes `Response`" describes a mechanism
that genuinely existed and was removed. Lens B established this by history
rather than by inference: `git log -S'body: Vec<u8>,' --
crates/mc-host/src/handler.rs` returns `cf281ace` (the commit that added
`mc-host`) and `ef66e349` ("fix(mc-host): address PR #6 review findings"), and
`git log -S'```compile_fail' -- crates/mc-host/src/handler.rs` returns
`cf281ace` and `98b7270d`. The document line dates from `d0dbb25a` and has not
moved. The current variant is `RequestOutcome::Response { body: OutputBuffer,
binary }` (`handler.rs:224`), and the reservation mechanism the code enforces —
`OutputBuffer`, `reserve_output`, `output_from_writer` — appears nowhere in
`docs/mc-host-wire-protocol.md`, grepped, zero hits.

**No source comment in this sub-part describes a deleted mechanism.** Checked
explicitly, because the refactor deleted five files and 26,606 lines from this
crate and prior lens work cited them. Grepping all five 2e files for
`tcp_frame_channel`, `transport_negotiation`, `transport_provider`,
`provider_recovery`, `frame_read`, `shm_provider`, `negotiate`, `Serveable`, and
`fallback` returns **zero hits**. The request path never named the transport it
sat on, which is why it survived the deletion with its comments intact.

**One residual of the opposite shape, recorded so a later pass does not miscount
it as deleted.** The normative document names `McHandler` at nine sites (`:43`,
`:292`, `:596`, `:600`, `:626`, `:634`, `:685`, `:800`, `:906`) and no such type
exists in this crate. That is a **forward** reference: `handler.rs:3` says
`magic-context-c50.4` will adapt `McHandler` onto this boundary, while the code
carries the boundary that exists, `McHostHandler` (`:558`). Counted once, and
deliberately kept out of the deleted-mechanism section.

## Claims with no implementing code

Four, from lens B's 20-claim register. Two of the four are in the normative
document rather than in source.

| # | Claim | Source | Status |
| --- | --- | --- | --- |
| 4 | Handler `Response(Vec<u8>)` becomes `Response` | protocol `:673` | **A compiled doctest forbids it** (`handler.rs:213-219`) |
| 8, second clause | Under `panic=abort` any panic kills the process | `handler.rs:555-557` | **No code, and unfalsifiable in-tree** |
| 10 | `magic-context-c50.4` will adapt `McHandler` onto this boundary | `handler.rs:3` | **No `McHandler` exists in this crate**; the trait is `McHostHandler` (`:558`) |
| 20, acknowledgement half | Anything published without an observed terminal is `outcome_unknown` | protocol `:669`, `:692` | **No delivery acknowledgement exists for routed terminals** |

## Suspiciously quiet areas

Three, ranked by the gap between what the code decides and what any check
proves. The framing point that applies to all three: this is not thin coverage.
121 claim-bearing checks reach this sub-part and the `control.rs` and
`routing.rs` suites are dense and well built. What is quiet is a specific seam.

1. **`dispatch.rs` decides every terminal on 1,497 production lines and carries
   2 in-crate tests, both about length arithmetic.** Those lines own `Settlement`
   (`:34`), `settle` (`:399`), `dispatch_request` (`:828`), `open_route`
   (`:1103`), `close_generation` (`:1394`), `force_close_all_routes` (`:1421`),
   and `handle_cancel` (`:1489`). The two tests at `:1502` and `:1524` cover
   `error_body_len` (`:115`). Neither runs in CI and neither touches a terminal.
   Every one of the file's five silent exits, the emptiness gap at `:1031`, and
   the missing acknowledgement at `:447-460` sits in the same file, so the three
   highest-consequence findings in this catalog all land where in-crate coverage
   is thinnest. `tests/dispatch.rs` (20 tests) is the real coverage, and CI does
   not name it. Owned by
   [req-a-an-admitted-routed-request-emits-at-most-one-terminal-frame](catalog.md#req-a-an-admitted-routed-request-emits-at-most-one-terminal-frame),
   [req-a-a-handler-response-is-length-checked-and-never-content-checked](catalog.md#req-a-a-handler-response-is-length-checked-and-never-content-checked),
   and
   [req-a-a-routed-terminal-carries-no-delivery-acknowledgement](catalog.md#req-a-a-routed-terminal-carries-no-delivery-acknowledgement).

2. **The silent exits emit no terminal, no cause, and no counter.** At `:1058`,
   `:1164`, `:1174`, and `:1199` the code emits no frame, records no cause, and
   increments no metric; `remove_pending` (`:1097`) removes the entry and returns
   nothing. The comments at `:1162-1163` and `:1171-1173` argue each case
   correctly on ordering grounds, and the arguments are sound — running
   route-gone beside a still-executing bind would be worse than leaving the
   correlation unsettled. What is quiet is that the *chosen* outcome has no
   observation point. A caller learns only by its own deadline expiring, which is
   indistinguishable from a slow handler, and a host operator learns nothing at
   all. `:637-638` compounds it: `gen.token.cancel()` then
   `gen.writer.discard()` drops **other correlations' already queued terminals**
   with the same absence of a counter. Contrast `ring_transport.rs:209-228`,
   which maintains four lifecycle counters for a strictly less consequential set
   of events. Owned by
   [req-a-a-pre-dispatch-rejection-is-emitted-or-the-generation-is-retired](catalog.md#req-a-a-pre-dispatch-rejection-is-emitted-or-the-generation-is-retired),
   [req-a-a-route-open-is-answered-unless-the-host-is-failing-or-draining](catalog.md#req-a-a-route-open-is-answered-unless-the-host-is-failing-or-draining),
   and
   [req-a-every-pending-entry-is-removed-by-its-owner-or-its-route-close](catalog.md#req-a-every-pending-entry-is-removed-by-its-owner-or-its-route-close).

   **Ownership correction applied during disposition: one of the four exits is
   owned by nothing.** The three records above cover `:637-638` (pre-dispatch),
   `:1164`, `:1174`, and `:1199` (all three control `route.open` exits). The
   fourth, `:1058`, is the *only* one of the five that concerns an admitted routed
   request's settlement — it returns before the `settle` call at `:1063` — and no
   record asserts its silence. The pending-entry record cites `:1059`, which is the
   `remove_pending` on the same arm, so it covers the entry's removal and not the
   missing terminal. Queued as a gap in
   [portfolio-evaluation.md](portfolio-evaluation.md).

3. **`routing.rs` holds 3 unconditional production panics in a process-global
   structure, and no check drives any of them.** `:184`, `:446`, and `:447-450`
   all fire in release, all inside code holding the registry mutex (`:114` and 15
   sibling sites), and the module doc at `:3-8` makes this registry the single
   owner of every route in the host. A panic there poisons the mutex, and unlike
   `client.rs` there is no `lock_unpoisoned` recovery: the next of 16
   `.expect("registry lock")` sites converts one bad state transition into a
   cascade across every connection. The 12 in-crate tests cover the legal
   transitions thoroughly (`:570` reuse, `:598` epoch retirement, `:619` close
   racing bind, `:642` route-gone claiming) and none constructs the illegal state
   the guards exist for, which is correct for a test suite and leaves the guards'
   own reachability unestablished. `expect_occupant` (`:441`) is called on every
   occupant mutation, so it is the most-executed guard in the sub-part and the
   least characterised. Owned by no record: this is recorded as a quiet area
   rather than cataloged, because the illegal state is not injectable and lens B's
   own open question says establishing its reachability needs a `Slot`/`Occupant`
   state model that no pass has attempted.

## Sampling limits on this inventory

Stated so a later pass knows what was and was not looked at.

- Test counts are grep counts of attribute lines, not execution counts. The
  in-crate site lists come from lens B, which printed each; this synthesis
  re-derived the `#[cfg(test)]` module boundaries and the file lengths but did
  not re-print all 37 sites.
- CI reach was determined from workflow content only. Whether
  `shm-crash-recovery` (`ci.yml:111`) and `shm-source-build` (`:137`) are
  **required** status checks for merge is repository settings and is not
  verifiable from this tree. That decides whether "unnamed in CI" means ungated
  or merely unexecuted-in-one-job. Carried forward unresolved from
  `../part-2-rescope/scope-map-and-risk-ranking.md:750-752`.
- The six integration binaries were counted and their subjects identified, but
  only the tests named by catalog records were read. Their other tests may bear
  on records; this inventory establishes only the counts and the CI status.
- `tests/broca_subprocess.rs` (3,220 lines, zero `#[test]` attributes) was not
  read. If it is a test binary the integration count above is low.
- Whether this repository's release profile enables `debug-assertions` was not
  read, which is what decides whether `dispatch.rs:212` is a live guard.

## Open questions

- Is a never-executed test `Exercised: partial` or `Exercised: not yet`? It
  governs all 121 claim-bearing tests here. The 2b and 2d inventories record the
  same question as unresolved, as does the 4e inventory across five sub-parts.
  This synthesis did not decide it silently: the `Exercised:` lines in
  `catalog.md` are inherited verbatim from lens A, which uses `partial` when a
  test exists and `not yet` when none does. (needs human input)
- Is a zero-length `Response` terminal a defect or a supported outcome? A
  handler that legitimately produces an empty body is indistinguishable at
  `dispatch.rs:1031` from one that reserved output and failed, and
  `handler.rs:220-235` does not state the intent. (needs human input)
- Should `docs/mc-host-wire-protocol.md:673` be corrected to describe
  `OutputBuffer` and `reserve_output`, or is the `Vec<u8>` phrasing a deliberate
  abstraction over the handler API? The document nowhere mentions the reservation
  mechanism, and `handler.rs:209-211` treats the reservation as a budget
  invariant rather than an implementation detail, which argues for correction.
  (needs human input)
- Do the three unterminated `open_route` exits need a terminal, or is correlation
  abandonment the intended contract when the fatal latch is already tripped?
  `:1174`'s comment says the incarnation terminates, which makes a terminal
  pointless; `:1164` and `:1199` leave a live connection with an unsettled
  correlation, which does not. (needs human input)
- Is `debug_assert_eq!` the right strength for `dispatch.rs:212`? The model it
  checks feeds a byte charge, and the check is absent from a release host whose
  profile leaves `debug-assertions` off. (unresolved, needs the workspace profile
  table)
- Can a panic in `expect_occupant` (`routing.rs:446`) be reached from any input,
  or only from a registry bug? Establishing either way needs a state
  reachability argument over `Slot`/`Occupant` that no pass has attempted.
  (unresolved, needs a registry state model)
- `dispatch.rs:770-779` spawns the shutdown-commit watchdog with a bare
  `tokio::spawn`, outside both `spawn_tracked` and `gen.read_tasks`. It is the
  only spawn in this sub-part the host's task tracker does not observe, so a
  shutdown can complete while it is live holding an `Arc<GenerationCore>`. Is
  that deliberate? (unresolved, needs the `run` teardown order from sub-part 2f)
