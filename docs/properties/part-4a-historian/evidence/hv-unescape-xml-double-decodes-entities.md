# hv-unescape-xml-double-decodes-entities

## Discovery trigger

While enumerating the gate's only text transform for the control-character
record, the replacement ORDER in `unescape_xml` stood out. Decoding `&amp;`
before the other four entities is the classic double-decode ordering. Checking
the counterpart escape function confirmed the pair is asymmetric: the escape side
is correct, the unescape side is not.

## Evidence trail

`crates/mc-module/src/historian_validate.rs:1148-1154`:

```rust
fn unescape_xml(s: &str) -> String {
    s.replace("&amp;", "&")     // <- runs FIRST
        .replace("&apos;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")   // <- can now see an `&lt;` that was `&amp;lt;`
        .replace("&gt;", ">")
}
```

Trace the literal five-character prose sequence `&lt;`:

1. The model wants the body to read `use &lt; for less-than`. A correct producer
   escapes the ampersand, emitting `use &amp;lt; for less-than`.
2. `replace("&amp;", "&")` yields `use &lt; for less-than`.
3. `replace("&lt;", "<")` yields `use < for less-than`.

The output is `<`, not `&lt;`. One decode pass has consumed two levels.

The counterpart escapes are correct. Two independent implementations both escape
`&` first:

- `decay_render.rs:80-84`:
  `s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")`
- `historian_prompt.rs:104-108`: identical body.
- `historian_prompt.rs:96-102` (`escape_xml_attr`) also escapes `&` first, then
  `"`, `'`, `<`, `>`.

So `escape_xml_content` is a correct injective encoder, and `unescape_xml` is not
its inverse. Concretely,
`unescape_xml(escape_xml_content("a&lt;b")) == "a<b" != "a&lt;b"`.

The same holds for the other four entities: `&amp;amp;` decodes to `&`,
`&amp;gt;` to `>`, `&amp;quot;` to `"`, `&amp;apos;` to `'`.

Existing test coverage checks only the forward direction.
`historian_prompt.rs:427-432`:

```rust
assert_eq!(escape_xml_attr("&\"'<>"), "&amp;&quot;&apos;&lt;&gt;");
assert_eq!(escape_xml_content("&<>\"'"), "&amp;&lt;&gt;\"'");
```

No round-trip assertion exists anywhere. Grepped the 19 tests in
`historian_validate.rs:1305-1868` for entity strings; none appears.

Nothing downstream repairs it, and nothing downstream is endangered by it:
`decay_render.rs:235` and `:245` re-escape the body on render, so the corrupted
`<` becomes `&lt;` again in the m0 bytes. The damage is that the STORED text now
says `<` where the model said `&lt;`, and the rendered text says `&lt;` where the
model meant to display `&lt;` and now displays `<`-as-escaped. The user-visible
result is a wrong character, not broken markup.

## Failure scenario

A session about XML or HTML templating. The historian summarises:

```
<compartment start="1" end="30" title="Escaping rules" ...><p1>Template output must use &amp;lt; and &amp;gt; for angle brackets.</p1></compartment>
```

Gate: `extract_tier` (`:1112-1134`) returns
`unescape_xml(body.trim())`, which yields
`Template output must use < and > for angle brackets.` The compartment publishes
with that text.

Every check passes; nothing in the gate is looking at text content beyond
blankness.

Stored row: the sentence now instructs the reader to use `<` and `>` for angle
brackets, which is vacuous. The precise technical content the model captured is
destroyed. On render, `escape_xml_content` turns it into
`Template output must use &lt; and &gt; for angle brackets.`, which is the
ORIGINAL text again by coincidence of double-escaping, but the stored row is
wrong for any consumer that does not re-escape, and the coincidence does not hold
for `&amp;amp;` (stored as `&`, rendered as `&amp;`, meaning `&` where the model
said `&amp;`).

The realistic frequency is low but non-zero: it needs the model to discuss entity
syntax, which happens in any web or XML session. It is not adversarial-only.

## Timing windows and dependencies

None. Pure function defect, single evaluation.

The dependency worth naming is the golden oracle. `validate_golden_matches_typescript_oracle`
(`:1384-1414`) asserts Rust's parse output equals recorded TypeScript output for
16 cases. If TypeScript shares the ordering, correcting Rust changes those
verdicts and breaks the golden, so the fix is coupled to the upstream. Checked the
golden's cases: none contains an entity sequence, so today no recorded verdict
would change. That makes the fix locally safe even though the parity question is
open.

## What a test must construct

The property is a round-trip identity, so the test is a property test with a
trivial oracle and no fixtures:

```
for all s: unescape_xml(escape_xml_content(s)) == s
```

The shrinker will land on `"&"` or `"&lt;"` immediately. A minimal table version
covers the five entities plus their doubled forms: `&`, `<`, `>`, `"`, `'`,
`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&amp;lt;`, `&amp;amp;`.

Note two care points:

1. `unescape_xml` is private, so the test lives in the module's own test mod,
   which is where the 19 existing tests already are.
2. `escape_xml_content` exists in two places (`decay_render.rs:80`,
   `historian_prompt.rs:104`) with identical bodies. The round-trip test should
   name which one it pairs with, and the duplication itself is worth a note for a
   deduplication pass: two copies of an encoder whose single inverse is wrong.

A second, integration-level test asserts the observable consequence: publish a
compartment whose `p1` is `&amp;lt;`, then assert the stored `p1` is `&lt;` rather
than `<`.

## Investigation log

### Q: Does the TypeScript host parser have the same ordering, making this a faithful port rather than a divergence?

- Sources examined: `historian_validate.rs:261-263` (the doc comment stating the
  module uses "the TypeScript host parser's permissive extraction semantics for
  structures inside that root"), `:1384-1414` (the golden test and its carve-out),
  `testdata/validate-golden.json` (all 16 cases, inspected for entity sequences),
  `historian_validate.rs:816-820` (an explicit note where Rust deliberately
  diverges from TypeScript because Rust's regex engine lacks backreferences).
- Findings: The module documents its TypeScript alignment as a goal and documents
  at least one deliberate divergence, so divergences are recorded when known. No
  comment mentions entity-decode ordering, which suggests it was ported without
  scrutiny rather than matched deliberately. No golden case contains an entity
  sequence, so the golden neither confirms nor constrains the ordering.
- Missing evidence: the TypeScript parser source. It is not under any path this
  pass read; the scope map's file inventory for `mc-module` does not include it,
  and it lives in the plugin packages.
- Conclusion: unresolved, needs the TypeScript parser source. The practical
  consequence is favourable either way: because no golden case exercises an
  entity, a Rust-side fix changes no recorded verdict and can land before the
  parity question is settled.

### Q: Is the corruption observable anywhere, or fully silent?

- Sources examined: `historian.rs:38-67` (`to_stored_compartment`),
  `decay_render.rs:80-84`, `:235`, `:245`, `historian_prompt.rs:239-263`.
- Findings: The projection clones verbatim; the renderer re-escapes; the prompt
  feedback re-escapes. No layer compares stored text to producer text, and the
  producer text is not retained for comparison (only the RAW chunk is retained, at
  `historian.rs:1727`, which is the input, not the model's output).
- Missing evidence: none needed.
- Conclusion: resolved with answer — fully silent. Because the model's raw output
  text is not stored alongside the parsed compartments, there is no artifact
  against which the corruption could later be detected.
