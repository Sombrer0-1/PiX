/**
 * ACP compact short-circuit: ON sessions must not abort or emit compaction_start.
 * OFF sessions keep the existing compact path (no live LLM required here).
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function createSession(sessionManager = SessionManager.inMemory()) {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		}),
		sessionManager,
		settingsManager: SettingsManager.inMemory(),
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});
	return { session, sessionManager };
}

function overflowAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "prompt is too long",
		timestamp: Date.now(),
	};
}

describe("AgentSession ACP compact short-circuit", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-acp-compact-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("ACP ON compact() throws ACP_COMPACTION_DISABLED before abort or compaction_start", async () => {
		({ session, sessionManager } = createSession(SessionManager.inMemory(tempDir, { acp: true })));
		expect(sessionManager.getAcp()).toBe(true);

		const events: string[] = [];
		session.subscribe((event) => {
			events.push(event.type);
		});

		const disconnectSpy = vi.spyOn(
			session as unknown as { _disconnectFromAgent: () => void },
			"_disconnectFromAgent",
		);
		const abortSpy = vi.spyOn(session, "abort");

		await expect(session.compact()).rejects.toThrow("ACP_COMPACTION_DISABLED");
		expect(events).not.toContain("compaction_start");
		expect(events).not.toContain("compaction_end");
		expect(disconnectSpy).not.toHaveBeenCalled();
		expect(abortSpy).not.toHaveBeenCalled();
	});

	it("ACP OFF compact still emits compaction_start (empty session fails after the gate)", async () => {
		({ session, sessionManager } = createSession(SessionManager.inMemory(tempDir)));
		expect(sessionManager.getAcp()).toBe(false);

		const events: string[] = [];
		session.subscribe((event) => {
			events.push(event.type);
		});

		await expect(session.compact()).rejects.toThrow("Nothing to compact (session too small)");
		expect(events).toContain("compaction_start");
		expect(events).toContain("compaction_end");
	});

	it("ACP ON _checkCompaction returns false before settings.enabled", async () => {
		({ session, sessionManager } = createSession(SessionManager.inMemory(tempDir, { acp: true })));
		expect(session.settingsManager.getCompactionSettings().enabled).toBe(true);

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue(true);

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
			}
		)._checkCompaction.bind(session);

		await expect(checkCompaction(overflowAssistant())).resolves.toBe(false);
		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("isAcpLocked follows sessionManager lock, streaming, and _runAgentPrompt flag", async () => {
		({ session, sessionManager } = createSession(SessionManager.inMemory(tempDir, { acp: true })));
		expect(sessionManager.isAcpLocked()).toBe(false);
		expect(session.isAcpLocked()).toBe(false);

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now(),
		});
		expect(sessionManager.isAcpLocked()).toBe(true);
		expect(session.isAcpLocked()).toBe(true);

		const unlocked = createSession(SessionManager.inMemory(tempDir, { acp: true }));
		session.dispose();
		session = unlocked.session;
		sessionManager = unlocked.sessionManager;
		expect(session.isAcpLocked()).toBe(false);

		// isStreaming is OR'd into AgentSession.isAcpLocked (covers in-flight turns).
		vi.spyOn(session, "isStreaming", "get").mockReturnValue(true);
		expect(session.isAcpLocked()).toBe(true);
		vi.restoreAllMocks();
		expect(session.isAcpLocked()).toBe(false);

		const runAgentPrompt = (
			session as unknown as {
				_runAgentPrompt: (messages: { role: string; content: unknown[]; timestamp: number }) => Promise<void>;
			}
		)._runAgentPrompt.bind(session);
		vi.spyOn(session.agent, "prompt").mockResolvedValue();

		await runAgentPrompt({
			role: "user",
			content: [{ type: "text", text: "start" }],
			timestamp: Date.now(),
		});
		expect(sessionManager.isAcpLocked()).toBe(false);
		expect(session.isAcpLocked()).toBe(true);
	});

	it("exportToJsonl handwritten header includes acp from getAcp and does not persist the loop flag", () => {
		({ session, sessionManager } = createSession(SessionManager.inMemory(tempDir, { acp: true })));
		const onPath = join(tempDir, "on.jsonl");
		session.exportToJsonl(onPath);
		const onHeader = JSON.parse(readFileSync(onPath, "utf-8").split("\n")[0]!);
		expect(onHeader.type).toBe("session");
		expect(onHeader.acp).toBe(true);
		expect(onHeader).not.toHaveProperty("_acpAgentLoopStarted");

		session.dispose();
		({ session, sessionManager } = createSession(SessionManager.inMemory(tempDir)));
		const offPath = join(tempDir, "off.jsonl");
		session.exportToJsonl(offPath);
		const offHeader = JSON.parse(readFileSync(offPath, "utf-8").split("\n")[0]!);
		expect(offHeader.acp).toBeUndefined();
	});
});
