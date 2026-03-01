---
description: Display the current plugin configuration as a Markdown table, showing all six configuration fields and their active values.
---

# context-config

Reads and displays the `.context-optimizer.json` configuration file for the current repository (or global defaults if no local config is present).

## Configuration fields

| Field | Default | Description |
|-------|---------|-------------|
| `analysis_window_days` | 30 | Rolling window (days) used for signal analysis |
| `min_sessions` | 3 | Minimum distinct sessions required to pass the data sufficiency gate |
| `min_repeat_threshold` | 3 | Minimum repetition count for a candidate to be considered a signal |
| `min_confidence_score` | 0.7 | Minimum confidence to include a signal in reports |
| `exclude_paths` | node_modules, .git | Path prefixes excluded from file tracking |
| `auto_pr` | false | If true, `/context-apply` auto-commits applied patches |

## Usage

```
node dist/context-config.js
```

This skill delegates to the compiled `dist/context-config.js` Node.js script, which:
1. Reads `cwd` from the invocation context
2. Loads `.context-optimizer.json` from the repository root (falls back to defaults if absent)
3. Renders all six fields as a compact Markdown table to stdout

## Next steps

- To override settings, create or edit `.context-optimizer.json` in your repository root
- Run `/context-status` to check current signal state with the active configuration
