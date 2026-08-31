# Source inventory

Canonical repository: <https://github.com/ahrav/gossip-rs>

Pinned commit: `3d2869011138cd7812a12f893dc93635a961b0d7`

Watched default branch: `main`. `scripts/check-secret-scanner-upstream-drift.sh`
fetches the canonical repository and compares every source below without writing
to this repository.

Copyright: Copyright (c) 2026 ahrav

License: MIT. The complete notice is in `NOTICE`.

| Source path | Git blob ID | Source SHA-256 | Destination | Adaptation |
| --- | --- | --- | --- | --- |
| `crates/scanner-engine/default_rules.yaml` | `909e835f6d19a923aefa84484cd7fa215ffad973` | `2f1292b50148d38afe3ebdb7c489449d103b75b7df464e06da0d5d7c89ac2820` | `crates/mc-secret-scanner/default_rules.yaml` | Byte-identical copy |
| `crates/scanner-engine/src/api.rs` | `c3820efb996f457f25dd659146ac57b0e01fd22e` | `164178b41d56fd2966409f411217b77688c44f6003228c088efc95a7ebcdf5a3` | `crates/mc-secret-scanner/src/api.rs`, `src/rules.rs` | Rewritten types and typed validation |
| `crates/scanner-engine/src/rules/yaml.rs` | `a9b74233ed859f4c45c2f8cd994899e7f5861bba` | `70d20faec76c2dfbabc2d9bc3d33de4cb424dd3fc74f8c848996f93633bfe9f5` | `crates/mc-secret-scanner/src/rules.rs` | Rewritten embedded-only parser |
| `crates/scanner-engine/src/engine/helpers/entropy.rs` | `0fbeb6abf0df39d8c48e74a477694e404f81ffe5` | `79891d22c8151c6478a13a1defb607eb64d9cd213e0e076d50d7bc4dda5ed207` | `crates/mc-secret-scanner/src/evaluator.rs` | Safe direct-text rewrite |
| `crates/scanner-engine/src/engine/offline_validate.rs` | `24e38df8e365519afc4e0ea142793dc6c8635e10` | `e4e0a1952458531b4415a81da69c27e0bcb5bebfb33959bcd46742f0bd43a174` | `crates/mc-secret-scanner/src/evaluator.rs` | Rewritten offline validators |
| `crates/scanner-engine/src/engine/safelist.rs` | `eeaa4e713c57d56ffff351ed3cefae2d4c27a23d` | `a5c05922ae70dad988e8fcd7b8ecabb9e88d83e74c48b6af0b2d39f3afa67a47` | `crates/mc-secret-scanner/src/evaluator.rs` | Reduced direct-value suppressor rewrite |
| `crates/scanner-engine/src/engine/window_validate.rs` | `0b8b88e0daab93cc07044b85c4f1c7d105e7d7f3` | `a362a1c1c3addbd937e0591032dd655c69559bd1eaff66e1fa1c861f1e715299` | `crates/mc-secret-scanner/src/evaluator.rs` | Rewritten direct candidate evaluation and confidence flow |
| `LICENSE` | `00b501fa03e6a1b190c0a4a2f2ef66fd57431a3c` | `96afec54cd8f9e6497c91826a6f9576e7ae92c3c3dd68c4c0b170d9b996e2e2d` | `crates/mc-secret-scanner/NOTICE` | Verbatim license terms with attribution |

Local overlay: `crates/mc-secret-scanner/conservative_overlay.yaml`.

Overlay SHA-256: `bf5179b1a30ec1e87f7c6533785fca8b86f42805820ba1052b34ab221b43bcc6`

The overlay is original Magic Context compatibility policy and is not copied from
Gossip-rs. Its vendor rules reuse the lengths, alphabets, entropy floors, and
offline validators of the corpus rule for the same credential, so a credential
matched by both rule sets resolves to one verdict. Two bounded departures from
that parity are deliberate:

- Where a corpus rule terminates on an explicit delimiter class, the overlay
  terminates on `\b`. The two accept the same candidates except one followed
  immediately by `-`, which the corpus rejects and the overlay accepts.
- The format and keyed-value rules (`magic-jwt`, `magic-bearer-token`,
  `magic-keyed-*`) are local policy for text the corpus does not cover, so they
  are broader by construction and carry their own `value_suppressors_any`.

Anchor matching is case-insensitive, and the pinned corpus already depends on
this: `aiza`, `t3blbkfj`, and `zxlk` are the only anchors recorded for regexes
that match `AIza`, `T3BlbkFJ`, and `ZXlK`, so `gcp-api-key`, `openai-api-key`,
and `jwt-base64` cannot fire under a case-sensitive prefilter. Overlay anchors
therefore record one form per literal; enumerating case variants would not be a
substitute, because a mixed-case key such as `Api_Key` has more variants than a
list can hold.

The overlay's `key_group`, `value_group`, and `reject_scalars` fields are a local
schema extension read by the rewritten parser this inventory maps to
`crates/mc-secret-scanner/src/rules.rs`. The corpus header comment describes the
upstream field set only, and it warns that unknown fields are ignored silently,
so a parser that drops these three degrades the keyed-value rules to matching on
the whole `"key": "value"` span instead of the value.
