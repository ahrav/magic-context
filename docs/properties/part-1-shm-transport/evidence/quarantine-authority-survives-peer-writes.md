# quarantine-authority-survives-peer-writes

## Discovery trigger

The hostile-peer lens, applied field by field to the shared control pages. The
peer maps the whole object read-write and the required seal set omits
`F_SEAL_WRITE`, so every field in the mapping was checked for peer writability.
The quarantine flag is one of them, and it is the only field that carries a
terminal local decision.

## Evidence trail

- `crates/mc-shm-transport/src/backend/ring.rs:126-137` declares
  `struct LifecyclePage`, with `quarantined: AtomicU8` at `:136`. The flag lives
  in the shared mapping and nowhere else.
- `ring.rs:719-727` declares `struct Ring` with exactly seven fields: `mapping`,
  `layout`, `grant`, the two eventfd doorbells `data_ready` and `capacity_ready`
  (post-#131, replacing the former `scheduling` field), `owned_runtime_dir`, and
  `_not_send_or_sync: PhantomData<Rc<()>>`. There is no local mirror of the
  flag, so no local state can outlive a peer's overwrite of the shared byte.
- `ring.rs:1373-1378` is `enter_quarantine`. The store is at `:1376`:
  `unsafe { (*page).quarantined.store(1, Ordering::Release) }`. **Correction:**
  the catalog cites `ring.rs:1373`, which is the function signature.
- `ring.rs:1381-1388` is `is_quarantined`. It loads with `Ordering::Acquire` at
  `:1385` and ends `.unwrap_or(true)` at `:1387`, so a failed pointer
  computation reads as quarantined. That fail-closed behaviour covers a bad
  pointer, not a hostile value.
- The gates re-read the flag on every call: `:913` (`try_reserve`), `:1056`
  (`try_receive`), `:1176` (`release`), `:1251` (`conservation`), `:1337`
  (`probe`). A repository-wide grep for `is_quarantined` across `crates/` and
  `packages/mc-shm-native/src` returns exactly these five call sites plus the
  definition at `:1381` and one in-file unit-test assert (`ring.rs:2366`), so
  nothing latches the value.
- `ring.rs:321` (`Mapping::create`) and `ring.rs:342` (`Mapping::attach`) both
  pass `libc::PROT_READ | libc::PROT_WRITE` with `MAP_SHARED`.
- `ring.rs:2128-2135` (`validate_seals`) requires
  `F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL`, and `ring.rs:2167-2170`
  (`seal_object`) applies the same three. `F_SEAL_WRITE` appears nowhere in the
  file, so the lifecycle page stays writable through the peer's own mapping.
- `packages/mc-shm-native/src/lib.rs:283` and `:290` show the addon raising
  quarantine on a failed alias detach, which is the trigger most likely to
  matter in practice: the flag is what keeps the storage condemned while a
  JavaScript view may still be attached.

## Failure scenario

1. The receiver validates a peer-authored descriptor, validation fails, and
   `try_receive` calls `enter_quarantine()` at `ring.rs:1098`. The shared byte
   becomes 1.
2. The local side now treats the direction as terminal. Charges are retained
   rather than returned, per `docs/mc-host-shm-transport.md:79`.
3. The peer stores `0` to the same byte through its own writable mapping. No
   seal and no page protection prevents this.
4. The next local `try_reserve` re-reads the flag at `ring.rs:913`, observes
   zero, and admits a reservation into storage the local side condemned. The
   same holds for `try_receive`, `release`, `conservation`, and `probe`.

The consequence is that storage whose alias state is unknown becomes reusable
again, which is exactly what quarantine exists to prevent
(`docs/mc-host-shm-transport.md:79`).

## Timing windows and dependencies

The window is unbounded. Because every gate re-reads the shared byte rather
than latching it, a peer write at any time after `enter_quarantine()` takes
effect on the very next operation, and it stays in effect until something
re-raises the flag. There is no configuration that closes it: the seal set is
fixed in code, and both mapping paths request write access unconditionally.
Platform gating matters only for the seal check, which is Linux-only
(`ring.rs:2131` sits behind `validate_seals`, called from `Mapping::attach` under
`#[cfg(target_os = "linux")]`); on macOS there are no seals at all, so the
exposure is not narrower. This property is upstream of
`quarantine-gates-cover-every-storage-mutation` and
`attach-refuses-a-quarantined-object`: both assume the flag reads 1 once set.

## What a test must construct

A second process, or a second mapping of the same descriptor in the same
process, that writes the flag byte directly rather than calling any `Ring`
method. Concretely: derive the byte address as
`mapping.base + layout.lifecycle + offset_of!(LifecyclePage, quarantined)`,
raise quarantine on the first handle, then store `0u8` through the second
handle, then assert that `try_reserve`, `try_receive`, `release`, and `probe` on
the first handle still return their `Quarantined` variant. A test that only
calls `enter_quarantine()` and then re-checks the gates, as
`crates/mc-shm-transport/tests/ring.rs:240`
(`quarantine_rejects_all_operations_and_reports_conservation`) does at `:243`,
cannot fail regardless of the answer.

## Investigation log

### Q: Is the flag deliberately shared so the peer observes quarantine, and if so what protects the local decision?

- Sources examined: `ring.rs:126-137` (page layout), `:719-727` (`Ring`
  fields), `:1373-1392` (both flag accessors), all five gate sites, the addon
  quarantine call sites at `packages/mc-shm-native/src/lib.rs:283`, `:290`,
  `:319`, `:324`, `:345`, `:352`, `:381-382`, `:418-419`, and
  `docs/mc-host-shm-transport.md:79`, `:21`.
- Findings: placing the flag in the shared page is the only way the peer can
  learn the direction is dead, and the addon quarantines both directions
  together at `lib.rs:381-382`, which reads as deliberate cross-side signalling.
  Nothing in the code or the document states that the flag is also the local
  authority, and no comment addresses the asymmetry.
- Missing evidence: no design note, commit message, or plan requirement states
  whether the flag is intended as a shared signal, a local latch, or both.
- Conclusion: unresolved, needs the design intent. The mechanism is fully
  established; the intent is not.

### Q: Does the `docs/mc-host-shm-transport.md:116` non-guarantee about malicious peers extend to control pages, or only to payload bytes?

- Sources examined: `docs/mc-host-shm-transport.md:116` in full.
- Findings: the sentence is "It does not protect against a malicious
  authenticated peer mutating mapped payload after publication, and tests or
  docs must not claim such immutability." It names payload only. The preceding
  sentence lists the trusted obligations as "lane ownership, no-transfer,
  no resizing, and post-publication immutability", none of which mention control
  pages either.
- Missing evidence: no statement anywhere in the document about control-page
  integrity.
- Conclusion: needs human input. The text is silent on control pages, and
  reading silence as either coverage or exclusion would be a fabricated answer.
