import { getTextOutput } from "../../../core/tools/render-utils.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import type { InteractiveToolSnapshot, ToolDisplayStatus } from "../presentation.ts";

export interface BuiltinToolSummary {
	readonly status?: ToolDisplayStatus;
	readonly subject?: string;
	readonly progress?: string;
	readonly diagnostic?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstLine(text: string): string {
	const line = text.split("\n").find((part) => part.trim());
	return line?.trim() ?? "";
}

function toolPath(args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	return stringField(args, "path") ?? stringField(args, "file_path");
}

function readProgress(args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	const offset = numberField(args, "offset");
	const limit = numberField(args, "limit");
	if (offset !== undefined && limit !== undefined) return `lines ${offset}–${offset + limit - 1}`;
	if (offset !== undefined) return `lines ${offset}–`;
	if (limit !== undefined) return `lines 1–${limit}`;
	return undefined;
}

function editCount(args: unknown): number | undefined {
	if (!isRecord(args)) return undefined;
	if (Array.isArray(args.edits)) return args.edits.length;
	if (typeof args.oldText === "string" && typeof args.newText === "string") return 1;
	return undefined;
}

function firstChangedLine(details: unknown): number | undefined {
	if (!isRecord(details)) return undefined;
	return numberField(details, "firstChangedLine");
}

function commandLine(args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	const command = stringField(args, "command");
	return command ? firstLine(command) : undefined;
}

function bashProgress(tool: InteractiveToolSnapshot): string | undefined {
	if (!tool.result || tool.result.isError) return undefined;
	const text = getTextOutput(tool.result, false).trim();
	if (!text || text.includes("\n") || text.length > 48) return undefined;
	return text;
}

function searchSummary(toolName: "grep" | "find" | "ls", args: unknown): BuiltinToolSummary {
	if (!isRecord(args)) return {};
	const limit = numberField(args, "limit");
	const progress = limit !== undefined ? `limit ${limit}` : undefined;
	if (toolName === "ls") {
		return { subject: stringField(args, "path") ?? ".", progress };
	}
	const pattern = stringField(args, "pattern");
	const path = stringField(args, "path");
	if (toolName === "grep") {
		const quoted = pattern ? `"${pattern}"` : undefined;
		const subject = quoted && path ? `${quoted} in ${path}` : quoted;
		return { subject, progress };
	}
	const subject = [pattern, path ? `in ${path}` : undefined].filter((part): part is string => Boolean(part)).join(" ");
	return { subject: subject || undefined, progress };
}

function requestSummary(tool: InteractiveToolSnapshot): BuiltinToolSummary {
	const args = tool.args;
	let subject: string | undefined;
	if (isRecord(args) && Array.isArray(args.questions)) {
		const first = args.questions.find(isRecord);
		if (first) subject = stringField(first, "header") ?? stringField(first, "question");
	}
	const response = isRecord(tool.result?.details) ? tool.result?.details.response : undefined;
	if (isRecord(response) && response.cancelled === true) {
		const text = tool.result ? getTextOutput(tool.result, false).trim() : "";
		return { status: "cancelled", subject, diagnostic: text || "Cancelled" };
	}
	return { subject };
}

function unknownSummary(args: unknown): BuiltinToolSummary {
	if (!isRecord(args)) return {};
	const preferred = ["path", "file_path", "command", "pattern", "query", "url", "prompt", "name", "target", "id"];
	const bits: string[] = [];
	const pushValue = (value: unknown): void => {
		if (bits.length >= 3) return;
		if (typeof value === "string" && value.trim()) {
			const line = firstLine(value);
			if (line) bits.push(line);
			return;
		}
		if (typeof value === "number" || typeof value === "boolean") bits.push(String(value));
	};
	for (const key of preferred) {
		if (key in args) pushValue(args[key]);
	}
	if (bits.length === 0) {
		for (const value of Object.values(args)) pushValue(value);
	}
	return { subject: bits.join("  ") || undefined };
}

export function summarizeTool(tool: InteractiveToolSnapshot): BuiltinToolSummary {
	switch (tool.toolName) {
		case "read":
			return { subject: toolPath(tool.args), progress: readProgress(tool.args) };
		case "write":
			return { subject: toolPath(tool.args) };
		case "edit": {
			const count = editCount(tool.args);
			const line = firstChangedLine(tool.result?.details);
			const parts: string[] = [];
			if (count !== undefined) parts.push(count === 1 ? "1 replacement" : `${count} replacements`);
			if (line !== undefined) parts.push(`line ${line}`);
			return { subject: toolPath(tool.args), progress: parts.join(", ") || undefined };
		}
		case "bash":
			return { subject: commandLine(tool.args), progress: bashProgress(tool) };
		case "grep":
		case "find":
		case "ls":
			return searchSummary(tool.toolName, tool.args);
		case "request_user_input":
			return requestSummary(tool);
		default:
			return unknownSummary(tool.args);
	}
}

export function readSavedEditDiff(details: unknown): string | undefined {
	if (!isRecord(details)) return undefined;
	return typeof details.diff === "string" ? details.diff : undefined;
}

function formatValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === undefined) return "";
	return JSON.stringify(value, null, 2) ?? "";
}

function formatArgs(args: unknown): string {
	if (args == null) return "";
	if (!isRecord(args)) return formatValue(args);
	const lines: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		const rendered = formatValue(value);
		if (!rendered) continue;
		if (rendered.includes("\n")) {
			lines.push(`${key}:`);
			lines.push(rendered);
		} else {
			lines.push(`${key}: ${rendered}`);
		}
	}
	return lines.join("\n");
}

function truncationNote(details: unknown): string | undefined {
	if (!isRecord(details)) return undefined;
	const lines: string[] = [];
	const truncation = details.truncation;
	if (isRecord(truncation) && truncation.truncated === true) {
		const outputLines = numberField(truncation, "outputLines");
		const totalLines = numberField(truncation, "totalLines");
		if (truncation.truncatedBy === "lines" && outputLines !== undefined && totalLines !== undefined) {
			lines.push(`Truncated: showing ${outputLines} of ${totalLines} lines`);
		} else if (outputLines !== undefined) {
			lines.push(`Truncated: ${outputLines} lines shown`);
		} else {
			lines.push("Truncated");
		}
	}
	if (typeof details.fullOutputPath === "string" && details.fullOutputPath) {
		lines.push(`Full output: ${details.fullOutputPath}`);
	}
	if (typeof details.matchLimitReached === "number") lines.push(`Match limit: ${details.matchLimitReached}`);
	if (details.linesTruncated === true) lines.push("Some lines were truncated");
	if (typeof details.entryLimitReached === "number") lines.push(`Entry limit: ${details.entryLimitReached}`);
	if (typeof details.resultLimitReached === "number") lines.push(`Result limit: ${details.resultLimitReached}`);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

export function buildToolHistoryBody(tool: InteractiveToolSnapshot, extra?: string): string | undefined {
	const sections: string[] = [];
	const argsText = formatArgs(tool.args);
	if (argsText) sections.push(argsText);
	if (tool.result) {
		const output = getTextOutput(tool.result, false);
		if (output) sections.push(output);
		const diff = readSavedEditDiff(tool.result.details);
		if (diff) sections.push(diff);
		const note = truncationNote(tool.result.details);
		if (note) sections.push(note);
	}
	if (extra?.trim()) sections.push(extra);
	const body = sections.join("\n\n");
	if (!body.trim()) return undefined;
	return stripAnsi(body);
}
