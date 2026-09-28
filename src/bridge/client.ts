/**
 * BridgeClient: connects to Companion over a Unix domain socket and speaks JSON Lines.
 *
 * Handles framing (max 64 KB per line), token authentication, request/response
 * correlation by ID, per-call timeouts, and automatic reconnection on next call
 * after socket loss. Never logs argument values or output; only tool name and code.
 */
import { createConnection, Socket } from 'net';
import { readFileSync } from 'fs';
import { getSocketPath, getTokenPath } from './paths.js';
import { BridgeError } from './errors.js';

export { BridgeError };

export interface ToolSpec {
  name: string;
  description: string;
  properties: Array<{
    name: string;
    type: string;
    description: string;
  }>;
  required: string[];
}

export interface HelloResult {
  session: string;
  language: 'es' | 'en';
  accessibility: boolean;
  tools: ToolSpec[];
}

export interface CallResult {
  ok: boolean;
  output: string;
  target: string;
  tool?: string;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeoutHandle: NodeJS.Timeout;
}

const MAX_LINE_SIZE = 65_536;
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const DEFAULT_WRITE_TIMEOUT_MS = 130_000;

interface TimeoutConfig {
  ms: number;
  code: 'timeout' | 'approval_timeout';
}

interface BridgeClientOptions {
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
}

function getTimeoutForTool(name: string, options: BridgeClientOptions): TimeoutConfig {
  const writeTools = [
    'click',
    'type_text',
    'press_key',
    'scroll',
    'menu',
    'open_app',
    'open_url',
    'open_file',
  ];
  const isWrite = writeTools.includes(name);
  return {
    ms: isWrite
      ? (options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS)
      : (options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS),
    code: isWrite ? 'approval_timeout' : 'timeout',
  };
}

export class BridgeClient {
  private socket: Socket | null = null;
  private connected = false;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';
  private options: BridgeClientOptions;

  public session: string | null = null;
  public tools: ToolSpec[] = [];

  constructor(options?: BridgeClientOptions) {
    this.options = options ?? {};
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const socketPath = getSocketPath();
    const tokenContent = readFileSync(getTokenPath(), 'utf-8');
    const token = tokenContent.trim();

    return new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath);

      const onError = (err: Error) => {
        socket.destroy();
        this.socket = null;
        this.connected = false;
        reject(err);
      };

      const onConnect = () => {
        socket.removeListener('error', onError);
        this.socket = socket;
        this.connected = true;

        socket.on('data', (data) => {
          this.onData(data);
        });

        socket.on('error', (err) => {
          this.onSocketError(err);
        });

        socket.on('close', () => {
          this.onSocketClose();
        });

        // Send hello.
        const helloMsg = {
          id: this.nextId++,
          method: 'hello',
          params: {
            token,
            client: 'claude-code',
            protocol: 1,
          },
        };
        this.sendMessage(helloMsg);

        // Wait for hello response.
        this.waitForMessage(helloMsg.id as number)
          .then((result: unknown) => {
            const hello = result as HelloResult;
            this.session = hello.session;
            this.tools = hello.tools;
            resolve();
          })
          .catch(reject);
      };

      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
  }

  async call(name: string, args: Record<string, unknown>): Promise<CallResult> {
    await this.ensureConnected();

    const id = this.nextId++;
    const msg = {
      id,
      method: 'call',
      params: {
        name,
        arguments: args,
      },
    };

    this.sendMessage(msg);
    const timeoutConfig = getTimeoutForTool(name, this.options);
    const result = (await this.waitForMessage(id, timeoutConfig.ms, timeoutConfig.code)) as unknown;

    // Check for error response.
    if (typeof result === 'object' && result !== null && 'error' in result) {
      const err = result as { error: { code: string; message: string } };
      throw new BridgeError(err.error.code, err.error.message);
    }

    return result as CallResult;
  }

  async close(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }

    // Reject all pending.
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(new BridgeError('companion_unavailable', 'Socket closed'));
    }
    this.pending.clear();

    // Send bye if still connected (note: socket may already be destroyed).
    if (this.connected && this.socket) {
      const byeMsg = {
        id: this.nextId++,
        method: 'bye',
      };
      this.sendMessage(byeMsg);
    }
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  private sendMessage(msg: unknown): void {
    if (!this.socket || !this.connected) {
      throw new BridgeError('companion_unavailable', 'Socket not connected');
    }
    const line = JSON.stringify(msg) + '\n';
    const bytes = Buffer.byteLength(line, 'utf-8');
    if (bytes > MAX_LINE_SIZE) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
      throw new BridgeError('frame_too_large', 'Request exceeds 64 KB');
    }
    // Stderr log: tool name and id only, never arguments.
    if ((msg as Record<string, unknown>).method === 'call') {
      const callMsg = msg as { id: number; params: { name: string } };
      process.stderr.write(`[bridge] call ${callMsg.params.name} id=${callMsg.id}\n`);
    }
    this.socket.write(line);
  }

  private waitForMessage(
    id: number,
    timeoutMs = DEFAULT_READ_TIMEOUT_MS,
    timeoutCode: 'timeout' | 'approval_timeout' = 'timeout',
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(timeoutCode, `Request ${id} timed out`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeoutHandle });
    });
  }

  private onData(data: Buffer): void {
    this.buffer += data.toString('utf-8');

    // Check buffer size before looking for newline (S2: guard against streaming without newline).
    if (Buffer.byteLength(this.buffer, 'utf-8') > MAX_LINE_SIZE) {
      this.socket?.destroy();
      this.socket = null;
      this.connected = false;

      // Reject all pending with frame_too_large.
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timeoutHandle);
        pending.reject(new BridgeError('frame_too_large', 'Buffer exceeds 64 KB'));
      }
      this.pending.clear();
      return;
    }

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line) continue;

      // Check frame size of a complete line.
      const bytes = Buffer.byteLength(line, 'utf-8');
      if (bytes > MAX_LINE_SIZE) {
        this.socket?.destroy();
        this.socket = null;
        this.connected = false;

        // Reject all pending with frame_too_large.
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timeoutHandle);
          pending.reject(new BridgeError('frame_too_large', 'Server frame exceeds 64 KB'));
        }
        this.pending.clear();
        return;
      }

      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const msgId = msg.id as number | null;

        if (msgId === null || msgId === undefined) {
          // Unsolicited error from server (e.g., session_closed).
          const error = msg.error as { code: string; message: string } | undefined;
          if (error) {
            process.stderr.write(`[bridge] unsolicited error: ${error.code} ${error.message}\n`);
          }
          continue;
        }

        const pending = this.pending.get(msgId);
        if (!pending) {
          // Stale ID or out-of-order response.
          process.stderr.write(`[bridge] unexpected response id=${msgId}\n`);
          continue;
        }

        this.pending.delete(msgId);
        clearTimeout(pending.timeoutHandle);

        if (msg.result) {
          pending.resolve(msg.result);
        } else if (msg.error) {
          const err = msg.error as { code: string; message: string };
          pending.reject(new BridgeError(err.code, err.message));
        } else {
          pending.reject(new BridgeError('unknown_error', 'Malformed response'));
        }
      } catch (err) {
        process.stderr.write(
          `[bridge] parse error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        // JSON parse error is a protocol violation: destroy socket and reject ALL pending (S1).
        this.socket?.destroy();
        this.socket = null;
        this.connected = false;

        for (const [, pending] of this.pending) {
          clearTimeout(pending.timeoutHandle);
          pending.reject(new BridgeError('bad_frame', 'Failed to parse response'));
        }
        this.pending.clear();
        return;
      }
    }
  }

  private onSocketError(err: Error): void {
    process.stderr.write(`[bridge] socket error: ${err.message}\n`);
    this.socket = null;
    this.connected = false;

    // Reject all pending.
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(new BridgeError('companion_unavailable', 'Socket error'));
    }
    this.pending.clear();
  }

  private onSocketClose(): void {
    process.stderr.write('[bridge] socket closed\n');
    this.socket = null;
    this.connected = false;

    // Reject all pending.
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(new BridgeError('companion_unavailable', 'Socket closed'));
    }
    this.pending.clear();
  }
}
