# Lens C: negotiation codec and provider registry contract

Attention focus: the negotiation wire codec (`transport_negotiation.rs`), the
provider registry contract (`transport_provider.rs`), and the static composition
(`composite.rs`). Part 2a treated all three only as boundary context; the setup
state machine, sticky selection, fallback-reason precedence, and grant binding
are deliberately not re-reported here.

All line references verified against HEAD `1c193ae0`.

## Observations

- O1: The codec is a leaf module with no connection or provider code, and its
  own doc claims closed field sets, exact bounds, and recursive duplicate-key
  rejection "before any typed or opaque value is materialized"
  [crates/mc-host/src/transport_negotiation.rs:1-10].
- O2: Every decode entry point begins with `parse_root`, which calls
  `strict_json::parse` on the whole body and then requires the object form
  [transport_negotiation.rs:262-272].
- O3: `strict_json::parse` is a recursive `DeserializeSeed`/`Visitor` walk that
  rejects a repeated key at the depth where it occurs, and calls
  `deserializer.end()` so trailing bytes are a parse failure
  [crates/mc-host/src/control.rs:714-721, 792-804]. Exact consumption is
  therefore a property of the shared parser, not of the negotiation module.
- O4: `serde_json` is declared as `serde_json = "1"` with default features
  [Cargo.toml:27, crates/mc-host/Cargo.toml:17]. Neither `unbounded_depth` nor
  `arbitrary_precision` is enabled, so the parse recursion is capped by
  serde_json's own internal limit and `serde_json::to_vec` of a `Value` cannot
  fail. That is what makes the four `.expect(...)` calls on serialization
  unreachable [transport_negotiation.rs:850, 923, 940, 957].
- O5: The frame reader rejects a channel-0 request body over
  `MAX_CONTROL_BODY_LEN = 65_536` before any JSON is parsed
  [crates/mc-host/src/wire.rs:374, crates/mc-host/src/tcp_frame_channel.rs:198].
  So the parse input is bounded, but bounded at 64 KiB, not at any negotiation
  constant.
- O6: `check_closed_fields` rejects an unknown key and deliberately reports only
  the container `path`, never the key itself
  [transport_negotiation.rs:276-290]. It is applied at the root of every
  negotiation body [543, 570-573, 680-684, 733], to each offer object [493-497],
  and to `selected` [595-599]. It is **not** applied inside `parameters` or
  `descriptor`, which are opaque by contract, so "closed field set" bottoms out
  at the opaque boundary.
- O7: Duplicate-key rejection at arbitrary depth is entirely the parser's
  (`control.rs:794-802`); the negotiation module adds only the offer-identity
  duplicate rule [transport_negotiation.rs:511-518]. The comment at
  transport_negotiation.rs:384 states this correctly.
- O8: `exceeds_opaque_depth` is iterative with an explicit worklist and skips
  scalars before the bound test, which matches the §7.1 counting rule that only
  containers add a level [transport_negotiation.rs:416-432]. It runs before the
  byte counter [443-458].
- O9: `decode_negotiate_request` accepts **any** `negotiation_version >= 1`; the
  version check is deliberately host policy, not grammar
  [transport_negotiation.rs:538-540, 545-546]. `decode_negotiate_response`,
  `decode_activate_request`, and `decode_tagged_only` all require exactly
  `NEGOTIATION_VERSION` [576-581, 686, 735, 739-750].
- O10: `parse_control` parses the body with `strict_json::parse`
  [control.rs:197], and then for `OP_TRANSPORT_NEGOTIATE` calls
  `decode_negotiate_request(body)` [control.rs:238-240], which parses the same
  bytes a second time [transport_negotiation.rs:542]. The malformed path does
  the same through `malformed_negotiation` [control.rs:176-178, 200-202,
  216-219]. Every negotiation body is therefore fully parsed twice.
- O11: `is_negotiation_family` is a structure-blind byte scan for the literal
  `"transport.negotiate`, with a lossy escape-decoding second pass
  [control.rs:118-128, 133-158]. It is consulted on the binary-flag path
  [control.rs:185-195], the parse-failure path [200-202], and the over-depth
  path [216-219].
- O12: `TransportProviders::default()` is an empty `Vec` of entries
  [transport_provider.rs:159-163], and `HostConfig::default()` installs exactly
  that [crates/mc-host/src/config.rs:283-284, 297]. No production code path
  calls `with_injected`; the only callers are the test harness and the test
  files [crates/mc-host/tests/support/fake_transport.rs:56,
  tests/support/shm_process.rs:573, tests/shm_transport.rs:34, 559, 684,
  tests/transport_negotiation.rs:1001].
- O13: `ShmProvider`, the only provider implementation shipped inside the crate,
  overrides `preflight` [crates/mc-host/src/shm_provider.rs:275-285]. The test
  `FakeProvider` does not [tests/support/fake_transport.rs:69-90], so it takes
  the trait default.
- O14: Provider identity is snapshotted at registration by calling
  `transport()` and `capability_version()` once, inside `redact_sync`
  [transport_provider.rs:187-196], then asserted for grammar conformance, the
  reserved `tcp` name, and `(transport, capability_version)` uniqueness
  [197-213]. `find` matches the pair, `serves_transport` matches the name only
  [270-290].
- O15: `prepare_on_worker` takes a `std::sync::Mutex` and may lazily spawn an OS
  thread while holding it [transport_provider.rs:230-256]. It is called
  synchronously from the connection read loop [crates/mc-host/src/connection.rs:1037],
  and the setup deadline is only applied afterwards, to the reply
  [connection.rs:1045-1047].
- O16: `composite.rs` composes exactly three fixed children and is dispatch
  metadata only: the route map answers "which child owns this handle" and
  nothing else [crates/mc-host/src/composite.rs:1-15, 105-113].
- O17: `catch_child_panic` wraps **each poll** in `catch_unwind`
  [composite.rs:160-171]. It is applied to the two optional children's `health`
  [318-323] and to all three `shutdown` calls [371-384]. It is not applied to
  `install_connection_key` [193-197], `manifest`/`manifests` [118-121, 199-205],
  `resources` [207-215], `initialize` [217-228], `activate` [230-240], `bind`
  [270-274], `handle` [277-287], `route_gone` [289-296], or the primary's
  `health` [312].
- O18: `ShutdownError` is a `pub` tuple struct with a `pub String`, derives
  `Debug`, and its `Display` prints the inner string verbatim
  [composite.rs:31-38]. It is re-exported from the crate root
  [crates/mc-host/src/lib.rs:63-65]. The composite's own accounting reports only
  `err.0.len()` [composite.rs:182-185], and the doc comment explicitly invites
  components to "put real detail here" [composite.rs:28-30].
- O19: `HealthReport.detail` is set by the composite [composite.rs:313-317] and
  propagated on the winning report [349-356], but no host source file reads
  `.detail` on a `HealthReport` (verified by grep across `crates/mc-host/src`:
  the only `.detail` hits are `harness_closure.rs:170,176` on an unrelated
  type). The child's panic reason is therefore write-only.
- O20: Debug inventory in scope. Redacting: `ActivationToken` [183-187],
  `TransportOffer.parameters` as `"<opaque>"` [198-206], `NegotiateResponse`
  descriptor and token [238-254], `PreparedCandidate` [89-97 of
  transport_provider.rs], `GrantRecord` token [410-418], `TransportProviders`
  names only [293-300], `ShmProvider` profile [shm_provider.rs:258-263].
  Derived and non-redacting but carrying no contract-listed secret:
  `NegotiationError` [89], `NegotiateRequest` [209] (which reaches
  `TransportOffer`'s redacting impl), `SelectedTransport` [216],
  `ActivateRequest` [257] (which reaches the redacting token impl),
  `GrantBinding` [353], `ProviderFailure` [35], `PreflightEligibility` [100].
  No `Debug` at all: `ProviderContext`, `Candidate`.
- O21: `TransportOffer.parameters` and `ProviderContext::offer_parameters()` are
  `pub` [transport_negotiation.rs:195, transport_provider.rs:65-67], so the raw
  opaque value is reachable by any holder; redaction is a property of the
  wrapper `Debug` impls, not of the data.

## Codec bound map

Bounds are listed in the order the decoder reaches them for a
`transport.negotiate` request. "R" marks the single recursive walk.

- B1: Frame body length — 65,536 bytes, enforced at frame read, **before** the
  recursive parse [wire.rs:374, tcp_frame_channel.rs:198].
- B2: **R — the full recursive strict parse.** `strict_json::parse` walks the
  entire body. It enforces UTF-8, duplicate-key rejection at every depth, and
  exact consumption, and is depth-limited only by serde_json's internal
  recursion limit [control.rs:714-721, 792-804; transport_negotiation.rs:263].
  **No negotiation-specific bound precedes it.**
- B3: Whole-body nesting — `MAX_CONTROL_DEPTH = 33`
  (`MAX_ADMISSION_FACTS_DEPTH + 1`), computed by the recursive `value_depth`
  **after** B2 and only on the `parse_control` path
  [control.rs:63-69, 210-220, 474-480]. A direct call to
  `decode_negotiate_request` skips this entirely.
- B4: Root closed field set — `{op, negotiation_version, offers}`, after B2
  [transport_negotiation.rs:543]. Response root allows six names [563-573];
  activate allows three [680-684]; the tagged bodies allow two [733].
- B5: `op` exact match, after B4 [transport_negotiation.rs:292-315, 544].
- B6: `negotiation_version` — JSON integer in `1..=u32::MAX`; fractions and
  exponent forms fail because they parse as f64 and `as_u64()` returns `None`
  [transport_negotiation.rs:319-343, 545-546]. The request decoder does **not**
  pin it to 1 [538-540]; every other decoder does [576-581, 686, 739-750].
- B7: Offer count — 1 to `MAX_OFFERS = 8`, checked after B2 on the already
  materialized array [transport_negotiation.rs:25, 471-482].
- B8: Per-offer closed field set — `{transport, capability_version, parameters}`
  [transport_negotiation.rs:493-497].
- B9: Transport name — 1 to `MAX_TRANSPORT_NAME_BYTES = 32` bytes,
  `^[a-z][a-z0-9._-]{0,31}$`, byte-wise [transport_negotiation.rs:27, 345-354,
  356-380].
- B10: Per-offer `capability_version` — same integer rule as B6
  [transport_negotiation.rs:499-503].
- B11: Opaque `parameters`/`descriptor` type — must be a JSON **object**
  [transport_negotiation.rs:434-440].
- B12: Opaque depth — `MAX_OPAQUE_DEPTH = 8`, §7.1 counting, iterative
  worklist, checked **before** the byte counter and before any later recursive
  walk of that subtree [transport_negotiation.rs:31, 416-432, 441-448]. This is
  the only bound the module places before a recursion, and the recursion it
  guards is the *serializer's*, not the parser's (the parser already ran at B2).
- B13: Opaque bytes — `MAX_OPAQUE_BYTES = 8192` compact bytes, measured by
  `CappedCounter` which fails past the limit without retaining bytes
  [transport_negotiation.rs:29, 388-408, 449-458]. Checked **after** B12, so the
  depth walk's worklist is sized by the value's node count, which B1 bounds at
  64 KiB rather than at 8 KiB.
- B14: Duplicate offer identity — `(transport, capability_version)` compared
  against the already-accepted prefix [transport_negotiation.rs:511-518].
- B15: Required `tcp` offer — checked after the whole list decodes
  [transport_negotiation.rs:526-531].
- B16: Response only — selection must name an exact offered entry
  [transport_negotiation.rs:606-614]; TCP selections forbid
  `activation_token`/`descriptor` [616-628]; non-TCP selections forbid `reason`
  [652-657] and require both token and descriptor [658-665].
- B17: `activation_token` — exactly 32 lowercase hex ASCII characters
  [transport_negotiation.rs:33, 163-176, 691-713].
- B18: `reason` — closed two-value vocabulary
  [transport_negotiation.rs:120-135, 629-648].
- B19: Encoder side. `encode_negotiate_request` revalidates B6 (zero only), B7,
  B9, B10, B11-B13, B14, and B15 [transport_negotiation.rs:789-851].
  `encode_negotiate_response` revalidates version-nonzero, name grammar,
  the "a grant is never tcp" rule, and B11-B13 on the descriptor
  [861-924]. It does **not** take the offer list and cannot check B16.

## Provider registry map

- Registration: `TransportProviders::with_injected(Vec<Arc<dyn InjectedProvider>>)`
  is the only constructor that adds entries [transport_provider.rs:180-218].
  `Default` yields an empty registry [159-163]. The registry is reached only
  through the `#[doc(hidden)] pub transport_providers` field on `HostConfig`
  [config.rs:283-284] and is cloned into `HostShared` at startup
  [crates/mc-host/src/runtime.rs:870].
- Identity: the `(transport, capability_version)` pair, snapshotted into
  `ProviderEntry` at registration [transport_provider.rs:126-131, 187-196]. The
  snapshot, not the live provider, answers every later lookup, so a provider
  whose `transport()` changes after registration is ignored.
- Collision: impossible after construction. Three `assert!`s reject a name
  outside the grammar, the reserved `tcp` name, and a duplicate pair
  [transport_provider.rs:197-213]. These are plain `assert!`, so they hold in
  release. The panic messages carry only the index, never provider-authored
  bytes [201, 204, 211].
- Lookup: `find` requires both name and version; `serves_transport` requires
  only the name, and exists solely so the fallback reason can distinguish
  "unknown transport" from "known transport, wrong version"
  [transport_provider.rs:270-290; connection.rs:900-903, 938-941].
- Preflight: `InjectedProvider::preflight` has a default body returning
  `PreflightEligibility::Serveable` and ignoring its `_parameters` argument
  [transport_provider.rs:116-120]. The host calls it under `catch_unwind` +
  `redact_sync`, and a panic degrades to `StaticallyOmitted`
  [connection.rs:905-912]. `Serveable` goes straight to `grant_candidate`
  [connection.rs:914-929].
- Preparation: `prepare` is queued onto one lazily started, named OS thread with
  a `PREPARE_QUEUE_BOUND = 8` sync channel; a panicking gate is caught and
  becomes `ProviderFailure::Unavailable`; a full queue or a failed spawn drops
  the reply sender so the caller fails closed
  [transport_provider.rs:133-155, 220-264, 236-249].

## Composite map

- Composes three fixed children — one mandatory `PrimaryComponent` and two
  `SecondaryComponent`s — plus a `HashMap<RouteHandle, Child>` used only for
  dispatch [composite.rs:1-15, 46-96, 105-113].
- Invariants it must preserve across components: unique module IDs, checked once
  at construction [118-126]; the same deterministic child order in `manifests`,
  `resource_declarations`, `initialize`, `activate`, health tie-breaking, and the
  reversed drain order in `shutdown` [199-215, 217-240, 324-354, 359-385]; and
  exactly one route-map entry per bound handle, inserted before the child sees
  the handle and removed only after that child's `route_gone` returns
  [262-269, 297-303].
- Partial failure. Isolated: an optional child's `health` panic becomes a
  `Failing` report for that child and the primary still decides the aggregate
  [306-323, 349-354]; a `shutdown` error or panic in any child never skips a
  later child's drain [365-385]. Escalated by design: any child's `initialize`
  or `activate` `Err` aborts the whole `try_join!` [221-226, 233-238]; the
  aggregate `shutdown` failure is re-raised as one deterministic panic **after**
  every drain [386-388]; the primary's `health` panic is not caught [312].

## Candidate properties

### no-negotiation-bound-precedes-the-recursive-parse

Type: safety
Reachability: default-production
Status: active
Exercised: partial — depth and byte bounds are pinned exactly
(`tests/transport_negotiation.rs:379-457`), and an over-`MAX_CONTROL_DEPTH`
negotiation body is pinned to the negotiation classification
(`control.rs:973-984`). Nothing pins the parse-stage recursion itself.
Guarantee: The only recursive walk of an untrusted negotiation body that runs
before any negotiation bound is `strict_json::parse`, and its stack use is
bounded by serde_json's internal recursion limit for every input the frame
reader admits.
Check: `always` — for every channel-0 body up to `MAX_CONTROL_BODY_LEN`,
`parse_control` returns a value or a bounded error and never aborts the process.
`always` rather than `unreachable`, because the forbidden outcome is a state
(stack exhaustion) with no dedicated detection point in the code.
Fault/timing angle: none. The window is one synchronous call on the connection
read loop.
Required faults and enabling state: a maximally nested 64 KiB channel-0 request
body, sent on a thread with the smallest stack the host actually gives a
connection task. The negotiation constants do not help here: `MAX_OPAQUE_DEPTH`
is checked at transport_negotiation.rs:443, long after the parse at 263.
Confidence: medium — [evidence](evidence/no-negotiation-bound-precedes-the-recursive-parse.md).
Verified the ordering (B2 before B3 and B12) and that `serde_json = "1"` carries
default features so `unbounded_depth` is off and the internal limit applies. Did
not verify the exact serde_json limit value against the resolved lockfile, nor
measure frames-per-level for `StrictVisitor`, which recurses through
`next_value_seed` -> `deserialize_any` -> `visit_map` per level.
Existing check: `control.rs:973-984` exercises `MAX_CONTROL_DEPTH + 2` nesting,
which is roughly 35 levels. Nothing exercises the parser's own limit.
Impact: if the parse limit were ever disabled or the per-level frame cost were
large enough, an authenticated client would abort the host process with one
frame, bypassing every negotiation bound.
Open questions:
- What stack size does a connection task actually get, and what is the
  per-level frame cost of `StrictVisitor`? (needs measurement)

### opaque-depth-walk-is-sized-by-the-body-cap-not-the-opaque-cap

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `opaque_value_bounds_are_exact` pins both bounds
independently but never a value that is depth-legal and grossly oversized.
Guarantee: The iterative depth walk over an opaque value completes with a
worklist bounded by the value's node count, and the byte cap then rejects the
value; peak transient allocation during negotiation decode is therefore
governed by `MAX_CONTROL_BODY_LEN`, not by `MAX_OPAQUE_BYTES`.
Check: `always` — for every accepted or rejected `parameters`/`descriptor`,
peak `pending` length stays under a stated multiple of the parsed node count,
and the decode returns. Chosen over `sometimes` because the ordering holds on
every call, not just in one operational state.
Fault/timing angle: none, but the cost lands on the read loop before the setup
deadline exists.
Required faults and enabling state: an offer whose `parameters` is 8 levels deep
and thousands of sibling scalars wide, sized just under the 64 KiB frame cap so
B1 admits it, B12 passes, and B13 rejects it. Eight such offers per request,
one request per reconnect.
Confidence: high — [evidence](evidence/opaque-depth-walk-is-sized-by-the-body-cap-not-the-opaque-cap.md).
Read the ordering directly: `exceeds_opaque_depth` at
transport_negotiation.rs:443 precedes the `CappedCounter` at 449-458, and the
worklist pushes every container child [427-429] plus one boxed iterator per
container node [419-422].
Existing check: `tests/transport_negotiation.rs:379-457` pins depth 8 accept,
depth 9 reject, exactly-8192-bytes accept, 8193 reject, and non-object reject.
None of those is both deep and wide.
Impact: bounded, but the module's own doc claims the byte cap avoids
"materializing a full compact document on the connection read loop"
[transport_negotiation.rs:385-387], and the depth walk in front of it does
allocate proportional to the whole admitted body.
Open questions:
- Is reordering B13 before B12 safe, given the comment at
  transport_negotiation.rs:411-415 argues depth must come first to bound the
  serializer's recursion? A byte counter that fails fast is itself recursive.
  (needs human input)

### negotiation-family-classifier-is-structure-blind

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the under-approximation direction is well covered; the
over-approximation direction is not tested at all.
Guarantee: A malformed channel-0 body receives the disposition its actual `op`
earns: a negotiation body gets the terminal plus retirement, and every other
body gets a terminal for its correlation while the connection survives.
Check: `always` — for every malformed body, the chosen disposition equals the
disposition of the same body with all occurrences of the literal
`"transport.negotiate` removed from non-`op` positions.
Fault/timing angle: none. One frame, one classification.
Required faults and enabling state: a generation already in `TcpCommitted`, then
one malformed control body whose `op` is not `transport.negotiate` but which
contains the needle. A key literally named `transport.negotiate` suffices and
needs no escaping, for example
`{"op":"catalog.list","transport.negotiate":1,"op":"x"}`: the duplicate `op`
makes `strict_json::parse` fail [control.rs:197-203], `is_negotiation_family`
matches the key's opening quote [control.rs:118-122],
`malformed_negotiation` builds a `NegotiationError` [176-178], and
`handle_negotiate` sees `setup.state != BootstrapTcp` and returns
`ControlFlow::Close(ReadExit::Peer)` with no error frame at all
[connection.rs:637-639, 846-848].
Confidence: high — [evidence](evidence/negotiation-family-classifier-is-structure-blind.md).
Traced the whole path and confirmed the over-depth branch consults the real
parsed `op` [control.rs:216-219] while the parse-failure and binary-flag
branches cannot and fall back to the byte scan [185-195, 200-202].
Existing check: `control.rs:946-989` covers five under-approximation cases plus
the binary and over-depth branches, and one non-negotiation control body with
the same defect — but that body does not contain the needle
[control.rs:985-988]. `tests/transport_negotiation.rs:1048-1071` covers the
malformed-negotiation terminal on a setup generation.
Impact: an authenticated client with a buggy body loses the whole connection
silently instead of receiving `invalid_control_request` and staying connected,
contradicting the protocol at docs/mc-host-wire-protocol.md:334 and 398. On a
setup-only generation the outcome coincides, which is why this hides.
Open questions: None.

### response-decoder-pins-the-constant-version-not-the-request-version

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `version_bounds_accept_1_and_u32_max_and_reject_everything_else`
pins the integer range, and the host-side mismatch retirement is covered, but no
test exercises a request version other than 1 against the response decoder.
Guarantee: A client rejects exactly those responses whose `negotiation_version`
differs from the version it sent, and accepts a correctly echoed response at any
version it is willing to speak.
Check: `always` — for every `(request_version, response_version)` pair the
decoder accepts iff the two are equal. `always` because the comparison runs on
every response decode.
Fault/timing angle: none.
Required faults and enabling state: a request encoded at a version other than 1.
`encode_negotiate_request` permits that: it rejects only version 0
[transport_negotiation.rs:790-795], while `decode_negotiate_response` compares
against the constant `NEGOTIATION_VERSION` [576-581] because its signature has
no access to the request. A v2 client using this codec would therefore reject a
correctly echoed v2 response.
Confidence: high — [evidence](evidence/response-decoder-pins-the-constant-version-not-the-request-version.md).
Read both sides. Also confirmed the host never emits a mismatched echo, because
`handle_negotiate` closes on version inequality [connection.rs:885-887] before
`respond_tcp` runs [960-976], so the `negotiation_version` parameter of
`encode_negotiate_response` is constant on every production path.
Existing check: `tests/transport_negotiation.rs:191-253` pins the integer range;
`tests/transport_negotiation.rs:875-905` pins host-side mismatch retirement.
Impact: latent. Harmless while only version 1 exists, and it silently converts
the contract's "differs from the request's grammar version" into "differs from
1" the moment a second version ships.
Open questions:
- Should `decode_negotiate_response` take the request version as a parameter, or
  is pinning to 1 the intended v1-only simplification? (needs human input)

### encoder-cannot-refuse-an-unoffered-or-unserveable-selection

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `encoders_refuse_out_of_contract_values` covers the request
encoder thoroughly and the response encoder only for the "grant may never name
tcp" rule.
Guarantee: An encoded `transport.negotiate` response names a selection that was
actually offered and that this host can actually serve.
Check: `always` — every encoded response's `selected` pair is a member of the
request's offer list, and for a TCP selection the stamped
`tcp_capability_version` equals an offered `tcp` entry's version.
Fault/timing angle: none.
Required faults and enabling state: none in-process; this is a missing guard.
`encode_negotiate_response` takes no offer list
[transport_negotiation.rs:861-865], so offer membership is provable only by the
caller. Today the caller does prove it: `handle_negotiate` requires an offered
`tcp` at `TCP_CAPABILITY_VERSION` before any TCP response
[connection.rs:880-887] and builds a grant's `selected` from the offer it just
matched [connection.rs:917-920, 1055-1067]. The corresponding client-side proof
is `decode_negotiate_response`'s membership test
[transport_negotiation.rs:606-614], which proves membership but **not**
serveability: an accepted offer list can carry a selection the peer cannot serve,
and only the peer's own registry lookup catches that.
Confidence: high — [evidence](evidence/encoder-cannot-refuse-an-unoffered-or-unserveable-selection.md).
Verified the response encoder's full validation set at
transport_negotiation.rs:866-924 against the request encoder's at 789-851. The
request encoder's doc explicitly claims it "revalidat[es] the same bounds the
decoder enforces" [786-788]; the response encoder makes no such claim and
cannot.
Existing check: `tests/transport_negotiation.rs:647-707` covers request-encoder
refusals plus the grant-names-tcp refusal; `tests/transport_negotiation.rs:515-534`
covers decoder-side unoffered rejection.
Impact: the protocol's "The host MUST select exactly one offered entry"
[docs/mc-host-wire-protocol.md:590] is enforced only by one caller. A second
caller of `encode_negotiate_response` inherits no guard.
Open questions: None.

### encoder-refuses-exactly-what-the-decoder-refuses

Type: safety
Reachability: default-production
Status: active
Exercised: partial — refusals are tested by hand-picked examples, not as a
round-trip relation.
Guarantee: For every `NegotiateRequest` value, `encode_negotiate_request`
succeeds iff `decode_negotiate_request` would accept the resulting bytes, and
decoding an encoded request reproduces the original value.
Check: `always` — `decode(encode(x)) == Ok(x)` whenever `encode(x)` is `Ok`, and
`encode(x)` is `Err` whenever `x` violates any of B7, B9, B10, B11, B12, B13,
B14, or B15.
Fault/timing angle: none.
Required faults and enabling state: none; this is a property-test shape over
generated `NegotiateRequest` values. Note the one asymmetry that must be stated
in the property rather than asserted away: the encoder rejects only version 0
[transport_negotiation.rs:790-795] while the decoder accepts any version >= 1
[545-546], so the version field is outside the iff.
Confidence: high — [evidence](evidence/encoder-refuses-exactly-what-the-decoder-refuses.md).
Compared the encoder's checks at transport_negotiation.rs:789-851 against the
decoder's at 462-552 field by field. The duplicate-offer rules use different
loop shapes (decoder scans accepted offers at 511-513, encoder scans the input
prefix at 820-823) but compute the same relation.
Existing check: `tests/transport_negotiation.rs:69-94` round-trips one TCP-only
request; `tests/transport_negotiation.rs:647-707` tests four specific refusals.
No generated-input relation.
Impact: a drift between the two bound sets ships silently and produces bytes the
peer rejects, retiring healthy generations.
Open questions: None.

### preflight-default-advertises-unvetted-offer-parameters

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — the default body is executed by every test that uses
`FakeProvider`, but no test asserts what the default costs.
Guarantee: An offer whose `parameters` make it statically ineligible selects TCP
with no `reason`, and never reaches provider `prepare`.
Check: `always` — for every offer the host advertises as `Serveable`, the
provider inspected that offer's `parameters`. Coverage form: assert the
independent preconditions — a registered provider, an offer carrying parameters,
and a `Serveable` verdict — rather than asserting the violation.
Fault/timing angle: none in the decision itself; the consequence lands in
`grant_candidate`, which has already stopped and joined bootstrap liveness
[connection.rs:1023-1027] before the preparation it should not have started.
Required faults and enabling state: an injected provider that does not override
`preflight` [transport_provider.rs:116-120], plus an offer whose parameters that
provider cannot serve. The default ignores `_parameters` entirely, so the verdict
is `Serveable` for every parameter shape, the host calls `grant_candidate`
[connection.rs:914-929], and a `prepare` refusal returns
`ControlFlow::Close(ReadExit::Peer)` [connection.rs:1045-1047] — generation
retirement, where §7.7.3 requires reasonless TCP.
Reachability evidence: **not** default-production. `TransportProviders::default()`
is empty [transport_provider.rs:159-163] and is what `HostConfig::default()`
installs [config.rs:283-284, 297]; no `src/` caller invokes `with_injected`
(verified by grep: only `tests/`). The one in-crate provider overrides
`preflight` [shm_provider.rs:275-285]. The default body is therefore reached
today only through the test `FakeProvider`
[tests/support/fake_transport.rs:69-90], and by an out-of-tree embedder that
sets the `#[doc(hidden)] pub transport_providers` field [config.rs:283-284] with
`TransportProviders::with_injected`, which is `pub` in a `pub` module
[transport_provider.rs:180, lib.rs:27-28].
Confidence: high — [evidence](evidence/preflight-default-advertises-unvetted-offer-parameters.md).
Verified the default body, the unused parameter, both call sites, and the
absence of any production registration.
Existing check: `tests/transport_negotiation.rs:850-874` covers reasonless TCP
for an *absent* provider, which is the `None` arm at connection.rs:942-943, not
the preflight default. `tests/shm_transport.rs:521-561` uses a
`MatrixProvider`; unverified whether it overrides `preflight`.
Impact: what leaks is authority, not data. The static-ineligibility screen the
contract mandates is skipped, an authenticated client can drive provider
resource creation with arbitrary opaque parameters one attempt per reconnect
(bounded at 8 stranded jobs by `PREPARE_QUEUE_BOUND`
[transport_provider.rs:144]), and the contract's reasonless-TCP outcome becomes a
hard close. Because the default is `Serveable` rather than `StaticallyOmitted`,
the trait's failure mode is open, not closed — the opposite of the panic path,
which degrades to `StaticallyOmitted` [connection.rs:912].
Open questions:
- Should the default be `StaticallyOmitted` so an unimplemented preflight fails
  closed, or is `Serveable` deliberate so a minimal provider works? (needs human
  input)

### provider-identity-is-the-registration-snapshot

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet — no test registers a provider whose metadata getters change
after registration, and no test asserts the three registration panics.
Guarantee: A provider's `(transport, capability_version)` identity is fixed at
registration, is unique within the registry, is inside the wire grammar, is
never `tcp`, and every later lookup uses that snapshot rather than calling
provider code.
Check: `always` — after `with_injected` returns, no two entries share a pair,
every entry's name satisfies `valid_transport_name`, no entry is `tcp`, and
neither `find` nor `serves_transport` invokes any provider method.
Fault/timing angle: the ordering at transport_provider.rs:186-196 matters: the
panic hook is installed before the first provider method runs, and each getter
executes under `redact_sync`, so a panicking getter cannot print provider data.
Required faults and enabling state: a provider whose `transport()` returns a
different string on a second call; separately, a provider with a grammar-invalid
name, the reserved `tcp` name, or a duplicate pair.
Reachability evidence: reached only through `with_injected`, whose only callers
are under `crates/mc-host/tests/` (grep-verified), plus an out-of-tree embedder
via the `#[doc(hidden)] pub` config field [config.rs:283-284].
Confidence: high — [evidence](evidence/provider-identity-is-the-registration-snapshot.md).
Read the snapshot at transport_provider.rs:187-196, the three `assert!`s at
197-213, and both lookups at 270-290. Confirmed the asserts are plain `assert!`
and hold in release, and that their messages carry only the index.
Existing check: none. `transport_provider.rs:433-488` has three unit tests, all
about `GrantRecord`. Nothing tests the registry.
Impact: a duplicate identity would make `find` return an arbitrary sibling, and
a name outside the grammar would produce a response the peer's decoder rejects.
The asserts prevent both, but nothing tests them, and they are the only thing
standing between a provider bug and a corrupted wire response.
Open questions: None.

### prepare-dispatch-is-unbounded-work-on-the-read-loop

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `stalled_provider_prepare_fails_setup_within_the_deadline`
covers a stalled `prepare` but not a stalled dispatch.
Guarantee: Every step of a negotiation that runs on the connection read loop is
covered by the setup deadline.
Check: `always` — from the moment `grant_candidate` is entered, no synchronous
operation on the read loop can block longer than
`transport_setup_deadline`.
Fault/timing angle: this is the whole finding. `prepare_on_worker` is called
synchronously at connection.rs:1037; the deadline is constructed at
connection.rs:1022 but applied only at 1045, to the reply future. Inside
`prepare_on_worker`, the registry takes a `std::sync::Mutex` [transport_provider.rs:230]
and holds it across `std::thread::Builder::spawn` [233-250] and `try_send`
[261], releasing it only at function exit.
Required faults and enabling state: thread-creation pressure, so the lazy spawn
of `mc-host-provider-prepare` is slow or fails, concurrently with two or more
generations reaching `grant_candidate`. Under spawn failure the code is correct
(the reply sender drops, the caller fails closed [251-256]) but the *next*
caller retries the spawn while holding the lock, so slow spawns serialize across
connections.
Reachability evidence: `prepare_on_worker` is only reachable when the registry
is non-empty, which requires `with_injected`; see the reachability note on
`preflight-default-advertises-unvetted-offer-parameters`.
Confidence: medium — [evidence](evidence/prepare-dispatch-is-unbounded-work-on-the-read-loop.md).
Verified the lock scope, the call site, and the deadline placement. Did not
establish an upper bound on `Builder::spawn` latency under pressure, so the
severity is unproven. The `.expect("prepare worker lock")` at
transport_provider.rs:230 also panics on a poisoned lock, on the read loop;
poisoning looks unreachable because the critical section contains no panicking
operation, but that is an argument, not a proof.
Existing check: `tests/transport_negotiation.rs:982-1021` stalls `prepare`
itself, which is exactly the case the dedicated thread was built to contain.
Impact: a stall here delays the read loop before the deadline governs anything,
which is the same window the bootstrap-liveness handoff at
connection.rs:1023-1027 was moved to avoid.
Open questions:
- Can `std::thread::Builder::spawn` block, as opposed to fail fast, under
  `RLIMIT_NPROC` or cgroup pids pressure on the target platforms? (needs
  research)

### composite-route-entry-is-removed-by-exactly-one-route-gone

Type: safety
Reachability: default-production
Status: active
Exercised: partial — one rejected-bind case is covered; panic and
close-wins-bind are not.
Guarantee: Every route-map entry the composite inserts is removed exactly once,
so the map's size is bounded by the set of live plus closing routes.
Check: `always` — for every `RouteHandle` the composite inserts, the number of
removals is exactly one, and no removal precedes the owning child's `route_gone`
returning. Per-handle accounting is the primary oracle; total map size is a
cheap screen, since an insert and an unrelated remove cancel in the total.
Fault/timing angle: the removal is deliberately after the child callback
[composite.rs:297-303], so `handle` for a handle mid-`route_gone` still resolves
to the correct child [277-287]. That window is intentional and already covered.
Required faults and enabling state: the three non-success bind outcomes the
comment at composite.rs:262-265 names — a `BindOutcome::Reject`, a panicking
`bind`, and close-wins-bind — each of which must still produce exactly one
`route_gone`. The insert at composite.rs:266-269 happens before the `await` at
271-273, so a panicking `bind` leaves the entry behind and the host's route-gone
obligation is the only thing that reclaims it.
Confidence: high — [evidence](evidence/composite-route-entry-is-removed-by-exactly-one-route-gone.md).
Read the insert, the removal, and the unmapped arms of `handle` [282-285] and
`route_gone` [295]. The unmapped `route_gone` returns without touching the map,
so a spurious callback cannot remove another handle's entry.
Existing check: `tests/composite_routing.rs:485-531` pins exactly one
`route_gone` for a rejected bind;
`tests/composite_routing.rs:532-600` pins that a closed handle cannot dispatch
to stale child ownership.
Impact: a bind path that never yields `route_gone` leaks one map entry per
connection for the host's lifetime, and the leaked entry keeps routing a reused
handle to a stale child.
Open questions:
- Does the host guarantee `route_gone` after a panicking `bind`, or only after
  `Reject` and close? The comment claims all three; the runtime side is outside
  this lens. (needs verification in the runtime)

### composite-panic-containment-covers-only-optional-health-and-shutdown

Type: safety
Reachability: default-production
Status: active
Exercised: partial — both contained categories have dedicated tests; no test
pins that the other categories deliberately escalate.
Guarantee: A child panic is contained exactly where the composite can still
serve the host without that child, and escalates to the runtime's fatal cell
everywhere else; the set of contained call sites is closed.
Check: `always` — a panic in an optional child's `health` yields a `Failing`
report for that child and the primary's report still decides the aggregate; a
panic in any child's `shutdown` still drains every remaining child; and a panic
in any other child callback reaches the runtime.
Fault/timing angle: `catch_child_panic` wraps each individual poll
[composite.rs:160-171], so a child that panics after an `await` is still caught.
`shutdown` collects notes and re-raises one aggregate panic only after all three
drains [composite.rs:370-388], which is what keeps the instance fence held until
every child's background work has stopped.
Required faults and enabling state: a panicking child in each of the nine
uncontained positions listed in O17, plus the two contained ones. The primary's
`health` at composite.rs:312 is the one asymmetry a test should pin explicitly,
because the surrounding comment [306-311] only discusses optional children.
Confidence: high — [evidence](evidence/composite-panic-containment-covers-only-optional-health-and-shutdown.md).
Enumerated every child call in the file and checked each for a
`catch_child_panic` wrapper. This is deliberately a *containment* property and
does not restate part 2a's
`every-callback-invocation-is-inside-the-redaction-guard`, which is about the
redaction hook rather than about unwinding.
Existing check: `tests/composite_routing.rs:851-885` and `886-917` cover
shutdown panic and error; `tests/composite_routing.rs:986-1027` and `1028-1060`
cover optional-child health panics;
`tests/composite_routing.rs:918-985` covers the non-graceful incarnation.
Impact: adding a `catch_child_panic` to a callback the runtime treats as fatal
would silently convert a host-fatal invariant break into a degraded mode;
removing one from `shutdown` would release the instance fence with a child's
work still live.
Open questions: None.

### shutdown-error-formatting-defeats-its-own-redaction-contract

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — every test asserts the composite's redacted note; none
asserts the type's own formatting.
Guarantee: A component's `ShutdownError` detail never reaches a diagnostic
surface; only its byte length does.
Check: `always-or-unreached` — no formatting of a `ShutdownError` ever emits its
inner string. `always-or-unreached` because a correct host may never format one
at all, yet the type must be safe on the path where something does.
Fault/timing angle: none.
Required faults and enabling state: any `ShutdownError` carrying detail, plus one
consumer other than `shutdown_failure_note` that formats it. The composite's own
path is correct: it reports `err.0.len()` [composite.rs:182-185] and drops panic
payloads [186]. The type itself is the gap — `#[derive(Debug)]` on a `pub` tuple
struct with a `pub String` [composite.rs:31-32] plus a `Display` that prints the
inner string verbatim [34-38], re-exported at lib.rs:63-65, while the doc
comment invites components to "put real detail here without leaking it into host
logs" [composite.rs:28-30].
Confidence: medium — [evidence](evidence/shutdown-error-formatting-defeats-its-own-redaction-contract.md).
Verified the derive, the `Display`, the re-export, and every in-src construction
site: `broca/mod.rs:366-369` carries a run count and a fixed sentence, and
`synapse/mod.rs:1097-1104` never returns `Err`. So no shipped component puts a
secret there today, which is why this is medium and not high.
Existing check: `tests/composite_routing.rs:851-917` asserts the composite's
note is redacted. Nothing asserts `format!("{err}")` or `format!("{err:?}")` on
a `ShutdownError`.
Impact: the invitation in the doc comment is only true for the one consumer that
honours it. Any `#[derive(Debug)]` on a struct holding a `ShutdownError`, or any
`?`-based error chain, prints the detail in full.
Open questions:
- Should `ShutdownError` redact in its own `Debug` and `Display`, making the
  byte-length note the only rendering, or is the current split intentional?
  (needs human input)

## Contract-vs-code leads

- L1: **Malformed non-negotiation bodies can be misclassified as negotiation.**
  Contract: "Malformed JSON, duplicate recognized fields, ... receives terminal
  `invalid_control_request` for that correlation"
  [docs/mc-host-wire-protocol.md:334] and "host stays connected if framing
  remains valid" [docs/mc-host-wire-protocol.md:398]. Code:
  `is_negotiation_family` is a structure-blind byte scan [control.rs:118-128]
  consulted on the parse-failure branch [control.rs:200-202], so a body whose
  `op` is not `transport.negotiate` but which contains the literal
  `"transport.negotiate` anywhere is routed to `malformed_negotiation`
  [control.rs:176-178]; on a committed generation `handle_negotiate` then closes
  with no error frame [connection.rs:846-848]. See
  `negotiation-family-classifier-is-structure-blind`.
- L2: **The response decoder pins version 1, not the request's version.**
  Contract: "A response whose `negotiation_version` differs from the request's
  grammar version ... is malformed on the client side"
  [docs/mc-host-wire-protocol.md:608]. Code:
  `if version != NEGOTIATION_VERSION` [transport_negotiation.rs:576-581], with
  no access to the request's version. Coincides for v1 only.
- L3: **A dead rationale names a nonexistent fallback reason.** The code comment
  at transport_negotiation.rs:857-860 says echoing the request's version matters
  "for the `negotiation_version_mismatch` fallback: a peer speaking another
  version must be able to decode the response and retain TCP (R8)". Two problems.
  First, `negotiation_version_mismatch` is not in the closed vocabulary — §7.7.3
  lists only `unavailable` and `capability_version_mismatch`
  [docs/mc-host-wire-protocol.md:610-621], matching `FallbackReason`
  [transport_negotiation.rs:114-135]. Second, §7.7.3 states "Negotiation-version
  mismatch ... [is] not fallback evidence and MUST fail closed without
  same-generation TCP continuation" [docs/mc-host-wire-protocol.md:621], and the
  host implements exactly that by closing before it can respond
  [connection.rs:885-887]. The echoed-version parameter is therefore constant on
  every production path and its stated justification contradicts the contract.
- L4: **The preflight default contradicts §7.7.3's static-ineligibility rule.**
  Contract: "Permanent absence of a provider and statically ineligible offer
  parameters are NOT `unavailable`; they select TCP with no `reason`"
  [docs/mc-host-wire-protocol.md:616-617]. Code: the trait default returns
  `Serveable` and ignores `_parameters` [transport_provider.rs:116-120], so a
  provider that omits `preflight` sends every offer to `grant_candidate`, whose
  refusal path closes the generation [connection.rs:1045-1047] instead of
  selecting reasonless TCP. Reachable only through injection; see the record.
- L5: **"Closed field set" stops at the opaque boundary, as the contract
  intends, but the contract's wording is stronger than the code.** Contract:
  "every negotiation-family object has a closed field set and an unrecognized or
  repeated field is malformed" [docs/mc-host-wire-protocol.md:578]. Code:
  `check_closed_fields` is applied at four object positions only
  [transport_negotiation.rs:543, 493-497, 595-599, 570-573, 680-684, 733] and
  never inside `parameters` or `descriptor`. Duplicate-key rejection *is*
  recursive (via the parser), but the closed-field rule is not, and cannot be,
  since the opaque values have no schema. Recorded as a documentation precision
  issue rather than a defect.
- L6: **The offer-membership obligation has no encoder-side enforcement.**
  Contract: "The host MUST select exactly one offered `(transport,
  capability_version)` entry; it never invents a transport, version, or parameter
  shape" [docs/mc-host-wire-protocol.md:590]. Code:
  `encode_negotiate_response` receives no offer list
  [transport_negotiation.rs:861-865]. Enforced today only by
  `handle_negotiate`'s own checks [connection.rs:880-883, 917-920].

## Open questions

- What is the resolved `serde_json` version in the lockfile, and does its
  recursion limit apply to a custom `Visitor` reached through
  `deserialize_any`? The bound in B2 depends on it. (needs verification)
- Does `MatrixProvider` [tests/shm_transport.rs:521-558] override `preflight`?
  It affects whether the trait default has any coverage beyond `FakeProvider`.
- `HealthReport.detail` appears to be write-only on the host side: the composite
  sets it [composite.rs:313-317, 349-356] but grep finds no reader in
  `crates/mc-host/src`. If that is correct, the "`{id}` health check panicked"
  string never reaches an operator, and `tests/composite_routing.rs:986-1060`
  can only assert status. Worth a separate reachability record if a synthesis
  agent wants it; it is not a redaction leak.
- Is the double parse of every negotiation body [control.rs:197 then 238-240]
  intended, or an artifact of keeping the codec a leaf module with a
  `&[u8]` interface? Correctness is unaffected while both use
  `strict_json::parse`, but it doubles the parse cost on the read loop and
  creates a drift surface between classification and decode. (needs human input)
- Does the host guarantee exactly one `route_gone` after a panicking `bind`?
  The composite's comment [composite.rs:262-265] asserts it; the runtime side is
  outside this lens.
