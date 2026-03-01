/**
 * context-reset — Claude Code skill script.
 *
 * Displays a warning about clearing throttle/suggestion history, requires
 * explicit user confirmation, sends a reset message to the daemon, and
 * confirms the result.
 */

import { createInterface } from 'node:readline';
import { IpcClient, socketPathForSession } from './ipc-client.js';

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const WARNING = [
  '## ⚠️ Context Optimizer Reset',
  '',
  '**Warning:** This will permanently clear all throttle records and suggestion history',
  'for the current repository. All previously suggested recommendations will be eligible',
  'for re-suggestion on the next `/context-audit` or `/context-draft` run.',
  '',
  'Raw session events and signal data are **not** deleted.',
  '',
].join('\n');

export async function runReset(
  _sessionId: string,
  cwd: string,
  confirmFn: () => Promise<boolean>,
  resetFn: (repoRoot: string) => Promise<{ success: boolean; error?: string }>,
): Promise<string> {
  const confirmed = await confirmFn();

  if (!confirmed) {
    return [WARNING, '> **Cancelled** — throttle history was not reset.'].join('\n');
  }

  const result = await resetFn(cwd);

  if (!result.success) {
    return [
      '## Reset Failed',
      '',
      result.error ?? 'Unknown error',
      '',
      '> The throttle history could not be cleared. Ensure the daemon is running.',
    ].join('\n');
  }

  return [
    '## Reset Complete',
    '',
    '✅ Throttle records and suggestion history have been cleared for this repository.',
    '',
    'Run `/context-audit` or `/context-draft` to begin fresh analysis.',
  ].join('\n');
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

  // Display warning and prompt for confirmation
  process.stdout.write(WARNING);
  process.stdout.write('Clear throttle history for this repository? [y/N]: ');

  const confirmFn = async (): Promise<boolean> => {
    const answer = await new Promise<string>(resolve => {
      const confirmRl = createInterface({ input: process.stdin });
      confirmRl.once('line', line => {
        confirmRl.close();
        resolve(line.trim());
      });
    });
    return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
  };

  const sockPath = socketPathForSession(sessionId);
  const client = new IpcClient(sockPath);

  const resetFn = async (repoRoot: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await client.sendReset(repoRoot);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const output = await runReset(sessionId, cwd, confirmFn, resetFn);
  process.stdout.write(output);
}

main().catch(err => {
  process.stderr.write(
    `[context-reset] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
