import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";

// Track fs.readdirSync / fs.readFileSync targets so tests can assert that a
// snapshot hit skips the resource scan entirely. vi.hoisted keeps the arrays
// reachable from the hoisted vi.mock factory.
const { readdirTargets, readTargets } = vi.hoisted(() => ({
	readdirTargets: [] as string[],
	readTargets: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const trackReaddirSync = (path: unknown, ...rest: unknown[]) => {
		if (typeof path === "string") {
			readdirTargets.push(path);
		}
		return (actual.readdirSync as (...args: unknown[]) => unknown)(path, ...rest);
	};
	const trackReadFileSync = (path: unknown, ...rest: unknown[]) => {
		if (typeof path === "string") {
			readTargets.push(path);
		}
		return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
	};
	return {
		...actual,
		readdirSync: vi.fn(trackReaddirSync),
		readFileSync: vi.fn(trackReadFileSync),
	};
});

function skillFile(name: string, description: string): string {
	return `---
name: ${name}
description: ${description}
---
Skill content for ${name}.`;
}

const AGENT_FILE = `---
name: reviewer
description: Reviews code changes
---
You are a code reviewer.`;

function countReaddirUnder(prefix: string): number {
	return readdirTargets.filter((target) => target.startsWith(prefix)).length;
}

function countReadsOf(file: string): number {
	return readTargets.filter((target) => target === file).length;
}

describe("DefaultResourceLoader reload snapshot fast path (S8)", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let skillsDir: string;
	let firstSkillFile: string;
	let agentDefFile: string;
	let contextFile: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `rl-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		skillsDir = join(tempDir, "extra-skills");
		mkdirSync(join(skillsDir, "my-skill"), { recursive: true });
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		mkdirSync(cwd, { recursive: true });
		firstSkillFile = join(skillsDir, "my-skill", "SKILL.md");
		writeFileSync(firstSkillFile, skillFile("my-skill", "first description"));
		agentDefFile = join(agentDir, "agents", "reviewer.md");
		writeFileSync(agentDefFile, AGENT_FILE);
		contextFile = join(cwd, "AGENTS.md");
		writeFileSync(contextFile, "# Project context\n");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	// The skills dir is wired through additionalSkillPaths (not auto
	// discovery) so only the loader's own scan touches it; package-manager
	// auto discovery keeps readdiring its own dirs on every resolve().
	function makeLoader(): DefaultResourceLoader {
		return new DefaultResourceLoader({ cwd, agentDir, additionalSkillPaths: [skillsDir] });
	}

	function resetFsTracking(): void {
		readdirTargets.length = 0;
		readTargets.length = 0;
	}

	function fixtureSkills(loader: DefaultResourceLoader) {
		return loader.getSkills().skills.filter((skill) => skill.filePath.startsWith(skillsDir));
	}

	it("serves the cached inventory without rescanning when nothing changed", async () => {
		const first = makeLoader();
		await first.reload();
		expect(fixtureSkills(first).some((skill) => skill.name === "my-skill")).toBe(true);
		expect(first.getAgentsFiles().agentsFiles.some((file) => file.path === contextFile)).toBe(true);
		expect(first.getAgents()?.agents.some((agent) => agent.name === "reviewer")).toBe(true);

		const second = makeLoader();
		resetFsTracking();
		await second.reload();

		expect(fixtureSkills(second).some((skill) => skill.description === "first description")).toBe(true);
		expect(
			second
				.getAgentsFiles()
				.agentsFiles.some((file) => file.path === contextFile && file.content.includes("Project context")),
		).toBe(true);
		expect(second.getAgents()?.agents.some((agent) => agent.name === "reviewer")).toBe(true);
		// Snapshot validation readdirs recorded directories so a new child still
		// invalidates when directory mtime is unchanged; it must not re-read the
		// skill / agent / context file contents.
		expect(countReadsOf(firstSkillFile)).toBe(0);
		expect(countReadsOf(agentDefFile)).toBe(0);
		expect(countReadsOf(contextFile)).toBe(0);
	});

	it("reloads in full when a tracked file's stat changes", async () => {
		const first = makeLoader();
		await first.reload();

		writeFileSync(firstSkillFile, skillFile("my-skill", "second description that is longer"));

		const second = makeLoader();
		resetFsTracking();
		await second.reload();

		expect(countReaddirUnder(skillsDir)).toBeGreaterThan(0);
		expect(countReadsOf(firstSkillFile)).toBeGreaterThan(0);
		expect(fixtureSkills(second).some((skill) => skill.description === "second description that is longer")).toBe(
			true,
		);
	});

	it("returns deep copies so mutating one generation's inventory does not leak into the cache", async () => {
		const first = makeLoader();
		await first.reload();

		const firstSkills = first.getSkills().skills;
		expect(firstSkills.length).toBeGreaterThan(0);
		firstSkills.push({ ...firstSkills[0], name: "injected-first", description: "injected from first" });
		firstSkills[0].description = "mutated on first generation";

		const second = makeLoader();
		await second.reload();

		const secondSkills = second.getSkills().skills;
		expect(secondSkills.some((skill) => skill.name === "injected-first")).toBe(false);
		expect(secondSkills.some((skill) => skill.description === "mutated on first generation")).toBe(false);
		expect(secondSkills.length).toBeGreaterThan(0);
		secondSkills.push({ ...secondSkills[0], name: "injected", description: "injected description" });
		secondSkills[0].description = "mutated description";

		const third = makeLoader();
		await third.reload();
		const thirdSkills = third.getSkills().skills;
		expect(thirdSkills.some((skill) => skill.name === "injected")).toBe(false);
		expect(thirdSkills.some((skill) => skill.description === "mutated description")).toBe(false);
		expect(thirdSkills.some((skill) => skill.description === "mutated on first generation")).toBe(false);
		expect(fixtureSkills(third).some((skill) => skill.description === "first description")).toBe(true);
	});

	it("detects newly created and deleted skill files", async () => {
		const first = makeLoader();
		await first.reload();
		expect(fixtureSkills(first).length).toBe(1);

		const secondSkillDir = join(skillsDir, "second-skill");
		mkdirSync(secondSkillDir);
		writeFileSync(join(secondSkillDir, "SKILL.md"), skillFile("second-skill", "another skill"));

		const second = makeLoader();
		resetFsTracking();
		await second.reload();
		expect(countReaddirUnder(skillsDir)).toBeGreaterThan(0);
		expect(fixtureSkills(second).some((skill) => skill.name === "second-skill")).toBe(true);

		rmSync(secondSkillDir, { recursive: true, force: true });
		const third = makeLoader();
		await third.reload();
		expect(fixtureSkills(third).some((skill) => skill.name === "second-skill")).toBe(false);
		expect(fixtureSkills(third).length).toBe(1);
	});

	it("invalidates the snapshot when a new file appears under a tracked directory", async () => {
		const first = makeLoader();
		await first.reload();

		const extra = join(skillsDir, "my-skill", "NOTES.md");
		writeFileSync(extra, "# notes\n");

		const second = makeLoader();
		resetFsTracking();
		await second.reload();
		// A previously unseen child forces a full reload (file content is read).
		expect(countReadsOf(firstSkillFile)).toBeGreaterThan(0);
	});

	it("invalidates the snapshot when a settings.json stat changes", async () => {
		const first = makeLoader();
		await first.reload();

		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2));

		const second = makeLoader();
		resetFsTracking();
		await second.reload();

		expect(countReaddirUnder(skillsDir)).toBeGreaterThan(0);
		expect(countReadsOf(firstSkillFile)).toBeGreaterThan(0);
	});
});
