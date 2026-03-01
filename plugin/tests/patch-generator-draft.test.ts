import { describe, expect, it } from 'vitest';
import type {
  ErrorCandidate,
  FileCandidate,
  SequenceCandidate,
  SignalSummaryMessage,
} from '../src/ipc-client.js';
import type { DraftPatch } from '../src/patch-generator.js';
import { buildDraftPrompt, generateDraftPatches } from '../src/patch-generator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DRAFTABLE_FILE: FileCandidate = {
  path: 'src/router.ts',
  count: 10,
  confidence: 0.88,
  severity: 'high',
  evidence_count: 10,
  draftable: true,
};

const NON_DRAFTABLE_FILE: FileCandidate = {
  path: 'src/utils.ts',
  count: 4,
  confidence: 0.72,
  severity: 'medium',
  evidence_count: 4,
  draftable: false,
};

const DRAFTABLE_ERROR: ErrorCandidate = {
  error: 'cannot find module X',
  count: 7,
  confidence: 0.85,
  severity: 'high',
  evidence_count: 7,
  draftable: true,
};

const NON_DRAFTABLE_ERROR: ErrorCandidate = {
  error: 'type error at line N',
  count: 3,
  confidence: 0.67,
  severity: 'low',
  evidence_count: 3,
  draftable: false,
};

const DRAFTABLE_SEQUENCE: SequenceCandidate = {
  commands: ['cargo build', 'cargo test', 'cargo clippy'],
  count: 5,
  confidence: 0.83,
  severity: 'medium',
  evidence_count: 5,
  draftable: true,
};

const NON_DRAFTABLE_SEQUENCE: SequenceCandidate = {
  commands: ['git status', 'git diff'],
  count: 2,
  confidence: 0.68,
  severity: 'low',
  evidence_count: 2,
  draftable: false,
};

const FULL_DRAFTABLE_SUMMARY: SignalSummaryMessage = {
  type: 'signal_summary',
  gate_passed: true,
  gate_reasons: [],
  repeated_files: [DRAFTABLE_FILE, NON_DRAFTABLE_FILE],
  repeated_errors: [DRAFTABLE_ERROR],
  repeated_sequences: [DRAFTABLE_SEQUENCE],
};

const ONLY_FILES_SUMMARY: SignalSummaryMessage = {
  type: 'signal_summary',
  gate_passed: true,
  gate_reasons: [],
  repeated_files: [DRAFTABLE_FILE],
  repeated_errors: [],
  repeated_sequences: [],
};

const NO_DRAFTABLE_SUMMARY: SignalSummaryMessage = {
  type: 'signal_summary',
  gate_passed: true,
  gate_reasons: [],
  repeated_files: [NON_DRAFTABLE_FILE],
  repeated_errors: [NON_DRAFTABLE_ERROR],
  repeated_sequences: [NON_DRAFTABLE_SEQUENCE],
};

// ---------------------------------------------------------------------------
// buildDraftPrompt tests
// ---------------------------------------------------------------------------

describe('buildDraftPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildDraftPrompt(FULL_DRAFTABLE_SUMMARY);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('includes draftable file candidates', () => {
    const prompt = buildDraftPrompt(FULL_DRAFTABLE_SUMMARY);
    expect(prompt).toContain('src/router.ts');
  });

  it('excludes non-draftable file candidates', () => {
    const prompt = buildDraftPrompt(FULL_DRAFTABLE_SUMMARY);
    expect(prompt).not.toContain('src/utils.ts');
  });

  it('includes draftable error candidates', () => {
    const prompt = buildDraftPrompt(FULL_DRAFTABLE_SUMMARY);
    expect(prompt).toContain('cannot find module X');
  });

  it('excludes non-draftable error candidates', () => {
    const prompt = buildDraftPrompt(FULL_DRAFTABLE_SUMMARY);
    expect(prompt).not.toContain('type error at line N');
  });

  it('includes draftable sequence candidates', () => {
    const prompt = buildDraftPrompt(FULL_DRAFTABLE_SUMMARY);
    expect(prompt).toContain('cargo build');
    expect(prompt).toContain('cargo test');
    expect(prompt).toContain('cargo clippy');
  });

  it('excludes non-draftable sequence candidates', () => {
    const prompt = buildDraftPrompt(FULL_DRAFTABLE_SUMMARY);
    expect(prompt).not.toContain('git status');
  });

  it('instructs the LLM to use only provided signals (no hallucination)', () => {
    const prompt = buildDraftPrompt(FULL_DRAFTABLE_SUMMARY);
    expect(prompt).toMatch(
      /only.*signal|no hallucination|provided.*information|do not (hallucinate|invent)/i,
    );
  });

  it('instructs the LLM to output unified diff blocks', () => {
    const prompt = buildDraftPrompt(FULL_DRAFTABLE_SUMMARY);
    expect(prompt).toMatch(/unified diff|diff block/i);
  });

  it('specifies the PATCH marker format for parseable output', () => {
    const prompt = buildDraftPrompt(FULL_DRAFTABLE_SUMMARY);
    expect(prompt).toContain('<!-- PATCH');
    expect(prompt).toContain('<!-- END PATCH -->');
  });

  it('mentions recommendation kinds in format instructions', () => {
    const prompt = buildDraftPrompt(FULL_DRAFTABLE_SUMMARY);
    expect(prompt).toMatch(/claude_md|skill|slash_command|error_fix/);
  });

  it('includes confidence percentages for draftable candidates', () => {
    const prompt = buildDraftPrompt(FULL_DRAFTABLE_SUMMARY);
    // DRAFTABLE_FILE has confidence 0.88 → 88%
    expect(prompt).toContain('88%');
  });

  it('produces empty-like prompt when no draftable candidates exist', () => {
    const prompt = buildDraftPrompt(NO_DRAFTABLE_SUMMARY);
    // Should not include non-draftable items in candidate sections
    expect(prompt).not.toContain('src/utils.ts');
    expect(prompt).not.toContain('type error at line N');
    expect(prompt).not.toContain('git status');
  });

  it('omits the file section when no draftable files exist', () => {
    const summary: SignalSummaryMessage = {
      ...ONLY_FILES_SUMMARY,
      repeated_files: [],
      repeated_sequences: [DRAFTABLE_SEQUENCE],
    };
    const prompt = buildDraftPrompt(summary);
    expect(prompt).not.toMatch(/CLAUDE\.md Candidate/i);
    expect(prompt).toContain('cargo build');
  });
});

// ---------------------------------------------------------------------------
// generateDraftPatches tests
// ---------------------------------------------------------------------------

// Helper to build a mock LLM response with PATCH markers
function makeLlmPatch(
  kind: string,
  target: string,
  diffContent: string,
  rationale = 'Based on behavioral signals.',
): string {
  return [
    `<!-- PATCH kind=${kind} target=${target} -->`,
    `**Rationale**: ${rationale}`,
    '',
    '```diff',
    diffContent,
    '```',
    '',
    '<!-- END PATCH -->',
  ].join('\n');
}

const CLAUDE_MD_DIFF = `--- CLAUDE.md\n+++ CLAUDE.md\n@@ -0,0 +1,3 @@\n+## Frequently Accessed Files\n+\n+- \`src/router.ts\`: Core routing logic`;

const SKILL_DIFF = `--- /dev/null\n+++ .claude/skills/build-test/SKILL.md\n@@ -0,0 +1,5 @@\n+---\n+description: Build and test the project\n+---\n+\n+Run cargo build && cargo test && cargo clippy`;

describe('generateDraftPatches', () => {
  it('returns an empty array for empty LLM output', () => {
    const patches = generateDraftPatches(FULL_DRAFTABLE_SUMMARY, '');
    expect(patches).toEqual([]);
  });

  it('returns an empty array when no PATCH markers are present', () => {
    const patches = generateDraftPatches(FULL_DRAFTABLE_SUMMARY, 'No patches here, just prose.');
    expect(patches).toEqual([]);
  });

  it('parses a single claude_md patch', () => {
    const llmOutput = makeLlmPatch('claude_md', 'CLAUDE.md', CLAUDE_MD_DIFF);
    const patches = generateDraftPatches(ONLY_FILES_SUMMARY, llmOutput);
    expect(patches).toHaveLength(1);
    const patch = patches[0] as DraftPatch;
    expect(patch.recommendation_kind).toBe('claude_md');
    expect(patch.target_file).toBe('CLAUDE.md');
    expect(patch.unified_diff).toContain('src/router.ts');
  });

  it('carries confidence from the matching summary candidate', () => {
    const llmOutput = makeLlmPatch('claude_md', 'CLAUDE.md', CLAUDE_MD_DIFF);
    const patches = generateDraftPatches(ONLY_FILES_SUMMARY, llmOutput);
    expect(patches[0]?.confidence).toBe(DRAFTABLE_FILE.confidence);
  });

  it('carries severity from the matching summary candidate', () => {
    const llmOutput = makeLlmPatch('claude_md', 'CLAUDE.md', CLAUDE_MD_DIFF);
    const patches = generateDraftPatches(ONLY_FILES_SUMMARY, llmOutput);
    expect(patches[0]?.severity).toBe(DRAFTABLE_FILE.severity);
  });

  it('carries evidence_count from the matching summary candidate', () => {
    const llmOutput = makeLlmPatch('claude_md', 'CLAUDE.md', CLAUDE_MD_DIFF);
    const patches = generateDraftPatches(ONLY_FILES_SUMMARY, llmOutput);
    expect(patches[0]?.evidence_count).toBe(DRAFTABLE_FILE.evidence_count);
  });

  it('parses a skill patch', () => {
    const llmOutput = makeLlmPatch('skill', '.claude/skills/build-test/SKILL.md', SKILL_DIFF);
    const patches = generateDraftPatches(FULL_DRAFTABLE_SUMMARY, llmOutput);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.recommendation_kind).toBe('skill');
    expect(patches[0]?.target_file).toBe('.claude/skills/build-test/SKILL.md');
  });

  it('parses a slash_command patch', () => {
    const diff = `--- /dev/null\n+++ .claude/commands/test.md\n@@ -0,0 +1,2 @@\n+# test\n+cargo test`;
    const llmOutput = makeLlmPatch('slash_command', '.claude/commands/test.md', diff);
    const patches = generateDraftPatches(FULL_DRAFTABLE_SUMMARY, llmOutput);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.recommendation_kind).toBe('slash_command');
  });

  it('parses an error_fix patch', () => {
    const diff = `--- CLAUDE.md\n+++ CLAUDE.md\n@@ -1,0 +1,3 @@\n+## Troubleshooting\n+\n+- cannot find module X: check import paths`;
    const llmOutput = makeLlmPatch('error_fix', 'CLAUDE.md', diff);
    const patches = generateDraftPatches(FULL_DRAFTABLE_SUMMARY, llmOutput);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.recommendation_kind).toBe('error_fix');
    expect(patches[0]?.confidence).toBe(DRAFTABLE_ERROR.confidence);
  });

  it('parses multiple patches from a single LLM output', () => {
    const llmOutput = [
      makeLlmPatch('claude_md', 'CLAUDE.md', CLAUDE_MD_DIFF),
      '',
      makeLlmPatch('skill', '.claude/skills/build-test/SKILL.md', SKILL_DIFF),
    ].join('\n');
    const patches = generateDraftPatches(FULL_DRAFTABLE_SUMMARY, llmOutput);
    expect(patches).toHaveLength(2);
    expect(patches[0]?.recommendation_kind).toBe('claude_md');
    expect(patches[1]?.recommendation_kind).toBe('skill');
  });

  it('skips patches with unknown kind', () => {
    const llmOutput = makeLlmPatch('unknown_kind', 'CLAUDE.md', CLAUDE_MD_DIFF);
    const patches = generateDraftPatches(FULL_DRAFTABLE_SUMMARY, llmOutput);
    expect(patches).toHaveLength(0);
  });

  it('skips patches with no diff block', () => {
    const llmOutput = [
      '<!-- PATCH kind=claude_md target=CLAUDE.md -->',
      '**Rationale**: No diff here.',
      '',
      '<!-- END PATCH -->',
    ].join('\n');
    const patches = generateDraftPatches(FULL_DRAFTABLE_SUMMARY, llmOutput);
    expect(patches).toHaveLength(0);
  });

  it('skips patches when no matching candidate exists in summary', () => {
    // skill patch but summary has no sequences
    const llmOutput = makeLlmPatch('skill', '.claude/skills/foo/SKILL.md', SKILL_DIFF);
    const patches = generateDraftPatches(ONLY_FILES_SUMMARY, llmOutput);
    // ONLY_FILES_SUMMARY has no sequences → no skill candidate metadata → skip
    expect(patches).toHaveLength(0);
  });

  it('extracts the diff content without the surrounding code fence', () => {
    const llmOutput = makeLlmPatch('claude_md', 'CLAUDE.md', CLAUDE_MD_DIFF);
    const patches = generateDraftPatches(ONLY_FILES_SUMMARY, llmOutput);
    // unified_diff should not contain the ``` fence markers
    expect(patches[0]?.unified_diff).not.toContain('```');
  });

  it('handles LLM output with surrounding prose gracefully', () => {
    const llmOutput = [
      'Here are the proposed patches based on your signals:',
      '',
      makeLlmPatch('claude_md', 'CLAUDE.md', CLAUDE_MD_DIFF),
      '',
      'Please review the above diff before applying.',
    ].join('\n');
    const patches = generateDraftPatches(ONLY_FILES_SUMMARY, llmOutput);
    expect(patches).toHaveLength(1);
  });
});
