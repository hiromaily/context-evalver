# context-optimizer (plugin)

TypeScript Claude Code plugin that observes developer session behavior and proposes evidence-based context improvements for `CLAUDE.md`, skills, and slash commands.

This plugin is the TypeScript layer of the context-optimizer system. It integrates with Claude Code via hooks and user-invocable skills, delegates signal analysis to the [Rust core daemon](../core/README.md), and presents actionable patch proposals.

## How It Works

```
Claude Code hooks → Event Capture → IPC Client → Rust daemon (SQLite + signal analysis)
                                                        ↓
                             /context-audit → read-only signal report
                             /context-draft → LLM-generated patch proposals (staging file)
                             /context-apply → apply staged patches to disk
```

On **SessionStart**, the plugin spawns the Rust daemon as a detached background process. During the session, each tool use (`Read`, `Edit`, `Write`, `Bash`) and error response is captured and forwarded to the daemon via Unix socket IPC. On **SessionEnd**, buffered events are flushed and the daemon is shut down.

## Skills (User-Invocable Commands)

| Command | Description |
|---------|-------------|
| `/context-audit` | Query signals and display a read-only evidence report — no files written |
| `/context-draft` | Generate unified-diff patch proposals from high-confidence signals (≥ 0.80) |
| `/context-apply` | Apply staged patches from `/context-draft` after explicit confirmation |
| `/context-status` | Display current optimizer status (gate result, signal counts, daemon state) |
| `/context-reset` | Reset throttle history so previously suppressed signals can re-surface |
| `/context-config` | Display the active configuration merged with defaults |

### Typical workflow

```
/context-audit   # review what signals have been collected
/context-draft   # generate patch proposals (requires sufficient sessions)
/context-apply   # apply the diffs after reviewing them
```

## Source Modules

| Module | Responsibility |
|--------|---------------|
| `hook-dispatcher.ts` | Session lifecycle hooks: spawn daemon on start, capture events per tool use, flush + shutdown on end |
| `event-capture.ts` | Derive sanitized `CapturedEvent` objects from raw hook payloads; redact secrets; normalize error messages |
| `ipc-client.ts` | Unix socket JSONL client — `sendEvent`, `sendFlush`, `sendShutdown`, `querySignals` |
| `config-loader.ts` | Load and validate `.context-optimizer.json`; merge with defaults |
| `patch-generator.ts` | Build LLM prompts, parse `<!-- PATCH -->` blocks into unified diffs, generate audit/draft reports, persist staging files |
| `context-audit.ts` | `/context-audit` skill entry point |
| `context-draft.ts` | `/context-draft` skill entry point |
| `context-apply.ts` | `/context-apply` skill entry point |
| `context-status.ts` | `/context-status` skill entry point |
| `context-reset.ts` | `/context-reset` skill entry point |
| `context-config.ts` | `/context-config` skill entry point |

## Configuration

Place `.context-optimizer.json` in your repository root. All fields are optional — missing or invalid values fall back to defaults.

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

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `analysis_window_days` | integer | `30` | Lookback window for signal queries |
| `min_sessions` | integer | `3` | Minimum distinct sessions required per signal |
| `min_repeat_threshold` | integer | `3` | Minimum repetitions to surface a signal |
| `min_confidence_score` | float 0–1 | `0.7` | Minimum confidence to display a candidate |
| `exclude_paths` | string[] | `["node_modules", ".git"]` | Path segments to exclude from file-access capture |
| `auto_pr` | boolean | `false` | Auto-create a git commit after `/context-apply` |

To opt a repository out of all monitoring entirely, create `.context-optimizer-ignore` in its root.

## Event Capture

The plugin captures four event kinds from Claude Code hook payloads:

| Kind | Hook | Source |
|------|------|--------|
| `file_read` | `PreToolUse` | `Read` tool `file_path` |
| `file_write` | `PreToolUse` | `Edit` / `Write` tool `file_path` |
| `command` | `PreToolUse` | `Bash` tool `command` (secrets redacted) |
| `error` | `PostToolUse` | Tool response with `is_error: true` (message normalized) |

**Secret redaction** strips AWS access keys, GitHub tokens (`ghp_`, `ghs_`, etc.), and `KEY=value` environment variable assignments before forwarding commands to the daemon.

## Build

```bash
bun install
bun run build    # compiles src/index.ts → dist/ (ESM + .d.ts)
```

## Development

```bash
bun run test        # run all tests (vitest)
bun run test:watch  # watch mode
bun run check       # biome lint + format check
bun run lint        # biome lint --write
bun run format      # biome format --write
```

## Project Structure

```
plugin/
├── src/                    # TypeScript source
├── tests/                  # Vitest test suites (328 tests)
├── skills/                 # Claude Code skill definitions (SKILL.md)
│   ├── context-audit/
│   ├── context-draft/
│   ├── context-apply/
│   ├── context-status/
│   ├── context-reset/
│   └── context-config/
├── .claude-plugin/
│   └── plugin.json         # Plugin manifest
├── dist/                   # Compiled output (generated)
└── package.json
```

## Dependencies

All dependencies are dev-only (the plugin runs as compiled JS):

| Package | Purpose |
|---------|---------|
| `typescript` | Type checking and compilation |
| `tsup` | ESM bundle + type declaration generation |
| `vitest` | Test runner |
| `@biomejs/biome` | Linter and formatter |
