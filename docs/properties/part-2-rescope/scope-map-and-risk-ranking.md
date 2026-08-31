# Part 2 re-scope map and risk ranking

Scoping pass only. No property records, no fixes, no source or CI edits. The
deliverable is the re-partition of the remaining Part 2 work plus the region maps
that let later lens passes cite line ranges without re-reading the new files.

Provenance: code read from `/local/home/ahrav/scratch/magic-context`, `HEAD` =
`e447c927` ("refactor(shm): trim final review leftovers"). Method contract in
[../METHOD.md](../METHOD.md).

**One provenance correction before anything else.** The task states the code tree
is on `main`. It is not. `git branch --show-current` in that worktree reports
`feat/shared-memory-release-gate-audit`, and `HEAD` is `e447c927`, which is four
commits past `ed487e11`, the last of the four refactor commits named in the task.
Three of those four extra commits (`76cd6f41`, `b5dc778e`, `e447c927`) modify
`ring_transport.rs` again. Every line reference below is against `e447c927`, not
against `ed487e11` and not against `main`. If the intended baseline was `main`,
this whole file needs re-verification. Flagged as an open question rather than
assumed away.

Every line reference below was printed from the tree at `e447c927` before being
written. Where a reference is approximate it says so. File identity claims were
made with `git rev-parse <commit>:<path>` blob-hash comparison, not by reading.

## What the refactor changed

The four commits named in the task all exist and are ancestors of `HEAD`:

| Commit | Subject |
| --- | --- |
| `0f336d3c` | `refactor(shm): collapse to fixed ring transport` |
| `d8bde128` | `feat(host): add authenticated ring setup socket` |
| `793a973e` | `build(shm): require packaged native transport` |
| `ed487e11` | `refactor(host): make ring transport mandatory` |

`ed487e11` is the structural one: 82 files changed, 1,605 insertions, 26,606
deletions. Inside `crates/mc-host/src/` it removed five files outright and renamed
a sixth:

| Path | Disposition in `ed487e11` |
| --- | --- |
| `provider_recovery.rs` | deleted, 1,153 lines |
| `tcp_frame_channel.rs` | deleted, 1,155 lines |
| `transport_negotiation.rs` | deleted, 973 lines |
| `transport_provider.rs` | deleted, 500 lines |
| `frame_read.rs` | deleted, 125 lines |
| `shm_provider.rs` -> `ring_transport.rs` | rename, similarity index **R066** |

The `R066` figure is the single most important number in this section. Git
classifies the move as a rename at 66 percent similarity, and the diff carries 381
changed lines. `shm_provider.rs` was 904 lines at `1c193ae0`; `ring_transport.rs`
is 966 lines at `HEAD`, after three further modifying commits. **This is not a
path substitution.** Any prior citation of `shm_provider.rs:<line>` must be
re-derived, not rewritten. Spot-checking the five distinct line numbers Part 1
cites confirms it: `:137` was custody state and is now `exhaustions:
AtomicU64::new(0)`; `:365` is now a `rings: DuplexRing` parameter; `:645` is now
descriptor destructuring; `:851` is now inside the inline test module. Five of five
sampled citations land on unrelated content.

Also added, and never cataloged by any part:

- `crates/mc-host/src/ring_transport.rs` (966 lines), the renamed and rewritten
  transport.
- `crates/mc-host/src/setup_socket.rs` (826 lines), a new authenticated
  setup-socket protocol with file-descriptor transfer.
- `packages/mc-shm-native/src/setup.rs` (433 lines), the peer half of that
  handshake.
- `packages/plugin/src/shared/mc-host-client/owner.ts`, a new client-side owner
  module.

Test-side collateral, verified by blob presence at `HEAD`:

| Path | Disposition |
| --- | --- |
| `crates/mc-host/tests/transport_negotiation.rs` | deleted |
| `crates/mc-host/tests/shm_transport.rs` | deleted |
| `crates/mc-host/tests/support/fake_transport.rs` | deleted |
| `crates/mc-host/tests/support/shm_process.rs` | deleted |

Those four deletions matter because prior lens work cited all of them as existing
coverage. `mc-host` now has **24** integration binaries, not the 26 that earlier
passes recorded.

The architectural consequence that drives the whole re-partition: there is now
exactly **one** frame-channel implementation. `frame_channel_contract_suite!` still
exists at `frame_channel/contract_tests.rs:415`, but it is invoked exactly once, at
`contract_tests.rs:524`, as `frame_channel_contract_suite!(RingFactory)`. The
two-implementation premise that several prior records were built on is gone.

## Current mc-host surface inventory (file, lines, coverage status)

23 files, 24,708 lines. `wc -l` at `HEAD`. Coverage status uses the scope lines of
the existing catalogs, and follows METHOD's distinction that a file cited as
*boundary context* is not thereby scoped: its properties were not mined.

| File | Lines | Coverage status |
| --- | --- | --- |
| `lifecycle.rs` | 2,497 | Part 2a scope |
| `generation.rs` | 2,101 | Part 2a scope |
| `connection.rs` | 975 | Part 2a scope |
| `panic_boundary.rs` | 66 | Part 2a scope |
| `wire.rs` | 973 | surviving 2b scope |
| `frame_channel.rs` | 807 | surviving 2b scope |
| `frame_channel/contract_tests.rs` | 701 | surviving 2b scope |
| `composite.rs` | 390 | surviving 2b scope |
| `ring_transport.rs` | 966 | **new by refactor**, never scoped |
| `setup_socket.rs` | 826 | **new by refactor**, never scoped |
| `client.rs` | 3,998 | not yet scoped |
| `dispatch.rs` | 1,539 | not yet scoped (2a boundary context) |
| `instance.rs` | 1,423 | not yet scoped (2a boundary context) |
| `runtime.rs` | 1,344 | not yet scoped (2a boundary context) |
| `control.rs` | 1,180 | not yet scoped (2a boundary context) |
| `harness_closure.rs` | 1,122 | not yet scoped |
| `auth.rs` | 1,112 | not yet scoped (2a boundary context) |
| `routing.rs` | 833 | not yet scoped (2a boundary context) |
| `config.rs` | 674 | not yet scoped |
| `handler.rs` | 604 | not yet scoped |
| `connection_file.rs` | 471 | not yet scoped |
| `lib.rs` | 87 | not yet scoped |
| `file_mode.rs` | 19 | not yet scoped |

Roll-up:

| Bucket | Files | Lines |
| --- | --- | --- |
| Part 2a scope | 4 | 5,639 |
| Surviving original 2b scope | 4 | 2,871 |
| New by refactor | 2 | 1,792 |
| **Not yet scoped by any part** | **13** | **14,406** |
| Total | 23 | 24,708 |

**13 files, 14,406 lines, are not scoped by any part.** Seven of the 13 appear in
Part 2a's boundary-context list, so they have been read, but no records were mined
from them. Remaining Part 2 work is therefore 19 files and 19,069 lines: the 13
unscoped, plus the 2 new, plus the 4 surviving-2b files that need re-verification.

Part 2a's own scope shrank: it listed five files, and `frame_read.rs` is gone,
which is why its Group J is already marked `superseded-by-refactor`.

## Salvage assessment of the part-2b lens files (per-record disposition, with counts)

The four lens files hold 36 record blocks, distributed as lens A 12, lens B 12,
lens C 12. Lens D holds no record blocks; its `###` headings are claim leads
(`L1`-`L6`), bug-history entries (`D1`-`D9`), and check inventory. That matches the
36 stated in the task exactly, so lens D is assessed separately below.

The dispositions rest on one blob-identity result, which is the load-bearing fact
of this whole section:

| File | Identity vs lens-era `1c193ae0` |
| --- | --- |
| `wire.rs` | **byte-identical to `HEAD`** |
| `composite.rs` | **byte-identical to `HEAD`** |
| `tests/composite_routing.rs` | byte-identical to `HEAD` |
| `tests/handler_contract.rs` | byte-identical to `HEAD` |
| `frame_channel.rs` | changed (882 -> 807 lines) |
| `frame_channel/contract_tests.rs` | changed (657 -> 701 lines) |
| `connection.rs`, `control.rs`, `config.rs`, `dispatch.rs`, `client.rs`, `runtime.rs`, `routing.rs`, `lifecycle.rs` | all changed |
| `tests/protocol_vectors.rs` | changed |

Lens A verified against an unnamed HEAD but reports `wire.rs` at 973 lines, which
matches `HEAD`; lens C verified against `1c193ae0`; lens D verified against
`793a973e` and already documents the working-tree divergence. `wire.rs` and
`composite.rs` never changed at all, so records resting only on those two files
keep their line references.

Disposition rule applied: **valid** = every cited subject survives and is
byte-identical, so line references hold; **invalid** = the guarantee names a
subject that no longer exists and has no surviving carrier; **needs
re-verification** = the subject survives but the file changed, or the record's
enumeration spanned a now-deleted file.

### Counts

| Disposition | Count |
| --- | --- |
| Still valid against current code | **6** |
| Invalid, subject deleted | **9** |
| Needs re-verification | **21** |
| Total | 36 |

### Still valid — 6 records worth carrying forward verbatim

These are the salvage. Line references were confirmed to still resolve because the
subject file is byte-identical.

From lens A, resting only on `wire.rs`:

1. `decode-header-is-total-over-arbitrary-bytes` (L195-242)
2. `accepted-header-decode-is-a-bijection-on-twenty-one-bytes` (L243-290)
3. `reserved-encodings-and-identity-pairings-reject-at-decode` (L291-334)
4. `encoder-never-emits-a-frame-its-own-decoder-rejects` (L430-482)

Records 3 and 4 additionally cite `tests/protocol_vectors.rs` as the existing
check, and that file changed. The property and its subject citations hold; only the
`Existing check:` line needs a re-read. That is a field-level refresh, not
re-discovery.

From lens C, resting on `composite.rs` plus `tests/composite_routing.rs`, both
byte-identical:

5. `composite-route-entry-is-removed-by-exactly-one-route-gone` (L599-636)
6. `composite-panic-containment-covers-only-optional-health-and-shutdown`
   (L637-675)

### Invalid — 9 records, subject deleted

All nine are lens C records 1 through 9. Their subjects are
`transport_negotiation.rs` and `transport_provider.rs`, both deleted:
`no-negotiation-bound-precedes-the-recursive-parse`,
`opaque-depth-walk-is-sized-by-the-body-cap-not-the-opaque-cap`,
`negotiation-family-classifier-is-structure-blind`,
`response-decoder-pins-the-constant-version-not-the-request-version`,
`encoder-cannot-refuse-an-unoffered-or-unserveable-selection`,
`encoder-refuses-exactly-what-the-decoder-refuses`,
`preflight-default-advertises-unvetted-offer-parameters`,
`provider-identity-is-the-registration-snapshot`,
`prepare-dispatch-is-unbounded-work-on-the-read-loop`.

Two carry-forward leads survive the deletion and should be handed to the new
partition rather than lost:

- Record 1's underlying obligation is that the only unbounded recursive walk of an
  untrusted channel-0 body is `strict_json::parse`. The negotiation framing is
  gone, but `control.rs` survives and still owns `parse_control`. A lens pass over
  `control.rs` should re-derive this as a fresh property; it is not the same record.
- Record 7's `Serveable`/offer-parameter machinery is gone, and both of its cited
  existing checks (`tests/support/fake_transport.rs`,
  `tests/shm_transport.rs`) are deleted. Nothing survives. No lead.

### Needs re-verification — 21 records

All 12 of lens B, 8 of lens A, and lens C record 12.

Lens A (8): `pure-header-frame-shape-is-split-across-two-gates`,
`declared-body-cap-is-not-part-of-the-decode-postcondition`,
`emitted-frame-declares-exactly-the-bytes-written`,
`header-length-version-dispatch-has-no-production-driver`,
`ingress-capacity-never-below-the-declared-body-cap`,
`ingress-budget-exhaustion-has-one-close-classification`,
`byte-charge-covers-every-copy-it-accounts`,
`documented-byte-vectors-pin-the-production-codec`. Each has its core in `wire.rs`,
which is unchanged, but each also enumerates consumers, and the consumer set was
exactly what the refactor rewrote. `header-length-version-dispatch-has-no-
production-driver` is the clearest case: `header_len_for_version` still exists at
`wire.rs:292` and still returns `Some(HEADER_LEN)` only for `PROTOCOL_VERSION`
(`wire.rs:294`), so the property is probably still true and now easier to state,
but the record's `Check:` names "the production TCP reader", which no longer
exists. The verdict survives; the wording and the enumeration do not.

Lens B (12): every record. The subject is the frame-channel abstraction and its
egress path, and `frame_channel.rs` lost 75 lines while `contract_tests.rs` gained
44. Three sub-cases worth calling out:

- `every-channel-implementation-runs-the-shared-contract-suite` needs reframing,
  not just re-checking. Its stated rationale is that "a second implementation
  cannot silently provide weaker semantics than the first", and there is no longer
  a second implementation: `contract_tests.rs:524` registers `RingFactory` alone.
  Its cited existing check `tests/support/shm_process.rs` is deleted.
- `shm-egress-progress-does-not-depend-on-inbound-arrivals` is the highest-value
  item in lens B and it transfers directly onto the new file. Its `Check:` cites
  `shm_provider.rs:55` for `POLL_INTERVAL`; the constant is now at
  `ring_transport.rs:33`. The interleaving it describes is visibly present in
  `run_endpoint`, where the ingress-budget wait services the outbound queue
  (`ring_transport.rs:501-508`).
- `oversize-control-drain-shares-the-frames-absolute-deadline` sits on
  `connection.rs`, which lost 815 lines in `ed487e11`. Its 64 MiB drain claim must
  be re-derived; `MAX_BODY_LEN` is still `64 * 1024 * 1024` via
  `wire.rs:35` and `wire.rs:371`, and the ring path rejects oversize channel-0
  requests at `ring_transport.rs:474-485`, which is a different mechanism from the
  drain the record describes.

Lens C record 12, `shutdown-error-formatting-defeats-its-own-redaction-contract`,
sits on `composite.rs`, which is byte-identical, so the redaction property itself
holds. It is in this bucket rather than the valid bucket because it enumerates
`ShutdownError` producers and two of those producers were deleted. The record's
claim survives; its producer inventory does not.

### Lens D

Not counted in the 36. It self-documents the divergence: its own preamble records
that the working tree at authoring time already held uncommitted deletions of the
files it inventories. Salvage value is asymmetric:

- The nine bug-history entries `D1` through `D9` stay valuable regardless of
  deletion. A fixed bug in deleted code is still evidence about how this team's
  transport code fails, and `D5` (recursive opaque-depth stack exhaustion) and
  `D9` (provider preparation blocking the read loop) describe failure shapes the
  new `run_endpoint` single-thread design could reintroduce.
- Claim leads `L1`, `L3`, `L4`, `L5` are about negotiation, providers, and a
  deleted fallback reason. Retire them.
- `L2` duplicates lens C record 12 and travels with it.
- The existing-check inventory is stale in its counts (26 binaries, four named) and
  must be rebuilt; see the CI section, which supersedes it.

### How much re-discovery is actually needed

Six records carry forward as-is, nine are dead, 21 need a re-read of a changed
consumer set. The 21 are cheaper than fresh discovery because the guarantee text
and the check semantics are already reasoned out and, for the eight lens A records,
the `wire.rs` core they rest on has not moved. The genuinely new work is the 1,792
lines of `ring_transport.rs` and `setup_socket.rs`, against which nothing has ever
been cataloged, plus the 14,406 unscoped lines.

## New surface region maps

Both maps were produced by scanning top-level item declarations at `HEAD` and then
reading the region endpoints back individually. An earlier scan of
`ring_transport.rs` missed both `async fn` items because the pattern did not allow
the `async` prefix; the map below is the corrected one, and `receive_one` at
`:455` is the item that scan dropped.

### `ring_transport.rs` (966 lines)

Production is `1-752`. `#[cfg(test)] mod tests` runs `753-966`, 214 lines holding
5 test functions (`:770`, `:778`, `:822`, `:830`, `:839`).

| Range | Lines | Region |
| --- | --- | --- |
| `1-30` | 30 | Module doc and `use` block. The doc states the load-bearing design claim: "One dedicated OS thread creates and owns both `!Send` ring endpoints" (`:3-4`) |
| `31-40` | 10 | Constants and the hook alias: `RING_PROFILE` (`:31`), `DESCRIPTOR_DEPTH` (`:32`), `POLL_INTERVAL` (`:33`), `pub type PublishHook` (`:39`) |
| `41-90` | 50 | Fixed geometry, no ring state: `ring_profile()` (`:41-60`), `per_connection_limits()` (`:61-74`), `process_limits()` (`:75-90`) |
| `91-123` | 33 | Types: `RingTransport` (`:91-102`), `pub(crate) PreparedRing` (`:103-113`), `RingUnavailable` with `Display` (`:116`) and `Error` (`:122`) |
| `124-232` | 109 | `impl RingTransport` accounting and diagnostics: `for_ring_profile` (`:126`), `accounting` (`:143`), `diagnostics` (`:153-208`), the four lifecycle counters `record_attachment` / `record_activation` / `record_peer_death` / `record_reclamation` (`:209-228`), `set_publish_hook` (`:229`) |
| `233-317` | 85 | `RingTransport::prepare`. Ring and worker-thread bring-up; the ownership boundary the module doc claims |
| `318-349` | 32 | Descriptor marshalling: `WireDescriptor` (`:318-323`), `worker_descriptor` (`:324-339`) returning the JSON plus `[OwnedFd; 2]`, `encode_hex` (`:340-349`) |
| `350-361` | 12 | `ShmReceiver` (`:350`) and `impl FrameReceiver for ShmReceiver` (`:354-361`). The sole surviving `FrameReceiver` implementation |
| `363-454` | 92 | `run_endpoint` (`:364`), the single worker loop. Owns the interleave of inbound receive and outbound publish, plus `discard`/`finish` handling (`:374-377`) |
| `455-535` | 81 | `receive_one`. Header decode (`:471`), `validate_inbound_header` (`:473`), oversize channel-0 `Request` rejection (`:474-485`), and the ingress-charge deadline loop that returns `ReadClose::Overloaded` (`:487-499`) while servicing queued outbound frames (`:501-508`) |
| `536-607` | 72 | Publication: `publish_one` (`:536`) with its `begin_publication` guard (`:542`), `publish_direct` (`:580`), `publish_owned` (`:595`) |
| `608-626` | 19 | `ReservationWriter` (`:608`) and its `io::Write` impl (`:610`) |
| `627-711` | 85 | `RingClientEndpoint`, doc-commented "Thread-confined peer endpoint for integration tests": `attach_with_descriptors` (`:636`), `send` (`:659`), `recv` (`:676`), `try_recv` (`:689`), `pub(crate) try_recv_with` (`:694`) |
| `712-736` | 25 | Grant decoding: `decode_grant` (`:712`), `decode_hex` (`:716`) with its inner `nibble` (`:721`) |
| `737-752` | 16 | `RingClientError` (`:737`) with hand-written `Debug` (`:739`), `Display` (`:745`), `Error` (`:751`) |
| `753-966` | 214 | `#[cfg(test)] mod tests` |

What it owns: the mandatory transport's fixed geometry, the single-owner worker
thread, inbound header validation and ingress admission, outbound publication and
reservation writing, descriptor and file-descriptor marshalling, the peer-side
attach endpoint, and the lifecycle counters that `diagnostics()` exposes.

Reachability note for a later pass, not resolved here: `RING_PROFILE` is the
string `"mc-host-test-ring-v1"` (`:31`) and `RingClientEndpoint` is documented as
being for integration tests (`:627`), yet `lib.rs:21` exports the module publicly
and `client.rs:1855` calls `attach_with_descriptors` on a path that does not look
test-gated. Whether the ring is default-production or explicit-config-only is a
per-record determination and I did not resolve it.

### `setup_socket.rs` (826 lines)

Production is `1-440`. `#[cfg(test)] mod tests` runs `441-826`, 386 lines, 47
percent of the file.

| Range | Lines | Region |
| --- | --- | --- |
| `1-23` | 23 | Module doc and `use`. The doc states a deliberate isolation claim: "no dependency on application frame types or decoders" and "Its closed message set" (`:3-5`) |
| `24-26` | 3 | `MAX_SETUP_MESSAGE_LEN` = 16 KiB (`:24`), `RING_DESCRIPTOR_COUNT` = 2 (`:25`) |
| `27-53` | 27 | `pub(crate) fn bind_owner_only` (`:27`), the listener-permission gate |
| `54-99` | 46 | The closed message set: `GrantMessage` (`:54`), `enum ClientMessage` (`:63`), `enum ServerMessage` (`:75`), `pub enum PeerClose` (`:81`), `pub enum SetupError` (`:88`) |
| `100-131` | 32 | Error plumbing: `From<io::Error>` (`:100`), `Display` (`:106`), `Error::source` (`:122`) |
| `132-236` | 105 | Grant exchange: `send_grant` (`:132-177`) and `receive_grant` (`:178-236`), the file-descriptor transfer pair |
| `237-333` | 97 | Activation: `activate_server` (`:237-287`), `activate_client` (`:288-333`) |
| `334-354` | 21 | Teardown and liveness: `goodbye_client` (`:334`), `pub(crate) encoded_goodbye` (`:340`), `observe_peer` (`:345-353`) |
| `355-429` | 75 | Framed message I/O: `read_message_unbounded` (`:355`), `read_message` (`:369`), `read_message_from_prefix` (`:388`), `write_message` (`:418`) |
| `430-440` | 11 | `encode_message` (`:430`), the 4-byte little-endian length prefix and the `MAX_SETUP_MESSAGE_LEN` cap |
| `441-826` | 386 | `#[cfg(test)] mod tests` |

What it owns: a length-prefixed, capped, closed-message-set handshake over a
`UnixStream` that authenticates one ring, transfers exactly two file descriptors,
activates, commits, and then observes peer lifetime. The `read_message_unbounded`
/ `read_message` pair at `:355` and `:369` is the obvious first target for a lens
pass, since one of the two names asserts the absence of the bound the other
enforces; I did not read far enough to say whether that is a real gap.

Production wiring, verified: `connection.rs:170` calls `activate_server`,
`connection.rs:199-200` selects on `observe_peer` and compares against
`PeerClose::Goodbye`, `client.rs:347` connects to `info.setup_socket`,
`client.rs:367` calls `activate_client`, `client.rs:1890` calls
`encoded_goodbye`. `connection.rs:27` imports `PreparedRing`, and
`client.rs:1855` calls `RingClientEndpoint::attach_with_descriptors`. So both new
files are wired into the connection path, not dormant.

### `packages/mc-shm-native/src/setup.rs` and `owner.ts`

`packages/mc-shm-native/src/setup.rs` is 433 lines, production `1-376`, tests
`377-433`. It is the peer half of the same handshake and it is *not* a mirror of
`setup_socket.rs`. It carries an authentication layer the host-side file does not
name: `NONCE_LEN` (`:15`), `PROOF_LEN` (`:16`), `DAEMON_ID_LEN` (`:17`),
`MAX_AUTH_MESSAGE_LEN` = 4096 (`:18`), and two domain-separation constants
`SERVER_PROOF_DOMAIN` = `b"subc-server-v1"` (`:20`) and `CLIENT_AUTH_DOMAIN` =
`b"subc-client-v1"` (`:21`), driving `ClientHello` (`:24`), `ServerProof` (`:30`),
`ClientAuth` (`:38`), and `fn authenticate` (`:174`) with `fn proof` (`:222`).

**Placement verdict: Part 2, not Part 5.** It is Rust, it is one half of a
two-party protocol whose other half is in `mc-host`, and the proof-and-domain
construction can only be audited against the host side. Part 1's scope line does
nominally cover `packages/mc-shm-native`, so this is a boundary that must be
stated explicitly rather than left ambiguous: I propose Part 2 owns
`src/setup.rs` because the handshake is a `mc-host` protocol, and Part 1 retains
the rest of the crate. That is a scoping decision a human should confirm.

`packages/plugin/src/shared/mc-host-client/owner.ts` is **Part 5**. It is
TypeScript in the plugin's client library. Note there are two `owner.ts` files in
the tree, `packages/plugin/src/shared/mc-host-client/owner.ts` and
`packages/plugin/src/shared/mc-host-lifecycle/owner.ts`; the refactor commits touch
the `mc-host-client` one. I did not read either file, so I am recording the
placement verdict from path and language only, not from content. `part-5a-storage`
has `_lenses/` and `evidence/` but **no `catalog.md`**, so Part 5 is mid-flight and
the owner of that assignment should confirm it rather than take it from here.

## Part 1 staleness quantified

Part 1's catalog is 2,585 lines. It cites `crates/mc-host/src/` paths **9 times**,
across **7 distinct records**. Every one of the 9 citations names a path that is
now removed or renamed. There are no other `crates/mc-host/src/` citations in the
file, so the blast radius is exactly these 7 records out of 58.

| Record | Citation | Path status |
| --- | --- | --- |
| `quarantine-charge-transition-is-atomic` | `provider_recovery.rs:187` | deleted |
| `custody-terminal-transition-exactly-once` | `shm_provider.rs:365` | renamed + rewritten |
| `custody-terminal-transition-exactly-once` | `provider_recovery.rs:167-197` | deleted |
| `custody-terminal-transition-exactly-once` | `provider_recovery.rs:811` (existing check) | deleted |
| `publish-signal-implies-committed-frame` | `shm_provider.rs:645-652` | renamed + rewritten |
| `release-failure-is-observable` | `shm_provider.rs:365` | renamed + rewritten |
| `cancelled-frame-disposition-is-declared` | `shm_provider.rs:583-585` | renamed + rewritten |
| `attach-binds-geometry-to-a-local-profile` | `shm_provider.rs:851` (existing check) | renamed + rewritten |
| `clean-reclamation-is-reachable` | `shm_provider.rs:137-152` | renamed + rewritten |

Separately, Part 1's **scope line itself** is stale. It reads "Boundary context
from `crates/mc-host/src/{shm_provider,transport_negotiation,transport_provider,
provider_recovery}.rs`". Three of those four are deleted and the fourth is renamed,
so all four names in the scope declaration are wrong.

**Recommendation: a targeted refresh pass, not a header note.** Three reasons, in
increasing order of weight.

1. A header note cannot fix the citations. The rename is `R066` with three further
   modifying commits, and five of five sampled line numbers land on unrelated
   content. There is no mechanical path rewrite that produces correct references;
   each of the six `shm_provider.rs` citations has to be re-derived against
   `ring_transport.rs`.
2. The three `provider_recovery.rs` citations have no successor file at all. The
   host-side recovery driver is gone. `ring_transport.rs` exposes
   `record_peer_death` (`:217`) and `record_reclamation` (`:221`) as the surviving
   observation surface, but that is an accounting counter, not the state machine
   the records cite.
3. Most importantly, this may be a **`Status:` change, not a citation change**, and
   only a record-level pass can tell. The good news is that the quarantine and
   custody machinery still exists in Part 1's own crate: `quarantine` or `custody`
   appears in `crates/mc-shm-transport/src/` in `arena.rs`, `backend/ring.rs`,
   `lease.rs`, `lifecycle.rs`, `profile.rs`, and `descriptor.rs`. So the transport-
   side properties are probably intact and only their host-side anchors moved. But
   `quarantine-charge-transition-is-atomic` and
   `custody-terminal-transition-exactly-once` are precisely the two records whose
   deleted citation was the *host-side driver*, and whether the property is still
   reachable without that driver is a reachability determination. METHOD rule 4
   requires reachability be verified per record at authoring time, so this cannot
   be settled in a preamble.

Scope of the refresh: 7 records, re-anchor citations and re-verify the reachability
label on the two custody records. Add a header note correcting the scope line as
well, but the note is the smaller half of the job.

## CI reality

Five workflow files: `ci.yml`, `claude-code-review.yml`, `historian-eval.yml`,
`retrieval-benchmark.yml`, `shm-hardening-optin.yml`. All references below are
`ci.yml` unless stated.

`mc-host` test execution, complete, with line references:

| Line | Command | Binary named |
| --- | --- | --- |
| `:132` | `cargo nextest run -p mc-host --test client` | `client` |
| `:133` | `cargo test -p mc-host --test shm_failure_modes -- --test-threads=1` | `shm_failure_modes` |
| `:134-135` | `cargo test -p mc-host --test shm_soak short_soak_keeps_fd_mapping_thread_and_rss_envelopes_bounded -- --exact` | `shm_soak`, **one test only** |
| `:178-179` | `cargo nextest run -p mc-host --test client --test lifecycle` (Linux) | `client`, `lifecycle` |
| `:187` | `cargo nextest run -p mc-host --test client --test lifecycle` (macOS) | `client`, `lifecycle` |
| `:190` | `cargo test -p mc-host --doc` | doctests |
| `:168` | `cargo build -p mc-shm-transport -p mc-host -p mc-shm-native` | build only |

Jobs involved: `shm-crash-recovery` (`:111`, `needs: [shm-hardening-gate]`,
Linux only) and `shm-source-build` (`:137`, matrix `ubuntu-latest`,
`macos-latest`, `macos-15-intel`).

**Verified answer to the task's question.** The refactor did add `--test
lifecycle` (`:179`, `:187`) and `--test client` (`:132`, `:179`, `:187`). The prior
finding that CI names four of the integration binaries still holds numerically, but
both terms changed: the denominator is now **24**, not 26, and the four named
binaries are `client`, `lifecycle`, `shm_failure_modes`, `shm_soak`. So **4 of 24
named, 20 unnamed**. Part 2a's `the-largest-lifecycle-proof-runs-in-ci` record can
be closed on the `lifecycle.rs` half; `tests/activation.rs` (412 lines) and
`tests/host_roundtrip.rs` (323) remain named in no workflow.

Three further CI facts that matter more than the named-binary count and that I did
not find recorded in any prior pass:

1. **`mc-host`'s inline unit tests never run in CI.** Every `-p mc-host` test
   invocation carries a `--test <name>` filter, which selects only that integration
   binary and excludes the lib target. `grep -n 'mc-host' .github/workflows/ci.yml`
   returns hits at `:87`, `:132`, `:133`, `:134`, `:168`, `:169`, `:178`, `:187`,
   `:190`, `:211`, `:361`, `:442`, `:461`, and none of them is an unfiltered
   `cargo nextest run -p mc-host` or a `--lib` run. Consequence for this
   re-partition: the 214-line test module in `ring_transport.rs:753-966` and the
   386-line module in `setup_socket.rs:441-826` are **not executed by CI**. Any
   record whose `Existing check:` points at an inline `mc-host` unit test is
   pointing at something that only runs locally.
2. **Clippy does not run in CI for any crate**, deliberately. The `check-rust` job
   (`:463`) runs exactly `cargo fmt --check` (`:485`) and `cargo check -p mc-core
   --no-default-features` (`:492`). The comment at `:481-483` states the reason:
   "Clippy would have to compile the cortexkit-* siblings, which the stubs cannot
   support, so it stays in the local lint:rust gate."
3. **A grep-level architecture gate now exists.** The `mandatory-ring-architecture`
   job (`:41`) runs `bun test scripts/check-mc-shm-architecture.test.ts` (`:55`)
   and `bun run check:shm-architecture` (`:58`), described as "Reject obsolete
   application transports and dependencies". This is the mechanism enforcing that
   the deleted transports stay deleted. I did not read the script, so I cannot say
   what it actually asserts.

`shm-hardening-optin.yml` runs `cargo fmt --check` (`:56`), `cargo check --locked`
(`:57`), and `cargo +nightly fuzz run` (`:78`); it names no `mc-host` test binary.

Not verified: whether any of these jobs are required status checks for merge. That
is repository settings, not workflow content, and I could not read it.

## Proposed partition

Five sub-parts, 19,069 lines, ordered by value. Sizing is against Part 2a's
realized 6.5k and Part 4's 7.8k-to-10k sub-parts, so every one of these is inside
a single pass with room to read adjacent tests.

**The old `2b` label is retired and its number reused.** The original `2b` scope
was seven files and four are gone, so "wire and channels" no longer names a
coherent unit. There were never any `2c`/`2d`/`2e` directories in
`docs/properties/`, so nothing else is being displaced. The five labels below are
new.

Ranking rationale: new-and-never-cataloged beats surviving-and-stale, because the
salvage analysis above shows the stale material still carries usable guarantee text
while the new material carries none. Within the new material, the mandatory
production datapath beats everything else.

### 2b-ring-datapath — the mandatory transport and the framing contract

Files: `ring_transport.rs` (966), `wire.rs` (973), `frame_channel.rs` (807),
`frame_channel/contract_tests.rs` (701).
**Lines: 3,447.** Risk rank: **1, highest.**

Rationale: this is the whole production datapath after the refactor, it contains
the only file that was renamed-and-rewritten rather than merely edited, and the
two-implementation assumption that the surviving lens material rests on has
collapsed to a single `RingFactory` registration.

Attention focuses: (a) the single-owner worker thread claim in
`ring_transport.rs:3-4` against `prepare` (`:233-317`) and `run_endpoint`
(`:363-454`), specifically whether both `!Send` endpoints really stay confined;
(b) inbound admission and close classification in `receive_one` (`:455-535`),
where the `Overloaded` deadline exit (`:487-499`) is interleaved with outbound
publication (`:501-508`); (c) the contract suite's collapse to one implementation
at `contract_tests.rs:524` and what that vacates.

Salvage input: heavy. All 12 lens B records and all 12 lens A records feed this
sub-part. Four of the six still-valid records land here
(`decode-header-is-total-over-arbitrary-bytes`,
`accepted-header-decode-is-a-bijection-on-twenty-one-bytes`,
`reserved-encodings-and-identity-pairings-reject-at-decode`,
`encoder-never-emits-a-frame-its-own-decoder-rejects`) and carry forward
unmodified. `shm-egress-progress-does-not-depend-on-inbound-arrivals` transfers
with a citation fix from `shm_provider.rs:55` to `ring_transport.rs:33`.

### 2c-setup-and-identity — the authenticated handshake and host identity

Files: `setup_socket.rs` (826), `auth.rs` (1,112), `instance.rs` (1,423),
`connection_file.rs` (471), plus `packages/mc-shm-native/src/setup.rs` (433) as the
peer half.
**Lines: 3,832 in-crate, 4,265 with the peer half.** Risk rank: **2.**

Rationale: an entirely new authenticated protocol with file-descriptor transfer,
nonce and proof construction, and domain separation, none of which any part has
cataloged, and it gates every connection.

Attention focuses: (a) the two-party proof construction, host `activate_server`
(`setup_socket.rs:237`) against peer `authenticate`
(`mc-shm-native/src/setup.rs:174`) and `proof` (`:222`), including whether the
domain-separation constants at `:20-21` are actually applied on both sides;
(b) message bounding, the `read_message_unbounded` / `read_message` pair
(`setup_socket.rs:355`, `:369`) against the `MAX_SETUP_MESSAGE_LEN` cap enforced
in `encode_message` (`:430-440`), and the peer's separate `MAX_AUTH_MESSAGE_LEN`
of 4096 (`mc-shm-native/src/setup.rs:18`); (c) descriptor custody, exactly
`RING_DESCRIPTOR_COUNT` = 2 fds (`setup_socket.rs:25`) across `send_grant`
(`:132`) and `receive_grant` (`:178`), and the listener permission gate
`bind_owner_only` (`:27`).

Salvage input: none. No lens file covered either file.

### 2d-client-peer — the peer-side host client

Files: `client.rs` (3,998).
**Lines: 3,998.** Risk rank: **3.**

Rationale: the largest unscoped file in the crate, never cataloged, and the
refactor rewrote 488 of its lines. It is the other end of both 2b and 2c, and it is
where the ring attach and the setup handshake are actually driven
(`client.rs:347`, `:367`, `:1855`, `:1890`).

Attention focuses: (a) the attach and activate sequence and what happens on each
partial-failure path between `UnixStream::connect` (`:347`) and
`attach_with_descriptors` (`:1855`); (b) descriptor and endpoint ownership on the
client side, given that `RingClientEndpoint` is doc-commented as test-only
(`ring_transport.rs:627`) yet reached from here; (c) teardown ordering around
`encoded_goodbye` (`:1890`) and whether a client exit is distinguishable from a
crash by the host's `observe_peer`.

Salvage input: light. Lens A records 4, 5 and 12 cite `client.rs` as boundary
context only; no lens mined it.

### 2e-request-path — dispatch, routing, control decode, composition

Files: `dispatch.rs` (1,539), `control.rs` (1,180), `routing.rs` (833),
`handler.rs` (604), `composite.rs` (390).
**Lines: 4,546.** Risk rank: **4.**

Rationale: the channel-0 control surface and the request fan-out. `composite.rs`
is the one surviving-2b file whose records carry forward intact, and `control.rs`
inherits the recursive-parse obligation that lens C record 1 raised about deleted
negotiation code.

Attention focuses: (a) `parse_control` in `control.rs` as the sole unbounded
recursive walk of an untrusted channel-0 body, re-derived from lens C's `strict_json`
observations at `control.rs:714-721` and `:792-804` now that the negotiation
wrapper is gone; (b) route-handle accounting and panic containment in
`composite.rs`, carrying the two valid lens C records forward; (c) the
`ShutdownError` producer inventory, since the redaction property holds but two of
its cited producers were deleted.

Salvage input: moderate and precise. Lens C records 10 and 11 carry forward valid.
Record 12 needs its producer list rebuilt. Records 1 and 7's leads belong here,
record 1 as a fresh property over `control.rs` and record 7 as retired.

### 2f-runtime-and-config — process wiring, limits, harness closure

Files: `runtime.rs` (1,344), `harness_closure.rs` (1,122), `config.rs` (674),
`lib.rs` (87), `file_mode.rs` (19).
**Lines: 3,246.** Risk rank: **5, lowest.**

Rationale: mostly startup wiring and validated limits, the least likely to hold a
safety property the other four do not already reach. Deliberately last.

Attention focuses: (a) limit validation and the derivation of ingress capacity
against `MAX_BODY_LEN`, which is lens A record 9's obligation and needs
`config.rs` plus `runtime.rs` re-read since both changed; (b) the public surface
in `lib.rs:10-87`, notably that `ring_transport` (`:21`) and `setup_socket`
(`:35`) are `pub mod` while `connection`, `control`, `dispatch`, `routing`,
`runtime` are private (`:24-33`), which fixes what an embedder can reach; (c)
`harness_closure.rs` shutdown ordering against the composite drain.

Salvage input: light. Lens A record 9 (`ingress-capacity-never-below-the-declared-
body-cap`) is the one record that lands here, and it needs re-verification.

### Partition summary

| Label | Files | Lines | Risk | Salvage |
| --- | --- | --- | --- | --- |
| `2b-ring-datapath` | 4 | 3,447 | 1 | 24 records, 4 valid as-is |
| `2c-setup-and-identity` | 4 + 1 external | 3,832 (+433) | 2 | none |
| `2d-client-peer` | 1 | 3,998 | 3 | boundary citations only |
| `2e-request-path` | 5 | 4,546 | 4 | 3 records, 2 valid as-is |
| `2f-runtime-and-config` | 5 | 3,246 | 5 | 1 record |
| Total | 19 in-crate | 19,069 | | 6 valid, 21 re-verify, 9 dead |

## Overlaps with existing parts

Checked against the scope lines and index tables of `part-1-shm-transport`,
`part-2a-host-lifecycle`, `part-3-store-core`, `part-4a` through `part-4f`, and
`part-5a-storage`.

**Part 1 (58 records, `crates/mc-shm-transport` + `packages/mc-shm-native`).** Two
real overlaps. First, `ring_transport.rs` is the host-side surface Part 1 mined
through `shm_provider.rs`, so 2b must not re-catalog Part 1's custody, lease,
publication-cursor, or reclamation properties; it should cite them. Part 1's index
already holds `publish-signal-implies-committed-frame`,
`no-frame-observable-before-commit`,
`publication-visibility-derives-only-from-the-published-cursor`,
`release-exactly-once-per-sequence`,
`cancelled-frame-disposition-is-declared`, and `clean-reclamation-is-reachable`.
2b's new material is the *host worker thread and admission*, not the ring
mechanics. Second, `packages/mc-shm-native/src/setup.rs` sits inside Part 1's
declared crate scope but was added after Part 1 was written; the proposal above
gives it to 2c. Confirm before either pass starts, or it gets cataloged twice or
not at all.

**Part 2a (55 records).** Its scope files `lifecycle.rs`, `generation.rs`,
`connection.rs`, `panic_boundary.rs` are excluded from all five sub-parts. Three
specific non-duplication constraints, taken from its own preamble and index:
2a owns the writer-task abort chain, the discard-versus-retired token split,
completion-hook panics, permit release under abort, and read-exit close
disposition, so 2b must approach those from the ring side only and cite
`close-disposition-is-a-total-function-of-the-read-exit-cause` and
`a-cancelled-emission-releases-every-permit-it-held` rather than restate them.
2a's Group J is already `superseded-by-refactor` for `frame_read.rs`; whatever
inbound-read obligation it held has migrated into `receive_one`
(`ring_transport.rs:455-535`) and 2b should pick it up explicitly, since no part
currently owns it. And 2a's `the-largest-lifecycle-proof-runs-in-ci` overlaps the
CI section above; the numbers here (4 of 24) supersede its 4 of 26.

**Part 3 (`mc-store`, `mc-core`, `mc-tokenizer`).** No overlap. Different crates,
no `mc-host/src` citations in its scope line.

**Parts 4a-4f (`mc-module`).** No file overlap; all six are `crates/mc-module`.
One indirect contact: 4a's scope names `mc_host::Client` as the historian
producer's transport, and `client.rs` is 2d's whole scope. 2d should catalog the
client's transport behaviour and leave the historian's use of it to 4a. 4a also
reaches into `mc-store/src/lib.rs:9360-9500`, which is Part 3's file, so the
precedent for citing across a part boundary rather than re-mining is already
established.

**Part 5a (`part-5a-storage`).** Cannot check for overlap. The directory contains
only `_lenses/` and `evidence/`; there is **no `catalog.md`** and therefore no
scope line or index table to compare against. Part 5 is mid-flight. The
`owner.ts` placement in this document is a proposal against an unread scope, and
the risk of duplicate or dropped coverage on the TypeScript client surface is
real and unresolved.

## Open questions

- The code tree is on `feat/shared-memory-release-gate-audit` at `e447c927`, not
  on `main` as the task states. `e447c927` is four commits past `ed487e11`, and
  three of those four touch `ring_transport.rs`. Is this the intended baseline? If
  the answer is `main`, every line reference here needs re-verification.
  (needs human input)
- Is the ring `default-production` or `explicit-config-only`? `RING_PROFILE` is
  `"mc-host-test-ring-v1"` (`ring_transport.rs:31`) and `RingClientEndpoint` is
  documented "for integration tests" (`:627`), yet `lib.rs:21` exports the module
  publicly and `client.rs:1855` reaches it on a path I did not prove test-gated.
  This is a per-record determination under METHOD rule 4 and I did not resolve it;
  2b must resolve it before authoring.
- Does `packages/mc-shm-native/src/setup.rs` belong to Part 1, whose scope line
  covers that package, or to 2c, which owns the other half of the protocol? I
  propose 2c. (needs human input)
- Does `packages/plugin/src/shared/mc-host-client/owner.ts` belong to Part 5? I
  propose yes, from path and language only. I did not read the file, and Part 5a
  has no `catalog.md` to check its scope against. (needs human input)
- `setup_socket.rs:355` is named `read_message_unbounded` and `:369` is named
  `read_message`. Whether the first is a real missing bound or a bounded read
  under a misleading name is unresolved; I did not read the bodies.
- What does `bun run check:shm-architecture` (`ci.yml:58`) actually assert? It is
  the gate keeping the deleted transports deleted, and its strength is unverified.
  I did not read `scripts/check-mc-shm-architecture.test.ts`.
- Are `shm-crash-recovery` (`ci.yml:111`) and `shm-source-build` (`:137`) required
  status checks for merge? Unverifiable from workflow content; it is repository
  settings.
- Do the two Part 1 custody records survive the deletion of the host-side driver
  in `provider_recovery.rs`, or does their reachability label change? The
  transport-side machinery is intact in `crates/mc-shm-transport/src/`, but the
  driver is gone. Only the Part 1 refresh pass can settle it.
