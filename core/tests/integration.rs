/// Integration tests for the context-evalver-core daemon.
///
/// test_integration_full_session_event_capture_and_signal_emergence (15.1):
///   Pre-populates the DB with rich historical data (10 sessions, 2 000 events
///   over 10 days), sends 60 events via IPC, and asserts gate_passed=true with
///   a draftable repeated-file candidate.
///
/// test_integration_throttle_suppression_and_reappearance (15.2):
///   Verifies the throttle mechanism: a candidate is suppressed on the second
///   query within 7 days, then reappears after `last_suggested_at` is advanced
///   8 days into the past.
///
/// Requirements covered: 1.1, 2.1, 2.7, 3.4, 4.1, 5.1, 7.4, 7.5, 14.1
use std::io::{BufRead, BufReader, Write as _};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tempfile::TempDir;
use xxhash_rust::xxh3::xxh3_64;

// ---------------------------------------------------------------------------
// Path helpers (mirror daemon logic)
// ---------------------------------------------------------------------------

fn daemon_socket_path(session_id: &str) -> PathBuf {
    let base = dirs_next::data_local_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    base.join("context-evalver").join(format!("{session_id}.sock"))
}

fn daemon_db_path(repo_root: &str) -> PathBuf {
    let hash = xxh3_64(repo_root.as_bytes());
    let hex = format!("{:016x}", hash);
    let base = dirs_next::data_local_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    base.join("context-evalver")
        .join("db")
        .join(format!("{hex}.db"))
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

fn wait_for_path(path: &PathBuf, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------

/// Send a JSONL message on a new connection, read and return the response.
fn send_recv_one(sock_path: &PathBuf, msg: &str) -> serde_json::Value {
    let mut stream = UnixStream::connect(sock_path).expect("connect to daemon socket");
    stream.write_all(msg.as_bytes()).unwrap();
    stream.write_all(b"\n").unwrap();
    stream.flush().unwrap();
    let mut reader = BufReader::new(&stream);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    serde_json::from_str(line.trim()).unwrap_or(serde_json::Value::Null)
}

/// Send many JSONL messages on a single connection; return all response lines.
fn send_batch_recv(sock_path: &PathBuf, messages: &[String]) -> Vec<serde_json::Value> {
    let mut stream = UnixStream::connect(sock_path).expect("connect to daemon socket");
    for msg in messages {
        stream.write_all(msg.as_bytes()).unwrap();
        stream.write_all(b"\n").unwrap();
    }
    stream.flush().unwrap();

    let mut reader = BufReader::new(&stream);
    let mut responses = Vec::new();
    for _ in messages {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let v: serde_json::Value =
            serde_json::from_str(line.trim()).unwrap_or(serde_json::Value::Null);
        responses.push(v);
    }
    responses
}

// ---------------------------------------------------------------------------
// DB schema (mirrors SQLiteStore::create_schema)
// ---------------------------------------------------------------------------

const SCHEMA_SQL: &str = "
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous  = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT    PRIMARY KEY,
        repo_root  TEXT    NOT NULL,
        branch     TEXT,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT    NOT NULL,
        repo_root  TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        kind       TEXT    NOT NULL,
        payload    TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file_access (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_root  TEXT    NOT NULL,
        path       TEXT    NOT NULL,
        session_id TEXT    NOT NULL,
        ts         INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS errors (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_root  TEXT    NOT NULL,
        message    TEXT    NOT NULL,
        session_id TEXT    NOT NULL,
        ts         INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS throttle_records (
        kind              TEXT    NOT NULL,
        target            TEXT    NOT NULL,
        repo_root         TEXT    NOT NULL,
        last_suggested_at INTEGER NOT NULL,
        last_confidence   REAL    NOT NULL,
        PRIMARY KEY (kind, target, repo_root)
    );
    CREATE INDEX IF NOT EXISTS idx_events_repo_ts   ON events      (repo_root, ts);
    CREATE INDEX IF NOT EXISTS idx_fa_repo_path     ON file_access (repo_root, path);
    CREATE INDEX IF NOT EXISTS idx_errors_repo_msg  ON errors      (repo_root, message);
    CREATE INDEX IF NOT EXISTS idx_sessions_repo    ON sessions    (repo_root);
";

// ---------------------------------------------------------------------------
// The integration test
// ---------------------------------------------------------------------------

#[test]
fn test_integration_full_session_event_capture_and_signal_emergence() {
    // -----------------------------------------------------------------------
    // 1. Unique identifiers for this test run
    // -----------------------------------------------------------------------
    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let session_id = format!("inttest-{ts_ms}");

    // Use a temp directory as the "repo root" so we get a unique DB per run.
    let repo_tmp = TempDir::new().unwrap();
    let repo_root = repo_tmp.path().to_str().unwrap().to_string();

    let sock_path = daemon_socket_path(&session_id);
    let db_path = daemon_db_path(&repo_root);

    // Ensure directories exist.
    for path in [&sock_path, &db_path] {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
    }

    // -----------------------------------------------------------------------
    // 2. Pre-populate the DB with rich historical data
    //    (10 sessions, 2 000 command events spread over 10 days)
    //    so that DataFactor ≈ 0.93 and all candidates can reach draftable.
    // -----------------------------------------------------------------------
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();

        for day in 0..10i64 {
            let sess_id = format!("hist-sess-{day}");
            let started_at = now_secs - day * 86_400;

            conn.execute(
                "INSERT OR IGNORE INTO sessions (id, repo_root, branch, started_at)
                 VALUES (?1, ?2, NULL, ?3)",
                rusqlite::params![sess_id, repo_root, started_at],
            )
            .unwrap();

            // 200 command events per historical session
            for j in 0..200i64 {
                let ts = started_at + j * 10;
                conn.execute(
                    "INSERT INTO events (session_id, repo_root, ts, kind, payload)
                     VALUES (?1, ?2, ?3, 'command', '{\"command\":\"cargo build\"}')",
                    rusqlite::params![sess_id, repo_root, ts],
                )
                .unwrap();
            }
        }
    }

    // -----------------------------------------------------------------------
    // 3. Start the daemon subprocess
    // -----------------------------------------------------------------------
    let binary = env!("CARGO_BIN_EXE_context-evalver-core");

    let mut child = std::process::Command::new(binary)
        .args(["--session-id", &session_id, "--repo-root", &repo_root])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("failed to spawn daemon binary");

    // Wait for socket to appear (up to 5 s).
    if !wait_for_path(&sock_path, Duration::from_secs(5)) {
        let _ = child.kill();
        let _ = std::fs::remove_file(&db_path);
        panic!("daemon socket did not appear within 5 seconds at {sock_path:?}");
    }

    // Brief pause so the daemon's IpcServer::bind has fully completed.
    std::thread::sleep(Duration::from_millis(100));

    // -----------------------------------------------------------------------
    // 4. Build 60 IPC event messages:
    //    - 30 file_read events for "src/main.rs" (3 per historical session)
    //    - 30 command events for filler
    // -----------------------------------------------------------------------
    let mut messages: Vec<String> = Vec::with_capacity(60);

    for day in 0..10usize {
        let sess_id = format!("hist-sess-{day}");
        for j in 0..3usize {
            let ts = now_secs + (day * 3 + j) as i64;
            let msg = serde_json::json!({
                "type": "event",
                "event": {
                    "session_id": sess_id,
                    "repo_root": repo_root,
                    "ts": ts,
                    "kind": "file_read",
                    "payload": {"path": "src/main.rs"}
                }
            })
            .to_string();
            messages.push(msg);
        }
    }

    for i in 0..30i64 {
        let msg = serde_json::json!({
            "type": "event",
            "event": {
                "session_id": "hist-sess-0",
                "repo_root": repo_root,
                "ts": now_secs + 200 + i,
                "kind": "command",
                "payload": {"command": "cargo test"}
            }
        })
        .to_string();
        messages.push(msg);
    }

    assert_eq!(messages.len(), 60);

    // -----------------------------------------------------------------------
    // 5. Send all events in one connection; receive all acks.
    // -----------------------------------------------------------------------
    let acks = send_batch_recv(&sock_path, &messages);
    assert_eq!(acks.len(), 60, "expected 60 ack responses for 60 events");
    for (i, ack) in acks.iter().enumerate() {
        assert_eq!(
            ack["type"], "ack",
            "event #{i} should be acked, got {:?}", ack
        );
    }

    // -----------------------------------------------------------------------
    // 6. Flush
    // -----------------------------------------------------------------------
    let flush_ack = send_recv_one(&sock_path, r#"{"type":"flush"}"#);
    assert_eq!(flush_ack["type"], "ack", "flush ack expected: {:?}", flush_ack);
    assert_eq!(flush_ack["ok"], true);

    // -----------------------------------------------------------------------
    // 7. Query signals
    // -----------------------------------------------------------------------
    let query = serde_json::json!({
        "type": "query_signals",
        "repo_root": repo_root,
        "window_days": 30,
        "min_repeat_threshold": 3
    })
    .to_string();

    let summary = send_recv_one(&sock_path, &query);

    // -----------------------------------------------------------------------
    // 8. Assertions on the signal summary
    // -----------------------------------------------------------------------
    assert_eq!(
        summary["gate_passed"], true,
        "gate should pass (S=10, E≈2060, R≥1); summary={:?}", summary
    );

    let files = summary["repeated_files"]
        .as_array()
        .expect("repeated_files must be an array");

    let main_rs_candidate = files.iter().find(|c| {
        c["path"]
            .as_str()
            .map(|p| p.contains("main.rs"))
            .unwrap_or(false)
    });

    assert!(
        main_rs_candidate.is_some(),
        "src/main.rs should appear in repeated_files; files={:?}", files
    );

    let main_rs = main_rs_candidate.unwrap();

    let count = main_rs["count"].as_u64().unwrap_or(0);
    assert!(count >= 30, "access count should be ≥ 30 (sent 30 file_read), got {count}");

    let confidence = main_rs["confidence"].as_f64().unwrap_or(0.0);
    assert!(
        confidence >= 0.65,
        "confidence should be ≥ 0.65, got {confidence}"
    );

    let draftable = main_rs["draftable"].as_bool().unwrap_or(false);
    assert!(
        draftable,
        "candidate should be draftable (conf ≥ 0.80), got confidence={confidence}"
    );

    // -----------------------------------------------------------------------
    // 9. Verify batch was committed to SQLite (query DB directly)
    // -----------------------------------------------------------------------
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();

        // Total events: 2000 pre-inserted + 60 via IPC = 2060
        let event_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM events WHERE repo_root = ?1",
                rusqlite::params![repo_root],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            event_count >= 2060,
            "all events should be committed to SQLite; found {event_count}"
        );

        // 30 file_access rows for src/main.rs (one per file_read event)
        let fa_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM file_access WHERE repo_root = ?1 AND path = 'src/main.rs'",
                rusqlite::params![repo_root],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            fa_count >= 30,
            "30 file_access rows expected for src/main.rs; found {fa_count}"
        );
    }

    // -----------------------------------------------------------------------
    // 10. Shutdown the daemon
    // -----------------------------------------------------------------------
    let _ = send_recv_one(&sock_path, r#"{"type":"shutdown"}"#);

    // Wait for the daemon process to exit (up to 5 s).
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => {
                let _ = child.kill();
                break;
            }
        }
    }

    // -----------------------------------------------------------------------
    // 11. Cleanup artefacts
    // -----------------------------------------------------------------------
    let _ = std::fs::remove_file(&db_path);
    // sock_path is removed by IpcServer::Drop when the daemon exits.
}

// ---------------------------------------------------------------------------
// Integration test 15.2: throttle suppression and reappearance
// ---------------------------------------------------------------------------

#[test]
fn test_integration_throttle_suppression_and_reappearance() {
    // -----------------------------------------------------------------------
    // 1. Unique identifiers for this test run
    // -----------------------------------------------------------------------
    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let session_id = format!("throttle-test-{ts_ms}");

    let repo_tmp = TempDir::new().unwrap();
    let repo_root = repo_tmp.path().to_str().unwrap().to_string();

    let sock_path = daemon_socket_path(&session_id);
    let db_path = daemon_db_path(&repo_root);

    for path in [&sock_path, &db_path] {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
    }

    // -----------------------------------------------------------------------
    // 2. Pre-populate DB: 10 sessions + 2 000 command events + 30 file_access
    //    rows for "src/main.rs" (3 per session × 10 sessions).
    //    This makes data_factor ≈ 0.93 so candidates become draftable.
    // -----------------------------------------------------------------------
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();

        for day in 0..10i64 {
            let sess_id = format!("thr-sess-{day}");
            let started_at = now_secs - day * 86_400;

            conn.execute(
                "INSERT OR IGNORE INTO sessions (id, repo_root, branch, started_at)
                 VALUES (?1, ?2, NULL, ?3)",
                rusqlite::params![sess_id, repo_root, started_at],
            )
            .unwrap();

            // 200 command events per session
            for j in 0..200i64 {
                let ts = started_at + j * 10;
                conn.execute(
                    "INSERT INTO events (session_id, repo_root, ts, kind, payload)
                     VALUES (?1, ?2, ?3, 'command', '{\"command\":\"cargo build\"}')",
                    rusqlite::params![sess_id, repo_root, ts],
                )
                .unwrap();
            }

            // 3 file_access rows for "src/main.rs" per session
            for k in 0..3i64 {
                let ts = started_at + 2_000 + k;
                conn.execute(
                    "INSERT INTO file_access (repo_root, path, session_id, ts)
                     VALUES (?1, 'src/main.rs', ?2, ?3)",
                    rusqlite::params![repo_root, sess_id, ts],
                )
                .unwrap();
            }
        }
    }

    // -----------------------------------------------------------------------
    // 3. Start the daemon subprocess
    // -----------------------------------------------------------------------
    let binary = env!("CARGO_BIN_EXE_context-evalver-core");

    let mut child = std::process::Command::new(binary)
        .args(["--session-id", &session_id, "--repo-root", &repo_root])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("failed to spawn daemon binary");

    if !wait_for_path(&sock_path, Duration::from_secs(5)) {
        let _ = child.kill();
        let _ = std::fs::remove_file(&db_path);
        panic!("daemon socket did not appear within 5 seconds at {sock_path:?}");
    }
    std::thread::sleep(Duration::from_millis(100));

    // -----------------------------------------------------------------------
    // 4. Build the query_signals message
    // -----------------------------------------------------------------------
    let query = serde_json::json!({
        "type": "query_signals",
        "repo_root": repo_root,
        "window_days": 30,
        "min_repeat_threshold": 3
    })
    .to_string();

    // -----------------------------------------------------------------------
    // 5. First query — candidate must appear (throttle record is upserted)
    // -----------------------------------------------------------------------
    let summary1 = send_recv_one(&sock_path, &query);

    assert_eq!(
        summary1["gate_passed"], true,
        "gate should pass on first query; summary={:?}", summary1
    );

    let files1 = summary1["repeated_files"]
        .as_array()
        .expect("repeated_files must be an array");

    let found1 = files1.iter().any(|c| {
        c["path"].as_str().map(|p| p.contains("main.rs")).unwrap_or(false)
    });
    assert!(
        found1,
        "src/main.rs should appear in repeated_files on first query; files={:?}", files1
    );

    // -----------------------------------------------------------------------
    // 6. Second query (immediate) — same candidate must be suppressed
    //    (within 7 days, no confidence improvement)
    // -----------------------------------------------------------------------
    let summary2 = send_recv_one(&sock_path, &query);

    assert_eq!(
        summary2["gate_passed"], true,
        "gate should still pass on second query; summary={:?}", summary2
    );

    let files2 = summary2["repeated_files"]
        .as_array()
        .expect("repeated_files must be an array");

    let found2 = files2.iter().any(|c| {
        c["path"].as_str().map(|p| p.contains("main.rs")).unwrap_or(false)
    });
    assert!(
        !found2,
        "src/main.rs should be suppressed on second query (within 7 days); files={:?}", files2
    );

    // -----------------------------------------------------------------------
    // 7. Advance last_suggested_at by 8 days into the past (direct DB write)
    //    This simulates the throttle window expiring.
    // -----------------------------------------------------------------------
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "UPDATE throttle_records
             SET last_suggested_at = ?1
             WHERE repo_root = ?2 AND kind = 'claude_md' AND target = 'src/main.rs'",
            rusqlite::params![now_secs - 8 * 86_400, repo_root],
        )
        .unwrap();
    }

    // -----------------------------------------------------------------------
    // 8. Third query — candidate must reappear (throttle window expired)
    // -----------------------------------------------------------------------
    let summary3 = send_recv_one(&sock_path, &query);

    assert_eq!(
        summary3["gate_passed"], true,
        "gate should pass on third query; summary={:?}", summary3
    );

    let files3 = summary3["repeated_files"]
        .as_array()
        .expect("repeated_files must be an array");

    let found3 = files3.iter().any(|c| {
        c["path"].as_str().map(|p| p.contains("main.rs")).unwrap_or(false)
    });
    assert!(
        found3,
        "src/main.rs should reappear after throttle window expires (8 days); files={:?}", files3
    );

    // -----------------------------------------------------------------------
    // 9. Shutdown
    // -----------------------------------------------------------------------
    let _ = send_recv_one(&sock_path, r#"{"type":"shutdown"}"#);

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => {
                let _ = child.kill();
                break;
            }
        }
    }

    // -----------------------------------------------------------------------
    // 10. Cleanup
    // -----------------------------------------------------------------------
    let _ = std::fs::remove_file(&db_path);
}
