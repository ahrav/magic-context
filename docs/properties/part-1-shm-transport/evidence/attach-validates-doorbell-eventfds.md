# attach-validates-doorbell-eventfds

## Discovery trigger

Fix commit `fb2acc880`: "Transferred doorbells could block setup if they were
not nonblocking eventfds. Validate descriptor flags and identity before
attachment." The commit is the lead; every claim below was re-verified against
HEAD code.

## Evidence trail

- `Doorbell::create` (`crates/mc-shm-transport/src/backend/ring.rs:387-395`)
  makes an `eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK)`, so a locally created ring
  always holds nonblocking eventfds.
- `Doorbell::from_fd` (`ring.rs:397-409`) is the attach-side gate: `F_GETFL`
  must succeed and include `O_NONBLOCK` (`:399-402`), and the
  `/proc/self/fd/<fd>` readlink must equal exactly `anon_inode:[eventfd]`
  (`:403-408`). Any failure is `RingError::DoorbellFailed`.
- `Ring::attach` (`ring.rs:783-798`) takes `[OwnedFd; 3]` and routes both
  transferred descriptors through `Doorbell::from_fd` (`:793-794`), after
  mapping and lifecycle validation, before returning a usable ring.
- The gate matters because `signal` (`:416-428`) treats `EAGAIN` as success
  and `drain` (`:430-448`) treats `EAGAIN` as empty. On a blocking descriptor
  neither branch exists: an eight-byte read on an empty blocking eventfd
  blocks forever inside `drain`, and a saturated blocking eventfd blocks
  inside `signal`. On a non-eventfd the semantics of the u64 read/write
  protocol do not hold at all.
- Production attach paths that feed this gate: the host client bridge
  (`crates/mc-host/src/client.rs:1827` via
  `RingClientEndpoint::attach_with_descriptors`) and the native addon attach,
  both of which receive descriptors over the setup socket.

## Failure scenario

A peer (buggy or hostile) transfers a blocking eventfd, or a pipe, or any
other pollable descriptor in a doorbell slot. Attach succeeds. The first
`drain` on the empty descriptor blocks the attaching thread forever with no
deadline: `drain` runs inside `arm_data_wait` (`ring.rs:846`) and
`complete_data_wait` (`:861`), which run on the host bridge thread and inside
the addon's `readiness_handled`. Setup wedges silently; no error, no
quarantine.

## Timing windows and dependencies

None. The check is a pure predicate on the descriptor at attach time. The one
platform dependency is `/proc/self/fd`, which makes the identity half of the
gate Linux-shaped; a platform without that readlink would fail closed
(readlink error maps to `DoorbellFailed`).

## What a test must construct

- Negative arms: an eventfd without `O_NONBLOCK`, and a nonblocking
  non-eventfd (both exist today in
  `doorbell_attachment_requires_nonblocking_eventfd`, `ring.rs:2248-2270`).
- A full-`Ring::attach` negative: substitute one doorbell slot in an
  otherwise valid `[OwnedFd; 3]` and assert `DoorbellFailed` with no mapping
  side effects. Today's unit test calls `Doorbell::from_fd` directly, so the
  ordering claim (mapping validated before doorbells, no partial state
  leaked) is untested.
- Positive arm: a cross-process attach with genuine doorbells
  (`ring_child_exchange`, `tests/ring.rs:597-626`, does this).

## Investigation log

### Q: is the /proc readlink gate racy against fd reuse?

- Sources examined: `ring.rs:397-409`, `OwnedFd` semantics.
- Findings: the descriptor is owned (`OwnedFd`) for the whole check, so the
  fd number cannot be closed and reused underneath the readlink by safe code
  in this process.
- Missing evidence: none for the single-threaded ownership argument; no tool
  validates it against unsafe code elsewhere.
- Conclusion: resolved with answer — not racy while ownership is respected.

### Q: does anything downgrade the flags after attach?

- Sources examined: `set_inheritable` (`ring.rs:884-906`) is the only
  post-attach fcntl; it touches `FD_CLOEXEC` (F_SETFD), not `O_NONBLOCK`
  (F_SETFL).
- Findings: no F_SETFL call exists in the crate outside the unit test.
- Conclusion: resolved with answer — no.
