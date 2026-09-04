//! `kernel.read`: the visible rows of one surface at one snapshot, filtered
//! to the bound project, each carrying the mutation token `kernel.commit`
//! checks. Decision objects also carry their decision row, so a client can
//! render the decision text without a second route.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

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

/// Rows served per read. A row's fixed JSON structure (registry fields, token, visibility, scope) encodes to ~500 bytes before payload text, so this cap keeps a payload-light response in the low tens of mebibytes and bounds client-side parse and ranking work; memory surfaces render at most ~100 rows per query, so the newest rows this cap keeps dominate every surface's candidate set. commentlint: allow(JUDGE)
pub const MAX_READ_ROWS: usize = 8192;

/// Byte budget for the serialized `rows` array: one eighth of the 64 MiB wire cap. Redaction caps each decision text field at 512 KiB, so a worst-case row is ~1 MiB and at least eight always fit; typical memory rows run ~1 KiB, so thousands fit before [`MAX_READ_ROWS`] binds first. The response is the rows plus a fixed envelope of under 200 bytes, so a rows array within this budget cannot reach the cap that would fail the whole response. commentlint: allow(JUDGE)
pub const MAX_READ_ROW_BYTES: usize = crate::dispatch::MAX_WIRE_BODY_BYTES / 8;

/// Ids per `object_ids` filter. A filtered read preflights one mutation batch, so the bound stays far under [`MAX_READ_ROWS`] and a filtered read never hits the row cap. commentlint: allow(JUDGE)
pub const MAX_READ_OBJECT_IDS: usize = 64;

#[derive(Debug, Deserialize)]
pub(crate) struct ReadRequest {
    surface: String,
    /// `None` reads the tip.
    #[serde(default)]
    as_of: Option<i64>,
    /// Filters the read to these objects before the row cap applies, so a targeted lookup addresses a row the bounded unfiltered read drops; `None` reads the whole surface. commentlint: allow(JUDGE)
    #[serde(default)]
    object_ids: Option<Vec<String>>,
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
    /// Whether rows beyond [`MAX_READ_ROWS`] were dropped. Byte-budget truncation happens at serialization, so the response's flag can be `true` while `truncated` here is `false`. commentlint: allow(JUDGE)
    truncated: bool,
    /// Decision rows keyed by `object_id`, looked up at `known_as_of`. Total
    /// over the visible decision-kind rows in `rows`: a missing entry fails
    /// the read, so a `None` lookup during rendering means a non-decision row.
    decisions: HashMap<String, DecisionRow>,
}

/// Orders rows for a max-heap whose maximum is the serving-order-last row: an older `created_commit_seq` ranks greater, and among rows of one commit the greater `object_id` ranks greater, so the heap's peek is exactly the row a full newest-first sort then truncate drops first. commentlint: allow(JUDGE)
struct ServingOrderLast(VisibleRow);

impl Ord for ServingOrderLast {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .0
            .object
            .created_commit_seq
            .cmp(&self.0.object.created_commit_seq)
            .then_with(|| self.0.object.object_id.cmp(&other.0.object.object_id))
    }
}

impl PartialOrd for ServingOrderLast {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for ServingOrderLast {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for ServingOrderLast {}

/// Bounded newest-first selection: keeps at most `cap` rows of the serving order (`created_commit_seq` descending, `object_id` breaking ties) while candidates stream in, so selection costs `O(n log cap)` comparisons and `cap` retained rows instead of a full sort. Each overflow evicts the serving-order-last kept row, so the kept set and its order match a full sort followed by a truncate. commentlint: allow(JUDGE)
pub struct NewestRows {
    cap: usize,
    heap: BinaryHeap<ServingOrderLast>,
    dropped: bool,
}

impl NewestRows {
    pub fn new(cap: usize) -> Self {
        Self {
            cap,
            heap: BinaryHeap::with_capacity(cap.saturating_add(1)),
            dropped: false,
        }
    }

    pub fn push(&mut self, row: VisibleRow) {
        self.heap.push(ServingOrderLast(row));
        if self.heap.len() > self.cap {
            self.heap.pop();
            self.dropped = true;
        }
    }

    /// Returns the kept rows in serving order and whether any candidate was dropped.
    pub fn finish(self) -> (Vec<VisibleRow>, bool) {
        let rows = self
            .heap
            .into_sorted_vec()
            .into_iter()
            .map(|entry| entry.0)
            .collect();
        (rows, self.dropped)
    }
}

pub(crate) fn read_visible(
    store: &KernelStore,
    project: &ProjectBinding,
    surface: Surface,
    as_of: Option<i64>,
    object_ids: Option<&[String]>,
) -> Result<ReadResponse, KernelError> {
    let requested = match as_of {
        Some(as_of) => as_of,
        None => store.tip()?,
    };
    // The kernel keeps rows whose scope names another project out of the
    // snapshot, so the read costs the project's rows and not the store's.
    let visible =
        store.visible_as_of_in_scope(surface, requested, object_ids, Some(project.scope_term()))?;
    let mut filter = ScopeFilter::new(project);
    let mut terms = stored_terms(store);
    // `ScopeFilter` judges scope-term operators the kernel query keeps for the caller, so the row bound cannot be a SQL `LIMIT`; it applies here, after the filter. commentlint: allow(JUDGE)
    let mut newest = NewestRows::new(MAX_READ_ROWS);
    for row in visible.rows {
        if filter.matches(row.scope_id.as_deref(), &mut terms)? {
            newest.push(row);
        }
    }
    let (rows, truncated) = newest.finish();
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
        truncated,
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
        if parsed
            .object_ids
            .as_ref()
            .is_some_and(|ids| ids.len() > MAX_READ_OBJECT_IDS)
        {
            return crate::invalid_params_error(format!(
                "{OPERATION} object_ids must name at most {MAX_READ_OBJECT_IDS} objects"
            ));
        }
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
        let object_ids = parsed.object_ids.clone();
        let result =
            blocking(move || read_visible(&store, &project, surface, as_of, object_ids.as_deref()))
                .await;
        let response = match result {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => return state_only(KernelOutcome::from(error)),
            Err(outcome) => return state_only(outcome),
        };
        // Rows are newest first, so the budget retains a contiguous prefix of the most recent rows. A failed measurement stops collection and sets `truncated`. commentlint: allow(JUDGE)
        let mut truncated = response.truncated;
        let mut rows: Vec<Value> = Vec::with_capacity(response.rows.len());
        let mut row_bytes = 0usize;
        for row in &response.rows {
            let value = row_json(
                row,
                response.decisions.get(&row.object.object_id),
                response.known_as_of,
            );
            // The `+ 1` charges each row's array separator or bracket byte against the budget. commentlint: allow(JUDGE)
            let cost = crate::dispatch::measure_json(&value)
                .ok()
                .and_then(|len| len.checked_add(1));
            match cost {
                Some(cost) if row_bytes + cost <= MAX_READ_ROW_BYTES => {
                    row_bytes += cost;
                    rows.push(value);
                }
                _ => {
                    truncated = true;
                    break;
                }
            }
        }
        kernel_response(
            &KernelOutcome::Available,
            json!({
                "known_as_of": response.known_as_of,
                "tip": response.tip,
                "gated": parsed.gated,
                "truncated": truncated,
                "rows": rows,
            }),
        )
    }
}
