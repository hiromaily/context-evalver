import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillMdPath = join(pluginRoot, 'skills', 'context-audit', 'SKILL.md');
const content = readFileSync(skillMdPath, 'utf-8');

// ---------------------------------------------------------------------------
// Frontmatter requirements
// ---------------------------------------------------------------------------

describe('context-audit SKILL.md — frontmatter', () => {
  it('has YAML frontmatter delimiters', () => {
    expect(content).toMatch(/^---\n/);
    expect(content.indexOf('---', 3)).toBeGreaterThan(3);
  });

  it('has disable-model-invocation: true in frontmatter', () => {
    // Extract frontmatter block
    const fmEnd = content.indexOf('---', 3);
    const frontmatter = content.slice(0, fmEnd + 3);
    expect(frontmatter).toMatch(/disable-model-invocation:\s*true/);
  });

  it('has a non-empty description in frontmatter', () => {
    expect(content).toMatch(/^---[\s\S]*?description:\s*.+/m);
  });

  it('description mentions read-only or behavioral analysis', () => {
    const fmEnd = content.indexOf('---', 3);
    const frontmatter = content.slice(0, fmEnd + 3);
    expect(frontmatter).toMatch(/read.only|behavioral|evidence|signal/i);
  });
});

// ---------------------------------------------------------------------------
// Skill body requirements
// ---------------------------------------------------------------------------

describe('context-audit SKILL.md — skill body', () => {
  it('delegates to a compiled Node.js script or command', () => {
    // Should reference a script/command invocation for context-audit
    expect(content).toMatch(/node|dist\/|npx|context.audit/i);
  });

  it('explains the command invokes read-only behavioral analysis', () => {
    // Body should mention no file writes or read-only nature
    expect(content).toMatch(/No files|no file|read.only|safe|not.*write/i);
  });
});
