# context-evalver-core

Rust daemon that continuously monitors developer activity within a repository to identify recurring patterns and generate AI-powered contextual recommendations. Serves as the backend engine for the AI-DLC (AI Development Life Cycle) system.

## What It Does

Detects three types of patterns across development sessions:

- **Repeated file access** → recommends adding files to CLAUDE.md
- **Recurring errors** → recommends error-fix slash commands
- **Repeated command sequences** → recommends new slash commands / skills

## Architecture

Five-phase pipeline:

```
Events → Ingestor Buffer → SQLite (5 tables) → Signal Extractors
       → Data-Sufficiency Gate → Confidence Scorer → Throttle Filter → SignalSummary (JSON)
```

### Modules

| Module | Responsibility |
|--------|---------------|
| `main.rs` | CLI parsing, socket/DB initialization, background flush thread, signal handling |
| `store.rs` | SQLite persistence — 5-table schema, batch inserts, windowed queries, throttle records |
| `ingestor.rs` | Event buffering with dual-trigger flushing (50-event threshold or 100 ms interval) |
| `signal_extractor.rs` | File/error/sequence pattern detection; data-sufficiency gate |
| `confidence_scorer.rs` | Per-kind confidence formulas, throttle suppression, severity assignment |
| `ipc_server.rs` | Unix domain socket JSONL server — accepts and dispatches inbound messages |

## IPC Protocol

**Transport**: Unix domain socket (`~/.local/share/context-evalver/{SESSION_ID}.sock`)
**Format**: JSONL (newline-delimited JSON) over `SOCK_STREAM`

### Inbound Messages

```json
// Ingest an event
{"type": "event", "event": {"session_id": "s1", "repo_root": "/repo", "ts": 1700000000, "kind": "file_read", "payload": {"path": "src/main.rs"}}}

// Flush buffered events to DB synchronously
{"type": "flush"}

// Query scored recommendations
{"type": "query_signals", "repo_root": "/repo", "window_days": 30, "min_repeat_threshold": 3}

// Graceful shutdown
{"type": "shutdown"}
```

Supported `kind` values: `command`, `file_read`, `file_write`, `error`

### Outbound Messages

```json
// Acknowledgement
{"type": "ack", "ok": true}

// Recommendation results
{
  "type": "signal_summary",
  "gate_passed": true,
  "gate_reasons": [],
  "repeated_files": [{"path": "src/main.rs", "count": 30, "severity": "high", "confidence": 0.88, "evidence_count": 30, "draftable": true}],
  "repeated_errors": [...],
  "repeated_sequences": [...]
}

// Error
{"type": "error", "message": "..."}
```

## Data Model

SQLite database at `~/.local/share/context-evalver/db/{xxh3(repo_root)}.db`

| Table | Purpose |
|-------|---------|
| `sessions` | Session metadata (id, repo_root, branch, timestamps) |
| `events` | Full event log (session_id, ts, kind, payload JSON) |
| `file_access` | Denormalized file access rows for fast signal queries |
| `errors` | Denormalized normalized error messages |
| `throttle_records` | Per-kind suppression state (last_suggested_at, last_confidence) |

**Optimizations**: WAL journal mode, `synchronous=NORMAL`, 6 indexes on hot paths, prepared statement caching, single-transaction batch inserts.

## Confidence Scoring

Each signal kind uses a distinct formula built from composable utility functions:

- `sat(x, k)` = 1 − exp(−x/k) — saturating count normalization
- `spread(with_signal, total)` — fraction of sessions with the signal
- `day_coverage(days)` — min(1, days/3)
- `recency(age_days)` — exp(−age/14) (14-day half-life)
- `data_factor(stats)` — overall dataset availability weight

**Key thresholds**:

| Threshold | Value | Meaning |
|-----------|-------|---------|
| `CONF_SUPPRESS_THRESHOLD` | 0.65 | Minimum score to return a candidate |
| `CONF_DRAFTABLE_THRESHOLD` | 0.80 | Marks candidate as auto-draftable |
| `THROTTLE_WINDOW_SECS` | 7 days | Suppress re-suggestion within window |
| `THROTTLE_CONF_DELTA` | 0.15 | Minimum confidence improvement to override throttle |

**Data-sufficiency gate** — must pass at least one condition before any recommendations are returned:
- S ≥ 5 sessions, or
- S ≥ 3 AND E ≥ 200 events, or
- At least 1 strong signal exists

## Build & Run

**Requirements**: Rust toolchain (edition 2024), no external runtime dependencies (SQLite is bundled).

```bash
# Build
cd core
cargo build --release

# Run
./target/release/context-evalver-core --session-id <ID> --repo-root <PATH>
```

The daemon creates its socket and database automatically on first run.

## Testing

```bash
cargo test                     # All tests (~150+)
cargo test --lib               # Unit tests only
cargo test --test smoke        # Dependency smoke tests
cargo test --test integration  # End-to-end daemon + IPC tests
```

Integration tests in `tests/integration.rs` spawn a real daemon process, send events over IPC, and verify signal emergence and throttle suppression behavior.

## Dependencies

| Crate | Purpose |
|-------|---------|
| `rusqlite 0.38` (bundled) | SQLite persistence |
| `serde` + `serde_json` | JSON serialization |
| `xxhash-rust` (xxh3) | Fast repo-root → DB path hashing |
| `anyhow` | Error propagation |
| `ctrlc` | SIGTERM/SIGINT handling |
| `dirs-next` | XDG base directory resolution |
| `regex` | Error message normalization |
