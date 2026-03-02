import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ErrorCandidate,
  FileCandidate,
  SequenceCandidate,
  Severity,
  SignalSummaryMessage,
} from './ipc-client.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AuditReport {
  markdown: string;
}

export type RecommendationKind = 'claude_md' | 'skill' | 'slash_command' | 'error_fix';

export interface DraftPatch {
  target_file: string;
  recommendation_kind: RecommendationKind;
  confidence: number;
  severity: Severity;
  evidence_count: number;
  unified_diff: string;
}

export interface DraftStagingFile {
  session_id: string;
  created_at: number; // Unix epoch seconds
  patches: DraftPatch[];
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function severityBadge(s: Severity): string {
  return s === 'high' ? '🔴 high' : s === 'medium' ? '🟡 medium' : '🟢 low';
}

function confidencePct(c: number): string {
  return `${(c * 100).toFixed(0)}%`;
}

function draftableTag(d: boolean): string {
  return d ? ' ✅ draftable' : '';
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderGateFailed(reasons: string[]): string {
  const lines: string[] = [
    '## Insufficient Evidence',
    '',
    'The data sufficiency gate has not yet been passed. More sessions are needed before recommendations can be generated.',
    '',
  ];

  if (reasons.length > 0) {
    lines.push('**Shortfall details:**', '');
    for (const r of reasons) {
      lines.push(`- ${r}`);
    }
    lines.push('');
  }

  lines.push(
    '> **Recommendation:** Continue logging sessions normally. The gate will pass automatically once sufficient evidence is collected.',
  );

  return lines.join('\n');
}

function renderSufficiencyStatus(): string {
  return [
    '## Data Sufficiency',
    '',
    '✅ Gate passed — sufficient evidence collected to generate recommendations.',
  ].join('\n');
}

function renderObservedSignals(
  files: FileCandidate[],
  errors: ErrorCandidate[],
  sequences: SequenceCandidate[],
): string {
  const lines: string[] = ['## Observed Signals', ''];

  if (files.length > 0) {
    lines.push('### Repeated File Access', '');
    lines.push('| File | Accesses | Confidence | Severity |');
    lines.push('|------|----------|------------|----------|');
    for (const f of files) {
      lines.push(`| \`${f.path}\` | ${f.count} | ${confidencePct(f.confidence)} | ${f.severity} |`);
    }
    lines.push('');
  }

  if (errors.length > 0) {
    lines.push('### Repeated Errors', '');
    lines.push('| Error Pattern | Occurrences | Confidence | Severity |');
    lines.push('|---------------|-------------|------------|----------|');
    for (const e of errors) {
      lines.push(
        `| \`${e.error}\` | ${e.count} | ${confidencePct(e.confidence)} | ${e.severity} |`,
      );
    }
    lines.push('');
  }

  if (sequences.length > 0) {
    lines.push('### Repeated Command Sequences', '');
    lines.push('| Commands | Occurrences | Confidence | Severity |');
    lines.push('|----------|-------------|------------|----------|');
    for (const s of sequences) {
      const cmds = s.commands.map(c => `\`${c}\``).join(' → ');
      lines.push(`| ${cmds} | ${s.count} | ${confidencePct(s.confidence)} | ${s.severity} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderCandidates(
  files: FileCandidate[],
  errors: ErrorCandidate[],
  sequences: SequenceCandidate[],
): string {
  const lines: string[] = ['## Recommendation Candidates', ''];

  if (files.length > 0) {
    lines.push('### CLAUDE.md Additions (Frequent File Context)', '');
    for (const f of files) {
      lines.push(
        `- **\`${f.path}\`** — ${severityBadge(f.severity)} | confidence: ${confidencePct(f.confidence)} | evidence: ${f.evidence_count} accesses${draftableTag(f.draftable)}`,
      );
    }
    lines.push('');
  }

  if (errors.length > 0) {
    lines.push('### Error-Fix Candidates', '');
    for (const e of errors) {
      lines.push(
        `- **\`${e.error}\`** — ${severityBadge(e.severity)} | confidence: ${confidencePct(e.confidence)} | evidence: ${e.evidence_count} occurrences${draftableTag(e.draftable)}`,
      );
    }
    lines.push('');
  }

  if (sequences.length > 0) {
    lines.push('### Skill / Slash-Command Candidates (Repeated Sequences)', '');
    for (const s of sequences) {
      const cmds = s.commands.map(c => `\`${c}\``).join(' → ');
      lines.push(
        `- ${cmds} — ${severityBadge(s.severity)} | confidence: ${confidencePct(s.confidence)} | evidence: ${s.evidence_count} occurrences${draftableTag(s.draftable)}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a read-only Markdown audit report from a `SignalSummaryMessage`.
 * Never writes any files — caller is responsible for printing to stdout.
 */
export function generateAuditReport(summary: SignalSummaryMessage): AuditReport {
  const { gate_passed, gate_reasons, repeated_files, repeated_errors, repeated_sequences } =
    summary;

  const sections: string[] = ['# Context Optimizer — Audit Report', ''];

  if (!gate_passed) {
    sections.push(renderGateFailed(gate_reasons));
    return { markdown: sections.join('\n') };
  }

  sections.push(renderSufficiencyStatus());
  sections.push('');

  const hasSignals =
    repeated_files.length > 0 || repeated_errors.length > 0 || repeated_sequences.length > 0;

  if (hasSignals) {
    sections.push(renderObservedSignals(repeated_files, repeated_errors, repeated_sequences));
    sections.push(renderCandidates(repeated_files, repeated_errors, repeated_sequences));
  } else {
    sections.push('## No Actionable Recommendations');
    sections.push('');
    sections.push(
      'No signals have yet crossed the 0.65 confidence threshold. Continue using Claude Code normally and re-run `/context-audit` after more sessions.',
    );
  }

  return { markdown: sections.join('\n') };
}

// ---------------------------------------------------------------------------
// LLM prompt construction
// ---------------------------------------------------------------------------

/**
 * Builds a structured LLM prompt from a signal summary.
 * Only draftable candidates (confidence >= 0.80) are included.
 * The prompt instructs the LLM to output patches in a parseable PATCH marker format.
 */
export function buildDraftPrompt(summary: SignalSummaryMessage): string {
  const draftableFiles = summary.repeated_files.filter(f => f.draftable);
  const draftableErrors = summary.repeated_errors.filter(e => e.draftable);
  const draftableSeqs = summary.repeated_sequences.filter(s => s.draftable);

  const lines: string[] = [
    '# Context Optimizer — Patch Draft Request',
    '',
    "You are generating context improvement patches for a developer's Claude Code repository",
    'based on statistically significant behavioral signals.',
    '',
    '## Draftable Signals',
    '',
  ];

  if (draftableFiles.length > 0) {
    lines.push('### CLAUDE.md Candidates (Repeated File Access)', '');
    for (const f of draftableFiles) {
      lines.push(
        `- File: \`${f.path}\` | Accesses: ${f.count} | Confidence: ${(f.confidence * 100).toFixed(0)}% | Severity: ${f.severity} | Evidence: ${f.evidence_count}`,
      );
    }
    lines.push('');
  }

  if (draftableErrors.length > 0) {
    lines.push('### Error-Fix Candidates (Repeated Errors)', '');
    for (const e of draftableErrors) {
      lines.push(
        `- Error: \`${e.error}\` | Count: ${e.count} | Confidence: ${(e.confidence * 100).toFixed(0)}% | Severity: ${e.severity} | Evidence: ${e.evidence_count}`,
      );
    }
    lines.push('');
  }

  if (draftableSeqs.length > 0) {
    lines.push('### Skill/Slash-Command Candidates (Repeated Sequences)', '');
    for (const s of draftableSeqs) {
      const cmds = s.commands.join(' → ');
      lines.push(
        `- Sequence: \`${cmds}\` | Count: ${s.count} | Confidence: ${(s.confidence * 100).toFixed(0)}% | Severity: ${s.severity} | Evidence: ${s.evidence_count}`,
      );
    }
    lines.push('');
  }

  lines.push(
    '## Instructions',
    '',
    'Generate ONE patch per signal using ONLY the provided information above.',
    'Do not hallucinate or invent signals not listed above.',
    '',
    'For each signal, output a patch block in this EXACT format:',
    '',
    '<!-- PATCH kind=<claude_md|skill|slash_command|error_fix> target=<target_filename> -->',
    '**Rationale**: Brief explanation of why this change is recommended based on the evidence.',
    '',
    '```diff',
    '--- <target_filename> (before)',
    '+++ <target_filename> (after)',
    '@@ ... @@',
    '...unified diff content...',
    '```',
    '',
    '<!-- END PATCH -->',
    '',
    '## Target Files',
    '',
  );

  if (draftableFiles.length > 0) {
    lines.push('- For repeated file-access signals → target file: `CLAUDE.md`');
  }
  if (draftableSeqs.length > 0) {
    lines.push(
      '- For repeated sequences (skill) → target file: `.claude/skills/<skill-name>/SKILL.md` (new file)',
    );
    lines.push(
      '- For repeated sequences (slash command) → target file: `.claude/commands/<command-name>.md` (new file)',
    );
  }
  if (draftableErrors.length > 0) {
    lines.push('- For repeated errors → target file: `CLAUDE.md` (add a Troubleshooting section)');
  }

  lines.push(
    '',
    '## Output',
    '',
    'Generate unified diff blocks for all draftable signals listed above.',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/**
 * Parses unified diff blocks from LLM output.
 * Expects patch blocks delimited by <!-- PATCH kind=X target=Y --> ... <!-- END PATCH -->.
 * Candidate metadata (confidence, severity, evidence_count) is looked up from the summary.
 */
export function generateDraftPatches(
  summary: SignalSummaryMessage,
  llm_output: string,
): DraftPatch[] {
  const patches: DraftPatch[] = [];

  // Match <!-- PATCH kind=X target=Y --> ... <!-- END PATCH --> blocks
  const patchBlockRegex =
    /<!--\s*PATCH\s+kind=(\S+)\s+target=(\S+)\s*-->([\s\S]*?)<!--\s*END PATCH\s*-->/gi;
  // Match ```diff ... ``` within a block
  const diffRegex = /```diff\n([\s\S]*?)```/;

  for (const match of llm_output.matchAll(patchBlockRegex)) {
    const [, kindRaw, target_file, blockContent] = match;

    const kind = normalizeKind(kindRaw ?? '');
    if (!kind) continue;

    const diffMatch = diffRegex.exec(blockContent ?? '');
    if (!diffMatch) continue;
    const unified_diff = (diffMatch[1] ?? '').trimEnd();
    if (!unified_diff) continue;

    const meta = findCandidateMeta(summary, kind);
    if (!meta) continue;

    patches.push({
      target_file: target_file ?? '',
      recommendation_kind: kind,
      confidence: meta.confidence,
      severity: meta.severity,
      evidence_count: meta.evidence_count,
      unified_diff,
    });
  }

  return patches;
}

function normalizeKind(raw: string): RecommendationKind | null {
  const lower = raw.toLowerCase();
  if (lower === 'claude_md' || lower === 'claudemd') return 'claude_md';
  if (lower === 'skill') return 'skill';
  if (lower === 'slash_command') return 'slash_command';
  if (lower === 'error_fix' || lower === 'errorfix') return 'error_fix';
  return null;
}

interface CandidateMeta {
  confidence: number;
  severity: Severity;
  evidence_count: number;
}

function findCandidateMeta(
  summary: SignalSummaryMessage,
  kind: RecommendationKind,
): CandidateMeta | null {
  if (kind === 'claude_md') {
    const c = summary.repeated_files.find(f => f.draftable);
    return c
      ? { confidence: c.confidence, severity: c.severity, evidence_count: c.evidence_count }
      : null;
  }
  if (kind === 'skill' || kind === 'slash_command') {
    const c = summary.repeated_sequences.find(s => s.draftable);
    return c
      ? { confidence: c.confidence, severity: c.severity, evidence_count: c.evidence_count }
      : null;
  }
  if (kind === 'error_fix') {
    const c = summary.repeated_errors.find(e => e.draftable);
    return c
      ? { confidence: c.confidence, severity: c.severity, evidence_count: c.evidence_count }
      : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Draft staging file persistence
// ---------------------------------------------------------------------------

/**
 * Returns the path for the draft staging file for a given session.
 * Path: `$XDG_DATA_HOME/context-evalver/drafts/{session_id}.json`
 */
export function draftStagingPath(session_id: string): string {
  const xdgDataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(xdgDataHome, 'context-evalver', 'drafts', `${session_id}.json`);
}

/**
 * Serializes patches into a `DraftStagingFile` and writes it to disk.
 * Creates the drafts directory if it does not exist.
 */
export async function saveDraft(session_id: string, patches: DraftPatch[]): Promise<void> {
  const stagingPath = draftStagingPath(session_id);
  await mkdir(dirname(stagingPath), { recursive: true });
  const file: DraftStagingFile = {
    session_id,
    created_at: Math.floor(Date.now() / 1000),
    patches,
  };
  await writeFile(stagingPath, JSON.stringify(file, null, 2), 'utf8');
}

/**
 * Reads and parses the staging file for a given session.
 * Returns `null` if the file is absent or contains invalid JSON.
 */
export async function loadDraft(session_id: string): Promise<DraftStagingFile | null> {
  const stagingPath = draftStagingPath(session_id);
  try {
    const raw = await readFile(stagingPath, 'utf8');
    return JSON.parse(raw) as DraftStagingFile;
  } catch {
    return null;
  }
}

/**
 * Deletes the staging file for a given session.
 * Silently ignores the error if the file does not exist.
 */
export async function clearDraft(session_id: string): Promise<void> {
  const stagingPath = draftStagingPath(session_id);
  try {
    await unlink(stagingPath);
  } catch {
    // File not found — no action needed
  }
}
