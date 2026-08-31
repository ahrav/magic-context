# a-declaration-order-change-cannot-orphan-a-retained-generation

## Discovery trigger

Gap G4's second half. The prompt framed the risk as "a field added out of
declaration order would silently change every retained generation's digest". That
framing needed checking against the validation path, and it turns out to be wrong
in an instructive way: the digest break is not silent, it is fail-closed, and the
silent consequence is a different one.

## Evidence trail

The generation's name is the SHA-256 of its manifest bytes
(`generation.rs:176-178`), and those bytes are declaration order
(`:172-174`, structs at `:138-145` and `:147-169`).

`validate_in_dir` binds name to bytes twice, `generation.rs:636-648`:

```
if hex(&sha2::Sha256::digest(&bytes)) != digest {
    return Err(invalid("manifest bytes do not hash to the generation name"));
}
// The digest above binds the generation name to whatever bytes are on
// disk, not to the canonical encoding of the decoded manifest. Without
// this equality a manifest with reordered keys or extra whitespace,
// stored under the hash of those raw bytes, validates while
// `manifest.digest()` names a different generation -- two identities for
// one logical manifest, which breaks the content-addressed
// deduplication and repair the digest is supposed to provide.
if manifest.canonical_bytes() != bytes {
    return Err(invalid("manifest is not canonically encoded"));
}
```

Trace a reordered struct against a retained generation:

1. The bytes on disk are unchanged, so `hex(sha256(bytes)) == digest` and the first
   check passes.
2. `decode_with_schema` (`generation.rs:188-206`) decodes by key name, not
   position, so the decode succeeds regardless of order.
3. `manifest.canonical_bytes()` now re-encodes in the *new* order, so it differs
   from the on-disk bytes, and the second check fails with
   `invalid("manifest is not canonically encoded")`.

`invalid(..)` maps to the payload-invalid error class, which surfaces as
`native_payload_invalid`. That is the same operator-visible outcome the
`source_payload_manifest_sha256` doc comment at `generation.rs:157-165` was
written to avoid:

> Schema 1 shipped without it and the schema number did not change when it was
> added, so requiring it would decode every retained predecessor as corrupt and
> fail the first no-`--payload-dir` start after an upgrade with
> `native_payload_invalid` -- refusing a payload that is intact.

So the authors already identified this exact failure shape for one specific
evolution and defended against it with `Option` plus
`skip_serializing_if`. Nothing defends against the same shape arriving through a
field that moves.

Reachability label evidence: `default-production`. `validate` is called on the
default start path and `config.rs:292` supplies a default
`payload_manifest_digest`, so nothing gates it.

## Failure scenario

Two consequences, with opposite detection properties.

**Fail-closed, on retained generations.** A release moves
`source_payload_manifest_sha256` up beside the other hashes. On the first start
after upgrade, every retained generation whose manifest carries that field fails
`:645`, so `validate` rejects it. The catalog's
`current-profile-never-names-an-unvalidatable-generation` then applies: the current
profile names a digest that no longer validates. The operator sees
`native_payload_invalid` for a payload that is byte-for-byte intact, and no
message says why.

**Silent, on new staging.** The same release stages the same logical content and
computes a different digest, so it lands in a new directory. Content-addressed
deduplication stops recognizing the old generation as the same content. Nothing
errors; the store simply holds two directories for one payload, and the prune
retention accounting treats them as distinct.

The prompt's word "silently" applies to the second consequence, not the first. Both
are worth a record and this one covers both, because they share a single root cause
and a single check.

## Timing windows and dependencies

No runtime window. The dependency is a version boundary: the defect is introduced
by one release and observed by the next start of that release against state written
by the previous one. That makes it invisible to any test that stages and validates
within a single binary, which is every existing store test.

The schema number does not change when a field moves, so
`decode_with_schema`'s `Some(1)` gate at `:192-196` cannot catch it, and
`GenerationError::UnsupportedStateSchema` is never produced. The quarantine
machinery that exists for schema changes therefore does not engage: the generation
is classified corrupt rather than quarantined, and the catalog's
`an-undecidable-quarantine-witness-fails-closed` shows what corrupt classification
leads to in prune.

## What a test must construct

Two options, and the cheap one is enough.

**Cheap, static.** A test that pins the encoding, which is the sibling record
`manifest-canonical-bytes-and-digest-are-pinned-by-a-full-golden-vector`. If the
golden covers every field of both structs plus the digest, no order change can
reach a release. This record's obligation is discharged by that check.

**Direct, cross-version.** A test that proves the runtime behaviour rather than
preventing it:

1. Write a manifest byte literal in a *different* field order from the current
   struct, for example `source_payload_manifest_sha256` placed before
   `inputs_lock_sha256`.
2. Compute its SHA-256 and create a generation directory under that name, with the
   manifest and the files it lists.
3. Call `store.validate(name)` and assert the error is
   `invalid("manifest is not canonically encoded")` rather than a hash mismatch or
   a decode failure.

The second option documents the failure mode explicitly, which has value: a
maintainer reading it learns that field order is a compatibility contract. It does
not prevent the defect, so it complements rather than replaces the golden.

## Investigation log

### Q: Is the reordering break silent or fail-closed?

- Sources examined: `generation.rs:636-648` (both equality checks and the comment
  between them), `:188-206` (`decode_with_schema`), `:172-178` (encoding and
  digest), `:157-165` (the `Option` field's rationale), `:602-616`
  (`validate`'s entry).
- Findings: fail-closed for retained generations, via `manifest.canonical_bytes()
  != bytes` at `:645`. Silent for new staging, because the digest changes and
  nothing compares it to a previous one. The prompt's framing captured the second
  and missed the first.
- Missing evidence: none needed; both paths are direct reads.
- Conclusion: resolved with answer. The record states both consequences and the
  Fault/timing angle names the correction explicitly, per the METHOD rule about
  reporting contract-versus-code and claim-versus-code disagreements with both
  sides cited.

### Q: Should the canonical encoding be decoupled from declaration order?

- Sources examined: `:148-150` (the struct doc stating order is the contract),
  `:172-174` (`serde_json::to_vec`), `:640-647` (the comment justifying the
  canonical-bytes equality).
- Findings: the current design states the contract in a doc comment and enforces
  it with a runtime equality check, but the contract's *content* lives implicitly
  in the field order of a struct that an ordinary refactor can change. An explicit
  field-order list, a canonical-JSON serializer, or a hand-written `Serialize`
  would state it once. Each has a cost, and the store has other canonical-encoding
  consumers (`WireProfile` at `:914-918`) that would want the same treatment.
- Missing evidence: whether any other component outside this crate encodes or
  decodes these manifests, which would make the encoding a cross-crate contract
  rather than an internal one. Not established in this pass.
- Conclusion: needs human input. It is a design decision with a real cost, and the
  golden vector closes the immediate risk without it.
