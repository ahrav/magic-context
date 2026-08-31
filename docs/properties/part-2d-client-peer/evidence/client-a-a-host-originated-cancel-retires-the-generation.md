# client-a-a-host-originated-cancel-retires-the-generation

## Discovery trigger

Enumerating `validate_inbound`'s coverage against `FrameType`'s twelve variants to
prove the `dispatch` catch-all unreachable. `Cancel` fell into the residue, and
checking the doc showed the residue is not obviously correct for that one type.

## Evidence trail

`FrameType` has twelve variants (`wire.rs:51-64`):

```
51: pub enum FrameType {
52:     Request = 0,
53:     Response = 1,
54:     Push = 2,
55:     StreamData = 3,
56:     StreamEnd = 4,
57:     Error = 5,
58:     Cancel = 6,
59:     Ping = 7,
60:     Pong = 8,
61:     Hello = 9,
62:     HelloAck = 10,
63:     Goodbye = 11,
64: }
```

`validate_inbound`'s match covers seven of them and rejects the rest:

| Arm | Site | Covers |
| --- | --- | --- |
| `Response \| Error` | `:2022` | 1, 5 |
| `StreamData \| StreamEnd` | `:2038` | 3, 4 |
| `Push` | `:2050` | 2 |
| `Ping` | `:2057` | 7 |
| `Goodbye` | `:2062` | 11 |
| `_ => return Err(())` | `:2067` | 0, 6, 8, 9, 10 |

So `Request`, `Cancel`, `Pong`, `Hello`, and `HelloAck` are all rejected on the
header. `ring_reader_loop` turns that rejection into a generation retirement:

```
1978:        if validate_inbound(&header).is_err() || body.len() != header.len as usize {
1979:            inner.retire("protocol_violation");
1980:            return;
1981:        }
```

Four of the five are clearly correct. `docs/mc-host-wire-protocol.md:269` makes
host-originated `Request` role-invalid explicitly: "A consumer-originated
`Response`, `Push`, `StreamData`, `StreamEnd`, or `Error`, and every host-originated
`Request`, are role-invalid. The receiver MUST close the generation rather than
extend this profile implicitly." `Pong` is consumer-to-host by `:262`, so a
host-originated one is role-invalid by the same logic. `Hello` and `HelloAck` are
handled at `:267`: "receiving either on an authenticated consumer connection is a
role violation."

`Cancel` is the exception. It appears in the state table at `:280`:

> | `Cancel` | current nonzero route and pending nonzero correlation | empty |
> stale route or unknown/terminal correlation is idempotent no-op |

That row assigns a disposition of "idempotent no-op", not "close the generation",
and it names no direction. And `:269`'s role-invalid enumeration omits `Cancel`
entirely, in a sentence that is otherwise exhaustive about which frames are
role-invalid in which direction.

So the doc's two relevant statements are: `Cancel` is not listed as role-invalid in
either direction, and a `Cancel` that does not match live state is a no-op. The code
retires the generation.

## Failure scenario

A host emits a pure-header `Cancel` on a live route with a pending correlation,
intending to withdraw work the client asked for. The frame is well-formed: `len == 0`,
binary clear, last clear, admission `Normal`, nonzero channel, epoch, and correlation.

`validate_inbound` reaches `:2067` because there is no `Cancel` arm, returns `Err`,
and `ring_reader_loop` retires with `protocol_violation`. Every route on the
generation dies, every pending request is settled, and the caller sees
`protocol_violation` if it had work outstanding and `connection_retired` otherwise.

Whether this ever happens depends on whether the host emits `Cancel`. If it never
does, the strictness costs nothing and the finding is that the documentation is
ambiguous. If it ever does, one intended cancellation destroys the whole generation.

The consequence of the strictness is also structural: `dispatch`'s catch-all arm

```
1557:            _ => self.retire("protocol_violation"),
```

is unreachable from the production reader, because every type that would land there
is already rejected. That is recorded separately as
`client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production`. The two
sites duplicate the same classification decision in two places, which is how they can
drift.

## Timing windows and dependencies

No timing window. The classification is a total function of the header.

Note that the client's own outbound `Cancel` is a first-class part of its behaviour:
it sends them from `cancel_key` (`:1298`), from the unexpected-stream-data path
(`:1498`), and from the stream-saturation path (`:1543`). So the client is a `Cancel`
sender and not a `Cancel` receiver, and the asymmetry is deliberate in the code even
if the doc does not license it.

Related: `client-a-a-retired-generation-forgets-why-it-retired`. A caller with no
pending work would see only `connection_retired` and would have no way to learn a
`Cancel` arrived, so this failure would be very hard to diagnose in the field.

## What a test must construct

1. A peer that sends a well-formed pure-header `Cancel` on a live route with a
   pending correlation. The header must satisfy every pure-header constraint at
   `:2073-2080` so the test is about the missing arm and not about flags.
2. Assert the client retired with `protocol_violation`, which is the property as the
   code stands.
3. Assert the pending request on that route was settled, and record its
   `SendOutcome`. This matters because the doc's intended disposition is a no-op, so
   under the doc's reading the request should have been cancelled and the generation
   should have survived. The test documents the gap between the two.
4. `inbound_validation_enforces_the_direct_profile_table` (`:2658`) is the existing
   table-driven check and is the right place for this case. Whether it already covers
   `Cancel` is unverified; if it does, this record's `Exercised` line should be
   upgraded and its confidence in the existing check stated.

## Investigation log

### Q: Is host-originated `Cancel` legal in this profile?

- Sources examined: `docs/mc-host-wire-protocol.md:256-267` (the frame-type table
  with per-type required/reserved status), `:269` (the role-invalid enumeration),
  `:273-282` (the state-invalid disposition table including the `Cancel` row at
  `:280`), `:248` (pure-header flag constraints naming `Cancel`), `:656` (which
  exempts `Cancel`, `Pong`, and `Goodbye` from the watermark because they "reference
  existing identities").
- Findings: the doc treats `Cancel` as a real frame with a defined identity rule and
  a defined no-op disposition, and it exempts it from the watermark alongside `Pong`
  and `Goodbye`. `Goodbye` is explicitly bidirectional at `:265` ("either
  direction"). `Pong` is explicitly consumer-to-host at `:262`. `Cancel` is given no
  direction at all. Since `:269` is written as an exhaustive statement of what is
  role-invalid and omits `Cancel`, the most natural reading is that `Cancel` is
  permitted in both directions, which the code contradicts.
- Missing evidence: whether the host implementation emits `Cancel`. That is 2a or 2e
  territory. If it does not, the doc should say `Cancel` is consumer-to-host and the
  code is right; if it does, the code needs an arm.
- Conclusion: needs human input. This is a specification gap, not something I can
  resolve by reading either side, and the fix differs depending on the answer.

### Q: Would adding a `Cancel` arm require `dispatch` changes too?

- Sources examined: `dispatch:1386-1558`, `cancel_key` (`:1262-1312`),
  `settle_route` (`:1623-1647`).
- Findings: yes. `dispatch` has no `Cancel` arm either, so an inbound `Cancel` would
  fall to `:1557` and retire anyway. Handling it as the doc's no-op would mean
  settling the named correlation locally, which `cancel_key` already does, but with a
  code that reflects a host-initiated cancellation rather than a local one. The
  existing `cancel_key` codes are all local (`cancelled`, `deadline_expired`,
  `caller_dropped`, `route_gone`), so a new code would be needed.
- Missing evidence: none.
- Conclusion: resolved with answer. The change would touch both classification sites,
  which reinforces that duplicating the decision at `:2067` and `:1557` is a
  maintenance hazard.
