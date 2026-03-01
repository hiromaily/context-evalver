use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::confidence_scorer::{ConfidenceScorerService, SignalSummary};
use crate::ingestor::EventIngestor;
use crate::signal_extractor;
use crate::store::{EventRecord, SQLiteStore};

// ---------------------------------------------------------------------------
// Wire protocol types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InboundMessage {
    Event { event: EventRecord },
    QuerySignals { repo_root: String, window_days: u32, min_repeat_threshold: u32 },
    Flush,
    Shutdown,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutboundMessage {
    SignalSummary(SignalSummary),
    Ack { ok: bool },
    Error { message: String },
}

// ---------------------------------------------------------------------------
// IpcServer
// ---------------------------------------------------------------------------

/// Unix domain socket server that accepts sequential JSONL connections.
pub struct IpcServer {
    listener: UnixListener,
    socket_path: PathBuf,
}

impl IpcServer {
    /// Bind a new Unix socket at `socket_path`.
    /// Removes a stale socket file at that path if one already exists.
    pub fn bind(socket_path: impl AsRef<Path>) -> Result<Self> {
        let path = socket_path.as_ref();
        if path.exists() {
            std::fs::remove_file(path)?;
        }
        let listener = UnixListener::bind(path)?;
        Ok(IpcServer { listener, socket_path: path.to_path_buf() })
    }

    /// Return the path to the bound socket.
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// Accept connections sequentially and process JSONL messages.
    ///
    /// Returns when a `shutdown` message is received or a fatal accept error
    /// occurs. All connections after `shutdown` are ignored.
    pub fn run(
        &self,
        ingestor: &EventIngestor,
        store: Arc<Mutex<SQLiteStore>>,
    ) -> Result<()> {
        for stream in self.listener.incoming() {
            match stream {
                Ok(s) => match handle_connection(s, ingestor, &store) {
                    Ok(true) => break,  // shutdown requested
                    Ok(false) => {}
                    Err(e) => eprintln!("[ipc] connection error: {e}"),
                },
                Err(e) => {
                    eprintln!("[ipc] accept error: {e}");
                    break;
                }
            }
        }
        Ok(())
    }
}

impl Drop for IpcServer {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

// ---------------------------------------------------------------------------
// Per-connection handling
// ---------------------------------------------------------------------------

/// Process all JSONL messages on a single connection.
/// Returns `Ok(true)` when a `shutdown` message is received.
fn handle_connection(
    stream: UnixStream,
    ingestor: &EventIngestor,
    store: &Arc<Mutex<SQLiteStore>>,
) -> Result<bool> {
    let mut writer = stream.try_clone()?;
    let reader = BufReader::new(stream);

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<InboundMessage>(&line) {
            Err(e) => OutboundMessage::Error { message: format!("parse error: {e}") },
            Ok(msg) => match dispatch(msg, ingestor, store) {
                Dispatched::Ack(r) => match r {
                    Ok(shutdown) => {
                        write_message(&mut writer, &OutboundMessage::Ack { ok: true })?;
                        if shutdown {
                            return Ok(true);
                        }
                        continue;
                    }
                    Err(e) => OutboundMessage::Error { message: e.to_string() },
                },
                Dispatched::Summary(r) => match r {
                    Ok(summary) => OutboundMessage::SignalSummary(summary),
                    Err(e) => OutboundMessage::Error { message: e.to_string() },
                },
            },
        };

        write_message(&mut writer, &response)?;
    }

    Ok(false) // EOF without shutdown
}

/// Intermediate dispatch result to avoid duplication.
enum Dispatched {
    /// `Ok(true)` → shutdown was requested; `Ok(false)` → normal ack.
    Ack(Result<bool>),
    Summary(Result<SignalSummary>),
}

fn dispatch(
    msg: InboundMessage,
    ingestor: &EventIngestor,
    store: &Arc<Mutex<SQLiteStore>>,
) -> Dispatched {
    match msg {
        InboundMessage::Event { event } => {
            Dispatched::Ack(ingestor.ingest(event).map(|_| false))
        }
        InboundMessage::Flush => {
            Dispatched::Ack(ingestor.flush().map(|_| false))
        }
        InboundMessage::Shutdown => {
            Dispatched::Ack(ingestor.flush().map(|_| true))
        }
        InboundMessage::QuerySignals { repo_root, window_days, min_repeat_threshold } => {
            Dispatched::Summary(query_signals(store, &repo_root, window_days, min_repeat_threshold))
        }
    }
}

fn query_signals(
    store: &Arc<Mutex<SQLiteStore>>,
    repo_root: &str,
    window_days: u32,
    threshold: u32,
) -> Result<SignalSummary> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let since = now - window_days as i64 * 86_400;

    let db = store.lock().unwrap();
    let (stats, raw_signals) = signal_extractor::extract(&db, repo_root, window_days, threshold)?;
    let unique_file_count = db.query_unique_file_count(repo_root, since)?;
    ConfidenceScorerService::score(raw_signals, stats, &db, repo_root, unique_file_count, now)
}

fn write_message(writer: &mut impl Write, msg: &OutboundMessage) -> Result<()> {
    let json = serde_json::to_string(msg)?;
    writer.write_all(json.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    fn setup() -> (TempDir, Arc<Mutex<SQLiteStore>>, EventIngestor) {
        let dir = TempDir::new().unwrap();
        let store = Arc::new(Mutex::new(SQLiteStore::open_in_memory()));
        let ingestor = EventIngestor::new(Arc::clone(&store));
        (dir, store, ingestor)
    }

    /// Connect to the socket, send a JSONL line, read one response line.
    fn send_recv(socket_path: &Path, payload: &str) -> String {
        let mut stream = UnixStream::connect(socket_path).unwrap();
        stream.write_all(payload.as_bytes()).unwrap();
        stream.write_all(b"\n").unwrap();
        stream.flush().unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        line.trim().to_string()
    }

    // -----------------------------------------------------------------------
    // bind / socket lifecycle
    // -----------------------------------------------------------------------

    #[test]
    fn test_bind_creates_socket_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.sock");
        let server = IpcServer::bind(&path).unwrap();
        assert!(path.exists(), "socket file must exist after bind");
        drop(server);
        assert!(!path.exists(), "socket file must be removed on drop");
    }

    #[test]
    fn test_bind_removes_stale_socket() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("stale.sock");
        // Pre-create a regular file to simulate a stale socket.
        std::fs::write(&path, b"stale").unwrap();
        let _server = IpcServer::bind(&path).unwrap();
        // Binding should succeed even with the stale file.
        assert!(path.exists());
    }

    // -----------------------------------------------------------------------
    // event message → ack
    // -----------------------------------------------------------------------

    #[test]
    fn test_event_message_returns_ack() {
        let (dir, store, ingestor) = setup();
        let socket_path = dir.path().join("test.sock");
        let ingestor = Arc::new(ingestor);

        let server = IpcServer::bind(&socket_path).unwrap();
        let store_clone = Arc::clone(&store);
        let ingestor_clone = Arc::clone(&ingestor);
        let path_clone = socket_path.clone();
        let handle = std::thread::spawn(move || server.run(&ingestor_clone, store_clone));

        // Wait briefly for the server to start accepting.
        std::thread::sleep(std::time::Duration::from_millis(20));

        let event_json = serde_json::json!({
            "type": "event",
            "event": {
                "session_id": "s1",
                "repo_root": "/repo",
                "ts": 1_700_000_000i64,
                "kind": "command",
                "payload": {"command": "cargo test"}
            }
        });
        let resp = send_recv(&path_clone, &event_json.to_string());
        let resp_val: serde_json::Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(resp_val["type"], "ack");
        assert_eq!(resp_val["ok"], true);

        // Shutdown
        let _shutdown_resp = send_recv(&path_clone, r#"{"type":"shutdown"}"#);
        handle.join().unwrap().unwrap();
    }

    // -----------------------------------------------------------------------
    // flush message → ack
    // -----------------------------------------------------------------------

    #[test]
    fn test_flush_message_returns_ack() {
        let (dir, store, ingestor) = setup();
        let socket_path = dir.path().join("flush.sock");
        let ingestor = Arc::new(ingestor);

        let server = IpcServer::bind(&socket_path).unwrap();
        let store_clone = Arc::clone(&store);
        let ingestor_clone = Arc::clone(&ingestor);
        let path_clone = socket_path.clone();
        let _handle = std::thread::spawn(move || server.run(&ingestor_clone, store_clone));

        std::thread::sleep(std::time::Duration::from_millis(20));

        let resp = send_recv(&path_clone, r#"{"type":"flush"}"#);
        let val: serde_json::Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(val["type"], "ack");
        assert_eq!(val["ok"], true);

        send_recv(&path_clone, r#"{"type":"shutdown"}"#);
    }

    // -----------------------------------------------------------------------
    // shutdown message → ack then server exits
    // -----------------------------------------------------------------------

    #[test]
    fn test_shutdown_returns_ack_and_stops_server() {
        let (dir, store, ingestor) = setup();
        let socket_path = dir.path().join("shutdown.sock");
        let ingestor = Arc::new(ingestor);

        let server = IpcServer::bind(&socket_path).unwrap();
        let store_clone = Arc::clone(&store);
        let ingestor_clone = Arc::clone(&ingestor);
        let path_clone = socket_path.clone();
        let handle = std::thread::spawn(move || server.run(&ingestor_clone, store_clone));

        std::thread::sleep(std::time::Duration::from_millis(20));

        let resp = send_recv(&path_clone, r#"{"type":"shutdown"}"#);
        let val: serde_json::Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(val["type"], "ack");
        assert_eq!(val["ok"], true);

        // Server thread should exit cleanly.
        handle.join().unwrap().unwrap();
    }

    // -----------------------------------------------------------------------
    // malformed JSON → error response
    // -----------------------------------------------------------------------

    #[test]
    fn test_malformed_json_returns_error_response() {
        let (dir, store, ingestor) = setup();
        let socket_path = dir.path().join("err.sock");
        let ingestor = Arc::new(ingestor);

        let server = IpcServer::bind(&socket_path).unwrap();
        let store_clone = Arc::clone(&store);
        let ingestor_clone = Arc::clone(&ingestor);
        let path_clone = socket_path.clone();
        let _handle = std::thread::spawn(move || server.run(&ingestor_clone, store_clone));

        std::thread::sleep(std::time::Duration::from_millis(20));

        let resp = send_recv(&path_clone, r#"not valid json"#);
        let val: serde_json::Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(val["type"], "error");
        assert!(val["message"].as_str().unwrap().contains("parse error"),
            "error message should mention parse error: {:?}", val["message"]);

        send_recv(&path_clone, r#"{"type":"shutdown"}"#);
    }

    // -----------------------------------------------------------------------
    // multiple messages on one connection
    // -----------------------------------------------------------------------

    #[test]
    fn test_multiple_messages_on_single_connection() {
        let (dir, store, ingestor) = setup();
        let socket_path = dir.path().join("multi.sock");
        let ingestor = Arc::new(ingestor);

        let server = IpcServer::bind(&socket_path).unwrap();
        let store_clone = Arc::clone(&store);
        let ingestor_clone = Arc::clone(&ingestor);
        let path_clone = socket_path.clone();
        let handle = std::thread::spawn(move || server.run(&ingestor_clone, store_clone));

        std::thread::sleep(std::time::Duration::from_millis(20));

        // Open one connection and send multiple messages.
        let mut stream = UnixStream::connect(&path_clone).unwrap();
        let event = serde_json::json!({
            "type": "event",
            "event": {
                "session_id": "s1", "repo_root": "/repo", "ts": 1i64,
                "kind": "command", "payload": {"command": "cargo build"}
            }
        });

        // Send event + flush on the same connection.
        for msg in &[event.to_string(), r#"{"type":"flush"}"#.to_string()] {
            stream.write_all(msg.as_bytes()).unwrap();
            stream.write_all(b"\n").unwrap();
        }
        stream.flush().unwrap();
        drop(stream); // EOF → server moves to next connection

        std::thread::sleep(std::time::Duration::from_millis(30));

        // Shutdown on a new connection.
        let resp = send_recv(&path_clone, r#"{"type":"shutdown"}"#);
        let val: serde_json::Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(val["type"], "ack");

        handle.join().unwrap().unwrap();
    }

    // -----------------------------------------------------------------------
    // query_signals → signal_summary (gate fail path)
    // -----------------------------------------------------------------------

    #[test]
    fn test_query_signals_returns_signal_summary_gate_failed() {
        let (dir, store, ingestor) = setup();
        let socket_path = dir.path().join("qs.sock");
        let ingestor = Arc::new(ingestor);

        let server = IpcServer::bind(&socket_path).unwrap();
        let store_clone = Arc::clone(&store);
        let ingestor_clone = Arc::clone(&ingestor);
        let path_clone = socket_path.clone();
        let handle = std::thread::spawn(move || server.run(&ingestor_clone, store_clone));

        std::thread::sleep(std::time::Duration::from_millis(20));

        // No events in DB → gate will fail.
        let qs = serde_json::json!({
            "type": "query_signals",
            "repo_root": "/repo",
            "window_days": 30,
            "min_repeat_threshold": 3
        });
        let resp = send_recv(&path_clone, &qs.to_string());
        let val: serde_json::Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(val["type"], "signal_summary");
        assert_eq!(val["gate_passed"], false);

        send_recv(&path_clone, r#"{"type":"shutdown"}"#);
        handle.join().unwrap().unwrap();
    }

    // -----------------------------------------------------------------------
    // ingest event → flush → event visible in DB
    // -----------------------------------------------------------------------

    #[test]
    fn test_ingest_via_ipc_then_flush_persists_to_db() {
        let (dir, store, ingestor) = setup();
        let socket_path = dir.path().join("persist.sock");
        let ingestor = Arc::new(ingestor);

        let server = IpcServer::bind(&socket_path).unwrap();
        let store_clone = Arc::clone(&store);
        let ingestor_clone = Arc::clone(&ingestor);
        let path_clone = socket_path.clone();
        let handle = std::thread::spawn(move || server.run(&ingestor_clone, store_clone));

        std::thread::sleep(std::time::Duration::from_millis(20));

        let event = serde_json::json!({
            "type": "event",
            "event": {
                "session_id": "sess-1", "repo_root": "/my-repo", "ts": 1_700_000_000i64,
                "kind": "command", "payload": {"command": "cargo test"}
            }
        });
        send_recv(&path_clone, &event.to_string());
        // Explicit flush via IPC
        send_recv(&path_clone, r#"{"type":"flush"}"#);

        // Shutdown
        send_recv(&path_clone, r#"{"type":"shutdown"}"#);
        handle.join().unwrap().unwrap();

        // Verify event is in DB.
        let count: i64 = store
            .lock()
            .unwrap()
            .connection()
            .query_row("SELECT COUNT(*) FROM events WHERE repo_root='/my-repo'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "event should be persisted after IPC flush");
    }
}
