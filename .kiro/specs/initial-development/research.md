# Research & Design Decisions

---

**Purpose**: Capture discovery findings, architectural investigations, and rationale that inform the technical design.

---

## Summary

- **Feature**: `initial-development`
- **Discovery Scope**: New Feature (greenfield) / Complex Integration
- **Key Findings**:
  - Claude Code plugins are **file-system based** (no compiled SDK). Hooks are shell commands spawned per event; there is no persistent TypeScript process within the plugin lifecycle.
  - The original spec's "JSONL over stdio" IPC model requires a **persistent Rust daemon** (started by `SessionStart` hook) because per-event process spawning takes 10–50ms — violating the <5ms overhead requirement.
  - The TypeScript layer is composed of compiled Node.js scripts called by hook handlers and command skills, not a long-running server process.
  - `rusqlite 0.38.0` (bundled, sync) is the right SQLite crate for a synchronous I/O process; `sqlx` adds async runtime overhead with no benefit here.
  - `xxhash-rust 0.8.15` with `xxh3` feature provides the fastest sliding-window hashing for command sequences.
  - Biome 2.4 handles TypeScript linting and formatting with type-aware rules, replacing the need for `tsc` in CI lint passes.

---

## Research Log

### Claude Code Plugin Architecture

- **Context**: Need to understand how TypeScript/Node.js code integrates with Claude Code hooks and commands.
- **Sources Consulted**:
  - Official Anthropic Claude Code plugin docs (code.claude.com/docs)
  - Claude Code hooks reference and guide
  - Plugin structure reference
- **Findings**:
  - Plugins are directories, not npm packages. Manifest is at `.claude-plugin/plugin.json`.
  - Hooks registered in `hooks/hooks.json` as shell commands: `{"type": "command", "command": "node scripts/on-tool.js"}`.
  - Each hook invocation spawns a fresh process; there is no shared in-process state.
  - Hook stdin receives a JSON object with `session_id`, `cwd`, `hook_event_name`, and event-specific fields.
  - `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, `SessionEnd` are all relevant hook types.
  - Commands/Skills: SKILL.md files in `skills/<name>/SKILL.md` with frontmatter `description`. Namespaced as `<plugin-name>:<skill-name>`.
  - `CLAUDE_PLUGIN_ROOT` env var is available in hook scripts.
  - `CLAUDE_ENV_FILE` (SessionStart only) allows persisting env vars across the session.
- **Implications**: The TypeScript layer cannot be a persistent process directly; it must communicate with the Rust daemon via a Unix domain socket. The SessionStart hook starts the daemon; other hooks connect to it.

### Process Lifecycle and IPC Strategy

- **Context**: <5ms event overhead requirement conflicts with per-event process spawning.
- **Findings**:
  - Spawning a new process per event costs ~10–50ms on macOS/Linux.
  - Unix domain sockets have <0.1ms connection setup time on localhost.
  - Named pipes are an alternative but Unix sockets are more ergonomic.
  - The `CLAUDE_ENV_FILE` mechanism can store the socket path so all subsequent hooks know where to connect.
- **Implications**: Rust binary runs as a background daemon process, started once per session by `SessionStart` hook. Socket path written to `CLAUDE_ENV_FILE` for pickup by all subsequent hooks. `SessionEnd` / `Stop` hooks signal the daemon to flush and optionally shut down.

### Rust SQLite Crate Selection

- **Context**: Need WAL mode, prepared statements, batched writes in a synchronous Rust binary.
- **Sources Consulted**: crates.io, docs.rs for rusqlite, sqlx
- **Findings**:
  - `rusqlite 0.38.0`: synchronous, bundled SQLite 3.51.1, `prepare_cached`, `Connection::transaction()`, WAL pragma support. No async runtime required.
  - `sqlx 0.8.6`: async-first; requires tokio or async-std runtime. Heavier binary, unnecessary complexity.
- **Implications**: Use `rusqlite 0.38.0` with `features = ["bundled"]`. Wrap batch writes in a transaction for 10–100× throughput improvement over auto-commit mode.

### Command Sequence Hashing

- **Context**: Need fast, deterministic hashing of sliding windows of command strings.
- **Sources Consulted**: crates.io for xxhash-rust, twox-hash
- **Findings**:
  - `xxhash-rust 0.8.15` with `xxh3` feature: incremental `Xxh3::new()` + `update(&[u8])` + `digest() -> u64`. `reset()` for reuse.
  - `twox-hash 2.1.2`: implements std `Hasher` trait, slightly more idiomatic but same speed.
- **Selected**: `xxhash-rust 0.8.15` with `xxh3` — lower overhead, explicit reset, no dependency on std Hasher trait.

### TypeScript Toolchain

- **Context**: Spec requires Rust-based TypeScript linter/formatter.
- **Findings**:
  - Biome 2.4 (March 2026): single binary, lints + formats + organizes imports. Type-aware rules (`noFloatingPromises`) without needing `tsc`. `biome check --write` for combined pass.
  - No other Rust-based TS tool is in common use.
- **Implications**: Use `@biomejs/biome 2.4` as dev dependency. No ESLint or Prettier needed.

---

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Ephemeral scripts (per-event spawn) | Hook handler spawns Rust binary each time | Simple deployment | 10–50ms spawn cost violates <5ms requirement | Rejected |
| Persistent daemon via Unix socket | SessionStart starts Rust daemon; hooks connect via socket | <1ms connection overhead; persistent batch buffer | Daemon lifecycle management needed | **Selected** |
| Node.js long-running process with Rust child | Node.js parent spawns Rust via stdio | Matches original JSONL-over-stdio spec text | No persistent Node.js process in plugin hooks | Rejected — no persistent TS process in Claude Code hooks |
| TCP socket daemon | Same as Unix socket but over loopback TCP | Cross-platform | Higher overhead, no auth | Rejected in favor of Unix socket |

---

## Design Decisions

### Decision: Rust Daemon via Unix Domain Socket

- **Context**: <5ms overhead requirement cannot be met by spawning a new process per hook event.
- **Alternatives Considered**:
  1. Per-event Rust spawn — rejected (too slow)
  2. TCP loopback — rejected (higher overhead than Unix socket)
  3. Named pipe — considered; Unix socket preferred for ergonomics
- **Selected Approach**: `SessionStart` hook starts the Rust binary as a background process. Socket path is `~/.local/share/context-evalver/{session_id}.sock`. Path is written to `CLAUDE_ENV_FILE` so all subsequent hooks inherit it as `CONTEXT_OPTIMIZER_SOCKET`.
- **Rationale**: Unix socket connection is <0.1ms; fire-and-forget write is <1ms total. Stays well within 5ms budget.
- **Trade-offs**: Daemon must be managed (start/stop/crash recovery). `SessionEnd` hook sends `{"type": "flush"}` and `{"type": "shutdown"}` messages.
- **Follow-up**: Implement daemon health check in hook scripts; if socket not found, log warning and skip event.

### Decision: rusqlite over sqlx

- **Context**: Simplicity and synchronous I/O in the Rust daemon.
- **Selected Approach**: `rusqlite 0.38.0` with bundled SQLite and synchronous API.
- **Rationale**: No async runtime needed; lower binary size; `prepare_cached` and transaction batching provide all needed performance features.
- **Trade-offs**: No compile-time SQL verification (sqlx macro). Mitigated by integration tests.

### Decision: TypeScript Hook Scripts (Compiled JS) as Plugin Entry Points

- **Context**: Claude Code hooks are shell commands. TypeScript must compile to JS.
- **Selected Approach**: TypeScript source compiled to `dist/` by `tsc` or `tsup`. Hook handlers reference `node dist/hooks/<name>.js`. Commands invoke `node dist/commands/<name>.js`.
- **Rationale**: Keeps TypeScript type safety; no interpreted TS overhead at runtime.
- **Trade-offs**: Requires build step before plugin use. Mitigated by including `dist/` in the plugin directory.

### Decision: Confidence Scoring in Rust, Markdown Generation in TypeScript

- **Context**: Where to place confidence computation logic.
- **Selected Approach**: All numerical scoring (Sat, Spread, DayCoverage, Recency, DataFactor, kind-specific Conf) computed in Rust. TypeScript receives `signal_summary` with pre-computed `confidence`, `severity`, `evidence_count` per candidate. TypeScript only renders Markdown and generates diffs.
- **Rationale**: Deterministic computation stays in the strongly typed, tested Rust layer. TypeScript handles presentation only. LLM prompting is TypeScript-side since it requires API access.

---

## Risks & Mitigations

- **Daemon crash recovery**: If the Rust daemon crashes mid-session, events are lost. Mitigation: hook scripts check socket availability; log warning on failure; optional auto-restart via `SessionStart`-registered launchd/systemd watch.
- **SQLite contention**: WAL mode allows one writer. If two sessions write to the same DB file simultaneously, the second waits on `busy_timeout`. Mitigation: per-session WAL DB in `~/.local/share/context-evalver/db/{repo_hash}.db` with 5s busy timeout.
- **Secret leakage**: Hook event payloads may contain env var values or command arguments with tokens. Mitigation: TypeScript sanitizer runs before IPC send; regex-based `[REDACTED]` replacement.
- **Biome false positives in generated code**: Mitigation: add `dist/` to `.biomeignore`.

---

## References

- [Claude Code Plugin Docs](https://code.claude.com/docs/en/plugins) — plugin structure and manifest
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) — hook types, payloads, control output
- [rusqlite docs.rs](https://docs.rs/rusqlite/latest/rusqlite/) — WAL, prepared statements, transactions
- [xxhash-rust GitHub](https://github.com/DoumanAsh/xxhash-rust) — Xxh3 API reference
- [Biome v2 release](https://biomejs.dev/blog/biome-v2/) — type-aware rules, config format
- [serde_json crates.io](https://crates.io/crates/serde_json) — version 1.0.149
