use std::collections::HashMap;
use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use mc_shm_transport::backend::ring::Ring;
use napi::bindgen_prelude::Function;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Error, Result, Status};
use rustix::buffer::spare_capacity;
use rustix::event::{epoll, eventfd, EventfdFlags, PollFd, PollFlags};

fn wait_until_handled(control: &OwnedFd, pending: &AtomicBool, closing: &AtomicBool) -> bool {
    let mut fds = [PollFd::new(control, PollFlags::IN)];
    while pending.load(Ordering::Acquire) && !closing.load(Ordering::Acquire) {
        if rustix::event::poll(&mut fds, None).is_err() {
            return false;
        }
        if fds[0].revents().contains(PollFlags::IN) {
            let mut value = [0u8; 8];
            let _ = rustix::io::read(control, &mut value);
        }
    }
    !closing.load(Ordering::Acquire)
}

/// Native worker limit. commentlint: allow(JUDGE)
pub(crate) const WORKER_LIMIT: u32 = 0;

type ReadinessCallback = ThreadsafeFunction<(), (), (), Status, false, true, 1>;

pub(crate) struct Reactor {
    epoll: Arc<OwnedFd>,
    control: Arc<OwnedFd>,
    registrations: HashMap<u32, OwnedFd>,
    pending: Arc<AtomicBool>,
    kick: Arc<AtomicBool>,
    closing: Arc<AtomicBool>,
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
        let watcher = {
            let epoll = Arc::clone(&epoll);
            let control = Arc::clone(&control);
            let pending = Arc::clone(&pending);
            let kick = Arc::clone(&kick);
            let closing = Arc::clone(&closing);
            let callback = Arc::clone(&callback);
            std::thread::Builder::new()
                .name("mc-shm-readiness".to_owned())
                .spawn(move || {
                    let mut events = Vec::with_capacity(64);
                    loop {
                        events.clear();
                        if epoll::wait(&epoll, spare_capacity(&mut events), None).is_err() {
                            break;
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
                            } else if !wait_until_handled(&control, &pending, &closing) {
                                break;
                            } else if kick.load(Ordering::Acquire) {
                                let _ = rustix::io::write(&control, &1u64.to_ne_bytes());
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
            _callback: callback,
            watcher: Some(watcher),
        })
    }

    pub(crate) fn register(&mut self, channel_id: u32, ring: &Ring) -> Result<()> {
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
        self.registrations.insert(channel_id, descriptor);
        match ring.arm_data_wait() {
            Ok(true) => {}
            Ok(false) => self.kick(),
            Err(_) => {
                return Err(Error::new(
                    Status::GenericFailure,
                    "readiness registration failed",
                ))
            }
        }
        Ok(())
    }

    pub(crate) fn unregister(&mut self, channel_id: u32) {
        if let Some(descriptor) = self.registrations.remove(&channel_id) {
            let _ = epoll::delete(&self.epoll, &descriptor);
        }
    }

    pub(crate) fn handled(&self) {
        self.pending.store(false, Ordering::Release);
        let _ = rustix::io::write(&self.control, &1u64.to_ne_bytes());
    }

    fn kick(&self) {
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
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    use rustix::event::{eventfd, EventfdFlags};

    use super::wait_until_handled;

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
        assert!(done_rx.recv_timeout(Duration::from_secs(1)).unwrap());
        waiter.join().unwrap();
    }
}
