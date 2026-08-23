//! Topology classification and atomic-fixture contract tests: synthetic
//! sysfs trees prove pair validation, auto-selection skips, and explicit
//! configuration failures without depending on this machine's shape; the
//! atomic handshake tests prove finite termination on the real host.

#[path = "../benches/support/linux_topology.rs"]
mod linux_topology;

#[path = "../benches/support/atomic.rs"]
mod atomic;

use std::collections::BTreeSet;
use std::path::Path;

use linux_topology::{
    auto_select, is_singleton_affinity, parse_cpu_list, read_topology, validate_pair,
    AutoSelection, Class,
};

/// Writes one file under a synthetic sysfs root.
fn put(root: &Path, rel: &str, contents: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

struct SynthCpu {
    cpu: u32,
    package: u32,
    core: u32,
    siblings: String,
    l3_shared: Option<String>,
}

/// Builds a synthetic sysfs tree for a CPU list plus per-node cpulists.
fn synth(root: &Path, cpus: &[SynthCpu], nodes: &[(u32, &str)]) {
    let online: Vec<String> = cpus.iter().map(|c| c.cpu.to_string()).collect();
    put(root, "sys/devices/system/cpu/online", &online.join(","));
    for c in cpus {
        let base = format!("sys/devices/system/cpu/cpu{}", c.cpu);
        put(
            root,
            &format!("{base}/topology/physical_package_id"),
            &c.package.to_string(),
        );
        put(
            root,
            &format!("{base}/topology/core_id"),
            &c.core.to_string(),
        );
        put(
            root,
            &format!("{base}/topology/thread_siblings_list"),
            &c.siblings,
        );
        if let Some(shared) = &c.l3_shared {
            put(root, &format!("{base}/cache/index3/level"), "3");
            put(root, &format!("{base}/cache/index3/type"), "Unified");
            put(
                root,
                &format!("{base}/cache/index3/shared_cpu_list"),
                shared,
            );
        }
    }
    for (node, cpulist) in nodes {
        put(
            root,
            &format!("sys/devices/system/node/node{node}/cpulist"),
            cpulist,
        );
    }
}

fn cpu(cpu: u32, core: u32, l3: &str) -> SynthCpu {
    SynthCpu {
        cpu,
        package: 0,
        core,
        siblings: cpu.to_string(),
        l3_shared: Some(l3.to_owned()),
    }
}

fn allowed(cpus: &[u32]) -> BTreeSet<u32> {
    cpus.iter().copied().collect()
}

#[test]
fn parses_kernel_cpu_lists() {
    let set = parse_cpu_list("0-3,8,10-11").unwrap();
    assert_eq!(set, allowed(&[0, 1, 2, 3, 8, 10, 11]));
    assert!(parse_cpu_list("").unwrap().is_empty());
    assert!(parse_cpu_list("3-1").is_err());
    assert!(parse_cpu_list("a-b").is_err());
}

#[test]
fn classifies_same_l3_pair() {
    let dir = tempfile::tempdir().unwrap();
    synth(
        dir.path(),
        &[cpu(0, 0, "0-3"), cpu(1, 1, "0-3")],
        &[(0, "0-1")],
    );
    let topo = read_topology(dir.path()).unwrap();
    validate_pair(&topo, &allowed(&[0, 1]), (0, 1), Class::SameL3).unwrap();
    assert_eq!(
        auto_select(&topo, &allowed(&[0, 1]), Class::SameL3),
        AutoSelection::Pair(0, 1)
    );
}

#[test]
fn classifies_cross_numa_pair_and_preserves_order() {
    let dir = tempfile::tempdir().unwrap();
    synth(
        dir.path(),
        &[cpu(0, 0, "0"), cpu(4, 4, "4")],
        &[(0, "0"), (1, "4")],
    );
    let topo = read_topology(dir.path()).unwrap();
    validate_pair(&topo, &allowed(&[0, 4]), (0, 4), Class::CrossNuma).unwrap();
    // Ordered roles: (4, 0) is also valid but distinct; auto-selection is
    // deterministic lowest-first.
    validate_pair(&topo, &allowed(&[0, 4]), (4, 0), Class::CrossNuma).unwrap();
    assert_eq!(
        auto_select(&topo, &allowed(&[0, 4]), Class::CrossNuma),
        AutoSelection::Pair(0, 4)
    );
}

#[test]
fn explicit_pair_failures_are_configuration_errors() {
    let dir = tempfile::tempdir().unwrap();
    // cpu0/cpu1: SMT siblings on core 0. cpu2: second core, same L3.
    // cpu8: different node. cpu6: offline (absent).
    synth(
        dir.path(),
        &[
            SynthCpu {
                cpu: 0,
                package: 0,
                core: 0,
                siblings: "0-1".to_owned(),
                l3_shared: Some("0-2".to_owned()),
            },
            SynthCpu {
                cpu: 1,
                package: 0,
                core: 0,
                siblings: "0-1".to_owned(),
                l3_shared: Some("0-2".to_owned()),
            },
            cpu(2, 1, "0-2"),
            cpu(8, 8, "8"),
        ],
        &[(0, "0-2"), (1, "8")],
    );
    let topo = read_topology(dir.path()).unwrap();
    let all = allowed(&[0, 1, 2, 8]);

    // Duplicate CPU.
    let err = validate_pair(&topo, &all, (0, 0), Class::SameL3).unwrap_err();
    assert!(err.contains("same CPU twice"), "{err}");
    // SMT siblings.
    let err = validate_pair(&topo, &all, (0, 1), Class::SameL3).unwrap_err();
    assert!(err.contains("SMT siblings"), "{err}");
    // Offline CPU.
    let err = validate_pair(&topo, &all, (0, 6), Class::SameL3).unwrap_err();
    assert!(err.contains("not online"), "{err}");
    // Disallowed CPU.
    let err = validate_pair(&topo, &allowed(&[0]), (0, 2), Class::SameL3).unwrap_err();
    assert!(err.contains("allowed affinity"), "{err}");
    // Class mismatch both directions.
    let err = validate_pair(&topo, &all, (0, 8), Class::SameL3).unwrap_err();
    assert!(err.contains("spans NUMA nodes"), "{err}");
    let err = validate_pair(&topo, &all, (0, 2), Class::CrossNuma).unwrap_err();
    assert!(err.contains("one NUMA node"), "{err}");
    // The valid explicit pairs still pass.
    validate_pair(&topo, &all, (0, 2), Class::SameL3).unwrap();
    validate_pair(&topo, &all, (0, 8), Class::CrossNuma).unwrap();
}

#[test]
fn one_node_allowed_set_skips_cross_numa_auto_selection() {
    let dir = tempfile::tempdir().unwrap();
    synth(
        dir.path(),
        &[cpu(0, 0, "0-1"), cpu(1, 1, "0-1")],
        &[(0, "0-1")],
    );
    let topo = read_topology(dir.path()).unwrap();
    match auto_select(&topo, &allowed(&[0, 1]), Class::CrossNuma) {
        AutoSelection::Unavailable(reason) => {
            assert!(
                reason.contains("NUMA"),
                "reason names the constraint: {reason}"
            );
        }
        AutoSelection::Pair(a, b) => panic!("fabricated cross-NUMA pair ({a},{b})"),
    }
    // The same host still auto-selects a valid same-L3 pair.
    assert_eq!(
        auto_select(&topo, &allowed(&[0, 1]), Class::SameL3),
        AutoSelection::Pair(0, 1)
    );
}

#[test]
fn missing_unified_l3_cannot_classify_same_l3() {
    let dir = tempfile::tempdir().unwrap();
    synth(
        dir.path(),
        &[
            SynthCpu {
                cpu: 0,
                package: 0,
                core: 0,
                siblings: "0".to_owned(),
                l3_shared: None,
            },
            SynthCpu {
                cpu: 1,
                package: 0,
                core: 1,
                siblings: "1".to_owned(),
                l3_shared: None,
            },
        ],
        &[(0, "0-1")],
    );
    let topo = read_topology(dir.path()).unwrap();
    assert!(validate_pair(&topo, &allowed(&[0, 1]), (0, 1), Class::SameL3).is_err());
    assert!(matches!(
        auto_select(&topo, &allowed(&[0, 1]), Class::SameL3),
        AutoSelection::Unavailable(_)
    ));
}

#[test]
fn non_singleton_affinity_readback_is_rejected() {
    // The pure check the pin path uses before timing.
    assert!(is_singleton_affinity(&allowed(&[3]), 3));
    assert!(!is_singleton_affinity(&allowed(&[3, 4]), 3));
    assert!(!is_singleton_affinity(&allowed(&[4]), 3));
    assert!(!is_singleton_affinity(&allowed(&[]), 3));
}

/// Two distinct allowed CPUs on this host, if available.
fn two_allowed_cpus() -> Option<(u32, u32)> {
    let affinity = linux_topology::effective_affinity().ok()?;
    let mut iter = affinity.into_iter();
    Some((iter.next()?, iter.next()?))
}

#[test]
fn finite_atomic_handshake_completes_and_joins() {
    let Some((a, b)) = two_allowed_cpus() else {
        eprintln!("skipping: fewer than two allowed CPUs");
        return;
    };
    let cfg = atomic::PingPongConfig {
        initiator_cpu: a,
        responder_cpu: b,
        warmup_batches: 2,
        batches: 5,
        exchanges_per_batch: 100,
    };
    let out = atomic::run_ping_pong(cfg).unwrap();
    // The exact requested exchange count, full RTT per exchange, and both
    // threads joined (run_ping_pong returned).
    assert_eq!(out.total_exchanges, 5 * 100);
    assert_eq!(out.batch_mean_rtt_ns.len(), 5);
    assert!(out.batch_mean_rtt_ns.iter().all(|&ns| ns > 0.0));
    assert_eq!(out.initiator.before, a);
    assert_eq!(out.initiator.after, a);
    assert_eq!(out.responder.before, b);
    assert_eq!(out.responder.after, b);
    assert!(out.exchanges_per_sec() > 0.0);
}

#[test]
fn pinning_an_invalid_cpu_fails_before_timing() {
    // CPU ids above the kernel cpuset size cannot be pinned; both threads
    // must abort and join rather than hang on the readiness barrier.
    let err = atomic::run_ping_pong(atomic::PingPongConfig {
        initiator_cpu: u32::MAX - 1,
        responder_cpu: 0,
        warmup_batches: 0,
        batches: 1,
        exchanges_per_batch: 1,
    })
    .unwrap_err();
    assert!(err.contains("pin") || err.contains("aborted"), "{err}");
}
