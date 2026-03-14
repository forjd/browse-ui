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
	| { type: "user"; id: string; text: string; timestamp: number }
	| { type: "text"; id: string; text: string; timestamp: number }
	| {
			type: "tool";
			id: string;
			tool: string;
			status: "pending" | "running" | "completed" | "error";
			input?: string;
			output?: string;
			screenshots: string[];
			timestamp: number;
	  };

interface ThreadSummary {
	id: string;
	title: string;
	updatedAt: number;
}

interface AppState {
	activeThreadId: string | null;
	threads: ThreadSummary[];
	sessionId: string | null;
	status: "idle" | "busy" | "connecting";
	entries: TimelineEntry[];
	sidebarOpen: boolean;
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
	  }
	| { type: "SET_THREADS"; threads: ThreadSummary[] }
	| {
			type: "SET_ACTIVE_THREAD";
			threadId: string;
			entries: TimelineEntry[];
	  }
	| { type: "ADD_THREAD"; thread: ThreadSummary }
	| { type: "REMOVE_THREAD"; threadId: string }
	| { type: "UPDATE_THREAD_TITLE"; threadId: string; title: string }
	| { type: "TOGGLE_SIDEBAR" };

// ── Settings ──

interface Settings {
	fontSize: number;
	showTimestamps: boolean;
	autoExpandTools: boolean;
	messageWidth: "compact" | "default" | "wide";
}

const DEFAULT_SETTINGS: Settings = {
	fontSize: 14,
	showTimestamps: true,
	autoExpandTools: false,
	messageWidth: "default",
};

function loadSettings(): Settings {
	try {
		const stored = localStorage.getItem("browse-ui-settings");
		if (stored) return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
	} catch {
		// ignore
	}
	return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings: Settings) {
	localStorage.setItem("browse-ui-settings", JSON.stringify(settings));
}

interface ProviderModel {
	id: string;
	name: string;
	providerId: string;
	providerName: string;
}

const SCREENSHOT_PATTERN = /\.bun-browse\/screenshots\/([^\s]+\.png)/g;
const SCREENSHOT_MD_IMAGE = /!\[[^\]]*\]\([^)]*?screenshot-[^\s)]+\.png\)\n?/g;

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
						timestamp: Date.now(),
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
					{
						type: "text",
						id: action.id,
						text: action.text,
						timestamp: Date.now(),
					},
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
					tool: action.tool || existing.tool,
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
						timestamp: Date.now(),
					},
				],
			};
		}

		case "SET_THREADS":
			return { ...state, threads: action.threads };

		case "SET_ACTIVE_THREAD":
			return {
				...state,
				activeThreadId: action.threadId,
				entries: action.entries,
				sessionId: null,
			};

		case "ADD_THREAD":
			return {
				...state,
				threads: [action.thread, ...state.threads],
			};

		case "REMOVE_THREAD": {
			const threads = state.threads.filter((t) => t.id !== action.threadId);
			if (state.activeThreadId === action.threadId) {
				return {
					...state,
					threads,
					activeThreadId: threads[0]?.id ?? null,
					entries: [],
					sessionId: null,
				};
			}
			return { ...state, threads };
		}

		case "UPDATE_THREAD_TITLE":
			return {
				...state,
				threads: state.threads.map((t) =>
					t.id === action.threadId ? { ...t, title: action.title } : t,
				),
			};

		case "TOGGLE_SIDEBAR":
			return { ...state, sidebarOpen: !state.sidebarOpen };

		default:
			return state;
	}
}

const initialState: AppState = {
	activeThreadId: null,
	threads: [],
	sessionId: null,
	status: "connecting",
	entries: [],
	sidebarOpen: false,
};

// ── WebSocket hook ──

function useWebSocket(
	dispatch: React.Dispatch<Action>,
	activeThreadId: string | null,
) {
	const wsRef = useRef<WebSocket | null>(null);
	const retryRef = useRef(0);
	const threadIdRef = useRef(activeThreadId);
	threadIdRef.current = activeThreadId;

	useEffect(() => {
		function subscribe(ws: WebSocket) {
			const tid = threadIdRef.current;
			if (ws.readyState === WebSocket.OPEN && tid) {
				ws.send(JSON.stringify({ type: "subscribe", threadId: tid }));
			}
		}

		function connect() {
			const protocol = location.protocol === "https:" ? "wss:" : "ws:";
			const ws = new WebSocket(`${protocol}//${location.host}/ws`);
			wsRef.current = ws;

			ws.onopen = () => {
				retryRef.current = 0;
				dispatch({ type: "SET_STATUS", status: "idle" });
				subscribe(ws);
			};

			ws.onmessage = (evt) => {
				const event = JSON.parse(evt.data);
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

	// Subscribe when active thread changes
	useEffect(() => {
		const ws = wsRef.current;
		if (ws?.readyState === WebSocket.OPEN && activeThreadId) {
			ws.send(JSON.stringify({ type: "subscribe", threadId: activeThreadId }));
		}
	}, [activeThreadId]);
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

// ── Helpers ──

function generateId(): string {
	return crypto.randomUUID();
}

function relativeTime(ts: number): string {
	const diff = Date.now() - ts;
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

// ── Components ──

function Header({
	status,
	onToggleSidebar,
	onOpenSettings,
}: {
	status: AppState["status"];
	onToggleSidebar: () => void;
	onOpenSettings: () => void;
}) {
	const [restarting, setRestarting] = useState(false);

	async function handleRestart() {
		if (restarting) return;
		setRestarting(true);
		try {
			await fetch("/api/daemon/restart", { method: "POST" });
		} finally {
			setRestarting(false);
		}
	}

	return (
		<header className="header">
			<button
				type="button"
				className="sidebar-toggle"
				onClick={onToggleSidebar}
				aria-label="Toggle sidebar"
			>
				&#9776;
			</button>
			<div className={`status-dot ${status}`} />
			<h1>browse</h1>
			<div className="header-actions">
				<span className="header-status">{status}</span>
				<button
					type="button"
					className={`header-action ${restarting ? "spinning" : ""}`}
					onClick={handleRestart}
					disabled={restarting}
					aria-label="Restart browser daemon"
					title="Restart browser daemon"
				>
					&#x21BB;
				</button>
				<button
					type="button"
					className="header-action"
					onClick={onOpenSettings}
					aria-label="Settings"
					title="Settings"
				>
					&#x2699;
				</button>
			</div>
		</header>
	);
}

function ThreadItem({
	thread,
	active,
	onSelect,
	onDelete,
}: {
	thread: ThreadSummary;
	active: boolean;
	onSelect: () => void;
	onDelete: () => void;
}) {
	return (
		<div className={`thread-item ${active ? "active" : ""}`}>
			<button type="button" className="thread-item-btn" onClick={onSelect}>
				<span className="thread-title">{thread.title}</span>
				<span className="thread-time">{relativeTime(thread.updatedAt)}</span>
			</button>
			<button
				type="button"
				className="thread-delete"
				onClick={(e) => {
					e.stopPropagation();
					onDelete();
				}}
				aria-label="Delete thread"
			>
				&times;
			</button>
		</div>
	);
}

function Sidebar({
	threads,
	activeThreadId,
	open,
	onSelectThread,
	onNewThread,
	onDeleteThread,
	onClose,
}: {
	threads: ThreadSummary[];
	activeThreadId: string | null;
	open: boolean;
	onSelectThread: (id: string) => void;
	onNewThread: () => void;
	onDeleteThread: (id: string) => void;
	onClose: () => void;
}) {
	return (
		<>
			{open && (
				<button
					type="button"
					className="sidebar-backdrop"
					onClick={onClose}
					aria-label="Close sidebar"
				/>
			)}
			<aside className={`sidebar ${open ? "open" : ""}`}>
				<div className="sidebar-header">
					<span className="sidebar-title">Threads</span>
					<button
						type="button"
						className="new-thread-btn"
						onClick={onNewThread}
					>
						+ New
					</button>
				</div>
				<div className="thread-list">
					{threads.map((t) => (
						<ThreadItem
							key={t.id}
							thread={t}
							active={t.id === activeThreadId}
							onSelect={() => onSelectThread(t.id)}
							onDelete={() => onDeleteThread(t.id)}
						/>
					))}
					{threads.length === 0 && (
						<div className="thread-list-empty">No threads yet</div>
					)}
				</div>
			</aside>
		</>
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

function UserMessage({ text, timestamp }: { text: string; timestamp: number }) {
	return (
		<div className="user-message">
			{text}
			<span className="message-time">{formatTime(timestamp)}</span>
		</div>
	);
}

function TextEntry({ text, timestamp }: { text: string; timestamp: number }) {
	const cleaned = text.replace(SCREENSHOT_MD_IMAGE, "").trim();
	return (
		<div className="text-entry prose">
			<Markdown remarkPlugins={[remarkGfm]}>{cleaned}</Markdown>
			<span className="message-time">{formatTime(timestamp)}</span>
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

function SettingsModal({
	settings,
	onUpdate,
	onClose,
}: {
	settings: Settings;
	onUpdate: (patch: Partial<Settings>) => void;
	onClose: () => void;
}) {
	const [currentModel, setCurrentModel] = useState("");
	const [models, setModels] = useState<ProviderModel[]>([]);
	const [loadingModel, setLoadingModel] = useState(true);

	useEffect(() => {
		(async () => {
			try {
				const [configRes, providersRes] = await Promise.all([
					fetch("/api/config"),
					fetch("/api/providers"),
				]);
				const config = await configRes.json();
				const providers = await providersRes.json();

				setCurrentModel(config.model ?? "");

				const allModels: ProviderModel[] = [];
				for (const provider of providers.all ?? []) {
					for (const [modelId, model] of Object.entries(
						provider.models ?? {},
					)) {
						const m = model as { name: string };
						allModels.push({
							id: `${provider.id}/${modelId}`,
							name: m.name || modelId,
							providerId: provider.id,
							providerName: provider.name || provider.id,
						});
					}
				}
				setModels(allModels);
			} catch {
				// non-fatal
			} finally {
				setLoadingModel(false);
			}
		})();
	}, []);

	useEffect(() => {
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [onClose]);

	async function handleModelChange(model: string) {
		setCurrentModel(model);
		await fetch("/api/config", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model }),
		});
	}

	const providerGroups = models.reduce(
		(groups, m) => {
			const key = m.providerName;
			if (!groups[key]) groups[key] = [];
			groups[key].push(m);
			return groups;
		},
		{} as Record<string, ProviderModel[]>,
	);

	return (
		<div
			className="settings-overlay"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
			onKeyDown={() => {}}
			role="dialog"
			aria-modal="true"
		>
			<div className="settings-panel">
				<div className="settings-header">
					<h2>Settings</h2>
					<button type="button" className="settings-close" onClick={onClose}>
						&times;
					</button>
				</div>

				<div className="settings-section">
					<div className="settings-section-title">Appearance</div>

					<div className="settings-row">
						<span className="settings-label">Font size</span>
						<div className="range-group">
							<input
								type="range"
								className="settings-range"
								min={12}
								max={18}
								value={settings.fontSize}
								onChange={(e) => onUpdate({ fontSize: Number(e.target.value) })}
							/>
							<span className="range-value">{settings.fontSize}</span>
						</div>
					</div>

					<div className="settings-row">
						<span className="settings-label">Show timestamps</span>
						<label className="toggle-switch">
							<input
								type="checkbox"
								checked={settings.showTimestamps}
								onChange={(e) => onUpdate({ showTimestamps: e.target.checked })}
							/>
							<span className="toggle-slider" />
						</label>
					</div>

					<div className="settings-row">
						<span className="settings-label">Message width</span>
						<div className="segmented-control">
							{(["compact", "default", "wide"] as const).map((w) => (
								<button
									key={w}
									type="button"
									className={`segmented-btn ${settings.messageWidth === w ? "active" : ""}`}
									onClick={() => onUpdate({ messageWidth: w })}
								>
									{w}
								</button>
							))}
						</div>
					</div>
				</div>

				<div className="settings-section">
					<div className="settings-section-title">Agent</div>

					<div className="settings-row">
						<span className="settings-label">
							Model
							{loadingModel && (
								<span className="settings-label-hint">Loading...</span>
							)}
						</span>
						<select
							className="settings-select"
							value={currentModel}
							onChange={(e) => handleModelChange(e.target.value)}
							disabled={loadingModel}
						>
							{currentModel && models.length === 0 && (
								<option value={currentModel}>{currentModel}</option>
							)}
							{Object.entries(providerGroups).map(([provider, provModels]) => (
								<optgroup key={provider} label={provider}>
									{provModels.map((m) => (
										<option key={m.id} value={m.id}>
											{m.name}
										</option>
									))}
								</optgroup>
							))}
						</select>
					</div>

					<div className="settings-row">
						<span className="settings-label">
							Auto-expand tool cards
							<span className="settings-label-hint">
								New tool cards start expanded
							</span>
						</span>
						<label className="toggle-switch">
							<input
								type="checkbox"
								checked={settings.autoExpandTools}
								onChange={(e) =>
									onUpdate({ autoExpandTools: e.target.checked })
								}
							/>
							<span className="toggle-slider" />
						</label>
					</div>
				</div>
			</div>
		</div>
	);
}

function ToolCard({
	entry,
	autoExpand,
}: {
	entry: Extract<TimelineEntry, { type: "tool" }>;
	autoExpand: boolean;
}) {
	const [expanded, setExpanded] = useState(autoExpand);

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
				<span className="message-time">{formatTime(entry.timestamp)}</span>
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
	autoExpandTools,
}: {
	entries: TimelineEntry[];
	busy: boolean;
	autoExpandTools: boolean;
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
						return (
							<UserMessage
								key={entry.id}
								text={entry.text}
								timestamp={entry.timestamp}
							/>
						);
					case "text":
						return (
							<TextEntry
								key={entry.id}
								text={entry.text}
								timestamp={entry.timestamp}
							/>
						);
					case "tool":
						if (/screenshot-[^\s]+\.png$/.test(entry.tool)) return null;
						return (
							<ToolCard
								key={entry.id}
								entry={entry}
								autoExpand={autoExpandTools}
							/>
						);
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
	activeThreadId,
	dispatch,
	onEnsureThread,
}: {
	status: AppState["status"];
	sessionId: string | null;
	activeThreadId: string | null;
	dispatch: React.Dispatch<Action>;
	onEnsureThread: () => Promise<string>;
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

			// Ensure we have a thread
			const threadId = activeThreadId ?? (await onEnsureThread());

			let sid = sessionId;
			if (!sid) {
				const res = await fetch("/api/session", { method: "POST" });
				const session = (await res.json()) as { id: string };
				sid = session.id;
				dispatch({ type: "SET_SESSION", sessionId: sid });
			}

			const msgRes = await fetch(`/api/session/${sid}/message`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text: trimmed, threadId }),
			});

			// Server returns auto-title when thread is first messaged
			if (msgRes.headers.get("content-type")?.includes("json")) {
				const data = (await msgRes.json()) as {
					threadTitle?: string;
				};
				if (data.threadTitle) {
					dispatch({
						type: "UPDATE_THREAD_TITLE",
						threadId,
						title: data.threadTitle,
					});
				}
			}
		},
		[text, busy, sessionId, activeThreadId, dispatch, onEnsureThread],
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
	const [settings, setSettings] = useState<Settings>(loadSettings);
	const [settingsOpen, setSettingsOpen] = useState(false);

	useWebSocket(dispatch, state.activeThreadId);

	// Apply settings to DOM
	useEffect(() => {
		document.documentElement.style.setProperty(
			"--font-size",
			`${settings.fontSize}px`,
		);
		document.documentElement.style.fontSize = `${settings.fontSize}px`;
	}, [settings.fontSize]);

	const handleUpdateSettings = useCallback((patch: Partial<Settings>) => {
		setSettings((prev) => {
			const next = { ...prev, ...patch };
			saveSettings(next);
			return next;
		});
	}, []);

	// Load threads on mount
	useEffect(() => {
		(async () => {
			const res = await fetch("/api/threads");
			const threads = (await res.json()) as ThreadSummary[];
			dispatch({ type: "SET_THREADS", threads });

			// Load most recent thread if available
			if (threads.length > 0 && threads[0]) {
				const threadRes = await fetch(`/api/threads/${threads[0].id}`);
				const data = (await threadRes.json()) as {
					entries: TimelineEntry[];
				};
				dispatch({
					type: "SET_ACTIVE_THREAD",
					threadId: threads[0].id,
					entries: data.entries,
				});
			}
		})();
	}, []);

	const handleSelectThread = useCallback(async (threadId: string) => {
		const res = await fetch(`/api/threads/${threadId}`);
		const data = (await res.json()) as { entries: TimelineEntry[] };
		dispatch({
			type: "SET_ACTIVE_THREAD",
			threadId,
			entries: data.entries,
		});
		// Close sidebar on mobile
		dispatch({ type: "TOGGLE_SIDEBAR" });
	}, []);

	const handleNewThread = useCallback(async () => {
		const id = generateId();
		const res = await fetch("/api/threads", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id }),
		});
		const thread = (await res.json()) as { id: string; title: string };
		const summary: ThreadSummary = {
			id: thread.id,
			title: thread.title,
			updatedAt: Date.now(),
		};
		dispatch({ type: "ADD_THREAD", thread: summary });
		dispatch({
			type: "SET_ACTIVE_THREAD",
			threadId: thread.id,
			entries: [],
		});
	}, []);

	const handleDeleteThread = useCallback(
		async (threadId: string) => {
			await fetch(`/api/threads/${threadId}`, { method: "DELETE" });
			dispatch({ type: "REMOVE_THREAD", threadId });

			// If we deleted the active thread and there are remaining threads, load first
			if (state.activeThreadId === threadId && state.threads.length > 1) {
				const remaining = state.threads.filter((t) => t.id !== threadId);
				if (remaining[0]) {
					const res = await fetch(`/api/threads/${remaining[0].id}`);
					const data = (await res.json()) as {
						entries: TimelineEntry[];
					};
					dispatch({
						type: "SET_ACTIVE_THREAD",
						threadId: remaining[0].id,
						entries: data.entries,
					});
				}
			}
		},
		[state.activeThreadId, state.threads],
	);

	// Ensure a thread exists (create one if needed) — used by ChatInput
	const ensureThread = useCallback(async (): Promise<string> => {
		const id = generateId();
		const res = await fetch("/api/threads", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id }),
		});
		const thread = (await res.json()) as { id: string; title: string };
		const summary: ThreadSummary = {
			id: thread.id,
			title: thread.title,
			updatedAt: Date.now(),
		};
		dispatch({ type: "ADD_THREAD", thread: summary });
		dispatch({
			type: "SET_ACTIVE_THREAD",
			threadId: thread.id,
			entries: [],
		});
		return thread.id;
	}, []);

	const widthClass =
		settings.messageWidth !== "default" ? `width-${settings.messageWidth}` : "";
	const timestampClass = settings.showTimestamps ? "" : "hide-timestamps";

	return (
		<>
			<Header
				status={state.status}
				onToggleSidebar={() => dispatch({ type: "TOGGLE_SIDEBAR" })}
				onOpenSettings={() => setSettingsOpen(true)}
			/>
			<div className="app-layout">
				<Sidebar
					threads={state.threads}
					activeThreadId={state.activeThreadId}
					open={state.sidebarOpen}
					onSelectThread={handleSelectThread}
					onNewThread={handleNewThread}
					onDeleteThread={handleDeleteThread}
					onClose={() => dispatch({ type: "TOGGLE_SIDEBAR" })}
				/>
				<main className={`main-content ${widthClass} ${timestampClass}`.trim()}>
					<Timeline
						entries={state.entries}
						busy={state.status === "busy"}
						autoExpandTools={settings.autoExpandTools}
					/>
					<ChatInput
						status={state.status}
						sessionId={state.sessionId}
						activeThreadId={state.activeThreadId}
						dispatch={dispatch}
						onEnsureThread={ensureThread}
					/>
				</main>
			</div>
			{settingsOpen && (
				<SettingsModal
					settings={settings}
					onUpdate={handleUpdateSettings}
					onClose={() => setSettingsOpen(false)}
				/>
			)}
		</>
	);
}

// ── Mount ──

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<App />);
}
