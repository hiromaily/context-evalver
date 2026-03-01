import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config-loader.js';
import type { HookInput } from '../src/event-capture.js';
import { handlePerEventHook } from '../src/hook-dispatcher.js';
import type { IpcClient } from '../src/ipc-client.js';

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

function makePreToolUseInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: 'sess-99',
    hook_event_name: 'PreToolUse',
    cwd: '/repo',
    transcript_path: '/tmp/transcript.json',
    permission_mode: 'default',
    tool_name: 'Read',
    tool_input: { file_path: '/repo/src/main.rs' },
    ...overrides,
  };
}

function makePostToolUseInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: 'sess-99',
    hook_event_name: 'PostToolUse',
    cwd: '/repo',
    transcript_path: '/tmp/transcript.json',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_response: { is_error: true, content: 'error: command failed' },
    ...overrides,
  };
}

function makeMockClient(): IpcClient {
  return {
    sendEvent: vi.fn(),
    querySignals: vi.fn(),
    sendFlush: vi.fn(),
  } as unknown as IpcClient;
}

// ---------------------------------------------------------------------------
// handlePerEventHook — PreToolUse (file_read)
// ---------------------------------------------------------------------------

describe('handlePerEventHook — PreToolUse Read', () => {
  let mockClient: IpcClient;

  beforeEach(() => {
    mockClient = makeMockClient();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls sendEvent with a file_read event for a Read tool call', async () => {
    const input = makePreToolUseInput();
    await handlePerEventHook(input, { config: DEFAULT_CONFIG, ipcClient: mockClient });
    expect(mockClient.sendEvent).toHaveBeenCalledOnce();
    const [event] = vi.mocked(mockClient.sendEvent).mock.calls[0]!;
    expect(event.kind).toBe('file_read');
    expect(event.payload.path).toBe('/repo/src/main.rs');
  });

  it('sets session_id on the emitted event', async () => {
    const input = makePreToolUseInput({ session_id: 'my-sess' });
    await handlePerEventHook(input, { config: DEFAULT_CONFIG, ipcClient: mockClient });
    const [event] = vi.mocked(mockClient.sendEvent).mock.calls[0]!;
    expect(event.session_id).toBe('my-sess');
  });

  it('sets repo_root on the emitted event from cwd', async () => {
    const input = makePreToolUseInput({ cwd: '/my/project' });
    await handlePerEventHook(input, { config: DEFAULT_CONFIG, ipcClient: mockClient });
    const [event] = vi.mocked(mockClient.sendEvent).mock.calls[0]!;
    expect(event.repo_root).toBe('/my/project');
  });

  it('does not call sendEvent for excluded paths', async () => {
    const input = makePreToolUseInput({
      tool_input: { file_path: '/repo/node_modules/lodash/index.js' },
    });
    await handlePerEventHook(input, { config: DEFAULT_CONFIG, ipcClient: mockClient });
    expect(mockClient.sendEvent).not.toHaveBeenCalled();
  });

  it('does not call sendEvent for unknown tool names', async () => {
    const input = makePreToolUseInput({ tool_name: 'UnknownTool' });
    await handlePerEventHook(input, { config: DEFAULT_CONFIG, ipcClient: mockClient });
    expect(mockClient.sendEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handlePerEventHook — PreToolUse (Bash → command)
// ---------------------------------------------------------------------------

describe('handlePerEventHook — PreToolUse Bash', () => {
  let mockClient: IpcClient;

  beforeEach(() => {
    mockClient = makeMockClient();
  });

  it('captures command events from Bash tool calls', async () => {
    const input = makePreToolUseInput({
      tool_name: 'Bash',
      tool_input: { command: 'cargo test' },
    });
    await handlePerEventHook(input, { config: DEFAULT_CONFIG, ipcClient: mockClient });
    expect(mockClient.sendEvent).toHaveBeenCalledOnce();
    const [event] = vi.mocked(mockClient.sendEvent).mock.calls[0]!;
    expect(event.kind).toBe('command');
    expect(event.payload.command).toBe('cargo test');
  });
});

// ---------------------------------------------------------------------------
// handlePerEventHook — PreToolUse (Edit/Write → file_write)
// ---------------------------------------------------------------------------

describe('handlePerEventHook — PreToolUse Edit', () => {
  let mockClient: IpcClient;

  beforeEach(() => {
    mockClient = makeMockClient();
  });

  it('captures file_write events from Edit tool calls', async () => {
    const input = makePreToolUseInput({
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/lib.rs' },
    });
    await handlePerEventHook(input, { config: DEFAULT_CONFIG, ipcClient: mockClient });
    const [event] = vi.mocked(mockClient.sendEvent).mock.calls[0]!;
    expect(event.kind).toBe('file_write');
  });
});

// ---------------------------------------------------------------------------
// handlePerEventHook — PostToolUse (error)
// ---------------------------------------------------------------------------

describe('handlePerEventHook — PostToolUse error', () => {
  let mockClient: IpcClient;

  beforeEach(() => {
    mockClient = makeMockClient();
  });

  it('captures error events from failed PostToolUse responses', async () => {
    const input = makePostToolUseInput();
    await handlePerEventHook(input, { config: DEFAULT_CONFIG, ipcClient: mockClient });
    expect(mockClient.sendEvent).toHaveBeenCalledOnce();
    const [event] = vi.mocked(mockClient.sendEvent).mock.calls[0]!;
    expect(event.kind).toBe('error');
  });

  it('does not capture events for successful PostToolUse responses', async () => {
    const input = makePostToolUseInput({
      tool_response: { is_error: false, content: 'ok' },
    });
    await handlePerEventHook(input, { config: DEFAULT_CONFIG, ipcClient: mockClient });
    expect(mockClient.sendEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handlePerEventHook — UserPromptSubmit (no-op capturable event)
// ---------------------------------------------------------------------------

describe('handlePerEventHook — UserPromptSubmit', () => {
  let mockClient: IpcClient;

  beforeEach(() => {
    mockClient = makeMockClient();
  });

  it('does not call sendEvent for UserPromptSubmit (no capturable payload)', async () => {
    const input: HookInput = {
      session_id: 'sess-1',
      hook_event_name: 'UserPromptSubmit',
      cwd: '/repo',
      transcript_path: '/tmp/t.json',
      permission_mode: 'default',
    };
    await handlePerEventHook(input, { config: DEFAULT_CONFIG, ipcClient: mockClient });
    expect(mockClient.sendEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handlePerEventHook — does not throw on IPC errors
// ---------------------------------------------------------------------------

describe('handlePerEventHook — error resilience', () => {
  let mockClient: IpcClient;

  beforeEach(() => {
    mockClient = makeMockClient();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw when sendEvent throws', async () => {
    vi.mocked(mockClient.sendEvent).mockImplementationOnce(() => {
      throw new Error('socket unavailable');
    });
    const input = makePreToolUseInput();
    await expect(
      handlePerEventHook(input, { config: DEFAULT_CONFIG, ipcClient: mockClient }),
    ).resolves.toBeUndefined();
  });

  it('logs to stderr when sendEvent throws', async () => {
    vi.mocked(mockClient.sendEvent).mockImplementationOnce(() => {
      throw new Error('socket unavailable');
    });
    const input = makePreToolUseInput();
    await handlePerEventHook(input, { config: DEFAULT_CONFIG, ipcClient: mockClient });
    expect(process.stderr.write).toHaveBeenCalled();
  });
});
