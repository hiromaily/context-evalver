# context-optimizer

**[Documentation](https://hiromaily.github.io/context-evalver/)** · [Architecture](./ARCHITECTURE.md)

A Claude Code plugin that silently observes your development sessions, identifies recurring behavioral patterns, and proposes concrete improvements to your `CLAUDE.md`, skills, and slash commands — backed by statistical evidence rather than guesswork.

## What It Does

As you work, the plugin captures which files you open repeatedly, which errors keep recurring, and which command sequences you run over and over. After enough sessions, it surfaces statistically significant patterns and lets you turn them into durable context artifacts with a three-command workflow:

```
/context-audit   → review collected signals (read-only report)
/context-draft   → generate unified-diff patch proposals via LLM
/context-apply   → apply the diffs after explicit confirmation
```

## How It Works

The system is a **hybrid TypeScript + Rust** plugin:

- The **TypeScript layer** integrates with Claude Code hooks, captures and sanitizes events, and provides user-facing skills.
- The **Rust daemon** runs as a background process per session, persisting events to SQLite and computing confidence-scored recommendations via signal extraction.

```
Claude Code hooks → TypeScript plugin → Unix socket (JSONL) → Rust daemon → SQLite
                                                                     ↓
                         /context-audit / /context-draft / /context-apply
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

## Skills

| Skill | Description |
|-------|-------------|
| `/context-audit` | Read-only signal report — no files written |
| `/context-draft` | Generate patch proposals from high-confidence signals (≥ 0.80) |
| `/context-apply` | Apply staged patches after explicit confirmation |
| `/context-status` | Show optimizer status: gate result, signal counts, daemon state |
| `/context-reset` | Reset throttle history so suppressed signals can re-surface |
| `/context-config` | Display the active configuration merged with defaults |

## Signal Types

| Signal | What triggers it | Recommendation |
|--------|-----------------|----------------|
| Repeated file access | Same file opened frequently across sessions | Add to `CLAUDE.md` |
| Repeated error pattern | Same error appearing across sessions | Add troubleshooting section to `CLAUDE.md` |
| Repeated command sequence | Same 2–4 command sequence repeated across sessions | Create a new skill or slash command |

Recommendations require a minimum confidence score (default 0.70) and pass through a data-sufficiency gate before surfacing.

## Configuration

Place `.context-optimizer.json` in your repository root:

```json
{
  "analysis_window_days": 30,
  "min_sessions": 3,
  "min_repeat_threshold": 3,
  "min_confidence_score": 0.7,
  "exclude_paths": ["node_modules", ".git"],
  "auto_pr": false
}
```

All fields are optional — missing or invalid values fall back to defaults. To disable monitoring for a specific repository, create a `.context-optimizer-ignore` file in its root.

## Project Structure

```
context-optimizer/
├── core/       Rust daemon — SQLite persistence, signal extraction, confidence scoring
├── plugin/     TypeScript plugin — Claude Code hooks, IPC client, skills, patch generation
├── docs/       Design documents and specifications
├── ARCHITECTURE.md
└── README.md
```

- [core/README.md](./core/README.md) — Rust daemon internals, IPC protocol, build instructions
- [plugin/README.md](./plugin/README.md) — TypeScript plugin modules, skills, dev workflow

## Building

### Rust core

```bash
cd core
cargo build --release
# binary: core/target/release/context-optimizer-core
```

### TypeScript plugin

```bash
cd plugin
bun install
bun run build
# output: plugin/dist/
```

## Testing

```bash
# Rust unit + integration tests
cd core && cargo test

# TypeScript tests (328 tests, vitest)
cd plugin && bun run test
```

## Security

- **No file contents are logged** — only file paths and tool names
- **Secrets are redacted** from commands before storage (AWS keys, GitHub tokens, `KEY=value` assignments)
- **Error messages are normalized** — file paths and line numbers stripped before storage
- **Opt-out per repository** — create `.context-optimizer-ignore` to disable all capture
- **Exclude paths** — configure `exclude_paths` to skip specific directories
