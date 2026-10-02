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
const NEWLINE = 0x0a;

// The socket and token exist only while Companion runs with its bridge on, so these mean "closed".
const NOT_RUNNING_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK']);
const NOT_RUNNING_MESSAGE =
  'Companion is not running, or its bridge is off. Open Companion (for example: open -a Companion), ' +
  'check Ajustes › Agentes › "Prestar las manos a otros agentes", then retry. ' +
  'open_app cannot start it: it runs inside Companion.';
// Opening Companion would not fix this one: the files exist but belong to another user.
const PERMISSION_MESSAGE =
  "Companion's bridge files cannot be opened by this process (permission denied). " +
  'Run Claude Code as the same macOS user that runs Companion, then retry.';
// Companion serves one connection; its own busy text names neither the cause nor the way out.
const BUSY_MESSAGE =
  "Another agent session already holds Companion's hands, and Companion serves one at a time. " +
  'Close that session (or its companion MCP server), then retry.';

/**
 * The one place a failure to reach Companion becomes an actionable error, so a future
 * auto-launch hooks in here. Matches on err.code only; anything unlisted passes through raw.
 */
function unreachable(err: unknown): unknown {
  const code =
    err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
  let translated: BridgeError;
  if (code !== undefined && NOT_RUNNING_CODES.has(code)) {
    translated = new BridgeError('companion_unavailable', NOT_RUNNING_MESSAGE, { cause: err });
  } else if (code === 'EACCES') {
    translated = new BridgeError('permission_required', PERMISSION_MESSAGE, { cause: err });
  } else {
    return err;
  }
  // The raw message carries the bridge path; the code alone is enough to diagnose.
  process.stderr.write(`[bridge] companion unreachable: ${code}\n`);
  return translated;
}

const MAX_SERVER_MESSAGE = 300;
const CODE_PATTERN = /^[a-z_]{1,64}$/;

interface ServerErrorBody {
  code: string;
  message: string;
}

/** The error member of a frame, or null when it is not the protocol's shape. */
function parseServerError(raw: unknown): ServerErrorBody | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { code, message } = raw as Record<string, unknown>;
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return null;
  return { code, message: typeof message === 'string' ? message : '' };
}

// The message reaches the model: one short line, so it cannot carry a paragraph of instructions.
function serverError(error: ServerErrorBody): BridgeError {
  if (error.code === 'busy') return new BridgeError('busy', BUSY_MESSAGE);
  // eslint-disable-next-line no-control-regex
  const flat = error.message.replace(/[\x00-\x1F\x7F\u2028\u2029]+/g, ' ').trim();
  return new BridgeError(error.code, flat.slice(0, MAX_SERVER_MESSAGE));
}

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
  // True only after hello succeeds: an open socket without a session would send calls Companion rejects.
  private ready = false;
  // Shared by concurrent callers so a race never opens a second socket, which Companion answers with busy.
  private connecting: Promise<void> | null = null;
  // Companion sends some refusals without an id right before hanging up; they explain the close.
  private hangUpReason: BridgeError | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private options: BridgeClientOptions;

  public session: string | null = null;
  public tools: ToolSpec[] = [];

  constructor(options?: BridgeClientOptions) {
    this.options = options ?? {};
  }

  get isConnected(): boolean {
    return this.ready;
  }

  connect(): Promise<void> {
    if (this.ready) return Promise.resolve();
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async call(name: string, args: Record<string, unknown>): Promise<CallResult> {
    await this.connect();
    const timeoutConfig = getTimeoutForTool(name, this.options);
    const result = await this.request(
      { method: 'call', params: { name, arguments: args } },
      timeoutConfig.ms,
      timeoutConfig.code,
    );
    return result as CallResult;
  }

  async close(): Promise<void> {
    if (this.socket) {
      this.teardown(this.socket, new BridgeError('companion_unavailable', 'Socket closed'));
    }
  }

  private async open(): Promise<void> {
    let token: string;
    try {
      token = readFileSync(getTokenPath(), 'utf-8').trim();
    } catch (err) {
      throw unreachable(err);
    }

    const socket = await this.dial();
    try {
      const hello = (await this.request(
        { method: 'hello', params: { token, client: 'claude-code', protocol: 1 } },
        this.options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
        'timeout',
      )) as HelloResult;
      this.session = hello.session;
      this.tools = hello.tools;
      this.ready = true;
    } catch (err) {
      this.teardown(socket, err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  private dial(): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(getSocketPath());
      // Registered with once() and removed on 'connect', so it only sees failures to reach the socket.
      const onError = (err: Error) => {
        socket.destroy();
        reject(unreachable(err));
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        this.attach(socket);
        resolve(socket);
      });
    });
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    this.hangUpReason = null;
    // Per socket, and kept as bytes so a multibyte character split across reads decodes whole.
    let partial: Buffer = Buffer.alloc(0);

    // A socket that is no longer current must not touch the live one's state or pending calls.
    socket.on('data', (chunk: Buffer) => {
      if (socket !== this.socket) return;
      partial = this.onData(socket, partial.length ? Buffer.concat([partial, chunk]) : chunk);
    });
    socket.on('error', (err) => {
      if (socket !== this.socket) return;
      process.stderr.write(`[bridge] socket error: ${err.message}\n`);
      this.teardown(
        socket,
        this.hangUpReason ?? new BridgeError('companion_unavailable', 'Socket error'),
      );
    });
    socket.on('close', () => {
      if (socket !== this.socket) return;
      process.stderr.write('[bridge] socket closed\n');
      this.teardown(
        socket,
        this.hangUpReason ?? new BridgeError('companion_unavailable', 'Socket closed'),
      );
    });
  }

  /** Splits complete lines out of `data` and returns the unterminated rest. */
  private onData(socket: Socket, data: Buffer): Buffer {
    let start = 0;
    let end: number;
    while ((end = data.indexOf(NEWLINE, start)) !== -1) {
      const line = data.subarray(start, end);
      start = end + 1;
      // Measured per line: two valid replies sharing a read are not one oversized frame.
      if (line.length > MAX_LINE_SIZE) {
        this.teardown(socket, new BridgeError('frame_too_large', 'Server frame exceeds 64 KB'));
        return Buffer.alloc(0);
      }
      if (line.length > 0) this.onLine(socket, line.toString('utf-8'));
      if (socket !== this.socket) return Buffer.alloc(0);
    }
    const rest = data.subarray(start);
    // Guards a peer that streams without ever sending a newline.
    if (rest.length > MAX_LINE_SIZE) {
      this.teardown(socket, new BridgeError('frame_too_large', 'Server frame exceeds 64 KB'));
      return Buffer.alloc(0);
    }
    return rest;
  }

  private onLine(socket: Socket, line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.badFrame(socket);
      return;
    }

    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      this.badFrame(socket);
      return;
    }
    const msgId = msg.id;
    const error = msg.error === undefined ? undefined : parseServerError(msg.error);
    if (error === null || (msgId !== null && msgId !== undefined && typeof msgId !== 'number')) {
      this.badFrame(socket);
      return;
    }

    if (msgId === null || msgId === undefined) {
      if (error) {
        process.stderr.write(`[bridge] unsolicited error: ${error.code}\n`);
        this.hangUpReason = serverError(error);
      }
      return;
    }

    const pending = this.pending.get(msgId);
    if (!pending) {
      // Stale ID or out-of-order response.
      process.stderr.write(`[bridge] unexpected response id=${msgId}\n`);
      return;
    }

    this.pending.delete(msgId);
    clearTimeout(pending.timeoutHandle);

    if (msg.result) {
      pending.resolve(msg.result);
    } else if (error) {
      pending.reject(serverError(error));
    } else {
      pending.reject(new BridgeError('unknown_error', 'Malformed response'));
    }
  }

  // Logs nothing of the line: JSON.parse's message quotes its start, which can be screen content.
  private badFrame(socket: Socket): void {
    process.stderr.write('[bridge] bad frame from Companion\n');
    this.teardown(socket, new BridgeError('bad_frame', 'Failed to parse response'));
  }

  private request(
    body: { method: string; params: { name?: string } & Record<string, unknown> },
    timeoutMs: number,
    timeoutCode: 'timeout' | 'approval_timeout',
  ): Promise<unknown> {
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(new BridgeError('companion_unavailable', 'Socket not connected'));
    }
    const id = this.nextId++;
    const line = JSON.stringify({ id, ...body }) + '\n';
    const bytes = Buffer.byteLength(line, 'utf-8');
    // Refused here so only this call fails: Companion would answer by closing the whole session.
    if (bytes > MAX_LINE_SIZE) {
      return Promise.reject(
        new BridgeError(
          'frame_too_large',
          `This request is ${Math.ceil(bytes / 1024)} KB and Companion accepts at most 64 KB per call. ` +
            'Split the text into smaller parts and send them in separate calls.',
        ),
      );
    }

    return new Promise<unknown>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(timeoutCode, `Request ${id} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeoutHandle });
      // Stderr log: tool name and id only, never arguments.
      if (body.method === 'call') {
        process.stderr.write(`[bridge] call ${body.params.name} id=${id}\n`);
      }
      socket.write(line);
    });
  }

  private teardown(socket: Socket, reason: Error): void {
    socket.destroy();
    if (socket !== this.socket) return;
    this.socket = null;
    this.ready = false;
    this.session = null;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}
