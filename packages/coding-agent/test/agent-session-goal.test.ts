import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getModel, type Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function createUsage(input: number, output = 0): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function createAssistantMessage(usage: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createSession(sessionManager = SessionManager.inMemory()) {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "high",
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

describe("AgentSession goals", () => {
	it("persists goal state and restores it from the session entries", () => {
		const { session, sessionManager } = createSession();
		try {
			const created = session.createGoal({ objective: "Ship the feature", tokenBudget: 100 });
			expect(created.status).toBe("active");
			expect(created.tokensUsed).toBe(0);

			session.updateGoal({ status: "paused" });
			expect(session.goal?.status).toBe("paused");
		} finally {
			session.dispose();
		}

		const restored = createSession(sessionManager);
		try {
			expect(restored.session.goal?.objective).toBe("Ship the feature");
			expect(restored.session.goal?.status).toBe("paused");
			expect(restored.session.goal?.tokenBudget).toBe(100);
		} finally {
			restored.session.dispose();
		}
	});

	it("accounts assistant usage and budget-limits the active goal", async () => {
		const { session } = createSession();
		const events: string[] = [];
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "goal_update") {
				events.push(event.goal?.status ?? "none");
			}
		});

		try {
			session.createGoal({ objective: "Stay within budget", tokenBudget: 10 });
			const message = createAssistantMessage(createUsage(7, 5));
			await (
				session as unknown as {
					_handleAgentEvent(event: unknown): Promise<void>;
				}
			)._handleAgentEvent({
				type: "message_end",
				message,
			});

			expect(session.goal?.tokensUsed).toBe(12);
			expect(session.goal?.status).toBe("budget_limited");
			expect(events).toContain("budget_limited");
		} finally {
			unsubscribe();
			session.dispose();
		}
	});
});
