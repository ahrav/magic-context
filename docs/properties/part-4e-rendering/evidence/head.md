# Part 4e property catalog: rendered output, tags, and nudge overlay

Scope: sub-part 4e of `crates/mc-module`, 9,304 production lines across seven
units. `src/transform.rs:7511-12623` (5,113 lines) carries the byte-producing
splice `build_output_with_tags_inner` (`:11678-12156`), the overlay application
site (`:8208-8269`), the tag caches (`:7597-7727`) and the nudge decisions
(`:9142-9627`). The other six are `src/tail_hygiene.rs` (1,278),
`src/decay_render.rs` (849), `src/caveman.rs` (651), `src/memory_render.rs`
(538), `src/classify.rs` (490) and `src/prompt_surface.rs` (385). All seven line
counts were re-derived at `HEAD` and sum to 9,304, matching
[../part-4-module/_lenses/scope-map-and-risk-ranking.md](../part-4-module/_lenses/scope-map-and-risk-ranking.md)
at `:587-595`.

Three neighbours are cited rather than catalogued, and the reason is recorded
because the task framing named them as in-scope files. `src/injection.rs` (911)
belongs to sub-part 4b (`scope-map-and-risk-ranking.md:526`), which counts its 18
tests as its own; 4e owns where the synthetic todo pair is *placed in the served
array* (`transform.rs:11804-11833`, `:12091-12121`), not how the pair is built,
and lens B cites the file throughout on that basis. `src/ck_wire.rs` (1,279)
belongs to 4f (`:619`) and is cited only at `:440-451`, where the arc-id
assignment is what makes one 4e `HashMap` iteration order-independent. The
`lib.rs` overlay regions are split between 4a, 4c and 4d by the same map; the
only `lib.rs` sites cited below are the four consumers of `prompt_surface.rs`
exports at `:7594-7601` and `:7688-7720`, which are 4d code reading a 4e
contract. Two further neighbours are load-bearing and cited, not paraphrased: the
three overlay tables and the transform commit transaction in
`crates/mc-store/src/lib.rs` (Part 3's territory) and the two harness encoders
in `crates/mc-module/src/codec/`.

Provenance in [../README.md](../README.md). System
`/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927` ("refactor(shm):
trim final review leftovers"). Method contract in [../METHOD.md](../METHOD.md).

### CI line-reference drift

Per METHOD.md rule 1 both numberings are recorded, because the workflow file
moved between the commits the lenses read. The one `mc-module` test invocation,
`cargo test -p mc-module --test lifecycle_cli`, is **`ci.yml:168` at
`76cd6f41`** and **`ci.yml:172` at `HEAD`**; both were read directly, the first
through `git show 76cd6f41:.github/workflows/ci.yml`. The build-only step above
it, `cargo build -p mc-module --bin ck-mc-host`, is `:165` at `76cd6f41` and
`:169` at `HEAD`. Inherited text may cite either. Lens A cites the build step as
`ci.yml:164-165`, which is the `run: |` block at `76cd6f41`; lens C cites `:169`,
which is the same line at `HEAD`. All of these name the same two steps. The
TypeScript sweep, `bun run test`, is `ci.yml:257` at `HEAD`, and the pi-plugin
suite runs again directly at `:317`.

Rust source references do not drift across these commits. All three lenses read
at `HEAD`, and every `transform.rs`, `tail_hygiene.rs`, `prompt_surface.rs`,
`memory_render.rs`, `injection.rs`, `mc-store`, `codec/` and `packages/` line
reference used in this catalog's own prose was read back individually at
`e447c927` during synthesis.

### Reachability provenance

Both record-proposing lenses labelled 11 of their 12 records
`default-production`, so 22 of 24 carry that label and 2 carry
`explicit-config-only`. Per METHOD.md rule 4 no preamble below repeats the claim;
each record carries its own label and its own derivation.

The `default-production` derivation is a single dispatch fact plus a default.
`build_output_with_tags_inner` is the only byte-producing splice, it carries no
`#[cfg]`, and every accepted transform pass traverses it, so the composition,
determinism, drop and index records need nothing beyond a request. The overlay
records need `tagging_active`, which requires a `serializer_profile` in
`{opencode-aisdk, claude-code-anthropic}` plus `tool_present`
(`lib.rs:568-577`) and the persisted-or-bootstrap condition at
`transform.rs:3503-3504`; the shipped host sends `opencode-aisdk`
(`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:1339`). The
auto-search records need `auto_search_active`, which is
`!req.is_subagent && req.auto_search_enabled` (`transform.rs:3519`) and defaults
to `true` on the wire (`default_auto_search_enabled`, `:865-867`), in the shipped
producer (`rust-mode-transform.ts:2010`) and in the schema
(`assets/magic-context.schema.json:1607-1612`, `CONFIGURATION.md:682`).

The two `explicit-config-only` labels rest on a configuration that the shipped
producer does not emit, and they are not equally solid.
`render-a-light-surface-fallback-notice-never-served` needs
`PromptSurfacePreset::Light`, which is not the serde default (`Full` is,
`prompt_surface.rs:74-76`), so the label is a straightforward statement about a
config key. `nudge-b-channel2-retirement-is-caller-asserted` needs
`serializer_profile == "claude-code-anthropic"`, and no TypeScript sender in this
repository emits that string; `ARCHITECTURE.md:125` describes a Claude Code leg
as a real deployment, so the arm is presumably reached from a proxy outside this
tree. If that leg is not live the label is closer to `test-only`. Lens B recorded
that as an open question needing deployment knowledge, and it is not resolved
here.
