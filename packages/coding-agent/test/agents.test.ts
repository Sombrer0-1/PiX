/**
 * Tests for agent definition discovery, parsing, scope resolution and prompt formatting.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BUILTIN_AGENTS,
	formatAgentsForPrompt,
	loadAgents,
	loadAgentsFromDir,
	MAX_AVAILABLE_AGENTS_PROMPT_BYTES,
	MAX_AGENTS_PER_SOURCE,
	resolveAgentsForScope,
	type AgentDefinition,
} from "../src/core/agents.ts";

function writeAgent(dir: string, filename: string, frontmatter: string, body = "Agent body"): string {
	const filePath = join(dir, filename);
	writeFileSync(filePath, `---\n${frontmatter}\n---\n\n${body}`);
	return filePath;
}

describe("loadAgentsFromDir", () => {
	let tempDir: string;
	let agentsDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-agents-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentsDir = join(tempDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("discovers direct child .md files with filename-sorted deterministic order", () => {
		writeAgent(agentsDir, "b-agent.md", "name: b-agent\ndescription: B agent");
		writeAgent(agentsDir, "a-agent.md", "name: a-agent\ndescription: A agent");
		writeAgent(agentsDir, "c-agent.md", "name: c-agent\ndescription: C agent");

		const { agents, diagnostics } = loadAgentsFromDir({ dir: agentsDir, source: "user" });

		expect(diagnostics).toEqual([]);
		expect(agents.map((agent) => agent.name)).toEqual(["a-agent", "b-agent", "c-agent"]);
	});

	it("parses the file body as the system prompt", () => {
		writeAgent(agentsDir, "scout.md", "name: scout\ndescription: Scout agent", "Inspect the repository and report findings.");

		const { agents } = loadAgentsFromDir({ dir: agentsDir, source: "project" });

		expect(agents).toHaveLength(1);
		expect(agents[0]?.systemPrompt).toBe("Inspect the repository and report findings.");
		expect(agents[0]?.source).toBe("project");
		expect(agents[0]?.filePath).toBe(join(agentsDir, "scout.md"));
		expect(agents[0]?.baseDir).toBe(agentsDir);
	});

	it("ignores non-markdown files and missing directories", () => {
		writeFileSync(join(agentsDir, "notes.txt"), "not an agent");
		writeAgent(agentsDir, "ok.md", "name: ok\ndescription: OK agent");

		const result = loadAgentsFromDir({ dir: agentsDir, source: "user" });
		expect(result.agents.map((agent) => agent.name)).toEqual(["ok"]);
		expect(result.diagnostics).toEqual([]);

		const missing = loadAgentsFromDir({ dir: join(tempDir, "missing"), source: "user" });
		expect(missing.agents).toEqual([]);
		expect(missing.diagnostics).toEqual([]);
	});

	it("normalizes tools as YAML array with trim and stable dedupe", () => {
		writeAgent(agentsDir, "a.md", 'name: a\ndescription: A\ntools:\n  - read\n  - " bash "\n  - read\n  - grep');
		writeAgent(agentsDir, "b.md", 'name: b\ndescription: B\ntools: "read, , bash"');

		const { agents, diagnostics } = loadAgentsFromDir({ dir: agentsDir, source: "user" });

		expect(diagnostics).toEqual([]);
		expect(agents.find((agent) => agent.name === "a")?.tools).toEqual(["read", "bash", "grep"]);
		expect(agents.find((agent) => agent.name === "b")?.tools).toEqual(["read", "bash"]);
	});

	it("normalizes a lone '*' to undefined (all tools) and preserves an explicit empty array", () => {
		writeAgent(agentsDir, "star-array.md", 'name: star-array\ndescription: Star\ntools: ["*"]');
		writeAgent(agentsDir, "star-scalar.md", 'name: star-scalar\ndescription: Star\ntools: "*"');
		writeAgent(agentsDir, "empty-array.md", "name: empty-array\ndescription: Empty\ntools: []");
		writeAgent(agentsDir, "no-tools.md", "name: no-tools\ndescription: None");

		const { agents, diagnostics } = loadAgentsFromDir({ dir: agentsDir, source: "user" });

		expect(diagnostics).toEqual([]);
		expect(agents.find((agent) => agent.name === "star-array")?.tools).toBeUndefined();
		expect(agents.find((agent) => agent.name === "star-scalar")?.tools).toBeUndefined();
		expect(agents.find((agent) => agent.name === "empty-array")?.tools).toEqual([]);
		expect(agents.find((agent) => agent.name === "no-tools")?.tools).toBeUndefined();
	});

	it("rejects '*' mixed with concrete tool names", () => {
		writeAgent(agentsDir, "mixed.md", 'name: mixed\ndescription: Mixed\ntools: ["*", "read"]');

		const { agents, diagnostics } = loadAgentsFromDir({ dir: agentsDir, source: "user" });

		expect(agents).toEqual([]);
		expect(diagnostics.some((d) => d.type === "error" && d.path === join(agentsDir, "mixed.md"))).toBe(true);
	});

	it("rejects '*' in disallowedTools and accepts concrete names", () => {
		writeAgent(agentsDir, "deny-star.md", 'name: deny-star\ndescription: Deny star\ndisallowedTools: ["*"]');
		writeAgent(agentsDir, "deny-names.md", 'name: deny-names\ndescription: Deny names\ndisallowedTools: ["bash", "bash", " edit "]');

		const { agents, diagnostics } = loadAgentsFromDir({ dir: agentsDir, source: "user" });

		expect(agents.map((agent) => agent.name)).toEqual(["deny-names"]);
		expect(agents[0]?.disallowedTools).toEqual(["bash", "edit"]);
		expect(diagnostics.some((d) => d.path === join(agentsDir, "deny-star.md"))).toBe(true);
	});

	it("skips invalid names with diagnostics while other files load", () => {
		writeAgent(agentsDir, "upper.md", "name: UpperCase\ndescription: Upper");
		writeAgent(agentsDir, "underscore.md", "name: bad_name\ndescription: Underscore");
		writeAgent(agentsDir, "double-hyphen.md", "name: bad--name\ndescription: Double hyphen");
		writeAgent(agentsDir, "leading-hyphen.md", "name: -bad\ndescription: Leading hyphen");
		writeAgent(agentsDir, "too-long.md", `name: ${"a".repeat(65)}\ndescription: Too long`);
		writeAgent(agentsDir, "valid.md", "name: valid\ndescription: Valid");

		const { agents, diagnostics } = loadAgentsFromDir({ dir: agentsDir, source: "user" });

		expect(agents.map((agent) => agent.name)).toEqual(["valid"]);
		expect(diagnostics.filter((d) => d.type === "error")).toHaveLength(5);
	});

	it("skips invalid descriptions, models, maxTurns and colors with diagnostics", () => {
		writeAgent(agentsDir, "empty-desc.md", "name: empty-desc\ndescription: \"\"");
		writeAgent(agentsDir, "ws-desc.md", "name: ws-desc\ndescription: \"   \"");
		writeAgent(agentsDir, "long-desc.md", `name: long-desc\ndescription: ${"x".repeat(1025)}`);
		writeAgent(agentsDir, "empty-model.md", 'name: empty-model\ndescription: M\nmodel: ""');
		writeAgent(agentsDir, "bad-turns.md", "name: bad-turns\ndescription: T\nmaxTurns: 0");
		writeAgent(agentsDir, "big-turns.md", "name: big-turns\ndescription: T\nmaxTurns: 201");
		writeAgent(agentsDir, "float-turns.md", "name: float-turns\ndescription: T\nmaxTurns: 1.5");
		writeAgent(agentsDir, "empty-color.md", 'name: empty-color\ndescription: C\ncolor: ""');
		writeAgent(
			agentsDir,
			"ok.md",
			'name: ok\ndescription: OK\nmodel: anthropic/claude-sonnet-4-5\nmaxTurns: 100\ncolor: "#ff0000"',
		);

		const { agents, diagnostics } = loadAgentsFromDir({ dir: agentsDir, source: "user" });

		expect(agents.map((agent) => agent.name)).toEqual(["ok"]);
		expect(agents[0]?.model).toBe("anthropic/claude-sonnet-4-5");
		expect(agents[0]?.maxTurns).toBe(100);
		expect(agents[0]?.color).toBe("#ff0000");
		expect(diagnostics.filter((d) => d.type === "error")).toHaveLength(8);
	});

	it("rejects empty strings in tools/disallowedTools fields", () => {
		writeAgent(agentsDir, "empty-tools.md", 'name: empty-tools\ndescription: T\n  tools: ""');
		writeAgent(agentsDir, "empty-deny.md", 'name: empty-deny\ndescription: D\n  disallowedTools: "  "');

		const { agents, diagnostics } = loadAgentsFromDir({ dir: agentsDir, source: "user" });

		expect(agents).toEqual([]);
		expect(diagnostics.filter((d) => d.type === "error")).toHaveLength(2);
	});

	it("rejects definitions larger than 64 KiB", () => {
		const filePath = join(agentsDir, "big.md");
		writeFileSync(filePath, `---\nname: big\ndescription: Big\n---\n\n${"x".repeat(66 * 1024)}`);

		const { agents, diagnostics } = loadAgentsFromDir({ dir: agentsDir, source: "user" });

		expect(agents).toEqual([]);
		expect(diagnostics.some((d) => d.type === "error" && d.path === filePath)).toBe(true);
	});

	it("rejects invalid YAML frontmatter with a diagnostic", () => {
		const filePath = join(agentsDir, "broken.md");
		writeFileSync(filePath, "---\nname: [broken\n---\nBody");
		writeAgent(agentsDir, "ok.md", "name: ok\ndescription: OK");

		const { agents, diagnostics } = loadAgentsFromDir({ dir: agentsDir, source: "user" });

		expect(agents.map((agent) => agent.name)).toEqual(["ok"]);
		expect(diagnostics.some((d) => d.type === "error" && d.path === filePath)).toBe(true);
	});

	it("ignores unknown frontmatter keys for forward compatibility", () => {
		writeAgent(agentsDir, "future.md", "name: future\ndescription: Future\nmemory: enabled\nisolation: true");

		const { agents, diagnostics } = loadAgentsFromDir({ dir: agentsDir, source: "user" });

		expect(agents).toHaveLength(1);
		expect(diagnostics).toEqual([]);
	});

	it("rejects symlinked definition files and directory entries named like .md files", () => {
		const outsideDir = join(tempDir, "outside");
		mkdirSync(outsideDir, { recursive: true });
		const outsideFile = join(outsideDir, "outside.md");
		writeFileSync(outsideFile, "---\nname: outside\ndescription: Outside\n---\nBody");

		symlinkSync(outsideFile, join(agentsDir, "linked.md"), "file");
		symlinkSync(outsideDir, join(agentsDir, "linked-dir"), "dir");
		mkdirSync(join(agentsDir, "dir.md"));
		writeAgent(agentsDir, "ok.md", "name: ok\ndescription: OK");

		const { agents, diagnostics } = loadAgentsFromDir({ dir: agentsDir, source: "user" });

		expect(agents.map((agent) => agent.name)).toEqual(["ok"]);
		expect(diagnostics.some((d) => d.type === "error" && d.path === join(agentsDir, "linked.md"))).toBe(true);
		expect(diagnostics.some((d) => d.type === "error" && d.path === join(agentsDir, "dir.md"))).toBe(true);
	});

	it("reports a collision diagnostic for duplicate names and keeps the sorted-first winner", () => {
		writeAgent(agentsDir, "a-scout.md", "name: scout\ndescription: First scout");
		writeAgent(agentsDir, "b-scout.md", "name: scout\ndescription: Second scout");

		const { agents, diagnostics } = loadAgentsFromDir({ dir: agentsDir, source: "user" });

		expect(agents).toHaveLength(1);
		expect(agents[0]?.description).toBe("First scout");
		const collision = diagnostics.find((d) => d.type === "collision");
		expect(collision).toBeDefined();
		expect(collision?.path).toBe(join(agentsDir, "b-scout.md"));
	});

	it("processes only the first 128 candidates and reports one aggregate diagnostic", () => {
		for (let index = 0; index < MAX_AGENTS_PER_SOURCE + 2; index++) {
			const padded = String(index).padStart(3, "0");
			writeAgent(agentsDir, `agent-${padded}.md`, `name: agent-${padded}\ndescription: Agent ${padded}`);
		}

		const { agents, diagnostics } = loadAgentsFromDir({ dir: agentsDir, source: "user" });

		expect(agents).toHaveLength(MAX_AGENTS_PER_SOURCE);
		expect(agents[0]?.name).toBe("agent-000");
		expect(agents[MAX_AGENTS_PER_SOURCE - 1]?.name).toBe(`agent-${String(MAX_AGENTS_PER_SOURCE - 1).padStart(3, "0")}`);
		expect(diagnostics.some((d) => d.type === "warning" && d.message.includes("more than 128"))).toBe(true);
	});
});

describe("loadAgents", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-load-agents-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns the union of user and project sources plus built-ins", () => {
		const userDir = join(agentDir, "agents");
		const projectDir = join(cwd, ".pi", "agents");
		mkdirSync(userDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeAgent(userDir, "scout.md", "name: scout\ndescription: User scout");
		writeAgent(userDir, "helper.md", "name: helper\ndescription: User helper");
		writeAgent(projectDir, "scout.md", "name: scout\ndescription: Project scout");

		const result = loadAgents({ cwd, agentDir, includeBuiltIns: true });

		expect(result.projectAgentsDir).toBe(projectDir);
		// User source is filename-sorted, then project source, then built-ins.
		const names = result.agents.map((agent) => agent.name);
		expect(names).toEqual(["helper", "scout", "scout", "general-purpose"]);
		expect(result.agents.filter((agent) => agent.name === "scout").map((agent) => agent.source)).toEqual([
			"user",
			"project",
		]);
	});

	it("omits built-ins when includeBuiltIns is false", () => {
		const result = loadAgents({ cwd, agentDir, includeBuiltIns: false });
		expect(result.agents).toEqual([]);
	});
});

describe("BUILTIN_AGENTS", () => {
	it("contains general-purpose with inherit model, all tools and 150 max turns", () => {
		expect(BUILTIN_AGENTS).toHaveLength(1);
		const agent = BUILTIN_AGENTS[0];
		expect(agent?.name).toBe("general-purpose");
		expect(agent?.source).toBe("built-in");
		expect(agent?.model).toBe("inherit");
		expect(agent?.tools).toBeUndefined();
		expect(agent?.maxTurns).toBe(150);
		expect(agent?.filePath).toBeUndefined();
		expect(agent?.systemPrompt.length).toBeGreaterThan(0);
		expect(agent?.description.length).toBeGreaterThan(0);
	});
});

describe("resolveAgentsForScope", () => {
	let catalog: AgentDefinition[];

	beforeEach(() => {
		const builtin = BUILTIN_AGENTS[0]!;
		const userScout: AgentDefinition = {
			name: "scout",
			description: "User scout",
			systemPrompt: "User prompt",
			source: "user",
		};
		const userHelper: AgentDefinition = {
			name: "helper",
			description: "User helper",
			systemPrompt: "Helper prompt",
			source: "user",
		};
		const projectScout: AgentDefinition = {
			name: "scout",
			description: "Project scout",
			systemPrompt: "Project prompt",
			source: "project",
		};
		catalog = [userScout, userHelper, projectScout, builtin];
	});

	it("user scope prefers user over built-in and excludes project", () => {
		const result = resolveAgentsForScope(catalog, "user");
		expect(result.map((agent) => agent.name)).toEqual(["scout", "helper", "general-purpose"]);
		expect(result[0]?.source).toBe("user");
	});

	it("project scope prefers project over built-in and excludes user", () => {
		const result = resolveAgentsForScope(catalog, "project");
		expect(result.map((agent) => agent.name)).toEqual(["scout", "general-purpose"]);
		expect(result[0]?.source).toBe("project");
	});

	it("both scope prefers project over user over built-in with unique names", () => {
		const result = resolveAgentsForScope(catalog, "both");
		expect(result.map((agent) => agent.name)).toEqual(["scout", "helper", "general-purpose"]);
		expect(result[0]?.source).toBe("project");
		expect(result[1]?.source).toBe("user");
	});

	it("keeps stable input order within each priority tier", () => {
		const extraUser: AgentDefinition = {
			name: "z-user",
			description: "Late user",
			systemPrompt: "Late",
			source: "user",
		};
		const result = resolveAgentsForScope([...catalog, extraUser], "user");
		expect(result.map((agent) => agent.name)).toEqual(["scout", "helper", "z-user", "general-purpose"]);
	});
});

describe("formatAgentsForPrompt", () => {
	it("returns an empty string for no agents", () => {
		expect(formatAgentsForPrompt([])).toBe("");
	});

	it("declares low-trust metadata, escapes XML and marks project agents as requiring approval", () => {
		const agents: AgentDefinition[] = [
			{
				name: "scout",
				description: 'He said "hi" & <welcome> <script>alert(1)</script>',
				systemPrompt: "Secret system prompt text",
				tools: ["read", "grep"],
				model: "anthropic/claude-sonnet-4-5",
				source: "project",
			},
			BUILTIN_AGENTS[0]!,
		];

		const rendered = formatAgentsForPrompt(agents);

		expect(rendered).toContain("low-trust metadata");
		expect(rendered).toContain("not instructions");
		expect(rendered).toContain("<available_agents>");
		expect(rendered).toContain("</available_agents>");
		expect(rendered).toContain("&quot;hi&quot;");
		expect(rendered).toContain("&amp; &lt;welcome&gt;");
		expect(rendered).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(rendered).not.toContain("<script>alert(1)</script>");
		expect(rendered).toContain('source="project"');
		expect(rendered).toContain("approval");
		expect(rendered).toContain('model="anthropic/claude-sonnet-4-5"');
		expect(rendered).toContain('tools="read, grep"');
		expect(rendered).not.toContain("Secret system prompt text");
		expect(rendered).not.toContain("filePath");
	});

	it("summarizes model and tools for built-in agents", () => {
		const rendered = formatAgentsForPrompt(BUILTIN_AGENTS);
		expect(rendered).toContain('name="general-purpose" source="built-in" model="inherit" tools="all"');
	});

	it("truncates in input order to 32 KiB with an omitted count", () => {
		const agents: AgentDefinition[] = [];
		for (let index = 0; index < 40; index++) {
			agents.push({
				name: `agent-${String(index).padStart(2, "0")}`,
				description: `Description ${index} ${"x".repeat(1000)}`,
				systemPrompt: "Body",
				source: "user",
			});
		}

		const rendered = formatAgentsForPrompt(agents);

		expect(Buffer.byteLength(rendered, "utf-8")).toBeLessThanOrEqual(MAX_AVAILABLE_AGENTS_PROMPT_BYTES);
		expect(rendered).toContain("agent-00");
		expect(rendered).not.toContain("agent-39");
		expect(rendered).toMatch(/<!-- \d+ agents? omitted: catalog exceeds/);
	});

	it("does not truncate when the catalog fits", () => {
		const agents: AgentDefinition[] = [
			{ name: "a", description: "A", systemPrompt: "Body", source: "user" },
			{ name: "b", description: "B", systemPrompt: "Body", source: "user" },
		];
		const rendered = formatAgentsForPrompt(agents);
		expect(rendered).toContain('name="a"');
		expect(rendered).toContain('name="b"');
		expect(rendered).not.toContain("omitted");
	});

	it("survives multi-byte UTF-8 descriptions", () => {
		const agents: AgentDefinition[] = [
			{ name: "cn", description: "中文描述：审查代码并报告发现。", systemPrompt: "Body", source: "user" },
		];
		const rendered = formatAgentsForPrompt(agents);
		expect(rendered).toContain("审查代码");
		expect(rendered).toContain("<available_agents>");
	});
});

describe("agents directory paths", () => {
	it("project agents dir resolves under cwd/.pi", () => {
		const tempDir = join(tmpdir(), `pi-agents-path-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		try {
			const cwd = join(tempDir, "project");
			mkdirSync(cwd, { recursive: true });
			const result = loadAgents({ cwd, agentDir: join(tempDir, "agent"), includeBuiltIns: true });
			expect(existsSync(result.projectAgentsDir ?? "")).toBe(false);
			expect(result.projectAgentsDir?.endsWith(`${join(".pi", "agents")}`)).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
