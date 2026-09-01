# setup-a-a-captured-client-proof-never-authenticates-twice

## Discovery trigger

The task named replay as the hazard to test hardest. The handshake has no
sequence number, no timestamp, and no server-side record of past handshakes, so
the only thing that can make a replay fail is the nonce pair. That makes the
property worth stating explicitly rather than assuming.

## Evidence trail

All references at commit `e447c927`.

The proof construction, `crates/mc-host/src/auth.rs:140-153`:

```
mac.update(domain.as_bytes());
mac.update(client_nonce);
mac.update(server_nonce);
mac.update(daemon_id);
```

`HMAC-SHA256` keyed on the connection key, over four concatenated inputs with a
domain string first. The two domains are `"subc-server-v1"` and
`"subc-client-v1"` (`auth.rs:19-20`), so a server proof can never be replayed as
a client proof.

Nonce provenance:

- `server_nonce`: `auth.rs:245` calls `random_nonce()`, defined at `:379-383`, one
  `getrandom::getrandom` into a fresh `[u8; 32]` per call. Called exactly once per
  `authenticate_server_inner`, after `ClientHello` is read at `:244`.
- `client_nonce`: arrives in `ClientHello` (`auth.rs:26-29`) and is used at
  `:246-252` and `:268-274` without any inspection. There is no freshness,
  uniqueness, or non-zero check anywhere on the host path.

The comparison, `auth.rs:267-277`: the host recomputes the expected `ClientAuth`
from the key, the client domain, the *client's* nonce, its *own* fresh nonce, and
its own daemon id, then compares with `constant_time_eq` (`:404-406`, wrapping
`subtle::ConstantTimeEq`).

So a replayed `ClientAuth` verifies only if the recomputed expectation matches,
which requires the same `server_nonce`. Since that nonce is 32 fresh random bytes
per handshake, a replay succeeds with probability 2^-256.

The contract states this reasoning explicitly:
`docs/mc-host-wire-protocol.md:177` says "Server-nonce freshness is the replay
defense: a reused server nonce would let an observer replay a previously captured
`client_auth` under a replayed client nonce."

The peer side matches: `packages/mc-shm-native/src/setup.rs:181-182` draws the
client nonce with `getrandom`, and `:222-235` is the same four-input construction
over byte-string domains (`:20-21`).

## Failure scenario

Suppose `random_nonce` were changed to a process-lifetime counter, or to a value
derived from the daemon id, or cached per accepted socket for performance. Then an
observer of one successful handshake replays `ClientHello` and `ClientAuth`
verbatim and authenticates. Because authentication is the sole authorization gate
(see `setup-a-no-descriptor-leaves-the-host-without-a-verified-client-proof`),
that replay yields ring descriptors.

The insidious variant is a counter. A counter is distinct on every handshake, so
`repeated_handshakes_receive_fresh_server_nonces` (`auth.rs:924-939`) still
passes, while an observer who can predict the next value can precompute a valid
`ClientAuth` without the key only if it also knows the key. Without the key a
counter does not break the HMAC. The real break is *reuse*, not predictability:
a cached-per-socket nonce, or a nonce drawn once at startup, breaks replay
resistance while remaining unpredictable to anyone without a transcript.

## Timing windows and dependencies

None. The defence is structural, not temporal. A replay may be attempted at any
time against any live host and must fail on the nonce mismatch alone.

Depends on the connection key not having rotated, since after rotation the replay
fails for a different reason and the test would pass without exercising the
nonce. So a replay test must run against the *same* live host incarnation that
produced the transcript. That is the distinguishing condition between this record
and `setup-a-credentials-do-not-survive-a-host-incarnation`.

## What a test must construct

Against one live host:

1. run one complete successful handshake through
   `mc_host::authenticate_client` and capture both peer-to-host messages verbatim,
   the `ClientHello` body and the `ClientAuth` body, as raw length-prefixed bytes;
2. open a second connection to the same socket;
3. write the recorded `ClientHello` bytes, read and discard the `ServerProof`,
   then write the recorded `ClientAuth` bytes;
4. assert the outcome is specifically `AuthError::InvalidClientAuth`
   (`auth.rs:275-277`), observed on the host side, not merely a closed socket.

Step 4's specificity is what makes the test non-vacuous. A closed socket is also
what a length-cap rejection, a JSON decode failure, and a timeout produce, so
asserting only "closed" would pass on an implementation that rejected the replay
for the wrong reason, including one that rejected *every* handshake.

`crates/mc-host/tests/support/raw_client.rs:878` already provides
`connect_unauthenticated`, which returns the raw stream needed for steps 2 and 3.

A negative control is required: replaying the same recorded `ClientHello` but a
*freshly computed* `ClientAuth` over the new `server_nonce` must succeed. Without
it the test cannot distinguish replay rejection from a host that stopped
authenticating anybody.

## Investigation log

### Q: Does the host inspect `client_nonce` at all?

- Sources examined: `auth.rs:232-280`, `:26-29`, `:140-153`.
- Findings: the field is destructured from `hello` and passed into
  `compute_proof` twice, at `:249` and `:271`. No length check beyond serde's
  fixed `[u8; NONCE_LEN]` deserialization, no value check.
- Missing evidence: none.
- Conclusion: resolved. `client_nonce` is fully peer-controlled and unvalidated
  beyond its length. The wire doc states the MUST for both nonces
  (`mc-host-wire-protocol.md:177`) but the host can only enforce its own half.
  Recorded as lead 5 in the lens.

### Q: Does the existing nonce-freshness test cover replay?

- Sources examined: `auth.rs:924-939`.
- Findings: the test runs `complete_handshake` twice and asserts the two
  `server_nonce` values differ. It never replays a `ClientAuth`.
- Missing evidence: none.
- Conclusion: resolved. It establishes the precondition of the defence and not
  the defence. Recorded as `Exercised: partial` and the existing check marked
  unaudited.

### Q: Can a captured `ServerProof` be replayed to impersonate the host?

- Sources examined: `auth.rs:326-338`, `packages/mc-shm-native/src/setup.rs:200-205`.
- Findings: the peer recomputes the expected server proof over its own freshly
  drawn `client_nonce` (`auth.rs:313`), so a replayed `ServerProof` fails at
  `:333-335` for the mirror-image reason. Both peer implementations do this.
- Missing evidence: none.
- Conclusion: resolved. The symmetric property holds and is covered by
  `setup-a-a-rogue-listener-at-the-published-path-obtains-no-client-proof`.
