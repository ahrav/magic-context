#[cfg(any(feature = "bench-topology", test))]
use std::collections::VecDeque;
use std::sync::Arc;
#[cfg(any(feature = "bench-topology", test))]
use std::sync::Mutex;

#[cfg(any(feature = "bench-topology", test))]
use tokio::sync::oneshot;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkClass {
    Query,
    Batch,
}

impl WorkClass {
    #[cfg(any(feature = "bench-topology", test))]
    fn other(self) -> Self {
        match self {
            Self::Query => Self::Batch,
            Self::Batch => Self::Query,
        }
    }
}

pub(crate) struct Topology {
    cpu: Arc<Semaphore>,
    chunk_rows: Option<usize>,
    #[cfg(feature = "bench-topology")]
    gate: Gate,
    reserve_result_at_start: bool,
}

impl Topology {
    pub(crate) fn production() -> Self {
        Self {
            cpu: Arc::new(Semaphore::new(1)),
            chunk_rows: None,
            #[cfg(feature = "bench-topology")]
            gate: Gate::Serialized,
            reserve_result_at_start: false,
        }
    }

    #[cfg(feature = "bench-topology")]
    pub(crate) fn benchmark(config: super::BenchTopology) -> Self {
        let (permits, chunk_rows, gate) = match config {
            super::BenchTopology::B0 | super::BenchTopology::T1 { .. } => {
                (1, None, Gate::Serialized)
            }
            super::BenchTopology::T2 => (1, None, Gate::ClassAware(ClassGate::new())),
            super::BenchTopology::T3 { chunk_rows } => (1, Some(chunk_rows), Gate::Serialized),
            super::BenchTopology::T4 { permits } | super::BenchTopology::T5 { permits } => {
                (permits, None, Gate::Serialized)
            }
        };
        Self {
            cpu: Arc::new(Semaphore::new(permits)),
            chunk_rows,
            gate,
            reserve_result_at_start: chunk_rows.is_some() || permits > 1,
        }
    }

    pub(crate) async fn acquire(&self, _class: WorkClass) -> Result<Turn, AcquireError> {
        #[cfg(feature = "bench-topology")]
        let class_turn = match &self.gate {
            Gate::Serialized => None,
            Gate::ClassAware(gate) => Some(gate.acquire(_class).await?),
        };
        let cpu = Arc::clone(&self.cpu)
            .acquire_owned()
            .await
            .map_err(|_| AcquireError)?;
        Ok(Turn {
            _cpu: cpu,
            #[cfg(feature = "bench-topology")]
            _class: class_turn,
        })
    }

    pub(crate) fn chunk_rows(&self) -> Option<usize> {
        self.chunk_rows
    }

    pub(crate) fn reserve_result_at_start(&self) -> bool {
        self.reserve_result_at_start
    }

    pub(crate) fn close(&self) {
        self.cpu.close();
        #[cfg(feature = "bench-topology")]
        if let Gate::ClassAware(gate) = &self.gate {
            gate.close();
        }
    }
}

#[cfg(feature = "bench-topology")]
enum Gate {
    Serialized,
    #[cfg(feature = "bench-topology")]
    ClassAware(Arc<ClassGate>),
}

#[derive(Debug)]
pub(crate) struct AcquireError;

pub(crate) struct Turn {
    _cpu: OwnedSemaphorePermit,
    #[cfg(feature = "bench-topology")]
    _class: Option<ClassTurn>,
}

#[cfg(any(feature = "bench-topology", test))]
struct Waiter {
    id: u64,
    tx: oneshot::Sender<()>,
}

#[cfg(any(feature = "bench-topology", test))]
struct ClassState {
    active: bool,
    closed: bool,
    next: WorkClass,
    next_id: u64,
    query: VecDeque<Waiter>,
    batch: VecDeque<Waiter>,
}

#[cfg(any(feature = "bench-topology", test))]
struct ClassGate {
    state: Mutex<ClassState>,
}

#[cfg(any(feature = "bench-topology", test))]
impl ClassGate {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(ClassState {
                active: false,
                closed: false,
                next: WorkClass::Query,
                next_id: 0,
                query: VecDeque::new(),
                batch: VecDeque::new(),
            }),
        })
    }

    async fn acquire(self: &Arc<Self>, class: WorkClass) -> Result<ClassTurn, AcquireError> {
        let (rx, id) = {
            let mut state = self.state.lock().expect("class gate lock");
            if state.closed {
                return Err(AcquireError);
            }
            if !state.active && state.query.is_empty() && state.batch.is_empty() {
                state.active = true;
                return Ok(ClassTurn {
                    gate: Arc::clone(self),
                });
            }
            let (tx, rx) = oneshot::channel();
            let id = state.next_id;
            state.next_id = state.next_id.wrapping_add(1);
            state.queue_mut(class).push_back(Waiter { id, tx });
            (rx, id)
        };
        let mut registration = Registration {
            gate: Arc::clone(self),
            class,
            id,
            armed: true,
        };
        rx.await.map_err(|_| AcquireError)?;
        registration.armed = false;
        Ok(ClassTurn {
            gate: Arc::clone(self),
        })
    }

    fn release(&self) {
        let mut state = self.state.lock().expect("class gate lock");
        if state.closed {
            state.active = false;
            return;
        }
        loop {
            let both = !state.query.is_empty() && !state.batch.is_empty();
            let class = if both {
                state.next
            } else if !state.query.is_empty() {
                WorkClass::Query
            } else if !state.batch.is_empty() {
                WorkClass::Batch
            } else {
                state.active = false;
                return;
            };
            let waiter = state
                .queue_mut(class)
                .pop_front()
                .expect("queue is nonempty");
            if waiter.tx.send(()).is_ok() {
                state.active = true;
                if both {
                    state.next = class.other();
                }
                return;
            }
        }
    }

    fn deregister(&self, class: WorkClass, id: u64) -> bool {
        let mut state = self.state.lock().expect("class gate lock");
        let queue = state.queue_mut(class);
        if let Some(index) = queue.iter().position(|waiter| waiter.id == id) {
            queue.remove(index);
            true
        } else {
            false
        }
    }

    fn close(&self) {
        let mut state = self.state.lock().expect("class gate lock");
        state.closed = true;
        state.query.clear();
        state.batch.clear();
    }
}

#[cfg(any(feature = "bench-topology", test))]
impl ClassState {
    fn queue_mut(&mut self, class: WorkClass) -> &mut VecDeque<Waiter> {
        match class {
            WorkClass::Query => &mut self.query,
            WorkClass::Batch => &mut self.batch,
        }
    }
}

#[cfg(any(feature = "bench-topology", test))]
struct Registration {
    gate: Arc<ClassGate>,
    class: WorkClass,
    id: u64,
    armed: bool,
}

#[cfg(any(feature = "bench-topology", test))]
impl Drop for Registration {
    fn drop(&mut self) {
        if self.armed {
            // A waiter may be cancelled after its sender grants the baton but
            // before its future is polled again. Its queue entry is gone in
            // that case, so cancellation must pass the baton onward.
            if !self.gate.deregister(self.class, self.id) {
                self.gate.release();
            }
        }
    }
}

#[cfg(any(feature = "bench-topology", test))]
struct ClassTurn {
    gate: Arc<ClassGate>,
}

#[cfg(any(feature = "bench-topology", test))]
impl Drop for ClassTurn {
    fn drop(&mut self) {
        self.gate.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_send_static<T: Send + 'static>(_: &T) {}

    #[tokio::test]
    async fn class_gate_is_work_conserving_and_turn_is_send_static() {
        let gate = ClassGate::new();
        let first = gate.acquire(WorkClass::Query).await.expect("first turn");
        let waiting_gate = Arc::clone(&gate);
        let waiting = tokio::spawn(async move { waiting_gate.acquire(WorkClass::Batch).await });
        tokio::task::yield_now().await;
        drop(first);
        let turn = waiting.await.expect("waiter joins").expect("batch turn");
        assert_send_static(&turn);
    }

    #[tokio::test]
    async fn cancellation_deregisters_without_advancing_alternation() {
        let gate = ClassGate::new();
        let first = gate.acquire(WorkClass::Batch).await.expect("first turn");
        let cancelled_gate = Arc::clone(&gate);
        let cancelled = tokio::spawn(async move { cancelled_gate.acquire(WorkClass::Query).await });
        tokio::task::yield_now().await;
        cancelled.abort();
        let _ = cancelled.await;

        let batch_gate = Arc::clone(&gate);
        let batch = tokio::spawn(async move { batch_gate.acquire(WorkClass::Batch).await });
        let query_gate = Arc::clone(&gate);
        let query = tokio::spawn(async move { query_gate.acquire(WorkClass::Query).await });
        tokio::task::yield_now().await;
        drop(first);
        let query_turn = query.await.expect("query joins").expect("query turn");
        assert!(
            !batch.is_finished(),
            "query cursor must not advance on cancellation"
        );
        drop(query_turn);
        batch.await.expect("batch joins").expect("batch turn");
    }

    #[tokio::test]
    async fn cancellation_after_grant_passes_the_baton() {
        let gate = ClassGate::new();
        let first = gate.acquire(WorkClass::Query).await.expect("first turn");
        let cancelled_gate = Arc::clone(&gate);
        let cancelled = tokio::spawn(async move { cancelled_gate.acquire(WorkClass::Batch).await });
        tokio::task::yield_now().await;

        drop(first);
        cancelled.abort();
        let _ = cancelled.await;

        let next = gate
            .acquire(WorkClass::Query)
            .await
            .expect("baton survives cancelled grant");
        drop(next);
    }

    #[tokio::test]
    async fn close_wakes_waiters_as_cancellation_errors() {
        let gate = ClassGate::new();
        let first = gate.acquire(WorkClass::Query).await.expect("first turn");
        let waiting_gate = Arc::clone(&gate);
        let waiting = tokio::spawn(async move { waiting_gate.acquire(WorkClass::Batch).await });
        tokio::task::yield_now().await;
        gate.close();
        assert!(waiting.await.expect("waiter joins").is_err());
        drop(first);
    }
}
