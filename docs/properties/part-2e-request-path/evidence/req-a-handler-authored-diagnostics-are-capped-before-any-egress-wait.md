# req-a-handler-authored-diagnostics-are-capped-before-any-egress-wait

## Discovery trigger

Task 6 asked whether response buffers are bounded. Handler-authored error strings
are the one payload on this path that is *not* covered by a byte charge, because
they are held as owned `String`s across an await rather than as reserved output.
`dispatch.rs:75-80` flags this itself.

## Evidence trail

The constants, `dispatch.rs:75-80`:

```
/// Longest handler-authored diagnostic retained on a terminal. Diagnostics
/// are held across the egress wait without a charge, so the cap — not the
/// frame limit — is what bounds their retained cost per pending request.
/// Anything larger is replaced immediately, dropping the oversized strings.
const MAX_TERMINAL_CODE_LEN: usize = 128;
const MAX_TERMINAL_MESSAGE_LEN: usize = 4096;
```

**Site 1, request errors.** `bounded_terminal_error` (`dispatch.rs:82-95`):

```
fn bounded_terminal_error(code: String, message: String, retry_after_ms: Option<u64>) -> Terminal {
    if code.len() > MAX_TERMINAL_CODE_LEN || message.len() > MAX_TERMINAL_MESSAGE_LEN {
        return Terminal::Error {
            code: CODE_INTERNAL_ERROR.to_owned(),
            message: "handler error exceeds diagnostic limit".to_owned(),
            retry_after_ms: None,
        };
    }
    Terminal::Error { code, message, retry_after_ms }
}
```

Substitution, not truncation: the oversized strings are dropped whole and
`retry_after_ms` is dropped with them. Called from `dispatch.rs:1050`, inside the
`Ok(RequestOutcome::Error { .. })` arm, with the comment at `:1045-1049` giving
the reason:

> Normalized before the terminal is held across the egress wait: the handler task
> permit is already released, so oversized owned strings would otherwise
> accumulate uncharged across up to max_pending_requests settlements.

That reason is verifiable: the task permit moves into the inner task at `:990` and
releases when the handler returns, while the outer task holds only the pending
permit (`:933`) and the `Terminal` while awaiting egress.

**Site 2, bind rejections.** `dispatch.rs:1210-1218`, hand-written rather than
calling `bounded_terminal_error`:

```
let (code, message) =
    if code.len() > MAX_TERMINAL_CODE_LEN || message.len() > MAX_TERMINAL_MESSAGE_LEN {
        (
            CODE_INTERNAL_ERROR.to_owned(),
            "bind rejection exceeds diagnostic limit".to_owned(),
        )
    } else {
        (code, message)
    };
```

Same constants, same comparison, different substitute message, and no shared
helper. The comment at `:1206-1209` names its own bound: "up to max_routes
concurrent binds would otherwise retain arbitrary allocations. Same caps as
request-error terminals."

**A third, independent cap downstream.** `charged_error_body`
(`dispatch.rs:184-193`) applies the *frame* limit, not the diagnostic limit:

```
let (code, message, retry_after_ms) =
    if error_body_len(code, message, retry_after_ms) > crate::wire::MAX_BODY_LEN as usize {
        (CODE_INTERNAL_ERROR, "handler error exceeds frame limit", None)
    } else {
        (code, message, retry_after_ms)
    };
```

So there are two ceilings with two different substitute messages, and the
diagnostic cap (4 KiB) is far below the frame cap (64 MiB), which means the frame
check is unreachable for any diagnostic that passed site 1 or site 2. It remains
reachable for `emit_error_terminal`'s `&'static str` callers, whose messages are
compile-time constants and therefore never oversized either. That makes
`:184-193` defence-in-depth with no live producer, which is worth stating but is
not this record's subject.

**The empty-code fallback.** `dispatch.rs:1224-1228` substitutes `"bind_rejected"`
for an empty handler code, after the cap check. So a handler returning
`Reject { code: "", .. }` cannot produce an error body with an empty `code` field.

## Failure scenario

Without site 1:

1. A handler returns `RequestOutcome::Error` with a 16 MiB message — a stack
   trace, a serialized request echo, a database error with the full query.
2. `dispatch.rs:1040-1051` builds the `Terminal` and the outer task holds it.
3. The inner task has returned, so the handler task permit is free and another
   request dispatches immediately.
4. Under a contended egress budget the terminal waits at
   `charged_error_body`'s `charge_frame_or_cancel` (`:200`).
5. Repeat up to `max_pending_requests` (928 general at defaults): 928 × 16 MiB of
   owned `String`s held with no byte charge against them.

`egress_budget` cannot prevent this, because the charge is taken for the *encoded
body* at `:198-202`, after the strings already exist. The cap is what makes the
retained cost bounded at 928 × (128 + 4096) bytes ≈ 3.8 MiB.

Without site 2 the same argument runs over `max_routes` concurrent binds, and the
window is longer: the bind rejection is held across `run_route_gone`
(`dispatch.rs:1220`) as well as the egress wait, and `run_route_gone` is bounded
by `lifecycle_callback_deadline` (30 s default).

The maintenance hazard is the duplication. A future change to either constant, or
a decision to truncate rather than substitute, applied at one site and missed at
the other silently reopens half the exposure. There is no test asserting the two
sites agree.

## Timing windows and dependencies

Site 1's window: from `bounded_terminal_error` returning at `:1050` to the frame
being queued inside `settle` at `:473-480`. That spans one budget wait plus one
admission wait, both bounded by `gen.writer.admission_deadline()`.

Site 2's window: from `:1210` to `emit_error_terminal` at `:1229-1236`, spanning
`take_rejected_bind` (`:1219`), `run_route_gone` (`:1220`, up to 30 s),
`finalize_close` (`:1222`), the budget wait, and the admission wait.

Dependency: the cap only binds if it is applied before the first await. Both sites
satisfy this — site 1 is a synchronous call inside the `match`, site 2 is a
synchronous `if` before `take_rejected_bind`. Moving either after an await would
void the property while leaving the code looking correct.

## What a test must construct

1. A handler returning `RequestOutcome::error` with a code of exactly 128 bytes
   and a message of exactly 4096: assert the client receives the handler's own
   code and message, so the boundary is inclusive.
2. The same with 129 and 4097 respectively, separately: assert the client receives
   `internal_error` with "handler error exceeds diagnostic limit" and **no**
   `retry_after_ms`, even when the handler supplied one.
3. The bind mirror: `BindOutcome::Reject` with an oversized code and message,
   asserting `internal_error` with "bind rejection exceeds diagnostic limit".
4. An agreement check: assert both sites use the same two constants, either by
   parameterizing one test over both paths or by a source-level assertion.
5. Residency: saturate egress, settle `max_pending_requests` oversized errors, and
   assert host RSS growth stays within the cap's product rather than the
   handlers' product.

Existing coverage is one inline unit test, `dispatch.rs:1524-1538`
(`diagnostic_limit_substitution_drops_retry_hint`), which covers only case 2 for
site 1 and only the 129-byte code direction. Inline `mc-host` tests are excluded
from CI by every `--test` filter in `ci.yml`, so it runs locally only. Site 2 has
no test at all, and `tests/handler_contract.rs:229`
(`a_rejected_bind_carries_the_handler_code_to_the_client`) uses a short code.

## Investigation log

### Q: Are the two sites' limits actually the same constants?

- Sources examined: `dispatch.rs:79-80` (declarations), `:83` (site 1's
  comparison), `:1211` (site 2's comparison).
- Findings: both compare against `MAX_TERMINAL_CODE_LEN` and
  `MAX_TERMINAL_MESSAGE_LEN` by name, so a constant change propagates. What does
  not propagate is the *shape* of the policy: substitution message, whether
  `retry_after_ms` is dropped (site 2 has no retry field to drop), and the empty
  code fallback which exists only at site 2.
- Missing evidence: none.
- Conclusion: resolved with answer — same constants, duplicated logic.

### Q: Is the frame-limit check at `:184-193` reachable?

- Sources examined: every caller of `charged_error_body`: `dispatch.rs:377`
  (`emit_error_terminal`, `&str` params from `&'static str` callers), `:420`
  (a fixed literal), `:468` (a `Terminal::Error` already through
  `bounded_terminal_error` or built from literals), `:795`
  (`emit_authoritative_rejection`, `&'static str`).
- Findings: `:468` is the only path carrying handler-authored strings, and they
  are capped at 4 KiB by then, far under `MAX_BODY_LEN`. `emit_error_terminal`'s
  `&code` at `:1233` carries a handler bind code — but that is capped at site 2
  first. So no live caller can trip the frame check.
- Missing evidence: none.
- Conclusion: resolved with answer — currently unreachable defence-in-depth. Worth
  noting for the reachability lens but not a defect: it guards the invariant
  independently of the two caps, which is what defence-in-depth is for.

### Q: Does the `escaped_json_len` model matter to this cap?

- Sources examined: `dispatch.rs:101-124`, `:194`, `:212`.
- Findings: `error_body_len` uses `escaped_json_len`, so a 4096-byte message of
  control characters serializes to 24,576 bytes. The charge is taken for the
  *serialized* size at `:198`, so the budget accounting is correct. The retained
  `String` is still 4096 bytes, so the cap's own arithmetic is unaffected. The
  `debug_assert_eq!` at `:212` is the only guard that the model matches
  `serde_json`, and it is compiled out in release.
- Missing evidence: whether any release-build check exists elsewhere.
- Conclusion: resolved with answer — the cap is sound; the model's release-build
  verification is a separate concern, recorded as observation 4 in the lens file.
