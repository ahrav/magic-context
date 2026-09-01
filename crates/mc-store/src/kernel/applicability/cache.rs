//! Two-generation bounded cache, following the token-cache rotation
//! pattern: when the current generation fills, it becomes the previous
//! generation and hits promote entries back into current. Process-local,
//! never persisted — the durable record is the observations log.

use std::borrow::Borrow;
use std::collections::{hash_map::RandomState, HashMap};
use std::hash::{BuildHasher, Hash};

/// Per-generation entry cap. Two full generations bound total residency;
/// anchor resolutions and object classifications are small values.
pub(super) const GENERATION_CAP: usize = 16_384;

pub(super) struct TwoGenerationCache<K, V, S = RandomState> {
    current: HashMap<K, V, S>,
    previous: HashMap<K, V, S>,
    cap: usize,
}

impl<K: Eq + Hash + Clone, V: Clone> TwoGenerationCache<K, V, RandomState> {
    pub(super) fn new(cap: usize) -> Self {
        Self::with_hasher(cap, RandomState::new())
    }
}

impl<K: Eq + Hash + Clone, V: Clone, S: BuildHasher + Clone> TwoGenerationCache<K, V, S> {
    pub(super) fn with_hasher(cap: usize, hasher: S) -> Self {
        Self {
            current: HashMap::with_hasher(hasher.clone()),
            previous: HashMap::with_hasher(hasher),
            cap,
        }
    }

    pub(super) fn reserve(&mut self, additional: usize) {
        self.current
            .reserve(additional.min(self.cap.saturating_sub(self.current.len())));
    }

    pub(super) fn get<Q>(&mut self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
        Q: Eq + Hash + ?Sized,
    {
        self.get_key_value(key).map(|(_, value)| value)
    }

    pub(super) fn get_key_value<Q>(&mut self, key: &Q) -> Option<(K, V)>
    where
        K: Borrow<Q>,
        Q: Eq + Hash + ?Sized,
    {
        if let Some((stored_key, value)) = self.current.get_key_value(key) {
            return Some((stored_key.clone(), value.clone()));
        }
        if let Some((stored_key, value)) = self.previous.remove_entry(key) {
            self.insert(stored_key.clone(), value.clone());
            return Some((stored_key, value));
        }
        None
    }

    pub(super) fn insert(&mut self, key: K, value: V) {
        if self.current.len() >= self.cap && !self.current.contains_key(&key) {
            let current = HashMap::with_hasher(self.current.hasher().clone());
            self.previous = std::mem::replace(&mut self.current, current);
        }
        self.current.insert(key, value);
    }

    /// Mutates a cached value in place wherever it currently lives.
    pub(super) fn update<Q>(&mut self, key: &Q, apply: impl FnOnce(&mut V)) -> bool
    where
        K: Borrow<Q>,
        Q: Eq + Hash + ?Sized,
    {
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
