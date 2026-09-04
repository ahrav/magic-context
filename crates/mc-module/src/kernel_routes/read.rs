//! `kernel.read`: the visible rows of one surface at one snapshot, filtered
//! to the bound project, each carrying the mutation token `kernel.commit`
//! checks. Decision objects also carry their decision row, so a client can
//! render the decision text without a second route.

use std::collections::HashMap;

use mc_host::RouteHandle;
use mc_kernel::{DecisionRow, KernelError, KernelStore, Surface, SurfaceVisibility, VisibleRow};
use serde::Deserialize;
use serde_json::{json, Value};

use super::project::{stored_terms, ProjectBinding, ScopeFilter};
use super::serving;
use super::{blocking, kernel_response, state_only, KernelOutcome};
use crate::dispatch::PreparedOutcome;
use crate::McHandler;

const OPERATION: &str = "kernel.read";

#[derive(Debug, Deserialize)]
pub(crate) struct ReadRequest {
    surface: String,
    /// `None` reads the tip.
    #[serde(default)]
    as_of: Option<i64>,
    /// Whether the serving policy judges freshness before rows are returned.
    #[serde(default)]
    gated: bool,
    /// Clock the lag age is measured against, so a test can place a read on
    /// either side of the age threshold; production reads take the wall clock.
    #[cfg(feature = "test-support")]
    #[serde(default)]
    now_ms: Option<i64>,
}

impl ReadRequest {
    #[cfg(feature = "test-support")]
    fn clock_ms(&self) -> i64 {
        self.now_ms.unwrap_or_else(crate::now_ms)
    }

    #[cfg(not(feature = "test-support"))]
    fn clock_ms(&self) -> i64 {
        crate::now_ms()
    }
}

pub(crate) struct ReadResponse {
    known_as_of: i64,
    tip: i64,
    rows: Vec<VisibleRow>,
    /// Decision rows keyed by `object_id`, looked up at `known_as_of`. Total
    /// over the visible decision-kind rows in `rows`: a missing entry fails
    /// the read, so a `None` lookup during rendering means a non-decision row.
    decisions: HashMap<String, DecisionRow>,
}

pub(crate) fn read_visible(
    store: &KernelStore,
    project: &ProjectBinding,
    surface: Surface,
    as_of: Option<i64>,
) -> Result<ReadResponse, KernelError> {
    let requested = match as_of {
        Some(as_of) => as_of,
        None => store.tip()?,
    };
    // The kernel keeps rows whose scope names another project out of the
    // snapshot, so the read costs the project's rows and not the store's.
    let visible = store.visible_as_of_in_scope(surface, requested, Some(project.scope_term()))?;
    let mut filter = ScopeFilter::new(project);
    let mut terms = stored_terms(store);
    let mut rows = Vec::with_capacity(visible.rows.len());
    for row in visible.rows {
        if filter.matches(row.scope_id.as_deref(), &mut terms)? {
            rows.push(row);
        }
    }
    let decision_ids: Vec<String> = rows
        .iter()
        .filter(|row| row.object.object_kind == "decision")
        .map(|row| row.object.object_id.clone())
        .collect();
    let decisions: HashMap<String, DecisionRow> = store
        .decisions_for_objects_as_of(&decision_ids, visible.known_as_of)?
        .into_iter()
        .map(|decision| (decision.object_id.clone(), decision))
        .collect();
    // A visible decision-kind row without its typed decision row at the same snapshot is a
    // canonical-integrity break. Serving it with `decision: null` would be indistinguishable
    // from a non-decision row and silently drop it from memory surfaces, so the read fails
    // closed instead.
    if decision_ids.iter().any(|id| !decisions.contains_key(id)) {
        return Err(KernelError::CorruptCanonicalRow);
    }
    Ok(ReadResponse {
        known_as_of: visible.known_as_of,
        tip: visible.tip,
        rows,
        decisions,
    })
}

fn row_json(row: &VisibleRow, decision: Option<&DecisionRow>, known_as_of: i64) -> Value {
    json!({
        "object": row.object,
        "visibility": match row.visibility {
            SurfaceVisibility::Hidden => "hidden",
            SurfaceVisibility::Visible => "visible",
            SurfaceVisibility::Labeled => "labeled",
        },
        "labeled": row.labeled,
        "scope_id": row.scope_id,
        "token": {"object_id": row.object.object_id, "known_as_of": known_as_of},
        "decision": decision.map(|decision| json!({
            "decision_kind": decision.decision_kind,
            "payload": decision.payload,
        })),
    })
}

impl McHandler {
    pub(crate) async fn handle_kernel_read(
        &self,
        channel: RouteHandle,
        request: &Value,
    ) -> PreparedOutcome {
        let scope = match self.kernel_route_scope(channel, request, OPERATION) {
            Ok(scope) => scope,
            Err(outcome) => return outcome,
        };
        let parsed = match serde_json::from_value::<ReadRequest>(request.clone()) {
            Ok(parsed) => parsed,
            Err(error) => {
                return crate::invalid_params_error(format!("invalid {OPERATION}: {error}"))
            }
        };
        let Ok(surface) = Surface::try_from(parsed.surface.as_str()) else {
            return crate::invalid_params_error(format!(
                "{OPERATION} surface must be one of auto_inject, auto_search, explicit_search"
            ));
        };
        let mut as_of = parsed.as_of;
        if parsed.gated {
            let store = scope.store.clone();
            let now_ms = parsed.clock_ms();
            let gate = blocking(move || {
                let tip = store.tip()?;
                store.outbox_lag(now_ms).map(|lag| (tip, lag))
            })
            .await;
            let outcome = match gate {
                Ok(Ok((tip, lag))) => {
                    as_of.get_or_insert(tip);
                    serving::project(serving::decide(&lag), surface)
                }
                Ok(Err(error)) => KernelOutcome::from(error),
                Err(outcome) => outcome,
            };
            if !outcome.is_available() {
                return state_only(outcome);
            }
        }
        let store = scope.store.clone();
        let project = scope.project.clone();
        let result = blocking(move || read_visible(&store, &project, surface, as_of)).await;
        let response = match result {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => return state_only(KernelOutcome::from(error)),
            Err(outcome) => return state_only(outcome),
        };
        let rows: Vec<Value> = response
            .rows
            .iter()
            .map(|row| {
                row_json(
                    row,
                    response.decisions.get(&row.object.object_id),
                    response.known_as_of,
                )
            })
            .collect();
        kernel_response(
            &KernelOutcome::Available,
            json!({
                "known_as_of": response.known_as_of,
                "tip": response.tip,
                "gated": parsed.gated,
                "rows": rows,
            }),
        )
    }
}
