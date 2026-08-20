import { describe, expect, it } from "vitest";
import type { HostToolPolicyInput } from "../src/core/tool-execution-policy.ts";
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

	it("read-only blocks every tool outside the read-only tool set", () => {
		for (const toolName of ["bash", "write", "edit", "submit_user_plan", "request_user_input", "unknown_extension_tool"]) {
			const decision = inspectToolExecution({
				mode: "read-only",
				toolName,
				args: {},
				cwd,
			});

			expect(decision.allowed).toBe(false);
			expect(decision.reason).toContain("Read-only mode only allows read, grep, find, and ls");
		}
	});

	it("read-only allows the read-only tool set", () => {
		for (const toolName of ["read", "grep", "find", "ls"]) {
			const decision = inspectToolExecution({
				mode: "read-only",
				toolName,
				args: {},
				cwd,
			});

			expect(decision.allowed).toBe(true);
		}
	});

	it("a HostToolPolicyInput-shaped object composes with inspectToolExecution for override fallback", () => {
		// AgentSession consults `hostToolPolicyOverride(input) ?? inspectToolExecution(input)`.
		// Verify a value typed as HostToolPolicyInput is accepted by the fallback
		// policy unchanged, including the optional pathContext passthrough.
		const input: HostToolPolicyInput = {
			mode: "read-only",
			toolName: "bash",
			args: { command: "echo hi" },
			cwd,
		};

		const decision = inspectToolExecution(input);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("Read-only mode only allows read, grep, find, and ls");
	});
});
