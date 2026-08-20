# Synapse Model Bundle Operations

Status: normative for the bundle format served by `crates/mc-host/src/synapse`
Task: `magic-context-c50.6`; installed packaging and CLI discovery: `magic-context-c50.8`

## 1. What a bundle is

A Synapse bundle is one immutable, owner-provisioned directory that fully
determines an embedding space. The host loads it from trusted startup
configuration only — no request field, route identity, or environment value
can ever select a bundle path or model file. The directory contains exactly:

| File | Purpose |
| --- | --- |
| `manifest.json` | The strict schema-1 manifest below; the only unhashed file |
| model ONNX file | Named and SHA-256-pinned by `model_file` |
| external initializer files | Each named and pinned by `external_initializers[]` |
| `tokenizer.json`, `config.json`, `special_tokens_map.json`, `tokenizer_config.json` | All four HuggingFace tokenizer artifacts, each pinned |
| corpus file | Semantics-certification inputs and expected vectors, pinned |

Any other entry in the directory — including symlinks, subdirectories, and
non-regular files — disables the lane before model construction. Every
artifact byte is read once, size-bounded, and verified against its manifest
hash before FastEmbed sees it.

## 2. Manifest schema (version 1)

```json
{
  "schema_version": 1,
  "model": "tiny-test-model",
  "fingerprint": "<64 lowercase hex>",
  "table_epoch": 1,
  "dims": 8,
  "pooling": "mean",
  "quantization": "none",
  "output": {"name": "last_hidden_state"},
  "max_tokens": 8,
  "provenance": {"source": "…", "production": false},
  "recommended_batch": {"rows": 16, "token_budget": 8192},
  "model_file": {"name": "model.onnx", "sha256": "…"},
  "external_initializers": [{"name": "embedding.bin", "sha256": "…"}],
  "tokenizer": {
    "tokenizer": {"name": "tokenizer.json", "sha256": "…"},
    "config": {"name": "config.json", "sha256": "…"},
    "special_tokens_map": {"name": "special_tokens_map.json", "sha256": "…"},
    "tokenizer_config": {"name": "tokenizer_config.json", "sha256": "…"}
  },
  "corpus": {"name": "corpus.json", "sha256": "…"}
}
```

Validation rules (`crates/mc-host/src/synapse/bundle.rs` is authoritative):

- Strict JSON: duplicate keys and unknown fields are rejected.
- `pooling` is `mean` or `cls`; `quantization` is `none`, `static`, or
  `dynamic` — exactly the modes FastEmbed's user-defined path supports.
- `output` is exactly one of `{"name": …}` (allowlisted: `text_embeds`,
  `last_hidden_state`, `sentence_embedding`, `token_embeddings`),
  `{"index": 0..=7}`, or `{"only_one": true}`.
- Artifact names are bare file names: path separators, `.`, `..`, NUL, and
  the reserved name `manifest.json` are refused, so a manifest can never
  escape its directory.
- Hashes are 64 lowercase hex and may not be placeholders (a repeated
  single character, e.g. all zeros, is refused).
- `max_tokens` must equal the tokenizer_config's `model_max_length`, so the
  truncation boundary has one owner, and `tokenizer_config` must declare a
  string `pad_token`.
- The corpus must parse, match `dims`, and carry a finite tolerance in
  `(0, 0.1]`.

`fingerprint` covers the complete embedding-space contract: artifact
identity, dimensions, pooling, quantization, output selection, truncation
length, and FastEmbed's fixed L2 post-processing. Changing any of those is a
new fingerprint, and changing the destination-table layout is a new
`table_epoch`; the TypeScript ledger and destination guards treat both as a
different, incompatible lane.

The host does not take `fingerprint` on trust: it recomputes the canonical
value from the manifest and rejects a bundle whose declared fingerprint
disagrees, naming the expected digest in the disable reason. Otherwise an
owner who edited the embedding space but left the fingerprint alone would
serve a different space under the old lane identity, and clients — whose only
substitution guard is `required_fingerprint` — would mix vector spaces inside
one destination table.

The canonical value is `sha256` over the UTF-8 bytes of a newline-joined
`key=value` serialization, starting with a format tag and listing exactly the
fields that determine a served vector:

```text
mc-synapse-fingerprint-v1
model_file=<sha256>
external_initializer=<sha256>     # repeated, in manifest order, may be absent
tokenizer=<sha256>
config=<sha256>
special_tokens_map=<sha256>
tokenizer_config=<sha256>
pooling=<mean|cls>
quantization=<none|…>
output=<name:NAME | index:N | only_one>
max_tokens=<int>
dims=<int>
table_epoch=<int>
corpus=<sha256>
```

There is no trailing newline. Fields that cannot change a served vector —
`model`, `provenance`, `recommended_batch` — are excluded, so tuning them
never forces a new lane identity. `canonical_fingerprint` in
`crates/mc-host/src/synapse/bundle.rs` is the source of truth;
`generate-synapse-tiny.py` mirrors it, and packaging tools must recompute the
digest whenever any listed field changes.

## 3. Native runtime identity

The host loads ONNX Runtime dynamically and commits it process-globally
exactly once. Startup configuration supplies the library path plus the
SHA-256 of its bytes; a missing file, wrong hash, placeholder hash, or an
environment that something else already initialized disables the lane. The
resolved crate graph is pinned to `fastembed 6.0.0` and `ort 2.0.0-rc.13`
with defaults disabled: the only ORT-related features are `std`, `ndarray`,
`api-17`..`api-24`, `load-dynamic`, `preload-dylibs`, and
`ort-sys/disable-linking`. No download, copy, TLS/fetch, Hugging Face,
image-model, or accelerator feature is reachable; verify with
`cargo tree -p mc-host -e features`.

`magic-context-c50.8` owns installing the production bundle and shared
library and must record the exact certified native identity: ONNX Runtime
version, target triple, CPU-only build provenance, and the SHA-256 the host
configuration pins. A nominally matching library with a different hash is
refused by design.

## 4. Startup, readiness, and degraded mode

Initialization order: hash and confine every bundle artifact, verify and
commit the ORT identity, construct the FastEmbed user-defined model (one
intra-op thread, CPU execution provider only), run a structural probe
(dimension count, finite components, unit L2 norm), then certify semantics
against the corpus.
The corpus is chosen to be sensitive to output selection, pooling, and the
truncation boundary, so a structurally healthy but semantically wrong model
never reports ready.

Every expected artifact fault — absent configuration, invalid bundle,
incompatible or pre-initialized ORT, failed probe or certification — leaves
the catalog identity published and the component disabled: its
`route.open` bind rejects with `artifact_invalid`, internal health reports
degraded, and Magic Context stays fully available. A post-startup backend
invariant failure (non-finite vector, wrong dimensions, broken norm) marks
the lane failing and refuses new work without serving the suspect vector.

## 5. The committed test bundle

`crates/mc-host/tests/fixtures/synapse-tiny/` is a deliberately tiny,
non-production bundle: an embedding-table-lookup ONNX graph with an external
initializer, a second dimension-compatible decoy output, a WordLevel
tokenizer, and a corpus that distinguishes output selection, pooling, and
truncation. `crates/mc-host/tests/fixtures/generate-synapse-tiny.py`
regenerates every artifact, hash, fingerprint, and expected vector
deterministically. The toy bundle proves loading, confinement, dynamic ORT,
and cross-language mechanics hermetically; it cannot certify the production
model or the production native runtime — the release smoke must run against
the exact owner-provisioned bundle with network access disabled.

Tests that need native inference locate the runtime through the
`MC_SYNAPSE_TEST_ORT_LIBRARY` environment variable and skip loudly when it
is unset; every pre-ORT rejection path runs hermetically without it.

## 6. Upgrade rules

- Replacing model bytes, tokenizer files, pooling, output selection,
  truncation, or quantization requires a new `fingerprint`, which the host
  recomputes and enforces (§2).
- A destination-table layout change requires a new `table_epoch`.
- Bundles are immutable in place: ship a new directory and point trusted
  configuration at it. The host never watches, reloads, or mutates a bundle.
- The lane serves exactly one model; there is no registry, no download path,
  and no per-request model selection.
