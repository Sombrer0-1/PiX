/**
 * Tests for the opt-in `shouldStopAfterTurn` hook and the `enableBuiltInEnhancementTools`
 * switch on `createAgentSession`.
 *
 * Both are pure additions: omitting them must keep the pre-existing behaviour.
 */

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ToolDefinition } from "../src/core/extensions/index.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createFauxStreamFn, type FauxResponseInput } from "./test-harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

/** Custom SDK tool that records its executions and returns a fixed result. */
function createRecordingTool(executed: string[]): ToolDefinition {
	return {
		name: "record_note",
		label: "Record Note",
		description: "Records that it ran.",
		promptSnippet: "Record a note",
		parameters: Type.Object({}),
		execute: async () => {
			executed.push("record_note");
			return { content: [{ type: "text", text: "recorded" }], details: {} };
		},
	};
}

interface TestSessionOptions {
	responses?: FauxResponseInput[];
	shouldStopAfterTurn?: CreateAgentSessionOptions["shouldStopAfterTurn"];
	enableBuiltInEnhancementTools?: boolean;
	/** When provided, registers the `record_note` tool which pushes its name on execution. */
	executed?: string[];
}

async function createSession(options: TestSessionOptions = {}) {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const { streamFn, state: faux } = createFauxStreamFn(options.responses ?? ["ok"]);

	const { session } = await createAgentSession({
		model,
		authStorage,
		modelRegistry,
		settingsManager: SettingsManager.inMemory(),
		sessionManager: SessionManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
		shouldStopAfterTurn: options.shouldStopAfterTurn,
		enableBuiltInEnhancementTools: options.enableBuiltInEnhancementTools,
		customTools: options.executed ? [createRecordingTool(options.executed)] : undefined,
	});
	// The SDK builds a provider-backed stream function; swap in the faux one.
	session.agent.streamFn = streamFn;
	return { session, faux };
}

function toolResults(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.filter((message) => message.role === "toolResult");
}

/** One tool-calling turn followed by a plain text response. */
const TOOL_CALL_RESPONSES: FauxResponseInput[] = [{ toolCalls: [{ name: "record_note", args: {} }] }, "done"];

describe("AgentSession shouldStopAfterTurn", () => {
	it("ends the run after the tool batch when the callback returns true", async () => {
		const executed: string[] = [];
		let calls = 0;
		const { session, faux } = await createSession({
			responses: TOOL_CALL_RESPONSES,
			executed,
			shouldStopAfterTurn: () => {
				calls++;
				return true;
			},
		});

		const agentEvents: AgentEvent[] = [];
		session.agent.subscribe((event) => {
			agentEvents.push(event);
		});

		try {
			await session.prompt("record a note");

			expect(calls).toBe(1);
			expect(executed).toEqual(["record_note"]);
			// The run ended after the first turn: no second provider request.
			expect(faux.callCount).toBe(1);

			const agentEnd = agentEvents.find(
				(event): event is Extract<AgentEvent, { type: "agent_end" }> => event.type === "agent_end",
			);
			expect(agentEnd).toBeDefined();
			const emittedToolResults = toolResults(agentEnd?.messages ?? []);
			expect(emittedToolResults).toHaveLength(1);
			expect(JSON.stringify(emittedToolResults[0]?.content)).toContain("recorded");

			// The tool batch is persisted, not truncated from the transcript.
			expect(toolResults(session.messages)).toHaveLength(1);
		} finally {
			session.dispose();
		}
	});

	it("keeps running when the callback returns false", async () => {
		const executed: string[] = [];
		let calls = 0;
		const { session, faux } = await createSession({
			responses: TOOL_CALL_RESPONSES,
			executed,
			shouldStopAfterTurn: () => {
				calls++;
				return false;
			},
		});

		try {
			await session.prompt("record a note");

			expect(calls).toBe(2);
			expect(executed).toEqual(["record_note"]);
			// Both responses were consumed: the loop kept going after the tool batch.
			expect(faux.callCount).toBe(2);
			expect(toolResults(session.messages)).toHaveLength(1);
		} finally {
			session.dispose();
		}
	});

	it("keeps the baseline behaviour when no callback is provided", async () => {
		const executed: string[] = [];
		const { session, faux } = await createSession({ responses: TOOL_CALL_RESPONSES, executed });

		const agentEvents: AgentEvent[] = [];
		session.agent.subscribe((event) => {
			agentEvents.push(event);
		});

		try {
			expect(session.agent.shouldStopAfterTurn).toBeUndefined();

			await session.prompt("record a note");

			expect(executed).toEqual(["record_note"]);
			expect(faux.callCount).toBe(2);
			expect(toolResults(session.messages)).toHaveLength(1);
			expect(agentEvents.some((event) => event.type === "agent_end")).toBe(true);
		} finally {
			session.dispose();
		}
	});
});

describe("AgentSession enableBuiltInEnhancementTools", () => {
	it("does not register the goal tools when disabled", async () => {
		const { session } = await createSession({ enableBuiltInEnhancementTools: false });
		try {
			const names = session.getAllTools().map((tool) => tool.name);
			expect(names).not.toContain("get_goal");
			expect(names).not.toContain("create_goal");
			expect(names).not.toContain("update_goal");
			// Regular built-in tools are unaffected by the switch.
			expect(names).toContain("read");
		} finally {
			session.dispose();
		}
	});

	it("registers the goal tools when the option is omitted", async () => {
		const { session } = await createSession();
		try {
			const names = session.getAllTools().map((tool) => tool.name);
			expect(names).toContain("get_goal");
			expect(names).toContain("create_goal");
			expect(names).toContain("update_goal");
		} finally {
			session.dispose();
		}
	});
});
