/// Performance test: event send latency (task 15.3)
///
/// Starts a local Unix socket server that immediately drains incoming data,
/// then sends 1000 events sequentially using the same connection+write pattern
/// as IpcClient.sendEvent.  Each measurement covers:
///   - Unix socket connection establishment
///   - JSONL line serialization and write to OS send buffer (write callback)
///
/// Assertions:
///   - Median latency < 5 ms
///   - 99th-percentile latency < 20 ms
///
/// Requirements: 2.7, 14.1, 14.3

import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:net';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CapturedEvent } from '../src/ipc-client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVENT_COUNT = 1000;
const MEDIAN_THRESHOLD_MS = 5;
const P99_THRESHOLD_MS = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(i: number): CapturedEvent {
  return {
    session_id: 'perf-session',
    timestamp: 1_700_000_000 + i,
    repo_root: '/repo',
    kind: 'file_read',
    payload: { path: `src/file_${i}.rs` },
  };
}

/**
 * Mirrors IpcClient.sendEvent: opens a Unix socket connection, writes one
 * JSONL event line, and resolves with the elapsed time (ms) when the OS
 * write buffer has accepted the data (write callback).
 */
function sendEventTimed(sockPath: string, event: CapturedEvent): Promise<number> {
  const line = `${JSON.stringify({ type: 'event', event })}\n`;
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const socket = createConnection(sockPath);
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(line, () => {
        const elapsed = performance.now() - start;
        socket.destroy();
        resolve(elapsed);
      });
    });
  });
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('IpcClient event send latency', { timeout: 30_000 }, () => {
  let tmpDir: string;
  let sockPath: string;
  let server: Server;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ipc-perf-'));
    sockPath = join(tmpDir, 'perf.sock');

    // Minimal server: drain incoming data, no response needed (sendEvent is fire-and-forget)
    server = createServer(socket => {
      socket.resume(); // discard all incoming data
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(sockPath, () => resolve());
      server.on('error', reject);
    });
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it(`sends ${EVENT_COUNT} events sequentially: median < ${MEDIAN_THRESHOLD_MS} ms, p99 < ${P99_THRESHOLD_MS} ms`, async () => {
    const latencies: number[] = [];

    for (let i = 0; i < EVENT_COUNT; i++) {
      const elapsed = await sendEventTimed(sockPath, makeEvent(i));
      latencies.push(elapsed);
    }

    latencies.sort((a, b) => a - b);

    const med = median(latencies);
    const p99 = percentile(latencies, 99);

    expect(med).toBeLessThan(MEDIAN_THRESHOLD_MS);
    expect(p99).toBeLessThan(P99_THRESHOLD_MS);
  });
});
