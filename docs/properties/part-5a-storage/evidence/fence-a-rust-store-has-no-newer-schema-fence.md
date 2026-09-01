# fence-a-rust-store-has-no-newer-schema-fence

## Discovery trigger

The task asks whether a Rust binary can write a database this TypeScript layer
would refuse, and directs me to cite Part 3 for the Rust store's schema handling
rather than re-deriving it. Verifying the premise first changed the shape of the
answer: the two runtimes do not share a database file.

## Evidence trail

### The file-scope correction

Rust's fenced store is `store.db`. The name appears in
`crates/mc-store/src/lib.rs:1344` ("Highest `mc_cache` migration recorded in
`store.db`"), `:1368` ("Refuse a `store.db` whose `mc_cache` history predates the
consolidated bootstrap"), the operator message at `:3456-3457`, and the path
construction at `:13943` (`dir.join("store.db")`).

TypeScript's is `context.db`, from `resolveDatabasePath`
(`packages/plugin/src/features/magic-context/storage-db.ts:167-177`):
`join(dbDir, "context.db")` at `:176`.

`mc-module` states the separation twice, unprompted:

- `crates/mc-module/src/lib.rs:15451` — "The module never opens or attaches the
  host's context.db — the TypeScript plugin ..."
- `crates/mc-module/src/lib.rs:26264` — "The module does not read the host's
  context.db; the TS surface owns it."

A search for `context.db` across `crates/` returns five hits total: those two,
plus `mc-store/src/lib.rs:3458` (message text about project memory),
`:11018` ("Durably stage one claim command before the host mutates `context.db`")
and `:11550` ("context.db barrier until this transition has committed on the
module side"). None is an open.

So the direct answer to the task's question is: **no, a Rust binary cannot write
`context.db`,** and the fence is not being flanked on its own file. The two
comments at `:11018` and `:11550` are important for what follows, because they
show the two files are halves of one protocol.

### The Rust guard, cited from Part 3

`refuse_pre_cutover_store` (`crates/mc-store/src/lib.rs:1375-1385`):

```
fn refuse_pre_cutover_store(inner: &SqliteStore) -> Result<(), McStoreError> {
    match recorded_mc_cache_version(inner)? {
        Some(recorded) if recorded < OLDEST_ADOPTABLE_MIGRATION_VERSION => {
            Err(McStoreError::PreCutoverModuleStore { ... })
        }
        _ => Ok(()),
    }
}
```

The `_ => Ok(())` arm at `:1383` covers both `None` and
`Some(recorded)` where `recorded >= OLDEST_ADOPTABLE_MIGRATION_VERSION`, so an
above-ceiling version is admitted.

`recorded_mc_cache_version` (`:1346-1367`) checks that
`cortexkit_schema_version` exists in `main.sqlite_schema` (`:1349-1357`), reads
`COALESCE(MAX(version), 0)` for namespace `NS` (`:1359-1364`), and maps `0` to
`None` via `.filter(|version| *version > 0)` (`:1365`).

Part 3 established the consequence and I cite it rather than re-deriving:
`docs/properties/part-3-store-core/_lenses/lens-a-sqlite-durability.md:555-563`
records that `OLDEST_ADOPTABLE_MIGRATION_VERSION = LATEST_MIGRATION_VERSION`
(`lib.rs:1342`), that the guard is `recorded < OLDEST_ADOPTABLE` (`lib.rs:1377`),
that `run_migrations` skips every bundled version at or below `current`
(`cortexkit-store:363-365`), and concludes: "So an older binary opens a newer
database silently and queries it with the older binary's expectations."

Part 3 also records the call site: `lib.rs:4873 refuse_pre_cutover_store(&inner)`
inside `McStore::open`
([lens-a:89](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md)).

### The asymmetry

TypeScript fences the newer direction and admits nothing above its ceiling
(`storage-db.ts:669`). Rust fences the older direction and admits everything
above its ceiling (`lib.rs:1383`). Same hazard, two files, opposite coverage.

At one version skew an install therefore produces two verdicts: `context.db`
refused, `store.db` opened and written. The claim protocol spans both, per
`lib.rs:11018` and `:11550`.

## Failure scenario

1. A user runs a newer Magic Context generation once. It advances `context.db`'s
   `schema_migrations` past 90 or its marker epoch past 1, and advances
   `store.db`'s `cortexkit_schema_version` past the older binary's
   `OLDEST_ADOPTABLE_MIGRATION_VERSION`.
2. The user then runs an older generation, for example a pinned install in
   another harness. The scope map notes the fence message names exactly this
   cause: "A pinned or stale plugin is likely sharing this database with a newer
   instance" (`storage-db.ts:678`).
3. The TypeScript side refuses `context.db`, logs the fatal line, latches the
   rejection, and disables Magic Context for the run (`hook.ts:263-283`).
4. The Rust module opens `store.db` without complaint and applies the older
   binary's expectations to a newer schema. Part 3 records that no manifest
   digest, `application_id`, `user_version`, marker row or object inventory is
   checked for `store.db`
   ([lens-a:529-539](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md)),
   so nothing else catches it either.
5. The user-visible symptom is that Magic Context announces itself disabled while
   the module continues writing.

## Timing windows and dependencies

Part 3 records that the Rust predicate is split:
`refuse_pre_cutover_store` reads the recorded version in its own transaction and
`inner.migrate` re-reads it in the runner outside any transaction
([lens-a:490](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md),
`cortexkit-store:351-357`). It also records that the version-table creation and
the current-version read precede any transaction, and that the per-migration
`BEGIN` is DEFERRED rather than IMMEDIATE
([lens-a:408-414](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md),
`cortexkit-store:341-383`). The TypeScript bootstrap is a single
`db.transaction(...).immediate()` (`storage-db.ts:616-639`), so on this axis the
TypeScript side is the stronger of the two.

Part 4's finding that `mc-module` tests do not run in CI applies to the Rust half.
So the CI asymmetry compounds the guard asymmetry: the fenced direction is
continuously verified and the unfenced one is not verified at all.

## What a test must construct

This record's check is about the Rust side, so the construction is a Rust test:

1. Create a `store.db`, run `McStore::open` to bootstrap it.
2. Insert a `cortexkit_schema_version` row for namespace `mc_cache` at
   `OLDEST_ADOPTABLE_MIGRATION_VERSION + 1`.
3. Call `McStore::open` again and assert it returns
   `Err(McStoreError::PreCutoverModuleStore)` or a new above-ceiling error
   variant. Under the current code it returns `Ok`.

Part 3 names the two existing tests as `lib.rs:16140`
`fresh_and_current_module_stores_open_without_a_pre_cutover_refusal` and
`lib.rs:16089`
`pre_cutover_module_store_is_refused_by_family_not_by_ddl_collision`
([lens-a:413](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md),
`:429`), neither covering the newer direction.

## Investigation log

### Q: Can a Rust binary write `context.db`?

- Sources examined: every `context.db` occurrence in `crates/` (five, all
  comments or message text); `mc-module/src/lib.rs:15451` and `:26264`;
  `mc-store/src/lib.rs:13943` and the other `store.db` path constructions;
  `storage-db.ts:167-177`.
- Findings: no. The module asserts the separation in prose twice, and there is no
  open, attach or path construction for `context.db` anywhere in `crates/`.
- Missing evidence: I searched for the literal string `context.db`. A Rust path
  built from components, for example `join("context").join("db")`, would not
  match. I did not search for such a construction.
- Conclusion: resolved with answer, with that caveat stated. The two runtimes own
  different files, so the task's framing of a Rust binary flanking the
  TypeScript fence on the same file does not hold.

### Q: Does the asymmetry still matter given the file separation?

- Sources examined: `mc-store/src/lib.rs:11018`, `:11550`,
  `docs/properties/part-3-store-core/_lenses/lens-a-sqlite-durability.md:555-563`
  and `:529-539`; the Part 5 scope map's 5a rationale
  (`docs/properties/part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md:404-418`).
- Findings: yes, and arguably more than a shared-file bypass would. A shared-file
  bypass would be one guard with a hole. This is two guards covering opposite
  directions over two files that hold halves of one claim protocol, so one skew
  yields a split-brain install: fail-closed on one store, fail-open on the other.
  The scope map's own rationale ends "the protection is only as good as the
  TypeScript path being the only writer, which the claim outbox in
  `module-state-sync.ts` demonstrates it is not" (`:416-418`). That is correct in
  spirit; the precise mechanism is not a second writer to `context.db` but a
  second, less-guarded store.
- Missing evidence: what a module holding a newer `store.db` does when the host's
  `context.db` is unavailable. That is the sibling lens's territory and 4c/4d
  scope.
- Conclusion: resolved with answer for the asymmetry's existence and shape.
  The cross-store consequence is unresolved and belongs to the outbox lens.

### Q: Should `refuse_pre_cutover_store` gain an above-ceiling arm?

- Sources examined: `mc-store/src/lib.rs:1368-1385` (including the doc comment,
  which says "Old version ranges are not supported inputs
  (`docs/migration-version-lanes.md`), so this refuses rather than migrating"),
  Part 3's finding at
  [lens-a:555-563](../../part-3-store-core/_lenses/lens-a-sqlite-durability.md).
- Findings: the doc comment addresses only old ranges, so the function does what
  it says. Part 3 notes the enforcement is "stricter than the doc" in the older
  direction because the window is one version wide, "and worth stating: there is
  no forward compatibility either". The missing arm is a gap against the
  TypeScript layer's behaviour, not against this function's stated contract.
- Missing evidence: whether the project wants symmetric fencing or accepts the
  asymmetry because `store.db` is a rebuildable cache. The name `mc_cache` for the
  namespace (`lib.rs:1361`) hints at the latter, which would be a legitimate
  design answer.
- Conclusion: needs human input. If `store.db` is genuinely a rebuildable cache,
  the asymmetry may be intended and the right fix is documentation rather than a
  guard. If it holds unrecoverable claim state, it is a gap.
