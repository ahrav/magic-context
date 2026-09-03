//! The project a route is bound to, and how kernel rows are filtered by it.
//!
//! One kernel root serves every project on the host; a project is a scope
//! term on the `project` dimension whose exact value is the bound root. A
//! row serves to a route only when its scope names that root.

use std::collections::HashMap;
use std::path::Path;

use mc_kernel::{
    scope_matches, CanonicalScope, CommitIntent, Dimension, KernelError, KernelStore, MatchOutcome,
    ScopeMatchContext, ScopeSpec, ScopeTermSpec, Sensitivity, UnknownGraph,
};
use mc_store::canonical_root;
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// Source kind stamped on the scope object the route materializes per project.
const PROJECT_SCOPE_SOURCE_KIND: &str = "kernel_route";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectBinding {
    /// The bound root after canonicalization; the scope term's exact value.
    root: String,
    /// `sha256(root)`, the collision-free handle both the scope id and the
    /// per-project operation-key prefix are built from.
    digest: String,
}

impl ProjectBinding {
    pub(crate) fn new(root: &Path) -> Self {
        let root = canonical_root(root).to_string_lossy().into_owned();
        let digest = format!("{:x}", Sha256::digest(root.as_bytes()));
        Self { root, digest }
    }

    /// A request's `project_root` is compared after the same canonicalization
    /// the binding went through, so a symlinked spelling of the bound root passes.
    pub(crate) fn accepts(&self, requested: &Path) -> bool {
        canonical_root(requested).to_string_lossy() == self.root
    }

    pub(crate) fn scope_id(&self) -> String {
        format!("project:{}", self.digest)
    }

    /// The receipt key the store sees. `(producer, operation_key)` is unique
    /// kernel-wide: the project digest keeps two projects apart, and `family`
    /// keeps one route family's idempotency receipt from answering another's
    /// request. A blank key is refused here because the prefix would otherwise
    /// hide it from the kernel's emptiness check.
    fn operation_key(&self, family: &str, operation_key: &str) -> Option<String> {
        if operation_key.trim().is_empty() {
            return None;
        }
        Some(format!("{}:{family}:{operation_key}", self.digest))
    }

    /// The scope object every route-written row names.
    pub(crate) fn scope_spec(&self, domain_id: &str) -> ScopeSpec {
        let scope_id = self.scope_id();
        ScopeSpec {
            object_id: scope_id.clone(),
            source_id: scope_id.clone(),
            scope_id,
            domain_id: domain_id.to_string(),
            source_kind: PROJECT_SCOPE_SOURCE_KIND.to_string(),
            source_revision: 1,
            sensitivity: Sensitivity::Normal,
            terms: vec![ScopeTermSpec {
                dimension: Dimension::Project.as_str().to_string(),
                operator: "exact".to_string(),
                exact_value: Some(self.root.clone()),
                ..ScopeTermSpec::default()
            }],
        }
    }

    fn match_context(&self) -> ScopeMatchContext {
        ScopeMatchContext::new().with_value(Dimension::Project, self.root.clone())
    }
}

/// A commit intent as the wire carries it; `kernel.commit` and artifact
/// ingestion accept the same shape.
#[derive(Debug, Deserialize)]
pub(crate) struct IntentRequest {
    pub(crate) producer: String,
    pub(crate) operation_key: String,
    pub(crate) request_digest: String,
    pub(crate) actor: String,
    pub(crate) cause: String,
}

impl IntentRequest {
    /// The intent the store receives, its key namespaced to `project` and
    /// `family`; `None` when the caller's key is blank.
    pub(crate) fn into_intent(
        self,
        project: &ProjectBinding,
        family: &str,
    ) -> Option<CommitIntent> {
        let operation_key = project.operation_key(family, &self.operation_key)?;
        Some(CommitIntent {
            producer: self.producer,
            operation_key,
            request_digest: self.request_digest,
            actor: self.actor,
            cause: self.cause,
        })
    }
}

/// Answers whether a row's scope names the bound project, remembering each
/// scope's verdict for the duration of one request.
pub(crate) struct ScopeFilter<'a> {
    store: &'a KernelStore,
    context: ScopeMatchContext,
    verdicts: HashMap<String, bool>,
}

impl<'a> ScopeFilter<'a> {
    pub(crate) fn new(project: &ProjectBinding, store: &'a KernelStore) -> Self {
        Self {
            store,
            context: project.match_context(),
            verdicts: HashMap::new(),
        }
    }

    /// A row with no scope has no project and is never served, and neither is
    /// a scope with no `project` term: it constrains nothing, so it would
    /// match every project's route. An `Uncertain` verdict (a redacted term,
    /// a term on a dimension the route has no value for, a malformed scope)
    /// and a scope with no stored row are both treated as not matching.
    pub(crate) fn matches(&mut self, scope_id: Option<&str>) -> Result<bool, KernelError> {
        let Some(scope_id) = scope_id else {
            return Ok(false);
        };
        if let Some(verdict) = self.verdicts.get(scope_id) {
            return Ok(*verdict);
        }
        let verdict = match self.store.scope_terms(scope_id) {
            Ok(terms) => CanonicalScope::from_term_specs(&terms).is_ok_and(|scope| {
                scope.term(Dimension::Project).is_some()
                    && scope_matches(&scope, &self.context, &UnknownGraph) == MatchOutcome::Matches
            }),
            Err(KernelError::NotFound) => false,
            Err(error) => return Err(error),
        };
        self.verdicts.insert(scope_id.to_string(), verdict);
        Ok(verdict)
    }
}
