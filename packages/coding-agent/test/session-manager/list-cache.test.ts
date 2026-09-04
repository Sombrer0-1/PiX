import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	invalidateSessionListCache,
	readSessionInfo,
	SessionManager,
	type SessionListProgress,
} from "../../src/core/session-manager.ts";

interface TestMessage {
	role: "user" | "assistant";
	text: string;
	timestamp: number;
}

function messageLine(id: string, message: TestMessage): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: "2025-01-01T00:00:01Z",
		message: { role: message.role, content: message.text, timestamp: message.timestamp },
	});
}

function writeSessionFile(
	dir: string,
	fileName: string,
	id: string,
	cwd: string,
	messages: TestMessage[],
): string {
	const file = join(dir, fileName);
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id,
		timestamp: "2025-01-01T00:00:00Z",
		cwd,
	});
	writeFileSync(file, `${[header, ...messages.map((m, i) => messageLine(`${id}-${i}`, m))].join("\n")}\n`);
	return file;
}

function trackProgress(): { calls: Array<[number, number]>; onProgress: SessionListProgress } {
	const calls: Array<[number, number]> = [];
	return { calls, onProgress: (loaded, total) => calls.push([loaded, total]) };
}

describe("SessionManager.list stat cache", () => {
	let tempDir: string;
	let projectDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-list-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(tempDir, "project");
		mkdirSync(tempDir, { recursive: true });
		invalidateSessionListCache();
	});

	afterEach(() => {
		invalidateSessionListCache();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("second list with unchanged stats reads nothing", async () => {
		writeSessionFile(tempDir, "a.jsonl", "a", projectDir, [{ role: "user", text: "hello", timestamp: 1000 }]);
		writeSessionFile(tempDir, "b.jsonl", "b", projectDir, [{ role: "user", text: "world", timestamp: 2000 }]);

		const first = trackProgress();
		const firstSessions = await SessionManager.list(projectDir, tempDir, first.onProgress);
		expect(first.calls).toEqual([
			[1, 2],
			[2, 2],
		]);
		expect(firstSessions.map((s) => s.id)).toEqual(["b", "a"]);

		const second = trackProgress();
		const secondSessions = await SessionManager.list(projectDir, tempDir, second.onProgress);
		// Cache hit: no file is read, so onProgress never fires.
		expect(second.calls).toHaveLength(0);
		expect(secondSessions.map((s) => s.id)).toEqual(["b", "a"]);
	});

	it("re-reads only the file whose stat changed", async () => {
		const fileA = writeSessionFile(tempDir, "a.jsonl", "a", projectDir, [
			{ role: "user", text: "hello", timestamp: 1000 },
		]);
		writeSessionFile(tempDir, "b.jsonl", "b", projectDir, [{ role: "user", text: "world", timestamp: 2000 }]);
		await SessionManager.list(projectDir, tempDir);

		// Appending changes the file size, so the fingerprint differs regardless
		// of mtime granularity.
		appendFileSync(fileA, `${messageLine("a-1", { role: "user", text: "again", timestamp: 3000 })}\n`);

		const progress = trackProgress();
		const sessions = await SessionManager.list(projectDir, tempDir, progress.onProgress);
		expect(progress.calls).toEqual([[1, 1]]);
		const a = sessions.find((s) => s.id === "a");
		expect(a?.messageCount).toBe(2);
		expect(sessions.map((s) => s.id)).toEqual(["a", "b"]);

		const third = trackProgress();
		await SessionManager.list(projectDir, tempDir, third.onProgress);
		expect(third.calls).toHaveLength(0);
	});

	it("includeAllMessagesText=false returns empty text and never mixes cache entries", async () => {
		writeSessionFile(tempDir, "a.jsonl", "a", projectDir, [
			{ role: "user", text: "hello", timestamp: 1000 },
			{ role: "assistant", text: "response", timestamp: 1001 },
		]);

		const withText = await SessionManager.list(projectDir, tempDir);
		expect(withText[0].allMessagesText).toBe("hello response");

		const noTextProgress = trackProgress();
		const withoutText = await SessionManager.list(projectDir, tempDir, noTextProgress.onProgress, {
			includeAllMessagesText: false,
		});
		expect(withoutText[0].allMessagesText).toBe("");
		expect(withoutText[0].firstMessage).toBe("hello");
		expect(withoutText[0].messageCount).toBe(2);
		// The false-option variant has its own cache entry: everything is re-read once.
		expect(noTextProgress.calls).toEqual([[1, 1]]);

		const noTextAgain = trackProgress();
		await SessionManager.list(projectDir, tempDir, noTextAgain.onProgress, { includeAllMessagesText: false });
		expect(noTextAgain.calls).toHaveLength(0);

		// The default-option entry stayed warm and intact.
		const withTextAgain = trackProgress();
		const again = await SessionManager.list(projectDir, tempDir, withTextAgain.onProgress);
		expect(withTextAgain.calls).toHaveLength(0);
		expect(again[0].allMessagesText).toBe("hello response");
	});

	it("picks up new files and drops deleted files", async () => {
		const fileA = writeSessionFile(tempDir, "a.jsonl", "a", projectDir, [
			{ role: "user", text: "a", timestamp: 1000 },
		]);
		writeSessionFile(tempDir, "b.jsonl", "b", projectDir, [{ role: "user", text: "b", timestamp: 2000 }]);
		await SessionManager.list(projectDir, tempDir);

		rmSync(fileA);
		writeSessionFile(tempDir, "c.jsonl", "c", projectDir, [{ role: "user", text: "c", timestamp: 3000 }]);

		const progress = trackProgress();
		const sessions = await SessionManager.list(projectDir, tempDir, progress.onProgress);
		// Only the new file is read; the deleted file's entry is dropped.
		expect(progress.calls).toEqual([[1, 1]]);
		expect(sessions.map((s) => s.id)).toEqual(["c", "b"]);
	});

	it("returns sessions sorted by modified descending", async () => {
		writeSessionFile(tempDir, "old.jsonl", "old", projectDir, [{ role: "user", text: "old", timestamp: 1000 }]);
		writeSessionFile(tempDir, "mid.jsonl", "mid", projectDir, [{ role: "user", text: "mid", timestamp: 2000 }]);
		writeSessionFile(tempDir, "new.jsonl", "new", projectDir, [{ role: "user", text: "new", timestamp: 3000 }]);

		const sessions = await SessionManager.list(projectDir, tempDir);
		expect(sessions.map((s) => s.id)).toEqual(["new", "mid", "old"]);

		appendFileSync(
			join(tempDir, "old.jsonl"),
			`${messageLine("old-1", { role: "user", text: "bump", timestamp: 4000 })}\n`,
		);
		const reordered = await SessionManager.list(projectDir, tempDir);
		expect(reordered.map((s) => s.id)).toEqual(["old", "new", "mid"]);
	});

	it("invalidateSessionListCache(dir) clears only that directory", async () => {
		const dir1 = join(tempDir, "one");
		const dir2 = join(tempDir, "two");
		mkdirSync(dir1);
		mkdirSync(dir2);
		writeSessionFile(dir1, "a.jsonl", "a", projectDir, [{ role: "user", text: "a", timestamp: 1000 }]);
		writeSessionFile(dir2, "b.jsonl", "b", projectDir, [{ role: "user", text: "b", timestamp: 1000 }]);
		await SessionManager.list(projectDir, dir1);
		await SessionManager.list(projectDir, dir2);

		invalidateSessionListCache(dir1);

		const one = trackProgress();
		await SessionManager.list(projectDir, dir1, one.onProgress);
		expect(one.calls).toEqual([[1, 1]]);

		const two = trackProgress();
		await SessionManager.list(projectDir, dir2, two.onProgress);
		expect(two.calls).toHaveLength(0);
	});

	it("invalidateSessionListCache() clears every directory", async () => {
		const dir1 = join(tempDir, "one");
		const dir2 = join(tempDir, "two");
		mkdirSync(dir1);
		mkdirSync(dir2);
		writeSessionFile(dir1, "a.jsonl", "a", projectDir, [{ role: "user", text: "a", timestamp: 1000 }]);
		writeSessionFile(dir2, "b.jsonl", "b", projectDir, [{ role: "user", text: "b", timestamp: 1000 }]);
		await SessionManager.list(projectDir, dir1);
		await SessionManager.list(projectDir, dir2);

		SessionManager.invalidateSessionListCache();

		const one = trackProgress();
		await SessionManager.list(projectDir, dir1, one.onProgress);
		expect(one.calls).toEqual([[1, 1]]);

		const two = trackProgress();
		await SessionManager.list(projectDir, dir2, two.onProgress);
		expect(two.calls).toEqual([[1, 1]]);
	});

	it("applies filterCwd per call without disturbing the cache", async () => {
		const projectA = join(tempDir, "project-a");
		const projectB = join(tempDir, "project-b");
		writeSessionFile(tempDir, "a.jsonl", "a", projectA, [{ role: "user", text: "a", timestamp: 1000 }]);
		writeSessionFile(tempDir, "b.jsonl", "b", projectB, [{ role: "user", text: "b", timestamp: 2000 }]);

		const forA = await SessionManager.list(projectA, tempDir);
		expect(forA.map((s) => s.id)).toEqual(["a"]);

		// Both files were read into the cache by the first call; filtering for
		// projectB must not trigger a re-read.
		const forBProgress = trackProgress();
		const forB = await SessionManager.list(projectB, tempDir, forBProgress.onProgress);
		expect(forB.map((s) => s.id)).toEqual(["b"]);
		expect(forBProgress.calls).toHaveLength(0);

		const forAAgain = await SessionManager.list(projectA, tempDir);
		expect(forAAgain.map((s) => s.id)).toEqual(["a"]);
	});

	it("returns deep copies so mutating a listed SessionInfo does not poison the cache", async () => {
		writeSessionFile(tempDir, "a.jsonl", "a", projectDir, [{ role: "user", text: "hello", timestamp: 1000 }]);

		const first = await SessionManager.list(projectDir, tempDir);
		expect(first).toHaveLength(1);
		first[0].firstMessage = "MUTATED";
		first[0].allMessagesText = "MUTATED";

		const second = await SessionManager.list(projectDir, tempDir);
		expect(second[0].firstMessage).toBe("hello");
		expect(second[0].allMessagesText).toBe("hello");
		expect(second[0]).not.toBe(first[0]);
	});

	it("LRU-refreshes a listed directory so it is not evicted by newer dirs", async () => {
		const dirs: string[] = [];
		for (let i = 0; i < 9; i++) {
			const dir = join(tempDir, `dir${i}`);
			mkdirSync(dir);
			writeSessionFile(dir, "s.jsonl", `s${i}`, projectDir, [{ role: "user", text: `t${i}`, timestamp: 1000 }]);
			dirs.push(dir);
		}
		for (let i = 0; i < 8; i++) {
			await SessionManager.list(projectDir, dirs[i]);
		}
		// Relist dir0 so it becomes the newest of the 8; inserting dir8 then
		// evicts dir1 (oldest), not dir0.
		await SessionManager.list(projectDir, dirs[0]);
		await SessionManager.list(projectDir, dirs[8]);

		const dir0 = trackProgress();
		await SessionManager.list(projectDir, dirs[0], dir0.onProgress);
		expect(dir0.calls).toHaveLength(0);

		const dir1 = trackProgress();
		await SessionManager.list(projectDir, dirs[1], dir1.onProgress);
		expect(dir1.calls).toEqual([[1, 1]]);
	});

	describe("readSessionInfo", () => {
		it("returns null for missing or header-less files", async () => {
			expect(await readSessionInfo(join(tempDir, "missing.jsonl"))).toBeNull();

			const noHeader = join(tempDir, "no-header.jsonl");
			writeFileSync(noHeader, `${messageLine("x", { role: "user", text: "x", timestamp: 1 })}\n`);
			expect(await readSessionInfo(noHeader)).toBeNull();
		});

		it("skips allMessagesText when includeAllMessagesText is false", async () => {
			const file = writeSessionFile(tempDir, "a.jsonl", "a", projectDir, [
				{ role: "user", text: "hello", timestamp: 1000 },
				{ role: "assistant", text: "response", timestamp: 1001 },
			]);

			const withText = await readSessionInfo(file);
			expect(withText?.allMessagesText).toBe("hello response");
			expect(withText?.firstMessage).toBe("hello");
			expect(withText?.messageCount).toBe(2);

			const withoutText = await readSessionInfo(file, { includeAllMessagesText: false });
			expect(withoutText?.allMessagesText).toBe("");
			expect(withoutText?.firstMessage).toBe("hello");
			expect(withoutText?.messageCount).toBe(2);
		});
	});
});
