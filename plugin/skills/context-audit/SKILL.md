---
description: Query behavioral signals and display a read-only evidence report (no file writes).
disable-model-invocation: true
---

# context-audit

Queries the Rust daemon for accumulated behavioral signals from past sessions, runs the data sufficiency gate, and renders a Markdown report showing repeated-file accesses, error loops, and command-sequence patterns with per-candidate confidence scores.

No files are written; this command is safe to run at any time.

## Usage

```
node dist/context-audit.js
```

This skill delegates to the compiled `dist/context-audit.js` Node.js script, which:
1. Reads `session_id` and `cwd` from the invocation context
2. Loads `.context-optimizer.json` config from the repository root
3. Sends a `query_signals` request to the Rust daemon
4. Renders the signal summary as a Markdown report to stdout
