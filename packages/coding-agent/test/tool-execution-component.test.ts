import { join, resolve } from "node:path";
import { Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { getReadmePath } from "../src/config.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: Array<{ type: string; text?: string }>; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("bash renderer does not duplicate final full output truncation details", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) {
					onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		const result = await tool.execute(
			"tool-bash-1b",
			{ command: "generate output" },
			undefined,
			undefined,
			{} as never,
		);
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-1b",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ ...result, isError: false }, false);

		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered.match(/Full output:/g)?.length ?? 0).toBe(1);
		expect(rendered).toMatch(/line-4000[^\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).not.toMatch(/line-4000[^\n]*\n[^\S\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).toContain("Truncated: showing 2000 of 4000 lines");
		expect(rendered).not.toContain("[Showing lines 2001-4000 of 4000. Full output:");
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bread\b/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "notes.txt" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("falls back when custom renderers are absent", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom_tool");
		expect(rendered).toContain("done");
	});

	test("trims trailing blank display lines from write previews", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("trims trailing blank display lines from read results", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("collapses ordinary read results until expanded", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-ordinary-read-collapsed",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "hidden content" }], details: undefined, isError: false },
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("read");
		expect(collapsed).toContain("notes.txt");
		expect(collapsed).not.toContain("hidden content");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("hidden content");
	});

	for (const scenario of [
		{
			title: "SKILL.md",
			path: join(process.cwd(), "attio", "SKILL.md"),
			content: "---\nname: attio\ndescription: CRM helper\n---\n\n# Hidden skill instructions",
			compact: "[skill] attio",
			hidden: "Hidden skill instructions",
			absent: "read skill attio",
		},
		{
			title: "AGENTS.md",
			path: join(process.cwd(), ".pi", "AGENTS.md"),
			content: "Hidden resource instructions",
			compact: "read resource .pi/AGENTS.md",
			hidden: "Hidden resource instructions",
			absent: undefined,
		},
		{
			title: "outside AGENTS.md",
			path: resolve(process.cwd(), "..", "AGENTS.md"),
			content: "Hidden outside resource instructions",
			compact: `read resource ${resolve(process.cwd(), "..", "AGENTS.md").replace(/\\/g, "/")}`,
			hidden: "Hidden outside resource instructions",
			absent: undefined,
		},
		{
			title: "Pi documentation",
			path: getReadmePath(),
			content: "Hidden docs content",
			compact: "read docs README.md",
			hidden: "Hidden docs content",
			absent: undefined,
		},
	] as const) {
		test(`renders ${scenario.title} read results compactly until expanded`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-${scenario.title}`,
				{ path: scenario.path },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: scenario.content }], details: undefined, isError: false },
				false,
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed).not.toContain(scenario.hidden);
			if (scenario.absent) {
				expect(collapsed).not.toContain(scenario.absent);
			}

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(120).join("\n"));
			expect(expanded).toContain(scenario.hidden);
		});
	}

	for (const scenario of [
		{ title: "SKILL.md", path: join(process.cwd(), "attio", "SKILL.md"), compact: "[skill] attio:120-329" },
		{ title: "Pi documentation", path: getReadmePath(), compact: "read docs README.md:120-329" },
	] as const) {
		test(`shows the read line range in compact ${scenario.title} reads before the expand hint`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-range-${scenario.title}`,
				{ path: scenario.path, offset: 120, limit: 210 },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed.indexOf(":120-329")).toBeLessThan(collapsed.indexOf("to expand"));
		});
	}
});

describe("ToolExecutionComponent compact presentation", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function renderText(component: ToolExecutionComponent, width = 100): string {
		return stripAnsi(component.render(width).join("\n"));
	}

	test("keeps the legacy read rendering when describe is absent", () => {
		const component = new ToolExecutionComponent(
			"read",
			"legacy-read",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = renderText(component);
		expect(rendered).toContain("read");
		expect(rendered).toContain("notes.txt");
		expect(rendered).not.toContain("Done");
	});

	test("shows a compact read line and the full output after expand", () => {
		const component = new ToolExecutionComponent(
			"read",
			"compact-read",
			{ path: "test/setup.ts", offset: 1, limit: 80 },
			{ describe: () => undefined },
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.setArgsComplete();
		component.markExecutionStarted();
		let rendered = renderText(component);
		expect(rendered).toContain("Processing");
		expect(rendered).toContain("read");
		expect(rendered).toContain("test/setup.ts");
		expect(rendered).toContain("lines 1–80");

		component.updateResult(
			{ content: [{ type: "text", text: "hidden content" }], details: undefined, isError: false },
			false,
		);
		rendered = renderText(component);
		expect(rendered).toContain("Done");
		expect(rendered).not.toContain("hidden content");
		expect(rendered.split("\n").filter((line) => line.trim()).length).toBe(1);

		const item = component.getHistoryItem("read-history");
		expect(item.id).toBe("read-history");
		expect(item.kind).toBe("tool");
		expect(item.label).toContain("Done");
		expect(item.label).not.toContain("\n");
		expect(item.detail?.()).toContain("path: test/setup.ts");
		expect(item.detail?.()).toContain("hidden content");

		component.setExpanded(true);
		expect(renderText(component)).toContain("hidden content");
	});

	test("uses a historical file_path for read", () => {
		const component = new ToolExecutionComponent(
			"read",
			"compact-file-path",
			{ file_path: "历史/说明.ts" },
			{ describe: () => undefined },
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.setArgsComplete();
		expect(renderText(component)).toContain("历史/说明.ts");
	});

	test("keeps a failed bash reason while collapsing the rest", () => {
		const command = `npm run test:unit\n--watch ${"项目模块".repeat(12)}`;
		const component = new ToolExecutionComponent(
			"bash",
			"compact-bash",
			{ command },
			{ describe: () => undefined },
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{
				content: [
					{
						type: "text",
						text: "Missing script: test:unit\nsecond reason\nthird reason\nFOURTH-UNIQUE",
					},
				],
				details: {
					fullOutputPath: "/tmp/bash-full.txt",
					truncation: { truncated: true, truncatedBy: "lines", outputLines: 2, totalLines: 9 },
				},
				isError: true,
			},
			false,
		);

		const wide = component.render(100);
		for (const line of wide) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		const rendered = stripAnsi(wide.join("\n"));
		expect(rendered).toContain("Failed");
		expect(rendered).toContain("bash");
		expect(rendered).toContain("npm run test:unit");
		expect(rendered).toContain("Missing script: test:unit");
		expect(rendered).not.toContain("FOURTH-UNIQUE");
		expect(wide.length).toBeLessThanOrEqual(4);
		const narrow = component.render(36);
		for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(36);

		const detail = component.getHistoryItem("bash-history").detail?.() ?? "";
		expect(detail).toContain("FOURTH-UNIQUE");
		expect(detail).toContain("Full output: /tmp/bash-full.txt");
		expect(detail).toContain("Truncated: showing 2 of 9 lines");
		expect(detail).toContain("--watch");

		component.setExpanded(true);
		expect(renderText(component, 80)).toContain("FOURTH-UNIQUE");
	});

	test("restores an edit diff from the saved result", async () => {
		const diff = "  context\n-old\n+UNIQUE_DIFF_LINE\n";
		const component = new ToolExecutionComponent(
			"edit",
			"compact-edit",
			{
				path: "src/项目.ts",
				edits: [
					{ oldText: "a", newText: "b" },
					{ oldText: "c", newText: "d" },
				],
			},
			{ describe: () => undefined },
			createEditToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.setArgsComplete();
		component.updateResult(
			{
				content: [{ type: "text", text: "Successfully replaced 2 block(s) in src/项目.ts." }],
				details: { diff, firstChangedLine: 3 },
				isError: false,
			},
			false,
		);

		const collapsed = renderText(component, 80);
		expect(collapsed).toContain("Done");
		expect(collapsed).toContain("edit");
		expect(collapsed).toContain("src/项目.ts");
		expect(collapsed).toContain("2 replacements");
		expect(collapsed).toContain("line 3");
		expect(collapsed).not.toContain("UNIQUE_DIFF_LINE");

		const detail = component.getHistoryItem("edit-history").detail?.() ?? "";
		expect(detail).toContain("  context");
		expect(detail).toContain("+UNIQUE_DIFF_LINE");

		component.setExpanded(true);
		expect(renderText(component, 100)).toContain("UNIQUE_DIFF_LINE");
		await new Promise((resolve) => setTimeout(resolve, 40));
		const later = renderText(component, 100);
		expect(later).toContain("UNIQUE_DIFF_LINE");
		expect(later).not.toContain("ENOENT");
	});

	test("summarizes grep without treating output lines as hits", () => {
		const component = new ToolExecutionComponent(
			"grep",
			"compact-grep",
			{ pattern: "createSession", path: "test/", limit: 20 },
			{ describe: () => undefined },
			createGrepToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "a\ncontext around the match\nb\ncontext around the match\n" }],
				details: undefined,
				isError: false,
			},
			false,
		);
		const rendered = renderText(component);
		expect(rendered).toContain("Done");
		expect(rendered).toContain("grep");
		expect(rendered).toContain('"createSession"');
		expect(rendered).toContain("test/");
		expect(rendered).toContain("limit 20");
		expect(rendered).not.toContain("context around");
		expect(rendered).not.toMatch(/\d+ matches/);

		component.setExpanded(true);
		expect(renderText(component)).toContain("context around the match");
	});

	test("keeps an unknown extension name and its arguments", () => {
		const code = "function f() {\n  return 1;\n}\n";
		const component = new ToolExecutionComponent(
			"mcp__docs__search",
			"compact-mcp",
			{ query: "会话历史", snippet: code },
			{ describe: () => undefined },
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [
					{ type: "text", text: code },
					{ type: "image", data: "aaaa", mimeType: "image/png" },
				],
				details: undefined,
				isError: false,
			},
			false,
		);
		const rendered = renderText(component, 48);
		expect(rendered).toContain("mcp__docs__search");
		expect(rendered).toContain("会话历史");
		expect(rendered).not.toContain("return 1");
		for (const line of component.render(28)) expect(visibleWidth(line)).toBeLessThanOrEqual(28);

		const detail = component.getHistoryItem("mcp-history").detail?.() ?? "";
		expect(detail).toContain("会话历史");
		expect(detail).toContain("  return 1;");
		expect(detail).toContain("[Image:");

		component.setExpanded(true);
		const expanded = renderText(component, 80);
		expect(expanded).toContain("return 1");
		expect(expanded).toContain("会话历史");
	});

	test("shows a cancelled request_user_input result", () => {
		const component = new ToolExecutionComponent(
			"request_user_input",
			"ask-1",
			{ questions: [{ id: "go", header: "Proceed", question: "Continue?" }] },
			{ describe: () => undefined },
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "User cancelled the input request." }],
				details: { response: { id: "1", answers: {}, cancelled: true } },
				isError: false,
			},
			false,
		);
		const rendered = renderText(component);
		expect(rendered).toContain("Cancelled");
		expect(rendered).toContain("Proceed");
		expect(rendered).toContain("User cancelled the input request.");
	});

	test("prefers describe status and still shows the tool error", () => {
		let status: "running" | "interrupted" | "failed" | "waiting-input" = "running";
		const component = new ToolExecutionComponent(
			"custom_tool",
			"describe-1",
			{ name: "child" },
			{
				describe: () => ({
					status,
					subject: "child",
					diagnostic: "adapter note",
				}),
			},
			createBaseToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		expect(renderText(component)).toContain("Processing");

		status = "waiting-input";
		component.refreshPresentation();
		expect(renderText(component)).toContain("Waiting");
		expect(renderText(component)).toContain("child");

		status = "interrupted";
		component.updateResult(
			{ content: [{ type: "text", text: "tool broke badly" }], details: {}, isError: true },
			false,
		);
		const rendered = renderText(component);
		expect(rendered).toContain("Interrupted");
		expect(rendered).toContain("tool broke badly");
		expect(rendered).not.toContain("adapter note");
	});

	test("uses a describe diagnostic when the tool result is not an error", () => {
		const component = new ToolExecutionComponent(
			"custom_tool",
			"describe-failed",
			{ name: "child" },
			{ describe: () => ({ status: "failed", diagnostic: "child task failed" }) },
			createBaseToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "still running" }], details: {}, isError: false },
			false,
		);
		const rendered = renderText(component);
		expect(rendered).toContain("Failed");
		expect(rendered).toContain("child task failed");
	});

	test("keeps partial text when a call finishes without a result", () => {
		const component = new ToolExecutionComponent(
			"read",
			"finish-read",
			{ path: "src/项目.ts", offset: 10, limit: 5 },
			{ describe: () => undefined },
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{ content: [{ type: "text", text: "partial output kept" }], details: undefined, isError: false },
			true,
		);
		component.finishWithoutResult("cancelled", "User cancelled");
		const rendered = renderText(component);
		expect(rendered).toContain("Cancelled");
		expect(rendered).toContain("User cancelled");
		expect(rendered).not.toContain("Successfully");
		expect(component.getHistoryItem("finish-read").detail?.()).toContain("partial output kept");
	});

	test("uses registered renderers and shared state when expanded", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition("ext.workspace.search"),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: () => new Text("custom result shared-token", 0, 0),
		};
		const component = new ToolExecutionComponent(
			"ext.workspace.search",
			"renderer-1",
			{ query: "会话历史" },
			{ describe: () => undefined },
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const collapsed = renderText(component);
		expect(collapsed).toContain("ext.workspace.search");
		expect(collapsed).not.toContain("custom call");

		component.setExpanded(true);
		const expanded = renderText(component);
		expect(expanded).toContain("custom call shared-token");
		expect(expanded).toContain("custom result shared-token");

		component.setExpanded(false);
		component.refreshPresentation();
		component.setExpanded(true);
		expect(renderText(component)).toContain("custom call shared-token");
	});

	test("clears a bash detail timer after the row collapses", () => {
		vi.useFakeTimers();
		try {
			const output = Array.from({ length: 20 }, (_, index) => `output-line-${index}`).join("\n");
			const component = new ToolExecutionComponent(
				"bash",
				"bash-timer",
				{ command: "echo hi" },
				{ describe: () => undefined },
				createBashToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			component.setExpanded(true);
			component.markExecutionStarted();
			component.updateResult(
				{ content: [{ type: "text", text: "output-line-0" }], details: undefined, isError: false },
				true,
			);
			expect(vi.getTimerCount()).toBeGreaterThan(0);

			component.setExpanded(false);
			component.updateResult(
				{ content: [{ type: "text", text: output }], details: undefined, isError: false },
				false,
			);
			expect(vi.getTimerCount()).toBe(0);
			expect(renderText(component, 80)).not.toContain("output-line-19");

			component.setExpanded(true);
			expect(renderText(component, 80)).toContain("output-line-19");
		} finally {
			vi.useRealTimers();
		}
	});

	test("fits a long Chinese command and a multiline error to the column width", () => {
		const command = `npm test -- ${"非常长的中文测试名称".repeat(8)}`;
		const component = new ToolExecutionComponent(
			"bash",
			"bash-width",
			{ command },
			{ describe: () => undefined },
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{
				content: [
					{
						type: "text",
						text: [
							"无法执行这段命令",
							"  at 项目/模块.ts:12",
							"    const value = 1;",
							"第四行不应该留在折叠行里",
						].join("\n"),
					},
				],
				details: undefined,
				isError: true,
			},
			false,
		);
		const lines = component.render(24);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		const rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("Failed");
		expect(rendered).toContain("bash");
		expect(rendered).not.toContain("第四行不应该留在折叠行里");
		expect(component.getHistoryItem("bash-width").detail?.()).toContain("    const value = 1;");
	});
});
