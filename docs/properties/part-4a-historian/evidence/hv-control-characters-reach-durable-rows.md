# hv-control-characters-reach-durable-rows

## Discovery trigger

Task item 4 asks about output that injects control characters or markup. The
instruction to confirm by reading code rather than inferring absence mattered
here: the gate has no sanitation, but a compensating control DOES exist
downstream, and it is asymmetric in a way that only shows up by reading the
renderer.

## Evidence trail

### The gate performs no sanitation

The only text transform in `crates/mc-module/src/historian_validate.rs:1-1304` is
`unescape_xml` (`:1148-1154`):

```rust
fn unescape_xml(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&apos;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}
```

Five entity decodes. It strips nothing and rejects nothing. Its call sites are
`:298` (title), `:305` (episode_type), `:333` (flat content), `:370`, `:389`,
`:408`, `:423` (side channels), `:842` (event fields), `:1133` (tier bodies). So
every model-authored string passes through exactly this and nothing else.

Searched for any character-class guard in the module and found none:

```
rg -n "sanitiz|is_control|\\\\u\\{2028\\}|escape" crates/mc-module/src/historian_validate.rs
# only the unescape_xml lines above
```

`validate_parsed_compartments` (`:983-1084`) reads `p1` for blankness only.

### The compensating control exists at render, and is asymmetric

`decay_render.rs:104-121`, for TITLES:

```rust
fn sanitize_compartment_title(title: &str) -> String {
    // Historian-authored titles are untrusted: controls and Unicode line/paragraph
    // separators must collapse or they can forge a visually multiline heading.
    ...
        if ch.is_control() || matches!(ch, '\u{2028}' | '\u{2029}') {
    ...
    escape_xml_content(&single_line)
}
```

Called at `decay_render.rs:134` from `compartment_heading`. Note the comment
explicitly names historian-authored titles as untrusted, so the trust boundary IS
recognised in this codebase, just located at the renderer.

For BODIES, `decay_render.rs:235` and `:245`:

```rust
let body = guard_compartment_body(&escape_xml_content(&legacy_body_for_tier(flat, tier)));
...
guard_compartment_body(&escape_xml_content(&body))
```

`escape_xml_content` (`:80-84`) escapes `&`, `<`, `>` and nothing else.
`guard_compartment_body` (`:138-147`) does one thing:

```rust
let guarded = body.replace("\n## ", "\n ## ");
if guarded.starts_with("## ") { format!(" {guarded}") } else { guarded }
```

Only the markdown-heading sequence. No control-character handling for bodies.

So: titles are control-stripped and XML-escaped; bodies are XML-escaped and
heading-guarded but NOT control-stripped. That asymmetry is the finding, and the
gate stores unsanitized bytes for both.

### The prompt feedback loop IS escaped

Checked, because a stored `</output>` echoed into the next run's prompt would be
the sharpest consequence. `render_session_ref_compartment`
(`historian_prompt.rs:218-265`) escapes every field it renders: `escape_xml_attr`
on title (`:230`) and episode_type (`:224`), `escape_xml_content` on `p1`..`p4`
(`:239`, `:245`, `:249`, `:253`) and flat content (`:263`).
`escape_xml_content` there (`:104-108`) escapes `&` first, correctly. So a stored
`</output>` cannot break the next run's envelope. This narrows the impact and is
recorded so a later pass does not re-derive it.

## Failure scenario

The producer emits a compartment whose body contains a Unicode line separator and
an ANSI escape introducer:

```
<compartment start="1" end="9" title="Refactor" ...><p1>Done.\u{2028}## Injected heading\u{1b}[2J</p1></compartment>
```

Gate: `unescape_xml` leaves all three characters intact. `p1.trim()` is
non-empty, so `:1000-1008` passes. Every other check is about ordinals. The
compartment publishes.

Store: `to_stored_compartment` (`historian.rs:52-56`) clones the body verbatim
into `StoredCompartment.p1`. The durable row now holds U+2028 and an ESC byte.

Render into m0: `escape_xml_content` leaves both alone (neither is `&`, `<`, or
`>`). `guard_compartment_body` looks for `"\n## "`; the injected heading is
preceded by U+2028, not `\n`, so the guard does not match and the `## ` is not
indented. Whether that renders as a heading depends on the consumer's newline
handling, which is why this is a real hazard and not a proven exploit: U+2028 is
a line terminator in some contexts and not others.

The ESC byte reaches whatever surface prints m0. The gate is not the control that
prevents that; nothing in the historian path is.

## Timing windows and dependencies

None. Single-firing input admission.

The dependency chain that decides severity is entirely downstream and outside this
lens: which surfaces read `StoredCompartment.p1` and `.content`, and whether each
sanitises. `decay_render` is one such surface and is partly cataloged by Part 3
(per the scope map's overlap list). The record's claim is deliberately scoped to
what the gate stores, so it stays true regardless of how many renderers exist.

## What a test must construct

Gate-level unit test:

1. Chunk `1..=9`, dense, anchorable.
2. A compartment whose `p1` contains `'\u{2028}'`, `'\r'`, and `'\u{1b}'`, and
   whose `title` contains the same.
3. Assert the property: no character of any accepted `title`, `content`, or tier
   satisfies `char::is_control()` or is U+2028/U+2029, or the call returned `Err`.
   Today it returns `Ok` with all three characters present, which is the finding.

A second test pins the asymmetry so it cannot silently change: render the stored
row through `decay_render` and assert the title has no control characters
(passes today, `decay_render.rs:110`) while asserting the body's treatment
explicitly, whichever way the project decides it should be. Writing the body
assertion down is the point, because today it is unspecified.

Property-based form: generate bodies from a char corpus that includes the C0
range, C1 range, U+2028, U+2029, and the bidi override codepoints, and assert the
gate's disposition is uniform. Uniformity is the useful oracle, since the current
behaviour is "accept everything" and the desired behaviour is a single consistent
rule rather than a per-character allowlist.

## Investigation log

### Q: Should the gate be the sanitation point, or is renderer-side sanitation the deliberate design?

- Sources examined: `decay_render.rs:104-107` (the comment naming historian titles
  untrusted), `decay_render.rs:138-141` (the body guard's comment, which justifies
  itself only in terms of compartment-boundary ambiguity), `historian_validate.rs:1-9`
  (the module's four stated concerns, none of them content), `historian_prompt.rs:21`
  (`HISTORIAN_TRANSCRIPT_GUARD`, an injection defence at the prompt layer).
- Findings: The codebase clearly recognises the historian as untrusted and places
  three separate defences (title sanitation, body heading guard, prompt injection
  guard) at three different layers. None is at the gate. That pattern reads as
  deliberate defence-in-depth at the point of use rather than an oversight about
  where sanitation belongs. But the title/body asymmetry within a single function
  (`decay_render.rs`) is harder to read as deliberate: the same untrusted source
  feeds both, and only one gets control-stripping.
- Missing evidence: whether a design note anywhere states the sanitise-at-render
  policy. The scope map's resolved open question establishes there is no historian
  specification outside `historian*.rs`, so no such note exists to consult.
- Conclusion: needs human input on the policy. The asymmetry is worth flagging
  regardless of which layer owns sanitation, because it is inconsistent under
  either policy.

### Q: Can a stored control character or markup sequence corrupt a later historian run?

- Sources examined: `historian_prompt.rs:96-108` (both escape functions),
  `:218-265` (`render_session_ref_compartment` and every escape call site),
  `:267-278` (`render_session_references_block`), `:292-300`
  (`build_reference_blocks_from_stored`).
- Findings: Every compartment field rendered into the next run's prompt is
  escaped, with `&` escaped first in both functions, so the escaping is correct.
  A stored `</output>` or `<compartment>` is neutralised. Control characters are
  NOT stripped by these functions, so they do reach the prompt bytes, but they
  cannot alter the XML structure the next run's parser sees.
- Missing evidence: none needed.
- Conclusion: resolved with answer — markup cannot corrupt a later run; control
  characters propagate into prompt bytes without structural effect. Impact is
  therefore scoped to the stored rows and their non-`decay_render` readers.
