---
layout: home

hero:
  name: context-evalver
  text: Evidence-based context improvements for Claude Code
  tagline: Passively observes your development sessions and proposes targeted improvements to CLAUDE.md, Skills, and slash commands — backed by real behavioral data.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/hiromaily/context-evalver

features:
  - title: Passive Observation
    details: Hooks into Claude Code's event system to capture file accesses, errors, and command patterns without interrupting your workflow.
  - title: Evidence-Based
    details: Only surfaces recommendations backed by statistical confidence. A data-sufficiency gate prevents premature suggestions.
  - title: Three-Command Workflow
    details: Audit signals with /context-audit, generate patches with /context-draft, then apply with /context-apply.
---

## How It Works

```
Claude Code sessions
        │  hook events (file access, errors, commands)
        ▼
TypeScript Plugin   ←──── six user-facing skills
        │  JSONL / Unix socket
        ▼
Rust Core Daemon
        │  SQLite (per-repository)
        ▼
Signal extraction → confidence scoring → patch proposals
```

The daemon accumulates behavioral data across sessions. Once enough evidence exists, `/context-audit` surfaces patterns and `/context-draft` generates concrete unified-diff patches you can review and apply.

## Quick Start

```bash
# 1. Build the Rust daemon
cd core && cargo build --release

# 2. Build the plugin
cd plugin && bun install && bun run build

# 3. Register with Claude Code (edit ~/.claude/settings.json)
# 4. Run /context-config to verify setup
```

See [Getting Started](/getting-started) for full instructions.
