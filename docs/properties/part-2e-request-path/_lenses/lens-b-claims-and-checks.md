# Sub-part 2e lens B: claims and checks

Attention focus: what the request path *claims* about itself, and what
mechanically holds those claims. Claim sources are doc comments in
`dispatch.rs` (1,539 lines), `control.rs` (1,180), `routing.rs` (833),
`handler.rs` (604), and `composite.rs` (390); the error and close-reason string
vocabulary those files mint; and `docs/mc-host-wire-protocol.md` (936 lines),
which Section 1 makes the normative contract.

Provenance: code read from `/local/home/ahrav/scratch/magic-context`, `HEAD` =
`e447c927`, branch `feat/shared-memory-release-gate-audit`. Every line
reference below was printed at that commit before being written. Method
contract in [../../METHOD.md](../../METHOD.md).

METHOD rule 3 governs this file. A documented guarantee is a claim under test.
Where the document and the code disagree, both sides are cited and neither is
resolved in the document's favour.

## Claims register

Twenty claims, capped by consequence rather than by enumeration. `Held by`
names the mechanism that actually enforces the claim, or records that none
does.

| # | Claim | Source | Held by |
| --- | --- | --- | --- |
| 1 | Logical settlement is distinct from socket-write outcome: the settlement primitive records which terminal won, the writer only reports whether bytes left | `dispatch.rs:4-7` | `Settlement` (`:34-60`) versus `emit_reserved_frame`'s `Result` (`:315`). Structural, no check |
| 2 | `won` flips exactly once no matter which of handler completion, cancellation, route close, or teardown arrives first | `dispatch.rs:31-33` | `won.swap(true, SeqCst)` under `order` (`:407-410`) |
| 3 | A routed `Request` carries exactly one correlation; the host produces one `Response`/`Error`, or `StreamData`* then one `StreamEnd`/`Error` | protocol `:666-669` | Same swap at `:408`, plus the `has_streamed` re-check at `:418` |
| 4 | Handler `Response(Vec<u8>)` becomes `Response` | protocol `:673` | **Nothing. A compiled doctest forbids it** (`handler.rs:213-219`). See contract leads |
| 5 | All response frames MUST echo channel, epoch, and correlation | protocol `:671` | `FrameId::routed(route, corr)` threaded through every emit (`dispatch.rs:436`, `:451`) |
| 6 | Output storage must be reserved through `reserve_output` before allocation; an already allocated `Vec` cannot bypass the resident-byte budget | `handler.rs:209-211` | `OutputBuffer` private fields (`:332-335`) plus the `compile_fail` doctest at `:213-219`. **CI-executed** |
| 7 | `RequestCtx` specifically hides transport correlations, sockets, and credentials | `handler.rs:422-423` | Three `compile_fail` doctests (`:425-427`, `:429-431`, `:433-435`) and the `pub(crate)` field set (`:442-447`). **CI-executed** |
| 8 | A panic in `handle` maps to one `internal_error` terminal for that correlation only; under `panic=abort` any panic kills the process | `handler.rs:555-557` | First clause: `Err(join_err) if join_err.is_panic()` (`dispatch.rs:1053-1057`). Second clause: **no code, and unfalsifiable in-tree** |
| 9 | `route_gone` runs exactly once per handle the handler observed, including rejected binds | `handler.rs:550-552` | `run_route_gone`'s `gone_started` gate (`dispatch.rs:1241-1242`), `take_rejected_bind` (`:1219`) |
| 10 | `magic-context-c50.4` will adapt `McHandler` onto this boundary | `handler.rs:3` | **Nothing. No `McHandler` exists in this crate**; the trait is `McHostHandler` (`:558`) |
| 11 | Every byte limit is enforced before handler callbacks, route reservation, or filesystem work | `control.rs:4-5` | Ordering of `parse_control` against `open_route` (`dispatch.rs:1103`). No check pins the order |
| 12 | The channel-0 rejection vocabulary is eight codes | `control.rs:13-20` | Eight `pub const` string literals; `control.rs` tests assert individual codes |
| 13 | Channel 0 caps a body at 65,536 bytes; oversize receives terminal `invalid_control_request` and the body is drained, never buffered | protocol `:321` | `ring_transport.rs:474-485` (2b scope), reached before `control.rs` sees bytes |
| 14 | The registry, not any connection task, owns every route from reservation through route-gone, so a dying connection can never strand or double-free a route | `routing.rs:4-8` | `RouteRegistry` `Mutex<Inner>` (`:19-22`); 12 in-crate tests and `tests/routing.rs` |
| 15 | Channel reuse is permitted only after prior work settles, route-gone completes once, and the epoch advances strictly; at `u32::MAX` the channel is permanently retired | protocol `:626` | `routing.rs:570` and `:598` in-crate tests, `unreachable!` at `:184` |
| 16 | The composite is dispatch metadata only; the host registry remains sole owner of reservation, liveness, closing, finalization, cancellation, and reuse | `composite.rs:3-8` | Composite holds only a `HashMap` route map (`:17`, `:141`); no registry call in the file |
| 17 | The composite never surfaces a `ShutdownError` message; diagnostics report byte length only | `composite.rs:27-30`, `:174-175` | `shutdown_failure_note` (`:182-186`), which emits only `err.0.len()` and drops panic payloads |
| 18 | Every child poll is wrapped so a panicking or erroring earlier child cannot skip a later child's drain | `composite.rs:155-156`, `:363-365` | `catch_unwind(AssertUnwindSafe(...))` per poll (`:165`), fixed drain order (`:371-384`) |
| 19 | Duplicate route `Goodbye` is idempotent; route close settles or cancels within the close budget then calls route-gone exactly once | protocol `:691` | `close_route_decision` (`dispatch.rs:1296`), `settle_route_work` (`:1320`); `routing.rs:689` in-crate test |
| 20 | A routed terminal's arrival is observable to the caller; anything published without an observed terminal is `outcome_unknown` | protocol `:669`, `:692` | Partial. **No delivery acknowledgement exists for routed terminals**; see contract leads |

**Claims with no implementing code: 4** (numbers 4, 8's second clause, 10, and
20's acknowledgement half). Two of the four are in the normative document
rather than in source.

## Contract-vs-code leads

Five, each verified at `HEAD` and ordered by consequence.

### C1. The document names a handler API that a compiled check forbids

Protocol `:673` reads "Handler `Response(Vec<u8>)` becomes `Response`". The
current variant is `RequestOutcome::Response { body: OutputBuffer, binary }`
(`handler.rs:224`), and `OutputBuffer`'s fields are all `pub(crate)`
(`:332-335`), so no external caller can build one without
`RequestCtx::reserve_output` (`:466`). The doctest at `handler.rs:213-219`
asserts exactly that: constructing `RequestOutcome::Response { body:
Vec::<u8>::new(), binary: false }` must fail to compile.

This is the sharpest disagreement in the sub-part because the two sides are
not merely unsynchronised, they are mechanically opposed. The document
describes a construction, and a check that **runs in CI** (`ci.yml:190`)
fails the build if that construction ever becomes possible. The reservation
mechanism the code enforces is absent from the document: `OutputBuffer`,
`reserve_output`, and `output_from_writer` appear nowhere in
`docs/mc-host-wire-protocol.md` (grepped, zero hits).

### C2. The response gate checks that the body fits, never that the handler succeeded

`dispatch.rs:1031-1034` is the whole success path for a unary response:

```
Ok(RequestOutcome::Response { body, binary })
    if body.len() <= crate::wire::MAX_BODY_LEN as usize => {
        Terminal::Response { body, binary }
    }
```

The guard is an upper bound only, and `0 <= MAX_BODY_LEN` holds. A handler that
reserves output through `reserve_output` (`handler.rs:466`), fails partway, and
returns the buffer it never wrote into therefore emits a **zero-length
`Response` terminal**, which the client reads as success.

The wire layer accepts it. `wire.rs:340` rejects a body only on a pure-header
type:

```
if ty.is_pure_header() && len != 0 {
```

`Response` is not pure-header, so there is no lower bound on its declared
length anywhere in decode. Nothing between the handler's `return` and the
client's `Ok` distinguishes "succeeded and produced nothing" from "failed
after reserving". The adjacent arms show the author reasoning carefully about
other shapes in the same match: `:1020` catches a unary response after
streaming, `:1035` catches an oversize body. Emptiness is the gap.

### C3. Routed terminals carry no delivery acknowledgement

`settle` returns `true` once `emit_reserved_frame` has *enqueued* the terminal
(`dispatch.rs:447-460`); an `Err` from that call only cancels the generation
(`:458`). There is no ack frame, no write-completion callback, and no
per-correlation delivery record on the routed path.

The contrast inside the same file is what makes this a finding rather than an
observation. `handle_host_shutdown` deliberately has the mechanism this path
lacks: `dispatch.rs:646-651` describes a `CommitOnAck` hook where "commit and
host cancellation run inside the writer task at full-frame write completion",
and every earlier failure drops the hook unrun. So the crate knows how to
condition an effect on delivery, and does so for exactly one channel-0
operation.

Consequence for METHOD's effect accounting: on the routed path the
**acknowledged** count is identically zero and only **attempted** is
observable. Per-identity oracles cannot use an acknowledgement side, and the
`observed >= acknowledged` bound is vacuous here.

### C4. Five exits leave routed or control work with no terminal

Verified individually. `open_route` (`dispatch.rs:1103-1239`) has exactly seven
exits; four emit a terminal and three do not.

| Site | Exit | Terminal |
| --- | --- | --- |
| `:1112-1122` | draining or shutdown cancelled | `target_unavailable` |
| `:1127-1137` | route capacity exhausted | `target_unavailable` |
| `:1164-1170` | bind callback stopped (panic, abort, or self-bounded deadline) | **none** |
| `:1174` | bind callback still executing; fatal latch already tripped | **none** |
| `:1178-1193` | `BindInstall::Installed` | `Response` |
| `:1195-1202` | `BindInstall::CloseWins` | **none** |
| `:1204-1237` | `BindOutcome::Reject` | `Error` |

Two more silent exits sit outside `open_route`:

- `dispatch.rs:1058-1061`, the non-panic join-error arm of the request match.
  `Err(join_err) if join_err.is_panic()` at `:1053` produces an
  `internal_error` terminal; the `Err(_)` arm immediately below removes the
  pending entry and returns. An aborted handler task therefore settles
  nothing.
- `dispatch.rs:629-639`, busy-reject exhaustion. Past the reject bound the code
  calls `gen.token.cancel()` and `gen.writer.discard()`. This is the worst of
  the five by blast radius: `discard()` drops **other correlations' already
  queued terminals**, not just the one that could not be rejected. The comment
  at `:630-636` argues the trade honestly and names the outcome
  ("unemitted terminals become outcome_unknown, which is the documented result
  of retirement"), so this is a declared cost rather than an oversight. It is
  in the register because nothing checks that the declared cost is the one that
  actually occurs.

Protocol `:692` covers three of the five: "Any published request lacking an
observed terminal at close is `outcome_unknown`". It does not cover `:1164`,
`:1174`, or `:1199`, where the connection stays live and the `route.open`
correlation simply never settles until the caller's own deadline expires.

### C5. A reserved-pool comment is contradicted by the only in-tree declarer

`runtime.rs:117-119` (2f's file, but the claim is about this sub-part's
admission classes):

```
/// Reserved-class admission pools, sized by the checked declaration sums
/// (plan KTD2). Zero-permit when no module declared a reservation, and
/// then unreachable because every route is general-class.
```

Broca declares the opposite. `broca/mod.rs:164-177` returns a
`ResourceDeclaration` with `route_class: RouteClass::Reserved` and
`reserved_handler_tasks: config::RESERVED_HANDLER_TASKS`,
`reserved_pending_requests: config::RESERVED_PENDING_REQUESTS`, both `96`
(`broca/config.rs:185`, `:188`). The comment at `:169-170` states the intent
plainly: "Constants rather than limits so a test-shrunken supervisor still
declares the product contract."

So the reserved pools are neither zero-permit nor unreachable in the composed
host. This bears on 2e because `RouteClass` is read back by dispatch to pick a
permit pair (`handler.rs:60-64`), which makes reserved-class dispatch a live
path rather than a dormant one. Recorded here and cross-filed in the 2f lens.
The sibling lens reports this as the fourth misleading comment in this crate;
this pass verified the contradiction itself but did not verify the count of
three prior instances, so the ordinal is inherited and unconfirmed.

## Documentation describing deleted mechanisms

**One, and it is C1.** Protocol `:673`'s `Response(Vec<u8>)` describes a
mechanism that genuinely existed and was removed, not one that never was.
Verified by history rather than inferred: `git log -S'body: Vec<u8>,' --
crates/mc-host/src/handler.rs` returns `cf281ace` (the commit that added
`mc-host`) and `ef66e349` ("fix(mc-host): address PR #6 review findings"), and
`git log -S'```compile_fail' -- crates/mc-host/src/handler.rs` returns
`cf281ace` and `98b7270d` ("fix(mc-host): resolve retained PR review
findings"). The document line dates from `d0dbb25a` and has not moved since.

**No source comment in this sub-part describes a deleted mechanism.** Checked
explicitly, because the refactor deleted five files from this crate and prior
lens work cited them. Grepping all five 2e files for `tcp_frame_channel`,
`transport_negotiation`, `transport_provider`, `provider_recovery`,
`frame_read`, `shm_provider`, `negotiate`, `Serveable`, and `fallback` returns
**zero hits**. The request path never named the transport it sat on, which is
why it survived a 26,606-line deletion with its comments intact.

**One residual of a different shape, recorded so a later pass does not
miscount it as deleted.** The normative document names `McHandler` at nine
sites (`:43`, `:292`, `:596`, `:600`, `:626`, `:634`, `:685`, `:800`, `:906`),
and no such type exists in this crate. This is a **forward** reference, not a
stale one: `handler.rs:3` says "`magic-context-c50.4` will adapt `McHandler`
onto this boundary", so the document describes the adapter that is planned
while the code carries the boundary that exists (`McHostHandler`, `:558`).
Counted once, in the claims register at row 10, and deliberately kept out of
this section.

## Conventionally-enforced-only claims

Six, each stated somewhere and checked by no build step.

1. **The two terminal-diagnostic caps are stated nowhere normative.**
   `MAX_TERMINAL_CODE_LEN` = 128 and `MAX_TERMINAL_MESSAGE_LEN` = 4096
   (`dispatch.rs:79-80`) bound every handler-authored terminal
   (`bounded_terminal_error`, `:82`) and every bind rejection (`:1211`).
   Conformance vector V24 requires bounded observability, but fixes no number.
   The client's independent equivalents are 128 and 512 (`client.rs:112-113`),
   so a handler message between 513 and 4096 bytes is inside the host's cap and
   outside the client's, and nothing compares the two.

2. **The bind-rejection cap is coupled to the terminal cap by comment only.**
   `dispatch.rs:1205-1209` says "Same caps as request-error terminals" and then
   restates the comparison inline at `:1211` rather than calling
   `bounded_terminal_error`. Two sites, one stated invariant, no shared
   definition.

3. **The eight control codes are duplicated on the TypeScript side.**
   `control.rs:13-20` mints them as `pub const`. The managed TypeScript client
   is bound by the same normative vocabulary and carries its own literals.
   Nothing cross-checks the two spellings, and `ci.yml:211`'s Bun suite tests
   the TypeScript client against its own constants.

4. **The four operation names are byte literals on both sides.**
   `control.rs:22-25` (`route.open`, `catalog.list`, `host.shutdown`,
   `host.status`) against the document's Sections 7.2, 7.3, 7.6, and the
   `host.shutdown` request and response examples at `:541` and `:545`. A rename
   on either side changes the wire and fails no build.

5. **The `unreachable!` at `routing.rs:184` states a coupling nothing
   enforces.** `unreachable!("bind completion found route in {state:?}")` is
   sound only while every state that reaches bind completion is enumerated
   above it. Adding a state to the slot machine without extending that match
   turns a registry bug into a production panic under the registry mutex.

6. **`escaped_json_len` is a hand-written length model for a serializer it does
   not call.** `dispatch.rs:101` computes the encoded length of an error body
   and `:212` checks the result with a `debug_assert_eq!` labelled "escaped
   length model diverged". Because it is a `debug_assert`, the check is
   compiled out of any release profile that leaves `debug-assertions` off, and
   the two in-crate tests that exercise the model (`:1502`, `:1524`) never run
   in CI. So in a release host the model is unchecked, and it feeds a byte
   charge.

## Existing-check inventory

**Every status below is `unaudited`.** An existing check never removes a
property from the catalog. Test adequacy belongs to
`/testing:invariant-test-review`; production guard adequacy belongs to
`/low-level-systems:defensive-assertions-and-invariant-guards`.

The framing fact for this sub-part, and the one place it beats both siblings:
**2e owns four of the six CI-executed source-resident checks in the whole
`mc-host` library.** Everything else it has runs only locally.

### In-crate tests

**37 tests across three of the five files. None of them runs in CI.**

| File | Test module | Production | Tests | Sites | CI |
| --- | --- | --- | --- | --- | --- |
| `control.rs` | `:710-1180` | `1-709` | **23** | `:765`, `:780`, `:812`, `:824`, `:830`, `:838`, `:845`, `:851`, `:863`, `:876`, `:883`, `:908`, `:937`, `:964`, `:978`, `:990`, `:1010`, `:1020`, `:1027`, `:1045`, `:1085`, `:1103`, `:1112` | **No** |
| `routing.rs` | `:454-833` | `1-453` | **12** | `:511`, `:530`, `:546`, `:570`, `:598`, `:619`, `:642`, `:671`, `:689`, `:728`, `:774`, `:801` | **No** |
| `dispatch.rs` | `:1498-1539` | `1-1497` | **2** | `:1502`, `:1524` | **No** |
| `handler.rs` | none | all 604 | **0** | | n/a |
| `composite.rs` | none | all 390 | **0** | | n/a |
| **Total** | | | **37** | | **0 in CI** |

The reason is structural, and this pass re-derived it rather than inheriting
it. Every `-p mc-host` test invocation in `ci.yml` carries a `--test <name>`
filter, which selects one integration binary and never builds the lib target:
`:132`, `:133`, `:134-135`, `:178-179`, and `:187`. The remaining `mc-host`
hits are `:87` (a Bun drift gate), `:168-169` (`cargo build`), `:190` (the
doctest step), `:211`, `:361`, `:442`, and `:461`. None is an unfiltered
`cargo nextest run -p mc-host` or a `--lib` run.

Clustered by subject, the distribution is lopsided in a way worth naming:

| Cluster | Tests | Where |
| --- | --- | --- |
| Channel-0 parse bounds, strictness, and classification | **17** | `control.rs:824-1027` |
| Route slot lifecycle, epoch advance, close and bind races | **12** | all of `routing.rs` |
| Catalog and response-shape fidelity | **4** | `control.rs:1045`, `:1085`, `:1103`, `:1112` |
| Route-open parse and identity bounds | **2** | `control.rs:765`, `:780` |
| Error-body length model | **2** | `dispatch.rs:1502`, `:1524` |

So the file that owns settlement, terminal arbitration, and all five silent
exits carries **2** of the 37 in-crate tests, and both of those test a length
arithmetic helper.

**`#[ignore]`, `should_panic`, `loom`, `shuttle`, `miri`, `proptest`,
`quickcheck`, `arbitrary`: none found** in any of the five files. There is no
coverage instrumentation, so every placement statement in this file is
structural rather than measured.

### Integration tests

**Six of the 24 binaries are the natural home for this sub-part's claims, and
CI names none of them.**

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
`--test-threads=1`), and `shm_soak` (`:134-135`, one test by `--exact`). So **4
of 24 named, 20 unnamed**, and every binary whose subject is the request path
falls in the unnamed 20.

This is the load-bearing coverage observation for 2e. The sub-part is
*well tested* and *barely gated*: 84 integration tests plus 37 in-crate tests
is 121 claim-bearing checks, and the number CI executes is zero. Whether the
two jobs that do name binaries are required status checks for merge is
repository settings and is not verifiable from this tree, carried forward
unresolved from
[../../part-2-rescope/scope-map-and-risk-ranking.md:750-752](../../part-2-rescope/scope-map-and-risk-ranking.md).

One inventory note for a later pass: `tests/broca_subprocess.rs` is 3,220 lines
and a grep for `#[test]` or `#[tokio::test]` returns **zero**, so it is either
a shared-helper binary or uses a macro-generated form. Not resolved here.

### Doctests

**Four, all `compile_fail`, all in `handler.rs`, and all executed by CI.**

| Site | Forbids |
| --- | --- |
| `handler.rs:213-219` | `RequestOutcome::Response { body: Vec::<u8>::new(), .. }` |
| `handler.rs:425-427` | `ctx.corr` |
| `handler.rs:429-431` | `ctx.socket` |
| `handler.rs:433-435` | `ctx.credentials` |

They run because `handler.rs` is `pub mod handler` (`lib.rs:17`) and
`ci.yml:190` runs `cargo test -p mc-host --doc` under the step name "Rust
lease non-escape".

The crate-wide picture, derived by grepping every doc fence under
`crates/mc-host/src/`: **six compiled doctests exist in the whole library**,
all `compile_fail` — these four plus `frame_channel.rs:296-301` and `:303-308`
(2b scope). Two further fences are `text` and are not compiled
(`wire.rs:4-14`, `generation.rs:6-11`). This extends the shared CI fact handed
to this pass, which named only the two in `frame_channel.rs`.

The three `RequestCtx` doctests are worth separating from the first. They are
**negative structural checks**: each asserts that a field name does not resolve.
A field renamed rather than removed still fails them, so they pin absence, not
privacy. `handler.rs:213-219` is stronger, because `OutputBuffer`'s
`pub(crate)` fields make the failure a type error that no rename can satisfy.

`control.rs`, `dispatch.rs`, `routing.rs`, and `composite.rs` contain **zero**
doc fences of any kind.

### Production assertions and guards

Enforcement in this sub-part is overwhelmingly by returned value and typed
state. Counts below were derived by extracting each file's production half and
grepping it, so no test-module hit is included.

**`.expect(`: 34, in four clusters.** The distribution is the finding: 30 of
the 34 are mutex-poisoning labels, not contracts.

| Cluster | Sites | Label |
| --- | --- | --- |
| Registry and membership locks | 16 | `routing.rs:114`, `:163`, `:174`, `:192`, `:210`, `:237`, `:262`, `:277`, `:300`, `:331`, `:345`, `:361`, `:378`, `:399`, `:421`, `:437` — `"registry lock"` / `"membership lock"` |
| Pending, connections, and composite maps | 9 | `dispatch.rs:916`, `:1098`, `:1335`, `:1376`, `:1412`, `:1490`; `composite.rs:141`, `:268`, `:301` |
| Infallible serialization | 6 | `dispatch.rs:235`, `:237`, `:241`, `:717`, `:1464`; `control.rs:261`, `:531`, `:604` |
| Real stated contracts | 1 | `dispatch.rs:1126` `"validated route.open target is indexed"` |

`dispatch.rs:1126` is the one that states a cross-module invariant: `open_route`
expects `parse_control` to have already indexed the target, so a validation
path that admits an unindexed target converts a rejection into a panic. Nothing
couples the two sites.

Unlike `client.rs`, which routes every poisoning through `lock_unpoisoned`,
these 30 sites propagate the panic. `composite.rs` is the only file in the
sub-part with a panic boundary (`catch_unwind` at `:165`, entered from `:374`,
`:378`, `:382`), and it wraps child polls, not lock acquisition.

**Production panic sites: 3.**

| Site | Form | Reachability |
| --- | --- | --- |
| `routing.rs:184` | `unreachable!("bind completion found route in {state:?}")` | Catch-all arm of the bind-completion state match |
| `routing.rs:446-450` | `panic!("{op}: registry lost route it owns")` then `assert_eq!(occupant.epoch, handle.epoch, "{op}: registry occupant epoch diverged")` | `expect_occupant`, called on every occupant mutation |
| `composite.rs:387` | `panic!("{}", failures.join("; "))` | Deliberate: converts child shutdown failure into a failed callback the runtime can classify |

`composite.rs:387` is a designed signal, not a defect, and the comment at
`:363-369` says so. Its payload is already redacted: `shutdown_failure_note`
(`:182-186`) emits only `err.0.len()` for an error and drops panic payloads
entirely, so claim 17 holds at the panic site too. Worth recording because
prior lens material flagged shutdown-error formatting as defeating its own
redaction contract; in the current code it does not.

`routing.rs:441-451` is the densest guard pair in the sub-part and the only
place where a `panic!` and an `assert_eq!` guard the same read. Both fire
unconditionally in release.

**`debug_assert`: 1.** `dispatch.rs:212`, `debug_assert_eq!(body.len(),
body_len, "escaped length model diverged")`. Compiled out of a release profile
without `debug-assertions`, and its two supporting tests never run in CI. See
conventionally-enforced item 6.

**`let _ =` discarded results: 12, in three clusters.**

| What is discarded | Sites |
| --- | --- |
| Write-completion and start signals where the receiver may be gone | `dispatch.rs:679`, `:815`, `:1074`, `:1475` |
| Cancellation and pending-map calls | `dispatch.rs:735`, `:806`, `:1003` |
| The bounded Goodbye completion wait | `dispatch.rs:1483` |

`handler.rs`'s four `let _ =` occurrences are all inside the doctests
(`:215`, `:426`, `:430`, `:434`); its production half has none.
`control.rs`, `routing.rs`, and `composite.rs` have none.

**Checked and saturating arithmetic: 6.** `checked_` once and `saturating_`
four times in `dispatch.rs` (the length model and terminal budgets),
`saturating_` once in `control.rs` and once in `handler.rs:382`
(`OutputBuffer::extend_from_slice`'s remaining-capacity computation, which is
what makes the reservation a hard ceiling).

**Explicit "none found".** No fuzz target reaches any of the five files. No
benchmark asserts a behavioural claim here. No snapshot or golden fixture in
the five files. No differential harness against the TypeScript peer. No
coverage instrumentation. No `catch_unwind` outside `composite.rs`. No
`todo!` or `unimplemented!` anywhere in the sub-part.

## Suspiciously quiet areas

Three, ranked by the gap between what the code decides and what any check
proves. The framing point that applies to all three: this is not thin
coverage. 121 claim-bearing checks reach this sub-part and the `control.rs` and
`routing.rs` suites are dense and well built. What is quiet is a specific seam.

1. **`dispatch.rs` decides every terminal in the host and carries two in-crate
   tests, both about arithmetic.** 1,497 production lines own
   `Settlement` (`:34`), `settle` (`:399`), `dispatch_request` (`:828`),
   `open_route` (`:1103`), `close_generation` (`:1394`),
   `force_close_all_routes` (`:1421`), and `handle_cancel` (`:1489`). The two
   tests at `:1502` and `:1524` cover `error_body_len` (`:115`). Neither runs
   in CI, and neither touches a terminal. Every one of this file's five silent
   exits, the emptiness gap at `:1031`, and the missing acknowledgement at
   `:447-460` sits in the same file, so the three highest-consequence leads in
   this lens all land where in-crate coverage is thinnest. `tests/dispatch.rs`
   (20 tests) is the real coverage and CI does not name it.

2. **A silent exit is silent in three senses at once, and there is no counter
   to notice it.** At `:1058`, `:1164`, `:1174`, and `:1199` the code emits no
   terminal, records no cause, and increments no metric; `remove_pending`
   (`:1097`) removes the entry and returns nothing. The comments at `:1162-1163`
   and `:1171-1173` argue each case correctly on ordering grounds, and the
   arguments are sound: running route-gone beside a still-executing bind would
   be worse than leaving the correlation unsettled. What is quiet is that the
   *chosen* outcome has no observation point. A caller learns only by its own
   deadline expiring, which is indistinguishable from a slow handler, and a
   host operator learns nothing at all. `dispatch.rs:637-638` compounds it by
   discarding unrelated queued terminals through `writer.discard()` with the
   same absence of a counter. Contrast `ring_transport.rs:209-228`, which
   maintains four lifecycle counters for a strictly less consequential set of
   events.

3. **`routing.rs` holds three unconditional production panics in a
   process-global structure, and no check drives any of them.** `:184`,
   `:446`, and `:447-450` all fire in release, all inside code holding the
   registry mutex (`:114` and 15 sibling sites), and the module doc at `:3-8`
   makes this registry the single owner of every route in the host. A panic
   there poisons the mutex, and unlike `client.rs` there is no
   `lock_unpoisoned` recovery: the next of 16 `.expect("registry lock")` sites
   converts one bad state transition into a cascade across every connection.
   The 12 in-crate tests cover the legal transitions thoroughly (`:570` reuse,
   `:598` epoch retirement, `:619` close racing bind, `:642` route-gone
   claiming) and none constructs the illegal state the guards exist for, which
   is correct for a test suite and leaves the guards' own reachability
   unestablished. `expect_occupant` (`:441`) is called on every occupant
   mutation, so it is the most-executed guard in the sub-part and the least
   characterised.

## Open questions

- Is a zero-length `Response` terminal a defect or a supported outcome? A
  handler that legitimately produces an empty body is indistinguishable at
  `dispatch.rs:1031` from one that reserved output and failed. Resolving it
  needs the handler contract's intent, and `handler.rs:220-235` does not say.
  (needs human input)
- Should `docs/mc-host-wire-protocol.md:673` be corrected to describe
  `OutputBuffer` and `reserve_output`, or is the `Vec<u8>` phrasing a
  deliberate abstraction over the handler API? The document nowhere mentions
  the reservation mechanism, and `handler.rs:209-211` treats the reservation as
  a budget invariant rather than an implementation detail, which argues for
  correction. (needs human input)
- Do the three unterminated `open_route` exits need a terminal, or is
  correlation abandonment the intended contract when the fatal latch is
  already tripped? `:1174`'s comment says the incarnation terminates, which
  makes a terminal pointless; `:1164` and `:1199` leave a live connection with
  an unsettled correlation, which does not. (needs human input)
- Is `debug_assert_eq!` the right strength for `dispatch.rs:212`? The model it
  checks feeds a byte charge, and the check is absent from a release host whose
  profile leaves `debug-assertions` off. Whether this repository's release
  profile enables them was not read. (unresolved, needs the workspace profile
  table)
- Can a panic in `expect_occupant` (`routing.rs:446`) be reached from any
  input, or only from a registry bug? Establishing either way needs a state
  reachability argument over `Slot`/`Occupant` that this pass did not attempt.
  (unresolved, needs a registry state model)
- Is `tests/broca_subprocess.rs` (3,220 lines, zero `#[test]` attributes) a
  test binary or a shared helper? It affects the integration count above.
  (unresolved, needs a read of the file)
