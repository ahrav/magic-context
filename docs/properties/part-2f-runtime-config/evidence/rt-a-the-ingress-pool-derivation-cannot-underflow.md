# rt-a-the-ingress-pool-derivation-cannot-underflow

## Discovery trigger

Reading the `HostShared` literal for the conditionality map. `ingress_budget`
at `runtime.rs:896-902` is the only field built from arithmetic rather than a
constant or a validated value, and it uses plain `-` four times in a row. The
comment that justifies it sits 165 lines earlier.

## Evidence trail

The subtraction, verified verbatim at `runtime.rs:896-902`:

```
ingress_budget: ByteBudget::new(
    config.limits.max_resident_bytes
        - crate::config::EGRESS_RESERVED_BYTES
        - crate::config::SCRATCH_RESERVED_BYTES
        - catalog_resident
        - reservations.retained_bytes,
),
```

Its sole guard, `runtime.rs:733-740`:

```
let resident_floor = crate::config::MIN_RESIDENT_BYTES
    .saturating_add(catalog_resident)
    .saturating_add(reservations.retained_bytes);
if config.limits.max_resident_bytes < resident_floor {
```

And the identity that closes the proof, `config.rs:23-24`:

```
pub const MIN_RESIDENT_BYTES: u64 =
    MAX_BODY_LEN as u64 + EGRESS_RESERVED_BYTES + SCRATCH_RESERVED_BYTES;
```

Substituting: the gate requires
`max_resident_bytes >= MAX_BODY_LEN + EGRESS + SCRATCH + catalog + retained`, so
the subtraction's result is at least `MAX_BODY_LEN`. The arithmetic is correct
today. Confirmed numerically: at the default `max_resident_bytes` of 385,942,805
with an empty catalog and no retention, the result is 134,217,728, exactly
`2 * MAX_BODY_LEN`.

What happens on failure, `wire.rs:394-400`:

```
pub fn new(max_bytes: u64) -> Self {
    let capacity = max_bytes as usize;
    Self { semaphore: Arc::new(Semaphore::new(capacity)), capacity }
}
```

`Semaphore::new` panics above `MAX_PERMITS`, so a wrapped value produces a panic
inside the struct literal rather than a `Result`.

The existing test, `config.rs:520-548`
`the_resident_cap_splits_into_three_non_overlapping_pools`, asserts the constant
decomposition and computes `admission_at_floor` and `admission_at_default` by
hand. It reproduces the runtime's arithmetic rather than calling it. Its comment
at `:541-543` even says "The catalog and declared retained bytes are subtracted
from admission only (runtime.rs)", naming the coupling it does not test.

## Failure scenario

Someone adds a fourth resident class — say a per-incarnation prompt cache — and
subtracts it at `:896-902` alongside the others, which is the natural local
edit. They do not add it to `resident_floor` at `:733-735`, because that is in a
different function 165 lines away and the compiler says nothing.

On a host configured at or near the floor, the subtraction now wraps. In debug
builds the arithmetic panics with an overflow message at `:896`, which is at
least legible. In release builds it wraps silently to roughly `u64::MAX`,
`as usize` preserves it on 64-bit, and `Semaphore::new` panics with a message
about permit counts that names neither `max_resident_bytes` nor the new class.

Either way the panic is after publication (`:842`), so the failure mode is an
advertised endpoint with no listener.

## Timing windows and dependencies

No runtime window. Both sites execute once, sequentially, on the same task.

The window is in the source: three files must agree.

- `config.rs:23-24` defines `MIN_RESIDENT_BYTES` as the sum of exactly three
  terms.
- `runtime.rs:733-735` adds the two handler-derived terms to it.
- `runtime.rs:896-902` subtracts all five.

Any edit to one without the others breaks the invariant. `EGRESS_RESERVED_BYTES`
and `SCRATCH_RESERVED_BYTES` are `pub(crate)` (`config.rs:28`, `:50`), so the
compiler will not catch a crate-internal divergence.

Dependency: `catalog_resident` comes from `catalog.resident_len()` at `:732`,
which runs after `CatalogCache::new_bounded` succeeded at `:718`, so the catalog
is already known to fit `MAX_BODY_LEN`. `reservations.retained_bytes` is a
`checked_add` sum (`:573-578`), so it cannot itself have wrapped.

## What a test must construct

The cheapest valid oracle is a static assertion, not a runtime one. A
`const` assertion or a unit test that recomputes the gate and the subtraction
from the same constants and asserts
`MIN_RESIDENT_BYTES - EGRESS_RESERVED_BYTES - SCRATCH_RESERVED_BYTES == MAX_BODY_LEN as u64`
fails the moment any of the three terms changes.

The runtime half needs a host started at exactly its handler-dependent floor,
with a non-empty catalog and a non-zero `retained_resident_bytes`, asserting
that `shared.ingress_budget.capacity()` equals `MAX_BODY_LEN`.
`handler_contract.rs:437` `retained_declaration_raises_the_resident_floor_exactly`
already constructs the floor case and asserts the boundary from outside; it
would need access to the budget's capacity to assert the inner value.

A `debug_assert` immediately before `:896` stating the five-term inequality is
the cheapest production guard, and it asserts a precondition rather than the
violation.

## Investigation log

### Q: does any existing test exercise the runtime subtraction at a floor?

- Sources examined: `config.rs:463-673` (all nine unit tests),
  `handler_contract.rs:252-300` and `:437-530`, `synapse_bundle.rs:828`.
- Findings: `handler_contract.rs:437` starts a host at the exact floor and one
  byte below, asserting success and `InitFailed`. So the *gate* is covered at
  its boundary. `synapse_bundle.rs:828` uses `MIN_RESIDENT_BYTES * 2`. No test
  reads the resulting `ingress_budget` capacity, and `ByteBudget::capacity` is
  `pub(crate)` (`wire.rs:405`), so an integration test cannot.
- Missing evidence: none; the gap is real.
- Conclusion: resolved with answer — the gate's boundary is covered, the
  consumer's postcondition is not, and the visibility of `capacity` is why.

### Q: could `catalog_resident` alone exceed the headroom and force a wrap?

- Sources examined: `runtime.rs:718-724`, `:732`.
- Findings: `CatalogCache::new_bounded` is bounded at `MAX_BODY_LEN`
  (`:719`), so `catalog_resident <= 67,108,864`. The gate at `:736` accounts for
  it exactly. With the default cap there is 3.9 GB of headroom on 64-bit.
- Missing evidence: whether `resident_len()` can exceed the serialization bound
  the constructor enforced. I did not read `control.rs`.
- Conclusion: unresolved, needs `control.rs`, which belongs to sub-part 2e. The
  gate uses whatever `resident_len` returns, so the two must agree; if
  `resident_len` could exceed `new_bounded`'s cap the gate would still be
  correct, only the bound looser.
