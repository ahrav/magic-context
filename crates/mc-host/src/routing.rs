//! The registry owns route lifecycles process-wide.
//!
//! The linked handler keys bindings by `u16` channel alone, so channels are process-global.
//! The registry, not a connection task, owns every provisional and published route.
//! The registry owns each route from reservation through route-gone.
//! Registry ownership prevents a dying connection from stranding membership lookups.
//! membership lookups.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::connection::GenerationCore;
use crate::handler::{RouteClass, RouteHandle};

pub struct RouteRegistry {
    inner: Mutex<Inner>,
    max_routes: usize,
}

struct Inner {
    slots: HashMap<u16, Slot>,
    live: usize,
    cursor: u16,
    accepting: bool,
}

struct Slot {
    /// `last_epoch` is the highest epoch used on this channel.
    /// A reused channel must use a higher epoch; `u32::MAX` retires the channel permanently.
    last_epoch: u32,
    occupant: Option<Occupant>,
}

struct Occupant {
    epoch: u32,
    gen: Arc<GenerationCore>,
    state: OccState,
    class: RouteClass,
    aborts: Vec<tokio::task::AbortHandle>,
    /// The registry owns `tracker` for this route's dispatch tasks.
    /// Dropping a close owner's future does not destroy the registry-owned tracker.
    /// Forced shutdown waits on the registry-owned tracker before route-gone.
    /// The wait ensures dispatch tasks stop before route-gone runs.
    tracker: TaskTracker,
    cancel: CancellationToken,
    /// The registry sets `gone_started` under its lock immediately before spawning route-gone.
    /// Setting `gone_started` under the lock guarantees route-gone starts exactly once.
    gone_started: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OccState {
    /// Handler bind in flight; the bind task owns eventual cleanup.
    Binding {
        close_requested: bool,
    },
    Live,
    /// A close owner is settling work; nobody else may free or reuse.
    Closing,
}

pub enum CloseDecision {
    /// The close owner aborts tasks, waits on `tracker`, runs route-gone, and calls `RouteRegistry::finalize_close`.
    /// [`RouteRegistry::finalize_close`].
    Owner {
        gen: Arc<GenerationCore>,
        aborts: Vec<tokio::task::AbortHandle>,
        tracker: TaskTracker,
    },
    /// The bind task observes `close_requested` and performs cleanup.
    /// cleanup.
    DeferredToBind,
    /// Unknown, stale, or already-closing route: idempotent no-op.
    AlreadyGone,
}

#[derive(Debug, PartialEq, Eq)]
pub enum BindInstall {
    /// Route published; the success response may be queued.
    Installed,
    /// When a close races a bind, the close path runs route-gone exactly once.
    /// `CloseWins` requires `RouteRegistry::finalize_close` and never publishes the route.
    CloseWins,
}

impl RouteRegistry {
    pub fn new(max_routes: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                slots: HashMap::new(),
                live: 0,
                cursor: 1,
                accepting: true,
            }),
            max_routes,
        }
    }

    /// `reserve` reserves a channel unused by every live connection at a higher epoch.
    /// The registry owns the reservation in `Binding` state.
    /// `reserve` returns `None` when admission is frozen, the generation is cancelled, or capacity is exhausted.
    /// Capacity exhaustion returns `None` before a handler bind starts.
    pub fn reserve(&self, gen: &Arc<GenerationCore>, class: RouteClass) -> Option<RouteHandle> {
        let mut inner = self.inner.lock().expect("registry lock");
        if !inner.accepting || gen.token.is_cancelled() || inner.live >= self.max_routes {
            return None;
        }
        // `reserve` scans each nonzero `u16` channel at most once from `cursor`.
        // `cursor` advances after each reservation, so reuse occurs only after the scan wraps.
        let start = inner.cursor;
        let mut candidate = start;
        loop {
            if candidate != 0 {
                let slot = inner.slots.entry(candidate).or_insert(Slot {
                    last_epoch: 0,
                    occupant: None,
                });
                if slot.occupant.is_none() && slot.last_epoch < u32::MAX {
                    let epoch = slot.last_epoch + 1;
                    slot.last_epoch = epoch;
                    slot.occupant = Some(Occupant {
                        epoch,
                        gen: Arc::clone(gen),
                        state: OccState::Binding {
                            close_requested: false,
                        },
                        class,
                        aborts: Vec::new(),
                        tracker: TaskTracker::new(),
                        cancel: CancellationToken::new(),
                        gone_started: false,
                    });
                    inner.live += 1;
                    inner.cursor = candidate.wrapping_add(1);
                    return Some(RouteHandle {
                        channel: candidate,
                        epoch,
                    });
                }
            }
            candidate = candidate.wrapping_add(1);
            if candidate == start {
                return None;
            }
        }
    }

    /// `inner`'s lock linearizes route publication before the success response.
    /// `inner`'s lock lets concurrent closes find cleanup ownership before the success response.
    pub fn install_bound(&self, handle: RouteHandle) -> BindInstall {
        let mut inner = self.inner.lock().expect("registry lock");
        let occupant = expect_occupant(&mut inner, handle, "install_bound");
        match occupant.state {
            OccState::Binding {
                close_requested: false,
            } => {
                occupant.state = OccState::Live;
                occupant
                    .gen
                    .membership
                    .lock()
                    .expect("membership lock")
                    .insert(handle.channel, handle.epoch);
                BindInstall::Installed
            }
            OccState::Binding {
                close_requested: true,
            } => {
                occupant.state = OccState::Closing;
                BindInstall::CloseWins
            }
            state => unreachable!("bind completion found route in {state:?}"),
        }
    }

    /// A rejected bind enters `Closing`; the bind task performs cleanup.
    /// A missing or stale occupant is an idempotent no-op.
    pub fn take_rejected_bind(&self, handle: RouteHandle) {
        let mut inner = self.inner.lock().expect("registry lock");
        let Some(occupant) = inner
            .slots
            .get_mut(&handle.channel)
            .and_then(|slot| slot.occupant.as_mut())
        else {
            return;
        };
        if occupant.epoch != handle.epoch {
            return;
        }
        occupant.cancel.cancel();
        occupant.state = OccState::Closing;
    }

    /// Shutdown freezes admission before taking its route snapshot, so no bind can appear behind that snapshot.
    pub fn freeze_admission(&self) {
        self.inner.lock().expect("registry lock").accepting = false;
    }

    /// generation.
    pub fn begin_close_generation(&self, gen_id: u64) -> Vec<(RouteHandle, CloseDecision)> {
        self.routes_of_generation(gen_id)
            .into_iter()
            .map(|handle| (handle, self.begin_close_owned(handle, gen_id)))
            .collect()
    }

    pub fn begin_close(&self, handle: RouteHandle) -> CloseDecision {
        self.begin_close_for(handle, None)
    }

    /// A foreign handle is an idempotent no-op even when its channel and epoch are valid.
    pub fn begin_close_owned(&self, handle: RouteHandle, gen_id: u64) -> CloseDecision {
        self.begin_close_for(handle, Some(gen_id))
    }

    fn begin_close_for(&self, handle: RouteHandle, owner: Option<u64>) -> CloseDecision {
        let mut inner = self.inner.lock().expect("registry lock");
        let Some(slot) = inner.slots.get_mut(&handle.channel) else {
            return CloseDecision::AlreadyGone;
        };
        let Some(occupant) = slot.occupant.as_mut() else {
            return CloseDecision::AlreadyGone;
        };
        if occupant.epoch != handle.epoch || owner.is_some_and(|gen_id| occupant.gen.id != gen_id) {
            return CloseDecision::AlreadyGone;
        }
        match occupant.state {
            OccState::Binding { .. } => {
                occupant.cancel.cancel();
                occupant.state = OccState::Binding {
                    close_requested: true,
                };
                CloseDecision::DeferredToBind
            }
            OccState::Live => {
                occupant.state = OccState::Closing;
                occupant.cancel.cancel();
                occupant
                    .gen
                    .membership
                    .lock()
                    .expect("membership lock")
                    .remove(&handle.channel);
                CloseDecision::Owner {
                    gen: Arc::clone(&occupant.gen),
                    aborts: std::mem::take(&mut occupant.aborts),
                    tracker: occupant.tracker.clone(),
                }
            }
            OccState::Closing => CloseDecision::AlreadyGone,
        }
    }

    pub fn finalize_close(&self, handle: RouteHandle) {
        let mut inner = self.inner.lock().expect("registry lock");
        let Some(slot) = inner.slots.get_mut(&handle.channel) else {
            return;
        };
        if slot
            .occupant
            .as_ref()
            .is_some_and(|occupant| occupant.epoch == handle.epoch)
        {
            slot.occupant = None;
            inner.live -= 1;
        }
    }

    /// The returned cancellation root belongs to the locked route state, so close cannot overtake admission.
    pub fn register_dispatch(
        &self,
        handle: RouteHandle,
        gen_id: u64,
        abort: tokio::task::AbortHandle,
    ) -> Option<CancellationToken> {
        let mut inner = self.inner.lock().expect("registry lock");
        // Frozen admission rejects dispatch registration: a task that passed the advisory draining check before the shutdown commit cannot start handler work after it.
        // The `register_dispatch` lock is the `freeze_admission` lock, so admission and freezing are atomic.
        if !inner.accepting {
            return None;
        }
        let slot = inner.slots.get_mut(&handle.channel)?;
        let occupant = slot.occupant.as_mut()?;
        if occupant.epoch != handle.epoch
            || occupant.gen.id != gen_id
            || occupant.state != OccState::Live
        {
            return None;
        }
        occupant.aborts.retain(|abort| !abort.is_finished());
        occupant.aborts.push(abort);
        Some(occupant.cancel.clone())
    }

    /// [`RouteRegistry::register_dispatch`] remains authoritative for admission.
    pub fn route_tracker(
        &self,
        handle: RouteHandle,
        gen_id: u64,
    ) -> Option<(TaskTracker, RouteClass)> {
        let inner = self.inner.lock().expect("registry lock");
        let occupant = inner
            .slots
            .get(&handle.channel)
            .and_then(|slot| slot.occupant.as_ref())?;
        (occupant.epoch == handle.epoch
            && occupant.gen.id == gen_id
            && occupant.state == OccState::Live)
            .then(|| (occupant.tracker.clone(), occupant.class))
    }

    /// A generation's teardown includes every binding, live, and closing route the generation owns.
    pub fn routes_of_generation(&self, gen_id: u64) -> Vec<RouteHandle> {
        let inner = self.inner.lock().expect("registry lock");
        inner
            .slots
            .iter()
            .filter_map(|(channel, slot)| {
                let occupant = slot.occupant.as_ref()?;
                (occupant.gen.id == gen_id).then_some(RouteHandle {
                    channel: *channel,
                    epoch: occupant.epoch,
                })
            })
            .collect()
    }

    pub fn all_routes(&self) -> Vec<RouteHandle> {
        let inner = self.inner.lock().expect("registry lock");
        inner
            .slots
            .iter()
            .filter_map(|(channel, slot)| {
                let occupant = slot.occupant.as_ref()?;
                Some(RouteHandle {
                    channel: *channel,
                    epoch: occupant.epoch,
                })
            })
            .collect()
    }

    /// Returns `true` exactly once per occupied route; the caller must invoke the callback.
    pub fn mark_gone_started(&self, handle: RouteHandle) -> bool {
        let mut inner = self.inner.lock().expect("registry lock");
        let Some(slot) = inner.slots.get_mut(&handle.channel) else {
            return false;
        };
        let Some(occupant) = slot.occupant.as_mut() else {
            return false;
        };
        if occupant.epoch != handle.epoch || occupant.gone_started {
            return false;
        }
        occupant.gone_started = true;
        true
    }

    /// Forced shutdown aborts registered dispatch tasks and invokes the supplied callback.
    /// Binding routes remain close-requested because their abort-exempt bind wrapper owns the exactly-once route-gone.
    /// Completing a bind against a finalized slot panics the registry.
    pub fn force_drain(&self) -> Vec<(RouteHandle, Vec<tokio::task::AbortHandle>, TaskTracker)> {
        let mut inner = self.inner.lock().expect("registry lock");
        let mut drained = Vec::new();
        for (channel, slot) in inner.slots.iter_mut() {
            let Some(occupant) = slot.occupant.as_mut() else {
                continue;
            };
            if occupant.gone_started {
                continue;
            }
            if matches!(occupant.state, OccState::Binding { .. }) {
                occupant.cancel.cancel();
                occupant.state = OccState::Binding {
                    close_requested: true,
                };
                continue;
            }
            occupant.state = OccState::Closing;
            occupant.cancel.cancel();
            occupant
                .gen
                .membership
                .lock()
                .expect("membership lock")
                .remove(channel);
            drained.push((
                RouteHandle {
                    channel: *channel,
                    epoch: occupant.epoch,
                },
                std::mem::take(&mut occupant.aborts),
                occupant.tracker.clone(),
            ));
        }
        drained
    }

    #[cfg(test)]
    pub fn live_count(&self) -> usize {
        self.inner.lock().expect("registry lock").live
    }
}

fn expect_occupant<'a>(inner: &'a mut Inner, handle: RouteHandle, op: &str) -> &'a mut Occupant {
    let occupant = inner
        .slots
        .get_mut(&handle.channel)
        .and_then(|slot| slot.occupant.as_mut())
        .unwrap_or_else(|| panic!("{op}: registry lost route it owns"));
    assert_eq!(
        occupant.epoch, handle.epoch,
        "{op}: registry occupant epoch diverged"
    );
    occupant
}

#[cfg(test)]
impl RouteRegistry {
    fn force_last_epoch(&self, channel: u16, epoch: u32) {
        let mut inner = self.inner.lock().expect("registry lock");
        inner
            .slots
            .entry(channel)
            .or_insert(Slot {
                last_epoch: 0,
                occupant: None,
            })
            .last_epoch = epoch;
    }

    /// `reserve` scans forward from `cursor`; set `cursor` to control the next allocation.
    fn force_cursor(&self, channel: u16) {
        self.inner.lock().expect("registry lock").cursor = channel;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::AtomicU64;
    use tokio_util::sync::CancellationToken;

    fn generation(id: u64) -> Arc<GenerationCore> {
        let (writer, _task) = crate::tcp_frame_channel::spawn_writer(
            tokio::io::duplex(1024).0,
            8,
            CancellationToken::new(),
            std::time::Duration::from_secs(5),
        );
        Arc::new(GenerationCore {
            id,
            token: CancellationToken::new(),
            read_cancel: CancellationToken::new(),
            read_tasks: tokio_util::task::TaskTracker::new(),
            shutdown_complete: CancellationToken::new(),
            writer,
            membership: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            pings: Mutex::new(HashMap::new()),
            busy_rejects: Arc::new(tokio::sync::Semaphore::new(4)),
            next_ping_corr: AtomicU64::new(1),
            liveness: Mutex::new(None),
        })
    }

    fn owner_aborts(decision: CloseDecision) -> Vec<tokio::task::AbortHandle> {
        match decision {
            CloseDecision::Owner { aborts, .. } => aborts,
            CloseDecision::DeferredToBind => panic!("expected close ownership, got bind deferral"),
            CloseDecision::AlreadyGone => panic!("expected close ownership, got already-gone"),
        }
    }

    #[tokio::test]
    async fn reserved_channels_are_nonzero_distinct_and_start_at_epoch_one() {
        let registry = RouteRegistry::new(16);
        let gen = generation(1);
        let first = registry
            .reserve(&gen, RouteClass::General)
            .expect("first reserve");
        let second = registry
            .reserve(&gen, RouteClass::General)
            .expect("second reserve");

        assert_ne!(first.channel, 0);
        assert_ne!(second.channel, 0);
        assert_ne!(first.channel, second.channel);
        assert_eq!(first.epoch, 1);
        assert_eq!(second.epoch, 1);
        assert_eq!(registry.live_count(), 2);
    }

    #[tokio::test]
    async fn concurrent_generations_never_share_a_live_channel() {
        let registry = RouteRegistry::new(64);
        let left = generation(1);
        let right = generation(2);
        let mut seen = std::collections::HashSet::new();
        for _ in 0..8 {
            for gen in [&left, &right] {
                let handle = registry.reserve(gen, RouteClass::General).expect("reserve");
                registry.install_bound(handle);
                assert!(seen.insert(handle.channel), "channel reused while live");
            }
        }
        assert_eq!(registry.live_count(), 16);
    }

    #[tokio::test]
    async fn membership_appears_at_publication_and_clears_at_close() {
        let registry = RouteRegistry::new(16);
        let gen = generation(1);
        let handle = registry
            .reserve(&gen, RouteClass::General)
            .expect("reserve");

        // Reservation alone must not make the route dispatchable.
        assert!(gen.membership.lock().expect("lock").is_empty());

        assert!(matches!(
            registry.install_bound(handle),
            BindInstall::Installed
        ));
        assert_eq!(
            gen.membership.lock().expect("lock").get(&handle.channel),
            Some(&handle.epoch)
        );

        owner_aborts(registry.begin_close(handle));
        assert!(gen.membership.lock().expect("lock").is_empty());
    }

    #[tokio::test]
    async fn reuse_requires_cleanup_and_advances_the_epoch() {
        let registry = RouteRegistry::new(1);
        let gen = generation(1);
        let first = registry
            .reserve(&gen, RouteClass::General)
            .expect("reserve");
        registry.install_bound(first);

        // A single-route budget cannot admit another route while this one lives.
        assert!(registry.reserve(&gen, RouteClass::General).is_none());

        owner_aborts(registry.begin_close(first));
        // The generation retains the route until cleanup finalizes it.
        assert!(registry.reserve(&gen, RouteClass::General).is_none());

        registry.finalize_close(first);
        registry.force_cursor(first.channel);
        let reused = registry
            .reserve(&gen, RouteClass::General)
            .expect("reuse after cleanup");
        assert_eq!(reused.channel, first.channel);
        assert!(
            reused.epoch > first.epoch,
            "reuse must advance the epoch strictly"
        );
    }

    #[tokio::test]
    async fn channel_is_retired_permanently_at_max_epoch() {
        let registry = RouteRegistry::new(4);
        let gen = generation(1);
        let probe = registry
            .reserve(&gen, RouteClass::General)
            .expect("probe reserve");
        let channel = probe.channel;
        registry.finalize_close(probe);
        registry.force_last_epoch(channel, u32::MAX);
        registry.force_cursor(channel);

        let handle = registry
            .reserve(&gen, RouteClass::General)
            .expect("another channel remains available");
        assert_ne!(
            handle.channel, channel,
            "a channel at u32::MAX must never be reserved again"
        );
    }

    #[tokio::test]
    async fn close_racing_bind_defers_to_the_bind_task_and_wins() {
        let registry = RouteRegistry::new(16);
        let gen = generation(1);
        let handle = registry
            .reserve(&gen, RouteClass::General)
            .expect("reserve");

        assert!(matches!(
            registry.begin_close(handle),
            CloseDecision::DeferredToBind
        ));
        // The bind task observes the close and must not publish the route.
        assert!(matches!(
            registry.install_bound(handle),
            BindInstall::CloseWins
        ));
        assert!(
            gen.membership.lock().expect("lock").is_empty(),
            "a route the close won must never become dispatchable"
        );
    }

    #[tokio::test]
    async fn route_gone_is_claimed_exactly_once_across_racing_closers() {
        let registry = Arc::new(RouteRegistry::new(16));
        let gen = generation(1);
        let handle = registry
            .reserve(&gen, RouteClass::General)
            .expect("reserve");
        registry.install_bound(handle);
        let barrier = Arc::new(tokio::sync::Barrier::new(3));

        let claims: Vec<_> = (0..2)
            .map(|_| {
                let registry = Arc::clone(&registry);
                let barrier = Arc::clone(&barrier);
                tokio::spawn(async move {
                    barrier.wait().await;
                    registry.mark_gone_started(handle)
                })
            })
            .collect();
        barrier.wait().await;
        let mut won = 0;
        for claim in claims {
            won += usize::from(claim.await.expect("claim task"));
        }
        assert_eq!(won, 1, "exactly one racing closer may claim route-gone");
        assert!(registry.force_drain().is_empty());
    }

    #[tokio::test]
    async fn rejected_bind_keeps_cleanup_ownership_without_publishing() {
        let registry = RouteRegistry::new(16);
        let gen = generation(1);
        let handle = registry
            .reserve(&gen, RouteClass::General)
            .expect("reserve");

        registry.take_rejected_bind(handle);
        assert!(gen.membership.lock().expect("lock").is_empty());
        assert!(
            registry.mark_gone_started(handle),
            "the handler observed the handle, so route-gone is still owed"
        );
        registry.finalize_close(handle);
        assert_eq!(registry.live_count(), 0);
    }

    #[tokio::test]
    async fn duplicate_and_stale_closes_are_idempotent_no_ops() {
        let registry = RouteRegistry::new(16);
        let gen = generation(1);
        let handle = registry
            .reserve(&gen, RouteClass::General)
            .expect("reserve");
        registry.install_bound(handle);

        owner_aborts(registry.begin_close(handle));
        assert!(matches!(
            registry.begin_close(handle),
            CloseDecision::AlreadyGone
        ));
        registry.finalize_close(handle);
        assert!(matches!(
            registry.begin_close(handle),
            CloseDecision::AlreadyGone
        ));
        // A stale epoch against a live reuse must not close the new binding.
        registry.force_cursor(handle.channel);
        let reused = registry.reserve(&gen, RouteClass::General).expect("reuse");
        assert_eq!(reused.channel, handle.channel);
        assert!(reused.epoch > handle.epoch);
        registry.install_bound(reused);
        assert!(matches!(
            registry.begin_close(RouteHandle {
                channel: reused.channel,
                epoch: handle.epoch,
            }),
            CloseDecision::AlreadyGone
        ));
        assert_eq!(
            gen.membership.lock().expect("lock").get(&reused.channel),
            Some(&reused.epoch),
            "the live binding must survive a stale-epoch close"
        );
    }

    #[tokio::test]
    async fn dispatch_registration_is_atomic_with_route_close() {
        let registry = RouteRegistry::new(16);
        let gen = generation(1);
        let handle = registry
            .reserve(&gen, RouteClass::General)
            .expect("reserve");

        // The token is the route's cancellation root.
        assert!(registry
            .register_dispatch(handle, gen.id, tokio::spawn(async {}).abort_handle())
            .is_none());

        registry.install_bound(handle);
        let cancel = registry
            .register_dispatch(handle, gen.id, tokio::spawn(async {}).abort_handle())
            .expect("live route atomically registers dispatch");
        assert!(!cancel.is_cancelled());
        // A stale epoch must not attach work to the current occupant.
        assert!(registry
            .register_dispatch(
                RouteHandle {
                    channel: handle.channel,
                    epoch: handle.epoch + 1,
                },
                gen.id,
                tokio::spawn(async {}).abort_handle()
            )
            .is_none());

        let aborts = owner_aborts(registry.begin_close(handle));
        assert!(
            cancel.is_cancelled(),
            "the same lock transition that claims dispatch tasks cancels them"
        );
        assert_eq!(
            aborts.len(),
            1,
            "the close owner must receive the route's work"
        );
        assert!(registry
            .register_dispatch(handle, gen.id, tokio::spawn(async {}).abort_handle())
            .is_none());
    }

    #[tokio::test]
    async fn generation_teardown_sees_only_its_own_routes() {
        let registry = RouteRegistry::new(16);
        let mine = generation(7);
        let theirs = generation(8);
        let a = registry
            .reserve(&mine, RouteClass::General)
            .expect("reserve a");
        let b = registry
            .reserve(&mine, RouteClass::General)
            .expect("reserve b");
        let other = registry
            .reserve(&theirs, RouteClass::General)
            .expect("reserve other");
        for handle in [a, b, other] {
            registry.install_bound(handle);
        }

        let mut owned = registry.routes_of_generation(7);
        owned.sort_by_key(|handle| handle.channel);
        let mut expected = vec![a, b];
        expected.sort_by_key(|handle| handle.channel);
        assert_eq!(owned, expected);
        assert_eq!(registry.routes_of_generation(8), vec![other]);
        assert_eq!(registry.all_routes().len(), 3);
    }

    #[tokio::test]
    async fn forced_drain_claims_settled_routes_and_defers_mid_bind_to_its_wrapper() {
        let registry = RouteRegistry::new(16);
        let gen = generation(1);
        let live = registry
            .reserve(&gen, RouteClass::General)
            .expect("reserve live");
        registry.install_bound(live);
        let mid_bind = registry
            .reserve(&gen, RouteClass::General)
            .expect("reserve mid-bind");

        let drained: Vec<RouteHandle> = registry
            .force_drain()
            .into_iter()
            .map(|(handle, _aborts, _tracker)| handle)
            .collect();

        assert_eq!(drained, vec![live], "only settled routes are swept");
        assert!(gen.membership.lock().expect("lock").is_empty());

        // force_drain marks mid-bind routes close-requested without finalizing them.
        // bind wrapper completes against a live slot and owns route-gone.
        assert_eq!(
            registry.install_bound(mid_bind),
            BindInstall::CloseWins,
            "a bind completing after the forced sweep must observe the close"
        );
        // A bind rejected after the sweep must not invoke route-gone a second time.
        registry.take_rejected_bind(mid_bind);
        registry.finalize_close(mid_bind);
    }
}
