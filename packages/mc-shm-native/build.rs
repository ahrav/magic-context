//! Configures the N-API native build through `napi-build`.
//!
//! The helper emits Cargo build-script directives and may fail the build when
//! the native toolchain or environment is unsupported.

fn main() {
    napi_build::setup();
}
