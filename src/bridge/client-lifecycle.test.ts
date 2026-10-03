/**
 * Connection lifecycle against a fake Companion: one connection at a time, framing per line,
 * and the server's reason surviving when it hangs up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, Server as NetServer, Socket } from 'net';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BridgeClient } from './client.js';

type Msg = { id: number; method: string; params?: { name?: string; arguments?: unknown } };
type Handler = (msg: Msg, socket: Socket, connection: number) => void;

const HELLO_RESULT = { session: 's', language: 'en', accessibility: true, tools: [] };

describe('BridgeClient lifecycle', () => {
  let testDir: string;
  let server: NetServer;
  let sockets: Socket[];

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'companion-life-'));
    process.env.COMPANION_BRIDGE_DIR = testDir;
    writeFileSync(join(testDir, 'bridge.token'), 'tok', { mode: 0o600 });
    sockets = [];
  });

  afterEach(async () => {
    delete process.env.COMPANION_BRIDGE_DIR;
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    rmSync(testDir, { recursive: true, force: true });
  });

  function reply(socket: Socket, id: number, result: unknown): void {
    socket.write(JSON.stringify({ id, result }) + '\n');
  }

  function start(handler: Handler): Promise<void> {
    return new Promise((resolve) => {
      server = createServer((socket) => {
        sockets.push(socket);
        const connection = sockets.length;
        let buffer = '';
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) if (line) handler(JSON.parse(line) as Msg, socket, connection);
        });
      });
      server.listen(join(testDir, 'bridge.sock'), () => resolve());
    });
  }

  function helloThen(onCall: Handler): Handler {
    return (msg, socket, connection) => {
      if (msg.method === 'hello') reply(socket, msg.id, HELLO_RESULT);
      else onCall(msg, socket, connection);
    };
  }

  // H2: Companion takes one connection and answers busy to the next, so a second socket must never exist.
  it('opens a single connection when two calls race while disconnected', async () => {
    await start(
      helloThen((msg, socket) => reply(socket, msg.id, { ok: true, output: 'x', target: '' })),
    );
    const client = new BridgeClient();
    const results = await Promise.all([client.call('look', {}), client.call('look', {})]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(sockets).toHaveLength(1);
    await client.close();
  });

  // M3
  it('is not connected, and hangs up, when hello never answers', async () => {
    let hungUp!: Promise<void>;
    await start((_msg, socket) => {
      hungUp = new Promise((resolve) => socket.on('close', () => resolve()));
    });
    const client = new BridgeClient({ readTimeoutMs: 50 });
    await expect(client.connect()).rejects.toMatchObject({ code: 'timeout' });
    expect(client.isConnected).toBe(false);
    await hungUp;
  });

  it('keeps the session when a reply arrives after its call timed out', async () => {
    let first = true;
    await start(
      helloThen((msg, socket) => {
        const answer = () =>
          reply(socket, msg.id, { ok: true, output: String(msg.id), target: '' });
        if (first) {
          first = false;
          setTimeout(answer, 100);
        } else answer();
      }),
    );
    const client = new BridgeClient({ readTimeoutMs: 50, sessionSheetMs: 0 });
    await client.connect();
    await expect(client.call('look', {})).rejects.toMatchObject({ code: 'timeout' });
    await new Promise((r) => setTimeout(r, 80));
    expect(client.isConnected).toBe(true);
    const next = await client.call('look', {});
    expect(next.output).not.toBe('2');
    expect(sockets).toHaveLength(1);
    await client.close();
  });

  it('delivers a valid reply, then hangs up on an unterminated tail over 64 KB', async () => {
    await start(
      helloThen((msg, socket) => {
        if (msg.params?.name === 'look') {
          socket.write(
            JSON.stringify({ id: msg.id, result: { ok: true, output: 'fine', target: '' } }) +
              '\n' +
              'x'.repeat(70_000),
          );
        }
      }),
    );
    const client = new BridgeClient();
    await client.connect();
    await expect(client.call('look', {})).resolves.toMatchObject({ output: 'fine' });
    await vi.waitFor(() => expect(client.isConnected).toBe(false));
  });

  it('rejects the calls still waiting when it is closed', async () => {
    await start(helloThen(() => undefined));
    const client = new BridgeClient();
    await client.connect();
    const waiting = client.call('look', {});
    await client.close();
    await expect(waiting).rejects.toMatchObject({ code: 'companion_unavailable' });
    expect(client.isConnected).toBe(false);
  });

  // H5: the old guard measured the whole buffer, so a reply's tail plus the next reply crossed 64 KB.
  // One call is on the wire at a time, so the frame ahead of the reply is one the shim no longer
  // waits for, such as a reply to a call whose connection already moved on.
  it('keeps two replies that are each under 64 KB but sit in the buffer together', async () => {
    await start(
      helloThen((msg, socket) => {
        const stray =
          JSON.stringify({
            id: 999,
            result: { ok: true, output: 'a'.repeat(60_000), target: '' },
          }) + '\n';
        const own =
          JSON.stringify({
            id: msg.id,
            result: { ok: true, output: 'b'.repeat(10_000), target: '' },
          }) + '\n';
        socket.write(stray.slice(0, -10));
        setTimeout(() => socket.write(stray.slice(-10) + own), 20);
      }),
    );
    const client = new BridgeClient({ sessionSheetMs: 0 });
    await client.connect();
    const b = await client.call('see', {});
    expect(b.output).toHaveLength(10_000);
    expect(client.isConnected).toBe(true);
    await client.close();
  });

  // H5
  it('refuses only a request over 64 KB, says how to split it, and keeps the session', async () => {
    await start(
      helloThen((msg, socket) => reply(socket, msg.id, { ok: true, output: 'ok', target: '' })),
    );
    const client = new BridgeClient();
    await client.connect();
    await expect(client.call('type_text', { text: 'x'.repeat(70_000) })).rejects.toMatchObject({
      code: 'frame_too_large',
      message: expect.stringMatching(/split/i),
    });
    expect(client.isConnected).toBe(true);
    await expect(client.call('look', {})).resolves.toMatchObject({ ok: true });
    expect(sockets).toHaveLength(1);
    await client.close();
  });

  // M4
  it('decodes a multibyte character split across two chunks', async () => {
    await start(
      helloThen((msg, socket) => {
        const line = Buffer.from(
          JSON.stringify({ id: msg.id, result: { ok: true, output: 'año ñ', target: '' } }) + '\n',
        );
        const cut = line.indexOf(Buffer.from('ñ')) + 1;
        socket.write(line.subarray(0, cut));
        setTimeout(() => socket.write(line.subarray(cut)), 10);
      }),
    );
    const client = new BridgeClient();
    await expect(client.call('look', {})).resolves.toMatchObject({ output: 'año ñ' });
    await client.close();
  });

  // H7: Companion answers busy with no id and hangs up; "Socket closed" named neither cause nor way out.
  it('keeps the busy reason when Companion hangs up before hello, and names the way out', async () => {
    await start((_msg, socket) => {
      socket.end(JSON.stringify({ id: null, error: { code: 'busy', message: 'busy' } }) + '\n');
    });
    await expect(new BridgeClient().connect()).rejects.toMatchObject({
      code: 'busy',
      message: expect.stringMatching(/another .*session.*close/i),
    });
  });

  // H7
  it('keeps any other id-less reason as the code of the pending calls', async () => {
    await start(
      helloThen((_msg, socket) => {
        socket.end(
          JSON.stringify({ id: null, error: { code: 'cooling_down', message: 'wait' } }) + '\n',
        );
      }),
    );
    const client = new BridgeClient();
    await expect(client.call('click', { id: 1 })).rejects.toMatchObject({
      code: 'cooling_down',
      message: expect.stringContaining('wait'),
    });
  });

  // A frame that parses but is not an object used to throw inside the data listener and kill the shim.
  it.each(['null', '5', '[]', '"x"'])(
    'treats the frame %s as a bad frame, not a crash',
    async (frame) => {
      await start(helloThen((_msg, socket) => socket.write(frame + '\n')));
      const client = new BridgeClient();
      await expect(client.call('look', {})).rejects.toMatchObject({ code: 'bad_frame' });
      expect(client.isConnected).toBe(false);
    },
  );

  it('treats an error whose code is not a string as a bad frame', async () => {
    await start(
      helloThen((msg, socket) =>
        socket.write(JSON.stringify({ id: msg.id, error: 'nope' }) + '\n'),
      ),
    );
    const client = new BridgeClient();
    await expect(client.call('look', {})).rejects.toMatchObject({ code: 'bad_frame' });
  });

  it('caps a refusal message from Companion before it reaches the model', async () => {
    await start(
      helloThen((msg, socket) =>
        socket.write(
          JSON.stringify({
            id: msg.id,
            error: { code: 'invalid_args', message: 'm'.repeat(5000) },
          }) + '\n',
        ),
      ),
    );
    const client = new BridgeClient();
    const err = (await client.call('look', {}).catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ code: 'invalid_args' });
    expect(err.message.length).toBeLessThanOrEqual(300);
  });

  // H8: bye lets Companion free its only slot at once instead of waiting out the idle close.
  it('says bye to Companion before hanging up', async () => {
    const seen: string[] = [];
    await start((msg, socket) => {
      seen.push(msg.method);
      if (msg.method === 'hello') reply(socket, msg.id, HELLO_RESULT);
    });
    const client = new BridgeClient();
    await client.connect();
    await client.close();
    await vi.waitFor(() => expect(seen).toContain('bye'));
    expect(client.isConnected).toBe(false);
  });

  // connect() is still dialing when it returns, so a close() right after lands in that window.
  it('does not keep a connection that finishes after close was called', async () => {
    let hungUp!: Promise<void>;
    await start((msg, socket) => {
      if (msg.method === 'hello') reply(socket, msg.id, HELLO_RESULT);
    });
    server.on('connection', (socket: Socket) => {
      hungUp = new Promise((resolve) => socket.on('close', () => resolve()));
    });
    const client = new BridgeClient();
    const connecting = client.connect();
    await client.close();
    await expect(connecting).rejects.toMatchObject({ code: 'companion_unavailable' });
    expect(client.isConnected).toBe(false);
    await vi.waitFor(() => expect(hungUp).toBeDefined());
    await hungUp;
  });

  it('hangs up without bye when closed while hello is still pending', async () => {
    const seen: string[] = [];
    let hungUp!: Promise<void>;
    await start((msg, socket) => {
      seen.push(msg.method);
      hungUp ??= new Promise((resolve) => socket.on('close', () => resolve()));
    });
    const client = new BridgeClient();
    const connecting = client.connect();
    await vi.waitFor(() => expect(seen).toEqual(['hello']));
    await client.close();
    await expect(connecting).rejects.toMatchObject({ code: 'companion_unavailable' });
    await hungUp;
    expect(seen).toEqual(['hello']);
  });

  it('closes quietly when it never connected, and once when closed twice', async () => {
    await expect(new BridgeClient().close()).resolves.toBeUndefined();
    const seen: string[] = [];
    await start((msg, socket) => {
      seen.push(msg.method);
      if (msg.method === 'hello') reply(socket, msg.id, HELLO_RESULT);
    });
    const client = new BridgeClient();
    await client.connect();
    await client.close();
    await client.close();
    await vi.waitFor(() => expect(seen).toContain('bye'));
    expect(seen.filter((m) => m === 'bye')).toHaveLength(1);
  });

  it('connects again after close', async () => {
    await start(helloThen(() => undefined));
    const client = new BridgeClient();
    await client.connect();
    await client.close();
    await client.connect();
    expect(client.isConnected).toBe(true);
    expect(sockets).toHaveLength(2);
    await client.close();
  });

  // H3: after a denied or expired sheet Companion answers session_closed until the idle close.
  // A new hello asks again; the rejected call never ran, so sending it once more is safe.
  it.each(['session_closed', 'no_session'])(
    'asks Companion again once after %s and returns the retried result',
    async (code) => {
      const calls: number[] = [];
      await start(
        helloThen((msg, socket, connection) => {
          calls.push(connection);
          if (connection === 1) {
            socket.write(JSON.stringify({ id: msg.id, error: { code, message: 'closed' } }) + '\n');
          } else reply(socket, msg.id, { ok: true, output: 'again', target: '' });
        }),
      );
      const client = new BridgeClient();
      await expect(client.call('look', {})).resolves.toMatchObject({ output: 'again' });
      expect(calls).toEqual([1, 2]);
      await client.close();
    },
  );

  it('asks only once: a second session_closed reaches the agent', async () => {
    let callCount = 0;
    await start(
      helloThen((msg, socket) => {
        callCount += 1;
        socket.write(
          JSON.stringify({ id: msg.id, error: { code: 'session_closed', message: 'closed' } }) +
            '\n',
        );
      }),
    );
    const client = new BridgeClient();
    await expect(client.call('look', {})).rejects.toMatchObject({ code: 'session_closed' });
    expect(callCount).toBe(2);
    await client.close();
  });

  it('does not retry a call the user denied', async () => {
    let callCount = 0;
    await start(
      helloThen((msg, socket) => {
        callCount += 1;
        socket.write(
          JSON.stringify({ id: msg.id, error: { code: 'denied_by_user', message: 'no' } }) + '\n',
        );
      }),
    );
    const client = new BridgeClient();
    await expect(client.call('click', { id: 1 })).rejects.toMatchObject({ code: 'denied_by_user' });
    expect(callCount).toBe(1);
    await client.close();
  });

  // A session_closed that is not the reply to this call says nothing about whether it ran:
  // resending it could run a click or a type_text twice.
  it('never resends a call that was in flight when Companion hung up with session_closed', async () => {
    const frames: Array<{ connection: number; name?: string }> = [];
    await start(
      helloThen((msg, socket, connection) => {
        frames.push({ connection, name: msg.params?.name });
        socket.end(JSON.stringify({ error: { code: 'session_closed', message: 'x' } }) + '\n');
      }),
    );
    const client = new BridgeClient();
    await client.connect();
    await expect(client.call('click', { id: 7 })).rejects.toMatchObject({ code: 'session_closed' });
    expect(frames.filter((f) => f.name === 'click')).toHaveLength(1);
    await client.close();
  });

  it('resends the same arguments under a new id', async () => {
    const seen: Array<{ id: number; args: unknown }> = [];
    await start(
      helloThen((msg, socket, connection) => {
        seen.push({ id: msg.id, args: msg.params?.arguments });
        if (connection === 1) {
          socket.write(
            JSON.stringify({ id: msg.id, error: { code: 'session_closed', message: 'x' } }) + '\n',
          );
        } else reply(socket, msg.id, { ok: true, output: 'typed', target: '' });
      }),
    );
    const client = new BridgeClient();
    await client.call('type_text', { text: 'hola' });
    expect(seen.map((s) => s.args)).toEqual([{ text: 'hola' }, { text: 'hola' }]);
    expect(seen[0].id).not.toBe(seen[1].id);
    await client.close();
  });

  it('reports why the second try failed when Companion is gone by then', async () => {
    await start(
      helloThen((msg, socket) => {
        socket.write(
          JSON.stringify({ id: msg.id, error: { code: 'session_closed', message: 'x' } }) + '\n',
        );
        server.close();
      }),
    );
    const client = new BridgeClient();
    await expect(client.call('look', {})).rejects.toMatchObject({ code: 'companion_unavailable' });
  });

  // Right after the user said no, a new sheet on the agent's next call would nag; it waits.
  it('does not ask again right after the user denied', async () => {
    let calls = 0;
    await start(
      helloThen((msg, socket) => {
        calls += 1;
        const code = calls === 1 ? 'denied_by_user' : 'session_closed';
        socket.write(JSON.stringify({ id: msg.id, error: { code, message: 'x' } }) + '\n');
      }),
    );
    const client = new BridgeClient();
    await expect(client.call('click', { id: 1 })).rejects.toMatchObject({ code: 'denied_by_user' });
    await expect(client.call('click', { id: 1 })).rejects.toMatchObject({
      code: 'session_closed',
      message: expect.stringMatching(/said no.*ask the user/i),
    });
    expect(sockets).toHaveLength(1);
    await client.close();
  });

  it('asks again once the pause after a denial has passed', async () => {
    let calls = 0;
    await start(
      helloThen((msg, socket, connection) => {
        calls += 1;
        if (connection === 2) return reply(socket, msg.id, { ok: true, output: 'ok', target: '' });
        const code = calls === 1 ? 'denied_by_user' : 'session_closed';
        socket.write(JSON.stringify({ id: msg.id, error: { code, message: 'x' } }) + '\n');
      }),
    );
    const client = new BridgeClient({ reaskAfterDenialMs: 30 });
    await expect(client.call('click', { id: 1 })).rejects.toMatchObject({ code: 'denied_by_user' });
    await new Promise((r) => setTimeout(r, 60));
    await expect(client.call('click', { id: 1 })).resolves.toMatchObject({ output: 'ok' });
    await client.close();
  });

  it('starts the pause when the user denies the sheet the retry opened', async () => {
    let deniedOnce = false;
    await start(
      helloThen((msg, socket, connection) => {
        // The retry's sheet is the only one denied; after that the session stays closed.
        const code = connection === 2 && !deniedOnce ? 'denied_by_user' : 'session_closed';
        if (code === 'denied_by_user') deniedOnce = true;
        socket.write(JSON.stringify({ id: msg.id, error: { code, message: 'x' } }) + '\n');
      }),
    );
    const client = new BridgeClient();
    await expect(client.call('look', {})).rejects.toMatchObject({ code: 'denied_by_user' });
    await expect(client.call('look', {})).rejects.toMatchObject({ code: 'session_closed' });
    expect(sockets).toHaveLength(2);
    await client.close();
  });

  it('does not ask again right after Companion cooled down', async () => {
    let calls = 0;
    await start(
      helloThen((msg, socket) => {
        calls += 1;
        const code = calls === 1 ? 'cooling_down' : 'session_closed';
        socket.write(JSON.stringify({ id: msg.id, error: { code, message: 'x' } }) + '\n');
      }),
    );
    const client = new BridgeClient();
    await expect(client.call('look', {})).rejects.toMatchObject({ code: 'cooling_down' });
    await expect(client.call('look', {})).rejects.toMatchObject({ code: 'session_closed' });
    expect(sockets).toHaveLength(1);
    await client.close();
  });

  // H4: the browser actions open a per-call sheet like click does; a read timeout made the agent
  // resend a click or a type_text that still ran once the user approved. A tool Companion adds
  // later is held to the same, until the list says it only reads.
  it.each([
    'browser_click',
    'browser_type',
    'browser_select',
    'browser_navigate',
    'browser_open',
    'browser_take',
    'browser_release',
    'some_future_tool',
  ])('%s waits like an action and times out as approval_timeout', async (name) => {
    await start(
      helloThen((msg, socket) => {
        if (msg.params?.name === 'look') {
          return reply(socket, msg.id, { ok: true, output: '', target: '' });
        }
        if ((msg.params?.arguments as { late?: boolean } | undefined)?.late) return;
        setTimeout(() => reply(socket, msg.id, { ok: true, output: 'done', target: '' }), 90);
      }),
    );
    const client = new BridgeClient({ readTimeoutMs: 30, writeTimeoutMs: 200, sessionSheetMs: 0 });
    try {
      await client.call('look', {});
      await expect(client.call(name, {})).resolves.toMatchObject({ output: 'done' });
      const quick = new BridgeClient({ readTimeoutMs: 10, writeTimeoutMs: 30, sessionSheetMs: 0 });
      try {
        await expect(quick.call(name, { late: true })).rejects.toMatchObject({
          code: 'approval_timeout',
        });
      } finally {
        await quick.close();
      }
    } finally {
      await client.close();
    }
  });

  // The first call of a connection raises the session sheet before anything runs, read or not.
  it.each(['look', 'browser_click'])(
    'gives %s, as the first call after hello, the time of the session sheet',
    async (name) => {
      await start(
        helloThen((msg, socket) => {
          setTimeout(() => reply(socket, msg.id, { ok: true, output: 'x', target: '' }), 90);
        }),
      );
      const client = new BridgeClient({
        readTimeoutMs: 30,
        writeTimeoutMs: 30,
        sessionSheetMs: 150,
      });
      try {
        await expect(client.call(name, {})).resolves.toMatchObject({ ok: true });
        await expect(client.call(name, {})).rejects.toMatchObject({
          code: name === 'look' ? 'timeout' : 'approval_timeout',
        });
      } finally {
        await client.close();
      }
    },
  );

  it('gives the sheet time again after a reconnect, because Companion asks again', async () => {
    await start(
      helloThen((msg, socket) => {
        setTimeout(() => reply(socket, msg.id, { ok: true, output: 'x', target: '' }), 90);
      }),
    );
    const client = new BridgeClient({ readTimeoutMs: 30, sessionSheetMs: 150 });
    try {
      await client.call('look', {});
      sockets[0].destroy();
      await vi.waitFor(() => expect(client.isConnected).toBe(false));
      await expect(client.call('look', {})).resolves.toMatchObject({ ok: true });
      expect(sockets).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  // The call that raises the session sheet waits it out; the next one is sent after it, with its own time.
  it('gives the session sheet time to the call that raises it, and the next call its own time', async () => {
    let queue = Promise.resolve();
    await start(
      helloThen((msg, socket) => {
        queue = queue.then(
          () =>
            new Promise<void>((resolve) =>
              setTimeout(() => {
                reply(socket, msg.id, { ok: true, output: String(msg.id), target: '' });
                resolve();
              }, 90),
            ),
        );
      }),
    );
    const client = new BridgeClient({ readTimeoutMs: 30, sessionSheetMs: 250 });
    try {
      const [first, second] = await Promise.allSettled([
        client.call('look', {}),
        client.call('see', {}),
      ]);
      expect(first).toMatchObject({ status: 'fulfilled' });
      expect(second).toMatchObject({ status: 'rejected', reason: { code: 'timeout' } });
    } finally {
      await client.close();
    }
  });

  it('gives the retry after session_closed the time of the new session sheet', async () => {
    await start(
      helloThen((msg, socket, connection) => {
        if (connection === 1) {
          socket.write(
            JSON.stringify({ id: msg.id, error: { code: 'session_closed', message: 'x' } }) + '\n',
          );
        } else {
          setTimeout(() => reply(socket, msg.id, { ok: true, output: 'x', target: '' }), 90);
        }
      }),
    );
    const client = new BridgeClient({ readTimeoutMs: 30, sessionSheetMs: 150 });
    try {
      await expect(client.call('look', {})).resolves.toMatchObject({ ok: true });
    } finally {
      await client.close();
    }
  });

  it('spends the sheet time on the first call even when that call fails', async () => {
    await start(
      helloThen((msg, socket) => {
        // look answers after its own timeout, so see goes out on the same connection.
        const delay = msg.params?.name === 'see' ? 90 : 200;
        setTimeout(() => reply(socket, msg.id, { ok: true, output: 'x', target: '' }), delay);
      }),
    );
    // 30 + 100 ms would let the 90 ms reply through: only a spent allowance makes it time out.
    const client = new BridgeClient({ readTimeoutMs: 30, sessionSheetMs: 100 });
    try {
      await expect(client.call('look', {})).rejects.toMatchObject({ code: 'timeout' });
      await expect(client.call('see', {})).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      await client.close();
    }
  });

  // Companion serves one line at a time: a call sent behind a slow one waits there, so a timer that
  // starts on send expires while Companion has not even looked at it, and the call runs anyway.
  function serialCompanion(delays: Record<string, number>, seen: string[]): Handler {
    let queue = Promise.resolve();
    return helloThen((msg, socket) => {
      const name = String(msg.params?.name);
      queue = queue.then(
        () =>
          new Promise<void>((resolve) => {
            seen.push(`start ${name}`);
            setTimeout(() => {
              seen.push(`end ${name}`);
              reply(socket, msg.id, { ok: true, output: name, target: '' });
              resolve();
            }, delays[name] ?? 0);
          }),
      );
    });
  }

  it('sends a call only after the one before it settled, so its timer runs while Companion works on it', async () => {
    const seen: string[] = [];
    await start(serialCompanion({ click: 150, look: 10 }, seen));
    const client = new BridgeClient({ readTimeoutMs: 60, writeTimeoutMs: 400, sessionSheetMs: 0 });
    try {
      const both = await Promise.all([client.call('click', {}), client.call('look', {})]);
      expect(both.map((r) => r.output)).toEqual(['click', 'look']);
      expect(seen).toEqual(['start click', 'end click', 'start look', 'end look']);
    } finally {
      await client.close();
    }
  });

  it('still sends the next call when the one before it failed or timed out', async () => {
    await start(
      helloThen((msg, socket) => {
        if (msg.params?.name === 'see')
          reply(socket, msg.id, { ok: true, output: 'see', target: '' });
      }),
    );
    const client = new BridgeClient({ readTimeoutMs: 40, sessionSheetMs: 0, lateReplyCapMs: 60 });
    try {
      const [first, second] = await Promise.allSettled([
        client.call('look', {}),
        client.call('see', {}),
      ]);
      expect(first).toMatchObject({ status: 'rejected', reason: { code: 'timeout' } });
      expect(second).toMatchObject({ status: 'fulfilled', value: { output: 'see' } });
    } finally {
      await client.close();
    }
  });

  it('rejects a call still queued when it is closed, without connecting again', async () => {
    await start(helloThen(() => undefined));
    const client = new BridgeClient();
    await client.connect();
    const running = client.call('look', {}).catch((e: unknown) => e);
    const queued = client.call('see', {}).catch((e: unknown) => e);
    await client.close();
    expect(await running).toMatchObject({ code: 'companion_unavailable' });
    expect(await queued).toMatchObject({ code: 'companion_unavailable' });
    expect(sockets).toHaveLength(1);
    expect(client.isConnected).toBe(false);
  });
  // A timeout does not stop Companion: a call sent right after it would wait behind the old one.
  it('sends the next call only after Companion answered the one that timed out', async () => {
    const seen: string[] = [];
    await start(serialCompanion({ look: 120, see: 10 }, seen));
    const client = new BridgeClient({ readTimeoutMs: 40, sessionSheetMs: 0 });
    try {
      const [first, second] = await Promise.allSettled([
        client.call('look', {}),
        client.call('see', {}),
      ]);
      expect(first).toMatchObject({ status: 'rejected', reason: { code: 'timeout' } });
      expect(second).toMatchObject({ status: 'fulfilled', value: { output: 'see' } });
      expect(seen).toEqual(['start look', 'end look', 'start see', 'end see']);
    } finally {
      await client.close();
    }
  });

  it('moves to a new connection when the call that timed out is never answered', async () => {
    const frames: Array<{ connection: number; name?: string }> = [];
    await start(
      helloThen((msg, socket, connection) => {
        frames.push({ connection, name: msg.params?.name });
        if (connection > 1) reply(socket, msg.id, { ok: true, output: 'see', target: '' });
      }),
    );
    const client = new BridgeClient({ readTimeoutMs: 40, sessionSheetMs: 0, lateReplyCapMs: 80 });
    try {
      const [first, second] = await Promise.allSettled([
        client.call('look', {}),
        client.call('see', {}),
      ]);
      expect(first).toMatchObject({ status: 'rejected', reason: { code: 'timeout' } });
      expect(second).toMatchObject({ status: 'fulfilled' });
      expect(frames).toEqual([
        { connection: 1, name: 'look' },
        { connection: 2, name: 'see' },
      ]);
    } finally {
      await client.close();
    }
  });

  // The re-ask keeps its place: a type_text queued after a click must not overtake the click's retry.
  it('retries a call before sending the ones queued behind it', async () => {
    const frames: Array<{ connection: number; name?: string }> = [];
    await start(
      helloThen((msg, socket, connection) => {
        frames.push({ connection, name: msg.params?.name });
        if (connection === 1) {
          socket.write(
            JSON.stringify({ id: msg.id, error: { code: 'session_closed', message: 'x' } }) + '\n',
          );
        } else reply(socket, msg.id, { ok: true, output: String(msg.params?.name), target: '' });
      }),
    );
    const client = new BridgeClient({ sessionSheetMs: 0 });
    try {
      const both = await Promise.all([client.call('click', {}), client.call('type_text', {})]);
      expect(both.map((r) => r.output)).toEqual(['click', 'type_text']);
      expect(frames).toEqual([
        { connection: 1, name: 'click' },
        { connection: 2, name: 'click' },
        { connection: 2, name: 'type_text' },
      ]);
    } finally {
      await client.close();
    }
  });

  it('does not re-ask for a call queued behind one the user denied', async () => {
    await start(
      helloThen((msg, socket) => {
        const code = msg.params?.name === 'click' ? 'denied_by_user' : 'session_closed';
        socket.write(JSON.stringify({ id: msg.id, error: { code, message: 'x' } }) + '\n');
      }),
    );
    const client = new BridgeClient({ sessionSheetMs: 0 });
    try {
      const [first, second] = await Promise.allSettled([
        client.call('click', {}),
        client.call('type_text', {}),
      ]);
      expect(first).toMatchObject({ status: 'rejected', reason: { code: 'denied_by_user' } });
      expect(second).toMatchObject({ status: 'rejected', reason: { code: 'session_closed' } });
      expect(sockets).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it('keeps the line moving when Companion hangs up during a call', async () => {
    await start(
      helloThen((msg, socket, connection) => {
        if (connection === 1) socket.destroy();
        else reply(socket, msg.id, { ok: true, output: 'see', target: '' });
      }),
    );
    const client = new BridgeClient({ sessionSheetMs: 0 });
    try {
      const [first, second] = await Promise.allSettled([
        client.call('look', {}),
        client.call('see', {}),
      ]);
      expect(first).toMatchObject({
        status: 'rejected',
        reason: { code: 'companion_unavailable' },
      });
      expect(second).toMatchObject({ status: 'fulfilled', value: { output: 'see' } });
    } finally {
      await client.close();
    }
  });

  it('never sends a call the client cancelled while it waited in line', async () => {
    const seen: string[] = [];
    await start(serialCompanion({ look: 80 }, seen));
    const client = new BridgeClient({ readTimeoutMs: 500, sessionSheetMs: 0 });
    try {
      const abort = new AbortController();
      const running = client.call('look', {});
      const queued = client.call('see', {}, abort.signal).catch((e: unknown) => e);
      abort.abort();
      await running;
      expect(await queued).toMatchObject({ code: 'cancelled' });
      expect(seen).toEqual(['start look', 'end look']);
    } finally {
      await client.close();
    }
  });

  it('fails the call in flight with frame_too_large when its reply never ends under 64 KB', async () => {
    await start(helloThen((_msg, socket) => socket.write('x'.repeat(70_000))));
    const client = new BridgeClient({ sessionSheetMs: 0 });
    await expect(client.call('look', {})).rejects.toMatchObject({ code: 'frame_too_large' });
    expect(client.isConnected).toBe(false);
  });

  it('gives up at once on a call cancelled while it waits for a late reply', async () => {
    await start(helloThen(() => undefined));
    const client = new BridgeClient({
      readTimeoutMs: 40,
      sessionSheetMs: 0,
      lateReplyCapMs: 5_000,
    });
    try {
      const abort = new AbortController();
      const running = client.call('look', {}).catch((e: unknown) => e);
      const queued = client.call('see', {}, abort.signal).catch((e: unknown) => e);
      expect(await running).toMatchObject({ code: 'timeout' });
      const started = Date.now();
      abort.abort();
      expect(await queued).toMatchObject({ code: 'cancelled' });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await client.close();
    }
  });

  it('does not re-ask for a call that was cancelled while Companion had it', async () => {
    const frames: Array<{ connection: number; name?: string }> = [];
    const abort = new AbortController();
    await start(
      helloThen((msg, socket, connection) => {
        frames.push({ connection, name: msg.params?.name });
        abort.abort();
        socket.write(
          JSON.stringify({ id: msg.id, error: { code: 'session_closed', message: 'x' } }) + '\n',
        );
      }),
    );
    const client = new BridgeClient({ sessionSheetMs: 0 });
    try {
      await expect(client.call('click', {}, abort.signal)).rejects.toMatchObject({
        code: 'cancelled',
      });
      expect(frames).toEqual([{ connection: 1, name: 'click' }]);
    } finally {
      await client.close();
    }
  });
});
