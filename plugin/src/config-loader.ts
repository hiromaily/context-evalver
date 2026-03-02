import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Config {
  analysis_window_days: number; // default: 30
  min_sessions: number; // default: 3
  min_repeat_threshold: number; // default: 3
  min_confidence_score: number; // default: 0.7
  exclude_paths: string[]; // default: ["node_modules", ".git"]
  auto_pr: boolean; // default: false
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: Config = {
  analysis_window_days: 30,
  min_sessions: 3,
  min_repeat_threshold: 3,
  min_confidence_score: 0.7,
  exclude_paths: ['node_modules', '.git'],
  auto_pr: false,
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function warn(field: string, value: unknown, reason: string): void {
  process.stderr.write(
    `[context-evalver] config warning: ${field}=${JSON.stringify(value)} — ${reason}; using default\n`,
  );
}

function validPositiveInt(field: string, raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    warn(field, raw, 'must be a positive integer');
    return def;
  }
  return raw;
}

function validFraction(field: string, raw: unknown, def: number): number {
  if (typeof raw !== 'number' || raw < 0 || raw > 1) {
    warn(field, raw, 'must be a number between 0 and 1');
    return def;
  }
  return raw;
}

function validStringArray(field: string, raw: unknown, def: string[]): string[] {
  if (!Array.isArray(raw)) {
    warn(field, raw, 'must be an array of strings');
    return def;
  }
  return raw as string[];
}

function validBoolean(field: string, raw: unknown, def: boolean): boolean {
  if (typeof raw !== 'boolean') {
    warn(field, raw, 'must be a boolean');
    return def;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads `.context-evalver.json` from `repo_root`, merges with defaults for
 * any missing or invalid field, and returns a fully populated Config object.
 * Never throws — on any error the full defaults are returned.
 */
export function loadConfig(repo_root: string): Config {
  const configPath = join(repo_root, '.context-evalver.json');
  let raw: Record<string, unknown> = {};

  try {
    const text = readFileSync(configPath, 'utf8');
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // File absent or malformed — start from empty, use all defaults
    return { ...DEFAULT_CONFIG };
  }

  return {
    analysis_window_days: validPositiveInt(
      'analysis_window_days',
      raw.analysis_window_days,
      DEFAULT_CONFIG.analysis_window_days,
    ),
    min_sessions: validPositiveInt('min_sessions', raw.min_sessions, DEFAULT_CONFIG.min_sessions),
    min_repeat_threshold: validPositiveInt(
      'min_repeat_threshold',
      raw.min_repeat_threshold,
      DEFAULT_CONFIG.min_repeat_threshold,
    ),
    min_confidence_score: validFraction(
      'min_confidence_score',
      raw.min_confidence_score,
      DEFAULT_CONFIG.min_confidence_score,
    ),
    exclude_paths: validStringArray(
      'exclude_paths',
      raw.exclude_paths,
      DEFAULT_CONFIG.exclude_paths,
    ),
    auto_pr: validBoolean('auto_pr', raw.auto_pr, DEFAULT_CONFIG.auto_pr),
  };
}
