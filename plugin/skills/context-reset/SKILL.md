---
description: Reset throttle records and suggestion history for the current repository, requiring explicit user confirmation before any data is cleared.
---

# context-reset

Clears all throttle records and suggestion history for the current repository so all signals become eligible for re-suggestion on the next `/context-audit` or `/context-draft` run.

> **Warning:** This action is irreversible. All previously suggested recommendations will be eligible for re-suggestion. Raw session events and signal data are **not** deleted.

Explicit user confirmation is required before any data is cleared.

## Usage

```
node dist/context-reset.js
```

This skill delegates to the compiled `dist/context-reset.js` Node.js script, which:
1. Reads `session_id` and `cwd` from the invocation context
2. Displays a warning about the destructive nature of the reset
3. Prompts for explicit confirmation (`[y/N]`)
4. Sends a `reset` message to the Rust daemon to clear throttle records
5. Confirms success or reports any errors

## Next steps

- Run `/context-audit` or `/context-draft` to begin fresh analysis with no throttle history
