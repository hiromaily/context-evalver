# Daily Workflow

context-optimizer is designed to fit naturally into your development routine. Most of the time, nothing special is needed — data collection is fully automatic.

## Phase 1: Passive Observation (Automatic)

Once the plugin is installed, it silently captures behavioral data during every Claude Code session:

- Files you frequently ask Claude to read
- Errors that recur across sessions
- Command sequences you run repeatedly

No action is required. Just work normally.

## Phase 2: Check Signals Periodically

After accumulating a few sessions (typically 3–5), run `/context-audit` to see what patterns have been detected.

```
/context-audit
```

**What to look for:**
- **Gate status** — if the gate has not passed, data collection is still in progress
- **High-severity signals** — these are the strongest candidates for optimization
- **Confidence scores** — values ≥ 0.80 are eligible for automatic patch generation

**How often to run it**: There is no strict schedule. Once per week is a reasonable starting cadence. The throttle system prevents the same suggestion from appearing more than once every 7 days.

## Phase 3: Draft Improvements

When `/context-audit` shows draftable candidates (confidence ≥ 0.80), generate concrete patch proposals:

```
/context-draft
```

This calls the Claude API to produce unified diffs for:
- Additions to `CLAUDE.md` (frequently accessed files, error troubleshooting)
- New skill files in `.claude/skills/`
- New slash-command files in `.claude/commands/`

Review each displayed diff carefully before proceeding. The staging file is saved automatically.

## Phase 4: Review and Apply

After reviewing the proposed diffs, apply them to your repository:

```
/context-apply
```

You will be shown each patch again with its metadata and asked for explicit confirmation before any files are written. After applying:

- `git diff` is displayed so you can see exactly what changed
- If `auto_pr = true`, a commit is created automatically
- The staging file is deleted

## Tips

### When to Reset the Throttle

Run `/context-reset` when:
- You have significantly changed your workflow and want fresh recommendations
- It has been more than a week since your last optimization cycle and you want to re-evaluate

> **Note:** Reset clears throttle records only. Raw session events and signal data are preserved.

### How to Read Confidence Scores

| Score | Meaning |
|-------|---------|
| 0.90+ | Very strong signal — appears frequently across many sessions |
| 0.80–0.90 | Strong signal — eligible for `/context-draft` |
| 0.70–0.80 | Moderate signal — visible in audit but not yet draftable |
| < 0.70 | Below report threshold — not shown |

Confidence improves as more sessions accumulate. A score of 0.78 today may reach 0.80 after two more sessions.

### What "Draftable" Means

A signal is **draftable** when its confidence is ≥ 0.80 and it has not been throttle-suppressed. The count displayed by `/context-status` tells you how many such signals are ready for `/context-draft`.

### Checking Status Quickly

Use `/context-status` for a compact summary without the full signal tables:

```
/context-status
```

This shows:
- Whether the data-sufficiency gate has passed
- Total detected signals
- Draftable recommendation count
- Days since last optimization

## Typical Weekly Cadence

```
Monday     — normal development (auto-captured)
Tuesday    — normal development
...
Friday     — /context-status  (quick check)
           — /context-audit   (if draftable > 0)
           — /context-draft   (if candidates look good)
           — /context-apply   (after reviewing diffs)
```

There is no obligation to follow this schedule. The plugin works at whatever pace suits your project.
