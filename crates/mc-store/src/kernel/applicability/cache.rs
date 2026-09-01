//! Two-generation bounded cache, following the token-cache rotation
//! pattern: when the current generation fills, it becomes the previous
//! generation and hits promote entries back into current. Process-local,
//! never persisted — the durable record is the observations log.

use std::collections::HashMap;
use std::hash::Hash;

/// Per-generation entry cap. Two full generations bound total residency;
/// anchor resolutions and object classifications are small values.
pub(super) const GENERATION_CAP: usize = 16_384;

pub(super) struct TwoGenerationCache<K, V> {
    current: HashMap<K, V>,
    previous: HashMap<K, V>,
    cap: usize,
}

impl<K: Eq + Hash + Clone, V: Clone> TwoGenerationCache<K, V> {
    pub(super) fn new(cap: usize) -> Self {
        Self {
            current: HashMap::new(),
            previous: HashMap::new(),
            cap,
        }
    }

    pub(super) fn get(&mut self, key: &K) -> Option<V> {
        if let Some(value) = self.current.get(key) {
            return Some(value.clone());
        }
        let value = self.previous.remove(key)?;
        // Promotion bypasses `insert` so a read never rotates.
        if self.current.len() < self.cap {
            self.current.insert(key.clone(), value.clone());
        } else {
            self.previous.insert(key.clone(), value.clone());
        }
        Some(value)
    }

    pub(super) fn insert(&mut self, key: K, value: V) {
        if self.current.len() >= self.cap && !self.current.contains_key(&key) {
            self.previous = std::mem::take(&mut self.current);
        }
        self.current.insert(key, value);
    }

    /// Returns whether the key was present, so a caller cannot mistake a
    /// dropped entry for an applied mutation.
    pub(super) fn update(&mut self, key: &K, apply: impl FnOnce(&mut V)) -> bool {
        if let Some(value) = self.current.get_mut(key) {
            apply(value);
            true
        } else if let Some(value) = self.previous.get_mut(key) {
            apply(value);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn promoting_from_the_previous_generation_keeps_the_rest_of_it() {
        let mut cache: TwoGenerationCache<u32, u32> = TwoGenerationCache::new(4);
        // Fill one generation, then rotate it into `previous`.
        for key in 0..4 {
            cache.insert(key, key);
        }
        cache.insert(100, 100);
        assert_eq!(cache.previous.len(), 4);
        // Refill `current` so a promotion would meet the rotation condition.
        for key in 101..104 {
            cache.insert(key, key);
        }
        assert_eq!(cache.current.len(), 4);

        // Reading one previous-generation entry must not evict its siblings.
        assert_eq!(cache.get(&0), Some(0));
        for key in 1..4 {
            assert_eq!(
                cache.get(&key),
                Some(key),
                "entry {key} was evicted by a read"
            );
        }
    }

    #[test]
    fn residency_stays_within_two_generations_under_promotion() {
        let mut cache: TwoGenerationCache<u32, u32> = TwoGenerationCache::new(4);
        for key in 0..100 {
            cache.insert(key, key);
            // Re-reading recent keys drives promotion alongside inserts.
            let _ = cache.get(&key.saturating_sub(3));
        }
        assert!(
            cache.current.len() + cache.previous.len() <= 2 * cache.cap,
            "residency grew past two generations"
        );
    }

    #[test]
    fn update_reports_whether_the_key_was_present() {
        let mut cache: TwoGenerationCache<u32, u32> = TwoGenerationCache::new(4);
        cache.insert(1, 1);
        assert!(cache.update(&1, |value| *value = 2));
        assert_eq!(cache.get(&1), Some(2));
        assert!(!cache.update(&9, |value| *value = 3));
    }
}
