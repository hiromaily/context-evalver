import { describe, expect, it } from 'vitest';
import type {
  ErrorCandidate,
  FileCandidate,
  SequenceCandidate,
  SignalSummaryMessage,
} from '../src/ipc-client.js';
import { generateAuditReport } from '../src/patch-generator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GATE_FAILED_SUMMARY: SignalSummaryMessage = {
  type: 'signal_summary',
  gate_passed: false,
  gate_reasons: ['Only 1 session analyzed (need ≥ 5)', 'Only 50 events captured (need ≥ 200)'],
  repeated_files: [],
  repeated_errors: [],
  repeated_sequences: [],
};

const GATE_PASSED_EMPTY: SignalSummaryMessage = {
  type: 'signal_summary',
  gate_passed: true,
  gate_reasons: [],
  repeated_files: [],
  repeated_errors: [],
  repeated_sequences: [],
};

const FILE_CANDIDATE: FileCandidate = {
  path: '/repo/src/main.rs',
  count: 12,
  confidence: 0.87,
  severity: 'high',
  evidence_count: 12,
  draftable: true,
};

const ERROR_CANDIDATE: ErrorCandidate = {
  error: 'undefined variable x',
  count: 6,
  confidence: 0.75,
  severity: 'medium',
  evidence_count: 6,
  draftable: false,
};

const SEQUENCE_CANDIDATE: SequenceCandidate = {
  commands: ['cargo build', 'cargo test'],
  count: 8,
  confidence: 0.91,
  severity: 'high',
  evidence_count: 8,
  draftable: true,
};

const FULL_SUMMARY: SignalSummaryMessage = {
  type: 'signal_summary',
  gate_passed: true,
  gate_reasons: [],
  repeated_files: [FILE_CANDIDATE],
  repeated_errors: [ERROR_CANDIDATE],
  repeated_sequences: [SEQUENCE_CANDIDATE],
};

// ---------------------------------------------------------------------------
// Gate failed — Insufficient Evidence
// ---------------------------------------------------------------------------

describe('generateAuditReport — gate failed', () => {
  it('returns an object with a markdown string', () => {
    const report = generateAuditReport(GATE_FAILED_SUMMARY);
    expect(typeof report.markdown).toBe('string');
    expect(report.markdown.length).toBeGreaterThan(0);
  });

  it('contains "Insufficient Evidence" heading', () => {
    const { markdown } = generateAuditReport(GATE_FAILED_SUMMARY);
    expect(markdown).toMatch(/Insufficient Evidence/i);
  });

  it('lists each gate reason', () => {
    const { markdown } = generateAuditReport(GATE_FAILED_SUMMARY);
    expect(markdown).toContain('Only 1 session analyzed');
    expect(markdown).toContain('Only 50 events captured');
  });

  it('includes a recommendation to continue logging', () => {
    const { markdown } = generateAuditReport(GATE_FAILED_SUMMARY);
    // Should mention continuing or logging more sessions
    expect(markdown).toMatch(/continu|more session|keep logging/i);
  });

  it('does not contain candidate sections when gate fails', () => {
    const { markdown } = generateAuditReport(GATE_FAILED_SUMMARY);
    expect(markdown).not.toMatch(/Recommendation Candidates/i);
  });
});

// ---------------------------------------------------------------------------
// Gate passed, no candidates — No actionable recommendations
// ---------------------------------------------------------------------------

describe('generateAuditReport — gate passed, no candidates', () => {
  it('contains "No actionable recommendations" when all candidate lists are empty', () => {
    const { markdown } = generateAuditReport(GATE_PASSED_EMPTY);
    expect(markdown).toMatch(/No actionable recommendations/i);
  });

  it('still renders the data sufficiency section', () => {
    const { markdown } = generateAuditReport(GATE_PASSED_EMPTY);
    expect(markdown).toMatch(/Data Sufficiency|Sufficient Evidence|Gate.*passed/i);
  });
});

// ---------------------------------------------------------------------------
// Gate passed with candidates
// ---------------------------------------------------------------------------

describe('generateAuditReport — gate passed with candidates', () => {
  it('contains "Recommendation Candidates" section', () => {
    const { markdown } = generateAuditReport(FULL_SUMMARY);
    expect(markdown).toMatch(/Recommendation Candidates/i);
  });

  it('renders file candidates with path and confidence', () => {
    const { markdown } = generateAuditReport(FULL_SUMMARY);
    expect(markdown).toContain('/repo/src/main.rs');
    // Confidence rendered as percentage
    expect(markdown).toContain('87%');
  });

  it('renders error candidates with message', () => {
    const { markdown } = generateAuditReport(FULL_SUMMARY);
    expect(markdown).toContain('undefined variable x');
  });

  it('renders sequence candidates with command list', () => {
    const { markdown } = generateAuditReport(FULL_SUMMARY);
    expect(markdown).toContain('cargo build');
    expect(markdown).toContain('cargo test');
  });

  it('renders severity level for each candidate', () => {
    const { markdown } = generateAuditReport(FULL_SUMMARY);
    expect(markdown).toMatch(/high/i);
    expect(markdown).toMatch(/medium/i);
  });

  it('indicates draftable status for high-confidence candidates', () => {
    const { markdown } = generateAuditReport(FULL_SUMMARY);
    // draftable=true candidates should be marked as draftable
    expect(markdown).toMatch(/draftable|draft/i);
  });

  it('shows observed signals section with file counts', () => {
    const { markdown } = generateAuditReport(FULL_SUMMARY);
    expect(markdown).toMatch(/Observed Signals|Signals/i);
    // File count 12 should appear somewhere
    expect(markdown).toContain('12');
  });

  it('shows observed signals section with error counts', () => {
    const { markdown } = generateAuditReport(FULL_SUMMARY);
    expect(markdown).toContain('undefined variable x');
    expect(markdown).toContain('6');
  });

  it('does not contain "No actionable recommendations" when candidates exist', () => {
    const { markdown } = generateAuditReport(FULL_SUMMARY);
    expect(markdown).not.toMatch(/No actionable recommendations/i);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('generateAuditReport — edge cases', () => {
  it('handles empty gate_reasons gracefully', () => {
    const summary: SignalSummaryMessage = { ...GATE_FAILED_SUMMARY, gate_reasons: [] };
    const { markdown } = generateAuditReport(summary);
    expect(markdown).toMatch(/Insufficient Evidence/i);
  });

  it('renders only file candidates when others are empty', () => {
    const summary: SignalSummaryMessage = {
      ...GATE_PASSED_EMPTY,
      repeated_files: [FILE_CANDIDATE],
    };
    const { markdown } = generateAuditReport(summary);
    expect(markdown).toContain('/repo/src/main.rs');
    expect(markdown).not.toMatch(/No actionable recommendations/i);
  });

  it('renders only error candidates when others are empty', () => {
    const summary: SignalSummaryMessage = {
      ...GATE_PASSED_EMPTY,
      repeated_errors: [ERROR_CANDIDATE],
    };
    const { markdown } = generateAuditReport(summary);
    expect(markdown).toContain('undefined variable x');
    expect(markdown).not.toMatch(/No actionable recommendations/i);
  });

  it('renders only sequence candidates when others are empty', () => {
    const summary: SignalSummaryMessage = {
      ...GATE_PASSED_EMPTY,
      repeated_sequences: [SEQUENCE_CANDIDATE],
    };
    const { markdown } = generateAuditReport(summary);
    expect(markdown).toContain('cargo build');
    expect(markdown).not.toMatch(/No actionable recommendations/i);
  });
});
