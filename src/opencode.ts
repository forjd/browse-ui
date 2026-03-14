import { createOpencode } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk/client";

let client: OpencodeClient;
let serverHandle: { url: string; close(): void };
let warmedSessionId: string | null = null;

const SKILL_PATH = "/Users/dan/Projects/bun-browser/SKILL.md";
const SCREENSHOT_DIR = `${process.env.HOME}/.bun-browse/screenshots` as const;

const SCREENSHOT_PATTERN = /\.bun-browse\/screenshots\/([^\s]+\.png)/g;

type EventHandler = (event: unknown) => void;
const eventHandlers = new Set<EventHandler>();

export function onEvent(handler: EventHandler) {
	eventHandlers.add(handler);
	return () => {
		eventHandlers.delete(handler);
	};
}

export async function init() {
	const result = await createOpencode({
		config: {
			instructions: [SKILL_PATH],
			permission: {
				bash: "allow",
				edit: "allow",
				webfetch: "allow",
				doom_loop: "allow",
				external_directory: "allow",
			},
		},
	});
	client = result.client;
	serverHandle = result.server;

	// Subscribe to SSE events and relay to handlers
	const { stream } = await client.event.subscribe();
	(async () => {
		for await (const event of stream) {
			for (const handler of eventHandlers) {
				handler(event);
			}
		}
	})();

	console.log(`[opencode] server running at ${serverHandle.url}`);

	// Pre-warm a session so the first user prompt is instant
	try {
		const { data, error } = await client.session.create();
		if (!error && data) {
			warmedSessionId = data.id;
			console.log(`[opencode] pre-warmed session ${warmedSessionId}`);
		}
	} catch {
		// Non-fatal — session will be created on demand
	}
}

export async function createSession() {
	// Return pre-warmed session if available
	if (warmedSessionId) {
		const id = warmedSessionId;
		warmedSessionId = null;
		console.log(`[opencode] using pre-warmed session ${id}`);
		return { id };
	}

	const { data, error } = await client.session.create();
	if (error)
		throw new Error(`Failed to create session: ${JSON.stringify(error)}`);
	return data;
}

export async function sendMessage(sessionId: string, text: string) {
	const { error } = await client.session.promptAsync({
		path: { id: sessionId },
		body: {
			parts: [{ type: "text", text }],
		},
	});
	if (error)
		throw new Error(`Failed to send message: ${JSON.stringify(error)}`);
}

export async function abortSession(sessionId: string) {
	const { data, error } = await client.session.abort({
		path: { id: sessionId },
	});
	if (error)
		throw new Error(`Failed to abort session: ${JSON.stringify(error)}`);
	return data;
}

export function extractScreenshots(output: string): string[] {
	const matches: string[] = [];
	for (const match of output.matchAll(SCREENSHOT_PATTERN)) {
		if (match[1]) matches.push(match[1]);
	}
	return matches;
}

export function getWarmedSessionId() {
	return warmedSessionId;
}

export { SCREENSHOT_DIR };

export function shutdown() {
	serverHandle?.close();
}
