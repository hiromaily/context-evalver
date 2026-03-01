import { constants } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookInput } from '../src/event-capture.js';
import { handleSessionEnd } from '../src/hook-dispatcher.js';
import { IpcClient } from '../src/ipc-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionEndInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: 'end-sess-42',
    hook_event_name: 'SessionEnd',
    cwd: '/repo',
    transcript_path: '/tmp/transcript.json',
    permission_mode: 'default',
    ...overrides,
  };
}

function makeMockClient(): IpcClient {
  return {
    sendEvent: vi.fn(),
    querySignals: vi.fn(),
    sendFlush: vi.fn().mockResolvedValue(undefined),
    sendShutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as IpcClient;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// handleSessionEnd — sends flush
// ---------------------------------------------------------------------------

describe('handleSessionEnd — flush', () => {
  let mockClient: IpcClient;

  beforeEach(() => {
    mockClient = makeMockClient();
  });

  it('calls sendFlush on the ipc client', async () => {
    const input = makeSessionEndInput();
    await handleSessionEnd(input, { ipcClient: mockClient });
    expect(mockClient.sendFlush).toHaveBeenCalledOnce();
  });

  it('calls sendFlush before sendShutdown', async () => {
    const callOrder: string[] = [];
    vi.mocked(mockClient.sendFlush).mockImplementationOnce(async () => {
      callOrder.push('flush');
    });
    vi.mocked(mockClient.sendShutdown).mockImplementationOnce(async () => {
      callOrder.push('shutdown');
    });
    const input = makeSessionEndInput();
    await handleSessionEnd(input, { ipcClient: mockClient });
    expect(callOrder.indexOf('flush')).toBeLessThan(callOrder.indexOf('shutdown'));
  });
});

// ---------------------------------------------------------------------------
// handleSessionEnd — sends shutdown
// ---------------------------------------------------------------------------

describe('handleSessionEnd — shutdown', () => {
  let mockClient: IpcClient;

  beforeEach(() => {
    mockClient = makeMockClient();
  });

  it('calls sendShutdown on the ipc client', async () => {
    const input = makeSessionEndInput();
    await handleSessionEnd(input, { ipcClient: mockClient });
    expect(mockClient.sendShutdown).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// handleSessionEnd — draft file cleanup
// ---------------------------------------------------------------------------

describe('handleSessionEnd — draft file cleanup', () => {
  let mockClient: IpcClient;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'session-end-test-'));
    mockClient = makeMockClient();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('deletes the draft staging file when it exists', async () => {
    const draftPath = join(tmpDir, 'end-sess-42.json');
    await writeFile(draftPath, '{"session_id":"end-sess-42","patches":[]}');
    const input = makeSessionEndInput();
    await handleSessionEnd(input, { ipcClient: mockClient, draftsDir: tmpDir });
    expect(await fileExists(draftPath)).toBe(false);
  });

  it('does not throw when draft file does not exist', async () => {
    const input = makeSessionEndInput();
    await expect(
      handleSessionEnd(input, { ipcClient: mockClient, draftsDir: tmpDir }),
    ).resolves.toBeUndefined();
  });

  it('does not throw when draftsDir does not exist', async () => {
    const input = makeSessionEndInput();
    await expect(
      handleSessionEnd(input, { ipcClient: mockClient, draftsDir: '/nonexistent/dir' }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleSessionEnd — error resilience
// ---------------------------------------------------------------------------

describe('handleSessionEnd — error resilience', () => {
  let mockClient: IpcClient;

  beforeEach(() => {
    mockClient = makeMockClient();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw when sendFlush rejects', async () => {
    vi.mocked(mockClient.sendFlush).mockRejectedValueOnce(new Error('socket gone'));
    const input = makeSessionEndInput();
    await expect(handleSessionEnd(input, { ipcClient: mockClient })).resolves.toBeUndefined();
  });

  it('does not throw when sendShutdown rejects', async () => {
    vi.mocked(mockClient.sendShutdown).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const input = makeSessionEndInput();
    await expect(handleSessionEnd(input, { ipcClient: mockClient })).resolves.toBeUndefined();
  });

  it('still calls sendShutdown even when sendFlush rejects', async () => {
    vi.mocked(mockClient.sendFlush).mockRejectedValueOnce(new Error('gone'));
    const input = makeSessionEndInput();
    await handleSessionEnd(input, { ipcClient: mockClient });
    expect(mockClient.sendShutdown).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// IpcClient.sendShutdown — socket tests
// ---------------------------------------------------------------------------

import type { Server } from 'node:net';
import { createServer } from 'node:net';

describe('IpcClient.sendShutdown', () => {
  let tmpNetDir: string;
  let sockPath: string;
  let server: Server;
  const received: string[] = [];

  beforeEach(async () => {
    tmpNetDir = await mkdtemp(join(tmpdir(), 'ipc-shutdown-test-'));
    sockPath = join(tmpNetDir, 'test.sock');
    received.length = 0;
    server = createServer(socket => {
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) received.push(line);
        }
      });
      socket.on('close', () => {
        /* no-op */
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(sockPath, () => resolve());
      server.on('error', reject);
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(tmpNetDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('sends a shutdown message to the socket', async () => {
    const client = new IpcClient(sockPath);
    await client.sendShutdown();
    await new Promise(r => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    const msg = JSON.parse(received[0]!);
    expect(msg.type).toBe('shutdown');
  });

  it('does not throw when socket is unavailable', async () => {
    const client = new IpcClient('/tmp/no-shutdown-sock.sock');
    await expect(client.sendShutdown()).resolves.toBeUndefined();
  });

  it('logs to stderr when socket is unavailable', async () => {
    const client = new IpcClient('/tmp/no-shutdown-sock2.sock');
    await client.sendShutdown();
    expect(process.stderr.write).toHaveBeenCalled();
  });
});
