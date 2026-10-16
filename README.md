# companion-mcp

Local stdio MCP server that bridges Claude Code to Companion over a Unix domain socket.

## What It Is

This MCP server connects Claude Code to the Companion app on macOS, allowing Claude Code to:

- See what's on your screen (`look`, `see`, `read_focused`)
- Click buttons and elements (`click`)
- Type text and press keys (`type_text`, `press_key`)
- Scroll, open apps, and interact with your Mac directly

Companion acts as the gatekeeper: every action opens an approval sheet on the Mac. You control when and what Claude Code can do.

## Install

```bash
pnpm install && pnpm build
```

## Register with Claude Code

Add the MCP server to your Claude Code configuration:

```bash
claude mcp add companion -- node /Users/karenrebecaog/Desktop/SoftwareDevProjects/companion-mcp/dist/index.js
```

This registers the server in user scope (not project scope).

## Enable in Companion

Before using, enable the bridge in Companion:

1. Open **Companion**
2. Go to **Ajustes** (Settings)
3. Navigate to **Agentes** (Agents)
4. Enable the toggle **"Prestar las manos a otros agentes"** (Allow other agents to control my hands)

When Claude Code tries to use a tool, a sheet appears in Companion asking to use the Mac for this connection. The sheet for the connection is never remembered: each new connection asks again. Sensitive actions (destructive clicks, typing in command shells, opening URLs) ask on their own sheet each time.

## QA mode

Companion has a second, volatile switch under Ajustes > Privacidad, below "Prestar las manos": **Modo QA**. It starts off, lives in memory (it dies when Companion closes) and needs Touch ID or the system password to be available. With it on, Claude Code gets `companion_ask` and `companion_wait_turn` (type a turn into the conversation, then wait for it to end) and the actions it takes skip the per-action sheet: what is not critical acts directly, and anything critical (terminal, shell, deleting, overwriting) asks the user for Touch ID at that moment.

The risk, in one sentence: while it is on and the session sheet is approved, any process of the same user that can read `bridge.token` can talk to Companion as if it were you and read its replies and tool output, with no sheet; only critical actions still need your finger.

- `companion_ask { text, conversation?, as_user_words?, wait_seconds? }` starts a turn and waits up to `wait_seconds` (max 100). A status of `awaiting_owner` means a Touch ID dialog is on screen: tell the user to touch the sensor, then call `companion_wait_turn { turn_id }`.
- `companion_wait_turn` is read-only and may block up to 130 s; the shim gives it that time instead of the 30 s read limit.

## Environment Override

For testing, you can override the socket and token paths:

```bash
export COMPANION_BRIDGE_DIR=/path/to/bridge/dir
```

The server looks for `bridge.sock` and `bridge.token` in that directory.

## Security Notes

- **Socket**: Located at `~/Library/Application Support/Companion/bridge/bridge.sock`, created with 0600 permissions. Only the user can connect.
- **Token**: `~/Library/Application Support/Companion/bridge/bridge.token`, regenerated on every Companion launch, never persisted beyond the session.
- **One session at a time**: Only one Claude Code session can control the bridge. If a second connection attempts to connect, it receives a `busy` error.
- **Rate limit**: Maximum 30 write actions (click, type_text, press_key, scroll, menu, open_app, open_url, open_file) per minute. Read actions (look, see, read_focused, list_apps) are unlimited.
- **Logs**: Only tool names and error codes are logged; never argument values or screen output.
- **No text in logs**: The bridge never writes screen content to stderr, even in error cases.

## How to Use

In a Claude Code session:

1. Call `open_app` first to pin the app you want to control (e.g., `open_app("Safari")`)
2. Call `look` to see numbered elements on the screen
3. Call `click` with the element ID to click it
4. Call `type_text` to type, `scroll` to scroll, etc.
5. Each `look` call refreshes the element IDs; old IDs expire

Example flow:

```
→ open_app("Safari")
→ look
← "1. Permitir – button\n2. URL bar – textbox\n..."
→ click({"id": 1})  # Clicks the "Permitir" button
← "Clicked button. Permission granted."
```

Results show what's on screen as text: the tool descriptions declare this as data, not instructions, so Claude Code won't try to interpret it.

## Troubleshooting

- **Companion is not reachable**: Make sure Companion is running and the "Prestar las manos" setting is enabled. Run the `companion_status` tool to check.
- **Busy**: Another Claude Code session is already using the bridge. Disconnect it or wait a moment.
- **Request timed out**: Write actions can take up to 2 minutes if waiting for user approval. Read actions timeout after 30 seconds, except `companion_wait_turn`, which waits up to 130 seconds.
- **Element ID has expired** (`stale_id`): Call `look` again to refresh element IDs.

## Testing

```bash
pnpm test
```

Tests use a fake JSONL server on a temporary Unix socket to simulate Companion without needing the app.

## Verify

```bash
pnpm verify
```

Runs type check, linting, format check, and tests.

## Architecture

- `src/bridge/paths.ts`: Resolves socket/token paths
- `src/bridge/client.ts`: JSONL client with token auth, framing, and timeout handling
- `src/server.ts`: MCP server registration; dynamically registers tools from Companion
- `src/core/tool-result.ts`: Result formatting helpers
- `src/index.ts`: stdio entry point

The server attempts to connect to Companion on startup but doesn't block if it's unavailable. If Companion is not running or the setting is off, only `companion_status` is registered; it reports that Companion is unreachable and how to enable the bridge, but it does not retry the connection. Companion's tools are registered only by that startup attempt, so after opening Companion, reconnect the server (in Claude Code: `/mcp`).

If Companion closes after its tools were registered, the next call tries to reconnect and fails with `error[companion_unavailable]`, which says to open Companion itself (`open_app` cannot start it: it runs inside Companion). A bridge file this process may not open fails with `error[permission_required]` instead.
