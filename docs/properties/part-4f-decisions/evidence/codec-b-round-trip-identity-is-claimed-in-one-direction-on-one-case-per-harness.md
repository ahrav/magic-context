# codec-b-round-trip-identity-is-claimed-in-one-direction-on-one-case-per-harness

## Discovery trigger

Task item three: be precise about which round-trip direction is claimed, because
a prior part found a round-trip assertion that was a tautology over accepted
inputs (`part-1-shm-transport/catalog.md:1360-1361`). I checked both directions
and both goldens. The assertions here are not tautologies; the weakness is
different and needs stating precisely so it is not confused with Part 1's.

## Evidence trail

The claimed direction is decode-then-encode. `codec/mod.rs:78-89`, read at `HEAD`
`e447c927`:

```
78:         for case in golden.cases {
79:             let decoded = decode_opencode(&case.messages);
80:             let decoded_again = decode_opencode(&case.messages);
81:             assert_eq!(decoded, decoded_again);
82:             assert!(decoded.boundary.is_some());
83:
84:             let ck_messages: Vec<_> = decoded.messages.iter().map(|msg| msg.ck.clone()).collect();
85:             let encoded = encode_opencode(&ck_messages, &decoded.sidecar, None);
86:             let encoded_again = encode_opencode(&ck_messages, &decoded.sidecar, None);
87:             assert_eq!(encoded, encoded_again);
88:             assert_eq!(encoded, strip_opencode_compaction(case.messages));
89:         }
```

and the Pi equivalent at `:201-212`, ending in
`assert_eq!(encoded, strip_pi_compaction(case.entries));` at `:211`.

Why these are genuine oracles and not tautologies. The comparison target is
`case.messages` / `case.entries`, the captured input array, which is external to
the codec. `opencode-golden.json`'s `generated_from` names a real database
(`db_path: /Users/ufukaltinok/.local/share/opencode/opencode.db`, `selection:
"part-table feature queries over read-only captured OpenCode rows"`), and
`pi-golden.json`'s names real session files under `.pi/agent/sessions/`. Part 1's
tautology was structurally different: `harness.rs:112-116` asserted
`decode(encode(x)) == x` on a value the test itself had just encoded, so no
external reference existed. Here an external reference exists.

The reverse direction is not claimed, and is provably false.
`codec/mod.rs:112-125`:

```
112:         let mut output = vec![
113:             CkWireMessage::synthetic_user_text("<session-history>\nP1\n</session-history>"),
114:             CkWireMessage::synthetic_user_text("session delta"),
115:             todo.assistant_msg,
116:             todo.tool_msg,
117:         ];
118:         output.extend(decoded.messages.iter().map(|message| message.ck.clone()));
119:
120:         let encoded =
121:             encode_opencode_with_session(&output, &decoded.sidecar, Some(&golden.session_id), None);
122:         assert_eq!(encoded[0], golden.m0);
123:         assert_eq!(encoded[1], golden.m1);
124:         assert_eq!(encoded[2], golden.synthetic_todo);
125:         assert_eq!(&encoded[3..], golden.messages.as_slice());
```

Four leading CK messages (m0, m1, todo assistant, todo tool) produce three
encoded values, indices 0, 1, 2. The collapse is `render_synthetic_todo_pair`
(`codec/opencode.rs:916-948`), reached from `:388-399`, which consumes two
messages and emits one part with `index += 2` at `:398`. The general tool-pair
collapse at `:404-416` does the same with `index += 2` at `:413`, and the
in-message version at `:749-757` pushes one part for two blocks with
`block_index += 2` at `:755`. The comment at `:750-753` states the reason:
"OpenCode stores a completed invocation as one part, while CK expands that part
into adjacent call and result blocks."

So encode-then-decode maps two CK messages to one wire message and back to one CK
message with two blocks. The role also changes: the CK pair is
`assistant` + `tool`, and `encode_new_message` at `:1009-1014` rewrites a
standalone `tool` role to `assistant` with the comment "MessageV2 model conversion
only visits tool parts inside assistant messages." This is a designed
non-identity, pinned by `codec/mod.rs:112-125` without being named there.

The exception set, and the fact that it is stated twice. `encode_opencode` passes
`preserve_compaction: false`:

```
283: pub fn encode_opencode(
...
289:         Some(mid) => encode_opencode_impl(messages, sidecar, None, false, &[mid], true),
290:         None => encode_opencode_impl(messages, sidecar, None, false, &[], true),
```

`encode_opencode_with_session` passes `true`:

```
305:         Some(mid) => encode_opencode_impl(messages, sidecar, session_id, true, &[mid], true),
306:         None => encode_opencode_impl(messages, sidecar, session_id, true, &[], true),
```

with the doc comment at `:294-297` explaining: "Native serving also retains
compaction parts because it promises a full-array replay of untouched ingress."
The consequence for the tests: the round-trip golden uses `encode_opencode` and
must therefore strip compaction in its oracle (`codec/mod.rs:88`, helper at
`:273-281`), while the native-serving golden uses `encode_opencode_with_session`
and compares `&encoded[3..]` to the raw messages unstripped (`:125`). The two
tests together are consistent evidence that the compaction policy is exactly as
documented. The observation is that the policy now exists in two places: the
`preserve_compaction` flag threaded through `encode_opencode_impl`, and the test's
own `strip_opencode_compaction` helper, which reimplements it.

Oracle fidelity, by the goldens' own admission. Both files carry
`projection_oracle.status: "todo"`. The OpenCode reason: "The OpenCode SDK
serializer is not vendored in the Rust workspace test closure; these goldens
assert raw-part identity for wire-reachable parts plus sidecar re-attach, with
compaction parts excluded because the codec emits them as a boundary signal.
TODO: replace this fallback with toModelMessagesEffect byte projection when the
SDK is available to the generator." The Pi reason is the same shape, naming "Pi
provider serializer entry points". So the oracle is input-array identity, not
provider wire bytes.

Breadth. Both `cases` arrays have length 1: 10 OpenCode messages, 11 Pi entries,
verified by parsing the files.

The structural reason the pass carries less information than it looks like it
should: for an unmutated decoded message, the encoder short-circuits. In
OpenCode, `encode_with_meta` checks `block_is_unchanged` at `:763` and `continue`s
at `:764-765`, then at `:804-808` returns `meta.raw.clone()` verbatim if `raw ==
meta.raw`. In Pi, `:372-374` returns `meta.raw.clone()` when the tool-result
block is unchanged and `:399-403` does the same for the general case. So for an
input that decodes cleanly and is not mutated, the encoder's output is the
retained raw by construction, and identity is nearly guaranteed regardless of
whether the block-rendering code is correct. The golden exercises the
render-and-update paths only for whatever the fixture happens to mutate, which
for the round-trip test is nothing.

## Failure scenario

An encoder regression in a render path that the golden's unmutated round trip
never invokes. Concretely: break `update_content_part`'s reasoning arm
(`codec/pi.rs:536-542`) so it writes `thinking` into the wrong key. The round-trip
golden still passes, because every decoded block is unchanged and `:463-465`
skips the update entirely. The break surfaces only when the transform mutates a
reasoning block, which no golden case does.

## Timing windows and dependencies

None temporal. The dependency chain is: identity holds because the retained raw
holds, which holds because `meta_for_ck` (`codec/sidecar.rs:315-329`) resolves the
right meta, which holds because the mid survives decode unchanged. Break any link
and identity fails for reasons unrelated to the render code.

## What a test must construct

1. More cases. One per harness is the entire base. The generator exists
   (`generated_from` describes it) but cannot be re-run by anyone else; see the
   last investigation question.
2. A mutated-block round trip: decode, mutate one block of each `CkKind`, encode,
   and assert the *specific* expected part shape. This is what
   `codec/opencode.rs:1515-1582` and `codec/pi.rs:1436-1443` do for a couple of
   shapes; it needs to be systematic over the eight `CkKind` variants and the
   three `ResultBlockKind` variants.
3. An input containing an unrecognised part or entry type, so the two opposed
   unknown-shape policies are covered by the test that is taken to cover them.
   Verified absent: the OpenCode case's part types are `step-start`, `reasoning`,
   `text`, `tool`, `step-finish`, `patch`, `file`, `compaction`; the Pi case's
   entry types are `message`, `custom_message`, `compaction`.
4. An explicit negative for the reverse direction: assert that
   `decode(encode(ck_pair))` yields one message with two blocks, so the designed
   non-identity is stated rather than incidentally pinned by `codec/mod.rs:124`.

## Investigation log

### Q: Should the compaction exception set be declared in code rather than reimplemented in the test?

- Sources examined: `codec/opencode.rs:283-341` (all five encoder entry points and
  their `preserve_compaction` arguments), `:785-787`; `codec/pi.rs:19-21`, `:36-39`;
  `codec/mod.rs:273-288`.
- Findings: the encoder's policy is a boolean threaded through five entry points.
  The test's `strip_opencode_compaction` (`:273-281`) and `strip_pi_compaction`
  (`:283-288`) are independent reimplementations. Pi's is structurally different
  from OpenCode's: OpenCode strips a *part* from within a message, Pi filters a
  whole *entry*, matching the decoders (`codec/opencode.rs:161-170` versus
  `codec/pi.rs:36-39`). So the two harnesses genuinely need two helpers, and the
  duplication is between encoder and test rather than between harnesses.
- Missing evidence: none.
- Conclusion: resolved with answer. Two statements of one rule, in code and in
  test. Not currently divergent. Recorded as an open question on the record
  because a shared helper would make the test's oracle derive from the encoder's
  policy rather than restate it.

### Q: Can the `projection_oracle` TODO be discharged without vendoring the harness SDKs?

- Sources examined: both goldens' `projection_oracle`; `differential_goldens.rs:1`
  ("DG-1..3 differential goldens: TS emits fixtures, Rust consumes them
  in-process") and `:41-71`.
- Findings: `differential_goldens.rs` is the pattern that would discharge it. It
  consumes a fixture whose `expected.wire` was produced by the TypeScript side,
  with provenance fields (`generator_version`, `input_sha256`) asserted at `:46-47`.
  So the crate already has a mechanism for "TypeScript computes the oracle, Rust
  checks against it" that does not require vendoring anything into the Rust test
  closure.
- Missing evidence: whether the OpenCode and Pi provider serialisers are reachable
  from the TypeScript side of this repo. `packages/plugin/src/hooks/magic-context/`
  and `packages/pi-plugin/` exist, and `PARITY.md:15` says they "share the same
  `packages/plugin/src` core", but whether either can invoke
  `toModelMessagesEffect` is not something I established.
- Conclusion: unresolved, needs a reading of the TypeScript packages. If the
  serialisers are reachable there, the `differential_goldens.rs` pattern discharges
  the TODO. If not, the TODO is permanent and both goldens should say so instead of
  saying "when the SDK is available to the generator".

### Q: Are the goldens reproducible?

- Sources examined: `opencode-golden.json`'s `generated_from.db_path`;
  `pi-golden.json`'s `generated_from.session_files`.
- Findings: both are absolute paths under `/Users/ufukaltinok/`. The OpenCode one
  names a personal `opencode.db`; the Pi one names four `.jsonl` session files
  under `~/.pi/agent/sessions/`. Neither input is committed. No generator script
  is referenced.
- Missing evidence: none needed; the paths settle it.
- Conclusion: resolved with answer. Neither golden can be regenerated by anyone
  other than its author, on any other machine. That is a supply problem for every
  recommendation in this record that asks for more cases, so it is raised as a
  lens-level open question.
