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
        if let Some(value) = self.previous.remove(key) {
            self.insert(key.clone(), value.clone());
            return Some(value);
        }
        None
    }

    pub(super) fn insert(&mut self, key: K, value: V) {
        if self.current.len() >= self.cap && !self.current.contains_key(&key) {
            self.previous = std::mem::take(&mut self.current);
        }
        self.current.insert(key, value);
    }

    /// Mutates a cached value in place wherever it currently lives.
    pub(super) fn update(&mut self, key: &K, apply: impl FnOnce(&mut V)) {
        if let Some(value) = self.current.get_mut(key) {
            apply(value);
        } else if let Some(value) = self.previous.get_mut(key) {
            apply(value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_preserves_one_generation_and_hits_promote() {
        let mut cache = TwoGenerationCache::new(2);
        cache.insert("a", 1);
        cache.insert("b", 2);
        // Third distinct insert rotates: {a, b} becomes the previous
        // generation.
        cache.insert("c", 3);
        // A previous-generation hit promotes the entry back into current.
        assert_eq!(cache.get(&"a"), Some(1));
        // Updates reach values still parked in the previous generation.
        cache.update(&"b", |value| *value = 20);
        assert_eq!(cache.get(&"b"), Some(20));
        // Two more distinct inserts push the oldest generation out entirely.
        cache.insert("d", 4);
        cache.insert("e", 5);
        assert_eq!(cache.get(&"c"), None);
    }

    #[test]
    fn reinserting_an_existing_key_does_not_rotate() {
        let mut cache = TwoGenerationCache::new(2);
        cache.insert("a", 1);
        cache.insert("b", 2);
        cache.insert("a", 10);
        assert_eq!(cache.get(&"a"), Some(10));
        assert_eq!(cache.get(&"b"), Some(2));
    }
}
