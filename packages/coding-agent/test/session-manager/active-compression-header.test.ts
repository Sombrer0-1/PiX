import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

function userMessage(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("SessionManager active compression header", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `acp-header-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("getAcp defaults to false when header omits acp", () => {
		const session = SessionManager.inMemory();
		expect(session.getAcp()).toBe(false);
		expect(session.getHeader()?.acp).toBeUndefined();
		expect(session.isAcpLocked()).toBe(false);
	});

	it("create persists options.acp true via newSession", () => {
		const session = SessionManager.create(tempDir, tempDir, { acp: true });
		expect(session.getAcp()).toBe(true);
		expect(session.getHeader()?.acp).toBe(true);
		expect(session.isFlushed()).toBe(false);
		expect(existsSync(session.getSessionFile()!)).toBe(false);
	});

	it("inMemory accepts options.acp true", () => {
		const session = SessionManager.inMemory(tempDir, { acp: true });
		expect(session.getAcp()).toBe(true);
		expect(session.getHeader()?.acp).toBe(true);
	});

	it("create/inMemory with acp false or omitted stay off", () => {
		expect(SessionManager.create(tempDir, tempDir, { acp: false }).getAcp()).toBe(false);
		expect(SessionManager.inMemory(tempDir, { acp: false }).getAcp()).toBe(false);
		expect(SessionManager.inMemory(tempDir, {}).getAcp()).toBe(false);
	});

	it("newSession is a fresh session and does not keep previous header.acp", () => {
		const session = SessionManager.inMemory(tempDir, { acp: true });
		expect(session.getAcp()).toBe(true);
		session.newSession();
		expect(session.getAcp()).toBe(false);
		expect(session.getHeader()?.acp).toBeUndefined();

		session.newSession({ acp: true });
		expect(session.getAcp()).toBe(true);
		session.newSession({ parentSession: "parent.jsonl" });
		expect(session.getAcp()).toBe(false);
	});

	it("locks after a user message", () => {
		const session = SessionManager.inMemory(tempDir, { acp: true });
		expect(session.isAcpLocked()).toBe(false);
		session.appendMessage(userMessage("hello"));
		expect(session.isAcpLocked()).toBe(true);
		expect(() => session.setAcp(false)).toThrowError("ACP_LOCKED");
		expect(session.getAcp()).toBe(true);
	});

	it("locks after an assistant message", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(assistantMessage("hi"));
		expect(session.isAcpLocked()).toBe(true);
		expect(() => session.setAcp(true)).toThrowError("ACP_LOCKED");
		expect(session.getAcp()).toBe(false);
	});

	it("custom_message does not lock", () => {
		const session = SessionManager.inMemory();
		session.appendCustomMessageEntry("ext", "injected", false);
		expect(session.isAcpLocked()).toBe(false);
		session.setAcp(true);
		expect(session.getAcp()).toBe(true);
		session.setAcp(false);
		expect(session.getAcp()).toBe(false);
	});

	it("unflushed setAcp mutates memory but does not create a jsonl file", () => {
		const session = SessionManager.create(tempDir, tempDir);
		const file = session.getSessionFile()!;
		expect(session.isFlushed()).toBe(false);
		expect(existsSync(file)).toBe(false);

		session.setAcp(true);
		expect(session.getAcp()).toBe(true);
		expect(session.getHeader()?.acp).toBe(true);
		expect(session.isFlushed()).toBe(false);
		expect(existsSync(file)).toBe(false);

		session.setAcp(false);
		expect(session.getAcp()).toBe(false);
		expect(existsSync(file)).toBe(false);
	});

	it("flushed setAcp rewrites the session header", () => {
		const file = join(tempDir, "flushed.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "abc",
				timestamp: "2025-01-01T00:00:00.000Z",
				cwd: tempDir,
			})}\n`,
		);

		const session = SessionManager.open(file, tempDir);
		expect(session.isFlushed()).toBe(true);
		expect(session.isAcpLocked()).toBe(false);
		expect(session.getAcp()).toBe(false);

		session.setAcp(true);
		expect(session.getAcp()).toBe(true);
		const afterOn = JSON.parse(readFileSync(file, "utf-8").trim().split("\n")[0]);
		expect(afterOn.acp).toBe(true);

		session.setAcp(false);
		expect(session.getAcp()).toBe(false);
		const afterOff = JSON.parse(readFileSync(file, "utf-8").trim().split("\n")[0]);
		expect(afterOff.acp).toBeUndefined();
	});

	it("createBranchedSession copies current getAcp()", () => {
		const onSession = SessionManager.inMemory(tempDir, { acp: true });
		const onLeaf = onSession.appendMessage(userMessage("keep acp on"));
		onSession.createBranchedSession(onLeaf);
		expect(onSession.getAcp()).toBe(true);
		expect(onSession.getHeader()?.acp).toBe(true);

		const offSession = SessionManager.inMemory(tempDir);
		offSession.setAcp(true);
		offSession.setAcp(false);
		const offLeaf = offSession.appendMessage(userMessage("keep acp off"));
		offSession.createBranchedSession(offLeaf);
		expect(offSession.getAcp()).toBe(false);
		expect(offSession.getHeader()?.acp).toBeUndefined();
	});

	it("forkFrom copies sourceHeader.acp", () => {
		const sourceOn = join(tempDir, "source-on.jsonl");
		writeFileSync(
			sourceOn,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "src-on",
				timestamp: "2025-01-01T00:00:00.000Z",
				cwd: tempDir,
				acp: true,
			})}\n${JSON.stringify({
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2025-01-01T00:00:01.000Z",
				message: userMessage("hi"),
			})}\n`,
		);

		const forkedOn = SessionManager.forkFrom(sourceOn, tempDir, tempDir);
		expect(forkedOn.getAcp()).toBe(true);
		expect(forkedOn.getHeader()?.acp).toBe(true);

		const sourceOff = join(tempDir, "source-off.jsonl");
		writeFileSync(
			sourceOff,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "src-off",
				timestamp: "2025-01-01T00:00:00.000Z",
				cwd: tempDir,
			})}\n`,
		);
		const forkedOff = SessionManager.forkFrom(sourceOff, tempDir, tempDir);
		expect(forkedOff.getAcp()).toBe(false);
		expect(forkedOff.getHeader()?.acp).toBeUndefined();
	});

	it("empty or corrupt session file starts a new session with ACP off", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");
		const emptySession = SessionManager.open(emptyFile, tempDir);
		expect(emptySession.getAcp()).toBe(false);
		expect(emptySession.getHeader()?.acp).toBeUndefined();

		const badFile = join(tempDir, "bad.jsonl");
		writeFileSync(badFile, "not json\n");
		const badSession = SessionManager.open(badFile, tempDir);
		expect(badSession.getAcp()).toBe(false);
		expect(badSession.getHeader()?.acp).toBeUndefined();

		const noHeaderFile = join(tempDir, "no-header.jsonl");
		writeFileSync(
			noHeaderFile,
			'{"type":"message","id":"abc","parentId":null,"timestamp":"2025-01-01T00:00:00Z","message":{"role":"user","content":"hi"}}\n',
		);
		const recovered = SessionManager.open(noHeaderFile, tempDir);
		expect(recovered.getAcp()).toBe(false);
		expect(recovered.getHeader()?.acp).toBeUndefined();
	});
});
