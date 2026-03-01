/**
 * context-config — Claude Code skill script.
 *
 * Loads the repository configuration and renders a compact Markdown table
 * showing all six configuration fields and their current values.
 */

import { createInterface } from 'node:readline';
import type { Config } from './config-loader.js';
import { loadConfig } from './config-loader.js';

// ---------------------------------------------------------------------------
// Render compact Markdown table
// ---------------------------------------------------------------------------

export function renderConfigReport(config: Config): string {
  const excludePaths = config.exclude_paths.join(', ');

  return [
    '## Context Optimizer — Configuration',
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| analysis_window_days | ${config.analysis_window_days} |`,
    `| min_sessions | ${config.min_sessions} |`,
    `| min_repeat_threshold | ${config.min_repeat_threshold} |`,
    `| min_confidence_score | ${config.min_confidence_score} |`,
    `| exclude_paths | ${excludePaths} |`,
    `| auto_pr | ${config.auto_pr} |`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runConfig(
  cwd: string,
  loadConfigFn: (cwd: string) => Promise<Config> = async c => loadConfig(c),
): Promise<string> {
  const config = await loadConfigFn(cwd);
  return renderConfigReport(config);
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

  const cwd = input.cwd ?? process.cwd();

  const output = await runConfig(cwd);
  process.stdout.write(output);
}

main().catch(err => {
  process.stderr.write(
    `[context-config] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
