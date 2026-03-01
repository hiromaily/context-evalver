import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Claude Code plugin directory structure', () => {
  it('plugin.json exists with name, version, and description', () => {
    const manifestPath = join(pluginRoot, '.claude-plugin', 'plugin.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    expect(manifest.name).toBe('context-optimizer');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof manifest.description).toBe('string');
    expect((manifest.description as string).length).toBeGreaterThan(0);
  });

  it('hooks.json registers all five required hook events', () => {
    const hooksPath = join(pluginRoot, 'hooks', 'hooks.json');
    expect(existsSync(hooksPath)).toBe(true);
    const config = JSON.parse(readFileSync(hooksPath, 'utf-8')) as {
      hooks: Record<string, unknown>;
    };
    const required = [
      'SessionStart',
      'SessionEnd',
      'PreToolUse',
      'PostToolUse',
      'UserPromptSubmit',
    ];
    for (const name of required) {
      expect(config.hooks[name], `hooks.json must register ${name}`).toBeDefined();
    }
  });

  it('hooks.json each entry has at least one command directive', () => {
    const hooksPath = join(pluginRoot, 'hooks', 'hooks.json');
    const config = JSON.parse(readFileSync(hooksPath, 'utf-8')) as {
      hooks: Record<
        string,
        Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>
      >;
    };
    for (const [name, entries] of Object.entries(config.hooks)) {
      expect(entries.length, `${name} must have at least one entry`).toBeGreaterThan(0);
      const cmd = entries[0]?.hooks[0]?.command;
      expect(typeof cmd, `${name} command must be a string`).toBe('string');
      expect((cmd as string).length, `${name} command must not be empty`).toBeGreaterThan(0);
    }
  });

  it('all six skill directories contain a SKILL.md', () => {
    const skills = [
      'context-audit',
      'context-draft',
      'context-apply',
      'context-status',
      'context-reset',
      'context-config',
    ];
    for (const skill of skills) {
      const skillMd = join(pluginRoot, 'skills', skill, 'SKILL.md');
      expect(existsSync(skillMd), `skills/${skill}/SKILL.md must exist`).toBe(true);
    }
  });

  it('each SKILL.md contains a non-empty description frontmatter field', () => {
    const skills = [
      'context-audit',
      'context-draft',
      'context-apply',
      'context-status',
      'context-reset',
      'context-config',
    ];
    for (const skill of skills) {
      const content = readFileSync(join(pluginRoot, 'skills', skill, 'SKILL.md'), 'utf-8');
      expect(content, `${skill}/SKILL.md must contain description: frontmatter`).toMatch(
        /^---[\s\S]*?description:\s*.+/m,
      );
    }
  });
});
