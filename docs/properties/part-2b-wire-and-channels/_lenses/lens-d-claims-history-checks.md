# Lens D: claims, bug history, and existing-check inventory

Attention focus: the claim and coverage inventory for Part 2b. This lens mines
documented guarantees, git history, and existing checks. It does not propose
catalog records; the three sibling lenses own those. Where a lead here matches a
sibling's candidate property, the slug is cited so synthesis can join them
instead of duplicating.

## Tree state, and a divergence that must be settled before synthesis

Everything below was read at **HEAD = `793a973e`** (`build(shm): require packaged
native transport`), which contains all seven scope files. Every line reference
was printed from HEAD before being written; corrections are noted inline.

**The working tree does not match HEAD, and the difference is inside this
scope.** `git status` shows uncommitted deletions of three of the seven scope
files and of five test files that this inventory counts as coverage:

| Path | HEAD | Working tree |
| --- | --- | --- |
| `crates/mc-host/src/tcp_frame_channel.rs` | 1155 lines | deleted |
| `crates/mc-host/src/transport_negotiation.rs` | 973 lines | deleted |
| `crates/mc-host/src/transport_provider.rs` | 500 lines | deleted |
| `crates/mc-host/src/shm_provider.rs` | present | deleted |
| `crates/mc-host/src/provider_recovery.rs` | present | deleted |
| `crates/mc-host/src/frame_channel.rs` | 882 lines | 807 lines |
| `crates/mc-host/tests/transport_negotiation.rs` | present | deleted |
| `crates/mc-host/tests/shm_transport.rs` | present | deleted |
| `crates/mc-host/tests/shm_failure_modes.rs` | present | deleted |
| `crates/mc-host/tests/shm_soak.rs` | present | deleted |
| `crates/mc-host/tests/support/fake_transport.rs` | present | deleted |
| `crates/mc-host/src/ring_transport.rs` | absent | untracked, new |

`git log --diff-filter=D` returns nothing for any of them, confirming these are
uncommitted working-tree deletions rather than landed removals. The three most
recent commits (`0f336d3c` collapse to fixed ring transport, `d8bde128`
authenticated ring setup socket, `793a973e` require packaged native transport)
are the visible front of that migration, and the working tree is mid-way through
a further step of it.

Consequences a human must resolve:

1. Lens A recorded `transport_provider.rs` as 489 lines; HEAD is 500. Every other
   line count in Lens A matches HEAD exactly, so the siblings were authored
   against HEAD (or very near it) and this one number is a transcription slip,
   not evidence of a different base.
2. If the working tree lands as-is, roughly half this inventory becomes
   historical: the negotiation grammar module, the TCP channel, the provider
   registry, and four of the five CI-named `mc-host` integration binaries all
   disappear at once. Part 2b would then need re-scoping onto
   `ring_transport.rs`.
3. `docs/properties/` itself is untracked (`?? docs/properties/`), so no part of
   this catalog is committed.

Everything below therefore describes HEAD and is explicitly labelled as such.

## Claims register

30 claims, ordered by safety impact. `Source` is the authority making the claim.
`Code` is where an implementation was found, or `NOT FOUND`. Unqualified file
names are under `crates/mc-host/src/`.

| # | Claim (verbatim, abridged) | Source | Implied property | Code |
| --- | --- | --- | --- | --- |
| C1 | "the default registry holds no injected providers, so a production host can never grant a non-TCP channel (R6)" | `transport_provider.rs:3-5` | No production configuration can reach a non-TCP grant path | **CONTRADICTED** — `config.rs:297-303` |
| C2 | "A reader MUST read the prefix, reject unsupported version, read the remaining 16 header bytes, validate the complete header, and only then allocate/read the body" | protocol §6.1, `:233` | No allocation or budget charge precedes full header validation | `wire.rs:306-338`, `tcp_frame_channel.rs:159-196` then charge at `:205-216` |
| C3 | "body declaration above 64 MiB corrupts stream alignment. Receiver MUST close the connection generation without resynchronization" | protocol §6.3, `:293` | A declared length over the cap closes before allocation | `frame_channel.rs:59-61` — **not** in `decode_header`; see lens-a `declared-body-cap-is-not-part-of-the-decode-postcondition` |
| C4 | "Pure-header frames (`Cancel`, `Ping`, `Pong`, `Goodbye`) MUST set `binary = 0`, `last = 0`, and admission class `Normal`" | protocol §6.1, `:245` | Pure-header flag shape rejected at ingress | Split: `len != 0` at `wire.rs:340-342`; flags at `frame_channel.rs:62-68`. See lens-a `pure-header-frame-shape-is-split-across-two-gates` |
| C5 | "receiving either [`Hello`/`HelloAck`] on an authenticated consumer connection is a role violation. The host MUST close that generation; it MUST NOT reinterpret the peer as a provider" | protocol §6.2, `:264` | Provider-registration frames never admitted | `frame_channel.rs:69-75` allowlist of `Request \| Cancel \| Pong \| Goodbye` |
| C6 | "A consumer-originated `Response`, `Push`, `StreamData`, `StreamEnd`, or `Error` ... [is] role-invalid" | protocol §6.2, `:266` | Host-direction frames rejected from a consumer | Same allowlist, `frame_channel.rs:69-75` |
| C7 | "`Sheddable` is legal only on `Push` and `StreamData`" | protocol §6.1, `:245` | Sheddable on any other type is invalid flags | `wire.rs:332-339` |
| C8 | "nonzero channel-0 epoch, zero epoch on a routed channel ... corrupts stream alignment" | protocol §6.3, `:293` | Both halves of the channel/epoch pairing are structural | `wire.rs:342-357`, both directions |
| C9 | "Each connection additionally has exactly one logical writer: implementations MUST serialize fully encoded frames so every byte of one frame (header then body) reaches the socket before any byte of another frame" | protocol §6.3, `:295` | No egress interleaving on any writer path | `tcp_frame_channel.rs:303-401`, single `write_frames` task draining one mpsc |
| C10 | "after a partial write, the writer MUST continue that same frame's remaining bytes before emitting any other frame" | protocol §6.3, `:295` | Short writes resume the same frame | `tcp_frame_channel.rs:366-378` via `write_all` on `bytes` then `tail` inside one `timeout` |
| C11 | "Writers MUST verify header `len` equals body length" | protocol §6.3, `:295` | Emitted `len` equals emitted body bytes | `wire.rs:569-598` (`encode_owned_frame`), `:604-628` (`encode_split_frame`) derive `len` from `body.len()`; see lens-b `header-len-equals-emitted-body-on-every-published-frame` |
| C12 | "MUST be able to accept one otherwise valid maximum-size frame on an admitted authenticated connection" | protocol §6.3, `:287` | Ingress pool is never below the declared cap | `config.rs:22-24` `MIN_RESIDENT_BYTES`; see lens-a `ingress-capacity-never-below-the-declared-body-cap` |
| C13 | "the host MAY emit that terminal as soon as header validation completes, MUST NOT buffer the oversize body, and drains and discards the declared bytes under the frame's absolute deadline" | protocol §7.1, `:318` | Oversize control never allocates its body; alignment preserved by drain | `tcp_frame_channel.rs:198-203` (`OversizeControl`), `:264-277` (`drain_declared_body`) |
| C14 | "Clean EOF before any byte of the next header is orderly connection close" | protocol §6.3, `:293` | Exactly one read-exit cause maps to orderly | `tcp_frame_channel.rs:167-169` returns `ReadClose::CleanEof` only when the first byte read is 0 |
| C15 | "Once the first header byte arrives, the remaining header and body bytes MUST complete within one finite operation-owned absolute deadline" | protocol §6.3, `:291` | One absolute deadline, armed at the first byte, covers header plus body | `tcp_frame_channel.rs:171` (`Instant::now() + frame_deadline`), threaded to every later read |
| C16 | "Waiting for the next frame on an idle connection is unbounded at the framing layer" | protocol §6.3, `:291` | The first-byte read is not deadline-bounded | `tcp_frame_channel.rs:161-166` — a bare `select!` on cancel and read, no timer |
| C17 | "every non-TCP provider MUST enforce owner-only endpoint access, exclusive peer attachment, provider-incarnation fencing, and stale-descriptor rejection before it yields a candidate channel" | protocol §7.7.2, `:606` | The KTD9 gate runs inside `prepare` before a candidate exists | **Convention only** — `transport_provider.rs:112-118` states the obligation on implementors; the four `ProviderFailure` variants (`:36-48`) name the outcomes but the registry never verifies any gate ran |
| C18 | "The host compares the activation token in constant time and atomically consumes the one-use grant record" | protocol §7.7.4, `:647` | Token comparison is constant-time and consumption is atomic | `transport_provider.rs:445-500` in-crate tests assert non-consumption on a wrong token; the constant-time property has no check |
| C19 | "A real token MUST be freshly generated from the OS CSPRNG for each grant" | protocol §7.7.2, `:606` | Grant tokens are fresh and unpredictable | `transport_provider.rs` `fresh_tokens_have_the_wire_form_and_vary` test; wire form and variation only, not CSPRNG provenance |
| C20 | "Tokens, descriptors, and offer parameters MUST stay absent from events, errors, cause chains, stacks, `Debug`/`Display` formatting, and panic output on both sides" | protocol §7.7.2, `:608` | No provider secret reaches any diagnostic surface | `transport_negotiation.rs:137-141` (no `Display`, redacting `Debug`), `:85-91` (errors carry only code plus documented path), `transport_provider.rs:33-48` |
| C21 | "The composite never surfaces the message itself — diagnostics report its byte length only (protocol V24)" | `composite.rs:27-30` | A child shutdown message never reaches a log | **CONTRADICTED** — `composite.rs:34-38`; see lens-c `shutdown-error-formatting-defeats-its-own-redaction-contract` |
| C22 | "a child's panic or returned shutdown error MUST NOT skip a later child's drain ... fixed order — `broca`, then `synapse`, then `magic-context`" | protocol §12, `:870` | Every child drains regardless of earlier failure, in that order | `composite.rs:359-389`; array literal forces all three awaits, order tertiary/secondary/primary matching broca/synapse/magic-context per `:10-14` |
| C23 | "The host MUST select exactly one offered `(transport, capability_version)` entry; it never invents a transport, version, or parameter shape" | protocol §7.7.2, `:590` | An unoffered selection cannot be encoded or accepted | Decoder side `transport_negotiation.rs:557-676` validates against `offers`; encoder side see lens-c `encoder-cannot-refuse-an-unoffered-or-unserveable-selection` |
| C24 | "Decoding is strict ... an unrecognized or repeated field is malformed. ... A duplicate object key at **any** depth ... is rejected before any typed or opaque value is materialized" | protocol §7.7.1, `:580` | Recursive duplicate-key rejection precedes materialization | `transport_negotiation.rs:274-316` (`check_closed_fields`), strict parse in `parse_root` |
| C25 | "each at most 8,192 bytes of compact UTF-8 JSON serialization and at most 8 nesting levels" | protocol §7.7.1, `:570` | Opaque values bounded in bytes and depth before traversal | `transport_negotiation.rs:410-431` (iterative depth), `:433-470` (`CappedCounter`); see lens-c `opaque-depth-walk-is-sized-by-the-body-cap-not-the-opaque-cap` |
| C26 | "The fallback vocabulary is closed" — only `unavailable` and `capability_version_mismatch` | protocol §7.7.3, `:612-620` | No third reason can select or retain TCP | `transport_negotiation.rs:112-135`; a two-variant enum since `35af65f6` |
| C27 | "At most one candidate may be prepared." / "`Retired` is terminal; no provider choice, descriptor, token, correlation, or route survives into a later generation" | protocol §7.7.5, `:651`, `:672` | One candidate per generation; nothing crosses retirement | `transport_provider.rs` grant records plus `PreparedCandidate.generation` (`:71-80`); the enforcement point is in `connection.rs`, outside scope |
| C28 | "Data and reserved-control frames share one queued-byte budget ... Data traffic cannot consume control slots" — 256 data slots, 32 reserved | protocol §11, `:832-839` | Control egress cannot be starved by data egress | **NOT FOUND in scope.** Implemented client-side (`client.rs:74`, `:1331-1356`, `:1613`). Host egress is one undifferentiated mpsc of `writer_queue_frames` (`frame_channel.rs:862`, default 64 at `config.rs:141`) |
| C29 | "Fixtures MUST use committed literal bytes and an independent decoder/oracle; importing production proof, header, or frame helpers to generate expected values proves only self-consistency" | protocol §14.1, `:991` | The vector suite never asks the host for its own expected bytes | `tests/protocol_vectors.rs:1-18` declares and appears to honour it; oracle is `support/raw_client.rs`, which re-implements the layout (`:1-7`, `:19-49`) |
| C30 | "Everything here is `#[doc(hidden)]`: the module is a crate-internal seam reachable only so the integration-test harness can inject fake providers through `HostConfig`" | `transport_provider.rs:11-13` | The provider seam is test-only | **CONTRADICTED by C1's evidence** — the seam is on the default production path via `config.rs:297-303` |

## Contract-vs-code leads

Ordered by value. Each is a disagreement between a stated guarantee and HEAD, or
a guarantee with no implementing code.

### L1. The production default registry injects a non-TCP provider (highest value)

`transport_provider.rs:3-5` states, as a module-level invariant with a plan
identifier attached:

> Production construction contains TCP only: the default registry holds no
> injected providers, so a production host can never grant a non-TCP channel
> (R6).

`TransportProviders` does `#[derive(Clone, Default)]` (`:162-166`) with an empty
`injected: Vec<ProviderEntry>`, so the claim is true of
`TransportProviders::default()`. But no production caller uses that. The
production default is `HostConfig::default()`, and at `config.rs:296-304`:

```rust
transport_providers: crate::transport_provider::TransportProviders::with_injected(
    vec![std::sync::Arc::new(
        crate::shm_provider::ShmProvider::for_qualified_test_profile(
            crate::shm_provider::single_candidate_limits(),
        ),
    )],
),
```

`crates/mc-module/src/bin/ck_mc_host/serve.rs:583-595` builds the real serving
config with `..HostConfig::default()` and overrides only `data_dir`,
`daemon_ver`, `payload_manifest_digest`, `init`, and `limits`. So the shipped
host binary registers a `shm` provider, and the module doc's stated impossibility
is false on the default production path. The constructor's own name,
`for_qualified_test_profile` (`shm_provider.rs:138`), says the profile was built
for tests.

This invalidates two claims at once (C1 and C30) and changes the reachability
class of the whole provider and candidate-activation surface from
`test-only` / `explicit-config-only` to `default-production`. Lens C's records
that assume an injected provider is a test knob need their `Reachability:` line
re-derived. METHOD rule 4 makes this exactly the error that "has already been
made once and cost a whole revision".

Unresolved: whether the shm registration is intentional (the last three commits
are a shm-to-production migration) with a stale doc comment, or an accidental
default. That is a design question. (needs human input)

### L2. The composite's redaction contract is defeated by its own `Display`

`composite.rs:27-30` claims the composite "never surfaces the message itself".
`composite.rs:34-38`:

```rust
impl std::fmt::Display for ShutdownError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "component shutdown failed: {}", self.0)
    }
}
```

The field is `pub` (`:32`) and `#[derive(Debug)]` on a public tuple struct also
prints the string. The composite's *own* aggregation path is clean —
`shutdown_failure_note` at `:176-188` emits `err.0.len()` and drops panic
payloads — so the leak requires a different formatter. The doc states the
property of the type; only one path holds it. Already recorded by lens-c
`shutdown-error-formatting-defeats-its-own-redaction-contract`; noted here
because the *claim* is what makes it a defect rather than a design choice.

### L3. The host has no reserved control egress; the doc's slot split is client-only

Protocol §11 `:832-839` specifies 256 data slots, 32 reserved slots for
`Pong`/`Cancel`/`Goodbye`, and "Data traffic cannot consume control slots". The
table is introduced as "Managed Rust and TypeScript client defaults", and the
split is indeed implemented client-side (`client.rs:74`, `:1331-1356`).

The host side has one queue: `mpsc::channel::<QueuedOutboundFrame>(queue_frames)`
at `frame_channel.rs:862`, default `writer_queue_frames: 64`
(`config.rs:122`, `:141`). There is no reserve, no priority lane, and no
control-frame classification anywhere in `frame_channel.rs` or
`tcp_frame_channel.rs`.

This is not a literal contract violation, because §11 scopes the table to
clients. It is a lead because §12 step 4 (`:867`) requires the host's connection
`Goodbye` to *follow* the drain, and the contract suite scenario is named
`saturation_holds_at_frame_bound_and_spares_control_capacity`
(`contract_tests.rs:416`) — a control-capacity claim asserted against a channel
that has no control capacity to spare. Whether the host owes the guarantee is a
contract question. (needs human input)

### L4. `encode_negotiate_response`'s surviving rationale cites a deleted fallback reason

`transport_negotiation.rs:856-860`:

> `negotiation_version` is the *request's* grammar version, echoed per
> §7.7.2. Echoing matters for the `negotiation_version_mismatch` fallback:
> a peer speaking another version must be able to decode the response and
> retain TCP (R8), which it cannot do if the host stamps its own version.

`negotiation_version_mismatch` was removed from `FallbackReason` by `35af65f6`
(see D4 below). The only justification the doc gives for the echo no longer
exists. Worse, `decode_negotiate_response` at `:576-581` rejects any
`negotiation_version != NEGOTIATION_VERSION`, so the echo capability can now only
produce a response this module's own decoder refuses. The parameter and its
`negotiation_version == 0` guard (`:866-871`) are live code whose stated purpose
was deleted around them. Relates to lens-c
`response-decoder-pins-the-constant-version-not-the-request-version`.

### L5. `encode_frame`'s "one logical write" doc describes a test-only function

`wire.rs:539-540`:

> Encodes one complete frame (header then body) as a single buffer so the
> writer emits it in one logical write.

`wire.rs:541` is `#[cfg(test)]`. The production encoders are
`encode_owned_frame` (`:569`), which does produce one buffer, and
`encode_split_frame` (`:604`), which for bodies at or above
`SPLIT_WRITE_MIN_BODY = 16 * 1024` (`:601`) deliberately returns `(header, body)`
as two buffers that the writer emits as two `write_all` calls
(`tcp_frame_channel.rs:368-372`). Protocol §6.3 `:295` makes the single write a
`SHOULD`, so there is no violation — but the only place the "one logical write"
property is asserted in a doc comment is on the one function production never
calls, and neither production encoder carries the claim.

### L6. Claims with no implementing code in scope

- **C28**, above: no host-side control reserve.
- **The channel-0 JSON-only rule.** Protocol §7.1 `:318` says channel 0 accepts
  "UTF-8 JSON only (`binary = 0`)". `validate_inbound_header`
  (`frame_channel.rs:58-76`) checks the binary flag only for pure-header types.
  A `Request` on channel 0 with `binary = 1` passes the framing layer. The only
  `is_binary()` checks that could catch it are `connection.rs:1207` and
  `dispatch.rs:939`, both outside this scope, and `client.rs:2050` on the peer.
  So the framing layer does not enforce it and the scope contains no gate;
  whether a downstream gate is total is a Part 2a/2c question.
- **C17**, the KTD9 provider gate: obligation stated on implementors with nothing
  verifying it. Carried into the conventional-only list below.
- **C18**, constant-time token comparison: the property is claimed by the
  protocol (`:647`) and no check in scope establishes timing behaviour. The three
  in-crate `transport_provider` tests cover wire form, `Debug` redaction, and
  non-consumption on mismatch.
- **Header-length version dispatch.** `header_len_for_version`
  (`wire.rs:292-297`) exists so a future version can declare another header
  width, and the module doc (`:16-18`) calls the frozen prefix a forward-
  compatibility discipline. Only `PROTOCOL_VERSION` maps, and
  `tcp_frame_channel.rs:159` declares `[0u8; HEADER_LEN]`, so a longer header
  could not be read even if the map grew. Already lens-a
  `header-length-version-dispatch-has-no-production-driver`.

## Conventionally-enforced-only claims

Claims where a comment states an obligation on a caller or implementor and
nothing in the code prevents violating it.

1. **The KTD9 provider gate.** `transport_provider.rs:112-118`: "Implementations
   must run KTD9's attachment gate inside `prepare` and fail with a bounded
   `ProviderFailure` before yielding a candidate," and `:119` "Implementations
   must not create resources, run cleanup, or touch workers here (R6)." A
   provider that returns a `PreparedCandidate` having run no gate is accepted.
   With L1 in play, the only registered provider is a real one on the production
   path.
2. **Byte-budget wait bounding.** `wire.rs:409-411`: "Callers must bound the wait
   (deadline or cancellation)." `ByteBudget::charge` itself has no timer; the TCP
   reader supplies one (`tcp_frame_channel.rs:205-216`), and the doc names the
   emit paths as relying on generation retirement instead. A new caller that
   awaits `charge` bare blocks forever.
3. **Receive-lease escape discipline.** `frame_channel.rs:4-10`: "Receive bytes
   are visible only through a lexical `ReceiveLease`; compatibility consumers
   must use the explicit copying adapter before entering asynchronous work."
   This one is *partly* mechanised: `ReceiveLease` is `!Send` via an `Rc`
   marker and non-`'static` (`:290-308`), and two `compile_fail` doctests pin
   both. That is stronger than convention. What stays conventional is the
   *choice* to call `into_owned` rather than holding the frame across an await.
4. **Single-logical-writer ownership.** `frame_channel.rs:4-6` says a
   "single-owner `FrameReceiver`" and "one logical writer". `FrameSender` is
   `#[derive(Clone)]` (`:757`), so any number of senders exist by design; the
   serialization comes from there being one `SenderQueue` consumer. Nothing
   prevents a second `write_frames` task being spawned over the same socket
   half; only construction discipline in `TcpFrameChannel::start` does.
5. **Charge-release-outside-a-lock.** `wire.rs:493-499`: "so a caller holding a
   lock can defer the release until after the guard falls. Releasing a permit
   takes the budget's own waiter lock and wakes queued waiters, which must not
   happen underneath an unrelated mutex." The hazard is real and the remedy
   (`split_or_take`) is opt-in; calling plain `shrink_to` under a lock compiles.
6. **Oracle independence.** `support/raw_client.rs:1-7`: "It must never call
   `mc-host`'s encoders or proof helpers." Enforced by review only. The file
   maintains its own `HEADER_LEN`, `WIRE_VERSION`, all twelve type constants, and
   its own flag constants (`:19-49`), which is what makes the discipline both
   valuable and fragile.
7. **Registration-time metadata safety.** `transport_provider.rs:190-194`:
   "the redaction hook must exist before they run (registration happens before
   `run` installs it)". This is an ordering fact asserted in prose;
   `with_injected` does call `panic_boundary::install()` at `:187`, so the
   ordering is self-enforced here, but the claim about `run` is about a caller
   sequence nothing checks.

## Defect records

Nine genuine defects, read from diffs. Each entry gives root cause, the trigger,
whether a nearby condition bypasses the fix, and the regression property.

### D1. `decode_header` accepted epoch 0 on a routed channel — `cffc09e7`

- **Root cause.** Only one half of the channel/epoch pairing was structural. The
  decoder rejected a nonzero epoch on channel 0 but accepted epoch 0 on a
  nonzero channel. Commit message: "The TypeScript client already rejected this
  pairing in `validateHeader` while the Rust decoder accepted it."
- **Trigger.** A routed frame with `epoch == 0`. No timing needed.
- **Effect.** "which let a corrupt routing identity through to be dropped as
  unmatched instead of closing the generation" — a corruption class silently
  demoted to a stale-state disposition, so a desynchronised stream kept running.
- **Fix at HEAD.** `wire.rs:348-357`, with the reasoning kept as a comment.
- **Nearby bypass.** The symmetric rule is now enforced, but this was
  *drift between two hand-maintained implementations of one table*, and the
  structural cause survives: `wire.rs`, `support/raw_client.rs`, and the
  TypeScript client each encode the framing rules independently, with nothing
  cross-checking them. See Q1.
- **Regression property.** Both halves of the channel/epoch pairing reject at
  decode, and the Rust decoder and the independent oracle agree on the accept
  set for every pairing.

### D2. Two drifting copies of inbound header validation — `26235a6c`

- **Root cause.** The TCP and shared-memory read paths each carried their own
  cap, pure-header-flag, and role-allowlist checks. Commit message: "Inbound
  header validation shares one implementation across the TCP and shared-memory
  transports instead of two drifting copies."
- **Trigger.** Any header rule change landing in one path.
- **Fix at HEAD.** `validate_inbound_header` at `frame_channel.rs:58-76`, called
  from exactly two sites: `tcp_frame_channel.rs:196` and `shm_provider.rs:540`.
  Verified by `git grep`: those are the only callers in the tree.
- **Nearby bypass.** The function is `pub(crate)` and nothing forces a new
  transport to call it. A third channel implementation can decode a header and
  dispatch without it, which is the same class of omission the fix removed.
- **Regression property.** Every read path that produces an `InboundFrame`
  passes its header through the one shared validator before any body admission.

### D3. TCP producer copy charge stranded on failed alias detachment — `26235a6c`

- **Root cause.** "The TCP producer's copy charge is reservation-scoped: a failed
  alias detachment during commit previously stranded it after abort released
  only the span reservation."
- **Trigger.** Alias detachment fails *during commit*, after the span
  reservation exists and before publication.
- **Effect.** Permanently leaked ingress/egress permits; under a bounded pool,
  repeated occurrences starve every later admission.
- **Fix at HEAD.** Charge ownership moved into the queued item on publication;
  `DirectProducer`'s `C` guard "moves into `ProducedBody` on success and drops
  immediately on constructor failure, overflow, underfill, explicit abort, or
  ordinary drop. This makes charge return an ownership property instead of a
  caller convention" (`frame_channel.rs:110-115`).
- **Nearby bypass.** The ownership rewrite closes the whole class, not one path.
  The remaining exposure is that the guard type is generic, so a backend whose
  `C` does not actually release on drop reintroduces it silently.
- **Regression property.** Every producer abandonment path returns each attached
  charge exactly once, counted per charge and not in aggregate — see METHOD's
  effect-accounting rule, since a double release and a leak can cancel in a
  total.

### D4. A third fallback reason permitted a forbidden TCP downgrade — `35af65f6`

The highest-value history entry in this scope.

- **Root cause.** `FallbackReason` carried `NegotiationVersionMismatch` while
  §7.7.3 `:612-620` closes the vocabulary at `unavailable` and
  `capability_version_mismatch`, and §7.7.3 `:620` explicitly lists
  negotiation-version mismatch among the outcomes that "are not fallback
  evidence and MUST fail closed without same-generation TCP continuation."
- **Trigger.** A host answering a non-TCP offer with
  `reason: "negotiation_version_mismatch"`.
- **Effect.** From the commit: "A host answering a non-TCP offer with that reason
  therefore committed the generation to plain TCP instead of retiring it — the
  downgrade V53 exists to forbid." A peer could force a client off its intended
  transport onto TCP with a single reason string.
- **Fix at HEAD.** `transport_negotiation.rs:112-135`, a two-variant enum with
  `as_str` and `parse` both narrowed.
- **How the tests missed it.** "Both closed-table tests iterated their own
  vocabulary, so neither could see the drift." A test that enumerates the
  implementation's own enum and round-trips it can never detect a variant the
  spec forbids. This is the tautological-oracle failure in METHOD's terms: the
  oracle was derived from the subject.
- **Nearby bypass.** The fix pinned "the two literals and assert[ed] the excluded
  reasons are rejected", which is the right shape. But the same iterate-your-own-
  vocabulary pattern is available for every other closed table in the module:
  `NegotiationErrorCode` (`:42-84`), the transport-name grammar (`:26`), and the
  closed field sets in `check_closed_fields` (`:274-316`). None of those is
  pinned to a literal list taken from the document.
- **Regression property.** The fallback vocabulary equals exactly the two
  document literals, asserted against literals and not against the enum, and
  every excluded reason string is rejected by `parse`.
- **Residue.** L4 above: the deletion left `encode_negotiate_response`'s
  justification comment pointing at the removed variant.

### D5. Recursive opaque-depth walk could exhaust the read-loop stack — `544b04c7`

- **Root cause.** `check_opaque` measured depth with a recursive `value_depth`
  *after* serializing, so the recursion itself ran before the bound could reject.
  Commit message: "a provider-constructed value carries no parser recursion cap,
  so a deeply nested descriptor could exhaust the connection task's stack before
  the bound rejected it."
- **Trigger.** A deeply nested `descriptor` or `parameters` object. Provider-
  constructed values are the dangerous case because, unlike client bytes, they
  never passed a parser recursion cap.
- **Effect.** Stack exhaustion on the connection read loop, i.e. process abort
  rather than a bounded rejection.
- **Fix at HEAD.** `exceeds_opaque_depth` at `transport_negotiation.rs:410-431`,
  an explicit `pending` vector, called at `:443-449` before the byte counter.
- **Nearby bypass.** Ordering is now depth-then-bytes inside `check_opaque`. The
  guard depends on every opaque value reaching `check_opaque`; a future field
  typed as opaque JSON that skips it has the original exposure. Also see lens-c
  `opaque-depth-walk-is-sized-by-the-body-cap-not-the-opaque-cap`, which
  questions whether the reachable input size is bounded by the right cap.
- **Regression property.** No recursive traversal of a provider-supplied JSON
  value runs before an iterative depth bound has rejected it, checked at the
  maximum body size an opaque field can arrive in.

### D6. Oversized opaque values were materialized before rejection — `bdcc7428`

- **Root cause.** `serde_json::to_vec(value).expect(...)` built the entire
  compact document, then compared its length to `MAX_OPAQUE_BYTES`.
- **Trigger.** An oversized `parameters` or `descriptor`.
- **Effect.** A full compact serialization allocated on the connection read loop
  for a value that is then discarded — unaccounted memory on the read path.
- **Fix at HEAD.** `CappedCounter` (`transport_negotiation.rs:433-470`), a
  `std::io::Write` that fails past the limit "without retaining them".
- **Nearby bypass.** Same shape as D5: applies only where `check_opaque` is
  called. The `.expect("Value serialization cannot fail")` that the fix removed
  is worth noting as a class — `wire.rs` and `composite.rs` both retain
  cannot-fail encode sites.
- **Regression property.** An over-cap opaque value is rejected during traversal
  with allocation bounded by the cap, not by the value's size.

### D7. The response encoder guaranteed its own reason was unconsumable — `2d2e31c0`

- **Root cause.** "`encode_negotiate_response` stamped the host's
  `NEGOTIATION_VERSION`, so the one case that produces
  `negotiation_version_mismatch` guaranteed the peer's decoder rejected the
  response and failed closed instead of retaining TCP (R8) — the reason was
  unconsumable by construction."
- **Trigger.** A peer negotiating at a different grammar version.
- **Fix.** Echo the request's version; parameter added at
  `transport_negotiation.rs:863`.
- **Status at HEAD.** The reason this fix existed was deleted by D4. This is the
  clearest case in the scope of two fixes composing into stale code (L4), and it
  is a genuine defect record on both ends: D7 fixed a real unconsumable-response
  bug, and D4 then made the whole path unreachable without reverting D7.
- **Regression property.** No encoder emits a negotiation response that this
  crate's own decoder rejects — the same invariant lens-a states for the frame
  encoder, applied to the negotiation grammar.

### D8. An over-cap channel-0 request did not commit the transport — `2d2e31c0`

- **Root cause.** "The Rejected arm emitted its authoritative terminal but never
  called `commit_transport`, so during candidate setup an application-bearing
  over-cap request was tolerated instead of retiring the generation (§7.7.5),
  and in `BootstrapTcp` a later negotiation was still treated as first-and-fresh
  and could grant a candidate."
- **Trigger.** An oversize channel-0 `Request` arriving *during candidate setup*,
  followed by a second `transport.negotiate`.
- **Effect.** Two setup invariants broken at once: application-bearing traffic
  during setup did not retire the generation, and the late-negotiation allowance
  was not consumed, so a second negotiation could grant a candidate.
- **Nearby bypass.** The commit point is in `connection.rs`, outside this scope,
  so the inventory cannot confirm every rejection arm now commits. Recorded as
  unresolved. See Q3.
- **Regression property.** Every early-rejection arm on a setup-only generation
  consumes the negotiation allowance, so no rejected frame leaves the generation
  eligible for a fresh grant.

### D9. Provider preparation blocked the sole read loop and grew unboundedly — `6b3ffb2b`, `5b4f04c8`, `bdcc7428`

Three commits on one defect class, so recorded once.

- **Root cause.** `prepare` is provider code with no bound. It first ran inline
  (blocking the read loop), then on the blocking pool (one worker consumed per
  reconnect), with an unbounded queue.
- **Triggers.** `6b3ffb2b`: a permanently blocking gate. `5b4f04c8`: repeated
  reconnects behind a wedged gate. `bdcc7428`: "that wait blocks the sole read
  loop, so a slow prepare could leave a timely Pong unread and invalidate a
  healthy generation" — a liveness false-kill.
- **Fix at HEAD.** One dedicated OS thread (`transport_provider.rs:149-154`), a
  `sync_channel` bounded by `PREPARE_QUEUE_BOUND` (`:143-147`), `catch_unwind`
  plus `redact_sync` around the call (`:240-250`), and bootstrap liveness stopped
  before the wait.
- **Nearby bypass.** The thread is *lazily* started under a mutex
  (`:230-260`), and on spawn failure the reply sender drops so the setup fails
  closed — stated in a comment at `:257-259`, with no check. The queue bound
  caps stranded tuples but a wedged gate still permanently disables all
  non-TCP negotiation for the process lifetime, with no recovery path visible in
  scope. Overlaps lens-c `prepare-dispatch-is-unbounded-work-on-the-read-loop`.
- **Regression property.** Provider `prepare` never runs on a Tokio worker or the
  blocking pool, and a permanently blocking gate consumes exactly one OS thread
  and bounded queue slots while later setups fail at their own deadlines.

## Review-hardening churn

Distinguished from D1-D9 because the diffs show tightening without a stated
reachable trigger, or changes entirely outside the Rust scope files.

- **`3a45de9d`** adds `ReadClose::Overloaded` (`frame_channel.rs:39-43`) so a
  budget-wait timeout is classified as backpressure rather than corruption. The
  commit's real defect ("one saturated window can no longer permanently block
  every later shared-memory candidate") is in `shm_provider.rs` and the
  TypeScript channel; the scope diff is four doc-comment lines and one variant.
  Note a live inconsistency this leaves: `tcp_frame_channel.rs:212` still returns
  `ReadClose::Corrupt("body budget wait exceeded frame deadline")` for the same
  condition on the TCP path, so the two transports classify one event
  differently. Lens A records this as an open question under
  `ingress-budget-exhaustion-has-one-close-classification`.
- **`eafced9a`** rewrote `into_owned` so `ReceiveBody::Contiguous` moves instead
  of copying (`frame_channel.rs:541-547`). Behavioural, not a bug fix, but it
  silently changed what `CopyCounter` reports: a TCP body now yields **zero**
  recorded copies where it previously recorded one. Any zero-copy assertion
  written against `CopyCounter` for the TCP path now passes trivially. The
  counter doc at `:78-82` remains literally true ("for each body they copy"), so
  nothing flags the change. `contract_tests.rs` gained
  `tcp_owned_adapter_moves_contiguous_storage` to pin the new behaviour.
- **`db1123c6`** un-`cfg(test)`-ed `copy_counter()` and gave it a doc comment.
  One line in scope.
- **`1dbeb523`** extracted the three read loops into `frame_read.rs`
  (`tcp_frame_channel.rs` shrank by 19 lines net). A deduplication with a clear
  rationale — "That put the subtle parts in two places: the `biased` select that
  prefers cancellation over another read, treating a zero-length read as
  end-of-stream instead of looping, and capping the body read at the frame
  boundary so a pipelined next header is never consumed as body" — but no defect
  is claimed to have shipped. Part 2a records that `frame_read.rs` has zero
  tests, so this refactor moved three subtle loops into an untested module.
- **`f9cfd8eb`** and **`cffc09e7`** each touch `wire.rs` for real defects, but
  `f9cfd8eb`'s wire diff is the additive `capacity`/permanent-vs-transient
  split; the defect (three pools sharing one budget) lives in `config.rs`. D1
  covers `cffc09e7`'s wire half.
- **`d6000c48`, `4d48e15c`, `2f7d7a67`, `fc121bbc`, `74b1f386`** — five
  "close Nth-round negotiation review gaps" commits whose bodies describe real
  and often serious defects (`sendControl()` unwinding through frame dispatch,
  exponent-notation numbers bypassing a double-safe-range check, a stateful
  `toJSON` passing validation then emitting a different shape). Their **Rust**
  diffs in scope are 6 to 31 lines each and are mostly the registry-side mirror
  of a TypeScript fix. Two Rust-side items are worth carrying forward even though
  the primary fix was elsewhere: `4d48e15c` rejecting a provider that claims the
  reserved `tcp` name — "a tcp offer at another capability version could be
  validly selected and continue the v1 bootstrap channel under a version lie"
  (now `transport_provider.rs:206-209`); and `2f7d7a67` validating the complete
  offer list at registry construction so a static misconfiguration fails before
  any dial (now the three assertions at `:200-215`).

The pattern across 22 commits: **the Rust wire and channel core received few
genuine defects; the negotiation and provider seams received many, and most were
first found on the TypeScript side.** Twelve of the twenty-two commits touching
these files are "round N review gaps" or equivalent. That is review-driven
hardening, not test-driven, which is consistent with the quiet areas below.

## Existing-check inventory

Status for every check below is **unaudited**. Test adequacy belongs to
`/testing:invariant-test-review`; production guard adequacy to
`/low-level-systems:defensive-assertions-and-invariant-guards`.

### In-crate unit tests (clustered, with counts)

Counts from `#[test]` and `#[tokio::test]` attributes at HEAD.

| File | Tests | Asserts | Notes |
| --- | --- | --- | --- |
| `wire.rs` | 14 | 55 | `mod tests` at `:647` |
| `tcp_frame_channel.rs` | 18 | 35 | `mod tests` at `:512`; 5 are helpers, so ~24 named fns |
| `frame_channel/contract_tests.rs` | 15 | 66 | 9 generated by the suite macro + 6 in `ownership_contract` |
| `transport_provider.rs` | 3 | 11 | `mod tests` at `:445` |
| `frame_channel.rs` | **0** | 0 | all coverage is in the `contract_tests` submodule |
| `transport_negotiation.rs` | **0** | 0 | 973 lines, no in-crate test; covered by `tests/transport_negotiation.rs` |
| `composite.rs` | **0** | 0 | 390 lines, no in-crate test; covered by `tests/composite_routing.rs` |

**Total in scope: 50.** All 50 run in the Linux `--lib` job (`ci.yml:119`). The
macOS `--lib` step (`ci.yml:173-174`) names one filter,
`shm_provider::tests::platform_preflight_is_side_effect_free`, so **none of the
50 executes on macOS**.

Clusters:

- **`wire.rs`, 14 tests / 55 asserts**, in three groups.
  *Header codec* (8): canonical env-var names pinned; `Request` round-trip; all
  frame types round-trip; little-endian and frozen-prefix layout; truncated
  headers and unsupported versions; unknown type and reserved flag encodings;
  pure-header-with-body; epoch boundaries plus the reserved control epoch.
  *Sheddable* (1): `sheddable_rejected_on_every_illegal_frame_type` — the only
  test in the scope that sweeps a rule across every type.
  *Byte budget* (5): permanent-vs-transient exhaustion via `capacity`;
  `try_charge` exact and all-or-none; `split` preserving the total and
  `shrink_to` releasing only the delta; `split_or_take` whole-charge fallback;
  and one async test that body charges and reservations share one ingress pool.
  Gap visible from the names: no test asserts `decode_header` rejects a declared
  length above the cap, because it does not (C3, L6).
- **`tcp_frame_channel.rs`, ~24 named fns / 35 asserts**, in three groups.
  *Read classification* (12): clean EOF before a header is orderly; EOF after the
  first header byte and inside a declared body are corruption; the frame deadline
  is absolute from the first header byte; oversize control reported without
  reading the body; the control cap boundary exact; body over the interop cap
  closes before allocation; drain discards exactly the declared bytes and
  realigns; rejection then drain without allocation; failed drain reported as
  `RejectedDrainFailure`; fragmented and coalesced frames preserve alignment; a
  maximum-size frame admitted whole and its charge released; charges release with
  their frame.
  *Write path* (5): partial writes finish one frame before the next; the writer
  serializes frames and flushes the queue on close; a stalled consumer write
  retires the generation and frees charges; queue admission uses the remaining
  operation deadline; writer failure retires the generation.
  *Helpers* (5): `budget`, `header_bytes`, `outbound`, `receiver_over`, and a
  three-method `AsyncWrite` stub for partial writes.
- **`frame_channel/contract_tests.rs`, 15 tests / 66 asserts**, in two groups.
  *Factory-parameterized suite* (9), generated by `frame_channel_contract_suite!`
  at `:407-455`: FIFO admission under concurrent send and receive; saturation
  holds at the frame bound and spares control capacity; completion hooks fire
  once in order without claiming receipt; cancellation before admission leaves
  the frame unpublished; failure after publication begins retires without
  replay; graceful finish drains admitted frames before close; discard drops
  queued frames and releases charges; inbound payload ownership travels with the
  frame; clean close at a frame boundary is orderly.
  **The suite is instantiated exactly once**, for `TcpChannelFactory` at `:457`.
  The module doc at `:5-7` says "a later provider registers by instantiating
  `frame_channel_contract_suite!` with its own factory and runs the identical
  inventory"; no second factory exists at HEAD, and `shm_provider.rs` does not
  register one. See lens-b
  `every-channel-implementation-runs-the-shared-contract-suite`.
  *Ownership contract* (6), not factory-parameterized: exact commit across empty,
  boundary, segmented and maximum bodies; producer failures never publish and
  return each charge once; cancellation classified before and after publication
  without double release; the owned adapter copies once and releases the lease
  before returning; close with an active lease quarantines and never reopens
  storage; and the TCP owned adapter moves contiguous storage (the D-record
  pin from `eafced9a`).
- **`transport_provider.rs`, 3 tests / 11 asserts**: fresh tokens have the wire
  form and vary; the grant record's `Debug` redacts the token; a wrong token or
  binding never consumes. Nothing covers the registry's three panicking
  registration assertions (`:200-215`), the prepare worker, the queue bound, or
  the `catch_unwind` containment.

### Doctests

`ci.yml:177` runs `cargo test -p mc-host --doc`, named "Rust lease non-escape".
This is the executed proof for two `compile_fail` doctests on `ReceiveLease`
(`frame_channel.rs:296-308`): one asserting the type is not `Send`, one asserting
it is not `'static`. It is the only CI step in this scope that runs on **all
three** platforms in the `shm-source-build` matrix (`ubuntu-latest`,
`macos-latest`, `macos-15-intel`).

### Integration tests (with CI named/unnamed status)

`mc-host` has **26** integration binaries at HEAD. Verified against
`.github/workflows/`: `ci.yml` names four, `shm-hardening-optin.yml:38` runs a
profile-selected ignored-only pass, and the other three workflows invoke no
Rust tests.

| Binary | Tests | Bears on Part 2b | CI status |
| --- | --- | --- | --- |
| `transport_negotiation.rs` | 33 | Negotiation grammar and host setup states — the primary proof for most of `transport_negotiation.rs` and `transport_provider.rs` | **Named, Linux only** (`ci.yml:163-164`) |
| `shm_transport.rs` | — | The only driver of a real non-TCP candidate through the channel seam | **Named, Linux only** (`ci.yml:163-164`) |
| `shm_failure_modes.rs` | — | Channel-level fault paths | **Named, Linux** (`ci.yml:119-120`) |
| `shm_soak.rs` | — | Sustained channel and budget behaviour | **Named, Linux + macOS** (`ci.yml:120`, `:172`) |
| `protocol_vectors.rs` | **18** | **The §14.1 fixture oracle.** Committed literal header and proof bytes; `committed_header_vectors_decode_to_their_documented_fields`, `canonical_route_open_body_is_173_bytes`, `committed_negotiation_vectors_pin_bodies_and_headers`, `structural_corruption_closes_silently`, `pure_header_frames_accept_any_valid_priority`, `control_body_at_the_profile_cap_is_read_and_over_it_is_rejected_early`, `a_maximum_size_frame_stays_interoperable`, `three_component_catalog_order_is_pinned` | **UNNAMED** |
| `composite_routing.rs` | **16** | The only executed proof for `composite.rs` route entry, drain order, and panic containment | **UNNAMED** |
| `dispatch.rs` | 20 | Frame dispatch above the channel; egress charge and terminal settlement | **UNNAMED** |
| `ipc_budget_evidence.rs` | 14 | Byte-budget accounting evidence | **UNNAMED** |
| `ipc_budget_topology.rs` | 9 | Pool separation topology | **UNNAMED** |
| `handler_contract.rs` | 12 | Handler-side frame contract | **UNNAMED** |
| `client.rs` | 10 | The peer half of the framing contract, incl. the control reserve of C28 | **UNNAMED** |
| `routing.rs` | 12 | Channel and epoch identity | **UNNAMED** |
| `lifecycle.rs`, `activation.rs`, `host_roundtrip.rs`, `instance_security.rs`, `harness_closure.rs`, `perf_budget_runner.rs`, `perf_measurement.rs`, `broca_*` (3), `synapse_*` (4) | — | Part 2a scope or out of scope | **UNNAMED** |

**So: 4 of 26 binaries are CI-named, and 22 are not** — the same ratio Part 2a
established, now confirmed at HEAD for a different scope. The four that are named
are all shm or negotiation binaries, and three of the four are Linux-only.

The sharpest consequence: **`protocol_vectors.rs` is the file the protocol's own
§14.1 designates as the conformance oracle, and no CI job runs it.** Its 18 tests
are the only place the documented byte vectors of §6.4, the 173-byte canonical
body, and the pinned negotiation bodies are compared against literals. Likewise
`composite_routing.rs` is the sole executed proof of `composite.rs`, and it is
unnamed.

If the working-tree deletions land, `transport_negotiation.rs`,
`shm_transport.rs`, `shm_failure_modes.rs`, and `shm_soak.rs` all disappear —
that is **all four** CI-named binaries, leaving `--lib` and `--doc` as the only
named coverage for this scope.

### Production assertions and guards (clustered)

**Explicit `assert!` in production paths: three, all in one place.**
`transport_provider.rs:200-215`, inside `with_injected`: the transport name must
match the wire grammar, must not be the reserved `tcp` name, and must not
duplicate an earlier `(transport, capability_version)`. These are documented as
panicking under `# Panics` at `:174-182` and are the fix from `2f7d7a67` /
`4d48e15c`. **No in-crate or integration test exercises any of the three.**

No `debug_assert!` anywhere in the seven files.

Panicking assertions in effect, all unaudited:

- **Five mutex `expect` sites.** `frame_channel.rs:419`, `:433`, `:436`, `:439`,
  `:441` — every `LeaseTracker` method takes `self.0.lock().expect("lease
  tracker lock")`. `transport_provider.rs:229` takes `self.worker.sender.lock()
  .expect("prepare worker lock")`. A panic under any lease-tracker holder
  converts every later lease operation on that channel into a panic; a panic
  under the worker mutex permanently disables provider preparation for the
  process.
- **Two cannot-fail encode sites.** `wire.rs:849` ("negotiate request
  serialization cannot fail") and the `transport_negotiation.rs` response
  encoders. `bdcc7428` removed one such `expect` from `check_opaque` as a defect
  fix (D6); the remaining ones are the same shape on a different input class.
- **One deliberate panic as a control-flow signal.** `composite.rs:388`
  `panic!("{}", failures.join("; "))` — the composite reports child shutdown
  failure by panicking so the runtime classifies the callback as failed. The
  joined string is redacted (byte lengths only) by construction at `:176-188`.
- **`catch_unwind` at three boundaries**, each an assertion that a panic is
  contained: `composite.rs:155-171` (`catch_child_panic`, every poll wrapped);
  `transport_provider.rs:240-250` (provider `prepare`);
  `tcp_frame_channel.rs:348-349` (`direct.into_owned()` in the writer, where an
  unwind cancels the generation rather than propagating).

Guard clusters, all unaudited, all `Result`- or `Option`-returning:

- **Header decode ladder** (`wire.rs:306-368`): prefix length, version dispatch,
  full header length, unknown type, reserved flag bits, reserved priority,
  reserved admission, sheddable-on-illegal-type, pure-header-with-body,
  channel-0 nonzero epoch, routed zero epoch. Eleven `DecodeError` variants at
  `:218-243`.
- **Inbound role gate** (`frame_channel.rs:58-76`): three checks, two callers.
- **Byte budget** (`wire.rs:376-503`): `capacity` permanence check, `charge`
  blocking acquire, `try_charge` all-or-none, `split` non-inflating,
  `shrink_to` monotonic shrink, `split_or_take` lock-safe release.
- **Producer reservation** (`frame_channel.rs:95-227`): five
  `ProducerError` variants — reservation too small, write crossing the bound,
  commit above the reservation, cursor not equal to the committed length, and
  poisoned-after-error.
- **Lease close gate** (`frame_channel.rs:395-443`): the two-state
  `Drained`/`Quarantined` decision, and the quarantine latch that never clears.
- **Publication state machine** (`frame_channel.rs:706-756`): a four-value
  `AtomicU8` (`QUEUED`/`CANCELLED`/`PUBLISHED`/`COMPLETE`) with `begin_publication`
  and `cancel` as the two competing compare-exchanges.
- **Read-exit classification** (`tcp_frame_channel.rs:279-301`): `frame_close`
  and `drain_close`, two total matches over `ReadStop`.
- **Negotiation decode** (`transport_negotiation.rs:274-780`): closed field sets
  at every depth, version range, transport-name grammar, offer-list bounds, the
  required `tcp` entry, duplicate identity, opaque depth then bytes, token hex
  form, the closed reason vocabulary, and the field-mix invariants encoded in the
  `NegotiateResponse` enum shape (`:222-233`).
- **Composite construction** (`composite.rs:116-135`): duplicate module IDs
  refused so bind dispatch cannot be ambiguous.

Two guards worth naming as silent by construction:

1. `LeaseTracker::close` (`frame_channel.rs:415-427`) returns `Quarantined` for
   both "a lease is live" and "already quarantined", and the doc at `:416-417`
   justifies it: "U1 has no backend wait primitive, so active storage takes the
   allowed bounded-quarantine branch." A caller cannot distinguish the two.
2. `decode_header` is total over arbitrary bytes and returns eleven typed
   errors, but `tcp_frame_channel.rs:193-201` collapses them to **three**
   strings: `"unsupported version"`, `"unknown frame type"`, and a catch-all
   `"invalid header"`. Nine distinct rejection causes become one close reason, so
   no close-side observation can tell which rule fired.

### Test support helpers (enables / masks)

| Helper | Enables | Masks |
| --- | --- | --- |
| `support/raw_client.rs` (652 lines) | An independent wire oracle honouring §14.1: its own `HEADER_LEN`, `WIRE_VERSION`, all twelve type constants, and its own flag constants (`:19-49`), plus its own `decode_header` at `:299`. It is what makes `protocol_vectors.rs` a real conformance test rather than a round-trip. | **The third hand-maintained copy of the framing rules**, alongside `wire.rs` and the TypeScript client. D1 was drift between the other two. Nothing cross-checks the three. Its `decode_header` parses rather than validates, so the oracle cannot itself reject an illegal encoding — a test must assert the disposition separately. `frames_until_corr` (`:572`) returns skipped frames that most call sites discard, and those are the only copy — **tracked open as `magic-context-1or`**, which records that this already caused one real flake fixed in `29e6f4a1`. `closed_within` (`:593`) and `drain_until_close` (`:604`) are budget-bounded, so no test distinguishes "no more frames" from "budget expired", and reset is indistinguishable from orderly close. |
| `support/fake_transport.rs` | An injected provider with a scripted one-shot prepare failure, a prepared-count observer, and a raw-frame candidate driver. The only way most negotiation host tests reach a grant. | Per Part 2a: an in-process duplex stream, so the body is always **contiguous** and the two-span `ReceiveBody::Segmented` decode path never runs from an integration test. It does not implement preflight, taking the serveable default, so lens-c's `preflight-default-advertises-unvetted-offer-parameters` has no executed check. Read errors present as closes. **Deleted in the working tree.** |
| `support/mod.rs::TestHost` (948 lines) | A live in-process host on a fresh temp data root with a publication-bytes-changed startup wait and a `Drop` that cancels. `start_with` is the injection point every provider test uses (`config.transport_providers = ...`). | Per Part 2a: a fresh data root per test, publication-keyed waiting, no staged generation, and a `Drop` that cancels without joining. For Part 2b specifically, `start_with` mutating `transport_providers` means **every negotiation test overwrites the default registry**, so no test in the tree exercises the production default — which is precisely the configuration L1 shows to be non-empty. |
| `support/echo_host.rs` | A real wire endpoint on its own two-worker runtime, so at least one framing test runs on a multi-worker scheduler. | Per Part 2a: infallible callbacks, empty route-gone and shutdown, so no lifecycle-fatality or ordered-teardown claim is reachable through it. |
| `support/shm_process.rs` | An out-of-process shm peer, the only crash-a-real-peer driver for the channel seam. | **Deleted in the working tree**, together with the three shm test binaries it serves. |
| `frame_channel/contract_tests.rs` `ChannelFactory` / `PeerDriver` / `Harness` (`:407-455`, `tcp_frame_channel.rs:425-500`) | A transport-neutral harness with an **independent frame-level peer**: `TcpPeer` "encodes and decodes v2 frames itself so the channel under test is never used to verify its own output" (`tcp_frame_channel.rs:456-458`). A fourth independent implementation of the framing rules, and a good one. | The harness uses `tokio::io::duplex(cfg.transport_buffer_bytes)`, an in-memory stream — no real socket, no partial-write behaviour except through the explicit stub, no reset-vs-EOF distinction. `TcpPeer` is a fourth copy of the header layout, compounding the drift surface D1 exposed. And with one factory registered, the "neutral" parameterization currently proves nothing about neutrality. |

### Concurrency verification tooling

**None found.** No loom, shuttle, Miri, or ThreadSanitizer configuration
anywhere in the repository, re-verified at HEAD. This matters here more than in
Part 2a: `frame_channel.rs` contains a four-state `AtomicU8` publication machine
(`:706-756`) whose whole purpose is to resolve a race between
`FrameSendTicket::cancel` and the writer's `begin_publication`, with
`Ordering::AcqRel`/`Acquire` on both compare-exchanges. That is a
loom-shaped problem with no loom.

Threading of the checks that touch it: `contract_tests.rs`'s
`cancellation_classifies_before_and_after_publication_without_double_release`
is `#[tokio::test]` without `flavor = "multi_thread"`, so it runs on a
current-thread scheduler that cannot interleave the writer task with the
cancelling caller.

### Tracked issues

`docs/AUDIT-KNOWN-ISSUES.md` (915 lines) contains **no** entry for `mc-host`
wire, framing, frame-channel, negotiation, provider, or composite behaviour. All
matches for "wire", "channel", and "egress" are TypeScript plugin concerns
(memory blocks, `channel2_nudge_state`, smart-note sandbox egress).

In beads, three open issues bear on this scope:

| Issue | State | Relevance |
| --- | --- | --- |
| `magic-context-kp5` | OPEN, P2 | "Give outgoing-frame byte accounting one owner in wire.rs". Records that `client.rs` and `wire.rs` each define a `ByteCounter`/`ByteCharge` pair with the same contract, distinguishable only by module path, **and that the two reservation orderings disagree**: `connection.rs::reserve_catalog_frame` charges before encoding using a hand-computed `body.len() + HEADER_LEN`, while `client.rs::encode_data_frame` encodes first and charges afterward, "so the encoded buffer is briefly unaccounted". This is a documented, open, in-scope accounting hole. |
| `magic-context-1or` | OPEN, P3 | `RawClient::frames_until_corr` discards the only copy of skipped frames. One real flake already, fixed per-site in `29e6f4a1`; the issue argues the per-site approach is what allowed the flake. |
| `magic-context-awe` | OPEN, P2 | "repo: claim wire payload round-trip fixture — coordinate with 0fm". |

**Every bead referenced by a commit in this scope still exists.** Checked all 22
commits: only two reference an issue — `464f3f59` cites `magic-context-ymc.3`
(CLOSED) and `f9cfd8eb` cites `magic-context-vho` (IN_PROGRESS) — and both
resolve. This is a **different** result from Part 2a, which found two beads filed
instead of fixes that no longer exist. No such disappearance in Part 2b.

## Suspiciously quiet areas

Scope code with no executed check, ordered by risk.

1. **`protocol_vectors.rs` is the designated conformance oracle and no CI job
   runs it.** Protocol §14.1 `:991` makes committed-literal fixtures with an
   independent decoder the standard of proof. Those 18 tests are the only place
   the §6.4 header vectors, the 173-byte canonical body, the pinned negotiation
   bodies, and the maximum-size interoperability frame are checked against
   literals. Unnamed. Related: lens-a
   `documented-byte-vectors-pin-the-production-codec`.
2. **`composite.rs` has zero in-crate tests and its only integration binary is
   unnamed.** 390 lines including the fixed drain order (C22), the `catch_unwind`
   poll wrapper, the duplicate-module-ID refusal, and the redaction contract that
   L2 shows is broken. `composite_routing.rs` (16 tests) is the whole executed
   proof, and no workflow names it.
3. **`transport_negotiation.rs` has zero in-crate tests for 973 lines**, and its
   integration binary is Linux-only. So on macOS, nothing checks the strict
   decoder, the recursive duplicate-key rejection, the opaque depth and byte
   bounds (both of which are D-record fixes for stack exhaustion and unbounded
   allocation), or the closed fallback vocabulary whose drift caused D4.
4. **The three registry assertions have no check at any level.**
   `transport_provider.rs:200-215` is the fix from two separate review rounds,
   guards against a provider claiming the reserved `tcp` name — described in
   `4d48e15c` as allowing continuation of "the v1 bootstrap channel under a
   version lie" — and nothing constructs the violating input.
5. **The prepare worker is untested.** `transport_provider.rs:225-265`: lazy
   thread start under a mutex, `PREPARE_QUEUE_BOUND` back-pressure,
   `catch_unwind` plus `redact_sync` containment, and a spawn-failure path whose
   fail-closed behaviour is asserted only in a comment at `:257-259`. This is the
   D9 fix surface, three commits deep, with three in-crate tests in the file none
   of which touch it.
6. **The publication race has no interleaving check.** The `AtomicU8` machine
   (`frame_channel.rs:706-756`) exists solely to resolve cancel-versus-publish.
   Its one test is current-thread. No loom, no shuttle. A wrong `Ordering` here
   produces either a double release or a frame reported `NotSent` after its bytes
   were written — the `outcome_unknown` misclassification protocol §10.1 `:800`
   forbids.
7. **`ReadClose::Overloaded` has no producer on the TCP path.** Added by
   `3a45de9d` at `frame_channel.rs:39-43`; `tcp_frame_channel.rs:212` still
   returns `Corrupt("body budget wait exceeded frame deadline")` for the same
   condition. So one variant is unreachable from TCP and the two transports
   disagree on classifying one event. Nothing detects the divergence.
8. **The segmented receive path never runs.** `ReceiveBody::Segmented`
   (`frame_channel.rs:450`) and `InboundFrame::segmented` (`:492`, carrying an
   `#[allow(dead_code, reason = "shared-memory backends supply wrapped bodies")]`)
   — the `allow` is itself the admission. The only integration driver
   (`fake_transport.rs`) uses a contiguous duplex stream. So the one place
   `into_owned` still records a copy is the one path with no executed check.
9. **The `CopyCounter` no longer counts the TCP ingress copy.** After
   `eafced9a`, `into_owned` moves contiguous storage (`frame_channel.rs:541-547`).
   Any zero-copy assertion against `CopyCounter` on the TCP path passes
   trivially. The counter is `pub` (`:82-90`) and is the observable lens-b
   `every-egress-body-copy-is-counted` depends on.
10. **The contract suite has one factory.** `contract_tests.rs:457` is the only
    instantiation, so nine scenarios written to be transport-neutral currently
    prove one transport. The doc at `:5-7` states the plural intent.
11. **`frame_channel.rs` has zero direct in-crate tests** for 882 lines. All 15
    tests live in the `contract_tests` submodule and go through the TCP factory,
    so `validate_inbound_header` is never called directly — its three branches
    are reached only through `tcp_frame_channel.rs`'s reader.
12. **Four independent copies of the framing rules, none cross-checked.**
    `wire.rs`, `support/raw_client.rs`, `contract_tests.rs`'s `TcpPeer`, and the
    TypeScript client. D1 was drift between two of them. Each copy is
    individually justified — §14.1 *requires* the oracle to be independent — but
    no check compares the accept sets, so drift is detectable only by a test that
    happens to straddle two copies.
13. **The idle first-byte read is deliberately unbounded** (C16,
    `tcp_frame_channel.rs:161-166`). §6.3 `:291` requires this and explains why
    ("A deadline that instead started at read-loop entry would close healthy idle
    connections"), so it is correct. It is quiet in that no check asserts the
    deadline is *not* armed before the first byte; a future refactor arming it
    earlier would break healthy long-request connections and no test would fail.
14. **Nine decode causes collapse to three close strings**
    (`tcp_frame_channel.rs:193-201`). No test asserts which cause produced a
    close, so the eleven-variant `DecodeError` taxonomy is unobservable from any
    integration test.
15. **`encode_split_frame`'s 16 KiB threshold is a silent behaviour switch.**
    `wire.rs:601`: bodies below `SPLIT_WRITE_MIN_BODY` take the single-buffer
    path, at or above it the two-write path. Nothing in the scope's tests
    obviously straddles that boundary, so the two egress shapes may not both be
    exercised at the switch point.
16. **No encoder validates the frame's own legality.** Neither
    `encode_owned_frame` (`wire.rs:569`) nor `encode_split_frame` (`:604`) checks
    that a pure-header type carries no body, that flags suit the type, or that
    the channel/epoch pairing is legal — only that `body.len()` fits the cap.
    `FrameId::control` (`:517`) forces both identity fields to zero and
    `FrameId::routed` (`:525`) copies them from a `RouteHandle`, so legality rests
    on route handles never carrying epoch 0. Lens-a
    `encoder-never-emits-a-frame-its-own-decoder-rejects` owns this.
17. **The reservation-ordering disagreement in `magic-context-kp5` is open and
    unchecked**: one path charges before encoding from a hand-computed size, the
    other encodes first and charges after, leaving the encoded buffer briefly
    unaccounted. Two accounting implementations, two orderings, no check that
    either is the rule.
18. **macOS runs none of the 50 in-crate tests in this scope** (`ci.yml:173-174`
    names one unrelated filter) and none of the three unnamed-but-relevant
    integration binaries. The only scope coverage on macOS is `--test shm_soak`
    and the two `--doc` lease tests.

## Open questions

- **Q1.** Should the four independent framing-rule implementations get a single
  cross-check, given that D1 was drift between two of them and §14.1 forbids
  collapsing them into one? A conformance table shared as data, with each
  implementation asserting against the table rather than against another
  implementation, would preserve independence. (needs human input)
- **Q2.** Is the `ShmProvider` in `HostConfig::default()` (L1) intentional? The
  three most recent commits are a shm-to-production migration and the working
  tree is mid-way through another step, so this may be a deliberate change with
  a stale module doc. The answer decides the reachability class of the entire
  provider and candidate surface, so it blocks Lens C's records. (needs human
  input)
- **Q3.** Does every early-rejection arm on a setup-only generation now consume
  the negotiation allowance (D8)? The commit point is in `connection.rs`, outside
  this scope. Unresolved, needs a `connection.rs` read.
- **Q4.** Does the host owe the §11 control-reserve guarantee (C28, L3)? The
  table is scoped to clients, but the contract suite asserts a control-capacity
  property against a host channel that has no reserve. Either the scenario name
  overstates what it checks, or the host is missing a reserve. (needs human
  input)
- **Q5.** Should the working-tree deletions be resolved before synthesis? If they
  land, all four CI-named binaries and three of seven scope files disappear.
  Synthesis against HEAD would produce a catalog for code that is being removed.
  (needs human input)
- **Q6.** Is the TCP-path `Corrupt("body budget wait exceeded frame deadline")`
  versus `ReadClose::Overloaded` divergence (quiet area 7) intentional per-
  transport policy, or an incomplete application of `3a45de9d`? Lens A raises the
  same question from the property side.
- **Q7.** Was the loss of the TCP ingress copy count in `eafced9a` (quiet area 9)
  understood as changing the `CopyCounter` contract, or a side effect of the
  move optimization? The doc wording survives either reading.
