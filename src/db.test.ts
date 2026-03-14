import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We test db functions by re-implementing the init with a temp DB
// to avoid touching the real ~/.browse-ui/browse.db

let db: Database;
let testDir: string;

function createThread(id: string, title = "New thread") {
	const now = Date.now();
	db.run(
		"INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
		[id, title, now, now],
	);
	return { id, title, created_at: now, updated_at: now };
}

function listThreads() {
	return db
		.query("SELECT * FROM threads ORDER BY updated_at DESC")
		.all() as Array<{
		id: string;
		title: string;
		created_at: number;
		updated_at: number;
	}>;
}

function getThread(id: string) {
	return (
		(db.query("SELECT * FROM threads WHERE id = ?").get(id) as {
			id: string;
			title: string;
			created_at: number;
			updated_at: number;
		}) ?? null
	);
}

function deleteThread(id: string) {
	const result = db.run("DELETE FROM threads WHERE id = ?", [id]);
	return result.changes > 0;
}

function updateThread(id: string, fields: { title?: string }) {
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

function upsertEntry(
	threadId: string,
	entry: { id: string; type: string; data: unknown },
) {
	const now = Date.now();
	db.run(
		"INSERT OR REPLACE INTO entries (id, thread_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)",
		[entry.id, threadId, entry.type, JSON.stringify(entry.data), now],
	);
}

function getEntries(threadId: string) {
	return db
		.query("SELECT * FROM entries WHERE thread_id = ? ORDER BY created_at ASC")
		.all(threadId) as Array<{
		id: string;
		thread_id: string;
		type: string;
		data: string;
		created_at: number;
	}>;
}

beforeEach(() => {
	testDir = join(tmpdir(), `browse-ui-test-${Date.now()}`);
	mkdirSync(testDir, { recursive: true });
	db = new Database(join(testDir, "test.db"), { create: true });
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
});

afterEach(() => {
	db.close();
	rmSync(testDir, { recursive: true, force: true });
});

describe("threads", () => {
	test("createThread creates a thread with default title", () => {
		const thread = createThread("t1");
		expect(thread.id).toBe("t1");
		expect(thread.title).toBe("New thread");
		expect(thread.created_at).toBeGreaterThan(0);
	});

	test("createThread with custom title", () => {
		const thread = createThread("t2", "My thread");
		expect(thread.title).toBe("My thread");
	});

	test("listThreads returns threads ordered by updated_at desc", () => {
		createThread("t1", "First");
		createThread("t2", "Second");
		// Manually set t2's updated_at to be later
		db.run("UPDATE threads SET updated_at = updated_at + 1000 WHERE id = ?", [
			"t2",
		]);
		const threads = listThreads();
		expect(threads.length).toBe(2);
		expect(threads[0]?.id).toBe("t2");
		expect(threads[1]?.id).toBe("t1");
	});

	test("getThread returns thread by id", () => {
		createThread("t1", "Test");
		const thread = getThread("t1");
		expect(thread).not.toBeNull();
		expect(thread?.title).toBe("Test");
	});

	test("getThread returns null for missing id", () => {
		expect(getThread("nonexistent")).toBeNull();
	});

	test("deleteThread removes thread", () => {
		createThread("t1");
		expect(deleteThread("t1")).toBe(true);
		expect(getThread("t1")).toBeNull();
	});

	test("deleteThread returns false for missing id", () => {
		expect(deleteThread("nonexistent")).toBe(false);
	});

	test("updateThread updates title", () => {
		createThread("t1", "Old");
		updateThread("t1", { title: "New" });
		expect(getThread("t1")?.title).toBe("New");
	});

	test("updateThread returns false for missing id", () => {
		expect(updateThread("nonexistent", { title: "x" })).toBe(false);
	});
});

describe("entries", () => {
	test("upsertEntry inserts an entry", () => {
		createThread("t1");
		upsertEntry("t1", {
			id: "e1",
			type: "user",
			data: { type: "user", id: "e1", text: "hello" },
		});
		const entries = getEntries("t1");
		expect(entries.length).toBe(1);
		expect(entries[0]?.id).toBe("e1");
		expect(JSON.parse(entries[0]?.data)).toEqual({
			type: "user",
			id: "e1",
			text: "hello",
		});
	});

	test("upsertEntry replaces on same id", () => {
		createThread("t1");
		upsertEntry("t1", {
			id: "e1",
			type: "text",
			data: { text: "v1" },
		});
		upsertEntry("t1", {
			id: "e1",
			type: "text",
			data: { text: "v2" },
		});
		const entries = getEntries("t1");
		expect(entries.length).toBe(1);
		expect(JSON.parse(entries[0]?.data)).toEqual({ text: "v2" });
	});

	test("getEntries returns entries in order", () => {
		createThread("t1");
		upsertEntry("t1", { id: "e1", type: "user", data: { n: 1 } });
		upsertEntry("t1", { id: "e2", type: "text", data: { n: 2 } });
		const entries = getEntries("t1");
		expect(entries.length).toBe(2);
		expect(entries[0]?.id).toBe("e1");
		expect(entries[1]?.id).toBe("e2");
	});

	test("cascade delete removes entries", () => {
		createThread("t1");
		upsertEntry("t1", { id: "e1", type: "user", data: {} });
		upsertEntry("t1", { id: "e2", type: "text", data: {} });
		deleteThread("t1");
		expect(getEntries("t1").length).toBe(0);
	});

	test("entries scoped to thread", () => {
		createThread("t1");
		createThread("t2");
		upsertEntry("t1", { id: "e1", type: "user", data: {} });
		upsertEntry("t2", { id: "e2", type: "user", data: {} });
		expect(getEntries("t1").length).toBe(1);
		expect(getEntries("t2").length).toBe(1);
	});
});
