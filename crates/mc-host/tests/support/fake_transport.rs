//! Injected fake transport provider and a raw driver for its candidate
//! channel, used by the negotiation host tests. The fake never touches
//! `mc-host` encoders on the assertion side: candidate frames are built and
//! decoded with the independent `raw_client` codec.

#![allow(dead_code)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mc_host::transport_provider::{
    memory_candidate, InjectedProvider, PreparedCandidate, ProviderContext, ProviderFailure,
    TransportProviders,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::mpsc;

use super::raw_client::{decode_header, header, RawFrame, HEADER_LEN};

pub const FAKE_TRANSPORT: &str = "fake";

pub struct FakeProvider {
    capability_version: u32,
    descriptor: serde_json::Value,
    buffer_bytes: usize,
    fail_next: Mutex<Option<ProviderFailure>>,
    prepared: AtomicU64,
    peers: mpsc::UnboundedSender<DuplexStream>,
}

impl FakeProvider {
    /// Builds a provider plus the receiver on which each prepared
    /// candidate's peer half arrives.
    pub fn install(
        capability_version: u32,
        descriptor: serde_json::Value,
        buffer_bytes: usize,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<DuplexStream>) {
        let (peers, peer_rx) = mpsc::unbounded_channel();
        (
            Arc::new(Self {
                capability_version,
                descriptor,
                buffer_bytes,
                fail_next: Mutex::new(None),
                prepared: AtomicU64::new(0),
                peers,
            }),
            peer_rx,
        )
    }

    /// The registry includes this provider and built-in TCP only.
    pub fn registry(provider: &Arc<Self>) -> TransportProviders {
        TransportProviders::with_injected(vec![Arc::clone(provider) as Arc<dyn InjectedProvider>])
    }

    /// Scripts the next `prepare` to fail its KTD9 attachment gate.
    pub fn fail_next(&self, failure: ProviderFailure) {
        *self.fail_next.lock().expect("fail lock") = Some(failure);
    }

    pub fn prepared_count(&self) -> u64 {
        self.prepared.load(Ordering::SeqCst)
    }
}

impl InjectedProvider for FakeProvider {
    fn transport(&self) -> &str {
        FAKE_TRANSPORT
    }

    fn capability_version(&self) -> u32 {
        self.capability_version
    }

    fn prepare(&self, ctx: &ProviderContext) -> Result<PreparedCandidate, ProviderFailure> {
        if let Some(failure) = self.fail_next.lock().expect("fail lock").take() {
            return Err(failure);
        }
        let (candidate, peer) = memory_candidate(ctx, self.buffer_bytes);
        let candidate_id = self.prepared.fetch_add(1, Ordering::SeqCst) + 1;
        self.peers.send(peer).expect("test holds the peer receiver");
        Ok(PreparedCandidate {
            descriptor: self.descriptor.clone(),
            candidate_id,
            candidate,
        })
    }
}

/// Raw v2 frame driver over a candidate's peer duplex half.
pub struct RawCandidate {
    stream: DuplexStream,
    pub next_corr: u64,
}

impl RawCandidate {
    pub fn new(stream: DuplexStream) -> Self {
        Self {
            stream,
            next_corr: 0,
        }
    }

    pub fn next_corr(&mut self) -> u64 {
        self.next_corr += 1;
        self.next_corr
    }

    pub async fn send_frame(
        &mut self,
        ty: u8,
        flags: u8,
        channel: u16,
        epoch: u32,
        corr: u64,
        body: &[u8],
    ) -> std::io::Result<()> {
        let mut wire = header(body.len() as u32, ty, flags, channel, epoch, corr);
        wire.extend_from_slice(body);
        self.stream.write_all(&wire).await
    }

    pub async fn expect_frame(&mut self) -> std::io::Result<RawFrame> {
        let mut header_bytes = [0u8; HEADER_LEN];
        self.stream.read_exact(&mut header_bytes).await?;
        let mut frame = decode_header(&header_bytes);
        if frame.len > 0 {
            let mut body = vec![0u8; frame.len as usize];
            self.stream.read_exact(&mut body).await?;
            frame.body = body;
        }
        Ok(frame)
    }

    pub async fn frame_within(&mut self, budget: Duration) -> Result<RawFrame, String> {
        match tokio::time::timeout(budget, self.expect_frame()).await {
            Ok(Ok(frame)) => Ok(frame),
            Ok(Err(err)) => Err(format!("candidate frame read failed: {err}")),
            Err(_) => Err("timed out waiting for a candidate frame".to_owned()),
        }
    }

    /// True when no frame (or close) arrives for the whole budget.
    pub async fn quiet_for(&mut self, budget: Duration) -> bool {
        tokio::time::timeout(budget, self.expect_frame())
            .await
            .is_err()
    }

    pub async fn closed_within(&mut self, budget: Duration) -> bool {
        let mut byte = [0u8; 1];
        match tokio::time::timeout(budget, self.stream.read(&mut byte)).await {
            Ok(Ok(0)) => true,
            Ok(Ok(_)) => false,
            Ok(Err(_)) => true,
            Err(_) => false,
        }
    }
}
