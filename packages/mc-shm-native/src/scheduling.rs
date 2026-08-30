use std::collections::HashMap;
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use mc_shm_transport::backend::ring::Ring;
use napi::bindgen_prelude::Function;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Error, Result, Status};
use rustix::buffer::spare_capacity;
use rustix::event::{epoll, eventfd, EventfdFlags, PollFd, PollFlags};
use rustix::io::Errno;

fn retry_interrupted<T>(
    closing: &AtomicBool,
    mut operation: impl FnMut() -> std::result::Result<T, Errno>,
) -> std::result::Result<Option<T>, Errno> {
    loop {
        if closing.load(Ordering::Acquire) {
            return Ok(None);
        }
        match operation() {
            Err(Errno::INTR) => {}
            result => return result.map(Some),
        }
    }
}

fn register_setup_socket(
    reactor: &OwnedFd,
    setup: &UnixStream,
    event_data: u64,
) -> Result<OwnedFd> {
    let setup = setup
        .try_clone()
        .map_err(|_| Error::new(Status::GenericFailure, "readiness registration failed"))?;
    epoll::add(
        reactor,
        &setup,
        epoll::EventData::new_u64(event_data),
        epoll::EventFlags::IN
            | epoll::EventFlags::HUP
            | epoll::EventFlags::ERR
            | epoll::EventFlags::RDHUP,
    )
    .map_err(|_| Error::new(Status::GenericFailure, "readiness registration failed"))?;
    Ok(setup.into())
}

fn wait_until_handled(
    control: &OwnedFd,
    pending: &AtomicBool,
    closing: &AtomicBool,
) -> std::result::Result<bool, Errno> {
    let mut fds = [PollFd::new(control, PollFlags::IN)];
    while pending.load(Ordering::Acquire) && !closing.load(Ordering::Acquire) {
        if retry_interrupted(closing, || rustix::event::poll(&mut fds, None))?.is_none() {
            return Ok(false);
        }
        if fds[0].revents().contains(PollFlags::IN) {
            let mut value = [0u8; 8];
            let _ = rustix::io::read(control, &mut value);
        }
    }
    Ok(!closing.load(Ordering::Acquire))
}

/// Native worker limit. commentlint: allow(JUDGE)
pub(crate) const WORKER_LIMIT: u32 = 0;

type ReadinessCallback = ThreadsafeFunction<(), (), (), Status, false, true, 1>;

struct Registration {
    descriptors: Vec<OwnedFd>,
}

pub(crate) struct Reactor {
    epoll: Arc<OwnedFd>,
    control: Arc<OwnedFd>,
    registrations: HashMap<u32, Registration>,
    pending: Arc<AtomicBool>,
    kick: Arc<AtomicBool>,
    closing: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    _callback: Arc<ReadinessCallback>,
    watcher: Option<JoinHandle<()>>,
}

impl Reactor {
    pub(crate) fn new(callback: Function<(), ()>) -> Result<Self> {
        let callback = Arc::new(
            callback
                .build_threadsafe_function::<()>()
                .weak::<true>()
                .max_queue_size::<1>()
                .build()?,
        );
        let epoll = Arc::new(
            epoll::create(epoll::CreateFlags::CLOEXEC)
                .map_err(|_| Error::new(Status::GenericFailure, "readiness reactor failed"))?,
        );
        let control = Arc::new(
            eventfd(0, EventfdFlags::CLOEXEC | EventfdFlags::NONBLOCK)
                .map_err(|_| Error::new(Status::GenericFailure, "readiness reactor failed"))?,
        );
        epoll::add(
            &epoll,
            &control,
            epoll::EventData::new_u64(0),
            epoll::EventFlags::IN,
        )
        .map_err(|_| Error::new(Status::GenericFailure, "readiness reactor failed"))?;
        let pending = Arc::new(AtomicBool::new(false));
        let kick = Arc::new(AtomicBool::new(false));
        let closing = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(AtomicBool::new(false));
        let watcher = {
            let epoll = Arc::clone(&epoll);
            let control = Arc::clone(&control);
            let pending = Arc::clone(&pending);
            let kick = Arc::clone(&kick);
            let closing = Arc::clone(&closing);
            let failed = Arc::clone(&failed);
            let callback = Arc::clone(&callback);
            std::thread::Builder::new()
                .name("mc-shm-readiness".to_owned())
                .spawn(move || {
                    let mut events = Vec::with_capacity(64);
                    loop {
                        events.clear();
                        match retry_interrupted(&closing, || {
                            epoll::wait(&epoll, spare_capacity(&mut events), None)
                        }) {
                            Ok(Some(_)) => {}
                            Ok(None) => break,
                            Err(_) => {
                                failed.store(true, Ordering::Release);
                                if pending
                                    .compare_exchange(
                                        false,
                                        true,
                                        Ordering::AcqRel,
                                        Ordering::Acquire,
                                    )
                                    .is_ok()
                                    && callback.call((), ThreadsafeFunctionCallMode::NonBlocking)
                                        != Status::Ok
                                {
                                    pending.store(false, Ordering::Release);
                                }
                                break;
                            }
                        }
                        let mut ready = false;
                        for event in events.drain(..) {
                            if event.data.u64() == 0 {
                                let mut value = [0u8; 8];
                                let _ = rustix::io::read(&control, &mut value);
                                ready |= kick.swap(false, Ordering::AcqRel);
                            } else {
                                ready = true;
                            }
                        }
                        if closing.load(Ordering::Acquire) {
                            break;
                        }
                        if ready
                            && pending
                                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                                .is_ok()
                        {
                            let status = callback.call((), ThreadsafeFunctionCallMode::NonBlocking);
                            if status != Status::Ok {
                                pending.store(false, Ordering::Release);
                            } else {
                                match wait_until_handled(&control, &pending, &closing) {
                                    Ok(true) if kick.load(Ordering::Acquire) => {
                                        let _ = rustix::io::write(&control, &1u64.to_ne_bytes());
                                    }
                                    Ok(true) => {}
                                    Ok(false) => break,
                                    Err(_) => {
                                        failed.store(true, Ordering::Release);
                                        let _ = callback
                                            .call((), ThreadsafeFunctionCallMode::NonBlocking);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                })
                .map_err(|_| Error::new(Status::GenericFailure, "readiness reactor failed"))?
        };
        Ok(Self {
            epoll,
            control,
            registrations: HashMap::new(),
            pending,
            kick,
            closing,
            failed,
            _callback: callback,
            watcher: Some(watcher),
        })
    }

    pub(crate) fn register(
        &mut self,
        channel_id: u32,
        ring: &Ring,
        setup: Option<&UnixStream>,
    ) -> Result<()> {
        self.ensure_healthy()?;
        if self.registrations.contains_key(&channel_id) {
            return Ok(());
        }
        let descriptor = ring
            .duplicate_data_ready()
            .map_err(|_| Error::new(Status::GenericFailure, "readiness registration failed"))?;
        epoll::add(
            &self.epoll,
            &descriptor,
            epoll::EventData::new_u64(u64::from(channel_id) + 1),
            epoll::EventFlags::IN,
        )
        .map_err(|_| Error::new(Status::GenericFailure, "readiness registration failed"))?;
        let mut descriptors = vec![descriptor];
        if let Some(setup) = setup {
            match register_setup_socket(&self.epoll, setup, u64::from(channel_id) + 1) {
                Ok(setup) => descriptors.push(setup),
                Err(error) => {
                    let _ = epoll::delete(&self.epoll, &descriptors[0]);
                    return Err(error);
                }
            }
        }
        self.registrations
            .insert(channel_id, Registration { descriptors });
        match ring.arm_data_wait() {
            Ok(true) => {}
            Ok(false) => self.kick(),
            Err(_) => {
                self.unregister(channel_id);
                return Err(Error::new(
                    Status::GenericFailure,
                    "readiness registration failed",
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn unregister(&mut self, channel_id: u32) {
        if let Some(registration) = self.registrations.remove(&channel_id) {
            for descriptor in registration.descriptors {
                let _ = epoll::delete(&self.epoll, &descriptor);
            }
        }
    }

    pub(crate) fn ensure_healthy(&self) -> Result<()> {
        if self.failed.load(Ordering::Acquire) {
            Err(Error::new(
                Status::GenericFailure,
                "readiness reactor failed",
            ))
        } else {
            Ok(())
        }
    }

    pub(crate) fn handled(&self) {
        self.pending.store(false, Ordering::Release);
        let _ = rustix::io::write(&self.control, &1u64.to_ne_bytes());
    }

    pub(crate) fn kick(&self) {
        self.kick.store(true, Ordering::Release);
        let _ = rustix::io::write(&self.control, &1u64.to_ne_bytes());
    }

    pub(crate) fn shutdown(&mut self) {
        self.closing.store(true, Ordering::Release);
        let _ = rustix::io::write(&self.control, &1u64.to_ne_bytes());
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.join();
        }
        self.registrations.clear();
        self.pending.store(false, Ordering::Release);
    }
}

impl Drop for Reactor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixStream;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    use rustix::buffer::spare_capacity;
    use rustix::event::{epoll, eventfd, EventfdFlags};
    use rustix::io::Errno;

    use super::{register_setup_socket, retry_interrupted, wait_until_handled};

    #[test]
    fn pending_callback_waits_for_acknowledgement() {
        let control = Arc::new(
            eventfd(0, EventfdFlags::CLOEXEC | EventfdFlags::NONBLOCK).expect("control eventfd"),
        );
        let pending = Arc::new(AtomicBool::new(true));
        let closing = Arc::new(AtomicBool::new(false));
        let (done_tx, done_rx) = mpsc::channel();
        let waiter = {
            let control = Arc::clone(&control);
            let pending = Arc::clone(&pending);
            let closing = Arc::clone(&closing);
            std::thread::spawn(move || {
                done_tx
                    .send(wait_until_handled(&control, &pending, &closing))
                    .unwrap();
            })
        };

        rustix::io::write(&control, &1u64.to_ne_bytes()).unwrap();
        assert!(done_rx.recv_timeout(Duration::from_millis(25)).is_err());

        pending.store(false, Ordering::Release);
        rustix::io::write(&control, &1u64.to_ne_bytes()).unwrap();
        assert!(done_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap());
        waiter.join().unwrap();
    }

    #[test]
    fn setup_socket_eof_is_reactor_readiness() {
        let reactor = epoll::create(epoll::CreateFlags::CLOEXEC).unwrap();
        let (watched, peer) = UnixStream::pair().unwrap();
        let _registration = register_setup_socket(&reactor, &watched, 17).unwrap();
        drop(peer);

        let mut events = Vec::with_capacity(1);
        epoll::wait(&reactor, spare_capacity(&mut events), None).unwrap();
        assert_eq!(events.len(), 1);
        let event = events[0];
        let data = event.data;
        let flags = event.flags;
        assert_eq!(data.u64(), 17);
        assert!(flags
            .intersects(epoll::EventFlags::IN | epoll::EventFlags::HUP | epoll::EventFlags::RDHUP));
    }

    #[test]
    fn interrupted_wait_retries_until_success_or_close() {
        let closing = AtomicBool::new(false);
        let mut attempts = 0;
        let result = retry_interrupted(&closing, || {
            attempts += 1;
            if attempts == 1 {
                Err(Errno::INTR)
            } else {
                Ok(7)
            }
        })
        .unwrap();
        assert_eq!(result, Some(7));
        assert_eq!(attempts, 2);

        closing.store(true, Ordering::Release);
        assert_eq!(
            retry_interrupted(&closing, || Ok::<_, Errno>(9)).unwrap(),
            None
        );
    }
}
