# client-a-a-dropped-pong-is-never-observable-to-the-client

## Discovery trigger

Task 4 asked whether the client upholds the duties the protocol places on a peer,
including answering probes, and "whether a bug in the client could make a
well-behaved host retire the generation." The `Pong` path is the only probe duty
and its result is discarded.

## Evidence trail

The obligation, `docs/mc-host-wire-protocol.md:262`:

> | 8 | `Pong` | required | consumer to host; echoes Ping control identity and
> flags |

and `:281`: "| `Ping` | `0 / 0 / nonzero` | empty | client returns matching Pong
|". `Ping` is listed "required" at `:261` as the "host to consumer liveness
probe".

The client's entire implementation of that duty:

```
1387:        match header.ty {
1388:            FrameType::Ping => {
1389:                // V35: the Pong echoes the Ping's flags exactly.
1390:                let _ = self.send_control(
1391:                    FrameType::Pong,
1392:                    header.flags,
1393:                    FrameId::control(header.corr),
1394:                    None,
1395:                );
1396:            }
```

The `let _ =` at `:1390` is the finding. `send_control` returns
`Result<(), CallError>` and has four exits:

| Exit | Site | Retires? | Observable? |
| --- | --- | --- | --- |
| already retired | `:1326-1328` | n/a, already retired | benign |
| encode failed | `:1329-1335` | **no** | **no** |
| byte charge failed | `:1340-1347` | yes, `:1341` | yes |
| channel full | `:1355-1362` | yes, `:1356` | yes |

Two of the three real failures are loud because `send_control` retires the
generation itself. The encode failure at `:1329-1335` is the one that returns
`Err` without retiring, and at the `Ping` call site that `Err` goes nowhere.

For completeness, the flags are the host's own, echoed verbatim per conformance
vector V35 as the comment at `:1316-1318` explains. `validate_inbound` has already
constrained them:

```
2073:    if header.ty.is_pure_header()
2074:        && (header.len != 0
2075:            || header.flags.is_binary()
2076:            || header.flags.is_last()
2077:            || header.flags.admission_class() != Some(AdmissionClass::Normal))
2078:    {
2079:        return Err(());
2080:    }
```

so a `Ping` reaching `dispatch` has `len == 0`, binary clear, last clear, and
admission `Normal`, with priority unconstrained. `docs/mc-host-wire-protocol.md:248`
states this is deliberate: "A conforming `Ping` therefore never carries flags whose
mandated `Pong` echo the host would have to reject."

## Failure scenario

A `Ping` arrives. `encode_owned_frame` at `:1329` rejects the flag byte for a
reason `validate_inbound` did not screen. `send_control` returns
`encode_failed`. `dispatch` discards it and returns. `ring_reader_loop` checks
`retired` at `:1983`, finds it false, and continues.

The client is now silently in breach of its only liveness obligation. The host's
probe deadline runs down and the host retires the generation. Part 2a cataloged
that as `a-timely-pong-sustains-the-generation-within-a-bounded-round`; the
absence of a timely pong is the failure of that liveness property.

The client learns of the outcome only when the host's retirement arrives, as either
`connection_goodbye` (`:1397`) or `eof` (`:1987`), and by
`client-a-a-retired-generation-forgets-why-it-retired` the cause is discarded
before any new caller can read it. So the sequence is: a local encode bug causes a
remote retirement, and neither end records that a probe went unanswered.

A second, less severe variant is worth separating. A `Ping` arriving after `close`
has cancelled the token at `:711` reaches `send_control`, which succeeds because
`retired` may still be false and `control_tx` is still open, but `writer_loop` has
already broken out of its loop at `:1928`, so the frame is never written.
`send_control` returns `Ok` and the client believes it answered. This variant needs
no injected fault at all, though the host is already tearing the generation down in
that window, so the consequence is small.

## Timing windows and dependencies

The window for the primary variant is one host probe interval, which
`client.rs` does not know. `CLIENT_FRAME_TIMEOUT` is 30 seconds (`:45`), but that
bounds a frame's completion, not the probe.

Composes with `client-a-pong-egress-is-not-bounded-by-any-client-side-liveness-budget`:
that record covers a `Pong` that was accepted for transmission but stalls; this one
covers a `Pong` that was never accepted. Both end with the host retiring for a
missed probe and the client unaware.

## What a test must construct

1. Reach `send_control`'s encode branch for a `Pong`. Since I could not prove that
   branch reachable with a conforming flag byte, the honest test drives it through a
   seam: call `inner.dispatch` directly with a `Ping` header, using the same
   pattern as `a_ping_at_any_valid_priority_is_answered_with_an_exact_flag_echo`
   (`:2754-2779`), while forcing the encoder to reject. That requires either a
   failpoint in `encode_owned_frame` or a header whose flags `validate_inbound`
   would accept and the encoder would not, which is the open question below.
2. Assert the negative: no frame reached `control_rx`, `retired` is still false,
   and no counter moved. The absence of any observable is the property.
3. For the post-close variant, no fault is needed: cancel the token, then dispatch a
   `Ping`, and assert `send_control` returned `Ok` while `data_rx` and the ring
   never saw the frame.

## Investigation log

### Q: Can `encode_owned_frame` reject a flag byte `validate_inbound` accepted?

- Sources examined: `client.rs:2073-2080` (the pure-header flag gate),
  `docs/mc-host-wire-protocol.md:248` (the design intent that a conforming Ping's
  flags are always echoable), `client.rs:1329` (the encode call), and the import
  list at `:35-39` which brings in `encode_owned_frame`, `pure_header_flags`, and
  `Flags`.
- Findings: the design intent is explicit that this cannot happen for a conforming
  `Ping`, and `validate_inbound` enforces exactly the four constraints `:248`
  names. If `encode_owned_frame`'s only rejection condition is an oversize body,
  then with `Vec::new()` at `:1329` it cannot fail and the branch is unreachable.
- Missing evidence: `encode_owned_frame`'s body. It lives in `wire.rs`, which is
  sub-part 2b's scope, and I did not read it under the no-duplication constraint.
- Conclusion: unresolved, needs a `wire.rs` read that 2b owns. If the branch is
  unreachable the record should be downgraded to a lower-impact hygiene finding
  about the discarded `Result`, keeping the post-close variant. The confidence line
  is `medium` for exactly this reason.

### Q: Is the discarded `Result` at `:1390` the only swallowed control send?

- Sources examined: every `send_control` call site: `:1298` (Cancel in
  `cancel_key`, result inspected at `:1307-1309`), `:1390` (Pong, discarded),
  `:1498` (Cancel after unexpected stream data, discarded), `:1543` (Cancel after
  stream saturation, discarded), `:1579` (Goodbye for a stranded route, result
  inspected at `:1586-1589`), and `:1373` inside `send_control_wait` (mapped).
- Findings: three call sites discard. The two `Cancel` discards at `:1498` and
  `:1543` are defensible and documented as best-effort by the comments at
  `:1531-1537` and `:1481-1492`, because the caller's `OutcomeUnknown`
  classification already protects it. The `Pong` discard is different in kind,
  because no caller is protected by anything: the injured party is the host.
- Missing evidence: none.
- Conclusion: resolved with answer. `:1390` is the only discard whose failure has no
  compensating local classification, which is why it is the one worth a record.
