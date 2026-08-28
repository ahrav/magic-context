use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};

use mc_host::synapse::bundle;
use mc_host::synapse::inference::{Backend, InferenceError, OrtIdentity};
use mc_host::synapse::{EmbeddingEngine, LaneInfo, SynapseLimits};

pub fn load_pool(
    bundle_dir: &Path,
    ort: &OrtIdentity,
    limits: &SynapseLimits,
    size: usize,
) -> Result<
    (
        LaneInfo,
        Arc<dyn EmbeddingEngine>,
        usize,
        bundle::BundleManifest,
    ),
    String,
> {
    if size == 0 {
        return Err("pool size must be nonzero".to_owned());
    }
    let mut instances = Vec::with_capacity(size);
    let mut lane = None;
    let mut manifest = None;
    for _ in 0..size {
        let bundle = bundle::load_bundle(bundle_dir, limits).map_err(|error| error.to_string())?;
        lane.get_or_insert_with(|| LaneInfo::from_bundle(&bundle));
        manifest.get_or_insert_with(|| bundle.manifest.clone());
        instances.push(Backend::load_bench(bundle, ort, 1).map_err(|error| error.to_string())?);
    }
    let available = (0..size).collect();
    Ok((
        lane.expect("nonzero pool loads one lane"),
        Arc::new(PoolEngine {
            instances,
            available: Arc::new((Mutex::new(available), Condvar::new())),
        }),
        size,
        manifest.expect("nonzero pool loads one manifest"),
    ))
}

struct PoolEngine {
    instances: Vec<Backend>,
    available: Arc<(Mutex<VecDeque<usize>>, Condvar)>,
}

impl EmbeddingEngine for PoolEngine {
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, InferenceError> {
        let (available, wake) = &*self.available;
        let mut queue = available.lock().map_err(|_| {
            InferenceError::Invariant("model pool availability is poisoned".to_owned())
        })?;
        let index = loop {
            if let Some(index) = queue.pop_front() {
                break index;
            }
            queue = wake.wait(queue).map_err(|_| {
                InferenceError::Invariant("model pool availability is poisoned".to_owned())
            })?;
        };
        drop(queue);
        let turn = PoolTurn {
            index,
            available: Arc::clone(&self.available),
        };
        let result = self.instances[index].embed(texts);
        drop(turn);
        result
    }
}

struct PoolTurn {
    index: usize,
    available: Arc<(Mutex<VecDeque<usize>>, Condvar)>,
}

impl Drop for PoolTurn {
    fn drop(&mut self) {
        let (available, wake) = &*self.available;
        if let Ok(mut queue) = available.lock() {
            queue.push_back(self.index);
            wake.notify_one();
        }
    }
}
