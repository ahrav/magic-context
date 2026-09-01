# a-retired-generation-emits-nothing-and-mutates-nothing

Verified at `1c193ae0`. The catalog cites `d90e7811`; HEAD moved to the merge
commit `1c193ae0` and `git diff d90e7811 HEAD` is empty for `connection.rs`,
`dispatch.rs`, `frame_channel.rs`, and `tcp_frame_channel.rs`.

## Discovery trigger

The retirement design is fail-closed by intent: every emit path is supposed to
check the generation token, and every charge attempt is supposed to lose to it. But
the checks are hand-written at each call site rather than enforced by a type, so
"every path" is a claim about a set that has to be enumerated. Enumerating it shows
two shapes: a single-sourced charge helper that loses to the token by construction,
and a scattering of explicit `is_cancelled` prechecks whose completeness is a
grep result, not a guarantee.

## Evidence trail

- `dispatch.rs:143-168` `charge_frame_or_cancel` — the single-sourced gate. Its
  doc comment at `:138-142` states why: "five call sites ... each encoded this
  interaction by hand. A correctness fix applied to one and missed in another would
  leave those five paths with different cancellation semantics." The `biased`
  select at `:156-167` puts `:158` (the request token, when one exists) and `:159`
  `() = generation.token.cancelled() => None` ahead of the budget wait at `:160`,
  so after cancel every charge attempt returns `None`. On deadline expiry it
  escalates: `:163` `generation.token.cancel()`.
- The explicit precheck pairs, each `if gen.writer.is_retired() ||
  gen.token.is_cancelled()`: `dispatch.rs:195-197` (error terminals),
  `:265-270` (owned frames, combined with a body-length check),
  `:311-313` (buffered output), `:690-692` (the shutdown response).
- The stream paths check three conditions rather than two, adding the settlement
  race: `dispatch.rs:519-521` and `:550-552`, each
  `self.cancel.is_cancelled() || self.gen.token.is_cancelled() ||
  self.settlement.won.load(Ordering::SeqCst)`, re-tested *after* an await at
  `:508-509` and `:539-540`. `send` at `:567-573` rechecks at `:572`.
- Cancellation propagates rather than needing a per-task check: `:676`
  `() = gen.token.cancelled() => return` in the latch wait, and `:748-755`, the
  shutdown watchdog whose biased select ends on the generation token at `:751`.
- The queued-but-not-begun case is decided by the writer, not by admission.
  `frame_channel.rs:718-730` `begin_publication` is the boundary — a
  `compare_exchange(QUEUED, PUBLISHED, AcqRel, Acquire)` — and
  `tcp_frame_channel.rs:320-333` puts `:322` `() = discard.cancelled() => break`
  ahead of `queue.recv()` at `:329`. So a frame already in the queue is dropped
  with the receiver at `:400-402` rather than published.
- The two signals arrive as a pair on every peer-driven exit:
  `connection.rs:329-330` and `:319-320`, each `gen.token.cancel();` then
  `gen.writer.discard();`. That pairing is what makes a corrupt-frame close silent
  even mid-shutdown, per the comment at `:323-327`.
- Existing checks, confirmed: `tests/transport_negotiation.rs:907`
  `application_before_negotiation_retires_without_side_effects` covers one shape —
  it iterates `catalog.list`, `host.shutdown`, and `route.open` bodies sent before
  negotiation. `connection.rs:1598-1600` and `:1604-1606`
  (`shutdown_fence_queues_started_catalog_before_goodbye` and
  `..._capacity_rejection_before_goodbye`) pin the *positive* fence — a started
  producer precedes Goodbye — which is the drain direction, not this one.

## Failure scenario

The uncovered interleaving is a frame that is past every check and in the queue,
with the close decision landing between admission and dequeue:

1. An off-reader emission — a capacity rejection or a handler's response terminal —
   passes its precheck at `dispatch.rs:311`, wins its charge through
   `charge_frame_or_cancel` before the token is cancelled, and reaches
   `frame_channel.rs:814`. Admission tests `retired` only, so the frame enters the
   mpsc queue with state `QUEUED`.
2. The read loop exits peer-driven. `connection.rs:329` cancels the generation
   token. Every *later* emit now fails closed; this frame is already past that
   point.
3. The writer, parked at `tcp_frame_channel.rs:329`, wakes on the queue rather
   than on `discard` — because `connection.rs:330` has not run yet — dequeues,
   and `begin_publication` at `:336` CASes `QUEUED → PUBLISHED`.
4. Consequence: bytes reach a peer after the close decision, and no state records
   that it happened: the ticket's `PUBLISHED` state is indistinguishable from a
   legitimate publication, and nothing on the retirement path holds the ticket to
   call `FrameSendTicket::cancel` (`frame_channel.rs:747-755`) and learn
   `PossibleSend`.

The "mutates nothing" half is stronger than the "emits nothing" half. A retired
generation can still be mutated: `handle_cancel` at `dispatch.rs:1456-1463` takes
the `pending` lock and cancels entries with no token check, and the `pings` map is
mutated by the read loop at `connection.rs:504-537` before any token test. Both are
benign — cancelling an entry on a dying generation and recording a Pong arrival are
idempotent and unobservable to the peer — but they are mutations, so the property's
"mutates nothing" must be read as its Check states it: no *charge* is newly
acquired. That narrower reading is what the code enforces.

## Timing windows and dependencies

The window is between `frame_channel.rs:814` (admission succeeds) and
`tcp_frame_channel.rs:322` (the writer observes `discard`), and it is widened by
the non-atomic pair at `connection.rs:329-330`: the token is cancelled one
statement before the discard, so for that gap the fail-closed rule is enforced by
neither. It cannot be reached on a current-thread runtime, since the writer task
and the producer never interleave mid-statement there — every test in scope is
current-thread while production is multi-thread (fault class H1). A larger
`writer_queue_frames` (`connection.rs:181`) makes it likelier the writer is parked
at `recv()` with room to accept, and a larger `frame_deadline` (`:182`) widens the
charge wait during which a producer sits inside `charge_frame_or_cancel`. This
record is the negative case whose positive twin is
`retirement-discards-only-through-the-discard-token`; that record owns which token
does the stopping, this one owns whether every producer consults something.
`a-cancelled-emission-releases-every-permit-it-held` owns what happens to the
charge a failed emission was holding.

## What a test must construct

An in-flight off-reader emission concurrent with a peer-driven close (fault class
H1). Concretely: a multi-thread runtime; a handler that admits a response terminal
and then yields; a scheduling point after `frame_channel.rs:814` returns `Ok`; the
peer then sends a corrupt frame so the read loop takes `:414` → `ReadExit::Peer`;
hold the connection task between `connection.rs:329` and `:330`; release the
writer. Three oracles, asserted separately because they fail independently:

- Charge: after `gen.token.cancel()`, every `charge_frame_or_cancel` call returns
  `None`. Assert the egress budget's available bytes return to baseline, not just
  that the emit errored.
- Emission: no byte of any frame admitted at or after `:329` appears on the peer
  socket. Read the peer to EOF and compare the full byte stream, since a
  frame-count assertion passes if the wrong frame went out.
- Queue: for a frame queued before the cancel, assert `begin_publication` returned
  false — that is, the ticket ends `QUEUED` and is dropped, never `PUBLISHED`.

Coverage checks to emit: `host_emission_queued_at_cancel_instant`,
`host_charge_refused_after_cancel`, and `host_writer_broke_before_publication`.

## Investigation log

The catalog records no open question. The claim worth testing is its Confidence
line: "every emit path routes through a charge helper or an explicit
`is_cancelled` pair."

### Q: Is every path that can put bytes on the socket gated on the generation token, and is any state still mutable after cancel?

- Sources examined: `crates/mc-host/src/dispatch.rs:143-168`, `:195-197`,
  `:262-270`, `:306-313`, `:503-573`, `:668-681`, `:686-700`, `:744-757`,
  `:1371-1391`, `:1434-1463`; `crates/mc-host/src/frame_channel.rs:706-756`,
  `:760-831`; `crates/mc-host/src/tcp_frame_channel.rs:313-404`;
  `crates/mc-host/src/connection.rs:306-332`, `:418-464`, `:500-537`. Repo-wide
  `grep -n "is_cancelled\|token.cancelled" crates/mc-host/src/dispatch.rs` (19
  hits, all accounted for above).
- Findings: the emit claim holds at admission. Every path that constructs an
  outbound frame in `dispatch.rs` either goes through `charge_frame_or_cancel`,
  whose biased select loses to the token at `:159`, or carries an explicit pair at
  `:195`, `:266-267`, `:311`, or `:690`; the stream paths add the settlement race
  and, notably, *re-check after their awaits* at `:519-521` and `:550-552`, which
  is the part a hand-written check usually gets wrong. The one exception is
  `send_connection_goodbye` (`:1434-1452`), which has no token check at all — that
  is deliberate, since it is called only from the drain
  (`runtime.rs:1167-1169`) where the token is still live, but it means the set is
  "every path except the drain's own", not "every path".
  The mutation claim does not hold literally: `handle_cancel` (`:1456-1463`) and
  the Pong bookkeeping at `connection.rs:500-537` mutate a retired generation's
  maps without consulting the token. Both are idempotent and peer-invisible, and
  the record's own Check scopes the claim to charges, so this is a wording gap in
  the Guarantee rather than a defect.
- Missing evidence: no executed proof of the queued-but-not-begun case. There is
  no failpoint after `frame_channel.rs:814` and no multi-thread test in scope, so
  the one interleaving that distinguishes "fail closed" from "usually fails closed"
  is unreachable today.
- Conclusion: resolved with answer — the emit gating is complete at admission and
  the charge guarantee is enforced by a single-sourced helper; the "mutates
  nothing" phrasing overstates what the code enforces and should be read as the
  Check's narrower charge claim; and the load-bearing interleaving needs H1.
