# /context-status

Displays a compact status summary of the data-sufficiency gate, detected signals, and draftable recommendation count.

## When to Use

Use `/context-status` for a quick check without the full signal tables that `/context-audit` produces. It is useful for:

- Knowing whether to run `/context-draft`
- Tracking how much data has been collected
- Checking when the last optimization was applied

## Example Output

```markdown
## context-optimizer Status

| Item | Value |
|------|-------|
| Data sufficiency gate | ✅ Passed |
| Total signals detected | 7 |
| Draftable (≥ 0.80 confidence) | 3 |
| Days since last optimization | 5 |
```

If the gate has not passed:

```markdown
## context-optimizer Status

| Item | Value |
|------|-------|
| Data sufficiency gate | ⏳ Not yet (2 / 3 sessions) |
| Total signals detected | 0 |
| Draftable (≥ 0.80 confidence) | 0 |
| Days since last optimization | — |
```

## Next Steps

- If **gate not passed**: continue development and re-check later
- If **draftable > 0**: run `/context-draft` to generate patch proposals
- If **draftable = 0** but signals exist: scores are below 0.80; more data may push them over the threshold
