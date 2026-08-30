# Targeted lens: gaps G3, G4, G5

Queued by `portfolio-evaluation.md` after the Part 2a evaluation. Three gaps, six
records. Every line reference below was read at HEAD before it was written, and
the corrections are stated where the prompt's numbers were approximate.

Scope of this pass: normal configured liveness (`connection.rs`, `config.rs`),
canonical manifest evolution (`generation.rs`), and the Darwin exchange plus the
portable rename fallback (`generation.rs`, `.github/workflows/ci.yml`).

## Line-reference corrections

The prompt's references are accurate except for these, which are narrowed:

- `liveness_loop` spans `connection.rs:1345-1478`, confirmed. Its spawn site is
  `connection.rs:291-300`, gated on `if let Some(policy) = shared.liveness`.
- The probe insert is `connection.rs:1403-1411`, confirmed.
- The `Pong` arm is `connection.rs:500-540`, confirmed; the park branch is the
  single line `:535`.
- `LivenessPolicy` is `config.rs:234-245`, not `234-300`. The `liveness` field is
  `config.rs:282`, its default `None` is `config.rs:296`, and validation is
  `config.rs:370-382`.
- The manifest structs are `generation.rs:138-145` (`ManifestFile`) and
  `:147-169` (`GenerationManifest`), with `canonical_bytes` at `:172-174` and
  `digest` at `:176-178`. The prompt's `147-177` covers both correctly.
- `exchange_dirs` is `generation.rs:1191-1198` (macOS and Linux arm) and
  `:1200-1205` (the fail-closed stub), so the prompt's `1191-1204` is right.
- `rename_no_replace` is `generation.rs:1207-1242`: doc comment `:1207-1215`,
  body `:1216-1242`.
- The golden test is `generation.rs:1395-1412`, confirmed.

## G3 observations: normal configured liveness

### O1. The whole probe path is opt-in, and nothing in the crate opts in

`config.rs:282` declares `pub liveness: Option<LivenessPolicy>` with the doc
"`None` sends no Pings at all". `config.rs:296` defaults it to `None`. The only
`liveness: Some(..)` inside the crate's own source is `config.rs:664`, which is
in the `#[cfg(test)]` module. `connection.rs:291` gates the entire
`liveness_loop` spawn on that option. So both G3 records are
`explicit-config-only`, as the evaluation established for the existing ping
records.

One qualifier the earlier revision did not state: the integration test
`tests/client.rs:97-102` also sets it, through `TestHost::start_with`
(`tests/support/mod.rs:592`). That is still test code, so the label does not
change, but it means the path is exercisable today without new infrastructure.

### O2. The loop's bound is three code-stated quantities, not "eventually"

`liveness_loop` bounds itself entirely in `policy` units:

- `connection.rs:1346` arms the first tick at `Instant::now() + ping_interval`.
- `:1355-1364` computes the wake as the minimum of the next tick and the
  earliest `probe.sent + pong_deadline` over probes whose `written_at` is set.
- `:1370-1375` marks a probe expired when
  `now.duration_since(probe.sent) >= pong_deadline`.
- `:1376-1379` retires on expiry, and only when `invalidate_on_missed` is true.
- `:1399` re-arms the tick at `now + ping_interval`.

`config.rs:370-382` rejects a zero `ping_interval` or `pong_deadline`, so both
bounds are strictly positive in any accepted configuration. That gives a
liveness check a legitimate finite window: one probe round completes or retires
within `pong_deadline` of write completion, and the next Ping is issued no
earlier than one `ping_interval` after the previous tick.

### O3. `sent` is re-anchored at write completion, so queueing delay is not
charged to the peer

The insert at `:1403-1411` sets `sent: Instant::now()` and `written_at: None`.
The write-completion hook at `:1421-1447` overwrites `probe.sent` with
`completed_at` and sets `written_at`. Until then, `:1355-1359` filters the probe
out of the deadline wake and `:1370-1373` filters it out of the expiry scan. The
read loop's `Pong` arm mirrors this: with completion recorded it applies the
deadline (`:1519-1526` region, concretely `connection.rs:520-527`), and with
completion unknown it parks the arrival at `:535` rather than judging it.

The comment at `:528-534` names the reason: "a Ping queued behind large frames
would otherwise have its answer rejected before it was even written". So the
design intent is explicit, and no test constructs the parked-arrival state.

### O4. The host writer has no control lane, so a Ping really does queue behind
application bytes

`frame_channel.rs:761` shows `FrameSender` holding a single
`mpsc::Sender<QueuedOutboundFrame>`, created at `:862` with capacity
`queue_frames`. There is no priority queue, no reserved control slot, and no
second channel. `connection.rs:181` passes `shared.limits.writer_queue_frames`,
default 64 (`config.rs:141`). The client side does reserve control slots
(`client.rs:954` names a `queue_budget` so "ordinary data traffic can never
starve a Pong"), but the host's Ping has no equivalent.

So "a saturated application stream cannot block the probe" is **not** true by
construction at the queue level. What is true is O3: the deadline is anchored at
completion, so queueing delay does not count against the peer.

### O5. The sharpest finding in this pass: Ping admission timeout retires the
generation regardless of `invalidate_on_missed`

`liveness_loop` sends the Ping through `gen.writer.send(...)` at
`connection.rs:1449-1455`. `FrameSender::send` (`frame_channel.rs:779-781`)
delegates to `send_before` with `self.admission_deadline()`, which is
`Instant::now() + self.admission_timeout` (`:783-785`). `connection.rs:178-186`
constructs the channel with `shared.timing.frame_deadline` in that position,
default 30 seconds (`config.rs:224`).

The admission timeout arm is `frame_channel.rs:819-823`:

```
Err(_) => {
    self.retired.cancel();
    self.generation.cancel();
    Err(WriterGone)
}
```

So if the Ping cannot be admitted to the 64-slot queue within `frame_deadline`,
the generation token is cancelled. `liveness_loop` then sees `sent.is_err()` at
`:1457` and returns, but the retirement has already happened inside the sender.

This bypasses the documented safety valve. `config.rs:236-238` states that
`invalidate_on_missed` "stays `false` until the raw Rust historian client can
answer Ping ...; enabling it before then would kill healthy long-running awaits
(protocol §9.3)". With `invalidate_on_missed: false` the missed-Pong retirement
at `:1376` is disabled, but the admission retirement at
`frame_channel.rs:820-821` is not. A generation whose peer answers every Ping
correctly is retired anyway if application egress keeps the queue full for one
`frame_deadline`.

The window needs the peer to be reading, just slowly: if the peer stops reading
entirely, a single dequeued write exceeds `frame_deadline` and the writer retires
the generation on its own, which `config.rs:204-206` documents as intended. The
uncovered case is a peer that drains fast enough that no individual write times
out while the 64-slot queue stays continuously full.

### O6. What `tests/client.rs:97-145` actually covers

`stream_order_and_slow_consumer_do_not_block_ping_or_unary` configures
`ping_interval: 20ms`, `pong_deadline: 80ms`, `invalidate_on_missed: true`
(`:99-103`). It opens a route, starts a `stream_then_hang` stream with two items
(`:112-121`), reads both items (`:123-135`), sleeps 150ms (`:137`), then issues a
unary echo request and asserts it succeeds (`:138-146`).

What it proves, indirectly: across roughly seven ping intervals the generation
was not retired, because a retired generation would fail the unary request. That
does establish that a real client answers Pings inside an 80ms deadline while a
handler is parked.

What it does not prove, and this is the reason G3 is still a gap:

1. **No direct oracle.** It never observes a Ping, a Pong, the pings map, or a
   retirement. If the liveness loop returned immediately at `:1457` because the
   Ping was never admitted, or never spawned at all, the assertion at `:143`
   still passes. The test cannot distinguish "probing worked" from "probing never
   happened".
2. **The name overstates the fault.** `stream_then_hang`
   (`tests/support/mod.rs:492-501`) streams its items and then awaits
   `std::future::pending()`. The client consumed both items before the sleep, so
   the writer queue is empty during the observed window. There is no slow
   consumer and no egress saturation. The hang is in the **handler**, not in the
   consumer.
3. **No retirement direction.** Nothing anywhere asserts that a *missed* Pong
   retires the generation. `tests/lifecycle.rs:468` covers an unmatched Pong,
   which is the opposite direction.
4. **No parked-arrival state.** O3's `written_at: None` branch at `:535` is never
   reached, because a 20ms tick on an empty queue completes its write long before
   any Pong can arrive.

So the honest verdict is `partial`, and the part it covers is the one direction
that a happy-path integration test covers by accident.

## G4 observations: canonical manifest evolution

### O7. The digest is the directory name, and validation re-derives it twice

`generation.rs:172-174` defines `canonical_bytes` as `serde_json::to_vec(self)`,
so the byte order is exactly the struct declaration order at
`:153-168`: `schema`, `target`, `release_contract_sha256`,
`inputs_lock_sha256`, then `source_payload_manifest_sha256` when present, then
`files`. Within `files`, each entry serializes in `ManifestFile` declaration
order at `:141-144`: `path`, `mode`, `size`, `sha256`. `:176-178` names the
generation by the SHA-256 of those bytes.

`validate_in_dir` enforces the binding twice (`generation.rs:636-648`):

```
if hex(&sha2::Sha256::digest(&bytes)) != digest { ... }
if manifest.canonical_bytes() != bytes { ... }
```

The second check is the one that makes declaration order a compatibility
contract rather than a cosmetic detail. Its own comment (`:640-647`) explains
that without it a manifest stored under the hash of non-canonical bytes would
give one logical manifest two identities.

### O8. The failure mode is fail-closed, not silent

The prompt's framing was that reordering "would silently change every retained
generation's digest". Verified and corrected: the digest change is not silent.
Reordering a field changes `canonical_bytes()` for the decoded manifest while the
bytes on disk keep the old order, so `:645` fails with
`invalid("manifest is not canonically encoded")` for every retained generation
whose manifest contains the moved field. The result is a refusal, not a
mis-selection.

That is the same class of break the `source_payload_manifest_sha256` doc comment
at `:157-165` was written to avoid: "requiring it would decode every retained
predecessor as corrupt and fail the first no-`--payload-dir` start after an
upgrade with `native_payload_invalid` -- refusing a payload that is intact."
Reordering reaches the same outcome by a different route.

Both consequences are real and they are different properties:

- Staging the same logical content under a reordered struct computes a different
  digest, so it lands in a new directory and content-addressed deduplication
  silently stops deduplicating.
- Validating a retained generation under a reordered struct fails closed.

### O9. Existing protection is real but blind in three specific ways

`generation.rs:1395-1412`
(`a_generation_staged_before_the_source_digest_field_still_decodes`) asserts

```
assert_eq!(decoded.canonical_bytes(), predecessor);
```

against the literal fixture at `:1401`:

```
{"schema":1,"target":"linux-x64-gnu","release_contract_sha256":"aa","inputs_lock_sha256":"bb","files":[]}
```

That is a genuine byte-exact golden vector, and it does pin the relative order of
the four leading scalar fields and `files`. It is the only such vector in the
crate. Its blind spots:

1. **The optional field's position is unpinned.** The fixture omits
   `source_payload_manifest_sha256`, and `:166` marks it
   `skip_serializing_if = "Option::is_none"`, so moving it anywhere in the struct
   leaves this test green while changing the bytes of every generation that has
   it.
2. **`ManifestFile`'s field order is unpinned.** `files` is `[]`, so permuting
   `path`, `mode`, `size`, `sha256` at `:141-144` leaves this test green while
   changing the bytes of every generation with at least one file, which in
   practice is every real one.
3. **No digest is asserted.** The test compares bytes only. No test anywhere
   asserts a hardcoded SHA-256 for a known manifest, so nothing catches a change
   in the hash input or the hex encoding.

Also verified: adding a *required* field would break this test, because
`deny_unknown_fields` plus a missing field makes the fixture fail to decode. So
the existing vector does defend against the crudest mistake. It does not defend
against the two mistakes a careful author is most likely to make, which are
inserting an optional field in a natural-reading position and tidying
`ManifestFile`.

## G5 observations: Darwin lifecycle and the portable rename

### O10. macOS compiles the exchange and never runs it

`generation.rs:1191-1198` gives Linux and macOS one shared arm:

```
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn exchange_dirs(dir: &OwnedFd, a: &str, b: &str) -> Result<(), GenerationError> {
    rustix::fs::renameat_with(dir, a, dir, b, rustix::fs::RenameFlags::EXCHANGE)
        .map_err(|_| invalid("atomic digest-target exchange failed"))
}
```

with `:1200-1205` failing closed elsewhere. The doc comment at `:1191-1193`
states the mapping: Linux `renameat2(RENAME_EXCHANGE)`, macOS
`renameatx_np(RENAME_SWAP)`. Those are different kernel calls with independently
documented behaviour, reached through one Rust expression.

CI's macOS job (`.github/workflows/ci.yml:126-184`, matrix at `:132`) runs on
macOS exactly four mc-host steps:

- `:156` `cargo build -p mc-host` (build only, no test binaries)
- `:178` `cargo nextest run -p mc-host --test shm_soak`
- `:179-181` `cargo test -p mc-host --lib
  shm_provider::tests::platform_preflight_is_side_effect_free`
- `:182-183` `cargo test -p mc-host --doc`

No `--test lifecycle`, no `--test client`, no `--test activation`, and the only
`--lib` invocation is filtered to one `shm_provider` test. The lib test binary is
*compiled* on macOS by that filtered run, so a macOS type or cfg error would
surface, but no `generation` or `lifecycle` test body executes. The step comment
at `:171-174` says so in its own terms: the macOS job proves "side-effect-free
omission (R15), not active parity".

So the macOS `RENAME_SWAP` call has never been observed to execute. Its call site
is `generation.rs:905`, inside `promote_temp`, reached only when the digest target
is occupied by a corrupt unprotected generation (`:886-905`).

### O11. The portable fallback is dead on Linux and load-bearing on macOS

`rename_no_replace` (`generation.rs:1216-1242`) has a Linux-only flagged block at
`:1217-1230` that returns on `Ok`, `EXIST`, `NOTEMPTY`, and `NOSPC`, and falls
through only on `INVAL`, `NOSYS`, or `OPNOTSUPP`. On a current Linux kernel with
ext4, tmpfs, or overlayfs, `RENAME_NOREPLACE` is supported, so the fallback at
`:1231-1241` never executes.

On macOS the `#[cfg(target_os = "linux")]` block is absent entirely, so the
fallback is the **only** path. Combined with O10, that means the check-then-act
sequence is simultaneously the live production path on one supported platform and
unobserved on every platform.

The sequence is a textbook check-then-act:

```
match rustix::fs::statat(dir, to, AtFlags::SYMLINK_NOFOLLOW) {
    Ok(_) => return Ok(false),
    Err(rustix::io::Errno::NOENT) => {}
    Err(_) => return Err(invalid("generation target stat failed")),
}
match renameat(dir, from, dir, to) { ... }
```

### O12. The fallback cannot deliver the guarantee its caller documents

`promote_temp`'s doc comment at `generation.rs:865-876` states the requirement
explicitly:

> The rename must not replace: POSIX `renameat` succeeds when the target is an
> existing empty directory, so a plain rename would silently destroy a protected
> occupant that had been corrupted into an empty directory before the protection
> check below ever ran.

The fallback's own comment at `:1211-1215` acknowledges the gap and justifies it
by serialization:

> Filesystems that reject `renameat2` flags, and platforms without them, fall
> back to checking occupancy first; that check is sound here because every
> mutating entry point holds `transaction.lock`, so no other participant in the
> trust model creates the target concurrently.

Two things are true at once. The flagged Linux path enforces "must not replace"
unconditionally, because `RENAME_NOREPLACE` makes the occupant's emptiness
irrelevant. The fallback path enforces it only for the interval between the
`statat` and the `renameat`, and only against actors inside the trust model. An
empty directory that appears at `to` in that window is silently replaced, which
is exactly the outcome `:868-871` says must not happen.

The justification is a prose claim about `transaction.lock`
(`lifecycle.rs:44`, `:495-496`, `:534`), not a mechanism in
`rename_no_replace` itself. The lock excludes other lifecycle participants. It
does not exclude anything outside the trust model that can write into the
generations directory, and the store's own threat model elsewhere assumes hostile
planting is possible: `validate_in_dir` at `:669-678` documents a directory
replacement attack against the walk in detail, and
`validation-and-enumeration-address-one-directory-object` in the catalog records
two shipped defects from that class. So the store defends against planted
replacements in the validation path while relying on the lock in the rename
path.

Nothing in the crate tests the fallback on any platform. On Linux the branch is
unreachable without a filesystem that rejects `renameat2` flags, and no test
supplies one.

---

# Catalog records

Six records, in the METHOD.md schema, ready for synthesis into `catalog.md`.
Group placement: the two G3 records belong in Group B beside the existing ping
and pong records. The four store records belong in Group F.

## Group B additions

### a-timely-pong-sustains-the-generation-within-a-bounded-round

Type: liveness
Reachability: explicit-config-only
Status: active
Exercised: partial — `tests/client.rs:97-145` keeps a generation alive across
roughly seven ping intervals with a real answering client, but asserts only that
an unrelated unary request later succeeds. It observes no Ping, no Pong, and no
retirement, so it passes unchanged if the probe never runs at all. No test covers
the retirement direction.
Guarantee: For a configured policy, a peer that answers each Ping within
`pong_deadline` of that Ping's write completion keeps its generation
uncancelled indefinitely; and when `invalidate_on_missed` is set, a peer that
does not answer has its generation cancelled within one `pong_deadline` of write
completion.
Check: `always` — under paused virtual time, for a policy with a chosen
`ping_interval` and `pong_deadline`: (a) answer every Ping strictly inside
`pong_deadline` measured from the write-completion instant recorded at
`connection.rs:1443`, advance the clock by `k * ping_interval + pong_deadline`
for a fixed small `k`, and assert `gen.token` is not cancelled and exactly `k`
Pings were written; (b) with `invalidate_on_missed: true`, answer nothing,
advance to `write_completion + pong_deadline`, and assert `gen.token` is
cancelled; and assert it is *not* cancelled at `write_completion + pong_deadline
- 1ns`. `always` because the two directions are the dual outcomes of one
predicate, `expired` at `connection.rs:1370-1375`, and both must hold at every
evaluation of the loop.
Fault/timing angle: the bound is stated in the units the code bounds, so this is
a finite check rather than an unbounded "eventually". The wake is the minimum of
the next tick and the earliest `probe.sent + pong_deadline`
(`connection.rs:1355-1364`); expiry is `>= pong_deadline` from `probe.sent`
(`:1370-1373`); the tick re-arms at `now + ping_interval` (`:1399`).
`config.rs:370-382` rejects a zero value for either, so both bounds are strictly
positive in any accepted configuration. The subtle part is which instant
`probe.sent` holds: the insert at `:1403-1411` records the enqueue instant with
`written_at: None`, and the write-completion hook at `:1421-1447` overwrites it
with `completed_at`. Probes with `written_at: None` are excluded from both the
deadline wake (`:1358`) and the expiry scan (`:1372`), so queueing delay neither
expires a probe nor arms one. Both halves need paused time; wall-clock sleeps
cannot distinguish the boundary from scheduler noise.
Required faults and enabling state: a configured `LivenessPolicy`, which no
shipped configuration supplies. For (a) a cooperative peer, which the in-crate
duplex harness at `connection.rs:1480` onward already provides. For (b) a peer
that reads but never sends a Pong, plus `invalidate_on_missed: true`. Paused
tokio time for both. No adversary and no concurrency campaign.
Confidence: high — [evidence](evidence/a-timely-pong-sustains-the-generation-within-a-bounded-round.md). Every bound was read at HEAD and the two `sent` anchors were
traced through both writers of the field.
Existing check: partial. `tests/client.rs:97-145` covers direction (a) with an
indirect oracle, and is the only place in the crate where a full client answers a
host Ping. `tests/lifecycle.rs:468` covers an *unmatched* Pong, not a missed one.
Nothing covers direction (b).
Impact: the probe exists to detect a peer that has stopped reading. If (a) fails,
healthy long-running work is killed, which is the exact outcome
`config.rs:236-238` cites as the reason `invalidate_on_missed` defaults to
`false`. If (b) fails, a dead peer holds a generation, its route registrations,
and its egress budget for the life of the process.
Open questions:
- Should the retirement bound be stated from write completion or from Ping
  issuance? The code anchors on completion (`:1443`), so a Ping stuck in the
  queue extends the wall-clock time to retirement without bound while keeping the
  `pong_deadline` bound intact. That is the intended anchor per `:528-534`, but it
  means no bound exists on *total* time to detect a dead peer.

### slow-egress-alone-does-not-retire-a-probed-generation

Type: reachability
Reachability: explicit-config-only
Status: active
Exercised: not yet — no test fills the writer queue while liveness is configured.
Guarantee: Application egress backpressure, on its own, never retires a
generation whose peer is answering Pings, and in particular never retires one
when `invalidate_on_missed` is `false`.
Check: `sometimes` — a constant marker `probe_queued_behind_saturated_egress`
fires when all of these independent, legal preconditions hold at one instant: a
`LivenessPolicy` is configured; `invalidate_on_missed` is `false`; the writer
queue holds `writer_queue_frames` admitted frames; and a Ping tick is due. A
second constant marker `pong_parked_pending_write_completion` fires when a
matching Pong is observed while `probe.written_at.is_none()`, which is the park
branch at `connection.rs:535`. `sometimes` rather than `reachable` because a
campaign can execute those lines while never producing the operational state:
line coverage of `:535` proves the branch compiled and ran, whereas the property
needs a full queue coinciding with a due tick, which is situation coverage. Both
markers assert only legal preconditions, so they still fire against a correct
implementation; neither asserts a retirement, an expiry, or any violation.
Fault/timing angle: the window exists because the host writer has no control
lane. `frame_channel.rs:761` holds a single
`mpsc::Sender<QueuedOutboundFrame>`, created at `:862` with capacity
`queue_frames`, default 64 (`config.rs:141`, passed at `connection.rs:181`).
There is no reserved control slot, unlike the client, which reserves one
(`client.rs:954`). Two distinct consequences follow, and only the first is
handled. First, a Ping queued behind application frames is deadline-anchored at
completion (`connection.rs:1443`) and its Pong is parked rather than judged
(`:528-535`), so queueing delay is not charged to the peer. That is correct and
deliberate. Second, and unhandled: the Ping's *admission* is bounded.
`gen.writer.send(...)` at `:1449` reaches `FrameSender::send`
(`frame_channel.rs:779-781`), which passes `admission_deadline()`, that is
`now + admission_timeout` (`:783-785`), and `connection.rs:178-186` supplies
`shared.timing.frame_deadline` there, default 30 seconds (`config.rs:224`). The
timeout arm at `frame_channel.rs:819-823` calls `self.retired.cancel()` and
`self.generation.cancel()`. So a Ping that cannot be admitted within
`frame_deadline` retires the generation from inside the sender, before
`liveness_loop` observes `sent.is_err()` at `:1457`. This bypasses
`invalidate_on_missed` entirely: the missed-Pong retirement at `:1376` is gated
on that flag and the admission retirement is not.
Required faults and enabling state: a configured `LivenessPolicy` with
`invalidate_on_missed: false`; a handler producing frames faster than the peer
drains them so all 64 slots stay occupied; and a peer that keeps reading fast
enough that no single dequeued write exceeds `frame_deadline`, since a peer that
stops reading is retired by the write deadline on its own, which
`config.rs:204-206` documents as intended. Paused time makes the 30 second window
cheap. The second marker needs only a Ping enqueued behind at least one unwritten
frame plus a prompt Pong.
Confidence: high — [evidence](evidence/slow-egress-alone-does-not-retire-a-probed-generation.md). The admission path was traced from the Ping send through the
cancel calls, and the absence of a host-side control lane was confirmed by
reading the whole `FrameSender` and its constructor.
Existing check: none. `tests/client.rs:97-145` is named
`stream_order_and_slow_consumer_do_not_block_ping_or_unary`, but its
`stream_then_hang` handler (`tests/support/mod.rs:492-501`) streams two items
that the client consumes before the observed window, so the queue is empty
throughout and there is no slow consumer. The hang is in the handler.
Impact: the documented safety valve does not hold. `config.rs:236-238` states
that `invalidate_on_missed` stays `false` because enabling it "would kill healthy
long-running awaits (protocol §9.3)". An embedder that configures a policy with
the flag off, believing invalidation is disabled, still loses generations to
egress backpressure. The failure looks like a transport reset to both sides, and
per `authentication-and-capacity-rejections-are-observable` there is no channel
to report it.
Open questions:
- Is retiring on Ping admission timeout intended? The admission timeout is a
  general frame-channel policy and the Ping is an ordinary caller of it, so this
  reads as an unnoticed interaction rather than a decision. If it is intended,
  `invalidate_on_missed`'s doc comment overstates what the flag disables. (needs
  human input)
- Should the host reserve a control slot as the client does? That would remove the
  interaction rather than document it, but it changes the queue accounting the
  ingress budget depends on.

## Group F additions

### manifest-canonical-bytes-and-digest-are-pinned-by-a-full-golden-vector

Type: safety
Reachability: default-production
Status: active
Exercised: partial — one byte-exact golden vector exists
(`generation.rs:1395-1412`) but its fixture omits the optional field and carries
an empty `files`, so it pins neither the optional field's position nor
`ManifestFile`'s field order, and it asserts no digest.
Guarantee: The canonical manifest encoding is fixed by a golden vector that
covers every field in the schema, so no change to declaration order can alter a
generation's bytes or its digest without a test failing.
Check: `always` — a golden test asserts a hardcoded byte string and a hardcoded
lowercase-hex SHA-256 for a fully populated `GenerationManifest`: all four
leading scalars, `source_payload_manifest_sha256` present as `Some`, and `files`
holding at least two entries so sortedness is also pinned. Assert both
`manifest.canonical_bytes() == GOLDEN_BYTES` and `manifest.digest() ==
GOLDEN_DIGEST`, and assert the fixture round-trips by decoding `GOLDEN_BYTES` and
re-encoding. `always` because the encoding is evaluated on every stage and every
validate; there is no configuration in which it is unreached.
Fault/timing angle: none. This is a static encoding contract. The mechanism is
that `canonical_bytes` is `serde_json::to_vec(self)` (`generation.rs:172-174`),
so the byte order is literally the declaration order at `:153-168` for the outer
struct and `:141-144` for each file entry, and `digest` is the SHA-256 of exactly
those bytes (`:176-178`). The optional field's `skip_serializing_if =
"Option::is_none"` at `:166` is what makes the existing vector blind to its
position: with the field absent, moving it changes nothing about the fixture's
bytes.
Required faults and enabling state: none. The check is a pure unit test with no
store, no filesystem, and no fault injection. It is the cheapest record in this
pass.
Confidence: high — [evidence](evidence/manifest-canonical-bytes-and-digest-are-pinned-by-a-full-golden-vector.md). Both structs, both encoding functions, and the existing
fixture were read at HEAD, and the three blind spots were each confirmed by
reasoning from the fixture's literal contents.
Existing check: `generation.rs:1395-1412`
`a_generation_staged_before_the_source_digest_field_still_decodes` asserts
`decoded.canonical_bytes() == predecessor` against the literal at `:1401`. It is
the only byte-exact manifest vector in the crate and it does pin the relative
order of the four leading scalars and `files`, and it does catch the addition of
a required field, because `deny_unknown_fields` plus a missing field fails the
decode. Status unaudited.
Impact: declaration order is a wire-compatibility contract that is currently
enforced by a fixture that cannot see two thirds of it. A maintainer who inserts
`source_payload_manifest_sha256` beside the other hashes for readability, or who
alphabetizes `ManifestFile`, changes the digest of every generation with files
and sees a green suite.
Open questions: None.

### a-declaration-order-change-cannot-orphan-a-retained-generation

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test validates a manifest written under one declaration
order against a binary using another.
Guarantee: A retained generation staged by an earlier release keeps validating,
and keeps its directory name, under any later release of the same schema number.
Check: `always` — for a manifest fixture whose bytes were produced under the
previous declaration order, `store.validate(old_digest)` succeeds under the
current binary. Equivalently, and cheaper: for every field of
`GenerationManifest` and `ManifestFile`, a permutation of the declaration order
that leaves the existing golden test green must be detectable by some check.
`always` because validation runs on the default start path and the schema number
does not change when a field moves, so there is no version in which the
obligation lapses.
Fault/timing angle: none, but the failure shape needed correcting. The break is
**fail-closed, not silent**. `validate_in_dir` enforces the binding twice
(`generation.rs:636-648`): first `hex(sha256(bytes)) != digest`, then
`manifest.canonical_bytes() != bytes`. Under a reordered struct the on-disk bytes
still hash to the directory name, so the first check passes, and the re-encode of
the decoded manifest differs, so the second fails with
`invalid("manifest is not canonically encoded")`. The comment at `:640-647`
explains why that second check exists: without it one logical manifest would have
two identities. So reordering produces a refusal of intact payloads, which is
precisely the outcome the `source_payload_manifest_sha256` doc comment at
`:157-165` was written to avoid, reached by a different route. The second,
independent consequence is that staging the same logical content under the
reordered struct computes a different digest, so it lands in a new directory and
content-addressed deduplication stops deduplicating without any error at all.
Required faults and enabling state: none at runtime. Constructing the check needs
a fixture manifest whose bytes encode an older field order, which is a string
literal, plus a staged directory whose files match it. No fault injection.
Confidence: high — [evidence](evidence/a-declaration-order-change-cannot-orphan-a-retained-generation.md). Both equality checks were read at HEAD, and the
fail-closed conclusion was derived from them rather than assumed; the prompt's
"silently change every retained generation's digest" is corrected in the evidence
file.
Existing check: partial and narrow. The predecessor fixture at
`generation.rs:1395-1412` is the only cross-version manifest test, and it covers
one specific evolution, a field added at the end and omitted when absent. Nothing
covers a field that moves.
Impact: the first start after an upgrade reports `native_payload_invalid` for
every retained generation carrying the moved field, refusing payloads that are
byte-for-byte intact. That is the forward-compatibility break the `Option` on
`source_payload_manifest_sha256` was introduced to prevent.
Open questions:
- Should the canonical encoding be decoupled from declaration order, for example
  by an explicit field-order list or a canonical-JSON serializer, so the contract
  is stated once rather than implied by the struct? The current design makes an
  ordinary refactor a compatibility break. (needs human input)

### the-atomic-directory-exchange-is-atomic-on-every-supported-platform

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — the Linux arm has one test through `promote_temp`
(`generation.rs:1689`), and the macOS arm has never executed under observation.
Guarantee: Wherever the digest-target exchange runs, the two names are swapped
atomically inside one directory, or an error is returned and neither name is left
unoccupied; on a platform without the primitive it fails closed.
Check: `always-or-unreached` — for each supported platform, drive
`promote_temp` into the exchange branch and assert that after the call the digest
name holds the validated candidate and the temp name holds the displaced corrupt
orphan, with no observable state in which either name is absent. Also assert the
non-Linux non-macOS stub returns an error rather than succeeding.
`always-or-unreached` because the branch is optional: it is entered only when the
digest target is occupied by a corrupt unprotected generation
(`generation.rs:886-905`), so a run that never meets that condition owes nothing
and the check must not fail.
Fault/timing angle: the risk is platform divergence behind one expression.
`generation.rs:1191-1198` gives Linux and macOS a shared arm calling
`rustix::fs::renameat_with(.., RenameFlags::EXCHANGE)`, and its own doc comment
at `:1191-1193` records that this is `renameat2(RENAME_EXCHANGE)` on Linux and
`renameatx_np(RENAME_SWAP)` on macOS. Those are two different kernel interfaces
with independent semantics, error sets, and filesystem support, reached through
one line of Rust. The call site at `:905` sits between an exchange and a
revalidate-then-delete (`:907-910`), so a non-atomic or partially-applied
exchange deletes the wrong directory. `promote_temp`'s contract at `:865-876`
depends on the exchange being all-or-nothing.
Required faults and enabling state: a corrupt, unprotected generation already
occupying the digest target, plus a restage of the same digest. The existing test
`same_digest_corrupt_target_is_repaired_only_by_validated_exchange`
(`generation.rs:1689`) already builds that fixture, so the fault is available; the
missing element is executing it on macOS. On the stub platforms the check is a
compile-and-call assertion.
Confidence: high — [evidence](evidence/the-atomic-directory-exchange-is-atomic-on-every-supported-platform.md). Both cfg arms, the call site, and the whole macOS CI job were
read at HEAD; the claim that no macOS lifecycle or generation test executes is
derived from the four mc-host steps in that job rather than asserted.
Existing check: partial, Linux only. `generation.rs:1689`
`same_digest_corrupt_target_is_repaired_only_by_validated_exchange` drives the
branch. CI's macOS job (`.github/workflows/ci.yml:126-184`) runs only
`cargo build -p mc-host` (`:156`), `--test shm_soak` (`:178`), one filtered
`--lib shm_provider` test (`:179-181`), and `--doc` (`:182-183`). No `generation`
or `lifecycle` test body runs on macOS; the step comment at `:171-174` says the
job proves omission, not parity. Status unaudited.
Impact: the exchange is the store's only repair primitive for a corrupt occupant,
and it is immediately followed by a deletion. If macOS `RENAME_SWAP` behaves
differently on APFS than `RENAME_EXCHANGE` on ext4, the failure mode is deleting
a retained generation, on a platform whose lifecycle code the suite never runs.
Open questions:
- Is macOS a supported deployment target for the lifecycle store, or only a
  development platform? The cfg arm and the CI build say it is supported enough
  to compile; the test selection says it is not exercised. That decision sets
  whether this record is a real gap or a documentation fix. (needs human input)

### an-occupied-rename-target-is-never-replaced-on-the-portable-path

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — the branch is unreachable on Linux without a filesystem that
rejects `renameat2` flags, and it is the only path on macOS, where no test in this
scope runs.
Guarantee: `rename_no_replace` never replaces an occupied target, on any platform
and for any occupant, including an empty directory.
Check: `always` — plant a directory at `to`, call `rename_no_replace`, and assert
it returns `Ok(false)` and leaves both names as they were. Run the assertion for
an empty occupant and a nonempty occupant, on both the flagged Linux path and the
portable path, forcing the portable path either by a filesystem that rejects
`renameat2` flags or by extracting the fallback so it can be called directly.
`always` because the caller's contract at `generation.rs:868-871` is
unconditional, so an occupied target that gets replaced is a violation rather
than a tolerated case.
Fault/timing angle: this is a check-then-act window that is dead on one platform
and load-bearing on another. `generation.rs:1216-1242`: the Linux block at
`:1217-1230` returns on `Ok`, `EXIST`, `NOTEMPTY`, and `NOSPC`, falling through
only on `INVAL`, `NOSYS`, or `OPNOTSUPP`, so on a current kernel with ext4,
tmpfs, or overlayfs the fallback never runs. On macOS that block is absent by
cfg, so `statat` at `:1231-1235` followed by `renameat` at `:1236-1241` is the
only path. POSIX `rename` replaces an existing *empty* directory, which
`promote_temp`'s comment at `:868-871` calls out by name as the thing that must
not happen, so the flagged path and the fallback do not implement the same
guarantee. The fallback's justification at `:1211-1215` is a prose claim that
`transaction.lock` (`lifecycle.rs:44`, `:495-496`) excludes concurrent creation.
That is a claim about actors inside the trust model only, and the same file
defends against out-of-model directory replacement elsewhere: the walk comment at
`:669-678` describes exactly that attack, and the catalog's
`validation-and-enumeration-address-one-directory-object` records two shipped
defects from the class.
Required faults and enabling state: a directory appearing at the target between
the `statat` and the `renameat`. Deterministically: a failpoint between the two
calls, or an extracted fallback called with the target pre-planted. Reaching the
fallback on Linux at all needs a filesystem that rejects `renameat2` flags;
running it as the default needs macOS.
Confidence: high on the mechanism, medium on severity, since the transaction lock
does exclude the in-model actors and no out-of-model writer is demonstrated —
[evidence](evidence/an-occupied-rename-target-is-never-replaced-on-the-portable-path.md). Both branches, the caller's contract, and the lock references
were read at HEAD.
Existing check: none. No test drives the portable fallback on any platform, and
no test plants an empty directory at a digest target.
Impact: the guarantee `promote_temp` documents as mandatory, that a protected
occupant corrupted into an empty directory is never silently destroyed, is
enforced by the kernel on Linux and by a prose argument on macOS. A defect here
destroys a retained generation, which is the outcome the protection check exists
to prevent.
Open questions:
- Does anything outside the trust model have write access to the generations
  directory in a real deployment? The lock argument is sound if and only if the
  answer is no, and the store's validation path assumes the answer is yes.
  (needs human input)
- Should the fallback be removed rather than justified? If macOS is supported, it
  needs a real no-replace primitive; if it is not, the fallback is dead code on
  every supported platform and the stub at `:1200-1205` is the honest shape.
  (needs human input)
