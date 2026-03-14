import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import {
	createThread,
	deleteThread,
	getEntries,
	getThread,
	initDb,
	listThreads,
	touchThread,
	updateThread,
	upsertEntry,
} from "./src/db";
import index from "./src/index.html";
import {
	abortSession,
	createSession,
	getWarmedSessionId,
	init,
	onEvent,
	SCREENSHOT_DIR,
	sendMessage,
	shutdown,
} from "./src/opencode";

// ── Database ──

initDb();

// ── Session ↔ Thread mapping ──

const sessionToThread = new Map<string, string>();
const threadToSession = new Map<string, string>();

function linkSessionThread(sessionId: string, threadId: string) {
	sessionToThread.set(sessionId, threadId);
	threadToSession.set(threadId, sessionId);
}

// ── WebSocket client tracking ──

interface WsData {
	subscribedThreadId: string | null;
}

const clients = new Set<ServerWebSocket<WsData>>();

function broadcastToThread(threadId: string, data: unknown) {
	const json = JSON.stringify(data);
	for (const ws of clients) {
		if (ws.data?.subscribedThreadId === threadId) {
			ws.send(json);
		}
	}
}

// ── Server-side event → entry persistence ──

const userMessageIDs = new Set<string>();

function extractScreenshots(text: string): string[] {
	const pattern = /\.bun-browse\/screenshots\/([^\s]+\.png)/g;
	const matches: string[] = [];
	for (const match of text.matchAll(pattern)) {
		if (match[1]) matches.push(match[1]);
	}
	return matches;
}

function handleEventForPersistence(event: unknown) {
	const payload = ((event as Record<string, unknown>).payload ??
		event) as Record<string, unknown>;
	const type = payload.type as string;
	const properties = payload.properties as Record<string, unknown> | undefined;

	if (!type || !properties) return;

	// Determine which session this event belongs to.
	// sessionID lives directly on properties for session.* events,
	// but on properties.part for message.* events.
	const part =
		type === "message.part.updated" || type === "message.updated"
			? (properties.part as Record<string, unknown> | undefined)
			: undefined;
	const sessionId =
		(properties.sessionID as string | undefined) ??
		(part?.sessionID as string | undefined) ??
		((properties.info as Record<string, unknown> | undefined)?.sessionID as
			| string
			| undefined);
	const threadId = sessionId ? sessionToThread.get(sessionId) : undefined;

	switch (type) {
		case "message.updated": {
			const info = properties.info as Record<string, unknown> | undefined;
			if (info?.role === "user") {
				userMessageIDs.add(info.id as string);
			}
			break;
		}

		case "message.part.updated": {
			const msgPart = properties.part as Record<string, unknown>;
			if (userMessageIDs.has(msgPart.messageID as string)) break;

			if (threadId && (msgPart.type === "text" || msgPart.type === "tool")) {
				let entryData: unknown;

				if (msgPart.type === "text") {
					entryData = {
						type: "text",
						id: msgPart.id,
						text: msgPart.text,
					};
				} else {
					const state = msgPart.state as Record<string, unknown>;
					const input = state.input
						? typeof state.input === "string"
							? state.input
							: JSON.stringify(state.input, null, 2)
						: undefined;
					const output = state.output as string | undefined;
					const screenshots = output ? extractScreenshots(output) : [];

					entryData = {
						type: "tool",
						id: msgPart.id,
						tool: (state.title as string) ?? (msgPart.tool as string),
						status: state.status,
						input,
						output,
						screenshots,
					};
				}

				upsertEntry(threadId, {
					id: msgPart.id as string,
					type: msgPart.type as string,
					data: entryData,
				});
				touchThread(threadId);
			}
			break;
		}
	}

	// Broadcast to subscribed clients
	if (threadId) {
		broadcastToThread(threadId, event);
	}
}

// Relay OpenCode events through persistence + scoped broadcast
onEvent(handleEventForPersistence);

// Start OpenCode server
await init();

// ── Auto-title helper ──

function truncateAtWord(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	const truncated = text.slice(0, maxLen);
	const lastSpace = truncated.lastIndexOf(" ");
	return lastSpace > maxLen * 0.4
		? `${truncated.slice(0, lastSpace)}...`
		: `${truncated}...`;
}

// ── HTTP Server ──

const server = Bun.serve<WsData>({
	port: 3000,
	routes: {
		"/": index,
	},
	async fetch(req, server) {
		const url = new URL(req.url);

		// WebSocket upgrade
		if (url.pathname === "/ws") {
			const upgraded = server.upgrade(req, {
				data: { subscribedThreadId: null },
			});
			if (!upgraded) {
				return new Response("WebSocket upgrade failed", { status: 400 });
			}
			return undefined;
		}

		// ── Thread API ──

		if (url.pathname === "/api/threads" && req.method === "GET") {
			const threads = listThreads().map((t) => ({
				id: t.id,
				title: t.title,
				updatedAt: t.updated_at,
			}));
			return Response.json(threads);
		}

		if (url.pathname === "/api/threads" && req.method === "POST") {
			const body = (await req.json()) as { id: string; title?: string };
			const thread = createThread(body.id, body.title);
			return Response.json({ id: thread.id, title: thread.title });
		}

		const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
		if (threadMatch?.[1]) {
			const threadId = threadMatch[1];

			if (req.method === "GET") {
				const thread = getThread(threadId);
				if (!thread) {
					return new Response("Not found", { status: 404 });
				}
				const rows = getEntries(threadId);
				const entries = rows.map((r) => JSON.parse(r.data));
				return Response.json({
					id: thread.id,
					title: thread.title,
					updatedAt: thread.updated_at,
					entries,
				});
			}

			if (req.method === "DELETE") {
				deleteThread(threadId);
				return new Response(null, { status: 204 });
			}

			if (req.method === "PATCH") {
				const body = (await req.json()) as { title?: string };
				updateThread(threadId, body);
				return new Response(null, { status: 204 });
			}
		}

		// ── Session API ──

		if (url.pathname === "/api/session" && req.method === "POST") {
			const session = await createSession();
			return Response.json(session);
		}

		const messageMatch = url.pathname.match(
			/^\/api\/session\/([^/]+)\/message$/,
		);
		if (messageMatch?.[1] && req.method === "POST") {
			const sessionId = messageMatch[1];
			const body = (await req.json()) as {
				text: string;
				threadId?: string;
			};

			// Link session to thread and persist user message
			if (body.threadId) {
				linkSessionThread(sessionId, body.threadId);

				const entryId = `user-${Date.now()}`;
				const entryData = {
					type: "user" as const,
					id: entryId,
					text: body.text,
				};
				upsertEntry(body.threadId, {
					id: entryId,
					type: "user",
					data: entryData,
				});
				touchThread(body.threadId);

				// Auto-title on first user message
				const thread = getThread(body.threadId);
				if (thread?.title === "New thread") {
					const title = truncateAtWord(body.text, 60);
					updateThread(body.threadId, { title });

					await sendMessage(sessionId, body.text);
					return Response.json({ threadTitle: title });
				}
			}

			await sendMessage(sessionId, body.text);
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
		message(ws, msg) {
			try {
				const data = JSON.parse(msg as string) as Record<string, unknown>;
				if (data.type === "subscribe" && typeof data.threadId === "string") {
					ws.data.subscribedThreadId = data.threadId;

					// Send warmed session ID after subscription
					const warmedId = getWarmedSessionId();
					if (warmedId) {
						ws.send(
							JSON.stringify({
								type: "warmed_session",
								sessionId: warmedId,
							}),
						);
					}
				}
			} catch {
				// Ignore malformed messages
			}
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
