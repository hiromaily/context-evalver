# Getting Started

## Prerequisites

Before installing context-evalver, ensure you have:

- **Rust toolchain** — [rustup.rs](https://rustup.rs) (edition 2024, stable)
- **Bun** — [bun.sh](https://bun.sh) v1.0 or later
- **Claude Code** — the Claude CLI with plugin support

## 1. Build the Rust Daemon

The core daemon is a long-lived process that handles event ingestion, storage, and signal analysis.

```bash
cd core
cargo build --release
```

The compiled binary is at `core/target/release/context-evalver-core`. Copy or symlink it to a location on your `$PATH`:

```bash
# Example — adjust path to match your preference
cp core/target/release/context-evalver-core ~/.local/bin/context-evalver-core
```

## 2. Build the Plugin

```bash
cd plugin
bun install
bun run build
```

This produces `plugin/dist/index.js` and individual skill entry points (`dist/context-audit.js`, etc.).

## 3. Register with Claude Code

Edit `~/.claude/settings.json` to add the hooks and register the plugin manifest.

### Add hooks

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/plugin/dist/index.js SessionStart"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/plugin/dist/index.js PreToolUse"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/plugin/dist/index.js PostToolUse"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/plugin/dist/index.js SessionEnd"
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/plugin` with the absolute path to the `plugin/` directory.

### Register the plugin manifest

Add the plugin directory to Claude Code's plugin search path in `~/.claude/settings.json`:

```json
{
  "pluginPaths": ["/path/to/plugin"]
}
```

The plugin manifest at `plugin/.claude-plugin/plugin.json` is automatically discovered.

## 4. Verify Setup

Start a new Claude Code session and run:

```
/context-config
```

This displays the active configuration table. If the command is recognized and returns a table, the plugin is installed correctly.

## 5. Optional: Create a Config File

To customize behavior, create `.context-evalver.json` in your repository root:

```json
{
  "analysis_window_days": 30,
  "min_sessions": 3,
  "min_repeat_threshold": 3,
  "min_confidence_score": 0.7,
  "exclude_paths": ["node_modules", ".git", "dist"],
  "auto_pr": false
}
```

All fields are optional — omitted fields use their defaults. See [Configuration](/configuration) for the full reference.

## Opt-Out

To disable monitoring for a specific repository, create an empty file at the repository root:

```bash
touch .context-evalver-ignore
```

The plugin will not log any events for that repository.

## Next Steps

- Read [Concepts](/concepts) to understand signals, the gate, and confidence scoring
- Follow the [Daily Workflow](/daily-workflow) guide
- Use `/context-status` after a few sessions to check data collection progress
