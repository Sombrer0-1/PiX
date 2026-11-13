import type { CreateAgentSessionFromServicesOptions } from "./agent-session-services.ts";
import type { ExtensionFactory, SessionShutdownEvent } from "./extensions/index.ts";
import type { RequestUserInputHandler } from "./request-user-input-tool.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import type { SessionFileHost } from "./session-file-host.ts";
import type { SessionManager } from "./session-manager.ts";
import type { RuntimeEnvironmentContext } from "./system-prompt.ts";
import type { ExecutionBackend } from "./tools/execution-backend.ts";

export interface SessionHostIO {
	/** Aborted when the session closes or is replaced. */
	signal?: AbortSignal;
	requestUserInput: RequestUserInputHandler;
	emit<T extends { type: string }>(event: T, text?: string): void;
}

export interface SessionHostCommand {
	name: string;
	description: string;
	rpc?: string | readonly string[];
	execute(args: string | Record<string, unknown>): Promise<unknown>;
}

export interface MainHostSession {
	runtimeCwd?: string;
	executionBackend?: ExecutionBackend;
	runtimeEnvironmentOverride?: Partial<RuntimeEnvironmentContext>;
	extensionFactories?: ExtensionFactory[];
	createSession(options: CreateAgentSessionFromServicesOptions): Promise<CreateAgentSessionResult>;
	setIO?(io: SessionHostIO): void;
	commands?: SessionHostCommand[];
	initialize?(): Promise<void>;
	close(options?: { reason?: SessionShutdownEvent["reason"]; targetSessionFile?: string }): Promise<void>;
}

export interface MainHostProcess {
	prepareSession(input: { cwd: string; agentDir: string; sessionManager: SessionManager }): Promise<MainHostSession>;
	close(): Promise<void>;
}

export type AppMode = "interactive" | "print" | "json" | "rpc";

export interface MainHost {
	name: string;
	version: string;
	help?: { description?: string; additionalOptions?: string; sessionDirDescription?: string };
	files: SessionFileHost;
	resolveStartupCwd?(cwd: string): Promise<string>;
	start(context: { cwd: string; agentDir: string; mode: AppMode }): Promise<MainHostProcess>;
}
