# rt-a-reserved-pools-are-zero-permit-and-unentered-without-a-declaration

## Discovery trigger

Cataloguing which `HostShared` fields are built conditionally. These two are
built unconditionally but can hold zero permits, which is a third state the
conditionality map needs: constructed, present, and unusable.

## Evidence trail

The construction, `runtime.rs:911-912`:

```
reserved_pending_permits: Arc::new(Semaphore::new(reservations.pending)),
reserved_task_permits: Arc::new(Semaphore::new(reservations.tasks)),
```

`reservations.pending` and `reservations.tasks` are `checked_add` sums over every
module's declaration (`:555-566`). With no declarations, both are zero, so both
semaphores hold zero permits.

The claim is stated in the field doc, `runtime.rs:117-121`:

> Reserved-class admission pools, sized by the checked declaration sums (plan
> KTD2). Zero-permit when no module declared a reservation, and then unreachable
> because every route is general-class.

The gate that makes the second half true, `runtime.rs:535-554`:

```
match declaration.route_class {
    RouteClass::General => {
        if declaration.reserved_pending_requests != 0
            || declaration.reserved_handler_tasks != 0
        {
            return Err(HostError::InitFailed(
                "a general-class module declares reserved permits".to_owned(),
            ));
        }
    }
    RouteClass::Reserved => {
        if declaration.reserved_pending_requests == 0
            || declaration.reserved_handler_tasks == 0
        {
            return Err(HostError::InitFailed(
                "a reserved-class module declares no reserved permits".to_owned(),
            ));
        }
    }
}
```

Its rationale, `:530-534`: "a general-class module holding reserved permits would
shrink the general pools without anything ever drawing on the carve-out, and a
reserved-class module with a zero reservation could dispatch only through another
module's permits — both are impossible accounting, refused at startup."

So the implication chain is: `reservations.pending == 0` implies no module
declared a reservation, which implies (by the `Reserved` arm) no module is
`RouteClass::Reserved`, which implies every route is general-class, which implies
nothing acquires from the reserved pools.

The class travels with the target entry into `TargetIndex::new` (`:618-621`, from
the tuples built at `:604-608`), so route admission reads the class from the same
validated source that sized the pools. That single-source property is what makes
the implication hold rather than being a coincidence.

The general pools are the complement, `:905-910`:

```
pending_permits: Arc::new(Semaphore::new(
    config.limits.max_pending_requests - reservations.pending,
)),
task_permits: Arc::new(Semaphore::new(
    config.limits.max_handler_tasks - reservations.tasks,
)),
```

Both subtractions are protected by the strict comparisons at `:693` and `:698`,
so each general pool retains at least one permit.

Existing coverage:

- `handler_contract.rs:636` `zero_reservation_handlers_keep_single_pool_admission`
  — the no-declaration case from the admission side.
- `handler_contract.rs:375` `class_and_reservation_mismatches_fail_startup` — the
  gate itself, with both directions constructed at `:378-388`.
- `handler_contract.rs:323` `reservations_must_leave_one_general_slot_in_each_pool`
  — the strict comparisons at `:693` and `:698`.

None asserts the no-entry half directly, because an acquisition against the
reserved pool is internal to `dispatch.rs` and has no observable at the wire.

## Failure scenario

A future module is added with `route_class: RouteClass::Reserved` and non-zero
reserved counts, so the gate passes and the pools are non-empty. Then a routing
change makes a *general*-class route reach the reserved acquisition — a mis-set
class on a new target kind, a defaulted `RouteClass` in a new code path, or a
route whose class is derived from something other than `TargetIndex`.

On a host where no module declares a reservation, that route acquires against a
zero-permit `Semaphore`. `Semaphore::acquire` on zero permits does not fail; it
waits. Nothing ever adds a permit, because permits are only returned by holders
and there are none. So the dispatch task parks forever.

The observable is a request that never settles. It holds a pending permit from the
general pool (acquired earlier in dispatch), and its connection's writer queue
slot, until the frame deadline or generation retirement reclaims them. From the
client's side it is indistinguishable from a slow handler, not from a refusal.
`docs/mc-host-wire-protocol.md:290` allows a deployment to cap pending
correlations; it does not allow one to hang.

## Timing windows and dependencies

No startup race. Both pools are constructed once at `:882-927` and never resized.

The runtime window is the acquisition itself, which is unbounded on a zero-permit
semaphore. Whether the parked task is cancellable depends on how dispatch races
the acquisition against the generation token and the frame deadline, which is
`dispatch.rs` and belongs to sub-part 2e. This record deliberately asserts the
precondition — that no general route reaches the reserved pool — rather than the
consequence, because the consequence's containment is someone else's property.

Dependency: the whole guarantee rests on `TargetIndex` being the single authority
for a route's class. `runtime.rs:604-608` and `:618-621` establish that the
tuples fed to `TargetIndex::new` are the same ones the class gate validated. If
any other code derived a class independently, the implication breaks. I did not
audit `routing.rs` or `dispatch.rs` for a second derivation; that is 2e's file
set.

## What a test must construct

A three-component composite with mixed classes, plus a marker at each reserved
acquisition site in `dispatch.rs` recording the acquiring route's class.

The assertion has two halves:

1. On a host where `reservations.pending == 0`, no marker fires. Expressed as
   `always-or-unreached` rather than `unreachable`, because on a host that *does*
   declare a reservation the same sites fire legitimately.
2. Whenever a marker fires, the acquiring route's class is `Reserved`. This is
   the precondition form and holds on a correct implementation.

`handler_contract.rs:302-320` already provides `broca_declaration` and
`three_child_composite`, and `:378-388` already builds both mismatch directions,
so only the markers are missing.

A cheaper partial oracle needs no markers: assert
`shared.reserved_pending_permits.available_permits() == 0` throughout a run on a
no-declaration host. If a general route ever acquired, the count would have to
have gone negative, which `Semaphore` cannot represent, so the observable would
be the hang rather than a count change. That is why the marker form is the
primary one and this is only a screen.

## Investigation log

### Q: does `Semaphore::new(0)` differ from a closed semaphore?

- Sources examined: `runtime.rs:911-912`, and `ByteBudget::charge`'s
  `.expect("byte budget semaphore is never closed")` at `wire.rs:418-419`.
- Findings: a zero-permit semaphore is open and simply has nothing to hand out;
  `acquire` returns `Pending` indefinitely. A *closed* semaphore returns
  `Err(AcquireError)`, which is why `wire.rs:418` can `expect`. Nothing closes the
  reserved semaphores.
- Missing evidence: none.
- Conclusion: resolved with answer — the failure mode is a hang, not an error.
  That is what makes the no-entry half load-bearing: there is no error path to
  observe.

### Q: is the class the only thing that routes an acquisition to the reserved pool?

- Sources examined: `runtime.rs:535-554`, `:604-608`, `:618-621`,
  `handler.rs:88-91`.
- Findings: `handler.rs:88` and `:91` describe reserved permits as "carved out of
  `max_handler_tasks`" and "carved out of `max_pending_requests`" for a module, so
  the module identity plus its class is the selector. The tuples carrying the class
  into `TargetIndex` come from the same loop that validated it.
- Missing evidence: the acquisition sites themselves, in `dispatch.rs`. I did not
  read them.
- Conclusion: unresolved, needs 2e to confirm no second class derivation exists.
  The construction-side single-source property is verified; the consumption side is
  not, and that is exactly the gap the marker-based check would close.
