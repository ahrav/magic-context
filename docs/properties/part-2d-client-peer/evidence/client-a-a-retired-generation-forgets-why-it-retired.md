# client-a-a-retired-generation-forgets-why-it-retired

## Discovery trigger

Task 3 asked what the client does on a silent close. Tracing the answer required
finding where the retirement cause is stored. It is not stored anywhere.

## Evidence trail

`retire` is the single involuntary terminal transition:

```
1667:    fn retire(&self, code: &'static str) {
1668:        if self.retired.swap(true, Ordering::AcqRel) {
1669:            return;
1670:        }
1671:        self.closed.store(true, Ordering::Release);
1672:        self.settle_all(code);
1673:        lock_unpoisoned(&self.routes).clear();
1674:        self.cancel.cancel();
1675:    }
```

`code` appears exactly once in the body, at `:1672`. `settle_all` (`:1649-1665`)
drains the pending map and builds one `CallError::local(outcome, code, ...)` per
entry at `:1658-1662`. After that loop the string is dropped.

`Inner`'s field list (`client.rs:934-960`) was read in full. It holds
`daemon_id`, `daemon_ver`, `closed`, `retired`, `cancel`, `correlations`,
`admission`, `pending`, `streams`, `routes`, four `ByteCounter`s, `data_tx`,
`control_tx`, `close_lock`, `reader`, `writer`. There is no cause field.

The two post-retirement rejection sites both use constants:

- `admit` (`:1126-1131` and again `:1142-1148`) returns
  `CallError::local(SendOutcome::NotSent, "connection_retired", "connection
  generation is retired")`.
- `send_control` (`:1326-1328`) returns `retired_error(SendOutcome::NotSent)`,
  and `retired_error` (`:2234-2240`) hardcodes `"generation_retired"`.

The eight distinct causes `retire` is called with are tabulated in the lens file.
They are `connection_goodbye` (`:1397`), `protocol_violation` (`:1979`, `:1557`),
`eof` (`:1987`), `write_failed` (`:1954`, `:1963`), `control_capacity_exhausted`
(`:1341`, `:1356`), `invalid_route_response` (`:486`),
`stranded_route_cleanup_failed` (`:1588`), and the three local lifecycle codes
`owner_drop` (`:744`), `owner_close_dropped` (`:766`), `shutdown_timeout`
(`:676`).

## Failure scenario

An idle client holds an open connection with no pending requests. The host is
reloaded. Its ring closes, the bridge thread breaks, `ring_reader_loop` calls
`retire("eof")` at `:1987`, and `settle_all("eof")` iterates an empty map. The
string is discarded with no consumer.

The caller's next `request` reaches `admit`, sees `retired == true` at `:1126`,
and receives `connection_retired`. That is the same answer it would get if the
client had retired for `protocol_violation`, `control_capacity_exhausted`, or an
owner drop. The caller's recovery policy has to choose a strategy with no
information about which of eight causes applied.

## Timing windows and dependencies

The distinguishing information exists for the duration of `settle_all`'s `for`
loop at `:1654`. A caller whose request is in the map at that instant receives
the real code. A caller that calls `admit` one instruction after the loop ends
receives the constant. There is no window in which a *new* caller can learn the
cause.

Depends on record `client-a-a-clean-host-close-and-a-transport-failure-share-one-code`:
even a pending caller cannot separate a healthy host exit from a transport
failure, because both are spelled `eof`. So the information that is briefly
available is itself incomplete.

## What a test must construct

1. Build an `Inner` through `test_inner` (`client.rs:2270`) with an empty pending
   map. Call `inner.retire("protocol_violation")`. Then call any public entry
   point and assert the observed `CallError::code()` is `connection_retired`,
   not `protocol_violation`.
2. Repeat with one pending request outstanding and assert the pending caller does
   receive `protocol_violation`. The pair is what demonstrates the information is
   transient rather than absent by design.
3. Both directions matter. Asserting only the first would be consistent with a
   client that never surfaces a cause at all.

## Investigation log

### Q: Should `Inner` carry the cause so late callers can read it?

- Sources examined: `Inner` field list (`client.rs:934-960`), `retire`
  (`:1667-1675`), `admit` (`:1119-1217`), `retired_error` (`:2234-2240`),
  `CallError` (`:143-192`), and the public `code()` accessor (`:184-186`).
- Findings: the mechanism is cheap. `retired` is already an `AtomicBool` set
  under `swap`, so a `OnceLock<&'static str>` set immediately after it would be
  race-free and would give `admit` a real code with no new locking. The cost is
  that `CallError::code()` is public and documented as a "stable bounded error
  code", so widening its value set at the `connection_retired` site is a
  compatibility change for cross-language recovery policy, which
  `SendOutcome::as_str` (`:127-133`) shows is a real consumer.
- Missing evidence: which consumers switch on `code()` for the retired case. That
  is outside `client.rs`.
- Conclusion: needs human input. The implementation is trivial; the compatibility
  decision is not mine.

### Q: Is any cause already recoverable from another observable?

- Sources examined: `Client::daemon_id` (`:435`), `daemon_ver` (`:440`), the
  `Debug` impl (`:294-300`), `host_status` (`:619`), `HostStatusSnapshot`
  (`:256-260`).
- Findings: the `Debug` impl exposes only `closed`. `host_status` requires a live
  connection and so is unavailable after retirement. No accessor reports why.
- Missing evidence: none.
- Conclusion: resolved with answer. The cause is not recoverable by any other
  path once `settle_all` has run.
