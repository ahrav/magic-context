# preserved-identity-name-does-not-exempt-its-value

## Discovery trigger

A review comment claimed that credential fields ending in `_key` bypass secret
scanning under the identity-preserving policies. Reading the branch to confirm it
surfaced a second, independent bypass in the same expression.

## Evidence trail

The preserving branch in `prepare_value` took a byte-length-only path:

```rust
if identity_json_field(key) && !integrity_json_field(key) && !policy.reject_protected() {
    ensure_durable_text_bound(key)?;
    validate_existing_value(value)?;
}
```

`validate_existing_value` checks length only; no scan runs.

### Bypass 1: credential-qualified names

- `identity_json_field` (`lib.rs:3948-3956`) accepts `key.ends_with("_key")`.
- `integrity_json_field` (`lib.rs:3958-3971`) matches only `password`, `secret`,
  `token`, `signature`, `integrity`, `signed`, `digest`, `hash`, `fingerprint`.

So `api_key`, `private_key`, `access_key`, and `auth_key` satisfy
`identity_json_field && !integrity_json_field` and were persisted unscanned.

### Bypass 2: nested values

An identity name exempted its whole subtree, so
`{"id":{"message":"password=nested-secret"}}` stored the nested secret verbatim.
`id` is an identity field, `message` never got a policy of its own.

## Why the obvious fix is wrong

Gating on `protected_json_key_label` fails: `lineage_descent_target_key`,
`lineage_descent_source_key`, and `last_model_key` are structural identifiers in
`ModuleMeta`, and all three derive a `key` label. Gating on them made five
`lineage_descent_tests` fail with "target lineage metadata failed secret
scanning", because `prepare_transaction_json_preserving_identities` runs over the
serialized meta.

The distinction that holds is whether the name carries a credential *qualifier*.
`qualified_secret_key_label` in `mc-core/src/redaction.rs` returns a label only
when the derived label is not the bare `key` or `keys`:

- `api_key` -> `api_key`, `private_key` -> `private_key` — credential.
- `lineage_descent_target_key`, `last_model_key` -> `key` — structural.

## Change

- The preserving path additionally requires `qualified_secret_key_label(key)` to
  be `None`.
- The preserving path applies only to a non-object value; an object falls through
  to the structural walk so each nested field name carries its own policy. An
  array still inherits the enclosing key, which keeps a list of grandfathered
  identifiers verbatim.

Both conditions are in one expression at `lib.rs:4027-4036`.

## Oracle

The pre-existing `preserved_json_identities_do_not_exempt_integrity_fields`
(`lib.rs:17237`) claims to cover this interaction and does not reach it.
`identity_json_field` requires `id`, `key`, `locator`, `revision`, or those
suffixes; the test's cases are the bare names `password`, `token`, `signature`,
and `integrity`, none of which is an identity field, so every case takes the
else-branch trivially. The `api_key` bypass passed it.

`preserved_json_identities_do_not_exempt_credential_names_or_nested_values`
(`lib.rs:17258`) covers the four quadrants:

- credential-qualified identity name (`api_key`, `private_key`, `access_key`) —
  refused.
- structural identity name (`block_id`, `target_key`, `revision_locator`) —
  preserved verbatim.
- nested object under an identity name — inner value redacted.
- array under an identity name — elements preserved verbatim.
- `apiKey`, which ends in `Key` rather than `_key` and so is not an identity field
  at all — substituted to `<REDACTED:api_key>`, not refused.

Mutation backstop: removing the credential-name gate, and restoring the
whole-subtree exemption, each fail it.

`only_qualified_key_names_mark_a_credential` in `mc-core/src/redaction.rs` pins
the credential-versus-structural split directly, including the three `ModuleMeta`
names that must stay on the preserving path.

## Limits

`secret_shaped_json_key` still refuses a benign structural string under a
secret-shaped name, so `{"stream_key": "main"}` is rejected in claim integrity
JSON. That is a fail-closed default, not a bypass, and changing it is a policy
decision. `OQ-H2`.
