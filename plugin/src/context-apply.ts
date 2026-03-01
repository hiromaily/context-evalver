/**
 * context-apply — Claude Code skill script.
 *
 * Loads the draft staging file, displays patches with metadata, prompts for
 * explicit user confirmation, applies each patch to the filesystem, runs
 * git diff, and clears the staging file.
 */

import { exec, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { DraftPatch, DraftStagingFile } from './patch-generator.js';
import { clearDraft, loadDraft } from './patch-generator.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Patch application to the filesystem
// ---------------------------------------------------------------------------

/**
 * Applies a single `DraftPatch` to the filesystem rooted at `cwd`.
 *
 * - For new-file diffs (diff starts with `--- /dev/null`): extract `+` lines
 *   and write a new file, creating parent directories as needed.
 * - For modification diffs: delegate to `git apply` via shell.
 *
 * Returns `{ success: true }` on success or `{ success: false, error }` on failure.
 */
export async function applyPatchToFs(
  patch: DraftPatch,
  cwd: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const isNewFile = patch.unified_diff.includes('--- /dev/null');

    if (isNewFile) {
      // Extract content from `+` lines (skip `+++` header and `@@` lines)
      const lines = patch.unified_diff.split('\n');
      const contentLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          contentLines.push(line.slice(1));
        }
      }
      const content = `${contentLines.join('\n')}\n`;
      const targetPath = join(cwd, patch.target_file);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content, 'utf8');
    } else {
      // Apply an existing-file diff via `git apply`, piping diff to stdin
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('git', ['apply', '--whitespace=nowarn', '-'], { cwd });
        let errOutput = '';
        proc.stderr.on('data', (chunk: Buffer) => {
          errOutput += chunk.toString();
        });
        proc.on('close', code => {
          if (code === 0) resolve();
          else reject(new Error(errOutput || `git apply exited with code ${String(code)}`));
        });
        proc.stdin.write(patch.unified_diff);
        proc.stdin.end();
      });
    }

    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error };
  }
}

// ---------------------------------------------------------------------------
// Git diff helper
// ---------------------------------------------------------------------------

/**
 * Runs `git diff` in `cwd` and returns the output string.
 * Returns an empty string on error (e.g., not a git repo).
 */
export async function runGitDiff(cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git diff', { cwd });
    return stdout;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Git commit helper
// ---------------------------------------------------------------------------

/**
 * Creates a git commit with the given message in `cwd`.
 * Returns `{ success: true, output }` on success or `{ success: false, output }` on failure.
 */
export async function runGitCommit(
  cwd: string,
  message: string,
): Promise<{ success: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execAsync(
      `git add -A && git commit -m ${JSON.stringify(message)}`,
      { cwd },
    );
    return { success: true, output: (stdout + stderr).trim() };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    const combined = (error.stdout ?? '') + (error.stderr ?? '');
    const output = (combined || error.message || String(err)).trim();
    return { success: false, output };
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function renderPatchList(patches: DraftPatch[]): string {
  const lines: string[] = [
    '## Pending Patches',
    '',
    `${patches.length} patch(es) staged for application:`,
    '',
  ];

  for (const patch of patches) {
    lines.push(
      `### \`${patch.target_file}\` (${patch.recommendation_kind})`,
      `- **Confidence**: ${(patch.confidence * 100).toFixed(0)}%`,
      `- **Severity**: ${patch.severity}`,
      `- **Evidence**: ${patch.evidence_count}`,
      '',
      '```diff',
      patch.unified_diff,
      '```',
      '',
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunApplyOptions {
  /** When true, creates a git commit after successful patch application. Default: false. */
  auto_pr?: boolean;
  /** Injectable git commit function for testing. Defaults to the real runGitCommit. */
  gitCommitFn?: (cwd: string, message: string) => Promise<{ success: boolean; output: string }>;
}

export async function runApply(
  sessionId: string,
  cwd: string,
  loadDraftFn: (session_id: string) => Promise<DraftStagingFile | null>,
  confirmFn: (patches: DraftPatch[]) => Promise<boolean>,
  applyFn: (patch: DraftPatch, cwd: string) => Promise<{ success: boolean; error?: string }>,
  gitDiffFn: (cwd: string) => Promise<string>,
  clearDraftFn: (session_id: string) => Promise<void>,
  options: RunApplyOptions = {},
): Promise<string> {
  // 1. Load staging file
  const stagingFile = await loadDraftFn(sessionId);
  if (!stagingFile) {
    return [
      '## No Draft Available',
      '',
      'No staged draft was found for this session.',
      '',
      'Run `/context-draft` first to generate patch proposals.',
    ].join('\n');
  }

  const { patches } = stagingFile;

  // 2. Display patches and request confirmation
  const patchList = renderPatchList(patches);
  const confirmed = await confirmFn(patches);

  if (!confirmed) {
    return [patchList, '---', '', '> **Cancelled** — patches were not applied.'].join('\n');
  }

  // 3. Apply each patch
  const applied: string[] = [];
  const failed: Array<{ target_file: string; error: string }> = [];

  for (const patch of patches) {
    const result = await applyFn(patch, cwd);
    if (result.success) {
      applied.push(patch.target_file);
    } else {
      failed.push({ target_file: patch.target_file, error: result.error ?? 'Unknown error' });
    }
  }

  const { auto_pr = false, gitCommitFn = runGitCommit } = options;

  // 4. Run git diff
  const gitDiffOutput = await gitDiffFn(cwd);

  // 5. Optional git commit
  let commitResult: { success: boolean; output: string } | null = null;
  if (auto_pr && applied.length > 0) {
    const kinds = applied
      .map(f => patches.find(p => p.target_file === f)?.recommendation_kind ?? 'update')
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(', ');
    const commitMessage = `chore: apply context-optimizer recommendations (${kinds})\n\nApplied files:\n${applied.map(f => `- ${f}`).join('\n')}`;
    commitResult = await gitCommitFn(cwd, commitMessage);
  }

  // 6. Clear staging file
  await clearDraftFn(sessionId);

  // 7. Build result report
  const output: string[] = ['# Context Optimizer — Apply Results', ''];

  if (applied.length > 0) {
    output.push('## Successfully Applied', '');
    for (const f of applied) {
      output.push(`- ✅ \`${f}\``);
    }
    output.push('');
  }

  if (failed.length > 0) {
    output.push('## Failed Patches', '');
    for (const { target_file, error } of failed) {
      output.push(`- ❌ \`${target_file}\`: ${error}`);
    }
    output.push('');
  }

  if (gitDiffOutput) {
    output.push('## Git Diff', '', '```diff', gitDiffOutput.trimEnd(), '```', '');
  }

  if (commitResult !== null) {
    if (commitResult.success) {
      output.push('## Git Commit', '', commitResult.output, '');
    } else {
      output.push(
        '## Git Commit Failed',
        '',
        commitResult.output,
        '',
        '> Patches were written to disk. Please resolve and commit manually with `git commit`.',
        '',
      );
    }
  } else if (!auto_pr && applied.length > 0) {
    output.push(
      '## Next Steps',
      '',
      'Patches applied. You can commit manually with:',
      '',
      '```sh',
      'git add -A && git commit -m "chore: apply context-optimizer recommendations"',
      '```',
      '',
    );
  }

  return output.join('\n');
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

  // Confirmation via readline from tty if available, else auto-confirm
  const confirmFn = async (patches: DraftPatch[]): Promise<boolean> => {
    process.stdout.write(renderPatchList(patches));
    process.stdout.write('\nApply these patches? [y/N]: ');
    const answer = await new Promise<string>(resolve => {
      const confirmRl = createInterface({ input: process.stdin });
      confirmRl.once('line', line => {
        confirmRl.close();
        resolve(line.trim());
      });
    });
    return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
  };

  const output = await runApply(
    sessionId,
    cwd,
    loadDraft,
    confirmFn,
    applyPatchToFs,
    runGitDiff,
    clearDraft,
  );

  process.stdout.write(output);
}

main().catch(err => {
  process.stderr.write(
    `[context-apply] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
