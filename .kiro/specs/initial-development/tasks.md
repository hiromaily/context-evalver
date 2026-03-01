# Implementation Plan

## Task Format Notes
- `(P)` = can be executed in parallel with sibling tasks at the same level
- `- [ ]*` = optional/deferrable test coverage (can be revisited post-MVP)
- Requirements use `N.M` form where N is the top-level Requirement number

---

- [ ] 1. Set up project scaffolding and build infrastructure
- [x] 1.1 Initialize the Rust workspace with a binary crate for the core daemon
  - Create a Cargo workspace with a single binary crate (`context-optimizer-core`) configured for Edition 2024
  - Add dependencies: `rusqlite` (bundled feature), `serde` with derive, `serde_json`, `xxhash-rust` (xxh3 feature), `anyhow`
  - Configure release profile for minimal binary size and fast startup
  - Verify the empty binary compiles and exits cleanly
  - _Requirements: 3.1, 3.5_

- [x] 1.2 Initialize the TypeScript plugin project
  - Create a `package.json` with `tsup` for compilation and `@biomejs/biome` 2.4 for linting
  - Configure `tsconfig.json` targeting Node.js 22 with strict type checking and no implicit `any`
  - Add a `biome.json` with `noExplicitAny` as error and `noFloatingPromises` enabled
  - Set up `build` and `check` scripts; verify an empty entry point compiles to `dist/`
  - _Requirements: 12.1, 14.2_

- [x] 1.3 Create the Claude Code plugin directory structure and manifest
  - Create `.claude-plugin/plugin.json` with plugin name `context-optimizer`, version, and description
  - Create `hooks/hooks.json` placeholder registering `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, and `UserPromptSubmit` hooks pointing to compiled scripts in `dist/`
  - Create stub `skills/` directories for `context-audit`, `context-draft`, `context-apply`, `context-status`, `context-reset`, and `context-config`
  - Verify the plugin directory is recognized by Claude Code with `--plugin-dir`
  - _Requirements: 1.6, 11.1_

---

- [ ] 2. Build the SQLite persistence layer
- [x] 2.1 Implement database initialization with WAL mode and schema creation
  - On first open, set `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, and `busy_timeout=5000` pragmas
  - Create the `sessions`, `events`, `file_access`, `errors`, and `throttle_records` tables using `CREATE TABLE IF NOT EXISTS`
  - Create all required indexes: `(repo_root, ts)` on events, `(repo_root, path)` on file\_access, `(repo_root, message)` on errors, `repo_root` on sessions
  - Place the database file at `~/.local/share/context-optimizer/db/{16-char repo hash}.db`
  - _Requirements: 3.1, 3.2, 3.3_

- [x] 2.2 Implement typed write operations using prepared statements
  - Implement session insert (with id, repo\_root, branch, started\_at) and session-end update (sets ended\_at)
  - Implement a batch insert for events that wraps all inserts in a single transaction and uses `prepare_cached` for the insert statement
  - Implement denormalized inserts into `file_access` and `errors` tables from event payloads during batch flush
  - Implement throttle-record upsert and throttle-history clear by repo\_root
  - _Requirements: 3.4, 3.5, 3.6, 7.4_

- [x] 2.3 Implement windowed read queries for signal analysis
  - Implement queries for file\_access, errors, events, and session stats filtered by `repo_root` and a `since` timestamp derived from `analysis_window_days`
  - Implement a stats query that returns session count (S), total event count (E), and active days count (D) in a single pass
  - Implement a throttle-record lookup by `(kind, target, repo_root)`
  - Verify all queries use index-covered WHERE clauses (no full-table scans)
  - _Requirements: 3.7, 4.5, 5.4_

---

- [ ] 3. Build the event ingestion and batch-write subsystem
- [x] 3.1 Implement the in-memory event buffer with timed and size-triggered flushing
  - Hold captured events in a Vec buffer; flush to SQLite when the buffer reaches 50 events
  - Run a background thread that fires a flush every 100ms regardless of buffer size
  - Flush uses the batch insert from task 2.2 inside a single SQLite transaction
  - After a successful flush, clear the buffer
  - _Requirements: 3.4, 14.3_

- [x] 3.2 Implement event payload denormalization on ingest
  - When ingesting a `file_read` or `file_write` event, also insert a row into `file_access` with the path and session\_id
  - When ingesting an `error` event, also insert a row into `errors` with the normalized message and session\_id
  - All three table writes (events, file\_access/errors) occur in the same flush transaction
  - Verify a crashed flush leaves the DB in a consistent state (WAL rollback)
  - _Requirements: 3.6, 4.1, 4.2_

---

- [ ] 4. (P) Build the signal extraction engine
  - Depends on schema from task 2; can be developed in parallel with task 3
- [x] 4.1 (P) Implement repeated file-access signal extraction
  - Query `file_access` grouped by path; count total accesses and distinct sessions within the window
  - Flag as a signal when access count meets `min_repeat_threshold` AND spans at least 2 distinct sessions
  - Flag as a **strong** signal (`R` contribution) when access count ≥ 8 AND spans ≥ 2 sessions
  - Return results ordered by access count descending
  - _Requirements: 4.1, 4.4_

- [x] 4.2 (P) Implement repeated error-loop signal extraction
  - Query `errors` grouped by normalized message within the window
  - Flag as a signal when occurrence count meets `min_repeat_threshold`
  - Flag as strong when occurrence count ≥ 5
  - Normalize error messages by stripping file paths and line numbers before grouping
  - _Requirements: 4.2, 4.4_

- [x] 4.3 (P) Implement repeated command-sequence detection via sliding-window hashing
  - Load all `command` events for the repo within the window, ordered by timestamp
  - For each window length 2, 3, and 4, slide across the command list and hash each window using xxh3 over null-delimited command strings
  - Count occurrences of each hash; flag as a signal when count meets `min_repeat_threshold`
  - Flag as strong when count ≥ 4; store the original command list for each unique hash
  - _Requirements: 4.3, 4.4_

- [x] 4.4 Implement the data sufficiency gate evaluation
  - Compute `S`, `E`, `D` from the stats query; count strong signals (`R`) from the three extractors
  - Pass the gate if: `S >= 5`, OR `S >= 3 AND E >= 200`, OR `R >= 1`
  - When the gate fails, produce a list of human-readable reasons explaining each unmet condition
  - The gate result is the prerequisite for any confidence scoring; gate failure returns a `signal_summary` with `gate_passed = false`
  - _Requirements: 5.1, 5.2, 5.3_

---

- [ ] 5. Build the confidence scoring engine
- [x] 5.1 Implement shared scoring utility functions
  - Implement `Sat(x, k) = 1 − exp(−x / k)` for saturating count normalization
  - Implement `Spread` as normalized entropy of per-session occurrence counts (or approximation `sessions_with_signal / S`)
  - Implement `DayCoverage = min(1, active_days_for_signal / 3)`
  - Implement `Recency = exp(−age_days / 14)` using the signal's most recent timestamp
  - Implement `DataFactor = min(1, Sat(S,3) × Sat(E,300) × Sat(D,3))`
  - _Requirements: 5.4, 6.2, 6.3, 6.4_

- [x] 5.2 Implement per-kind confidence formulas
  - CLAUDE.md candidates: `strength_f = Sat(count, 6) × (0.5 + 0.5×Spread) × (0.7 + 0.3×DayCoverage) × (0.7 + 0.3×Recency)`; apply `NoisePenalty = 0.85` when unique files opened > 500; `Evidence = average(top-5 strength_f)`
  - Skill candidates: `Conf = clamp(Sat(count,3) × min(1, sessions/3) × (0.5+0.5×Spread) × (0.7+0.3×Recency) × UtilityPenalty)`; apply `UtilityPenalty = 0.6` when sequence lacks meaningful operations (test/build/lint/migrate/format/grep)
  - Slash command candidates: `Conf = clamp(Sat(count,8) × min(1, sessions/3) × (0.6+0.4×Spread) × (0.7+0.3×Recency))`; exclude sequences containing destructive operations (`rm -rf`, force push, prod deploy)
  - Error-fix candidates: `Base = Sat(count,4) × min(1, sessions/2) × (0.6+0.4×Spread) × (0.7+0.3×Recency)`
  - _Requirements: 6.1, 6.5, 6.6, 6.7_

- [x] 5.3 Apply DataFactor penalty, threshold filtering, and throttle suppression
  - Multiply each kind-specific score by `DataFactor` to produce `Conf_final`
  - Attach `severity` (`high` ≥ 0.85, `medium` ≥ 0.70, `low` otherwise), `confidence`, `evidence_count`, and `draftable` (true when `Conf_final >= 0.80`) to each candidate
  - Suppress candidates with `Conf_final < 0.65` entirely (no output)
  - Candidates with `0.65 <= Conf_final < 0.80` are included in output but marked `draftable = false`
  - Check the throttle table: if the same `(kind, target, repo_root)` was last suggested within 7 days AND the new `Conf_final` is not at least 0.15 higher than `last_confidence`, suppress the candidate; otherwise upsert the throttle record
  - _Requirements: 6.8, 6.9, 7.1, 7.2, 7.3, 7.4, 7.5_

---

- [ ] 6. Build the Rust IPC server
- [x] 6.1 Implement the Unix domain socket listener and JSONL message loop
  - Bind a Unix socket at `~/.local/share/context-optimizer/{session_id}.sock` on startup
  - Accept connections sequentially; for each connection, read newline-delimited JSON until EOF
  - Dispatch `event` messages to the event ingestor's buffer; dispatch `query_signals` to signal extraction and confidence scoring; handle `flush` and `shutdown` control messages
  - Write JSONL responses (`signal_summary`, `ack`, `error`) back on the same connection
  - On `shutdown`, flush the batch buffer synchronously before exiting
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6_

- [x] 6.2 Wire all Rust components together in the daemon entry point
  - Accept `--session-id` CLI argument; derive socket and DB paths from it
  - Initialize SQLiteStore, EventIngestor, and the socket listener in the correct order
  - Spawn the 100ms flush background thread after SQLiteStore is ready
  - Handle SIGTERM and SIGINT by flushing and shutting down cleanly
  - _Requirements: 1.1, 1.2, 3.1_

---

- [ ] 7. (P) Build the TypeScript plugin foundation
  - These tasks operate on a separate codebase boundary (TypeScript vs Rust) and can run in parallel with tasks 2–6
- [x] 7.1 (P) Implement the configuration loader
  - Read `.context-optimizer.json` from the repository root; merge with hardcoded defaults for any missing or invalid field
  - Support all six config fields: `analysis_window_days`, `min_sessions`, `min_repeat_threshold`, `min_confidence_score`, `exclude_paths`, `auto_pr`
  - Log a warning to stderr for each invalid field value; never throw or crash
  - Return a fully populated config object even when the file is absent
  - _Requirements: 12.1, 12.2, 12.3, 12.4_

- [x] 7.2 (P) Implement the IPC client for the Unix socket
  - Derive the socket path deterministically as `~/.local/share/context-optimizer/{session_id}.sock`
  - Implement fire-and-forget event send: open connection, write JSONL line, close — no await for acknowledgment
  - Implement request-response `query_signals` send: write JSONL line, read one response line, parse and return the `SignalSummaryMessage`
  - Implement `sendFlush` for the `SessionEnd` hook
  - On any connection error (socket not found, ECONNREFUSED), log to stderr and return gracefully without throwing
  - _Requirements: 2.1, 2.3, 2.4, 2.5, 2.6, 2.7_

- [x] 7.3 (P) Implement the event capture and secret redaction module
  - Extract file paths from `Read`, `Edit`, `Write` tool inputs for `file_access` events
  - Extract the command string from `Bash` tool inputs for `command` events
  - Extract normalized error messages from failed `PostToolUse` tool responses for `error` events
  - Apply path exclusion: skip any event whose path starts with an `exclude_paths` entry
  - Redact secrets: replace values matching common patterns (AWS keys, GitHub tokens, `=<value>` env var assignments) with `[REDACTED]` before any serialization
  - Return `null` for events that cannot be meaningfully captured or that are excluded
  - _Requirements: 1.3, 1.4, 1.5, 1.7, 13.1, 13.2, 13.3, 13.4_

---

- [ ] 8. Build the hook dispatcher and session lifecycle management
- [x] 8.1 Implement the session start hook script
  - Read hook input from stdin; parse `session_id`, `cwd`, and `hook_event_name`
  - Check for `.context-optimizer-ignore` in `cwd`; if found, exit 0 immediately with no further action
  - Spawn the Rust daemon binary as a background process with `--session-id`; do not wait for it
  - Insert a session record (id, repo\_root, branch, started\_at) into the DB by sending an event message to the daemon after a brief startup wait
  - Exit 0 promptly so Claude Code is not blocked
  - _Requirements: 1.1, 1.8, 2.5_

- [x] 8.2 Implement the per-event hook scripts for tool use and prompt submission
  - Implement `PreToolUse` and `PostToolUse` hook handlers: read stdin, derive socket path from `session_id`, call event capture, send to IPC client fire-and-forget
  - Implement `UserPromptSubmit` hook handler with the same pattern (captures prompt metadata, not content)
  - Each hook script must complete and exit 0 within the 5ms total overhead budget
  - If the daemon socket is not yet available (race on session start), log a warning and exit 0 without capturing
  - _Requirements: 1.3, 1.4, 1.5, 1.6, 2.5, 2.7, 14.1, 14.2_

- [x] 8.3 Implement the session end hook script
  - Send a `flush` message to the daemon so any buffered events are committed before the session closes
  - Update the session record's `ended_at` by sending the appropriate event message
  - Clean up any draft staging file for this session (`drafts/{session_id}.json`) if it exists
  - Send a `shutdown` message to gracefully stop the daemon
  - _Requirements: 1.2, 9.4_

---

- [ ] 9. Build the `/context-audit` command
- [x] 9.1 Implement the audit query and Markdown report renderer
  - Read `session_id` and `cwd` from the skill invocation context; load config from the repo root
  - Send `query_signals` to the daemon with `repo_root`, `window_days`, and `min_repeat_threshold`
  - When `gate_passed = false`, render an "Insufficient Evidence" section listing the shortfall reasons and the recommendation to continue logging
  - When `gate_passed = true`, render sections for: data sufficiency status, observed signals (files, errors, sequences with counts), and recommendation candidates grouped by kind with confidence and severity
  - When no candidates exceed 0.65, render a "No actionable recommendations" message
  - Never write any files; all output is printed to stdout for Claude Code to display
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 9.2 Write the SKILL.md for the `/context-audit` skill
  - Author `skills/context-audit/SKILL.md` with frontmatter `disable-model-invocation: true` and a description that explains the command invokes read-only behavioral analysis
  - The skill body delegates to the compiled `context-audit` Node.js script
  - _Requirements: 8.1_

---

- [ ] 10. Build the `/context-draft` command and patch generator
- [x] 10.1 Implement the LLM prompt construction and diff parsing
  - Query signals via the IPC client; verify at least one candidate has `draftable = true`; if none exist, output a clear message directing the user to run `/context-audit` first
  - Construct a structured prompt containing the full signal summary (candidate kind, confidence, evidence, command lists for sequences) with instructions: use only provided signals, no hallucination, output unified diff blocks labeled by recommendation kind with rationale sections
  - Call the LLM and parse the response to extract unified diff blocks per recommendation kind
  - For each parsed diff, wrap it in a `DraftPatch` with `target_file`, `recommendation_kind`, `confidence`, `severity`, `evidence_count`, and `unified_diff`
  - Display each patch to the user with its metadata header; do not write any files
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

- [x] 10.2 Implement draft staging file persistence
  - After successful diff generation, serialize all `DraftPatch` objects into a `DraftStagingFile` JSON and write it to `~/.local/share/context-optimizer/drafts/{session_id}.json`
  - If the LLM call fails, do not write the staging file; surface the error as a Markdown message with a retry suggestion
  - Implement `loadDraft` to read and parse the staging file; return `null` if the file is absent
  - Implement `clearDraft` to delete the staging file
  - _Requirements: 9.4, 10.1_

- [x] 10.3 Write the SKILL.md for the `/context-draft` skill
  - Author `skills/context-draft/SKILL.md` with description explaining it generates concrete patch proposals from high-confidence signals
  - _Requirements: 9.1_

---

- [ ] 11. Build the `/context-apply` command
- [x] 11.1 Implement user confirmation and patch application
  - Load the draft staging file for the current session; if absent, inform the user to run `/context-draft` first and exit cleanly
  - Display all pending patches with their metadata; prompt the user for explicit confirmation before writing any files
  - On confirmation, apply each patch: create the target file if it does not exist, otherwise apply the unified diff
  - After all writes, run `git diff` and display the output
  - When a file write fails, report the specific path and error; leave all other successfully written files in place; continue to the next patch
  - _Requirements: 10.1, 10.2, 10.3, 10.6, 10.7_

- [x] 11.2 Implement optional git commit behavior
  - After patches are applied, if `auto_pr = true` in config, create a git commit with a descriptive message summarizing the applied recommendations
  - If `auto_pr = false` (default), do not commit; inform the user they can commit manually
  - On git command failure, report the output and suggest manual resolution
  - On success, call `clearDraft` to remove the staging file
  - _Requirements: 10.4, 10.5_

- [x] 11.3 Write the SKILL.md for the `/context-apply` skill
  - Author `skills/context-apply/SKILL.md` with description noting it requires a prior `/context-draft` run
  - _Requirements: 10.1_

---

- [ ] 12. (P) Build secondary utility commands
  - These commands share only the IPC client and config loader (no inter-command data dependency) and can be built in parallel with each other
- [x] 12.1 (P) Implement `/context-status`
  - Query the daemon for a lightweight summary: sessions analyzed, strong signal count, draftable recommendation count
  - Compute and display days since last optimization (last `throttle_records` entry for this repo)
  - Output as a compact Markdown block
  - Write `skills/context-status/SKILL.md`
  - _Requirements: 11.1_

- [x] 12.2 (P) Implement `/context-reset`
  - Display a warning explaining that all throttle and suggestion history for the current repository will be cleared
  - Require explicit user confirmation before proceeding
  - Send a reset message to the daemon (or directly invoke the SQLite clear operation via a daemon message)
  - Confirm successful reset to the user
  - Write `skills/context-reset/SKILL.md`
  - _Requirements: 11.2_

- [x] 12.3 (P) Implement `/context-config`
  - Load configuration using the config loader (no daemon query needed)
  - Display all six configuration fields and their current values in a readable Markdown table
  - Write `skills/context-config/SKILL.md`
  - _Requirements: 11.3, 11.4, 12.5_

---

- [ ] 13. Write unit tests for the Rust core
- [x] 13.1 Test confidence scoring utility functions and per-kind formulas
  - Verify `Sat(0, k) = 0`, `Sat(k, k) ≈ 0.63`, `Sat(2k, k) ≈ 0.86` for representative k values
  - Verify `Spread` returns 0 when all occurrences are in one session and approaches 1 when spread evenly
  - Verify `DayCoverage` clamps at 1.0 when days ≥ 3 and scales linearly below
  - Verify `Recency` returns 1.0 at age 0 and ≈ 0.5 at age 14
  - Verify each kind-specific formula produces correct `Conf_final` for fixture inputs, including NoisePenalty and UtilityPenalty cases
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

- [x] 13.2 Test signal extraction and the data sufficiency gate
  - Use an in-memory SQLite instance (`:memory:`) populated with synthetic events
  - Verify repeated file-access signal is detected at threshold and not below; verify strong-signal classification at count ≥ 8 across ≥ 2 sessions
  - Verify repeated error-loop detection and strong threshold at ≥ 5
  - Verify command-sequence detection for lengths 2, 3, 4; verify identical window produces identical hash
  - Verify gate passes for each of the three conditions (`S>=5`, `S>=3 AND E>=200`, `R>=1`) and fails when none hold; verify human-readable reason strings
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.6, 5.1, 5.2, 5.3_

- [x] 13.3 Test SQLite store operations and batch flushing
  - Verify schema tables and indexes are created on first open; verify idempotency on repeated open
  - Verify session insert and update-end round-trip
  - Verify batch insert writes all rows in a single transaction; verify flush at 50 events and at 100ms timer
  - Verify windowed queries exclude events older than `analysis_window_days`
  - Verify throttle upsert and suppression logic (same kind+target within 7 days, conf delta < 0.15)
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 7.4, 7.5_

---

- [ ] 14. (P) Write unit tests for the TypeScript layer
- [x] 14.1 (P) Test event capture and secret redaction
  - Verify file path extraction from Read, Edit, and Write tool inputs
  - Verify command extraction from Bash tool inputs
  - Verify error normalization from PostToolUse failure responses
  - Verify `null` return for events whose path matches an `exclude_paths` entry
  - Verify AWS key pattern, GitHub token pattern, and `KEY=value` env var assignment are each replaced with `[REDACTED]`
  - _Requirements: 1.3, 1.4, 1.5, 1.7, 13.1, 13.2, 13.3, 13.4_

- [x] 14.2 (P) Test configuration loader
  - Verify all six defaults are returned when the config file is absent
  - Verify each field is correctly overridden by a valid value in the file
  - Verify an invalid field value (e.g., negative `analysis_window_days`) falls back to the default and logs a warning
  - _Requirements: 12.1, 12.2, 12.3, 12.4_

- [x] 14.3 (P) Test IPC client error handling and patch generator
  - Verify that when the socket is unavailable, `sendEvent` returns without throwing and a warning is logged to stderr
  - Verify `querySignals` returns a sensible error representation when the daemon is unreachable
  - Verify `generateAuditReport` renders required sections: sufficiency block, signal lists, candidate list with confidence
  - Verify `saveDraft` / `loadDraft` / `clearDraft` round-trip correctly; verify `loadDraft` returns null for a missing file
  - _Requirements: 2.6, 8.2, 8.5, 9.4_

---

- [ ] 15. Write integration and performance tests
- [x] 15.1 Integration test: full session event capture and signal emergence
  - Start the Rust daemon binary as a subprocess with a temp session ID
  - Send 60 synthetic events (including 8 file-access events for the same path across 3 sessions) via the Unix socket
  - Send `flush` and then `query_signals`; assert `gate_passed = true`, the repeated-file candidate appears with correct count and `draftable = true`
  - Verify the batch was committed to SQLite (query the DB directly)
  - _Requirements: 1.1, 2.1, 2.7, 3.4, 4.1, 5.1, 14.1_

- [x] 15.2 Integration test: throttle suppression over time
  - Propose a candidate; assert it appears in `signal_summary`
  - Query again immediately; assert the same candidate is suppressed (within 7 days, no conf improvement)
  - Artificially advance `last_suggested_at` by 8 days in the DB; query again; assert the candidate reappears
  - _Requirements: 7.4, 7.5_

- [x] 15.3 Performance test: event send latency
  - Send 1000 events sequentially via the Unix socket from the TypeScript IPC client
  - Measure the round-trip time (send + write + buffer) for each event
  - Assert the median latency is under 5ms; assert the 99th percentile is under 20ms
  - _Requirements: 2.7, 14.1, 14.3_

- [x] 15.4* (optional) Integration test: /context-audit end-to-end output
  - Load the plugin in Claude Code via `--plugin-dir`; run 3 synthetic sessions by replaying pre-recorded hook payloads
  - Invoke `/context-optimizer:context-audit` and capture stdout
  - Assert the output contains the "Observed Signals" and "Recommendation Candidates" sections with non-zero entries
  - _Requirements: 8.1, 8.2, 8.3_

- [x] 15.5* (optional) Integration test: /context-draft staging file lifecycle
  - Invoke `/context-optimizer:context-draft` with a mocked LLM response returning a known unified diff
  - Assert the staging file is written with the expected patches
  - Invoke `/context-optimizer:context-apply` with auto-confirm; assert the target file is created and the staging file is removed
  - _Requirements: 9.4, 10.1, 10.2_
