# attach-refuses-a-quarantined-object

## Discovery trigger

The catalog recorded this at medium confidence as a lead: the reported basis was
that `validate_lifecycle`'s snapshot tuple omits the `quarantined` field, but no
one had re-read the tuple directly. This file resolves that by direct read. The
lens is state-reachability: quarantine is documented as terminal, so every
entry point that creates a usable handle should observe it.

## Evidence trail

- `crates/mc-shm-transport/src/backend/ring.rs:2067-2098` is
  `validate_lifecycle`. Its snapshot reads exactly eight fields with
  `read_volatile` at `:2074-2085`, in order: `magic`, `layout_version`,
  `descriptor_depth`, `arena_bytes`, `max_leases`, `total_bytes`, `incarnation`,
  `lane`. The equality check at `:2086-2096` compares those same eight and
  returns `RingError::InvalidGrant` at `:2095`. **`quarantined` is not read and
  not compared.** This resolves the catalog's open question and lifts the basis
  from reported to verified (line numbers re-verified at post-#131 HEAD: the
  field reads are `:2074-2085` and the comparison is `:2086-2096`).
- `ring.rs:783-798` is `Ring::attach`. It computes the layout at `:785`, converts
  `total_bytes` at `:786`, maps at `:787`, calls `validate_lifecycle` at `:788`,
  and returns the `Ring`, wiring the two transferred eventfd doorbells
  (`:789-797`; the pre-#131 `prefault_read` step is gone from attach). There is no
  quarantine check on this path, which is consistent with the grep result: the
  only five `is_quarantined` call sites are `ring.rs:913`, `:1056`, `:1176`,
  `:1251`, and `:1337`, all per-operation.
- `ring.rs:136` shows `quarantined: AtomicU8` is a `LifecyclePage` field, so it
  is present in the very page `validate_lifecycle` reads. The omission is a
  choice of fields, not an absence of data.
- `ring.rs:2050-2063` initializes a fresh lifecycle page and sets
  `quarantined: AtomicU8::new(0)` at `:2061`, so the field is meaningful from
  creation onward.
- `packages/mc-shm-native/src/lib.rs:605-608` claims the process-wide grant
  reservation with `GrantReservation::claim`, and `:609-610` attaches the two
  rings afterwards. Ordering matters: the claim is consumed **before** the
  mapping is validated, so a failing attach releases it through
  `GrantReservation::drop` (`lib.rs:118-126`, removing both grants at `:122`)
  while a succeeding attach retains it.
- `lib.rs:616-631` inserts the `Channel` with `_reservation: Some(reservation)`
  (field declared at `lib.rs:84`), so the claim outlives attach and is held by
  the registry entry.
- `lib.rs:1308-1332` (`close`) and `:1335-1356` (`force_close`) remove the registry
  entry at `:1328` and `:1352` respectively, but only under the condition at
  `:1326-1327` and `:1350-1351`: `channel.producers.is_empty() && channel.active
  .is_empty() && channel.stranded.is_empty()`. **Correction:** the catalog's
  impact claim that the grant reservation is "held for the process lifetime" is
  too strong. An alias-free quarantined channel can be closed and its claim
  released. The claim is pinned indefinitely only when a detach already failed
  and left entries in `stranded`, which is the same condition that raised
  quarantine in the first place (`lib.rs:283-284`).

## Failure scenario

1. A detach failure or a receive-validation failure sets the flag. The two
   reachable triggers are `packages/mc-shm-native/src/lib.rs:283` and
   `ring.rs:1098`.
2. A reconnect or worker restart re-derives the same grant and calls
   `Ring::attach` (`ring.rs:783`), directly or through `RingAttachment::attach`
   (`ring.rs:697-699`).
3. `validate_lifecycle` compares its eight fields, all of which still match, and
   returns `Ok(())`. A `Ring` is returned.
4. On the addon path the grant claim taken at `lib.rs:605` is now consumed and a
   channel id is issued at `lib.rs:616-631`. The caller receives a success.
5. Every subsequent operation fails: `try_reserve` returns
   `ProducerError::Quarantined` (`ring.rs:913-915`), `try_receive` returns
   `RingError::Quarantined` (`:1056-1058`), `release` returns
   `LeaseError::Quarantined` (`:1176-1178`), and `probe` returns
   `RingError::Quarantined` (`:1337-1339`).

The consequence is a misleading success return plus a channel that can never do
work. If the original quarantine came from a failed detach, the surviving
`stranded` entries also block the registry cleanup that would release the grant
claim.

## Timing windows and dependencies

No timing window is involved. The property is a missing check on a synchronous
path, so it holds or fails deterministically for any attach against a flagged
object. It depends on `quarantine-authority-survives-peer-writes` only in the
sense that both assume the flag is trustworthy. Platform framing changed with
PR #131: the former Linux-only `/proc`-based descriptor transfer (pre-rewrite
`ring.rs:497-505`) is gone, and `RingAttachment` (`ring.rs:690-699`) now carries
already-owned descriptors with no `cfg(target_os)` gate of its own; the
remaining platform-specific code is confined to object creation and sealing
(`ring.rs:2109-2185` cfg arms).

## What a test must construct

Create a ring, publish nothing, call `ring.enter_quarantine()`, then obtain the
grant with `ring.grant()` and duplicates of the three descriptors, and call
`Ring::attach(descriptors, grant)` (post-#131 signature, `ring.rs:783`). Assert the attach returns `Err`. On the
addon side, drive the same sequence through `force_close` and a re-open of the
same descriptor pair, and assert both that no channel id is issued and that
`ACTIVE_GRANTS` (`lib.rs:93`) does not contain the grant afterwards. Reading
`ACTIVE_GRANTS` requires a test hook; the addon exposes channel counts but the
grant set is a private static, so the observable proxy today is the channel
count plus a second attach attempt expecting "shared-memory descriptor is
already attached" (`lib.rs:108`).

## Investigation log

### Q: Confirm by direct read that `validate_lifecycle` does not read `quarantined`.

- Sources examined: `ring.rs:2067-2098` read in full, including the eight
  `read_volatile` calls at `:2074-2085` and the eight-way equality check at
  `:2086-2096`; `ring.rs:126-137` for the field list of `LifecyclePage`;
  `ring.rs:783-798` for the whole attach path; and the complete
  `is_quarantined` call-site grep.
- Findings: the tuple reads eight fields and `quarantined` is not among them.
  No other read of the flag occurs anywhere on the attach path. The claim is
  confirmed.
- Missing evidence: none for this question.
- Conclusion: resolved. `validate_lifecycle` does not read `quarantined`, so
  attach admits a quarantined object. The catalog's medium confidence can be
  raised to high, and the caveat about not having re-read the tuple can be
  dropped.
