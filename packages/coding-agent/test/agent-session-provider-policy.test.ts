/**
 * Tests for the extension provider mutation policy.
 *
 * Default "mutable" keeps the official pi.registerProvider/unregisterProvider
 * behavior including current-model refresh; "read-only" makes load-phase and
 * runtime provider mutations side-effect-free no-ops while extension tools and
 * events stay intact.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionProviderPolicy } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ProviderConfig } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession, type ExtensionFactory } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function providerConfig(modelId: string): ProviderConfig {
	return {
		baseUrl: "https://provider.test/v1",
		apiKey: "provider-test-key",
		api: "openai-completions",
		models: [
			{
				id: modelId,
				name: "Test Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	};
}

describe("AgentSession extension provider policy", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-provider-policy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(
		factories: ExtensionFactory[],
		policy?: ExtensionProviderPolicy,
	): Promise<{ session: import("../src/core/agent-session.ts").AgentSession; modelRegistry: ModelRegistry }> {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: factories,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			authStorage,
			resourceLoader,
			extensionProviderPolicy: policy,
		});

		return { session, modelRegistry: session.modelRegistry };
	}

	function registerToolFactory(pi: import("../src/core/extensions/types.ts").ExtensionAPI): void {
		pi.registerTool({
			name: "policy-tool",
			label: "policy-tool",
			description: "Policy tool",
			parameters: Type.Object({}),
			execute: async () => ({ result: "ok" }),
		});
	}

	it("mutable (default) keeps official provider registration behavior including current-model refresh", async () => {
		const { session, modelRegistry } = await createSession([
			(pi) => {
				pi.registerProvider("policy-provider", providerConfig("policy-model"));
				registerToolFactory(pi);
			},
		]);

		// Load-phase pending registration was flushed to the shared registry.
		expect(modelRegistry.find("policy-provider", "policy-model")).toBeDefined();
		expect(session.getAllTools().some((tool) => tool.name === "policy-tool")).toBe(true);

		// Runtime register/unregister take effect immediately.
		const runtime = session.resourceLoader.getExtensions().runtime;
		runtime.registerProvider("runtime-provider", providerConfig("runtime-model"));
		expect(modelRegistry.find("runtime-provider", "runtime-model")).toBeDefined();
		runtime.unregisterProvider("runtime-provider");
		expect(modelRegistry.find("runtime-provider", "runtime-model")).toBeUndefined();

		// Provider change refreshes the current model object.
		const modelBefore = session.model;
		runtime.registerProvider("anthropic", { ...providerConfig("claude-sonnet-4-5"), api: "anthropic-messages" });
		expect(session.model).not.toBe(modelBefore);
		expect(modelRegistry.find("anthropic", "claude-sonnet-4-5")?.baseUrl).toBe("https://provider.test/v1");

		await session.dispose();
	});

	it("read-only leaves the shared ModelRegistry unchanged for load and runtime registrations", async () => {
		const { session, modelRegistry } = await createSession(
			[
				(pi) => {
					pi.registerProvider("policy-provider", providerConfig("policy-model"));
					registerToolFactory(pi);
				},
			],
			"read-only",
		);

		// Load-phase pending registration was a no-op.
		expect(modelRegistry.find("policy-provider", "policy-model")).toBeUndefined();
		// Extension tools still bind.
		expect(session.getAllTools().some((tool) => tool.name === "policy-tool")).toBe(true);

		// Runtime register/unregister are side-effect-free no-ops.
		const runtime = session.resourceLoader.getExtensions().runtime;
		runtime.registerProvider("runtime-provider", providerConfig("runtime-model"));
		expect(modelRegistry.find("runtime-provider", "runtime-model")).toBeUndefined();
		expect(() => runtime.unregisterProvider("runtime-provider")).not.toThrow();

		// Provider mutation must not refresh the current model.
		const modelBefore = session.model;
		runtime.registerProvider("anthropic", { ...providerConfig("claude-sonnet-4-5"), api: "anthropic-messages" });
		expect(session.model).toBe(modelBefore);
		expect(modelRegistry.find("anthropic", "claude-sonnet-4-5")?.baseUrl).not.toBe("https://provider.test/v1");

		await session.dispose();
	});

	it("read-only makes session_start registrations no-ops but keeps extension events working", async () => {
		let agentStartFired = 0;
		const { session, modelRegistry } = await createSession(
			[
				(pi) => {
					pi.on("session_start", () => {
						pi.registerProvider("session-provider", providerConfig("session-model"));
					});
					pi.on("agent_start", () => {
						agentStartFired++;
					});
				},
			],
			"read-only",
		);

		await session.bindExtensions({});

		expect(modelRegistry.find("session-provider", "session-model")).toBeUndefined();
		expect(agentStartFired).toBe(0);

		await session.extensionRunner.emit({ type: "agent_start" });
		expect(agentStartFired).toBe(1);

		await session.dispose();
	});

	it("read-only policy is held across reload-created runners", async () => {
		const { session, modelRegistry } = await createSession(
			[
				(pi) => {
					pi.registerProvider("policy-provider", providerConfig("policy-model"));
					registerToolFactory(pi);
				},
			],
			"read-only",
		);

		expect(modelRegistry.find("policy-provider", "policy-model")).toBeUndefined();

		await session.reload();

		// The reloaded loader's pending registrations were flushed through the
		// same read-only no-op actions.
		expect(modelRegistry.find("policy-provider", "policy-model")).toBeUndefined();
		expect(session.getAllTools().some((tool) => tool.name === "policy-tool")).toBe(true);

		// Runtime mutation on the reloaded runner is also a no-op.
		session.resourceLoader.getExtensions().runtime.registerProvider("post-reload-provider", providerConfig("post-model"));
		expect(modelRegistry.find("post-reload-provider", "post-model")).toBeUndefined();

		await session.dispose();
	});

	it("mutable policy still flushes on reload-created runners", async () => {
		const { session, modelRegistry } = await createSession([
			(pi) => {
				pi.registerProvider("policy-provider", providerConfig("policy-model"));
				registerToolFactory(pi);
			},
		]);

		expect(modelRegistry.find("policy-provider", "policy-model")).toBeDefined();

		await session.reload();

		expect(modelRegistry.find("policy-provider", "policy-model")).toBeDefined();
		expect(session.getAllTools().some((tool) => tool.name === "policy-tool")).toBe(true);

		await session.dispose();
	});
});
