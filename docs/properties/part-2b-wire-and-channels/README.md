# Sub-part 2b-wire-and-channels: superseded

**This directory is superseded. It is not a plan, and nothing in it should be
picked up and worked as one.** It holds four completed lens files describing a
surface the ring-transport refactor rewrote or deleted. They are retained as
salvage and for traceability. Nothing here is deleted.

There is no `catalog.md`, `existing-checks.md`, `fault-map.md` or
`portfolio-evaluation.md`, and none will be written. Synthesis never ran. The
36 records the lens files propose were triaged against the post-refactor tree by
[../part-2-rescope/scope-map-and-risk-ranking.md](../part-2-rescope/scope-map-and-risk-ranking.md),
which is the authoritative disposition; this note records its outcome and adds
what has happened since.

## Why it is superseded, and the number it left behind

The negotiated-transport architecture was collapsed into a single fixed ring
transport across four commits, and `ed487e11` ("refactor(host): make ring
transport mandatory") deleted three of this sub-part's six scope files.
Re-verified with `git log --diff-filter=D` at `e447c927`: `tcp_frame_channel.rs`,
`transport_negotiation.rs` and `transport_provider.rs` were all removed by
`ed487e11`. See
[../README.md](../README.md#refactor-in-progress-the-ring-transport-collapse) for
the whole refactor.

The re-scope retired this label and **reused the number** for
`part-2b-ring-datapath`, so two directories now carry `2b`. They are not two
versions of one sub-part. This one is a pre-refactor surface that was never
synthesized; the other is a post-refactor surface against which nothing had ever
been cataloged. `../README.md` resolves the collision in its parts table.

## Which parts absorbed the scope

Old scope was `crates/mc-host/src/{wire,frame_channel,tcp_frame_channel,
transport_negotiation,transport_provider,composite}.rs`, about 4,900 lines.

| Old scope file | Now | Absorbed by |
| --- | --- | --- |
| `wire.rs` (973) | survives, byte-identical | [../part-2b-ring-datapath/](../part-2b-ring-datapath/) |
| `frame_channel.rs` (882 to 807) | survives, changed | [../part-2b-ring-datapath/](../part-2b-ring-datapath/) |
| `composite.rs` (390) | survives, byte-identical | [../part-2e-request-path/](../part-2e-request-path/) |
| `tcp_frame_channel.rs` (1,155) | deleted in `ed487e11` | nothing |
| `transport_negotiation.rs` (973) | deleted in `ed487e11` | nothing |
| `transport_provider.rs` (500) | deleted in `ed487e11` | nothing |

Two obligations were routed rather than files. Lens C record 1's underlying
obligation, that the only unbounded recursive walk of an untrusted channel-0 body
is `strict_json::parse`, went to `control.rs` in 2e-request-path as a fresh
property rather than as a carried record. Lens A record 9,
`ingress-capacity-never-below-the-declared-body-cap`, went to
[../part-2f-runtime-config/](../part-2f-runtime-config/) needing
re-verification, because `config.rs` and `runtime.rs` both changed.

## Per-record triage

36 record blocks across three lens files: 12 in `lens-a-wire-format.md`, 12 in
`lens-b-channel-egress.md`, 12 in `lens-c-negotiation-provider.md`.
`lens-d-claims-history-checks.md` proposes no records; its 22 headings are the
claims register, the bug-history entries and the check inventory.

| Disposition | Count | Rule |
| --- | --- | --- |
| Still valid | **6** | Every cited subject survives byte-identical, so line references hold |
| Invalid, subject deleted | **9** | The guarantee names a subject that no longer exists and has no surviving carrier |
| Needs re-verification | **21** | The subject survives but the file changed, or the record's enumeration spanned a now-deleted file |
| Total | 36 | |

The split by lens file, re-derived here by reading each record's own citations
rather than by trusting the counts:

| Lens | Valid | Invalid | Re-verify |
| --- | --- | --- | --- |
| A, wire format | 4 | 0 | 8 |
| B, channel egress | 0 | 0 | 12 |
| C, negotiation and provider | 2 | 9 | 1 |

The 9 invalid are lens C records 1 through 9, all resting on
`transport_negotiation.rs` or `transport_provider.rs`. Of those, only record 1
left a usable lead, named above. Record 7's `Serveable` and offer-parameter
machinery is gone along with both of its cited checks, and it has no lead.

The 21 needing re-verification are all 12 lens B records, 8 lens A records, and
lens C record 12. Lens B's whole subject is the frame-channel egress path, and
`frame_channel.rs` lost 75 lines while `contract_tests.rs` gained 44. The 8 lens
A records each have their core in the unchanged `wire.rs` but each also
enumerates consumers, and the consumer set is what the refactor rewrote. Lens C
record 12 sits on the unchanged `composite.rs`, so its redaction claim holds, but
two of the `ShutdownError` producers it inventories were deleted.

## The 6 still-valid records: none is covered elsewhere yet

This is the part of the triage that has moved since the re-scope was written, and
it moved in the unhelpful direction. The re-scope routed all six forward and
expected them to be carried "unmodified". Checked against the two absorbing
sub-parts at `e447c927`, **none of the six has been carried forward. All six
remain uncovered.**

### Four on `wire.rs`: in scope for 2b-ring-datapath, uncataloged there

1. `decode-header-is-total-over-arbitrary-bytes` (lens A, `L195-242`)
2. `accepted-header-decode-is-a-bijection-on-twenty-one-bytes` (lens A, `L243-290`)
3. `reserved-encodings-and-identity-pairings-reject-at-decode` (lens A, `L291-334`)
4. `encoder-never-emits-a-frame-its-own-decoder-rejects` (lens A, `L430-482`)

`wire.rs` is inside 2b-ring-datapath's declared scope, which names it as "the
frame codec and the byte budget"
([../part-2b-ring-datapath/catalog.md](../part-2b-ring-datapath/catalog.md), scope
paragraph). But all 14 of that sub-part's records carry the `ring-a-` prefix and
every one of their `Guarantee:` lines is about the ring transport: endpoint-thread
ownership, release identities, admission charges and quarantine, publication
failure and panic classification, lease completion, reclamation counts, doctor
terminal classes, and close classification. Not one is about the codec.
`wire.rs` appears in that catalog only twice, in the scope sentence and in the
test inventory, where its 14 in-file tests are counted. So the codec is
**in scope and uncataloged**, and these four records are the material a follow-up
pass on 2b-ring-datapath should absorb.

Two precisions, so a later reader does not mis-file them.

- **Records 3 and 4 need a field-level refresh, not re-discovery.** Both cite
  `tests/protocol_vectors.rs` as their existing check, and that file changed. It
  still exists (762 lines at `e447c927`). The property and its `wire.rs`
  citations hold; the `Existing check:` line needs a re-read.
- **Part 1 has structurally analogous records on a different decoder, and they
  are not these.** `part-1-shm-transport` holds
  `decoder-totality-over-arbitrary-bytes` and
  `accepted-decode-consumes-its-declared-width`, both over the
  `crates/mc-shm-transport` decoders: `descriptor.rs`, `sample.rs`, `ring.rs` and
  `harness.rs`, as their own `Confidence:` and `Fault/timing angle:` lines cite.
  `wire::decode_header` in `mc-host` is a different function. Lens A already
  excluded Part 1's records from its own scope on exactly this ground, in its
  "Not re-reported here" preamble. Counting Part 1 as cover for records 1 and 2
  would be a double-count in the wrong direction.

### Two on `composite.rs`: routed to 2e-request-path, not carried

5. `composite-route-entry-is-removed-by-exactly-one-route-gone` (lens C, `L599-636`)
6. `composite-panic-containment-covers-only-optional-health-and-shutdown` (lens C, `L637-675`)

`composite.rs` is byte-identical and is in 2e-request-path's scope, which lists it
at 390 lines. The re-scope named carrying these two forward as one of that
sub-part's three attention focuses. It did not happen: all 14 of 2e's records
carry the `req-a-` prefix and cover dispatch, routing, control decode and handler
concurrency. Neither composite record appears, and `composite.rs` is mentioned in
that catalog only in its scope line and in two test-inventory notes recording that
the file has no test module of its own.

So these two are **routed but not absorbed**, and they are the cheapest salvage in
the directory: both subjects are byte-identical, both existing checks
(`tests/composite_routing.rs`) are byte-identical, and neither needs a citation
refresh.

## How to use what is here

- **`_lenses/` is working material, per METHOD.md, and now it is also an archive.**
  Read a record for its reasoning, never for its line numbers, unless it is one of
  the six above.
- **The lens files disagree with each other about `HEAD`, and they say so.** Lens A
  verified against an unnamed commit but reports `wire.rs` at 973 lines, matching
  `e447c927`. Lens C verified against `1c193ae0`. Lens D verified against
  `793a973e` and its own preamble records that the working tree already held
  uncommitted deletions of three of the seven files it inventories. Lens D also
  corrects lens A's `transport_provider.rs` count from 489 to 500.
- **Lens D's bug history survives the deletions and is worth reading.** Its nine
  entries `D1` through `D9` are evidence about how this team's transport code
  fails, which does not stop being true because the code was deleted. `D5`
  (recursive opaque-depth stack exhaustion) and `D9` (provider preparation
  blocking the read loop) describe failure shapes the new single-threaded
  `run_endpoint` design could reintroduce. Its claim leads `L1`, `L3`, `L4` and
  `L5` are about negotiation, providers and a deleted fallback reason, and are
  retired. `L2` duplicates lens C record 12 and travels with it. Its
  existing-check inventory is stale in its counts and is superseded by the
  re-scope's CI section.
- **Do not re-mine the 9 invalid records.** They stay listed in the re-scope so
  the same dead end is not re-entered.
