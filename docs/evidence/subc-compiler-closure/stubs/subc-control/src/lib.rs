
use serde::{Deserialize, Serialize};
use serde_json::Value;
use subc_protocol::{BindIdentity, RouteTarget};

#[derive(Serialize, Deserialize)]
pub struct ConsumerIdentity {
    pub module_id: String,
    pub launch_nonce: String,
}

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

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum ClientControlResponse {
    #[serde(rename = "route.open")]
    RouteOpen { route_channel: u16, route_epoch: u32 },
}
