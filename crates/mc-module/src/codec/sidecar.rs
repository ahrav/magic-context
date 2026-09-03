//! Lossless sidecar metadata for decoding and re-encoding harness messages.
//!
//! Decoding stamps native origins and content fingerprints onto wire blocks. Encoding
//! aligns surviving blocks to native metadata with an order-preserving maximum-score
//! walk, preferring exact origin matches over fingerprint-only matches.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::ck_wire::{CkIngressMessage, CkWireBlock};

/// Compaction marker decoded from a harness transcript.
///
/// `ordinal` is the harness message order. Optional part and entry indices identify a
/// boundary nested within that message. `raw` preserves provider fields verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedBoundary {
    pub harness: String,
    pub message_id: String,
    pub ordinal: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    pub raw: Value,
}

/// Decoded messages plus metadata required for lossless re-encoding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedHarnessMessages {
    pub messages: Vec<CkIngressMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary: Option<ExtractedBoundary>,
    pub sidecar: DecodeSidecar,
}

/// Harness metadata indexed by message ID with a separate decode-order list.
///
/// Repeated message IDs replace metadata without changing their first-seen position.
/// `mid_pins` retains stable-key assignments across encode cycles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecodeSidecar {
    pub harness: String,
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub messages: BTreeMap<String, Arc<HarnessMessageMeta>>,
    #[serde(default)]
    pub mid_pins: BTreeMap<String, String>,
}

impl DecodeSidecar {
    pub fn new(harness: impl Into<String>) -> Self {
        Self {
            harness: harness.into(),
            order: Vec::new(),
            messages: BTreeMap::new(),
            mid_pins: BTreeMap::new(),
        }
    }

    /// Inserts or replaces message metadata while preserving first-seen order.
    pub fn remember_message(&mut self, mid: String, meta: HarnessMessageMeta) {
        if !self.messages.contains_key(&mid) {
            self.order.push(mid.clone());
        }
        self.messages.insert(mid, Arc::new(meta));
    }

    pub fn message_by_mid(&self, mid: &str) -> Option<&HarnessMessageMeta> {
        self.messages.get(mid).map(Arc::as_ref)
    }

    /// Returns metadata at zero-based decode order `index`.
    pub fn message_for_index(&self, index: usize) -> Option<&HarnessMessageMeta> {
        self.order
            .get(index)
            .and_then(|mid| self.messages.get(mid.as_str()))
            .map(Arc::as_ref)
    }

    pub fn inherit_pin(&self, stable_key: &str) -> Option<String> {
        self.mid_pins.get(stable_key).cloned()
    }

    pub fn pin_mid(&mut self, stable_key: impl Into<String>, mid: impl Into<String>) {
        self.mid_pins.insert(stable_key.into(), mid.into());
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HarnessMessageMeta {
    pub mid: String,
    pub ordinal: u64,
    pub role: String,
    pub raw: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stable_key: Option<String>,
    #[serde(default)]
    pub blocks: Vec<BlockMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockMeta {
    pub block_index: usize,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_fingerprint: Option<String>,
    pub raw: Value,
}

/// Order-preserving block-to-metadata alignment and native-part retention sets.
pub(crate) struct MatchedBlockMetas<'a> {
    pub(crate) by_block: Vec<Option<&'a BlockMeta>>,
    retained_native_indices: BTreeSet<usize>,
    decoded_native_indices: BTreeSet<usize>,
}

impl MatchedBlockMetas<'_> {
    /// Removes native parts whose decoded blocks were removed.
    ///
    /// Parts with no decoded metadata remain because the sidecar cannot prove they
    /// correspond to a deleted block. Relative order of retained parts is unchanged.
    pub(crate) fn remove_unretained_native_parts<T>(&self, parts: Vec<T>) -> Vec<T> {
        parts
            .into_iter()
            .enumerate()
            .filter_map(|(native_index, part)| {
                let decoded_block_was_removed = self.decoded_native_indices.contains(&native_index)
                    && !self.retained_native_indices.contains(&native_index);
                (!decoded_block_was_removed).then_some(part)
            })
            .collect()
    }
}

const BLOCK_IDENTITY_NAMESPACE: &str = "_cortexkit_codec";
const BLOCK_INDEX_KEY: &str = "blockIndex";
const NATIVE_INDEX_KEY: &str = "nativeIndex";
const FINGERPRINT_KEY: &str = "decodedFingerprint";

#[derive(Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
struct AlignmentScore {
    origin_matches: usize,
    total_matches: usize,
}

impl AlignmentScore {
    fn with_match(self, origin_match: bool) -> Self {
        Self {
            origin_matches: self.origin_matches + usize::from(origin_match),
            total_matches: self.total_matches + 1,
        }
    }
}

/// Hashes decoded content after removing codec-owned identity metadata.
pub(crate) fn decoded_block_fingerprint(block: &CkWireBlock) -> String {
    let mut canonical = block.clone();
    canonical.provider_extras.remove(BLOCK_IDENTITY_NAMESPACE);
    canonical.mark_modified();
    stable_hash(&serde_json::to_value(canonical).unwrap_or(Value::Null))
}

/// Stores a block's decoded origin and pre-mutation fingerprint in provider extras.
pub(crate) fn stamp_block_identity(
    block: &mut CkWireBlock,
    block_index: usize,
    native_index: usize,
    fingerprint: &str,
) {
    let identity = block
        .provider_extras
        .entry(BLOCK_IDENTITY_NAMESPACE.to_string())
        .or_default();
    identity.insert(BLOCK_INDEX_KEY.to_string(), Value::from(block_index));
    identity.insert(NATIVE_INDEX_KEY.to_string(), Value::from(native_index));
    identity.insert(
        FINGERPRINT_KEY.to_string(),
        Value::String(fingerprint.to_string()),
    );
    block.mark_modified();
}

fn stamped_block_identity(block: &CkWireBlock) -> Option<(usize, usize, &str)> {
    let identity = block.provider_extras.get(BLOCK_IDENTITY_NAMESPACE)?;
    let block_index = identity.get(BLOCK_INDEX_KEY)?.as_u64()?.try_into().ok()?;
    let native_index = identity.get(NATIVE_INDEX_KEY)?.as_u64()?.try_into().ok()?;
    let fingerprint = identity.get(FINGERPRINT_KEY)?.as_str()?;
    Some((block_index, native_index, fingerprint))
}

/// True when a decoded block retains its exact native-part origin.
pub(crate) fn has_stamped_block_identity(block: &CkWireBlock) -> bool {
    stamped_block_identity(block).is_some()
}

pub(crate) fn block_is_unchanged(block: &CkWireBlock, meta: &BlockMeta) -> bool {
    meta.content_fingerprint
        .as_deref()
        .is_some_and(|fingerprint| decoded_block_fingerprint(block) == fingerprint)
}

fn alignment_candidate(
    block: &CkWireBlock,
    block_index: usize,
    meta: &BlockMeta,
    kind_matches: bool,
) -> Option<bool> {
    if let Some((origin_block_index, origin_native_index, fingerprint)) =
        stamped_block_identity(block)
    {
        let origin_matches = origin_block_index == meta.block_index
            && Some(origin_native_index) == meta.native_index
            && meta.content_fingerprint.as_deref() == Some(fingerprint);
        return origin_matches.then_some(true);
    }

    if kind_matches
        && meta
            .content_fingerprint
            .as_deref()
            .is_some_and(|fingerprint| decoded_block_fingerprint(block) == fingerprint)
    {
        return Some(false);
    }

    // Position-only matching for fingerprintless sidecars requires an unchanged block index and does not scan nearby same-kind blocks.
    (meta.content_fingerprint.is_none() && block_index == meta.block_index && kind_matches)
        .then_some(false)
}

/// Aligns blocks with metadata without reordering either sequence.
///
/// Exact stamped origins score above fingerprint-only or positional matches. Dynamic
/// programming maximizes origin matches first and total matches second. Each block and
/// metadata row appears in at most one pair. Time and memory are `O(blocks * metas)`.
pub(crate) fn match_block_metas<'a>(
    blocks: &[CkWireBlock],
    metas: &'a [BlockMeta],
    mut matches: impl FnMut(&CkWireBlock, &BlockMeta) -> bool,
) -> MatchedBlockMetas<'a> {
    let mut candidates = vec![vec![None; metas.len()]; blocks.len()];
    for (block_index, block) in blocks.iter().enumerate() {
        for (meta_index, meta) in metas.iter().enumerate() {
            let kind_matches = matches(block, meta);
            candidates[block_index][meta_index] =
                alignment_candidate(block, block_index, meta, kind_matches);
        }
    }

    // Origin indexes are stamped onto decoded blocks and survive reductions, overlays, and deletion compaction in CkWireBlock::provider_extras.
    // Each origin index stores the pre-mutation decoded fingerprint.
    // Pre-mutation fingerprints align mutated survivors with their native metadata; the LCS-style walk preserves native order and avoids same-kind adjacency matching.
    let mut scores = vec![vec![AlignmentScore::default(); metas.len() + 1]; blocks.len() + 1];
    for block_index in (0..blocks.len()).rev() {
        for meta_index in (0..metas.len()).rev() {
            let mut best =
                scores[block_index + 1][meta_index].max(scores[block_index][meta_index + 1]);
            if let Some(origin_match) = candidates[block_index][meta_index] {
                best = best.max(scores[block_index + 1][meta_index + 1].with_match(origin_match));
            }
            scores[block_index][meta_index] = best;
        }
    }

    let mut by_block = vec![None; blocks.len()];
    let (mut block_index, mut meta_index) = (0, 0);
    while block_index < blocks.len() && meta_index < metas.len() {
        if let Some(origin_match) = candidates[block_index][meta_index] {
            let matched_score = scores[block_index + 1][meta_index + 1].with_match(origin_match);
            if matched_score == scores[block_index][meta_index] {
                by_block[block_index] = Some(&metas[meta_index]);
                block_index += 1;
                meta_index += 1;
                continue;
            }
        }
        if scores[block_index + 1][meta_index] >= scores[block_index][meta_index + 1] {
            block_index += 1;
        } else {
            meta_index += 1;
        }
    }

    let retained_native_indices = by_block
        .iter()
        .filter_map(|meta| meta.and_then(|meta| meta.native_index))
        .collect();
    let decoded_native_indices = metas.iter().filter_map(|meta| meta.native_index).collect();

    MatchedBlockMetas {
        by_block,
        retained_native_indices,
        decoded_native_indices,
    }
}

/// Returns the full lowercase SHA-256 digest of `serde_json`-serialized bytes.
///
/// Serialization failure hashes an empty byte sequence.
pub fn stable_hash(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    let digest = Sha256::digest(bytes);
    hex_prefix(&digest, digest.len())
}

/// Returns up to `chars` lowercase hexadecimal characters from serialized JSON's SHA-256 digest.
///
/// Serialization failure hashes an empty byte sequence. Requests above 64 characters
/// return the full 64-character digest.
pub fn stable_hash_prefix(value: &Value, chars: usize) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    let digest = Sha256::digest(bytes);
    hex_prefix(&digest, chars.div_ceil(2))
        .chars()
        .take(chars)
        .collect()
}

fn hex_prefix(bytes: &[u8], count: usize) -> String {
    let mut out = String::with_capacity(count * 2);
    for byte in bytes.iter().take(count) {
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

/// Selects metadata by explicit harness ID, then by decode order for nonsynthetic messages.
///
/// Synthetic messages never use the positional fallback.
pub fn meta_for_ck<'a>(
    sidecar: &'a DecodeSidecar,
    msg: &'a crate::ck_wire::CkWireMessage,
    index: usize,
) -> Option<&'a HarnessMessageMeta> {
    msg.meta
        .harness_id
        .as_deref()
        .and_then(|mid| sidecar.message_by_mid(mid))
        .or_else(|| {
            (!msg.meta.synthetic)
                .then(|| sidecar.message_for_index(index))
                .flatten()
        })
}

/// Recognizes either supported boolean marker for a synthetic native part.
pub(crate) fn is_synthetic_part(part: &Value) -> bool {
    part.get("synthetic")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || part
            .get("syntheticTodoMarker")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}
