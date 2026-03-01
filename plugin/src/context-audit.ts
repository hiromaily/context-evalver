/**
 * context-audit — Claude Code skill script.
 *
 * Queries the Rust daemon for accumulated behavioral signals, runs them
 * through the data-sufficiency gate, and renders a read-only Markdown report
 * to stdout.  No files are written.
 *
 * Entry-point:  node dist/context-audit.js
 * Input (stdin): JSON object { session_id?: string; cwd?: string }
 */

import { createInterface } from 'node:readline';
import { loadConfig } from './config-loader.js';
import type { SignalSummaryMessage } from './ipc-client.js';
import { IpcClient, socketPathForSession } from './ipc-client.js';
import { generateAuditReport } from './patch-generator.js';

// ---------------------------------------------------------------------------
// Exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Core audit logic, factored out for testability.
 *
 * @param repoRoot        Working directory / repository root.
 * @param querySignalsFn  Injectable: (repoRoot, windowDays, minRepeat) → SignalSummaryMessage.
 * @param writeFn         Injectable output sink (default: process.stdout.write).
 * @returns               The rendered Markdown string.
 */
export async function runAudit(
  repoRoot: string,
  querySignalsFn: (
    repoRoot: string,
    windowDays: number,
    minRepeat: number,
  ) => Promise<SignalSummaryMessage> = defaultQuerySignals,
  writeFn: (chunk: string) => void = chunk => process.stdout.write(chunk),
): Promise<string> {
  const config = await loadConfig(repoRoot);
  const summary = await querySignalsFn(
    repoRoot,
    config.analysis_window_days,
    config.min_repeat_threshold,
  );
  const { markdown } = generateAuditReport(summary);
  writeFn(markdown);
  writeFn('\n');
  return markdown;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function defaultQuerySignals(
  repoRoot: string,
  windowDays: number,
  minRepeat: number,
): Promise<SignalSummaryMessage> {
  const sessionId = process.env.CLAUDE_SESSION_ID ?? '';
  const sockPath = socketPathForSession(sessionId);
  const client = new IpcClient(sockPath);
  return client.querySignals(repoRoot, windowDays, minRepeat);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  let stdinData = '';
  for await (const line of rl) {
    stdinData += line;
  }

  let input: { session_id?: string; cwd?: string } = {};
  try {
    input = JSON.parse(stdinData) as { session_id?: string; cwd?: string };
  } catch {
    // Not JSON; fall through to env-var defaults
  }

  const cwd = input.cwd ?? process.cwd();

  await runAudit(cwd);
}

const isMain =
  process.argv[1]?.endsWith('context-audit.js') || process.argv[1]?.endsWith('context-audit.ts');

if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`[context-audit] error: ${String(err)}\n`);
    process.exit(1);
  });
}
