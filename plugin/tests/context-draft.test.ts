import { describe, expect, it, vi } from 'vitest';
import { runDraft } from '../src/context-draft.js';
import type { SignalSummaryMessage } from '../src/ipc-client.js';
import type { DraftPatch } from '../src/patch-generator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GATE_FAILED_SUMMARY: SignalSummaryMessage = {
  type: 'signal_summary',
  gate_passed: false,
  gate_reasons: ['Insufficient sessions'],
  repeated_files: [],
  repeated_errors: [],
  repeated_sequences: [],
};

const NO_DRAFTABLE_SUMMARY: SignalSummaryMessage = {
  type: 'signal_summary',
  gate_passed: true,
  gate_reasons: [],
  repeated_files: [
    {
      path: 'src/utils.ts',
      count: 3,
      confidence: 0.7,
      severity: 'medium',
      evidence_count: 3,
      draftable: false,
    },
  ],
  repeated_errors: [],
  repeated_sequences: [],
};

const DRAFTABLE_SUMMARY: SignalSummaryMessage = {
  type: 'signal_summary',
  gate_passed: true,
  gate_reasons: [],
  repeated_files: [
    {
      path: 'src/router.ts',
      count: 10,
      confidence: 0.88,
      severity: 'high',
      evidence_count: 10,
      draftable: true,
    },
  ],
  repeated_errors: [],
  repeated_sequences: [],
};

function makeQuerySignals(summary: SignalSummaryMessage) {
  return vi.fn().mockResolvedValue(summary);
}

function makeCallLlm(output: string) {
  return vi.fn().mockResolvedValue(output);
}

function makeFailingCallLlm(message: string) {
  return vi.fn().mockRejectedValue(new Error(message));
}

// A mock LLM response containing a valid PATCH block
function mockLlmWithPatch(kind: string, target: string, diffContent: string): string {
  return [
    `<!-- PATCH kind=${kind} target=${target} -->`,
    '**Rationale**: Based on behavioral signals.',
    '',
    '```diff',
    diffContent,
    '```',
    '',
    '<!-- END PATCH -->',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDraft', () => {
  const sessionId = 'test-session-123';
  const cwd = '/tmp/test-repo';
  const apiKey = 'test-api-key';

  it('returns "No Draftable Candidates" message when gate is not passed', async () => {
    const output = await runDraft(
      sessionId,
      cwd,
      makeQuerySignals(GATE_FAILED_SUMMARY),
      makeCallLlm(''),
      apiKey,
    );
    expect(output).toMatch(/No Draftable Candidates/i);
  });

  it('returns "No Draftable Candidates" message when all candidates are below threshold', async () => {
    const output = await runDraft(
      sessionId,
      cwd,
      makeQuerySignals(NO_DRAFTABLE_SUMMARY),
      makeCallLlm(''),
      apiKey,
    );
    expect(output).toMatch(/No Draftable Candidates/i);
    expect(output).toMatch(/context-audit/i);
  });

  it('does not call LLM when no draftable candidates exist', async () => {
    const callLlmFn = makeCallLlm('');
    await runDraft(sessionId, cwd, makeQuerySignals(NO_DRAFTABLE_SUMMARY), callLlmFn, apiKey);
    expect(callLlmFn).not.toHaveBeenCalled();
  });

  it('calls LLM when draftable candidates exist', async () => {
    const diffContent = `--- CLAUDE.md\n+++ CLAUDE.md\n@@ -0,0 +1,2 @@\n+## Files\n+- src/router.ts`;
    const llmOutput = mockLlmWithPatch('claude_md', 'CLAUDE.md', diffContent);
    const callLlmFn = makeCallLlm(llmOutput);

    await runDraft(sessionId, cwd, makeQuerySignals(DRAFTABLE_SUMMARY), callLlmFn, apiKey);
    expect(callLlmFn).toHaveBeenCalledOnce();
  });

  it('passes the api key to the LLM call', async () => {
    const diffContent = `--- CLAUDE.md\n+++ CLAUDE.md\n@@ -0,0 +1,2 @@\n+## Files\n+- src/router.ts`;
    const llmOutput = mockLlmWithPatch('claude_md', 'CLAUDE.md', diffContent);
    const callLlmFn = makeCallLlm(llmOutput);

    await runDraft(sessionId, cwd, makeQuerySignals(DRAFTABLE_SUMMARY), callLlmFn, 'my-secret-key');
    expect(callLlmFn).toHaveBeenCalledWith(expect.any(String), 'my-secret-key');
  });

  it('returns a header and patch output when LLM produces valid patches', async () => {
    const diffContent = `--- CLAUDE.md\n+++ CLAUDE.md\n@@ -0,0 +1,2 @@\n+## Files\n+- src/router.ts`;
    const llmOutput = mockLlmWithPatch('claude_md', 'CLAUDE.md', diffContent);

    const output = await runDraft(
      sessionId,
      cwd,
      makeQuerySignals(DRAFTABLE_SUMMARY),
      makeCallLlm(llmOutput),
      apiKey,
    );
    expect(output).toMatch(/Context Optimizer.*Draft Patches/i);
    expect(output).toContain('CLAUDE.md');
    expect(output).toContain('src/router.ts');
  });

  it('includes patch metadata (confidence, severity, evidence) in output', async () => {
    const diffContent = `--- CLAUDE.md\n+++ CLAUDE.md\n@@ -0,0 +1,2 @@\n+## Files\n+- src/router.ts`;
    const llmOutput = mockLlmWithPatch('claude_md', 'CLAUDE.md', diffContent);

    const output = await runDraft(
      sessionId,
      cwd,
      makeQuerySignals(DRAFTABLE_SUMMARY),
      makeCallLlm(llmOutput),
      apiKey,
    );
    // Confidence 0.88 → 88%
    expect(output).toContain('88%');
    expect(output).toMatch(/high/i);
  });

  it('mentions context-apply in the output to guide next steps', async () => {
    const diffContent = `--- CLAUDE.md\n+++ CLAUDE.md\n@@ -0,0 +1,2 @@\n+## Files\n+- src/router.ts`;
    const llmOutput = mockLlmWithPatch('claude_md', 'CLAUDE.md', diffContent);

    const output = await runDraft(
      sessionId,
      cwd,
      makeQuerySignals(DRAFTABLE_SUMMARY),
      makeCallLlm(llmOutput),
      apiKey,
    );
    expect(output).toMatch(/context-apply/i);
  });

  it('returns "No Patches Generated" when LLM output has no parseable diffs', async () => {
    const output = await runDraft(
      sessionId,
      cwd,
      makeQuerySignals(DRAFTABLE_SUMMARY),
      makeCallLlm('Here is a response with no diff blocks.'),
      apiKey,
    );
    expect(output).toMatch(/No Patches Generated/i);
  });

  it('returns an LLM error message when the API call fails', async () => {
    const output = await runDraft(
      sessionId,
      cwd,
      makeQuerySignals(DRAFTABLE_SUMMARY),
      makeFailingCallLlm('Connection refused'),
      apiKey,
    );
    expect(output).toMatch(/LLM Error/i);
    expect(output).toContain('Connection refused');
    expect(output).toMatch(/retry/i);
  });

  it('does not write any files (only returns a string)', async () => {
    // This is a structural test: runDraft returns a string, not void.
    const diffContent = `--- CLAUDE.md\n+++ CLAUDE.md\n@@ -0,0 +1,2 @@\n+## Files\n+- src/router.ts`;
    const llmOutput = mockLlmWithPatch('claude_md', 'CLAUDE.md', diffContent);

    const result = await runDraft(
      sessionId,
      cwd,
      makeQuerySignals(DRAFTABLE_SUMMARY),
      makeCallLlm(llmOutput),
      apiKey,
      vi.fn().mockResolvedValue(undefined),
    );
    expect(typeof result).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Task 10.2 — saveDraft integration in runDraft
// ---------------------------------------------------------------------------

describe('runDraft — staging file integration', () => {
  const sessionId = 'test-session-123';
  const cwd = '/tmp/test-repo';
  const apiKey = 'test-api-key';

  const diffContent = `--- CLAUDE.md\n+++ CLAUDE.md\n@@ -0,0 +1,2 @@\n+## Files\n+- src/router.ts`;

  function makeSaveDraftFn() {
    return vi.fn().mockResolvedValue(undefined);
  }

  it('calls saveDraftFn with session_id and patches on successful generation', async () => {
    const llmOutput = mockLlmWithPatch('claude_md', 'CLAUDE.md', diffContent);
    const saveDraftFn = makeSaveDraftFn();

    await runDraft(
      sessionId,
      cwd,
      makeQuerySignals(DRAFTABLE_SUMMARY),
      makeCallLlm(llmOutput),
      apiKey,
      saveDraftFn,
    );

    expect(saveDraftFn).toHaveBeenCalledOnce();
    const [calledSessionId, calledPatches] = saveDraftFn.mock.calls[0] as [string, DraftPatch[]];
    expect(calledSessionId).toBe(sessionId);
    expect(calledPatches).toHaveLength(1);
    expect(calledPatches[0]?.recommendation_kind).toBe('claude_md');
  });

  it('does NOT call saveDraftFn when LLM call fails', async () => {
    const saveDraftFn = makeSaveDraftFn();

    await runDraft(
      sessionId,
      cwd,
      makeQuerySignals(DRAFTABLE_SUMMARY),
      makeFailingCallLlm('API timeout'),
      apiKey,
      saveDraftFn,
    );

    expect(saveDraftFn).not.toHaveBeenCalled();
  });

  it('does NOT call saveDraftFn when there are no draftable candidates', async () => {
    const saveDraftFn = makeSaveDraftFn();

    await runDraft(
      sessionId,
      cwd,
      makeQuerySignals(NO_DRAFTABLE_SUMMARY),
      makeCallLlm(''),
      apiKey,
      saveDraftFn,
    );

    expect(saveDraftFn).not.toHaveBeenCalled();
  });

  it('does NOT call saveDraftFn when LLM produces no parseable patches', async () => {
    const saveDraftFn = makeSaveDraftFn();

    await runDraft(
      sessionId,
      cwd,
      makeQuerySignals(DRAFTABLE_SUMMARY),
      makeCallLlm('No patches here.'),
      apiKey,
      saveDraftFn,
    );

    expect(saveDraftFn).not.toHaveBeenCalled();
  });

  it('works without saveDraftFn argument (backwards compatible)', async () => {
    const llmOutput = mockLlmWithPatch('claude_md', 'CLAUDE.md', diffContent);
    // Should not throw when saveDraftFn is omitted
    await expect(
      runDraft(sessionId, cwd, makeQuerySignals(DRAFTABLE_SUMMARY), makeCallLlm(llmOutput), apiKey),
    ).resolves.toBeDefined();
  });
});
