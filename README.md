# browse-ui

A web interface for agentic browser automation. Chat-style input, visual timeline output.

![preview](preview.png)

## What is this?

A Bun-powered web app that lets you give natural language instructions to an AI agent that controls a real browser via [browse](https://github.com/forjd/browse). Think ChatGPT, but it actually goes and does things on the web.

**Examples:**

- "Research the latest pricing for Vercel, Netlify, and Cloudflare Pages and compare them"
- "Go to staging.example.com, log in, and test the checkout flow"
- "Run through the signup form and check for accessibility issues"
- "QA the landing page on mobile and desktop viewports"

## How it works

```
┌──────────────────────────────────┐
│  Web UI                          │
│  - Chat input                    │
│  - Action timeline + screenshots │
├──────────────────────────────────┤
│  OpenCode (agent + LLM)         │
│  - Interprets user intent        │
│  - Decides which browse commands │
│  - Loops until task is complete  │
├──────────────────────────────────┤
│  browse CLI → daemon → Playwright│
│  - Navigates, clicks, fills      │
│  - Takes screenshots             │
│  - Reads page content            │
└──────────────────────────────────┘
```

1. You type a prompt in the web UI
2. The prompt is sent to an OpenCode session via the SDK
3. OpenCode's agent calls `browse` commands through its bash tool, guided by the browse skill
4. Each action (navigation, click, screenshot, etc.) streams back to the UI as it happens
5. The UI renders a visual timeline: screenshots, summaries, and status updates

## Tech stack

- **Runtime:** Bun
- **Backend:** `Bun.serve()` with WebSocket for live updates
- **Frontend:** React, served via Bun HTML imports
- **Agent:** OpenCode SDK — manages sessions, tool calling, and event streaming
- **Browser automation:** browse (Playwright wrapper with persistent daemon)

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [browse](https://github.com/forjd/browse) installed and on PATH
- [OpenCode](https://opencode.ai) installed and configured with an LLM provider

## Development

```bash
bun install
bun run dev
```

## Status

Early development. Not yet functional.
