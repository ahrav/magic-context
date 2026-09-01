# note-b-registered-policy-version-never-reaches-selection

## Discovery trigger

`note_evaluation_body`'s allow list for `register` includes `policy_version`
(`crates/mc-module/src/lib.rs:10891`), and the closed schema rejects any key
outside it (`:13894-13900`), so `policy_version` is a required part of the
registration contract. The handler validates it with a range check. I traced the
value to see what behaviour it selects and found no consumer.

## Evidence trail

1. It is validated as a non-negative integer:

   ```
   let policy_version = match note_evaluation_i64_field(body, "policy_version") {
       Ok(value) if value >= 0 => value,
       Ok(_) => return note_evaluation_bad_request("'policy_version' must be >= 0"),
       Err(outcome) => return outcome,
   };
   ```
   (`lib.rs:10915-10919`)

2. It is stored on the registration entry (`:10964`), in a field declared at
   `:2983`.

3. Every remaining reference in the protocol range is a write or an echo. A grep
   for `policy_version` over `lib.rs:10880-11500` returns exactly six hits: the
   allow-list string (`:10891`), the validation (`:10916`), the error message
   (`:10918`), the struct field initialization (`:10964`), an increment
   (`:11045`), and a response field (`:11050`). No read feeds a decision.

4. The increment at `:11045` is in the heartbeat, and it overwrites the caller's
   registered value:

   ```
   if policy_changed {
       entry.policy_version += 1;
   }
   ```
   where `policy_changed` is set when a heartbeat changes `retina_handoff` or
   `wake_owned` (`:11036-11044`). So the number the caller registered does not
   even survive a policy-changing heartbeat, and the value echoed at `:11050` is
   the module's own counter rather than the caller's declaration.

5. Selection compares a *different* `policy_version`: the note's, against a
   compile-time constant. Three predicates read it:

   ```
   && note.policy_version == SMART_NOTE_CHECK_POLICY_VERSION
   ```
   in the due selector (`crates/mc-module/src/smart_note_evaluation.rs:723`) and
   the liveness selector (`:773`), and

   ```
   || note.policy_version != SMART_NOTE_CHECK_POLICY_VERSION
   ```
   in the compile selector (`:749`), which is how an off-policy note gets
   recompiled.

   `SMART_NOTE_CHECK_POLICY_VERSION` is `1` (`:16`, doc comment
   "Compiled-check policy version; other versions force recompilation").

6. The note's `policy_version` comes from the note row, defaulted to `0` when NULL
   (`lib.rs:13983`), and is written by the reducer:
   `stored.policy_version = SMART_NOTE_CHECK_POLICY_VERSION` on a successful
   compile (`smart_note_evaluation.rs:493`). So the whole policy-version mechanism
   is module-internal: the module stamps its own constant on notes it compiles and
   recompiles notes stamped with anything else.

7. There is therefore no evaluator-side half to the mechanism. An evaluator running
   an older compiled-check policy, whose sandbox semantics differ from what the
   module's constant `1` denotes, registers successfully and is offered every note.
   The module has no way to refuse it, and the note it compiles is stamped `1`
   regardless of what the evaluator actually did.

8. `SMART_NOTE_CHECK_POLICY_VERSION` is also asserted equal to the frozen
   fixture's `constants.policy_version` (`smart_note_evaluation.rs:1111`, fixture
   value `1`), so the constant is a cross-language contract. The registration
   field is not part of that contract, which is consistent with it being unused.

## Failure scenario

The compiled-check policy changes: version 2 restricts the sandbox capability set,
say by removing `httpGet`, which `docs/AUDIT-KNOWN-ISSUES.md:823-830` (A50)
records as a live capability with an accepted v1 egress risk. The module's
constant becomes `2`, so every note compiled under version 1 is recompiled
(`smart_note_evaluation.rs:749`). That half works.

An older evaluator, still running the version-1 sandbox, registers with
`policy_version: 1`. The module accepts it (`lib.rs:10915-10919`), stores the `1`,
and offers it the recompilation work. The evaluator compiles the condition under
version-1 semantics, returns an artifact, and
`reduce_compile` stamps `stored.policy_version = SMART_NOTE_CHECK_POLICY_VERSION`,
which is now `2` (`smart_note_evaluation.rs:493`).

The note is now marked as compiled under policy 2 while its artifact was produced
under policy 1. The selectors will never recompile it, because `note.policy_version
== SMART_NOTE_CHECK_POLICY_VERSION` now holds. The version-1 artifact is
permanently accepted as version-2 compliant, and the field that could have refused
the registration was validated and discarded.

The registration's own echo makes this worse for a client trying to detect it: the
`policy_version` in the register response (`:11050`) is the caller's own value
played back, so a client cannot learn the module's policy version from the
handshake. It looks like agreement and carries no information.

## Timing windows and dependencies

No interleaving. The dependency is a policy-version bump plus a version-skewed
evaluator, which is exactly the deployment shape a version field exists to handle.
Today, with `SMART_NOTE_CHECK_POLICY_VERSION` at `1` and no version 2 in
existence, the scenario is not currently constructible in the field; the field is
inert now and the mechanism it appears to provide would be absent when first
needed.

## What a test must construct

The immediate assertion is about the current inertness, which is what makes it
implementable today:

1. Construct an `McHandler`, bind two routes to the same authority project.
2. `note.evaluation.register` on route 1 with `policy_version: 0` and on route 2
   with `policy_version: 99`.
3. Insert several smart notes spanning `policy_version` `0` and `1` in their own
   rows.
4. Call `note.evaluation.next` on each route with a fresh `acquisition_id`.
5. Assert the offered note sets are identical, and that this equality is the
   documented contract.

Step 5 is the honest form of the check: the assertion passes, and its value is
that it *pins* the current semantics so a future change that starts consuming the
field cannot land silently. Written the other way, asserting the field has an
effect, the test would fail today and encode a behaviour nobody has designed.

A companion assertion covers the echo: register with `policy_version: 7`, send a
heartbeat that flips `retina_handoff`, and assert the response's
`policy_version` still equals `7`. It will be `8` (`:11045`), which documents that
the echoed field is a module counter and not the caller's declaration.

## Investigation log

### Q: Is `policy_version` reserved for future negotiation, or vestigial?

- Sources examined: the register allow list (`lib.rs:10884-10896`), the
  validation (`:10915-10919`), the struct field (`:2983`), the heartbeat increment
  (`:11036-11045`), the register and heartbeat response bodies (`:10970-10977`,
  `:11047-11051`), all three note-side predicates
  (`smart_note_evaluation.rs:723`, `:749`, `:773`), the constant and its doc
  comment (`:15-16`), the fixture assertion (`:1111`), the retired
  `note.evaluate` error (`lib.rs:12281`, `:13860-13863`), and
  `NOTE_EVALUATOR_PROTOCOL_VERSION` for contrast (`:2964`).
- Findings: two readings, and the code supports the first more strongly.
  First, the field is a *client-declared* policy version that a future module will
  compare against its own constant to refuse a skewed evaluator. Evidence for: the
  name matches the note-side field exactly, the range check is deliberate rather
  than incidental, and the protocol has a working precedent for refusal in
  `protocol_version`, which *is* compared and *does* refuse
  (`:10907-10914`, returning `protocol_unsupported`). The existence of a
  correctly-implemented sibling check right next to an unimplemented one is the
  strongest single piece of evidence that the check was intended.
  Second, it is vestigial from the retired `note.evaluate` protocol. Evidence
  against this reading: the retired path is a one-line error at `:13860-13863`
  with no surviving fields, so nothing suggests field inheritance.
- Missing evidence: the evaluator worker's register payload, which would show
  whether the client sends a meaningful value or a hardcoded constant. If the
  client hardcodes `1`, that is consistent with an unimplemented check that
  nobody has needed yet. `evaluator-worker.ts:193` issues the register call and I
  did not read its body.
- Conclusion: needs human input on whether to implement the comparison, but the
  reading is fairly clear: the adjacent `protocol_version` check shows the pattern
  the author used when a version must be enforced, and `policy_version` does not
  follow it. Reading `evaluator-worker.ts:193` is the cheap next step and would
  strengthen or weaken the "intended check" reading without settling the design
  question.

### Q: Does the heartbeat increment break anything today?

- Sources examined: `:11036-11045`, `:11047-11051`, and every read of
  `entry.policy_version`.
- Findings: no, because nothing reads it. The increment is visible only in the
  heartbeat response. It looks like it was meant to let a client detect that its
  policy view is stale, which would be a sensible use, but a client cannot act on
  it because the number is not compared to anything on either side.
- Missing evidence: none.
- Conclusion: resolved with answer. Harmless today, and it is a second signal that
  the field was designed for a role it never received.
