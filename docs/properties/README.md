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

## Parts

The system is cataloged incrementally. Each part is a separate directory with
its own catalog, existing-check inventory, fault map, and per-property evidence
files.

| Part | Scope | Status |
| --- | --- | --- |
| [part-1-shm-transport](part-1-shm-transport/) | `crates/mc-shm-transport`, `packages/mc-shm-native`; boundary context from `crates/mc-host/src/{shm_provider,transport_negotiation,transport_provider,provider_recovery}.rs` | 58 records; portfolio evaluated; all 7 queued gaps closed |
| [part-2a-host-lifecycle](part-2a-host-lifecycle/) | `crates/mc-host/src/{lifecycle,generation,connection,frame_read,panic_boundary}.rs` (~6.5k lines) | 55 records; portfolio evaluated; all 5 queued gaps mined and merged; 6 records superseded by the ring-transport refactor |
| part-2b-wire-and-channels | `crates/mc-host/src/{wire,frame_channel,tcp_frame_channel,transport_negotiation,transport_provider,composite}.rs` (~4.9k) | Parked — pending ring-transport refactor. No catalog; four completed lens files retained under `_lenses/` (A wire format, B channel egress, C negotiation and provider, D claims and existing checks), of which A, B, and C propose records and D is the claims-and-history inventory. All four describe the pre-refactor surface. |
| part-2c-auth-and-control | `crates/mc-host/src/{auth,instance,control,config,connection_file}.rs` (~5k) | Parked — pending ring-transport refactor |
| part-2d-dispatch-and-client | `crates/mc-host/src/{client,dispatch,routing,handler,runtime}.rs` (~8.4k) | Parked — pending ring-transport refactor |
| part-2e-subsystems | `crates/mc-host/src/{broca,synapse}/`, `harness_closure.rs` | Parked — pending ring-transport refactor |
| part-3-store-core | `crates/mc-store`, `crates/mc-core`, `crates/mc-tokenizer`: SQLite durability, claim mirror, migrations | Not started |
| part-4-module | `crates/mc-module`: transform, historian, selection | Not started |
| part-5-ts-surfaces | `packages/plugin`, `packages/pi-plugin`, `packages/cli`, `packages/retina-local-fs` | Not started |

`mc-host` is 28,026 lines of source across 29 modules, an order of magnitude
larger than Part 1, so Part 2 is sub-partitioned. `shm_provider.rs` and
`provider_recovery.rs` are not re-mined in Part 2: they are already cataloged as
Part 1 boundary context.

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
