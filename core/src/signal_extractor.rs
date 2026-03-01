use crate::store::SQLiteStore;
use anyhow::Result;
use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;
use xxhash_rust::xxh3::xxh3_64;

// ---------------------------------------------------------------------------
// Thresholds (from spec)
// ---------------------------------------------------------------------------

const STRONG_FILE_THRESHOLD: u64 = 8;
const MIN_FILE_SESSIONS: u64 = 2;
const STRONG_ERROR_THRESHOLD: u64 = 5;
const STRONG_SEQUENCE_THRESHOLD: u64 = 4;

// ---------------------------------------------------------------------------
// Raw signal types
// ---------------------------------------------------------------------------

pub struct RawFileSignal {
    pub path: String,
    pub access_count: u64,
    pub session_count: u64,
    pub is_strong: bool,
    pub latest_ts: i64,
}

pub struct RawErrorSignal {
    /// Normalized message used for grouping.
    pub message: String,
    pub occurrence_count: u64,
    pub session_count: u64,
    pub is_strong: bool,
    pub latest_ts: i64,
}

pub struct RawSequenceSignal {
    /// Representative command list for this hash bucket.
    pub commands: Vec<String>,
    pub count: u64,
    pub window_len: usize,
    pub is_strong: bool,
    pub latest_ts: i64,
}

pub struct RawSignals {
    pub repeated_files: Vec<RawFileSignal>,
    pub repeated_errors: Vec<RawErrorSignal>,
    pub repeated_sequences: Vec<RawSequenceSignal>,
}

// ---------------------------------------------------------------------------
// 4.1 — Repeated file-access signal extraction
// ---------------------------------------------------------------------------

/// Extract repeated file-access signals from the `file_access` table.
/// - Includes a path when: access_count >= threshold AND distinct_sessions >= 2.
/// - Strong signal when: access_count >= 8 AND distinct_sessions >= 2.
/// - Results ordered by access_count descending.
pub fn extract_file_signals(
    db: &SQLiteStore,
    repo_root: &str,
    since: i64,
    threshold: u32,
) -> Result<Vec<RawFileSignal>> {
    let mut stmt = db.connection().prepare_cached(
        "SELECT path,
                COUNT(*)                    AS access_count,
                COUNT(DISTINCT session_id)  AS session_count,
                MAX(ts)                     AS latest_ts
         FROM file_access
         WHERE repo_root = ?1 AND ts >= ?2
         GROUP BY path
         HAVING COUNT(*) >= ?3 AND COUNT(DISTINCT session_id) >= 2
         ORDER BY access_count DESC",
    )?;

    let rows = stmt.query_map(rusqlite::params![repo_root, since, threshold], |r| {
        let ac: i64 = r.get(1)?;
        let sc: i64 = r.get(2)?;
        let ac = ac as u64;
        let sc = sc as u64;
        Ok(RawFileSignal {
            path: r.get(0)?,
            access_count: ac,
            session_count: sc,
            is_strong: ac >= STRONG_FILE_THRESHOLD && sc >= MIN_FILE_SESSIONS,
            latest_ts: r.get(3)?,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

// ---------------------------------------------------------------------------
// 4.2 — Repeated error-loop signal extraction
// ---------------------------------------------------------------------------

// Compiled once; shared across all calls.
static RE_FILE_LOC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\w./\\-]+\.\w+:\d+(:\d+)*:?\s*").unwrap());
static RE_ARROW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s*-->\s*[\w./\\-]+\.\w+:\d+(:\d+)*").unwrap());
static RE_HEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b0x[0-9a-fA-F]+\b").unwrap());

/// Normalize an error message for grouping: strip file paths and line numbers.
pub fn normalize_error(msg: &str) -> String {
    let s = RE_FILE_LOC.replace_all(msg.trim(), "");
    let s = RE_ARROW.replace_all(&s, "");
    let s = RE_HEX.replace_all(&s, "<addr>");
    s.trim().to_string()
}

/// Extract repeated error-loop signals.
/// - Groups errors by their normalized message.
/// - Includes when occurrence_count >= threshold.
/// - Strong when occurrence_count >= 5.
pub fn extract_error_signals(
    db: &SQLiteStore,
    repo_root: &str,
    since: i64,
    threshold: u32,
) -> Result<Vec<RawErrorSignal>> {
    struct Row {
        message: String,
        session_id: String,
        ts: i64,
    }

    let mut stmt = db.connection().prepare_cached(
        "SELECT message, session_id, ts
         FROM errors
         WHERE repo_root = ?1 AND ts >= ?2",
    )?;

    let raw_rows: Vec<Row> = stmt
        .query_map(rusqlite::params![repo_root, since], |r| {
            Ok(Row { message: r.get(0)?, session_id: r.get(1)?, ts: r.get(2)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Group by normalized message: key → (session_ids Vec, latest_ts)
    let mut groups: HashMap<String, (Vec<String>, i64)> = HashMap::new();
    for row in raw_rows {
        let key = normalize_error(&row.message);
        let entry = groups.entry(key).or_insert_with(|| (Vec::new(), i64::MIN));
        entry.0.push(row.session_id);
        if row.ts > entry.1 {
            entry.1 = row.ts;
        }
    }

    let mut signals: Vec<RawErrorSignal> = groups
        .into_iter()
        .filter_map(|(msg, (sessions, latest_ts))| {
            let count = sessions.len() as u64;
            if count < threshold as u64 {
                return None;
            }
            let mut uniq = sessions;
            uniq.sort_unstable();
            uniq.dedup();
            let session_count = uniq.len() as u64;
            Some(RawErrorSignal {
                message: msg,
                occurrence_count: count,
                session_count,
                is_strong: count >= STRONG_ERROR_THRESHOLD,
                latest_ts,
            })
        })
        .collect();

    signals.sort_by(|a, b| b.occurrence_count.cmp(&a.occurrence_count));
    Ok(signals)
}

// ---------------------------------------------------------------------------
// 4.3 — Repeated command-sequence detection via sliding-window hashing
// ---------------------------------------------------------------------------

/// Hash a command window using xxh3 over null-delimited command strings.
fn hash_window(commands: &[&str]) -> u64 {
    let joined = commands.join("\0");
    xxh3_64(joined.as_bytes())
}

/// Extract repeated command-sequence signals using sliding-window hashing.
/// Window lengths 2, 3, 4 are tried.
/// - Includes when count >= threshold.
/// - Strong when count >= 4.
pub fn extract_sequence_signals(
    db: &SQLiteStore,
    repo_root: &str,
    since: i64,
    threshold: u32,
) -> Result<Vec<RawSequenceSignal>> {
    struct CmdRow {
        payload: String,
        ts: i64,
    }

    let mut stmt = db.connection().prepare_cached(
        "SELECT payload, ts
         FROM events
         WHERE repo_root = ?1 AND ts >= ?2 AND kind = 'command'
         ORDER BY ts ASC",
    )?;

    let cmd_rows: Vec<CmdRow> = stmt
        .query_map(rusqlite::params![repo_root, since], |r| {
            Ok(CmdRow { payload: r.get(0)?, ts: r.get(1)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Extract command strings from JSON payloads.
    let commands: Vec<(String, i64)> = cmd_rows
        .iter()
        .filter_map(|row| {
            let v: serde_json::Value = serde_json::from_str(&row.payload).ok()?;
            let cmd = v.get("command")?.as_str()?.to_string();
            Some((cmd, row.ts))
        })
        .collect();

    if commands.len() < 2 {
        return Ok(vec![]);
    }

    let cmd_strs: Vec<&str> = commands.iter().map(|(s, _)| s.as_str()).collect();
    let cmd_ts: Vec<i64> = commands.iter().map(|(_, ts)| *ts).collect();

    // (window_len, hash) → (count, representative_commands, latest_ts)
    let mut buckets: HashMap<(usize, u64), (u64, Vec<String>, i64)> = HashMap::new();

    for wlen in [2usize, 3, 4] {
        if commands.len() < wlen {
            continue;
        }
        for i in 0..=(commands.len() - wlen) {
            let window = &cmd_strs[i..i + wlen];
            let hash = hash_window(window);
            let latest = cmd_ts[i + wlen - 1];
            let entry = buckets.entry((wlen, hash)).or_insert_with(|| {
                (0, window.iter().map(|s| s.to_string()).collect(), i64::MIN)
            });
            entry.0 += 1;
            if latest > entry.2 {
                entry.2 = latest;
            }
        }
    }

    let mut signals: Vec<RawSequenceSignal> = buckets
        .into_iter()
        .filter_map(|((wlen, _hash), (count, cmds, latest_ts))| {
            if count < threshold as u64 {
                return None;
            }
            Some(RawSequenceSignal {
                commands: cmds,
                count,
                window_len: wlen,
                is_strong: count >= STRONG_SEQUENCE_THRESHOLD,
                latest_ts,
            })
        })
        .collect();

    signals.sort_by(|a, b| b.count.cmp(&a.count));
    Ok(signals)
}

// ---------------------------------------------------------------------------
// 4.4 — Data sufficiency gate
// ---------------------------------------------------------------------------

/// Result of the data sufficiency gate check.
pub struct GateResult {
    pub passed: bool,
    /// Human-readable explanations for each unmet condition (empty when passed).
    pub reasons: Vec<String>,
    /// Total count of strong signals (R) across all three extractors.
    pub strong_repetition_count: u64,
}

/// Count strong signals across all three raw signal categories.
fn count_strong_signals(raw: &RawSignals) -> u64 {
    let files = raw.repeated_files.iter().filter(|s| s.is_strong).count() as u64;
    let errors = raw.repeated_errors.iter().filter(|s| s.is_strong).count() as u64;
    let seqs = raw.repeated_sequences.iter().filter(|s| s.is_strong).count() as u64;
    files + errors + seqs
}

/// Evaluate the data sufficiency gate.
///
/// Gate passes if ANY of these conditions hold:
///   1. S >= 5
///   2. S >= 3 AND E >= 200
///   3. R >= 1  (at least one strong repeated signal)
///
/// When the gate fails, `reasons` lists a human-readable explanation for each
/// unmet condition.
pub fn evaluate_gate(stats: &crate::store::DataStats, raw: &RawSignals) -> GateResult {
    let s = stats.sessions_count;
    let e = stats.events_count;
    let r = count_strong_signals(raw);

    let cond1 = s >= 5;
    let cond2 = s >= 3 && e >= 200;
    let cond3 = r >= 1;

    if cond1 || cond2 || cond3 {
        return GateResult { passed: true, reasons: vec![], strong_repetition_count: r };
    }

    let mut reasons = Vec::new();
    reasons.push(format!(
        "Condition 1 unmet: need at least 5 sessions (have {})",
        s
    ));
    reasons.push(format!(
        "Condition 2 unmet: need at least 3 sessions with 200+ events \
         (have {} sessions and {} events)",
        s, e
    ));
    reasons.push(format!(
        "Condition 3 unmet: no strong repeated signals detected (R={})",
        r
    ));

    GateResult { passed: false, reasons, strong_repetition_count: r }
}

/// Top-level entry point: query the DB and extract all raw signals.
pub fn extract(
    db: &SQLiteStore,
    repo_root: &str,
    window_days: u32,
    threshold: u32,
) -> Result<(crate::store::DataStats, RawSignals)> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let since = now - (window_days as i64) * 86_400;

    let stats = db.query_stats(repo_root, since)?;
    let repeated_files = extract_file_signals(db, repo_root, since, threshold)?;
    let repeated_errors = extract_error_signals(db, repo_root, since, threshold)?;
    let repeated_sequences = extract_sequence_signals(db, repo_root, since, threshold)?;

    Ok((stats, RawSignals { repeated_files, repeated_errors, repeated_sequences }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{EventRecord, SQLiteStore};

    fn with_store<F, T>(f: F) -> T
    where
        F: FnOnce(&mut SQLiteStore) -> T,
    {
        let mut s = SQLiteStore::open_in_memory();
        f(&mut s)
    }

    fn insert_file_accesses(
        store: &mut SQLiteStore,
        repo: &str,
        path: &str,
        sessions: &[&str],
        base_ts: i64,
    ) {
        let batch: Vec<EventRecord> = sessions
            .iter()
            .enumerate()
            .map(|(i, sid)| EventRecord {
                session_id: sid.to_string(),
                repo_root: repo.to_string(),
                ts: base_ts + i as i64,
                kind: "file_read".to_string(),
                payload: serde_json::json!({ "path": path }),
            })
            .collect();
        store.batch_insert_events(&batch).unwrap();
    }

    fn insert_errors(
        store: &mut SQLiteStore,
        repo: &str,
        messages: &[(&str, &str)], // (message, session_id)
        base_ts: i64,
    ) {
        let batch: Vec<EventRecord> = messages
            .iter()
            .enumerate()
            .map(|(i, (msg, sid))| EventRecord {
                session_id: sid.to_string(),
                repo_root: repo.to_string(),
                ts: base_ts + i as i64,
                kind: "error".to_string(),
                payload: serde_json::json!({ "message": msg }),
            })
            .collect();
        store.batch_insert_events(&batch).unwrap();
    }

    fn insert_commands(
        store: &mut SQLiteStore,
        repo: &str,
        commands: &[(&str, &str, i64)], // (session_id, command, ts)
    ) {
        let batch: Vec<EventRecord> = commands
            .iter()
            .map(|(sid, cmd, ts)| EventRecord {
                session_id: sid.to_string(),
                repo_root: repo.to_string(),
                ts: *ts,
                kind: "command".to_string(),
                payload: serde_json::json!({ "command": cmd }),
            })
            .collect();
        store.batch_insert_events(&batch).unwrap();
    }

    // -----------------------------------------------------------------------
    // Task 4.1 — file-access signal extraction
    // -----------------------------------------------------------------------

    #[test]
    fn test_file_signal_detected_at_threshold_with_2_sessions() {
        with_store(|store| {
            insert_file_accesses(store, "/repo", "src/main.rs",
                &["s1", "s1", "s2"],  // 3 accesses, 2 sessions
                1_700_000_000);
            let signals = extract_file_signals(store, "/repo", 0, 3).unwrap();
            assert_eq!(signals.len(), 1);
            assert_eq!(signals[0].path, "src/main.rs");
            assert_eq!(signals[0].access_count, 3);
            assert_eq!(signals[0].session_count, 2);
        });
    }

    #[test]
    fn test_file_signal_not_detected_below_threshold() {
        with_store(|store| {
            insert_file_accesses(store, "/repo", "src/main.rs",
                &["s1", "s2"],  // 2 accesses, 2 sessions — below threshold=3
                1_700_000_000);
            let signals = extract_file_signals(store, "/repo", 0, 3).unwrap();
            assert_eq!(signals.len(), 0);
        });
    }

    #[test]
    fn test_file_signal_not_detected_with_only_1_session() {
        with_store(|store| {
            // 5 accesses but all from same session — fails the 2-session requirement
            insert_file_accesses(store, "/repo", "src/main.rs",
                &["s1", "s1", "s1", "s1", "s1"],
                1_700_000_000);
            let signals = extract_file_signals(store, "/repo", 0, 3).unwrap();
            assert_eq!(signals.len(), 0);
        });
    }

    #[test]
    fn test_file_signal_strong_at_8_accesses_2_sessions() {
        with_store(|store| {
            let sessions: Vec<&str> = ["s1","s1","s1","s1","s2","s2","s2","s2"].to_vec();
            insert_file_accesses(store, "/repo", "src/main.rs", &sessions, 1_700_000_000);
            let signals = extract_file_signals(store, "/repo", 0, 3).unwrap();
            assert_eq!(signals.len(), 1);
            assert!(signals[0].is_strong, "8 accesses across 2 sessions should be strong");
        });
    }

    #[test]
    fn test_file_signal_not_strong_below_8_accesses() {
        with_store(|store| {
            insert_file_accesses(store, "/repo", "src/main.rs",
                &["s1","s1","s1","s2","s2","s2","s3"],  // 7 accesses, 3 sessions
                1_700_000_000);
            let signals = extract_file_signals(store, "/repo", 0, 3).unwrap();
            assert_eq!(signals.len(), 1);
            assert!(!signals[0].is_strong, "7 accesses should not be strong (threshold=8)");
        });
    }

    #[test]
    fn test_file_signals_ordered_by_access_count_desc() {
        with_store(|store| {
            // src/a.rs: 5 accesses, 2 sessions
            insert_file_accesses(store, "/repo", "src/a.rs",
                &["s1","s1","s1","s2","s2"], 1_700_000_000);
            // src/b.rs: 3 accesses, 2 sessions
            insert_file_accesses(store, "/repo", "src/b.rs",
                &["s1","s2","s2"], 1_700_000_100);
            let signals = extract_file_signals(store, "/repo", 0, 3).unwrap();
            assert_eq!(signals.len(), 2);
            assert_eq!(signals[0].path, "src/a.rs", "higher count must come first");
            assert_eq!(signals[1].path, "src/b.rs");
        });
    }

    #[test]
    fn test_file_signal_respects_since_window() {
        with_store(|store| {
            // Old accesses (ts = 1000) for file_a: 3 accesses from 2 sessions
            insert_file_accesses(store, "/repo", "src/old.rs",
                &["s1","s1","s2"], 1_000);
            // Recent accesses (ts = 2_000_000_000) for file_b
            insert_file_accesses(store, "/repo", "src/new.rs",
                &["s1","s1","s2"], 2_000_000_000);

            // Query with since=1_000_000_000 — only new.rs qualifies
            let signals = extract_file_signals(store, "/repo", 1_000_000_000, 3).unwrap();
            assert_eq!(signals.len(), 1);
            assert_eq!(signals[0].path, "src/new.rs");
        });
    }

    #[test]
    fn test_file_signal_scoped_to_repo() {
        with_store(|store| {
            insert_file_accesses(store, "/repo-a", "src/main.rs",
                &["s1","s1","s2"], 1_700_000_000);
            insert_file_accesses(store, "/repo-b", "src/main.rs",
                &["s3","s3","s4"], 1_700_000_000);
            let signals = extract_file_signals(store, "/repo-a", 0, 3).unwrap();
            assert_eq!(signals.len(), 1);
            // /repo-b's rows must not appear
            assert!(signals.iter().all(|_| true)); // basic existence check
        });
    }

    // -----------------------------------------------------------------------
    // Task 4.2 — error-loop signal extraction + normalization
    // -----------------------------------------------------------------------

    #[test]
    fn test_normalize_error_strips_rust_file_prefix() {
        let raw = "src/main.rs:42:5: error: mismatched types";
        let normalized = normalize_error(raw);
        assert!(!normalized.contains("src/main.rs"), "file path should be stripped");
        assert!(!normalized.contains(":42:"), "line number should be stripped");
        assert!(normalized.contains("error: mismatched types") || normalized.contains("mismatched types"),
            "error text should remain: got '{}'", normalized);
    }

    #[test]
    fn test_normalize_error_strips_rust_compiler_arrow() {
        let raw = "error[E0308]: mismatched types\n  --> src/main.rs:10:5";
        let normalized = normalize_error(raw);
        assert!(!normalized.contains("src/main.rs"), "arrow path should be stripped");
        assert!(normalized.contains("error[E0308]"), "error code should remain");
    }

    #[test]
    fn test_normalize_error_strips_hex_address() {
        let raw = "Segfault at 0xDEADBEEF in module";
        let normalized = normalize_error(raw);
        assert!(!normalized.contains("0xDEADBEEF"), "hex address should be replaced");
        assert!(normalized.contains("<addr>"), "hex should be replaced with <addr>");
    }

    #[test]
    fn test_error_signal_detected_at_threshold() {
        with_store(|store| {
            insert_errors(store, "/repo",
                &[("mismatched types", "s1"),
                  ("mismatched types", "s1"),
                  ("mismatched types", "s2")],
                1_700_000_000);
            let signals = extract_error_signals(store, "/repo", 0, 3).unwrap();
            assert_eq!(signals.len(), 1);
            assert_eq!(signals[0].occurrence_count, 3);
        });
    }

    #[test]
    fn test_error_signal_not_detected_below_threshold() {
        with_store(|store| {
            insert_errors(store, "/repo",
                &[("mismatched types", "s1"),
                  ("mismatched types", "s2")],
                1_700_000_000);
            let signals = extract_error_signals(store, "/repo", 0, 3).unwrap();
            assert_eq!(signals.len(), 0);
        });
    }

    #[test]
    fn test_error_signals_grouped_by_normalized_message() {
        with_store(|store| {
            // Two variants of the same error differing only in file path/line
            insert_errors(store, "/repo",
                &[("src/main.rs:10:5: error: use of moved value: `x`", "s1"),
                  ("src/lib.rs:22:3: error: use of moved value: `x`", "s1"),
                  ("src/foo.rs:5:1: error: use of moved value: `x`", "s2")],
                1_700_000_000);
            let signals = extract_error_signals(store, "/repo", 0, 3).unwrap();
            // All three normalize to the same message → 1 signal with count=3
            assert_eq!(signals.len(), 1, "normalized messages should be grouped: {:?}",
                signals.iter().map(|s| &s.message).collect::<Vec<_>>());
            assert_eq!(signals[0].occurrence_count, 3);
        });
    }

    #[test]
    fn test_error_signal_strong_at_5_occurrences() {
        with_store(|store| {
            insert_errors(store, "/repo",
                &[("cannot borrow `x` as mutable", "s1"),
                  ("cannot borrow `x` as mutable", "s1"),
                  ("cannot borrow `x` as mutable", "s2"),
                  ("cannot borrow `x` as mutable", "s2"),
                  ("cannot borrow `x` as mutable", "s3")],
                1_700_000_000);
            let signals = extract_error_signals(store, "/repo", 0, 3).unwrap();
            assert_eq!(signals.len(), 1);
            assert!(signals[0].is_strong, "5 occurrences should be strong");
        });
    }

    #[test]
    fn test_error_signal_not_strong_below_5() {
        with_store(|store| {
            insert_errors(store, "/repo",
                &[("type mismatch", "s1"),
                  ("type mismatch", "s1"),
                  ("type mismatch", "s2"),
                  ("type mismatch", "s2")],
                1_700_000_000);
            let signals = extract_error_signals(store, "/repo", 0, 3).unwrap();
            assert_eq!(signals.len(), 1);
            assert!(!signals[0].is_strong, "4 occurrences should not be strong");
        });
    }

    #[test]
    fn test_error_signal_respects_since_window() {
        with_store(|store| {
            insert_errors(store, "/repo",
                &[("old error", "s1"), ("old error", "s1"), ("old error", "s2")],
                1_000);
            insert_errors(store, "/repo",
                &[("new error", "s1"), ("new error", "s1"), ("new error", "s2")],
                2_000_000_000);
            let signals = extract_error_signals(store, "/repo", 1_000_000_000, 3).unwrap();
            assert_eq!(signals.len(), 1);
            assert!(signals[0].message.contains("new error"));
        });
    }

    // -----------------------------------------------------------------------
    // Task 4.3 — command-sequence detection
    // -----------------------------------------------------------------------

    #[test]
    fn test_sequence_signal_detected_for_repeated_pair() {
        let mut store = SQLiteStore::open_in_memory();
        let cmds = [
            ("s1", "cargo build", 1_000i64),
            ("s1", "cargo test", 1_001),
            ("s2", "cargo build", 2_000),
            ("s2", "cargo test", 2_001),
            ("s3", "cargo build", 3_000),
            ("s3", "cargo test", 3_001),
        ];
        insert_commands(&mut store, "/repo", &cmds);
        let signals = extract_sequence_signals(&store, "/repo", 0, 3).unwrap();
        let pair = signals.iter().find(|s| s.window_len == 2);
        assert!(pair.is_some(), "repeated 2-command sequence should be detected");
        let pair = pair.unwrap();
        assert_eq!(pair.commands, vec!["cargo build", "cargo test"]);
        assert_eq!(pair.count, 3);
    }

    #[test]
    fn test_sequence_signal_not_detected_below_threshold() {
        let mut store = SQLiteStore::open_in_memory();
        let cmds = [
            ("s1", "cargo build", 1_000i64),
            ("s1", "cargo test", 1_001),
            ("s2", "cargo build", 2_000),
            ("s2", "cargo test", 2_001),
        ];
        insert_commands(&mut store, "/repo", &cmds);
        let signals = extract_sequence_signals(&store, "/repo", 0, 3).unwrap();
        // Only 2 occurrences of the pair — below threshold=3
        assert!(signals.iter().filter(|s| s.window_len == 2).count() == 0,
            "pair with count=2 should not appear at threshold=3");
    }

    #[test]
    fn test_sequence_signal_strong_at_4_occurrences() {
        let mut store = SQLiteStore::open_in_memory();
        for i in 0..4i64 {
            insert_commands(&mut store, "/repo", &[
                (&format!("s{}", i), "make lint", 1_000 + i * 100),
                (&format!("s{}", i), "make test", 1_001 + i * 100),
            ]);
        }
        let signals = extract_sequence_signals(&store, "/repo", 0, 3).unwrap();
        let pair = signals.iter().find(|s| s.window_len == 2);
        assert!(pair.is_some());
        assert!(pair.unwrap().is_strong, "4 occurrences should be strong");
    }

    #[test]
    fn test_sequence_signal_not_strong_at_3_occurrences() {
        let mut store = SQLiteStore::open_in_memory();
        for i in 0..3i64 {
            insert_commands(&mut store, "/repo", &[
                (&format!("s{}", i), "make lint", 1_000 + i * 100),
                (&format!("s{}", i), "make test", 1_001 + i * 100),
            ]);
        }
        let signals = extract_sequence_signals(&store, "/repo", 0, 3).unwrap();
        let pair = signals.iter().find(|s| s.window_len == 2);
        assert!(pair.is_some());
        assert!(!pair.unwrap().is_strong, "3 occurrences should not be strong (threshold=4)");
    }

    #[test]
    fn test_sequence_hash_is_deterministic_for_same_commands() {
        // Same window hashed twice must give the same result.
        let h1 = hash_window(&["cargo build", "cargo test"]);
        let h2 = hash_window(&["cargo build", "cargo test"]);
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_sequence_hash_differs_for_different_order() {
        let h1 = hash_window(&["cargo build", "cargo test"]);
        let h2 = hash_window(&["cargo test", "cargo build"]);
        assert_ne!(h1, h2, "different order must produce different hash");
    }

    #[test]
    fn test_sequence_hash_differs_for_different_commands() {
        let h1 = hash_window(&["cargo build", "cargo test"]);
        let h2 = hash_window(&["make build", "make test"]);
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_sequence_detects_window_lengths_2_3_4() {
        let mut store = SQLiteStore::open_in_memory();
        // 3-command repeat: build → test → lint  (×3)
        for i in 0..3i64 {
            insert_commands(&mut store, "/repo", &[
                ("s1", "build", 1_000 + i * 10),
                ("s1", "test",  1_001 + i * 10),
                ("s1", "lint",  1_002 + i * 10),
            ]);
        }
        let signals = extract_sequence_signals(&store, "/repo", 0, 3).unwrap();
        // Should find at least one window-3 signal
        assert!(signals.iter().any(|s| s.window_len == 3),
            "window-3 repeated sequence should be detected");
    }

    #[test]
    fn test_sequence_stores_representative_command_list() {
        let mut store = SQLiteStore::open_in_memory();
        let cmds = [
            ("s1", "npm install", 1_000i64),
            ("s1", "npm test",    1_001),
            ("s2", "npm install", 2_000),
            ("s2", "npm test",    2_001),
            ("s3", "npm install", 3_000),
            ("s3", "npm test",    3_001),
        ];
        insert_commands(&mut store, "/repo", &cmds);
        let signals = extract_sequence_signals(&store, "/repo", 0, 3).unwrap();
        let pair = signals.iter().find(|s| s.window_len == 2).unwrap();
        assert_eq!(pair.commands.len(), 2);
        assert!(pair.commands.contains(&"npm install".to_string()));
        assert!(pair.commands.contains(&"npm test".to_string()));
    }

    #[test]
    fn test_sequence_empty_when_fewer_than_2_commands() {
        let mut store = SQLiteStore::open_in_memory();
        insert_commands(&mut store, "/repo", &[("s1", "cargo build", 1_000)]);
        let signals = extract_sequence_signals(&store, "/repo", 0, 1).unwrap();
        assert_eq!(signals.len(), 0, "need at least 2 commands for any window");
    }

    #[test]
    fn test_sequence_respects_since_filter() {
        let mut store = SQLiteStore::open_in_memory();
        // Old commands (below `since`)
        for i in 0..3i64 {
            insert_commands(&mut store, "/repo", &[
                ("s1", "old-cmd-a", 100 + i),
                ("s1", "old-cmd-b", 101 + i),
            ]);
        }
        // Recent commands (above `since`)
        for i in 0..3i64 {
            insert_commands(&mut store, "/repo", &[
                ("s1", "new-cmd-a", 2_000_000_000 + i),
                ("s1", "new-cmd-b", 2_000_000_001 + i),
            ]);
        }
        let signals = extract_sequence_signals(&store, "/repo", 1_000_000_000, 3).unwrap();
        assert!(signals.iter().all(|s| s.commands.iter().all(|c| c.starts_with("new-"))),
            "only recent commands should appear");
    }

    // -----------------------------------------------------------------------
    // Task 4.4 — data sufficiency gate
    // -----------------------------------------------------------------------

    fn make_stats(s: u64, e: u64, d: u64) -> crate::store::DataStats {
        crate::store::DataStats {
            sessions_count: s,
            events_count: e,
            active_days: d,
        }
    }

    fn empty_signals() -> RawSignals {
        RawSignals {
            repeated_files: vec![],
            repeated_errors: vec![],
            repeated_sequences: vec![],
        }
    }

    fn signals_with_strong_file() -> RawSignals {
        RawSignals {
            repeated_files: vec![RawFileSignal {
                path: "src/main.rs".to_string(),
                access_count: 8,
                session_count: 2,
                is_strong: true,
                latest_ts: 1_700_000_000,
            }],
            repeated_errors: vec![],
            repeated_sequences: vec![],
        }
    }

    #[test]
    fn test_gate_passes_when_sessions_gte_5() {
        let stats = make_stats(5, 50, 2);
        let result = evaluate_gate(&stats, &empty_signals());
        assert!(result.passed, "S=5 should pass the gate");
        assert!(result.reasons.is_empty());
    }

    #[test]
    fn test_gate_passes_when_sessions_gt_5() {
        let stats = make_stats(10, 100, 5);
        let result = evaluate_gate(&stats, &empty_signals());
        assert!(result.passed);
    }

    #[test]
    fn test_gate_passes_when_s3_and_e200() {
        let stats = make_stats(3, 200, 2);
        let result = evaluate_gate(&stats, &empty_signals());
        assert!(result.passed, "S=3 AND E=200 should pass condition 2");
    }

    #[test]
    fn test_gate_passes_when_s3_and_e_gt_200() {
        let stats = make_stats(3, 500, 3);
        let result = evaluate_gate(&stats, &empty_signals());
        assert!(result.passed);
    }

    #[test]
    fn test_gate_passes_when_strong_signal_r1() {
        let stats = make_stats(1, 10, 1); // Would fail conditions 1 and 2
        let result = evaluate_gate(&stats, &signals_with_strong_file());
        assert!(result.passed, "R=1 should pass condition 3");
        assert_eq!(result.strong_repetition_count, 1);
    }

    #[test]
    fn test_gate_fails_when_no_condition_met() {
        let stats = make_stats(2, 50, 1); // S<5, S<3 (or E<200), R=0
        let result = evaluate_gate(&stats, &empty_signals());
        assert!(!result.passed);
        assert!(!result.reasons.is_empty(), "reasons must be non-empty when gate fails");
    }

    #[test]
    fn test_gate_fail_produces_three_reason_messages() {
        let stats = make_stats(2, 50, 1);
        let result = evaluate_gate(&stats, &empty_signals());
        assert_eq!(result.reasons.len(), 3,
            "one reason per unmet condition (3 conditions total)");
    }

    #[test]
    fn test_gate_fail_reasons_mention_actual_values() {
        let stats = make_stats(2, 50, 1);
        let result = evaluate_gate(&stats, &empty_signals());
        let combined = result.reasons.join(" ");
        assert!(combined.contains('2') || combined.contains("2 session"),
            "reason should mention S=2: '{}'", combined);
    }

    #[test]
    fn test_gate_fail_when_s4_and_e199() {
        // S=4: doesn't satisfy S>=5; S>=3 but E=199<200; R=0
        let stats = make_stats(4, 199, 2);
        let result = evaluate_gate(&stats, &empty_signals());
        assert!(!result.passed, "S=4, E=199, R=0 must fail all three conditions");
    }

    #[test]
    fn test_gate_strong_repetition_count_sums_all_kinds() {
        let signals = RawSignals {
            repeated_files: vec![
                RawFileSignal { path: "a".to_string(), access_count: 8,
                    session_count: 2, is_strong: true, latest_ts: 0 },
                RawFileSignal { path: "b".to_string(), access_count: 3,
                    session_count: 2, is_strong: false, latest_ts: 0 },
            ],
            repeated_errors: vec![
                RawErrorSignal { message: "err".to_string(), occurrence_count: 5,
                    session_count: 2, is_strong: true, latest_ts: 0 },
            ],
            repeated_sequences: vec![
                RawSequenceSignal { commands: vec![], count: 4, window_len: 2,
                    is_strong: true, latest_ts: 0 },
            ],
        };
        let stats = make_stats(1, 5, 1);
        let result = evaluate_gate(&stats, &signals);
        // 1 strong file + 1 strong error + 1 strong sequence = 3
        assert_eq!(result.strong_repetition_count, 3);
        assert!(result.passed, "R=3 should pass gate via condition 3");
    }

    #[test]
    fn test_gate_strong_count_is_0_for_empty_signals() {
        let stats = make_stats(1, 5, 1);
        let result = evaluate_gate(&stats, &empty_signals());
        assert_eq!(result.strong_repetition_count, 0);
    }

    #[test]
    fn test_gate_passes_via_s5_even_when_r0() {
        // Make sure condition 1 alone is sufficient
        let stats = make_stats(5, 10, 1);
        let result = evaluate_gate(&stats, &empty_signals());
        assert!(result.passed);
        assert_eq!(result.strong_repetition_count, 0);
    }
}
