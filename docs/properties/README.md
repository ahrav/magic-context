# Property catalog

Concrete, evidence-backed statements of what this system must always hold, what
must eventually happen, and which rare situations a test campaign has to
actually reach.

The deliverable here is the catalog, not a test suite. Each record is a claim
with evidence attached, not proof that the property holds. Records hand off to
`/testing:test-strategy` for test form and oracle, to
`/testing:deterministic-simulation-testing` for harness and workload design, to
`/testing:invariant-test-review` for judging whether an existing test proves its
claim, and to `/low-level-systems:defensive-assertions-and-invariant-guards` for
production runtime enforcement.

## Provenance

- System: `/local/home/ahrav/scratch/magic-context`
- Commit: `9c1eb4d1301c455903c367fbd33a5920430cfbdb`
- Date: 2026-08-29
- Method: `/testing:property-discovery-and-catalog`
- Part 1 records cite commit `9c1eb4d1`. The worktree was later fast-forwarded to
  `753b1c38`; `crates/mc-shm-transport` and `packages/mc-shm-native` are
  byte-identical across that range, and of the `mc-host` files Part 1 cites only
  `generation.rs` changed, which no record depends on. The gap-closure records
  added in Groups I through M were verified against the later commit.
- Eventfd reconciliation, 2026-08-31: Part 1 was reconciled against HEAD
  `46278f47a` after PR #131 (merge `5d638e3e8`) replaced polling with sparse
  eventfd delivery and confirmed the iceoryx2 backend's removal. This covers
  the range from the `9c1eb4d1`/`e447c927` anchoring era to `46278f47a`, and
  normalizes Part 1's interim `superseded-by-refactor` status to `invalidated`
  per METHOD's `active | invalidated` vocabulary.

### External references consulted

The scope question was asked before analysis and answered "in-repo plus sibling
repos".

| Reference | Why consulted |
| --- | --- |
| `docs/mc-host-shm-transport.md` | Primary source of claimed guarantees for the shared-memory transport: zero-copy ownership contract, resource charges, failure/fallback/close, recovery contract. |
| `docs/plans/2026-08-24-1500-feat-iceoryx2-shared-memory-transport-plan.md` | Numbered requirements R1-R19 and AE1-AE15 that the transport is measured against. |
| `docs/plans/2026-08-25-0524-feat-shared-memory-failure-hardening-plan.md` | Failure-hardening requirements and the recovery-episode contract. |
| `docs/plans/2026-08-25-2352-feat-shared-memory-release-gate-plan.md` | Release-gate conditions, including the dead-peer charge blocker. |
| `docs/evidence/mc-shm-traceability-v1.json` | Existing requirement-to-evidence mapping and its status vocabulary. |
| `crates/mc-shm-transport/benches/manifests/v1.json` | Frozen-versus-unset benchmark and hardening gates; the selection predicates that decide whether a provider may ship. |
| `docs/AUDIT-KNOWN-ISSUES.md` | Findings already investigated and accepted by design, so they are not re-reported as defects. Contains no shared-memory entries. |
| `piolium/attack-surface/manual-attack-surface-inventory.md`, `unauthenticated-surface.md` | Checked for an existing treatment of the shared-memory trust boundary. Neither mentions it. |
| Git history of `crates/mc-shm-transport` and `packages/mc-shm-native` | Defect archaeology; diffs of the 13 most safety-relevant commits were read rather than trusting commit titles. |
| `bd list` / beads issues | Open tracked work, including `magic-context-ymc.12` (retained-tuple manifest) referenced by the dead-peer gap. |
| Sibling repos `/local/home/ahrav/scratch/commons`, `/local/home/ahrav/scratch/subconscious` | In scope by the user's answer. Confirmed present, and confirmed **not** in the dependency graph of Part 1: `mc-shm-transport` depends only on `getrandom`, `libc`, `serde`, and `iceoryx2`. They contributed no evidence to this part and remain in scope for later parts. |

## Scope decision: Rust-first

Recorded 2026-08-30 by the project owner. Property discovery focuses on the Rust
side from here, and all transforms are moving to Rust.

Part 5, the TypeScript surfaces, is parked. The sub-parts already completed there
are retained in full as a record of the transitional state. No `part-5*` material
is deleted: the lens files, the per-record evidence files, and the
`part-5a-storage` catalog, check inventory, and fault map all stay as written.

### The fact 5c established, which stands

Sub-part 5c settled what a default install runs today, and a Rust-first reader
still needs that answer. All four references below were re-read at `e447c927` and
are unchanged.

- `transform_mode` defaults to `"ts"`. The field is declared at
  `packages/plugin/src/config/schema/magic-context.ts:672-677` and `.default("ts")`
  is `:674`.
- The resolver at `packages/plugin/src/config/index.ts:605-611` decides the mode
  once and overwrites the field at `:611`. It is the only decision point.
- Both of that resolver's early returns demote toward `ts`:
  `packages/plugin/src/config/transform-mode.ts:22-27` on compaction-off and
  `:34-39` on missing user-tier consent. Only `:41` passes `rust` through.

So a default install selects the TypeScript renderer, and reaching the Rust
transform requires user-tier consent.

### The inference that does not stand

The commit message of `9a8a11e9` drew a further conclusion from that fact: that
"Parts 4b and 4e cataloged a path ordinary users do not execute, and their
reachability labels need revisiting."

Under the Rust-first decision that reading is backwards. The Rust transform is
the target architecture, so Parts 4b and 4e catalog the path that is becoming the
default, and their records gain importance rather than losing it. The records that
describe a transitional state are the TypeScript transform records in 5c.

No record's reachability label changes as a result. What is corrected is the
inference about what 5c's fact implies for other parts, not any record. Parts 4b
and 4e each carry a framing note under `## Reachability under the Rust-first
decision` in their catalog headers, and neither note relabels anything.

## Parts

The system is cataloged incrementally. Each part is a separate directory with
its own catalog, existing-check inventory, fault map, and per-property evidence
files.

| Part | Scope | Status |
| --- | --- | --- |
| [part-1-shm-transport](part-1-shm-transport/) | `crates/mc-shm-transport`, `packages/mc-shm-native`; boundary context from `crates/mc-host/src/{shm_provider,transport_negotiation,transport_provider,provider_recovery}.rs` | 65 records; portfolio evaluated; the 7 originally queued gaps are closed, and the Group N evaluation queued 4 new gaps (redispatch termination, acknowledgement-failure, multi-channel interleaving, coverage markers) for a follow-up discovery pass — see [portfolio-evaluation.md](part-1-shm-transport/portfolio-evaluation.md) |
| [part-2a-host-lifecycle](part-2a-host-lifecycle/) | `crates/mc-host/src/{lifecycle,generation,connection,frame_read,panic_boundary}.rs` (~6.5k lines) | 55 records; portfolio evaluated; all 5 queued gaps mined and merged; 6 records superseded by the ring-transport refactor |
| [part-2b-wire-and-channels](part-2b-wire-and-channels/) | `crates/mc-host/src/{wire,frame_channel,tcp_frame_channel,transport_negotiation,transport_provider,composite}.rs` (~4.9k) | **Superseded by the ring-transport refactor. Retained as salvage, not as a plan.** No catalog and none owed; synthesis never ran. Four completed lens files under `_lenses/` (A wire format, B channel egress, C negotiation and provider, D claims and existing checks) describe the pre-refactor surface; A, B and C propose 36 records between them and D is the claims-and-history inventory. Triage of those 36: 6 still valid, 9 invalid because their subject was deleted, 21 needing re-verification. **None of the 6 still-valid records has been absorbed by a successor part yet.** See [part-2b-wire-and-channels/README.md](part-2b-wire-and-channels/README.md) for the disposition and [Two directories share the number 2b](#two-directories-share-the-number-2b) below. |
| part-2c-auth-and-control | `crates/mc-host/src/{auth,instance,control,config,connection_file}.rs` (~5k) | Parked — pending ring-transport refactor |
| part-2d-dispatch-and-client | `crates/mc-host/src/{client,dispatch,routing,handler,runtime}.rs` (~8.4k) | Parked — pending ring-transport refactor |
| part-2e-subsystems | `crates/mc-host/src/{broca,synapse}/`, `harness_closure.rs` | Parked — pending ring-transport refactor |
| part-3-store-core | `crates/mc-store`, `crates/mc-core`, `crates/mc-tokenizer`: SQLite durability, claim mirror, migrations | Not started |
| part-4-module | `crates/mc-module`: transform, historian, selection | Not started |
| part-5-ts-surfaces | `packages/plugin`, `packages/pi-plugin`, `packages/cli`, `packages/retina-local-fs` | Parked — see [Scope decision: Rust-first](#scope-decision-rust-first). Holds the sub-part scope map and risk ranking under `_lenses/`; the sub-parts below carry the work. |
| [part-5a-storage](part-5a-storage/) | `packages/plugin` storage: the newer-schema fence, the claim outbox, and write authority | Parked — retained as transitional record. 23 records; catalog, check inventory, and fault map present; no portfolio evaluation. |
| part-5b-historian-ts | `packages/plugin` historian and compartment pipeline | Parked — retained as transitional record. 14 records, present as per-record evidence files plus two lens files; no synthesized catalog. |
| part-5c-transform-ts | `packages/plugin` TypeScript transform and the Rust-mode adapter | Parked — retained as transitional record. 13 records, present as per-record evidence files plus two lens files; no synthesized catalog. This is the sub-part whose records describe the transitional state. |
| part-5d-cli | `packages/cli` wizards, doctor, and the destructive database commands | Parked — retained as transitional record. 14 records, present as per-record evidence files plus two lens files; no synthesized catalog. |
| part-5e-pi-plugin | `packages/pi-plugin` harness surface | Not started — parked. |

`mc-host` is 28,026 lines of source across 29 modules, an order of magnitude
larger than Part 1, so Part 2 is sub-partitioned. `shm_provider.rs` and
`provider_recovery.rs` are not re-mined in Part 2: they are already cataloged as
Part 1 boundary context.

The Part 2 rows above are the **original** sub-partition. The ring-transport
refactor forced a re-partition, recorded in
[part-2-rescope/scope-map-and-risk-ranking.md](part-2-rescope/scope-map-and-risk-ranking.md),
and the directories that exist today are `part-2a-host-lifecycle`,
`part-2b-ring-datapath`, `part-2c-setup-identity`, `part-2d-client-peer`,
`part-2e-request-path` and `part-2f-runtime-config`. Their record counts are in
[Records carrying a `Reachability:` line](#records-carrying-a-reachability-line).
The `part-2c`, `part-2d` and `part-2e` rows above name the **pre-refactor** scope
for those numbers and are superseded by the re-partition; do not read a row above
as the scope of the same-numbered directory in the tree.

### Two directories share the number 2b

`part-2b-wire-and-channels` and `part-2b-ring-datapath` are **not two versions of
one sub-part, and neither supersedes the other's records.** The re-scope retired
the `wire-and-channels` label and reused the number.

| Directory | Surface | State |
| --- | --- | --- |
| `part-2b-wire-and-channels` | pre-refactor: the frame codec, both channel implementations, transport negotiation and provider selection | Superseded. Lens files only, no catalog, none owed. |
| `part-2b-ring-datapath` | post-refactor: `ring_transport.rs`, `wire.rs`, `frame_channel.rs`, `frame_channel/contract_tests.rs` | Active. 14 records; missing `portfolio-evaluation.md`. |

The two overlap on exactly one file. `wire.rs` is in both scopes and is
byte-identical across the refactor, and the four still-valid wire records the old
directory holds are **not** among `part-2b-ring-datapath`'s 14, all of which are
about the ring transport rather than the codec. So the number is shared, the
records are disjoint, and one file's properties are owed by the active directory
and not yet written there. `composite.rs` left 2b entirely and belongs to
`part-2e-request-path`. Details in
[part-2b-wire-and-channels/README.md](part-2b-wire-and-channels/README.md).

## Remaining Rust work

Determined by inspecting the worktree at `0bc9c3fa`, not from the table above,
which is stale for several Rust parts. Two directories are excluded because they
are scope-map holders rather than cataloging units: `part-2-rescope` and
`part-4-module` each contain only a scope map and risk ranking.

### Missing artifacts per Rust part

METHOD.md requires four artifacts per part: `catalog.md`, `existing-checks.md`,
`fault-map.md`, and `portfolio-evaluation.md`. `evidence/<slug>.md` is per record
and is not counted here.

| Rust part | Missing artifacts |
| --- | --- |
| part-1-shm-transport | none |
| part-2a-host-lifecycle | none |
| part-2b-ring-datapath | `portfolio-evaluation.md` |
| part-2b-wire-and-channels | **none owed — superseded**, see [its note](part-2b-wire-and-channels/README.md) |
| part-2c-setup-identity | `portfolio-evaluation.md` |
| part-2d-client-peer | `portfolio-evaluation.md` |
| part-2e-request-path | `portfolio-evaluation.md` |
| part-2f-runtime-config | `portfolio-evaluation.md` |
| part-3-store-core | none |
| part-4a-historian | none |
| part-4b-transform | none |
| part-4c-handlers | none |
| part-4d-facade | none |
| part-4e-rendering | none — **reconstructed from a report, with 7 of its 9 refinements outstanding** |
| part-4f-decisions | `existing-checks.md`, `fault-map.md`, `portfolio-evaluation.md` |

So six parts are missing a portfolio evaluation and 4f is missing its check
inventory and fault map as well. Two rows need reading with their footnote.

- **2b-wire-and-channels owes nothing.** It is superseded rather than parked, and
  no catalog will be synthesized against a surface the refactor deleted. It holds
  four completed lens files as salvage.
- **4e's `portfolio-evaluation.md` is present but is a reconstruction.** The
  evaluation ran and its file was destroyed before it reached disk. The file in
  the directory is written from a report of its findings, marks itself as such,
  and records that **7 of its 9 refinements were never applied**, as actionable
  work. Two were applied and are named in `catalog.md`. Treat the part as
  evaluated and not dispositioned.

### Records carrying a `Reachability:` line

METHOD.md rule 4 requires a per-record reachability label. The field entered the
record schema partway through, so the earliest parts predated it; the backfill in
`2930790ae` closed that gap. Counts are of records in each part's `catalog.md`,
where a record is a `###` heading whose first field is `Type:`, re-derived against
HEAD.

| Rust part | Records | With `Reachability:` | Without |
| --- | --- | --- | --- |
| part-1-shm-transport | 65 | 65 | 0 |
| part-2a-host-lifecycle | 55 | 55 | 0 |
| part-2b-ring-datapath | 18 | 18 | 0 |
| part-2c-setup-identity | 16 | 16 | 0 |
| part-2d-client-peer | 14 | 14 | 0 |
| part-2e-request-path | 16 | 16 | 0 |
| part-2f-runtime-config | 14 | 14 | 0 |
| part-3-store-core | 37 | 37 | 0 |
| part-4a-historian | 24 | 24 | 0 |
| part-4b-transform | 24 | 24 | 0 |
| part-4c-handlers | 25 | 25 | 0 |
| part-4d-facade | 25 | 25 | 0 |
| part-4e-rendering | 26 | 26 | 0 |
| part-4f-decisions | 27 | 27 | 0 |
| part-2b-wire-and-channels | 0 | 0 | 0 |
| **Total** | **386** | **386** | **0** |

Every Rust record now carries the label. The two earliest parts were the whole
shortfall, and `2930790ae` backfilled them: Part 1 went from 0 labels to all of
its records, and Part 2a from 17 of 55 to all 55. This table's Part 1 row also
absorbs the seven Group N records added in the eventfd reconciliation pass.
`part-2b-wire-and-channels` scores zero because it has no catalog and is owed
none; its 36 unlabelled lens records are working material, not records, and are
not counted in the 386.

Four rows besides Part 1 were re-derived upward here (2b-ring-datapath 14 to 18,
2c-setup-identity 14 to 16, 2e-request-path 14 to 16, 4f-decisions 26 to 27).
Those records were added by earlier passes that did not revisit this table, so
the drift predates this pass; the counts above are what the stated derivation
rule yields at HEAD.

### Not yet opened on the Rust side

No Rust part is queued that has no directory. The Rust scope named in the part-2
and part-4 scope maps is covered by the directories above.

## Refactor in progress: the ring-transport collapse

Observed 2026-08-30. The negotiated-transport architecture is being collapsed
into a single fixed ring transport. Four commits carry the change:

| Commit | Subject |
| --- | --- |
| `0f336d3c` | `refactor(shm): collapse to fixed ring transport` |
| `d8bde128` | `feat(host): add authenticated ring setup socket` |
| `793a973e` | `build(shm): require packaged native transport` |
| `ed487e11` | `refactor(host): make ring transport mandatory` |

Removed from the module tree: `crates/mc-host/src/{shm_provider,
provider_recovery,transport_negotiation,transport_provider,tcp_frame_channel,
frame_read}.rs`. Added: `crates/mc-host/src/ring_transport.rs` (a rename of
`shm_provider.rs`), `crates/mc-host/src/setup_socket.rs`,
`packages/mc-shm-native/src/setup.rs`, and the client
`packages/plugin/src/shared/mc-host-client/owner.ts`.

These deletions were uncommitted and still in progress when first observed. As of
this entry they are committed: `ed487e11`, now `HEAD`, carries every one of the
six deletions and all of the additions above, and the worktree has no pending
changes under `crates/` or `packages/`.

Consequence for the catalog: Part 1 and Part 2b records that cite the deleted
files describe a superseded architecture. They are retained for traceability
rather than deleted, so a reader can see which obligations were established
against the negotiated transport and must be re-derived against the fixed ring
transport before they are considered discharged. Part 2a's Group J is affected
the same way and is annotated in place; see
[part-2a-host-lifecycle/catalog.md](part-2a-host-lifecycle/catalog.md).

## Reading order

A reviewer reads `catalog.md`. An implementer reads the evidence file for the
property they are about to test. `existing-checks.md` records what is already
asserted today, `fault-map.md` records what a campaign must inject for each
property to be non-vacuous, and `portfolio-evaluation.md` records what an
independent evaluator found wrong with the set as a whole, including the gaps
still queued and the decisions that need a human.

## Conventions

- Every property has one kebab-case slug used in the catalog heading, the
  evidence filename, and every cross-reference.
- Check semantics are chosen from a fixed set — `always`,
  `always-or-unreached`, `sometimes`, `reachable`, `unreachable` — with a
  recorded rationale. A forbidden *state* with no dedicated detection point uses
  `always(!X)`, not `unreachable`.
- A documented guarantee stays a claim under test. The documentation establishes
  the contractual obligation; it never establishes that the implementation
  satisfies it.
- Coverage checks assert the independent preconditions that create a vulnerable
  window. They never assert the violation itself, so they still fire on a
  correct implementation.
- `Exercised: not yet` means the property is not evidence yet. Its check will
  pass forever until the campaign can construct the named fault.
- Invalidated properties stay in the catalog with their reason so the same dead
  end is not re-mined. They are excluded from test-implementation handoff.
