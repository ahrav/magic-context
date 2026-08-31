# no-framed-read-resumes-after-a-read-stop

## Discovery trigger

`frame_read.rs:5-8` assigns the interpretation of a short read to the callers:
"whether a short read is corruption or an orderly close, stays with each caller,
because the two answer those questions differently." It never states the
obligation that follows from all three helpers abandoning partial progress: after
any stop, the reader is at an unknown offset inside a frame, so no second framed
read is permitted on it. Gap G2 named this as the undocumented obligation to
establish.

## Evidence trail

All references at `1c193ae0`; the cited files are byte-identical to `d90e7811`.

No helper retains an offset across a stop:

- `read_exact`: progress is the local `filled` (`frame_read.rs:45`), incremented
  at `:58`, discarded on every `Err` path (`:49`, `:51`, `:52`, `:56`). The
  bytes already written into `buf[..filled]` are consumed from the stream and
  unrecoverable.
- `read_body`: progress is the caller's `buf`, so the partial bytes survive, but
  nothing records how many of them belong to this frame. `limited`
  (`frame_read.rs:79`) is rebuilt per call, so its residual limit is lost too.
- `drain`: progress is the local `remaining` (`:108`), decremented at `:122`,
  discarded on every `Err` path.

So after a stop the reader sits at an arbitrary offset inside a frame with no
record of where.

The host satisfies the obligation, structurally. `read_loop`
(`connection.rs:382-415`) is the only `recv` caller for the TCP channel, and
every `Err` arm returns:

```
:398        let event = match channel.recv().await {
:399            Ok(event) => event,
:400            Err(ReadClose::Cancelled) => return ReadExit::HostCancelled,
:401            Err(ReadClose::RejectedDrainFailed) => { ... return ... }
:411            Err(ReadClose::CleanEof)
:412            | Err(ReadClose::Corrupt(_))
:413            | Err(ReadClose::Io(_))
:414            | Err(ReadClose::Overloaded) => return ReadExit::Peer,
```

There is no `continue` and no fallthrough. The match is exhaustive over
`ReadClose` with no wildcard arm, so adding a variant is a compile error rather
than a silent resume. That is stronger than a test, and it is why this record's
existing-check line names a production guard instead of a test file.

The client satisfies it too, by shape rather than by exhaustiveness.
`reader_loop` (`client.rs:1890-1908`):

```
:1893        let frame = match read_active_frame(&mut read, &inner).await {
:1894            Ok(Some(frame)) => frame,
:1895            Ok(None) => { inner.retire("eof"); break; }
:1897            Err(()) => { inner.retire("protocol_violation"); break; }
```

Both non-success arms `break`. `read_active_frame`'s error type is `()`
(`client.rs:1919-1921`), so there is nothing to match exhaustively; the guarantee
rests entirely on the two `break`s.

One residual hazard sits at the transport layer rather than at a caller. `recv`
(`tcp_frame_channel.rs:96-131`) does `self.pending_drain.take()` at `:97`, before
running the drain at `:98-111`. So a failed drain leaves the stream misaligned
*and* clears the pending state that would have realigned it. `:110` returns
`Err(ReadClose::RejectedDrainFailed)`. If any future caller retried `recv` on
that error it would read the undrained body bytes as a header, with no pending
drain left. `connection.rs:401-410` is the only thing preventing it, and that arm
exists for a different reason: to preserve the queued authoritative terminal
(protocol §7.1).

## Failure scenario

A caller treats one stop class as recoverable. The most tempting candidate is
`ReadClose::Cancelled`: cancellation is not corruption, and a reader that saw
`Cancelled` because a *sibling* subsystem cancelled a shared token looks
resumable. Suppose `connection.rs:400` were changed from `return` to `continue`
under a guard like "if the generation is not itself retired".

The cancelled read abandoned `filled` bytes of a header, say 9 of 21. The next
`recv` calls `read_frame`, which reads its first header byte at
`tcp_frame_channel.rs:160-163` from byte 10 of the previous header, arms a fresh
deadline at `:169`, and reads 20 more bytes spanning the rest of that header and
the start of its body.

`decode_header` at `:188` then produces a header from bytes that are partly
header and partly body. If it decodes, `validate_inbound_header` at `:196` sees a
`len`, `ty`, `channel`, `epoch`, and `corr` chosen by the peer's body content.
The watermark check at `connection.rs:426` and the type checks at
`frame_channel.rs:62-74` will usually reject it. When they do not, the host
dispatches a frame whose identity the peer chose, on a stream it believes is
aligned.

The `RejectedDrainFailed` variant of this is worse, because the misalignment is
guaranteed rather than probable: the undrained remainder of an oversize control
body is attacker-supplied in full, so the peer can place a valid header at
exactly the resume offset.

## Timing windows and dependencies

No interleaving is required. The property is about control flow after an error,
not about a race.

The one timing-adjacent element is which stop class occurs, and each has its own
trigger: EOF from a peer close mid-frame, `DeadlineExpired` from a stalled peer,
`Cancelled` from `runtime.rs:1160` or `connection.rs:305`, `Io` from a socket
error.

## What a test must construct

The host's obligation is already enforced at compile time, so the valuable test
is the negative one at the transport layer, which no test covers:

1. Drive the reject-then-drain cycle to failure, as
   `tcp_frame_channel.rs:810-834` already does: an oversize channel-0 `Request`
   header followed by a truncated body, then `drop(client)`.
2. First `recv` returns `InboundEvent::Rejected`. Second `recv` returns
   `Err(ReadClose::RejectedDrainFailed)`. Both already asserted at `:827-833`.
3. Add the missing step: call `recv` a *third* time and assert what it does. The
   record's claim is that the caller must never do this; the test documents the
   consequence if it did, and pins `pending_drain` as cleared
   (`tcp_frame_channel.rs:97`) so a future reader cannot assume the drain is
   retried.

For the callers themselves, the cheapest durable check is not a test:

- Host: already covered by the exhaustive match. Worth an explicit comment at
  `connection.rs:398` naming the obligation, since the exhaustiveness enforces
  "handle every variant" but not "never resume".
- Client: a comment at `client.rs:1893` or a `#[must_use]`-style shape change.
  `read_active_frame` returning an opaque `ReaderStopped` type that only
  `reader_loop` can consume would make a resume unrepresentable, at the cost of a
  type for one call site.

## Investigation log

### Q: Does every caller satisfy the no-resume obligation?

- Sources examined: every `frame_read` call site from
  `grep -rn frame_read crates`, then upward to the loops that own them:
  `tcp_frame_channel.rs:96-131` (`recv`) and its sole consumer
  `connection.rs:382-415` (`read_loop`); `client.rs:1919-1980`
  (`read_active_frame`) and its sole consumer `client.rs:1890-1908`
  (`reader_loop`). Also checked `grep -n '\.recv()'` across
  `connection.rs`, `shm_provider.rs`, and `transport_provider.rs` to confirm no
  second consumer of the TCP channel exists: the matches are
  `connection.rs:398`, `connection.rs:1215` (a single bootstrap `recv`, not a
  loop), and `shm_provider.rs` sites that belong to a different transport which
  does not use `frame_read` at all.
- Findings: yes, both callers satisfy it. The host's four `Err` arms all return
  (`connection.rs:400`, `:401-410`, `:411-414`) with no wildcard, so the
  obligation is compile-time enforced. The client's two non-success arms both
  `break` (`client.rs:1894-1900`).
- Missing evidence: none for the current tree. The `shm_provider` transport was
  confirmed out of scope for this record because `grep -rn frame_read` returns
  no match in it.
- Conclusion: resolved. Every caller satisfies it, including `client.rs`. The
  host's compliance is structural; the client's is conventional and would not
  fail to compile if broken.

### Q: Is the obligation stated anywhere?

- Sources examined: `frame_read.rs:1-16` (module doc), `:21-23` (`ReadStop`
  doc), `:35`, `:63-68`, `:96-97` (per-helper docs);
  `tcp_frame_channel.rs:279-301` (the two mapping functions' docs);
  `client.rs:1982-1984`, `:1996`, `:2010-2011` (the client wrappers' docs).
- Findings: no, not as an obligation. Two documents come close and neither
  states it. `frame_read.rs:5-8` assigns short-read *policy* to callers.
  `client.rs:1982-1984` states the client's own resolution ("Every stop is fatal
  to this generation: the client resynchronizes by reconnecting, never by
  guessing where the next header begins"), which is the obligation discharged for
  one caller, in that caller's own doc. `tcp_frame_channel.rs:279-280` says EOF
  and deadline "both mean stream alignment is lost, so the generation closes
  without resynchronization", which again states one caller's resolution rather
  than the shared rule.
- Missing evidence: none.
- Conclusion: resolved. The obligation is discharged twice and stated nowhere as
  a shared contract. Since the type system cannot express it, whether the module
  doc should say so is a judgment call, recorded as the record's open question.
