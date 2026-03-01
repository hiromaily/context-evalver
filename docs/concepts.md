# Concepts

Understanding the key concepts helps you interpret audit reports and make the most of context-optimizer.

## Signal Kinds

The daemon extracts three kinds of behavioral signals from raw session events:

### File Access Signals

Detected when the same file (or set of files) is accessed repeatedly across multiple sessions. A file-access signal indicates that a file is important enough to your workflow that it should be mentioned in `CLAUDE.md` — either as always-read context or as a troubleshooting reference.

**Extraction criteria**: A file must be accessed at least `min_repeat_threshold` times and appear in at least 2 distinct sessions.

### Error Pattern Signals

Detected when the same error message (after normalization) recurs across sessions. Normalized errors strip file paths, line numbers, and memory addresses so that structurally identical errors from different files are grouped together.

**Extraction criteria**: A normalized error must appear at least `min_repeat_threshold` times.

**What gets proposed**: A troubleshooting section in `CLAUDE.md` documenting the error and its typical fix.

### Command Sequence Signals

Detected when the same 2–4 command sequence (e.g., `cargo build` → `cargo test`) is run repeatedly. Sequences are identified by a rolling xxh3 hash of the command window.

**Extraction criteria**: A sequence must appear at least `min_repeat_threshold` times across multiple sessions.

**What gets proposed**: A new skill file in `.claude/skills/` and/or a slash command in `.claude/commands/`.

## Data-Sufficiency Gate

Before any signal analysis runs, the gate checks whether enough data has been collected. This prevents premature suggestions from sparse data.

The gate passes if **any** of the following conditions is true:

| Condition | Variables | Meaning |
|-----------|-----------|---------|
| `S ≥ 5` | S = distinct sessions | At least 5 sessions logged for this repo |
| `S ≥ 3 AND E ≥ 200` | E = total events | 3+ sessions with 200+ total events |
| `R ≥ 1` | R = strong signals | At least 1 signal with high raw count |

If the gate does not pass, `/context-audit` and `/context-draft` report why and suggest continuing normal development.

## Confidence Scoring

Each detected signal receives a confidence score in `[0, 1]` computed per-kind:

```
score = f(count, spread, day_coverage, recency) × data_factor
```

Where:
- **count** — raw occurrence count (higher is better)
- **spread** — how many distinct sessions contributed (wider = more confident)
- **day_coverage** — fraction of analysis window days with at least one occurrence
- **recency** — exponential decay weighting recent occurrences more heavily
- **data_factor** — scales down confidence proportionally when data is sparse

### Confidence Thresholds

| Threshold | Value | Effect |
|-----------|-------|--------|
| Report threshold | `min_confidence_score` (default 0.7) | Minimum score to appear in `/context-audit` output |
| Draftable threshold | 0.80 | Minimum score to be eligible for `/context-draft` |

## Throttle Suppression

To avoid repeatedly proposing the same improvement, the daemon tracks the last time each signal was suggested and its confidence at that time.

A signal is **suppressed** (excluded from reports) if both conditions hold:

1. It was suggested within the last **7 days**, AND
2. The current confidence has not increased by at least **0.15** since the last suggestion

To override suppression and see all signals regardless, run `/context-reset` to clear throttle records.

## Severity Levels

Each signal is assigned a severity level based on its confidence score and kind:

| Severity | Criteria |
|----------|----------|
| `high` | Confidence ≥ 0.85, or error pattern with very high recurrence |
| `medium` | Confidence ≥ 0.70 |
| `low` | Confidence < 0.70 (above report threshold) |

Severity is displayed in `/context-audit` output to help you prioritize which improvements to apply first.

## Data Storage

All data is stored locally under `~/.local/share/context-optimizer/` (or `$XDG_DATA_HOME/context-optimizer/`). No data leaves your machine.

| Path | Contents |
|------|----------|
| `{session_id}.sock` | Unix socket for the active session |
| `db/{hash}.db` | Per-repository SQLite database (WAL mode) |
| `drafts/{session_id}.json` | Staging file created by `/context-draft` |

The database hash is derived from the repository root path using xxh3, so each repository has its own isolated database.
