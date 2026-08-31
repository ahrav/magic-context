# validation-and-enumeration-address-one-directory-object

Scope note: the directory objects here are payload generations — content-addressed
on-disk directories under `generations/`, named by the SHA-256 of their canonical
manifest bytes. Nothing in this record concerns the connection generations of
`connection.rs`, which have no filesystem identity at all.

## Discovery trigger

The class recurred. `a9489c35` fixed it in validation; `0827dbc8` fixed the same
split in `prune` eight review rounds later, and its own message says so: "the same
correction already applied to validation's unlisted-entry walk". Two independent
discoveries of one shape is the trigger to sweep rather than patch.

## Evidence trail

Both instances read as diffs. In `a9489c35` the unlisted-entry walk re-resolved
the digest pathname while the manifest-listed files were verified through the
retained descriptor, so a replacement holding only the expected names satisfied
the walk while the returned `ValidatedGeneration` still pinned the original
directory and its unlisted content. The fix is `walk_generation_tree(dir, ...)`
at `crates/mc-host/src/generation.rs:675`, with the reasoning recorded at
`:666-673`. In `0827dbc8` `prune` enumerated with
`std::fs::read_dir(self.root.join(GENERATIONS_DIR_NAME))` while every
`remove_tree` below it acted on `generations_fd`, so a replacement directory at
that name, populated with chosen names, could drive deletions inside the pinned
store. The fix is `read_dir_names(&self.generations_fd)` at `:990`, reasoning at
`:986-989`. `read_dir_names` (`:1369-1384`) enumerates the open directory
description through `Dir::read_from`, which is what makes the listing
unredirectable.

## The sweep

Inside `generation.rs`, no third instance of that shape exists. Every
directory-relative operation in production code resolves against a pinned
descriptor — `root_fd`, `generations_fd`, `temp_fd`, or a `dir`/`parent`
argument. The only non-descriptor filesystem call in production code is
`std::fs::symlink_metadata(&spec.source)` at `:738`, and its subject is a staging
*source*, not a store object; it feeds capacity sizing only, and
`copy_source_into` re-opens the same source by pathname at `:1038` under a
before/after identity check (`:1045`, `:1132-1141`).

The class does survive, in two weaker forms.

First, at the `ValidatedGeneration::path()` boundary. That accessor (`:315`) is
the deliberate escape hatch, documented at `:312-314` as requiring every consumer
to perform its own validation. One consumer honours the descriptor:
`generation_launcher` (`crates/mc-module/src/bin/ck-mc-host.rs:929-945`) uses
`open_verified_file`. The other does not:
`crates/mc-module/src/bin/ck_mc_host/serve.rs:509` and `:529` hand
`generation.path().join(BUNDLE_DIR)` and `generation.path().join(ORT_LIBRARY)`
downstream as pathnames. The comment at `serve.rs:510-517` states the hazard in
the property's own terms — "a directory replaced after validation could serve
different embedding bytes under a generation the daemon still reported as valid"
— and mitigates it by forwarding the manifest's SHA-256 so the loader verifies
content. So two store objects are addressed by re-resolved pathname, guarded by
content hash rather than by descriptor pinning.

Second, entry-level double resolution under an identical pinned parent, at three
sites. In `prune`, a name comes from the pinned listing (`:990`),
`is_quarantined_schema` re-opens it (`:942`), and `remove_tree` opens it a third
time (`:1010`, then `:1350`): the classification descriptor and the removal
descriptor are distinct opens. In `promote_temp`, `validate(digest)` at `:887`
and again at `:909` each open the digest name fresh (`:606`), and the
`ValidatedGeneration` from `:909` is discarded. In `walk_generation_tree`,
`statat` decides an entry's type (`:1323`) and `open_child_dir` then opens it
(`:1328`), while the `S_IFREG` arm (`:1332-1334`) records a name from `statat`
alone even though the hash check opened that file separately at `:662`.

These are not the fixed shape: the parent is identical in each, so nothing at the
`generations` name can redirect them, and `open_child_dir` re-applies the
owner-only predicate on every open (`:1259-1266`). What they share with the class
is exactly what the property statement names — the read, walk, or removal does not
go through a descriptor the operation pinned for that entry. One limit is
structural: `remove_tree`'s final `unlinkat(parent, name, AtFlags::REMOVEDIR)`
(`:1357`) has no fd-based equivalent, so a fully descriptor-relative removal is
not expressible and the property can only ever be about the parent.

## Failure scenario

Both shipped instances turned a validation or a deletion into a decision about a
directory other than the one the operation was holding. The prune instance is the
worse of the two, because `0827dbc8` notes the consequence is unrecoverable: "the
later namespace-anchor failure cannot bring those bytes back." The surviving
`serve.rs` form fails differently — a replaced bundle directory is caught by the
forwarded hash, so the failure is a rejected start rather than served bytes,
provided the loader actually verifies.

## Timing windows and dependencies

Fault class H6: a directory replacement between the pin and the use, under the
transaction lock. The `serve.rs` window is wider than the in-store ones, since it
spans from `validate` in `serve::run` (`serve.rs:544-547`) to whenever the loader
resolves the pathname, in a process that holds `lifetime.lock` rather than
`transaction.lock`.

## What a test must construct

For the in-store shape, a replacement directory planted at the operation's name
between the pin and the walk or removal — Linux-gated, and the two fixed
instances have regressions. For the `serve.rs` shape, a bundle directory replaced
after `validate` returns and before the loader reads it, asserting that the
forwarded SHA-256 rejects it. Nothing constructs the second today, and nothing
prevents a fourth instance appearing at the `path()` boundary.

## Investigation log

### Q: How many more instances exist? A sweep of every pathname-based call in the store would settle it.

- Sources examined: every filesystem call site in `generation.rs`
  (`std::fs::*`, `openat`, `statat`, `chmodat`, `mkdirat`, `unlinkat`,
  `renameat`, `renameat_with`, `Dir::read_from`), production code only;
  `git show a9489c35` and `git show 0827dbc8` for both diffs; all consumers of
  `ValidatedGeneration::path()` and `open_verified_file`
  (`ck-mc-host.rs:929-945`, `serve.rs:492-533`).
- Findings: as above. Zero remaining instances of the directory-level shape
  inside `generation.rs`; two pathname handoffs of store objects at
  `serve.rs:509` and `:529`; three entry-level double resolutions under an
  identical pinned parent.
- Missing evidence: whether `load_bundle` and the ORT loader actually verify the
  forwarded hashes against the bytes they read. `crates/mc-host/src/synapse/`
  is outside this catalog's scope, so the `serve.rs` mitigation is asserted by
  its comment rather than verified here. Also unestablished: whether any of the
  three entry-level resolutions is reachable by a writer that is not excluded by
  `transaction.lock`.
- Conclusion: the sweep is done for `generation.rs` and answers the question
  there — no third instance. It does not close the property, because the class
  reappears at the `path()` boundary in a different crate under a different
  mitigation, and that boundary has no regression test.
