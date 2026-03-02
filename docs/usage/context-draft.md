# /context-draft

Queries the Rust daemon for high-confidence behavioral signals, calls the Claude API to generate concrete patch proposals as unified diffs, and saves a staging file for `/context-apply`.

## Prerequisites

- The data-sufficiency gate must have passed (run `/context-audit` to check)
- At least one signal must have confidence ≥ 0.80 (the draftable threshold)

If no draftable candidates are available, the command explains why and suggests what to do next.

## What It Generates

Patches targeting:

| Target | What Changes |
|--------|-------------|
| `CLAUDE.md` | Additions for frequently accessed files; troubleshooting sections for recurring errors |
| `.claude/skills/` | New skill definition files for repeated command sequences |
| `.claude/commands/` | New slash-command files for repeated command chains |

## How to Review the Proposed Diffs

Each patch is displayed with:
- **Signal type** and description
- **Confidence score** and **severity**
- **Evidence count** (raw occurrences) and **session spread**
- The full **unified diff**

Example display:

```
Signal: file_access — src/store.rs
Confidence: 0.91 (high)  Evidence: 23 occurrences across 6 sessions

--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -12,6 +12,10 @@
 ## Key Files

+### Core Storage Layer
+- `src/store.rs` — SQLite schema, batch inserts, windowed queries
+  (accessed in 100% of recent sessions)
+
 ## Development Commands
```

Review each diff carefully. You are not committed to applying all patches.

## Staging File Location

After generating patches, `/context-draft` saves the staging file to:

```
~/.local/share/context-evalver/drafts/{session_id}.json
```

This file is read by `/context-apply`. It is automatically deleted after a successful apply.

## Next Step

Run `/context-apply` to review patches again and apply them to your repository.
