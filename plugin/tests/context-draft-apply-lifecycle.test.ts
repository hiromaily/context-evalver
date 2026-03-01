/// Integration test: /context-draft → staging file → /context-apply lifecycle (task 15.5*)
///
/// Tests the full draft–apply pipeline:
///   1. runDraft (mocked LLM, real saveDraft) → staging file is written
///   2. Staging file contents are verified
///   3. runApply (real loadDraft + applyPatchToFs + clearDraft, auto-confirm) →
///      target file is created on disk and staging file is removed
///
/// XDG_DATA_HOME is overridden to a temp directory so the real staging file
/// functions operate in isolation without touching the real home directory.
///
/// Requirements: 9.4, 10.1, 10.2

import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPatchToFs, runApply } from '../src/context-apply.js';
import { runDraft } from '../src/context-draft.js';
import type { SignalSummaryMessage } from '../src/ipc-client.js';
import { clearDraft, draftStagingPath, loadDraft, saveDraft } from '../src/patch-generator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'lifecycle-test-session';

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

/** Known unified diff that creates a new CLAUDE.md with one section. */
const KNOWN_DIFF =
  '--- /dev/null\n+++ CLAUDE.md\n@@ -0,0 +1,3 @@\n+## Frequently Accessed Files\n+\n+- `src/router.ts`: Core routing';

/**
 * Mock LLM response that wraps KNOWN_DIFF in the expected PATCH block format.
 */
const MOCK_LLM_RESPONSE = [
  '<!-- PATCH kind=claude_md target=CLAUDE.md -->',
  '**Rationale**: src/router.ts is accessed in every session.',
  '',
  '```diff',
  KNOWN_DIFF,
  '```',
  '',
  '<!-- END PATCH -->',
].join('\n');

// ---------------------------------------------------------------------------
// Test setup: isolated XDG_DATA_HOME and temp repo root
// ---------------------------------------------------------------------------

let xdgDir: string;
let repoDir: string;
let origXdg: string | undefined;

beforeEach(async () => {
  xdgDir = await mkdtemp(join(tmpdir(), 'lifecycle-xdg-'));
  repoDir = await mkdtemp(join(tmpdir(), 'lifecycle-repo-'));
  origXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = xdgDir;
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  if (origXdg !== undefined) {
    process.env.XDG_DATA_HOME = origXdg;
  } else {
    delete process.env.XDG_DATA_HOME;
  }
  await rm(xdgDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

// ---------------------------------------------------------------------------
// Phase 1: runDraft writes the staging file
// ---------------------------------------------------------------------------

describe('context-draft → staging file', () => {
  it('staging file does not exist before runDraft', async () => {
    const exists = await fileExists(draftStagingPath(SESSION_ID));
    expect(exists).toBe(false);
  });

  it('staging file is created after runDraft with draftable candidates', async () => {
    await runDraft(
      SESSION_ID,
      repoDir,
      vi.fn().mockResolvedValue(DRAFTABLE_SUMMARY),
      vi.fn().mockResolvedValue(MOCK_LLM_RESPONSE),
      'test-api-key',
      saveDraft,
    );
    const exists = await fileExists(draftStagingPath(SESSION_ID));
    expect(exists).toBe(true);
  });

  it('staging file contains the expected session_id', async () => {
    await runDraft(
      SESSION_ID,
      repoDir,
      vi.fn().mockResolvedValue(DRAFTABLE_SUMMARY),
      vi.fn().mockResolvedValue(MOCK_LLM_RESPONSE),
      'test-api-key',
      saveDraft,
    );
    const file = await loadDraft(SESSION_ID);
    expect(file).not.toBeNull();
    expect(file?.session_id).toBe(SESSION_ID);
  });

  it('staging file contains the expected patch with correct target_file', async () => {
    await runDraft(
      SESSION_ID,
      repoDir,
      vi.fn().mockResolvedValue(DRAFTABLE_SUMMARY),
      vi.fn().mockResolvedValue(MOCK_LLM_RESPONSE),
      'test-api-key',
      saveDraft,
    );
    const file = await loadDraft(SESSION_ID);
    expect(file?.patches).toHaveLength(1);
    expect(file?.patches[0]?.target_file).toBe('CLAUDE.md');
  });

  it('staging file patch contains the known unified diff', async () => {
    await runDraft(
      SESSION_ID,
      repoDir,
      vi.fn().mockResolvedValue(DRAFTABLE_SUMMARY),
      vi.fn().mockResolvedValue(MOCK_LLM_RESPONSE),
      'test-api-key',
      saveDraft,
    );
    const file = await loadDraft(SESSION_ID);
    expect(file?.patches[0]?.unified_diff).toBe(KNOWN_DIFF);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: runApply consumes staging file, creates target, clears staging
// ---------------------------------------------------------------------------

describe('context-apply → target created, staging file removed', () => {
  beforeEach(async () => {
    // Pre-populate the staging file (as if runDraft had already run)
    await saveDraft(SESSION_ID, [
      {
        target_file: 'CLAUDE.md',
        recommendation_kind: 'claude_md',
        confidence: 0.88,
        severity: 'high',
        evidence_count: 10,
        unified_diff: KNOWN_DIFF,
      },
    ]);
  });

  it('target file is created on disk after runApply', async () => {
    await runApply(
      SESSION_ID,
      repoDir,
      loadDraft,
      async () => true, // auto-confirm
      applyPatchToFs, // real file writer
      async () => '', // mock git diff
      clearDraft,
    );
    const targetExists = await fileExists(join(repoDir, 'CLAUDE.md'));
    expect(targetExists).toBe(true);
  });

  it('target file contains the expected content', async () => {
    await runApply(
      SESSION_ID,
      repoDir,
      loadDraft,
      async () => true,
      applyPatchToFs,
      async () => '',
      clearDraft,
    );
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(join(repoDir, 'CLAUDE.md'), 'utf8');
    expect(content).toContain('Frequently Accessed Files');
    expect(content).toContain('src/router.ts');
  });

  it('staging file is removed after successful runApply', async () => {
    await runApply(
      SESSION_ID,
      repoDir,
      loadDraft,
      async () => true,
      applyPatchToFs,
      async () => '',
      clearDraft,
    );
    const stagingExists = await fileExists(draftStagingPath(SESSION_ID));
    expect(stagingExists).toBe(false);
  });

  it('staging file is NOT removed when user does not confirm', async () => {
    await runApply(
      SESSION_ID,
      repoDir,
      loadDraft,
      async () => false, // user declines
      applyPatchToFs,
      async () => '',
      clearDraft,
    );
    const stagingExists = await fileExists(draftStagingPath(SESSION_ID));
    expect(stagingExists).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: full end-to-end lifecycle (draft → apply)
// ---------------------------------------------------------------------------

describe('full draft → apply lifecycle', () => {
  it('draft then apply: staging file created then removed, target file created', async () => {
    // Step 1: draft
    await runDraft(
      SESSION_ID,
      repoDir,
      vi.fn().mockResolvedValue(DRAFTABLE_SUMMARY),
      vi.fn().mockResolvedValue(MOCK_LLM_RESPONSE),
      'test-api-key',
      saveDraft,
    );

    // Intermediate: staging file must exist
    const stagingAfterDraft = await fileExists(draftStagingPath(SESSION_ID));
    expect(stagingAfterDraft).toBe(true);

    // Step 2: apply
    await runApply(
      SESSION_ID,
      repoDir,
      loadDraft,
      async () => true,
      applyPatchToFs,
      async () => '',
      clearDraft,
    );

    // Final: target file exists, staging file removed
    const targetExists = await fileExists(join(repoDir, 'CLAUDE.md'));
    const stagingAfterApply = await fileExists(draftStagingPath(SESSION_ID));

    expect(targetExists).toBe(true);
    expect(stagingAfterApply).toBe(false);
  });
});
