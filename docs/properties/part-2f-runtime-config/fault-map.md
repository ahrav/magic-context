# Sub-part 2f fault-to-property map

For each of the 14 records, what must actually occur for a test to be
non-vacuous, and whether the harness can produce it today.

Same rules as the earlier parts. Safety checks must hold *while* their faults are
active. Liveness checks need a bounded fault-free window, stated in the units the
code bounds; this sub-part has no liveness record, so that rule does not bind
here. Rare implementation branches need deterministic injection to be reachable
at all. Coverage checks assert independent preconditions, never the violation.

Four framing points specific to this sub-part.

**First, almost nothing here needs a fault, and that is a property of the subject
rather than of the analysis.** This sub-part's subject is construction and
configuration: what is built, in what order, from which values. Six of the
fourteen records are discharged wholly or in their load-bearing half by
enumeration over the tree, four more need only a *value* — a configuration a test
supplies — and only four need something that could be called a fault. The
construction conditionality map in `catalog.md` is itself the largest oracle in
the sub-part, and it was produced by reading `runtime.rs:630-936` end to end.

**Second, the fixture that unblocks the most records is a test handler, exactly
as in 2e, but for a different reason.** In 2e the handler is hostile on the
*request* path. Here it is authoritative on the *startup and health* paths: a
handler supplies `manifests()`, `resource_declarations()`, `initialize`,
`activate`, and `health`, and four records turn on what it declares or reports.
`tests/handler_contract.rs` already builds declaring handlers at `:302-320`,
`:378-388`, and `:437`; `tests/lifecycle.rs:579` already builds a slow-callback
one. What no fixture builds is a handler whose `health` report carries
`storage_state: "starting"`, which is the single cheapest missing fixture in the
sub-part and which two records need.

**Third, one record is blocked at the fixture layer and one is blocked outside
the sub-part's footprint, and the two blockages are different in kind.** The
serial-setup-budget record needs a peer that stalls inside authentication and then
inside descriptor transfer; Part 2c's `fault-map.md:52` describes that fixture and
records that it does not exist, so the blockage is a missing harness. The
closure-store record needs an operator-visible classified reason, and no such
reason exists because `serve.rs:162` and `:349` each discard it with `.ok()`, so
the blockage is a missing *mechanism* in a file this sub-part does not own. Only
the first is fixed by building something.

**Fourth, one existing test actively defeats one record and the fix is a one-line
value change.** `tests/lifecycle.rs:165` sets `health_interval` to 50 ms, which is
numerically identical to the hardcoded activation interval at `runtime.rs:1130`.
So the one test that touches the health cadence cannot distinguish the two
branches of `:1129`. Two records need that value changed, and nothing else about
the fixture.

## Fault classes required

`F0` is listed first because it is the cheapest capability here and it is not a
fault at all. `F4` is listed as a class for symmetry with the other parts, and it
is not a fault either; the row says so.

| Class | Description | Available today |
| --- | --- | --- |
| **F0** test execution in CI | A workflow job that builds and runs the checks a record's oracle would live in | **No, and this is the weakest position of the three sub-parts.** *In-crate: no.* All 11 execute in no job, because every `-p mc-host` invocation carries a `--test <name>` filter and never builds the lib target; the 13 `mc-host` hits are `:87`, `:132`, `:133`, `:134`, `:168`, `:169`, `:178`, `:187`, `:190`, `:211`, `:361`, `:442`, `:461`, and `:168-169` are `cargo build`. *Integration: no.* CI names `client`, `lifecycle`, `shm_failure_modes`, and `shm_soak`; it names none of `synapse_bundle`, `harness_closure`, `ipc_budget_topology`, or `activation`. *Doctests: none exist.* The five files contain zero doc fences, yet `ci.yml:190` runs `cargo test -p mc-host --doc` and `config.rs`, `harness_closure.rs`, and `lib.rs` are all `pub mod` (`lib.rs:14`, `:17`, `:18`), so a doctest added to any 2f file **would** run. That is the one CI lane this sub-part could reach and does not use. The single exception is transitive: `tests/lifecycle.rs` is CI-named and reaches `runtime.rs` because `run` is how any host starts, but it is Part 2a scope and tests lifecycle records rather than the configuration contract |
| **F1** a declaring handler | A handler whose `resource_declarations()` sum approaches or exceeds a configured limit (`runtime.rs:693`, `:698`, `:708`), or whose declared `route_class` disagrees with its reserved counts (`:535-554`), or which declares zero reservations | **Yes, and three shapes already exist.** `tests/handler_contract.rs:302-320` builds a declaration sum near a limit, `:378-388` builds the class/reservation disagreement in both directions, and `:636`'s `zero_reservation_handlers_keep_single_pool_admission` builds the zero-declaration composition. `resource_declarations()` is called unconditionally at `runtime.rs:687` inside `redact_sync`, so a test handler's declaration reaches every one of the eight startup gates |
| **F2** a resident-floor configuration | `max_resident_bytes` set exactly at the handler-dependent floor, with a non-zero `retained_resident_bytes` declaration and a non-trivial catalog, so `runtime.rs:736`'s gate is the only thing between the configuration and the unchecked subtraction at `:896-902` | **Yes.** `tests/handler_contract.rs:437` `retained_declaration_raises_the_resident_floor_exactly` already constructs the floor case, and the production configuration itself raises `max_resident_bytes` by two declared retained quantities (`serve.rs:588-590`), so the shape is production-realistic rather than synthetic. The arithmetic that makes the subtraction safe was verified independently by lens A from `wire.rs:28`, `:35`, and `:371` |
| **F3** an out-of-range configuration value | Any field of `HostLimits`, `HostTiming`, or `LivenessPolicy` set one step outside its bound, so `validate` returns a `ConfigError` naming it | **Yes, and it is a pure function.** `HostConfig::validate` (`config.rs:300`) needs no host, no handler, and no runtime, and seven tests already drive it per key (`:502`, `:550`, `:564`, `:576`, `:603`, `:636`, `:646`). Making the coverage exhaustive over fields is a fixture edit, not a capability |
| **F4** the default configuration | `HostConfig::default()` with no overrides, which is what production uses apart from `max_resident_bytes` (`serve.rs:582-593`, `..HostConfig::default()` at `:593`) | **Yes, and it is not a fault.** It is the production configuration, and it is already the subject of the sub-part's one `Exercised: yes` record: `tests/lifecycle.rs:496` `liveness_is_disabled_by_default` asserts no Ping arrives within 500 ms on a default host |
| **F5** a handler-authored activation report | A handler or composite whose `health` report carries `metrics.components.<id>.metrics.storage_state == "starting"` or `synapse_state == "starting"`, so `activation_in_progress` (`runtime.rs:1051-1071`) returns true and `:1130` selects the fixed 50 ms | **Yes in principle, and built nowhere. This is the cheapest missing fixture in the sub-part.** `McHostHandler::health` returns a `HealthReport` (`handler.rs:591`) whose `metrics` field is `Option<serde_json::Value>` (`:194`), entirely handler-authored, so the report is a value a test writes. Two things are needed together: the report, and a `health_interval` distinguishable from 50 ms, because `tests/lifecycle.rs:165` currently sets exactly 50 ms and therefore cannot separate the branches. `tests/activation.rs` (4 tests, 412 lines) is the natural home |
| **F6** a blocking first health callback | A handler whose first `health` call blocks, so the seeded `Degraded` snapshot (`runtime.rs:889-893`) is what an authenticated `host.status` reads (`connection.rs:691-695`) for up to `lifecycle_callback_deadline` | **Yes.** `tests/lifecycle.rs:579` already builds a slow-callback handler, and the window is genuinely client-visible by construction: the health task is spawned at `runtime.rs:933` and `accept_loop` starts one line later at `:934`. A client that authenticates and issues `host.status` inside the window is ordinary harness work |
| **F7** a non-yielding tracked task at shutdown | A tracked task that survives `shutdown_deadline`, so `timeout_at(deadline, tracker.wait())` fails at `runtime.rs:1214` and the doubled chain at `:1223-1224` is armed | **Partial, and the split is the finding rather than the count.** *Reaching the forced path: yes.* `tests/lifecycle.rs:678` and `:714-715` build the non-yielding-callback shape and set both `lifecycle_callback_deadline` and `shutdown_deadline`. *Bounding it: no, and the same fixture is why.* A `tokio::time::timeout` cannot preempt a future that never yields, and `run_handler_shutdown`'s own doc comment states the callback "is never aborted" (`:1256-1258`), so against a non-yielding callback every finite ceiling in the record is void. Bounding the path needs a callback that is slow **and** yielding, and separating the two forced exits — `:1238`, which never calls `run_handler_shutdown`, from `:1241`, which does — needs a second variant that drains inside the doubled chain. Neither exists. What no test does is measure the elapsed total, and that is a stopwatch; what no test *builds* is the input against which the total is bounded at all |
| **F8** a peer that stalls across two setup stages | A peer that stalls inside authentication (`connection.rs:125`), then inside descriptor transfer (`:158`), then inside ring activation (`:177`), so the serial pre-service budget can be measured against `auth_deadline + 2 * transport_setup_deadline` | **No.** Part 2c's `fault-map.md:52` describes this fixture and records that it does not exist, and Part 2c's `fault-map.md:180` reaches only one of the two `transport_setup_deadline` sites. The blockage is a missing harness rather than a missing seam: nothing prevents writing a peer that stalls, but no peer fixture in the tree stalls at a chosen stage |
| **F9** a hostile closure-root path | A `${dataDir}/cortexkit/mc-host-harness-closures` path that is a symlink, group-writable, a non-directory, or owned by another uid, so `HarnessClosureStore::open` fails with one of its distinct `&'static str` causes (`harness_closure.rs:1044`, `:1052`, `:1067`, `:1074`, `:1076`, and `verify_owned_directory` at `:923`) | **Partial, and the split matters.** *Producing the failure: yes.* `tests/instance_security.rs` already builds hostile-path fixtures for the sibling walk in `instance.rs`, and `tests/harness_closure.rs` constructs the store at 11 sites, so `open` can be driven to each of its failure causes directly. *Observing a classified reason: no.* Both production call sites are `HarnessClosureStore::open(&closure_root).ok()` (`serve.rs:162`, `:349`), so every distinct cause collapses to `None` before anything could report it. The record's oracle as written cannot pass, and the honest oracle is the enumeration that the discard happens |
| **F10** a pre-publication drain trigger | One of the three entries into `PrePublicationCleanup::finish` (`runtime.rs:351`) with initialization having returned `Ok`: the shutdown token already cancelled at `:831`, `bind_owner_only` failing at `:836`, or `publish` failing at `:843` | **Yes, and the cheapest form is deterministic rather than racy.** The shutdown token is caller-supplied and `initialize` is handler-supplied, so a test handler that cancels the token inside its own `initialize` makes the `is_cancelled` check at `:831` deterministically true and returns `Ok(None)`, draining through `:856`. The bind form needs the `setup.sock` path occupied or unwritable inside the guard's directory; the publish form needs a connection-file write failure. Neither of those two is built today |

Three availability caveats cut across the classes.

**F5 and the `tests/lifecycle.rs:165` collision are one problem, not two.** The
fixture exists and its value defeats it. Any oracle for either fast-probe record
must first set `health_interval` to something other than 50 ms, and that is worth
stating as a precondition rather than discovering during implementation.

**F9's blockage is outside this sub-part's footprint and that is why one record is
`medium`.** Lens A said so explicitly: it read only the immediate context of
`serve.rs:162` and `:349` and did not trace what `harness_backend` (`serve.rs:344`)
ultimately reports to an operator. So the record's confidence reflects an
unresolved question in `mc-module`, not a weakness in the code reading.

**F0's absence is total here, unlike in 2e.** 2e owns four CI-executed doctests.
This sub-part owns none, and every one of its 63 claim-bearing checks runs
locally only. The one transitive exception, `tests/lifecycle.rs`, belongs to
another part and tests another subject.

## Map

All 14 records, in catalog index order. **"Non-vacuous today" means a developer
can construct the required state with the current harness.** It does not mean the
check runs anywhere: under `F0`, no oracle placed anywhere in this sub-part is
CI-protected, and the only CI-reachable lane is a doctest that does not yet
exist.

Thirteen records are `default-production` on the strength of the construction
conditionality map: `runtime::run` has exactly one non-test caller
(`serve.rs:632`), nothing in the sequence is `cfg`-gated, and the only conditional
steps are `set_publish_hook` (test-only), the setup-socket bind and publish pair,
and the per-connection liveness loop. The one `explicit-config-only` record is
[rt-a-every-published-configuration-field-changes-host-behaviour](catalog.md#rt-a-every-published-configuration-field-changes-host-behaviour),
whose subject is what an embedder can set rather than what production does set;
its row notes the consequence.

### What startup refuses to fund

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| rt-a-startup-refuses-every-configuration-it-cannot-fund | **`F1`.** A handler whose `resource_declarations` sum approaches or exceeds a configured limit, driven through all eight startup gates so the joint postcondition at `runtime.rs:882` can be asserted. `tests/handler_contract.rs:302-320` already builds one, and four existing tests (`:323`, `:375`, `:408`, `:437`) each cover one gate | **Yes** — the state construction is a fixture that exists and the missing piece is the conjunction. Note the oracle's placement: the check is stated *at the construction site*, so it is either an in-crate assertion or a startup-refusal observation from outside; the four existing tests take the second form one gate at a time |
| rt-a-the-ingress-pool-derivation-cannot-underflow | **`F2` for the state, enumeration for the relationship.** The enumeration half is that `MIN_RESIDENT_BYTES` is by construction `MAX_BODY_LEN + EGRESS_RESERVED_BYTES + SCRATCH_RESERVED_BYTES` (`config.rs:23-24`), so `runtime.rs:736`'s gate makes the subtraction at `:896-902` always leave at least one `MAX_BODY_LEN`. The state half is a configuration exactly at the floor, which `tests/handler_contract.rs:437` constructs | **Yes** — and the record's own point is that the oracle belongs at the consumer rather than at the guard 160 lines earlier. `config.rs:520-548` already pins the constant decomposition, so what is missing is one assertion relating it to `runtime.rs:896`, which is why this is a maintenance-window record rather than a runtime one |
| rt-a-no-configured-limit-is-silently-clamped | **`F3`, and no fault at all in the ordinary sense.** A pure function of a constructed `HostConfig`: set each field one step outside its bound, assert `Err` whose `Display` names that field, and assert no accepted config differs from the submitted one. Seven tests already drive it per key | **Yes** — the cheapest record in the sub-part. Note the one silent narrowing lens A found is `file_mode.rs:18`'s `0o7777` mask, which is outside `HostConfig` and whose precondition is upheld inside `harness_closure.rs` (`:284-286` constrains `mode` to `0o600` or `0o700`) but is unverified for its other caller in Part 2a's `generation.rs` |

### Fixed bounds that outrank configured ones

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval | **`F5`, plus a fixture value change.** A handler whose `health` report carries `storage_state: "starting"` or `synapse_state: "starting"`, so `activation_in_progress` (`:1051-1071`) returns true, **and** a `health_interval` distinguishable from 50 ms. `tests/lifecycle.rs:165` currently sets exactly 50 ms, which makes the two branches of `:1129` inseparable | **Partial, and the split is per conjunct rather than per fault.** The state construction is fully available: the report is a `serde_json::Value` a test writes and the interval is a config field, so both halves are fixture work with no seam. What is *not* available is a bound for the fast path. The record's first conjunct — selected interval equals `health_interval` whenever the predicate is false — is a pass/fail assertion and is non-vacuous today with only the `tests/lifecycle.rs:165` value change. The second has no bound in the code to assert: the earlier text asked an oracle to "record the number of consecutive iterations that selected 50 ms so a campaign can bound it", which every observation satisfies, so it can only pass. Nothing in `HostTiming` supplies a `K`, and no reading of `config.rs:216-232` makes an existing knob govern activation. So the fast-path half is blocked on a product decision, not on a harness, and the record's open question is the blocker |
| rt-a-the-serial-setup-budget-triples-the-configured-transport-deadline | **`F8`.** A peer that stalls maximally inside authentication (`connection.rs:125`), then descriptor transfer (`:158`), then ring activation (`:177`), measured from `run_connection` entry (`:115`) to `activate_server`'s return | **No** — Part 2c's `fault-map.md:52` describes the fixture and records that it does not exist, and `:180` reaches one of the two `transport_setup_deadline` sites. The **static** half is settled by reading: both sites arm the deadline fresh, which is why the correct figure is 6 s and not 2c's recorded 4 s. What is unconstructible is the wall-clock measurement |
| rt-a-forced-shutdown-outlives-the-configured-shutdown-deadline | **`F7`, and it must now be built in two shapes rather than one.** A tracked task that survives `shutdown_deadline` so `:1214`'s `timeout_at` fails and `:1223-1224` arms the doubled chain, **and then either drains inside that chain or does not**, because those are the two forced exits and they carry different bounds. `tests/lifecycle.rs:678` and `:714-715` already build a shape that reaches the forced path and set both deadlines | **Partial, and the earlier `Yes` rested on a check that could not pass.** Three corrections, all applied to the record. First, `shutdown_sequence` has three exits, not one: `:1243` graceful at `shutdown_deadline + lifecycle_callback_deadline`, `:1238` fatal-latch at `shutdown_deadline + 2 x lifecycle_callback_deadline` and **never calling `run_handler_shutdown`**, and `:1241` forced-with-callback at `shutdown_deadline + 3 x lifecycle_callback_deadline`. The old single bound, `shutdown_deadline + 2 x lifecycle_callback_deadline`, was the bound of the exit that does the least work, so an oracle written to it failed on a correct build the moment the handler callback took any time — which the pre-disposition text noticed, recorded as a synthesis note, and declined to fix. Second, the composed figures are per-branch **ceilings**, not floors: every stage returns as soon as its awaited future resolves, so a forced shutdown whose surviving task drains immediately exits in milliseconds past the drain deadline. Third and load-bearing for the fixture: **the existing `tests/lifecycle.rs:678` shape is non-yielding, and a non-yielding callback defeats every finite ceiling here**, because `tokio::time::timeout` cannot preempt a future that never yields and `run_handler_shutdown`'s own comment at `:1256-1258` says the callback is never aborted. So the fixture that reaches the forced path is the fixture that cannot bound it, and a slow-but-yielding callback is what no test builds. The measurement is a stopwatch; the *fixture* is not free |

### The detection the default configuration does not arm

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| rt-a-the-default-configuration-arms-no-liveness-probe | **`F4`, and no fault.** A default `HostConfig`, which is the production configuration: `config.rs:294` sets `liveness: None` and `serve.rs:593` falls through to `..HostConfig::default()`, both printed and confirmed. The oracle asserts no `liveness_loop` task was spawned and no `Ping` frame was ever enqueued, for the whole incarnation | **Yes, and it is the sub-part's one `Exercised: yes`.** `tests/lifecycle.rs:496` `liveness_is_disabled_by_default` asserts no Ping within 500 ms. The gap between that and the record's check is the scope of the window: 500 ms versus the whole incarnation. Note that this record is the reachability label for Part 2a's three `explicit-config-only` records, so its oracle is load-bearing across parts |
| rt-a-an-unprobed-health-snapshot-is-distinguishable-from-a-degraded-one | **`F6`.** A handler whose first `health` call blocks, plus a client that authenticates and issues `host.status` inside the window. `tests/lifecycle.rs:579` already builds a slow-callback handler, and the window is client-visible by construction because the health task is spawned at `runtime.rs:933` and `accept_loop` starts at `:934` | **Yes** — both halves exist. The distinguishing signal the record depends on is incidental: `build_target_index` requires one to three manifests (`:500`) and `composite.rs:334-348` emits one entry per component, so a real report is never empty while the seed's `components` map is. That is exactly why the record asks for the assertion: the signal works and nothing pins it |
| rt-a-the-activation-fast-probe-interval-is-entered | **`F5`.** A handler or composite whose `health` reports a component with `metrics.storage_state == "starting"`, observed by the probe at `:1092` before activation completes. `spawn_activation_task` (`:932`) runs `handler.activate()` with deliberately no lifecycle deadline (`:981-983`), so the window's length is component-determined and a test can hold it open | **Yes** — same fixture as the fixed-probe record, and this one needs only the report, not the interval change. `tests/activation.rs` (4 tests) is the natural home. Currently unbuilt, which is why the override in the fixed-probe record cannot be measured at all today |

### The configuration surface

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| rt-a-every-published-configuration-field-changes-host-behaviour | **No fault.** An enumeration: for each of the 21 public configuration fields, assert at least one read site outside `config.rs` and outside a `Debug` implementation. Lens A performed it by grepping each field across the repository and found one violator, `HostInit::subc_capabilities` (`config.rs:250`), read nowhere and written as `Vec::new()` at all four construction sites | **Yes** — enumeration only, and the oracle proves an **absence** for the violator, so it is discharged by a census rather than by a test that passes. Best expressed as a test that names each field and its consumer, or as a review gate that fails when a new field lands with no reader. Note the `explicit-config-only` label: an embedder can populate the field, and production never does |
| rt-a-configuration-is-frozen-for-the-incarnation | **No fault, and no runtime observation is possible.** `limits`, `timing`, and `liveness` are plain owned values on `HostShared` (`runtime.rs:96-98`), cloned in at `:884-886`, with `init` moved out at `:751` and no read of `config` after `:926`. The check is a compile-time or review-level assertion that no interior mutability exists on those fields | **Yes** — structural, and it is the one record whose value is entirely in being written down. It licenses every sibling record's treatment of a limit as constant, which lens A puts at 55 or more records across the catalog. Nothing can refute it at runtime because the absent reload path cannot be exercised |
| rt-a-reserved-pools-are-zero-permit-and-unentered-without-a-declaration | Two conjuncts with different costs. **`F1`'s zero-declaration shape** gives the second: no `Reserved`-class route exists when `reservations.pending == 0`, and `tests/handler_contract.rs:636` already builds that composition. The first conjunct — that an acquisition against `reserved_pending_permits` or `reserved_task_permits` occurs *only* for a `Reserved`-class route — requires observing pool acquisitions, which needs the pools instrumented | **Partial** — one conjunct is constructible today from an existing fixture; the other needs acquisition-site observation that no harness provides. Note the cross-part fact: the pools are **not** dormant in production, because `broca/mod.rs:164-177` declares `RouteClass::Reserved` with 96/96 counts, so the live entry half is owned by 2e's saturation record and the zero-permit half describes a composition no in-tree production configuration produces |

### Paths nobody owns

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| rt-a-a-closure-store-open-failure-is-classified-not-swallowed | **`F9`.** A hostile closure root — symlinked or non-owner-only ancestor, wrong mode, non-directory, or a creation failure — each of which `harness_closure.rs` maps to a distinct `&'static str` (`:1044`, `:1052`, `:1067`, `:1074`, `:1076`, `:923`). `tests/instance_security.rs` already builds hostile-path fixtures for the sibling walk in `instance.rs`, and `tests/harness_closure.rs` constructs the store at 11 sites | **Partial, and the split is the finding.** Driving `open` to each failure cause is constructible today. Asserting that "the resulting host startup carries a classified unavailability reason naming that cause" is not, because no such reason exists: `serve.rs:162` and `:349` are each `HarnessClosureStore::open(&closure_root).ok()`, so every cause collapses to `None` before anything could report it. The honest oracle today is the enumeration that the discard happens; the record's oracle needs a mechanism that does not exist, in a file this sub-part does not own |
| rt-a-an-initialized-handler-drains-without-publishing | **`F10`.** Any of three entries into `PrePublicationCleanup::finish` (`:351`) with initialization having returned `Ok`: the shutdown token already cancelled at `:831` (which returns `Ok(None)` and drains through `:856`), `bind_owner_only` failing at `:836`, or `publish` failing at `:843` | **Yes**, via the cheapest entry, and it is deterministic rather than racy. The shutdown token is caller-supplied and `initialize` is handler-supplied, so a test handler that cancels the token inside its own `initialize` makes `:831` deterministically true. The two failure entries are unbuilt: the bind form needs `setup.sock` occupied or unwritable inside the guard's directory, the publish form needs a connection-file write failure |

**Totals: 9 fully non-vacuous today, 4 partial, 1 not constructible**, against a
pre-disposition 11/2/1. Two rows moved from `Yes` to `Partial` and both moves are
pessimistic, which is the honest direction: the fixed-probe record, whose
fast-path conjunct has no bound in the code to assert and is blocked on a product
decision rather than on a harness, and the forced-shutdown record, whose single
stated bound was the bound of the exit that does the least work and whose one
existing fixture shape is non-yielding and therefore cannot bound anything. The
nine are all three of Group A, both default-configuration detection records, the
activation-fast-probe reachability record, both surface enumerations, and the
pre-publication drain. The four partial ones are the reserved-pools record, where
one conjunct needs acquisition-site observation; the closure-store record, whose
oracle needs a mechanism outside the footprint; and the two just demoted. The one
blocked record is the serial-setup-budget record, blocked on Part 2c's missing
stalling-peer fixture.

Note the shape of that nine: **six of them need no fault at all**, because six of
the fourteen records are statements about construction order, arithmetic
coupling, or the presence or absence of a consumer, rather than about code
misbehaving under stress. Two more need only a configuration value, and two more
need only a handler-authored report. That is what cataloging an assembly and
configuration surface produces, and it remains a stronger position than either
sibling had, offset entirely by `F0`.

**One capability claim in `F7` needs correcting rather than recounting, because it
is what the forced-shutdown demotion turns on.** `F7`'s row says
`tests/lifecycle.rs:678` and `:714-715` "build the non-yielding-callback shape",
and reports that as availability. It is availability of the *state* and
unavailability of the *oracle*: a non-yielding callback is precisely the input
against which `tokio::time::timeout` provides no bound, so the fixture that
reaches the forced path is the one that cannot measure it. The fixture the record
now needs is a callback that is slow **and** yielding, plus a second variant that
drains inside the doubled chain so the `:1241` exit is separable from the `:1238`
one. Neither exists. `F7` is therefore `Partial`, not `Yes`, and the row above
says so.

**And one class is missing from this table entirely, which the gap section
records.** `AbandonGuard::drop` (`runtime.rs:419-476`) is a second teardown path
with no fault class, no record, and no row here. Reaching it needs the `run`
future dropped rather than polled, which is a capability nothing in the table
describes and which `tests/lifecycle.rs` does not exercise.

## Coverage checks to add

Each asserts a precondition that a **correct** implementation still satisfies, so
it fires without a defect present. Names are constants, globally unique, and never
constructed dynamically.

**Lens A produced exactly two `sometimes` records and both comply with the METHOD
coverage rule, so neither is duplicated here.** Verified against the rule
individually.

[rt-a-the-activation-fast-probe-interval-is-entered](catalog.md#rt-a-the-activation-fast-probe-interval-is-entered)
is a marker at `runtime.rs:1130`, fired when the fixed interval is selected. That
branch is a *designed* outcome, not a violation: the comment structure around
`:1129-1133` makes fast polling during activation the intent, and protocol `:596`
requires the host to stay usable while storage opens. The one pairing to be
careful about is with
[rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval](catalog.md#rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval),
which is `always(selected interval == health_interval whenever
activation_in_progress is false)` — that record's first conjunct, and the only one
of its two that is a pass/fail assertion at all. The marker fires when the
predicate is **true**, so it is not the negation of that `always` and the pair is
not the forbidden `always(!X)`/`sometimes(X)` shape. Recorded explicitly because
this is the one place in the sub-part where the illegal pairing would be easy to
write by accident. The disposition that split that record into an assertable
conjunct and a measured one does not change this argument: the marker pairs with
the assertable conjunct, and the measured one asserts nothing to be paired with.

[rt-a-an-initialized-handler-drains-without-publishing](catalog.md#rt-a-an-initialized-handler-drains-without-publishing)
is a marker inside `PrePublicationCleanup::finish` (`:351`), fired only when
initialization had returned `Ok`. It is a legal state on all three entries: the
shutdown-token entry at `:831` is a specified early return, and the bind and
publish entries are ordinary I/O failures. The record's `Check:` line already
explains why it is `sometimes` rather than `reachable` — `finish` is also reached
from the initialization-failure arms at `:789` and `:803`, so line coverage of the
function does not witness the situation. It is not paired with any `always(!X)`
and needs no companion marker.

| Coverage check | Situation it witnesses | Why it is safe |
| --- | --- | --- |
| `rt_startup_reached_shared_construction` | `run` reached `runtime.rs:882` with all eight startup gates passed | The ordinary success path of every startup. The precondition of every permit and byte quantity the record asserts |
| `rt_reservation_gate_refused_a_declaration` | One of `:693`, `:698`, or `:708` returned an error for a handler declaration | Legal and the specified behaviour, already produced by `tests/handler_contract.rs:323`, `:375`, `:408`. The complementary legal case to the check above |
| `rt_resident_floor_gate_admitted_at_the_boundary` | `:736` admitted a `max_resident_bytes` exactly equal to `MIN_RESIDENT_BYTES + catalog + retained` | The tightest legal configuration, already constructed by `handler_contract.rs:437`. Records the precondition of the unchecked subtraction without asserting that it underflowed |
| `rt_ingress_budget_derived_from_a_subtraction` | `:896-902` computed `ingress_budget` with plain `-` | True of every startup and legal, since the guard is 160 lines earlier. This is the honest form of the coupling finding: a fact about the code path, not an outcome |
| `rt_validate_rejected_a_named_field` | `validate` returned `Err` whose `Display` names the offending key (`config.rs:158`, `:161`, `:169`, `:176`, `:187`, `:358`, `:361`) | The designed rejection path. The complement of a clamp, and the only observable form of "not clamped" |
| `rt_validate_accepted_an_unmodified_config` | `validate` returned `Ok` and every field equals the submitted value | The ordinary acceptance path. Together with the check above, the pair is the no-silent-clamping finding; neither alone is a defect claim |
| `rt_liveness_was_absent_for_the_incarnation` | `shared.liveness.is_none()` held at `HostShared` construction (`:886`) | True of the production configuration (`config.rs:294`, `serve.rs:593`). Records the precondition of the detection gap without asserting that a peer went undetected |
| `rt_liveness_loop_was_spawned` | `connection.rs:279`'s condition held and a `liveness_loop` task was spawned | The legal configured case, reachable from `tests/lifecycle.rs:402` and `tests/client.rs:64`. The pair makes the production absence provable rather than assumed |
| `rt_health_interval_selected_the_configured_value` | `runtime.rs:1129` chose `shared.timing.health_interval` because `activation_in_progress` was false | The ordinary steady-state cadence. The independent companion to the activation marker, and what makes that marker's meaning legible |
| `rt_activation_predicate_read_a_handler_string` | `activation_in_progress` (`:1051-1071`) inspected a component's `storage_state` or `synapse_state` in a handler-authored report | Legal on every probe that has a previous report. Records that the switch is handler-controlled without asserting how long the fast cadence persisted |
| `rt_host_status_served_the_seeded_snapshot` | An authenticated `host.status` read the `Degraded` seed with an empty `components` map (`:889-893`, read at `connection.rs:691-695`) | Legal on any host whose first probe has not stored a report, which is guaranteed possible because `accept_loop` starts at `:934` and the health task at `:933`. Does **not** assert that a supervisor misread it |
| `rt_first_health_report_populated_components` | The first stored report at `:1120-1123` carried at least one entry, as `composite.rs:334-348` guarantees for a real composite | The complementary legal case, and the one that shows the distinguishing signal exists. The pair is the finding; the record's point is that nothing pins it |
| `rt_shutdown_drain_consumed_its_absolute_deadline` | `:1200` returned without the tracker draining, so `:1214`'s `timeout_at` was entered with `deadline` already in the past | Legal whenever a tracked task outlives `shutdown_deadline`, which `tests/lifecycle.rs:678` already produces. The precondition of the doubled chain, stated as the control-flow fact it is |
| `rt_shutdown_armed_the_doubled_lifecycle_chain` | `:1223` computed `lifecycle_callback_deadline.saturating_mul(2)` and `:1224` awaited it | The deliberate current behaviour, justified at `:1217-1222`. Recording it is what makes the budget overrun provable without asserting that a supervisor killed the host |
| `rt_force_close_all_routes_ran_untimed` | `:1206` or `:1216` was entered with no enclosing timeout | True of both call sites by construction. The other half of the composition finding, and the one that takes the floor from about 100 s to about 160 s |
| `rt_reserved_pool_constructed_with_zero_permits` | `:911-912` built the reserved pools from a `reservations` sum of zero | Legal for a composition with no reserved declaration, already produced by `handler_contract.rs:636`. Does **not** assert that a route reached them |
| `rt_reserved_pool_acquisition_by_a_reserved_route` | A route whose stored class is `Reserved` acquired from `reserved_pending_permits` or `reserved_task_permits` | Legal and live, because `broca/mod.rs:164-177` declares 96/96. Contradicts `runtime.rs:118-119`'s "unreachable" comment as a byproduct, which is why it is worth placing |
| `rt_closure_store_open_returned_a_classified_error` | `HarnessClosureStore::open` returned `Err` carrying one of its distinct `&'static str` causes | Legal on a hostile or misconfigured closure root, and drivable from `tests/harness_closure.rs`. Records that the classification **is produced** before anything discards it, which is the precise shape of the finding |
| `rt_closure_store_open_result_was_discarded` | `serve.rs:162` or `:349` applied `.ok()` to that result | The deliberate current behaviour. The pair is the finding: the cause exists and is thrown away one call later |
| `rt_pre_publication_cleanup_ran_after_a_successful_initialize` | `PrePublicationCleanup::finish` (`:351`) ran with initialization having returned `Ok` | Legal on all three entries and specified by the grouping comment at `:821-825`. This is the `sometimes` record's own marker, listed here for completeness rather than as an addition |

**Anti-patterns to avoid in this sub-part specifically.** Five pairings are
forbidden by METHOD's rule, and each is tempting here because in every case the
defect is easier to name than its precondition.

- Do not pair `always(probe_interval == health_interval)` with
  `sometimes(probe_interval == 50ms)`. The 50 ms branch is a *specified* outcome
  at `:1130`, so the second marker would report designed behaviour as a defect and
  the first `always` is false as stated. The record's own `always` is correctly
  conditioned on `activation_in_progress` being false; assert
  `rt_health_interval_selected_the_configured_value` and
  `rt_activation_predicate_read_a_handler_string` as two independent legal facts.
- Do not pair `always(shutdown_returns_within_shutdown_deadline)` with
  `sometimes(shutdown_exceeded_shutdown_deadline)`. The `always` is **false by
  design** — `:1223` is deliberate and justified at `:1217-1222` — so the marker
  could only fire by observing intended behaviour. Assert
  `rt_shutdown_drain_consumed_its_absolute_deadline`,
  `rt_shutdown_armed_the_doubled_lifecycle_chain`, and
  `rt_force_close_all_routes_ran_untimed`: three legal preconditions whose
  composition is the finding.
- Do not pair `always(no_config_value_is_clamped)` with
  `sometimes(a_value_was_clamped)`. No clamping path exists, so the `sometimes`
  half can never fire and the pairing would read as passing coverage forever,
  which is the failure mode 2b recorded for the quarantine assertions. Assert
  `rt_validate_rejected_a_named_field` and
  `rt_validate_accepted_an_unmodified_config`.
- Do not pair `unreachable(reserved_pool_acquisition)` with
  `sometimes(reserved_pool_entered)`. `unreachable` is the wrong semantics per
  METHOD's first coverage rule, because the pools are legitimately entered on a
  host that declares a reservation — which the production host does. The record's
  own `always-or-unreached` is the correct choice; assert
  `rt_reserved_pool_constructed_with_zero_permits` and
  `rt_reserved_pool_acquisition_by_a_reserved_route`.
- Do not pair `always(closure_open_failure_is_reported)` with
  `sometimes(closure_open_failure_was_swallowed)`. The swallowing is total:
  `.ok()` at both production sites means the "violation" is the only behaviour
  there is, so the second marker can only fire by observing it. Assert
  `rt_closure_store_open_returned_a_classified_error` and
  `rt_closure_store_open_result_was_discarded` instead: two independent legal
  facts, both present on a correct build.

Two further constraints on marker placement here.

**Place a marker where its precondition becomes true, not where the code finishes
depending on it.** `PrePublicationCleanup::finish` (`:351`) is reached from five
sites — the three post-initialization entries plus the two initialization-failure
arms at `:789` and `:803` — so a marker inside `finish` alone cannot distinguish
them. The `sometimes` record is explicit about this and conditions its marker on
initialization having returned `Ok`; the same discipline applies to the three
entries, which need `:831`, `:836`, and `:843` distinguished if the campaign wants
to know which one ran.

**Do not place any marker after `run` returns.** The forced shutdown path returns
`false` from three separate places (`:1234`, `:1240`, and one more within
`:1144-1244`) and the differences between them are exactly what the composition
finding is about. A marker at `run`'s exit sees an orderly return on every path,
100-second or otherwise.

## Leverage ranking, by cheapest valid oracle

Ranked by the cost of the cheapest oracle that yields a valid result, not by
records unblocked per capability.

**The cheapest item on this list is a doctest, and that is unusual enough to state
first.** For every other sub-part the cheapest item is a workflow change. Here
there are two candidates and the doctest is cheaper, because this sub-part's whole
contract is doc comments and `ci.yml:190` already builds and runs the lib doc
target.

1. **A `compile_fail` or ordinary doctest in `config.rs`.** `config.rs` is
   `pub mod` (`lib.rs:14`), `ci.yml:190` runs `cargo test -p mc-host --doc`, and
   the file has no fence of any kind. So a doctest added there executes in CI
   **today**, with no workflow edit. It unblocks **zero** records on its own and it
   is the only way anything in this sub-part becomes CI-protected without touching
   the workflow. The obvious first use is
   `rt-a-no-configured-limit-is-silently-clamped`, whose check is a pure function
   of a constructed `HostConfig` and therefore expressible as a doctest. Stated
   first because a reader who assumes the workflow must change is wrong about this
   sub-part specifically.

2. **`F0`, running the existing suites in CI.** A workflow change: add an
   unfiltered `-p mc-host` invocation, or name `synapse_bundle`,
   `harness_closure`, `ipc_budget_topology`, and `activation`. It unblocks zero new
   records and protects **63 existing test functions**, including the 15 that are
   the entire coverage of a 1,122-line untrusted-manifest filesystem module.
   Ranked second only because item 1 needs no workflow access at all.

3. **Enumeration oracles, no fault and no fixture.** Five records are discharged
   wholly or in their load-bearing half by reading the tree, each costing one pass:
   `rt-a-every-published-configuration-field-changes-host-behaviour` (21 fields
   against their consumers, one violator),
   `rt-a-configuration-is-frozen-for-the-incarnation` (three cloned fields, one
   moved `init`, no read of `config` after `:926`),
   `rt-a-the-ingress-pool-derivation-cannot-underflow` (the `MIN_RESIDENT_BYTES`
   identity against the subtrahend list), the static half of
   `rt-a-the-serial-setup-budget-triples-the-configured-transport-deadline` (both
   sites arm the deadline fresh, so the figure is 6 s), and the discard half of
   `rt-a-a-closure-store-open-failure-is-classified-not-swallowed` (`.ok()` at both
   production sites). Their value is that they **are** the sub-part's findings, and
   a census check is cheaper than a test and catches the reintroduction case.

4. **`F5`, one handler health report plus one changed fixture value.** **This is
   the highest-value tier**, and it is ranked below the enumerations only because
   those cost less still. A handler whose `health` report carries
   `storage_state: "starting"` discharges
   `rt-a-the-activation-fast-probe-interval-is-entered` outright, and the same
   report plus a `health_interval` set to something other than 50 ms gives
   `rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval` its
   measurement. Two records from one fixture, and the second half is literally a
   one-line change to `tests/lifecycle.rs:165`, which currently sets exactly the
   hardcoded value and therefore defeats the record it would otherwise serve.

5. **`F3` made exhaustive, and `F1`'s existing shapes composed.** Extending the
   seven per-key `config.rs` tests to every field of `HostLimits`, `HostTiming`,
   and `LivenessPolicy` discharges `rt-a-no-configured-limit-is-silently-clamped`
   as written, and asserting the conjunction at the construction site over
   `handler_contract.rs`'s four existing gate tests discharges
   `rt-a-startup-refuses-every-configuration-it-cannot-fund`. Both are fixture
   edits over material that exists.

6. **`F7` plus a stopwatch.** `tests/lifecycle.rs:678` and `:714-715` already
   reach the forced shutdown path; measuring elapsed time from cancellation to
   `run`'s return gives
   `rt-a-forced-shutdown-outlives-the-configured-shutdown-deadline` its whole
   oracle. Ranked here rather than higher because the record's stated bound needs
   the refinement noted in its row and in the catalog: `run_handler_shutdown`'s own
   30 s is outside the two terms, so the check must be corrected before the
   stopwatch means anything.

7. **`F6` plus a client inside the window.** A slow first `health` callback
   (`tests/lifecycle.rs:579` exists) plus an authenticated `host.status` inside the
   window gives
   `rt-a-an-unprobed-health-snapshot-is-distinguishable-from-a-degraded-one`. The
   assertion is that a `degraded` response carries a non-empty `components` map or
   an explicit marker. Cheap, and ranked below tier 6 only because it needs a
   client interaction rather than a measurement.

8. **`F10`'s cheapest entry, a self-cancelling `initialize`.** A test handler that
   cancels the caller-supplied shutdown token inside its own `initialize` makes
   `runtime.rs:831` deterministically true and discharges
   `rt-a-an-initialized-handler-drains-without-publishing`. Ranked here because the
   handler shape is unlike anything the suite currently builds, even though the
   mechanism is deterministic.

9. **Pool acquisition-site observation.** The only route to the first conjunct of
   `rt-a-reserved-pools-are-zero-permit-and-unentered-without-a-declaration` —
   that acquisitions happen only for `Reserved`-class routes — because it requires
   observing the permit pools rather than the outcome. Note that 2e's five-state
   saturation campaign reaches the same evidence from the admission side, so the
   cheaper path may be to let
   [../part-2e-request-path/catalog.md#req-a-both-admission-classes-and-the-rejection-bound-saturate](../part-2e-request-path/catalog.md#req-a-both-admission-classes-and-the-rejection-bound-saturate)
   own it and cite that result here.

10. **`F8`, a stalling-peer fixture.** The only route to
    `rt-a-the-serial-setup-budget-triples-the-configured-transport-deadline`'s
    measurement, and the sub-part's one fully blocked record. Part 2c's
    `fault-map.md:52` describes the fixture and records its absence, so the work is
    shared with that part rather than owned here. The static half is already
    settled by reading, so what this buys is confirmation of a 6-second figure
    against a documented 2-second client budget, plus the same fixture for 2c's own
    records.

11. **A classified startup-unavailability reason.** Last, because it is a
    production change in a file this sub-part does not own.
    `rt-a-a-closure-store-open-failure-is-classified-not-swallowed` needs
    `serve.rs:162` and `:349` to stop discarding a well-built closed error
    vocabulary, and its own open question — what `harness_backend` (`serve.rs:344`)
    ultimately reports to an operator — must be answered by an `mc-module` pass
    that is not currently scheduled. Until then the honest oracle is tier 3's
    enumeration that the discard happens, which is why the record is the catalog's
    only `medium` confidence.
