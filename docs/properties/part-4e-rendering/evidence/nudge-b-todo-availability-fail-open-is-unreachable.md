# nudge-b-todo-availability-fail-open-is-unreachable

## Discovery trigger

`injection.rs` states three times that a missing availability verdict "fails
open". Checking that claim against the production call path found the opposite,
and found a second doc comment in `transform.rs` that states the opposite too.
Per `METHOD.md` rule 3 a documented guarantee is a claim under test, so this
became a record rather than a note.

## Evidence trail

`HEAD` `e447c927`. All lines read back.

### The contract, side A

`crates/mc-module/src/injection.rs`:

- `:205` — on `capture_todo_state_on_bust`: "A missing availability verdict fails
  open for legacy senders."
- `:228` — on `advance_injection_from_meta`: "A frozen unavailable verdict makes
  the state effectively empty only on a bust."
- `:299` — on `advance_injection`: "A frozen unavailable verdict is treated as an
  empty todo state on busts, while an absent verdict fails open for legacy
  senders."

The implementation matches those comments *as written*. The parameter is
`todo_tool_present: Option<bool>` and every guard tests for the exact value
`Some(false)`:

- `:212` — `if !is_bust_pass || todo_tool_present == Some(false) { return false }`
- `:256` — `if todo_tool_present == Some(false) { return frozen.is_some() }`
- `:314-318` — `let effective_state_json = if todo_tool_present == Some(false) {
  Some("[]") } else { persisted_state_json };`

So `None` is treated identically to `Some(true)` inside the module. Fail-open is
a real property of these four functions.

### The contract, side B

`crates/mc-module/src/transform.rs:737-741`, the doc comment on the wire field
itself:

```
/// Combined host verdict for OpenCode's native todowrite tool (tool map and permission).
/// None is a provisional or legacy-sender verdict and fails closed: missing authority
/// must never manufacture a synthetic tool call.
#[serde(default, skip_serializing_if = "Option::is_none")]
pub todo_tool_present: Option<bool>,
```

Directly contradicts side A for the same value of the same field.

### The code

`transform.rs:2626-2630`:

```
fn todo_synthesis_verdict(req: &TransformRequest) -> Option<bool> {
    // Normalize both explicit denial and missing host authority to the injection API's
    // unavailable verdict so neither case can manufacture a synthetic tool call.
    Some(req.todo_tool_present.unwrap_or(false))
}
```

The return type is `Option<bool>` but the function can only ever return
`Some(_)`. Its own comment states the fail-closed intent.

Every production call into the injection API routes through it. Enumerated by
grep for `todo_synthesis_verdict`:

- `transform.rs:4155` — into `injection_pending_after_capture` (called at
  `:4152-4157`).
- `transform.rs:4529` — same predicate, second site.
- `transform.rs:4826` — same predicate, third site.
- `transform.rs:7454` — into `advance_injection_from_meta` inside
  `advance_synthetic_todo`.

A grep for the four public injection entry points finds no other production
caller: `advance_injection`, `advance_injection_after_capture`, and
`capture_todo_state_on_bust` appear only in `injection.rs`'s own `#[cfg(test)]`
module (`:585-910`).

### The shipped sender

`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts`:

- `:1945-1951` — `const todoToolPresent = await resolveCombinedTodowriteVerdict(...)`.
- `:141-146` — that function's signature is
  `Promise<boolean>`; its four return statements are `false` (`:147`), the
  `permissionDenied` fallthrough (`:171` returns `!permissionDenied`), and the
  early `false` at `:147`. It cannot resolve to `undefined`.
- `:2023-2024` — the value is placed in `passInputs` unconditionally.
- `:1382-1385` — the request builder includes the field when
  `typeof args.passInputs.todo_tool_present === "boolean"`, which the above
  guarantees.

So the absent-field case does not arise from the shipped host either. Both the
module and the host close the door.

## Failure scenario

There is no live failure today. The failure is a future one, and it is the exact
failure `transform.rs:739-741` warns against. A maintainer adding a fifth call
site reads `injection.rs:299` ("an absent verdict fails open for legacy
senders"), concludes that passing `None` is the legacy-compatible choice, passes
`req.todo_tool_present` directly, and the module then manufactures a synthetic
`todowrite` tool call for a session where the host never confirmed the tool
exists. The provider is sent an assistant message calling a tool that is not in
the tool map, which most providers reject outright.

## Timing windows and dependencies

None. This is a static reachability property of the call graph.

## What a test must construct

Two halves, and the first is the one that matters.

1. **Reachability half.** A test that asserts `todo_synthesis_verdict` never
   returns `None`, for both `Some(true)`, `Some(false)`, and `None` inputs. Three
   lines, and it pins the fail-closed reading against a future edit. Today
   nothing asserts it.
2. **Safety half.** Keep the existing direct-call tests
   (`injection.rs:626-644`, `:646-659`, `:706-721`) as the
   `always-or-unreached` safety proof for the branch, and add a comment or a
   marker naming them as coverage of a path with no production caller.

The `sometimes`/`reachable` distinction matters here. A coverage check asserting
that a production request with `todo_tool_present: None` reaches the fail-open
branch would never fire, because `todo_synthesis_verdict` intercepts it. That is
the point: the correct assertion is the negative reachability one, expressed as
`always-or-unreached` on the branch plus an `always` on the collapse.

## Investigation log

### Q: Which of the two doc comments is the intended contract?

- Sources examined: `injection.rs:205`, `:228`, `:299`, `:1-9` (the module
  header); `transform.rs:737-741`, `:2626-2630`; the git-visible content of
  `packages/plugin/.../rust-mode-transform.ts:141-171`, `:1941-1943` (the
  comment "provisional or missing host evidence fails closed for synthesis").
- Findings: three independent statements agree on fail-closed: the
  `transform.rs` field doc, the `todo_synthesis_verdict` body comment, and the
  TypeScript comment at `rust-mode-transform.ts:1940-1942`. One source, the
  `injection.rs` doc comments, says fail-open. The module header at
  `injection.rs:5-9` describes the functions as "deliberately pure: the caller
  supplies the persisted todo state and the currently frozen synthetic unit",
  which explains the shape: `injection.rs` documents its own local semantics
  honestly and is silent about the fact that its only caller pre-collapses the
  input.
- Missing evidence: whether the fail-open wording predates
  `todo_synthesis_verdict` or was written alongside it. That needs the history,
  which `METHOD.md` rule 6 does not forbid but which is not decisive either way.
- Conclusion: needs human input on the wording. The behaviour is not in doubt:
  fail-closed ships, and it is the safer reading.

### Q: Is `Option<bool>` on `todo_synthesis_verdict`'s return type load-bearing?

- Sources examined: the four call sites (`transform.rs:4155`, `:4529`, `:4826`,
  `:7454`) and the two API signatures
  (`injection.rs:249-254`, `:229-234`).
- Findings: both APIs take `Option<bool>`, so the `Option` return exists purely to
  match them. Narrowing `todo_synthesis_verdict` to `bool` would require changing
  both signatures, which would in turn delete the fail-open branch and the three
  tests that cover it.
- Missing evidence: none.
- Conclusion: resolved with answer. The `Option` is a signature-matching
  artifact, not a value the function ever needs. That is exactly why the branch
  is dead while the type keeps it looking live.

### Q: Are the three fail-open tests worthless?

- Sources examined: `injection.rs:626-644`
  (`provisional_verdict_keeps_capture_and_composition_fail_open`), `:646-659`
  (`enabled_verdict_keeps_capture_and_composition_behavior`), `:706-721`
  (`aged_out_todowrite_injects_from_module_meta`).
- Findings: not worthless. They are unit tests of a pure function's documented
  contract, and under `always-or-unreached` semantics that is the correct thing
  to have: if a future caller does pass `None`, these prove the branch behaves.
  Their weakness is that a reader takes them as evidence the path is live.
  `aged_out_todowrite_injects_from_module_meta` is also doing double duty as the
  aged-out-metadata test, and that behaviour *is* production-reachable, just not
  with `None`.
- Missing evidence: none.
- Conclusion: resolved with answer. Keep them, label them.
