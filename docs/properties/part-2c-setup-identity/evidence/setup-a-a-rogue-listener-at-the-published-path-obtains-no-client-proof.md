# setup-a-a-rogue-listener-at-the-published-path-obtains-no-client-proof

## Discovery trigger

The socket path is fully predictable, `${dataDir}/cortexkit/run/setup.sock`, and
neither peer implementation inspects the socket before connecting. So the question
"can an attacker who creates the path first impersonate the host?" has to be
answered by the handshake rather than by the filesystem.

## Evidence trail

All references at commit `e447c927`.

Neither peer checks the socket:

- Managed Rust: `crates/mc-host/src/client.rs:346-350`,
  `UnixStream::connect(&info.setup_socket)` with no preceding stat. Contrast the
  same file's discovery path, which reaches `read_for_client` and its full
  no-follow, owner, mode, bounded-read and replacement checks
  (`connection_file.rs:182-221`).
- Native: `packages/mc-shm-native/src/setup.rs:106`,
  `UnixStream::connect(path)?`, likewise unchecked.
- Test support does the same: `crates/mc-host/tests/support/raw_client.rs:879`.

So impersonation is defeated by mutual authentication alone. The peer's three
checks, all before it emits anything secret:

`crates/mc-host/src/auth.rs:303-367`:

- `:325` reads `ServerProof`.
- `:326-332` recomputes the expected proof from `conn.key`, the
  `SERVER_PROOF_DOMAIN`, its own freshly drawn `client_nonce` (`:313`), the peer's
  `server_nonce`, and the peer's `daemon_id`.
- `:333-335` returns `AuthError::InvalidServerProof` on mismatch.
- `:336-338` returns `AuthError::DaemonIdMismatch` when the presented daemon id is
  not the one in the connection-file snapshot.
- `:346-348` returns `AuthError::DaemonVerMismatch`. The comment at `:339-345`
  explains why: `daemon_ver` is not an HMAC input, so this comparison is what binds
  the reported version to the authenticated snapshot.
- `:357-363` is the only `ClientAuth` write, reached only after all three.

`packages/mc-shm-native/src/setup.rs:174-220` is the same sequence with the three
checks folded into one `if` at `:200-205`, using `ct_eq` on both the proof and the
daemon id and `!=` on the version string, and the `ClientAuth` write at `:206-219`
after it.

A rogue listener therefore obtains: one `ClientHello` containing a random nonce and
the string `"client"`. That is all. It cannot produce a `ServerProof` that verifies
without the key, so it never receives `ClientAuth`.

The error taxonomy keeps the three reasons distinct
(`auth.rs:130`, `:131`, `:136`), which is what makes a negative test able to
assert the reason rather than merely the refusal.

## Failure scenario

If the peer emitted `ClientAuth` before verifying, or verified only the proof and
not the daemon id, a rogue listener would collect a valid `ClientAuth` over
nonces it chose. That is not directly a credential, because it is bound to the
nonce pair, but it is a chosen-nonce oracle on `HMAC-SHA256(key, ...)`. An attacker
who can request many such proofs over chosen `server_nonce` values has a much
better position than one who cannot, and the whole point of ordering the checks
first is to deny it.

The realistic route in is a same-uid squatter. Windows exist in
`bind_owner_only`: between `remove_file` (`setup_socket.rs:39`) and `bind` (`:44`)
a same-uid attacker can take the name. But the consequence there is the host
failing to start and publishing nothing, so no peer ever dials. The dangerous
ordering is the reverse: attacker binds first, host is not running, and a peer
dials using a stale connection file that names the same path. That is reachable,
and it is exactly what this property covers.

## Timing windows and dependencies

No temporal window in the property itself; it is an ordering invariant inside one
function on the peer side.

The enabling state is a stale connection file naming a path an attacker has taken.
`InstanceGuard::drop` (`instance.rs:403-410`) removes the socket and then the
publication, and `remove_publication` (`:351-400`) is identity-fenced on
`(dev, ino)` and on `daemon_id`, so a graceful exit leaves neither. An abnormal
exit can leave both, and then the attacker's window is open until a new
incarnation republishes.

Depends on the peer holding a snapshot whose key does not match the attacker,
which is the normal case since the attacker cannot read the `0600` file. If the
attacker *can* read the connection file, this property is irrelevant: it holds the
key and does not need to impersonate.

## What a test must construct

An impostor listener, in-process:

1. create a `UnixStream::pair`, treat one end as the impostor host;
2. read the peer's `ClientHello`;
3. reply with a syntactically valid `ServerProof` whose `server_proof` is 32
   arbitrary bytes;
4. assert the peer returns `AuthError::InvalidServerProof` and assert, by counting
   bytes readable on the impostor end, that the peer wrote exactly one message.

Then repeat with a correct proof but a wrong `daemon_id`, asserting
`DaemonIdMismatch`, and with a correct proof and daemon id but a wrong
`daemon_ver`, asserting `DaemonVerMismatch`.

The byte-count assertion in step 4 is the load-bearing part. Asserting only the
error variant proves the peer noticed; it does not prove the peer stayed silent.

The native peer needs the same three cases driven through `setup::connect` or
`connect_setup`, because it is a separate implementation of the same ordering
(`packages/mc-shm-native/src/setup.rs:200-205`) and nothing keeps the two lists in
step.

## Investigation log

### Q: Do the existing tests already cover all three refusal reasons?

- Sources examined: `auth.rs:1022-1073` `rejected_server_sends_no_client_auth`,
  `:1074-1081` `invalid_server_proof_sends_no_client_auth`, `:1082-1089`
  `daemon_id_mismatch_sends_no_client_auth`, and the comment at `:385-403`.
- Findings: the shared helper is driven by two callers, covering the proof
  mismatch and the daemon-id mismatch. No caller for the `daemon_ver` mismatch was
  found, even though `AuthError::DaemonVerMismatch` (`auth.rs:136`) has a doc
  comment explaining its purpose. The comment at `:394-395` also names
  `foreign_server_reused_port_never_receives_client_auth` as the always-true guard;
  that test was not located in `crates/mc-host/src/auth.rs`, so it lives
  elsewhere.
- Missing evidence: the location of
  `foreign_server_reused_port_never_receives_client_auth`.
- Conclusion: resolved as partial. Two of three reasons covered on the host-side
  unit suite; the `daemon_ver` case and the native implementation are uncovered.

### Q: Does the impostor learn anything from the `ClientHello`?

- Sources examined: `auth.rs:26-29`, `:314-323`,
  `packages/mc-shm-native/src/setup.rs:183-191`.
- Findings: the message carries a 32-byte random nonce and the literal role string
  `"client"` (`auth.rs:21`, native `setup.rs:187`). Neither is secret. Nothing
  derived from the key is sent before `ClientAuth`.
- Missing evidence: none.
- Conclusion: resolved. The `ClientHello` is safe to leak by construction.

### Q: Should the peer stat the socket before connecting?

- Sources examined: `client.rs:346-350`, `connection_file.rs:182-221`, native
  `setup.rs:95-106`.
- Findings: the asymmetry is real. The connection *file* is validated to a high
  standard, including no-follow traversal, owner, mode, single hard link, bounded
  read and a replacement check. The socket it names is opened with no check at all.
  Mutual authentication makes that sound, but it means the two artifacts on the
  same trust path are held to very different standards.
- Missing evidence: no design note explaining the asymmetry.
- Conclusion: needs human input. Recorded as the record's open question.
