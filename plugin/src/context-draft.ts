/**
 * context-draft — Claude Code skill script.
 *
 * Queries the daemon for signals, constructs a structured LLM prompt,
 * calls the Claude API, parses unified diffs from the response, and
 * displays each patch to stdout. Does not write any files.
 */

import { createInterface } from 'node:readline';
import { loadConfig } from './config-loader.js';
import type { SignalSummaryMessage } from './ipc-client.js';
import { IpcClient, socketPathForSession } from './ipc-client.js';
import type { DraftPatch } from './patch-generator.js';
import { buildDraftPrompt, generateDraftPatches, saveDraft } from './patch-generator.js';

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

interface AnthropicResponseBody {
  content: Array<{ type: string; text?: string }>;
}

/**
 * Calls the Anthropic Messages API with the given prompt.
 * Uses the native fetch API (Node.js >= 22).
 */
export async function callLlm(prompt: string, apiKey: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as AnthropicResponseBody;
  const textBlock = data.content.find(b => b.type === 'text');
  return textBlock?.text ?? '';
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function renderPatchHeader(patch: DraftPatch): string {
  return [
    `## Patch: \`${patch.recommendation_kind}\` → \`${patch.target_file}\``,
    '',
    `- **Confidence**: ${(patch.confidence * 100).toFixed(0)}%`,
    `- **Severity**: ${patch.severity}`,
    `- **Evidence**: ${patch.evidence_count}`,
    '',
    '```diff',
    patch.unified_diff,
    '```',
    '',
  ].join('\n');
}

function renderNoDraftableMessage(): string {
  return [
    '## No Draftable Candidates',
    '',
    'No candidates currently have sufficient confidence (≥ 0.80) to generate a draft.',
    '',
    'Run `/context-audit` to review current signals and check when more evidence is collected.',
  ].join('\n');
}

function renderNoPatchesMessage(): string {
  return [
    '## No Patches Generated',
    '',
    'The LLM did not produce any parseable diff blocks.',
    '',
    'Please retry `/context-draft`.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Core draft logic, factored out for testability.
 * Accepts injectable querySignals and callLlmFn for unit testing.
 */
export async function runDraft(
  sessionId: string,
  cwd: string,
  querySignalsFn: (
    repoRoot: string,
    windowDays: number,
    minRepeat: number,
  ) => Promise<SignalSummaryMessage>,
  callLlmFn: (prompt: string, apiKey: string) => Promise<string>,
  apiKey: string,
  saveDraftFn: (session_id: string, patches: DraftPatch[]) => Promise<void> = saveDraft,
): Promise<string> {
  const config = await loadConfig(cwd);

  const summary = await querySignalsFn(
    cwd,
    config.analysis_window_days,
    config.min_repeat_threshold,
  );

  const hasDraftable =
    summary.repeated_files.some(f => f.draftable) ||
    summary.repeated_errors.some(e => e.draftable) ||
    summary.repeated_sequences.some(s => s.draftable);

  if (!hasDraftable) {
    return renderNoDraftableMessage();
  }

  const prompt = buildDraftPrompt(summary);

  let llmOutput: string;
  try {
    llmOutput = await callLlmFn(prompt, apiKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `## LLM Error\n\n${msg}\n\nPlease retry \`/context-draft\`.`;
  }

  const patches = generateDraftPatches(summary, llmOutput);

  if (patches.length === 0) {
    return renderNoPatchesMessage();
  }

  await saveDraftFn(sessionId, patches);

  const output: string[] = [
    '# Context Optimizer — Draft Patches',
    '',
    `Generated ${patches.length} patch proposal(s) based on behavioral signals.`,
    'Review each diff below and run `/context-apply` to apply them.',
    '',
  ];

  for (const patch of patches) {
    output.push(renderPatchHeader(patch));
  }

  return output.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Read stdin for skill invocation context
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

  const sessionId = input.session_id ?? process.env.CLAUDE_SESSION_ID ?? '';
  const cwd = input.cwd ?? process.cwd();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stdout.write('## Error\n\n`ANTHROPIC_API_KEY` environment variable is not set.\n');
    return;
  }

  const sockPath = socketPathForSession(sessionId);
  const client = new IpcClient(sockPath);

  const output = await runDraft(
    sessionId,
    cwd,
    (repoRoot, windowDays, minRepeat) => client.querySignals(repoRoot, windowDays, minRepeat),
    callLlm,
    apiKey,
  );

  process.stdout.write(output);
}

main().catch(err => {
  process.stderr.write(
    `[context-draft] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
