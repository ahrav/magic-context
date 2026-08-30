# duplex-overlap-is-reached

## Discovery trigger

The transport is a duplex pair driven by one loop on one thread, and the loop carries a
comment claiming the two directions cannot starve each other. Checking whether any test
had ever put frames in flight in both directions at once turned up none. Every
shared-memory host test is strict request-response: send one frame, wait for its reply,
send the next. Under that shape the two lanes are never simultaneously loaded, so the
alternation the comment describes is never exercised and
`neither-direction-starves-the-other` would pass without evaluating anything.

## Evidence trail

- The situation is defined on state both rings expose. A frame is in flight in one
  direction when its slot is past `SLOT_PRODUCER_RESERVED` and not yet reclaimed —
  `SLOT_PUBLISHED`, `SLOT_RECEIVER_HELD`, `SLOT_RECEIVER_LEASED`, or
  `SLOT_RELEASE_PENDING`. `conservation()` counts exactly these
  (`crates/mc-shm-transport/src/backend/ring.rs:948-987`), separately per ring, so the
  overlap is one snapshot of each of `rings.first` and `rings.second` with no new
  instrumentation.
- The two rings are independent objects with independent cursors and independent random
  incarnations, created together by `DuplexRing::create` (`ring.rs:564`). Nothing
  couples their progress except the single endpoint task that drives both.
- `crates/mc-host/src/ring_transport.rs:254-259` and `:279-290` — that task: one
  `new_current_thread` runtime on one dedicated thread running `run_endpoint`.
  `:473-544` is the loop; `:476-486` is the one receive per iteration; `:538` is the one
  publish per iteration.
- The paths whose behaviour only differs under overlap. `:409-415` takes at most one
  outbound frame with a non-blocking `queue.try_recv()` after each successful receive —
  a no-op unless an outbound frame is already queued while an inbound frame arrives.
  `:592-602` services outbound frames inside the ingress-budget wait — unreachable
  unless outbound work exists while an inbound frame is held. Both are the alternation
  machinery, and both are dead code under lockstep traffic.
- Existing coverage: none. `qualified_provider_grants_activates_correlates_and_closes`
  (`crates/mc-host/tests/shm_transport.rs:189-271`) performs five
  `peer.send` calls each immediately followed by `peer.recv(BUDGET)` — activate at
  `:209-216`, commit at `:223-228`, route open at `:236-243`, the direct request at
  `:250-260`, then a goodbye at `:265`. At no point are two frames outstanding in
  opposite directions.
- The peer harness cannot express the situation. `TestShmPeer::send`
  (`ring_transport.rs:659-673`) reserves, writes, and commits in one blocking call
  with a
  two-second deadline, and `recv` (`:762-776`) polls to a deadline. Both are
  synchronous and thread-confined, so a single-threaded peer alternates by construction.
- The transport-level two-process test is single-direction:
  `two_process_zero_copy_exchange_uses_authenticated_grant`
  (`crates/mc-shm-transport/tests/ring.rs:581-618`) shares one ring, with the parent
  producing and the child consuming.

## Failure scenario

For a coverage record this section states what it means if the situation never occurs.

If `shm_both_directions_in_flight` never fires, then
`neither-direction-starves-the-other` is vacuous. Its ratio arm is defined over a window
in which both directions have work offered; with no overlap that window never opens, and
the check evaluates a condition over an empty set. Its post-pressure drain arm degrades
into a plain round-trip test, which the existing suite already performs. The campaign
reports a pass and the pass means the loop alternated between a loaded lane and an idle
one, which is the case that was never in doubt.

A never-fired marker also reports something about the harness rather than the
implementation: the peer side has no way to hold work outstanding in both directions, so
the whole duplex property is untestable until `TestShmPeer` grows independent send and
receive paths. That is worth surfacing as an explicit unreached situation rather than
discovering it as a silently trivial pass. The same absence explains why the two
blocking paths found in that record — the synchronous `reserve_until` inside
`publish_one` and the untimed `inbound.send().await` — have never been observed in a
test: neither can be entered while the other lane is idle.

## Timing windows and dependencies

The situation is instantaneous overlap, so the observation must be a pair of snapshots
taken close enough together to represent one instant. Because the two rings are
independent objects with no shared cursor, there is no atomic way to sample both, and a
naive sequential pair can report overlap that never existed if a frame completes between
the two reads. The safe construction is monotone: sample `rings.first`, then
`rings.second`, then `rings.first` again, and accept the overlap only if the first
ring's in-flight count was non-zero in **both** of its samples. That turns a possibly
stale pair into a claim about an interval during which both were non-zero.

Dependencies. A peer that can hold frames outstanding in both directions at once, which
today means either two threads or a non-blocking send and receive pair. Enough
descriptor depth that both lanes can hold a frame — depth is 8 per direction
(`ring_transport.rs:32`, `:47-50`), so this is not a constraint. No fault
injection: this
is a normal-operation situation, and every state it observes is one a healthy duplex
channel occupies constantly.

## What a test must construct

Offered load in both directions at once, observed while both are loaded. The peer needs
a shape it does not have: either a sender thread and a receiver thread over the same
attached `TestShmPeer`, or non-blocking variants of `send` and `recv` so one loop can
keep both lanes busy. Then emit `shm_both_directions_in_flight` at the point where the
monotone triple-sample above shows a non-zero in-flight count on `rings.first` and on
`rings.second` for the same interval. Both facts are ordinary states of a working
duplex channel, so the marker fires on a correct implementation and never requires a
defect. It is not the negation of any `always` check here: the violation it enables
observing — one direction making no progress — is a distinct predicate asserted
separately in `neither-direction-starves-the-other`.

Two refinements worth emitting as the same marker rather than separate ones, since both
are the same situation at different intensities: overlap while neither lane is at
capacity, which exercises the alternation at `:507-513`; and overlap while the outbound
lane is at capacity, which is the state in which `publish_one` blocks the shared thread
and is the one that makes the starvation property refutable. A campaign that only ever
reaches the first has reached the situation but not the interesting corner of it, and the
test should record which intensity it saw.

## Investigation log

### Q: Has any existing test ever had frames in flight in both directions simultaneously?

- Sources examined: `crates/mc-host/tests/shm_transport.rs:189-271`;
  `crates/mc-host/src/ring_transport.rs:254-259`, `:279-290`, `:363-453`, `:455-534`,
  `:711-777`; `crates/mc-shm-transport/tests/ring.rs:581-647`;
  `crates/mc-shm-transport/src/backend/ring.rs:536-562`, `:913-997`;
  `crates/mc-host/tests/shm_soak.rs` role and cycle structure.
- Findings: no. The host tests are uniformly lockstep, the transport's only two-process
  test is single-direction, and the soak harness measures operating-system resource
  counters across cycles rather than concurrent duplex traffic. The blocking limiter is
  `TestShmPeer`, whose `send` and `recv` are both synchronous and thread-confined, so a
  single-threaded peer cannot construct the situation at all. Confirming this also
  established that two code paths in the endpoint loop — the post-receive
  `queue.try_recv()` and the outbound service inside the ingress wait — are unreachable
  under the existing traffic shape.
- Missing evidence: whether the addon or the TypeScript client drives both directions
  concurrently in its own tests. Those suites were not examined here; the finding is
  scoped to the Rust host and transport tests. If they do overlap, the marker would fire
  there first and the harness gap would be narrower than stated.
- Conclusion: resolved with answer — the situation has zero coverage in the Rust
  suites, the harness cannot currently produce it, and its absence is the reason the
  duplex starvation property cannot yet be evaluated. Recording it as a `sometimes`
  obligation is what keeps that from being reported as a pass.
