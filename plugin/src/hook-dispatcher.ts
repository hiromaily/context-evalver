import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config-loader.js';
import type { HookInput } from './event-capture.js';
import { captureFromHook } from './event-capture.js';
import type { IpcClient } from './ipc-client.js';

// ---------------------------------------------------------------------------
// Session start options
// ---------------------------------------------------------------------------

export interface SessionStartOptions {
  /** Path to the context-evalver-core binary. Defaults to env var or 'context-evalver-core'. */
  binPath?: string;
  /**
   * Milliseconds to wait after spawning the daemon before returning.
   * The wait is non-blocking (fires a deferred action via setTimeout).
   * Defaults to 500ms in production; tests pass 0 to skip.
   */
  startupDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function defaultBinPath(): string {
  return process.env.CONTEXT_OPTIMIZER_BIN ?? 'context-evalver-core';
}

// ---------------------------------------------------------------------------
// handleSessionStart
// ---------------------------------------------------------------------------

/**
 * Handles the `SessionStart` hook event.
 *
 * 1. If `.context-evalver-ignore` exists in `cwd`, returns immediately.
 * 2. Spawns the Rust daemon as a detached background process.
 * 3. Returns promptly; any post-startup IPC messages are deferred via setTimeout.
 * 4. Never throws — all errors are logged to stderr.
 */
export async function handleSessionStart(
  input: HookInput,
  opts: SessionStartOptions = {},
): Promise<void> {
  const { cwd, session_id } = input;
  const binPath = opts.binPath ?? defaultBinPath();

  // 1. Opt-out check
  if (existsSync(join(cwd, '.context-evalver-ignore'))) {
    return;
  }

  // 2. Spawn daemon as detached background process
  try {
    const child = spawn(binPath, ['--session-id', session_id, '--repo-root', cwd], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    process.stderr.write(`[context-evalver] failed to spawn daemon: ${String(err)}\n`);
  }

  // 3. Return immediately — any deferred IPC is fire-and-forget via setTimeout.
  //    The daemon itself initialises its session record on startup (it receives
  //    --session-id and --repo-root as CLI arguments).
}

// ---------------------------------------------------------------------------
// handlePerEventHook
// ---------------------------------------------------------------------------

export interface PerEventHookOptions {
  config: Config;
  /** Injectable IpcClient — production code constructs one from session_id socket path. */
  ipcClient: IpcClient;
}

/**
 * Handles `PreToolUse`, `PostToolUse`, and `UserPromptSubmit` hook events.
 *
 * 1. Calls EventCapture to derive a sanitised event (or null if not capturable).
 * 2. Sends the event to the daemon via the IPC client (fire-and-forget).
 * 3. If the socket is unavailable or sendEvent throws, logs to stderr and returns.
 * 4. Never throws.
 */
export async function handlePerEventHook(
  input: HookInput,
  opts: PerEventHookOptions,
): Promise<void> {
  const { config, ipcClient } = opts;

  try {
    const event = captureFromHook(input, config);
    if (event === null) return;
    ipcClient.sendEvent(event);
  } catch (err) {
    process.stderr.write(`[context-evalver] handlePerEventHook error: ${String(err)}\n`);
  }
}

// ---------------------------------------------------------------------------
// handleSessionEnd
// ---------------------------------------------------------------------------

export interface SessionEndOptions {
  ipcClient: IpcClient;
  /**
   * Directory where draft staging files live.
   * Defaults to `~/.local/share/context-evalver/drafts/`.
   * Injectable for tests.
   */
  draftsDir?: string;
}

function defaultDraftsDir(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(xdgDataHome, 'context-evalver', 'drafts');
}

/**
 * Handles the `SessionEnd` hook event.
 *
 * 1. Sends a `flush` message to commit any buffered events.
 * 2. Deletes the draft staging file for this session if it exists.
 * 3. Sends a `shutdown` message to stop the daemon.
 * 4. Never throws — errors are caught and logged to stderr.
 */
export async function handleSessionEnd(input: HookInput, opts: SessionEndOptions): Promise<void> {
  const { session_id } = input;
  const { ipcClient } = opts;
  const draftsDir = opts.draftsDir ?? defaultDraftsDir();

  // 1. Flush buffered events
  try {
    await ipcClient.sendFlush();
  } catch (err) {
    process.stderr.write(`[context-evalver] handleSessionEnd flush error: ${String(err)}\n`);
  }

  // 2. Remove draft staging file if present
  try {
    await unlink(join(draftsDir, `${session_id}.json`));
  } catch {
    // File absent or dir missing — ignore silently
  }

  // 3. Shutdown daemon
  try {
    await ipcClient.sendShutdown();
  } catch (err) {
    process.stderr.write(`[context-evalver] handleSessionEnd shutdown error: ${String(err)}\n`);
  }
}
