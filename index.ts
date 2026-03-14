import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import index from "./src/index.html";
import {
	abortSession,
	createSession,
	init,
	onEvent,
	SCREENSHOT_DIR,
	sendMessage,
	shutdown,
} from "./src/opencode";

const clients = new Set<ServerWebSocket<unknown>>();

function broadcast(data: unknown) {
	const json = JSON.stringify(data);
	for (const ws of clients) {
		ws.send(json);
	}
}

// Relay OpenCode events to all WS clients
onEvent((event: unknown) => {
	broadcast(event);
});

// Start OpenCode server
await init();

const server = Bun.serve({
	port: 3000,
	routes: {
		"/": index,
	},
	async fetch(req, server) {
		const url = new URL(req.url);

		// WebSocket upgrade
		if (url.pathname === "/ws") {
			const upgraded = server.upgrade(req);
			if (!upgraded) {
				return new Response("WebSocket upgrade failed", { status: 400 });
			}
			return undefined;
		}

		// REST API
		if (url.pathname === "/api/session" && req.method === "POST") {
			const session = await createSession();
			return Response.json(session);
		}

		const messageMatch = url.pathname.match(
			/^\/api\/session\/([^/]+)\/message$/,
		);
		if (messageMatch?.[1] && req.method === "POST") {
			const body = (await req.json()) as { text: string };
			await sendMessage(messageMatch[1], body.text);
			return new Response(null, { status: 204 });
		}

		const abortMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/abort$/);
		if (abortMatch?.[1] && req.method === "POST") {
			const result = await abortSession(abortMatch[1]);
			return Response.json({ aborted: result });
		}

		// Screenshot serving
		if (url.pathname.startsWith("/screenshots/")) {
			const filename = url.pathname.slice("/screenshots/".length);
			const filePath = join(SCREENSHOT_DIR, filename);
			try {
				const data = await readFile(filePath);
				return new Response(data, {
					headers: { "Content-Type": "image/png" },
				});
			} catch {
				return new Response("Not found", { status: 404 });
			}
		}

		return new Response("Not found", { status: 404 });
	},

	websocket: {
		open(ws) {
			clients.add(ws);
		},
		close(ws) {
			clients.delete(ws);
		},
		message() {
			// Client-to-server WS messages not used in MVP
		},
	},
});

console.log(`[browse-ui] listening on http://localhost:${server.port}`);

// Graceful shutdown
process.on("SIGINT", () => {
	shutdown();
	process.exit(0);
});
process.on("SIGTERM", () => {
	shutdown();
	process.exit(0);
});
