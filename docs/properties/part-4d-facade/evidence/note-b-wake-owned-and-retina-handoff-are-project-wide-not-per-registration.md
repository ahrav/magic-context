# note-b-wake-owned-and-retina-handoff-are-project-wide-not-per-registration

## Discovery trigger

`NoteEvaluatorRegistration` stores `retina_handoff` and `wake_owned` per entry
(`crates/mc-module/src/lib.rs:2985-2986`), and
`validated_note_evaluator_registration` returns a clone of the calling
registration (`:3938-3966`), so `handle_note_evaluation_next` holds the caller's
own policy in hand. It then ignores it and reads a project-wide aggregate
instead.

## Evidence trail

1. The aggregate accumulates with `|=` over every live entry:

   ```
   fn live_note_evaluator_policy(&self, project: &str, now: i64) -> (bool, bool) {
       let registrations = self.note_evaluator_registrations.lock()...;
       let live = registrations
           .get(project)
           .into_iter()
           .flatten()
           .filter(|entry| entry.expires_at > now);
       let mut retina_handoff = false;
       let mut wake_owned = false;
       for entry in live {
           retina_handoff |= entry.retina_handoff;
           wake_owned |= entry.wake_owned;
       }
       (retina_handoff, wake_owned)
   }
   ```
   (`lib.rs:3888-3906`)

   Its doc comment is accurate and states the semantics plainly: "Returns whether
   any live registration for `project` sets each policy" (`:3887`).

2. `handle_note_evaluation_next` takes both from that aggregate, immediately after
   obtaining the caller's own registration:

   ```
   let (retina_handoff, wake_owned) = self.live_note_evaluator_policy(&project, now);
   ```
   (`:11166`)

   The registration obtained at `:11147-11159` is used for `capacity`
   (`:11162`) and for `slot_cycles` (`:11181`), and its `retina_handoff` and
   `wake_owned` fields are read nowhere in the function.

3. `wake_owned` is a hard veto that returns before the store is touched:

   ```
   if wake_owned {
       // The wake flag can flip before the next poll, so this veto skips
       // the store and leaves no replayable acquisition decision behind.
       return respond(json!({ "result": "no_work", "wake_owned": true }));
   }
   ```
   (`:11166-11172`)

4. `retina_handoff` flows into the selector's eligibility predicate:

   ```
   fn eligible(note: &SmartNoteSelectionSnapshot, retina_handoff: bool) -> bool {
       note.status == "pending"
           && (!retina_handoff || note.compile_status.as_deref() != Some("compiled"))
   }
   ```
   (`crates/mc-module/src/smart_note_evaluation.rs:704-707`)

   It is passed to `select_smart_note_evaluation_cycle` at `lib.rs:11208` and to
   the `cycle_exhausted` re-run at `:11223`, so it changes both the selection and
   the classification of an empty answer.

5. Multiple live registrations per project are a designed state, not an anomaly.
   Registrations are stored as a `Vec` per project
   (`:10945-10947` obtains `registrations.entry(project).or_default()`), the
   deduplication on re-register is keyed on `(evaluator_instance, route)` and
   removes only that pair (`:10948-10950`), and the count is capped at 32 rather
   than 1 (`NOTE_EVALUATOR_MAX_REGISTRATIONS`, `:2969`, enforced at
   `:10951-10956`).

6. The plugin anticipates two bridges over one project identity. The hook comment
   says: "Keyed by identity AND root: two worktrees of one repository share a
   project identity, and discarding the second bridge would evaluate its
   file-dependent conditions against the first checkout"
   (`packages/plugin/src/hooks/magic-context/hook.ts:1030-1033`). And it
   anticipates two plugin instances sharing one bridge: "Another plugin instance
   already registered this exact bridge" (`:1036-1039`). So two live registrations
   for one authority project is expected.

7. The shipped bridge sets `wakeOwned: false` and derives `retinaHandoff` from
   config: `{ retinaHandoff: deps.config.smart_notes?.retina_handoff === true,
   wakeOwned: false }` (`hook.ts:1110-1113`). `retina_handoff` defaults to
   `false` in the schema (`packages/plugin/src/config/schema/magic-context.ts:711-715`).
   So in the default shipped configuration both flags are `false` for every
   registration and the OR is a no-op. That is why this is a latent coupling
   rather than a live defect, and it is also why a test would never notice it by
   accident.

8. `wake_owned` can also be flipped after registration, by heartbeat:
   `entry.wake_owned = wake_owned` when the optional field is present
   (`:11041-11044`), which also bumps `entry.policy_version` (`:11045`). So a
   single heartbeat from one evaluator can begin vetoing every other evaluator's
   polls.

## Failure scenario

Two worktrees of one repository are open, each with a plugin instance, so two
bridges register against the same authority project from two different routes.
Worktree A's config sets `smart_notes.retina_handoff = true`; worktree B's does
not.

1. Both register. The project's `Vec` holds two live entries with
   `retina_handoff` `true` and `false`.
2. Worktree B polls `note.evaluation.next`. `live_note_evaluator_policy` ORs to
   `true`.
3. `eligible` now excludes every note whose `compile_status` is already
   `"compiled"` (`smart_note_evaluation.rs:706`), which is the retina-handoff
   contract: skip notes another pipeline already compiled.
4. Worktree B, which never opted into a retina handoff and has no retina pipeline,
   silently stops being offered those notes. They are not evaluated by B and, if
   A's retina pipeline is not actually running, not by anyone.

The `wake_owned` version is sharper because it is total. One evaluator that
heartbeats `wake_owned: true` causes every `note.evaluation.next` for the project,
from every registration and every slot, to return `no_work` (`lib.rs:11166-11172`).
Evaluation for that project halts. The response does carry `wake_owned: true`, so a
client that inspects it can tell why its own poll was vetoed, but it cannot tell
that the flag came from someone else, and nothing else records it: there is no log
or metric on this path.

## Timing windows and dependencies

No interleaving required for the steady-state version: two live registrations with
differing flags is enough. The heartbeat-driven version has a window, since
`wake_owned` can flip between polls, and the comment at `:11167-11168`
acknowledges exactly that ("The wake flag can flip before the next poll").

Registration liveness is 120 seconds (`NOTE_EVALUATOR_LEASE_MS`, `:2962`) with a
60-second heartbeat (`:2963`), so a stale registration self-clears within two
minutes through `purge_expired_note_evaluator_registrations` (`:3858-3867`),
which is called at the top of register, heartbeat, and
`validated_note_evaluator_registration` (`:10938`, `:11012`, `:3939`). That bounds
how long an abandoned registration's flags can affect others.

## What a test must construct

Entirely within the module, no plugin needed:

1. Construct an `McHandler`, bind two routes to project roots that resolve to the
   same authority project.
2. `note.evaluation.register` on route 1 with `retina_handoff: true`, and on
   route 2 with `retina_handoff: false`. Both must succeed; the registry allows up
   to 32 entries per project.
3. Insert two smart notes, one with `compile_status = "compiled"`.
4. `note.evaluation.next` on route 2.
5. Assert the compiled-`compile_status` note can still be claimed by route 2,
   which is what route 2's own `retina_handoff: false` asked for. It cannot.

The `wake_owned` form is shorter: register two evaluators, heartbeat one with
`wake_owned: true`, then assert the other's `next` still returns work. It will
return `{"result":"no_work","wake_owned":true}`.

The existing protocol tests all register a single evaluator (the inline tests at
`lib.rs:23047`, `:23310` register once each), so nothing today constructs the
two-registration state.

## Investigation log

### Q: Is the project-wide OR the intended semantics?

- Sources examined: `live_note_evaluator_policy` and its doc comment
  (`lib.rs:3887-3906`), the registration struct's doc comment (`:2974-2976`), the
  `wake_owned` veto comment (`:11167-11168`), the registrations-per-project `Vec`
  and its cap (`:2967-2969`, `:10945-10956`), the plugin's two-worktree and
  two-instance comments (`hook.ts:1030-1039`), and the file list of
  `packages/plugin/src/features/magic-context/smart-notes/`, which includes
  `wake-plane.ts` and `wake-plane.test.ts`.
- Findings: the existence of a file called `wake-plane.ts` is meaningful evidence
  that `wake_owned` describes a *plane*, that is, a project-level or
  system-level ownership of the wake decision, rather than one evaluator's
  preference. Under that reading the project-wide OR is exactly right for
  `wake_owned`: if anything owns the wake plane for this project, no poller should
  independently acquire. `retina_handoff` reads differently. It is a per-pipeline
  handoff (skip what my retina already compiled), and ORing it across
  registrations makes one evaluator's pipeline shape narrow another's work set,
  which has no equivalent justification. So the two flags plausibly want different
  scoping and share one accumulator.
- Missing evidence: `wake-plane.ts`, which would settle the `wake_owned` half
  outright. The registration struct's doc comment (`:2974-2976`) scopes the
  *project* to the route and is silent on policy scope, so it does not help.
- Conclusion: needs human input, and the input is cheap to obtain: reading
  `wake-plane.ts` likely resolves `wake_owned` as correct-by-design and leaves
  `retina_handoff` as the real finding. I am recording both together because they
  share one function and one call site, and a fix to one has to decide about the
  other.

### Q: Does the same aggregation affect any other handler?

- Sources examined: every call site of `live_note_evaluator_policy` (one, at
  `lib.rs:11166`) and of `has_live_note_evaluator` (`:11618` in the `ctx_note`
  write path, `:11828` in the update path).
- Findings: no. `has_live_note_evaluator` (`:3880-3886`) is a pure existence
  check over live entries and does not read policy at all, which is correct for
  its purpose: the conditioned-write gate only needs to know that *somebody* will
  evaluate. So the aggregation affects exactly one handler.
- Missing evidence: none.
- Conclusion: resolved with answer. Blast radius is `handle_note_evaluation_next`
  only.
