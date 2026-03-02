import { describe, expect, it, vi } from 'vitest';
import { runApply } from '../src/context-apply.js';
import type { DraftPatch, DraftStagingFile } from '../src/patch-generator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session-git-commit';
const CWD = '/tmp/test-repo';

const PATCH_A: DraftPatch = {
  target_file: 'CLAUDE.md',
  recommendation_kind: 'claude_md',
  confidence: 0.88,
  severity: 'high',
  evidence_count: 10,
  unified_diff: '--- /dev/null\n+++ CLAUDE.md\n@@ -0,0 +1,2 @@\n+## Files\n+- src/router.ts',
};

const PATCH_B: DraftPatch = {
  target_file: '.claude/skills/build/SKILL.md',
  recommendation_kind: 'skill',
  confidence: 0.83,
  severity: 'medium',
  evidence_count: 5,
  unified_diff:
    '--- /dev/null\n+++ .claude/skills/build/SKILL.md\n@@ -0,0 +1,2 @@\n+---\n+description: build',
};

const STAGING_FILE: DraftStagingFile = {
  session_id: SESSION_ID,
  created_at: Math.floor(Date.now() / 1000),
  patches: [PATCH_A, PATCH_B],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLoadDraft(result: DraftStagingFile | null) {
  return vi.fn().mockResolvedValue(result);
}
function makeConfirm(answer: boolean) {
  return vi.fn().mockResolvedValue(answer);
}
function makeApplyAll() {
  return vi.fn().mockResolvedValue({ success: true });
}
function makeGitDiff(out = '') {
  return vi.fn().mockResolvedValue(out);
}
function makeClearDraft() {
  return vi.fn().mockResolvedValue(undefined);
}
function makeGitCommit(result: { success: boolean; output: string }) {
  return vi.fn().mockResolvedValue(result);
}

// ---------------------------------------------------------------------------
// auto_pr = false (default): no commit, instruct manual
// ---------------------------------------------------------------------------

describe('runApply — auto_pr = false', () => {
  it('does not call gitCommitFn when auto_pr is false', async () => {
    const gitCommitFn = makeGitCommit({ success: true, output: '' });

    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirm(true),
      makeApplyAll(),
      makeGitDiff(),
      makeClearDraft(),
      { auto_pr: false, gitCommitFn },
    );

    expect(gitCommitFn).not.toHaveBeenCalled();
  });

  it('does not call gitCommitFn when auto_pr option is omitted', async () => {
    const gitCommitFn = makeGitCommit({ success: true, output: '' });

    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirm(true),
      makeApplyAll(),
      makeGitDiff(),
      makeClearDraft(),
      { gitCommitFn },
    );

    expect(gitCommitFn).not.toHaveBeenCalled();
  });

  it('includes a manual-commit suggestion in the output when auto_pr is false', async () => {
    const output = await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirm(true),
      makeApplyAll(),
      makeGitDiff('diff --git a/CLAUDE.md b/CLAUDE.md'),
      makeClearDraft(),
      { auto_pr: false },
    );

    expect(output).toMatch(/commit manually|git commit|manually commit/i);
  });
});

// ---------------------------------------------------------------------------
// auto_pr = true: run git commit
// ---------------------------------------------------------------------------

describe('runApply — auto_pr = true', () => {
  it('calls gitCommitFn when auto_pr is true and patches were applied', async () => {
    const gitCommitFn = makeGitCommit({ success: true, output: '[main abc1234] ...' });

    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirm(true),
      makeApplyAll(),
      makeGitDiff(),
      makeClearDraft(),
      { auto_pr: true, gitCommitFn },
    );

    expect(gitCommitFn).toHaveBeenCalledOnce();
  });

  it('passes cwd to gitCommitFn', async () => {
    const gitCommitFn = makeGitCommit({ success: true, output: '' });

    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirm(true),
      makeApplyAll(),
      makeGitDiff(),
      makeClearDraft(),
      { auto_pr: true, gitCommitFn },
    );

    expect(gitCommitFn).toHaveBeenCalledWith(CWD, expect.any(String));
  });

  it('commit message includes applied file names', async () => {
    const gitCommitFn = makeGitCommit({ success: true, output: '' });

    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirm(true),
      makeApplyAll(),
      makeGitDiff(),
      makeClearDraft(),
      { auto_pr: true, gitCommitFn },
    );

    const [, commitMessage] = gitCommitFn.mock.calls[0] as [string, string];
    expect(commitMessage).toMatch(/CLAUDE\.md|context.optimizer/i);
  });

  it('includes git commit output in the result when commit succeeds', async () => {
    const output = await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirm(true),
      makeApplyAll(),
      makeGitDiff(),
      makeClearDraft(),
      {
        auto_pr: true,
        gitCommitFn: makeGitCommit({
          success: true,
          output: '[main abc1234] Apply context-evalver recommendations',
        }),
      },
    );

    expect(output).toContain('[main abc1234]');
  });

  it('does not call gitCommitFn when no patches were applied (all failed)', async () => {
    const gitCommitFn = makeGitCommit({ success: true, output: '' });
    const applyFn = vi.fn().mockResolvedValue({ success: false, error: 'Permission denied' });

    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirm(true),
      applyFn,
      makeGitDiff(),
      makeClearDraft(),
      { auto_pr: true, gitCommitFn },
    );

    expect(gitCommitFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// git commit failure handling
// ---------------------------------------------------------------------------

describe('runApply — git commit failure', () => {
  it('reports git commit error in the output when commit fails', async () => {
    const output = await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirm(true),
      makeApplyAll(),
      makeGitDiff(),
      makeClearDraft(),
      {
        auto_pr: true,
        gitCommitFn: makeGitCommit({ success: false, output: 'error: nothing to commit' }),
      },
    );

    expect(output).toMatch(/git.*fail|commit.*fail|error.*commit/i);
    expect(output).toContain('nothing to commit');
  });

  it('suggests manual resolution when git commit fails', async () => {
    const output = await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirm(true),
      makeApplyAll(),
      makeGitDiff(),
      makeClearDraft(),
      {
        auto_pr: true,
        gitCommitFn: makeGitCommit({ success: false, output: 'fatal: not a git repository' }),
      },
    );

    expect(output).toMatch(/manual|resolve|commit.*manually/i);
  });

  it('still calls clearDraftFn even when git commit fails', async () => {
    const clearDraftFn = makeClearDraft();

    await runApply(
      SESSION_ID,
      CWD,
      makeLoadDraft(STAGING_FILE),
      makeConfirm(true),
      makeApplyAll(),
      makeGitDiff(),
      clearDraftFn,
      {
        auto_pr: true,
        gitCommitFn: makeGitCommit({ success: false, output: 'error: nothing to commit' }),
      },
    );

    expect(clearDraftFn).toHaveBeenCalledOnce();
  });
});
