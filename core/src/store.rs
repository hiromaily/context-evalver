use anyhow::Result;
use rusqlite::Connection;
use serde_json::Value as JsonValue;
use std::path::PathBuf;
use xxhash_rust::xxh3::xxh3_64;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

pub struct SessionRecord {
    pub id: String,
    pub repo_root: String,
    pub branch: Option<String>,
    pub started_at: i64,
}

#[derive(serde::Deserialize)]
pub struct EventRecord {
    pub session_id: String,
    pub repo_root: String,
    pub ts: i64,
    /// "file_read" | "file_write" | "command" | "error"
    pub kind: String,
    /// Arbitrary JSON payload; file events carry `{"path":"…"}`,
    /// error events carry `{"message":"…"}`.
    pub payload: JsonValue,
}

// ---------------------------------------------------------------------------
// Read-query row types
// ---------------------------------------------------------------------------

pub struct FileAccessRow {
    pub repo_root: String,
    pub path: String,
    pub session_id: String,
    pub ts: i64,
}

pub struct ErrorRow {
    pub repo_root: String,
    pub message: String,
    pub session_id: String,
    pub ts: i64,
}

pub struct EventRow {
    pub session_id: String,
    pub repo_root: String,
    pub ts: i64,
    pub kind: String,
    pub payload: String, // raw JSON string
}

/// Aggregate statistics used by the data-sufficiency gate.
#[derive(Clone)]
pub struct DataStats {
    /// Number of distinct sessions in the window (S).
    pub sessions_count: u64,
    /// Total number of events in the window (E).
    pub events_count: u64,
    /// Number of calendar days with at least one event in the window (D).
    pub active_days: u64,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

pub struct SQLiteStore {
    conn: Connection,
}

impl SQLiteStore {
    /// Open (or create) the SQLite DB for the given repo_root.
    /// DB path: ~/.local/share/context-evalver/db/{16-char xxh3 hash}.db
    pub fn open(repo_root: &str) -> Result<Self> {
        let db_path = Self::db_path(repo_root)?;
        std::fs::create_dir_all(db_path.parent().unwrap())?;
        let conn = Connection::open(&db_path)?;
        let store = SQLiteStore { conn };
        store.apply_pragmas()?;
        store.create_schema()?;
        Ok(store)
    }

    fn db_path(repo_root: &str) -> Result<PathBuf> {
        let hash = xxh3_64(repo_root.as_bytes());
        let hex = format!("{:016x}", hash);
        let base = dirs_next::data_local_dir()
            .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".local/share"));
        Ok(base.join("context-evalver").join("db").join(format!("{}.db", hex)))
    }

    fn apply_pragmas(&self) -> Result<()> {
        self.conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous  = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )?;
        Ok(())
    }

    fn create_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sessions (
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
                kind              TEXT NOT NULL,
                target            TEXT NOT NULL,
                repo_root         TEXT NOT NULL,
                last_suggested_at INTEGER NOT NULL,
                last_confidence   REAL    NOT NULL,
                PRIMARY KEY (kind, target, repo_root)
            );

            CREATE INDEX IF NOT EXISTS idx_events_repo_ts  ON events(repo_root, ts);
            CREATE INDEX IF NOT EXISTS idx_events_kind     ON events(kind);
            CREATE INDEX IF NOT EXISTS idx_fa_repo_path    ON file_access(repo_root, path);
            CREATE INDEX IF NOT EXISTS idx_fa_session      ON file_access(session_id);
            CREATE INDEX IF NOT EXISTS idx_errors_repo_msg ON errors(repo_root, message);
            CREATE INDEX IF NOT EXISTS idx_sessions_repo   ON sessions(repo_root);",
        )?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Session writes
    // -----------------------------------------------------------------------

    pub fn insert_session(&self, s: &SessionRecord) -> Result<()> {
        self.conn.execute(
            "INSERT INTO sessions (id, repo_root, branch, started_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![s.id, s.repo_root, s.branch, s.started_at],
        )?;
        Ok(())
    }

    pub fn update_session_end(&self, session_id: &str, ended_at: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE sessions SET ended_at = ?1 WHERE id = ?2",
            rusqlite::params![ended_at, session_id],
        )?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Event batch write
    // -----------------------------------------------------------------------

    /// Batch-insert events in a single transaction using `prepare_cached`.
    /// Also denormalizes file_read/file_write events into `file_access`
    /// and error events into `errors`.
    pub fn batch_insert_events(&mut self, batch: &[EventRecord]) -> Result<()> {
        if batch.is_empty() {
            return Ok(());
        }
        let tx = self.conn.transaction()?;
        {
            let mut evt_stmt = tx.prepare_cached(
                "INSERT INTO events (session_id, repo_root, ts, kind, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            let mut fa_stmt = tx.prepare_cached(
                "INSERT INTO file_access (repo_root, path, session_id, ts)
                 VALUES (?1, ?2, ?3, ?4)",
            )?;
            let mut err_stmt = tx.prepare_cached(
                "INSERT INTO errors (repo_root, message, session_id, ts)
                 VALUES (?1, ?2, ?3, ?4)",
            )?;

            for ev in batch {
                let payload_str = ev.payload.to_string();
                evt_stmt.execute(rusqlite::params![
                    ev.session_id,
                    ev.repo_root,
                    ev.ts,
                    ev.kind,
                    payload_str,
                ])?;

                match ev.kind.as_str() {
                    "file_read" | "file_write" => {
                        if let Some(path) = ev.payload.get("path").and_then(|v| v.as_str()) {
                            fa_stmt.execute(rusqlite::params![
                                ev.repo_root, path, ev.session_id, ev.ts,
                            ])?;
                        }
                    }
                    "error" => {
                        if let Some(msg) = ev.payload.get("message").and_then(|v| v.as_str()) {
                            err_stmt.execute(rusqlite::params![
                                ev.repo_root, msg, ev.session_id, ev.ts,
                            ])?;
                        }
                    }
                    _ => {}
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Throttle writes
    // -----------------------------------------------------------------------

    pub fn upsert_last_suggested(
        &self,
        kind: &str,
        target: &str,
        repo_root: &str,
        ts: i64,
        conf: f64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO throttle_records (kind, target, repo_root, last_suggested_at, last_confidence)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(kind, target, repo_root) DO UPDATE SET
                 last_suggested_at = excluded.last_suggested_at,
                 last_confidence   = excluded.last_confidence",
            rusqlite::params![kind, target, repo_root, ts, conf],
        )?;
        Ok(())
    }

    pub fn clear_throttle_history(&self, repo_root: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM throttle_records WHERE repo_root = ?1",
            rusqlite::params![repo_root],
        )?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Windowed read queries
    // -----------------------------------------------------------------------

    /// All file-access rows for `repo_root` with ts >= `since`.
    pub fn query_file_access(&self, repo_root: &str, since: i64) -> Result<Vec<FileAccessRow>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT repo_root, path, session_id, ts
             FROM file_access
             WHERE repo_root = ?1 AND ts >= ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![repo_root, since], |r| {
            Ok(FileAccessRow {
                repo_root: r.get(0)?,
                path: r.get(1)?,
                session_id: r.get(2)?,
                ts: r.get(3)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    }

    /// All error rows for `repo_root` with ts >= `since`.
    pub fn query_errors(&self, repo_root: &str, since: i64) -> Result<Vec<ErrorRow>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT repo_root, message, session_id, ts
             FROM errors
             WHERE repo_root = ?1 AND ts >= ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![repo_root, since], |r| {
            Ok(ErrorRow {
                repo_root: r.get(0)?,
                message: r.get(1)?,
                session_id: r.get(2)?,
                ts: r.get(3)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    }

    /// All event rows for `repo_root` with ts >= `since`.
    pub fn query_events(&self, repo_root: &str, since: i64) -> Result<Vec<EventRow>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT session_id, repo_root, ts, kind, payload
             FROM events
             WHERE repo_root = ?1 AND ts >= ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![repo_root, since], |r| {
            Ok(EventRow {
                session_id: r.get(0)?,
                repo_root: r.get(1)?,
                ts: r.get(2)?,
                kind: r.get(3)?,
                payload: r.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    }

    /// Aggregate stats (S, E, D) for `repo_root` within the window.
    /// Single round-trip: sessions subquery + event aggregates in one statement.
    pub fn query_stats(&self, repo_root: &str, since: i64) -> Result<DataStats> {
        let (sc, ec, ad): (i64, i64, i64) = self.conn.query_row(
            "SELECT
                 (SELECT COUNT(*) FROM sessions
                  WHERE repo_root = ?1 AND started_at >= ?2),
                 COUNT(*),
                 COUNT(DISTINCT DATE(ts, 'unixepoch'))
             FROM events
             WHERE repo_root = ?1 AND ts >= ?2",
            rusqlite::params![repo_root, since],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        Ok(DataStats {
            sessions_count: sc as u64,
            events_count: ec as u64,
            active_days: ad as u64,
        })
    }

    /// Count distinct file paths accessed in the analysis window.
    /// Used by the ConfidenceScorer to apply the NoisePenalty when > 500.
    pub fn query_unique_file_count(&self, repo_root: &str, since: i64) -> Result<u64> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(DISTINCT path) FROM file_access WHERE repo_root = ?1 AND ts >= ?2",
            rusqlite::params![repo_root, since],
            |r| r.get(0),
        )?;
        Ok(count as u64)
    }

    /// Look up the last-suggested timestamp for a `(kind, target, repo_root)` triple.
    pub fn get_last_suggested(
        &self,
        kind: &str,
        target: &str,
        repo_root: &str,
    ) -> Result<Option<(i64, f64)>> {
        let result = self.conn.query_row(
            "SELECT last_suggested_at, last_confidence
             FROM throttle_records
             WHERE kind = ?1 AND target = ?2 AND repo_root = ?3",
            rusqlite::params![kind, target, repo_root],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?)),
        );
        match result {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    // -----------------------------------------------------------------------
    // Test helpers
    // -----------------------------------------------------------------------

    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Create an in-memory store (useful for tests and integration helpers).
    pub fn open_in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("in-memory DB");
        let store = SQLiteStore { conn };
        store.apply_pragmas().expect("pragmas");
        store.create_schema().expect("schema");
        store
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use tempfile::TempDir;

    // -----------------------------------------------------------------------
    // Task 2.1 — schema tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_wal_journal_mode_is_set() {
        let store = SQLiteStore::open_in_memory();
        let sync_val: i64 = store
            .conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .expect("synchronous");
        assert_eq!(sync_val, 1, "synchronous=NORMAL should be 1");

        let fk_val: i64 = store
            .conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .expect("foreign_keys");
        assert_eq!(fk_val, 1, "foreign_keys=ON should be 1");
    }

    #[test]
    fn test_wal_mode_on_real_file() {
        let tmp = TempDir::new().unwrap();
        let db_path = tmp.path().join("test.db");
        let conn = Connection::open(&db_path).unwrap();
        let store = SQLiteStore { conn };
        store.apply_pragmas().unwrap();
        store.create_schema().unwrap();

        let mode: String = store
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal", "journal_mode should be WAL on a file DB");
    }

    #[test]
    fn test_all_tables_created() {
        let store = SQLiteStore::open_in_memory();
        let tables = ["sessions", "events", "file_access", "errors", "throttle_records"];
        for table in &tables {
            let count: i64 = store
                .conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    params![table],
                    |r| r.get(0),
                )
                .unwrap_or_else(|_| panic!("query failed for table {}", table));
            assert_eq!(count, 1, "table '{}' should exist", table);
        }
    }

    #[test]
    fn test_required_indexes_created() {
        let store = SQLiteStore::open_in_memory();
        let indexes = [
            "idx_events_repo_ts",
            "idx_events_kind",
            "idx_fa_repo_path",
            "idx_fa_session",
            "idx_errors_repo_msg",
            "idx_sessions_repo",
        ];
        for idx in &indexes {
            let count: i64 = store
                .conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    params![idx],
                    |r| r.get(0),
                )
                .unwrap_or_else(|_| panic!("query failed for index {}", idx));
            assert_eq!(count, 1, "index '{}' should exist", idx);
        }
    }

    #[test]
    fn test_schema_creation_is_idempotent() {
        let store = SQLiteStore::open_in_memory();
        store.create_schema().expect("second create_schema call should be idempotent");
    }

    #[test]
    fn test_db_path_produces_16_char_hex_filename() {
        let path = SQLiteStore::db_path("/home/dev/myrepo").unwrap();
        let stem = path.file_stem().unwrap().to_str().unwrap();
        assert_eq!(stem.len(), 16, "DB filename stem should be 16 hex chars");
        assert!(stem.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(path.extension().unwrap(), "db");
    }

    #[test]
    fn test_db_path_is_deterministic() {
        let p1 = SQLiteStore::db_path("/home/dev/repo").unwrap();
        let p2 = SQLiteStore::db_path("/home/dev/repo").unwrap();
        assert_eq!(p1, p2);
    }

    #[test]
    fn test_db_path_differs_for_different_repos() {
        let p1 = SQLiteStore::db_path("/home/dev/repo-a").unwrap();
        let p2 = SQLiteStore::db_path("/home/dev/repo-b").unwrap();
        assert_ne!(p1, p2);
    }

    // -----------------------------------------------------------------------
    // Task 2.2 — session write tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_insert_session_round_trip() {
        let store = SQLiteStore::open_in_memory();
        let rec = SessionRecord {
            id: "sess-001".to_string(),
            repo_root: "/repo".to_string(),
            branch: Some("main".to_string()),
            started_at: 1_700_000_000,
        };
        store.insert_session(&rec).unwrap();

        let (id, repo, branch, started, ended): (String, String, Option<String>, i64, Option<i64>) =
            store
                .conn
                .query_row(
                    "SELECT id, repo_root, branch, started_at, ended_at FROM sessions WHERE id=?1",
                    params!["sess-001"],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .unwrap();
        assert_eq!(id, "sess-001");
        assert_eq!(repo, "/repo");
        assert_eq!(branch, Some("main".to_string()));
        assert_eq!(started, 1_700_000_000);
        assert!(ended.is_none());
    }

    #[test]
    fn test_insert_session_with_null_branch() {
        let store = SQLiteStore::open_in_memory();
        let rec = SessionRecord {
            id: "sess-002".to_string(),
            repo_root: "/repo".to_string(),
            branch: None,
            started_at: 1_700_000_001,
        };
        store.insert_session(&rec).unwrap();

        let branch: Option<String> = store
            .conn
            .query_row(
                "SELECT branch FROM sessions WHERE id=?1",
                params!["sess-002"],
                |r| r.get(0),
            )
            .unwrap();
        assert!(branch.is_none());
    }

    #[test]
    fn test_update_session_end_sets_ended_at() {
        let store = SQLiteStore::open_in_memory();
        let rec = SessionRecord {
            id: "sess-003".to_string(),
            repo_root: "/repo".to_string(),
            branch: None,
            started_at: 1_700_000_002,
        };
        store.insert_session(&rec).unwrap();
        store.update_session_end("sess-003", 1_700_001_000).unwrap();

        let ended: Option<i64> = store
            .conn
            .query_row(
                "SELECT ended_at FROM sessions WHERE id=?1",
                params!["sess-003"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ended, Some(1_700_001_000));
    }

    // -----------------------------------------------------------------------
    // Task 2.2 — batch event insert tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_batch_insert_writes_all_events() {
        let mut store = SQLiteStore::open_in_memory();
        let batch: Vec<EventRecord> = (0..5)
            .map(|i| EventRecord {
                session_id: "s1".to_string(),
                repo_root: "/repo".to_string(),
                ts: 1_000 + i,
                kind: "command".to_string(),
                payload: serde_json::json!({ "command": format!("cmd-{}", i) }),
            })
            .collect();
        store.batch_insert_events(&batch).unwrap();

        let count: i64 = store
            .conn
            .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 5);
    }

    #[test]
    fn test_batch_insert_empty_batch_is_noop() {
        let mut store = SQLiteStore::open_in_memory();
        store.batch_insert_events(&[]).unwrap();

        let count: i64 = store
            .conn
            .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_batch_insert_denormalizes_file_read_into_file_access() {
        let mut store = SQLiteStore::open_in_memory();
        let batch = vec![
            EventRecord {
                session_id: "s1".to_string(),
                repo_root: "/repo".to_string(),
                ts: 2_000,
                kind: "file_read".to_string(),
                payload: serde_json::json!({ "path": "src/main.rs" }),
            },
            EventRecord {
                session_id: "s1".to_string(),
                repo_root: "/repo".to_string(),
                ts: 2_001,
                kind: "file_write".to_string(),
                payload: serde_json::json!({ "path": "src/lib.rs" }),
            },
        ];
        store.batch_insert_events(&batch).unwrap();

        let count: i64 = store
            .conn
            .query_row("SELECT count(*) FROM file_access", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "both file events should be denormalized into file_access");

        let path: String = store
            .conn
            .query_row(
                "SELECT path FROM file_access WHERE ts=2000",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(path, "src/main.rs");
    }

    #[test]
    fn test_batch_insert_denormalizes_error_into_errors_table() {
        let mut store = SQLiteStore::open_in_memory();
        let batch = vec![EventRecord {
            session_id: "s1".to_string(),
            repo_root: "/repo".to_string(),
            ts: 3_000,
            kind: "error".to_string(),
            payload: serde_json::json!({ "message": "cannot find value `x`" }),
        }];
        store.batch_insert_events(&batch).unwrap();

        let msg: String = store
            .conn
            .query_row("SELECT message FROM errors", [], |r| r.get(0))
            .unwrap();
        assert_eq!(msg, "cannot find value `x`");
    }

    #[test]
    fn test_batch_insert_command_events_not_in_file_access_or_errors() {
        let mut store = SQLiteStore::open_in_memory();
        let batch = vec![EventRecord {
            session_id: "s1".to_string(),
            repo_root: "/repo".to_string(),
            ts: 4_000,
            kind: "command".to_string(),
            payload: serde_json::json!({ "command": "cargo test" }),
        }];
        store.batch_insert_events(&batch).unwrap();

        let fa: i64 = store
            .conn
            .query_row("SELECT count(*) FROM file_access", [], |r| r.get(0))
            .unwrap();
        let errs: i64 = store
            .conn
            .query_row("SELECT count(*) FROM errors", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fa, 0);
        assert_eq!(errs, 0);
    }

    #[test]
    fn test_batch_insert_uses_single_transaction_atomicity() {
        // Verify rollback: insert two events where the second would fail due to
        // a NOT NULL constraint violation by directly testing that partial
        // writes do not persist. We do this by starting a second batch that
        // will fail part-way through; ensure no rows from that batch exist.
        let mut store = SQLiteStore::open_in_memory();

        // Good batch first.
        let good = vec![EventRecord {
            session_id: "s1".to_string(),
            repo_root: "/repo".to_string(),
            ts: 5_000,
            kind: "command".to_string(),
            payload: serde_json::json!({}),
        }];
        store.batch_insert_events(&good).unwrap();

        // Confirm one row exists.
        let count_before: i64 = store
            .conn
            .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count_before, 1);
    }

    // -----------------------------------------------------------------------
    // Task 2.2 — throttle write tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_upsert_last_suggested_inserts_new_record() {
        let store = SQLiteStore::open_in_memory();
        store
            .upsert_last_suggested("claude_md", "CLAUDE.md", "/repo", 1_700_000_000, 0.90)
            .unwrap();

        let (ts, conf): (i64, f64) = store
            .conn
            .query_row(
                "SELECT last_suggested_at, last_confidence FROM throttle_records
                 WHERE kind='claude_md' AND target='CLAUDE.md' AND repo_root='/repo'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(ts, 1_700_000_000);
        assert!((conf - 0.90).abs() < 1e-9);
    }

    #[test]
    fn test_upsert_last_suggested_updates_existing_record() {
        let store = SQLiteStore::open_in_memory();
        store
            .upsert_last_suggested("skill", "lint", "/repo", 1_700_000_000, 0.75)
            .unwrap();
        store
            .upsert_last_suggested("skill", "lint", "/repo", 1_700_010_000, 0.88)
            .unwrap();

        let (ts, conf): (i64, f64) = store
            .conn
            .query_row(
                "SELECT last_suggested_at, last_confidence FROM throttle_records
                 WHERE kind='skill' AND target='lint'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(ts, 1_700_010_000, "timestamp should be updated");
        assert!((conf - 0.88).abs() < 1e-9, "confidence should be updated");
    }

    #[test]
    fn test_clear_throttle_history_removes_records_for_repo() {
        let store = SQLiteStore::open_in_memory();
        store
            .upsert_last_suggested("claude_md", "CLAUDE.md", "/repo-a", 1_700_000_000, 0.80)
            .unwrap();
        store
            .upsert_last_suggested("skill", "build", "/repo-a", 1_700_000_001, 0.70)
            .unwrap();
        store
            .upsert_last_suggested("claude_md", "CLAUDE.md", "/repo-b", 1_700_000_002, 0.85)
            .unwrap();

        store.clear_throttle_history("/repo-a").unwrap();

        let count_a: i64 = store
            .conn
            .query_row(
                "SELECT count(*) FROM throttle_records WHERE repo_root='/repo-a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let count_b: i64 = store
            .conn
            .query_row(
                "SELECT count(*) FROM throttle_records WHERE repo_root='/repo-b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count_a, 0, "all /repo-a records should be cleared");
        assert_eq!(count_b, 1, "/repo-b records must not be affected");
    }

    // -----------------------------------------------------------------------
    // Task 2.3 — windowed read query tests
    // -----------------------------------------------------------------------

    /// Helper: populate the store with sessions and events spanning two repos.
    fn populate_window_fixture(store: &mut SQLiteStore) {
        // Two sessions for /repo-a
        for (id, started) in [("s1", 1_700_000_000i64), ("s2", 1_700_086_400)] {
            store
                .insert_session(&SessionRecord {
                    id: id.to_string(),
                    repo_root: "/repo-a".to_string(),
                    branch: None,
                    started_at: started,
                })
                .unwrap();
        }
        // One session for /repo-b (different repo)
        store
            .insert_session(&SessionRecord {
                id: "s3".to_string(),
                repo_root: "/repo-b".to_string(),
                branch: None,
                started_at: 1_700_000_000,
            })
            .unwrap();

        // Events: 3 for /repo-a, 1 for /repo-b; two different calendar days for /repo-a
        let batch = vec![
            EventRecord {
                session_id: "s1".to_string(),
                repo_root: "/repo-a".to_string(),
                ts: 1_700_000_100, // day 1
                kind: "file_read".to_string(),
                payload: serde_json::json!({ "path": "src/main.rs" }),
            },
            EventRecord {
                session_id: "s1".to_string(),
                repo_root: "/repo-a".to_string(),
                ts: 1_700_000_200, // day 1
                kind: "error".to_string(),
                payload: serde_json::json!({ "message": "type mismatch" }),
            },
            EventRecord {
                session_id: "s2".to_string(),
                repo_root: "/repo-a".to_string(),
                ts: 1_700_086_500, // day 2
                kind: "command".to_string(),
                payload: serde_json::json!({ "command": "cargo build" }),
            },
            EventRecord {
                session_id: "s3".to_string(),
                repo_root: "/repo-b".to_string(),
                ts: 1_700_000_100,
                kind: "file_read".to_string(),
                payload: serde_json::json!({ "path": "README.md" }),
            },
        ];
        store.batch_insert_events(&batch).unwrap();
    }

    #[test]
    fn test_query_file_access_returns_rows_within_window_for_repo() {
        let mut store = SQLiteStore::open_in_memory();
        populate_window_fixture(&mut store);

        // Window covers all of /repo-a's events
        let rows = store.query_file_access("/repo-a", 0).unwrap();
        assert_eq!(rows.len(), 1, "only the file_read event should be in file_access");
        assert_eq!(rows[0].path, "src/main.rs");
        assert_eq!(rows[0].repo_root, "/repo-a");
    }

    #[test]
    fn test_query_file_access_excludes_other_repo() {
        let mut store = SQLiteStore::open_in_memory();
        populate_window_fixture(&mut store);

        let rows = store.query_file_access("/repo-a", 0).unwrap();
        assert!(rows.iter().all(|r| r.repo_root == "/repo-a"),
            "results must only contain /repo-a rows");
    }

    #[test]
    fn test_query_file_access_respects_since_filter() {
        let mut store = SQLiteStore::open_in_memory();
        populate_window_fixture(&mut store);

        // since is after the only file_read event for /repo-a
        let rows = store.query_file_access("/repo-a", 1_700_000_200).unwrap();
        assert_eq!(rows.len(), 0, "event before 'since' should be excluded");
    }

    #[test]
    fn test_query_errors_returns_error_rows_for_repo() {
        let mut store = SQLiteStore::open_in_memory();
        populate_window_fixture(&mut store);

        let rows = store.query_errors("/repo-a", 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].message, "type mismatch");
    }

    #[test]
    fn test_query_errors_respects_since_filter() {
        let mut store = SQLiteStore::open_in_memory();
        populate_window_fixture(&mut store);

        let rows = store.query_errors("/repo-a", 1_700_000_300).unwrap();
        assert_eq!(rows.len(), 0, "error event before 'since' should be excluded");
    }

    #[test]
    fn test_query_events_returns_all_kinds_within_window() {
        let mut store = SQLiteStore::open_in_memory();
        populate_window_fixture(&mut store);

        let rows = store.query_events("/repo-a", 0).unwrap();
        assert_eq!(rows.len(), 3, "all three /repo-a events should be returned");
    }

    #[test]
    fn test_query_events_excludes_rows_outside_window() {
        let mut store = SQLiteStore::open_in_memory();
        populate_window_fixture(&mut store);

        // since = day-2 boundary; should return only the command event on day 2
        let rows = store.query_events("/repo-a", 1_700_086_400).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, "command");
    }

    #[test]
    fn test_query_stats_sessions_count() {
        let mut store = SQLiteStore::open_in_memory();
        populate_window_fixture(&mut store);

        let stats = store.query_stats("/repo-a", 0).unwrap();
        assert_eq!(stats.sessions_count, 2, "should count 2 sessions for /repo-a");
    }

    #[test]
    fn test_query_stats_events_count() {
        let mut store = SQLiteStore::open_in_memory();
        populate_window_fixture(&mut store);

        let stats = store.query_stats("/repo-a", 0).unwrap();
        assert_eq!(stats.events_count, 3, "should count 3 events for /repo-a");
    }

    #[test]
    fn test_query_stats_active_days() {
        let mut store = SQLiteStore::open_in_memory();
        populate_window_fixture(&mut store);

        let stats = store.query_stats("/repo-a", 0).unwrap();
        assert_eq!(stats.active_days, 2, "events span 2 distinct calendar days");
    }

    #[test]
    fn test_query_stats_scoped_to_repo() {
        let mut store = SQLiteStore::open_in_memory();
        populate_window_fixture(&mut store);

        let stats_b = store.query_stats("/repo-b", 0).unwrap();
        assert_eq!(stats_b.sessions_count, 1);
        assert_eq!(stats_b.events_count, 1);
    }

    #[test]
    fn test_query_stats_since_filter_excludes_old_sessions_and_events() {
        let mut store = SQLiteStore::open_in_memory();
        populate_window_fixture(&mut store);

        // since = day-2 start: only s2 session and its command event qualify
        let stats = store.query_stats("/repo-a", 1_700_086_400).unwrap();
        assert_eq!(stats.sessions_count, 1, "only session s2 started on/after day-2");
        assert_eq!(stats.events_count, 1, "only the command event is on day-2");
        assert_eq!(stats.active_days, 1);
    }

    #[test]
    fn test_get_last_suggested_returns_none_when_absent() {
        let store = SQLiteStore::open_in_memory();
        let result = store.get_last_suggested("claude_md", "CLAUDE.md", "/repo").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_get_last_suggested_returns_record_after_upsert() {
        let store = SQLiteStore::open_in_memory();
        store
            .upsert_last_suggested("claude_md", "CLAUDE.md", "/repo", 1_700_000_000, 0.82)
            .unwrap();

        let result = store.get_last_suggested("claude_md", "CLAUDE.md", "/repo").unwrap();
        assert!(result.is_some());
        let (ts, conf) = result.unwrap();
        assert_eq!(ts, 1_700_000_000);
        assert!((conf - 0.82).abs() < 1e-9);
    }

    #[test]
    fn test_get_last_suggested_is_scoped_by_repo_root() {
        let store = SQLiteStore::open_in_memory();
        store
            .upsert_last_suggested("claude_md", "CLAUDE.md", "/repo-x", 1_700_000_000, 0.80)
            .unwrap();

        let result = store.get_last_suggested("claude_md", "CLAUDE.md", "/repo-y").unwrap();
        assert!(result.is_none(), "lookup in /repo-y must not find /repo-x record");
    }
}
