import { basename, resolve } from "node:path";
import { getPathFromToolArgs, isPathInsideCwd } from "./file-change.ts";

export type AgentExecutionMode = "approval" | "unattended" | "read-only";

export interface ToolPolicyDecision {
	allowed: boolean;
	reason?: string;
	requiresApproval?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function commandArg(args: unknown): string | undefined {
	return isRecord(args) && typeof args.command === "string" ? args.command : undefined;
}

function normalizeCommand(command: string): string {
	return command.replace(/\s+/g, " ").trim().toLowerCase();
}

function isWindowsReservedDevicePath(path: string): boolean {
	const leaf = basename(path).split(".")[0]?.toLowerCase();
	return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(leaf ?? "");
}

function riskyCommandReason(command: string): string | undefined {
	const normalized = normalizeCommand(command);
	const checks: Array<[RegExp, string]> = [
		[
			/\brm\s+-(?=[^\n;&|]*r)(?=[^\n;&|]*f)[^\n;&|]*\s+(\/|~|\$home|\.\.)(\s|$)/,
			"recursive forced removal outside a narrow target",
		],
		[/\bgit\s+reset\s+--hard\b/, "hard git reset"],
		[/\bgit\s+clean\s+-[^\n;&|]*[dfx][^\n;&|]*\b/, "destructive git clean"],
		[/\bgit\s+(checkout|restore)\s+--\s+(\.|:\/|\/)\b/, "broad git checkout/restore"],
		[/\b(remove-item|rm)\b[^\n;&|]*\b-recurse\b[^\n;&|]*\b-force\b/i, "recursive forced removal"],
		[/\b(del|erase)\b[^\n;&|]*\s\/[sq]\b/i, "recursive Windows delete"],
		[/\b(rmdir|rd)\b[^\n;&|]*\s\/s\b/i, "recursive Windows directory removal"],
		[/\bformat\s+[a-z]:/i, "disk format command"],
		[/\bshutdown\b|\breboot\b|\brestart-computer\b/i, "system shutdown or reboot"],
	];

	for (const [pattern, reason] of checks) {
		if (pattern.test(normalized)) return reason;
	}
	return undefined;
}

function isReadOnlyTool(toolName: string): boolean {
	return ["read", "grep", "find", "ls"].includes(toolName);
}

export function inspectToolExecution(options: {
	mode: AgentExecutionMode;
	toolName: string;
	args: unknown;
	cwd: string;
}): ToolPolicyDecision {
	if (options.mode === "read-only" && !isReadOnlyTool(options.toolName)) {
		return {
			allowed: false,
			reason: `Read-only mode only allows read, grep, find, and ls tools. Blocked "${options.toolName}".`,
		};
	}

	const path = getPathFromToolArgs(options.args);
	if ((options.toolName === "write" || options.toolName === "edit") && path) {
		if (isWindowsReservedDevicePath(path)) {
			return {
				allowed: false,
				reason: `Refusing to write Windows reserved device path "${path}". Use a normal filename instead.`,
			};
		}
		if (options.mode === "approval" && !isPathInsideCwd(path, options.cwd)) {
			return {
				allowed: false,
				requiresApproval: true,
				reason: `File edit outside the project directory: ${resolve(options.cwd, path)}`,
			};
		}
	}

	if (options.toolName !== "bash") {
		return { allowed: true };
	}

	const command = commandArg(options.args);
	if (!command) return { allowed: true };
	if (options.mode === "unattended") return { allowed: true };

	const reason = riskyCommandReason(command);
	if (!reason) return { allowed: true };
	return {
		allowed: false,
		requiresApproval: true,
		reason: `High-risk command: ${reason}`,
	};
}
