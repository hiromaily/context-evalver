import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillMdPath = join(pluginRoot, 'skills', 'context-apply', 'SKILL.md');
const content = readFileSync(skillMdPath, 'utf-8');

// ---------------------------------------------------------------------------
// Frontmatter requirements
// ---------------------------------------------------------------------------

describe('context-apply SKILL.md — frontmatter', () => {
  it('has YAML frontmatter delimiters', () => {
    expect(content).toMatch(/^---\n/);
    expect(content.indexOf('---', 3)).toBeGreaterThan(3);
  });

  it('has a non-empty description in frontmatter', () => {
    expect(content).toMatch(/^---[\s\S]*?description:\s*.+/m);
  });

  it('description mentions applying patches or context-draft dependency', () => {
    const fmEnd = content.indexOf('---', 3);
    const frontmatter = content.slice(0, fmEnd + 3);
    expect(frontmatter).toMatch(/apply|patch|context.draft|draft/i);
  });
});

// ---------------------------------------------------------------------------
// Skill body requirements
// ---------------------------------------------------------------------------

describe('context-apply SKILL.md — skill body', () => {
  it('delegates to a compiled Node.js script', () => {
    expect(content).toMatch(/node|dist\/context.apply|npx/i);
  });

  it('explicitly states it requires a prior /context-draft run', () => {
    expect(content).toMatch(/context.draft|draft.*first|run.*draft/i);
  });

  it('mentions user confirmation before writing files', () => {
    expect(content).toMatch(/confirm|confirmation|approve/i);
  });

  it('mentions git diff or git commit behavior', () => {
    expect(content).toMatch(/git diff|git commit|auto_pr/i);
  });

  it('mentions the staging file or that /context-apply reads the draft', () => {
    expect(content).toMatch(/staging|draft.*file|staging.*file|stored|saved/i);
  });
});
