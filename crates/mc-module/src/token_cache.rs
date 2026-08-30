//! Bounded token-count cache keyed by SHA-256 content digest.
//!
//! `mc_tokenizer::estimate_tokens` is a pure function of its input, so a
//! digest-keyed count can be reused across passes and sessions without
//! affecting any rendered byte. Steady transform passes re-measure the same
//! projected blocks every pass; tail hygiene already computes a per-part
//! SHA-256, so the lookup key is free on that path.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use sha2::{Digest, Sha256};

/// Per-generation entry cap. Two generations bound the cache at roughly
/// 2 x 65,536 x ~44 bytes (~6 MB).
const GENERATION_CAP: usize = 65_536;

/// Contents shorter than this tokenize directly: hashing plus the lock
/// round-trip costs more than the BPE for tiny strings.
const MIN_CACHED_LEN: usize = 64;

#[derive(Default)]
struct Generations {
    current: HashMap<[u8; 32], u32>,
    previous: HashMap<[u8; 32], u32>,
}

static CACHE: Mutex<Option<Generations>> = Mutex::new(None);
static HITS: AtomicU64 = AtomicU64::new(0);
static MISSES: AtomicU64 = AtomicU64::new(0);
static CALLS: AtomicU64 = AtomicU64::new(0);
static TOKENIZED_BYTES: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct TokenCacheStats {
    pub hits: u64,
    pub misses: u64,
    pub calls: u64,
    pub tokenized_bytes: u64,
}

pub(crate) fn stats() -> TokenCacheStats {
    TokenCacheStats {
        hits: HITS.load(Ordering::Relaxed),
        misses: MISSES.load(Ordering::Relaxed),
        calls: CALLS.load(Ordering::Relaxed),
        tokenized_bytes: TOKENIZED_BYTES.load(Ordering::Relaxed),
    }
}

fn lock_cache() -> std::sync::MutexGuard<'static, Option<Generations>> {
    CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Token count for `content` whose digest the caller already computed.
pub(crate) fn count_with_digest(digest: [u8; 32], content: &str) -> usize {
    CALLS.fetch_add(1, Ordering::Relaxed);
    // ponytail: one global lock; shard per digest byte if concurrent sessions
    // ever contend here.
    {
        let mut guard = lock_cache();
        let generations = guard.get_or_insert_with(Generations::default);
        if let Some(&count) = generations.current.get(&digest) {
            HITS.fetch_add(1, Ordering::Relaxed);
            return count as usize;
        }
        if let Some(&count) = generations.previous.get(&digest) {
            HITS.fetch_add(1, Ordering::Relaxed);
            generations.current.insert(digest, count);
            return count as usize;
        }
    }
    // Tokenize outside the lock: a 2 KiB payload costs ~80 us and would
    // serialize every concurrent session behind one merge loop.
    MISSES.fetch_add(1, Ordering::Relaxed);
    TOKENIZED_BYTES.fetch_add(content.len() as u64, Ordering::Relaxed);
    let count = mc_tokenizer::estimate_tokens(content);
    // Return counts that exceed u32 uncached to avoid truncated cache hits.
    let Ok(cached) = u32::try_from(count) else {
        return count;
    };
    let mut guard = lock_cache();
    let generations = guard.get_or_insert_with(Generations::default);
    if generations.current.len() >= GENERATION_CAP {
        generations.previous = std::mem::take(&mut generations.current);
    }
    generations.current.insert(digest, cached);
    count
}

#[cfg(any(test, feature = "bench-internals"))]
pub fn clear() {
    let mut guard = lock_cache();
    *guard = Some(Generations::default());
}

/// Drop-in replacement for `mc_tokenizer::estimate_tokens` that hashes and
/// caches contents long enough to be worth it.
pub(crate) fn cached_estimate_tokens(content: &str) -> usize {
    if content.len() < MIN_CACHED_LEN {
        CALLS.fetch_add(1, Ordering::Relaxed);
        MISSES.fetch_add(1, Ordering::Relaxed);
        TOKENIZED_BYTES.fetch_add(content.len() as u64, Ordering::Relaxed);
        return mc_tokenizer::estimate_tokens(content);
    }
    count_with_digest(Sha256::digest(content.as_bytes()).into(), content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_counts_match_the_tokenizer() {
        for content in [
            "",
            "short",
            "a longer sentence that clears the minimum cached length threshold easily",
            "fn main() { println!(\"hello, tokenizer cache\"); }\n// with a second line so BPE has structure",
        ] {
            assert_eq!(
                cached_estimate_tokens(content),
                mc_tokenizer::estimate_tokens(content),
                "cached count diverged for {content:?}"
            );
            // Second call exercises the hit path; the count must not change.
            assert_eq!(
                cached_estimate_tokens(content),
                mc_tokenizer::estimate_tokens(content)
            );
        }
    }

    #[test]
    fn digest_keyed_hits_skip_retokenization() {
        let content = "x".repeat(200);
        let digest: [u8; 32] = Sha256::digest(content.as_bytes()).into();
        let expected = mc_tokenizer::estimate_tokens(&content);
        assert_eq!(count_with_digest(digest, &content), expected);
        let before = stats();
        assert_eq!(count_with_digest(digest, &content), expected);
        let after = stats();
        assert_eq!(after.hits, before.hits + 1);
        assert_eq!(after.misses, before.misses);
    }

    #[test]
    fn generation_rotation_keeps_recently_hit_entries() {
        let mut generations = Generations::default();
        generations.current.insert([1u8; 32], 7);
        // Simulate rotation: the hit path promotes from previous into current.
        generations.previous = std::mem::take(&mut generations.current);
        assert!(generations.current.is_empty());
        assert_eq!(generations.previous.get(&[1u8; 32]), Some(&7));
    }
}
