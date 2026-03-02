---
description: Display a compact status summary of signals, data sufficiency gate, and draftable recommendation count.
---

# context-status

Queries the Rust daemon for the current signal state and renders a compact Markdown status table showing:

- **Data sufficiency gate**: whether enough sessions and events have been collected
- **Signals detected**: total number of behavioral signals above the confidence threshold
- **Draftable recommendations**: count of candidates with confidence ≥ 0.80 (ready for `/context-draft`)
- **Days since last optimization**: how long since the last `/context-apply` run (requires throttle data)

## Usage

```
node dist/context-status.js
```

This skill delegates to the compiled `dist/context-status.js` Node.js script, which:
1. Reads `session_id` and `cwd` from the invocation context
2. Loads `.context-evalver.json` config from the repository root
3. Sends a `query_signals` request to the Rust daemon
4. Renders the derived status as a compact Markdown table to stdout

## Next steps

- If gate is not passed: continue normal development and re-run later
- If draftable count > 0: run `/context-draft` to generate patch proposals
