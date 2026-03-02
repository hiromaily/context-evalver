# Plan: Restructure for Claude Code Plugin Marketplace

**Goal**: Make `context-evalver` installable via:

```text
/plugin marketplace add hiromaily/context-evalver
/plugin install context-evalver
```

---

## Reference Implementation

`claude-mem` (`thedotmack/claude-mem`) is the established example. Its repository root IS the plugin — metadata, hooks, skills, and built artifacts all live at the top level.

---

## Gap Analysis

| Issue | Current State | Required |
|---|---|---|
| `plugin.json` location | `plugin/.claude-plugin/plugin.json` | Root `.claude-plugin/plugin.json` |
| `hooks.json` location | `plugin/hooks/hooks.json` | Root `hooks/hooks.json` |
| Skills location | `plugin/skills/` | Root `skills/` |
| Hook entry points | Not built separately | `dist/hooks/*.js` per event |
| Built artifacts | Not committed | `dist/` must be available post-install |
| Rust daemon install | Manual `cargo build` | `postinstall` script or pre-built binary |
| GitHub repo name | `context-evalver` | No rename needed |

---

## Target Repository Structure

```text
context-evalver/                    ← GitHub repo root
├── .claude-plugin/
│   └── plugin.json                 ← plugin manifest
├── hooks/
│   └── hooks.json                  ← hook event → script mapping
├── skills/
│   ├── context-audit/SKILL.md
│   ├── context-apply/SKILL.md
│   ├── context-config/SKILL.md
│   ├── context-draft/SKILL.md
│   ├── context-reset/SKILL.md
│   └── context-status/SKILL.md
├── src/                            ← TypeScript source (hook entry points + lib)
│   ├── hooks/
│   │   ├── session-start.ts
│   │   ├── session-end.ts
│   │   ├── pre-tool-use.ts
│   │   ├── post-tool-use.ts
│   │   └── user-prompt-submit.ts
│   └── lib/                        ← shared modules (moved from plugin/src/)
│       ├── ipc-client.ts
│       ├── event-capture.ts
│       ├── hook-dispatcher.ts
│       └── ...
├── dist/                           ← built JS (committed or built via postinstall)
│   └── hooks/
│       ├── session-start.js
│       ├── session-end.js
│       ├── pre-tool-use.js
│       ├── post-tool-use.js
│       └── user-prompt-submit.js
├── core/                           ← Rust daemon (unchanged)
│   ├── src/
│   ├── Cargo.toml
│   └── ...
├── package.json                    ← with postinstall script
├── tsconfig.json
└── README.md
```

---

## Implementation Steps

### Step 1 — Restructure TypeScript Source

Move files from `plugin/` to the repo root:

```
plugin/src/           → src/lib/
plugin/hooks/         → hooks/            (hooks.json config file)
plugin/skills/        → skills/
plugin/.claude-plugin → .claude-plugin/
plugin/tsconfig.json  → tsconfig.json
plugin/biome.json     → biome.json
plugin/package.json   → package.json      (update paths)
```

Create individual hook entry point files at `src/hooks/*.ts`, each a thin wrapper
that imports from `src/lib/` and calls the relevant handler.

---

### Step 3 — Update Build Configuration

Update `package.json` build script to compile each hook entry point separately:

```json
{
  "scripts": {
    "build": "tsup src/hooks/*.ts --format esm --out-dir dist/hooks --no-splitting",
    "postinstall": "bun run build && node scripts/install-daemon.js"
  }
}
```

The `tsup` multi-entry build produces one `.js` file per hook event.

---

### Step 4 — Handle Rust Daemon on Install

Two options (choose one):

#### Option A — Build from source (requires Rust on user machine)
```js
// scripts/install-daemon.js
import { execSync } from 'child_process';
import { existsSync } from 'fs';

const binaryPath = 'core/target/release/context-evalver-core';
if (!existsSync(binaryPath)) {
  console.log('[context-evalver] Building Rust daemon...');
  execSync('cargo build --release', { cwd: 'core', stdio: 'inherit' });
}
```

**Pros**: Always up to date, no binary management
**Cons**: Requires `cargo` installed; slow first install (~30-60s)

#### Option B — Pre-built binaries via GitHub Releases (recommended)
```js
// scripts/install-daemon.js
// Download the correct binary for the current platform from GitHub Releases
// Platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64
```

**Pros**: Fast install, no Rust toolchain required
**Cons**: Must publish binaries with each release; CI/CD required

**Recommendation**: Start with Option A for simplicity; migrate to Option B when the plugin is stable.

---

### Step 5 — Update hooks.json Paths

The hook commands in `hooks/hooks.json` reference `dist/hooks/`:

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "node dist/hooks/session-start.js"}]
    }],
    "SessionEnd": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "node dist/hooks/session-end.js"}]
    }],
    "PreToolUse": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "node dist/hooks/pre-tool-use.js"}]
    }],
    "PostToolUse": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "node dist/hooks/post-tool-use.js"}]
    }],
    "UserPromptSubmit": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "node dist/hooks/user-prompt-submit.js"}]
    }]
  }
}
```

These paths are relative to the plugin install directory (where Claude Code installs the plugin).

---

### Step 6 — Commit Built Artifacts

The `dist/` directory must be available after install. Options:

- **Commit `dist/` to git**: Simple, but pollutes history. Remove `dist/` from `.gitignore`.
- **Build via `postinstall`**: Cleaner history, but requires build tools on user machine.

For a plugin (not a library), committing `dist/` is acceptable and what `claude-mem` does.

---

### Step 7 — Update plugin.json

```json
{
  "name": "context-evalver",
  "version": "0.1.0",
  "description": "Observes session behavior and proposes evidence-based context improvements for CLAUDE.md, skills, and slash commands",
  "author": {
    "name": "hiromaily"
  },
  "repository": "https://github.com/hiromaily/context-evalver",
  "license": "MIT",
  "keywords": ["context", "claude-md", "hooks", "signals", "optimization"]
}
```

---

## Decision Required: Rust Daemon Strategy

Before implementing, decide on the Rust daemon distribution approach:

| | Build from Source | Pre-built Binaries |
|---|---|---|
| User requirement | `cargo` installed | None |
| Install speed | Slow (~60s) | Fast (<5s) |
| Maintenance | Low | High (CI/CD per platform) |
| Recommended for | Early development | Public release |

---

## Files to Delete After Restructure

- `plugin/` directory (source moved to root)
- `Cargo.toml` at root (if it's a workspace file, may need updating)

---

## Testing the Plugin Installation Locally

Before publishing to GitHub, test the plugin locally:

```bash
# Simulate what the marketplace installer does
cd /tmp
git clone https://github.com/hiromaily/context-evalver
cd context-evalver
bun install   # triggers postinstall → build + daemon install
```

Then in Claude Code:
```
/plugin install /tmp/context-evalver
```
