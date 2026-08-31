# synchronous-level-is-explicitly-declared-not-inherited

## Discovery trigger

`docs/migration-version-lanes.md:47-51` lists four properties that "Application
connections verify", and the fourth is "declared synchronous mode". The word
"declared" implies some line of code declares it. Searching for the declaration
found none, and then found that the verifier which is supposed to check it
accepts a value that contradicts the durability the surrounding document
promises.

## Evidence trail

The claim:

- `docs/migration-version-lanes.md:47-51`:
  "Application connections verify: foreign keys enabled / WAL activation /
  configured busy timeout / declared synchronous mode".

The verifier:

- `crates/mc-store/src/sqlite_runtime.rs:110-112` doc comment: "Verify the
  per-connection contract after PRAGMAs are applied: foreign keys enforced, WAL
  activated (when expected), a busy timeout installed, and a declared
  synchronous mode."
- `sqlite_runtime.rs:133-138`:
  ```
  let synchronous: i64 = conn.query_row("PRAGMA synchronous", [], |row| row.get(0))?;
  if !(1..=3).contains(&synchronous) {
      violations.push(format!(
          "synchronous mode {synchronous} is not in the declared set [1, 2, 3]"
      ));
  }
  ```
  The accepted set is `{1, 2, 3}` = `{NORMAL, FULL, EXTRA}`. Only `0` (`OFF`)
  is rejected.

The declaration that does not exist:

- `cortexkit-store/src/lib.rs:265-327` `open_sqlite` is the only function that
  applies PRAGMAs to the real file. It sets `journal_mode` (`:287`),
  `busy_timeout` (`:289`), and `foreign_keys` (`:291`). It does not set
  `synchronous`.
- `crates/mc-store/src/lib.rs:4816-4905` `McStore::open` issues no PRAGMA at
  all. Its two `with_conn` calls register scalar UDFs (`:4825-4872`) and size
  the statement cache (`:4878-4881`).
- A content search for `synchronous` across `crates/mc-store/src`,
  `crates/mc-core/src`, `crates/mc-tokenizer/src`, and
  `cortexkit-store/src/lib.rs` returns exactly three production hits, all in
  `sqlite_runtime.rs`: the doc comment at `:112` and the read plus message at
  `:133-137`. The remaining hits are `crates/mc-store/tests/sqlite_runtime.rs:192`
  and `:199`.

## Failure scenario

Two distinct failures, one of which is live today.

**Live: the level is whatever the build chose.** A future `libsqlite3-sys` bump,
a switch from `bundled` to a system SQLite, or a distribution that compiles with
`-DSQLITE_DEFAULT_SYNCHRONOUS=1` changes the durability class of every
acknowledged write in this store, with no code change, no test failure, and no
diagnostic. The verifier would still pass, because `1` is in the accepted set.

**Latent: the verifier's set contradicts the document.** In WAL mode
`synchronous=NORMAL` does not fsync at commit; a commit becomes durable only at
the next checkpoint. Since no checkpoint policy is configured anywhere (no
`wal_autocheckpoint`, no `wal_checkpoint`, no `journal_size_limit` in either
crate), a `NORMAL` store acknowledges writes that are lost on power failure for
an unbounded amount of write volume. The verifier would report zero violations
for that store.

## Timing windows and dependencies

No timing window. This is a static configuration property, observable at any
point after `McStore::open` returns.

The dependency that matters is direction of control: `mc-store` cannot fix this
in `open_sqlite` because that function is in another repository
(`Cargo.toml:16` resolves `cortexkit-store` to `../commons/crates/cortexkit-store`).
It could set the pragma itself in `McStore::open` after `open_sqlite` returns,
since `with_conn` hands out a `&Connection` (`cortexkit-store:155-161`).

## What a test must construct

Trivially cheap, which is part of why its absence is notable:

1. `McStore::open` a temp-dir store.
2. Reach the connection through the store's own path and read
   `PRAGMA synchronous`.
3. Assert it equals a named constant that some production line sets.

Step 3 is what does not exist. The nearest existing test,
`crates/mc-store/tests/sqlite_runtime.rs:171-202`, builds a bare
`rusqlite::Connection`, sets the pragmas by hand at `:176-181`, and asserts the
verifier's own logic. It never touches a `McStore`. So the test proves the
verifier is correct and proves nothing about the store.

A second, stronger test would be a coverage check on the *preconditions* of the
`NORMAL` hazard rather than the hazard itself: assert that WAL is active, that
`synchronous` is readable, and that no code path forces a checkpoint. Those
three jointly create the window, and they fire on a correct implementation, so
they do not require observing data loss.

## Investigation log

### Q: Is `NORMAL` an intended, acceptable configuration for `store.db`?

- Sources examined: `docs/migration-version-lanes.md` in full (83 lines),
  `sqlite_runtime.rs:110-140`, `crates/mc-store/tests/sqlite_runtime.rs:171-202`,
  `cortexkit-store:285-292` and its comment "Durability + concurrency pragmas:
  WAL for concurrent readers, a busy timeout so a transient lock waits rather
  than erroring, foreign keys on."
- Findings: the dependency's comment enumerates the three pragmas it considers
  the durability contract and does not mention `synchronous`, which reads as a
  deliberate omission rather than an oversight. The document, in contrast, calls
  the mode "declared". The verifier accepts `NORMAL`. Three artifacts, three
  positions.
- Missing evidence: no design note, ADR, or comment states the intended
  durability class for `store.db`.
- Conclusion: needs human input. Either the accepted set should narrow to
  `{2, 3}` and a production line should set the pragma, or the document's
  language should be changed from "declared" to describe process-crash
  durability only. This lens does not pick.

### Q: Does the verifier's `1..=3` range have a stated rationale?

- Sources examined: `sqlite_runtime.rs:110-140` and the whole 185-line file;
  the git-tracked comment at `:89-91` explaining the engine-gate rationale by
  contrast.
- Findings: the engine gate has an explicit rationale comment. The synchronous
  range has none; the message text `"is not in the declared set [1, 2, 3]"`
  restates the code without justifying it.
- Missing evidence: none available in-tree.
- Conclusion: unresolved, needs the author's intent. Recorded as an open
  question on the catalog record rather than guessed.
