pub mod confidence_scorer;
pub mod ingestor;
pub mod ipc_server;
pub mod signal_extractor;
pub mod store;

use std::io::Write as _;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};

use ingestor::EventIngestor;
use ipc_server::IpcServer;
use store::SQLiteStore;

// ---------------------------------------------------------------------------
// CLI helpers (public so tests can access them)
// ---------------------------------------------------------------------------

/// Derive the Unix socket path for a session.
///
/// Path: `~/.local/share/context-evalver/{session_id}.sock`
pub fn socket_path_for_session(session_id: &str) -> PathBuf {
    let base = dirs_next::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    base.join("context-evalver").join(format!("{session_id}.sock"))
}

/// Parse `--session-id <id>` and `--repo-root <path>` from `argv`.
///
/// Arguments may appear in any order. Returns an error if either flag is
/// missing or lacks a value.
pub fn parse_cli(args: &[String]) -> Result<(String, String)> {
    let mut session_id: Option<String> = None;
    let mut repo_root: Option<String> = None;
    let mut i = 1usize;

    while i < args.len() {
        match args[i].as_str() {
            "--session-id" => {
                i += 1;
                session_id = Some(
                    args.get(i)
                        .cloned()
                        .ok_or_else(|| anyhow!("--session-id requires a value"))?,
                );
            }
            "--repo-root" => {
                i += 1;
                repo_root = Some(
                    args.get(i)
                        .cloned()
                        .ok_or_else(|| anyhow!("--repo-root requires a value"))?,
                );
            }
            _ => {}
        }
        i += 1;
    }

    let session_id = session_id.ok_or_else(|| anyhow!("--session-id is required"))?;
    let repo_root = repo_root.ok_or_else(|| anyhow!("--repo-root is required"))?;
    Ok((session_id, repo_root))
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    if let Err(e) = run() {
        eprintln!("[context-evalver-core] fatal: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (session_id, repo_root) = parse_cli(&args)?;

    let sock_path = socket_path_for_session(&session_id);
    if let Some(parent) = sock_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // 1. Initialize SQLiteStore (creates DB directory + schema on first open).
    let store = Arc::new(Mutex::new(SQLiteStore::open(&repo_root)?));

    // 2. Initialize EventIngestor.
    let ingestor = Arc::new(EventIngestor::new(Arc::clone(&store)));

    // 3. Bind the IPC socket before starting the flush thread so any startup
    //    error surfaces early.
    let server = IpcServer::bind(&sock_path)?;

    // 4. Spawn the 100 ms background flush thread.
    let flush_thread = ingestor.start_flush_thread();

    // 5. Install SIGTERM / SIGINT handler.
    //    On signal: flush buffered events, then send a shutdown message to the
    //    IPC server so its accept loop exits cleanly.
    let ingestor_sig = Arc::clone(&ingestor);
    let sock_path_sig = sock_path.clone();
    ctrlc::set_handler(move || {
        let _ = ingestor_sig.flush();
        // Wake the blocking accept() by connecting and sending shutdown.
        if let Ok(mut s) = UnixStream::connect(&sock_path_sig) {
            let _ = s.write_all(b"{\"type\":\"shutdown\"}\n");
            let _ = s.flush();
        }
    })?;

    // 6. Run the IPC server — blocks until a shutdown message is received.
    server.run(&ingestor, Arc::clone(&store))?;

    // 7. Final cleanup: stop the flush thread (drains any remaining buffer).
    flush_thread.stop();

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // parse_cli
    // -----------------------------------------------------------------------

    fn args(parts: &[&str]) -> Vec<String> {
        std::iter::once("context-evalver-core")
            .chain(parts.iter().copied())
            .map(String::from)
            .collect()
    }

    #[test]
    fn test_parse_cli_extracts_session_id_and_repo_root() {
        let a = args(&["--session-id", "abc-123", "--repo-root", "/my/repo"]);
        let (sid, rr) = parse_cli(&a).unwrap();
        assert_eq!(sid, "abc-123");
        assert_eq!(rr, "/my/repo");
    }

    #[test]
    fn test_parse_cli_args_in_reverse_order() {
        let a = args(&["--repo-root", "/my/repo", "--session-id", "sess-x"]);
        let (sid, rr) = parse_cli(&a).unwrap();
        assert_eq!(sid, "sess-x");
        assert_eq!(rr, "/my/repo");
    }

    #[test]
    fn test_parse_cli_missing_session_id_is_error() {
        let a = args(&["--repo-root", "/my/repo"]);
        assert!(parse_cli(&a).is_err(), "missing --session-id must be an error");
    }

    #[test]
    fn test_parse_cli_missing_repo_root_is_error() {
        let a = args(&["--session-id", "abc-123"]);
        assert!(parse_cli(&a).is_err(), "missing --repo-root must be an error");
    }

    #[test]
    fn test_parse_cli_no_args_is_error() {
        let a = args(&[]);
        assert!(parse_cli(&a).is_err());
    }

    #[test]
    fn test_parse_cli_unknown_flags_are_ignored() {
        let a = args(&[
            "--verbose",
            "--session-id", "s1",
            "--unknown-flag", "val",
            "--repo-root", "/repo",
        ]);
        let (sid, rr) = parse_cli(&a).unwrap();
        assert_eq!(sid, "s1");
        assert_eq!(rr, "/repo");
    }

    #[test]
    fn test_parse_cli_session_id_missing_value_is_error() {
        let a = args(&["--session-id"]); // no value follows
        assert!(parse_cli(&a).is_err());
    }

    #[test]
    fn test_parse_cli_repo_root_missing_value_is_error() {
        let a = args(&["--session-id", "s1", "--repo-root"]); // no value follows
        assert!(parse_cli(&a).is_err());
    }

    // -----------------------------------------------------------------------
    // socket_path_for_session
    // -----------------------------------------------------------------------

    #[test]
    fn test_socket_path_ends_with_session_id_sock() {
        let path = socket_path_for_session("my-session-123");
        let filename = path.file_name().unwrap().to_str().unwrap();
        assert_eq!(filename, "my-session-123.sock");
    }

    #[test]
    fn test_socket_path_contains_context_optimizer_directory() {
        let path = socket_path_for_session("test");
        let path_str = path.to_str().unwrap();
        assert!(
            path_str.contains("context-evalver"),
            "socket path should be under 'context-evalver' dir: {path_str}"
        );
    }

    #[test]
    fn test_socket_path_differs_between_sessions() {
        let p1 = socket_path_for_session("session-a");
        let p2 = socket_path_for_session("session-b");
        assert_ne!(p1, p2);
    }

    #[test]
    fn test_socket_path_is_deterministic() {
        let p1 = socket_path_for_session("sess-42");
        let p2 = socket_path_for_session("sess-42");
        assert_eq!(p1, p2, "same session_id must always produce the same path");
    }

    #[test]
    fn test_socket_path_has_sock_extension() {
        let path = socket_path_for_session("any-session");
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("sock"));
    }
}
