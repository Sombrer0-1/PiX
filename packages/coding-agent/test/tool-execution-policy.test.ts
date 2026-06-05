import { describe, expect, it } from "vitest";
import { inspectToolExecution } from "../src/core/tool-execution-policy.ts";

describe("tool execution policy", () => {
	const cwd = process.platform === "win32" ? "C:\\work\\project" : "/work/project";

	it("requires approval for destructive commands in approval mode", () => {
		const decision = inspectToolExecution({
			mode: "approval",
			toolName: "bash",
			args: { command: "rm -fr /" },
			cwd,
		});

		expect(decision.allowed).toBe(false);
		expect(decision.requiresApproval).toBe(true);
		expect(decision.reason).toContain("High-risk command");
	});

	it("allows the same command in unattended mode", () => {
		const decision = inspectToolExecution({
			mode: "unattended",
			toolName: "bash",
			args: { command: "rm -fr /" },
			cwd,
		});

		expect(decision.allowed).toBe(true);
	});

	it("requires approval for file edits outside cwd in approval mode", () => {
		const decision = inspectToolExecution({
			mode: "approval",
			toolName: "write",
			args: { path: "../outside.txt", content: "x" },
			cwd,
		});

		expect(decision.allowed).toBe(false);
		expect(decision.requiresApproval).toBe(true);
		expect(decision.reason).toContain("outside the project");
	});

	it("always blocks Windows reserved device filenames for file mutation tools", () => {
		const decision = inspectToolExecution({
			mode: "unattended",
			toolName: "write",
			args: { path: "nul", content: "x" },
			cwd,
		});

		expect(decision.allowed).toBe(false);
		expect(decision.requiresApproval).toBeUndefined();
		expect(decision.reason).toContain("reserved device");
	});
});
