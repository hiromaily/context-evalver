import { describe, expect, it } from 'vitest';
import { PLUGIN_NAME, PLUGIN_VERSION } from '../src/index.js';

// Smoke tests for the TypeScript plugin scaffold.
// These verify the entry point exports are present and well-formed,
// and that strict TypeScript compilation produced a usable module.

describe('context-optimizer plugin scaffold', () => {
  it('exports the canonical plugin name', () => {
    expect(PLUGIN_NAME).toBe('context-optimizer');
  });

  it('exports a semver-formatted version string', () => {
    expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('does not export undefined values from the entry point', () => {
    expect(PLUGIN_NAME).toBeDefined();
    expect(PLUGIN_VERSION).toBeDefined();
  });
});
