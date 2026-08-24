//! Compile-closure stub for `subc-control` (private 0.1.2); each public item
//! is one row of the subc API surface inventory, and the crate is compiled
//! but never executed.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use subc_protocol::{BindIdentity, RouteTarget};

/// Row: `ConsumerIdentity` — `{ module_id, launch_nonce }`.
#[derive(Serialize, Deserialize)]
pub struct ConsumerIdentity {
    pub module_id: String,
    pub launch_nonce: String,
}

/// Row: `ClientControlRequest` — serde-tagged control envelope on channel 0;
/// the variant's wire tag is the dot-delimited `"route.open"` (per-variant
/// `rename`, matching published 0.1.1 and private 0.1.2).
/// Row: `ClientControlRequest::RouteOpen` — `{ target, identity,
/// consumer_identity, consumer_capabilities, admission_facts }`.
/// Row: `RouteOpen.admission_facts` — `Option<Value>`, sent as `None`.
#[derive(Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum ClientControlRequest {
    #[serde(rename = "route.open")]
    RouteOpen {
        target: RouteTarget,
        identity: BindIdentity,
        consumer_identity: Option<ConsumerIdentity>,
        consumer_capabilities: Option<Value>,
        admission_facts: Option<Value>,
    },
}

/// Row: `ClientControlResponse::RouteOpen` — `{ route_channel: u16,
/// route_epoch: u32 }`; wire tag `"route.open"`, as on the request enum.
/// `Debug` demanded by the catch-all match arm at
/// `tests/broca_roundtrip.rs:591:58`, which formats the response with
/// `panic!("unexpected control response {other:?}")` (E0277).
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum ClientControlResponse {
    #[serde(rename = "route.open")]
    RouteOpen { route_channel: u16, route_epoch: u32 },
}
