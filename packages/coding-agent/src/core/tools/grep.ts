import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import type { ToolPathContext } from "./execution-backend.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(
		Type.String({
			description: "Filter files by glob pattern relative to the search directory, e.g. '*.ts' or 'src/**/*.ts'",
		}),
	),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** @deprecated Context lines now come from ripgrep. */
	readFile?: (absolutePath: string) => Promise<string> | string;
	/**
	 * Spawn ripgrep in the runtime namespace (for example inside WSL).
	 * Must return a live ChildProcess so the existing readline/JSON/limit
	 * early-kill flow is preserved. cwd and absolutePath params are runtime
	 * (POSIX logical) paths; converting to physical is the backend's job.
	 */
	spawnRipgrep?: (args: string[], cwd: string, env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
};

type RgText = { text?: string; bytes?: string };

function decodeRgText(value: RgText | undefined): string {
	if (typeof value?.text === "string") return value.text;
	if (typeof value?.bytes === "string") return Buffer.from(value.bytes, "base64").toString("utf-8");
	return "";
}

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	operations?: GrepOperations;
	/** Path context for a remote execution backend (for example WSL). */
	pathContext?: ToolPathContext;
}

/**
 * Base timeout for a ripgrep spawn when a backend owns execution (WSL).
 * The local Windows fallback keeps its existing signal-only behavior.
 */
const GREP_SPAWN_TIMEOUT_MS = 120_000;

/**
 * Compute the ripgrep spawn timeout for a backend-managed search.
 * Cross-boundary searches under /mnt/<drive> (NTFS via 9P) are doubled
 * because metadata reads are noticeably slower than on native ext4.
 */
function computeGrepTimeoutMs(searchPath: string, pathStyle: "win32" | "posix"): number | undefined {
	if (pathStyle !== "posix") return undefined;
	// /mnt/<single-letter-drive>/ is a Windows drive mounted into WSL (9P).
	if (/^\/mnt\/[a-zA-Z]\//.test(searchPath) || /^\/mnt\/[a-zA-Z]$/.test(searchPath)) {
		return GREP_SPAWN_TIMEOUT_MS * 2;
	}
	return GREP_SPAWN_TIMEOUT_MS;
}

function formatGrepCall(
	args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
	theme: Theme,
	home?: string,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".", home) : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}

function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	const pathContext = options?.pathContext;
	const pathStyle = pathContext?.pathStyle ?? "win32";
	const pathApi = pathStyle === "posix" ? path.posix : path;
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						const spawnRipgrep = customOps?.spawnRipgrep;
						// Only probe/download a host rg binary when no backend owns the spawn.
						// A WSL backend spawns rg inside the distro and surfaces a missing-rg
						// error itself (with distro name + apt hint).
						let rgPath: string | undefined;
						if (!spawnRipgrep) {
							rgPath = await ensureTool("rg", true);
							if (!rgPath) {
								settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
								return;
							}
						}

						const searchPath = resolveToCwd(searchDir || ".", cwd, pathContext);
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}

						const contextValue =
							context && context > 0 ? Math.min(Math.floor(context), Number.MAX_SAFE_INTEGER) : 0;
						const effectiveLimit = Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT));
						const searchCwd = isDirectory ? searchPath : pathApi.dirname(searchPath);
						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = pathApi.relative(searchPath, pathApi.resolve(searchPath, filePath));
								if (relative && relative !== ".." && !relative.startsWith(`..${pathApi.sep}`)) {
									return relative.replace(/\\/g, "/");
								}
							}
							return pathApi.basename(filePath);
						};

						if (signal?.aborted) throw new Error("Operation aborted");
						const args: string[] = ["--json", "--line-number", "--color=never", "--hidden", "--no-require-git"];
						if (ignoreCase) args.push("--ignore-case");
						if (literal) args.push("--fixed-strings");
						if (glob) args.push("--glob", glob.replace(/^(!?)(?:\.\/)+/, "$1"));
						if (contextValue > 0) args.push("--context", String(contextValue));
						// ripgrep roots globs at its cwd. Searching "." also works for symlinked directories.
						args.push("--", pattern, isDirectory ? "." : searchPath);

						const child = spawnRipgrep
							? spawnRipgrep(args, searchCwd, process.env)
							: spawn(rgPath as string, args, { cwd: searchCwd, stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						let linesTruncated = false;
						let aborted = false;
						let killedDueToLimit = false;
						let timedOut = false;
						const outputLines: string[] = [];

						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", onAbort);
							if (timeoutHandle) clearTimeout(timeoutHandle);
						};
						const stopChild = (dueToLimit = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};
						const onAbort = () => {
							aborted = true;
							stopChild();
						};
						signal?.addEventListener("abort", onAbort, { once: true });
						// Independent timeout for backend-managed spawns (WSL). The local
						// Windows fallback keeps its existing signal-only behavior.
						const grepTimeoutMs = spawnRipgrep ? computeGrepTimeoutMs(searchPath, pathStyle) : undefined;
						const timeoutHandle: NodeJS.Timeout | undefined = grepTimeoutMs
							? setTimeout(() => {
									timedOut = true;
									stopChild();
								}, grepTimeoutMs)
							: undefined;
						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						// Size of the full output, including lines past the byte cap that are counted but not stored.
						let outputBytes = 0;
						let outputLineCount = 0;
						let lastFile: string | undefined;
						// Set at the last allowed match. rg still sends that match's trailing context, kept up to
						// trailingContextEnd, and the limit notice waits for proof of one more match.
						let limitHit = false;
						let trailingContextEnd = 0;
						let done = false;
						const finish = () => {
							done = true;
							stopChild(true);
						};
						const pushLine = (filePath: string, lineNumber: number, lineText: string, isMatch: boolean) => {
							lastFile = filePath;
							const relativePath = formatPath(filePath);
							// Strip only the line terminator: a lone CR inside a line is content, as in the read tool.
							const sanitized = lineText.replace(/\r?\n?$/, "");
							// Truncate long lines so grep output stays compact.
							const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
							if (wasTruncated) linesTruncated = true;
							const line = isMatch
								? `${relativePath}:${lineNumber}: ${truncatedText}`
								: `${relativePath}-${lineNumber}- ${truncatedText}`;
							// Byte truncation below drops everything past the cap, so keep counting but stop storing (#9276).
							// outputBytes counts a newline after every line; the joined output has one fewer.
							if (outputBytes - 1 <= DEFAULT_MAX_BYTES) outputLines.push(line);
							outputBytes += Buffer.byteLength(line, "utf-8") + 1;
							outputLineCount++;
						};

						rl.on("line", (line) => {
							if (done || !line.trim()) return;
							let event: { type: string; data?: { path?: RgText; line_number?: number; lines?: RgText } };
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}
							const isMatch = event.type === "match";
							if (!isMatch && event.type !== "context") return;
							const filePath = decodeRgText(event.data?.path);
							const lineNumber = event.data?.line_number;
							if (!filePath || typeof lineNumber !== "number") return;
							const lineText = decodeRgText(event.data?.lines);
							if (!limitHit) {
								pushLine(filePath, lineNumber, lineText, isMatch);
								if (!isMatch) return;
								matchCount++;
								if (matchCount >= effectiveLimit) {
									limitHit = true;
									trailingContextEnd = lineNumber + contextValue;
								}
								return;
							}
							const inWindow = filePath === lastFile && lineNumber <= trailingContextEnd;
							// A match inside the last match's trailing context is shown as context.
							if (inWindow) pushLine(filePath, lineNumber, lineText, false);
							// Only another match proves that the limit cut results off.
							if (isMatch) matchLimitReached = true;
							if (matchLimitReached && !(inWindow && lineNumber < trailingContextEnd)) finish();
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});
						child.on("close", (code) => {
							cleanup();
							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (timedOut) {
								settle(() => reject(new Error(`ripgrep timed out after ${grepTimeoutMs}ms`)));
								return;
							}
							if (!killedDueToLimit && code !== 0 && code !== 1) {
								const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
								settle(() => reject(new Error(errorMsg)));
								return;
							}
							if (matchCount === 0) {
								settle(() =>
									resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }),
								);
								return;
							}

							const rawOutput = outputLines.join("\n");
							// Apply byte truncation. There is no line limit here because the match limit already capped rows.
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							truncation.totalLines = outputLineCount;
							truncation.totalBytes = outputBytes - 1;
							let output = truncation.content;
							const details: GrepToolDetails = {};
							// Build actionable notices for truncation and match limits.
							const notices: string[] = [];
							if (matchLimitReached) {
								notices.push(
									`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.matchLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (linesTruncated) {
								notices.push(
									`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
								);
								details.linesTruncated = true;
							}
							if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
							settle(() =>
								resolve({
									content: [{ type: "text", text: output }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepCall(args, theme, pathContext?.homeDir));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result, options, theme, context.showImages));
			return text;
		},
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
