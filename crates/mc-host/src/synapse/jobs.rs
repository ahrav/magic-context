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
    result_bytes: u64,
    state: JobState,
    completed_at: Option<Instant>,
}

impl Job {
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

impl JobTable {
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

    /// Whether `key` currently names a retained job.
    pub fn key_is_retained(&self, key: &str) -> bool {
        let mut jobs = self.inner.lock().expect("job table lock");
        self.sweep_expired(&mut jobs);
        jobs.by_key.contains_key(key)
    }

    pub fn admit(&self, key: String, items: Vec<BatchItem>) -> AdmitOutcome {
        let digest = digest_payload(&key, &items);
        let text_bytes: u64 = items.iter().map(|item| item.text.len() as u64).sum();
        let mut jobs = self.inner.lock().expect("job table lock");
        if jobs.closed {
            return AdmitOutcome::Closed;
        }
        self.sweep_expired(&mut jobs);

        if let Some(seq) = jobs.by_key.get(&key).copied() {
            let job = jobs.by_seq.get(&seq).expect("keyed job exists");
            if job.payload_digest == digest {
                return AdmitOutcome::Existing(JobDescriptor {
                    job_id: self.job_id(seq),
                    status: job.status(),
                });
            }
            return AdmitOutcome::Conflict;
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
                result_bytes: 0,
                state: JobState::Queued { items },
                completed_at: None,
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
        let mut jobs = self.inner.lock().expect("job table lock");
        let job = jobs.by_seq.get_mut(&seq)?;
        let JobState::Queued { items } = &mut job.state else {
            return None;
        };
        let items = std::mem::take(items);
        job.state = JobState::Running;
        Some(items)
    }

    pub fn publish_ready(&self, seq: u64, vectors: Vec<Vec<f32>>) {
        let result_bytes: u64 = vectors.iter().map(|v| (v.len() * 4) as u64).sum();
        // Converting Vec to Arc<[T]> copies the allocation. Keep that work
        // outside the global job-table lock so large inference results do not
        // block admission, polling, or shutdown bookkeeping.
        let vectors: Vec<Arc<[f32]>> = vectors.into_iter().map(Arc::from).collect();
        let mut jobs = self.inner.lock().expect("job table lock");
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
            );
            return;
        }
        let meta_bytes: u64 = job
            .item_meta
            .iter()
            .map(|(id, hash)| (id.len() + hash.len()) as u64)
            .sum();
        let result_bytes = result_bytes + meta_bytes;
        let text_bytes = job.text_bytes;
        job.text_bytes = 0;

        let boundaries = self.page_boundaries(&job.item_meta, &vectors);
        job.state = JobState::Ready {
            vectors,
            boundaries,
        };
        job.result_bytes = result_bytes;
        job.completed_at = Some(Instant::now());
        jobs.queued_text_bytes -= text_bytes;
        jobs.retained_result_bytes += result_bytes;
        self.enforce_retention(&mut jobs, Some(seq));
    }

    pub fn publish_failed(&self, seq: u64, code: String, message: String) {
        let mut jobs = self.inner.lock().expect("job table lock");
        self.fail_job(&mut jobs, seq, code, message);
    }

    /// Terminal-failure bookkeeping shared by every failure path: queued
    /// text is released, the retention clock starts, and eviction runs.
    fn fail_job(&self, jobs: &mut Jobs, seq: u64, code: String, message: String) {
        let Some(job) = jobs.by_seq.get_mut(&seq) else {
            return;
        };
        let text_bytes = job.text_bytes;
        job.text_bytes = 0;
        job.state = JobState::Failed { code, message };
        job.completed_at = Some(Instant::now());
        jobs.queued_text_bytes -= text_bytes;
        self.enforce_retention(jobs, Some(seq));
    }

    pub fn poll(&self, job_id: &str, key: &str, cursor: Option<&str>) -> PollOutcome {
        let mut jobs = self.inner.lock().expect("job table lock");
        self.sweep_expired(&mut jobs);
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
        let escaped_id_bytes = serde_json::to_string(id)
            .expect("string serialization cannot fail")
            .len()
            .checked_sub(2)
            .expect("serialized JSON string includes quotes");
        vector_len
            .checked_mul(Self::ENCODED_BYTES_PER_COMPONENT)
            .and_then(|bytes| bytes.checked_add(escaped_id_bytes))
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

    fn sweep_expired(&self, jobs: &mut Jobs) {
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
            Self::remove(jobs, seq);
        }
    }

    /// Evicts oldest-completed jobs until the just-published job fits the
    /// retained count and byte caps. The publishing job itself is exempt
    /// until something newer displaces it.
    fn enforce_retention(&self, jobs: &mut Jobs, keep: Option<u64>) {
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
                Self::remove(jobs, seq);
                return;
            };
            Self::remove(jobs, seq);
        }
    }

    fn remove(jobs: &mut Jobs, seq: u64) {
        let Some(job) = jobs.by_seq.remove(&seq) else {
            return;
        };
        jobs.queued_text_bytes -= job.text_bytes;
        jobs.retained_result_bytes -= job.result_bytes;
        jobs.by_key.remove(&job.key);
    }

    /// Shutdown: closes admission and drops every queued (not yet started)
    /// job. Running jobs finish under the incarnation tracker; completed
    /// retention is released by [`JobTable::clear`] afterwards.
    pub fn close_admission(&self) {
        let mut jobs = self.inner.lock().expect("job table lock");
        jobs.closed = true;
        let queued: Vec<u64> = jobs
            .by_seq
            .values()
            .filter(|job| matches!(job.state, JobState::Queued { .. }))
            .map(|job| job.seq)
            .collect();
        for seq in queued {
            Self::remove(&mut jobs, seq);
        }
    }

    pub fn clear(&self) {
        let mut jobs = self.inner.lock().expect("job table lock");
        jobs.by_seq.clear();
        jobs.by_key.clear();
        jobs.queued_text_bytes = 0;
        jobs.retained_result_bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_polls_share_the_retained_vector_allocation() {
        let jobs = JobTable::new(SynapseLimits::default());
        let batch = vec![BatchItem {
            id: "large-vector".to_owned(),
            content_sha256: "0".repeat(64),
            text: "alpha".to_owned(),
        }];
        let AdmitOutcome::Admitted { job_id, seq } = jobs.admit("key".to_owned(), batch) else {
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
}
