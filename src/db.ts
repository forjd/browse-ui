import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DB_DIR = join(process.env.HOME ?? "~", ".browse-ui");
const DB_PATH = join(DB_DIR, "browse.db");

let db: Database;

export function initDb(): void {
	mkdirSync(DB_DIR, { recursive: true });
	db = new Database(DB_PATH, { create: true });
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");

	db.exec(`
		CREATE TABLE IF NOT EXISTS threads (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL DEFAULT 'New thread',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS entries (
			id TEXT PRIMARY KEY,
			thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
			type TEXT NOT NULL CHECK (type IN ('user', 'text', 'tool')),
			data TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_entries_thread ON entries(thread_id, created_at);
	`);
}

export interface ThreadRow {
	id: string;
	title: string;
	created_at: number;
	updated_at: number;
}

export interface EntryRow {
	id: string;
	thread_id: string;
	type: string;
	data: string;
	created_at: number;
}

export function createThread(id: string, title = "New thread"): ThreadRow {
	const now = Date.now();
	db.run(
		"INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
		[id, title, now, now],
	);
	return { id, title, created_at: now, updated_at: now };
}

export function listThreads(): ThreadRow[] {
	return db
		.query("SELECT * FROM threads ORDER BY updated_at DESC")
		.all() as ThreadRow[];
}

export function getThread(id: string): ThreadRow | null {
	return (
		(db.query("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow) ??
		null
	);
}

export function deleteThread(id: string): boolean {
	const result = db.run("DELETE FROM threads WHERE id = ?", [id]);
	return result.changes > 0;
}

export function updateThread(
	id: string,
	fields: Partial<Pick<ThreadRow, "title">>,
): boolean {
	const sets: string[] = [];
	const values: unknown[] = [];

	if (fields.title !== undefined) {
		sets.push("title = ?");
		values.push(fields.title);
	}

	if (sets.length === 0) return false;

	sets.push("updated_at = ?");
	values.push(Date.now());
	values.push(id);

	const result = db.run(
		`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`,
		values,
	);
	return result.changes > 0;
}

export function touchThread(id: string): void {
	db.run("UPDATE threads SET updated_at = ? WHERE id = ?", [Date.now(), id]);
}

export function upsertEntry(
	threadId: string,
	entry: { id: string; type: string; data: unknown },
): void {
	const now = Date.now();
	db.run(
		"INSERT OR REPLACE INTO entries (id, thread_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)",
		[entry.id, threadId, entry.type, JSON.stringify(entry.data), now],
	);
}

export function getEntries(threadId: string): EntryRow[] {
	return db
		.query("SELECT * FROM entries WHERE thread_id = ? ORDER BY created_at ASC")
		.all(threadId) as EntryRow[];
}
