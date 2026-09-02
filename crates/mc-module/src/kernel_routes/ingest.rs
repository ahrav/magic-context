//! `begin`, `page`, and `finish` transfer one artifact payload across the ring
//! in base64 pages and call `ingest_artifact` at `finish`.
//!
//! Pages stay in daemon memory keyed by the route that sent them; the kernel
//! sees nothing until `finish` hands it the assembled bytes, so the kernel's
//! own ingestion reservation is the only durable footprint an upload has. A
//! route owns at most one upload, and every route shares one
//! [`StagingBudget`], so an abandoned upload can hold no more than its
//! declared size until the route is torn down.
//!
//! `finish` owns the size verdict: `begin` admits any total up to
//! [`UPLOAD_ALLOWANCE_BYTES`], which sits above [`MAX_PAYLOAD_BYTES`], so an
//! over-cap payload is refused by the kernel as `payload_too_large` after its
//! declared digest has been checked, the same way an in-process caller sees it.

use std::collections::{BTreeMap, HashMap};

use base64::Engine as _;
use mc_host::RouteHandle;
use mc_kernel::{
    ArtifactHandle, ArtifactIngestRequest, CommitIntent, KernelStore, ProviderEgress,
    RepositoryProvenance, Sensitivity, MAX_PAYLOAD_BYTES,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    blocking, kernel_response, state_only, InvalidReason, KernelOutcome, UnavailableReason,
};
use crate::dispatch::PreparedOutcome;
use crate::{sha256_hex, McHandler};

const BEGIN: &str = "kernel.artifact.ingest.begin";
pub(crate) const PAGE: &str = "kernel.artifact.ingest.page";
const FINISH: &str = "kernel.artifact.ingest.finish";

const MIB: u64 = 1024 * 1024;
/// The largest total an upload may declare. It exceeds the kernel cap by one
/// page-sized margin so a payload one byte over the cap is staged whole and
/// refused by the kernel rather than by a route-local check.
pub const UPLOAD_ALLOWANCE_BYTES: u64 = MAX_PAYLOAD_BYTES as u64 + MIB;
/// Decoded bytes one page may carry. Encoded, a page of this size is about
/// 21.4 MiB, under the 32 MiB transform-class frame with room for the envelope.
pub const PAGE_BYTES_MAX: u64 = 16 * MIB;
/// Uploads in flight across every route.
pub const MAX_PENDING_UPLOADS: usize = 4;
/// Declared bytes staged across every route; every pending upload may be at
/// the allowance at once.
pub const MAX_STAGED_BYTES: u64 = UPLOAD_ALLOWANCE_BYTES * MAX_PENDING_UPLOADS as u64;
const MAX_UPLOAD_ID_BYTES: usize = 128;

/// Handler-wide staging caps. An upload reserves its declared total at
/// `begin` and releases it when it finishes or its route goes away, so the
/// staged bytes never exceed what was admitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StagingBudget {
    pub total_bytes: u64,
    pub pending: usize,
    pub max_bytes: u64,
    pub max_pending: usize,
}

impl StagingBudget {
    pub const fn new(max_bytes: u64, max_pending: usize) -> Self {
        Self {
            total_bytes: 0,
            pending: 0,
            max_bytes,
            max_pending,
        }
    }

    /// Admits one more upload of `bytes` when both caps hold afterwards.
    pub fn try_reserve(&mut self, bytes: u64) -> bool {
        let Some(total) = self.total_bytes.checked_add(bytes) else {
            return false;
        };
        if total > self.max_bytes || self.pending >= self.max_pending {
            return false;
        }
        self.total_bytes = total;
        self.pending += 1;
        true
    }

    pub fn release(&mut self, bytes: u64) {
        self.total_bytes = self.total_bytes.saturating_sub(bytes);
        self.pending = self.pending.saturating_sub(1);
    }
}

impl Default for StagingBudget {
    fn default() -> Self {
        Self::new(MAX_STAGED_BYTES, MAX_PENDING_UPLOADS)
    }
}

#[derive(Debug, Deserialize)]
struct IntentRequest {
    producer: String,
    operation_key: String,
    request_digest: String,
    actor: String,
    cause: String,
}

/// Everything `ArtifactIngestRequest` carries besides the intent and the
/// bytes, as the wire spells it.
#[derive(Debug, Deserialize)]
struct ArtifactRequest {
    evidence_id: String,
    object_id: String,
    object_kind: String,
    domain_id: String,
    source_kind: String,
    source_id: String,
    source_revision: i64,
    media_type: String,
    retention_class: String,
    #[serde(default)]
    retain_until: Option<i64>,
    asserted_sensitivity: Sensitivity,
    provider_egress: String,
    #[serde(default)]
    provenance: Option<ProvenanceRequest>,
}

#[derive(Debug, Deserialize)]
struct ProvenanceRequest {
    repository_id: String,
    revision: String,
}

fn parse_provider_egress(value: &str) -> Option<ProviderEgress> {
    match value {
        "remote_allowed" => Some(ProviderEgress::RemoteAllowed),
        "local_only" => Some(ProviderEgress::LocalOnly),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
struct BeginRequest {
    upload_id: String,
    total_bytes: u64,
    page_count: u32,
    payload_digest: String,
    request: ArtifactRequest,
    intent: IntentRequest,
}

#[derive(Debug, Deserialize)]
struct PageRequest {
    upload_id: String,
    index: u32,
    bytes_base64: String,
    page_digest: String,
}

#[derive(Debug, Deserialize)]
struct FinishRequest {
    upload_id: String,
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

struct Page {
    digest: String,
    bytes: Vec<u8>,
}

/// One route's in-flight upload: the declared layout, the pages received so
/// far by index, and the request the assembled bytes will be ingested under.
struct Upload {
    upload_id: String,
    total_bytes: u64,
    page_count: u32,
    payload_digest: String,
    received_bytes: u64,
    pages: BTreeMap<u32, Page>,
    request: ArtifactIngestRequest,
}

impl Upload {
    fn progress(&self) -> Value {
        json!({
            "upload_id": self.upload_id,
            "received_pages": self.pages.len(),
            "received_bytes": self.received_bytes,
        })
    }

    fn is_complete(&self) -> bool {
        self.pages.len() == self.page_count as usize && self.received_bytes == self.total_bytes
    }
}

/// Route-keyed uploads plus the budget they draw on. Held behind one mutex so
/// a reservation and the upload it admits change together.
#[derive(Default)]
pub(crate) struct UploadCoordinator {
    budget: StagingBudget,
    uploads: HashMap<RouteHandle, Upload>,
}

#[derive(Debug, PartialEq, Eq)]
enum BeginRejection {
    /// The route already has an upload in flight, or the budget is exhausted.
    QueueFull,
}

impl UploadCoordinator {
    pub(crate) fn budget(&self) -> StagingBudget {
        self.budget
    }

    fn begin(&mut self, route: RouteHandle, upload: Upload) -> Result<(), BeginRejection> {
        if self.uploads.contains_key(&route) || !self.budget.try_reserve(upload.total_bytes) {
            return Err(BeginRejection::QueueFull);
        }
        self.uploads.insert(route, upload);
        Ok(())
    }

    fn upload_mut(&mut self, route: RouteHandle, upload_id: &str) -> Option<&mut Upload> {
        self.uploads
            .get_mut(&route)
            .filter(|upload| upload.upload_id == upload_id)
    }

    /// Removes the route's upload and returns its declared size to the budget.
    /// Answers whether an upload was in flight.
    pub(crate) fn discard(&mut self, route: RouteHandle) -> bool {
        self.take(route).is_some()
    }

    fn take(&mut self, route: RouteHandle) -> Option<Upload> {
        let upload = self.uploads.remove(&route)?;
        self.budget.release(upload.total_bytes);
        Some(upload)
    }

    /// Drops every upload; the budget returns to empty with them.
    pub(crate) fn clear(&mut self) {
        let routes: Vec<RouteHandle> = self.uploads.keys().copied().collect();
        for route in routes {
            self.discard(route);
        }
    }

    /// Stages `page` under `index`. A page already held under that index with
    /// the same digest is acknowledged without being stored twice.
    fn stage(
        &mut self,
        route: RouteHandle,
        upload_id: &str,
        index: u32,
        page: Page,
    ) -> Result<Value, InvalidReason> {
        let upload = self
            .upload_mut(route, upload_id)
            .ok_or(InvalidReason::UploadNotFound)?;
        if index >= upload.page_count {
            return Err(InvalidReason::PageIndex);
        }
        if let Some(existing) = upload.pages.get(&index) {
            if existing.digest == page.digest {
                return Ok(upload.progress());
            }
            return Err(InvalidReason::PageDigest);
        }
        let bytes = page.bytes.len() as u64;
        if bytes == 0 || upload.received_bytes.saturating_add(bytes) > upload.total_bytes {
            return Err(InvalidReason::PageIndex);
        }
        upload.received_bytes += bytes;
        upload.pages.insert(index, page);
        Ok(upload.progress())
    }

    /// Takes a complete upload off the route for ingestion. An incomplete
    /// upload stays staged so the missing pages can still arrive.
    fn take_complete(
        &mut self,
        route: RouteHandle,
        upload_id: &str,
    ) -> Result<Upload, InvalidReason> {
        let complete = self
            .upload_mut(route, upload_id)
            .ok_or(InvalidReason::UploadNotFound)?
            .is_complete();
        if !complete {
            return Err(InvalidReason::PageIndex);
        }
        self.take(route).ok_or(InvalidReason::UploadNotFound)
    }
}

/// Concatenates the pages in index order and ingests the result when it
/// hashes to the declared digest; the mismatch leaves nothing in the kernel.
fn finish_upload(store: &KernelStore, upload: Upload) -> Result<ArtifactHandle, KernelOutcome> {
    let mut payload = Vec::with_capacity(usize::try_from(upload.total_bytes).unwrap_or(0));
    for page in upload.pages.into_values() {
        payload.extend_from_slice(&page.bytes);
    }
    if sha256_hex(&payload) != upload.payload_digest {
        return Err(KernelOutcome::invalid(InvalidReason::PayloadDigest));
    }
    let request = ArtifactIngestRequest {
        payload,
        ..upload.request
    };
    store
        .ingest_artifact(request)
        .map_err(|error| KernelOutcome::from(error.kind()))
}

impl McHandler {
    pub(crate) async fn handle_kernel_ingest_begin(
        &self,
        channel: RouteHandle,
        request: &Value,
    ) -> PreparedOutcome {
        let scope = match self.kernel_route_scope(channel, request, BEGIN) {
            Ok(scope) => scope,
            Err(outcome) => return outcome,
        };
        let parsed = match serde_json::from_value::<BeginRequest>(request.clone()) {
            Ok(parsed) => parsed,
            Err(error) => return crate::invalid_params_error(format!("invalid {BEGIN}: {error}")),
        };
        if parsed.upload_id.is_empty() || parsed.upload_id.len() > MAX_UPLOAD_ID_BYTES {
            return crate::invalid_params_error(format!(
                "{BEGIN} upload_id must be 1..={MAX_UPLOAD_ID_BYTES} bytes"
            ));
        }
        if !is_sha256_hex(&parsed.payload_digest) {
            return crate::invalid_params_error(format!(
                "{BEGIN} payload_digest must be lowercase sha256 hex"
            ));
        }
        if parsed.page_count == 0 || u64::from(parsed.page_count) > parsed.total_bytes {
            return crate::invalid_params_error(format!(
                "{BEGIN} page_count must be between 1 and total_bytes"
            ));
        }
        let Some(provider_egress) = parse_provider_egress(&parsed.request.provider_egress) else {
            return crate::invalid_params_error(format!(
                "{BEGIN} provider_egress must be remote_allowed or local_only"
            ));
        };
        if parsed.total_bytes > UPLOAD_ALLOWANCE_BYTES {
            return state_only(KernelOutcome::invalid(InvalidReason::PayloadTooLarge));
        }
        let artifact = parsed.request;
        let upload = Upload {
            upload_id: parsed.upload_id.clone(),
            total_bytes: parsed.total_bytes,
            page_count: parsed.page_count,
            payload_digest: parsed.payload_digest,
            received_bytes: 0,
            pages: BTreeMap::new(),
            request: ArtifactIngestRequest {
                intent: CommitIntent {
                    producer: parsed.intent.producer,
                    operation_key: scope.project.operation_key(&parsed.intent.operation_key),
                    request_digest: parsed.intent.request_digest,
                    actor: parsed.intent.actor,
                    cause: parsed.intent.cause,
                },
                payload: Vec::new(),
                evidence_id: artifact.evidence_id,
                object_id: artifact.object_id,
                object_kind: artifact.object_kind,
                domain_id: artifact.domain_id,
                source_kind: artifact.source_kind,
                source_id: artifact.source_id,
                source_revision: artifact.source_revision,
                media_type: artifact.media_type,
                retention_class: artifact.retention_class,
                retain_until: artifact.retain_until,
                asserted_sensitivity: artifact.asserted_sensitivity,
                provider_egress,
                provenance: artifact.provenance.map(|provenance| RepositoryProvenance {
                    repository_id: provenance.repository_id,
                    revision: provenance.revision,
                }),
            },
        };
        match self.kernel.uploads().begin(channel, upload) {
            Ok(()) => kernel_response(
                &KernelOutcome::Available,
                json!({"upload_id": parsed.upload_id, "page_bytes_max": PAGE_BYTES_MAX}),
            ),
            Err(BeginRejection::QueueFull) => {
                state_only(KernelOutcome::unavailable(UnavailableReason::QueueFull))
            }
        }
    }

    pub(crate) async fn handle_kernel_ingest_page(
        &self,
        channel: RouteHandle,
        request: &Value,
    ) -> PreparedOutcome {
        if let Err(outcome) = self.kernel_route_scope(channel, request, PAGE) {
            return outcome;
        }
        let parsed = match serde_json::from_value::<PageRequest>(request.clone()) {
            Ok(parsed) => parsed,
            Err(error) => return crate::invalid_params_error(format!("invalid {PAGE}: {error}")),
        };
        if !is_sha256_hex(&parsed.page_digest) {
            return crate::invalid_params_error(format!(
                "{PAGE} page_digest must be lowercase sha256 hex"
            ));
        }
        // Decoding and hashing a page is CPU work proportional to the frame,
        // so it runs off the async workers and before the coordinator lock.
        let decoded = blocking(move || {
            base64::engine::general_purpose::STANDARD
                .decode(parsed.bytes_base64.as_bytes())
                .map(|bytes| (parsed.upload_id, parsed.index, parsed.page_digest, bytes))
        })
        .await;
        let (upload_id, index, declared_digest, bytes) = match decoded {
            Ok(Ok(decoded)) => decoded,
            Ok(Err(_)) => {
                return crate::invalid_params_error(format!(
                    "{PAGE} bytes_base64 is not standard base64"
                ))
            }
            Err(outcome) => return state_only(outcome),
        };
        if bytes.len() as u64 > PAGE_BYTES_MAX {
            return state_only(KernelOutcome::invalid(InvalidReason::PageTooLarge));
        }
        let page = match blocking(move || (sha256_hex(&bytes), bytes)).await {
            Ok((digest, bytes)) if digest == declared_digest => Page { digest, bytes },
            Ok(_) => return state_only(KernelOutcome::invalid(InvalidReason::PageDigest)),
            Err(outcome) => return state_only(outcome),
        };
        match self
            .kernel
            .uploads()
            .stage(channel, &upload_id, index, page)
        {
            Ok(progress) => kernel_response(&KernelOutcome::Available, progress),
            Err(reason) => state_only(KernelOutcome::invalid(reason)),
        }
    }

    pub(crate) async fn handle_kernel_ingest_finish(
        &self,
        channel: RouteHandle,
        request: &Value,
    ) -> PreparedOutcome {
        let scope = match self.kernel_route_scope(channel, request, FINISH) {
            Ok(scope) => scope,
            Err(outcome) => return outcome,
        };
        let parsed = match serde_json::from_value::<FinishRequest>(request.clone()) {
            Ok(parsed) => parsed,
            Err(error) => return crate::invalid_params_error(format!("invalid {FINISH}: {error}")),
        };
        let upload = match self
            .kernel
            .uploads()
            .take_complete(channel, &parsed.upload_id)
        {
            Ok(upload) => upload,
            Err(reason) => return state_only(KernelOutcome::invalid(reason)),
        };
        let store = scope.store;
        match blocking(move || finish_upload(&store, upload)).await {
            Ok(Ok(handle)) => kernel_response(
                &KernelOutcome::Available,
                json!({
                    "upload_id": parsed.upload_id,
                    "handle": {"digest": handle.digest, "evidence_id": handle.evidence_id},
                }),
            ),
            Ok(Err(outcome)) | Err(outcome) => state_only(outcome),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(channel: u16) -> RouteHandle {
        RouteHandle { channel, epoch: 1 }
    }

    fn upload(id: &str, total_bytes: u64, page_count: u32, payload: &[u8]) -> Upload {
        Upload {
            upload_id: id.to_string(),
            total_bytes,
            page_count,
            payload_digest: sha256_hex(payload),
            received_bytes: 0,
            pages: BTreeMap::new(),
            request: ArtifactIngestRequest {
                intent: CommitIntent {
                    producer: "test".into(),
                    operation_key: id.into(),
                    request_digest: sha256_hex(payload),
                    actor: "test".into(),
                    cause: "test".into(),
                },
                payload: Vec::new(),
                evidence_id: "evidence".into(),
                object_id: "object".into(),
                object_kind: "evidence".into(),
                domain_id: "domain".into(),
                source_kind: "repository".into(),
                source_id: "src".into(),
                source_revision: 1,
                media_type: "text/plain".into(),
                retention_class: "canonical".into(),
                retain_until: None,
                asserted_sensitivity: Sensitivity::Normal,
                provider_egress: ProviderEgress::RemoteAllowed,
                provenance: None,
            },
        }
    }

    fn page(bytes: &[u8]) -> Page {
        Page {
            digest: sha256_hex(bytes),
            bytes: bytes.to_vec(),
        }
    }

    #[test]
    fn budget_admits_up_to_both_caps_and_releases_exactly_what_it_reserved() {
        let mut budget = StagingBudget::new(100, 2);
        assert!(budget.try_reserve(60));
        assert!(!budget.try_reserve(41), "bytes cap");
        assert!(budget.try_reserve(40));
        assert!(!budget.try_reserve(0), "pending cap");
        budget.release(60);
        assert_eq!((budget.total_bytes, budget.pending), (40, 1));
        assert!(budget.try_reserve(60));
        assert!(!budget.try_reserve(u64::MAX));
        assert_eq!(MAX_STAGED_BYTES, UPLOAD_ALLOWANCE_BYTES * 4);
        assert!(UPLOAD_ALLOWANCE_BYTES > MAX_PAYLOAD_BYTES as u64);
    }

    #[test]
    fn one_upload_per_route_and_pages_are_keyed_by_index() {
        let mut uploads = UploadCoordinator::default();
        let payload = b"abcdef";
        uploads.begin(route(1), upload("u", 6, 3, payload)).unwrap();
        assert!(matches!(
            uploads.begin(route(1), upload("v", 6, 3, payload)),
            Err(BeginRejection::QueueFull)
        ));
        assert_eq!(uploads.budget().pending, 1);

        assert_eq!(
            uploads.stage(route(1), "other", 0, page(b"ab")),
            Err(InvalidReason::UploadNotFound)
        );
        assert_eq!(
            uploads.stage(route(1), "u", 3, page(b"ab")),
            Err(InvalidReason::PageIndex)
        );
        // Out of order, then a duplicate of the same bytes, then a conflicting duplicate.
        let progress = uploads.stage(route(1), "u", 2, page(b"ef")).unwrap();
        assert_eq!(progress["received_bytes"], 2);
        uploads.stage(route(1), "u", 0, page(b"ab")).unwrap();
        let repeat = uploads.stage(route(1), "u", 0, page(b"ab")).unwrap();
        assert_eq!(repeat["received_bytes"], 4);
        assert_eq!(
            uploads.stage(route(1), "u", 0, page(b"xx")),
            Err(InvalidReason::PageDigest)
        );
        assert_eq!(
            uploads.take_complete(route(1), "u"),
            Err(InvalidReason::PageIndex)
        );
        // A page overrunning the declared total is a layout error.
        assert_eq!(
            uploads.stage(route(1), "u", 1, page(b"cde")),
            Err(InvalidReason::PageIndex)
        );
        uploads.stage(route(1), "u", 1, page(b"cd")).unwrap();
        let complete = uploads.take_complete(route(1), "u").unwrap();
        assert_eq!(
            complete.pages.keys().copied().collect::<Vec<_>>(),
            [0, 1, 2]
        );
        assert_eq!(uploads.budget(), StagingBudget::default());
    }

    #[test]
    fn discard_releases_the_declared_total_even_before_any_page_arrived() {
        let mut uploads = UploadCoordinator::default();
        uploads.begin(route(1), upload("u", 1000, 1, b"")).unwrap();
        uploads.begin(route(2), upload("v", 500, 1, b"")).unwrap();
        assert_eq!(uploads.budget().total_bytes, 1500);
        assert!(uploads.discard(route(1)));
        assert!(!uploads.discard(route(1)));
        assert_eq!(
            (uploads.budget().total_bytes, uploads.budget().pending),
            (500, 1)
        );
        uploads.clear();
        assert_eq!(uploads.budget(), StagingBudget::default());
    }

    #[test]
    fn allowance_leaves_the_size_verdict_to_the_kernel() {
        let mut uploads = UploadCoordinator::default();
        let over_cap = MAX_PAYLOAD_BYTES as u64 + 1;
        uploads
            .begin(route(1), upload("u", over_cap, 1, b""))
            .unwrap();
        assert_eq!(uploads.budget().total_bytes, over_cap);
    }

    impl PartialEq for Upload {
        fn eq(&self, other: &Self) -> bool {
            self.upload_id == other.upload_id
        }
    }

    impl std::fmt::Debug for Upload {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("Upload")
                .field("upload_id", &self.upload_id)
                .finish()
        }
    }
}
