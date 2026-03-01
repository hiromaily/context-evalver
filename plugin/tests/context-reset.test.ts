import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runReset } from '../src/context-reset.js';

const SESSION_ID = 'test-session-reset';
const CWD = '/tmp/test-repo';

function makeConfirm(answer: boolean) {
  return vi.fn().mockResolvedValue(answer);
}
function makeResetFn(result: { success: boolean; error?: string }) {
  return vi.fn().mockResolvedValue(result);
}

// ---------------------------------------------------------------------------
// runReset — no confirmation
// ---------------------------------------------------------------------------

describe('runReset — declined confirmation', () => {
  it('includes a warning about clearing throttle history', async () => {
    const output = await runReset(
      SESSION_ID,
      CWD,
      makeConfirm(false),
      makeResetFn({ success: true }),
    );
    expect(output).toMatch(/throttle|history|clear|reset/i);
    expect(output).toMatch(/warning|caution|will be cleared/i);
  });

  it('does not call resetFn when user declines', async () => {
    const resetFn = makeResetFn({ success: true });
    await runReset(SESSION_ID, CWD, makeConfirm(false), resetFn);
    expect(resetFn).not.toHaveBeenCalled();
  });

  it('returns a cancellation message when user declines', async () => {
    const output = await runReset(
      SESSION_ID,
      CWD,
      makeConfirm(false),
      makeResetFn({ success: true }),
    );
    expect(output).toMatch(/cancel|abort|not.*reset|declined/i);
  });
});

// ---------------------------------------------------------------------------
// runReset — confirmed
// ---------------------------------------------------------------------------

describe('runReset — confirmed', () => {
  it('calls resetFn with the repo root when user confirms', async () => {
    const resetFn = makeResetFn({ success: true });
    await runReset(SESSION_ID, CWD, makeConfirm(true), resetFn);
    expect(resetFn).toHaveBeenCalledOnce();
    expect(resetFn).toHaveBeenCalledWith(CWD);
  });

  it('returns a success confirmation message', async () => {
    const output = await runReset(
      SESSION_ID,
      CWD,
      makeConfirm(true),
      makeResetFn({ success: true }),
    );
    expect(output).toMatch(/success|reset.*complete|cleared|done/i);
  });

  it('output mentions throttle or suggestion history was cleared', async () => {
    const output = await runReset(
      SESSION_ID,
      CWD,
      makeConfirm(true),
      makeResetFn({ success: true }),
    );
    expect(output).toMatch(/throttle|suggestion.*history|history.*cleared/i);
  });
});

// ---------------------------------------------------------------------------
// runReset — reset failure
// ---------------------------------------------------------------------------

describe('runReset — reset failure', () => {
  it('reports the error when resetFn fails', async () => {
    const output = await runReset(
      SESSION_ID,
      CWD,
      makeConfirm(true),
      makeResetFn({ success: false, error: 'daemon unreachable' }),
    );
    expect(output).toMatch(/fail|error/i);
    expect(output).toContain('daemon unreachable');
  });

  it('does not show success message when reset fails', async () => {
    const output = await runReset(
      SESSION_ID,
      CWD,
      makeConfirm(true),
      makeResetFn({ success: false, error: 'connection refused' }),
    );
    expect(output).not.toMatch(/success|cleared.*successfully/i);
  });
});

// ---------------------------------------------------------------------------
// context-reset SKILL.md
// ---------------------------------------------------------------------------

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillMdPath = join(pluginRoot, 'skills', 'context-reset', 'SKILL.md');
const content = readFileSync(skillMdPath, 'utf-8');

describe('context-reset SKILL.md', () => {
  it('has YAML frontmatter', () => {
    expect(content).toMatch(/^---\n/);
    expect(content.indexOf('---', 3)).toBeGreaterThan(3);
  });

  it('has a non-empty description in frontmatter', () => {
    expect(content).toMatch(/^---[\s\S]*?description:\s*.+/m);
  });

  it('description mentions reset or confidence history', () => {
    const fmEnd = content.indexOf('---', 3);
    const frontmatter = content.slice(0, fmEnd + 3);
    expect(frontmatter).toMatch(/reset|confidence|throttle|history/i);
  });

  it('references the compiled script', () => {
    expect(content).toMatch(/node|dist\/context.reset|npx/i);
  });

  it('warns about destructive nature or data loss', () => {
    expect(content).toMatch(/warning|caution|clear|destruct|irreversible/i);
  });

  it('mentions user confirmation is required', () => {
    expect(content).toMatch(/confirm|confirmation|explicit/i);
  });
});
