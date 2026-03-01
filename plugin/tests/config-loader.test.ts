import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, loadConfig } from '../src/config-loader.js';

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'config-loader-test-'));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Defaults
  // --------------------------------------------------------------------------

  it('returns all defaults when config file is absent', () => {
    const config = loadConfig(tmpDir);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('returns analysis_window_days default of 30', () => {
    const config = loadConfig(tmpDir);
    expect(config.analysis_window_days).toBe(30);
  });

  it('returns min_sessions default of 3', () => {
    const config = loadConfig(tmpDir);
    expect(config.min_sessions).toBe(3);
  });

  it('returns min_repeat_threshold default of 3', () => {
    const config = loadConfig(tmpDir);
    expect(config.min_repeat_threshold).toBe(3);
  });

  it('returns min_confidence_score default of 0.7', () => {
    const config = loadConfig(tmpDir);
    expect(config.min_confidence_score).toBe(0.7);
  });

  it('returns exclude_paths default of ["node_modules", ".git"]', () => {
    const config = loadConfig(tmpDir);
    expect(config.exclude_paths).toEqual(['node_modules', '.git']);
  });

  it('returns auto_pr default of false', () => {
    const config = loadConfig(tmpDir);
    expect(config.auto_pr).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Valid overrides
  // --------------------------------------------------------------------------

  it('overrides analysis_window_days with valid value', async () => {
    await writeFile(
      join(tmpDir, '.context-optimizer.json'),
      JSON.stringify({ analysis_window_days: 60 }),
    );
    const config = loadConfig(tmpDir);
    expect(config.analysis_window_days).toBe(60);
  });

  it('overrides min_sessions with valid value', async () => {
    await writeFile(join(tmpDir, '.context-optimizer.json'), JSON.stringify({ min_sessions: 5 }));
    const config = loadConfig(tmpDir);
    expect(config.min_sessions).toBe(5);
  });

  it('overrides min_repeat_threshold with valid value', async () => {
    await writeFile(
      join(tmpDir, '.context-optimizer.json'),
      JSON.stringify({ min_repeat_threshold: 7 }),
    );
    const config = loadConfig(tmpDir);
    expect(config.min_repeat_threshold).toBe(7);
  });

  it('overrides min_confidence_score with valid value', async () => {
    await writeFile(
      join(tmpDir, '.context-optimizer.json'),
      JSON.stringify({ min_confidence_score: 0.9 }),
    );
    const config = loadConfig(tmpDir);
    expect(config.min_confidence_score).toBe(0.9);
  });

  it('overrides exclude_paths with valid array', async () => {
    await writeFile(
      join(tmpDir, '.context-optimizer.json'),
      JSON.stringify({ exclude_paths: ['vendor', 'dist'] }),
    );
    const config = loadConfig(tmpDir);
    expect(config.exclude_paths).toEqual(['vendor', 'dist']);
  });

  it('overrides auto_pr with true', async () => {
    await writeFile(join(tmpDir, '.context-optimizer.json'), JSON.stringify({ auto_pr: true }));
    const config = loadConfig(tmpDir);
    expect(config.auto_pr).toBe(true);
  });

  it('overrides only specified fields, keeps others as defaults', async () => {
    await writeFile(
      join(tmpDir, '.context-optimizer.json'),
      JSON.stringify({ analysis_window_days: 14, auto_pr: true }),
    );
    const config = loadConfig(tmpDir);
    expect(config.analysis_window_days).toBe(14);
    expect(config.auto_pr).toBe(true);
    expect(config.min_sessions).toBe(3);
    expect(config.min_repeat_threshold).toBe(3);
    expect(config.min_confidence_score).toBe(0.7);
    expect(config.exclude_paths).toEqual(['node_modules', '.git']);
  });

  // --------------------------------------------------------------------------
  // Invalid field values — fallback to default and log warning
  // --------------------------------------------------------------------------

  it('falls back to default for negative analysis_window_days and logs warning', async () => {
    await writeFile(
      join(tmpDir, '.context-optimizer.json'),
      JSON.stringify({ analysis_window_days: -5 }),
    );
    const config = loadConfig(tmpDir);
    expect(config.analysis_window_days).toBe(30);
    expect(process.stderr.write).toHaveBeenCalled();
  });

  it('falls back to default for zero analysis_window_days', async () => {
    await writeFile(
      join(tmpDir, '.context-optimizer.json'),
      JSON.stringify({ analysis_window_days: 0 }),
    );
    const config = loadConfig(tmpDir);
    expect(config.analysis_window_days).toBe(30);
  });

  it('falls back to default for non-integer min_sessions and logs warning', async () => {
    await writeFile(
      join(tmpDir, '.context-optimizer.json'),
      JSON.stringify({ min_sessions: 'bad' }),
    );
    const config = loadConfig(tmpDir);
    expect(config.min_sessions).toBe(3);
    expect(process.stderr.write).toHaveBeenCalled();
  });

  it('falls back to default for negative min_repeat_threshold', async () => {
    await writeFile(
      join(tmpDir, '.context-optimizer.json'),
      JSON.stringify({ min_repeat_threshold: -1 }),
    );
    const config = loadConfig(tmpDir);
    expect(config.min_repeat_threshold).toBe(3);
  });

  it('falls back to default for out-of-range min_confidence_score (> 1)', async () => {
    await writeFile(
      join(tmpDir, '.context-optimizer.json'),
      JSON.stringify({ min_confidence_score: 1.5 }),
    );
    const config = loadConfig(tmpDir);
    expect(config.min_confidence_score).toBe(0.7);
  });

  it('falls back to default for out-of-range min_confidence_score (< 0)', async () => {
    await writeFile(
      join(tmpDir, '.context-optimizer.json'),
      JSON.stringify({ min_confidence_score: -0.1 }),
    );
    const config = loadConfig(tmpDir);
    expect(config.min_confidence_score).toBe(0.7);
  });

  it('falls back to default for non-array exclude_paths', async () => {
    await writeFile(
      join(tmpDir, '.context-optimizer.json'),
      JSON.stringify({ exclude_paths: 'node_modules' }),
    );
    const config = loadConfig(tmpDir);
    expect(config.exclude_paths).toEqual(['node_modules', '.git']);
    expect(process.stderr.write).toHaveBeenCalled();
  });

  it('falls back to default for non-boolean auto_pr', async () => {
    await writeFile(join(tmpDir, '.context-optimizer.json'), JSON.stringify({ auto_pr: 1 }));
    const config = loadConfig(tmpDir);
    expect(config.auto_pr).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Malformed JSON — do not throw, return defaults
  // --------------------------------------------------------------------------

  it('returns defaults when config file contains invalid JSON', async () => {
    await writeFile(join(tmpDir, '.context-optimizer.json'), 'not valid json {{{');
    const config = loadConfig(tmpDir);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  // --------------------------------------------------------------------------
  // Unknown fields — ignored silently
  // --------------------------------------------------------------------------

  it('ignores unknown fields in config file', async () => {
    await writeFile(
      join(tmpDir, '.context-optimizer.json'),
      JSON.stringify({ unknown_field: 'value', analysis_window_days: 7 }),
    );
    const config = loadConfig(tmpDir);
    expect(config.analysis_window_days).toBe(7);
    expect((config as Record<string, unknown>).unknown_field).toBeUndefined();
  });
});
