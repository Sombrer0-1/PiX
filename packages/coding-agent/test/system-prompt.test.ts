import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import type { AgentDefinition } from "../src/core/agents.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import type { Skill } from "../src/core/skills.ts";
import {
	buildSystemPrompt,
	definePromptFragment,
	getPromptFragmentMarkers,
	matchesPromptFragment,
	renderPromptFragment,
} from "../src/core/system-prompt.ts";
import { fauxModel } from "./test-harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("renders typed prompt fragments with stable markers", () => {
			const fragment = definePromptFragment({
				tag: "sample_context",
				role: "developer",
				source: "runtime",
				priority: 20,
				body: "Use the current runtime context.",
			});
			const rendered = renderPromptFragment(fragment);

			expect(rendered).toContain('<sample_context role="developer" source="runtime" priority="20">');
			expect(rendered).toContain("</sample_context>");
			expect(getPromptFragmentMarkers("sample_context")).toEqual({
				startMarker: "<sample_context",
				endMarker: "</sample_context>",
			});
			expect(matchesPromptFragment(rendered, "sample_context")).toBe(true);
			expect(matchesPromptFragment("<other_context>text</other_context>", "sample_context")).toBe(false);
		});

		test("renders core instructions as structured prompt fragments", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain('<role_and_scope role="system" source="base"');
			expect(prompt).toContain('<instruction_hierarchy role="system" source="base"');
			expect(prompt).toContain('<task_execution role="developer" source="base"');
			expect(prompt).toContain('<tool_use role="developer" source="tools"');
			expect(prompt).toContain('<context_boundaries role="developer" source="base"');
			expect(prompt).toContain('<environment_context role="developer" source="runtime"');
			expect(prompt).toContain("adapt to the user's actual task");
			expect(
				matchesPromptFragment(
					prompt.match(/<role_and_scope[\s\S]*?<\/role_and_scope>/)?.[0] ?? "",
					"role_and_scope",
				),
			).toBe(true);
		});

		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
		});

		test("marks project instructions as scoped context", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [{ path: "AGENTS.md", content: "Prefer local conventions." }],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain('<project_context role="user" source="project"');
			expect(prompt).toContain("listed from broadest to most specific");
			expect(prompt).toContain('<project_instructions path="AGENTS.md">');
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	describe("available agents", () => {
		const testAgent: AgentDefinition = {
			name: "scout",
			description: "Scout agent",
			systemPrompt: "Scout body",
			source: "user",
			tools: ["read", "grep"],
		};
		const testSkill: Skill = {
			name: "test-skill",
			description: "Test skill",
			filePath: "/tmp/skill.md",
			baseDir: "/tmp",
			sourceInfo: createSyntheticSourceInfo("/tmp/skill.md", { source: "custom" }),
			disableModelInvocation: false,
		};

		test("appends available agents after skills and before environment context in the default branch", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [testSkill],
				agents: [testAgent],
				cwd: process.cwd(),
			});

			const agentsIndex = prompt.indexOf("<available_agents>");
			const skillsIndex = prompt.indexOf("<available_skills>");
			const environmentIndex = prompt.indexOf('<environment_context role="developer" source="runtime"');

			expect(agentsIndex).toBeGreaterThan(-1);
			expect(skillsIndex).toBeGreaterThan(-1);
			expect(environmentIndex).toBeGreaterThan(-1);
			expect(agentsIndex).toBeGreaterThan(skillsIndex);
			expect(environmentIndex).toBeGreaterThan(agentsIndex);
			expect(prompt).toContain('name="scout"');
		});

		test("appends available agents after skills and before environment context in the custom branch", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "You are a custom assistant.",
				contextFiles: [],
				skills: [testSkill],
				agents: [testAgent],
				cwd: process.cwd(),
			});

			const agentsIndex = prompt.indexOf("<available_agents>");
			const skillsIndex = prompt.indexOf("<available_skills>");
			const environmentIndex = prompt.indexOf('<environment_context role="developer" source="runtime"');

			expect(agentsIndex).toBeGreaterThan(-1);
			expect(skillsIndex).toBeGreaterThan(-1);
			expect(environmentIndex).toBeGreaterThan(-1);
			expect(agentsIndex).toBeGreaterThan(skillsIndex);
			expect(environmentIndex).toBeGreaterThan(agentsIndex);
		});

		test("renders no agents section when no agents are provided", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("<available_agents>");
		});

		test("XML-escapes agent descriptions in both branches", () => {
			const agents: AgentDefinition[] = [
				{
					...testAgent,
					description: 'Scout "quoted" & <tagged> agent',
				},
			];

			const customPrompt = buildSystemPrompt({
				customPrompt: "You are a custom assistant.",
				contextFiles: [],
				skills: [],
				agents,
				cwd: process.cwd(),
			});
			expect(customPrompt).toContain("Scout &quot;quoted&quot; &amp; &lt;tagged&gt; agent");
			expect(customPrompt).not.toContain("Scout \"quoted\" & <tagged> agent");

			const defaultPrompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				agents,
				cwd: process.cwd(),
			});
			expect(defaultPrompt).toContain("Scout &quot;quoted&quot; &amp; &lt;tagged&gt; agent");
		});

		test("does not render the systemPrompt or filePath of agents", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				agents: [testAgent],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("Scout body");
			expect(prompt).not.toContain("filePath");
		});
	});

	describe("session-level agent injection", () => {
		test("injects the catalog only when the agent tool is active", async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "pi-prompt-agents-test-"));
			try {
				const agents: AgentDefinition[] = [
					{
						name: "scout",
						description: "Scout agent",
						systemPrompt: "Scout body",
						source: "user",
					},
				];
				const loader: ResourceLoader = {
					...createTestResourceLoader(),
					getAgents: () => ({ agents, diagnostics: [], projectAgentsDir: null }),
				};
				const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
				authStorage.setRuntimeApiKey(fauxModel.provider, "faux-key");
				const settingsManager = SettingsManager.create(tempDir, tempDir);
				const agentTool: ToolDefinition = {
					name: "agent",
					label: "agent",
					description: "Delegate a self-contained task",
					parameters: Type.Object({}),
					execute: async () => ({ result: "ok" }),
				};

				const { session: withAgentTool } = await createAgentSession({
					cwd: tempDir,
					agentDir: tempDir,
					model: fauxModel,
					authStorage,
					settingsManager,
					resourceLoader: loader,
					tools: ["agent"],
					customTools: [agentTool],
					sessionManager: SessionManager.inMemory(),
				});
				expect(withAgentTool.systemPrompt).toContain("<available_agents>");
				expect(withAgentTool.systemPrompt).toContain('name="scout"');
				await withAgentTool.dispose();

				const { session: withoutAgentTool } = await createAgentSession({
					cwd: tempDir,
					agentDir: tempDir,
					model: fauxModel,
					authStorage,
					settingsManager,
					resourceLoader: loader,
					tools: ["read"],
					sessionManager: SessionManager.inMemory(),
				});
				expect(withoutAgentTool.systemPrompt).not.toContain("<available_agents>");
				await withoutAgentTool.dispose();
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe("environment context", () => {
		test("includes OS and configured POSIX shell guidance", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: "C:\\Users\\me\\project",
				runtimeEnvironment: {
					platform: "win32",
					osName: "Windows",
					timezone: "Asia/Shanghai",
					shell: {
						path: "C:\\Program Files\\Git\\bin\\bash.exe",
						args: ["-c"],
					},
				},
			});

			expect(prompt).toContain('<environment_context role="developer" source="runtime"');
			expect(prompt).toContain("Timezone: Asia/Shanghai");
			expect(prompt).toContain("Current working directory: C:/Users/me/project");
			expect(prompt).toContain("Operating system: Windows (win32)");
			expect(prompt).toContain("Execution mode: approval mode");
			expect(prompt).toContain("Verification gate: enabled for code/configuration changes");
			expect(prompt).toContain("Command shell for bash tool: C:\\Program Files\\Git\\bin\\bash.exe -c");
			expect(prompt).toContain("Shell syntax for bash tool: POSIX shell/bash syntax.");
			expect(prompt).toContain("use /dev/null to discard output");
			expect(prompt).toContain("do not use bare NUL/nul redirection");
		});

		test("describes unavailable shell instead of hiding it", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: "/workspace",
				runtimeEnvironment: {
					platform: "win32",
					shell: {
						error: "No bash shell found",
					},
				},
			});

			expect(prompt).toContain("Command shell for bash tool: unavailable (No bash shell found)");
			expect(prompt).toContain("bash tool calls may fail");
		});
	});
});
