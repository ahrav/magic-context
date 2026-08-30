# tokenizer-cross-process-determinism

## Discovery trigger

`crates/mc-tokenizer/src/lib.rs:13-19` names determinism as the crate's
load-bearing property: "DETERMINISM is the load-bearing property (the module's
cache-stability core only ever calls this on a HARD m0 rematerialization, and a
resume must produce byte-identical m0)." The word "resume" is the tell: a resume
is a *new process*. The test that carries the determinism name,
`deterministic_across_calls` (`crates/mc-tokenizer/tests/token_golden.rs:64-73`),
loops 1000 times inside one process. Those are different claims, and the gap
between them is what this record covers.

## Evidence trail

The crate's determinism inputs, each checked:

- `crates/mc-tokenizer/src/lib.rs:37` — the vocab is embedded with
  `include_str!("../assets/claude.tiktoken")`, so there is no runtime file read
  and no network fetch. The doc at `:34-36` states this is deliberate because
  "both would break the determinism guarantee on resume".
- `crates/mc-tokenizer/src/lib.rs:43-44` — `CLAUDE_PAT_STR` is a `const &str`,
  fixed at compile time.
- `crates/mc-tokenizer/src/lib.rs:46-68` — `tokenizer()` builds a `CoreBPE`
  once through a `static TOKENIZER: OnceLock<CoreBPE>` at `:47`.
- `crates/mc-tokenizer/src/lib.rs:73-78` — `estimate_tokens` short-circuits the
  empty string to 0 at `:74-75`, otherwise returns `count_ordinary(text)`.
- No `use std::time`, no clock read, no RNG, no environment-variable read
  anywhere in the crate's 85 lines.

The encoder-build reproducibility question, which the in-process test cannot
reach. The loop at `:50-62` inserts into an `FxHashMap<Vec<u8>, Rank>`. If the
vocab contained the same token bytes twice with different ranks, the insert at
`:61` would be last-line-wins and the encoder would depend on file line order.
I verified the asset directly:

- 64,995 non-empty lines.
- Every line has exactly two space-separated fields (the set of field counts is
  `{2}`), so the `parts.next()` calls at `:55-56` never encounter a third field.
  Note that a three-field line *would* be silently accepted with the third field
  ignored, since `:54-56` reads only the first two.
- Zero duplicate token-byte keys.
- Zero duplicate ranks. Ranks span 5 to 64,999, so the rank space is sparse
  rather than dense.

With no duplicate keys, the map build is order-insensitive and the encoder is
identical regardless of iteration order, so the `OnceLock` build is
reproducible. That is a real result, not an assumption, and it is the reason the
in-process test's blindness to the build is currently harmless rather than
currently broken.

The dependency-pinning question:

- `crates/mc-tokenizer/Cargo.toml` pins `tiktoken-rs = "=0.11.0"` exactly, with
  a comment explaining that "Determinism across resumes depends on the SAME
  tiktoken-rs + fancy-regex versions (Unicode-category behavior), so treat a bump
  as a renderer change (Cargo.lock is the pin)."
- `fancy-regex` is not listed in the manifest at all; it arrives transitively
  through `tiktoken-rs` and is pinned only by `Cargo.lock`.
- The pattern at `:43-44` uses `\p{L}` and `\p{N}`, whose membership depends on
  the regex crate's Unicode tables. A `fancy-regex` bump within its semver range
  can move those tables for newly assigned code points, changing
  pre-tokenization and therefore the token IDs.

So the manifest pins the engine and the lockfile pins the regex layer. That is a
defensible arrangement, and the Cargo.toml comment describes it accurately. The
lib.rs doc at `:16-17` overstates slightly by naming both as "version-pinned".

The five `expect` calls at `:55`, `:56`, `:59`, `:60`, and `:66` panic on first
use if the embedded asset is malformed. Because the asset is embedded at compile
time, these are build-integrity guards reachable only by editing the asset, not
runtime hazards.

## Failure scenario

A `cargo update` moves `fancy-regex` within its semver range and the new
version's Unicode tables classify some code point differently under `\p{L}` or
`\p{N}`. Pre-tokenization splits that text differently, so the byte-BPE runs over
different pieces and produces different token IDs and a different count.

The count feeds budget fitting. `crates/mc-module/src/tail_hygiene.rs:85` calls
`mc_tokenizer::estimate_tokens(content)`, and the m0 composer uses it repeatedly
(`crates/mc-module/src/m0_compose.rs:191`, `:202`, `:204`, `:221`, `:223`,
`:245`, `:257`) to decide what fits. A different count changes a fit decision,
which changes which claims or compartments are included, which changes the
rendered m0 bytes.

Changed m0 bytes on resume is exactly the failure the cache-stability core exists
to prevent. `crates/mc-tokenizer/src/lib.rs:14-15` says the module "only ever
calls this on a HARD m0 rematerialization, and a resume must produce
byte-identical m0". A non-byte-identical m0 busts the cached provider-visible
prefix, so the session pays a full re-render and loses the cache benefit, and any
consumer relying on prefix stability sees a discontinuity.

The failure is silent and gradual: the suite stays green unless the changed
classification happens to touch one of the golden corpus's 36 strings.

## Timing windows and dependencies

The window is process cold start. The `OnceLock` at
`crates/mc-tokenizer/src/lib.rs:47` builds the encoder on first call and never
again, so any build-order sensitivity is observable only on that first call.
`deterministic_across_calls` (`token_golden.rs:64-73`) calls `estimate_tokens`
once at `:69` to establish `first` and then 1000 times in the loop at `:70-72`,
all after the `OnceLock` is warm. It therefore proves the memoised path is pure
and cannot observe the build at all.

There is no thread-safety concern to construct: `OnceLock::get_or_init` is
documented to run the initialiser at most once even under concurrent access, and
`CoreBPE` is used immutably afterwards.

Dependency: this record is about the *implementation's* self-consistency.
Agreement with the TypeScript oracle is a different property, covered by
`tokenizer-golden-oracle-provenance`, and the crate doc at `:16-19` is explicit
that faithfulness is a goal validated by the golden while determinism is the
runtime invariant.

## What a test must construct

1. A cross-process check: record the encoding of a corpus in one process, spawn
   a second process, re-encode, and compare. The cheapest form is a test binary
   that writes IDs to stdout plus a harness that runs it twice and diffs, or a
   `std::process::Command` re-invocation of the test binary with an env marker.
   Semantics: `always`, since byte-identity must hold on every resume.
2. A first-call check inside a fresh process: assert the very first
   `estimate_tokens` result for a given text equals the value recorded from a
   prior process, so the cold path is compared and not just the warm one. Pair it
   with a `sometimes` marker that the corpus exercised a cold first call, which
   is a situation rather than a location.
3. A vocab-integrity check that is currently implicit: assert the parsed vocab
   has no duplicate token-byte keys and that every line has exactly two fields,
   so the order-insensitivity of the build at `:61` is asserted rather than
   incidentally true. This turns a measured fact into a maintained one.
4. A second-architecture run, ideally aarch64 alongside x86-64, since
   `.github/workflows/ci.yml` runs the Rust jobs on `ubuntu-latest` and the only
   `matrix.os` job in the file is the shared-memory source build. Without a second
   target, cross-platform determinism is asserted by argument rather than by
   observation.
5. A lockfile-drift guard: a check that fails when the resolved `fancy-regex`
   version changes, so a bump is a deliberate act with a regenerated golden
   rather than a silent one. The Cargo.toml comment already says a bump should be
   treated as a renderer change; this makes it enforceable.

## Investigation log

### Q: Does `fancy-regex` or `tiktoken-rs` carry target-dependent behaviour?

- Sources examined: `crates/mc-tokenizer/src/lib.rs:26-31` (the imports:
  `std::sync::OnceLock`, `base64`, `rustc_hash::FxHashMap`,
  `tiktoken_rs::{CoreBPE, Rank}`), `:43-44` (the pattern), the Cargo.toml
  comments about `rustc-hash` major-version matching and Unicode-category
  behaviour, and the crate's own code, which contains no `cfg(target_*)` and no
  floating-point arithmetic.
- Findings: nothing in `mc-tokenizer` itself is target-dependent. Token counts
  are `usize` and IDs are `u32`, so there is no floating-point rounding to
  differ. `FxHashMap` iteration order can differ between runs in principle, but I
  established above that the vocab has no duplicate keys, so iteration order
  cannot affect the built encoder. The remaining risk is inside `fancy-regex` and
  `tiktoken-rs`, which I did not read.
- Missing evidence: an actual run on a second architecture, and a read of the
  dependency internals.
- Conclusion: unresolved, needs a second-architecture run. The argument for
  portability is strong (integer-only, no `cfg`, no order dependence) but an
  argument is not an observation, and the crate doc makes determinism the
  load-bearing claim, which deserves an observation.

### Q: Does the empty-string short-circuit hide a divergence?

- Sources examined: `crates/mc-tokenizer/src/lib.rs:70-78` (the doc says "Empty
  text is 0 (matching the TS falsy-guard)" and the code returns 0 at `:75`),
  `crates/mc-tokenizer/tests/token_golden.rs:59-62` (`empty_text_is_zero`), and
  the golden corpus, whose first case is `label: "empty"`, `text: ""`,
  `ids: []`.
- Findings: the short-circuit exists to match a TypeScript falsy guard, so it is
  deliberate rather than an optimisation. The corpus's `empty` case goes through
  `encode_ordinary` (`token_golden.rs:32`), which does *not* short-circuit, and
  asserts the IDs are empty. So the underlying engine's empty-input behaviour is
  in fact covered by the ID test even though the count test at `:47-57` would
  pass on the short-circuit alone.
- Missing evidence: none.
- Conclusion: resolved with answer. The apparent masking is closed by the
  `encode_ordinary` path in the same fixture. Recording it because the two
  functions have different empty-input handling
  (`estimate_tokens` short-circuits at `:74`, `encode_ordinary` at `:83-85` does
  not) and a future change to one and not the other would be easy to miss.
