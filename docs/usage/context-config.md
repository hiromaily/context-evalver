# /context-config

Reads and displays the `.context-evalver.json` configuration for the current repository as a Markdown table.

## When to Use

- After installation, to verify that the plugin is working and the config is loaded correctly
- After editing `.context-evalver.json`, to confirm the new values are active
- To quickly check the current settings without opening the config file

## Example Output

With a local `.context-evalver.json`:

```markdown
## context-evalver Configuration

| Field | Value |
|-------|-------|
| analysis_window_days | 14 |
| min_sessions | 5 |
| min_repeat_threshold | 4 |
| min_confidence_score | 0.75 |
| exclude_paths | node_modules, .git, dist |
| auto_pr | true |
```

With no config file (all defaults):

```markdown
## context-evalver Configuration (defaults)

| Field | Value |
|-------|-------|
| analysis_window_days | 30 |
| min_sessions | 3 |
| min_repeat_threshold | 3 |
| min_confidence_score | 0.7 |
| exclude_paths | node_modules, .git |
| auto_pr | false |
```

## Next Steps

- To change settings, create or edit `.context-evalver.json` in your repository root
- See [Configuration](/configuration) for the full field reference
- Run `/context-status` to check current signal state with the active configuration
