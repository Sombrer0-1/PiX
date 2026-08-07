export {
	type ExecutionBackend,
	type ToolMutationKeyResolver,
	type ToolPathContext,
	type ToolPathResolver,
} from "./execution-backend.ts";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";
export {
	createRunBackgroundToolDefinition,
	type RunBackgroundInput,
} from "./run-background.ts";
export {
	createReadOutputToolDefinition,
	type ReadOutputInput,
} from "./read-output.ts";
export {
	createStopProcessToolDefinition,
	type StopProcessInput,
} from "./stop-process.ts";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BackgroundTaskRegistry } from "../background-task-registry.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ExecutionBackend, ToolPathContext } from "./execution-backend.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";
import { createRunBackgroundToolDefinition, type RunBackgroundInput } from "./run-background.ts";
import { createReadOutputToolDefinition, type ReadOutputInput } from "./read-output.ts";
import { createStopProcessToolDefinition, type StopProcessInput } from "./stop-process.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export const allToolNames: Set<ToolName> = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export interface ToolsOptions {
	executionBackend?: ExecutionBackend;
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
}

/**
 * Merge per-tool options with the execution backend's operations and path context.
 *
 * Priority: explicit per-tool operations/pathContext > backend > local default.
 * The spread is applied first to preserve all existing per-tool fields
 * (autoResizeImages, commandPrefix, shellPath, spawnHook).
 *
 * pathContext is added to per-tool option types in S2; until then it is set
 * on the object at runtime and ignored by tool factories.
 */
function withBackend<T extends object>(
	perToolOptions: T | undefined,
	backendOperations: unknown,
	paths: ToolPathContext | undefined,
): T | undefined {
	if (!backendOperations && !paths) {
		return perToolOptions;
	}
	const existing = (perToolOptions ?? {}) as T & {
		operations?: unknown;
		pathContext?: ToolPathContext;
	};
	return {
		...existing,
		operations: existing.operations ?? backendOperations,
		pathContext: existing.pathContext ?? paths,
	} as T;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	const backend = options?.executionBackend;
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, withBackend(options?.read, backend?.read, backend?.paths));
		case "bash":
			return createBashToolDefinition(cwd, withBackend(options?.bash, backend?.bash, backend?.paths));
		case "edit":
			return createEditToolDefinition(cwd, withBackend(options?.edit, backend?.edit, backend?.paths));
		case "write":
			return createWriteToolDefinition(cwd, withBackend(options?.write, backend?.write, backend?.paths));
		case "grep":
			return createGrepToolDefinition(cwd, withBackend(options?.grep, backend?.grep, backend?.paths));
		case "find":
			return createFindToolDefinition(cwd, withBackend(options?.find, backend?.find, backend?.paths));
		case "ls":
			return createLsToolDefinition(cwd, withBackend(options?.ls, backend?.ls, backend?.paths));
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	const backend = options?.executionBackend;
	switch (toolName) {
		case "read":
			return createReadTool(cwd, withBackend(options?.read, backend?.read, backend?.paths));
		case "bash":
			return createBashTool(cwd, withBackend(options?.bash, backend?.bash, backend?.paths));
		case "edit":
			return createEditTool(cwd, withBackend(options?.edit, backend?.edit, backend?.paths));
		case "write":
			return createWriteTool(cwd, withBackend(options?.write, backend?.write, backend?.paths));
		case "grep":
			return createGrepTool(cwd, withBackend(options?.grep, backend?.grep, backend?.paths));
		case "find":
			return createFindTool(cwd, withBackend(options?.find, backend?.find, backend?.paths));
		case "ls":
			return createLsTool(cwd, withBackend(options?.ls, backend?.ls, backend?.paths));
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	const backend = options?.executionBackend;
	return [
		createReadToolDefinition(cwd, withBackend(options?.read, backend?.read, backend?.paths)),
		createBashToolDefinition(cwd, withBackend(options?.bash, backend?.bash, backend?.paths)),
		createEditToolDefinition(cwd, withBackend(options?.edit, backend?.edit, backend?.paths)),
		createWriteToolDefinition(cwd, withBackend(options?.write, backend?.write, backend?.paths)),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	const backend = options?.executionBackend;
	return [
		createReadToolDefinition(cwd, withBackend(options?.read, backend?.read, backend?.paths)),
		createGrepToolDefinition(cwd, withBackend(options?.grep, backend?.grep, backend?.paths)),
		createFindToolDefinition(cwd, withBackend(options?.find, backend?.find, backend?.paths)),
		createLsToolDefinition(cwd, withBackend(options?.ls, backend?.ls, backend?.paths)),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	const backend = options?.executionBackend;
	return {
		read: createReadToolDefinition(cwd, withBackend(options?.read, backend?.read, backend?.paths)),
		bash: createBashToolDefinition(cwd, withBackend(options?.bash, backend?.bash, backend?.paths)),
		edit: createEditToolDefinition(cwd, withBackend(options?.edit, backend?.edit, backend?.paths)),
		write: createWriteToolDefinition(cwd, withBackend(options?.write, backend?.write, backend?.paths)),
		grep: createGrepToolDefinition(cwd, withBackend(options?.grep, backend?.grep, backend?.paths)),
		find: createFindToolDefinition(cwd, withBackend(options?.find, backend?.find, backend?.paths)),
		ls: createLsToolDefinition(cwd, withBackend(options?.ls, backend?.ls, backend?.paths)),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	const backend = options?.executionBackend;
	return [
		createReadTool(cwd, withBackend(options?.read, backend?.read, backend?.paths)),
		createBashTool(cwd, withBackend(options?.bash, backend?.bash, backend?.paths)),
		createEditTool(cwd, withBackend(options?.edit, backend?.edit, backend?.paths)),
		createWriteTool(cwd, withBackend(options?.write, backend?.write, backend?.paths)),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	const backend = options?.executionBackend;
	return [
		createReadTool(cwd, withBackend(options?.read, backend?.read, backend?.paths)),
		createGrepTool(cwd, withBackend(options?.grep, backend?.grep, backend?.paths)),
		createFindTool(cwd, withBackend(options?.find, backend?.find, backend?.paths)),
		createLsTool(cwd, withBackend(options?.ls, backend?.ls, backend?.paths)),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	const backend = options?.executionBackend;
	return {
		read: createReadTool(cwd, withBackend(options?.read, backend?.read, backend?.paths)),
		bash: createBashTool(cwd, withBackend(options?.bash, backend?.bash, backend?.paths)),
		edit: createEditTool(cwd, withBackend(options?.edit, backend?.edit, backend?.paths)),
		write: createWriteTool(cwd, withBackend(options?.write, backend?.write, backend?.paths)),
		grep: createGrepTool(cwd, withBackend(options?.grep, backend?.grep, backend?.paths)),
		find: createFindTool(cwd, withBackend(options?.find, backend?.find, backend?.paths)),
		ls: createLsTool(cwd, withBackend(options?.ls, backend?.ls, backend?.paths)),
	};
}

export function createBackgroundToolDefinitions(
	cwd: string,
	registry: BackgroundTaskRegistry,
): ToolDef[] {
	return [
		createRunBackgroundToolDefinition(cwd, registry),
		createReadOutputToolDefinition(registry),
		createStopProcessToolDefinition(registry),
	];
}
