/// Integration test: /context-audit end-to-end output (task 15.4*)
///
/// Tests the full context-audit skill execution path:
///   - runAudit calls querySignals via the injectable dependency
///   - generateAuditReport is invoked on the returned signal summary
///   - The rendered Markdown is written to the provided output sink
///
/// Three scenarios mirror the task spec requirement of "3 synthetic sessions"
/// with varied signal data:
///   1. Gate passed with file + error + sequence candidates
///   2. Gate passed with only file candidates
///   3. Gate failed (insufficient data)
///
/// Requirements: 8.1, 8.2, 8.3

import { describe, expect, it, vi } from 'vitest';
import { runAudit } from '../src/context-audit.js';
import type { SignalSummaryMessage } from '../src/ipc-client.js';

const REPO_ROOT = '/tmp/test-repo';

// ---------------------------------------------------------------------------
// Fixtures: synthetic session signal summaries
// ---------------------------------------------------------------------------

const SESSION_FULL: SignalSummaryMessage = {
  type: 'signal_summary',
  gate_passed: true,
  gate_reasons: [],
  repeated_files: [
    {
      path: 'src/main.rs',
      count: 15,
      confidence: 0.87,
      severity: 'high',
      evidence_count: 15,
      draftable: true,
    },
  ],
  repeated_errors: [
    {
      error: 'undefined variable y',
      count: 5,
      confidence: 0.72,
      severity: 'medium',
      evidence_count: 5,
      draftable: false,
    },
  ],
  repeated_sequences: [
    {
      commands: ['cargo build', 'cargo test'],
      count: 9,
      confidence: 0.9,
      severity: 'high',
      evidence_count: 9,
      draftable: true,
    },
  ],
};

const SESSION_FILES_ONLY: SignalSummaryMessage = {
  type: 'signal_summary',
  gate_passed: true,
  gate_reasons: [],
  repeated_files: [
    {
      path: 'src/lib.rs',
      count: 8,
      confidence: 0.81,
      severity: 'high',
      evidence_count: 8,
      draftable: true,
    },
  ],
  repeated_errors: [],
  repeated_sequences: [],
};

const SESSION_GATE_FAILED: SignalSummaryMessage = {
  type: 'signal_summary',
  gate_passed: false,
  gate_reasons: ['Only 2 sessions analyzed (need ≥ 5)', 'Only 80 events captured (need ≥ 200)'],
  repeated_files: [],
  repeated_errors: [],
  repeated_sequences: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture all chunks written to the injectable output sink. */
function captureOutput(): {
  chunks: string[];
  text: () => string;
  write: (chunk: string) => void;
} {
  const chunks: string[] = [];
  return {
    chunks,
    text: () => chunks.join(''),
    write: (chunk: string) => {
      chunks.push(chunk);
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: gate passed, all three signal types present
// ---------------------------------------------------------------------------

describe('context-audit runAudit — gate passed with all signal types', () => {
  it('writes non-empty Markdown to the output sink', async () => {
    const out = captureOutput();
    await runAudit(REPO_ROOT, async () => SESSION_FULL, out.write);
    expect(out.text().length).toBeGreaterThan(0);
  });

  it('output contains "Observed Signals" section', async () => {
    const out = captureOutput();
    await runAudit(REPO_ROOT, async () => SESSION_FULL, out.write);
    expect(out.text()).toMatch(/Observed Signals/i);
  });

  it('output contains "Recommendation Candidates" section', async () => {
    const out = captureOutput();
    await runAudit(REPO_ROOT, async () => SESSION_FULL, out.write);
    expect(out.text()).toMatch(/Recommendation Candidates/i);
  });

  it('output includes the repeated file path', async () => {
    const out = captureOutput();
    await runAudit(REPO_ROOT, async () => SESSION_FULL, out.write);
    expect(out.text()).toContain('src/main.rs');
  });

  it('output includes the error message', async () => {
    const out = captureOutput();
    await runAudit(REPO_ROOT, async () => SESSION_FULL, out.write);
    expect(out.text()).toContain('undefined variable y');
  });

  it('output includes the command sequence', async () => {
    const out = captureOutput();
    await runAudit(REPO_ROOT, async () => SESSION_FULL, out.write);
    expect(out.text()).toContain('cargo build');
    expect(out.text()).toContain('cargo test');
  });

  it('output shows confidence percentage', async () => {
    const out = captureOutput();
    await runAudit(REPO_ROOT, async () => SESSION_FULL, out.write);
    expect(out.text()).toContain('87%');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: gate passed, only file candidates
// ---------------------------------------------------------------------------

describe('context-audit runAudit — gate passed with file candidates only', () => {
  it('output contains "Recommendation Candidates" section', async () => {
    const out = captureOutput();
    await runAudit(REPO_ROOT, async () => SESSION_FILES_ONLY, out.write);
    expect(out.text()).toMatch(/Recommendation Candidates/i);
  });

  it('output includes src/lib.rs', async () => {
    const out = captureOutput();
    await runAudit(REPO_ROOT, async () => SESSION_FILES_ONLY, out.write);
    expect(out.text()).toContain('src/lib.rs');
  });

  it('output does not contain "No actionable recommendations"', async () => {
    const out = captureOutput();
    await runAudit(REPO_ROOT, async () => SESSION_FILES_ONLY, out.write);
    expect(out.text()).not.toMatch(/No actionable recommendations/i);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: gate failed (insufficient data)
// ---------------------------------------------------------------------------

describe('context-audit runAudit — gate failed', () => {
  it('output contains "Insufficient Evidence" heading', async () => {
    const out = captureOutput();
    await runAudit(REPO_ROOT, async () => SESSION_GATE_FAILED, out.write);
    expect(out.text()).toMatch(/Insufficient Evidence/i);
  });

  it('output lists gate reasons', async () => {
    const out = captureOutput();
    await runAudit(REPO_ROOT, async () => SESSION_GATE_FAILED, out.write);
    expect(out.text()).toContain('Only 2 sessions analyzed');
    expect(out.text()).toContain('Only 80 events captured');
  });

  it('output does not contain "Recommendation Candidates"', async () => {
    const out = captureOutput();
    await runAudit(REPO_ROOT, async () => SESSION_GATE_FAILED, out.write);
    expect(out.text()).not.toMatch(/Recommendation Candidates/i);
  });
});

// ---------------------------------------------------------------------------
// Injectable dependency contract
// ---------------------------------------------------------------------------

describe('context-audit runAudit — querySignals injection', () => {
  it('calls querySignalsFn exactly once', async () => {
    const spy = vi.fn().mockResolvedValue(SESSION_FULL);
    const out = captureOutput();
    await runAudit(REPO_ROOT, spy, out.write);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('passes repoRoot to querySignalsFn', async () => {
    const spy = vi.fn().mockResolvedValue(SESSION_FULL);
    const out = captureOutput();
    await runAudit(REPO_ROOT, spy, out.write);
    expect(spy).toHaveBeenCalledWith(REPO_ROOT, expect.any(Number), expect.any(Number));
  });
});
