//! Deterministic realistic-content corpus for the hot-path benches.
//!
//! BPE cost is content-dependent: `"x".repeat(n)` merges into a handful of
//! tokens and exercises pathological merge loops, while real prose/code/JSON
//! tokenizes at ~3-4 bytes/token with very different merge behavior. Every
//! generator here is seeded (xorshift64*, seed recorded per corpus) so a run
//! is reproducible byte-for-byte across machines and reruns.

use mc_module::ck_wire::CkIngressMessage;
use mc_store::{
    CkKind, CkOutputKind, CkToolOutput, CkWireBlock, CkWireMessage, HarnessMeta, ProviderExtras,
};
use serde_json::json;

pub const CORPUS_SEED: u64 = 0x9E37_79B9_7F4A_7C15;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentClass {
    Prose,
    Code,
    JsonTool,
    Log,
    /// Rotates the other classes per message, approximating a real session mix.
    Mixed,
}

impl ContentClass {
    pub fn label(self) -> &'static str {
        match self {
            Self::Prose => "prose",
            Self::Code => "code",
            Self::JsonTool => "json_tool",
            Self::Log => "log",
            Self::Mixed => "mixed",
        }
    }
}

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    pub fn next(&mut self) -> u64 {
        // xorshift64* — deterministic, dependency-free.
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[(self.next() as usize) % items.len()]
    }
}

const PROSE_FRAGMENTS: &[&str] = &[
    "The retry loop needs a jittered backoff so concurrent clients do not synchronize their reconnect storms against the store. ",
    "We should keep the projection cache keyed by the served fingerprint; invalidating on every pass defeats the point of incremental reuse. ",
    "That failure only reproduces when the boundary compartment ends exactly at the coverage ordinal, which the fixture never exercised before. ",
    "Latency on the second pass is dominated by output identity hashing, so caching the serialized form by content hash should remove most of it. ",
    "Please double-check whether the scheduler defers the reduction when the drain latch is active, because the trace shows two hard passes back to back. ",
    "The token estimator is deterministic by construction, so any divergence between passes has to come from the overlay text, not the vocabulary. ",
];

const CODE_FRAGMENTS: &[&str] = &[
    "fn resolve_budget(limit: u64, used: u64) -> u64 {\n    limit.saturating_sub(used).min(MAX_BUDGET)\n}\n\n",
    "let mut ordered = claims\n    .iter()\n    .filter(|c| c.importance > 0)\n    .cloned()\n    .collect::<Vec<_>>();\nordered.sort_by_key(|c| std::cmp::Reverse(c.importance));\n\n",
    "match store.load(&session_id) {\n    Ok(state) => apply(state),\n    Err(McStoreError::Missing) => State::default(),\n    Err(err) => return Err(err.into()),\n}\n\n",
    "export async function flushPending(queue: Task[]): Promise<number> {\n  const settled = await Promise.allSettled(queue.map(run));\n  return settled.filter((s) => s.status === 'fulfilled').length;\n}\n\n",
    "#[test]\nfn boundary_survives_revert() {\n    let mut core = CoreState::default();\n    core.boundary_id = \"b-1\".into();\n    assert!(step(&mut core, PassInput::defer()).is_stable());\n}\n\n",
];

const LOG_FRAGMENTS: &[&str] = &[
    "2026-02-11T14:32:07.412Z INFO  mc_host::serve request accepted session=ses_04fe conn=118 bytes=48213\n",
    "2026-02-11T14:32:07.489Z DEBUG mc_module::transform pass=defer fingerprint=9f31ac02 blocks=1382 elapsed_ms=4.7\n",
    "2026-02-11T14:32:08.101Z WARN  mc_store::lease lease contention retrying holder=pid:88134 wait_ms=250\n",
    "   Compiling mc-module v0.1.0 (/local/home/build/crates/mc-module)\n    Finished `release` profile [optimized] target(s) in 42.18s\n",
    "test transform::tests::astro_defer_pass_is_stable ... ok\ntest tail_hygiene::tests::band_transitions ... ok\n",
];

const IDENTIFIERS: &[&str] = &[
    "session_resolver",
    "publication_floor",
    "coverage_ordinal",
    "frozen_unit",
    "tail_hygiene",
    "claim_mirror",
    "render_config",
    "drain_latch",
];

/// Text of at least `target_bytes` built from class fragments, varied by `rng`
/// so no two messages are byte-identical (unique ids defeat accidental
/// memoization anywhere in the pipeline).
pub fn text(class: ContentClass, target_bytes: usize, rng: &mut Rng) -> String {
    let mut out = String::with_capacity(target_bytes + 128);
    let class = match class {
        ContentClass::Mixed => *rng.pick(&[
            ContentClass::Prose,
            ContentClass::Code,
            ContentClass::JsonTool,
            ContentClass::Log,
        ]),
        other => other,
    };
    while out.len() < target_bytes {
        match class {
            ContentClass::Prose => {
                out.push_str(rng.pick(PROSE_FRAGMENTS));
                if rng.next().is_multiple_of(3) {
                    out.push_str(&format!(
                        "See `{}` (rev {}). ",
                        rng.pick(IDENTIFIERS),
                        rng.next() % 10_000
                    ));
                }
            }
            ContentClass::Code => {
                out.push_str(&format!("// case {}\n", rng.next() % 100_000));
                out.push_str(rng.pick(CODE_FRAGMENTS));
            }
            ContentClass::JsonTool => {
                let value = json!({
                    "path": format!("crates/mc-module/src/{}.rs", rng.pick(IDENTIFIERS)),
                    "line": rng.next() % 20_000,
                    "matches": (0..4).map(|i| json!({
                        "offset": rng.next() % 4_096,
                        "text": format!("{} = {}", rng.pick(IDENTIFIERS), rng.next() % 999),
                        "rank": i,
                    })).collect::<Vec<_>>(),
                    "truncated": false,
                });
                out.push_str(&serde_json::to_string(&value).expect("corpus json"));
                out.push('\n');
            }
            ContentClass::Log => {
                out.push_str(rng.pick(LOG_FRAGMENTS));
            }
            ContentClass::Mixed => unreachable!("mixed resolved above"),
        }
    }
    truncate_at_char_boundary(out, target_bytes)
}

fn truncate_at_char_boundary(mut s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    s
}

/// A session-shaped ingress array: repeating user → assistant → tool_call →
/// tool_result turns, `payload_bytes` of class content per message.
///
/// The `tool_call` `command` argument is capped at 256 bytes.
/// A `payload_bytes` above that leaves three full-size messages per four.
/// Cell labels name `payload_bytes`, not the resulting tokenized volume.
pub fn messages(
    class: ContentClass,
    count: usize,
    payload_bytes: usize,
    seed: u64,
) -> Vec<CkIngressMessage> {
    let mut rng = Rng::new(seed);
    let mut out = Vec::with_capacity(count);
    for index in 0..count {
        let ordinal = index as u64 + 1;
        let mid = format!("m{ordinal}");
        let ck = match index % 4 {
            0 => text_message("user", &mid, text(class, payload_bytes, &mut rng)),
            1 => text_message("assistant", &mid, text(class, payload_bytes, &mut rng)),
            2 => CkWireMessage::from_parts(
                "assistant",
                vec![CkWireBlock::bare(CkKind::ToolCall {
                    id: format!("call_{ordinal}"),
                    name: "bash".to_string(),
                    input: json!({ "command": text(class, payload_bytes.min(256), &mut rng) }),
                    provider_executed: false,
                })],
                None,
                ProviderExtras::new(),
                meta(&mid),
            ),
            _ => CkWireMessage::from_parts(
                "tool",
                vec![CkWireBlock::bare(CkKind::ToolResult {
                    id: format!("call_{}", ordinal - 1),
                    tool_name: "bash".to_string(),
                    output: CkToolOutput::bare(CkOutputKind::Text {
                        text: text(class, payload_bytes, &mut rng),
                    }),
                    provider_executed: false,
                })],
                None,
                ProviderExtras::new(),
                meta(&mid),
            ),
        };
        out.push(CkIngressMessage { mid, ordinal, ck });
    }
    out
}

fn text_message(role: &str, mid: &str, body: String) -> CkWireMessage {
    CkWireMessage::from_parts(
        role,
        vec![CkWireBlock::bare(CkKind::Text { text: body })],
        None,
        ProviderExtras::new(),
        meta(mid),
    )
}

fn meta(mid: &str) -> HarnessMeta {
    HarnessMeta {
        harness_id: Some(mid.to_string()),
        ..Default::default()
    }
}
