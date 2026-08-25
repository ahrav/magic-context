#![deny(unsafe_op_in_unsafe_fn)]

mod lifecycle;
mod napi_buffers;
mod scheduling;

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::os::fd::OwnedFd;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use mc_shm_transport::backend::ring::{Ring, RingGrant};
use mc_shm_transport::descriptor::{
    HardwareProfileId, ReleaseIdentity, SchedulingMode, WIRE_V2_HEADER_BYTES,
};
use mc_shm_transport::profile::ring_profile;
use napi::bindgen_prelude::{Buffer, FnArgs, Function};
use napi::{Env, Error, Result, Status, Unknown};
use napi_derive::napi;

use napi_buffers::ExternalRef;

const PROFILE: &str = "mc-host-test-ring-v1";

#[napi(object)]
pub struct NativeDescriptor {
    pub profile: String,
    pub pid: u32,
    pub host_to_peer_fd: i32,
    pub host_to_peer_grant: String,
    pub peer_to_host_fd: i32,
    pub peer_to_host_grant: String,
}

#[napi(object)]
pub struct NativeTestPair {
    pub first: u32,
    pub second: u32,
    pub descriptor_depth: u32,
    pub arena_bytes: u32,
}

struct ActiveLease {
    identity: ReleaseIdentity,
    buffers: Vec<ExternalRef>,
}

struct Channel {
    to_host: Ring,
    from_host: Ring,
    active: HashMap<u32, ActiveLease>,
    next_lease: u32,
    closed: bool,
}

#[derive(Default)]
struct Registry {
    next_channel: u32,
    channels: HashMap<u32, Channel>,
    cleanup_registered: bool,
}

thread_local! {
    static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default());
}

fn error(message: &'static str) -> Error {
    Error::new(Status::GenericFailure, message)
}

fn decode_hex<const N: usize>(text: &str) -> Result<[u8; N]> {
    if text.len() != N * 2 {
        return Err(error("invalid attachment grant"));
    }
    let mut bytes = [0u8; N];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16)
            .map_err(|_| error("invalid attachment grant"))?;
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
fn attach_ring(pid: u32, fd: i32, grant: &str) -> Result<Ring> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(format!("/proc/{pid}/fd/{fd}"))
        .map_err(|_| error("shared-memory attachment failed"))?;
    let grant = RingGrant::decode(decode_hex(grant)?)
        .map_err(|_| error("shared-memory attachment failed"))?;
    Ring::attach(OwnedFd::from(file), grant, SchedulingMode::ColdParkWake)
        .map_err(|_| error("shared-memory attachment failed"))
}

fn detach_active(env: &Env, channel: &mut Channel, token: u32) -> Result<()> {
    let Some(active) = channel.active.remove(&token) else {
        return Err(error("receive lease is already released"));
    };
    for buffer in &active.buffers {
        if napi_buffers::detach(env, buffer).is_err() {
            channel.from_host.enter_quarantine();
            channel.active.insert(token, active);
            return Err(error("receive alias state is unknown; storage quarantined"));
        }
    }
    for buffer in active.buffers {
        napi_buffers::delete_ref(env, buffer)?;
    }
    channel
        .from_host
        .release(active.identity)
        .map_err(|_| error("receive completion failed"))
}

fn close_channel(env: &Env, channel: &mut Channel) -> Result<()> {
    channel.closed = true;
    let tokens: Vec<u32> = channel.active.keys().copied().collect();
    for token in tokens {
        detach_active(env, channel, token)?;
    }
    Ok(())
}

fn quarantine_channel(env: &Env, channel: &mut Channel) -> Result<()> {
    channel.closed = true;
    channel.to_host.enter_quarantine();
    channel.from_host.enter_quarantine();
    let tokens: Vec<u32> = channel.active.keys().copied().collect();
    for token in tokens {
        let Some(active) = channel.active.remove(&token) else {
            continue;
        };
        for buffer in &active.buffers {
            if napi_buffers::detach(env, buffer).is_err() {
                channel.active.insert(token, active);
                return Err(error("receive alias state is unknown; storage quarantined"));
            }
        }
        for buffer in active.buffers {
            napi_buffers::delete_ref(env, buffer)?;
        }
    }
    Ok(())
}

fn insert_channel(registry: &mut Registry, channel: Channel) -> Result<u32> {
    registry.next_channel = registry
        .next_channel
        .checked_add(1)
        .ok_or_else(|| error("native channel identity exhausted"))?;
    let id = registry.next_channel;
    registry.channels.insert(id, channel);
    Ok(id)
}

fn cleanup_env(raw_env: usize) {
    let raw_env = raw_env as napi::sys::napi_env;
    let env = Env::from_raw(raw_env);
    REGISTRY.with(|registry| {
        if let Ok(mut registry) = registry.try_borrow_mut() {
            for channel in registry.channels.values_mut() {
                if close_channel(&env, channel).is_err() {
                    channel.from_host.enter_quarantine();
                }
            }
            registry.channels.clear();
        }
    });
}

fn ensure_cleanup(env: &Env, registry: &mut Registry) -> Result<()> {
    if registry.cleanup_registered {
        return Ok(());
    }
    let raw = env.raw() as usize;
    env.add_async_cleanup_hook(raw, cleanup_env)?;
    registry.cleanup_registered = true;
    Ok(())
}

#[napi]
pub fn napi_version(env: &Env) -> Result<u32> {
    let mut version = 0u32;
    // SAFETY: version points to writable storage and env is current.
    let status = unsafe { napi::sys::napi_get_version(env.raw(), &mut version) };
    if status == napi::sys::Status::napi_ok {
        Ok(version)
    } else {
        Err(error("N-API version probe failed"))
    }
}

#[napi]
pub fn create_external_probe<'env>(env: &'env Env, length: u32) -> Result<Unknown<'env>> {
    napi_buffers::create_owned_probe(env, length as usize)
}

#[napi]
pub fn detach_array_buffer(env: &Env, buffer: Unknown<'_>) -> Result<bool> {
    napi_buffers::detach_value(env, buffer)
}

#[napi]
pub fn register_cleanup_probe(env: &Env, path: String) -> Result<()> {
    lifecycle::register_cleanup_marker(env, PathBuf::from(path))
}

#[napi]
pub fn native_leak_diagnostics() -> u32 {
    napi_buffers::leak_diagnostics().min(u64::from(u32::MAX)) as u32
}

#[napi]
pub fn worker_limit() -> u32 {
    scheduling::WORKER_LIMIT
}

#[napi]
pub fn attach(env: &Env, descriptor: NativeDescriptor) -> Result<u32> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (env, descriptor);
        return Err(error(
            "shared-memory transport is unsupported on this platform",
        ));
    }
    #[cfg(target_os = "linux")]
    {
        if descriptor.profile != PROFILE {
            return Err(error("shared-memory profile is unavailable"));
        }
        let from_host = attach_ring(
            descriptor.pid,
            descriptor.host_to_peer_fd,
            &descriptor.host_to_peer_grant,
        )?;
        let to_host = attach_ring(
            descriptor.pid,
            descriptor.peer_to_host_fd,
            &descriptor.peer_to_host_grant,
        )?;
        REGISTRY.with(|registry| {
            let mut registry = registry
                .try_borrow_mut()
                .map_err(|_| error("native channel is busy"))?;
            ensure_cleanup(env, &mut registry)?;
            insert_channel(
                &mut registry,
                Channel {
                    to_host,
                    from_host,
                    active: HashMap::new(),
                    next_lease: 0,
                    closed: false,
                },
            )
        })
    }
}

#[napi]
pub fn create_test_pair(env: &Env) -> Result<NativeTestPair> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = env;
        return Err(error(
            "shared-memory test pair is unsupported on this platform",
        ));
    }
    #[cfg(target_os = "linux")]
    {
        let profile = ring_profile(
            HardwareProfileId::new(PROFILE).map_err(|_| error("test profile unavailable"))?,
            SchedulingMode::ColdParkWake,
        )
        .map_err(|_| error("test profile unavailable"))?;
        let first_to_second = Ring::create(&profile, 1)
            .map_err(|_| error("shared-memory test pair creation failed"))?;
        let second_from_first = first_to_second
            .attachment()
            .and_then(|attachment| attachment.attach())
            .map_err(|_| error("shared-memory test pair creation failed"))?;
        let second_to_first = Ring::create(&profile, 2)
            .map_err(|_| error("shared-memory test pair creation failed"))?;
        let first_from_second = second_to_first
            .attachment()
            .and_then(|attachment| attachment.attach())
            .map_err(|_| error("shared-memory test pair creation failed"))?;
        REGISTRY.with(|registry| {
            let mut registry = registry
                .try_borrow_mut()
                .map_err(|_| error("native channel is busy"))?;
            ensure_cleanup(env, &mut registry)?;
            let first = insert_channel(
                &mut registry,
                Channel {
                    to_host: first_to_second,
                    from_host: first_from_second,
                    active: HashMap::new(),
                    next_lease: 0,
                    closed: false,
                },
            )?;
            let second = insert_channel(
                &mut registry,
                Channel {
                    to_host: second_to_first,
                    from_host: second_from_first,
                    active: HashMap::new(),
                    next_lease: 0,
                    closed: false,
                },
            )?;
            Ok(NativeTestPair {
                first,
                second,
                descriptor_depth: u32::try_from(profile.descriptor_depth())
                    .map_err(|_| error("test profile unavailable"))?,
                arena_bytes: u32::try_from(profile.arena_bytes())
                    .map_err(|_| error("test profile unavailable"))?,
            })
        })
    }
}

#[napi]
pub fn produce(
    env: &Env,
    channel_id: u32,
    header: Buffer,
    capacity: u32,
    timeout_ms: u32,
    fill: Function<Vec<Unknown<'_>>, u32>,
    before_publish: Function<(), ()>,
) -> Result<()> {
    let header: [u8; WIRE_V2_HEADER_BYTES] = header
        .as_ref()
        .try_into()
        .map_err(|_| error("wire header has invalid length"))?;
    REGISTRY.with(|registry| {
        let mut registry = registry
            .try_borrow_mut()
            .map_err(|_| error("native channel is busy"))?;
        let channel = registry
            .channels
            .get_mut(&channel_id)
            .ok_or_else(|| error("native channel is closed"))?;
        if channel.closed {
            return Err(error("native channel is closed"));
        }
        let mut reservation = channel
            .to_host
            .reserve_until(
                capacity as usize,
                header,
                Instant::now() + Duration::from_millis(u64::from(timeout_ms)),
            )
            .map_err(|_| error("shared-memory reservation failed"))?;
        let mut views = Vec::with_capacity(reservation.segment_count());
        let mut refs = Vec::with_capacity(reservation.segment_count());
        for index in 0..reservation.segment_count() {
            let span = reservation
                .segment(index)
                .map_err(|_| error("shared-memory reservation failed"))?
                .ok_or_else(|| error("shared-memory reservation failed"))?;
            let (view, reference) =
                napi_buffers::create_external_view(env, span.as_mut_ptr(), span.len())?;
            views.push(view);
            refs.push(reference);
        }
        let written = fill.call(views);
        let mut detach_ok = true;
        for reference in &refs {
            if napi_buffers::detach(env, reference).is_err() {
                detach_ok = false;
                channel.to_host.enter_quarantine();
            }
        }
        for reference in refs {
            napi_buffers::delete_ref(env, reference)?;
        }
        if !detach_ok {
            return Err(error(
                "producer alias state is unknown; storage quarantined",
            ));
        }
        let written = written? as usize;
        reservation
            .advance(written)
            .map_err(|_| error("producer overflow"))?;
        before_publish.call(())?;
        reservation
            .commit(written)
            .map_err(|_| error("producer underfill or invalid commit"))?;
        Ok(())
    })
}

#[napi]
pub fn poll(
    env: &Env,
    channel_id: u32,
    deliver: Function<FnArgs<(u32, Buffer, Vec<Unknown<'_>>)>, ()>,
) -> Result<bool> {
    let Some((token, header, views)) = REGISTRY.with(|registry| {
        let mut registry = registry
            .try_borrow_mut()
            .map_err(|_| error("native channel is busy"))?;
        let channel = registry
            .channels
            .get_mut(&channel_id)
            .ok_or_else(|| error("native channel is closed"))?;
        let Some(lease) = channel
            .from_host
            .try_receive()
            .map_err(|_| error("shared-memory receive failed"))?
        else {
            return Ok::<Option<(u32, Buffer, Vec<Unknown<'_>>)>, Error>(None);
        };
        channel.next_lease = channel
            .next_lease
            .checked_add(1)
            .ok_or_else(|| error("receive lease identity exhausted"))?;
        let token = channel.next_lease;
        let identity = lease.identity();
        let header = Buffer::from(lease.wire_header().to_vec());
        let mut views = Vec::with_capacity(lease.segment_count());
        let mut refs = Vec::with_capacity(lease.segment_count());
        for index in 0..lease.segment_count() {
            let span = lease
                .segment(index)
                .ok_or_else(|| error("shared-memory receive failed"))?;
            let (view, reference) =
                napi_buffers::create_external_view(env, span.as_mut_ptr(), span.len())?;
            views.push(view);
            refs.push(reference);
        }
        std::mem::forget(lease);
        channel.active.insert(
            token,
            ActiveLease {
                identity,
                buffers: refs,
            },
        );
        Ok(Some((token, header, views)))
    })?
    else {
        return Ok(false);
    };

    if let Err(callback_error) = deliver.call(FnArgs::from((token, header, views))) {
        REGISTRY.with(|registry| {
            let mut registry = registry
                .try_borrow_mut()
                .map_err(|_| error("native channel is busy"))?;
            let channel = registry
                .channels
                .get_mut(&channel_id)
                .ok_or_else(|| error("native channel is closed"))?;
            if channel.active.contains_key(&token) {
                detach_active(env, channel, token)?;
            }
            Ok::<(), Error>(())
        })?;
        return Err(callback_error);
    }
    Ok(true)
}

#[napi]
pub fn release(env: &Env, channel_id: u32, token: u32) -> Result<()> {
    REGISTRY.with(|registry| {
        let mut registry = registry
            .try_borrow_mut()
            .map_err(|_| error("native channel is busy"))?;
        let channel = registry
            .channels
            .get_mut(&channel_id)
            .ok_or_else(|| error("native channel is closed"))?;
        detach_active(env, channel, token)
    })
}

#[napi]
pub fn close(env: &Env, channel_id: u32) -> Result<()> {
    REGISTRY.with(|registry| {
        let mut registry = registry
            .try_borrow_mut()
            .map_err(|_| error("native channel is busy"))?;
        let channel = registry
            .channels
            .get_mut(&channel_id)
            .ok_or_else(|| error("native channel is closed"))?;
        close_channel(env, channel)?;
        registry.channels.remove(&channel_id);
        Ok(())
    })
}

#[napi]
pub fn force_close(env: &Env, channel_id: u32) -> Result<()> {
    REGISTRY.with(|registry| {
        let mut registry = registry
            .try_borrow_mut()
            .map_err(|_| error("native channel is busy"))?;
        let channel = registry
            .channels
            .get_mut(&channel_id)
            .ok_or_else(|| error("native channel is closed"))?;
        quarantine_channel(env, channel)?;
        registry.channels.remove(&channel_id);
        Ok(())
    })
}
