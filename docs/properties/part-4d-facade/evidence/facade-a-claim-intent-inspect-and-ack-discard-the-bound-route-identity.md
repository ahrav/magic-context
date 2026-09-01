# facade-a-claim-intent-inspect-and-ack-discard-the-bound-route-identity

## Discovery trigger

The task handed me the claim intent ledger at `lib.rs:10082-10182` with Part 3's
store-side findings and asked who uses it, what the digest conflict check does,
and whether the identity mismatch defect is reachable from the facade. Reading
the four handlers as a group showed that the doc comment above them states a
guarantee that three of the four do not implement.

## Evidence trail

### The stated contract

`crates/mc-module/src/lib.rs:10062-10067`

    /// Resolve the daemon-bound route root for a claim facade request.
    ///
    /// Every claim handler must go through this. The claim wire carries
    /// caller-supplied identity (`binding.authorityProject`,
    /// `binding.databaseIncarnationId`), so the bound route is the only
    /// trustworthy authority identity on the request.

`claim_route_root` itself (`:10068-10080`) returns
`binding.project_root.to_string_lossy().into_owned()` on success and a
`route_unbound` error otherwise.

### What each handler does with it

- `handle_claim_intent_stage` (`:10082-10113`). `:10083-10086` binds
  `route_root`, and `:10100` passes it as the first argument to
  `memory_tool::stage_claim_intent`. This handler honours the contract.
- `handle_claim_intent_inspect` (`:10115-10151`). `:10120-10122`:

      if let Err(outcome) = self.claim_route_root(channel, "claim.intent.inspect") {
          return outcome;
      }

  The `Ok` value is dropped. `:10138` calls
  `memory_tool::inspect_claim_intents(&store, &parsed)` with no route argument.
- `handle_claim_intent_ack` (`:10153-10182`). `:10154-10156` is the same pattern,
  and `:10169` calls
  `memory_tool::acknowledge_claim_intent(&store, &parsed, now_ms())`.
- `handle_claim_effects_apply` (`:10184-10255`). Same pattern at `:10185-10187`.

`memory_tool.rs` confirms the signatures cannot carry a route even if a caller
wanted to: `stage_claim_intent` takes `route_project_root: &str`
(`memory_tool.rs:109-114`), while `inspect_claim_intents`
(`:136-139`) and `acknowledge_claim_intent` (`:161-165`) do not.

### What the store checks instead

- `mc-store/src/lib.rs:11121-11138` — `inspect_claim_intent` selects by
  `producer` and `operation_key` only.
- `:11140-11158` — `list_claim_intents(unresolved_only, limit)`. The SQL has no
  project, producer, or route predicate: the only `WHERE` is the optional
  `state IN ('staged', 'context-committed')`. `ORDER BY created_at_ms, producer,
  operation_key LIMIT ?1`.
- `memory_tool.rs:140-145` — the module's only bound on that read is
  `1 <= limit <= 10_000`.
- `memory_tool.rs:99-107` — `intent_wire_record` returns `binding`, `command`,
  `request_digest`, `state`, and `result_json` for every row.
- `:11165-11288` — `acknowledge_claim_intent`. Its identity checks are the
  digest comparison (`:11209-11211`) and `require_claim_intent_binding`
  (`:11212-11226`, function at `:3851-3885`), which compares the REQUEST's
  binding against the STORED row's binding on four fields. That answers "does
  this request agree with what was written", never "is this caller entitled to
  this row".
- By contrast `stage_claim_intent` calls `claim_intent_stage_fence`
  (`:11072`, `:11084`; function at `:4048-4090`), which resolves the authority
  from the bound route (`:4064-4072`, `authority_for_route_tx` at
  `:4092-4116`) and rejects a binding naming another project
  (`:4074-4081`) or another generation (`:4082-4088`). The comment at
  `:4062-4065` states the reason: `mc_authority` is keyed by
  `context_store_uuid`, which "the host mints independently of the format
  marker's `database_incarnation_id`", so keying the lookup by the binding
  identity "matches no row and fails open".

So the route-scoped fence exists and is used by exactly one of the four
handlers.

### Who calls these on the facade in production

- `packages/plugin/src/hooks/magic-context/module-wire.ts:602-623` builds
  `{name, arguments}` bodies for `claim.intent.stage`, `claim.intent.inspect`,
  `claim.intent.ack`, and `claim.effects.apply`. So these are facade-envelope
  commands, routed at `lib.rs:10048-10051`.
- `module-transport.ts:1026-1087` sends them.
- `hook.ts:938-990` wires `commitModuleClaimIntent` with all four.

Reachability class: default-production. No feature flag, no config gate. The
handlers need only a bound facade route (`:10120`, `:10154`) and an open store
(`:10135`, `:10166`).

### Coverage

Grepping `lib.rs:16001-30517` for `claim_intent` and `claim_effects` returns
nothing. The four handlers have zero module-side test coverage. The store side is
covered by `crates/mc-store/tests/claim_intent_ledger.rs`, which
`.github/workflows/ci.yml:171-172` does not run.

## Failure scenario

Two routes are bound in one module process, A to `/repo/alpha` and B to
`/repo/beta`, each authority-managed for a different project. This is ordinary:
`hook.ts` registers bridges per resolved project and the comment at
`hook.ts:996-1000` says sessions can resolve projects other than the plugin's
launch directory.

1. Route B calls `claim.intent.inspect` with `unresolvedOnly: false` and
   `limit: 10000`. `list_claim_intents` returns every intent row in the store,
   including route A's, each carrying its `binding`, `command`,
   `request_digest`, and `result_json`.
2. Route B now holds a valid `(producer, operation_key)`, the exact
   `request_digest`, and the exact binding for one of route A's staged intents.
3. Route B calls `claim.intent.ack` with those values and
   `kind: ContextCommitted`. The digest matches (`:11209`),
   `require_claim_intent_binding` passes because route B echoed the stored
   binding (`:11212-11226`), and the transition from `Staged` to
   `ContextCommitted` is legal (`:11225-11227`). The row is updated
   (`:11248-11262`).
4. Route A's producer later acks its own intent and gets a `Transition` error
   because the state is no longer `staged`, or, worse, believes its context
   mutation was recorded when it was another route that recorded it.

The read alone is the more certain harm: `result_json` is the claim operation's
result, and the ledger is durable past terminal state and never pruned
(Part 3's lens B records that no delete statement exists for `mc_claim_intents`;
`part-3-store-core/_lenses/lens-b-claim-mirror-ledger.md:293`). So
`claim.intent.inspect` is a permanent cross-project read from any bound facade
route.

## Timing windows and dependencies

No interleaving needed for the read. The ack needs the target row to still be in
a non-terminal state, so the window is between another route's `stage` and its
own `ack`. That window is exactly the "context mutation in progress" interval the
ledger exists to represent, so it is not narrow.

Dependency: two bound routes with different authority projects in one process. A
single-project deployment cannot reach the cross-route case, but the unbounded
read is reachable with one route as soon as the store holds intents from a
previous project binding, because the ledger is never pruned.

## What a test must construct

1. Two `RouteHandle`s bound to different project roots, both authority-managed,
   in one `McHandler`. `handler_with_store_and_resolver` plus two `bind_route`
   calls; `lib.rs:18502` shows `call_facade_on_channel` already exists for
   per-channel facade calls.
2. Stage an intent from route A with a distinctive `result_json` after acking it.
3. From route B, call `claim.intent.inspect` and assert route A's intent is NOT
   in the response.
4. From route B, call `claim.intent.ack` with route A's `command`,
   `request_digest`, and `binding`, and assert the outcome is an error, not a
   transition. Then assert the row's state is unchanged by reading it back from
   the store directly.
5. Positive control: route A performing the same ack must succeed, proving the
   test's ack arguments are otherwise valid and that step 4 failed for the right
   reason.
6. The read case needs no second route: seed two intents under different
   `authority_project` bindings, bind one route, and assert `inspect` returns only
   the one matching the route's authority project.

## Investigation log

### Q: Is the ledger identity mismatch defect Part 3 found reachable from the facade?

- Sources examined: Part 3's record
  (`part-3-store-core/_lenses/lens-b-claim-mirror-ledger.md:176-209`,
  `:415-426`); `mc-store/src/lib.rs:4118-4126`,
  `set_claim_intent_transition_tx`, which returns `Ok(())` without writing when
  `!is_lower_hex(database_incarnation_id, 32)`; a search of `crates/mc-store` for
  its four callers; `lib.rs:10082-10255`, the four facade claim handlers;
  `lib.rs:12254-12267`, the router's `authority.*` arms;
  `packages/plugin/src/features/magic-context/context-authority.ts:829-1072`.
- Findings: the defect lives in the transition-control row
  (`mc_claim_intent_controls`), not in `mc_claim_intents`. Its four callers are
  `authority_begin_prepare`, `authority_finish_prepare`, and two
  `authority_begin_drain` arms, all inside `mc-store`. Those are reached from the
  module through `handle_authority_prepare_value` (`lib.rs:12255`) and
  `handle_authority_drain_value` (`:12257-12267`), which are FLAT `method` bodies,
  not `{name, arguments}` facade envelopes. No handler routed by
  `handle_facade_value` (`:10042-10060`) reaches
  `set_claim_intent_transition_tx`. The shipped plugin drives the flat surface
  from `context-authority.ts:829` (prepare) and `:983-1072` (drain).
- Missing evidence: none for the routing question.
- Conclusion: resolved. The identity mismatch defect is NOT reachable from the
  MCP facade surface. It is reachable from the module's single request entry
  point (`lib.rs:11963`) through the flat `authority.*` method surface, which the
  shipped plugin drives in default production. The ledger's own stage fence
  survives the defect for the reason Part 3 gave: `claim_intent_stage_fence`
  resolves the live authority from `mc_authority_route_bindings`
  (`mc-store/src/lib.rs:4064-4072`) and treats an absent control row as
  `accepting` (`:4053-4061`), so a control row that was never written does not
  block staging. The consequence stays where Part 3 put it, on the mirror's
  control-row readers.

### Q: Is the ack's reliance on the stored binding intended as sufficient?

- Sources examined: `mc-store/src/lib.rs:3851-3885`, the four compared fields;
  `:11209-11211`, the digest check; `:4048-4090`, the fence that stage uses and
  ack does not; `lib.rs:10062-10067`, the doc comment; `memory_tool.rs:161-180`,
  which shows the module never had a route to pass.
- Findings: the ack's checks establish that the caller knows the stored row's
  binding and its 64-hex request digest. `claim.intent.inspect` hands both to any
  bound facade route in the same store, so knowledge of them is not evidence of
  entitlement. The stage path's fence comment (`:4062-4065`) shows the authors
  reasoned carefully about route-versus-binding identity for stage; nothing
  analogous appears for ack or inspect.
- Missing evidence: whether ack is considered a trusted-caller operation because
  only the plugin's own commit path issues it. That would be a deployment
  assumption, and the doc comment at `:10062-10067` explicitly rejects trusting
  request-carried identity, which cuts against it.
- Conclusion: needs human input. Either the doc comment's guarantee is wrong for
  three of four handlers, or the route root must be threaded into
  `inspect_claim_intents` and `acknowledge_claim_intent` and enforced the way
  `claim_intent_stage_fence` enforces it for stage. Choosing is a design
  decision with a signature change on both sides.
