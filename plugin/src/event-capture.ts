import type { Config } from './config-loader.js';
import type { CapturedEvent, EventKind, SanitizedPayload } from './ipc-client.js';

// ---------------------------------------------------------------------------
// HookInput — matches the Claude Code hook stdin payload shape
// ---------------------------------------------------------------------------

export interface HookInput {
  session_id: string;
  hook_event_name:
    | 'SessionStart'
    | 'UserPromptSubmit'
    | 'PreToolUse'
    | 'PostToolUse'
    | 'Stop'
    | 'SessionEnd';
  cwd: string;
  transcript_path: string;
  permission_mode: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  prompt?: string;
}

// ---------------------------------------------------------------------------
// Secret redaction patterns
// ---------------------------------------------------------------------------

// AWS access key: starts with AKIA and is 20 uppercase alphanumeric chars
const AWS_KEY_RE = /AKIA[0-9A-Z]{16}/g;

// GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_ followed by alphanumeric/underscore
const GITHUB_TOKEN_RE = /gh[pouhsr]_[A-Za-z0-9_]{36}/g;

// Generic env var assignment: KEY=value (value ends at whitespace or end-of-string)
// Only redact when the key is all-caps with optional underscores (env-var convention)
const ENV_ASSIGN_RE = /\b([A-Z][A-Z0-9_]*)=([^\s]+)/g;

function redactSecrets(text: string): string {
  return text
    .replace(AWS_KEY_RE, '[REDACTED]')
    .replace(GITHUB_TOKEN_RE, '[REDACTED]')
    .replace(ENV_ASSIGN_RE, '$1=[REDACTED]');
}

// ---------------------------------------------------------------------------
// Error message normalisation
// ---------------------------------------------------------------------------

// Strip absolute file paths with optional line:col suffix
const FILE_PATH_RE = /\/?(?:[a-zA-Z]:)?(?:\/[^\s/:]+)+(?::\d+(?::\d+)?)?/g;

function normalizeErrorMessage(raw: string): string {
  return raw.replace(FILE_PATH_RE, '<path>').trim();
}

// ---------------------------------------------------------------------------
// Path exclusion
// ---------------------------------------------------------------------------

function isExcluded(filePath: string, excludePaths: string[]): boolean {
  // Check if any segment of the file path matches an excluded path
  return excludePaths.some(excluded => {
    // Match if the path contains the excluded segment as a directory component
    return (
      filePath.includes(`/${excluded}/`) ||
      filePath.includes(`/${excluded}`) ||
      filePath.startsWith(`${excluded}/`) ||
      filePath === excluded
    );
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derives a `CapturedEvent` from a raw Claude Code hook payload.
 *
 * Returns `null` when:
 * - The hook event kind is not one that produces a capturable event
 * - The tool is not one of the monitored tools (Read, Edit, Write, Bash)
 * - Required fields are missing from `tool_input` / `tool_response`
 * - The file path matches an `exclude_paths` entry
 */
export function captureFromHook(input: HookInput, config: Config): CapturedEvent | null {
  const { session_id, cwd, hook_event_name, tool_name, tool_input, tool_response } = input;
  const timestamp = Math.floor(Date.now() / 1000);

  function makeEvent(kind: EventKind, payload: SanitizedPayload): CapturedEvent {
    return { session_id, timestamp, repo_root: cwd, kind, payload };
  }

  // PostToolUse: capture error events from failed tool responses
  if (hook_event_name === 'PostToolUse') {
    if (
      tool_response &&
      tool_response.is_error === true &&
      typeof tool_response.content === 'string'
    ) {
      const normalized = normalizeErrorMessage(tool_response.content);
      return makeEvent('error', { message: normalized });
    }
    return null;
  }

  // PreToolUse: capture file access and command events
  if (hook_event_name === 'PreToolUse') {
    if (!tool_name || !tool_input) return null;

    if (tool_name === 'Read') {
      const path = tool_input.file_path;
      if (typeof path !== 'string') return null;
      if (isExcluded(path, config.exclude_paths)) return null;
      return makeEvent('file_read', { path });
    }

    if (tool_name === 'Edit' || tool_name === 'Write') {
      const path = tool_input.file_path;
      if (typeof path !== 'string') return null;
      if (isExcluded(path, config.exclude_paths)) return null;
      return makeEvent('file_write', { path });
    }

    if (tool_name === 'Bash') {
      const command = tool_input.command;
      if (typeof command !== 'string') return null;
      return makeEvent('command', { command: redactSecrets(command) });
    }

    return null;
  }

  // All other hook types (SessionStart, SessionEnd, UserPromptSubmit, Stop)
  // are not capturable by this module.
  return null;
}
