# /context-reset

Clears all throttle records and suggestion history for the current repository so all signals become eligible for re-suggestion.

> **Warning:** This action is irreversible. All previously suggested recommendations will be eligible for re-suggestion on the next `/context-audit` or `/context-draft` run. Raw session events and signal data are **not** deleted.

## When to Use

Run `/context-reset` when:

- You have significantly changed your workflow and want fresh recommendations unaffected by older throttle state
- It has been more than a week since your last optimization but signals are still suppressed
- You want to re-evaluate all signals from scratch after a major refactor

## Confirmation Prompt

The command always prompts before clearing data:

```
⚠️  This will clear all throttle records for this repository.
Previously suggested signals will become eligible for re-suggestion.
Raw session events are not deleted.

Clear throttle history? [y/N]:
```

Enter `y` to proceed. Any other input aborts without making changes.

## What Gets Cleared

| Data | Cleared? |
|------|---------|
| Throttle records (last suggested, last confidence) | ✅ Yes |
| Session events | ❌ No |
| File access records | ❌ No |
| Error pattern records | ❌ No |
| Signal extraction cache | ❌ No |

After reset, all signals with sufficient confidence will appear in the next `/context-audit` run as if they had never been suggested.

## Next Steps

After resetting, run `/context-audit` to see all unthrottled signals.
