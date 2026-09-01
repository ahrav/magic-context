# facade-a-transform-class-byte-cap-probe-diverges-from-the-router

## Discovery trigger

Sub-part 4d's first attention focus asks whether the request caps are applied
before allocation. They are. Reading `enforce_request_byte_cap` to confirm that
turned up a different problem: the function decides which of two ceilings to
apply by sniffing fields that the router does not read the same way.

## Evidence trail

`crates/mc-module/src/lib.rs`

- `:11963-11966` — `CompositeComponent::handle` calls
  `enforce_request_byte_cap(ctx.body.as_slice())` first, before any parse. So
  the cap decision is made on raw bytes, which is the point of the probe.
- `:14279` — `MAX_FACADE_FRAME_BYTES: usize = 1024 * 1024`.
- `:14284` — `MAX_TRANSFORM_FRAME_BYTES: usize = 32 * 1024 * 1024`.
- `:14286-14295` — `RequestMethodProbe` deserializes only `method` and `kind`,
  both `Option<String>` with `#[serde(default)]`. Its doc comment says the probe
  exists so the module does not have to build a full `Value` "just to reject
  it".
- `:14297-14305` — `is_transform_class`:

      named(&self.kind, "transform")
          || named(&self.method, "state_sync")

  `kind` is consulted for the transform name, `method` for the state-sync name.
  Neither name is checked against both fields.
- `:14375-14391` — `enforce_request_byte_cap`. Under 1 MiB: `Ok(())`. Over
  1 MiB and transform-class: `Ok(())` up to 32 MiB, then
  "request body exceeds the 32 MiB transform limit". Over 1 MiB and not
  transform-class: "request body exceeds the 1 MiB limit".
- `:12245-12248` — the router reads
  `request.get("method")...or_else(|| request.get("kind")...)`. One resolved
  string, either field, for every arm including `"transform"` (`:12274`) and
  `"state_sync"` (`:12278`).

Shipped senders:

- `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:1336-1337`
  sets both `method: "transform"` and `kind: "transform"` on the same body, so
  the probe's `kind` check succeeds in production.
- `packages/plugin/src/hooks/magic-context/module-state-sync.ts:1167` sets only
  `method: "state_sync"`, which is exactly the field the probe checks for that
  name.

So the two field choices in `is_transform_class` mirror the two shipped senders
rather than the router's rule. Callers that do not match those senders exist in
the tree already:

- `packages/plugin/src/hooks/magic-context/module-wire.test.ts:438` and `:450`
  send `method: "transform"` with no `kind`.
- `crates/mc-module/tests/direct_host.rs:110` and `:173` send
  `"kind": "transform"` with no `method`.

## Failure scenario

A harness integration, a probe script, or a future sender emits a 4 MiB
transform body carrying `method: "transform"` and no `kind`. The body is a
legitimate transform request: the router at `:12245-12248` would dispatch it to
`handle_transform_dispatch`. The probe at `:14298-14304` does not recognise it,
so `enforce_request_byte_cap` refuses it with
`invalid_params` and the message "request body exceeds the 1 MiB limit". The
caller is told about a limit that does not apply to the request it sent, and the
message names no field, so the caller has nothing to act on. The symmetric case
is a `kind: "state_sync"` body over 1 MiB, refused the same way, and
`module-state-sync.ts:78` notes the state-sync ceiling is a real operational
concern ("Ceiling for a single live (non-seed) state_sync body").

The inverse direction is the more serious one and is not currently possible: for
the probe to over-admit, a non-transform request would have to carry
`kind: "transform"` or `method: "state_sync"`, which would also make the router
dispatch it to that lane. So the divergence today is over-refusal, not
over-admission.

## Timing windows and dependencies

None. The probe and the router both read the same immutable body. There is no
interleaving, no clock, and no store.

The dependency that keeps this latent is entirely outside the crate: it is the
shipped TypeScript sender setting both fields. Nothing in the Rust code
enforces or documents that requirement.

## What a test must construct

1. A body over `MAX_FACADE_FRAME_BYTES` and under `MAX_TRANSFORM_FRAME_BYTES`
   carrying `method: "transform"` and no `kind`, padded with a large string so
   the byte length is real.
2. Assert `enforce_request_byte_cap` returns `Ok(())`, on the ground that the
   router would route the same body to the transform lane.
3. The mirror case: `kind: "state_sync"` with no `method`.
4. A negative control: a 4 MiB body with neither field, which must still be
   refused with the 1 MiB message.
5. A property form is better than three cases. For an arbitrary body over
   1 MiB, assert
   `enforce_request_byte_cap(body).is_ok() == router_selects_transform_lane(body)`,
   where the second side is computed by the same `method`-then-`kind` fallback
   the router uses. That form fires on any future name added to one side only.

The test needs no store, no route binding, and no async runtime:
`enforce_request_byte_cap` is a free function over `&[u8]`.

## Investigation log

### Q: Is the field split deliberate, or an artifact of two senders written at different times?

- Sources examined: `lib.rs:14286-14305` including the probe's doc comment;
  `lib.rs:14307-14310`, the comment above `VALUE_NODE_SLACK`, which explains the
  wider cap's rationale ("transform-class requests legitimately carry a
  session's full message array"); the `is_transform_class` comment at
  `:14301-14303`, which explains only why `state_sync` gets the wide ceiling,
  not why it is matched on `method` while `transform` is matched on `kind`;
  every shipped sender found by searching `packages/` for both field names.
- Findings: the comment at `:14301-14303` says "A single state-sync row can
  exceed the facade cap, so this live module path uses the transform-class
  ceiling as well." It justifies the ceiling, never the field. No comment
  anywhere states that a transform body must carry `kind` or that a state-sync
  body must carry `method`. The router's own fallback (`:12245-12248`) is the
  only statement of how the discriminator is read, and it is field-agnostic.
- Missing evidence: any design note, schema, or wire document declaring the
  required discriminator field per command. The scope map established that no
  transform specification exists outside the source
  (`part-4-module/_lenses/scope-map-and-risk-ranking.md:685-700`).
- Conclusion: needs human input. Either the probe should use the router's
  fallback for both names, or the wire contract should state which field each
  command requires and the router should stop accepting the other. Choosing
  between those is a design decision.
