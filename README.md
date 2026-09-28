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

When Claude Code tries to use a tool, an approval sheet will appear in Companion. You can:

- **Permitir 1 h**: Allow Claude Code to act for 1 hour without additional approvals
- **Solo esta conexión**: Allow this single action only
- **No**: Deny

The approval sheet is the same one Companion uses for voice commands, and sensitive actions (destructive clicks, typing in command shells, opening URLs) always require approval.

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
- **Request timed out**: Write actions can take up to 2 minutes if waiting for user approval. Read actions timeout after 30 seconds.
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

The server attempts to connect to Companion on startup but doesn't block if it's unavailable. If Companion is not running or the setting is off, only `companion_status` is registered; it guides the user to enable the bridge and retries on each call.
