import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config-loader.js';
import { renderConfigReport, runConfig } from '../src/context-config.js';

const SAMPLE_CONFIG: Config = {
  analysis_window_days: 30,
  min_sessions: 3,
  min_repeat_threshold: 3,
  min_confidence_score: 0.7,
  exclude_paths: ['node_modules', '.git'],
  auto_pr: false,
};

// ---------------------------------------------------------------------------
// renderConfigReport
// ---------------------------------------------------------------------------

describe('renderConfigReport', () => {
  it('returns a Markdown table', () => {
    const output = renderConfigReport(SAMPLE_CONFIG);
    expect(output).toMatch(/\|.*\|.*\|/);
  });

  it('includes a heading', () => {
    const output = renderConfigReport(SAMPLE_CONFIG);
    expect(output).toMatch(/^#{1,3} /m);
  });

  it('shows all six configuration fields', () => {
    const output = renderConfigReport(SAMPLE_CONFIG);
    expect(output).toMatch(/analysis_window_days/i);
    expect(output).toMatch(/min_sessions/i);
    expect(output).toMatch(/min_repeat_threshold/i);
    expect(output).toMatch(/min_confidence_score/i);
    expect(output).toMatch(/exclude_paths/i);
    expect(output).toMatch(/auto_pr/i);
  });

  it('shows the numeric values', () => {
    const output = renderConfigReport(SAMPLE_CONFIG);
    expect(output).toContain('30');
    expect(output).toContain('0.7');
  });

  it('shows exclude_paths as a readable string', () => {
    const output = renderConfigReport(SAMPLE_CONFIG);
    expect(output).toMatch(/node_modules/);
    expect(output).toMatch(/\.git/);
  });

  it('shows auto_pr value', () => {
    const output = renderConfigReport(SAMPLE_CONFIG);
    expect(output).toMatch(/false/i);
  });

  it('shows auto_pr true when set', () => {
    const output = renderConfigReport({ ...SAMPLE_CONFIG, auto_pr: true });
    expect(output).toMatch(/true/i);
  });

  it('reflects non-default values', () => {
    const custom: Config = {
      ...SAMPLE_CONFIG,
      analysis_window_days: 90,
      min_confidence_score: 0.85,
    };
    const output = renderConfigReport(custom);
    expect(output).toContain('90');
    expect(output).toContain('0.85');
  });
});

// ---------------------------------------------------------------------------
// runConfig
// ---------------------------------------------------------------------------

describe('runConfig', () => {
  it('calls loadConfigFn with the cwd', async () => {
    let capturedCwd: string | undefined;
    const loadFn = (cwd: string) => {
      capturedCwd = cwd;
      return Promise.resolve(SAMPLE_CONFIG);
    };
    await runConfig('/repo/root', loadFn);
    expect(capturedCwd).toBe('/repo/root');
  });

  it('returns the rendered config report', async () => {
    const loadFn = () => Promise.resolve(SAMPLE_CONFIG);
    const output = await runConfig('/repo/root', loadFn);
    expect(output).toMatch(/analysis_window_days/i);
    expect(output).toMatch(/\|.*\|.*\|/);
  });
});

// ---------------------------------------------------------------------------
// context-config SKILL.md
// ---------------------------------------------------------------------------

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillMdPath = join(pluginRoot, 'skills', 'context-config', 'SKILL.md');
const content = readFileSync(skillMdPath, 'utf-8');

describe('context-config SKILL.md', () => {
  it('has YAML frontmatter', () => {
    expect(content).toMatch(/^---\n/);
    expect(content.indexOf('---', 3)).toBeGreaterThan(3);
  });

  it('has a non-empty description in frontmatter', () => {
    expect(content).toMatch(/^---[\s\S]*?description:\s*.+/m);
  });

  it('description mentions config or configuration', () => {
    const fmEnd = content.indexOf('---', 3);
    const frontmatter = content.slice(0, fmEnd + 3);
    expect(frontmatter).toMatch(/config/i);
  });

  it('references the compiled script', () => {
    expect(content).toMatch(/node|dist\/context.config|npx/i);
  });

  it('mentions all six configuration fields', () => {
    expect(content).toMatch(/analysis_window_days/i);
    expect(content).toMatch(/min_sessions/i);
    expect(content).toMatch(/min_repeat_threshold/i);
    expect(content).toMatch(/min_confidence_score/i);
    expect(content).toMatch(/exclude_paths/i);
    expect(content).toMatch(/auto_pr/i);
  });
});
