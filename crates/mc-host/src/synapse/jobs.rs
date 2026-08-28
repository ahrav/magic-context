//! Bounded process-local batch jobs: deterministic idempotency, ephemeral
//! retention, opaque incarnation-fenced identifiers, and replayable
//! boundary-checked result cursors.
//!
//! Nothing here is durable. The TypeScript ledger owns crash recovery; a
//! host restart maps every old job to `module_restarted`, which is the
//! client's single resubmission rule.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use sha2::{Digest, Sha256};

use super::SynapseLimits;
use crate::wire::ByteCharge;

pub(crate) const MAX_ITEM_ID_BYTES: usize = 256;
pub(crate) const CONTENT_SHA256_BYTES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchItem {
    pub id: String,
    pub content_sha256: String,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct JobDescriptor {
    pub job_id: String,
    pub status: &'static str,
}

pub enum AdmitOutcome {
    /// Same retained key with a byte-identical canonical payload.
    Existing(JobDescriptor),
    /// Same retained key with a conflicting payload.
    Conflict,
    /// New job admitted; the caller must start exactly one worker for it.
    Admitted { job_id: String, seq: u64 },
    /// Admission capacity is exhausted and nothing evictable remains.
    Full,
    /// This request's result cannot fit the retained-result byte cap.
    ResultTooLarge,
    /// Shutdown already closed admission.
    Closed,
}

pub enum PollOutcome {
    /// Unknown, foreign-incarnation, expired, or evicted job.
    Restarted,
    /// The supplied request_key does not belong to this job.
    KeyMismatch,
    Pending {
        status: &'static str,
    },
    Failed {
        code: String,
        message: String,
    },
    Page(ResultPage),
    BadCursor,
}

pub struct ResultPage {
    /// Shared backing keeps concurrent polls from copying retained vectors
    /// before their output reservations are acquired.
    pub vectors: Vec<(String, String, Arc<[f32]>)>,
    pub done: bool,
    pub next_cursor: Option<String>,
}

enum JobState {
    Queued {
        items: Vec<BatchItem>,
    },
    Running,
    Ready {
        vectors: Vec<Arc<[f32]>>,
        boundaries: Vec<usize>,
    },
    Failed {
        code: String,
        message: String,
    },
}

struct Job {
    seq: u64,
    key: String,
    payload_digest: [u8; 32],
    /// `(id, content_sha256)` in request order; texts live in `state` only
    /// until inference replaces them with vectors.
    item_meta: Vec<(String, String)>,
    text_bytes: u64,
    dimensions: usize,
    reserved_result_bytes: u64,
    result_bytes: u64,
    state: JobState,
    completed_at: Option<Instant>,
    /// Resident-byte charge for this job's request inputs. Sized by
    /// [`job_input_bytes`] at admission, shrunk to [`Job::retained_input_bytes`]
    /// when the texts die, and released by dropping the job on removal,
    /// eviction, expiry, or clear.
    charge: ByteCharge,
}

impl Job {
    /// Logical request-input bytes still owned after the item texts die:
    /// both key copies and the id/hash metadata. String contents only;
    /// struct and hash-bucket overhead stay outside the accounting claim.
    fn retained_input_bytes(&self) -> usize {
        let meta: usize = self
            .item_meta
            .iter()
            .map(|(id, hash)| id.len() + hash.len())
            .sum();
        2 * self.key.len() + meta
    }

    fn status(&self) -> &'static str {
        match self.state {
            JobState::Queued { .. } => "queued",
            JobState::Running => "running",
            JobState::Ready { .. } => "ready",
            JobState::Failed { .. } => "failed",
        }
    }

    fn is_completed(&self) -> bool {
        matches!(self.state, JobState::Ready { .. } | JobState::Failed { .. })
    }
}

struct Jobs {
    by_key: HashMap<String, u64>,
    by_seq: HashMap<u64, Job>,
    next_seq: u64,
    queued_text_bytes: u64,
    retained_result_bytes: u64,
    closed: bool,
}

pub struct JobTable {
    limits: SynapseLimits,
    incarnation: String,
    inner: std::sync::Mutex<Jobs>,
}

/// Bytes `s` occupies inside a JSON string, excluding the delimiting quotes:
/// its escaped form, which is what a serialized body holds. Quotes,
/// backslashes, and control characters expand — a control character costs six
/// bytes as `\u00XX` — so a byte-length charge undercounts the body an output
/// reservation must fit.
pub(crate) fn escaped_string_bytes(s: &str) -> usize {
    serde_json::to_string(s)
        .expect("string serialization cannot fail")
        .len()
        .checked_sub(2)
        .expect("serialized JSON string includes quotes")
}

/// Whether a stored failure code's retry disposition is permanent
/// (protocol §7.5.1): an identical re-submission would deterministically
/// re-fail, so admission replays the stored failure instead of re-running
/// inference. Every other code is retryable or caller-policy, and an
/// identical re-submission replaces the failed job with a fresh attempt.
fn failure_is_permanent(code: &str) -> bool {
    matches!(
        code,
        "artifact_invalid"
            | "substitution_rejected"
            | "schema_violation"
            | "not_certified"
            | "probe_required"
            | "idempotency_conflict"
    )
}

fn digest_payload(key: &str, items: &[BatchItem]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    let mut update = |bytes: &[u8]| {
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    };
    update(key.as_bytes());
    for item in items {
        update(item.id.as_bytes());
        update(item.content_sha256.as_bytes());
        update(item.text.as_bytes());
    }
    hasher.finalize().into()
}

/// Logical request-input bytes a newly admitted job owns while queued: both
/// key copies (job field and table index), the queued item strings at their
/// allocated capacities, and the id/hash metadata copies. String contents
/// only; struct and hash-bucket overhead stay outside the accounting claim.
pub(crate) fn job_input_bytes(key: &str, items: &[BatchItem]) -> usize {
    let mut bytes = 2usize.saturating_mul(key.len());
    for item in items {
        bytes = bytes
            .saturating_add(item.id.capacity())
            .saturating_add(item.content_sha256.capacity())
            .saturating_add(item.text.capacity())
            // The admission-time metadata copies.
            .saturating_add(item.id.len())
            .saturating_add(item.content_sha256.len());
    }
    bytes
}

/// Charges detached from the table but not yet released. Releasing a permit
/// takes the byte budget's own waiter lock and wakes whoever is queued on it,
/// so it must happen after the table guard falls — never underneath it, where
/// it would nest a host-wide lock inside the one that serializes admission,
/// polling, publication, and shutdown. Dropping a `Job` here also frees its
/// retained vectors outside the lock, for the same reason `publish_ready`
/// builds them outside it.
#[derive(Default)]
struct Released {
    jobs: Vec<Job>,
    charges: Vec<ByteCharge>,
}

impl Released {
    fn job(&mut self, job: Option<Job>) {
        self.jobs.extend(job);
    }

    fn charge(&mut self, charge: ByteCharge) {
        if charge.bytes() > 0 {
            self.charges.push(charge);
        }
    }
}

fn result_bytes(item_count: usize, dimensions: usize, metadata_bytes: usize) -> Option<u64> {
    let vector_bytes = item_count
        .checked_mul(dimensions)?
        .checked_mul(std::mem::size_of::<f32>())?;
    vector_bytes
        .checked_add(metadata_bytes)
        .and_then(|bytes| u64::try_from(bytes).ok())
}

/// Worst retained bytes for a protocol-valid batch at one model dimension.
pub(crate) fn max_result_bytes(item_count: usize, dimensions: usize) -> Option<u64> {
    let metadata_bytes = item_count.checked_mul(MAX_ITEM_ID_BYTES + CONTENT_SHA256_BYTES)?;
    result_bytes(item_count, dimensions, metadata_bytes)
}

fn admitted_result_bytes(items: &[BatchItem], dimensions: usize) -> Option<u64> {
    let metadata_bytes = items.iter().try_fold(0usize, |total, item| {
        total
            .checked_add(item.id.len())?
            .checked_add(item.content_sha256.len())
    })?;
    result_bytes(items.len(), dimensions, metadata_bytes)
}

impl JobTable {
    /// Acquires the table lock, recovering from poisoning. A panic while
    /// the lock is held would otherwise brick the whole route: `sweep`
    /// runs at the top of every request, so one poisoned acquisition
    /// becomes a panic on every subsequent request until restart, and
    /// `AbandonGuard::drop` re-entering a poisoned lock during unwind
    /// would double-panic and abort the process. Recovered state may
    /// reflect a partially applied mutation from the panicking call;
    /// every operation on `Jobs` is defensive against missing or
    /// already-completed entries, and the expiry sweep bounds how long
    /// an inconsistent entry survives.
    fn lock_jobs(&self) -> std::sync::MutexGuard<'_, Jobs> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn new(limits: SynapseLimits) -> Self {
        let mut nonce = [0u8; 8];
        // The incarnation fence must be unpredictable across restarts, or a
        // stale job ID from a previous process could name a live job here.
        getrandom::getrandom(&mut nonce).expect("OS entropy for the job incarnation");
        Self {
            limits,
            incarnation: nonce.iter().map(|b| format!("{b:02x}")).collect(),
            inner: std::sync::Mutex::new(Jobs {
                by_key: HashMap::new(),
                by_seq: HashMap::new(),
                next_seq: 1,
                queued_text_bytes: 0,
                retained_result_bytes: 0,
                closed: false,
            }),
        }
    }

    fn job_id(&self, seq: u64) -> String {
        format!("{}-{seq}", self.incarnation)
    }

    fn parse_job_id(&self, job_id: &str) -> Option<u64> {
        let (incarnation, seq) = job_id.split_once('-')?;
        if incarnation != self.incarnation {
            return None;
        }
        // Canonical digits only: `+1`, `007`, and similar aliases of a live
        // sequence number must not resolve, or job IDs stop being opaque.
        if seq.is_empty() || seq.len() > 20 || !seq.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        if seq.len() > 1 && seq.starts_with('0') {
            return None;
        }
        seq.parse().ok()
    }

    /// Whether `key` names a retained job.
    pub fn key_is_retained(&self, key: &str) -> bool {
        // Declared before the guard so it drops after it: permits release
        // outside the table lock.
        let mut released = Released::default();
        let mut jobs = self.lock_jobs();
        self.sweep_expired(&mut jobs, &mut released);
        jobs.by_key.contains_key(key)
    }

    /// Admission with **no resident charge** — the job owns its key, queued
    /// item texts, and metadata copies with zero accounting, so nothing is
    /// ever released for them. Test-only: the host must never call this,
    /// because an uncharged job is precisely the untracked request-input
    /// ownership that [`JobTable::admit_charged`] exists to close.
    #[doc(hidden)]
    pub fn admit_uncharged_for_tests(
        &self,
        key: String,
        items: Vec<BatchItem>,
        dimensions: usize,
    ) -> AdmitOutcome {
        self.admit_charged(key, items, dimensions, &mut ByteCharge::none())
    }

    /// Admission that transfers a job-sized portion of `charge` into the new
    /// job under the same table lock that inserts it. Every non-`Admitted`
    /// outcome leaves `charge` with the caller, so a rejected, replayed,
    /// conflicting, full, or closed candidate never alters a retained job's
    /// charge.
    pub(crate) fn admit_charged(
        &self,
        key: String,
        items: Vec<BatchItem>,
        dimensions: usize,
        charge: &mut ByteCharge,
    ) -> AdmitOutcome {
        let digest = digest_payload(&key, &items);
        let text_bytes: u64 = items.iter().map(|item| item.text.len() as u64).sum();
        let result_bytes = admitted_result_bytes(&items, dimensions);
        let input_bytes = job_input_bytes(&key, &items);
        // Declared before the guard so it drops after it: permits release
        // outside the table lock.
        let mut released = Released::default();
        let mut jobs = self.lock_jobs();
        if jobs.closed {
            return AdmitOutcome::Closed;
        }
        self.sweep_expired(&mut jobs, &mut released);

        // A failed same-digest job a retry below may replace. Eviction is
        // deferred until every admission check has passed: a retry that
        // bounces off a full table (or an oversized result) must leave the
        // stored failure pollable rather than losing it to a rejection.
        let mut failed_replay = None;
        if let Some(seq) = jobs.by_key.get(&key).copied() {
            let job = jobs.by_seq.get(&seq).expect("keyed job exists");
            if job.payload_digest != digest {
                return AdmitOutcome::Conflict;
            }
            // A retryably-failed job is not a result worth replaying: the
            // retained failure exists so a poll can read the error, but an
            // identical re-submission is a retry, and returning `Existing`
            // would hold the key hostage until expiry and make the
            // protocol's retryable disposition a lie within the retention
            // window. A permanently-coded failure is the opposite case:
            // re-running the same payload deterministically re-fails, so
            // the stored failure replays instead of burning inference.
            match &job.state {
                JobState::Failed { code, .. } if !failure_is_permanent(code) => {
                    failed_replay = Some(seq);
                }
                _ => {
                    return AdmitOutcome::Existing(JobDescriptor {
                        job_id: self.job_id(seq),
                        status: job.status(),
                    });
                }
            }
        }

        let Some(result_bytes) = result_bytes else {
            return AdmitOutcome::ResultTooLarge;
        };
        if result_bytes > self.limits.max_retained_result_bytes {
            return AdmitOutcome::ResultTooLarge;
        }

        let admitted = jobs
            .by_seq
            .values()
            .filter(|job| !job.is_completed())
            .count();
        if admitted >= self.limits.max_queued_jobs
            || jobs.queued_text_bytes.saturating_add(text_bytes)
                > self.limits.max_queued_request_bytes
        {
            // Queued and running work is never evicted to admit new work,
            // so a full admission class rejects instead.
            return AdmitOutcome::Full;
        }

        // Every check passed: the retry replaces the failed job. Removed
        // before the insert below so the key's index entry is never
        // clobbered for a job that still lives in the table.
        if let Some(seq) = failed_replay {
            released.job(Self::remove(&mut jobs, seq));
        }

        let seq = jobs.next_seq;
        jobs.next_seq += 1;
        let item_meta = items
            .iter()
            .map(|item| (item.id.clone(), item.content_sha256.clone()))
            .collect();
        jobs.queued_text_bytes += text_bytes;
        jobs.by_key.insert(key.clone(), seq);
        jobs.by_seq.insert(
            seq,
            Job {
                seq,
                key,
                payload_digest: digest,
                item_meta,
                text_bytes,
                dimensions,
                reserved_result_bytes: result_bytes,
                result_bytes: 0,
                state: JobState::Queued { items },
                completed_at: None,
                charge: charge.split_or_take(input_bytes),
            },
        );
        AdmitOutcome::Admitted {
            job_id: self.job_id(seq),
            seq,
        }
    }

    /// Claims the queued inputs for inference. `None` means the job was
    /// cancelled by shutdown before its worker started.
    pub fn start(&self, seq: u64) -> Option<Vec<BatchItem>> {
        self.start_reserving(seq, false)
    }

    pub(crate) fn start_reserving(&self, seq: u64, reserve_result: bool) -> Option<Vec<BatchItem>> {
        let mut jobs = self.lock_jobs();
        let job = jobs.by_seq.get_mut(&seq)?;
        let JobState::Queued { items } = &mut job.state else {
            return None;
        };
        let items = std::mem::take(items);
        let reserved = if reserve_result {
            job.reserved_result_bytes
        } else {
            0
        };
        job.result_bytes = reserved;
        job.state = JobState::Running;
        jobs.retained_result_bytes += reserved;
        Some(items)
    }

    pub fn publish_ready(&self, seq: u64, vectors: Vec<Vec<f32>>) {
        // Converting Vec to Arc<[T]> copies the allocation. Keep that work
        // outside the global job-table lock so large inference results do not
        // block admission, polling, or shutdown bookkeeping.
        let vectors: Vec<Arc<[f32]>> = vectors.into_iter().map(Arc::from).collect();
        // Declared before the guard so it drops after it: permits release
        // outside the table lock.
        let mut released = Released::default();
        let mut jobs = self.lock_jobs();
        let Some(job) = jobs.by_seq.get_mut(&seq) else {
            return;
        };
        // An engine that returns the wrong item count must fail this one
        // job: pairing vectors with item_meta below indexes by position, and
        // a panic here would poison the table lock for every later caller,
        // including shutdown's close_admission. The engine trait is an open
        // seam, so the count cannot be assumed pre-validated.
        if vectors.len() != job.item_meta.len() {
            self.fail_job(
                &mut jobs,
                seq,
                "artifact_invalid".to_owned(),
                "inference returned a different item count".to_owned(),
                &mut released,
            );
            return;
        }
        if vectors.iter().any(|vector| vector.len() != job.dimensions) {
            self.fail_job(
                &mut jobs,
                seq,
                "artifact_invalid".to_owned(),
                "inference returned a different vector dimension".to_owned(),
                &mut released,
            );
            return;
        }
        let result_bytes = job.reserved_result_bytes;
        let needs_result_charge = job.result_bytes == 0;
        let text_bytes = job.text_bytes;
        job.text_bytes = 0;

        let boundaries = self.page_boundaries(&job.item_meta, &vectors);
        job.state = JobState::Ready {
            vectors,
            boundaries,
        };
        job.result_bytes = result_bytes;
        job.completed_at = Some(Instant::now());
        // The queued texts died with the worker's items; only the retained
        // key and metadata stay charged. The freed permits leave the lock
        // with `released` rather than being handed back underneath it.
        let retained = job.retained_input_bytes();
        let excess = job.charge.split_excess(retained);
        released.charge(excess);
        if needs_result_charge {
            jobs.retained_result_bytes += result_bytes;
        }
        jobs.queued_text_bytes -= text_bytes;
        self.enforce_retention(&mut jobs, Some(seq), &mut released);
    }

    pub fn publish_failed(&self, seq: u64, code: String, message: String) {
        // Declared before the guard so it drops after it: permits release
        // outside the table lock.
        let mut released = Released::default();
        let mut jobs = self.lock_jobs();
        self.fail_job(&mut jobs, seq, code, message, &mut released);
    }

    /// Terminal-failure bookkeeping shared by every failure path: queued
    /// text is released, the retention clock starts, and eviction runs.
    /// Idempotent on an already-completed job so a late abandonment guard
    /// cannot clobber a published result or its byte accounting.
    fn fail_job(
        &self,
        jobs: &mut Jobs,
        seq: u64,
        code: String,
        message: String,
        released: &mut Released,
    ) {
        let Some(job) = jobs.by_seq.get_mut(&seq) else {
            return;
        };
        if job.is_completed() {
            return;
        }
        let text_bytes = job.text_bytes;
        job.text_bytes = 0;
        jobs.retained_result_bytes -= job.result_bytes;
        job.result_bytes = 0;
        job.state = JobState::Failed { code, message };
        job.completed_at = Some(Instant::now());
        // Queued items (if the worker never started) and worker-owned texts
        // are both dead at this transition.
        let retained = job.retained_input_bytes();
        let excess = job.charge.split_excess(retained);
        released.charge(excess);
        jobs.queued_text_bytes -= text_bytes;
        self.enforce_retention(jobs, Some(seq), released);
    }

    pub fn poll(&self, job_id: &str, key: &str, cursor: Option<&str>) -> PollOutcome {
        // Declared before the guard so it drops after it: permits release
        // outside the table lock.
        let mut released = Released::default();
        let mut jobs = self.lock_jobs();
        self.sweep_expired(&mut jobs, &mut released);
        let Some(seq) = self.parse_job_id(job_id) else {
            return PollOutcome::Restarted;
        };
        let Some(job) = jobs.by_seq.get(&seq) else {
            return PollOutcome::Restarted;
        };
        if job.key != key {
            return PollOutcome::KeyMismatch;
        }
        match &job.state {
            JobState::Queued { .. } | JobState::Running => PollOutcome::Pending {
                status: job.status(),
            },
            JobState::Failed { code, message } => PollOutcome::Failed {
                code: code.clone(),
                message: message.clone(),
            },
            JobState::Ready {
                vectors,
                boundaries,
            } => {
                let offset = match cursor {
                    None => 0,
                    Some(cursor) => match self.parse_cursor(cursor, seq, boundaries) {
                        Some(offset) => offset,
                        None => return PollOutcome::BadCursor,
                    },
                };
                let next_boundary = boundaries
                    .iter()
                    .copied()
                    .find(|b| *b > offset)
                    .unwrap_or(vectors.len());
                let page = (offset..next_boundary)
                    .map(|index| {
                        let (id, hash) = &job.item_meta[index];
                        (id.clone(), hash.clone(), Arc::clone(&vectors[index]))
                    })
                    .collect();
                let done = next_boundary >= vectors.len();
                let next_cursor = (!done).then(|| format!("{}:{next_boundary}", self.job_id(seq)));
                PollOutcome::Page(ResultPage {
                    vectors: page,
                    done,
                    next_cursor,
                })
            }
        }
    }

    /// A cursor is valid only if this table issued it: right job, and an
    /// offset that is exactly one of the job's page boundaries. Re-reading
    /// an already-served page is allowed so a lost response can be retried.
    fn parse_cursor(&self, cursor: &str, seq: u64, boundaries: &[usize]) -> Option<usize> {
        let (job_id, offset) = cursor.rsplit_once(':')?;
        if self.parse_job_id(job_id) != Some(seq) {
            return None;
        }
        let offset: usize = offset.parse().ok()?;
        boundaries.contains(&offset).then_some(offset)
    }

    /// Worst-case JSON text bytes for one f32 component (sign, up to nine
    /// significant digits, exponent, separator).
    const ENCODED_BYTES_PER_COMPONENT: usize = 16;
    /// Fixed JSON envelope around one vector item (braces, field names,
    /// quotes, separators).
    const ENCODED_ITEM_OVERHEAD: usize = 64;

    /// Estimated encoded page cost of one result item. `hash` is the
    /// server-computed lowercase hexadecimal content digest and therefore
    /// needs no JSON escaping. Deliberately
    /// conservative: undercounting could split a ready job into a page whose
    /// JSON body exceeds the frame limit, which no cursor could ever serve.
    /// The response encoder reserves output from the same estimate, so it is
    /// also the upper bound on one item's serialized bytes.
    pub(crate) fn encoded_item_cost(vector_len: usize, id: &str, hash: &str) -> usize {
        debug_assert!(
            hash.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "content hash must be hexadecimal"
        );
        vector_len
            .checked_mul(Self::ENCODED_BYTES_PER_COMPONENT)
            .and_then(|bytes| bytes.checked_add(escaped_string_bytes(id)))
            .and_then(|bytes| bytes.checked_add(hash.len()))
            .and_then(|bytes| bytes.checked_add(Self::ENCODED_ITEM_OVERHEAD))
            .unwrap_or(usize::MAX)
    }

    fn page_boundaries(
        &self,
        item_meta: &[(String, String)],
        vectors: &[Arc<[f32]>],
    ) -> Vec<usize> {
        let mut boundaries = Vec::new();
        let mut count_in_page = 0usize;
        let mut bytes_in_page = 0usize;
        for (index, vector) in vectors.iter().enumerate() {
            let (id, hash) = &item_meta[index];
            let encoded = Self::encoded_item_cost(vector.len(), id, hash);
            if count_in_page > 0
                && (count_in_page >= self.limits.max_page_vectors
                    || bytes_in_page
                        .checked_add(encoded)
                        .is_none_or(|bytes| bytes > self.limits.max_page_encoded_bytes))
            {
                boundaries.push(index);
                count_in_page = 0;
                bytes_in_page = 0;
            }
            count_in_page += 1;
            bytes_in_page = bytes_in_page.saturating_add(encoded);
        }
        boundaries
    }

    /// Releases every expired retained job and its charge. The request path
    /// calls this when a resident reservation fails: every other sweep site
    /// (admission, poll, key lookup) sits after the reservation and is
    /// unreachable once the pool is exhausted, so without a pass here a
    /// charge already past its retention period could hold the pool below
    /// the minimum reservation and fail every request `queue_full` —
    /// including the ones that would have swept it.
    pub fn sweep(&self) {
        // Declared before the guard so it drops after it: permits release
        // outside the table lock.
        let mut released = Released::default();
        let mut jobs = self.lock_jobs();
        self.sweep_expired(&mut jobs, &mut released);
    }

    fn sweep_expired(&self, jobs: &mut Jobs, released: &mut Released) {
        let now = Instant::now();
        let expired: Vec<u64> = jobs
            .by_seq
            .values()
            .filter(|job| {
                job.completed_at
                    .is_some_and(|at| now.duration_since(at) >= self.limits.retention)
            })
            .map(|job| job.seq)
            .collect();
        for seq in expired {
            released.job(Self::remove(jobs, seq));
        }
    }

    /// Evicts oldest-completed jobs until the just-published job fits the
    /// retained count and byte caps. The publishing job itself is exempt
    /// until something newer displaces it.
    fn enforce_retention(&self, jobs: &mut Jobs, keep: Option<u64>, released: &mut Released) {
        loop {
            let retained = jobs
                .by_seq
                .values()
                .filter(|job| job.is_completed())
                .count();
            let over_count = retained > self.limits.max_retained_jobs;
            let over_bytes = jobs.retained_result_bytes > self.limits.max_retained_result_bytes;
            if !over_count && !over_bytes {
                return;
            }
            let oldest = jobs
                .by_seq
                .values()
                .filter(|job| job.is_completed() && Some(job.seq) != keep)
                .min_by_key(|job| job.completed_at)
                .map(|job| job.seq);
            let Some(seq) = oldest else {
                // Only the protected job remains; drop the protection so an
                // oversized single result cannot pin the caps forever.
                let Some(seq) = keep else { return };
                released.job(Self::remove(jobs, seq));
                return;
            };
            released.job(Self::remove(jobs, seq));
        }
    }

    fn remove(jobs: &mut Jobs, seq: u64) -> Option<Job> {
        let job = jobs.by_seq.remove(&seq)?;
        jobs.queued_text_bytes -= job.text_bytes;
        jobs.retained_result_bytes -= job.result_bytes;
        jobs.by_key.remove(&job.key);
        Some(job)
    }

    /// Shutdown: closes admission and drops every queued (not yet started)
    /// job. Running jobs finish under the incarnation tracker; completed
    /// retention is released by [`JobTable::clear`] afterwards.
    pub fn close_admission(&self) {
        // Declared before the guard so it drops after it: shutdown can drop
        // a full table of charged jobs, and every one of those releases
        // would otherwise take the byte budget's waiter lock while this
        // lock is held.
        let mut released = Released::default();
        let mut jobs = self.lock_jobs();
        jobs.closed = true;
        let queued: Vec<u64> = jobs
            .by_seq
            .values()
            .filter(|job| matches!(job.state, JobState::Queued { .. }))
            .map(|job| job.seq)
            .collect();
        for seq in queued {
            released.job(Self::remove(&mut jobs, seq));
        }
    }

    pub fn clear(&self) {
        // Declared before the guard so it drops after it: the drained jobs
        // carry both their charges and their retained vectors, and freeing
        // either under the table lock is what this ordering avoids.
        let mut released = Released::default();
        let mut jobs = self.lock_jobs();
        released
            .jobs
            .extend(jobs.by_seq.drain().map(|(_, job)| job));
        jobs.by_key.clear();
        jobs.queued_text_bytes = 0;
        jobs.retained_result_bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::ByteBudget;

    fn charged_item(id: &str, text: &str) -> BatchItem {
        BatchItem {
            id: id.to_owned(),
            content_sha256: "0".repeat(64),
            text: text.to_owned(),
        }
    }

    fn retained_bytes(key: &str, items: &[BatchItem]) -> usize {
        let meta: usize = items
            .iter()
            .map(|item| item.id.len() + item.content_sha256.len())
            .sum();
        2 * key.len() + meta
    }

    #[test]
    fn a_charged_job_transfers_shrinks_and_releases_exact_permits() {
        const POOL: usize = 1_000_000;
        let budget = ByteBudget::new(POOL as u64);
        let jobs = JobTable::new(SynapseLimits::default());
        let items = vec![charged_item("a", "alpha"), charged_item("b", "beta")];
        let key = "k".repeat(64);
        let job_bytes = job_input_bytes(&key, &items);
        let retained = retained_bytes(&key, &items);
        assert!(job_bytes > retained);

        let mut candidate = budget.try_charge(job_bytes + 500).expect("candidate");
        let AdmitOutcome::Admitted { seq, .. } =
            jobs.admit_charged(key.clone(), items.clone(), 4, &mut candidate)
        else {
            panic!("admitted");
        };
        assert_eq!(
            candidate.bytes(),
            500,
            "admission takes exactly the job-sized portion"
        );
        drop(candidate);
        assert_eq!(budget.available(), POOL - job_bytes);

        let taken = jobs.start(seq).expect("starts");
        assert_eq!(
            budget.available(),
            POOL - job_bytes,
            "the job keeps the whole charge while the worker owns the items"
        );

        jobs.publish_ready(seq, vec![vec![0.0; 4]; taken.len()]);
        assert_eq!(
            budget.available(),
            POOL - retained,
            "publication shrinks the charge to retained metadata"
        );

        jobs.clear();
        assert_eq!(budget.available(), POOL);
    }

    #[test]
    fn non_admitted_outcomes_leave_the_candidate_charge_with_the_caller() {
        const POOL: usize = 1_000_000;
        let budget = ByteBudget::new(POOL as u64);
        let jobs = JobTable::new(SynapseLimits::default());
        let key = "k".repeat(64);
        let items = vec![charged_item("a", "alpha")];
        let job_bytes = job_input_bytes(&key, &items);

        let mut first = budget.try_charge(job_bytes).expect("first");
        let AdmitOutcome::Admitted { .. } =
            jobs.admit_charged(key.clone(), items.clone(), 4, &mut first)
        else {
            panic!("admitted");
        };

        let mut replay = budget.try_charge(job_bytes).expect("replay");
        assert!(matches!(
            jobs.admit_charged(key.clone(), items.clone(), 4, &mut replay),
            AdmitOutcome::Existing(_)
        ));
        assert_eq!(
            replay.bytes(),
            job_bytes,
            "replay keeps its candidate charge"
        );
        drop(replay);

        let other = vec![charged_item("b", "different")];
        let mut conflict = budget.try_charge(1_000).expect("conflict");
        assert!(matches!(
            jobs.admit_charged(key.clone(), other, 4, &mut conflict),
            AdmitOutcome::Conflict
        ));
        assert_eq!(
            conflict.bytes(),
            1_000,
            "conflict keeps its candidate charge"
        );
        drop(conflict);

        jobs.close_admission();
        let mut closed = budget.try_charge(1_000).expect("closed");
        assert!(matches!(
            jobs.admit_charged(
                "x".repeat(64),
                vec![charged_item("c", "gamma")],
                4,
                &mut closed
            ),
            AdmitOutcome::Closed
        ));
        assert_eq!(closed.bytes(), 1_000, "closed keeps its candidate charge");
        drop(closed);

        assert_eq!(
            budget.available(),
            POOL,
            "close_admission dropped the queued job and its whole charge"
        );
    }

    #[test]
    fn failure_eviction_and_expiry_release_their_charges() {
        const POOL: usize = 1_000_000;
        let budget = ByteBudget::new(POOL as u64);
        let limits = SynapseLimits {
            max_retained_jobs: 1,
            ..SynapseLimits::default()
        };
        let jobs = JobTable::new(limits);

        let admit = |key: String, items: Vec<BatchItem>| {
            let bytes = job_input_bytes(&key, &items);
            let mut charge = budget.try_charge(bytes).expect("charge");
            let AdmitOutcome::Admitted { seq, .. } = jobs.admit_charged(key, items, 4, &mut charge)
            else {
                panic!("admitted");
            };
            seq
        };

        let first_key = "f".repeat(64);
        let first_items = vec![charged_item("a", "alpha")];
        let first = admit(first_key.clone(), first_items.clone());
        jobs.publish_failed(first, "artifact_invalid".to_owned(), "boom".to_owned());
        assert_eq!(
            budget.available(),
            POOL - retained_bytes(&first_key, &first_items),
            "a failed job that never started still shrinks to retained metadata"
        );

        jobs.publish_failed(first, "artifact_invalid".to_owned(), "late".to_owned());
        assert_eq!(
            budget.available(),
            POOL - retained_bytes(&first_key, &first_items),
            "a late abandonment settlement cannot alter completed accounting"
        );

        let second_key = "e".repeat(64);
        let second_items = vec![charged_item("b", "beta")];
        let second = admit(second_key.clone(), second_items.clone());
        jobs.start(second).expect("starts");
        jobs.publish_ready(second, vec![vec![0.0; 4]]);
        assert_eq!(
            budget.available(),
            POOL - retained_bytes(&second_key, &second_items),
            "eviction of the oldest retained job released its remaining charge"
        );

        jobs.clear();
        assert_eq!(budget.available(), POOL);
    }

    /// `sweep` alone must release expired charges: it is the only sweep
    /// site that runs before the parse reservation, so it is what keeps
    /// expired retained charges from wedging the ingress pool into a
    /// permanent `queue_full`.
    #[test]
    fn sweep_releases_expired_charges_without_a_request_path() {
        const POOL: usize = 1_000_000;
        let budget = ByteBudget::new(POOL as u64);
        let limits = SynapseLimits {
            retention: std::time::Duration::ZERO,
            ..SynapseLimits::default()
        };
        let jobs = JobTable::new(limits);

        let key = "s".repeat(64);
        let items = vec![charged_item("a", "alpha")];
        let mut charge = budget
            .try_charge(job_input_bytes(&key, &items))
            .expect("charge");
        let AdmitOutcome::Admitted { seq, .. } = jobs.admit_charged(key, items, 4, &mut charge)
        else {
            panic!("admitted");
        };
        jobs.publish_failed(seq, "artifact_invalid".to_owned(), "boom".to_owned());
        assert!(budget.available() < POOL, "the retained charge is held");

        jobs.sweep();
        assert_eq!(
            budget.available(),
            POOL,
            "sweep released the expired job's charge"
        );
    }

    /// An identical re-submission of a failed payload is a retry, not a
    /// replay of the stored failure: the failed job is evicted (releasing
    /// its retained charge) and the retry admitted fresh, so a retryable
    /// failure is not terminal within the retention window.
    #[test]
    fn an_identical_retry_replaces_a_failed_job() {
        const POOL: usize = 1_000_000;
        let budget = ByteBudget::new(POOL as u64);
        let jobs = JobTable::new(SynapseLimits::default());
        let key = "r".repeat(64);
        let items = vec![charged_item("a", "alpha")];
        let job_bytes = job_input_bytes(&key, &items);

        let mut first = budget.try_charge(job_bytes).expect("charge");
        let AdmitOutcome::Admitted { seq, .. } =
            jobs.admit_charged(key.clone(), items.clone(), 4, &mut first)
        else {
            panic!("admitted");
        };
        jobs.publish_failed(seq, "internal_error".to_owned(), "worker died".to_owned());

        // A retry that fails admission must not consume the stored failure:
        // the same payload at an absurd dimension count is ResultTooLarge,
        // and the failed job stays pollable under its key afterwards.
        let mut rejected = budget.try_charge(job_bytes).expect("rejected charge");
        assert!(matches!(
            jobs.admit_charged(key.clone(), items.clone(), usize::MAX, &mut rejected),
            AdmitOutcome::ResultTooLarge
        ));
        drop(rejected);
        assert!(
            jobs.key_is_retained(&key),
            "a bounced retry leaves the failed job retained"
        );

        let mut second = budget.try_charge(job_bytes).expect("recharge");
        let AdmitOutcome::Admitted { seq: retry_seq, .. } =
            jobs.admit_charged(key.clone(), items.clone(), 4, &mut second)
        else {
            panic!("retry admitted");
        };
        assert_ne!(seq, retry_seq, "the retry is a new job");
        assert_eq!(
            budget.available(),
            POOL - job_bytes,
            "the failed job's retained charge was released with its eviction"
        );

        // A permanently-coded failure deterministically re-fails, so an
        // identical re-submission replays the stored failure instead of
        // re-running inference.
        jobs.publish_failed(
            retry_seq,
            "schema_violation".to_owned(),
            "bad input".to_owned(),
        );
        let mut third = budget.try_charge(job_bytes).expect("third charge");
        assert!(
            matches!(
                jobs.admit_charged(key.clone(), items.clone(), 4, &mut third),
                AdmitOutcome::Existing(descriptor) if descriptor.status == "failed"
            ),
            "a permanent failure replays rather than re-running"
        );
        drop(third);

        jobs.clear();
        assert_eq!(budget.available(), POOL);
    }

    #[test]
    fn ready_polls_share_the_retained_vector_allocation() {
        let jobs = JobTable::new(SynapseLimits::default());
        let batch = vec![BatchItem {
            id: "large-vector".to_owned(),
            content_sha256: "0".repeat(64),
            text: "alpha".to_owned(),
        }];
        let AdmitOutcome::Admitted { job_id, seq } =
            jobs.admit_uncharged_for_tests("key".to_owned(), batch, 256 * 1024)
        else {
            panic!("job is admitted");
        };
        jobs.start(seq).expect("job starts");
        jobs.publish_ready(seq, vec![vec![0.5; 256 * 1024]]);

        let PollOutcome::Page(first) = jobs.poll(&job_id, "key", None) else {
            panic!("first poll returns a page");
        };
        let second = jobs.poll(&job_id, "key", None);
        let PollOutcome::Page(second) = second else {
            panic!("second poll returns a page");
        };
        assert!(
            Arc::ptr_eq(&first.vectors[0].2, &second.vectors[0].2),
            "ready polls must not allocate or clone vector elements"
        );

        jobs.clear();
        assert_eq!(first.vectors[0].2.len(), 256 * 1024);
        assert_eq!(second.vectors[0].2[0], 0.5);
    }

    #[test]
    fn concurrent_topologies_reserve_result_bytes_at_start_without_double_charging() {
        let jobs = JobTable::new(SynapseLimits::default());
        let batch = vec![BatchItem {
            id: "item".to_owned(),
            content_sha256: "0".repeat(CONTENT_SHA256_BYTES),
            text: "alpha".to_owned(),
        }];
        let AdmitOutcome::Admitted { seq, .. } =
            jobs.admit_uncharged_for_tests("key".to_owned(), batch, 2)
        else {
            panic!("job is admitted");
        };
        let reserved = jobs
            .lock_jobs()
            .by_seq
            .get(&seq)
            .expect("job exists")
            .reserved_result_bytes;

        jobs.start_reserving(seq, true).expect("job starts");
        assert_eq!(jobs.lock_jobs().retained_result_bytes, reserved);
        jobs.publish_ready(seq, vec![vec![0.5; 2]]);
        assert_eq!(jobs.lock_jobs().retained_result_bytes, reserved);

        jobs.clear();
        assert_eq!(jobs.lock_jobs().retained_result_bytes, 0);
    }

    #[test]
    fn concurrent_result_reservations_never_evict_running_jobs() {
        let dimensions = 2;
        let one_result =
            result_bytes(1, dimensions, 1 + CONTENT_SHA256_BYTES).expect("small result size");
        let jobs = JobTable::new(SynapseLimits {
            max_retained_result_bytes: one_result,
            ..SynapseLimits::default()
        });
        let item = |id: &str| {
            vec![BatchItem {
                id: id.to_owned(),
                content_sha256: "0".repeat(CONTENT_SHA256_BYTES),
                text: "alpha".to_owned(),
            }]
        };
        let AdmitOutcome::Admitted { seq: first, .. } =
            jobs.admit_uncharged_for_tests("first".to_owned(), item("a"), dimensions)
        else {
            panic!("first job is admitted");
        };
        let AdmitOutcome::Admitted { seq: second, .. } =
            jobs.admit_uncharged_for_tests("second".to_owned(), item("b"), dimensions)
        else {
            panic!("second job is admitted");
        };

        jobs.start_reserving(first, true).expect("first starts");
        jobs.start_reserving(second, true).expect("second starts");
        let state = jobs.lock_jobs();
        assert_eq!(state.by_seq.len(), 2);
        assert_eq!(state.retained_result_bytes, one_result * 2);
    }

    #[test]
    fn result_byte_boundary_keeps_accepted_job_and_rejects_oversize_before_start() {
        let dimensions = 2;
        let exact_bytes =
            result_bytes(1, dimensions, 1 + CONTENT_SHA256_BYTES).expect("small result size");
        let limits = SynapseLimits {
            max_retained_result_bytes: exact_bytes,
            ..SynapseLimits::default()
        };
        let jobs = JobTable::new(limits);
        let item = |id: &str| {
            vec![BatchItem {
                id: id.to_owned(),
                content_sha256: "0".repeat(CONTENT_SHA256_BYTES),
                text: "alpha".to_owned(),
            }]
        };

        let AdmitOutcome::Admitted { job_id, seq } =
            jobs.admit_uncharged_for_tests("exact".to_owned(), item("a"), dimensions)
        else {
            panic!("exact result is admitted");
        };
        jobs.start(seq).expect("exact job starts");
        jobs.publish_ready(seq, vec![vec![0.5; dimensions]]);
        assert!(matches!(
            jobs.poll(&job_id, "exact", None),
            PollOutcome::Page(ResultPage { done: true, .. })
        ));

        assert!(matches!(
            jobs.admit_uncharged_for_tests("oversize".to_owned(), item("ab"), dimensions),
            AdmitOutcome::ResultTooLarge
        ));
        assert!(!jobs.key_is_retained("oversize"));
    }
}
