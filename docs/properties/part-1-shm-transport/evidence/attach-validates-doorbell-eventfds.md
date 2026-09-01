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

The gate itself is a pure predicate evaluated once, at attach time, and there
is no window *inside* it. But it is not the whole story, because `O_NONBLOCK`
is not a property of the descriptor this process holds. Descriptors reach the
attaching side over `SCM_RIGHTS` (`setup_socket.rs:149` sends,
`:215-227` receives), which duplicates the *descriptor* while both sides keep
referring to the **same open file description**. `O_NONBLOCK` is a file-status
flag living in that shared description, so `fcntl(F_SETFL)` on any descriptor
naming it — including one the sender retained — clears it for this process too.
`FD_CLOEXEC` is the opposite case, a per-descriptor flag, which is why
`set_inheritable`'s `F_SETFD` (`ring.rs:884-906`) carries no equivalent risk.

That leaves a **post-attach mutation window** running from the moment
`Doorbell::from_fd` returns to the end of the ring's life. A peer that clears
`O_NONBLOCK` inside it reinstates exactly the failure below, past the gate:
`drain` (`ring.rs:430-448`) is a bare `read()` that only distinguishes
`EAGAIN`, and both of its callers invoke it precisely when the eventfd is
expected to be empty and neither guards it with a `poll` — `arm_data_wait`
drains at `:846` after establishing that no data is available, and
`complete_data_wait` drains unconditionally at `:861`. On a descriptor whose
`O_NONBLOCK` was cleared, that read blocks forever.

Scope of the claim, therefore: **the gate establishes that the descriptor was a
nonblocking eventfd at attach time, and nothing more.** It does not establish
that the descriptor stays nonblocking, and the guarantee holds only against a
peer that never mutates the shared file-status flags after the transfer. A
hostile peer is in this part's threat model, and the untrusted side is the one
holding the other descriptor, so the residual exposure is real: a client that
clears the flag can wedge a host thread inside `drain`. This window is
uncatalogued and untested; it is a gap, not a resolved question.

The one platform dependency is `/proc/self/fd`, which makes the identity half
of the gate Linux-shaped; a platform without that readlink would fail closed
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
- The post-attach window: attach with valid doorbells, then clear
  `O_NONBLOCK` from the descriptor the *other* side retained, then drive an
  empty `drain` through `arm_data_wait` and assert against an explicit
  deadline. This has no assertion today and no record owns it.

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
  post-attach fcntl in this crate; it touches `FD_CLOEXEC` (F_SETFD), not
  `O_NONBLOCK` (F_SETFL). `setup_socket.rs:149` and `:215-227` for how the
  descriptors are transferred.
- Findings: no F_SETFL call exists in the crate outside the unit test —
  but that search cannot answer this question. The descriptors arrive over
  `SCM_RIGHTS`, so the sender's retained descriptor and this one name the same
  open file description, and `O_NONBLOCK` is a file-status flag on that shared
  description rather than on either descriptor. A peer process can therefore
  clear it with `F_SETFL` at any time after the gate passes, and no amount of
  searching this crate would show it.
- Missing evidence: nothing pins the flag's value between attach and each
  `drain`. No test exercises a peer clearing it, and no record owns the
  resulting window.
- Conclusion: **corrected — yes, a peer can.** Nothing in *this process*
  downgrades the flags, which is what the original in-crate search actually
  established; the earlier "no" over-read that scope. See the post-attach
  mutation window under Timing windows above.
