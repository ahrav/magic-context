//! Separate input-size benchmarks distinguish scaling changes from
//! constant-factor changes.

use std::collections::{HashMap, HashSet};
use std::hint::black_box;
use std::sync::Arc;

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

use mc_module::boundary::{
    check_compartment_trigger, resolve_protected_tail_boundary, BoundaryBlock, BoundaryContext,
    BoundaryMsg, Role, TriggerContext,
};
use mc_module::caveman::{compress, CavemanLevel};
use mc_module::decay_render::{render_decayed_compartments, DecayRenderCompartment};
use mc_module::historian_chunk::truncate_historian_input_if_needed;
use mc_module::selection::{
    select_reductions, PassClass, SelItem, SelKind, SelMessageRole, SelectionConfig,
    SelectionContext,
};
use mc_tokenizer::estimate_tokens;

fn caveman_corpus(target_bytes: usize) -> String {
    let golden: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../testdata/caveman-golden.json"))
            .expect("parse caveman-golden.json");
    let inputs: Vec<&str> = golden
        .iter()
        .filter_map(|case| case.get("text").and_then(|t| t.as_str()))
        .collect();
    assert!(!inputs.is_empty(), "caveman golden must supply inputs");
    let mut doc = String::with_capacity(target_bytes + 1024);
    let mut i = 0usize;
    while doc.len() < target_bytes {
        doc.push_str(inputs[i % inputs.len()]);
        match i % 4 {
            0 => doc.push_str("\n\n"),
            1 => doc.push_str("\n\n\n\n   \n"),
            2 => doc.push_str("\n```rust\nlet x = compute(1, 2);\n```\n"),
            _ => doc.push_str(" see https://example.com/path?q=1 \n"),
        }
        i += 1;
    }
    doc
}

fn bench_caveman(c: &mut Criterion) {
    let mut group = c.benchmark_group("caveman");
    group.sample_size(20);
    for (size_name, bytes) in [("small", 4 << 10), ("medium", 32 << 10), ("large", 256 << 10)] {
        let doc = caveman_corpus(bytes);
        for (level_name, level) in [
            ("lite", CavemanLevel::Lite),
            ("full", CavemanLevel::Full),
            ("ultra", CavemanLevel::Ultra),
        ] {
            group.bench_with_input(
                BenchmarkId::new(level_name, size_name),
                &doc,
                |b, doc| b.iter(|| compress(black_box(doc), level)),
            );
        }
    }
    group.finish();
}

fn bench_tokenizer(c: &mut Criterion) {
    let mut group = c.benchmark_group("tokenizer");
    group.sample_size(20);
    for (size_name, bytes) in [("small", 512), ("medium", 16 << 10), ("large", 128 << 10)] {
        let doc = caveman_corpus(bytes);
        group.bench_with_input(
            BenchmarkId::new("estimate_tokens", size_name),
            &doc,
            |b, doc| b.iter(|| estimate_tokens(black_box(doc))),
        );
    }
    group.finish();
}

fn bench_historian_truncate(c: &mut Criterion) {
    let mut group = c.benchmark_group("historian_truncate");
    group.sample_size(10);
    for (size_name, bytes, budget) in
        [("medium", 64 << 10, 2_000usize), ("large", 512 << 10, 8_000usize)]
    {
        let doc = caveman_corpus(bytes);
        group.bench_with_input(
            BenchmarkId::new("over_budget", size_name),
            &(doc, budget),
            |b, (doc, budget)| b.iter(|| truncate_historian_input_if_needed(black_box(doc), *budget)),
        );
    }
    group.finish();
}

fn tool_output(i: usize) -> String {
    format!(
        "file {i} contents:\nfn kernel_{i}(input: &str) -> usize {{\n    input.len() + {i}\n}}\n\
         filler so token counts vary with i: {pad}\n",
        i = i,
        pad = "lorem ipsum dolor sit amet ".repeat(1 + i % 5),
    )
}

fn text_block(
    id: String,
    ordinal: u64,
    text: String,
    arc_id: Option<String>,
    kind: SelKind,
) -> BoundaryBlock {
    let token_count = estimate_tokens(&text);
    BoundaryBlock {
        id,
        ordinal,
        kind,
        provider_executed: false,
        byte_size: text.len(),
        arc_id,
        original: Arc::from(text.as_str()),
        original_token_count: token_count,
        rendered: None,
        ignored: false,
    }
}

fn arc_storm(arcs: usize) -> Vec<BoundaryMsg> {
    let mut messages = Vec::with_capacity(arcs * 2 + arcs / 8 + 2);
    let mut ordinal: u64 = 1;
    messages.push(BoundaryMsg {
        message_ordinal: ordinal,
        message_id: "m-user-0".to_string(),
        role: Role::User,
        blocks: vec![text_block(
            format!("m-user-0#{ordinal}"),
            ordinal,
            "please inspect the repository and summarize the kernels".to_string(),
            None,
            SelKind::Text,
        )],
    });
    ordinal += 1;
    for i in 0..arcs {
        if i % 8 == 7 {
            messages.push(BoundaryMsg {
                message_ordinal: ordinal,
                message_id: format!("m-user-{i}"),
                role: Role::User,
                blocks: vec![text_block(
                    format!("m-user-{i}#0"),
                    ordinal,
                    format!("continue with file {i} and explain what changed"),
                    None,
                    SelKind::Text,
                )],
            });
            ordinal += 1;
        }
        let arc = format!("arc-{i}");
        let tool = match i % 5 {
            0..=2 => "read",
            3 => "edit",
            _ => "bash",
        };
        messages.push(BoundaryMsg {
            message_ordinal: ordinal,
            message_id: format!("m-call-{i}"),
            role: Role::Assistant,
            blocks: vec![text_block(
                format!("m-call-{i}#0"),
                ordinal,
                format!("{{\"filePath\":\"src/file_{}.rs\"}}", i % 37),
                Some(arc.clone()),
                SelKind::ToolCall {
                    name: tool.to_string(),
                    input: serde_json::json!({"filePath": format!("src/file_{}.rs", i % 37)}),
                },
            )],
        });
        ordinal += 1;
        // Every 10th arc stays open: a call with no paired result.
        if i % 10 != 9 {
            messages.push(BoundaryMsg {
                message_ordinal: ordinal,
                message_id: format!("m-result-{i}"),
                role: Role::Other("tool".to_string()),
                blocks: vec![text_block(
                    format!("m-result-{i}#0"),
                    ordinal,
                    tool_output(i),
                    Some(arc.clone()),
                    SelKind::ToolResult {
                        tool_name: tool.to_string(),
                    },
                )],
            });
            ordinal += 1;
        }
    }
    messages.push(BoundaryMsg {
        message_ordinal: ordinal,
        message_id: "m-user-final".to_string(),
        role: Role::User,
        blocks: vec![text_block(
            format!("m-user-final#{ordinal}"),
            ordinal,
            "now summarize everything above".to_string(),
            None,
            SelKind::Text,
        )],
    });
    messages
}

fn pressured_trigger_ctx() -> TriggerContext {
    TriggerContext {
        boundary: BoundaryContext {
            usage_percentage: 72.0,
            usage_input_tokens: 92_000.0,
            ..BoundaryContext::default()
        },
        ..TriggerContext::default()
    }
}

fn bench_boundary(c: &mut Criterion) {
    let mut group = c.benchmark_group("boundary");
    group.sample_size(10);
    for arcs in [10usize, 100, 1000] {
        let messages = arc_storm(arcs);
        let trigger_ctx = pressured_trigger_ctx();
        group.bench_with_input(
            BenchmarkId::new("check_compartment_trigger", arcs),
            &messages,
            |b, messages| {
                b.iter(|| check_compartment_trigger(black_box(messages), black_box(&trigger_ctx)))
            },
        );
        let boundary_ctx = trigger_ctx.boundary.clone();
        group.bench_with_input(
            BenchmarkId::new("resolve_protected_tail", arcs),
            &messages,
            |b, messages| {
                b.iter(|| {
                    resolve_protected_tail_boundary(black_box(messages), black_box(&boundary_ctx))
                })
            },
        );
    }
    group.finish();
}

fn selection_items(messages: &[BoundaryMsg]) -> Vec<SelItem> {
    messages
        .iter()
        .flat_map(|message| {
            let role = match message.role {
                Role::Assistant => SelMessageRole::Assistant,
                Role::System => SelMessageRole::System,
                _ => SelMessageRole::NonAssistant,
            };
            message.blocks.iter().map(move |block| SelItem {
                id: block.id.clone(),
                ordinal: message.message_ordinal,
                message_role: role,
                kind: block.kind.clone(),
                provider_executed: block.provider_executed,
                byte_size: block.byte_size,
                token_count: Some(block.original_token_count),
                arc_id: block.arc_id.clone(),
            })
        })
        .collect()
}

fn bench_selection(c: &mut Criterion) {
    let mut group = c.benchmark_group("selection");
    group.sample_size(10);
    for arcs in [10usize, 100, 1000] {
        let messages = arc_storm(arcs);
        let items = selection_items(&messages);
        let max_ordinal = messages.last().map(|m| m.message_ordinal).unwrap_or(1);
        let ctx = SelectionContext {
            pass_class: PassClass::Execute,
            current_total_input_tokens: 100_000.0,
            ceiling_tokens: 83_200.0,
            protected_cutoff_ordinal: max_ordinal.saturating_mul(4) / 5,
            last_execute_ordinal: max_ordinal / 2,
            scheduler_pressure_execute: true,
            prior_input_sample: 0.0,
            has_prior_drop: false,
            agent_drop_ids: Vec::new(),
            agent_drop_command_ids: HashMap::new(),
            first_applied_agent_drop_ids: HashSet::new(),
            pass_already_busting: false,
            supersession_ride_available: true,
            tag_window_protected_block_ids: HashSet::new(),
            exempt_message_protected_block_ids: HashSet::new(),
        };
        let cfg = SelectionConfig { smart_drops: true };
        let frozen: HashSet<String> = HashSet::new();
        group.bench_with_input(
            BenchmarkId::new("select_reductions", arcs),
            &items,
            |b, items| {
                b.iter(|| {
                    select_reductions(
                        black_box(items),
                        black_box(&frozen),
                        black_box(&ctx),
                        black_box(&cfg),
                    )
                })
            },
        );
    }
    group.finish();
}

fn shape_compartments() -> Vec<DecayRenderCompartment> {
    let shape: serde_json::Value =
        serde_json::from_str(include_str!("../testdata/decay-store-shape.json"))
            .expect("parse decay-store-shape.json");
    let raw = shape["compartments"]
        .as_array()
        .expect("compartments array");
    raw.iter()
        .map(|c| DecayRenderCompartment {
            start_message: c["startMessage"].as_i64().unwrap_or(0),
            end_message: c["endMessage"].as_i64().unwrap_or(0),
            title: c["title"].as_str().unwrap_or_default().to_string(),
            content: c["content"].as_str().unwrap_or_default().to_string(),
            start_date: c["startDate"].as_str().map(str::to_string),
            end_date: c["endDate"].as_str().map(str::to_string),
            p1: c["p1"].as_str().map(str::to_string),
            p2: c["p2"].as_str().map(str::to_string),
            p3: c["p3"].as_str().map(str::to_string),
            p4: c["p4"].as_str().map(str::to_string),
            importance: c["importance"].as_i64().map(|v| v as i32),
            legacy: c["legacy"].as_i64().map(|v| v as i32),
        })
        .collect()
}

fn bench_decay_render(c: &mut Criterion) {
    let compartments = shape_compartments();
    assert_eq!(compartments.len(), 388, "store-shape fixture drifted");
    let mut group = c.benchmark_group("decay_render");
    group.sample_size(10);
    // budget below the rendered-body token count forces the demotion loop
    for (name, budget) in [("loose_budget", 200_000.0f64), ("tight_budget", 8_000.0f64)] {
        group.bench_with_input(
            BenchmarkId::new("render_388", name),
            &compartments,
            |b, compartments| {
                b.iter(|| {
                    render_decayed_compartments(
                        black_box(compartments),
                        budget,
                        estimate_tokens,
                    )
                })
            },
        );
    }
    group.finish();
}

criterion_group!(
    kernels,
    bench_caveman,
    bench_tokenizer,
    bench_historian_truncate,
    bench_boundary,
    bench_selection,
    bench_decay_render
);
criterion_main!(kernels);
