use crate::store::{EventRecord, SQLiteStore};
use anyhow::Result;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

const FLUSH_THRESHOLD: usize = 50;
const FLUSH_INTERVAL_MS: u64 = 100;

// ---------------------------------------------------------------------------
// EventIngestor
// ---------------------------------------------------------------------------

pub struct EventIngestor {
    store: Arc<Mutex<SQLiteStore>>,
    buffer: Arc<Mutex<Vec<EventRecord>>>,
}

impl EventIngestor {
    pub fn new(store: Arc<Mutex<SQLiteStore>>) -> Self {
        EventIngestor {
            store,
            buffer: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Add an event to the in-memory buffer.
    /// Triggers a synchronous flush when the buffer reaches FLUSH_THRESHOLD.
    pub fn ingest(&self, event: EventRecord) -> Result<()> {
        let should_flush = {
            let mut buf = self.buffer.lock().unwrap();
            buf.push(event);
            buf.len() >= FLUSH_THRESHOLD
        };
        if should_flush {
            self.flush()?;
        }
        Ok(())
    }

    /// Drain the buffer and write all pending events to SQLite in one transaction.
    pub fn flush(&self) -> Result<()> {
        flush_batch(&self.store, &self.buffer)
    }

    /// Number of events currently held in the buffer (for testing / diagnostics).
    pub fn buffer_len(&self) -> usize {
        self.buffer.lock().unwrap().len()
    }

    /// Spawn the background flush thread (100 ms interval).
    /// Returns a `FlushThread` handle that stops the thread when dropped or
    /// when `FlushThread::stop()` is called.
    pub fn start_flush_thread(&self) -> FlushThread {
        let buffer = Arc::clone(&self.buffer);
        let store = Arc::clone(&self.store);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = Arc::clone(&stop);

        let handle = std::thread::spawn(move || {
            while !stop_clone.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(FLUSH_INTERVAL_MS));
                let _ = flush_batch(&store, &buffer);
            }
        });

        FlushThread { handle, stop }
    }
}

// ---------------------------------------------------------------------------
// FlushThread handle
// ---------------------------------------------------------------------------

pub struct FlushThread {
    handle: std::thread::JoinHandle<()>,
    stop: Arc<AtomicBool>,
}

impl FlushThread {
    /// Signal the background thread to stop and wait for it to exit.
    pub fn stop(self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.handle.join();
    }
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

fn flush_batch(
    store: &Arc<Mutex<SQLiteStore>>,
    buffer: &Arc<Mutex<Vec<EventRecord>>>,
) -> Result<()> {
    let batch: Vec<EventRecord> = {
        let mut buf = buffer.lock().unwrap();
        if buf.is_empty() {
            return Ok(());
        }
        buf.drain(..).collect()
    };
    let mut store_guard = store.lock().unwrap();
    store_guard.batch_insert_events(&batch)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_store() -> Arc<Mutex<SQLiteStore>> {
        Arc::new(Mutex::new(SQLiteStore::open_in_memory()))
    }

    fn make_event(kind: &str, n: i64) -> EventRecord {
        let payload = match kind {
            "file_read" | "file_write" => json!({ "path": format!("src/file_{}.rs", n) }),
            "error" => json!({ "message": format!("error message {}", n) }),
            _ => json!({ "command": format!("cargo build {}", n) }),
        };
        EventRecord {
            session_id: "test-session".to_string(),
            repo_root: "/test-repo".to_string(),
            ts: 1_700_000_000 + n,
            kind: kind.to_string(),
            payload,
        }
    }

    fn count_table(store: &Arc<Mutex<SQLiteStore>>, table: &str) -> i64 {
        const VALID: &[&str] =
            &["events", "file_access", "errors", "sessions", "throttle_records"];
        assert!(VALID.contains(&table), "count_table: unknown table '{}'", table);
        store
            .lock()
            .unwrap()
            .connection()
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    // -----------------------------------------------------------------------
    // Task 3.1 — buffer management and size-triggered flush
    // -----------------------------------------------------------------------

    #[test]
    fn test_ingest_adds_event_to_buffer() {
        let store = make_store();
        let ingestor = EventIngestor::new(Arc::clone(&store));
        ingestor.ingest(make_event("command", 1)).unwrap();
        assert_eq!(ingestor.buffer_len(), 1);
    }

    #[test]
    fn test_ingest_49_events_does_not_flush() {
        let store = make_store();
        let ingestor = EventIngestor::new(Arc::clone(&store));
        for i in 0..49 {
            ingestor.ingest(make_event("command", i)).unwrap();
        }
        assert_eq!(ingestor.buffer_len(), 49, "49 events should still be in buffer");
        assert_eq!(count_table(&store, "events"), 0, "no flush should have happened yet");
    }

    #[test]
    fn test_size_triggered_flush_at_50_events() {
        let store = make_store();
        let ingestor = EventIngestor::new(Arc::clone(&store));
        for i in 0..50 {
            ingestor.ingest(make_event("command", i)).unwrap();
        }
        // The 50th ingest triggers a flush synchronously.
        assert_eq!(count_table(&store, "events"), 50, "50 events must be flushed to DB");
    }

    #[test]
    fn test_buffer_is_cleared_after_size_triggered_flush() {
        let store = make_store();
        let ingestor = EventIngestor::new(Arc::clone(&store));
        for i in 0..50 {
            ingestor.ingest(make_event("command", i)).unwrap();
        }
        assert_eq!(ingestor.buffer_len(), 0, "buffer must be empty after flush");
    }

    #[test]
    fn test_explicit_flush_writes_buffered_events_to_db() {
        let store = make_store();
        let ingestor = EventIngestor::new(Arc::clone(&store));
        for i in 0..10 {
            ingestor.ingest(make_event("command", i)).unwrap();
        }
        assert_eq!(count_table(&store, "events"), 0, "not yet flushed");
        ingestor.flush().unwrap();
        assert_eq!(count_table(&store, "events"), 10, "explicit flush should write 10 rows");
    }

    #[test]
    fn test_explicit_flush_clears_buffer() {
        let store = make_store();
        let ingestor = EventIngestor::new(Arc::clone(&store));
        ingestor.ingest(make_event("command", 1)).unwrap();
        ingestor.flush().unwrap();
        assert_eq!(ingestor.buffer_len(), 0);
    }

    #[test]
    fn test_flush_on_empty_buffer_is_noop() {
        let store = make_store();
        let ingestor = EventIngestor::new(Arc::clone(&store));
        ingestor.flush().unwrap(); // must not error
        assert_eq!(count_table(&store, "events"), 0);
    }

    #[test]
    fn test_events_after_flush_accumulate_in_fresh_buffer() {
        let store = make_store();
        let ingestor = EventIngestor::new(Arc::clone(&store));
        for i in 0..50 {
            ingestor.ingest(make_event("command", i)).unwrap();
        }
        // After automatic flush, add 3 more.
        for i in 50..53 {
            ingestor.ingest(make_event("command", i)).unwrap();
        }
        assert_eq!(ingestor.buffer_len(), 3, "post-flush events must go into fresh buffer");
        assert_eq!(count_table(&store, "events"), 50, "only the first batch is in DB");
    }

    #[test]
    fn test_timed_flush_fires_within_300ms() {
        let store = make_store();
        let ingestor = EventIngestor::new(Arc::clone(&store));
        let flush_thread = ingestor.start_flush_thread();

        // Add 5 events (below threshold so no size flush).
        for i in 0..5 {
            ingestor.ingest(make_event("command", i)).unwrap();
        }
        assert_eq!(count_table(&store, "events"), 0, "events not yet in DB");

        // Wait up to 300ms for the 100ms timer to fire at least once.
        std::thread::sleep(std::time::Duration::from_millis(300));
        flush_thread.stop();

        assert_eq!(count_table(&store, "events"), 5, "timed flush must have written 5 rows");
        assert_eq!(ingestor.buffer_len(), 0, "buffer must be empty after timed flush");
    }

    // -----------------------------------------------------------------------
    // Task 3.2 — denormalization through EventIngestor
    // -----------------------------------------------------------------------

    #[test]
    fn test_ingest_file_read_denormalized_to_file_access() {
        let store = make_store();
        let ingestor = EventIngestor::new(Arc::clone(&store));
        ingestor.ingest(make_event("file_read", 1)).unwrap();
        ingestor.flush().unwrap();

        assert_eq!(count_table(&store, "events"), 1);
        assert_eq!(count_table(&store, "file_access"), 1,
            "file_read event must be denormalized into file_access");
    }

    #[test]
    fn test_ingest_file_write_denormalized_to_file_access() {
        let store = make_store();
        let ingestor = EventIngestor::new(Arc::clone(&store));
        ingestor.ingest(make_event("file_write", 1)).unwrap();
        ingestor.flush().unwrap();

        assert_eq!(count_table(&store, "file_access"), 1,
            "file_write event must be denormalized into file_access");
    }

    #[test]
    fn test_ingest_error_denormalized_to_errors_table() {
        let store = make_store();
        let ingestor = EventIngestor::new(Arc::clone(&store));
        ingestor.ingest(make_event("error", 1)).unwrap();
        ingestor.flush().unwrap();

        assert_eq!(count_table(&store, "events"), 1);
        assert_eq!(count_table(&store, "errors"), 1,
            "error event must be denormalized into errors table");
    }

    #[test]
    fn test_denormalization_and_event_row_written_in_same_flush() {
        // Mix of event kinds — verify counts are consistent (atomic transaction).
        let store = make_store();
        let ingestor = EventIngestor::new(Arc::clone(&store));
        ingestor.ingest(make_event("file_read", 1)).unwrap();
        ingestor.ingest(make_event("error", 2)).unwrap();
        ingestor.ingest(make_event("command", 3)).unwrap();
        ingestor.flush().unwrap();

        assert_eq!(count_table(&store, "events"), 3, "all 3 events must be in events table");
        assert_eq!(count_table(&store, "file_access"), 1, "1 file_access row");
        assert_eq!(count_table(&store, "errors"), 1, "1 errors row");
    }

    #[test]
    fn test_wal_consistency_no_partial_writes_on_flush() {
        // Verify WAL atomicity: if the entire batch completes, all three tables
        // reflect the same data. We cannot easily force a mid-transaction crash
        // in unit tests, but we verify the counts are always consistent (all or nothing).
        let store = make_store();
        let ingestor = EventIngestor::new(Arc::clone(&store));

        // Ingest 4 file_read events — each produces one events row + one file_access row.
        for i in 0..4 {
            ingestor.ingest(make_event("file_read", i)).unwrap();
        }
        ingestor.flush().unwrap();

        let ev = count_table(&store, "events");
        let fa = count_table(&store, "file_access");
        assert_eq!(ev, 4);
        assert_eq!(fa, 4, "file_access count must equal file_read event count (atomic)");
    }
}
