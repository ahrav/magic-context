//! This module reads Linux CPU topology, validates pairs, and pins threads for the IPC budget benchmark.
//!
//! The root parameter lets tests classify synthetic sysfs fixtures.
//! Classification uses physical-core, unified-L3, and NUMA-node relationships.

#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// `Class` classifies ordered `(initiator, responder)` CPU pairs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    SameL3,
    CrossNuma,
}

impl Class {
    pub fn label(self) -> &'static str {
        match self {
            Class::SameL3 => "same-l3",
            Class::CrossNuma => "cross-numa",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "same-l3" => Ok(Class::SameL3),
            "cross-numa" => Ok(Class::CrossNuma),
            other => Err(format!("unknown topology class {other:?}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CpuDesc {
    /// (physical_package_id, core_id): distinct tuples are distinct cores.
    pub core: (u32, u32),
    pub node: u32,
    /// `l3` stores the `shared_cpu_list` that identifies the CPU's unified L3.
    pub l3: Option<String>,
    /// `siblings` contains the CPU's SMT siblings, including the CPU itself.
    pub siblings: Vec<u32>,
}

/// `Topology` contains observed descriptors for the online CPUs.
#[derive(Debug, Clone, Default)]
pub struct Topology {
    pub cpus: BTreeMap<u32, CpuDesc>,
}

pub fn parse_cpu_list(list: &str) -> Result<BTreeSet<u32>, String> {
    let mut out = BTreeSet::new();
    let trimmed = list.trim();
    if trimmed.is_empty() {
        return Ok(out);
    }
    for part in trimmed.split(',') {
        match part.split_once('-') {
            Some((lo, hi)) => {
                let lo: u32 = lo.trim().parse().map_err(|_| bad_list(list))?;
                let hi: u32 = hi.trim().parse().map_err(|_| bad_list(list))?;
                if lo > hi {
                    return Err(bad_list(list));
                }
                out.extend(lo..=hi);
            }
            None => {
                out.insert(part.trim().parse().map_err(|_| bad_list(list))?);
            }
        }
    }
    Ok(out)
}

fn bad_list(list: &str) -> String {
    format!("malformed cpulist {list:?}")
}

fn read_trimmed(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path)
        .map(|s| s.trim().to_owned())
        .map_err(|err| format!("{}: {err}", path.display()))
}

/// Production callers pass `/`; tests pass synthetic sysfs roots.
pub fn read_topology(root: &Path) -> Result<Topology, String> {
    let cpu_base = root.join("sys/devices/system/cpu");
    let online = parse_cpu_list(&read_trimmed(&cpu_base.join("online"))?)?;

    let mut node_of = BTreeMap::new();
    let node_base = root.join("sys/devices/system/node");
    if !node_base.is_dir() {
        for cpu in &online {
            node_of.insert(*cpu, 0u32);
        }
    } else {
        let entries = std::fs::read_dir(&node_base)
            .map_err(|err| format!("{}: {err}", node_base.display()))?;
        for entry in entries {
            let entry = entry.map_err(|err| err.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name
                .strip_prefix("node")
                .and_then(|n| n.parse::<u32>().ok())
            else {
                continue;
            };
            let cpulist = entry.path().join("cpulist");
            if !cpulist.exists() {
                continue;
            }
            for cpu in parse_cpu_list(&read_trimmed(&cpulist)?)? {
                node_of.insert(cpu, id);
            }
        }
    }

    let mut cpus = BTreeMap::new();
    for cpu in online {
        let topo = cpu_base.join(format!("cpu{cpu}/topology"));
        let package: u32 = read_trimmed(&topo.join("physical_package_id"))?
            .parse()
            .map_err(|_| format!("cpu{cpu}: malformed physical_package_id"))?;
        let core: u32 = read_trimmed(&topo.join("core_id"))?
            .parse()
            .map_err(|_| format!("cpu{cpu}: malformed core_id"))?;
        let siblings = parse_cpu_list(&read_trimmed(&topo.join("thread_siblings_list"))?)?
            .into_iter()
            .collect();
        let node = *node_of
            .get(&cpu)
            .ok_or_else(|| format!("cpu{cpu} belongs to no CPU-bearing NUMA node"))?;
        cpus.insert(
            cpu,
            CpuDesc {
                core: (package, core),
                node,
                l3: unified_l3(&cpu_base.join(format!("cpu{cpu}/cache")), cpu)?,
                siblings,
            },
        );
    }
    Ok(Topology { cpus })
}

/// The CPU's `shared_cpu_list` identifies its unified L3 cache.
/// shared_cpu_list string.
fn unified_l3(cache_dir: &Path, cpu: u32) -> Result<Option<String>, String> {
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return Ok(None);
    };
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        if !entry.file_name().to_string_lossy().starts_with("index") {
            continue;
        }
        let dir = entry.path();
        let level = read_trimmed(&dir.join("level"))?;
        let ty = read_trimmed(&dir.join("type"))?;
        if level == "3" && ty == "Unified" {
            let shared = read_trimmed(&dir.join("shared_cpu_list"))?;
            if !parse_cpu_list(&shared)?.contains(&cpu) {
                return Err(format!("cpu{cpu}: L3 shared_cpu_list omits the CPU itself"));
            }
            return Ok(Some(shared));
        }
    }
    Ok(None)
}

/// `validate_pair` rejects an ordered pair that violates the observed topology or declared class rather than substituting CPUs.
pub fn validate_pair(
    topology: &Topology,
    allowed: &BTreeSet<u32>,
    pair: (u32, u32),
    class: Class,
) -> Result<(), String> {
    let (a, b) = pair;
    if a == b {
        return Err(format!("pair ({a},{b}) names the same CPU twice"));
    }
    for cpu in [a, b] {
        if !topology.cpus.contains_key(&cpu) {
            return Err(format!("cpu{cpu} is not online"));
        }
        if !allowed.contains(&cpu) {
            return Err(format!("cpu{cpu} is outside the allowed affinity set"));
        }
    }
    let da = &topology.cpus[&a];
    let db = &topology.cpus[&b];
    if da.siblings.contains(&b) {
        return Err(format!("cpu{a} and cpu{b} are SMT siblings"));
    }
    if da.core == db.core {
        return Err(format!("cpu{a} and cpu{b} share one physical core"));
    }
    match class {
        Class::SameL3 => {
            if da.node != db.node {
                return Err(format!(
                    "same-l3 pair spans NUMA nodes {} and {}",
                    da.node, db.node
                ));
            }
            match (&da.l3, &db.l3) {
                (Some(la), Some(lb)) if la == lb => Ok(()),
                (Some(_), Some(_)) => Err(format!(
                    "cpu{a} and cpu{b} do not share one unified L3 cache"
                )),
                _ => Err(format!("cpu{a} or cpu{b} reports no unified L3 cache")),
            }
        }
        Class::CrossNuma => {
            if da.node == db.node {
                return Err(format!(
                    "cross-numa pair sits on one NUMA node ({})",
                    da.node
                ));
            }
            Ok(())
        }
    }
}

/// The selection result records either a valid pair or why the requested class is unavailable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoSelection {
    /// The selected pair is valid and orders CPUs by ascending number.
    Pair(u32, u32),
    /// skipped manifest.
    Unavailable(String),
}

/// `select_pair` deterministically selects the lowest-numbered valid ordered pair.
pub fn auto_select(topology: &Topology, allowed: &BTreeSet<u32>, class: Class) -> AutoSelection {
    let candidates: Vec<u32> = allowed
        .iter()
        .copied()
        .filter(|cpu| topology.cpus.contains_key(cpu))
        .collect();
    for (i, &a) in candidates.iter().enumerate() {
        for &b in &candidates[i + 1..] {
            if validate_pair(topology, allowed, (a, b), class).is_ok() {
                return AutoSelection::Pair(a, b);
            }
        }
    }
    let reason = match class {
        Class::SameL3 => {
            "no two allowed online CPUs on distinct physical cores share one \
                          unified L3 cache"
        }
        Class::CrossNuma => {
            "the allowed CPU set does not span two CPU-bearing NUMA nodes \
                             with distinct physical cores"
        }
    };
    AutoSelection::Unavailable(reason.to_owned())
}

pub fn is_singleton_affinity(affinity: &BTreeSet<u32>, cpu: u32) -> bool {
    affinity.len() == 1 && affinity.contains(&cpu)
}

/// The returned set is the calling thread's effective affinity.
pub fn effective_affinity() -> Result<BTreeSet<u32>, String> {
    let set = rustix::thread::sched_getaffinity(None)
        .map_err(|err| format!("sched_getaffinity: {err}"))?;
    let mut out = BTreeSet::new();
    for cpu in 0..rustix::thread::CpuSet::MAX_CPU {
        if set.is_set(cpu) {
            out.insert(cpu as u32);
        }
    }
    Ok(out)
}

/// Pinning fails unless post-pin affinity contains exactly the requested CPU.
/// The readback must be the singleton `{cpu}`; an intersected mask could label results with CPUs that never executed the work.
pub fn pin_current_thread(cpu: u32) -> Result<(), String> {
    if cpu as usize >= rustix::thread::CpuSet::MAX_CPU {
        return Err(format!(
            "cpu{cpu} exceeds the kernel cpuset size {}",
            rustix::thread::CpuSet::MAX_CPU
        ));
    }
    let mut set = rustix::thread::CpuSet::new();
    set.set(cpu as usize);
    rustix::thread::sched_setaffinity(None, &set)
        .map_err(|err| format!("sched_setaffinity(cpu{cpu}): {err}"))?;
    let readback = effective_affinity()?;
    if !is_singleton_affinity(&readback, cpu) {
        return Err(format!(
            "affinity readback {readback:?} is not the singleton {{{cpu}}}"
        ));
    }
    Ok(())
}

/// The kernel rejects an empty mask; retaining the old mask would leave the thread pinned.
pub fn set_current_thread_affinity(cpus: &BTreeSet<u32>) -> Result<(), String> {
    if cpus.is_empty() {
        return Err("cannot set affinity to an empty CPU set".to_owned());
    }
    let mut set = rustix::thread::CpuSet::new();
    for &cpu in cpus {
        if cpu as usize >= rustix::thread::CpuSet::MAX_CPU {
            return Err(format!(
                "cpu{cpu} exceeds the kernel cpuset size {}",
                rustix::thread::CpuSet::MAX_CPU
            ));
        }
        set.set(cpu as usize);
    }
    rustix::thread::sched_setaffinity(None, &set)
        .map_err(|err| format!("sched_setaffinity({cpus:?}): {err}"))
}

pub fn current_cpu() -> u32 {
    rustix::thread::sched_getcpu() as u32
}
