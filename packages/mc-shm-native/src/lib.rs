#![deny(unsafe_op_in_unsafe_fn)]

mod lifecycle;
mod napi_buffers;
mod scheduling;
mod setup;

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::os::fd::BorrowedFd;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use mc_shm_transport::backend::ring::RingGrant;
use mc_shm_transport::backend::ring::{ProducerError, ProducerReservation, Ring};
use mc_shm_transport::descriptor::{ReleaseIdentity, WIRE_V2_HEADER_BYTES};
use mc_shm_transport::profile::mc_host_ring_profile;
use napi::bindgen_prelude::{AsyncTask, Buffer, FnArgs, Function, Object};
use napi::{sys, Env, Error, JsValue, Result, Status, Task, Unknown, ValueType};
use napi_derive::napi;

use napi_buffers::ExternalRef;

const PROFILE: &str = mc_shm_transport::profile::MC_HOST_RING_PROFILE;

/// The one bounded, redacted failure every malformed raw descriptor maps
/// to. Grant bytes, pids, fds, and key names never reach error messages.
const DESCRIPTOR_ERROR: &str = "invalid shared-memory descriptor";

#[napi(object)]
pub struct NativeTestPair {
    pub first: u32,
    pub second: u32,
    pub descriptor_depth: u32,
    pub arena_bytes: u32,
}

#[napi(object)]
pub struct NativeSetupOptions {
    pub setup_socket: String,
    pub key: Buffer,
    pub daemon_id: Buffer,
    pub daemon_ver: String,
    pub timeout_ms: u32,
}

struct ActiveLease {
    identity: ReleaseIdentity,
    buffers: Vec<ExternalRef>,
}

struct ActiveProducer {
    reservation: ProducerReservation<'static>,
    buffers: Vec<ExternalRef>,
}

struct PendingChannel {
    to_host: Box<Ring>,
    from_host: Ring,
    setup: Option<setup::PendingSetup>,
    reservation: GrantReservation,
}

struct Channel {
    // Field order is load-bearing: Rust drops fields in declaration order, so
    // every reservation that borrows `to_host` is dropped before `to_host`.
    producers: HashMap<u32, ActiveProducer>,
    active: HashMap<u32, ActiveLease>,
    // Aliases whose detachment failed; retained so the channel entry (and its
    // mapping) stays alive while a JS view may still be attached.
    stranded: Vec<ExternalRef>,
    to_host: Box<Ring>,
    from_host: Ring,
    next_producer: u32,
    next_lease: u32,
    closed: bool,
    setup: Option<UnixStream>,
    // Held for its Drop: releasing the process-wide claim exactly when the
    // channel entry is removed keeps quarantined and alias-holding entries
    // reserved for as long as their mapping lives.
    _reservation: Option<GrantReservation>,
}

/// Process-wide claim on the encoded grants backing live channels.
///
/// Attachment exclusivity must span worker threads: each thread consults its
/// own `REGISTRY`, but every thread maps the same shared memory, so a grant
/// active on any thread is a concurrently duplicated descriptor on all of
/// them.
static ACTIVE_GRANTS: Mutex<BTreeSet<Vec<u8>>> = Mutex::new(BTreeSet::new());
static NEXT_ENVIRONMENT: AtomicU64 = AtomicU64::new(1);

struct GrantReservation {
    grants: [Vec<u8>; 2],
}

impl GrantReservation {
    /// Atomically claims both lane grants; either grant already active
    /// anywhere in the process is a replayed or duplicated descriptor.
    fn claim(first: Vec<u8>, second: Vec<u8>) -> Result<Self> {
        let mut active = ACTIVE_GRANTS
            .lock()
            .map_err(|_| error("native grant registry is poisoned"))?;
        if active.contains(&first) || active.contains(&second) {
            return Err(error("shared-memory descriptor is already attached"));
        }
        active.insert(first.clone());
        active.insert(second.clone());
        Ok(Self {
            grants: [first, second],
        })
    }
}

impl Drop for GrantReservation {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_GRANTS.lock() {
            for grant in &self.grants {
                active.remove(grant);
            }
        }
    }
}

#[derive(Default)]
struct Registry {
    environment_generation: u64,
    next_channel: u32,
    next_pending: u32,
    channels: HashMap<u32, Channel>,
    pending: HashMap<u32, PendingChannel>,
    reactor: Option<scheduling::Reactor>,
    cleanup_registered: bool,
}

thread_local! {
    static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default());
}

fn error(message: &'static str) -> Error {
    Error::new(Status::GenericFailure, message)
}

fn descriptor_error() -> Error {
    error(DESCRIPTOR_ERROR)
}

/// Swallows a JavaScript exception thrown by a hostile accessor or Proxy
/// trap during a raw property read, so the bounded descriptor error — not
/// provider-authored text — is what reaches the caller.
fn clear_pending_exception(env: &Env) {
    let mut pending = false;
    // SAFETY: env is the current environment.
    if unsafe { sys::napi_is_exception_pending(env.raw(), &mut pending) } == sys::Status::napi_ok
        && pending
    {
        let mut exception = std::ptr::null_mut();
        // SAFETY: exception receives the cleared value, which is discarded.
        let _ = unsafe { sys::napi_get_and_clear_last_exception(env.raw(), &mut exception) };
    }
}

fn cleared_descriptor_error(env: &Env) -> Error {
    clear_pending_exception(env);
    descriptor_error()
}

/// Reads one raw property exactly once. Missing/undefined properties and
/// throwing getters both map to the bounded descriptor error.
fn descriptor_field<'env>(env: &Env, object: &Object<'env>, name: &str) -> Result<Unknown<'env>> {
    match object.get::<Unknown<'env>>(name) {
        Ok(Some(value)) => Ok(value),
        Ok(None) => Err(descriptor_error()),
        Err(_) => Err(cleared_descriptor_error(env)),
    }
}

/// Decodes one raw numeric field without N-API numeric narrowing: the
/// value must already be a JavaScript number whose exact double is a
/// non-negative-zero integer inside `[min, max]`. `NaN`, infinities,
/// fractions, `-0`, and out-of-range values are all rejected before any
/// truncating cast exists.
fn integer_field(env: &Env, object: &Object<'_>, name: &str, min: f64, max: f64) -> Result<f64> {
    let value = descriptor_field(env, object, name)?;
    if value
        .get_type()
        .map_err(|_| cleared_descriptor_error(env))?
        != ValueType::Number
    {
        return Err(descriptor_error());
    }
    // SAFETY: the value was type-checked as Number above.
    let number: f64 = unsafe { value.cast::<f64>() }.map_err(|_| cleared_descriptor_error(env))?;
    if !number.is_finite()
        || number.fract() != 0.0
        || (number == 0.0 && number.is_sign_negative())
        || number < min
        || number > max
    {
        return Err(descriptor_error());
    }
    Ok(number)
}

/// Decodes one raw string field, bounding its length BEFORE materializing
/// it so a hostile oversized string is rejected without allocation.
fn string_field(env: &Env, object: &Object<'_>, name: &str, max_len: usize) -> Result<String> {
    let value = descriptor_field(env, object, name)?;
    if value
        .get_type()
        .map_err(|_| cleared_descriptor_error(env))?
        != ValueType::String
    {
        return Err(descriptor_error());
    }
    let mut len = 0usize;
    // SAFETY: value is a live string in env; a null buffer queries length.
    let status = unsafe {
        sys::napi_get_value_string_utf8(env.raw(), value.raw(), std::ptr::null_mut(), 0, &mut len)
    };
    if status != sys::Status::napi_ok || len > max_len {
        return Err(cleared_descriptor_error(env));
    }
    // SAFETY: the value was type-checked as String above.
    unsafe { value.cast::<String>() }.map_err(|_| cleared_descriptor_error(env))
}

fn strict_hex<const N: usize>(text: &str) -> Option<[u8; N]> {
    let ascii = text.as_bytes();
    if ascii.len() != N * 2 {
        return None;
    }
    // Strict lowercase hexadecimal only, matching the host encoder;
    // `from_str_radix` would also admit uppercase and sign prefixes.
    fn nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            _ => None,
        }
    }
    let mut bytes = [0u8; N];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = nibble(ascii[index * 2])? << 4 | nibble(ascii[index * 2 + 1])?;
    }
    Some(bytes)
}

fn attach_ring(fds: [i32; 3], grant: RingGrant) -> Result<Ring> {
    let mut descriptors = Vec::with_capacity(3);
    for fd in fds {
        // SAFETY: N-API caller retains each descriptor through this synchronous clone.
        let borrowed = unsafe { BorrowedFd::borrow_raw(fd) };
        descriptors.push(
            borrowed
                .try_clone_to_owned()
                .map_err(|_| error("shared-memory attachment failed"))?,
        );
    }
    Ring::attach(
        descriptors
            .try_into()
            .map_err(|_| error("shared-memory attachment failed"))?,
        grant,
    )
    .map_err(|_| error("shared-memory attachment failed"))
}

fn cleanup_created_refs(
    env: &Env,
    ring: &Ring,
    stranded: &mut Vec<ExternalRef>,
    buffers: Vec<ExternalRef>,
) -> Result<()> {
    if napi_buffers::detach_all(env, &buffers).is_err() {
        // A failed detach leaves JS views possibly attached to ring memory.
        // The references move into `stranded` so their lifetime records (and
        // the channel entry holding the mapping) survive until a later
        // detachment succeeds.
        ring.enter_quarantine();
        stranded.extend(buffers);
        return Err(error(
            "external alias state is unknown; storage quarantined",
        ));
    }
    if napi_buffers::delete_all(env, buffers).is_err() {
        ring.enter_quarantine();
        return Err(error("external alias cleanup failed; storage quarantined"));
    }
    Ok(())
}

// Retries detachment of aliases stranded by an earlier failed cleanup. Entries
// leave `stranded` only once detachment succeeds, so the channel stays
// registered while any alias may still be attached.
fn detach_stranded(env: &Env, channel: &mut Channel) -> Result<()> {
    if channel.stranded.is_empty() {
        return Ok(());
    }
    if napi_buffers::detach_all(env, &channel.stranded).is_err() {
        return Err(error(
            "external alias state is unknown; storage quarantined",
        ));
    }
    if napi_buffers::delete_all(env, std::mem::take(&mut channel.stranded)).is_err() {
        return Err(error("external alias cleanup failed; storage quarantined"));
    }
    Ok(())
}

fn detach_active(env: &Env, channel: &mut Channel, token: u32, complete: bool) -> Result<()> {
    let Some(active) = channel.active.remove(&token) else {
        return Err(error("receive lease is already released"));
    };
    if napi_buffers::detach_all(env, &active.buffers).is_err() {
        channel.from_host.enter_quarantine();
        channel.active.insert(token, active);
        return Err(error("receive alias state is unknown; storage quarantined"));
    }
    if napi_buffers::delete_all(env, active.buffers).is_err() {
        channel.from_host.enter_quarantine();
        return Err(error("receive alias cleanup failed; storage quarantined"));
    }
    if complete {
        channel
            .from_host
            .release(active.identity)
            .map_err(|_| error("receive completion failed"))?;
    }
    Ok(())
}

fn detach_producer(
    env: &Env,
    channel: &mut Channel,
    token: u32,
) -> Result<ProducerReservation<'static>> {
    let Some(active) = channel.producers.remove(&token) else {
        return Err(error("producer reservation is already released"));
    };
    if napi_buffers::detach_all(env, &active.buffers).is_err() {
        channel.to_host.enter_quarantine();
        channel.producers.insert(token, active);
        return Err(error(
            "producer alias state is unknown; storage quarantined",
        ));
    }
    if napi_buffers::delete_all(env, active.buffers).is_err() {
        channel.to_host.enter_quarantine();
        return Err(error("producer alias cleanup failed; storage quarantined"));
    }
    Ok(active.reservation)
}

fn close_channel(env: &Env, channel: &mut Channel) -> Result<()> {
    channel.closed = true;
    if let Some(mut setup) = channel.setup.take() {
        setup::goodbye(&mut setup);
    }
    let producer_tokens: Vec<u32> = channel.producers.keys().copied().collect();
    for token in producer_tokens {
        detach_producer(env, channel, token)?.abort();
    }
    let tokens: Vec<u32> = channel.active.keys().copied().collect();
    for token in tokens {
        detach_active(env, channel, token, true)?;
    }
    detach_stranded(env, channel)?;
    Ok(())
}

fn quarantine_channel(env: &Env, channel: &mut Channel) -> Result<()> {
    channel.closed = true;
    // The quarantine retains the mapping, not the peer. Holding `setup` keeps the host's connection permit and both rings for the process lifetime. commentlint: allow(JUDGE)
    if let Some(mut setup) = channel.setup.take() {
        setup::goodbye(&mut setup);
    }
    channel.to_host.enter_quarantine();
    channel.from_host.enter_quarantine();
    let producer_tokens: Vec<u32> = channel.producers.keys().copied().collect();
    for token in producer_tokens {
        detach_producer(env, channel, token)?.abort();
    }
    let tokens: Vec<u32> = channel.active.keys().copied().collect();
    for token in tokens {
        detach_active(env, channel, token, false)?;
    }
    detach_stranded(env, channel)?;
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
            if let Some(mut reactor) = registry.reactor.take() {
                reactor.shutdown();
            }
            registry.pending.clear();
            registry.channels.retain(|_, channel| {
                if close_channel(&env, channel).is_err() {
                    // Env teardown offers no later retry, so a failed close
                    // leaves both directions' alias state unknown.
                    channel.to_host.enter_quarantine();
                    channel.from_host.enter_quarantine();
                }
                // Same retention rule as close: only alias-free channels may
                // drop their mapping.
                !(channel.producers.is_empty()
                    && channel.active.is_empty()
                    && channel.stranded.is_empty())
            });
            for (_, quarantined) in registry.channels.drain() {
                // Process exit owns uncertain alias reclamation. commentlint: allow(JUDGE)
                std::mem::forget(quarantined);
            }
        }
    });
}

fn ensure_cleanup(env: &Env, registry: &mut Registry) -> Result<()> {
    if registry.cleanup_registered {
        return Ok(());
    }
    registry.environment_generation = NEXT_ENVIRONMENT.fetch_add(1, Ordering::Relaxed);
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
pub fn build_profile() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    }
}

#[napi]
pub fn build_target() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
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
pub fn active_external_ref_count() -> u32 {
    napi_buffers::active_external_refs().min(u64::from(u32::MAX)) as u32
}

#[napi]
pub fn set_external_view_failpoint(call: u32) {
    napi_buffers::set_external_view_failpoint(call);
}

#[napi]
pub fn worker_limit() -> u32 {
    scheduling::WORKER_LIMIT
}

#[napi]
pub fn active_channel_count() -> Result<u32> {
    REGISTRY.with(|registry| {
        u32::try_from(
            registry
                .try_borrow()
                .map_err(|_| error("native channel registry is busy"))?
                .channels
                .len(),
        )
        .map_err(|_| error("native channel count overflow"))
    })
}

#[napi]
pub fn attach(env: &Env, descriptor: Unknown<'_>) -> Result<u32> {
    {
        const GRANT_HEX_LEN: usize = RingGrant::encoded_len() * 2;
        // The argument is decoded as a RAW value — before any bindgen
        // numeric narrowing or property coercion — and every check below
        // runs before the first fd open, mapping, page touch, or registry
        // insertion, so a rejected descriptor has zero side effects.
        if descriptor.get_type().map_err(|_| descriptor_error())? != ValueType::Object {
            return Err(descriptor_error());
        }
        // SAFETY: the value was type-checked as Object above.
        let object = unsafe { descriptor.cast::<Object>() }.map_err(|_| descriptor_error())?;
        let profile = string_field(env, &object, "profile", 256)?;
        if profile != PROFILE {
            return Err(error("shared-memory profile is unavailable"));
        }
        let host_to_peer_fds = [
            integer_field(env, &object, "hostToPeerFd", 0.0, f64::from(i32::MAX))? as i32,
            integer_field(
                env,
                &object,
                "hostToPeerDataReadyFd",
                0.0,
                f64::from(i32::MAX),
            )? as i32,
            integer_field(
                env,
                &object,
                "hostToPeerCapacityReadyFd",
                0.0,
                f64::from(i32::MAX),
            )? as i32,
        ];
        let peer_to_host_fds = [
            integer_field(env, &object, "peerToHostFd", 0.0, f64::from(i32::MAX))? as i32,
            integer_field(
                env,
                &object,
                "peerToHostDataReadyFd",
                0.0,
                f64::from(i32::MAX),
            )? as i32,
            integer_field(
                env,
                &object,
                "peerToHostCapacityReadyFd",
                0.0,
                f64::from(i32::MAX),
            )? as i32,
        ];
        let host_to_peer_grant = RingGrant::decode(
            strict_hex(&string_field(
                env,
                &object,
                "hostToPeerGrant",
                GRANT_HEX_LEN,
            )?)
            .ok_or_else(descriptor_error)?,
        )
        .map_err(|_| descriptor_error())?;
        let peer_to_host_grant = RingGrant::decode(
            strict_hex(&string_field(
                env,
                &object,
                "peerToHostGrant",
                GRANT_HEX_LEN,
            )?)
            .ok_or_else(descriptor_error)?,
        )
        .map_err(|_| descriptor_error())?;
        // Both directions form one duplex pair over two distinct backing
        // objects; an aliased fd or grant collapses them onto one ring.
        let distinct = host_to_peer_fds
            .into_iter()
            .chain(peer_to_host_fds)
            .collect::<BTreeSet<_>>();
        if distinct.len() != 6 || host_to_peer_grant == peer_to_host_grant {
            return Err(descriptor_error());
        }
        // Exclusive active attachment: a grant already backing a live
        // channel anywhere in this process is a replayed or concurrently
        // duplicated descriptor. The claim is process-wide because worker
        // threads each hold their own `REGISTRY` yet map the same memory.
        let reservation = GrantReservation::claim(
            host_to_peer_grant.encode().to_vec(),
            peer_to_host_grant.encode().to_vec(),
        )?;
        let from_host = attach_ring(host_to_peer_fds, host_to_peer_grant)?;
        let to_host = attach_ring(peer_to_host_fds, peer_to_host_grant)?;
        REGISTRY.with(|registry| {
            let mut registry = registry
                .try_borrow_mut()
                .map_err(|_| error("native channel is busy"))?;
            ensure_cleanup(env, &mut registry)?;
            insert_channel(
                &mut registry,
                Channel {
                    producers: HashMap::new(),
                    active: HashMap::new(),
                    stranded: Vec::new(),
                    to_host: Box::new(to_host),
                    from_host,
                    next_producer: 0,
                    next_lease: 0,
                    closed: false,
                    setup: None,
                    _reservation: Some(reservation),
                },
            )
        })
    }
}

fn setup_error(failure: std::io::Error) -> Error {
    if failure.kind() == std::io::ErrorKind::PermissionDenied {
        error("shared-memory identity mismatch")
    } else {
        error("shared-memory setup failed")
    }
}

pub struct BeginSetupTask {
    setup_socket: String,
    key: Vec<u8>,
    daemon_id: Vec<u8>,
    daemon_ver: String,
    timeout: Duration,
}

impl Task for BeginSetupTask {
    type Output = setup::PendingSetup;
    type JsValue = u32;

    fn compute(&mut self) -> Result<Self::Output> {
        setup::begin_connect(
            std::path::Path::new(&self.setup_socket),
            &self.key,
            &self.daemon_id,
            &self.daemon_ver,
            self.timeout,
        )
        .map_err(setup_error)
    }

    fn resolve(&mut self, env: Env, mut pending: Self::Output) -> Result<Self::JsValue> {
        if pending.host_to_peer_grant == pending.peer_to_host_grant {
            return Err(descriptor_error());
        }
        let reservation = GrantReservation::claim(
            pending.host_to_peer_grant.encode().to_vec(),
            pending.peer_to_host_grant.encode().to_vec(),
        )?;
        let [host_mapping, host_data, host_capacity, peer_mapping, peer_data, peer_capacity] =
            pending.take_descriptors().map_err(setup_error)?;
        let from_host = Ring::attach(
            [host_mapping, host_data, host_capacity],
            pending.host_to_peer_grant,
        )
        .map_err(|_| error("shared-memory attachment failed"))?;
        let to_host = Ring::attach(
            [peer_mapping, peer_data, peer_capacity],
            pending.peer_to_host_grant,
        )
        .map_err(|_| error("shared-memory attachment failed"))?;
        REGISTRY.with(|registry| {
            let mut registry = registry
                .try_borrow_mut()
                .map_err(|_| error("native channel is busy"))?;
            ensure_cleanup(&env, &mut registry)?;
            registry.next_pending = registry
                .next_pending
                .checked_add(1)
                .ok_or_else(|| error("native setup identity exhausted"))?;
            let id = registry.next_pending;
            registry.pending.insert(
                id,
                PendingChannel {
                    to_host: Box::new(to_host),
                    from_host,
                    setup: Some(pending),
                    reservation,
                },
            );
            Ok(id)
        })
    }
}

pub struct FinishSetupTask {
    pending_id: u32,
    setup: Option<setup::PendingSetup>,
}

impl Task for FinishSetupTask {
    type Output = UnixStream;
    type JsValue = u32;

    fn compute(&mut self) -> Result<Self::Output> {
        self.setup
            .take()
            .ok_or_else(|| error("shared-memory setup failed"))?
            .activate()
            .map_err(setup_error)
    }

    fn resolve(&mut self, _env: Env, stream: Self::Output) -> Result<Self::JsValue> {
        REGISTRY.with(|registry| {
            let mut registry = registry
                .try_borrow_mut()
                .map_err(|_| error("native channel is busy"))?;
            let pending = registry
                .pending
                .remove(&self.pending_id)
                .ok_or_else(|| error("shared-memory setup was cancelled"))?;
            insert_channel(
                &mut registry,
                Channel {
                    producers: HashMap::new(),
                    active: HashMap::new(),
                    stranded: Vec::new(),
                    to_host: pending.to_host,
                    from_host: pending.from_host,
                    next_producer: 0,
                    next_lease: 0,
                    closed: false,
                    setup: Some(stream),
                    _reservation: Some(pending.reservation),
                },
            )
        })
    }

    fn reject(&mut self, _env: Env, failure: Error) -> Result<Self::JsValue> {
        REGISTRY.with(|registry| {
            if let Ok(mut registry) = registry.try_borrow_mut() {
                registry.pending.remove(&self.pending_id);
            }
        });
        Err(failure)
    }
}

#[napi]
pub fn connect_setup(options: NativeSetupOptions) -> AsyncTask<BeginSetupTask> {
    AsyncTask::new(BeginSetupTask {
        setup_socket: options.setup_socket,
        key: options.key.to_vec(),
        daemon_id: options.daemon_id.to_vec(),
        daemon_ver: options.daemon_ver,
        timeout: Duration::from_millis(u64::from(options.timeout_ms)),
    })
}

#[napi]
pub fn finish_setup(pending_id: u32) -> Result<AsyncTask<FinishSetupTask>> {
    let setup = REGISTRY.with(|registry| {
        let mut registry = registry
            .try_borrow_mut()
            .map_err(|_| error("native channel is busy"))?;
        registry
            .pending
            .get_mut(&pending_id)
            .and_then(|pending| pending.setup.take())
            .ok_or_else(|| error("shared-memory setup was cancelled"))
    })?;
    Ok(AsyncTask::new(FinishSetupTask {
        pending_id,
        setup: Some(setup),
    }))
}

#[napi]
pub fn create_test_pair(env: &Env) -> Result<NativeTestPair> {
    {
        let profile = mc_host_ring_profile().map_err(|_| error("test profile unavailable"))?;
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
                    producers: HashMap::new(),
                    active: HashMap::new(),
                    stranded: Vec::new(),
                    to_host: Box::new(first_to_second),
                    from_host: first_from_second,
                    next_producer: 0,
                    next_lease: 0,
                    closed: false,
                    setup: None,
                    // Test pairs attach freshly created local rings, never a
                    // host descriptor, so no process-wide grant is claimed.
                    _reservation: None,
                },
            )?;
            let second = insert_channel(
                &mut registry,
                Channel {
                    producers: HashMap::new(),
                    active: HashMap::new(),
                    stranded: Vec::new(),
                    to_host: Box::new(second_to_first),
                    from_host: second_from_first,
                    next_producer: 0,
                    next_lease: 0,
                    closed: false,
                    setup: None,
                    _reservation: None,
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
            .map_err(reservation_error)?;
        let mut views = Vec::with_capacity(reservation.segment_count());
        let mut refs = Vec::with_capacity(reservation.segment_count());
        let built = (|| -> Result<()> {
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
            Ok(())
        })();
        if let Err(build_error) = built {
            cleanup_created_refs(env, &channel.to_host, &mut channel.stranded, refs)?;
            return Err(build_error);
        }
        let written = fill.call(views);
        // The callback error carries the actionable diagnosis; a cleanup
        // failure is appended rather than replacing it.
        if let Err(cleanup_error) =
            cleanup_created_refs(env, &channel.to_host, &mut channel.stranded, refs)
        {
            return Err(match written {
                Err(callback_error) => Error::new(
                    Status::GenericFailure,
                    format!("{callback_error}; producer cleanup also failed: {cleanup_error}"),
                ),
                Ok(_) => cleanup_error,
            });
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
pub fn reserve(
    env: &Env,
    channel_id: u32,
    capacity: u32,
    timeout_ms: u32,
    deliver: Function<FnArgs<(u32, Vec<Unknown<'_>>)>, ()>,
) -> Result<()> {
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
        let ring_ptr: *const Ring = channel.to_host.as_ref();
        // SAFETY: `to_host` is boxed, so moving `Channel` does not move the
        // ring. `producers` is declared before `to_host`, so every stored
        // reservation drops before the ring on every Channel destruction path.
        let ring: &'static Ring = unsafe { &*ring_ptr };
        let reservation = ring
            .reserve_until(
                capacity as usize,
                [0; WIRE_V2_HEADER_BYTES],
                Instant::now() + Duration::from_millis(u64::from(timeout_ms)),
            )
            .map_err(reservation_error)?;
        let mut views = Vec::with_capacity(reservation.segment_count());
        let mut refs = Vec::with_capacity(reservation.segment_count());
        let built = (|| -> Result<()> {
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
            Ok(())
        })();
        if let Err(build_error) = built {
            cleanup_created_refs(env, &channel.to_host, &mut channel.stranded, refs)?;
            return Err(build_error);
        }
        channel.next_producer = channel
            .next_producer
            .checked_add(1)
            .ok_or_else(|| error("producer reservation identity exhausted"))?;
        let token = channel.next_producer;
        channel.producers.insert(
            token,
            ActiveProducer {
                reservation,
                buffers: refs,
            },
        );
        if let Err(callback_error) = deliver.call(FnArgs::from((token, views))) {
            // The callback error carries the actionable diagnosis; a cleanup
            // failure is appended rather than replacing it.
            match detach_producer(env, channel, token) {
                Ok(reservation) => reservation.abort(),
                Err(cleanup_error) => {
                    return Err(Error::new(
                        Status::GenericFailure,
                        format!("{callback_error}; producer cleanup also failed: {cleanup_error}"),
                    ));
                }
            }
            return Err(callback_error);
        }
        Ok(())
    })
}

#[napi]
pub fn commit_reservation(
    env: &Env,
    channel_id: u32,
    token: u32,
    header: Buffer,
    written: u32,
    before_publish: Function<(), ()>,
) -> Result<()> {
    REGISTRY.with(|registry| {
        let mut registry = registry
            .try_borrow_mut()
            .map_err(|_| error("native channel is busy"))?;
        let channel = registry
            .channels
            .get_mut(&channel_id)
            .ok_or_else(|| error("native channel is closed"))?;
        let mut reservation = detach_producer(env, channel, token)?;
        let header: [u8; WIRE_V2_HEADER_BYTES] = header
            .as_ref()
            .try_into()
            .map_err(|_| error("wire header has invalid length"))?;
        reservation
            .set_wire_header(header)
            .and_then(|()| reservation.advance(written as usize))
            .map_err(|_| error("producer overflow"))?;
        before_publish.call(())?;
        reservation
            .commit(written as usize)
            .map_err(|_| error("producer underfill or invalid commit"))?;
        Ok(())
    })
}

#[napi]
pub fn abort_reservation(env: &Env, channel_id: u32, token: u32) -> Result<()> {
    REGISTRY.with(|registry| {
        let mut registry = registry
            .try_borrow_mut()
            .map_err(|_| error("native channel is busy"))?;
        let channel = registry
            .channels
            .get_mut(&channel_id)
            .ok_or_else(|| error("native channel is closed"))?;
        detach_producer(env, channel, token)?.abort();
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_drops_borrowing_reservations_before_the_ring() {
        let profile = mc_host_ring_profile().expect("profile");
        let to_host = Box::new(Ring::create(&profile, 1).expect("producer ring"));
        let from_host = Ring::create(&profile, 2).expect("consumer ring");
        let ring_ptr: *const Ring = to_host.as_ref();
        // SAFETY: this mirrors `reserve`: `Channel` declares `producers` before
        // `to_host`, so the stored reservation is destroyed first.
        let ring: &'static Ring = unsafe { &*ring_ptr };
        let reservation = ring
            .reserve_until(
                0,
                [0; WIRE_V2_HEADER_BYTES],
                Instant::now() + Duration::from_secs(1),
            )
            .expect("reservation");
        let mut producers = HashMap::new();
        producers.insert(
            1,
            ActiveProducer {
                reservation,
                buffers: Vec::new(),
            },
        );
        drop(Channel {
            producers,
            active: HashMap::new(),
            stranded: Vec::new(),
            to_host,
            from_host,
            next_producer: 1,
            next_lease: 0,
            closed: false,
            setup: None,
            _reservation: None,
        });
    }
}

#[napi]
pub fn watch(channel_id: u32, callback: Function<(), ()>) -> Result<()> {
    REGISTRY.with(|registry| {
        let mut registry = registry
            .try_borrow_mut()
            .map_err(|_| error("native channel is busy"))?;
        if !registry.channels.contains_key(&channel_id) {
            return Err(error("native channel is closed"));
        }
        if registry.reactor.is_none() {
            registry.reactor = Some(scheduling::Reactor::new(callback)?);
        }
        let Registry {
            channels, reactor, ..
        } = &mut *registry;
        let channel = channels
            .get(&channel_id)
            .ok_or_else(|| error("native channel is closed"))?;
        reactor.as_mut().expect("reactor initialized").register(
            channel_id,
            &channel.from_host,
            channel.setup.as_ref(),
        )
    })
}

#[napi]
pub fn readiness_handled() -> bool {
    REGISTRY.with(|registry| {
        let Ok(registry) = registry.try_borrow() else {
            return false;
        };
        let Some(reactor) = registry.reactor.as_ref() else {
            return false;
        };
        let mut redispatch = false;
        for (channel_id, channel) in &registry.channels {
            if !reactor.is_registered(*channel_id) {
                continue;
            }
            redispatch |= channel.from_host.complete_data_wait().is_err();
            match channel.from_host.arm_data_wait() {
                Ok(true) => {}
                Ok(false) | Err(_) => redispatch = true,
            }
        }
        reactor.handled();
        redispatch
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
        if let Some(reactor) = registry.reactor.as_ref() {
            reactor.ensure_healthy()?;
        }
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
        let built = (|| -> Result<()> {
            for index in 0..lease.segment_count() {
                let span = lease
                    .segment(index)
                    .ok_or_else(|| error("shared-memory receive failed"))?;
                let (view, reference) =
                    napi_buffers::create_external_view(env, span.as_mut_ptr(), span.len())?;
                views.push(view);
                refs.push(reference);
            }
            Ok(())
        })();
        if let Err(build_error) = built {
            cleanup_created_refs(env, &channel.from_host, &mut channel.stranded, refs)?;
            return Err(build_error);
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
        REGISTRY.with(|registry| {
            let registry = registry
                .try_borrow()
                .map_err(|_| error("native channel is busy"))?;
            let channel = registry
                .channels
                .get(&channel_id)
                .ok_or_else(|| error("native channel is closed"))?;
            let should_block = channel
                .from_host
                .arm_data_wait()
                .map_err(|_| error("shared-memory receive failed"))?;
            if !should_block {
                if let Some(reactor) = registry.reactor.as_ref() {
                    reactor.kick();
                }
            }
            Ok::<(), Error>(())
        })?;
        return Ok(false);
    };

    if let Err(callback_error) = deliver.call(FnArgs::from((token, header, views))) {
        let cleanup = REGISTRY.with(|registry| {
            let mut registry = registry
                .try_borrow_mut()
                .map_err(|_| error("native channel is busy"))?;
            let channel = registry
                .channels
                .get_mut(&channel_id)
                .ok_or_else(|| error("native channel is closed"))?;
            if channel.active.contains_key(&token) {
                detach_active(env, channel, token, true)?;
            }
            Ok::<(), Error>(())
        });
        // The callback error carries the actionable diagnosis; a cleanup
        // failure is appended rather than replacing it.
        if let Err(cleanup_error) = cleanup {
            return Err(Error::new(
                Status::GenericFailure,
                format!("{callback_error}; receive cleanup also failed: {cleanup_error}"),
            ));
        }
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
        detach_active(env, channel, token, true)
    })
}

/// A full ring is ordinary backpressure, so it carries a distinct message the caller can classify as retryable instead of terminal. commentlint: allow(JUDGE)
fn reservation_error(failure: ProducerError) -> Error {
    match failure {
        ProducerError::Exhausted | ProducerError::Deadline => error("shared-memory ring is full"),
        _ => error("shared-memory reservation failed"),
    }
}

#[napi]
pub fn peer_closed(channel_id: u32) -> Result<bool> {
    REGISTRY.with(|registry| {
        let registry = registry
            .try_borrow()
            .map_err(|_| error("native channel is busy"))?;
        let channel = registry
            .channels
            .get(&channel_id)
            .ok_or_else(|| error("native channel is closed"))?;
        Ok(match channel.setup.as_ref() {
            Some(stream) => setup::peer_closed(stream),
            None => false,
        })
    })
}

#[napi]
pub fn close(env: &Env, channel_id: u32) -> Result<()> {
    REGISTRY.with(|registry| {
        let mut registry = registry
            .try_borrow_mut()
            .map_err(|_| error("native channel is busy"))?;
        if let Some(reactor) = registry.reactor.as_mut() {
            reactor.unregister(channel_id);
        }
        let channel = registry
            .channels
            .get_mut(&channel_id)
            .ok_or_else(|| error("native channel is closed"))?;
        let result = close_channel(env, channel);
        // The entry is removed once no tracked alias remains, even if
        // reference deletion or release reporting failed. A detach failure
        // leaves its token or stranded alias behind, and the entry must then
        // stay registered so the mapping outlives the still-attached JS
        // views; a later close retries the detachment.
        if channel.producers.is_empty() && channel.active.is_empty() && channel.stranded.is_empty()
        {
            registry.channels.remove(&channel_id);
        }
        result
    })
}

#[napi]
pub fn force_close(env: &Env, channel_id: u32) -> Result<()> {
    REGISTRY.with(|registry| {
        let mut registry = registry
            .try_borrow_mut()
            .map_err(|_| error("native channel is busy"))?;
        if let Some(reactor) = registry.reactor.as_mut() {
            reactor.unregister(channel_id);
        }
        let channel = registry
            .channels
            .get_mut(&channel_id)
            .ok_or_else(|| error("native channel is closed"))?;
        let result = quarantine_channel(env, channel);
        // Same retention rule as close: only alias-free channels may drop
        // their mapping.
        if channel.producers.is_empty() && channel.active.is_empty() && channel.stranded.is_empty()
        {
            registry.channels.remove(&channel_id);
        }
        result
    })
}
