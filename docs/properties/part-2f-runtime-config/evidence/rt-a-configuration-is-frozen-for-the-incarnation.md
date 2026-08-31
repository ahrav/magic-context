# rt-a-configuration-is-frozen-for-the-incarnation

## Discovery trigger

Every sibling sub-part has records whose enabling state is "a configured value of
X". None of them states whether that value can change mid-run. If it can, each of
those records needs a window. I checked, and it cannot — but the reason is
structural rather than asserted, so it is worth pinning once here instead of
implicitly 55 times across the catalog.

## Evidence trail

`HostConfig` is consumed, not retained. The complete inventory of what leaves it
and when:

| Field | Where it goes | Site |
| --- | --- | --- |
| `data_dir` | borrowed for the lock acquisition, never stored | `runtime.rs:660` |
| `payload_manifest_digest` | borrowed for the lock acquisition | `runtime.rs:661` |
| `init` | **moved out** with `std::mem::take` | `runtime.rs:751` |
| `limits` | cloned into `HostShared` | `runtime.rs:884` |
| `timing` | cloned into `HostShared` | `runtime.rs:885` |
| `liveness` | cloned into `HostShared` | `runtime.rs:886` |
| `daemon_ver` | borrowed at `:842`, then cloned into `HostShared` | `runtime.rs:926` |
| `max_routes` | read once to size the registry | `runtime.rs:895` |
| `max_resident_bytes` | read once for the ingress derivation | `runtime.rs:897` |
| `max_pending_requests`, `max_handler_tasks` | read for the gates and the pools | `:693`, `:698`, `:707`, `:906`, `:909` |
| `max_handshakes`, `max_connections` | read once each for their semaphores | `:913`, `:914`; `max_connections` also at `:872` |

After `runtime.rs:927` — the closing brace of the `HostShared` literal — the
identifier `config` does not appear again in the function. Verified by reading
`:928-961`.

The shared copies are plain owned values, `runtime.rs:96-98`:

```
pub limits: HostLimits,
pub timing: HostTiming,
pub liveness: Option<LivenessPolicy>,
```

No `Mutex`, no `RwLock`, no `AtomicU64`, no `ArcSwap`. `HostShared` is handed
around as `Arc<HostShared<H>>` (`:882`, and every `Arc::clone` thereafter), and
`Arc` gives shared references only, so these fields are immutable for every
holder. `HostLimits` and `HostTiming` derive `Debug, Clone` only
(`config.rs:89`, `:198`) and contain no interior-mutability types — six `usize`,
one `u64`, seven `Duration`.

Contrast with the fields on `HostShared` that *are* mutable, which is what makes
the immutability of the config fields legible rather than accidental:
`health_snapshot: RwLock<HealthReport>` (`:103`), `abort_handles: Mutex<AbortRegistry>`
(`:125`), `shutdown_callback_ran: AtomicBool` (`:130`), `draining: AtomicBool`
(`:134`), `gen_counter: AtomicU64` (`:136`),
`connections: Mutex<HashMap<..>>` (`:137`), and `FatalCell`'s
`message: Mutex<Option<String>>` (`:68`). The author reached for a lock or an
atomic every time mutation was intended. The three config fields are the ones
where they did not.

There is no reload surface. The public API is `run` and `run_with_publish_hook`
(`lib.rs:78`), both taking `config: HostConfig` by value. `HostShared` is not
exported — `runtime` is a private module (`lib.rs:33`), and only `run`,
`run_with_publish_hook`, and `HostError` are re-exported. So no external caller
can reach the fields at all, let alone mutate them.

`runtime.rs:3-5` confirms the design intent for the one thing that *is* injected
from outside: "Signal acquisition stays outside this crate: the caller supplies a
`CancellationToken`". The token is the only live control channel into a running
host, and it carries one bit.

## Failure scenario

There is no current failure. The record exists to make a future one visible.

A plausible addition is a `SIGHUP` reload, which `runtime.rs:3-5` gestures at by
deferring signal wiring to `magic-context-c50.4`. Suppose it lands and mutates
`timing.frame_deadline` behind an `RwLock`.

Every record in the catalog that says "bounded by `frame_deadline`" acquires a
window it did not have. Worse, several derived quantities were computed once at
startup and would not follow: `ingress_budget`'s capacity (`:896-902`),
`pending_permits`'s count (`:905-907`), the ring's `process_limits` (`:872`), and
the route registry's ceiling (`:895`) are all snapshots. A reload that changed
`max_resident_bytes` without rebuilding the budget would leave the host enforcing
the old value while reporting the new one — and the resident-floor gate at `:736`
would not re-run, so the underflow protection in
`rt-a-the-ingress-pool-derivation-cannot-underflow` would no longer cover it.

So the concrete risk is not that a reload is unsafe in the abstract; it is that
four values are derived once and three are stored live, and only the stored three
look reloadable.

## Timing windows and dependencies

None at runtime, by construction.

One ordering detail matters for a reader of `:751`. `config.init` is *moved out*,
not cloned, so after `:751` `config.init` is `HostInit::default()`. Nothing reads
it afterwards, so the emptied field is harmless, but a future edit that read
`config.init` after initialization would silently see an empty payload rather
than the caller's. `:748-750` explains the move (the storage descriptor must not
stay resident outside every byte budget), so the emptying is deliberate.

Dependency: this property is load-bearing for the reachability labels of every
config-dependent record in the catalog. If it were ever invalidated, the
`explicit-config-only` labels would need re-verification, because a value could be
`None` at startup and `Some` later.

## What a test must construct

Nothing at runtime. The honest checks are structural.

1. A compile-level assertion that `HostLimits`, `HostTiming`, and
   `LivenessPolicy` contain no interior mutability. Rust has no `Freeze` bound
   available on stable, so the practical form is a test that constructs a
   `HostShared`, takes `&shared.limits`, and relies on the borrow checker — which
   proves nothing a reader cannot already see. A better mechanical form is a
   review gate on those three types.
2. A snapshot-and-compare test: capture `limits`, `timing`, and `liveness`
   immediately after construction and assert equality at `run`'s return. This
   needs `PartialEq` on all three, which none derives today (`config.rs:89`,
   `:198`, `:239`). Adding it is the one small change that makes the property
   mechanically checkable.
3. A grep-level gate asserting no `RwLock`, `Mutex`, `Atomic`, or `ArcSwap`
   appears on those three types. Crude, but it is the check that would actually
   fire on the failure scenario above.

Form 2 is the one to prefer, and it asserts the precondition directly rather than
the absence of a defect.

## Investigation log

### Q: does any code path mutate `config` after `HostShared` is built?

- Sources examined: `runtime.rs:641-961` read in full, searching for `config`.
- Findings: the last occurrence is `:926` (`daemon_ver: config.daemon_ver.clone()`),
  inside the struct literal that closes at `:927`. Lines `:928-961` contain no
  reference. The parameter is declared `mut config` at `:643` solely for the
  `std::mem::take` at `:751`.
- Missing evidence: none.
- Conclusion: resolved with answer — `mut` is needed for exactly one move, and
  nothing mutates the config after construction.

### Q: is `HostShared` reachable from outside the crate, so an embedder could mutate it?

- Sources examined: `lib.rs:24-39`, `:78`.
- Findings: `mod runtime;` at `:33` is private. `lib.rs:78` re-exports only
  `run`, `run_with_publish_hook`, and `HostError`. `HostShared` is `pub` within a
  private module, so it is crate-visible only. `pub` on its fields matters for
  `connection.rs`, `dispatch.rs`, and `control.rs`, not for embedders.
- Missing evidence: none.
- Conclusion: resolved with answer — unreachable externally. The `pub` fields are
  crate-internal wiring.

### Q: are any of the derived-once values re-derived anywhere during the run?

- Sources examined: `runtime.rs:872`, `:895`, `:896-914`, and the `HostShared`
  field list at `:94-141`.
- Findings: `process_limits` runs once at `:872`. `RouteRegistry::new` runs once at
  `:895`. All six semaphores and three byte budgets are constructed once in the
  literal. `ByteBudget` is `Clone` (`wire.rs:383`) and `connection.rs:144` clones
  `ingress_budget`, but its only capacity-bearing state is
  `semaphore: Arc<Semaphore>` and a `usize` copy of the ceiling
  (`wire.rs:384-390`), so a clone is a handle onto the same permits, not a
  resized copy.
- Missing evidence: none.
- Conclusion: resolved with answer — every derived quantity is computed exactly
  once, which is why a future reload would desynchronise the stored config from
  the enforced capacity. That asymmetry is the substance of this record.
