use std::path::PathBuf;

use napi::{Env, Result};

pub(crate) fn register_cleanup_marker(env: &Env, path: PathBuf) -> Result<()> {
    env.add_env_cleanup_hook(path, |path| {
        let _ = std::fs::write(path, b"clean");
    })?;
    Ok(())
}
