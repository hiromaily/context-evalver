import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config-loader.js';
import type { HookInput } from '../src/event-capture.js';
import { captureFromHook } from '../src/event-capture.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: Config = {
  analysis_window_days: 30,
  min_sessions: 3,
  min_repeat_threshold: 3,
  min_confidence_score: 0.7,
  exclude_paths: ['node_modules', '.git'],
  auto_pr: false,
};

function makeInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: 'sess-1',
    hook_event_name: 'PreToolUse',
    cwd: '/repo',
    transcript_path: '/tmp/transcript.json',
    permission_mode: 'default',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// File events (Read tool → file_read)
// ---------------------------------------------------------------------------

describe('captureFromHook — Read tool', () => {
  it('captures a file_read event from a Read tool call', () => {
    const input = makeInput({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/repo/src/main.rs' },
    });
    const event = captureFromHook(input, DEFAULT_CONFIG);
    expect(event).not.toBeNull();
    expect(event?.kind).toBe('file_read');
    expect(event?.payload.path).toBe('/repo/src/main.rs');
  });

  it('sets session_id from hook input', () => {
    const input = makeInput({
      session_id: 'my-session',
      tool_name: 'Read',
      tool_input: { file_path: '/repo/file.ts' },
    });
    const event = captureFromHook(input, DEFAULT_CONFIG);
    expect(event?.session_id).toBe('my-session');
  });

  it('sets repo_root from hook cwd', () => {
    const input = makeInput({
      cwd: '/my/project',
      tool_name: 'Read',
      tool_input: { file_path: '/my/project/src/lib.ts' },
    });
    const event = captureFromHook(input, DEFAULT_CONFIG);
    expect(event?.repo_root).toBe('/my/project');
  });

  it('sets timestamp as a number', () => {
    const input = makeInput({
      tool_name: 'Read',
      tool_input: { file_path: '/repo/file.ts' },
    });
    const before = Math.floor(Date.now() / 1000);
    const event = captureFromHook(input, DEFAULT_CONFIG);
    const after = Math.ceil(Date.now() / 1000);
    expect(event?.timestamp).toBeGreaterThanOrEqual(before);
    expect(event?.timestamp).toBeLessThanOrEqual(after);
  });

  it('returns null when Read tool_input has no file_path', () => {
    const input = makeInput({
      tool_name: 'Read',
      tool_input: {},
    });
    const event = captureFromHook(input, DEFAULT_CONFIG);
    expect(event).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// File events (Edit / Write tool → file_write)
// ---------------------------------------------------------------------------

describe('captureFromHook — Edit tool', () => {
  it('captures a file_write event from an Edit tool call', () => {
    const input = makeInput({
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/lib.rs' },
    });
    const event = captureFromHook(input, DEFAULT_CONFIG);
    expect(event?.kind).toBe('file_write');
    expect(event?.payload.path).toBe('/repo/src/lib.rs');
  });
});

describe('captureFromHook — Write tool', () => {
  it('captures a file_write event from a Write tool call', () => {
    const input = makeInput({
      tool_name: 'Write',
      tool_input: { file_path: '/repo/README.md' },
    });
    const event = captureFromHook(input, DEFAULT_CONFIG);
    expect(event?.kind).toBe('file_write');
    expect(event?.payload.path).toBe('/repo/README.md');
  });
});

// ---------------------------------------------------------------------------
// Command events (Bash tool → command)
// ---------------------------------------------------------------------------

describe('captureFromHook — Bash tool', () => {
  it('captures a command event from a Bash tool call', () => {
    const input = makeInput({
      tool_name: 'Bash',
      tool_input: { command: 'cargo test' },
    });
    const event = captureFromHook(input, DEFAULT_CONFIG);
    expect(event?.kind).toBe('command');
    expect(event?.payload.command).toBe('cargo test');
  });

  it('returns null when Bash tool_input has no command', () => {
    const input = makeInput({
      tool_name: 'Bash',
      tool_input: {},
    });
    const event = captureFromHook(input, DEFAULT_CONFIG);
    expect(event).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error events (PostToolUse failure → error)
// ---------------------------------------------------------------------------

describe('captureFromHook — PostToolUse error', () => {
  it('captures an error event from a failed PostToolUse response', () => {
    const input = makeInput({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: {
        is_error: true,
        content: 'error: failed to compile src/main.rs:42: undefined variable x',
      },
    });
    const event = captureFromHook(input, DEFAULT_CONFIG);
    expect(event?.kind).toBe('error');
    expect(event?.payload.message).toBeDefined();
    expect(typeof event?.payload.message).toBe('string');
  });

  it('returns null for PostToolUse when is_error is false', () => {
    const input = makeInput({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: {
        is_error: false,
        content: 'success',
      },
    });
    const event = captureFromHook(input, DEFAULT_CONFIG);
    expect(event).toBeNull();
  });

  it('normalizes error messages by stripping file paths and line numbers', () => {
    const input = makeInput({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: {
        is_error: true,
        content: 'error at /repo/src/main.rs:42: undefined symbol',
      },
    });
    const event = captureFromHook(input, DEFAULT_CONFIG);
    // The normalized message should not contain the full path and line number
    expect(event?.payload.message).not.toContain('/repo/src/main.rs:42');
    expect(event?.payload.message).toContain('undefined symbol');
  });

  it('returns null for PostToolUse with no tool_response', () => {
    const input = makeInput({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
    });
    const event = captureFromHook(input, DEFAULT_CONFIG);
    expect(event).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unhandled / non-capturable events
// ---------------------------------------------------------------------------

describe('captureFromHook — unhandled events', () => {
  it('returns null for SessionStart', () => {
    const input = makeInput({ hook_event_name: 'SessionStart' });
    expect(captureFromHook(input, DEFAULT_CONFIG)).toBeNull();
  });

  it('returns null for SessionEnd', () => {
    const input = makeInput({ hook_event_name: 'SessionEnd' });
    expect(captureFromHook(input, DEFAULT_CONFIG)).toBeNull();
  });

  it('returns null for Stop', () => {
    const input = makeInput({ hook_event_name: 'Stop' });
    expect(captureFromHook(input, DEFAULT_CONFIG)).toBeNull();
  });

  it('returns null for UserPromptSubmit (no capturable payload)', () => {
    const input = makeInput({ hook_event_name: 'UserPromptSubmit' });
    expect(captureFromHook(input, DEFAULT_CONFIG)).toBeNull();
  });

  it('returns null for unknown tool name on PreToolUse', () => {
    const input = makeInput({
      hook_event_name: 'PreToolUse',
      tool_name: 'UnknownTool',
      tool_input: { file_path: '/repo/file.ts' },
    });
    expect(captureFromHook(input, DEFAULT_CONFIG)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Path exclusion
// ---------------------------------------------------------------------------

describe('captureFromHook — path exclusion', () => {
  it('returns null when file path starts with an excluded path', () => {
    const input = makeInput({
      tool_name: 'Read',
      tool_input: { file_path: '/repo/node_modules/lodash/index.js' },
    });
    expect(captureFromHook(input, DEFAULT_CONFIG)).toBeNull();
  });

  it('returns null when file path contains .git directory', () => {
    const input = makeInput({
      tool_name: 'Read',
      tool_input: { file_path: '/repo/.git/config' },
    });
    expect(captureFromHook(input, DEFAULT_CONFIG)).toBeNull();
  });

  it('does not exclude paths that only partially match', () => {
    const input = makeInput({
      tool_name: 'Read',
      tool_input: { file_path: '/repo/src/main.rs' },
    });
    expect(captureFromHook(input, DEFAULT_CONFIG)).not.toBeNull();
  });

  it('uses custom exclude_paths from config', () => {
    const config = { ...DEFAULT_CONFIG, exclude_paths: ['vendor', 'dist'] };
    const input = makeInput({
      tool_name: 'Read',
      tool_input: { file_path: '/repo/vendor/lib.js' },
    });
    expect(captureFromHook(input, config)).toBeNull();
  });

  it('does not exclude paths not in exclude_paths', () => {
    const config = { ...DEFAULT_CONFIG, exclude_paths: ['vendor'] };
    const input = makeInput({
      tool_name: 'Read',
      tool_input: { file_path: '/repo/node_modules/lib.js' },
    });
    expect(captureFromHook(input, config)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

describe('captureFromHook — secret redaction in commands', () => {
  it('redacts AWS access key patterns', () => {
    const input = makeInput({
      tool_name: 'Bash',
      tool_input: { command: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE aws s3 ls' },
    });
    const event = captureFromHook(input, DEFAULT_CONFIG);
    expect(event?.payload.command).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(event?.payload.command).toContain('[REDACTED]');
  });

  it('redacts GitHub token patterns', () => {
    const input = makeInput({
      tool_name: 'Bash',
      tool_input: { command: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345 gh pr list' },
    });
    const event = captureFromHook(input, DEFAULT_CONFIG);
    expect(event?.payload.command).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(event?.payload.command).toContain('[REDACTED]');
  });

  it('redacts env var KEY=value assignments', () => {
    const input = makeInput({
      tool_name: 'Bash',
      tool_input: { command: 'MY_SECRET=super-secret-value some-command' },
    });
    const event = captureFromHook(input, DEFAULT_CONFIG);
    expect(event?.payload.command).not.toContain('super-secret-value');
    expect(event?.payload.command).toContain('[REDACTED]');
  });

  it('preserves command structure after redaction', () => {
    const input = makeInput({
      tool_name: 'Bash',
      tool_input: { command: 'TOKEN=abc123 cargo test' },
    });
    const event = captureFromHook(input, DEFAULT_CONFIG);
    expect(event?.payload.command).toContain('cargo test');
  });

  it('does not redact normal commands without secrets', () => {
    const input = makeInput({
      tool_name: 'Bash',
      tool_input: { command: 'cargo build --release' },
    });
    const event = captureFromHook(input, DEFAULT_CONFIG);
    expect(event?.payload.command).toBe('cargo build --release');
  });
});
