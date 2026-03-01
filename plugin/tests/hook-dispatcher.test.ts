import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process before importing the module under test
vi.mock('node:child_process', () => {
  const mockProcess = {
    unref: vi.fn(),
    on: vi.fn(),
    pid: 12345,
  };
  return { spawn: vi.fn().mockReturnValue(mockProcess) };
});

import { spawn } from 'node:child_process';
import type { HookInput } from '../src/event-capture.js';
import { handleSessionStart } from '../src/hook-dispatcher.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionStartInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: 'test-session-abc',
    hook_event_name: 'SessionStart',
    cwd: '/repo',
    transcript_path: '/tmp/transcript.json',
    permission_mode: 'default',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleSessionStart — ignore file check
// ---------------------------------------------------------------------------

describe('handleSessionStart — ignore file', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hook-dispatcher-test-'));
    vi.clearAllMocks();
    vi.mocked(spawn).mockReturnValue({
      unref: vi.fn(),
      on: vi.fn(),
      pid: 1,
    } as unknown as ReturnType<typeof spawn>);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('does nothing when .context-optimizer-ignore exists in cwd', async () => {
    await writeFile(join(tmpDir, '.context-optimizer-ignore'), '');
    const input = makeSessionStartInput({ cwd: tmpDir });
    await handleSessionStart(input, { binPath: '/usr/bin/true', startupDelayMs: 0 });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns daemon when no ignore file exists', async () => {
    const input = makeSessionStartInput({ cwd: tmpDir });
    await handleSessionStart(input, { binPath: '/usr/bin/true', startupDelayMs: 0 });
    expect(spawn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleSessionStart — daemon spawn
// ---------------------------------------------------------------------------

const mockChild = {
  unref: vi.fn(),
  on: vi.fn(),
  pid: 12345,
};

describe('handleSessionStart — daemon spawn', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hook-dispatcher-test-'));
    vi.clearAllMocks();
    vi.mocked(spawn).mockReturnValue(mockChild as ReturnType<typeof spawn>);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('spawns daemon with --session-id argument', async () => {
    const input = makeSessionStartInput({ cwd: tmpDir, session_id: 'my-sess-42' });
    await handleSessionStart(input, { binPath: 'context-optimizer-core', startupDelayMs: 0 });
    const spawnMock = vi.mocked(spawn);
    const [_bin, args] = spawnMock.mock.calls[0]!;
    expect(args).toContain('--session-id');
    expect(args).toContain('my-sess-42');
  });

  it('spawns daemon with --repo-root argument set to cwd', async () => {
    const input = makeSessionStartInput({ cwd: tmpDir });
    await handleSessionStart(input, { binPath: 'context-optimizer-core', startupDelayMs: 0 });
    const spawnMock = vi.mocked(spawn);
    const [_bin, args] = spawnMock.mock.calls[0]!;
    expect(args).toContain('--repo-root');
    expect(args).toContain(tmpDir);
  });

  it('spawns daemon using the provided binPath', async () => {
    const input = makeSessionStartInput({ cwd: tmpDir });
    await handleSessionStart(input, { binPath: '/custom/path/daemon', startupDelayMs: 0 });
    const spawnMock = vi.mocked(spawn);
    const [bin] = spawnMock.mock.calls[0]!;
    expect(bin).toBe('/custom/path/daemon');
  });

  it('calls unref() on the spawned process to detach it', async () => {
    const input = makeSessionStartInput({ cwd: tmpDir });
    await handleSessionStart(input, { binPath: 'context-optimizer-core', startupDelayMs: 0 });
    expect(mockChild.unref).toHaveBeenCalled();
  });

  it('spawns with detached: true in options', async () => {
    const input = makeSessionStartInput({ cwd: tmpDir });
    await handleSessionStart(input, { binPath: 'context-optimizer-core', startupDelayMs: 0 });
    const spawnMock = vi.mocked(spawn);
    const [_bin, _args, opts] = spawnMock.mock.calls[0]!;
    expect(opts?.detached).toBe(true);
  });

  it('does not throw when daemon spawn fails', async () => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error('binary not found');
    });
    const input = makeSessionStartInput({ cwd: tmpDir });
    await expect(
      handleSessionStart(input, { binPath: '/nonexistent/daemon', startupDelayMs: 0 }),
    ).resolves.toBeUndefined();
  });

  it('logs to stderr when daemon spawn fails', async () => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    const input = makeSessionStartInput({ cwd: tmpDir });
    await handleSessionStart(input, { binPath: '/nonexistent/daemon', startupDelayMs: 0 });
    expect(process.stderr.write).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleSessionStart — returns promptly
// ---------------------------------------------------------------------------

describe('handleSessionStart — returns promptly', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hook-dispatcher-test-'));
    vi.clearAllMocks();
    vi.mocked(spawn).mockReturnValue({
      unref: vi.fn(),
      on: vi.fn(),
      pid: 1,
    } as unknown as ReturnType<typeof spawn>);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('resolves without waiting for the startup delay', async () => {
    const input = makeSessionStartInput({ cwd: tmpDir });
    const start = Date.now();
    // Use a 5000ms delay — it should NOT block
    await handleSessionStart(input, { binPath: 'context-optimizer-core', startupDelayMs: 5000 });
    const elapsed = Date.now() - start;
    // Should return immediately (well under 500ms even accounting for test overhead)
    expect(elapsed).toBeLessThan(500);
  });
});
