# facade-a-facade-error-text-carries-absolute-route-paths-to-the-model

## Discovery trigger

Task 4 asked whether any response, error, or diagnostic can carry secrets, file
paths, tokens, or raw user content that the contract says must not appear, and
noted that earlier parts found a redaction contract that a `Debug` implementation
defeated. The analogue here runs the other way. `dispatch.rs`'s `Debug` impls are
the strictest redaction discipline in the crate, and the response path is where
host filesystem paths escape.

## Evidence trail

### The redaction discipline that does exist

`crates/mc-module/src/dispatch.rs`

- `:81-88` `impl Debug for PreparedSegment` prints `bytes_len` and
  `measured_len`. No bytes.
- `:192-203` `impl Debug for PreparedOutput` prints only a `kind` string,
  `"json"`, `"exact"`, or `"transform"`. No value, no bytes.
- `:212-224` `impl Debug for PreparedOutcome`:

      Self::Error { code, message } => f
          .debug_struct("Error")
          .field("code_len", &code.len())
          .field("message_len", &message.len())
          .finish(),

  Not even the error code is printed, only its length.

Three hand-written `Debug` impls that each deliberately drop content is a
discipline, not an accident. Nothing in the file says why, which is itself worth
noting, but the pattern is unambiguous.

### Where paths leave through the response

Site 1, built in the module. `crates/mc-module/src/lib.rs:10446-10454`, inside
`resolve_facade_scope`:

    if requested_project.is_some_and(|requested| requested != authority_project) {
        return Err(PreparedOutcome::Error {
            code: "facade_project_vocabulary_mismatch".to_string(),
            message: format!(
                "{authority_domain} facade route {route_project_root} is authority-managed as {authority_project}, but the request supplied {}",
                requested_project.unwrap_or_default()
            ),
        });
    }

`route_project_root` comes from `binding.project_root.to_string_lossy().to_string()`
(`:10433`), which is the daemon-bound absolute project root.

Site 2, built in the store and forwarded. `lib.rs:11584-11590`:

    if let Err(error) = store.enforce_facade_project_vocabulary(
        facade_scope.route_project_root.as_str(),
        project,
        "notes",
    ) {
        return tool_error_result(format!("Error: {error}"));
    }

`enforce_facade_project_vocabulary` raises
`McStoreError::FacadeProjectVocabularyMismatch { route_project_root, ... }`
(`mc-store/src/lib.rs:5269-5274`), whose `Display`
(`:3504-3512`) is:

    "{domain} facade route {route_project_root} is authority-managed as {authority_project}, but the write used {write_project}"

`tool_error_result` (`lib.rs:13798-13800`) wraps that in
`mcp_text_result(msg, true)` (`:13791-13796`), so the path lands in
`content[0].text`, which is what the model reads.

### The generic forwarding pattern that makes this systemic

`format!("Error: {error}")` on a store error appears throughout the facade
handlers: `lib.rs:10515`, `:10519`, `:10675`, `:10757`, `:10810`, `:10830`,
`:10850`, `:10859`, `:11589`, `:15309`, `:15335`. Each one forwards an
`McStoreError` Display verbatim into model-visible text. Scanning the
`McStoreError` variants for path- or content-bearing fields
(`mc-store/src/lib.rs:3361-3460`) finds `FacadeProjectVocabularyMismatch`
carrying `route_project_root`, and `NoteOwnershipMismatch { id, project }`
carrying a project which is a filesystem path for a route that is not
authority-managed (`resolve_facade_scope` falls back to
`route_project_root.clone()` at `:10464` and `:10472` in exactly that case).

So the leak is not one message. It is a forwarding convention applied to an error
type whose variants were designed for operators.

### Sanitisation exists, and is not applied here

`lib.rs:15423-15441` `sanitize_status_text` strips control characters, collapses
whitespace, and truncates to a character limit. `compact_status_detail`
(`:15443-15445`) applies it at 120 characters. Both are used for status and
health text, not for facade error text.

### Contract search

I looked for a stated rule that facade responses must not carry host paths:

- `crates/mc-module/src` — searching for `redact`, `must not leak`,
  `never leak`, `no secrets`, and `scrub` returns only the `RedactedReasoning`
  CK block kind in the codecs, which is provider-supplied redacted thinking, an
  unrelated concept.
- `crates/mc-host/src` — same search, nothing.
- `docs/` — `redact` appears only in performance-run artifacts and shared-memory
  plans, nothing about response content.

So there is no explicit contract. The finding is therefore framed as an absent
contract plus a demonstrated behaviour, not as a violated rule.

## Failure scenario

A route is bound to `/Users/alice/work/acme-payments` and that project is
authority-managed under a domain identity that is not the path. The model calls
`ctx_note` with `action: "write"` and a `memory_project` value that disagrees, or
simply writes while the route's authority binding has moved.

The response is
`{"content":[{"type":"text","text":"Error: notes facade route /Users/alice/work/acme-payments is authority-managed as <project>, but the write used <other>"}],"isError":true}`.

That text now lives in the model's context. Everything downstream follows:

- It is part of the conversation the transform folds into `m0` or `m1`, so it can
  become part of the frozen baseline and be replayed on every later pass.
- It is part of the provider request, so it reaches the provider's prefix cache.
- It is part of any transcript, log, or session export the harness keeps.

The disclosed value is a host filesystem path, which typically contains the
operating-system username and the project name. It is not a credential, and the
model is not an untrusted party in the usual sense, so the severity is disclosure
of environment layout rather than a secret. The reason it is worth a record is
that it is inconsistent: the same crate refuses to print an error code's bytes
into a `Debug` line and prints an absolute path into the model's context.

## Timing windows and dependencies

None. Pure response construction.

Reachability: default-production, but the state is conditional. Site 1 requires
`authority_project_state_for_route` to return `Some` (`:10443-10445`), meaning the
route is authority-managed, AND a `memory_project` argument that disagrees. Site 2
requires a mutation on an authority-managed route where
`enforce_facade_project_vocabulary` rejects. A route with no authority binding
takes the `Ok(None)` path at `:10464` and stays path-scoped, in which case
`memory_project_path` IS the absolute path and flows into other messages through
`NoteOwnershipMismatch`.

Config default is not a gate: `memory_enabled: true` (`config.rs:124`) and the
default prompt-surface preset is `Full` (`prompt_surface.rs:112-122`), so all five
`ctx_*` tools are advertised in a default build.

## What a test must construct

1. A bound route whose `project_root` is a distinctive absolute path, for example
   a `tempdir` whose final component is a known marker string.
2. An authority binding for that route naming a project that is NOT the path, so
   the vocabulary check can fail. `store.bind_authority_route` is called from
   `bind_facade_route_for_write` (`:10377-10382`), and the existing tests build
   authority state directly.
3. Drive the mismatch both ways: a `ctx_note` write with a disagreeing
   `memory_project` (site 1) and a write that reaches
   `enforce_facade_project_vocabulary` (site 2).
4. For each, assert the response text does not contain the marker string.
5. Generalise: a harness helper that, for every facade response produced in the
   inline test module, asserts the response text contains no substring of the
   fixture's `tempdir` path. That converts a one-off assertion into a suite-wide
   invariant and would catch the next forwarding site added.
6. Do not assert on the full message equality, because that pins the wording and
   makes the test brittle. Assert on the absence of the path.

## Investigation log

### Q: Is there a documented rule anywhere that facade responses must not carry host paths?

- Sources examined: `crates/mc-module/src` searched for `redact`, `Redact`,
  `do not leak`, `must not leak`, `never leak`, `no secrets`, `scrub`;
  `crates/mc-host/src` searched the same way; `docs/` searched for `redact`;
  `dispatch.rs:81-88`, `:192-203`, `:212-224` for the `Debug` discipline, looking
  for a comment explaining it; `lib.rs:15423-15445` for the sanitiser that does
  exist, looking for a scope statement; `lib.rs:10339-10349`,
  `log_missing_facade_command_id`, which prints a session id to stderr, to see
  whether diagnostics have a stated policy.
- Findings: no rule, and no comment on any of the three `Debug` impls explaining
  why they redact. `sanitize_status_text` has no doc comment either; its usage
  (`compact_status_detail` at 120 characters, from `storage_versions_block` and
  the status summaries) suggests its purpose is bounded, readable status output
  rather than redaction. `log_missing_facade_command_id`'s message explicitly
  states its own policy inline ("accepting for transport compatibility",
  `:10346`), which shows the codebase does document policy where it has one.
- Missing evidence: whether the prompt-surface owner has a rule about what may
  enter the model's context. `docs/specs/prompt-surface/` exists and the scope map
  records it as containing a load-bearing-rules checklist
  (`part-4-module/_lenses/scope-map-and-risk-ranking.md:688-694`), which is the
  most likely home for such a rule. I did not read it, because 4e owns that
  directory and re-deriving its contents here would duplicate that lens.
- Conclusion: unresolved, needs the prompt-surface owner. Concretely: whether
  `docs/specs/prompt-surface/`'s load-bearing-rules checklist constrains
  response content. If it does, this becomes a contract violation with both sides
  citable. If it does not, the record stands as an inconsistency between the
  crate's diagnostic discipline and its response discipline, and the guarantee I
  stated is a proposed contract rather than an existing one.
