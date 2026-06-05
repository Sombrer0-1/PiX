import { describe, expect, test } from "vitest";
import {
	buildSystemPrompt,
	definePromptFragment,
	getPromptFragmentMarkers,
	matchesPromptFragment,
	renderPromptFragment,
} from "../src/core/system-prompt.ts";

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
