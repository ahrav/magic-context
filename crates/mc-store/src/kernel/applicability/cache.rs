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
