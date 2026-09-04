//! `begin`, `page`, and `finish` transfer one artifact payload across the ring
//! in base64 pages and call `ingest_artifact` at `finish`.
//!
//! Pages stay in daemon memory keyed by the route that sent them; the kernel
//! sees nothing until `finish` hands it the assembled bytes.
//!
//! A route holds one upload at a time. Replacement by a later `begin`,
//! eviction after [`UPLOAD_STALE_AFTER`], and route teardown each return the
//! upload's declared size to the shared [`StagingBudget`].
//!
//! `finish` owns the size verdict: `begin` admits any total up to
//! [`UPLOAD_ALLOWANCE_BYTES`], which sits above [`MAX_PAYLOAD_BYTES`], so an
//! over-cap payload is refused by the kernel as `payload_too_large` after its
//! declared digest has been checked, the same way an in-process caller sees it.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use mc_core::claim_operation::is_lower_hex;
use mc_host::RouteHandle;
use mc_kernel::{
    ArtifactHandle, ArtifactIngestRequest, KernelStore, ProviderEgress, RepositoryProvenance,
    Sensitivity, MAX_PAYLOAD_BYTES,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::project::IntentRequest;
use super::{
    blocking, kernel_response, state_only, InvalidReason, KernelOpenCoordinator, KernelOutcome,
    UnavailableReason,
};
use crate::dispatch::PreparedOutcome;
use crate::{sha256_hex, McHandler};

const BEGIN: &str = "kernel.artifact.ingest.begin";
pub(crate) const PAGE: &str = "kernel.artifact.ingest.page";
const FINISH: &str = "kernel.artifact.ingest.finish";
/// Namespace of this route family's receipts within a project.
const RECEIPT_FAMILY: &str = "artifact_ingest";

const MIB: u64 = 1024 * 1024;
/// The largest total an upload may declare. It exceeds the kernel cap by one
/// page-sized margin so a payload one byte over the cap is staged whole and
/// refused by the kernel rather than by a route-local check.
pub const UPLOAD_ALLOWANCE_BYTES: u64 = MAX_PAYLOAD_BYTES as u64 + MIB;
/// Decoded bytes one page may carry. Encoded, a page of this size is about
/// 21.4 MiB, under the 32 MiB transform-class frame with room for the envelope.
pub const PAGE_BYTES_MAX: u64 = 16 * MIB;
/// Standard base64 text decoding to [`PAGE_BYTES_MAX`] bytes is at most this
/// long. Padded base64 spends four characters per three bytes, so the bound
/// already counts the trailing `=` padding; valid longer input represents
/// more decoded bytes and is rejected before decoding.
pub const PAGE_BASE64_BYTES_MAX: usize = (PAGE_BYTES_MAX as usize).div_ceil(3) * 4;
/// Pages one upload may declare. Every page costs a map node, a digest, and
/// its own allocation on top of the bytes it carries, and the staging budget
/// charges only the bytes, so the count is bounded on its own. An upload at
/// the allowance needs five pages of [`PAGE_BYTES_MAX`].
pub const PAGE_COUNT_MAX: u32 = 1024;
/// Uploads in flight across every route.
pub const MAX_PENDING_UPLOADS: usize = 4;
/// Declared bytes staged across every route; every pending upload may be at
/// the allowance at once.
pub const MAX_STAGED_BYTES: u64 = UPLOAD_ALLOWANCE_BYTES * MAX_PENDING_UPLOADS as u64;
/// Working bytes finishes hold beside their staged pages. A finish assembles
/// the payload as one buffer while its pages stay resident for a retry, and
/// the kernel holds a redacted copy of a UTF-8 payload while it prepares the
/// artifact. Every finish occupies a pending slot, so at most
/// [`MAX_PENDING_UPLOADS`] run at once, each at the allowance.
pub const FINISH_WORKING_BYTES_MAX: u64 = 2 * MAX_STAGED_BYTES;
/// Page bytes in flight across every route: a page's encoded text and its
/// decoded bytes both live on the worker until the page is staged, and until
/// then neither is charged to the staging budget or any upload, so concurrent
/// page requests are bounded here. Enough for one full page per pending
/// upload at once.
pub const PAGE_DECODE_BYTES_MAX: u64 =
    (PAGE_BASE64_BYTES_MAX as u64 + PAGE_BYTES_MAX) * MAX_PENDING_UPLOADS as u64;
/// Page jobs in flight across every route. A tiny page charges almost no
/// bytes but still holds a blocking-pool worker and its frame, so the count is
/// bounded on its own: four concurrent pages per pending upload.
pub const PAGE_DECODE_JOBS_MAX: usize = 4 * MAX_PENDING_UPLOADS;
/// Uploads are evicted after this idle interval.
pub const UPLOAD_STALE_AFTER: Duration = Duration::from_secs(10 * 60);
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
    is_lower_hex(value, 64)
}

/// An empty artifact is declared as zero bytes in zero pages and completes at
/// `begin`; every other layout needs at least one byte per page and at most
/// [`PAGE_BYTES_MAX`] bytes per page.
fn layout_is_possible(total_bytes: u64, page_count: u32) -> bool {
    if page_count > PAGE_COUNT_MAX {
        return false;
    }
    let page_count = u64::from(page_count);
    if total_bytes == 0 {
        return page_count == 0;
    }
    page_count >= 1 && page_count <= total_bytes && total_bytes <= page_count * PAGE_BYTES_MAX
}

struct Page {
    digest: String,
    bytes: Vec<u8>,
}

/// Why a page's bytes were refused before staging, in the order the checks run.
enum PageRejection {
    NotBase64,
    TooLarge,
    DigestMismatch,
}

/// One route's in-flight upload: the declared layout, the pages received so
/// far by index, and the request the assembled bytes will be ingested under.
struct Upload {
    upload_id: String,
    /// Assigned by the coordinator at `begin`; a page decoded against one
    /// upload is staged only into that same upload.
    generation: u64,
    total_bytes: u64,
    page_count: u32,
    payload_digest: String,
    received_bytes: u64,
    pages: BTreeMap<u32, Page>,
    request: ArtifactIngestRequest,
    last_activity: Instant,
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

    /// Whether `other` declares the same upload: the same layout, digest, and
    /// ingestion request. Only such a `begin` may resume this upload's pages.
    fn declares_same(&self, other: &Upload) -> bool {
        self.upload_id == other.upload_id
            && self.total_bytes == other.total_bytes
            && self.page_count == other.page_count
            && self.payload_digest == other.payload_digest
            && self.request == other.request
    }
}

/// Route-keyed uploads plus the budget they draw on. Held behind one mutex so
/// a reservation and the upload it admits change together.
pub(crate) struct UploadCoordinator {
    budget: StagingBudget,
    uploads: HashMap<RouteHandle, Upload>,
    /// The generation of the newest upload each bound route has begun. It
    /// outlives the upload's removal so that a finish which took an earlier
    /// generation cannot restore it over a newer one; the route's unbind
    /// drops the entry.
    latest_generation: HashMap<RouteHandle, u64>,
    stale_after: Duration,
    next_generation: u64,
    /// Decoded page bytes currently in flight, bounded by `decode_max`.
    decoding_bytes: u64,
    decode_max: u64,
    /// Page jobs currently in flight, bounded by `decode_jobs_max`.
    decoding_jobs: usize,
    decode_jobs_max: usize,
}

impl Default for UploadCoordinator {
    fn default() -> Self {
        Self {
            budget: StagingBudget::default(),
            uploads: HashMap::new(),
            latest_generation: HashMap::new(),
            stale_after: UPLOAD_STALE_AFTER,
            next_generation: 1,
            decoding_bytes: 0,
            decode_max: PAGE_DECODE_BYTES_MAX,
            decoding_jobs: 0,
            decode_jobs_max: PAGE_DECODE_JOBS_MAX,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum BeginRejection {
    QueueFull,
}

enum BeginOutcome {
    Started,
    Resumed(Value),
}

impl UploadCoordinator {
    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn budget(&self) -> StagingBudget {
        self.budget
    }

    fn begin(
        &mut self,
        route: RouteHandle,
        mut upload: Upload,
        now: Instant,
    ) -> Result<BeginOutcome, BeginRejection> {
        self.evict_stale(now);
        if let Some(existing) = self.uploads.get_mut(&route) {
            // A `begin` that reuses the id but changes the declaration is a
            // new upload: resuming it would ingest the retained pages under
            // the earlier request's evidence id, class, and retention.
            if existing.declares_same(&upload) {
                existing.last_activity = now;
                return Ok(BeginOutcome::Resumed(existing.progress()));
            }
            self.take(route);
        }
        if !self.budget.try_reserve(upload.total_bytes) {
            return Err(BeginRejection::QueueFull);
        }
        upload.generation = self.next_generation;
        self.next_generation += 1;
        self.latest_generation.insert(route, upload.generation);
        self.uploads.insert(route, upload);
        Ok(BeginOutcome::Started)
    }

    fn evict_stale(&mut self, now: Instant) {
        let stale: Vec<RouteHandle> = self
            .uploads
            .iter()
            .filter(|(_, upload)| {
                now.saturating_duration_since(upload.last_activity) >= self.stale_after
            })
            .map(|(route, _)| *route)
            .collect();
        for route in stale {
            self.take(route);
        }
    }

    fn upload_mut(&mut self, route: RouteHandle, upload_id: &str) -> Option<&mut Upload> {
        self.uploads
            .get_mut(&route)
            .filter(|upload| upload.upload_id == upload_id)
    }

    /// Whether a page at `index` may be staged, answering the generation of
    /// the upload it would join. Decoding happens between this check and
    /// `stage`, and a `begin` in that gap may replace the upload under the
    /// same id; the generation is what `stage` compares to refuse the page.
    fn accepts_page(
        &mut self,
        route: RouteHandle,
        upload_id: &str,
        index: u32,
        now: Instant,
    ) -> Result<u64, InvalidReason> {
        let upload = self
            .upload_mut(route, upload_id)
            .ok_or(InvalidReason::UploadNotFound)?;
        if index >= upload.page_count {
            return Err(InvalidReason::PageIndex);
        }
        // Accepting the page is activity: the decode that follows must not
        // lose the upload to a concurrent `begin`'s stale eviction.
        upload.last_activity = now;
        Ok(upload.generation)
    }

    /// Removes the route's upload and returns its declared size to the budget.
    /// Answers whether an upload was in flight. The route is going away, so a
    /// finish still running for it can no longer restore anything either.
    pub(crate) fn discard(&mut self, route: RouteHandle) -> bool {
        self.latest_generation.remove(&route);
        self.take(route).is_some()
    }

    fn take(&mut self, route: RouteHandle) -> Option<Upload> {
        let upload = self.uploads.remove(&route)?;
        self.budget.release(upload.total_bytes);
        Some(upload)
    }

    fn release(&mut self, bytes: u64) {
        self.budget.release(bytes);
    }

    /// Admits one page job of `bytes` when both the in-flight byte total and
    /// the job count stay under their caps.
    fn reserve_decode(&mut self, bytes: u64) -> bool {
        if self.decoding_jobs >= self.decode_jobs_max {
            return false;
        }
        match self.decoding_bytes.checked_add(bytes) {
            Some(total) if total <= self.decode_max => {
                self.decoding_bytes = total;
                self.decoding_jobs += 1;
                true
            }
            _ => false,
        }
    }

    fn release_decode(&mut self, bytes: u64) {
        self.decoding_bytes = self.decoding_bytes.saturating_sub(bytes);
        self.decoding_jobs = self.decoding_jobs.saturating_sub(1);
    }

    /// An upload already handed out by `take_complete` is no longer in the
    /// map, so its reservation outlives this call until the finish handler
    /// releases it.
    pub(crate) fn clear(&mut self) {
        let routes: Vec<RouteHandle> = self.uploads.keys().copied().collect();
        for route in routes {
            self.take(route);
        }
        // A finish still running for a cleared route must not restore its
        // upload either: the transition drops every upload, held or not.
        self.latest_generation.clear();
    }

    /// Stages `page` under `index`. A page already held under that index with
    /// the same digest is acknowledged without being stored twice.
    fn stage(
        &mut self,
        route: RouteHandle,
        upload_id: &str,
        generation: u64,
        index: u32,
        page: Page,
        now: Instant,
    ) -> Result<Value, InvalidReason> {
        let upload = self
            .upload_mut(route, upload_id)
            .filter(|upload| upload.generation == generation)
            .ok_or(InvalidReason::UploadNotFound)?;
        if index >= upload.page_count {
            return Err(InvalidReason::PageIndex);
        }
        if let Some(existing) = upload.pages.get(&index) {
            if existing.digest == page.digest {
                upload.last_activity = now;
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
        upload.last_activity = now;
        Ok(upload.progress())
    }

    /// Keeps the reservation: the pages stay resident until the finish work
    /// drops them, so the caller releases `total_bytes` only afterwards.
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
        self.uploads
            .remove(&route)
            .ok_or(InvalidReason::UploadNotFound)
    }

    /// Puts back an upload `take_complete` handed out whose finish work failed
    /// retryably, so a later `finish` retries without the pages being resent.
    /// The upload's reservation is still charged; the caller keeps it charged
    /// when the upload is held again and releases it when the upload comes
    /// back because the route has begun another one in the meantime.
    fn restore(&mut self, route: RouteHandle, mut upload: Upload, now: Instant) -> Option<Upload> {
        // A newer upload that has since begun on this route supersedes the
        // returning one, whether or not it is still in the map.
        if self.uploads.contains_key(&route)
            || self.latest_generation.get(&route) != Some(&upload.generation)
        {
            return Some(upload);
        }
        upload.last_activity = now;
        self.uploads.insert(route, upload);
        None
    }
}

/// Releases an upload's staging reservation when dropped. The guard travels
/// into the blocking finish work with the payload, so the release happens
/// when that work ends, whether or not the handler future that spawned it is
/// still being polled: a dropped `spawn_blocking` handle does not stop its
/// worker, and a handler cancelled mid-finish would otherwise never release.
struct StagingReservation {
    kernel: Arc<KernelOpenCoordinator>,
    /// `None` once the charge has been handed back to an upload the
    /// coordinator holds again; `release` counts a pending slot as well as
    /// bytes, so the guard must then release nothing at all.
    bytes: Option<u64>,
}

impl StagingReservation {
    fn keep(mut self) {
        self.bytes = None;
    }
}

impl Drop for StagingReservation {
    fn drop(&mut self) {
        if let Some(bytes) = self.bytes {
            self.kernel.uploads().release(bytes);
        }
    }
}

/// Holds a share of [`PAGE_DECODE_BYTES_MAX`] from before a page is decoded
/// until it is staged or refused.
struct DecodeReservation {
    kernel: Arc<KernelOpenCoordinator>,
    bytes: u64,
}

impl Drop for DecodeReservation {
    fn drop(&mut self) {
        self.kernel.uploads().release_decode(self.bytes);
    }
}

enum FinishOutcome<Held = Box<Upload>> {
    Ingested(ArtifactHandle),
    /// The payload or the request is wrong; the pages are dropped.
    Refused(KernelOutcome),
    /// The store could not take the artifact right now. `finish_upload` hands
    /// the pages back for the route to hold; once held, only the outcome
    /// remains.
    Retry(KernelOutcome, Held),
}

/// Concatenates the pages in index order and ingests the result when it
/// hashes to the declared digest; the mismatch leaves nothing in the kernel.
fn finish_upload(store: &KernelStore, upload: Upload) -> FinishOutcome {
    let mut payload = Vec::with_capacity(usize::try_from(upload.total_bytes).unwrap_or(0));
    for page in upload.pages.values() {
        payload.extend_from_slice(&page.bytes);
    }
    if sha256_hex(&payload) != upload.payload_digest {
        return FinishOutcome::Refused(KernelOutcome::invalid(InvalidReason::PayloadDigest));
    }
    let request = ArtifactIngestRequest {
        payload,
        ..upload.request.clone()
    };
    match store.ingest_artifact(request) {
        Ok(handle) => FinishOutcome::Ingested(handle),
        Err(error) if error.is_retriable() => {
            FinishOutcome::Retry(KernelOutcome::from(error.kind()), Box::new(upload))
        }
        Err(error) => FinishOutcome::Refused(KernelOutcome::from(error.kind())),
    }
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
        if !is_sha256_hex(&parsed.intent.request_digest) {
            return crate::invalid_params_error(format!(
                "{BEGIN} intent.request_digest must be lowercase sha256 hex"
            ));
        }
        if !layout_is_possible(parsed.total_bytes, parsed.page_count) {
            return crate::invalid_params_error(format!(
                "{BEGIN} page_count must be between 1 and min(total_bytes, {PAGE_COUNT_MAX}), \
                 and total_bytes at most page_count * {PAGE_BYTES_MAX}"
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
        let Some(intent) = parsed.intent.into_intent(&scope.project, RECEIPT_FAMILY) else {
            return crate::invalid_params_error(format!(
                "{BEGIN} intent.operation_key must not be blank"
            ));
        };
        let artifact = parsed.request;
        let upload = Upload {
            upload_id: parsed.upload_id.clone(),
            generation: 0,
            total_bytes: parsed.total_bytes,
            page_count: parsed.page_count,
            payload_digest: parsed.payload_digest,
            received_bytes: 0,
            pages: BTreeMap::new(),
            request: ArtifactIngestRequest {
                intent,
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
            last_activity: Instant::now(),
        };
        let mut body = match self.kernel.uploads().begin(channel, upload, Instant::now()) {
            Ok(BeginOutcome::Started) => json!({"upload_id": parsed.upload_id}),
            Ok(BeginOutcome::Resumed(progress)) => progress,
            Err(BeginRejection::QueueFull) => {
                return state_only(KernelOutcome::unavailable(UnavailableReason::QueueFull))
            }
        };
        body["page_bytes_max"] = json!(PAGE_BYTES_MAX);
        kernel_response(&KernelOutcome::Available, body)
    }

    pub(crate) async fn handle_kernel_ingest_page(
        &self,
        channel: RouteHandle,
        request: Value,
    ) -> PreparedOutcome {
        if let Err(outcome) = self.kernel_route_scope(channel, &request, PAGE) {
            return outcome;
        }
        let parsed = match serde_json::from_value::<PageRequest>(request) {
            Ok(parsed) => parsed,
            Err(error) => return crate::invalid_params_error(format!("invalid {PAGE}: {error}")),
        };
        if !is_sha256_hex(&parsed.page_digest) {
            return crate::invalid_params_error(format!(
                "{PAGE} page_digest must be lowercase sha256 hex"
            ));
        }
        if parsed.bytes_base64.len() > PAGE_BASE64_BYTES_MAX {
            return state_only(KernelOutcome::invalid(InvalidReason::PageTooLarge));
        }
        // The worker holds the encoded text and, once decoded, at most three
        // bytes per four characters beside it.
        let encoded_bytes = parsed.bytes_base64.len() as u64;
        let decode_bytes = encoded_bytes + encoded_bytes.div_ceil(4) * 3;
        let generation = {
            let mut uploads = self.kernel.uploads();
            let generation = match uploads.accepts_page(
                channel,
                &parsed.upload_id,
                parsed.index,
                Instant::now(),
            ) {
                Ok(generation) => generation,
                Err(reason) => return state_only(KernelOutcome::invalid(reason)),
            };
            if !uploads.reserve_decode(decode_bytes) {
                return state_only(KernelOutcome::unavailable(UnavailableReason::QueueFull));
            }
            generation
        };
        let decoding = DecodeReservation {
            kernel: Arc::clone(&self.kernel),
            bytes: decode_bytes,
        };
        // Decoding and hashing a page is CPU work proportional to the frame,
        // so both run in one hop off the async workers and before the
        // coordinator lock. The reservation rides in the job's result: a
        // dropped `spawn_blocking` handle does not stop its worker, so a
        // cancelled handler must not release the charge while the worker still
        // holds the bytes.
        let decoded = blocking(move || {
            let page = base64_simd::STANDARD
                .decode_to_vec(parsed.bytes_base64.as_bytes())
                .map_err(|_| PageRejection::NotBase64)
                .and_then(|bytes| {
                    if bytes.len() as u64 > PAGE_BYTES_MAX {
                        return Err(PageRejection::TooLarge);
                    }
                    let digest = sha256_hex(&bytes);
                    if digest != parsed.page_digest {
                        return Err(PageRejection::DigestMismatch);
                    }
                    Ok((parsed.upload_id, parsed.index, Page { digest, bytes }))
                });
            (page, decoding)
        })
        .await;
        let (upload_id, index, page, _decoding) = match decoded {
            Ok((Ok((upload_id, index, page)), decoding)) => (upload_id, index, page, decoding),
            Ok((Err(PageRejection::NotBase64), _)) => {
                return crate::invalid_params_error(format!(
                    "{PAGE} bytes_base64 is not standard base64"
                ))
            }
            Ok((Err(PageRejection::TooLarge), _)) => {
                return state_only(KernelOutcome::invalid(InvalidReason::PageTooLarge))
            }
            Ok((Err(PageRejection::DigestMismatch), _)) => {
                return state_only(KernelOutcome::invalid(InvalidReason::PageDigest))
            }
            Err(outcome) => return state_only(outcome),
        };
        // Bound to a local so the coordinator guard is released before the
        // decode reservation's drop takes the same lock.
        let staged = self.kernel.uploads().stage(
            channel,
            &upload_id,
            generation,
            index,
            page,
            Instant::now(),
        );
        match staged {
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
        let reservation = StagingReservation {
            kernel: Arc::clone(&self.kernel),
            bytes: Some(upload.total_bytes),
        };
        let store = scope.store;
        let kernel = Arc::clone(&self.kernel);
        // Everything that must happen to the upload happens on the worker: a
        // handler cancelled here drops the worker's result unread, so a
        // retryable finish restores the upload before the worker returns and
        // the reservation guard rides in the result to release otherwise.
        let finished = blocking(move || {
            let outcome = finish_upload(&store, upload);
            let outcome: FinishOutcome<()> = match outcome {
                FinishOutcome::Retry(outcome, upload) => {
                    if kernel
                        .uploads()
                        .restore(channel, *upload, Instant::now())
                        .is_none()
                    {
                        reservation.keep();
                    }
                    return (FinishOutcome::Retry(outcome, ()), None);
                }
                FinishOutcome::Ingested(handle) => FinishOutcome::Ingested(handle),
                FinishOutcome::Refused(outcome) => FinishOutcome::Refused(outcome),
            };
            (outcome, Some(reservation))
        })
        .await;
        match finished {
            Ok((FinishOutcome::Ingested(handle), _reservation)) => kernel_response(
                &KernelOutcome::Available,
                json!({
                    "upload_id": parsed.upload_id,
                    "handle": {"digest": handle.digest, "evidence_id": handle.evidence_id},
                }),
            ),
            Ok((FinishOutcome::Refused(outcome) | FinishOutcome::Retry(outcome, ()), _)) => {
                state_only(outcome)
            }
            Err(outcome) => state_only(outcome),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use mc_kernel::CommitIntent;

    fn route(channel: u16) -> RouteHandle {
        RouteHandle { channel, epoch: 1 }
    }

    fn upload(id: &str, total_bytes: u64, page_count: u32, payload: &[u8]) -> Upload {
        upload_at(id, total_bytes, page_count, payload, Instant::now())
    }

    fn upload_at(
        id: &str,
        total_bytes: u64,
        page_count: u32,
        payload: &[u8],
        last_activity: Instant,
    ) -> Upload {
        Upload {
            upload_id: id.to_string(),
            generation: 0,
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
            last_activity,
        }
    }

    fn page(bytes: &[u8]) -> Page {
        Page {
            digest: sha256_hex(bytes),
            bytes: bytes.to_vec(),
        }
    }

    fn started(outcome: Result<BeginOutcome, BeginRejection>) {
        assert!(matches!(outcome, Ok(BeginOutcome::Started)));
    }

    /// The live generation of the route's upload, as a page handler learns it.
    fn generation(uploads: &UploadCoordinator, route: RouteHandle, upload_id: &str) -> u64 {
        uploads
            .uploads
            .get(&route)
            .filter(|upload| upload.upload_id == upload_id)
            .map(|upload| upload.generation)
            .unwrap()
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
    fn digests_must_be_lowercase_hex() {
        let lower = sha256_hex(b"x");
        assert!(is_sha256_hex(&lower));
        assert!(!is_sha256_hex(&lower.to_uppercase()));
        assert!(!is_sha256_hex(&lower[..63]));
    }

    #[test]
    fn a_layout_is_possible_only_when_its_pages_can_sum_to_the_total() {
        assert!(layout_is_possible(1, 1));
        assert!(layout_is_possible(PAGE_BYTES_MAX, 1));
        assert!(layout_is_possible(PAGE_BYTES_MAX * 4 + 1, 5));
        assert!(!layout_is_possible(PAGE_BYTES_MAX + 1, 1));
        assert!(!layout_is_possible(MAX_PAYLOAD_BYTES as u64, 1));
        assert!(layout_is_possible(0, 0));
        assert!(!layout_is_possible(0, 1));
        assert!(!layout_is_possible(5, 0));
        assert!(!layout_is_possible(5, 6));
        assert!(layout_is_possible(PAGE_COUNT_MAX as u64, PAGE_COUNT_MAX));
        assert!(!layout_is_possible(
            PAGE_COUNT_MAX as u64 + 1,
            PAGE_COUNT_MAX + 1
        ));
        assert!(UPLOAD_ALLOWANCE_BYTES <= PAGE_COUNT_MAX as u64 * PAGE_BYTES_MAX);
    }

    #[test]
    fn the_encoded_page_bound_admits_one_full_page() {
        let engine = base64::engine::general_purpose::STANDARD;
        let at_cap = vec![0u8; PAGE_BYTES_MAX as usize];
        assert_eq!(engine.encode(&at_cap).len(), PAGE_BASE64_BYTES_MAX);
        let over = vec![0u8; PAGE_BYTES_MAX as usize + 3];
        assert!(engine.encode(&over).len() > PAGE_BASE64_BYTES_MAX);
        let decoded = engine
            .decode(&engine.encode(&at_cap)[..PAGE_BASE64_BYTES_MAX])
            .unwrap();
        assert_eq!(decoded.len(), PAGE_BYTES_MAX as usize);
    }

    #[test]
    fn pages_are_keyed_by_index_and_finish_keeps_the_reservation_until_released() {
        let mut uploads = UploadCoordinator::default();
        let now = Instant::now();
        let payload = b"abcdef";
        started(uploads.begin(route(1), upload("u", 6, 3, payload), now));
        assert_eq!(uploads.budget().pending, 1);

        assert_eq!(
            uploads.accepts_page(route(1), "other", 0, now),
            Err(InvalidReason::UploadNotFound)
        );
        assert_eq!(
            uploads.accepts_page(route(2), "u", 0, now),
            Err(InvalidReason::UploadNotFound)
        );
        assert_eq!(
            uploads.accepts_page(route(1), "u", 3, now),
            Err(InvalidReason::PageIndex)
        );
        assert!(uploads.accepts_page(route(1), "u", 2, now).is_ok());
        assert_eq!(
            uploads.stage(route(1), "other", 1, 0, page(b"ab"), now),
            Err(InvalidReason::UploadNotFound)
        );
        // A page decoded against an earlier generation of this id is refused.
        assert_eq!(
            uploads.stage(
                route(1),
                "u",
                generation(&uploads, route(1), "u") + 1,
                0,
                page(b"ab"),
                now
            ),
            Err(InvalidReason::UploadNotFound)
        );
        assert_eq!(
            uploads.stage(
                route(1),
                "u",
                generation(&uploads, route(1), "u"),
                3,
                page(b"ab"),
                now
            ),
            Err(InvalidReason::PageIndex)
        );
        let progress = uploads
            .stage(
                route(1),
                "u",
                generation(&uploads, route(1), "u"),
                2,
                page(b"ef"),
                now,
            )
            .unwrap();
        assert_eq!(progress["received_bytes"], 2);
        uploads
            .stage(
                route(1),
                "u",
                generation(&uploads, route(1), "u"),
                0,
                page(b"ab"),
                now,
            )
            .unwrap();
        let repeat = uploads
            .stage(
                route(1),
                "u",
                generation(&uploads, route(1), "u"),
                0,
                page(b"ab"),
                now,
            )
            .unwrap();
        assert_eq!(repeat["received_bytes"], 4);
        assert_eq!(
            uploads.stage(
                route(1),
                "u",
                generation(&uploads, route(1), "u"),
                0,
                page(b"xx"),
                now
            ),
            Err(InvalidReason::PageDigest)
        );
        assert_eq!(
            uploads.take_complete(route(1), "u"),
            Err(InvalidReason::PageIndex)
        );
        assert_eq!(
            uploads.stage(
                route(1),
                "u",
                generation(&uploads, route(1), "u"),
                1,
                page(b"cde"),
                now
            ),
            Err(InvalidReason::PageIndex)
        );
        uploads
            .stage(
                route(1),
                "u",
                generation(&uploads, route(1), "u"),
                1,
                page(b"cd"),
                now,
            )
            .unwrap();
        let complete = uploads.take_complete(route(1), "u").unwrap();
        assert_eq!(
            complete.pages.keys().copied().collect::<Vec<_>>(),
            [0, 1, 2]
        );
        assert_eq!(
            uploads.take_complete(route(1), "u"),
            Err(InvalidReason::UploadNotFound)
        );
        assert_eq!(
            (uploads.budget().total_bytes, uploads.budget().pending),
            (6, 1)
        );
        uploads.clear();
        assert_eq!(
            (uploads.budget().total_bytes, uploads.budget().pending),
            (6, 1)
        );
        uploads.release(complete.total_bytes);
        assert_eq!(uploads.budget(), StagingBudget::default());
    }

    #[test]
    fn a_kept_reservation_releases_neither_bytes_nor_the_pending_slot() {
        let kernel = Arc::new(KernelOpenCoordinator::new());
        let now = Instant::now();
        started(
            kernel
                .uploads()
                .begin(route(1), upload("u", 2, 1, b"ab"), now),
        );
        let charged = |kernel: &KernelOpenCoordinator| {
            let budget = kernel.uploads().budget();
            (budget.total_bytes, budget.pending)
        };
        let guard = StagingReservation {
            kernel: Arc::clone(&kernel),
            bytes: Some(2),
        };
        guard.keep();
        assert_eq!(charged(&kernel), (2, 1));
        let guard = StagingReservation {
            kernel: Arc::clone(&kernel),
            bytes: Some(2),
        };
        drop(guard);
        assert_eq!(charged(&kernel), (0, 0));
    }

    #[test]
    fn a_restored_upload_keeps_its_pages_and_yields_to_a_newer_begin() {
        let mut uploads = UploadCoordinator::default();
        let now = Instant::now();
        started(uploads.begin(route(1), upload("u", 2, 1, b"ab"), now));
        uploads
            .stage(
                route(1),
                "u",
                generation(&uploads, route(1), "u"),
                0,
                page(b"ab"),
                now,
            )
            .unwrap();
        let complete = uploads.take_complete(route(1), "u").unwrap();
        assert!(uploads.restore(route(1), complete, now).is_none());
        assert_eq!(
            (uploads.budget().total_bytes, uploads.budget().pending),
            (2, 1)
        );
        let again = uploads.take_complete(route(1), "u").unwrap();
        assert_eq!(again.pages.len(), 1);

        // The route began another upload while the finish work ran, so the
        // finished one comes back and its reservation is the caller's to drop.
        started(uploads.begin(route(1), upload("v", 3, 1, b"xyz"), now));
        let returned = uploads.restore(route(1), again, now).unwrap();
        assert_eq!(returned.upload_id, "u");
        assert_eq!(
            (uploads.budget().total_bytes, uploads.budget().pending),
            (5, 2)
        );
        uploads.release(returned.total_bytes);
        assert_eq!(
            (uploads.budget().total_bytes, uploads.budget().pending),
            (3, 1)
        );

        // A newer upload under the same id that began and finished while the
        // older finish ran leaves the map empty, but the older one still
        // comes back rather than taking the newer one's place.
        uploads
            .stage(
                route(1),
                "v",
                generation(&uploads, route(1), "v"),
                0,
                page(b"xyz"),
                now,
            )
            .unwrap();
        let older = uploads.take_complete(route(1), "v").unwrap();
        started(uploads.begin(route(1), upload("v", 3, 1, b"xyz"), now));
        uploads
            .stage(
                route(1),
                "v",
                generation(&uploads, route(1), "v"),
                0,
                page(b"xyz"),
                now,
            )
            .unwrap();
        let newer = uploads.take_complete(route(1), "v").unwrap();
        assert!(uploads.restore(route(1), older, now).is_some());
        assert!(uploads.restore(route(1), newer, now).is_none());
        assert_eq!(
            (uploads.budget().total_bytes, uploads.budget().pending),
            (6, 2)
        );
    }

    #[test]
    fn begin_resumes_the_same_upload_and_replaces_a_different_one() {
        let mut uploads = UploadCoordinator::default();
        let now = Instant::now();
        started(uploads.begin(route(1), upload("u", 6, 3, b"abcdef"), now));
        uploads
            .stage(
                route(1),
                "u",
                generation(&uploads, route(1), "u"),
                0,
                page(b"ab"),
                now,
            )
            .unwrap();

        let resumed = uploads.begin(route(1), upload("u", 6, 3, b"abcdef"), now);
        let Ok(BeginOutcome::Resumed(progress)) = resumed else {
            panic!("same upload_id must resume");
        };
        assert_eq!(progress["received_pages"], 1);
        assert_eq!(progress["received_bytes"], 2);
        assert_eq!(
            (uploads.budget().total_bytes, uploads.budget().pending),
            (6, 1)
        );
        // The same id declaring other bytes is a replacement, not a resume.
        started(uploads.begin(route(1), upload("u", 6, 3, b"abcxyz"), now));
        assert_eq!(
            uploads
                .stage(
                    route(1),
                    "u",
                    generation(&uploads, route(1), "u"),
                    0,
                    page(b"ax"),
                    now
                )
                .unwrap()["received_pages"],
            1,
            "a retained page would have refused a different digest at index 0"
        );

        started(uploads.begin(route(1), upload("v", 10, 1, b""), now));
        assert_eq!(
            (uploads.budget().total_bytes, uploads.budget().pending),
            (10, 1)
        );
        assert_eq!(
            uploads.accepts_page(route(1), "u", 0, now),
            Err(InvalidReason::UploadNotFound)
        );
        assert!(uploads.accepts_page(route(1), "v", 0, now).is_ok());
    }

    #[test]
    fn a_replacement_the_budget_refuses_still_frees_the_route() {
        let mut uploads = UploadCoordinator {
            budget: StagingBudget::new(10, 4),
            ..UploadCoordinator::default()
        };
        let now = Instant::now();
        started(uploads.begin(route(1), upload("u", 6, 1, b""), now));
        assert_eq!(
            uploads.begin(route(1), upload("v", 11, 1, b""), now).err(),
            Some(BeginRejection::QueueFull)
        );
        assert_eq!(uploads.budget().pending, 0);
        assert!(!uploads.discard(route(1)));
    }

    #[test]
    fn only_the_budget_answers_queue_full() {
        let mut uploads = UploadCoordinator {
            budget: StagingBudget::new(100, 1),
            ..UploadCoordinator::default()
        };
        let now = Instant::now();
        started(uploads.begin(route(1), upload("u", 6, 1, b""), now));
        assert_eq!(
            uploads.begin(route(2), upload("v", 6, 1, b""), now).err(),
            Some(BeginRejection::QueueFull)
        );
        assert!(uploads.discard(route(1)));
        started(uploads.begin(route(2), upload("v", 6, 1, b""), now));
    }

    #[test]
    fn an_idle_upload_is_evicted_by_the_next_begin() {
        let mut uploads = UploadCoordinator {
            stale_after: Duration::ZERO,
            ..UploadCoordinator::default()
        };
        let now = Instant::now();
        started(uploads.begin(route(1), upload("u", 6, 3, b"abcdef"), now));
        assert_eq!(uploads.budget().pending, 1);
        started(uploads.begin(route(2), upload("v", 4, 1, b""), now));
        assert_eq!(
            (uploads.budget().total_bytes, uploads.budget().pending),
            (4, 1)
        );
        assert_eq!(
            uploads.accepts_page(route(1), "u", 0, now),
            Err(InvalidReason::UploadNotFound)
        );
    }

    #[test]
    fn activity_defers_staleness() {
        let mut uploads = UploadCoordinator {
            stale_after: Duration::from_secs(60),
            ..UploadCoordinator::default()
        };
        let began = Instant::now();
        started(uploads.begin(route(1), upload_at("u", 6, 3, b"abcdef", began), began));
        let later = began + Duration::from_secs(45);
        uploads
            .stage(
                route(1),
                "u",
                generation(&uploads, route(1), "u"),
                0,
                page(b"ab"),
                later,
            )
            .unwrap();
        let second = began + Duration::from_secs(70);
        started(uploads.begin(route(2), upload_at("v", 4, 1, b"", second), second));
        assert_eq!(uploads.budget().pending, 2);
        // A resume is activity too.
        let resumed = later + Duration::from_secs(50);
        assert!(matches!(
            uploads.begin(route(1), upload_at("u", 6, 3, b"abcdef", resumed), resumed),
            Ok(BeginOutcome::Resumed(_))
        ));
        let third = resumed + Duration::from_secs(59);
        started(uploads.begin(route(3), upload_at("w", 4, 1, b"", third), third));
        assert_eq!(uploads.budget().pending, 2);
        // Accepting a page is activity too, so the idle clock restarts at `third`.
        assert!(uploads.accepts_page(route(1), "u", 1, third).is_ok());
        let fourth = third + Duration::from_secs(60);
        started(uploads.begin(route(4), upload_at("x", 4, 1, b"", fourth), fourth));
        assert_eq!(
            uploads.accepts_page(route(1), "u", 1, fourth),
            Err(InvalidReason::UploadNotFound)
        );
    }

    #[test]
    fn page_decoding_is_bounded_by_bytes_and_by_jobs_and_released_exactly() {
        let mut uploads = UploadCoordinator {
            decode_max: 10,
            decode_jobs_max: 3,
            ..UploadCoordinator::default()
        };
        assert!(uploads.reserve_decode(6));
        assert!(!uploads.reserve_decode(5));
        assert!(uploads.reserve_decode(4));
        assert!(!uploads.reserve_decode(1));
        uploads.release_decode(6);
        assert!(uploads.reserve_decode(6));
        assert!(!uploads.reserve_decode(1));
        uploads.release_decode(10);
        assert!(uploads.reserve_decode(10));
        // Two jobs are in flight; the third fits and a fourth is refused even
        // at zero bytes.
        assert!(uploads.reserve_decode(0));
        assert!(!uploads.reserve_decode(0));
        uploads.release_decode(0);
        assert!(uploads.reserve_decode(0));
    }

    #[test]
    fn a_cleared_coordinator_refuses_to_restore_a_finish_it_no_longer_knows() {
        let mut uploads = UploadCoordinator::default();
        let now = Instant::now();
        started(uploads.begin(route(1), upload("u", 2, 1, b"ab"), now));
        uploads
            .stage(
                route(1),
                "u",
                generation(&uploads, route(1), "u"),
                0,
                page(b"ab"),
                now,
            )
            .unwrap();
        let complete = uploads.take_complete(route(1), "u").unwrap();
        uploads.clear();
        let returned = uploads.restore(route(1), complete, now).unwrap();
        uploads.release(returned.total_bytes);
        assert_eq!(uploads.budget(), StagingBudget::default());
    }

    #[test]
    fn discard_releases_the_declared_total_even_before_any_page_arrived() {
        let mut uploads = UploadCoordinator::default();
        let now = Instant::now();
        started(uploads.begin(route(1), upload("u", 1000, 1, b""), now));
        started(uploads.begin(route(2), upload("v", 500, 1, b""), now));
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
        started(uploads.begin(route(1), upload("u", over_cap, 1, b""), Instant::now()));
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
