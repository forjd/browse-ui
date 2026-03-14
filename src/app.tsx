import {
	type FormEvent,
	useCallback,
	useEffect,
	useReducer,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ── Types ──

type TimelineEntry =
	| { type: "user"; id: string; text: string }
	| { type: "text"; id: string; text: string }
	| {
			type: "tool";
			id: string;
			tool: string;
			status: "pending" | "running" | "completed" | "error";
			input?: string;
			output?: string;
			screenshots: string[];
	  };

interface AppState {
	sessionId: string | null;
	status: "idle" | "busy" | "connecting";
	entries: TimelineEntry[];
}

type Action =
	| { type: "SET_SESSION"; sessionId: string }
	| { type: "SET_STATUS"; status: AppState["status"] }
	| { type: "ADD_USER_MESSAGE"; text: string }
	| { type: "UPSERT_TEXT"; id: string; text: string }
	| {
			type: "UPSERT_TOOL";
			id: string;
			tool: string;
			status: string;
			input?: string;
			output?: string;
			screenshots?: string[];
	  };

const SCREENSHOT_PATTERN = /\.bun-browse\/screenshots\/([^\s]+\.png)/g;

function extractScreenshots(text: string): string[] {
	const matches: string[] = [];
	for (const match of text.matchAll(SCREENSHOT_PATTERN)) {
		if (match[1]) matches.push(match[1]);
	}
	return matches;
}

function reducer(state: AppState, action: Action): AppState {
	switch (action.type) {
		case "SET_SESSION":
			return { ...state, sessionId: action.sessionId };

		case "SET_STATUS":
			return { ...state, status: action.status };

		case "ADD_USER_MESSAGE":
			return {
				...state,
				entries: [
					...state.entries,
					{
						type: "user",
						id: `user-${Date.now()}`,
						text: action.text,
					},
				],
			};

		case "UPSERT_TEXT": {
			const idx = state.entries.findIndex(
				(e) => e.type === "text" && e.id === action.id,
			);
			if (idx >= 0) {
				const entries = [...state.entries];
				entries[idx] = {
					...(entries[idx] as Extract<TimelineEntry, { type: "text" }>),
					text: action.text,
				};
				return { ...state, entries };
			}
			return {
				...state,
				entries: [
					...state.entries,
					{ type: "text", id: action.id, text: action.text },
				],
			};
		}

		case "UPSERT_TOOL": {
			const idx = state.entries.findIndex(
				(e) => e.type === "tool" && e.id === action.id,
			);
			const screenshots =
				action.screenshots ??
				(action.output ? extractScreenshots(action.output) : []);
			if (idx >= 0) {
				const entries = [...state.entries];
				const existing = entries[idx] as Extract<
					TimelineEntry,
					{ type: "tool" }
				>;
				entries[idx] = {
					...existing,
					status: action.status as
						| "pending"
						| "running"
						| "completed"
						| "error",
					input: action.input ?? existing.input,
					output: action.output ?? existing.output,
					screenshots:
						screenshots.length > 0 ? screenshots : existing.screenshots,
				};
				return { ...state, entries };
			}
			return {
				...state,
				entries: [
					...state.entries,
					{
						type: "tool",
						id: action.id,
						tool: action.tool,
						status: action.status as "pending",
						input: action.input,
						output: action.output,
						screenshots,
					},
				],
			};
		}

		default:
			return state;
	}
}

const initialState: AppState = {
	sessionId: null,
	status: "connecting",
	entries: [],
};

// ── WebSocket hook ──

function useWebSocket(dispatch: React.Dispatch<Action>) {
	const wsRef = useRef<WebSocket | null>(null);
	const retryRef = useRef(0);

	useEffect(() => {
		function connect() {
			const protocol = location.protocol === "https:" ? "wss:" : "ws:";
			const ws = new WebSocket(`${protocol}//${location.host}/ws`);
			wsRef.current = ws;

			ws.onopen = () => {
				retryRef.current = 0;
				dispatch({ type: "SET_STATUS", status: "idle" });
			};

			ws.onmessage = (evt) => {
				const event = JSON.parse(evt.data);
				// Handle pre-warmed session from server
				if (event.type === "warmed_session" && event.sessionId) {
					dispatch({
						type: "SET_SESSION",
						sessionId: event.sessionId,
					});
					return;
				}
				handleEvent(event, dispatch);
			};

			ws.onclose = () => {
				dispatch({ type: "SET_STATUS", status: "connecting" });
				const delay = Math.min(1000 * 2 ** retryRef.current, 10000);
				retryRef.current++;
				setTimeout(connect, delay);
			};
		}

		connect();
		return () => {
			wsRef.current?.close();
		};
	}, [dispatch]);
}

const userMessageIDs = new Set<string>();

function handleEvent(
	event: Record<string, unknown>,
	dispatch: React.Dispatch<Action>,
) {
	const payload = (event.payload ?? event) as Record<string, unknown>;
	const type = payload.type as string;
	const properties = payload.properties as Record<string, unknown> | undefined;

	if (!type || !properties) return;

	switch (type) {
		case "message.updated": {
			const info = properties.info as Record<string, unknown> | undefined;
			if (info?.role === "user") {
				userMessageIDs.add(info.id as string);
			}
			break;
		}

		case "message.part.updated": {
			const part = properties.part as Record<string, unknown>;

			// Skip parts belonging to user messages (already shown as chat bubbles)
			if (userMessageIDs.has(part.messageID as string)) break;

			if (part.type === "text") {
				dispatch({
					type: "UPSERT_TEXT",
					id: part.id as string,
					text: part.text as string,
				});
			} else if (part.type === "tool") {
				const state = part.state as Record<string, unknown>;
				const input = state.input
					? typeof state.input === "string"
						? state.input
						: JSON.stringify(state.input, null, 2)
					: undefined;
				const output = state.output as string | undefined;

				dispatch({
					type: "UPSERT_TOOL",
					id: part.id as string,
					tool: (state.title as string) ?? (part.tool as string),
					status: state.status as string,
					input,
					output,
				});
			}
			break;
		}

		case "session.status": {
			const status = properties.status as Record<string, unknown>;
			if (status.type === "busy") {
				dispatch({ type: "SET_STATUS", status: "busy" });
			} else if (status.type === "idle") {
				dispatch({ type: "SET_STATUS", status: "idle" });
			}
			break;
		}

		case "session.idle": {
			dispatch({ type: "SET_STATUS", status: "idle" });
			break;
		}
	}
}

// ── Components ──

function Header({ status }: { status: AppState["status"] }) {
	return (
		<header className="header">
			<div className={`status-dot ${status}`} />
			<h1>browse</h1>
			<span className="header-status">{status}</span>
		</header>
	);
}

function EmptyState() {
	return (
		<div className="empty-state">
			<div className="empty-state-icon">
				<span role="img" aria-label="compass">
					&#x27A4;
				</span>
			</div>
			<div className="empty-state-text">
				Tell the agent what to do in the browser
			</div>
			<div className="empty-state-hint">
				e.g. &ldquo;Check the pricing page on stripe.com&rdquo;
			</div>
		</div>
	);
}

function UserMessage({ text }: { text: string }) {
	return <div className="user-message">{text}</div>;
}

function TextEntry({ text }: { text: string }) {
	return (
		<div className="text-entry prose">
			<Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
		</div>
	);
}

function Screenshot({ src }: { src: string }) {
	const [lightbox, setLightbox] = useState(false);

	return (
		<>
			<button
				type="button"
				className="screenshot"
				onClick={() => setLightbox(true)}
			>
				<img src={src} alt="Browser screenshot" loading="lazy" />
			</button>

			{lightbox && (
				<button
					type="button"
					className="lightbox-overlay"
					onClick={() => setLightbox(false)}
					onKeyDown={(e) => e.key === "Escape" && setLightbox(false)}
				>
					<img
						src={src}
						alt="Browser screenshot (full size)"
						className="lightbox-image"
					/>
				</button>
			)}
		</>
	);
}

function ToolCard({
	entry,
}: {
	entry: Extract<TimelineEntry, { type: "tool" }>;
}) {
	const [expanded, setExpanded] = useState(false);

	return (
		<div className="tool-card">
			<button
				type="button"
				className="tool-card-header"
				onClick={() => setExpanded(!expanded)}
			>
				<span className={`tool-collapse-icon ${expanded ? "expanded" : ""}`}>
					&#x25B6;
				</span>
				<span className="tool-name">{entry.tool}</span>
				<span className={`tool-badge ${entry.status}`}>{entry.status}</span>
			</button>

			{expanded && (
				<div className="tool-card-body">
					{entry.input && <pre>{entry.input}</pre>}
					{entry.output && (
						<div className="tool-output">
							<pre>
								{entry.output.length > 2000
									? `${entry.output.slice(0, 2000)}…`
									: entry.output}
							</pre>
						</div>
					)}
				</div>
			)}

			{entry.screenshots.map((filename) => (
				<Screenshot key={filename} src={`/screenshots/${filename}`} />
			))}
		</div>
	);
}

function ThinkingIndicator() {
	return (
		<div className="thinking-indicator">
			<span className="thinking-dot" />
			<span className="thinking-dot" />
			<span className="thinking-dot" />
		</div>
	);
}

function Timeline({
	entries,
	busy,
}: {
	entries: TimelineEntry[];
	busy: boolean;
}) {
	const bottomRef = useRef<HTMLDivElement>(null);
	const count = entries.length;

	useEffect(() => {
		if (count > 0) {
			bottomRef.current?.scrollIntoView({ behavior: "smooth" });
		}
	}, [count]);

	useEffect(() => {
		if (busy) {
			bottomRef.current?.scrollIntoView({ behavior: "smooth" });
		}
	}, [busy]);

	return (
		<div className="timeline">
			{entries.length === 0 && !busy && <EmptyState />}
			{entries.map((entry) => {
				switch (entry.type) {
					case "user":
						return <UserMessage key={entry.id} text={entry.text} />;
					case "text":
						return <TextEntry key={entry.id} text={entry.text} />;
					case "tool":
						return <ToolCard key={entry.id} entry={entry} />;
					default:
						return null;
				}
			})}
			{busy && <ThinkingIndicator />}
			<div ref={bottomRef} />
		</div>
	);
}

function ChatInput({
	status,
	sessionId,
	dispatch,
}: {
	status: AppState["status"];
	sessionId: string | null;
	dispatch: React.Dispatch<Action>;
}) {
	const [text, setText] = useState("");
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const busy = status === "busy";

	const handleSubmit = useCallback(
		async (e?: FormEvent) => {
			e?.preventDefault();
			const trimmed = text.trim();
			if (!trimmed || busy) return;

			dispatch({ type: "ADD_USER_MESSAGE", text: trimmed });
			setText("");

			let sid = sessionId;
			if (!sid) {
				const res = await fetch("/api/session", { method: "POST" });
				const session = (await res.json()) as { id: string };
				sid = session.id;
				dispatch({ type: "SET_SESSION", sessionId: sid });
			}

			await fetch(`/api/session/${sid}/message`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text: trimmed }),
			});
		},
		[text, busy, sessionId, dispatch],
	);

	const handleAbort = useCallback(async () => {
		if (!sessionId) return;
		await fetch(`/api/session/${sessionId}/abort`, { method: "POST" });
	}, [sessionId]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				handleSubmit();
			}
		},
		[handleSubmit],
	);

	useEffect(() => {
		if (!busy) inputRef.current?.focus();
	}, [busy]);

	return (
		<div className="chat-input-container">
			<textarea
				ref={inputRef}
				className="chat-input"
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder="What should I do in the browser?"
				disabled={busy}
				rows={1}
			/>
			{busy ? (
				<button type="button" className="abort-btn" onClick={handleAbort}>
					Stop
				</button>
			) : (
				<button
					type="button"
					className="send-btn"
					disabled={!text.trim() || status === "connecting"}
					onClick={() => handleSubmit()}
				>
					Send
				</button>
			)}
		</div>
	);
}

// ── App ──

function App() {
	const [state, dispatch] = useReducer(reducer, initialState);

	useWebSocket(dispatch);

	return (
		<>
			<Header status={state.status} />
			<Timeline entries={state.entries} busy={state.status === "busy"} />
			<ChatInput
				status={state.status}
				sessionId={state.sessionId}
				dispatch={dispatch}
			/>
		</>
	);
}

// ── Mount ──

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<App />);
}
