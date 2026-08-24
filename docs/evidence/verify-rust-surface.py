#!/usr/bin/env python3
"""Check every `subc` Rust item mc-module uses against the LATEST PUBLISHED source.

Run from a directory holding the extracted crate tarballs, e.g.

    for c in subc-protocol/0.10.0 subc-transport/0.5.0 \
             subc-control/0.1.1 subc-client-rs/0.3.0; do
        curl -sSL -o "$(echo "$c" | tr / -).crate" \
            "https://static.crates.io/crates/$c/download"
    done
    for f in subc-*.crate; do tar xzf "$f"; done
    python3 verify-rust-surface.py

Prints PRESENT/ABSENT per inventory row. ABSENT rows are the version deltas
between the locked private crates and the published reference source.
"""

from __future__ import annotations

import os
import re
import sys

CRATES = (
    "subc-protocol-0.10.0",
    "subc-transport-0.5.0",
    "subc-control-0.1.1",
    "subc-client-rs-0.3.0",
)

# (inventory row, source probe that must appear in that crate's src/). Probes
# prefixed with "re:" are regular expressions (searched with re.DOTALL); the
# rest are literal substrings. Every probe maps one-to-one onto an inventory
# row, so the PRESENT/ABSENT count reconciles against the row totals.
ITEMS: dict[str, tuple[tuple[str, str], ...]] = {
    "subc-protocol": (
        ("BindIdentity", "pub struct BindIdentity"),
        ("RouteTarget", "pub enum RouteTarget"),
        ("RouteTarget::ToolProvider", "    ToolProvider {"),
        ("RouteTarget::ManagementSurface", "    ManagementSurface {"),
        ("ErrorBody", "pub struct ErrorBody"),
        ("ErrorBody::new", "impl ErrorBody"),
        ("Flags", "pub struct Flags"),
        ("Flags::new", "pub fn new(binary: bool, priority: Priority, last: bool)"),
        ("Frame", "pub struct Frame"),
        ("Frame::build", "    pub fn build("),
        ("FrameBuildError", "pub enum FrameBuildError"),
        ("FrameType", "pub enum FrameType"),
        ("FrameType::Ping", "    Ping = 7,"),
        ("EnvelopeHeader", "pub struct EnvelopeHeader"),
        ("Priority::Interactive", "    Interactive"),
        ("PROTOCOL_VERSION", "pub const PROTOCOL_VERSION"),
        ("SUBC_MODULE_ID_ENV", "pub const SUBC_MODULE_ID_ENV"),
        ("SUBC_LAUNCH_NONCE_ENV", "pub const SUBC_LAUNCH_NONCE_ENV"),
        ("ModuleHelloAckBody", "pub struct ModuleHelloAckBody"),
        ("ModuleHelloAckBody.storage", "pub storage: Option<serde_json::Value>"),
        ("manifest::ModuleManifest", "pub struct ModuleManifest"),
        ("ModuleManifest.scheduled_tasks", "pub scheduled_tasks:"),
        ("manifest::TrustTier", "pub enum TrustTier"),
        ("manifest::ProviderRole", "pub enum ProviderRole"),
        (
            # Amended row: presence plus the test-demanded PartialEq derive
            # (one row, one result). The regex tolerates attribute order,
            # formatting, and CRLF differences in the published source, and
            # skips any mix of attributes and `//`-style (incl. doc) comment
            # lines between the derive and the enum keyword.
            "manifest::ConsumerRole (incl. PartialEq)",
            r"re:#\[derive\([^)]*\bPartialEq\b[^)]*\)\]\s*(?:#\[[^\]]*\]\s*|//[^\n]*\n\s*)*pub enum ConsumerRole",
        ),
        ("ConsumerRole::ServiceClient", "ServiceClient { of: Vec<String> }"),
        ("manifest::Bindings", "pub struct Bindings"),
        ("manifest::StorageBinding", "pub struct StorageBinding"),
        ("manifest::StorageKind", "pub enum StorageKind"),
        ("manifest::StorageScope", "pub enum StorageScope"),
        ("manifest::IdentityBinding", "pub struct IdentityBinding"),
        ("manifest::IdentityScope", "pub enum IdentityScope"),
        ("manifest::Concurrency", "pub enum Concurrency"),
        ("Concurrency::ModuleManaged", "    ModuleManaged"),
        ("manifest::Tool", "pub struct Tool"),
        ("manifest::ExecutionMode", "pub enum ExecutionMode"),
    ),
    "subc-transport": (
        ("authenticate_client", "pub async fn authenticate_client<"),
        ("connection_file::read", "pub fn read(path:"),
        ("read_frame", "pub async fn read_frame<"),
        ("write_frame", "pub async fn write_frame<"),
        ("AuthError", "pub enum AuthError"),
        ("ConnectionFileError", "pub enum ConnectionFileError"),
        ("FrameIoError", "pub enum FrameIoError"),
        ("ConnectionInfo", "pub struct ConnectionInfo"),
        ("Endpoint", "pub struct Endpoint"),
        ("SCHEMA_VERSION", "pub const SCHEMA_VERSION"),
        ("authenticate_server", "pub async fn authenticate_server<"),
        ("generate_key", "pub fn generate_key()"),
        ("generate_daemon_id", "pub fn generate_daemon_id()"),
        ("write_atomic", "pub fn write_atomic("),
    ),
    "subc-control": (
        ("ClientControlRequest", "pub enum ClientControlRequest"),
        ("ClientControlRequest::RouteOpen", '#[serde(rename = "route.open")]'),
        ("ClientControlResponse", "pub enum ClientControlResponse"),
        ("ConsumerIdentity", "pub struct ConsumerIdentity"),
        ("RouteOpen.admission_facts", "admission_facts: Option<serde_json::Value>"),
    ),
    "subc-client-rs": (
        ("async_trait re-export", "pub use async_trait::async_trait"),
        ("ModuleHandler", "pub trait ModuleHandler"),
        (
            "ModuleHandler::handle",
            "async fn handle(&self, ctx: RequestCtx, body: Vec<u8>) -> HandlerOutcome",
        ),
        ("ModuleHandler::on_hello_ack", "async fn on_hello_ack("),
        ("ModuleHandler::on_bind", "async fn on_bind("),
        ("ModuleHandler::on_route_gone", "async fn on_route_gone("),
        ("ModuleHandler::health", "async fn health(&self) -> HealthReport"),
        ("HandlerOutcome", "pub enum HandlerOutcome"),
        ("HandlerOutcome::Response", "    Response(Vec<u8>)"),
        ("HandlerOutcome::Error", "    Error { code: String, message: String }"),
        ("HandlerOutcome::ErrorWithDetail", "ErrorWithDetail"),
        ("HandlerOutcome::Streamed", "    Streamed"),
        ("HealthReport (re-export)", "session::{HealthReport, HealthStatus}"),
        ("RequestCtx", "pub struct RequestCtx"),
        ("RequestCtx::route_handle", "pub fn route_handle(&self) -> RouteHandle"),
        ("RouteBindRequest", "pub struct RouteBindRequest"),
        ("RouteHandle", "pub struct RouteHandle"),
        ("BindDecision", "pub struct BindDecision"),
        ("BindDecision::accept", "pub fn accept() -> Self"),
        ("serve_with", "pub async fn serve_with<"),
        ("SubcConsumer", "pub struct SubcConsumer"),
        ("SubcConsumer::connect", "    pub async fn connect("),
        ("SubcConsumer::call", "    pub async fn call("),
        ("SubcConsumer::close_route", "    pub async fn close_route("),
        ("SubcConsumer::close", "    pub async fn close(&self)"),
        ("ConsumerOptions", "pub struct ConsumerOptions"),
        ("CallOptions", "pub struct CallOptions"),
        ("CloseRouteOptions", "pub struct CloseRouteOptions"),
        ("RetryBackoff", "pub struct RetryBackoff"),
        ("CallError", "pub enum CallError"),
        ("CallError::Module", "    Module(ErrorBody)"),
    ),
}


def read_crate_source(crate_dir: str) -> str:
    """Concatenate every .rs file under crate_dir/src."""
    parts: list[str] = []
    for root, _dirs, files in os.walk(os.path.join(crate_dir, "src")):
        for name in sorted(files):
            if not name.endswith(".rs"):
                continue
            path = os.path.join(root, name)
            try:
                with open(path, encoding="utf-8") as handle:
                    parts.append(handle.read())
            except OSError as error:
                print(f"warning: could not read {path}: {error}", file=sys.stderr)
    return "".join(parts)


def main() -> int:
    sources: dict[str, str] = {}
    for crate in CRATES:
        if not os.path.isdir(crate):
            print(
                f"error: {crate}/ not found; extract the .crate tarballs first "
                "(see this file's docstring)",
                file=sys.stderr,
            )
            return 2
        sources[crate.rsplit("-", 1)[0]] = read_crate_source(crate)

    absent: list[tuple[str, str, str]] = []
    for crate, rows in ITEMS.items():
        for name, probe in rows:
            if probe.startswith("re:"):
                present = re.search(probe[3:], sources[crate], re.DOTALL) is not None
            else:
                present = probe in sources[crate]
            if not present:
                absent.append((crate, name, probe))
            status = "PRESENT" if present else "ABSENT "
            print(f"{status:8} {crate:16} {name}")

    print("\n--- ABSENT SUMMARY ---")
    if not absent:
        print("none")
    for crate, name, probe in absent:
        print(f"{crate}: {name}   (probe: {probe!r})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
