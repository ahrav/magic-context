### Check-semantics audit, and a finding on the two `unreachable` records

Semantics distribution across the 24 records: `always` 18, `always(!X)` 1
(written `always(!orphan)`), `always-or-unreached` 1, `sometimes` 2,
`unreachable` 2. No `reachable` and no liveness record. Lens A produced both
`unreachable` records, and METHOD.md reserves that form for a code location that
must not execute, requiring `always(!X)` for a forbidden **state** with no
dedicated detection point. Each was checked against the source, and the two do
not come out the same way. Per METHOD.md rules 3 and 6 the records are reproduced
verbatim below and the finding is reported here rather than applied.

**`render-a-user-hint-total-cap-cannot-bind` is a genuine forbidden code point.**
Its `Check:` line instruments the `utf16_len(wrapped) > limit` branch of
`truncate_hint_to_total_cap`. The function guards at `transform.rs:9120-9122`
with `if utf16_len(wrapped) <= limit { return wrapped.to_string(); }`, so the
truncating body at `:9123-9127` is reached only by falling through that guard,
and it is a distinct location that the arithmetic says cannot execute. Lens A's
cited range `:9120-9127` spans the guard plus the body, which is accurate. The
`unreachable` semantics stand as written.

**`render-a-light-surface-fallback-notice-never-served` names two targets that
are not code points, so on a strict reading of METHOD.md the semantics should be
`always(!X)`.** Both targets are value-producing expressions, not branches.
`prompt_surface.rs:141` is the field initializer `fallback: light.is_none()`
inside the `PromptSurfacePreset::Light` arm, and that arm **does** execute
whenever the Light preset is configured; what can never happen is the value
`true`. `tool_manifest_falls_back` (`:156-158`) likewise executes its predicate
`preset == PromptSurfacePreset::Light && TOOL_LIGHT_DESCRIPTIONS.is_none()`
(`:157`) on every manifest request and returns `false`. Both are therefore
forbidden states of a returned value, which is exactly the case METHOD.md says
takes `always(!X)`.

The record is not wrong about the underlying fact, and genuine forbidden code
points do exist one layer up, which is why this is a semantics correction rather
than an invalidation. The consumers contain real branches that must not execute:
the `"full"` arm of `if prompt_surface::tool_manifest_falls_back(selection.preset)`
at `lib.rs:7594-7596` and the `"full"` arm of `if asset.fallback` at
`:7712-7714`. Retargeting the `Check:` at those two arms would make
`unreachable` correct as written. The `.then_some(LIGHT_FALLBACK_NOTICE)` calls at
`:7600-7601` and `:7718` would not, because `bool::then_some` is a method call
whose argument is evaluated eagerly and is not a branch in source. Either
retargeting the check or restating it as `always(!fallback)` resolves this; it
needs the lens author or a reviewer, and no change was made here.
