//! Cross-platform test-only process resource observer (plan U5, KTD9,
//! R13).
//!
//! Counts open file descriptors, mapped memory regions, and threads for
//! one pid through one interface. Linux reads `/proc/<pid>/fd`,
//! `/proc/<pid>/maps`, and `/proc/<pid>/task`; macOS uses the public
//! `libproc` selectors `PROC_PIDLISTFDS`, `PROC_PIDREGIONINFO`, and
//! `PROC_PIDLISTTHREADS`. Short, unsupported, or permission-denied
//! observations FAIL with a bounded error naming only the counter kind —
//! a counter is never silently dropped (R13). Errors carry no paths,
//! addresses, or provider data (R17).
//!
//! Observing a process's own fd table on Linux includes the enumeration
//! descriptor itself; the bias is constant across samples, so deltas and
//! envelope comparisons are unaffected. commentlint: allow(JUDGE)

use std::collections::BTreeMap;
use std::fmt;

/// One role-tagged observation of a process's OS resource counters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResourceCounts {
    pub fds: u64,
    pub mapped_regions: u64,
    pub threads: u64,
}

impl ResourceCounts {
    /// Counter kind/value pairs for uniform envelope comparisons.
    pub fn counters(&self) -> [(&'static str, u64); 3] {
        [
            ("fds", self.fds),
            ("mapped_regions", self.mapped_regions),
            ("threads", self.threads),
        ]
    }
}

/// Failed observation. Carries only the counter kind (R13, R17).
#[derive(Clone, Copy)]
pub struct ObserveError {
    counter: &'static str,
}

impl fmt::Debug for ObserveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "ObserveError({})", self.counter)
    }
}

impl fmt::Display for ObserveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "process resource observation failed for counter {}",
            self.counter
        )
    }
}

impl std::error::Error for ObserveError {}

fn fail(counter: &'static str) -> ObserveError {
    ObserveError { counter }
}

/// Observes all three counters for `pid`, failing the whole observation if
/// any single counter cannot be read exactly.
pub fn observe(pid: u32) -> Result<ResourceCounts, ObserveError> {
    Ok(ResourceCounts {
        fds: count_fds(pid)?,
        mapped_regions: count_mapped_regions(pid)?,
        threads: count_threads(pid)?,
    })
}

/// Linux scheduler/accounting counters for one task. Values are raw kernel
/// clock ticks and context-switch counts, so deltas need no wall-clock
/// conversion and retain exact `/proc` evidence.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct TaskCounters {
    pub tid: u32,
    pub name: String,
    pub utime_ticks: u64,
    pub stime_ticks: u64,
    pub voluntary_context_switches: u64,
    pub nonvoluntary_context_switches: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct TaskDelta {
    pub tid: u32,
    pub name: String,
    pub role: &'static str,
    pub utime_ticks: u64,
    pub stime_ticks: u64,
    pub voluntary_context_switches: u64,
    pub nonvoluntary_context_switches: u64,
}

/// Enumerates every Linux task through the same `/proc/<pid>/task` authority
/// used by the resource observer. Unsupported platforms fail explicitly.
#[cfg(target_os = "linux")]
pub fn observe_tasks(pid: u32) -> Result<BTreeMap<u32, TaskCounters>, ObserveError> {
    let counter = "task_stat_status";
    let entries = std::fs::read_dir(format!("/proc/{pid}/task")).map_err(|_| fail(counter))?;
    let mut tasks = BTreeMap::new();
    for entry in entries {
        let entry = entry.map_err(|_| fail(counter))?;
        let tid = entry
            .file_name()
            .to_string_lossy()
            .parse::<u32>()
            .map_err(|_| fail(counter))?;
        let stat = std::fs::read_to_string(entry.path().join("stat")).map_err(|_| fail(counter))?;
        let status =
            std::fs::read_to_string(entry.path().join("status")).map_err(|_| fail(counter))?;
        let (name, utime_ticks, stime_ticks) =
            parse_task_stat(&stat).ok_or_else(|| fail(counter))?;
        let voluntary_context_switches =
            status_counter(&status, "voluntary_ctxt_switches").ok_or_else(|| fail(counter))?;
        let nonvoluntary_context_switches =
            status_counter(&status, "nonvoluntary_ctxt_switches").ok_or_else(|| fail(counter))?;
        tasks.insert(
            tid,
            TaskCounters {
                tid,
                name,
                utime_ticks,
                stime_ticks,
                voluntary_context_switches,
                nonvoluntary_context_switches,
            },
        );
    }
    Ok(tasks)
}

#[cfg(not(target_os = "linux"))]
pub fn observe_tasks(_pid: u32) -> Result<BTreeMap<u32, TaskCounters>, ObserveError> {
    Err(fail("task_stat_status"))
}

#[cfg(target_os = "linux")]
fn parse_task_stat(stat: &str) -> Option<(String, u64, u64)> {
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let name = stat.get(open + 1..close)?.to_owned();
    let fields: Vec<&str> = stat.get(close + 1..)?.split_whitespace().collect();
    Some((
        name,
        fields.get(11)?.parse().ok()?,
        fields.get(12)?.parse().ok()?,
    ))
}

#[cfg(target_os = "linux")]
fn status_counter(status: &str, key: &str) -> Option<u64> {
    status.lines().find_map(|line| {
        let (actual, value) = line.split_once(':')?;
        (actual == key).then(|| value.trim().parse().ok()).flatten()
    })
}

pub fn task_deltas(
    before: &BTreeMap<u32, TaskCounters>,
    after: &BTreeMap<u32, TaskCounters>,
) -> Vec<TaskDelta> {
    after
        .values()
        .map(|end| {
            let start = before.get(&end.tid);
            TaskDelta {
                tid: end.tid,
                name: end.name.clone(),
                role: if end.name.starts_with("host-") {
                    "host_runtime"
                } else {
                    "generator"
                },
                utime_ticks: end
                    .utime_ticks
                    .saturating_sub(start.map_or(0, |task| task.utime_ticks)),
                stime_ticks: end
                    .stime_ticks
                    .saturating_sub(start.map_or(0, |task| task.stime_ticks)),
                voluntary_context_switches: end
                    .voluntary_context_switches
                    .saturating_sub(start.map_or(0, |task| task.voluntary_context_switches)),
                nonvoluntary_context_switches: end
                    .nonvoluntary_context_switches
                    .saturating_sub(start.map_or(0, |task| task.nonvoluntary_context_switches)),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Linux backend: /proc (R13).
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn count_dir_entries(path: &str, counter: &'static str) -> Result<u64, ObserveError> {
    let entries = std::fs::read_dir(path).map_err(|_| fail(counter))?;
    let mut count = 0u64;
    for entry in entries {
        entry.map_err(|_| fail(counter))?;
        count += 1;
    }
    Ok(count)
}

#[cfg(target_os = "linux")]
fn count_fds(pid: u32) -> Result<u64, ObserveError> {
    count_dir_entries(&format!("/proc/{pid}/fd"), "fds")
}

#[cfg(target_os = "linux")]
fn count_mapped_regions(pid: u32) -> Result<u64, ObserveError> {
    let maps =
        std::fs::read_to_string(format!("/proc/{pid}/maps")).map_err(|_| fail("mapped_regions"))?;
    let count = maps.lines().filter(|line| !line.is_empty()).count();
    u64::try_from(count).map_err(|_| fail("mapped_regions"))
}

#[cfg(target_os = "linux")]
fn count_threads(pid: u32) -> Result<u64, ObserveError> {
    count_dir_entries(&format!("/proc/{pid}/task"), "threads")
}

// ---------------------------------------------------------------------------
// macOS backend: public libproc (R13). Compiled and self-testable on macOS
// CI; this crate's provisional soak tuple itself is Linux-only until the
// frozen `.12` manifest retains a macOS provider. commentlint: allow(JUDGE)
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod libproc {
    use std::ffi::c_void;
    use std::os::raw::c_int;

    /// Public selectors from XNU `bsd/sys/proc_info.h`.
    pub const PROC_PIDLISTFDS: c_int = 1;
    pub const PROC_PIDLISTTHREADS: c_int = 6;
    pub const PROC_PIDREGIONINFO: c_int = 7;

    /// `struct proc_fdinfo` from `proc_info.h`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct ProcFdInfo {
        pub proc_fd: i32,
        pub proc_fdtype: u32,
    }

    /// `struct proc_regioninfo` from `proc_info.h`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct ProcRegionInfo {
        pub pri_protection: u32,
        pub pri_max_protection: u32,
        pub pri_inheritance: u32,
        pub pri_flags: u32,
        pub pri_offset: u64,
        pub pri_behavior: u32,
        pub pri_user_wired_count: u32,
        pub pri_user_tag: u32,
        pub pri_pages_resident: u32,
        pub pri_pages_shared_now_private: u32,
        pub pri_pages_swapped_out: u32,
        pub pri_pages_dirtied: u32,
        pub pri_ref_count: u32,
        pub pri_shadow_depth: u32,
        pub pri_share_mode: u32,
        pub pri_private_pages_resident: u32,
        pub pri_shared_pages_resident: u32,
        pub pri_obj_id: u32,
        pub pri_depth: u32,
        pub pri_address: u64,
        pub pri_size: u64,
    }

    extern "C" {
        /// Public `libproc.h` entry point; not exposed by the `libc` crate.
        pub fn proc_pidinfo(
            pid: c_int,
            flavor: c_int,
            arg: u64,
            buffer: *mut c_void,
            buffersize: c_int,
        ) -> c_int;
    }
}

/// Entries to size the first buffer for when no size hint is available.
/// The growth loop below still proves completeness, so this only decides
/// how many retries a wide process costs.
#[cfg(target_os = "macos")]
const LIST_ENTRY_HINT: usize = 64;

/// Counts fixed-size list entries returned by one `proc_pidinfo` list
/// selector, growing the buffer until the result provably fits. Short or
/// non-multiple results FAIL instead of dropping entries (R13).
#[cfg(target_os = "macos")]
fn count_list_entries(
    pid: u32,
    flavor: std::os::raw::c_int,
    entry_size: usize,
    counter: &'static str,
) -> Result<u64, ObserveError> {
    use libproc::proc_pidinfo;
    let pid = i32::try_from(pid).map_err(|_| fail(counter))?;
    // A NULL buffer is a size query for PROC_PIDLISTFDS alone: XNU zeroes
    // the required size for that flavor only, so every other list
    // selector takes the `buffersize < size` path and returns ENOMEM.
    // A refused probe is therefore a missing hint, not a failed
    // observation — only a sized call below can fail the counter.
    let probed = unsafe { proc_pidinfo(pid, flavor, 0, std::ptr::null_mut(), 0) };
    let hint = if probed > 0 {
        probed as usize
    } else {
        LIST_ENTRY_HINT.saturating_mul(entry_size)
    };
    let mut capacity = hint.saturating_add(16 * entry_size);
    for _ in 0..8 {
        let buffer_size = std::os::raw::c_int::try_from(capacity).map_err(|_| fail(counter))?;
        let mut buffer = vec![0u8; capacity];
        let returned =
            unsafe { proc_pidinfo(pid, flavor, 0, buffer.as_mut_ptr().cast(), buffer_size) };
        if returned <= 0 {
            return Err(fail(counter));
        }
        let returned = returned as usize;
        if returned % entry_size != 0 {
            // A short observation must fail, never round down (R13).
            return Err(fail(counter));
        }
        if returned < capacity {
            return u64::try_from(returned / entry_size).map_err(|_| fail(counter));
        }
        // The list may have been truncated at exactly the buffer size:
        // grow and retry until the count is provably complete.
        capacity = capacity.saturating_mul(2);
    }
    Err(fail(counter))
}

#[cfg(target_os = "macos")]
fn count_fds(pid: u32) -> Result<u64, ObserveError> {
    count_list_entries(
        pid,
        libproc::PROC_PIDLISTFDS,
        std::mem::size_of::<libproc::ProcFdInfo>(),
        "fds",
    )
}

#[cfg(target_os = "macos")]
fn count_threads(pid: u32) -> Result<u64, ObserveError> {
    // PROC_PIDLISTTHREADS returns one uint64_t thread id per thread.
    count_list_entries(
        pid,
        libproc::PROC_PIDLISTTHREADS,
        std::mem::size_of::<u64>(),
        "threads",
    )
}

#[cfg(target_os = "macos")]
fn count_mapped_regions(pid: u32) -> Result<u64, ObserveError> {
    use libproc::{proc_pidinfo, ProcRegionInfo, PROC_PIDREGIONINFO};
    let counter = "mapped_regions";
    let pid = i32::try_from(pid).map_err(|_| fail(counter))?;
    let size = std::mem::size_of::<ProcRegionInfo>();
    let buffer_size = std::os::raw::c_int::try_from(size).map_err(|_| fail(counter))?;
    let mut address = 0u64;
    let mut count = 0u64;
    // Bounded region walk: iterate addresses until the kernel reports no
    // region at or above the cursor.
    for _ in 0..1_000_000u32 {
        let mut info: ProcRegionInfo = unsafe { std::mem::zeroed() };
        let returned = unsafe {
            proc_pidinfo(
                pid,
                PROC_PIDREGIONINFO,
                address,
                (&mut info as *mut ProcRegionInfo).cast(),
                buffer_size,
            )
        };
        if returned <= 0 {
            // End of the address space is only distinguishable after at
            // least one region; an empty walk is unsupported or
            // permission-denied and must FAIL (R13).
            return if count > 0 {
                Ok(count)
            } else {
                Err(fail(counter))
            };
        }
        if (returned as usize) < size {
            return Err(fail(counter));
        }
        count += 1;
        let next = info
            .pri_address
            .checked_add(info.pri_size)
            .ok_or_else(|| fail(counter))?;
        if next <= address {
            // A non-advancing walk would count one region forever.
            return Err(fail(counter));
        }
        address = next;
    }
    Err(fail(counter))
}

// ---------------------------------------------------------------------------
// Other platforms: unsupported observations fail, never silently zero.
// ---------------------------------------------------------------------------

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn count_fds(_pid: u32) -> Result<u64, ObserveError> {
    Err(fail("fds"))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn count_mapped_regions(_pid: u32) -> Result<u64, ObserveError> {
    Err(fail("mapped_regions"))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn count_threads(_pid: u32) -> Result<u64, ObserveError> {
    Err(fail("threads"))
}
