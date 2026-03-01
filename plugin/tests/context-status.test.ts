import { describe, expect, it, vi } from 'vitest';
import type { PluginStatus } from '../src/context-status.js';
import { deriveStatus, renderStatusReport, runStatus } from '../src/context-status.js';
import type { SignalSummaryMessage } from '../src/ipc-client.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GATE_FAILED_SUMMARY: SignalSummaryMessage = {
  type: 'signal_summary',
  gate_passed: false,
  gate_reasons: ['Only 1 session analyzed (need ≥ 5)', 'Only 50 events (need ≥ 200)'],
  repeated_files: [],
  repeated_errors: [],
  repeated_sequences: [],
};

const GATE_PASSED_NO_SIGNALS: SignalSummaryMessage = {
  type: 'signal_summary',
  gate_passed: true,
  gate_reasons: [],
  repeated_files: [],
  repeated_errors: [],
  repeated_sequences: [],
};

const GATE_PASSED_WITH_SIGNALS: SignalSummaryMessage = {
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
    {
      path: 'src/utils.ts',
      count: 4,
      confidence: 0.7,
      severity: 'medium',
      evidence_count: 4,
      draftable: false,
    },
  ],
  repeated_errors: [
    {
      error: 'module not found',
      count: 6,
      confidence: 0.85,
      severity: 'high',
      evidence_count: 6,
      draftable: true,
    },
  ],
  repeated_sequences: [
    {
      commands: ['cargo build', 'cargo test'],
      count: 5,
      confidence: 0.72,
      severity: 'medium',
      evidence_count: 5,
      draftable: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// deriveStatus
// ---------------------------------------------------------------------------

describe('deriveStatus', () => {
  it('sets gate_passed from summary', () => {
    const status = deriveStatus(GATE_FAILED_SUMMARY);
    expect(status.gate_passed).toBe(false);
  });

  it('sets gate_passed true when gate passes', () => {
    const status = deriveStatus(GATE_PASSED_WITH_SIGNALS);
    expect(status.gate_passed).toBe(true);
  });

  it('counts draftable candidates across all signal types', () => {
    const status = deriveStatus(GATE_PASSED_WITH_SIGNALS);
    // GATE_PASSED_WITH_SIGNALS has 2 draftable (1 file + 1 error)
    expect(status.draftable_count).toBe(2);
  });

  it('returns 0 draftable when no candidates', () => {
    const status = deriveStatus(GATE_PASSED_NO_SIGNALS);
    expect(status.draftable_count).toBe(0);
  });

  it('counts total signal count across all signal types', () => {
    const status = deriveStatus(GATE_PASSED_WITH_SIGNALS);
    // 2 files + 1 error + 1 sequence = 4
    expect(status.signal_count).toBe(4);
  });

  it('returns 0 signal count when no candidates', () => {
    const status = deriveStatus(GATE_FAILED_SUMMARY);
    expect(status.signal_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// renderStatusReport
// ---------------------------------------------------------------------------

describe('renderStatusReport', () => {
  const statusPassed: PluginStatus = {
    gate_passed: true,
    draftable_count: 2,
    signal_count: 4,
    last_optimized_days: null,
  };

  const statusFailed: PluginStatus = {
    gate_passed: false,
    draftable_count: 0,
    signal_count: 1,
    last_optimized_days: null,
  };

  it('returns a non-empty Markdown string', () => {
    const md = renderStatusReport(statusPassed);
    expect(typeof md).toBe('string');
    expect(md.length).toBeGreaterThan(0);
  });

  it('shows gate passed status', () => {
    const md = renderStatusReport(statusPassed);
    expect(md).toMatch(/gate.*pass|pass.*gate|✅|sufficient/i);
  });

  it('shows gate failed status', () => {
    const md = renderStatusReport(statusFailed);
    expect(md).toMatch(/gate.*fail|insufficient|not.*pass|❌/i);
  });

  it('displays draftable recommendation count', () => {
    const md = renderStatusReport(statusPassed);
    expect(md).toMatch(/draftable|draft/i);
    expect(md).toContain('2');
  });

  it('displays total signal count', () => {
    const md = renderStatusReport(statusPassed);
    expect(md).toContain('4');
  });

  it('shows "N/A" or similar when last_optimized_days is null', () => {
    const md = renderStatusReport(statusPassed);
    expect(md).toMatch(/N\/A|n\/a|not available|never|—/i);
  });

  it('shows days when last_optimized_days is a number', () => {
    const status = { ...statusPassed, last_optimized_days: 7 };
    const md = renderStatusReport(status);
    expect(md).toMatch(/7.*day|day.*7/i);
  });

  it('outputs a compact block (no sprawling multi-section structure)', () => {
    const md = renderStatusReport(statusPassed);
    // Should be reasonably compact — not a multi-section document
    const lines = md.split('\n').filter(l => l.trim());
    expect(lines.length).toBeLessThan(20);
  });
});

// ---------------------------------------------------------------------------
// runStatus
// ---------------------------------------------------------------------------

describe('runStatus', () => {
  const SESSION_ID = 'test-session-status';
  const CWD = '/tmp/test-repo';

  function makeQuerySignals(summary: SignalSummaryMessage) {
    return vi.fn().mockResolvedValue(summary);
  }

  it('queries signals with cwd, window_days, and min_repeat_threshold', async () => {
    const queryFn = makeQuerySignals(GATE_PASSED_NO_SIGNALS);
    await runStatus(SESSION_ID, CWD, queryFn);
    expect(queryFn).toHaveBeenCalledOnce();
    const [repoRoot] = queryFn.mock.calls[0] as [string, number, number];
    expect(repoRoot).toBe(CWD);
  });

  it('returns Markdown output containing status information', async () => {
    const output = await runStatus(SESSION_ID, CWD, makeQuerySignals(GATE_PASSED_WITH_SIGNALS));
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
    expect(output).toMatch(/status|gate|signal/i);
  });

  it('reflects gate_passed in output', async () => {
    const output = await runStatus(SESSION_ID, CWD, makeQuerySignals(GATE_FAILED_SUMMARY));
    expect(output).toMatch(/gate.*fail|insufficient|not.*pass/i);
  });

  it('shows draftable count in output', async () => {
    const output = await runStatus(SESSION_ID, CWD, makeQuerySignals(GATE_PASSED_WITH_SIGNALS));
    expect(output).toMatch(/draftable|draft/i);
    expect(output).toContain('2');
  });
});

// ---------------------------------------------------------------------------
// context-status SKILL.md
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillMdPath = join(pluginRoot, 'skills', 'context-status', 'SKILL.md');
const content = readFileSync(skillMdPath, 'utf-8');

describe('context-status SKILL.md', () => {
  it('has YAML frontmatter', () => {
    expect(content).toMatch(/^---\n/);
    expect(content.indexOf('---', 3)).toBeGreaterThan(3);
  });

  it('has a non-empty description in frontmatter', () => {
    expect(content).toMatch(/^---[\s\S]*?description:\s*.+/m);
  });

  it('description mentions status or signals', () => {
    const fmEnd = content.indexOf('---', 3);
    const frontmatter = content.slice(0, fmEnd + 3);
    expect(frontmatter).toMatch(/status|signal|summary/i);
  });

  it('references the compiled script', () => {
    expect(content).toMatch(/node|dist\/context.status|npx/i);
  });

  it('mentions sessions or data sufficiency', () => {
    expect(content).toMatch(/session|sufficiency|gate|signal/i);
  });

  it('mentions draftable recommendations', () => {
    expect(content).toMatch(/draftable|recommendation|draft/i);
  });
});
