import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillMdPath = join(pluginRoot, 'skills', 'context-draft', 'SKILL.md');
const content = readFileSync(skillMdPath, 'utf-8');

// ---------------------------------------------------------------------------
// Frontmatter requirements
// ---------------------------------------------------------------------------

describe('context-draft SKILL.md — frontmatter', () => {
  it('has YAML frontmatter delimiters', () => {
    expect(content).toMatch(/^---\n/);
    expect(content.indexOf('---', 3)).toBeGreaterThan(3);
  });

  it('has a non-empty description in frontmatter', () => {
    expect(content).toMatch(/^---[\s\S]*?description:\s*.+/m);
  });

  it('description mentions patch proposals or high-confidence signals', () => {
    const fmEnd = content.indexOf('---', 3);
    const frontmatter = content.slice(0, fmEnd + 3);
    expect(frontmatter).toMatch(/patch|proposal|high.confidence|signal|draft/i);
  });

  it('does NOT have disable-model-invocation: true (LLM invocation is required)', () => {
    const fmEnd = content.indexOf('---', 3);
    const frontmatter = content.slice(0, fmEnd + 3);
    expect(frontmatter).not.toMatch(/disable-model-invocation:\s*true/);
  });
});

// ---------------------------------------------------------------------------
// Skill body requirements
// ---------------------------------------------------------------------------

describe('context-draft SKILL.md — skill body', () => {
  it('delegates to a compiled Node.js script', () => {
    expect(content).toMatch(/node|dist\/context.draft|npx/i);
  });

  it('explains it generates concrete patch proposals', () => {
    expect(content).toMatch(/patch|proposal|diff|generate/i);
  });

  it('mentions a confidence threshold or high-confidence requirement', () => {
    expect(content).toMatch(/0\.80|confidence|high.confidence/i);
  });

  it('mentions /context-apply as the next step after reviewing diffs', () => {
    expect(content).toMatch(/context.apply/i);
  });

  it('mentions the staging file or that patches are saved for /context-apply', () => {
    expect(content).toMatch(/staging|draft.*file|saved|persists|stored/i);
  });

  it('mentions CLAUDE.md, Skills, or slash commands as patch targets', () => {
    expect(content).toMatch(/CLAUDE\.md|skill|slash.command/i);
  });
});
