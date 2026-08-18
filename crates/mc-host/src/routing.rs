//! Host-global route lifecycle registry.
//!
//! Channels are process-global because the linked handler keys bindings by
//! `u16` channel alone (protocol §8.2). The registry — not any connection task
//! — owns every provisional and published route from reservation through
//! request settlement and route-gone, so a dying connection can never strand
//! or double-free a route (plan KTD5). Connection generations hold only
//! membership lookups.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::connection::GenerationCore;
use crate::handler::RouteHandle;

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
    /// Highest epoch ever used on this channel in this incarnation. Reuse must
    /// be strictly higher; `u32::MAX` permanently retires the channel
    /// (protocol §8.2, V21).
    last_epoch: u32,
    occupant: Option<Occupant>,
}

struct Occupant {
    epoch: u32,
    gen: Arc<GenerationCore>,
    state: OccState,
    /// Handler tasks dispatched on this route; joined by the close owner
    /// before route-gone runs.
    tasks: Vec<JoinHandle<()>>,
    cancel: CancellationToken,
    /// Set under the registry lock immediately before the route-gone callback
    /// task is spawned; guarantees exactly-once even when a graceful closer
    /// and the forced shutdown path race (protocol §12).
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

/// What `begin_close` grants the caller.
pub enum CloseDecision {
    /// Caller became the close owner: settle/cancel work, join `tasks`, run
    /// route-gone, and call [`RouteRegistry::finalize_close`].
    Owner {
        gen: Arc<GenerationCore>,
        tasks: Vec<JoinHandle<()>>,
    },
    /// A bind is in flight; its task will observe `close_requested` and owns
    /// cleanup.
    DeferredToBind,
    /// Unknown, stale, or already-closing route: idempotent no-op.
    AlreadyGone,
}

/// What the bind task must do after the handler callback returned.
#[derive(Debug, PartialEq, Eq)]
pub enum BindInstall {
    /// Route published; the success response may be queued.
    Installed,
    /// A close raced the bind and wins: run route-gone once and
    /// [`RouteRegistry::finalize_close`]; never publish (protocol AE8).
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

    /// Reserves a channel unused across all live connections at a strictly
    /// higher epoch, owned by the registry in `Binding` state. `None` means
    /// admission is frozen, the generation is cancelled, or channel/route
    /// capacity is exhausted (`target_unavailable`, without any handler bind).
    pub fn reserve(&self, gen: &Arc<GenerationCore>) -> Option<RouteHandle> {
        let mut inner = self.inner.lock().expect("registry lock");
        if !inner.accepting || gen.token.is_cancelled() || inner.live >= self.max_routes {
            return None;
        }
        // Scan the full nonzero u16 space at most once, from a moving cursor
        // so channels are not immediately recycled after cleanup.
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
                        tasks: Vec::new(),
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

    /// Publishes an accepted bind. The transition to `Live` under the registry
    /// lock is the linearization point for route publication and precedes the
    /// success response, so any concurrent close finds cleanup ownership even
    /// if the response write fails (plan KTD10).
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

    /// Transfers a rejected bind's occupant into `Closing` so the bind task
    /// can run route-gone (the handler observed the handle) and finalize.
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

    /// Prevents every later reservation. Shutdown calls this before taking its
    /// route snapshot, so no bind can appear behind that snapshot.
    pub fn freeze_admission(&self) {
        self.inner.lock().expect("registry lock").accepting = false;
    }

    /// Advisory liveness read so dispatch can prove `unknown_channel` without
    /// consuming capacity (protocol §8.3 ordering). `register_dispatch` is the
    /// authoritative check; this one only orders the cheap rejection first.
    pub fn route_live(&self, handle: RouteHandle, gen_id: u64) -> bool {
        let inner = self.inner.lock().expect("registry lock");
        inner
            .slots
            .get(&handle.channel)
            .and_then(|slot| slot.occupant.as_ref())
            .is_some_and(|occupant| {
                occupant.epoch == handle.epoch
                    && occupant.gen.id == gen_id
                    && occupant.state == OccState::Live
            })
    }

    /// Begins closure of every route one generation owns, in one marking
    /// pass. Run this before waiting for the generation's in-flight binds:
    /// a bind that completes after the pass observes `close_requested` and
    /// lands in `CloseWins` instead of installing a route onto a retiring
    /// generation.
    pub fn begin_close_generation(&self, gen_id: u64) -> Vec<(RouteHandle, CloseDecision)> {
        self.routes_of_generation(gen_id)
            .into_iter()
            .map(|handle| (handle, self.begin_close_owned(handle, gen_id)))
            .collect()
    }

    /// Requests closure from host-owned teardown.
    pub fn begin_close(&self, handle: RouteHandle) -> CloseDecision {
        self.begin_close_for(handle, None)
    }

    /// Requests closure from one authenticated generation. A foreign handle is
    /// an idempotent no-op even when its channel and epoch are valid.
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
                    tasks: std::mem::take(&mut occupant.tasks),
                }
            }
            OccState::Closing => CloseDecision::AlreadyGone,
        }
    }

    /// Frees the channel after route-gone completed. The epoch history stays,
    /// so reuse is strictly higher and `u32::MAX` retires the channel.
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

    /// Atomically admits a dispatch while its route is live and records its
    /// task for the close owner. The returned cancellation root belongs to
    /// that same locked route state, so close cannot overtake admission.
    pub fn register_dispatch(
        &self,
        handle: RouteHandle,
        gen_id: u64,
        task: JoinHandle<()>,
    ) -> Option<CancellationToken> {
        let mut inner = self.inner.lock().expect("registry lock");
        let slot = inner.slots.get_mut(&handle.channel)?;
        let occupant = slot.occupant.as_mut()?;
        if occupant.epoch != handle.epoch
            || occupant.gen.id != gen_id
            || occupant.state != OccState::Live
        {
            return None;
        }
        // Prune completed handles on the dispatch path that grows the list.
        occupant.tasks.retain(|task| !task.is_finished());
        occupant.tasks.push(task);
        Some(occupant.cancel.clone())
    }

    /// Routes currently owned by one generation (binding, live, or closing),
    /// for generation teardown.
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

    /// Every currently owned route, for shutdown.
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

    /// Claims the route-gone callback for `handle`. `true` exactly once per
    /// occupied route; the caller must invoke the callback.
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

    /// Forced-shutdown sweep: takes ownership of every settled route whose
    /// route-gone has not started, so the forced path can abort its tasks and
    /// run the callback (protocol §12 forced shutdown). Mid-bind routes are
    /// only marked close-requested: their abort-exempt bind wrapper owns the
    /// exactly-once route-gone, and completing the bind against a finalized
    /// slot would otherwise panic the registry.
    pub fn force_drain(&self) -> Vec<(RouteHandle, Vec<JoinHandle<()>>)> {
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
                std::mem::take(&mut occupant.tasks),
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
    /// Fast-forwards a channel's epoch history so the retirement boundary is
    /// reachable without u32::MAX reservations.
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

    /// Tests that require a specific next channel must set `cursor` first
    /// because `reserve` scans forward from the last allocation.
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
        let (writer, _task) = crate::wire::spawn_writer(
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
            next_ping_corr: AtomicU64::new(1),
        })
    }

    fn owner_tasks(decision: CloseDecision) -> Vec<JoinHandle<()>> {
        match decision {
            CloseDecision::Owner { tasks, .. } => tasks,
            CloseDecision::DeferredToBind => panic!("expected close ownership, got bind deferral"),
            CloseDecision::AlreadyGone => panic!("expected close ownership, got already-gone"),
        }
    }

    #[tokio::test]
    async fn reserved_channels_are_nonzero_distinct_and_start_at_epoch_one() {
        let registry = RouteRegistry::new(16);
        let gen = generation(1);
        let first = registry.reserve(&gen).expect("first reserve");
        let second = registry.reserve(&gen).expect("second reserve");

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
                let handle = registry.reserve(gen).expect("reserve");
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
        let handle = registry.reserve(&gen).expect("reserve");

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

        owner_tasks(registry.begin_close(handle));
        assert!(gen.membership.lock().expect("lock").is_empty());
    }

    #[tokio::test]
    async fn reuse_requires_cleanup_and_advances_the_epoch() {
        let registry = RouteRegistry::new(1);
        let gen = generation(1);
        let first = registry.reserve(&gen).expect("reserve");
        registry.install_bound(first);

        // A single-route budget cannot admit another route while this one lives.
        assert!(registry.reserve(&gen).is_none());

        owner_tasks(registry.begin_close(first));
        // Still owned until cleanup finalizes.
        assert!(registry.reserve(&gen).is_none());

        registry.finalize_close(first);
        registry.force_cursor(first.channel);
        let reused = registry.reserve(&gen).expect("reuse after cleanup");
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
        let probe = registry.reserve(&gen).expect("probe reserve");
        let channel = probe.channel;
        registry.finalize_close(probe);
        registry.force_last_epoch(channel, u32::MAX);
        registry.force_cursor(channel);

        let handle = registry
            .reserve(&gen)
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
        let handle = registry.reserve(&gen).expect("reserve");

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
        let handle = registry.reserve(&gen).expect("reserve");
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
        let handle = registry.reserve(&gen).expect("reserve");

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
        let handle = registry.reserve(&gen).expect("reserve");
        registry.install_bound(handle);

        owner_tasks(registry.begin_close(handle));
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
        let reused = registry.reserve(&gen).expect("reuse");
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
        let handle = registry.reserve(&gen).expect("reserve");

        // Mid-bind: not yet dispatchable, so no task may attach or receive
        // the route's cancellation root.
        assert!(registry
            .register_dispatch(handle, gen.id, tokio::spawn(async {}))
            .is_none());

        registry.install_bound(handle);
        let cancel = registry
            .register_dispatch(handle, gen.id, tokio::spawn(async {}))
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
                tokio::spawn(async {})
            )
            .is_none());

        let tasks = owner_tasks(registry.begin_close(handle));
        assert!(
            cancel.is_cancelled(),
            "the same lock transition that claims dispatch tasks cancels them"
        );
        assert_eq!(
            tasks.len(),
            1,
            "the close owner must receive the route's work"
        );
        assert!(registry
            .register_dispatch(handle, gen.id, tokio::spawn(async {}))
            .is_none());
    }

    #[tokio::test]
    async fn generation_teardown_sees_only_its_own_routes() {
        let registry = RouteRegistry::new(16);
        let mine = generation(7);
        let theirs = generation(8);
        let a = registry.reserve(&mine).expect("reserve a");
        let b = registry.reserve(&mine).expect("reserve b");
        let other = registry.reserve(&theirs).expect("reserve other");
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
        let live = registry.reserve(&gen).expect("reserve live");
        registry.install_bound(live);
        let mid_bind = registry.reserve(&gen).expect("reserve mid-bind");

        let drained: Vec<RouteHandle> = registry
            .force_drain()
            .into_iter()
            .map(|(handle, _tasks)| handle)
            .collect();

        assert_eq!(drained, vec![live], "only settled routes are swept");
        assert!(gen.membership.lock().expect("lock").is_empty());

        // The mid-bind route was marked close-requested, not finalized: its
        // bind wrapper completes against a live slot and owns route-gone.
        assert_eq!(
            registry.install_bound(mid_bind),
            BindInstall::CloseWins,
            "a bind completing after the forced sweep must observe the close"
        );
        // A rejected bind after the sweep is likewise a tolerated transfer.
        registry.take_rejected_bind(mid_bind);
        registry.finalize_close(mid_bind);
    }
}
