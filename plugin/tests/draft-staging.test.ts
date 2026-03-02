import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DraftPatch } from '../src/patch-generator.js';
import { clearDraft, draftStagingPath, loadDraft, saveDraft } from '../src/patch-generator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session-abc123';

const PATCH_A: DraftPatch = {
  target_file: 'CLAUDE.md',
  recommendation_kind: 'claude_md',
  confidence: 0.88,
  severity: 'high',
  evidence_count: 10,
  unified_diff: '--- CLAUDE.md\n+++ CLAUDE.md\n@@ -0,0 +1,2 @@\n+## Files\n+- src/router.ts',
};

const PATCH_B: DraftPatch = {
  target_file: '.claude/skills/build-test/SKILL.md',
  recommendation_kind: 'skill',
  confidence: 0.83,
  severity: 'medium',
  evidence_count: 5,
  unified_diff:
    '--- /dev/null\n+++ .claude/skills/build-test/SKILL.md\n@@ -0,0 +1,2 @@\n+---\n+description: Build and test',
};

// ---------------------------------------------------------------------------
// Test setup: override XDG_DATA_HOME to a temp directory
// ---------------------------------------------------------------------------

let tmpDir: string;
let origXdg: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'context-evalver-test-'));
  origXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = tmpDir;
});

afterEach(async () => {
  if (origXdg !== undefined) {
    process.env.XDG_DATA_HOME = origXdg;
  } else {
    delete process.env.XDG_DATA_HOME;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// draftStagingPath
// ---------------------------------------------------------------------------

describe('draftStagingPath', () => {
  it('returns a path ending with {session_id}.json', () => {
    const p = draftStagingPath(SESSION_ID);
    expect(p).toMatch(new RegExp(`${SESSION_ID}\\.json$`));
  });

  it('includes "drafts" directory component', () => {
    const p = draftStagingPath(SESSION_ID);
    expect(p).toContain('drafts');
  });

  it('uses XDG_DATA_HOME when set', () => {
    const p = draftStagingPath(SESSION_ID);
    expect(p).toContain(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// saveDraft
// ---------------------------------------------------------------------------

describe('saveDraft', () => {
  it('creates the drafts directory if it does not exist', async () => {
    await saveDraft(SESSION_ID, [PATCH_A]);
    // If this didn't throw, the directory was created successfully
    const { access } = await import('node:fs/promises');
    await expect(access(draftStagingPath(SESSION_ID))).resolves.toBeUndefined();
  });

  it('writes a valid JSON file', async () => {
    await saveDraft(SESSION_ID, [PATCH_A]);
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(draftStagingPath(SESSION_ID), 'utf8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('includes session_id in the staging file', async () => {
    await saveDraft(SESSION_ID, [PATCH_A]);
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(draftStagingPath(SESSION_ID), 'utf8');
    const parsed = JSON.parse(raw) as { session_id: string };
    expect(parsed.session_id).toBe(SESSION_ID);
  });

  it('includes created_at as a number (unix epoch seconds)', async () => {
    const before = Math.floor(Date.now() / 1000);
    await saveDraft(SESSION_ID, [PATCH_A]);
    const after = Math.floor(Date.now() / 1000);
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(draftStagingPath(SESSION_ID), 'utf8');
    const parsed = JSON.parse(raw) as { created_at: number };
    expect(parsed.created_at).toBeGreaterThanOrEqual(before);
    expect(parsed.created_at).toBeLessThanOrEqual(after);
  });

  it('serializes all patches with correct fields', async () => {
    await saveDraft(SESSION_ID, [PATCH_A, PATCH_B]);
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(draftStagingPath(SESSION_ID), 'utf8');
    const parsed = JSON.parse(raw) as { patches: DraftPatch[] };
    expect(parsed.patches).toHaveLength(2);
    expect(parsed.patches[0]).toMatchObject(PATCH_A);
    expect(parsed.patches[1]).toMatchObject(PATCH_B);
  });

  it('overwrites an existing staging file', async () => {
    await saveDraft(SESSION_ID, [PATCH_A]);
    await saveDraft(SESSION_ID, [PATCH_B]);
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(draftStagingPath(SESSION_ID), 'utf8');
    const parsed = JSON.parse(raw) as { patches: DraftPatch[] };
    expect(parsed.patches).toHaveLength(1);
    expect(parsed.patches[0]?.recommendation_kind).toBe('skill');
  });

  it('persists an empty patches array without error', async () => {
    await saveDraft(SESSION_ID, []);
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(draftStagingPath(SESSION_ID), 'utf8');
    const parsed = JSON.parse(raw) as { patches: DraftPatch[] };
    expect(parsed.patches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadDraft
// ---------------------------------------------------------------------------

describe('loadDraft', () => {
  it('returns null when the staging file does not exist', async () => {
    const result = await loadDraft(SESSION_ID);
    expect(result).toBeNull();
  });

  it('returns the parsed DraftStagingFile when the file exists', async () => {
    await saveDraft(SESSION_ID, [PATCH_A]);
    const result = await loadDraft(SESSION_ID);
    expect(result).not.toBeNull();
    expect(result?.session_id).toBe(SESSION_ID);
  });

  it('round-trips patches through save and load', async () => {
    await saveDraft(SESSION_ID, [PATCH_A, PATCH_B]);
    const result = await loadDraft(SESSION_ID);
    expect(result?.patches).toHaveLength(2);
    expect(result?.patches[0]).toMatchObject(PATCH_A);
    expect(result?.patches[1]).toMatchObject(PATCH_B);
  });

  it('returns null for a different session_id (file not found)', async () => {
    await saveDraft(SESSION_ID, [PATCH_A]);
    const result = await loadDraft('different-session-id');
    expect(result).toBeNull();
  });

  it('returns null when the file contains invalid JSON', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const stagingPath = draftStagingPath(SESSION_ID);
    const { dirname } = await import('node:path');
    await mkdir(dirname(stagingPath), { recursive: true });
    await writeFile(stagingPath, 'not valid json', 'utf8');
    const result = await loadDraft(SESSION_ID);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// clearDraft
// ---------------------------------------------------------------------------

describe('clearDraft', () => {
  it('deletes the staging file when it exists', async () => {
    await saveDraft(SESSION_ID, [PATCH_A]);
    await clearDraft(SESSION_ID);
    const result = await loadDraft(SESSION_ID);
    expect(result).toBeNull();
  });

  it('does not throw when the staging file does not exist', async () => {
    await expect(clearDraft(SESSION_ID)).resolves.toBeUndefined();
  });

  it('does not affect staging files for other sessions', async () => {
    const otherSession = 'other-session-xyz';
    await saveDraft(SESSION_ID, [PATCH_A]);
    await saveDraft(otherSession, [PATCH_B]);

    await clearDraft(SESSION_ID);

    const other = await loadDraft(otherSession);
    expect(other).not.toBeNull();
    expect(other?.patches[0]?.recommendation_kind).toBe('skill');
  });
});
