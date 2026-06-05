import { isAbsolute, relative, resolve } from "node:path";

export interface DiffStat {
	added: number;
	removed: number;
}

export interface FileChangeSummary extends DiffStat {
	path?: string;
	toolCallId: string;
	toolName: string;
	diff?: string;
	patch?: string;
	firstChangedLine?: number;
}

export interface TurnDiffSummary extends DiffStat {
	files: number;
	changes: FileChangeSummary[];
}

export function emptyTurnDiffSummary(): TurnDiffSummary {
	return { added: 0, removed: 0, files: 0, changes: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function countDiffStat(diff: string): DiffStat {
	let added = 0;
	let removed = 0;
	for (const line of diff.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

export function addFileChangeToTurnSummary(summary: TurnDiffSummary, change: FileChangeSummary): TurnDiffSummary {
	const changes = [...summary.changes, change];
	const files = new Set(changes.map((item) => item.path).filter((path): path is string => !!path)).size;
	return {
		added: summary.added + change.added,
		removed: summary.removed + change.removed,
		files: files || changes.length,
		changes,
	};
}

export function getPathFromToolArgs(args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	for (const key of ["path", "file_path", "file", "target"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

export function isPathInsideCwd(path: string, cwd: string): boolean {
	const resolvedPath = resolve(cwd, path);
	const resolvedCwd = resolve(cwd);
	const rel = relative(resolvedCwd, resolvedPath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function extractFileChangeFromToolResult(options: {
	toolCallId: string;
	toolName: string;
	args: unknown;
	result: unknown;
	isError: boolean;
}): FileChangeSummary | undefined {
	if (options.isError || !isRecord(options.result)) return undefined;
	const details = options.result.details;
	if (!isRecord(details) || typeof details.diff !== "string") return undefined;

	const stat = countDiffStat(details.diff);
	if (stat.added === 0 && stat.removed === 0) return undefined;

	return {
		toolCallId: options.toolCallId,
		toolName: options.toolName,
		path: getPathFromToolArgs(options.args),
		added: stat.added,
		removed: stat.removed,
		diff: details.diff,
		patch: typeof details.patch === "string" ? details.patch : undefined,
		firstChangedLine: typeof details.firstChangedLine === "number" ? details.firstChangedLine : undefined,
	};
}
