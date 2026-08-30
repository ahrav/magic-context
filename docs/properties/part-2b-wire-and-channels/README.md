# Sub-part 2b-wire-and-channels: superseded

**This directory is superseded. It is not a plan, and nothing in it should be
picked up and worked as one.** It holds four completed lens files describing a
surface the ring-transport refactor rewrote or deleted. They are retained as
salvage and for traceability. Nothing here is deleted.

**Carry status: the 6 still-valid records have been carried out of here and are
now cataloged elsewhere. The remaining 30 blocks stay salvage.** The four
`wire.rs` records went to
[../part-2b-ring-datapath/](../part-2b-ring-datapath/) as its Group G and the two
`composite.rs` records went to
[../part-2e-request-path/](../part-2e-request-path/) as its Group F; the table in
[The 6 still-valid records](#the-6-still-valid-records-all-six-have-now-been-carried)
gives the mapping, the seven citations repaired on the way, and the two open
questions resolved. Of the 30 that stay, **9 are invalid because their subjects
were deleted** and nothing carries them, and **21 need re-verification that has
not been done**. Nothing in this directory is now a source for anything except
the reasoning behind those 30 and the bug history in lens D.

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

**All 6 still-valid records have since been carried out.** The 30 that remain
split 9 invalid and 21 needing re-verification, and both groups stay salvage. The
"line references hold" rule in the first row proved slightly optimistic even for
the six: it is true of every citation into a subject file, and seven citations
still needed repair, five of them into *cited* files that changed rather than
subject files, and two that were wrong when written. See
[The 6 still-valid records](#the-6-still-valid-records-all-six-have-now-been-carried).

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

## The 6 still-valid records: all six have now been carried

**Status as of the carry pass: all six are carried and cataloged. This section is
history.** The four `wire.rs` records are now
[Group G of ../part-2b-ring-datapath/catalog.md](../part-2b-ring-datapath/catalog.md#group-g-the-wire-header-decode-contract),
and the two `composite.rs` records are now
[Group F of ../part-2e-request-path/catalog.md](../part-2e-request-path/catalog.md#group-f-composite-route-ownership-and-panic-containment).
Each has an evidence file under its new sub-part's `evidence/` directory, an index
row in its new catalog, a per-property row in that sub-part's `fault-map.md` with a
"non-vacuous today" verdict, and its cited checks added to that sub-part's
`existing-checks.md`. Record counts moved from 14 to 18 in 2b-ring-datapath and
from 14 to 16 in 2e-request-path.

| Record | Carried to | Group |
| --- | --- | --- |
| `decode-header-is-total-over-arbitrary-bytes` | [../part-2b-ring-datapath/](../part-2b-ring-datapath/) | G |
| `accepted-header-decode-is-a-bijection-on-twenty-one-bytes` | [../part-2b-ring-datapath/](../part-2b-ring-datapath/) | G |
| `reserved-encodings-and-identity-pairings-reject-at-decode` | [../part-2b-ring-datapath/](../part-2b-ring-datapath/) | G |
| `encoder-never-emits-a-frame-its-own-decoder-rejects` | [../part-2b-ring-datapath/](../part-2b-ring-datapath/) | G |
| `composite-route-entry-is-removed-by-exactly-one-route-gone` | [../part-2e-request-path/](../part-2e-request-path/) | F |
| `composite-panic-containment-covers-only-optional-health-and-shutdown` | [../part-2e-request-path/](../part-2e-request-path/) | F |

The slugs were kept unprefixed rather than rewritten to `ring-a-` or `req-a-`, so
the carry stays visible against records those sub-parts derived themselves. Each
group preamble names this directory as the origin and states why the records were
orphaned: the scope moved and the absorbing sub-part's lenses did not re-derive
them.

**Seven citations were repaired at carry time**, which is more than this section
predicted, and the prediction was wrong in an instructive way. It expected two
repairs in the wire group and none in the composite group. What happened:

| Record | Repair |
| --- | --- |
| `decode-header-is-total-over-arbitrary-bytes` | `wire.rs:745-773` → `:745-774`; "both production callers" → three |
| `reserved-encodings-and-identity-pairings-reject-at-decode` | `wire.rs:745-773` → `:745-774`; `protocol_vectors.rs:512 structural_corruption_closes_silently` → `:351 structural_corruption_is_rejected_before_dispatch` (renamed and moved); `:656` → `:504` |
| `encoder-never-emits-a-frame-its-own-decoder-rejects` | `wire.rs:548` is inside a `#[cfg(test)]` encoder, so two production encoders not three; `docs/mc-host-wire-protocol.md:293` → `:296` |
| `composite-panic-containment-covers-only-optional-health-and-shutdown` | `tests/composite_routing.rs:1028-1060` → `:1028-1049` |
| `accepted-header-decode-is-a-bijection-on-twenty-one-bytes` | none |
| `composite-route-entry-is-removed-by-exactly-one-route-gone` | none |

Two files this section did not flag had changed. `tests/protocol_vectors.rs` was
flagged and did change, 976 lines to 762 under `63c4d277`.
**`docs/mc-host-wire-protocol.md` was not flagged and changed too**, 1,031 lines
to 936, which is what moved the encoder record's `:293`. And the composite group's
one repair was not caused by any change at all: this section stated that both
composite subjects and both existing checks were byte-identical and concluded
"neither needs a citation refresh". The byte-identity claim is correct —
`composite.rs` is blob `6858246d` and `tests/composite_routing.rs` is blob
`2201b830` at `1c193ae0`, `793a973e` and `e447c927` alike — and the conclusion
still failed, because `:1028-1060` overran a 1,049-line file and **was wrong when
the lens wrote it** rather than made wrong by a change. The lesson for any later
carry: blob identity bounds which citations can have drifted and bounds nothing
about which were ever right, so spans need checking against file length regardless.

Two things were resolved rather than repaired, both in records that predate the
`Reachability:` field and both recorded at the record:

- The encoder record's open question, whether the route allocator can mint a
  `RouteHandle` with a nonzero channel and epoch 0, is **resolved: it cannot.**
  `RouteRegistry::reserve` (`routing.rs:113-156`) skips channel 0 at `:123` and
  mints `epoch = last_epoch + 1` from `last_epoch: 0`, pinned by an existing test
  at `routing.rs:512`. The hole survives only through a hand-constructed handle.
- The route-entry record's open question, whether the host guarantees `route_gone`
  after a panicking `bind`, is **resolved: it does.** The runtime side is
  `dispatch.rs`, which is inside 2e's own scope rather than outside it, so the
  question was answerable in the sub-part that absorbed the record. That
  resolution surfaced three further bind or close outcomes the composite's comment
  does not name, all of which skip the removal and all of which trip the fatal
  latch; they are carried as a new open question.

All six were assigned `Reachability: default-production`, verified per record
rather than asserted in a preamble, per METHOD rule 4. The four wire records rest
on three production `decode_header` call sites and two production encoders; the two
composite records rest on `serve.rs:575` and `:632` plus the absence of any
`#[cfg]` in `composite.rs`.

### What this section said before the carry, retained for traceability

The re-scope routed all six forward and expected them to be carried
"unmodified". Checked against the two absorbing sub-parts at `e447c927` before the
carry pass, **none of the six had been carried forward and all six were
uncovered.** The two sub-sections below are the original analysis of why.

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
  Read a record for its reasoning, never for its line numbers. **This now applies
  to all 36 blocks without exception, including the six.** Before the carry, the
  six were the stated exception. They are no longer: their carried versions in
  [../part-2b-ring-datapath/catalog.md](../part-2b-ring-datapath/catalog.md#group-g-the-wire-header-decode-contract)
  and
  [../part-2e-request-path/catalog.md](../part-2e-request-path/catalog.md#group-f-composite-route-ownership-and-panic-containment)
  are the current versions, seven of their citations were repaired on the way, and
  the lens copies here are superseded even for those six.
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
