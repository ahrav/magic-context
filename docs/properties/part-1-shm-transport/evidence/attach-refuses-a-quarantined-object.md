# attach-refuses-a-quarantined-object

## Discovery trigger

The catalog recorded this at medium confidence as a lead: the reported basis was
that `validate_lifecycle`'s snapshot tuple omits the `quarantined` field, but no
one had re-read the tuple directly. This file resolves that by direct read. The
lens is state-reachability: quarantine is documented as terminal, so every
entry point that creates a usable handle should observe it.

## Evidence trail

- `crates/mc-shm-transport/src/backend/ring.rs:1637-1668` is
  `validate_lifecycle`. Its snapshot reads exactly eight fields with
  `read_volatile` at `:1646-1653`, in order: `magic`, `layout_version`,
  `descriptor_depth`, `arena_bytes`, `max_leases`, `total_bytes`, `incarnation`,
  `lane`. The equality check at `:1656-1665` compares those same eight and
  returns `RingError::InvalidGrant` at `:1665`. **`quarantined` is not read and
  not compared.** This resolves the catalog's open question and lifts the basis
  from reported to verified. **Correction:** the catalog cites `1644-1666` for
  the tuple; the field reads are `:1646-1653` and the comparison is `:1656-1665`.
- `ring.rs:593-611` is `Ring::attach`. It computes the layout at `:598`, converts
  `total_bytes` at `:599`, maps at `:600`, calls `validate_lifecycle` at `:601`,
  prefaults at `:602`, and returns the `Ring` at `:603-610`. There is no
  quarantine check on this path, which is consistent with the grep result: the
  only five `is_quarantined` call sites are `ring.rs:670`, `:765`, `:848`,
  `:913`, and `:999`, all per-operation.
- `ring.rs:127` shows `quarantined: AtomicU8` is a `LifecyclePage` field, so it
  is present in the very page `validate_lifecycle` reads. The omission is a
  choice of fields, not an absence of data.
- `ring.rs:1621-1633` initializes a fresh lifecycle page and sets
  `quarantined: AtomicU8::new(0)` at `:1631`, so the field is meaningful from
  creation onward.
- `packages/mc-shm-native/src/lib.rs:523-526` claims the process-wide grant
  reservation with `GrantReservation::claim`, and `:527-528` attaches the two
  rings afterwards. Ordering matters: the claim is consumed **before** the
  mapping is validated, so a failing attach releases it through
  `GrantReservation::drop` (`lib.rs:104-112`, removing both grants at `:108`)
  while a succeeding attach retains it.
- `lib.rs:529-545` inserts the `Channel` with `_reservation: Some(reservation)`
  (field declared at `lib.rs:70`), so the claim outlives attach and is held by
  the registry entry.
- `lib.rs:935-955` (`close`) and `:958-976` (`force_close`) remove the registry
  entry at `:951` and `:972` respectively, but only under the condition at
  `:949-950` and `:970-971`: `channel.producers.is_empty() && channel.active
  .is_empty() && channel.stranded.is_empty()`. **Correction:** the catalog's
  impact claim that the grant reservation is "held for the process lifetime" is
  too strong. An alias-free quarantined channel can be closed and its claim
  released. The claim is pinned indefinitely only when a detach already failed
  and left entries in `stranded`, which is the same condition that raised
  quarantine in the first place (`lib.rs:259-260`).

## Failure scenario

1. A detach failure or a receive-validation failure sets the flag. The two
   reachable triggers are `packages/mc-shm-native/src/lib.rs:259` and
   `ring.rs:807`.
2. A reconnect or worker restart re-derives the same grant and calls
   `Ring::attach` (`ring.rs:593`), directly or through `RingAttachment::attach`
   (`ring.rs:507-509`).
3. `validate_lifecycle` compares its eight fields, all of which still match, and
   returns `Ok(())`. The mapping is prefaulted and a `Ring` is returned.
4. On the addon path the grant claim taken at `lib.rs:523` is now consumed and a
   channel id is issued at `lib.rs:529-545`. The caller receives a success.
5. Every subsequent operation fails: `try_reserve` returns
   `ProducerError::Quarantined` (`ring.rs:670-672`), `try_receive` returns
   `RingError::Quarantined` (`:765-767`), `release` returns
   `LeaseError::Quarantined` (`:848-850`), and `probe` returns
   `RingError::Quarantined` (`:999-1001`).

The consequence is a misleading success return plus a channel that can never do
work. If the original quarantine came from a failed detach, the surviving
`stranded` entries also block the registry cleanup that would release the grant
claim.

## Timing windows and dependencies

No timing window is involved. The property is a missing check on a synchronous
path, so it holds or fails deterministically for any attach against a flagged
object. It depends on `quarantine-authority-survives-peer-writes` only in the
sense that both assume the flag is trustworthy. It is independent of platform
except that `RingAttachment` and the descriptor-transfer path are Linux-only
(`ring.rs:497-502` and `:504-505`), so on macOS the attach path is reachable
only through `Ring::attach` directly.

## What a test must construct

Create a ring, publish nothing, call `ring.enter_quarantine()`, then obtain the
grant with `ring.grant()` and a duplicate of the descriptor, and call
`Ring::attach(fd, grant, scheduling)`. Assert the attach returns `Err`. On the
addon side, drive the same sequence through `force_close` and a re-open of the
same descriptor pair, and assert both that no channel id is issued and that
`ACTIVE_GRANTS` (`lib.rs:79`) does not contain the grant afterwards. Reading
`ACTIVE_GRANTS` requires a test hook; the addon exposes channel counts but the
grant set is a private static, so the observable proxy today is the channel
count plus a second attach attempt expecting "shared-memory descriptor is
already attached" (`lib.rs:93`).

## Investigation log

### Q: Confirm by direct read that `validate_lifecycle` does not read `quarantined`.

- Sources examined: `ring.rs:1637-1668` read in full, including the eight
  `read_volatile` calls at `:1646-1653` and the eight-way equality check at
  `:1656-1665`; `ring.rs:118-136` for the field list of `LifecyclePage`;
  `ring.rs:593-612` for the whole attach path; and the complete
  `is_quarantined` call-site grep.
- Findings: the tuple reads eight fields and `quarantined` is not among them.
  No other read of the flag occurs anywhere on the attach path. The claim is
  confirmed.
- Missing evidence: none for this question.
- Conclusion: resolved. `validate_lifecycle` does not read `quarantined`, so
  attach admits a quarantined object. The catalog's medium confidence can be
  raised to high, and the caveat about not having re-read the tuple can be
  dropped.
