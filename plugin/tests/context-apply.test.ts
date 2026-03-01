import { describe, expect, it, vi } from 'vitest';
import { runApply } from '../src/context-apply.js';
import type { DraftPatch, DraftStagingFile } from '../src/patch-generator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session-abc123';
const CWD = '/tmp/test-repo';

const PATCH_A: DraftPatch = {
  target_file: 'CLAUDE.md',
  recommendation_kind: 'claude_md',
  confidence: 0.88,
  severity: 'high',
  evidence_count: 10,
  unified_diff:
    '--- /dev/null\n+++ CLAUDE.md\n@@ -0,0 +1,3 @@\n+## Frequently Accessed Files\n+\n+- `src/router.ts`: Core routing',
};

const PATCH_B: DraftPatch = {
  target_file: '.claude/skills/build-test/SKILL.md',
  recommendation_kind: 'skill',
  confidence: 0.83,
  severity: 'medium',
  evidence_count: 5,
  unified_diff:
    '--- /dev/null\n+++ .claude/skills/build-test/SKILL.md\n@@ -0,0 +1,3 @@\n+---\n+description: Build and test\n+---',
};

const STAGING_FILE: DraftStagingFile = {
  session_id: SESSION_ID,
  created_at: Math.floor(Date.now() / 1000),
  patches: [PATCH_A, PATCH_B],
};

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

function makeLoadDraft(result: DraftStagingFile | null) {
  return vi.fn().mockResolvedValue(result);
}

function makeConfirmFn(answer: boolean) {
  return vi.fn().mockResolvedValue(answer);
}

function makeApplyFn(results: Array<{ success: boolean; error?: string }>) {
  let callIndex = 0;
  return vi.fn().mockImplementation(() => {
    const result = results[callIndex] ?? { success: true };
    callIndex++;
    return Promise.resolve(result);
  });
}

function makeGitDiffFn(output: string) {
  return vi.fn().mockResolvedValue(output);
}

function makeClearDraftFn() {
  return vi.fn().mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Tests: no staging file
// ---------------------------------------------------------------------------

describe('runApply — no staging file', () => {
  it('returns a message directing user to run /context-draft when staging file is absent', async () => {
    const output = await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(null),
      makeConfirmFn(true),
      makeApplyFn([{ success: true }]),
      makeGitDiffFn(''),
      makeClearDraftFn(),
    );
    expect(output).toMatch(/context.draft/i);
    expect(output).toMatch(/no.*draft|staging.*not found|run.*context.draft/i);
  });

  it('does not call confirmFn when staging file is absent', async () => {
    const confirmFn = makeConfirmFn(true);
    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(null),
      confirmFn,
      makeApplyFn([]),
      makeGitDiffFn(''),
      makeClearDraftFn(),
    );
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('does not call applyFn when staging file is absent', async () => {
    const applyFn = makeApplyFn([]);
    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(null),
      makeConfirmFn(true),
      applyFn,
      makeGitDiffFn(''),
      makeClearDraftFn(),
    );
    expect(applyFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: display patches + confirmation
// ---------------------------------------------------------------------------

describe('runApply — patch display and confirmation', () => {
  it('displays patch metadata in the output before confirmation', async () => {
    const confirmFn = makeConfirmFn(false); // user declines
    const output = await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      confirmFn,
      makeApplyFn([]),
      makeGitDiffFn(''),
      makeClearDraftFn(),
    );
    expect(output).toContain('CLAUDE.md');
    expect(output).toContain('.claude/skills/build-test/SKILL.md');
  });

  it('displays confidence for each patch', async () => {
    const output = await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirmFn(false),
      makeApplyFn([]),
      makeGitDiffFn(''),
      makeClearDraftFn(),
    );
    // PATCH_A has 88% confidence, PATCH_B has 83%
    expect(output).toMatch(/88%|0\.88/);
  });

  it('calls confirmFn once when staging file is present', async () => {
    const confirmFn = makeConfirmFn(true);
    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      confirmFn,
      makeApplyFn([{ success: true }, { success: true }]),
      makeGitDiffFn(''),
      makeClearDraftFn(),
    );
    expect(confirmFn).toHaveBeenCalledOnce();
  });

  it('does not call applyFn when user declines', async () => {
    const applyFn = makeApplyFn([]);
    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirmFn(false),
      applyFn,
      makeGitDiffFn(''),
      makeClearDraftFn(),
    );
    expect(applyFn).not.toHaveBeenCalled();
  });

  it('returns a cancellation message when user declines', async () => {
    const output = await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirmFn(false),
      makeApplyFn([]),
      makeGitDiffFn(''),
      makeClearDraftFn(),
    );
    expect(output).toMatch(/cancel|abort|not applied|declined/i);
  });
});

// ---------------------------------------------------------------------------
// Tests: patch application
// ---------------------------------------------------------------------------

describe('runApply — patch application', () => {
  it('calls applyFn for each patch when user confirms', async () => {
    const applyFn = makeApplyFn([{ success: true }, { success: true }]);
    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirmFn(true),
      applyFn,
      makeGitDiffFn(''),
      makeClearDraftFn(),
    );
    expect(applyFn).toHaveBeenCalledTimes(2);
  });

  it('passes each patch and cwd to applyFn', async () => {
    const applyFn = makeApplyFn([{ success: true }, { success: true }]);
    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirmFn(true),
      applyFn,
      makeGitDiffFn(''),
      makeClearDraftFn(),
    );
    expect(applyFn).toHaveBeenCalledWith(PATCH_A, CWD);
    expect(applyFn).toHaveBeenCalledWith(PATCH_B, CWD);
  });

  it('runs git diff after all patches are applied', async () => {
    const gitDiffFn = makeGitDiffFn('diff --git a/CLAUDE.md b/CLAUDE.md\n...');
    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirmFn(true),
      makeApplyFn([{ success: true }, { success: true }]),
      gitDiffFn,
      makeClearDraftFn(),
    );
    expect(gitDiffFn).toHaveBeenCalledOnce();
    expect(gitDiffFn).toHaveBeenCalledWith(CWD);
  });

  it('includes git diff output in the final result', async () => {
    const output = await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirmFn(true),
      makeApplyFn([{ success: true }, { success: true }]),
      makeGitDiffFn('diff --git a/CLAUDE.md b/CLAUDE.md\n+++ added line'),
      makeClearDraftFn(),
    );
    expect(output).toContain('diff --git');
    expect(output).toContain('+++ added line');
  });

  it('calls clearDraftFn after successful application', async () => {
    const clearDraftFn = makeClearDraftFn();
    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirmFn(true),
      makeApplyFn([{ success: true }, { success: true }]),
      makeGitDiffFn(''),
      clearDraftFn,
    );
    expect(clearDraftFn).toHaveBeenCalledOnce();
    expect(clearDraftFn).toHaveBeenCalledWith(SESSION_ID);
  });

  it('does not call clearDraftFn when user declines', async () => {
    const clearDraftFn = makeClearDraftFn();
    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirmFn(false),
      makeApplyFn([]),
      makeGitDiffFn(''),
      clearDraftFn,
    );
    expect(clearDraftFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: error handling per requirement 10.7
// ---------------------------------------------------------------------------

describe('runApply — error handling', () => {
  it('reports the specific file path when a patch fails', async () => {
    const output = await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirmFn(true),
      makeApplyFn([{ success: false, error: 'Permission denied' }, { success: true }]),
      makeGitDiffFn(''),
      makeClearDraftFn(),
    );
    expect(output).toContain('CLAUDE.md');
    expect(output).toContain('Permission denied');
  });

  it('continues applying remaining patches after a failure', async () => {
    const applyFn = makeApplyFn([{ success: false, error: 'Cannot write' }, { success: true }]);
    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirmFn(true),
      applyFn,
      makeGitDiffFn(''),
      makeClearDraftFn(),
    );
    // applyFn should be called for both patches
    expect(applyFn).toHaveBeenCalledTimes(2);
  });

  it('reports both successful and failed patches in the output', async () => {
    const output = await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirmFn(true),
      makeApplyFn([{ success: false, error: 'Cannot write' }, { success: true }]),
      makeGitDiffFn(''),
      makeClearDraftFn(),
    );
    expect(output).toMatch(/fail|error/i);
    expect(output).toMatch(/success|applied/i);
  });

  it('still calls clearDraftFn even when some patches fail', async () => {
    const clearDraftFn = makeClearDraftFn();
    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirmFn(true),
      makeApplyFn([{ success: false, error: 'Error' }, { success: true }]),
      makeGitDiffFn(''),
      clearDraftFn,
    );
    expect(clearDraftFn).toHaveBeenCalledOnce();
  });

  it('still runs git diff even when some patches fail', async () => {
    const gitDiffFn = makeGitDiffFn('');
    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirmFn(true),
      makeApplyFn([{ success: false, error: 'Error' }, { success: true }]),
      gitDiffFn,
      makeClearDraftFn(),
    );
    expect(gitDiffFn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Tests: applyPatchToFs (filesystem-level patch application)
// ---------------------------------------------------------------------------

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach as aE, beforeEach as bE, describe as d2, it as it2 } from 'vitest';
import { applyPatchToFs } from '../src/context-apply.js';

d2('applyPatchToFs', () => {
  let tmpDir: string;

  bE(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'apply-test-'));
  });

  aE(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it2('creates a new file when the diff has --- /dev/null', async () => {
    const patch: DraftPatch = {
      target_file: 'CLAUDE.md',
      recommendation_kind: 'claude_md',
      confidence: 0.88,
      severity: 'high',
      evidence_count: 10,
      unified_diff: '--- /dev/null\n+++ CLAUDE.md\n@@ -0,0 +1,3 @@\n+## Files\n+\n+- src/router.ts',
    };
    const result = await applyPatchToFs(patch, tmpDir);
    expect(result.success).toBe(true);
    const content = await readFile(join(tmpDir, 'CLAUDE.md'), 'utf8');
    expect(content).toContain('## Files');
    expect(content).toContain('src/router.ts');
  });

  it2('creates parent directories for nested target files', async () => {
    const patch: DraftPatch = {
      target_file: '.claude/skills/build/SKILL.md',
      recommendation_kind: 'skill',
      confidence: 0.83,
      severity: 'medium',
      evidence_count: 5,
      unified_diff:
        '--- /dev/null\n+++ .claude/skills/build/SKILL.md\n@@ -0,0 +1,2 @@\n+---\n+description: build',
    };
    const result = await applyPatchToFs(patch, tmpDir);
    expect(result.success).toBe(true);
    const content = await readFile(join(tmpDir, '.claude', 'skills', 'build', 'SKILL.md'), 'utf8');
    expect(content).toContain('description: build');
  });

  it2('strips leading + from diff lines when creating a new file', async () => {
    const patch: DraftPatch = {
      target_file: 'output.md',
      recommendation_kind: 'claude_md',
      confidence: 0.88,
      severity: 'high',
      evidence_count: 5,
      unified_diff: '--- /dev/null\n+++ output.md\n@@ -0,0 +1,2 @@\n+line one\n+line two',
    };
    await applyPatchToFs(patch, tmpDir);
    const content = await readFile(join(tmpDir, 'output.md'), 'utf8');
    expect(content).toBe('line one\nline two\n');
  });

  it2('returns success: false when writing to an unwritable path', async () => {
    const patch: DraftPatch = {
      target_file: '\x00invalid/path/\x00',
      recommendation_kind: 'claude_md',
      confidence: 0.88,
      severity: 'high',
      evidence_count: 5,
      unified_diff: '--- /dev/null\n+++ invalid\n@@ -0,0 +1,1 @@\n+content',
    };
    const result = await applyPatchToFs(patch, tmpDir);
    // Should return failure rather than throwing
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
