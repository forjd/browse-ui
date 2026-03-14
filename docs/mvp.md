# browse-ui MVP Plan

## Overview

A web app where you type a natural language prompt and an AI agent goes and does it in a real browser. The agent uses [browse](https://github.com/forjd/browse) (a Playwright CLI wrapper) to navigate, interact, screenshot, and report back — all streamed live to a timeline UI.

## Architecture

```
┌──────────────────────────────────────────┐
│  Browser (React SPA)                     │
│  - Chat input                            │
│  - Streaming timeline with screenshots   │
│                    ▲                     │
│                    │ WebSocket            │
├────────────────────┼─────────────────────┤
│  Bun.serve()       │                     │
│  - REST API        │                     │
│  - WS relay    ◄───┘                     │
│  - Screenshot serving                    │
│         │                                │
│         ▼                                │
│  OpenCode SDK (SSE subscription)         │
│  - Session management                    │
│  - Event streaming                       │
│  - Permission handling                   │
├──────────────────────────────────────────┤
│  opencode serve (child process)          │
│  - LLM agent loop                        │
│  - bash tool → browse CLI                │
│  - Reads SKILL.md for browse usage       │
├──────────────────────────────────────────┤
│  browse daemon (Unix socket)             │
│  - Persistent Chromium instance          │
│  - 35 commands, ~30ms warm latency       │
└──────────────────────────────────────────┘
```

### Data flow

1. User types prompt in the web UI
2. Frontend `POST /api/session/:id/message` with the text
3. Backend forwards to OpenCode via `session.promptAsync()`
4. OpenCode's agent decides which `browse` commands to run via its bash tool
5. OpenCode streams events via SSE (`message.part.updated`, `session.status`, etc.)
6. Backend relays each event to the frontend over WebSocket
7. Frontend renders events in a timeline: text, tool calls, screenshots

## OpenCode Integration

### Server lifecycle

The SDK's `createOpencode()` spawns `opencode serve` as a child process and returns a connected client. The server exposes an HTTP API with SSE event streaming. Config is passed via the `OPENCODE_CONFIG_CONTENT` env var (the SDK handles this automatically). Default port is `0` (OS-assigned); the SDK parses stdout for the actual URL.

```ts
import { createOpencode } from "@opencode-ai/sdk"

const { client, server } = await createOpencode({
  config: {
    instructions: ["/Users/dan/Projects/bun-browser/SKILL.md"],
    permission: {
      bash: "allow",
      edit: "allow",
      webfetch: "allow",
      doom_loop: "allow",
      external_directory: "allow",
    },
  },
})
```

**Note:** `event.subscribe()` returns `Promise<{ stream: AsyncGenerator }>`:

```ts
const { stream } = await client.event.subscribe()
for await (const event of stream) {
  // handle event
}
```

### Key SDK methods

| Method | Purpose |
|--------|---------|
| `session.create()` | Create a new conversation session |
| `session.promptAsync()` | Send a message, return immediately (fire-and-forget) |
| `session.prompt()` | Send a message, wait for full response (blocking) |
| `session.abort()` | Cancel an in-progress session |
| `event.subscribe()` | SSE stream of all events |

### Event types we care about

| Event | Use |
|-------|-----|
| `message.part.updated` (TextPart) | Streaming agent text, render in timeline |
| `message.part.updated` (ToolPart) | Browse command execution with state transitions |
| `session.status` | Toggle busy/idle indicator |
| `session.idle` | Agent finished, re-enable input |
| `permission.updated` | Tool permission request (auto-approve for MVP) |

### Tool state machine

Tool calls arrive as `message.part.updated` events with a `ToolPart` containing a `ToolState` discriminated union:

```
pending → running → completed
                  → error
```

Each state update arrives as a separate event with the same part ID. The frontend upserts timeline entries by part ID.

### Permission handling

OpenCode requires permission approval for tool execution. For the MVP, configure auto-approval in `.opencode.json` for each tool type:

```json
{
  "permission": {
    "bash": "allow",
    "edit": "allow",
    "webfetch": "allow",
    "doom_loop": "allow",
    "external_directory": "allow"
  }
}
```

As a fallback, the backend can programmatically approve via the SDK:

```ts
client.postSessionIdPermissionsPermissionId({
  path: { id: sessionId, permissionID: permission.id },
  body: { response: "always" },
})
```

### Screenshot detection

Browse saves screenshots to `~/.bun-browse/screenshots/`. When a `tool_completed` event arrives, parse the output for screenshot paths:

```ts
const screenshotPattern = /\/\.bun-browse\/screenshots\/([^\s]+\.png)/g
```

Emit supplementary screenshot events so the frontend can render them inline.

## Backend — `index.ts`

`Bun.serve()` with three concerns:

### 1. REST API

| Route | Method | Purpose |
|-------|--------|---------|
| `/` | GET | Serve the React SPA (Bun HTML import) |
| `/api/session` | POST | Create a new OpenCode session |
| `/api/session/:id/message` | POST | Send a user message to the session |
| `/api/session/:id/abort` | POST | Abort the current agent run |
| `/screenshots/*` | GET | Serve screenshot files from `~/.bun-browse/screenshots/` |

### 2. WebSocket relay

- Upgrade requests on `/ws`
- Maintain a `Set<ServerWebSocket>` of connected clients
- On OpenCode SSE event: `JSON.stringify()` and broadcast to all clients

### 3. OpenCode lifecycle

- Spawn OpenCode server on startup
- Subscribe to events and relay to WebSocket clients
- Graceful shutdown: abort active sessions, kill child process

## Frontend — `src/app.tsx`

Single-file React app for the MVP. Bun HTML imports handle bundling.

### Component tree

```
App
  Header         — status dot (green=idle, amber=busy), title
  Timeline       — scrollable list of entries, auto-scrolls to bottom
    UserMessage   — user's prompt text
    TextEntry     — streaming agent text (assembled from deltas)
    ToolCard      — browse command with status badge + expandable I/O
      Screenshot  — inline <img> when screenshots detected
  ChatInput      — text input + send button, disabled while busy
```

### State

Single `useReducer` managing:

```ts
interface AppState {
  sessionId: string | null
  status: "idle" | "busy" | "connecting"
  entries: TimelineEntry[]
}

type TimelineEntry =
  | { type: "user"; text: string }
  | { type: "text"; id: string; text: string }
  | { type: "tool"; id: string; tool: string; status: string; input?: unknown; output?: string; screenshots: string[] }
```

### WebSocket hook

- Connect to `ws://localhost:3000/ws` on mount
- Parse JSON events and dispatch to reducer
- Text events: upsert by part ID, append delta text
- Tool events: upsert by part ID, update status/input/output
- Session events: update status indicator
- Reconnect on close with exponential backoff

### Screenshot rendering

When a tool entry's output contains screenshot paths, extract filenames and render:

```tsx
<img src={`/screenshots/${filename}`} alt="Browser screenshot" />
```

## Styles — `src/styles.css`

Minimal dark theme, no framework.

- Full viewport flexbox column layout
- Header: fixed top, status indicator
- Timeline: scrollable middle, `overflow-y: auto`
- Chat input: fixed bottom
- Dark palette: `#0d1117` background, `#e6edf3` text, `#58a6ff` accent

## File layout

```
browse-ui/
  index.ts              # Bun.serve() entry point
  .opencode.json        # OpenCode config (permissions, model, instructions)
  src/
    opencode.ts         # OpenCode server lifecycle + SDK wrapper
    index.html          # HTML entry (imports app.tsx + styles.css)
    app.tsx             # React SPA (all components)
    styles.css          # Dark theme styles
  docs/
    mvp.md              # This file
```

## Dependencies to add

```bash
bun add @opencode-ai/sdk react react-dom
bun add -d @types/react @types/react-dom
```

## Config — `.opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "bash": "allow",
    "edit": "allow",
    "webfetch": "allow",
    "doom_loop": "allow",
    "external_directory": "allow"
  },
  "instructions": [
    "/Users/dan/Projects/bun-browser/SKILL.md"
  ]
}
```

## MVP scope

### In scope

- Single session per page load
- Chat input → agent → browse commands → screenshots in timeline
- Streaming text and tool call status updates
- Inline screenshot rendering
- Session status indicator (idle/busy)
- Abort button

### Out of scope (future)

- Multi-session / session history
- Model picker
- Web UI authentication
- Live Playwright viewport (CDP screencast)
- Persistent chat history across refreshes
- Mobile-responsive design
- Error recovery UI (retry failed sessions)

## Verification

1. `bun run dev` starts without errors, frontend loads at `http://localhost:3000`
2. OpenCode server spawns as child process
3. Typing a prompt creates a session and sends a message
4. WebSocket receives streaming events
5. Timeline shows agent text appearing incrementally
6. Tool cards show status transitions (pending → running → completed)
7. Browse commands execute (e.g. `browse goto https://example.com`)
8. Screenshots render inline in the timeline
9. Status indicator toggles between idle and busy
10. No permission prompts block execution

## Risks

| Risk | Mitigation |
|------|------------|
| OpenCode `serve` port collision | Use port `0` (OS picks), parse stdout for actual URL |
| SSE stream disconnects | Retry loop with backoff in the event subscription |
| Large tool outputs (browse snapshot) | Truncate display, expandable toggle |
| Screenshot path parsing | Robust regex, graceful fallback if not found |
| OpenCode config `instructions` path | Use absolute path to SKILL.md |
