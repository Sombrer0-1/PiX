import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	invalidateSessionListCache,
	loadEntriesFromFile,
	SessionManager,
	type SessionMessageEntry,
} from "../../src/core/session-manager.ts";

const BASE_TIME = 1_700_000_000_000;

function headerLine(id: string): string {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" });
}

function messageLine(id: string, content: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: "2025-01-01T00:00:01Z",
		message: { role: "user", content, timestamp: 1000 },
	});
}

/** Force an exact integer-ms mtime so stat fingerprints can be made identical
 *  (or distinct) deterministically; Windows mtime granularity and utimes
 *  truncation would otherwise make same-size rewrites flaky. */
function setMtime(file: string, ms: number): void {
	const t = new Date(ms);
	utimesSync(file, t, t);
}

function messageContent(entryIndex: number, entries: ReturnType<typeof loadEntriesFromFile>): string {
	const content = (entries[entryIndex] as SessionMessageEntry).message.content;
	return content as string;
}

describe("loadEntriesFromFile entries cache", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-entries-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		invalidateSessionListCache();
	});

	afterEach(() => {
		invalidateSessionListCache();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("cache hits skip re-parsing and return deep copies", () => {
		const file = join(tempDir, "a.jsonl");
		writeFileSync(file, `${headerLine("a")}\n${messageLine("m1", "A".repeat(64))}\n`);
		setMtime(file, BASE_TIME);

		const first = loadEntriesFromFile(file);
		expect(first).toHaveLength(2);
		expect(messageContent(1, first)).toBe("A".repeat(64));

		// Mutate the returned copy; the cache must never observe this.
		(first[1] as SessionMessageEntry).message.content = "MUTATED";
		first.push(first[0]);

		// Same byte size + same forced mtime = identical fingerprint. The file on
		// disk now holds "B"s, so a re-parse (or a missing deep copy) would show.
		writeFileSync(file, `${headerLine("a")}\n${messageLine("m1", "B".repeat(64))}\n`);
		setMtime(file, BASE_TIME);

		const second = loadEntriesFromFile(file);
		expect(second).toHaveLength(2);
		expect(messageContent(1, second)).toBe("A".repeat(64));
	});

	it("re-reads after an append changed the stat fingerprint", () => {
		const file = join(tempDir, "b.jsonl");
		writeFileSync(file, `${headerLine("b")}\n${messageLine("m1", "one")}\n`);
		setMtime(file, BASE_TIME);
		expect(loadEntriesFromFile(file)).toHaveLength(2);

		appendFileSync(file, `${messageLine("m2", "two")}\n`);

		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(3);
		expect(messageContent(2, entries)).toBe("two");
	});

	it("re-reads when only mtimeMs changed", () => {
		const file = join(tempDir, "c.jsonl");
		writeFileSync(file, `${headerLine("c")}\n${messageLine("m1", "A".repeat(32))}\n`);
		setMtime(file, BASE_TIME);
		loadEntriesFromFile(file);

		writeFileSync(file, `${headerLine("c")}\n${messageLine("m1", "B".repeat(32))}\n`);
		setMtime(file, BASE_TIME + 10);

		const entries = loadEntriesFromFile(file);
		expect(messageContent(1, entries)).toBe("B".repeat(32));
	});

	it("evicts the least recently used entry beyond 4 files", () => {
		const files: string[] = [];
		for (let i = 0; i < 5; i++) {
			const file = join(tempDir, `f${i}.jsonl`);
			writeFileSync(file, `${headerLine(`s${i}`)}\n${messageLine(`m${i}`, `A${i}`.repeat(8))}\n`);
			setMtime(file, BASE_TIME + i);
			files.push(file);
		}
		for (let i = 0; i < 4; i++) loadEntriesFromFile(files[i]);
		// Touch f0 so its LRU position refreshes and f1 becomes the oldest entry.
		loadEntriesFromFile(files[0]);
		// Inserting the 5th file evicts the oldest cached entry (f1).
		loadEntriesFromFile(files[4]);

		// f1 was evicted: an identical fingerprint now re-parses the new disk content.
		writeFileSync(files[1], `${headerLine("s1")}\n${messageLine("m1", "B1".repeat(8))}\n`);
		setMtime(files[1], BASE_TIME + 1);
		expect(messageContent(1, loadEntriesFromFile(files[1]))).toBe("B1".repeat(8));

		// f0 is still cached (the touch refreshed it): identical fingerprint
		// serves the old parse, not the rewritten disk content.
		writeFileSync(files[0], `${headerLine("s0")}\n${messageLine("m0", "B0".repeat(8))}\n`);
		setMtime(files[0], BASE_TIME);
		expect(messageContent(1, loadEntriesFromFile(files[0]))).toBe("A0".repeat(8));
	});

	it("evicts oldest entries until the cache stays under 32MB", () => {
		// Four ~8.5MB session files exceed the 32MB cumulative byte budget, so
		// inserting the 4th big file evicts the small file (count limit) and the
		// 1st big file (byte budget). Approach sanctioned by the SDD (write
		// multiple large entries to exceed the budget for real).
		const bigSize = Math.floor(8.5 * 1024 * 1024);
		const small = join(tempDir, "small.jsonl");
		writeFileSync(small, `${headerLine("small")}\n${messageLine("m", "s")}\n`);
		setMtime(small, BASE_TIME);
		loadEntriesFromFile(small);

		const bigFiles: string[] = [];
		for (let i = 0; i < 4; i++) {
			const file = join(tempDir, `big${i}.jsonl`);
			writeFileSync(file, `${headerLine(`big${i}`)}\n${messageLine(`m${i}`, "A".repeat(bigSize))}\n`);
			setMtime(file, BASE_TIME + 100 + i);
			bigFiles.push(file);
		}
		loadEntriesFromFile(bigFiles[0]);
		loadEntriesFromFile(bigFiles[1]);
		loadEntriesFromFile(bigFiles[2]);
		// Cache now: [small, big0, big1, big2] (~25.5MB, fits).
		loadEntriesFromFile(bigFiles[3]);
		// Inserting big3 (~34MB total) evicts small (5 entries) and big0 (bytes)
		// until the budget is met: [big1, big2, big3].

		// big1 is still cached: identical fingerprint serves the old content.
		// (Checked first; re-loading big0 would insert it again and could evict big1.)
		writeFileSync(bigFiles[1], `${headerLine("big1")}\n${messageLine("m1", "B".repeat(bigSize))}\n`);
		setMtime(bigFiles[1], BASE_TIME + 101);
		expect(messageContent(1, loadEntriesFromFile(bigFiles[1]))).toBe("A".repeat(bigSize));

		// big0 was evicted: identical fingerprint re-parses the new disk content.
		writeFileSync(bigFiles[0], `${headerLine("big0")}\n${messageLine("m0", "B".repeat(bigSize))}\n`);
		setMtime(bigFiles[0], BASE_TIME + 100);
		expect(messageContent(1, loadEntriesFromFile(bigFiles[0]))).toBe("B".repeat(bigSize));
	});

	it("LRU-refreshes a rewritten file so appends do not leave it oldest", () => {
		const files: string[] = [];
		for (let i = 0; i < 5; i++) {
			const file = join(tempDir, `r${i}.jsonl`);
			writeFileSync(file, `${headerLine(`s${i}`)}\n${messageLine(`m${i}`, `A${i}`.repeat(8))}\n`);
			setMtime(file, BASE_TIME + i);
			files.push(file);
		}
		for (let i = 0; i < 4; i++) loadEntriesFromFile(files[i]);
		// Rewrite r0 (fingerprint changes) and reload: the miss-store must
		// move r0 to newest, so inserting r4 evicts r1, not r0.
		writeFileSync(files[0], `${headerLine("s0")}\n${messageLine("m0", "C0".repeat(8))}\n`);
		setMtime(files[0], BASE_TIME + 50);
		loadEntriesFromFile(files[0]);
		loadEntriesFromFile(files[4]);

		writeFileSync(files[1], `${headerLine("s1")}\n${messageLine("m1", "B1".repeat(8))}\n`);
		setMtime(files[1], BASE_TIME + 1);
		expect(messageContent(1, loadEntriesFromFile(files[1]))).toBe("B1".repeat(8));

		writeFileSync(files[0], `${headerLine("s0")}\n${messageLine("m0", "D0".repeat(8))}\n`);
		setMtime(files[0], BASE_TIME + 50);
		expect(messageContent(1, loadEntriesFromFile(files[0]))).toBe("C0".repeat(8));
	});

	it("does not cache files that fail session header validation", () => {
		const file = join(tempDir, "invalid.jsonl");
		const valid = `${headerLine("v")}\n${messageLine("m1", "valid")}\n`;
		// A message-only file (no session header) padded to the exact byte size
		// of the valid variant so both variants share one stat fingerprint.
		const bare = `${messageLine("m1", "")}\n`;
		const invalid = `${messageLine("m1", "x".repeat(Buffer.byteLength(valid) - Buffer.byteLength(bare)))}\n`;
		expect(Buffer.byteLength(invalid)).toBe(Buffer.byteLength(valid));

		writeFileSync(file, invalid);
		setMtime(file, BASE_TIME);
		expect(loadEntriesFromFile(file)).toEqual([]);

		// Same fingerprint but valid content: the empty result must not have been cached.
		writeFileSync(file, valid);
		setMtime(file, BASE_TIME);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
	});

	it("invalidateSessionListCache clears the entries cache too", () => {
		const file = join(tempDir, "d.jsonl");
		writeFileSync(file, `${headerLine("d")}\n${messageLine("m1", "A".repeat(16))}\n`);
		setMtime(file, BASE_TIME);
		loadEntriesFromFile(file);

		invalidateSessionListCache();

		// Identical fingerprint, new disk content: the old parse is gone.
		writeFileSync(file, `${headerLine("d")}\n${messageLine("m1", "B".repeat(16))}\n`);
		setMtime(file, BASE_TIME);
		expect(messageContent(1, loadEntriesFromFile(file))).toBe("B".repeat(16));
	});

	it("SessionManager.open reuses cached entries and sees appended data after writes", () => {
		const file = join(tempDir, "e.jsonl");
		writeFileSync(file, `${headerLine("e")}\n${messageLine("m1", "one")}\n`);
		setMtime(file, BASE_TIME);

		const sm1 = SessionManager.open(file, tempDir);
		expect(sm1.getSessionId()).toBe("e");
		expect(sm1.getEntries()).toHaveLength(1);

		// Second open hits the entries cache (same stat fingerprint).
		const sm2 = SessionManager.open(file, tempDir);
		expect(sm2.getSessionId()).toBe("e");
		expect(sm2.getEntries()).toHaveLength(1);

		// Appending through one manager changes the stat; a fresh open re-parses.
		sm1.appendMessage({ role: "user", content: "two", timestamp: Date.now() });
		const sm3 = SessionManager.open(file, tempDir);
		const contents = sm3
			.getEntries()
			.filter((e): e is SessionMessageEntry => e.type === "message")
			.map((e) => e.message.content as string);
		expect(contents).toEqual(["one", "two"]);
	});
});
