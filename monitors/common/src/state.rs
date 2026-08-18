//! JSON state persistence for monitor dedup/cold-start tracking.
//!
//! Load returns `None` (cold start) when the file is missing or unreadable so a
//! first run seeds fresh state. Save writes atomically via a temp file + rename.

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::io::Write;
use std::path::Path;

/// Load state from `path`, or `None` if absent/corrupt (treated as cold start).
pub fn load_state<T: DeserializeOwned>(path: impl AsRef<Path>) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Persist `state` to `path` atomically. Creates parent dirs as needed.
pub fn save_state<T: Serialize>(path: impl AsRef<Path>, state: &T) -> Result<(), String> {
    let path = path.as_ref();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create state dir: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    // Drop a partial temp file rather than leaving it to occupy the space the
    // next attempt needs.
    if let Err(e) = write_tmp(&tmp, &json) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("rename state: {e}"))
}

/// Write `json` to `tmp`, fsyncing so a later rename can't publish a short file.
fn write_tmp(tmp: &Path, json: &[u8]) -> Result<(), String> {
    let mut f = std::fs::File::create(tmp).map_err(|e| format!("write state tmp: {e}"))?;
    f.write_all(json).map_err(|e| format!("write state: {e}"))?;
    f.flush().map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| format!("sync state: {e}"))
}
