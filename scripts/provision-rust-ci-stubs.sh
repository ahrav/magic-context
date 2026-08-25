#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
parent=$(dirname "$root")

create_stub() {
  path=$1
  name=$2
  if [ -f "$path/Cargo.toml" ]; then
    return
  fi
  mkdir -p "$path/src"
  cat >"$path/Cargo.toml" <<EOF
[package]
name = "$name"
version = "0.0.0"
edition = "2021"
publish = false

[lib]
path = "src/lib.rs"
EOF
  printf '%s\n' '#![allow(dead_code)]' >"$path/src/lib.rs"
}

create_stub "$parent/commons/crates/cortexkit-cache-core" cortexkit-cache-core
create_stub "$parent/commons/crates/cortexkit-store" cortexkit-store
create_stub "$parent/commons/crates/cortexkit-store-types" cortexkit-store-types
create_stub "$parent/commons/crates/cortexkit-lease" cortexkit-lease
create_stub "$parent/subconscious/crates/subc-protocol" subc-protocol
create_stub "$parent/subconscious/crates/subc-control" subc-control
create_stub "$parent/subconscious/crates/subc-transport" subc-transport
create_stub "$parent/subconscious/crates/subc-client-rs" subc-client-rs
create_stub "$parent/subconscious/crates/subc-core" subc-core
