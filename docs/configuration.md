# Configuration

context-optimizer reads `.context-optimizer.json` from the repository root. All fields are optional — any missing or invalid field falls back to its default value. The config file is never required; the plugin operates with full defaults when it is absent.

## Config File Location

```
your-project/
└── .context-optimizer.json   ← place here
```

## Full Field Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `analysis_window_days` | `integer > 0` | `30` | Rolling window in days for signal analysis. Events older than this are excluded from scoring. |
| `min_sessions` | `integer > 0` | `3` | Minimum distinct sessions required to pass the data-sufficiency gate. |
| `min_repeat_threshold` | `integer > 0` | `3` | Minimum repetition count for a pattern to be considered a signal. |
| `min_confidence_score` | `number 0–1` | `0.7` | Minimum confidence score to include a signal in audit reports. Does not affect the draftable threshold (always 0.80). |
| `exclude_paths` | `string[]` | `["node_modules", ".git"]` | Path segments to exclude from file tracking. An event is suppressed if its path contains any listed segment. |
| `auto_pr` | `boolean` | `false` | When `true`, `/context-apply` automatically creates a git commit after applying patches. |

## Validation Rules

- **Positive integers**: `analysis_window_days`, `min_sessions`, `min_repeat_threshold` must be integers greater than zero. Non-integer, zero, or negative values revert to the default.
- **Fraction**: `min_confidence_score` must be a number in `[0, 1]`. Values outside this range revert to the default.
- **String array**: `exclude_paths` must be an array. Non-array values revert to the default.
- **Boolean**: `auto_pr` must be `true` or `false`. Other types revert to the default.

Invalid fields emit a warning to stderr and use their defaults. A malformed JSON file causes all fields to use defaults.

## Example Config

```json
{
  "analysis_window_days": 14,
  "min_sessions": 5,
  "min_repeat_threshold": 4,
  "min_confidence_score": 0.75,
  "exclude_paths": ["node_modules", ".git", "dist", "coverage", ".cache"],
  "auto_pr": true
}
```

## `exclude_paths` Usage

The `exclude_paths` list contains **path segment substrings**. An event is excluded if its file path contains any listed segment:

```json
{
  "exclude_paths": ["node_modules", ".git", "dist", "__pycache__", ".venv"]
}
```

- `/home/user/project/node_modules/lodash/array.js` → excluded (matches `node_modules`)
- `/home/user/project/src/utils.ts` → included
- `/home/user/project/dist/bundle.js` → excluded (matches `dist`)

## `auto_pr` Behavior

When `auto_pr = true`, running `/context-apply` after confirming changes will:

1. Apply all staged patches to disk
2. Stage the modified files with `git add`
3. Create a commit with a descriptive message listing the applied optimizations

When `auto_pr = false` (default), `/context-apply` prints the `git add` and `git commit` commands for you to run manually after reviewing.

## Viewing Active Config

Run `/context-config` in any Claude Code session to display the active configuration for the current repository as a Markdown table.
