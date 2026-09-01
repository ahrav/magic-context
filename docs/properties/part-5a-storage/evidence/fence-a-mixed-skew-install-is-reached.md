# fence-a-mixed-skew-install-is-reached

## Discovery trigger

Every other record in this lens is a reading of one side. The cross-language
asymmetry only becomes a behaviour when both verdicts occur on one install at one
skew, and nothing in the campaign produces that state. This is the situation-
coverage record that makes the asymmetry observable rather than inferred.

## Evidence trail

The two halves, each verified independently at `HEAD`.

**TypeScript half: `context.db` is refused.** `refuseNewerSchemaFence`
(`packages/plugin/src/features/magic-context/storage-db.ts:651-681`) refuses when
`persistedVersion > latestSupportedVersion || persistedEpoch > DIRECT_FORMAT_EPOCH`,
the negation of the accept condition at `:669`. It logs at `:677-679`, latches at
`:672`, and both call sites (`:689`, `:777-780`) turn that into a `null` return.
`hook.ts:263-283` then records a `schema_fence` init failure and
`notifyMagicContextDisabled` runs at `:262`. `index.ts:414-421` sends a Desktop
warning. `pi-plugin/src/index.ts:793-794` reads the same latches.

**Rust half: `store.db` is opened.** `refuse_pre_cutover_store`
(`crates/mc-store/src/lib.rs:1375-1385`) refuses only
`Some(recorded) if recorded < OLDEST_ADOPTABLE_MIGRATION_VERSION` (`:1377-1382`);
`_ => Ok(())` at `:1383` admits every above-ceiling version. Part 3 states the
consequence: "an older binary opens a newer database silently and queries it with
the older binary's expectations"
([lens-a:555-563](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md)).
Cited, not re-derived.

**Why they are one install and not two unrelated stores.** The claim protocol
spans both files. `crates/mc-store/src/lib.rs:11018` describes staging "one claim
command before the host mutates `context.db`", and `:11550` refers to a
"context.db barrier until this transition has committed on the module side". The
Part 5 scope map's 5a rationale reaches the same conclusion from the TypeScript
end: the fence's "protection is only as good as the TypeScript path being the only
writer, which the claim outbox in `module-state-sync.ts` demonstrates it is not"
(`docs/properties/part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md:416-418`).

**Why the skew is a real operational state and not a contrivance.** The fence's
own message names the cause: "A pinned or stale plugin is likely sharing this
database with a newer instance; update or unpin Magic Context with
'npx @cortexkit/magic-context@latest doctor --force', then restart."
(`storage-db.ts:678`). The message exists because the situation was anticipated.
The scope map records that two harnesses ship against the same storage
(`packages/plugin` for OpenCode, `packages/pi-plugin` for Pi), and
`storage-db.ts:495-503`'s comment mentions "harnesses that open the DB before
loading config (Pi)", so multi-harness installs are normal.

## Failure scenario

The state itself is the thing to reach, not a failure. What follows from it:

1. A user runs a newer generation once. `context.db` gains a fence row above 90
   or a marker epoch above 1; `store.db` gains a `cortexkit_schema_version` row
   above the older binary's ceiling.
2. The user runs an older generation, in the same harness or another.
3. TypeScript refuses `context.db`. Magic Context reports itself disabled.
   Nothing is written. This half is correct and is the fence working.
4. Rust opens `store.db` and writes it, applying older expectations to a newer
   schema. Part 3 records that no manifest digest, `application_id`,
   `user_version`, marker row or object inventory is checked for `store.db`
   ([lens-a:529-539](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md)),
   so nothing else intervenes.
5. The observable contradiction: one process reports storage unavailable while
   the module half of the same install continues writing durable state.

## Timing windows and dependencies

No race. The enabling condition is version skew across two runs, which is a
sequential, reproducible state.

Two dependencies constrain how the state is reached:

- The older binary must be older than the newer one on **both** ceilings. If it
  is older only on the TypeScript ceiling, `store.db` is not newer and half the
  state is missing. `LATEST_SUPPORTED_VERSION` is 90 (`storage-db.ts:98`,
  `migrations.ts:4-6`) and moves rarely, per `storage-db.ts:664-665`
  ("it only moves on a breaking format change"). The Rust ceiling is
  `OLDEST_ADOPTABLE_MIGRATION_VERSION = LATEST_MIGRATION_VERSION`
  (`lib.rs:1342`, per Part 3), which Part 3 records as 57 and which moves per
  migration. So in practice the Rust ceiling moves more often, and a skew that is
  newer on `store.db` but not on `context.db` is the more likely natural state.
  Reaching the full mixed state may need the fixtures to be built rather than
  produced by two real releases.
- Whichever way the state is built, the two databases must be a matched pair for
  one install, or the claim-protocol coupling is not present.

## What a test must construct

The situation, not a violation. Per `METHOD.md:64` and `:71-74`, this is
`sometimes`: a campaign can execute both the TypeScript refusal lines and the Rust
`Ok(())` line in unrelated tests while never producing one install where both hold.

1. One storage directory containing a matched `context.db` and `store.db`.
2. `context.db` advanced past this build's fence on one axis: a
   `schema_migrations` row at `LATEST_SUPPORTED_VERSION + 1`, or a valid marker at
   `formatEpoch: 2`.
3. `store.db` advanced past the Rust ceiling: a `cortexkit_schema_version` row for
   namespace `mc_cache` above `OLDEST_ADOPTABLE_MIGRATION_VERSION`.
4. Run the older binary generation against that directory.
5. Assert both simultaneously: `getSchemaFenceRejection()` is non-null for
   `context.db`, and `McStore::open` on the paired `store.db` returned `Ok` with
   `module_store_schema_version()` above the binary's ceiling.

The marker for a coverage check should assert the independent preconditions
rather than the contradiction, per `METHOD.md:79-86`: that `context.db`'s vintage
exceeds the TypeScript ceiling, and that `store.db`'s recorded version exceeds
the Rust ceiling, and that both files belong to one storage directory. Those three
jointly create the state and still fire if both guards were later made symmetric.

## Investigation log

### Q: Which harness can drive both runtimes at two versions?

- Sources examined: the Part 5 scope map's exclusion of `packages/e2e-tests` as
  harness (`:74-77`) and its CI inventory (`:319-341`), which lists
  `test:opencode-e2e` at `ci.yml:722` and `test:pi-e2e` at `:771`, both with
  `--mode ts`, plus `test:incidents --mode ts` at `:824`.
- Findings: the `--mode ts` flag on all three e2e invocations suggests a mode axis
  exists, which implies a Rust mode is also drivable. That is the only harness in
  the repository that runs a full install. But the scope map excludes
  `packages/e2e-tests` from Part 5 on the grounds that "a property catalog of a
  harness is a category error" (`:77`), which is about cataloging it, not about
  using it.
- Missing evidence: whether the e2e harness can install two versions in one run,
  or whether the fixtures would have to be hand-built as step 2 and 3 above
  describe. I did not read the harness.
- Conclusion: unresolved, needs a harness-fit decision from the fault-map pass.
  My reading is that hand-built fixtures are more likely to work than a genuine
  two-version install, and that they are sufficient because the property is about
  the two verdicts co-occurring, not about how the vintages got there.

### Q: Is the full mixed state naturally reachable, or only constructible?

- Sources examined: `storage-db.ts:98`, `:664-665`, `migrations.ts:4-6`,
  `crates/mc-store/src/lib.rs:1342` via Part 3
  ([lens-a:555-563](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md)).
- Findings: the two ceilings move on different cadences. The TypeScript fence
  version is pinned to a retired lane head and described as moving only on a
  breaking format change; the marker epoch is the axis expected to move instead.
  The Rust ceiling equals the latest migration version and therefore moves with
  ordinary migrations. So a real two-release skew most likely produces a newer
  `store.db` with an unchanged `context.db` vintage, which is the Rust-only
  half rather than the mixed state.
- Missing evidence: the actual release history of both ceilings. Not examined.
- Conclusion: unresolved, needs the release history. The practical consequence is
  that the campaign should construct the fixtures rather than wait for a natural
  skew, and that the Rust-only half is a distinct and more likely state that may
  deserve its own record in a later pass.

### Q: Does reaching this state require the claim outbox to be active?

- Sources examined: `crates/mc-store/src/lib.rs:11018`, `:11550`; the Part 5
  scope map's assignment of the outbox to a sibling lens (`:459-471`).
- Findings: no. The two verdicts occur at open time, before any claim traffic. The
  outbox coupling is why the state matters, not a precondition for producing it.
- Missing evidence: none.
- Conclusion: resolved with answer. The state is reachable at open, so the test
  does not need to drive claim traffic. What happens to in-flight claims in that
  state is the sibling lens's question.
