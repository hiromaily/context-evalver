# Requirements Document

## Project Description (Input)

Build a Claude Code plugin named `context-evalver` using a hybrid TypeScript + Rust architecture. The plugin logs developer interactions and AI agent behavior during Claude Code sessions, persists events to SQLite via a Rust core, extracts behavioral signals, and generates structured repository improvement proposals as reviewable Markdown patches.

Design philosophy: "It only speaks when it is confident." — avoid false positives, prefer silence over weak advice, require statistical repetition before intervention.

## Introduction

`context-evalver` is a developer productivity plugin for Claude Code that observes session behavior, detects recurring patterns, and proposes context improvements (CLAUDE.md updates, Skills, slash commands) only when statistical evidence is strong enough to be actionable. The system is composed of two layers: a TypeScript plugin layer integrated with Claude Code, and a Rust core binary that handles all persistence, signal extraction, and confidence scoring via SQLite. Communication between layers uses JSON Lines over stdio.

---

## Requirements

### Requirement 1: Event Capture and Session Lifecycle Management

**Objective:** As a developer, I want the plugin to automatically capture all significant interactions during my Claude Code session, so that behavioral patterns can be derived without any manual logging effort.

#### Acceptance Criteria

1. When a Claude Code session starts, the context-evalver shall create a new session record in the `sessions` table containing a unique session ID, `repo_root`, current git branch, and `started_at` timestamp.
2. When a Claude Code session ends, the context-evalver shall update the corresponding session record with an `ended_at` timestamp.
3. When a file is read or written by the agent, the context-evalver shall capture a `file_access` event containing the file path and timestamp.
4. When a shell command is executed by the agent, the context-evalver shall capture a `command` event containing the command string and timestamp.
5. When a tool call results in an error, the context-evalver shall capture an `error` event containing the normalized error message and timestamp.
6. The context-evalver shall capture events for all registered hook types: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop`.
7. The context-evalver shall exclude paths matching the `exclude_paths` configuration list from all event capture.
8. If a repo-level opt-out marker file is present (`.context-evalver-ignore`), the context-evalver shall not capture any events for that repository.

---

### Requirement 2: IPC Communication (TypeScript ↔ Rust Core)

**Objective:** As a developer, I want the TypeScript plugin and Rust core to communicate reliably and efficiently, so that event data flows without blocking Claude Code's main runtime.

#### Acceptance Criteria

1. The context-evalver TypeScript layer shall send all events to the Rust core as newline-delimited JSON (JSONL) over stdin of the Rust binary process.
2. When sending an event, the context-evalver shall format the message as `{"type": "event", "event": {...}}` with fields `session_id`, `timestamp`, `repo_root`, `kind`, and `payload`.
3. When querying signals, the context-evalver TypeScript layer shall send `{"type": "query_signals", "repo_root": "...", "window_days": N}` to the Rust core.
4. When the Rust core completes signal computation, it shall respond with a `signal_summary` JSONL message containing `repeated_files`, `repeated_errors`, and `repeated_sequences`.
5. The context-evalver TypeScript layer shall send events asynchronously and shall not block the Claude Code runtime while waiting for the Rust core.
6. If the Rust core process is unavailable, the context-evalver TypeScript layer shall log a warning and continue without interrupting the Claude Code session.
7. The context-evalver shall complete the full event send cycle (TypeScript → Rust → SQLite) within 5 milliseconds per event under normal operating conditions.

---

### Requirement 3: Data Persistence (Rust Core / SQLite)

**Objective:** As a developer, I want all captured events to be durably persisted in SQLite with low latency, so that signal analysis across many sessions is reliable and fast.

#### Acceptance Criteria

1. The context-evalver Rust core shall initialize the SQLite database with `PRAGMA journal_mode=WAL`, `PRAGMA synchronous=NORMAL`, and `PRAGMA foreign_keys=ON` on startup.
2. The context-evalver Rust core shall create and maintain four tables: `sessions`, `events`, `file_access`, and `errors`, with the schema defined in the specification.
3. The context-evalver Rust core shall maintain indexes on `repo_root`, `ts`, `path`, and `kind` columns to avoid full-table scans.
4. The context-evalver Rust core shall batch write events and commit to SQLite every 50 events or every 100 milliseconds, whichever occurs first.
5. The context-evalver Rust core shall use prepared statements for all database operations.
6. When inserting an event, the context-evalver Rust core shall store the `payload` field as a JSON string.
7. The context-evalver Rust core shall restrict all signal queries to events within the configured `analysis_window_days` time window.

---

### Requirement 4: Signal Extraction

**Objective:** As a developer, I want the system to deterministically extract behavioral signals from persisted events, so that recommendations are based on objective, reproducible analysis.

#### Acceptance Criteria

1. The context-evalver Rust core shall identify a **repeated file access** signal when the same file path has been opened at least `min_repeat_threshold` times (default: 3) within the analysis window, across at least 2 distinct sessions.
2. The context-evalver Rust core shall identify a **repeated error loop** signal when the same normalized error message has occurred at least `min_repeat_threshold` times within the analysis window.
3. The context-evalver Rust core shall identify a **repeated command sequence** signal when a command sequence of length 2–4 has occurred at least `min_repeat_threshold` times within the analysis window, using sliding-window hashing for detection.
4. The context-evalver Rust core shall define a **strong repetition** (`R`) as: a file opened ≥8 times across ≥2 sessions, OR an error occurring ≥5 times, OR a command sequence occurring ≥4 times.
5. The context-evalver Rust core shall compute session count (`S`), total event count (`E`), and active days count (`D`) for the analysis window upon each signal query.
6. The context-evalver shall produce identical signal output for identical input data (deterministic extraction).

---

### Requirement 5: Data Sufficiency Gate

**Objective:** As a developer, I want the system to withhold recommendations until enough evidence has accumulated, so that I only receive proposals backed by statistically meaningful data.

#### Acceptance Criteria

1. The context-evalver shall pass the data sufficiency gate if any of the following conditions are met: `S >= 5`, OR `S >= 3 AND E >= 200`, OR `R >= 1` (at least one strong repetition signal exists).
2. If the data sufficiency gate does not pass, the context-evalver shall not generate any draft proposals.
3. If the data sufficiency gate does not pass, the context-evalver shall display an "insufficient evidence" report explaining which conditions were not met and recommending continued logging.
4. The context-evalver shall apply a `DataFactor` penalty computed as `min(1, Sat(S,3) * Sat(E,300) * Sat(D,3))` to all confidence scores even after the gate passes, where `Sat(x,k) = 1 - exp(-x/k)`.

---

### Requirement 6: Confidence Scoring

**Objective:** As a developer, I want each recommendation to carry a computed confidence score, so that only well-evidenced proposals surface as actionable patches.

#### Acceptance Criteria

1. The context-evalver Rust core shall compute a confidence score in the range `[0.0, 1.0]` for each recommendation candidate using kind-specific formulas (CLAUDE.md addition, Skill proposal, Slash command, Error loop fix).
2. The context-evalver Rust core shall compute a **Spread** component as the normalized entropy of per-session occurrence counts, rewarding signals that appear across many sessions rather than concentrated in one.
3. The context-evalver Rust core shall compute a **DayCoverage** component as `min(1, active_days_for_signal / 3)`, reaching maximum at 3 or more days.
4. The context-evalver Rust core shall compute a **Recency** component as `exp(-age_days / 14)`, where `age_days` is the days since the signal last occurred.
5. The context-evalver Rust core shall apply a `NoisePenalty` of 0.85 to CLAUDE.md recommendations when the number of unique files opened exceeds 500, to discount broad exploratory sessions.
6. The context-evalver Rust core shall apply a `UtilityPenalty` of 0.6 to Skill proposals for command sequences that do not contain any of the recognized meaningful operations (test, build, migrate, lint, format, grep, etc.).
7. The context-evalver Rust core shall exclude any command sequence containing destructive operations (e.g., `rm -rf`, force push, prod deploy) from Slash command proposals.
8. The context-evalver Rust core shall multiply the kind-specific confidence by `DataFactor` to produce the final `Conf_final`.
9. The context-evalver Rust core shall attach `severity` (low/medium/high), `confidence` (0.0–1.0), and `evidence_count` to each recommendation candidate.

---

### Requirement 7: Recommendation Filtering and Throttling

**Objective:** As a developer, I want recommendations to be filtered by confidence thresholds and throttled over time, so that I am not overwhelmed with repetitive or low-quality suggestions.

#### Acceptance Criteria

1. When a recommendation candidate has `Conf_final >= 0.80`, the context-evalver shall include it as a draftable proposal available to `/context-draft`.
2. When a recommendation candidate has `0.65 <= Conf_final < 0.80`, the context-evalver shall display it in `/context-audit` as a "candidate" only, without making it draftable.
3. When a recommendation candidate has `Conf_final < 0.65`, the context-evalver shall suppress it entirely with no output.
4. The context-evalver shall record `last_suggested_at` for each proposed recommendation by kind and target.
5. If a recommendation of the same kind and target was proposed within the last 7 days, the context-evalver shall not re-propose it unless its `Conf_final` has increased by at least 0.15 since the last proposal.

---

### Requirement 8: `/context-audit` Command

**Objective:** As a developer, I want to run `/context-audit` to see a read-only analysis of behavioral patterns in my repository, so that I understand what the system has observed without risking unintended changes.

#### Acceptance Criteria

1. When a user invokes `/context-audit`, the context-evalver shall send a `query_signals` request to the Rust core with the current `repo_root` and configured `window_days`.
2. When the signal summary is received, the context-evalver shall generate a Markdown report containing: data sufficiency status, observed signals (files, errors, command sequences), confidence-scored recommendation candidates, and a recommendation summary.
3. When the data sufficiency gate fails, the context-evalver shall output an "insufficient evidence" section specifying the shortfall (e.g., "Only 1 session analyzed").
4. The context-evalver shall not modify any repository files when `/context-audit` is invoked.
5. When no candidates exceed the 0.65 confidence threshold, the context-evalver shall output a clear "No actionable recommendations" message.

---

### Requirement 9: `/context-draft` Command

**Objective:** As a developer, I want to run `/context-draft` to generate concrete, reviewable patch proposals from high-confidence signals, so that I can evaluate improvements before applying them.

#### Acceptance Criteria

1. When a user invokes `/context-draft`, the context-evalver shall first query signals and verify at least one draftable candidate (`Conf_final >= 0.80`) exists.
2. If no draftable candidates exist, the context-evalver shall instruct the user to run `/context-audit` first and explain why no draft is available.
3. The context-evalver shall construct a structured signal summary and send it to the LLM with a prompt contract requiring: use of provided signals only, no hallucination, structured Markdown output with rationale, and diff-ready sections.
4. When the LLM responds, the context-evalver shall produce unified diff blocks for: CLAUDE.md additions, Skill definition files (`.claude/skills/`), and slash command definition files (`.claude/commands/`).
5. The context-evalver shall not auto-write any files when `/context-draft` is invoked; all output is display-only.
6. The context-evalver shall present each patch with its recommendation kind, confidence score, severity, and evidence count.

---

### Requirement 10: `/context-apply` Command

**Objective:** As a developer, I want to run `/context-apply` to apply reviewed patches to my repository with explicit confirmation, so that context improvements are applied safely and traceably.

#### Acceptance Criteria

1. When a user invokes `/context-apply`, the context-evalver shall display the pending patches and require explicit user confirmation before writing any files.
2. When the user confirms, the context-evalver shall apply each patch to the target file, creating the file if it does not exist.
3. When patches are applied, the context-evalver shall display the resulting `git diff` of all changed files.
4. Where `auto_pr` is set to `false` in configuration, the context-evalver shall not create a git commit or pull request unless the user explicitly requests it.
5. Where `auto_pr` is set to `true`, the context-evalver shall create a git commit with a descriptive message and optionally open a pull request.
6. The context-evalver shall never overwrite existing file content without displaying the diff and receiving user confirmation.
7. If a file write fails, the context-evalver shall report the specific file path, the error reason, and leave all other successfully written files in place.

---

### Requirement 11: Secondary Commands

**Objective:** As a developer, I want lightweight utility commands to inspect and manage the plugin's state, so that I can operate it effectively during daily development.

#### Acceptance Criteria

1. When a user invokes `/context-status`, the context-evalver shall display a summary including: sessions analyzed, strong signal count, draftable recommendation count, and days since last optimization.
2. When a user invokes `/context-reset`, the context-evalver shall clear all confidence history and suggestion throttling records for the current repository after explicit user confirmation.
3. When a user invokes `/context-config`, the context-evalver shall display all current configuration values from `.context-evalver.json` in a readable format.
4. The context-evalver shall not require the Rust core to be queried for `/context-config`; it shall read configuration from the local file only.

---

### Requirement 12: Configuration Management

**Objective:** As a developer, I want to configure the plugin's behavior via a project-level JSON file, so that thresholds and analysis parameters are tunable per repository.

#### Acceptance Criteria

1. The context-evalver shall read configuration from `.context-evalver.json` in the repository root at startup and before each command invocation.
2. The context-evalver shall support the following configuration fields: `analysis_window_days` (default: 30), `min_sessions` (default: 3), `min_repeat_threshold` (default: 3), `min_confidence_score` (default: 0.7), `exclude_paths` (default: `["node_modules", ".git"]`), `auto_pr` (default: false).
3. If `.context-evalver.json` does not exist, the context-evalver shall use all default values and continue operating normally.
4. If a configuration field contains an invalid value, the context-evalver shall fall back to the default for that field and log a warning.
5. The context-evalver shall pass the `min_repeat_threshold` and `analysis_window_days` values to the Rust core in each `query_signals` request.

---

### Requirement 13: Security and Privacy

**Objective:** As a developer, I want the plugin to handle session data safely without capturing sensitive information, so that secrets and private data are never persisted.

#### Acceptance Criteria

1. The context-evalver shall never log the full content of any file, only file paths and access metadata.
2. The context-evalver shall mask environment variable values before persisting any event payload; only variable names may be recorded.
3. The context-evalver shall exclude files and directories matching the `exclude_paths` configuration list from all capture and analysis.
4. If the event payload contains patterns matching common secret formats (e.g., API keys, tokens), the context-evalver shall replace the matched value with `[REDACTED]` before persistence.
5. The context-evalver shall allow per-repository opt-out by detecting a `.context-evalver-ignore` file in the repository root, disabling all event capture for that repository.

---

### Requirement 14: Performance

**Objective:** As a developer, I want the plugin to have negligible runtime overhead, so that Claude Code's responsiveness is not affected during my sessions.

#### Acceptance Criteria

1. The context-evalver shall complete the full event capture and IPC send cycle in less than 5 milliseconds per event under normal operating conditions.
2. The context-evalver TypeScript layer shall send events to the Rust core asynchronously without awaiting acknowledgment on the hot path.
3. The context-evalver Rust core shall batch event writes and commit to SQLite every 50 events or 100 milliseconds, whichever threshold is reached first.
4. The context-evalver Rust core shall use prepared statements for all database queries and inserts to minimize query planning overhead.
5. The context-evalver Rust core shall restrict all analytical queries to the configured `analysis_window_days` time window to avoid full-table scans over unbounded historical data.
6. While the Rust core is processing a signal query, the context-evalver TypeScript layer shall remain responsive to new events and Claude Code hook callbacks.
