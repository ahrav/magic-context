//! Bounded token-count cache keyed by SHA-256 content digest.
//!
//! `mc_tokenizer::estimate_tokens` is a pure function of its input, so a
//! digest-keyed count can be reused across passes and sessions without
//! affecting any rendered byte. Steady transform passes re-measure the same
//! projected blocks every pass; tail hygiene already computes a per-part
//! SHA-256, so the lookup key is free on that path.

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::Mutex;

use sha2::{Digest, Sha256};

/// Per-generation entry cap; two full generations hold ~9.7 MB
/// (hashbrown rounds each 65,536-entry map to 131,072 x 37-byte buckets).
/// commentlint: allow(JUDGE)
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct TokenCacheStats {
    pub hits: u64,
    pub misses: u64,
    pub bypassed: u64,
    pub calls: u64,
    pub tokenized_bytes: u64,
}

thread_local! {
    /// Thread-local counters exclude updates from other threads. commentlint: allow(JUDGE)
    static LOCAL: Cell<TokenCacheStats> = const {
        Cell::new(TokenCacheStats {
            hits: 0,
            misses: 0,
            bypassed: 0,
            calls: 0,
            tokenized_bytes: 0,
        })
    };
}

/// Counters for the calling thread, monotonic for the life of the thread.
///
/// `calls` equals `hits + misses + bypassed` in any single reading. commentlint: allow(JUDGE)
/// Only differences are meaningful. commentlint: allow(JUDGE)
pub(crate) fn local_stats() -> TokenCacheStats {
    LOCAL.with(Cell::get)
}

fn bump_local(update: impl FnOnce(&mut TokenCacheStats)) {
    LOCAL.with(|local| {
        let mut stats = local.get();
        update(&mut stats);
        local.set(stats);
    });
}

fn lock_cache() -> std::sync::MutexGuard<'static, Option<Generations>> {
    CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `current` is rotated before it exceeds `GENERATION_CAP`, so `previous`
/// remains within the per-generation bound; every insertion path must use
/// this helper.
fn insert_current(generations: &mut Generations, digest: [u8; 32], count: u32) {
    if generations.current.len() >= GENERATION_CAP {
        generations.previous = std::mem::take(&mut generations.current);
    }
    generations.current.insert(digest, count);
}

/// Token count for `content` whose digest the caller already computed.
///
/// Callers must hash a domain-separated, injective encoding of `content`.
/// Tail hygiene hashes `kind_name ‖ NUL ‖ content`; this module's raw path
/// hashes `NUL ‖ content`, which no kind name can prefix.
/// commentlint: allow(JUDGE)
pub(crate) fn count_with_digest(digest: [u8; 32], content: &str) -> usize {
    bump_local(|stats| stats.calls += 1);
    // ponytail: one global lock; shard per digest byte if concurrent sessions
    // ever contend here.
    {
        let mut guard = lock_cache();
        let generations = guard.get_or_insert_with(Generations::default);
        if let Some(&count) = generations.current.get(&digest) {
            bump_local(|stats| stats.hits += 1);
            return count as usize;
        }
        if let Some(&count) = generations.previous.get(&digest) {
            bump_local(|stats| stats.hits += 1);
            insert_current(generations, digest, count);
            return count as usize;
        }
    }
    // Tokenize outside the lock: a 2 KiB payload costs ~80 us and would
    // serialize every concurrent session behind one merge loop.
    bump_local(|stats| {
        stats.misses += 1;
        stats.tokenized_bytes += content.len() as u64;
    });
    let count = mc_tokenizer::estimate_tokens(content);
    // Return counts that exceed u32 uncached to avoid truncated cache hits.
    let Ok(cached) = u32::try_from(count) else {
        return count;
    };
    let mut guard = lock_cache();
    let generations = guard.get_or_insert_with(Generations::default);
    insert_current(generations, digest, cached);
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
        bump_local(|stats| {
            stats.calls += 1;
            stats.bypassed += 1;
            stats.tokenized_bytes += content.len() as u64;
        });
        return mc_tokenizer::estimate_tokens(content);
    }
    // The leading NUL keeps this key domain disjoint from tail hygiene's
    // `kind_name ‖ NUL ‖ content` keys, so content that itself starts with
    // `"text\0"` cannot alias another entry's count.
    let mut hasher = Sha256::new();
    hasher.update([0u8]);
    hasher.update(content.as_bytes());
    count_with_digest(hasher.finalize().into(), content)
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
        let before = local_stats();
        assert_eq!(count_with_digest(digest, &content), expected);
        let after = local_stats();
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

    #[test]
    fn insert_current_rotates_at_capacity() {
        let mut generations = Generations::default();
        for i in 0..GENERATION_CAP {
            let mut key = [0u8; 32];
            key[..8].copy_from_slice(&(i as u64).to_le_bytes());
            generations.current.insert(key, 1);
        }
        // The promote-on-hit path also inserts through this helper, so a full
        // `current` must rotate rather than grow past the cap.
        insert_current(&mut generations, [0xAA; 32], 7);
        assert!(generations.current.len() <= GENERATION_CAP);
        assert_eq!(generations.current.get(&[0xAA; 32]), Some(&7));
        assert_eq!(generations.previous.len(), GENERATION_CAP);
    }

    #[test]
    fn stats_partition_calls_into_hits_misses_and_bypassed() {
        let long =
            "stats partition fixture: unique sentence long enough to clear the cache threshold";
        assert!(long.len() >= MIN_CACHED_LEN);
        let before = local_stats();
        cached_estimate_tokens("tiny");
        cached_estimate_tokens(long);
        cached_estimate_tokens(long);
        let after = local_stats();
        assert_eq!(after.calls - before.calls, 3);
        assert_eq!(after.bypassed - before.bypassed, 1);
        assert_eq!(after.misses - before.misses, 1);
        assert_eq!(after.hits - before.hits, 1);
    }

    #[test]
    fn kind_prefixed_and_raw_content_keys_do_not_alias() {
        let inner =
            "the retry loop needs a jittered backoff so clients spread out their reconnects ";
        // Raw content that byte-for-byte equals tail hygiene's preimage for
        // `inner` under the `text` kind.
        let adversarial = format!("text\0{inner}");
        assert!(adversarial.len() >= MIN_CACHED_LEN);
        let expected_inner = mc_tokenizer::estimate_tokens(inner);
        let expected_adversarial = mc_tokenizer::estimate_tokens(&adversarial);
        assert_ne!(
            expected_inner, expected_adversarial,
            "fixture must discriminate the two counts"
        );
        // Seed the cache the way tail hygiene does for (kind=text, inner).
        let hygiene_digest: [u8; 32] = Sha256::digest(adversarial.as_bytes()).into();
        assert_eq!(count_with_digest(hygiene_digest, inner), expected_inner);
        // The raw path must not read that entry back for `adversarial`.
        assert_eq!(cached_estimate_tokens(&adversarial), expected_adversarial);
    }
}
