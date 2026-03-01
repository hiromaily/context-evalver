---
description: Generate concrete unified-diff patch proposals for CLAUDE.md, Skills, and slash commands from high-confidence behavioral signals.
---

# context-draft

Queries the Rust daemon for accumulated behavioral signals, invokes the Claude API to produce structured patch proposals, generates unified diffs, and saves a staging file for `/context-apply`. Only signals with confidence ≥ 0.80 are eligible for draft generation.

## Prerequisites

Enough sessions must have been logged to pass the data sufficiency gate. If no draftable candidates are available, the command explains why and directs you to run `/context-audit` first.

## What it generates

Patches targeting:
- **`CLAUDE.md`** — additions for frequently accessed files and error-fix troubleshooting sections
- **`.claude/skills/`** — new Skill definition files for repeated command sequences
- **`.claude/commands/`** — new slash-command definition files for repeated sequences

## Usage

```
node dist/context-draft.js
```

This skill delegates to the compiled `dist/context-draft.js` Node.js script, which:
1. Reads `session_id` and `cwd` from the invocation context
2. Loads `.context-optimizer.json` config from the repository root
3. Sends a `query_signals` request to the Rust daemon
4. Constructs a structured prompt and calls the Claude API
5. Parses unified diff blocks from the LLM response
6. Displays each patch with its confidence, severity, and evidence count
7. Saves all patches to a staging file (`drafts/{session_id}.json`) for `/context-apply`

## Next step

After reviewing the displayed diffs, run `/context-apply` to apply the staged patches to your repository.
