/**
 * Generic execution backend contract for the SDK.
 *
 * This is the single seam between the SDK and any remote execution
 * implementation (WSL, SSH, containers, etc.). The SDK only depends on this
 * interface; it never imports WSL-specific code, distro names, or UNC paths.
 *
 * Type-only imports keep this file free of runtime dependencies on the tool
 * modules. The operations interfaces are defined in their respective tool
 * files and re-exported through the tools barrel.
 */

import type { RuntimeEnvironmentContext } from "../system-prompt.ts";
import type { BashOperations } from "./bash.ts";
import type { EditOperations } from "./edit.ts";
import type { FindOperations } from "./find.ts";
import type { GrepOperations } from "./grep.ts";
import type { LsOperations } from "./ls.ts";
import type { ReadOperations } from "./read.ts";
import type { WriteOperations } from "./write.ts";

/** Resolve a model-visible input path against a runtime cwd. */
export type ToolPathResolver = (input: string, cwd: string) => string;

/** Return an opaque canonical identity used only by the file mutation queue. */
export type ToolMutationKeyResolver = (absolutePath: string) => Promise<string>;

/**
 * Path context for a single execution backend instance.
 *
 * All paths produced here live in the runtime namespace (POSIX under WSL,
 * win32 on native Windows). File operations convert these to physical paths
 * internally; the SDK never sees UNC or drive letters from this layer.
 */
export interface ToolPathContext {
	/** Selects path.posix or path.win32 semantics for join/relative/format. */
	readonly pathStyle: "win32" | "posix";
	/** Home directory in the runtime namespace (for ~ expansion). */
	readonly homeDir: string;
	/** Resolve to an absolute path in the runtime namespace, never the host namespace. */
	readonly resolvePath: ToolPathResolver;
	/** Convert a host path back to a model-visible runtime path; logical input returned unchanged. */
	readonly displayPath?: (path: string) => string;
	/** Build a host-openable URL without changing model-visible tool text. */
	readonly toFileUrl?: (absolutePath: string) => string;
	/** Return an opaque, canonical identity used only by the mutation queue. */
	readonly getMutationKey?: ToolMutationKeyResolver;
}

/**
 * Execution backend providing operations and path context for built-in tools.
 *
 * When undefined, the SDK falls back to local-filesystem operations and
 * win32 path semantics, preserving existing Windows behavior byte-for-byte.
 */
export interface ExecutionBackend {
	/** Path context for this backend instance. */
	readonly paths: ToolPathContext;
	readonly bash?: BashOperations;
	readonly read?: ReadOperations;
	readonly write?: WriteOperations;
	readonly edit?: EditOperations;
	readonly grep?: GrepOperations;
	readonly find?: FindOperations;
	readonly ls?: LsOperations;
	/** Partial runtime environment merged into the system prompt (no cwd field). */
	readonly runtimeEnvironment?: Partial<RuntimeEnvironmentContext>;
	/** Validate that the runtime cwd exists before session start. */
	readonly assertProjectDirectory?: (runtimeCwd: string) => Promise<void> | void;
	/** Return the current runtime cwd (logical path). */
	readonly getCwd?: () => string;
	/** Release backend-owned resources. Only the context owner calls this. */
	readonly dispose?: () => Promise<void>;
}
