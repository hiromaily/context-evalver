/**
 * context-status — Claude Code skill script.
 *
 * Queries the daemon for signals and renders a compact Markdown status block
 * showing gate status, signal count, draftable recommendation count, and
 * days since last optimization.
 */

import { createInterface } from 'node:readline';
import { loadConfig } from './config-loader.js';
import type { SignalSummaryMessage } from './ipc-client.js';
import { IpcClient, socketPathForSession } from './ipc-client.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PluginStatus {
  gate_passed: boolean;
  /** Total number of signal candidates (all kinds, confidence >= 0.65). */
  signal_count: number;
  /** Number of draftable candidates (confidence >= 0.80). */
  draftable_count: number;
  /** Days since the most recent throttle record, or null if never optimized. */
  last_optimized_days: number | null;
}

// ---------------------------------------------------------------------------
// Derive status from a SignalSummaryMessage
// ---------------------------------------------------------------------------

/**
 * Computes a `PluginStatus` from a `SignalSummaryMessage`.
 * `last_optimized_days` is always null here; it would require throttle DB access.
 */
export function deriveStatus(summary: SignalSummaryMessage): PluginStatus {
  const all = [
    ...summary.repeated_files,
    ...summary.repeated_errors,
    ...summary.repeated_sequences,
  ];
  return {
    gate_passed: summary.gate_passed,
    signal_count: all.length,
    draftable_count: all.filter(c => c.draftable).length,
    last_optimized_days: null,
  };
}

// ---------------------------------------------------------------------------
// Render compact Markdown block
// ---------------------------------------------------------------------------

export function renderStatusReport(status: PluginStatus): string {
  const gateIcon = status.gate_passed ? '✅' : '❌';
  const gateLabel = status.gate_passed ? 'Passed' : 'Insufficient data';

  const lastOptimized =
    status.last_optimized_days === null ? '—' : `${status.last_optimized_days} day(s) ago`;

  return [
    '## Context Optimizer — Status',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Data sufficiency gate | ${gateIcon} ${gateLabel} |`,
    `| Signals detected | ${status.signal_count} |`,
    `| Draftable recommendations | ${status.draftable_count} |`,
    `| Days since last optimization | ${lastOptimized} |`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runStatus(
  _sessionId: string,
  cwd: string,
  querySignalsFn: (
    repoRoot: string,
    windowDays: number,
    minRepeat: number,
  ) => Promise<SignalSummaryMessage>,
): Promise<string> {
  const config = await loadConfig(cwd);
  const summary = await querySignalsFn(
    cwd,
    config.analysis_window_days,
    config.min_repeat_threshold,
  );
  const status = deriveStatus(summary);
  return renderStatusReport(status);
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
    // Not JSON; fall through to defaults
  }

  const sessionId = input.session_id ?? process.env.CLAUDE_SESSION_ID ?? '';
  const cwd = input.cwd ?? process.cwd();

  const sockPath = socketPathForSession(sessionId);
  const client = new IpcClient(sockPath);

  const output = await runStatus(sessionId, cwd, (repoRoot, windowDays, minRepeat) =>
    client.querySignals(repoRoot, windowDays, minRepeat),
  );

  process.stdout.write(output);
}

main().catch(err => {
  process.stderr.write(
    `[context-status] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
