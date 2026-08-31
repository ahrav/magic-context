use mc_store::kernel::{CommitIntent, DomainSpec, KernelStore, Sensitivity};

fn domain(index: usize) -> DomainSpec {
    DomainSpec {
        domain_id: format!("domain-{index}"),
        object_id: format!("object-{index}"),
        name: format!("name-{index}"),
        source_kind: "panic-probe".to_string(),
        source_id: format!("source-{index}"),
        source_revision: i64::try_from(index).expect("probe index fits i64"),
        sensitivity: Sensitivity::Normal,
    }
}

fn main() {
    let mut arguments = std::env::args().skip(1);
    let root = arguments.next().expect("probe root is required");
    let mode = arguments.next().expect("probe mode is required");
    let held_input = std::env::var("MC_PANIC_PROBE_INPUT").unwrap_or_default();
    let store = KernelStore::open(&root).expect("probe store opens");
    store
        .commit(
            CommitIntent {
                producer: "panic-probe".to_string(),
                operation_key: "seed".to_string(),
                request_digest: "0".repeat(64),
                actor: "panic-probe".to_string(),
                cause: "seed replacement source".to_string(),
            },
            |envelope| {
                envelope.insert_domain(domain(1))?;
                Ok(String::new())
            },
        )
        .expect("probe seed commits");
    let _ = store.commit(
        CommitIntent {
            producer: "panic-probe".to_string(),
            operation_key: mode.clone(),
            request_digest: "a".repeat(64),
            actor: "panic-probe".to_string(),
            cause: held_input,
        },
        |envelope| {
            envelope
                .correct_domain("object-1", domain(2))
                .expect("production replacement path accepts fixture");
            std::fs::write(
                std::path::Path::new(&root).join("replacement-path-reached"),
                b"replacement path reached",
            )
            .expect("positive-control artifact is written");
            if mode == "abort" {
                std::process::abort();
            }
            panic!("static scanner panic probe");
        },
    );
}
