import { fileURLToPath } from "node:url";
import { createOpencode } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk/client";

let client: OpencodeClient;
let serverHandle: { url: string; close(): void };
let warmedSessionId: string | null = null;

const DEFAULT_SKILL_PATH = fileURLToPath(
	new URL("../SKILL.md", import.meta.url),
);
const SKILL_PATH = process.env.BROWSE_UI_SKILL_PATH || DEFAULT_SKILL_PATH;
const SCREENSHOT_DIR = `${process.env.HOME}/.bun-browse/screenshots` as const;

const SCREENSHOT_PATTERN = /\.bun-browse\/screenshots\/([^\s]+\.png)/g;
const SCREENSHOT_INTENT_PATTERNS = [
	/\bshow me\b/i,
	/\blet me see\b/i,
	/\bwhat does .+ look like\b/i,
	/\btake a look\b/i,
	/\bvisual check\b/i,
];
const SCREENSHOT_PROMPT_NOTE =
	"\n\nSystem note: The user is asking for a visual result. You must take at least one `browse screenshot` after the relevant page loads so the UI can render it. A text-only snapshot is not enough unless the page fails to load.";

type EventHandler = (event: unknown) => void;
const eventHandlers = new Set<EventHandler>();

function parseModelSelection(model: string) {
	const separator = model.indexOf("/");
	if (separator <= 0 || separator === model.length - 1) return undefined;
	return {
		providerID: model.slice(0, separator),
		modelID: model.slice(separator + 1),
	};
}

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

export async function sendMessage(
	sessionId: string,
	text: string,
	model?: string,
	variant?: string,
) {
	const body: {
		parts: Array<{ type: "text"; text: string }>;
		model?: { providerID: string; modelID: string };
		variant?: string;
	} = {
		parts: [{ type: "text", text: preparePromptText(text) }],
	};

	const selection = model ? parseModelSelection(model) : undefined;
	if (selection) body.model = selection;
	if (variant) body.variant = variant;

	const { error } = await client.session.promptAsync({
		path: { id: sessionId },
		body,
	});
	if (error)
		throw new Error(`Failed to send message: ${JSON.stringify(error)}`);
}

export function requiresScreenshot(text: string) {
	return SCREENSHOT_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

export function preparePromptText(text: string) {
	if (!requiresScreenshot(text)) return text;
	return `${text}${SCREENSHOT_PROMPT_NOTE}`;
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

export function getClient() {
	return client;
}

export function shutdown() {
	serverHandle?.close();
}
