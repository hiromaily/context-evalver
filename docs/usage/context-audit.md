# /context-audit

Queries the Rust daemon for accumulated behavioral signals and renders a read-only Markdown report. No files are written.

## When to Run

Run `/context-audit` when you want to:
- Check whether enough data has been collected (gate status)
- Review which behavioral patterns have been detected
- Assess which signals are ready for patch generation

It is safe to run at any time, even in the middle of a session.

## What It Shows

The report contains:

1. **Gate status** — whether the data-sufficiency gate has passed and why
2. **File access signals** — files accessed repeatedly across sessions, with confidence and evidence count
3. **Error pattern signals** — normalized errors that recur, with frequency data
4. **Command sequence signals** — repeated command chains with per-kind confidence

## How to Read the Report

### Gate Status

```markdown
## Data Sufficiency Gate

✅ Gate passed — 6 sessions, 312 events
```

or

```markdown
## Data Sufficiency Gate

⏳ Gate not yet passed
  Sessions: 2 / 3 minimum
  Events:   87
```

If the gate has not passed, continue working normally and re-run later.

### Signal Tables

Each signal row shows:

| Column | Meaning |
|--------|---------|
| Signal | File path, error message, or command sequence |
| Confidence | Score from 0 to 1 (≥ 0.80 = draftable) |
| Severity | `high` / `medium` / `low` |
| Evidence | Raw occurrence count |
| Sessions | Distinct sessions where this signal appeared |

### Example Output

```markdown
## File Access Signals

| File | Confidence | Severity | Evidence | Sessions |
|------|-----------|----------|----------|----------|
| src/store.rs | 0.91 | high | 23 | 6 |
| plugin/src/ipc-client.ts | 0.83 | high | 14 | 4 |
| core/Cargo.toml | 0.72 | medium | 9 | 3 |

## Error Pattern Signals

| Pattern | Confidence | Severity | Evidence | Sessions |
|---------|-----------|----------|----------|----------|
| "cannot find type `X` in this scope" | 0.87 | high | 11 | 5 |

## Command Sequence Signals

| Sequence | Confidence | Severity | Evidence | Sessions |
|----------|-----------|----------|----------|----------|
| cargo build → cargo test | 0.84 | high | 19 | 5 |
```

## Next Steps

- If draftable signals exist (confidence ≥ 0.80): run `/context-draft`
- If the gate has not passed: continue development and check again later
- If all signals are throttle-suppressed: run `/context-reset` to clear history
