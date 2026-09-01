# setup-a-credentials-do-not-survive-a-host-incarnation

## Discovery trigger

Replay across incarnations was named as the hardest hazard to test. The connection
file is a bearer credential on disk. If its key persisted across host restarts,
one read of that file would be a permanent grant, and every other property on this
path would rest on filesystem permissions alone.

## Evidence trail

All references at commit `e447c927`.

Credential minting, `crates/mc-host/src/instance.rs:232-280`, inside
`InstanceGuard::acquire`:

- `:263-264`: `let mut key = [0u8; KEY_LEN]; getrandom::getrandom(&mut key)`.
- `:265-266`: the same for `daemon_id`, `DAEMON_ID_LEN` = 16
  (`connection_file.rs:29`).
- `:267-268`: the same for a 16-byte `launch_id`.

`KEY_LEN` is 32 (`connection_file.rs:28`) and `MIN_KEY_LEN` is also 32 (`:27`), so
`validate_key` (`auth.rs:369-377`) and `ConnectionInfo::validate` (`:74-79`) agree
on the length.

Ordering is deliberate and documented in the function's own doc comment at
`instance.rs:222-231`: "Takes the stable lifetime fence, secures the runtime
directory, acquires the runtime-directory lock, and mints fresh credentials — in
that order, so credentials never exist for an incarnation that lost a lock race."
The code matches: `LifetimeLock::acquire` at `:247`, `secure_runtime_dir` at
`:248`, `lock_instance` at `:249`, then the three `getrandom` calls.

Nothing persists them. `InstanceGuard` holds `key: ConnectionKey` and
`daemon_id: [u8; DAEMON_ID_LEN]` by value (`:194-195` region), and `publish`
(`:315-345`) copies them into the `ConnectionInfo` it serializes at `:326-327`.
There is no read-back-if-present branch and no keyfile.

`Drop` (`instance.rs:403-410`) removes the setup socket and calls
`remove_publication`, which is identity-fenced on `(dev, ino)` and on
`daemon_id` (`:351-400`, specifically the `info.daemon_id != self.daemon_id`
refusal at `:390`). So an incarnation never unlinks a successor's file.

Peer-side refusal, `crates/mc-host/src/auth.rs:303-367`, in order:

- `:326-332` recomputes the expected server proof from `conn.key`;
- `:333-335` returns `AuthError::InvalidServerProof` on mismatch;
- `:336-338` returns `AuthError::DaemonIdMismatch` if
  `server_proof.daemon_id != conn.daemon_id`;
- `:346-348` returns `AuthError::DaemonVerMismatch`;
- only after all three does `:357-363` write `ClientAuth`.

So a peer using a stale snapshot against a new incarnation fails at the first or
second of those and never emits its proof. The native peer is identical:
`packages/mc-shm-native/src/setup.rs:200-205` folds all three into one `if` before
the `write_message` at `:206-219`.

The wire doc states the intended behaviour at
`docs/mc-host-wire-protocol.md:218`: "Mixed-generation key, daemon-ID, and
daemon-version values therefore fail closed."

## Failure scenario

If the key were derived from a stable input, for example the data directory path,
the machine id, or a persisted seed file added for "reconnect without rediscovery",
then any process that read the connection file once would authenticate against
every future incarnation. Combined with
`setup-a-mapping-authority-derives-only-from-the-key-never-from-the-token`, that
is a permanent unrevocable grant to map host memory, and the only revocation
mechanism would be changing the data directory.

The subtler failure is partial. If `daemon_id` rotated but the key did not, a
stale snapshot would fail at `DaemonIdMismatch` on the peer side, which looks
identical from the outside. But a *hostile* peer does not have to run
`authenticate_client`: it can compute `ClientAuth` itself from the stale key and
the fresh `server_nonce` and `daemon_id` it just received, since both travel in
the clear in `ServerProof` (`auth.rs:31-37`). The host-side check at `:268-274`
folds in the *current* daemon id, so the proof verifies. Key rotation is therefore
the load-bearing half; daemon-id rotation only protects a well-behaved peer.

## Timing windows and dependencies

The realistic entry is a host restart while a client caches `ConnectionInfo`.
`crates/mc-host/src/client.rs:346` takes `info` by value and never re-reads the
file, so a long-lived client holds a snapshot indefinitely.

There is also a window at startup: `bind_owner_only` runs at `runtime.rs:836`
before `publish` at `:842`. Between them the new socket exists while the old
connection file may still be on disk, if the previous incarnation died without
running `Drop`. A peer reading in that window dials the new socket with the old
key and fails closed. That is the correct outcome and it is the cheapest way to
reach the property.

Depends on the instance lock actually serializing incarnations
(`instance.rs:249`, `:656-673`), which is Part 2a territory and should be cited
rather than re-proved.

## What a test must construct

1. Start a host, read and retain the `ConnectionInfo` snapshot.
2. Shut the host down gracefully and confirm the publication is gone.
3. Start a second host in the same data directory.
4. Dial the new `setup_socket` and call `authenticate_client` with the retained
   snapshot. Assert `AuthError::InvalidServerProof` or
   `AuthError::DaemonIdMismatch` specifically.
5. Assert no `ClientAuth` was written, by counting peer-to-host messages on the
   wire rather than by trusting the error variant.
6. The hostile variant: dial with a raw stream, send a fresh `ClientHello`, read
   the new `ServerProof`, compute `ClientAuth` from the *stale* key and the
   *fresh* nonces and daemon id, and assert the host returns
   `AuthError::InvalidClientAuth`. This is the case that actually tests key
   rotation rather than the peer's politeness.
7. A negative control: repeat step 6 with the fresh key and assert success.

Step 6 is the one that matters and it is the one no existing test performs.

`crates/mc-host/tests/host_roundtrip.rs:186` constructs a `ConnectionInfo` with a
borrowed `setup_socket` from a second host, which is adjacent but not the same
construction; it was not read in full in this pass.

## Investigation log

### Q: Is any credential read from disk rather than minted?

- Sources examined: `instance.rs:232-280`, `:315-345`, `connection_file.rs:182-221`,
  and a search for `getrandom` in `instance.rs` returning `:264`, `:266`, `:268`,
  `:597`.
- Findings: `:597` is inside `write_atomic_owner_only`, generating a temp-file
  name suffix, not a credential. `read_for_client` (`connection_file.rs:182-221`)
  is the only reader of the file and it lives on the peer side.
- Missing evidence: none.
- Conclusion: resolved. Both credentials are minted, never loaded.

### Q: Where are the bootstrap tests that `auth.rs:390-392` names?

- Sources examined: the comment at `auth.rs:385-403`, which says the always-false
  failure mode is "caught by the handshake integration tests and by two bootstrap
  tests -- named for key rotation and singleton probing". Searched
  `crates/mc-host/tests/` for `handshake`, `max_handshakes` and
  `unauthenticated`.
- Findings: the search surfaced `lifecycle.rs:237`, `:337`, `:1647`,
  `protocol_vectors.rs:245`, `:268`, `:294`, `:298`, `:305`,
  `handler_contract.rs:256`, `:289` and `support/raw_client.rs:878`. None is named
  for key rotation or singleton probing.
- Missing evidence: a repository-wide search including `packages/` and any
  bootstrap crate outside `crates/mc-host/tests/` was not run in this pass.
- Conclusion: unresolved, needs a repository-wide test search. Recorded on the
  record as an open question, and the `Existing check` line says "none direct"
  rather than crediting an unlocated test.

### Q: Does rotating `daemon_id` add anything beyond rotating the key?

- Sources examined: `auth.rs:246-252`, `:268-274`, `:336-338`,
  `packages/mc-shm-native/src/setup.rs:200-205`.
- Findings: the host folds its own current `daemon_id` into the expected proof, so
  a hostile peer holding a stale key but reading the fresh `ServerProof` can
  compute a matching `ClientAuth`. Daemon-id rotation therefore protects a
  well-behaved peer from talking to the wrong incarnation; it does not
  independently defeat a stale-key attacker.
- Missing evidence: none.
- Conclusion: resolved. Key rotation is the load-bearing half, and the test's step
  6 is written to target it.
