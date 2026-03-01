import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types shared with the Rust daemon wire protocol
// ---------------------------------------------------------------------------

export type EventKind = 'file_read' | 'file_write' | 'command' | 'error';

export interface SanitizedPayload {
  path?: string;
  command?: string;
  message?: string;
}

export interface CapturedEvent {
  session_id: string;
  timestamp: number;
  repo_root: string;
  kind: EventKind;
  payload: SanitizedPayload;
}

export type Severity = 'low' | 'medium' | 'high';

export interface FileCandidate {
  path: string;
  count: number;
  confidence: number;
  severity: Severity;
  evidence_count: number;
  draftable: boolean;
}

export interface ErrorCandidate {
  error: string;
  count: number;
  confidence: number;
  severity: Severity;
  evidence_count: number;
  draftable: boolean;
}

export interface SequenceCandidate {
  commands: string[];
  count: number;
  confidence: number;
  severity: Severity;
  evidence_count: number;
  draftable: boolean;
}

export interface SignalSummaryMessage {
  type: 'signal_summary';
  gate_passed: boolean;
  gate_reasons: string[];
  repeated_files: FileCandidate[];
  repeated_errors: ErrorCandidate[];
  repeated_sequences: SequenceCandidate[];
}

// ---------------------------------------------------------------------------
// Outbound message types
// ---------------------------------------------------------------------------

interface EventMessage {
  type: 'event';
  event: CapturedEvent;
}

interface QuerySignalsMessage {
  type: 'query_signals';
  repo_root: string;
  window_days: number;
  min_repeat_threshold: number;
}

interface FlushMessage {
  type: 'flush';
}

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

/**
 * Derives the Unix socket path for a given session_id.
 * Path: `~/.local/share/context-optimizer/{session_id}.sock`
 */
export function socketPathForSession(session_id: string): string {
  // Mirror the Rust daemon's socket_path_for_session logic.
  const xdgDataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(xdgDataHome, 'context-optimizer', `${session_id}.sock`);
}

// ---------------------------------------------------------------------------
// Fallback signal summary returned on connection error
// ---------------------------------------------------------------------------

const ERROR_SUMMARY: SignalSummaryMessage = {
  type: 'signal_summary',
  gate_passed: false,
  gate_reasons: ['daemon unreachable'],
  repeated_files: [],
  repeated_errors: [],
  repeated_sequences: [],
};

// ---------------------------------------------------------------------------
// IpcClient
// ---------------------------------------------------------------------------

/**
 * Thin client for the context-optimizer Rust daemon Unix socket.
 *
 * - `sendEvent` is fire-and-forget (no await for acknowledgment).
 * - `querySignals` is request-response: writes one JSONL line, reads one back.
 * - `sendFlush` writes a flush message and awaits an ack.
 * - All connection errors are caught, logged to stderr, and swallowed.
 */
export class IpcClient {
  constructor(private readonly sockPath: string) {}

  // -------------------------------------------------------------------------
  // sendEvent — fire-and-forget
  // -------------------------------------------------------------------------

  sendEvent(event: CapturedEvent): void {
    const msg: EventMessage = { type: 'event', event };
    const line = `${JSON.stringify(msg)}\n`;

    const socket = createConnection(this.sockPath);
    socket.on('error', err => {
      process.stderr.write(`[context-optimizer] sendEvent failed: ${err.message}\n`);
    });
    socket.on('connect', () => {
      socket.write(line, () => socket.destroy());
    });
  }

  // -------------------------------------------------------------------------
  // querySignals — request-response
  // -------------------------------------------------------------------------

  querySignals(
    repo_root: string,
    window_days: number,
    min_repeat_threshold: number,
  ): Promise<SignalSummaryMessage> {
    const msg: QuerySignalsMessage = {
      type: 'query_signals',
      repo_root,
      window_days,
      min_repeat_threshold,
    };
    const line = `${JSON.stringify(msg)}\n`;

    return new Promise(resolve => {
      const socket = createConnection(this.sockPath);

      socket.on('error', err => {
        process.stderr.write(`[context-optimizer] querySignals failed: ${err.message}\n`);
        resolve(ERROR_SUMMARY);
      });

      socket.on('connect', () => {
        socket.write(line);
        let buf = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          buf += chunk;
          const nl = buf.indexOf('\n');
          if (nl !== -1) {
            const rawLine = buf.slice(0, nl);
            socket.destroy();
            try {
              resolve(JSON.parse(rawLine) as SignalSummaryMessage);
            } catch {
              process.stderr.write('[context-optimizer] querySignals: malformed response\n');
              resolve(ERROR_SUMMARY);
            }
          }
        });
      });
    });
  }

  // -------------------------------------------------------------------------
  // sendFlush — write flush message, await ack
  // -------------------------------------------------------------------------

  sendFlush(): Promise<void> {
    const msg: FlushMessage = { type: 'flush' };
    const line = `${JSON.stringify(msg)}\n`;

    return new Promise(resolve => {
      const socket = createConnection(this.sockPath);

      socket.on('error', err => {
        process.stderr.write(`[context-optimizer] sendFlush failed: ${err.message}\n`);
        resolve();
      });

      socket.on('connect', () => {
        socket.write(line);
        let buf = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          buf += chunk;
          if (buf.includes('\n')) {
            socket.destroy();
            resolve();
          }
        });
        // Resolve even if socket closes without a response
        socket.on('close', () => resolve());
      });
    });
  }

  // -------------------------------------------------------------------------
  // sendShutdown — tell the daemon to exit cleanly
  // -------------------------------------------------------------------------

  sendShutdown(): Promise<void> {
    const line = `${JSON.stringify({ type: 'shutdown' })}\n`;

    return new Promise(resolve => {
      const socket = createConnection(this.sockPath);

      socket.on('error', err => {
        process.stderr.write(`[context-optimizer] sendShutdown failed: ${err.message}\n`);
        resolve();
      });

      socket.on('connect', () => {
        socket.write(line, () => {
          socket.destroy();
          resolve();
        });
      });
    });
  }

  // -------------------------------------------------------------------------
  // sendReset — clear throttle records for a repository
  // -------------------------------------------------------------------------

  sendReset(repoRoot: string): Promise<void> {
    const line = `${JSON.stringify({ type: 'reset', repo_root: repoRoot })}\n`;

    return new Promise((resolve, reject) => {
      const socket = createConnection(this.sockPath);

      socket.on('error', err => {
        reject(err);
      });

      socket.on('connect', () => {
        socket.write(line, () => {
          socket.destroy();
          resolve();
        });
      });
    });
  }
}
