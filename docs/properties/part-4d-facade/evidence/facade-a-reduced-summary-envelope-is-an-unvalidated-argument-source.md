# facade-a-reduced-summary-envelope-is-an-unvalidated-argument-source

## Discovery trigger

Reading `facade_arguments` for the unknown-key question exposed a second mode
nobody had named in the scope map: the function can replace the entire argument
map with the result of parsing a caller-supplied string. That makes model text a
first-class argument source, which is a trust-boundary question rather than a
validation question.

## Evidence trail

`crates/mc-module/src/lib.rs:14416-14435`

    /// Recover the intended argument object when a model repeats the reduced-call
    /// envelope it saw in context. Only unwrap when no real primary field is present,
    /// so explicit tool arguments always take precedence.
    fn facade_arguments(request: &Value, primary_fields: &[&str]) -> Option<Map<String, Value>> {
        let arguments = request.get("arguments")?.as_object()?;
        if primary_fields
            .iter()
            .any(|field| arguments.contains_key(*field))
            || arguments.get("reduced") != Some(&Value::Bool(true))
        {
            return Some(arguments.clone());
        }
        let Some(summary) = arguments.get("summary").and_then(Value::as_str) else {
            return Some(arguments.clone());
        };
        match serde_json::from_str::<Value>(summary) {
            Ok(Value::Object(unwrapped)) => Some(unwrapped),
            _ => Some(arguments.clone()),
        }
    }

Three guards stand in front of the unwrap, and all three are cheap for a caller
to satisfy:

1. No primary field present. The primary sets are `["drop"]` (`:10487`),
   `["action"]` (`:10595`), `["query"]` (`:10704`),
   `["message", "start"]` (`:10766`), `["action", "content"]` (`:11552`).
2. `arguments["reduced"] == true`.
3. `arguments["summary"]` is a string that parses to a JSON object.

On success the returned map is the parsed object, and every downstream
`string_arg`, `i64_arg`, `usize_arg`, and `validate_string_cap` call runs against
it. So the caps are applied to the unwrapped map, not bypassed. What is bypassed
is any bound on `summary` itself before parsing: nothing checks its length, and
`serde_json::from_str` builds a full `Value` from it. The request-level guards
still hold, because the whole body already passed
`enforce_request_byte_cap` (`:11964`) and `value_footprint_bound` (`:11979`), and
`value_footprint_bound` counts `summary`'s bytes as string bytes. So the resident
charge covers the raw string but not the second `Value` tree the unwrap builds
from it. For a 1 MiB facade body that second tree is bounded by the same
counting logic applied to a smaller input, so the amplification is bounded, but
it is uncharged.

The hardened analogue on the other side of the wire:

- `packages/plugin/src/tools/unwrap-imitated-reduced-args.ts:1-5` declares
  `ImitatedReducedArgs { reduced?: boolean; summary?: string }`, the exact shape.
- `:6-30` defines a per-field rule language (`string`, `number`, `boolean`,
  `enum`, `object` with `fields` and `optionalFields`, `array` with `maxItems`).
- `:33-34` sets `MAX_DECODED_STRING_LENGTH = 1024 * 1024` and
  `MAX_DECODED_ARRAY_ITEMS = 100`.
- `:37-42` — "Nested objects must carry every required field and nothing
  undeclared. An undeclared field would reach the tool unvalidated, and a
  missing required field would let a partial value (a mutation token short one
  digest) through to the mutation path."

That comment is the contract statement. It says explicitly that an undeclared
field reaching the tool unvalidated is the hazard being defended against, and
that the concrete worry is a mutation token short one digest. The Rust
`facade_arguments` has none of that machinery: it accepts whatever object the
string parses to.

## Failure scenario

The scenario depends on whether the module can receive an un-unwrapped envelope,
which is the open question below. Assuming it can:

A model reproduces a reduced `ctx_memory` call it saw in its own context and
emits `{"name":"ctx_memory","arguments":{"reduced":true,"summary":"{\"action\":\"get\",\"publicClaimIds\":[...]}"}}`.
`facade_arguments` unwraps, `handle_ctx_memory_facade` reads `action` from the
unwrapped map, and the call proceeds as though the model had emitted the inner
object directly.

For `ctx_memory` the mutation actions are refused unconditionally
(`:10692-10694`, "claim mutations require the host claim-operation commit
path"), so the reachable damage through that tool is a read. `ctx_note` is the
mutating tool with an unwrap path: its primary set is `["action", "content"]`, so
an envelope carrying neither plus `reduced: true` and a `summary` encoding
`{"action":"write","content":"..."}` writes a durable note whose arguments came
from a parsed string. Every cap at `:11556-11563` still applies to the unwrapped
map, so the write is well-formed; what is absent is any check that the unwrapped
object is the shape the tool advertises, which is exactly what the TypeScript
side enforces with `validObjectField`.

The concrete asymmetry to record is not "this is exploitable". It is that two
implementations of the same recovery exist, one with a declared rule language
and an explicit rejection of undeclared fields, and one with neither, and the
Rust one is the last line before the store.

## Timing windows and dependencies

None internal. The dependency is entirely about which side unwraps first.

If the plugin's `unwrap-imitated-reduced-args` runs before the module send, the
module receives an already-unwrapped argument map, the `reduced` key is gone, and
the Rust branch is dead code that exists as defence in depth. That is why this
record's check semantics are `always-or-unreached` rather than `always`.

## What a test must construct

1. For each of the five `ctx_*` handlers, a pair of calls: one with arguments
   `A`, one with `{"reduced": true, "summary": serde_json::to_string(&A)}` where
   `A` contains none of that tool's primary fields.
2. Assert the two outcomes are identical, including identical cap rejections.
   The cap cases are the interesting half: build `A` with a `content` field of
   `MAX_NOTE_CONTENT_BYTES + 1` bytes and assert both forms are rejected by
   `:11556`.
3. Assert the guard order: an envelope carrying both `reduced: true` and a real
   primary field must use the primary field, per the doc comment's "explicit tool
   arguments always take precedence". That is the one behaviour the comment
   promises and no test checks.
4. Assert the non-object cases fall back rather than error: `summary` that parses
   to an array, to a scalar, or not at all must return the original map
   (`:14431-14434`).
5. To make the record non-vacuous, the campaign needs a marker on the unwrap
   branch itself, otherwise a suite that only ever sends direct arguments passes
   every assertion above without executing the branch once.

## Investigation log

### Q: Does the shipped plugin always unwrap before the module sees the body, making the Rust branch dead defence in depth?

- Sources examined: `packages/plugin/src/tools/unwrap-imitated-reduced-args.ts`
  in full for its exported surface; a search of `packages/plugin/src` for
  `reduced: true` and `"reduced"`, which returned exactly one non-test hit,
  `unwrap-imitated-reduced-args.ts:92`; `lib.rs:14416-14435` for the Rust
  branch; `lib.rs:25652-25653`, which asserts `reduced` and `summary` are absent
  from every advertised schema, so no tool tells the model to send them.
- Findings: the single non-test occurrence of the key in the plugin source is
  inside the unwrapper itself, so I could not find a producer of the envelope in
  either codebase. That is consistent with the comment's framing: the envelope is
  something the MODEL emits by imitating a reduced call it saw rendered in its
  own context, not something either side of the wire constructs. I did not find
  the render site that puts a reduced call envelope into context; searching
  `transform.rs` for `reduced` alongside `summary` returned only a comment at
  `:24991` about summaries versus reduced raw bytes, which is a different
  concept.
- Missing evidence: the call sites of `unwrapImitatedReducedArgs` relative to the
  module send path, and the render site that produces the envelope shape the
  model imitates. Establishing the first would settle reachability; the second
  would settle whether the shape is even producible today.
- Conclusion: unresolved, needs a trace of `unwrapImitatedReducedArgs` call sites
  against the module send path in `packages/plugin/src/hooks/magic-context`. Until
  then the record stays `always-or-unreached` with a `sometimes`-style coverage
  requirement on the branch, and the confidence stays medium.
