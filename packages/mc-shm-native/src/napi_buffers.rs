use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use napi::{sys, Env, Error, JsValue, Result, Status, Unknown};

static LEAK_DIAGNOSTICS: AtomicU64 = AtomicU64::new(0);

pub(crate) struct ExternalRef {
    reference: sys::napi_ref,
    released: Arc<AtomicBool>,
}

struct FinalizerState {
    released: Arc<AtomicBool>,
}

struct OwnedProbe(Box<[u8]>);

unsafe extern "C" fn finalize_borrowed(_env: sys::napi_env, _data: *mut c_void, hint: *mut c_void) {
    // SAFETY: create_external_view allocates exactly one FinalizerState hint.
    let state = unsafe { Box::from_raw(hint.cast::<FinalizerState>()) };
    if !state.released.load(Ordering::Acquire) {
        LEAK_DIAGNOSTICS.fetch_add(1, Ordering::Relaxed);
    }
}

unsafe extern "C" fn finalize_owned(_env: sys::napi_env, _data: *mut c_void, hint: *mut c_void) {
    // SAFETY: create_owned_probe allocates exactly one OwnedProbe hint.
    drop(unsafe { Box::from_raw(hint.cast::<OwnedProbe>()) });
}

fn check(status: sys::napi_status, message: &'static str) -> Result<()> {
    if status == sys::Status::napi_ok {
        Ok(())
    } else if status == sys::Status::napi_no_external_buffers_allowed {
        Err(Error::new(
            Status::GenericFailure,
            "external ArrayBuffer unavailable",
        ))
    } else {
        Err(Error::new(Status::GenericFailure, message))
    }
}

pub(crate) fn create_external_view<'env>(
    env: &'env Env,
    data: *mut u8,
    len: usize,
) -> Result<(Unknown<'env>, ExternalRef)> {
    let released = Arc::new(AtomicBool::new(false));
    let hint = Box::into_raw(Box::new(FinalizerState {
        released: Arc::clone(&released),
    }));
    let mut arraybuffer = std::ptr::null_mut();
    // SAFETY: caller keeps data mapped while returned strong reference exists.
    let status = unsafe {
        sys::napi_create_external_arraybuffer(
            env.raw(),
            data.cast(),
            len,
            Some(finalize_borrowed),
            hint.cast(),
            &mut arraybuffer,
        )
    };
    if let Err(error) = check(status, "external ArrayBuffer creation failed") {
        // SAFETY: N-API rejected ownership of hint.
        drop(unsafe { Box::from_raw(hint) });
        return Err(error);
    }
    let mut typedarray = std::ptr::null_mut();
    // SAFETY: arraybuffer is live and byte offset zero with exact length.
    check(
        unsafe {
            sys::napi_create_typedarray(
                env.raw(),
                sys::TypedarrayType::uint8_array,
                len,
                arraybuffer,
                0,
                &mut typedarray,
            )
        },
        "Uint8Array creation failed",
    )?;
    let mut reference = std::ptr::null_mut();
    // SAFETY: arraybuffer is a live N-API value in this environment.
    check(
        unsafe { sys::napi_create_reference(env.raw(), arraybuffer, 1, &mut reference) },
        "ArrayBuffer reference creation failed",
    )?;
    // SAFETY: typedarray was created in env and remains in current callback scope.
    let view = unsafe { Unknown::from_raw_unchecked(env.raw(), typedarray) };
    Ok((
        view,
        ExternalRef {
            reference,
            released,
        },
    ))
}

pub(crate) fn detach(env: &Env, external: &ExternalRef) -> Result<()> {
    let mut value = std::ptr::null_mut();
    // SAFETY: reference belongs to env until delete is called.
    check(
        unsafe { sys::napi_get_reference_value(env.raw(), external.reference, &mut value) },
        "ArrayBuffer reference lookup failed",
    )?;
    if value.is_null() {
        return Err(Error::new(
            Status::GenericFailure,
            "ArrayBuffer alias state is unknown",
        ));
    }
    // SAFETY: referenced value is the external ArrayBuffer.
    check(
        unsafe { sys::napi_detach_arraybuffer(env.raw(), value) },
        "ArrayBuffer detachment failed",
    )?;
    let mut detached = false;
    // SAFETY: value remains valid until reference deletion below.
    check(
        unsafe { sys::napi_is_detached_arraybuffer(env.raw(), value, &mut detached) },
        "ArrayBuffer detachment verification failed",
    )?;
    if !detached {
        return Err(Error::new(
            Status::GenericFailure,
            "ArrayBuffer detachment verification failed",
        ));
    }
    external.released.store(true, Ordering::Release);
    Ok(())
}

pub(crate) fn delete_ref(env: &Env, external: ExternalRef) -> Result<()> {
    // SAFETY: reference belongs to env and is deleted once.
    check(
        unsafe { sys::napi_delete_reference(env.raw(), external.reference) },
        "ArrayBuffer reference deletion failed",
    )
}

pub(crate) fn create_owned_probe<'env>(env: &'env Env, len: usize) -> Result<Unknown<'env>> {
    let mut owned = Box::new(OwnedProbe(vec![0u8; len].into_boxed_slice()));
    let data = owned.0.as_mut_ptr();
    let hint = Box::into_raw(owned);
    let mut arraybuffer = std::ptr::null_mut();
    // SAFETY: OwnedProbe hint retains data until N-API finalization.
    let status = unsafe {
        sys::napi_create_external_arraybuffer(
            env.raw(),
            data.cast(),
            len,
            Some(finalize_owned),
            hint.cast(),
            &mut arraybuffer,
        )
    };
    if let Err(error) = check(status, "external ArrayBuffer creation failed") {
        // SAFETY: N-API rejected ownership of hint.
        drop(unsafe { Box::from_raw(hint) });
        return Err(error);
    }
    let mut typedarray = std::ptr::null_mut();
    // SAFETY: arraybuffer is live and exact-sized.
    check(
        unsafe {
            sys::napi_create_typedarray(
                env.raw(),
                sys::TypedarrayType::uint8_array,
                len,
                arraybuffer,
                0,
                &mut typedarray,
            )
        },
        "Uint8Array creation failed",
    )?;
    // SAFETY: typedarray was created in env.
    Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), typedarray) })
}

pub(crate) fn detach_value(env: &Env, value: Unknown<'_>) -> Result<bool> {
    // SAFETY: value is provided by JavaScript in env.
    let raw = value.raw();
    // SAFETY: runtime validates that raw is an ArrayBuffer.
    check(
        unsafe { sys::napi_detach_arraybuffer(env.raw(), raw) },
        "ArrayBuffer detachment failed",
    )?;
    let mut detached = false;
    // SAFETY: raw remains in current callback scope.
    check(
        unsafe { sys::napi_is_detached_arraybuffer(env.raw(), raw, &mut detached) },
        "ArrayBuffer detachment verification failed",
    )?;
    Ok(detached)
}

pub(crate) fn leak_diagnostics() -> u64 {
    LEAK_DIAGNOSTICS.load(Ordering::Relaxed)
}
