/**
 * Tests for the host-injected tool policy override on AgentSession.
 *
 * The override is synchronous, consulted before the built-in execution-mode
 * policy, authoritative when it returns a decision, and survives extension
 * reloads and tool registry refreshes. A throwing override fails closed
 * (allowed:false, host_policy_error) instead of falling back to allow.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix as posixPath } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { HostToolPolicyInput, HostToolPolicyOverride } from "../src/core/tool-execution-policy.ts";
import type { ExecutionBackend, ToolPathContext } from "../src/core/tools/execution-backend.ts";
import { createFauxStreamFn, fauxModel, type FauxResponseInput } from "./test-harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

function makeTempDir(): string {
	const dir = join(tmpdir(), `pi-host-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makePosixPathContext(home = "/home/user"): ToolPathContext {
	return {
		pathStyle: "posix",
		homeDir: home,
		resolvePath: (input, cwd) => posixPath.resolve(cwd, input),
	};
}

/** Fake tools that record every executed name. */
function recordingTools(names: string[]): { tools: Record<string, AgentTool>; executed: string[] } {
	const executed: string[] = [];
	const tools: Record<string, AgentTool> = {};
	for (const name of names) {
		tools[name] = {
			name,
			label: name,
			description: `${name} fake tool`,
			parameters: Type.Object({}),
			execute: async () => {
				executed.push(name);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
	}
	return { tools, executed };
}

/** Build a minimal AgentSession wired with a faux model and in-memory deps. */
function makeSession(options: {
	tempDir: string;
	hostToolPolicyOverride?: HostToolPolicyOverride;
	executionBackend?: ExecutionBackend;
	runtimeCwd?: string;
	responses?: FauxResponseInput[];
	tools?: Record<string, AgentTool>;
}): AgentSession {
	const { streamFn } = createFauxStreamFn(options.responses ?? ["ok"]);
	const agent = new Agent({
		getApiKey: () => "faux-key",
		initialState: { model: fauxModel, systemPrompt: "test", tools: [] },
		streamFn,
	});
	const sessionManager = SessionManager.inMemory(options.tempDir);
	const settingsManager = SettingsManager.create(options.tempDir, options.tempDir);
	const authStorage = AuthStorage.create(join(options.tempDir, "auth.json"));
	authStorage.setRuntimeApiKey(fauxModel.provider, "faux-key");
	const modelRegistry = ModelRegistry.create(authStorage, options.tempDir);
	return new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: options.tempDir,
		runtimeCwd: options.runtimeCwd,
		executionBackend: options.executionBackend,
		hostToolPolicyOverride: options.hostToolPolicyOverride,
		modelRegistry,
		resourceLoader: createTestResourceLoader(),
		baseToolsOverride: options.tools,
	});
}

function toolResultTexts(session: AgentSession): string[] {
	return session.messages
		.filter((m) => m.role === "toolResult")
		.map((m) => JSON.stringify(m.content));
}

describe("AgentSession host tool policy override", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("override allow wins over the read-only default policy", async () => {
		const { tools, executed } = recordingTools(["bash"]);
		const inputs: HostToolPolicyInput[] = [];
		const override: HostToolPolicyOverride = (input) => {
			inputs.push(input);
			return { allowed: true };
		};
		const session = makeSession({
			tempDir,
			hostToolPolicyOverride: override,
			responses: [{ toolCalls: [{ name: "bash", args: { command: "pwd" } }] }, "done"],
			tools,
		});
		try {
			session.settingsManager.setExecutionMode("read-only");
			await session.prompt("run a command");

			expect(executed).toEqual(["bash"]);
			expect(inputs).toHaveLength(1);
			expect(inputs[0]).toMatchObject({
				mode: "read-only",
				toolName: "bash",
				args: { command: "pwd" },
				cwd: tempDir,
			});
			expect(inputs[0].pathContext).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("override deny blocks the tool with its reason", async () => {
		const { tools, executed } = recordingTools(["bash"]);
		const override: HostToolPolicyOverride = () => ({ allowed: false, reason: "blocked by host policy" });
		const session = makeSession({
			tempDir,
			hostToolPolicyOverride: override,
			responses: [{ toolCalls: [{ name: "bash", args: { command: "pwd" } }] }, "done"],
			tools,
		});
		try {
			await session.prompt("run a command");

			expect(executed).toEqual([]);
			expect(toolResultTexts(session)).toEqual([expect.stringContaining("blocked by host policy")]);
		} finally {
			await session.dispose();
		}
	});

	it("undefined override falls back to the built-in execution-mode policy", async () => {
		const { tools, executed } = recordingTools(["bash"]);
		const override: HostToolPolicyOverride = () => undefined;
		const session = makeSession({
			tempDir,
			hostToolPolicyOverride: override,
			responses: [{ toolCalls: [{ name: "bash", args: { command: "pwd" } }] }, "done"],
			tools,
		});
		try {
			session.settingsManager.setExecutionMode("read-only");
			await session.prompt("run a command");

			expect(executed).toEqual([]);
			expect(toolResultTexts(session)).toEqual([
				expect.stringContaining("Read-only mode only allows read, grep, find, and ls"),
			]);
		} finally {
			await session.dispose();
		}
	});

	it("read-only planning allowlist works through the override while other tools are denied", async () => {
		// Mirrors the PlanController override contract: planning/revising allowlist
		// gets allowed:true (so read-only planning tools still run); everything
		// else (including unknown extension/MCP tools) gets allowed:false.
		const { tools, executed } = recordingTools(["submit_user_plan", "bash"]);
		const override: HostToolPolicyOverride = (input) =>
			input.toolName === "submit_user_plan"
				? { allowed: true }
				: { allowed: false, reason: `not in plan allowlist: ${input.toolName}` };
		const session = makeSession({
			tempDir,
			hostToolPolicyOverride: override,
			responses: [
				{ toolCalls: [{ name: "submit_user_plan", args: { title: "t" } }] },
				{ toolCalls: [{ name: "bash", args: { command: "pwd" } }] },
				"done",
			],
			tools,
		});
		try {
			session.settingsManager.setExecutionMode("read-only");
			await session.prompt("plan and then act");

			expect(executed).toEqual(["submit_user_plan"]);
			const texts = toolResultTexts(session);
			expect(texts).toHaveLength(2);
			expect(texts[0]).toContain("ok");
			expect(texts[1]).toContain("not in plan allowlist: bash");
			// The denial came from the host override, not the read-only default.
			expect(texts[1]).not.toContain("Read-only mode");
		} finally {
			await session.dispose();
		}
	});

	it("a throwing host override fails closed with host_policy_error", async () => {
		const { tools, executed } = recordingTools(["bash"]);
		const override: HostToolPolicyOverride = () => {
			throw new Error("host policy exploded");
		};
		const session = makeSession({
			tempDir,
			hostToolPolicyOverride: override,
			responses: [{ toolCalls: [{ name: "bash", args: { command: "pwd" } }] }, "done"],
			tools,
		});
		try {
			await session.prompt("run a command");

			expect(executed).toEqual([]);
			expect(toolResultTexts(session)).toEqual([expect.stringContaining("host_policy_error")]);
		} finally {
			await session.dispose();
		}
	});

	it("override survives reload and refreshTools without being bypassed", async () => {
		// Deny-based: the built-in policy would allow bash in approval mode, so
		// every executed bash proves the override was lost. A vacuous
		// allow-override test would keep passing even if reload dropped the host
		// callback, because the default policy lets bash through anyway.
		const { tools, executed } = recordingTools(["bash"]);
		const override: HostToolPolicyOverride = () => ({ allowed: false, reason: "host deny persists" });
		const session = makeSession({
			tempDir,
			hostToolPolicyOverride: override,
			responses: [{ toolCalls: [{ name: "bash", args: { command: "pwd" } }] }, "done"],
			tools,
		});
		try {
			await session.prompt("first run");
			expect(executed).toEqual([]);
			expect(toolResultTexts(session)).toEqual([expect.stringContaining("host deny persists")]);

			// Reload replaces the extension runner but must keep the host callback.
			await session.reload();
			await session.prompt("after reload");
			expect(executed).toEqual([]);
			expect(toolResultTexts(session)[1]).toContain("host deny persists");

			// A registry refresh must not install a bypass for the host policy.
			session.resourceLoader.getExtensions().runtime.refreshTools();
			await session.prompt("after refreshTools");
			expect(executed).toEqual([]);
			expect(toolResultTexts(session)[2]).toContain("host deny persists");
		} finally {
			await session.dispose();
		}
	});

	it("passes the execution backend path context and runtime cwd to the override", async () => {
		const { tools, executed } = recordingTools(["bash"]);
		const inputs: HostToolPolicyInput[] = [];
		const override: HostToolPolicyOverride = (input) => {
			inputs.push(input);
			return { allowed: true };
		};
		const backend: ExecutionBackend = {
			paths: makePosixPathContext(),
			getCwd: () => "/home/user/project",
		};
		const session = makeSession({
			tempDir,
			hostToolPolicyOverride: override,
			executionBackend: backend,
			runtimeCwd: "/home/user/project",
			responses: [{ toolCalls: [{ name: "bash", args: { command: "pwd" } }] }, "done"],
			tools,
		});
		try {
			await session.prompt("run a command");

			expect(executed).toEqual(["bash"]);
			expect(inputs[0].cwd).toBe("/home/user/project");
			expect(inputs[0].pathContext?.pathStyle).toBe("posix");
			expect(inputs[0].pathContext?.homeDir).toBe("/home/user");
		} finally {
			await session.dispose();
		}
	});
});
