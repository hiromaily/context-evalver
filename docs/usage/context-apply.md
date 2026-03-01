# /context-apply

Loads the staging file written by `/context-draft`, displays all pending patches, requests explicit user confirmation, applies each patch to disk, and shows a `git diff` of the changes.

## Prerequisites

Run `/context-draft` first. `/context-apply` reads the staging file (`drafts/{session_id}.json`) produced by that run. If no staging file is found, the command explains how to proceed.

## What Happens

1. **Load staging file** — reads `drafts/{session_id}.json` for the current session
2. **Display patches** — shows each patch with confidence, severity, evidence count, and the full unified diff
3. **Request confirmation** — prompts `Apply N patches? [y/N]` — no files are written without explicit confirmation
4. **Apply patches** — creates new files or updates existing ones on disk
5. **Show git diff** — displays all changes via `git diff` so you can review the result
6. **Git commit** (if `auto_pr = true`) — creates a commit with a descriptive message listing applied optimizations
7. **Cleanup** — removes the staging file

## Confirmation Prompt

```
The following 3 patches will be applied:
  1. CLAUDE.md (+12 lines) — file_access signal, confidence 0.91
  2. .claude/skills/build-test.md (new file) — command_sequence signal, confidence 0.84
  3. CLAUDE.md (+8 lines) — error_pattern signal, confidence 0.82

Apply 3 patches? [y/N]:
```

Enter `y` to proceed or `N` (or press Enter) to abort. No partial application on abort — either all patches are applied or none.

## `auto_pr` Flag

| `auto_pr` value | Behavior |
|-----------------|----------|
| `false` (default) | Prints `git add` and `git commit` commands for manual execution |
| `true` | Automatically stages files and creates a git commit |

To enable auto-commit, add `"auto_pr": true` to `.context-optimizer.json`.

## Partial Failure

If an individual file write fails (e.g., permission error), the error is reported and the remaining patches continue to be applied. Successfully applied patches are reflected in the staging file state.

## How to Undo

All changes are plain file edits. To undo:

```bash
# Discard uncommitted changes
git checkout -- CLAUDE.md .claude/skills/

# Or revert a specific commit (if auto_pr was used)
git revert HEAD
```

The staging file is always deleted after a successful apply, so re-running `/context-apply` in the same session will report "no staging file found."
