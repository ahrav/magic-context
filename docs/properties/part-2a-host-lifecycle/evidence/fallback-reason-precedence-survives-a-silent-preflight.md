# fallback-reason-precedence-survives-a-silent-preflight

## Discovery trigger

Gap G1 asked whether fallback reason precedence and the serveable-by-default
preflight belong to setup or to negotiation proper. They belong to setup: both are
inputs to the single decision `handle_negotiate` makes about which transport the
generation commits to, and the reason it emits determines whether the client is
permitted to retry an upgrade later
(`docs/mc-host-wire-protocol.md:621`). Verifying the reachability class was the
second half of the trigger, because the prompt warned against assuming it.

## Evidence trail

The precedence block, `crates/mc-host/src/connection.rs:947-959`:

```rust
let reason = if dynamically_unavailable {
    Some(FallbackReason::Unavailable)
} else if capability_mismatch {
    Some(FallbackReason::CapabilityVersionMismatch)
} else {
    None
};
```

The comment above it (`:947-952`) gives the reason for the ordering, and it matches
the document: exact `unavailable` is the only selection that authorizes an automatic
client re-upgrade probe (`docs/mc-host-wire-protocol.md:621`), and a dynamically
unavailable eligible offer is transient, so reporting a static mismatch from a
lower-preference sibling would permanently suppress recovery.

The two flags are set inside the offer loop (`:891-946`):

- `dynamically_unavailable = true` at `:933` when a found provider's `preflight`
  returns `PreflightEligibility::DynamicallyUnavailable`.
- `capability_mismatch = true` at `:941`, in the `None if
  shared.providers.serves_transport(&offer.transport)` arm at `:940`: the
  transport is installed at some other capability version.
- `StaticallyOmitted` at `:935` and permanent absence at `:944` both contribute
  nothing, so they select reasonless TCP.

The document's closed vocabulary at `:614-617` matches: `unavailable` is
explicitly restricted to "an installed, statically eligible non-TCP offer" that is
dynamically unavailable, and it states that permanent absence and statically
ineligible parameters "select TCP with no `reason`".

Three inputs make the precedence weaker than it looks:

1. **Preflight is serveable by default.** `transport_provider.rs:118-120` gives
   `InjectedProvider::preflight` a default body returning
   `PreflightEligibility::Serveable`. A provider that does not override it is
   always statically eligible, so `unavailable` can only ever be produced by an
   explicit override.
2. **A panicking preflight becomes silent omission.** `connection.rs:906-912`
   wraps the call in `catch_unwind` inside `redact_sync` and maps a panic to
   `StaticallyOmitted`. The comment at `:906` states the intent: fail toward static
   omission, meaning reasonless TCP and no client probe. So a provider whose
   preflight is merely buggy is indistinguishable, on the wire, from one that was
   never installed.
3. **First serveable TCP offer short-circuits the loop.** `:892-896` breaks out of
   the loop when it reaches the offered `tcp` entry at the supported capability
   version. Offers listed after the TCP entry are never evaluated and cannot
   contribute a reason, so precedence only ranges over offers ahead of TCP in
   client preference order.

Reachability, verified rather than assumed:

- `TransportProviders::default()` derives an empty `injected` vector
  (`transport_provider.rs:159-163`).
- `HostConfig::default` installs exactly that: `transport_providers:
  crate::transport_provider::TransportProviders::default()` at `config.rs:297`.
- The module doc states it outright at `transport_provider.rs:1-9`: "the default
  registry holds no injected providers, so a production host can never grant a
  non-TCP channel (R6). Injected providers exist for tests".
- With an empty registry, `providers.find` (`:901-903`) always returns `None` and
  `serves_transport` (`transport_provider.rs:286-290`) always returns false, so
  both flags stay false.

Consequence, stated as a verified fact: **in every shipped configuration in this
tree, `reason` is always `None` and negotiation always ends in a reasonless TCP
commit.** The precedence rule is test-only, and so is every path that can produce
either reason.

## Failure scenario

Invert the precedence, or let a `StaticallyOmitted` sibling suppress a
`DynamicallyUnavailable` one, and the host emits `capability_version_mismatch`
where `unavailable` is true. Per `docs/mc-host-wire-protocol.md:621` the client
then MUST NOT start the re-upgrade probe window, so a transport that was merely
recovering or under admission pressure, and would have been serveable seconds
later, stays unused for the entire life of that connection. Since reconnect
rereads discovery and renegotiates from a fresh setup state (`:651`), recovery
depends on the client happening to reconnect for an unrelated reason.

The panic mapping produces the same outcome from a different cause, and is the more
likely one in practice: a provider whose `preflight` panics on a parameter shape it
did not expect is permanently invisible to negotiation, with no wire signal and no
distinction from an uninstalled provider.

## Timing windows and dependencies

No interleaving. `handle_negotiate` runs inline on the sole read loop, and both
flags are plain locals over one loop.

The ordering that matters is offer order, which is client-controlled: the client
decides which offers precede the mandatory `tcp` entry (`:571` requires at least
one `tcp` offer, enforced at `transport_negotiation.rs:526-531`), and therefore
which offers are evaluated at all. A test that puts the unavailable transport after
TCP in preference order will observe no reason and will look like a precedence
failure when it is a short-circuit.

Dependency on injected providers is total: two providers are needed to exercise the
precedence, and injection is only reachable through `HostConfig`, which the module
doc describes as a crate-internal seam for the integration-test harness
(`transport_provider.rs:11-13`).

## What a test must construct

1. Two injected providers. Provider A overrides `preflight` to return
   `DynamicallyUnavailable`. Provider B is installed at capability version 2 while
   the client offers version 1, so `find` misses and `serves_transport` hits.
2. A client offer list ordered so that both A and B precede the `tcp` entry, since
   `:892-896` stops at TCP.
3. Assert the emitted response carries `reason: "unavailable"`, not
   `capability_version_mismatch`. Then swap the order of A and B in the offer list
   and assert the reason is unchanged: precedence must be independent of offer
   order among offers ahead of TCP.
4. A third case for the panic mapping: a provider whose `preflight` panics,
   offered alongside a version-mismatched sibling. Assert the response selects TCP
   with `reason: "capability_version_mismatch"` (the panicking provider
   contributes nothing) and that no provider bytes appear in any emitted frame or
   log, which is the `redact_sync` half of `:907-910`.
5. A negative baseline that is worth having in CI because it pins the shipped
   behaviour: with the default empty registry, any non-TCP offer selects TCP with
   no reason. This already exists at
   `tests/transport_negotiation.rs:851` `unprovided_non_tcp_offer_selects_reasonless_tcp`.

## Investigation log

### Q: Should a panicking preflight be observably different from permanent absence?

- Sources examined: `connection.rs:906-912` and its KTD6 comment;
  `transport_provider.rs:99-107` (`PreflightEligibility` variants and their
  comments), `:116-120` (the default body), `:237-247` (the analogous panic
  containment for `prepare`, which maps to `ProviderFailure::Unavailable` rather
  than to omission); `docs/mc-host-wire-protocol.md:614-621`.
- Findings: the wire behaviour is deliberate and should not change. `:906` states
  that a panicking preflight fails toward static omission specifically so the
  client gets no probe authorization, and `:943` states that permanent absence must
  select reasonless TCP so a client cannot probe for a provider that cannot appear.
  Both are correct on the wire. What is absent is a *host-side* signal: a panicking
  preflight is a host defect, and nothing in this path records that it happened.
  Note the asymmetry with `prepare`, where a panic maps to
  `ProviderFailure::Unavailable` (`transport_provider.rs:247`) rather than to
  omission, because by then a candidate was already being prepared.
- Missing evidence: whether an event or metric for a panicking preflight exists
  elsewhere in the host. No such emission is visible on this path.
- Conclusion: needs human input. The wire reason must stay reasonless; whether the
  host should observe the panic through a separate channel is a design decision,
  and it is carried as the record's open question.
