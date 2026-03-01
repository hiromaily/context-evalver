# Architecture — context-optimizer

context-optimizer is a **hybrid TypeScript + Rust** Claude Code plugin that observes developer session behavior, extracts recurring patterns, and proposes evidence-based improvements to `CLAUDE.md`, skills, and slash commands.

## System Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Claude Code Runtime                  │
│                                                         │
│  Hooks: SessionStart / PreToolUse / PostToolUse /       │
│         UserPromptSubmit / SessionEnd                   │
└──────────────────────┬──────────────────────────────────┘
                       │ hook payloads (JSON via stdin)
                       ▼
┌─────────────────────────────────────────────────────────┐
│              TypeScript Plugin Layer (plugin/)          │
│                                                         │
│  • Event capture & secret redaction                     │
│  • Config loading (.context-optimizer.json)             │
│  • IPC client (Unix socket JSONL)                       │
│  • Patch generation & LLM prompt building               │
│  • User-facing skills: /context-audit, /context-draft,  │
│    /context-apply, /context-status, /context-reset,     │
│    /context-config                                      │
└──────────────────────┬──────────────────────────────────┘
                       │ JSONL over Unix domain socket
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Rust Core Daemon (core/)                   │
│                                                         │
│  • Event ingestion & buffering (50 events / 100 ms)     │
│  • SQLite persistence (WAL, 5 tables)                   │
│  • Signal extraction (files, errors, sequences)         │
│  • Data-sufficiency gate                                │
│  • Confidence scoring & throttle suppression            │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
              ~/.local/share/context-optimizer/
              ├── {session_id}.sock   ← Unix socket
              └── db/{hash}.db        ← SQLite database
```

## Repository Layout

```
context-optimizer/
├── core/                        # Rust daemon
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs              # CLI entry, socket/DB init, flush thread
│       ├── ipc_server.rs        # Unix socket JSONL server, message dispatch
│       ├── store.rs             # SQLite schema, batch inserts, windowed queries
│       ├── ingestor.rs          # Event buffer with dual-trigger flushing
│       ├── signal_extractor.rs  # Pattern detection, data-sufficiency gate
│       └── confidence_scorer.rs # Per-kind confidence formulas, throttle logic
│
├── plugin/                      # TypeScript plugin
│   ├── src/
│   │   ├── index.ts             # Plugin manifest exports
│   │   ├── hook-dispatcher.ts   # SessionStart/PerEvent/SessionEnd handlers
│   │   ├── event-capture.ts     # Hook payload → CapturedEvent conversion
│   │   ├── ipc-client.ts        # IpcClient: sendEvent, querySignals, flush, shutdown
│   │   ├── config-loader.ts     # .context-optimizer.json loading with defaults
│   │   ├── patch-generator.ts   # LLM prompt building, diff parsing, staging file I/O
│   │   ├── context-audit.ts     # /context-audit skill entry point
│   │   ├── context-draft.ts     # /context-draft skill entry point
│   │   ├── context-apply.ts     # /context-apply skill entry point
│   │   ├── context-status.ts    # /context-status skill entry point
│   │   ├── context-reset.ts     # /context-reset skill entry point
│   │   └── context-config.ts    # /context-config skill entry point
│   ├── skills/                  # Claude Code SKILL.md definitions
│   ├── tests/                   # Vitest test suites
│   ├── .claude-plugin/
│   │   └── plugin.json          # Plugin manifest
│   └── package.json
│
└── docs/                        # Design documents and specs
```

## Component Responsibilities

### TypeScript Plugin Layer

**Boundary**: Claude Code hook interface ↔ Rust daemon IPC

| Module | Responsibility |
|--------|---------------|
| `hook-dispatcher.ts` | Spawn daemon on `SessionStart`; forward events per tool use; flush + shutdown on `SessionEnd` |
| `event-capture.ts` | Convert raw hook payloads to typed `CapturedEvent`; redact secrets; normalize error messages |
| `ipc-client.ts` | Fire-and-forget `sendEvent`; request-response `querySignals`; `sendFlush`, `sendShutdown`, `sendReset` |
| `config-loader.ts` | Read `.context-optimizer.json`, validate each field, merge with defaults — never throws |
| `patch-generator.ts` | Build structured LLM prompts; parse `<!-- PATCH -->` blocks into unified diffs; persist staging files |
| Skill entry points | Each skill reads `session_id`/`cwd` from context, loads config, calls IPC, renders output |

**Design constraints**: The TypeScript layer must not block the Claude Code runtime. All IPC is fire-and-forget or Promise-based without blocking the hook return.

### Rust Core Daemon

**Boundary**: Unix socket ↔ SQLite on disk

| Module | Responsibility |
|--------|---------------|
| `main.rs` | Parse CLI args (`--session-id`, `--repo-root`); initialize store + ingestor + IPC server; run background flush thread; handle SIGTERM/SIGINT |
| `ipc_server.rs` | Accept JSONL connections; dispatch `event`, `flush`, `query_signals`, `shutdown`, `reset` messages |
| `store.rs` | 5-table SQLite schema; batch transactional inserts; windowed queries; throttle record upserts |
| `ingestor.rs` | In-memory buffer; flush at 50-event threshold or 100 ms interval; atomic DB transactions |
| `signal_extractor.rs` | Detect repeated file access, error patterns, command sequences; evaluate data-sufficiency gate |
| `confidence_scorer.rs` | Compute per-kind confidence scores; apply throttle suppression; assign severity; return `SignalSummary` |

**Design constraints**: The daemon is a long-lived process per session. All DB writes are batched. Per-event overhead must be < 5 ms.

## IPC Protocol

**Transport**: Unix domain socket at `~/.local/share/context-optimizer/{session_id}.sock`
**Format**: Newline-delimited JSON (JSONL) over `SOCK_STREAM`

### Message Flow

```
Plugin (client)                          Daemon (server)
      │                                        │
      │── {"type":"event", "event":{...}} ────▶│  fire-and-forget
      │                                        │
      │── {"type":"flush"} ───────────────────▶│
      │◀─ {"type":"ack", "ok":true} ───────────│
      │                                        │
      │── {"type":"query_signals", ...} ───────▶│
      │◀─ {"type":"signal_summary", ...} ───────│
      │                                        │
      │── {"type":"shutdown"} ─────────────────▶│  daemon exits
```

### Event Kinds Captured

| Kind | Hook | Trigger |
|------|------|---------|
| `file_read` | `PreToolUse` | `Read` tool |
| `file_write` | `PreToolUse` | `Edit` or `Write` tool |
| `command` | `PreToolUse` | `Bash` tool (secrets redacted) |
| `error` | `PostToolUse` | Tool response with `is_error: true` |

## Signal Pipeline

```
Raw events (SQLite)
        │
        ▼
Signal Extraction
  ├── Repeated file access   (≥ threshold accesses, ≥ 2 sessions)
  ├── Repeated error pattern (≥ threshold occurrences, normalized)
  └── Repeated command sequence (sliding window 2–4, xxh3 hashed)
        │
        ▼
Data-Sufficiency Gate  (any condition must pass)
  ├── S ≥ 5 sessions, OR
  ├── S ≥ 3 AND E ≥ 200 events, OR
  └── R ≥ 1 strong signal
        │
        ▼
Confidence Scoring  (per-kind formula)
  score = f(count, spread, day_coverage, recency) × data_factor
        │
        ▼
Throttle Filter
  suppress if: suggested within 7 days AND confidence gain < 0.15
        │
        ▼
SignalSummary  →  TypeScript plugin  →  User
```

### Confidence Thresholds

| Threshold | Value | Effect |
|-----------|-------|--------|
| `CONF_SUPPRESS_THRESHOLD` | 0.65 | Minimum score to return a candidate |
| `CONF_DRAFTABLE_THRESHOLD` | 0.80 | Candidate eligible for `/context-draft` |
| `THROTTLE_WINDOW_SECS` | 7 days | Suppress re-suggestion within window |
| `THROTTLE_CONF_DELTA` | 0.15 | Min confidence improvement to override throttle |

## Skill Workflow

```
/context-audit
  └── querySignals → render Markdown report (read-only)

/context-draft
  └── querySignals → filter draftable (≥ 0.80) → build LLM prompt
      → parse unified diffs → display → save drafts/{session_id}.json

/context-apply
  └── load drafts/{session_id}.json → display patches → confirm
      → write files → git diff → [optional: git commit] → delete staging file
```

## Data Storage

All persistent state lives under `~/.local/share/context-optimizer/` (or `$XDG_DATA_HOME/context-optimizer/`).

| Path | Contents |
|------|----------|
| `{session_id}.sock` | Unix socket for active session |
| `db/{xxh3(repo_root)}.db` | Per-repository SQLite database |
| `drafts/{session_id}.json` | Staging file written by `/context-draft`, consumed by `/context-apply` |

### SQLite Schema (5 tables)

| Table | Purpose |
|-------|---------|
| `sessions` | Session metadata (id, repo_root, branch, timestamps) |
| `events` | Complete event log (normalized; source of truth) |
| `file_access` | Denormalized file access rows for fast signal queries |
| `errors` | Denormalized normalized error messages |
| `throttle_records` | Per-kind suppression state (last suggested, last confidence) |

Denormalization on write (event → `file_access` / `errors`) keeps signal queries O(1) without full-table scans.

## Security

- **No file contents logged** — only paths and tool names
- **Secret redaction** — AWS keys, GitHub tokens, `KEY=value` env assignments stripped before storing commands
- **Error normalization** — file paths and line numbers stripped from error messages before storage
- **Opt-out** — create `.context-optimizer-ignore` in a repository root to disable all monitoring for that repo
- **Exclude paths** — configurable `exclude_paths` list prevents capturing events for specified path segments (e.g. `node_modules`, `.git`)

## Technology Choices

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Plugin runtime | TypeScript (ESM) | Native Claude Code plugin interface |
| Build | tsup | Fast ESM + `.d.ts` bundling |
| Test | Vitest | Fast, ESM-native, compatible with bun |
| Lint/format | Biome | Rust-based, single tool for lint + format |
| Package manager | bun | Fast install and script execution |
| Core daemon | Rust (edition 2024) | Low latency, memory safety, bundled SQLite |
| Persistence | rusqlite (bundled) | No external SQLite dependency; WAL mode |
| Hashing | xxhash-rust (xxh3) | Fast non-cryptographic hash for DB path derivation |
| IPC | Unix domain socket + JSONL | Low latency local transport; human-debuggable format |
