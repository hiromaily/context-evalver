import { mkdtemp, rm } from 'node:fs/promises';
import type { Server, Socket } from 'node:net';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapturedEvent } from '../src/ipc-client.js';
import { IpcClient, type SignalSummaryMessage, socketPathForSession } from '../src/ipc-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeEvent(): CapturedEvent {
  return {
    session_id: 'test-session',
    timestamp: 1_700_000_000,
    repo_root: '/repo',
    kind: 'file_read',
    payload: { path: '/repo/src/main.rs' },
  };
}

function startUnixServer(
  sockPath: string,
  handler: (data: string, socket: Socket) => void,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(socket => {
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) handler(line, socket);
        }
      });
    });
    server.listen(sockPath, () => resolve(server));
    server.on('error', reject);
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// socketPathForSession
// ---------------------------------------------------------------------------

describe('socketPathForSession', () => {
  it('ends with {session_id}.sock', () => {
    const p = socketPathForSession('my-session');
    expect(p.endsWith('my-session.sock')).toBe(true);
  });

  it('contains "context-evalver" directory segment', () => {
    const p = socketPathForSession('sess-1');
    expect(p).toContain('context-evalver');
  });

  it('is deterministic for the same session_id', () => {
    expect(socketPathForSession('abc')).toBe(socketPathForSession('abc'));
  });

  it('differs for different session_ids', () => {
    expect(socketPathForSession('a')).not.toBe(socketPathForSession('b'));
  });
});

// ---------------------------------------------------------------------------
// IpcClient — sendEvent (fire-and-forget)
// ---------------------------------------------------------------------------

describe('IpcClient.sendEvent', () => {
  let tmpDir: string;
  let sockPath: string;
  let server: Server;
  const received: string[] = [];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ipc-client-test-'));
    sockPath = join(tmpDir, 'test.sock');
    received.length = 0;
    server = await startUnixServer(sockPath, line => received.push(line));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    await stopServer(server);
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('sends a valid JSONL event message to the socket', async () => {
    const client = new IpcClient(sockPath);
    client.sendEvent(makeFakeEvent());
    // Brief delay to allow the OS to deliver the data
    await new Promise(r => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    const msg = JSON.parse(received[0]!);
    expect(msg.type).toBe('event');
    expect(msg.event.kind).toBe('file_read');
  });

  it('does not throw when socket is unavailable', () => {
    const client = new IpcClient('/tmp/does-not-exist-XXXX.sock');
    expect(() => client.sendEvent(makeFakeEvent())).not.toThrow();
  });

  it('logs to stderr when socket is unavailable', async () => {
    const client = new IpcClient('/tmp/does-not-exist-YYYY.sock');
    client.sendEvent(makeFakeEvent());
    await new Promise(r => setTimeout(r, 50));
    expect(process.stderr.write).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// IpcClient — querySignals (request-response)
// ---------------------------------------------------------------------------

describe('IpcClient.querySignals', () => {
  let tmpDir: string;
  let sockPath: string;
  let server: Server;

  const fakeSignalSummary: SignalSummaryMessage = {
    type: 'signal_summary',
    gate_passed: true,
    gate_reasons: [],
    repeated_files: [],
    repeated_errors: [],
    repeated_sequences: [],
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ipc-client-test-'));
    sockPath = join(tmpDir, 'test.sock');
    server = await startUnixServer(sockPath, (_line, socket) => {
      socket.write(`${JSON.stringify(fakeSignalSummary)}\n`);
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    await stopServer(server);
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('sends query_signals message and returns parsed signal summary', async () => {
    const client = new IpcClient(sockPath);
    const result = await client.querySignals('/repo', 30, 3);
    expect(result.type).toBe('signal_summary');
    expect(result.gate_passed).toBe(true);
  });

  it('returns an error signal summary when socket is unavailable', async () => {
    const client = new IpcClient('/tmp/does-not-exist-ZZZ.sock');
    const result = await client.querySignals('/repo', 30, 3);
    expect(result.type).toBe('signal_summary');
    expect(result.gate_passed).toBe(false);
  });

  it('logs to stderr when socket is unavailable', async () => {
    const client = new IpcClient('/tmp/does-not-exist-QQQ.sock');
    await client.querySignals('/repo', 30, 3);
    expect(process.stderr.write).toHaveBeenCalled();
  });

  it('sends correct query_signals message fields', async () => {
    const received: string[] = [];
    await stopServer(server);
    server = await startUnixServer(sockPath, (line, socket) => {
      received.push(line);
      socket.write(`${JSON.stringify(fakeSignalSummary)}\n`);
    });

    const client = new IpcClient(sockPath);
    await client.querySignals('/my/repo', 14, 5);

    expect(received).toHaveLength(1);
    const msg = JSON.parse(received[0]!);
    expect(msg.type).toBe('query_signals');
    expect(msg.repo_root).toBe('/my/repo');
    expect(msg.window_days).toBe(14);
    expect(msg.min_repeat_threshold).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// IpcClient — sendFlush
// ---------------------------------------------------------------------------

describe('IpcClient.sendFlush', () => {
  let tmpDir: string;
  let sockPath: string;
  let server: Server;
  const received: string[] = [];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ipc-client-test-'));
    sockPath = join(tmpDir, 'test.sock');
    received.length = 0;
    server = await startUnixServer(sockPath, (line, socket) => {
      received.push(line);
      socket.write(`${JSON.stringify({ type: 'ack', ok: true })}\n`);
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    await stopServer(server);
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('sends a flush message to the socket', async () => {
    const client = new IpcClient(sockPath);
    await client.sendFlush();
    expect(received).toHaveLength(1);
    const msg = JSON.parse(received[0]!);
    expect(msg.type).toBe('flush');
  });

  it('does not throw when socket is unavailable', async () => {
    const client = new IpcClient('/tmp/no-sock-flush.sock');
    await expect(client.sendFlush()).resolves.toBeUndefined();
  });

  it('logs to stderr when socket is unavailable', async () => {
    const client = new IpcClient('/tmp/no-sock-flush2.sock');
    await client.sendFlush();
    expect(process.stderr.write).toHaveBeenCalled();
  });
});
