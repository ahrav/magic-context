# quarantine-gates-cover-every-storage-mutation

## Discovery trigger

An enumeration lens: list every function in `Ring` that mutates shared storage
state, then check each one against the quarantine gate. Five functions gate.
Three that mutate slot state and publish descriptors do not.

## Evidence trail

- A repository-wide grep for `is_quarantined` over `crates/` and
  `packages/mc-shm-native/src` returns exactly six hits in
  `crates/mc-shm-transport/src/backend/ring.rs`: the definition at `:1041` and
  the five gates at `:670` (`try_reserve`), `:765` (`try_receive`), `:848`
  (`release`), `:913` (`conservation`), and `:999` (`probe`). This is the
  complete gate set.
- `ring.rs:1164-1210` is `commit_reservation`. It has no gate. It writes the
  descriptor with `write_volatile` at `:1204`, stores `SLOT_PUBLISHED` at
  `:1205`, advances `arena_write` at `:1206`, and stores `published` with
  `Release` at `:1207`. **Correction:** the catalog cites `1164-1215`; the
  function ends at `:1210`.
- `ring.rs:1154-1162` is `abort_reservation`. It has no gate. It zeroes
  `reservation_len` at `:1158` and stores `SLOT_FREE` at `:1159`, returning the
  descriptor slot and its arena bytes to the free pool. **Correction:** the
  catalog cites `1150-1165`; the function is `1154-1162`.
- `ring.rs:1212-1244` is `write_reservation`, also ungated. It copies caller
  bytes into the arena at `:1235-1239`.
- The reachable callers of `abort_reservation` are all ungated:
  `ProducerReservation::write` on a write failure (`ring.rs:1343`), `commit` on
  each of its three failure paths (`:1347`, `:1353`, and `:1373` inside the
  `Err` arm), `abort` (`:1383`), and `Drop` (`:1398-1401`). So an ungated slot
  release happens on the ordinary error and drop paths, not just on an exotic
  one.
- `ring.rs:673` shows `try_reserve` calling `reclaim_completed()` after its gate
  at `:670`. `reclaim_completed` (`:1106-1152`) is called from that one site
  only, so its ungated `SLOT_FREE` store at `:1146` is reached only through a
  gated entry point. That is the one mutation path the gate set does cover
  transitively.
- `packages/mc-shm-native/src/lib.rs:248-270` is `cleanup_created_refs`. On a
  failed `detach_all` it calls `ring.enter_quarantine()` at `:259` and moves the
  references into `stranded` at `:260`, with the comment at `:255-258`: "A
  failed detach leaves JS views possibly attached to ring memory." This is the
  trigger where an ungated abort matters most, because the quarantine exists
  precisely because a JavaScript alias may still point into the arena.
- `ring.rs:348-361` (`quarantine_channel` in the addon,
  `packages/mc-shm-native/src/lib.rs:348-361`) quarantines both directions at
  `:350-351` and then walks producers at `:353-355`, calling
  `detach_producer(...)?.abort()`. The `?` means a mid-walk failure leaves later
  producers registered, and each surviving `ProducerReservation` will still
  abort ungated on drop.

## Failure scenario

1. The producer holds an open `ProducerReservation` over sequence N. The slot is
   `SLOT_PRODUCER_RESERVED` and `reservation_len` is set (`ring.rs:720-724`).
2. The peer publishes a structurally invalid frame in the other direction, or
   the addon's alias detach fails. Either raises quarantine:
   `ring.rs:807` on the receive-validation path, or
   `packages/mc-shm-native/src/lib.rs:259` on the detach path.
3. The producer calls `commit(body_len)`. `commit` performs no quarantine check,
   and `commit_reservation` performs none either, so the descriptor is written at
   `ring.rs:1204` and `published` advances at `:1207`. A frame is now published
   into a direction whose storage is considered unrecyclable.
4. Alternatively the producer drops the reservation. `Drop` calls
   `abort_reservation` (`ring.rs:1398-1401`), which stores `SLOT_FREE` at
   `:1159`. The descriptor slot and its arena range return to the free pool, and
   the next `try_reserve` may hand those exact bytes to a new frame while the
   stranded JavaScript view still points at them.

## Timing windows and dependencies

The window is the lifetime of any outstanding `ProducerReservation`, which is
caller-controlled and unbounded. It depends on quarantine being raised by a
party other than the reservation holder, which is why the two reachable triggers
matter: the receiver side at `ring.rs:807`, and the addon's alias cleanup at
`packages/mc-shm-native/src/lib.rs:259` and `:266`. `Ring` is
`PhantomData<Rc<()>>` (`ring.rs:531`) and so thread-confined, meaning a single
`Ring` handle cannot be quarantined by another thread through the same handle;
the cross-side trigger goes through the shared byte instead. This property
therefore depends on `quarantine-authority-survives-peer-writes`: if the flag
can be cleared, gating `commit` would not help.

## What a test must construct

Hold a live `ProducerReservation` from `try_reserve`, then set the flag out of
band with `ring.enter_quarantine()` on the same `Ring` (which is sufficient for
the gate question and avoids needing a second process), then assert two things.
First, `reservation.commit(len)` returns an error and the `published` cursor is
unchanged, observed through a second read of `conservation()` before quarantine
or through a direct read of `ProducerPage::published`. Second, in a separate
case, drop the reservation and assert no slot returns to `SLOT_FREE`. The second
assertion cannot use `conservation()` as its oracle, because `conservation()`
short-circuits on a quarantined ring at `ring.rs:913-924` and reports the whole
depth and arena as quarantined without reading any slot. The oracle must read
`DescriptorSlot::state` directly.

## Investigation log

### Q: Is "a reservation admitted before quarantine may still publish" the intended contract?

- Sources examined: `ring.rs:1164-1210` and `:1154-1162` for the absent gates,
  the five gate sites, `docs/mc-host-shm-transport.md:79` ("Quarantine retains
  the exact charges and permanently prevents that record's storage from being
  reused") and `:57` ("Quarantine retains charges instead of making uncertain
  storage reusable"), and the addon close ordering at
  `packages/mc-shm-native/src/lib.rs:334-361`.
- Findings: both documented sentences are unconditional and are about storage
  reuse, which is exactly what the ungated `abort_reservation` performs. Nothing
  in the code carries a comment explaining the omission, and the gated and
  ungated functions sit in the same `impl` block. The addon's own close paths
  quarantine first at `:350-351` and only then walk producers, which suggests
  the author expected quarantine to be raised before producer teardown rather
  than during it.
- Missing evidence: no plan requirement, comment, or test states whether
  in-flight reservations are meant to survive quarantine.
- Conclusion: unresolved, needs the intended close ordering stated. The evidence
  establishes that publication and slot release both proceed after quarantine;
  it does not establish whether that was a decision or an oversight.
