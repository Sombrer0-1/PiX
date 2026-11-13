/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { createInterface } from "node:readline";
import { type ImageContent, modelsAreEqual } from "@earendil-works/pi-ai";
import { ProcessTerminal, setKeybindings, TUI } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { type Args, type Mode, parseArgs, printHelp } from "./cli/args.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { listModels } from "./cli/list-models.ts";
import { selectSession } from "./cli/session-picker.ts";
import { ENV_SESSION_DIR, expandTildePath, getAgentDir, getPackageDir, VERSION } from "./config.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "./core/agent-session-runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	type CreateAgentSessionFromServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import { exportFromFile } from "./core/export-html/index.ts";
import type { ExtensionFactory } from "./core/extensions/types.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { KeybindingsManager } from "./core/keybindings.ts";
import type { ModelRegistry } from "./core/model-registry.ts";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.ts";
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.ts";
import type { SessionFileHost } from "./core/session-file-host.ts";
import type { AppMode, MainHost, MainHostProcess, MainHostSession } from "./core/session-host.ts";
import { assertValidSessionId, findMostRecentSession, SessionManager } from "./core/session-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { printTimings, resetTimings, time } from "./core/timings.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.ts";
import { ExtensionSelectorComponent } from "./modes/interactive/components/extension-selector.ts";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.ts";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(signal?: AbortSignal): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY || signal?.aborted) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		const onData = (chunk: string) => {
			data += chunk;
		};
		const finish = () => {
			process.stdin.off("data", onData);
			process.stdin.off("end", finish);
			signal?.removeEventListener("abort", finish);
			process.stdin.pause();
			resolve(data.trim() || undefined);
		};
		if (process.stdin.readableEnded) return finish();
		signal?.addEventListener("abort", finish, { once: true });
		process.stdin.on("data", onData);
		process.stdin.on("end", finish);
		process.stdin.resume();
	});
}

function collectSettingsDiagnostics(
	settingsManager: SettingsManager,
	context: string,
): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		type: "warning",
		message: `(${context}, ${scope} settings) ${error.message}`,
	}));
}

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function resolveAppMode(parsed: Args, stdinIsTTY: boolean): AppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY) {
		return "print";
	}
	return "interactive";
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
	return appMode === "json" ? "json" : "text";
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
	cwd?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages, cwd });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Result from resolving a session argument */
type ResolvedSession =
	| { type: "path"; path: string } // Direct file path
	| { type: "local"; path: string } // Found in current project
	| { type: "global"; path: string; cwd: string } // Found in different project
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
async function findLocalSessionByExactId(
	sessionId: string,
	cwd: string,
	sessionDir?: string,
): Promise<{ type: "local"; path: string } | undefined> {
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatch = localSessions.find((s) => s.id === sessionId);
	return localMatch ? { type: "local", path: localMatch.path } : undefined;
}

async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// If it looks like a file path, resolve it before handing it to the session manager.
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: resolvePath(sessionArg, cwd) };
	}

	// Try to match as session ID in current project first
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatch =
		localSessions.find((s) => s.id === sessionArg) ?? localSessions.find((s) => s.id.startsWith(sessionArg));

	if (localMatch) {
		return { type: "local", path: localMatch.path };
	}

	// Try global search across all projects
	const allSessions = await SessionManager.listAll(sessionDir);
	const globalMatch =
		allSessions.find((s) => s.id === sessionArg) ?? allSessions.find((s) => s.id.startsWith(sessionArg));

	if (globalMatch) {
		return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
	}

	// Not found anywhere
	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

function validateSessionIdFlags(parsed: Args): void {
	if (parsed.sessionId === undefined) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}

	try {
		assertValidSessionId(parsed.sessionId);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
	fileHost?: { files: SessionFileHost; sessionDir: string },
	signal?: AbortSignal,
): Promise<SessionManager | undefined> {
	const open = (path: string, cwdOverride?: string) =>
		fileHost
			? fileHost.files.open({ cwd, sessionDir: fileHost.sessionDir, path, cwdOverride })
			: SessionManager.open(path, sessionDir, cwdOverride);
	const fork = (sourcePath: string, id?: string) =>
		fileHost
			? fileHost.files.fork({ cwd, sessionDir: fileHost.sessionDir, sourcePath, id })
			: SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id });
	if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
		return parsed.noSession && fileHost && parsed.listModels === undefined
			? fileHost.files.create({ cwd, sessionDir: fileHost.sessionDir, persist: false })
			: SessionManager.inMemory(cwd);
	}

	if (parsed.fork) {
		if (parsed.sessionId) {
			const existingTarget = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
			if (existingTarget) {
				throw new Error(`Session already exists with id '${parsed.sessionId}'`);
			}
		}

		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return fork(resolved.path, parsed.sessionId);

			case "not_found":
				throw new Error(`No session found matching '${resolved.arg}'`);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return open(resolved.path);

			case "global": {
				if (fileHost) return open(resolved.path);
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					return undefined;
				}
				return fork(resolved.path);
			}

			case "not_found":
				throw new Error(`No session found matching '${resolved.arg}'`);
		}
	}

	if (parsed.resume) {
		initTheme(settingsManager.getTheme(), true);
		try {
			const selectedPath = await selectSession(
				(onProgress) => SessionManager.list(cwd, sessionDir, onProgress),
				(onProgress) => SessionManager.listAll(sessionDir, onProgress),
				fileHost?.files,
				signal,
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				return undefined;
			}
			return open(selectedPath);
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		if (!fileHost) return SessionManager.continueRecent(cwd, sessionDir);
		const recent = findMostRecentSession(fileHost.sessionDir, cwd);
		if (recent) return open(recent, cwd);
	}

	if (parsed.sessionId) {
		const existingSession = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
		if (existingSession) {
			return open(existingSession.path);
		}
	}

	return fileHost
		? fileHost.files.create({ cwd, sessionDir: fileHost.sessionDir, id: parsed.sessionId })
		: SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			modelRegistry,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// Tools
	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}
	if (parsed.excludeTools) {
		options.excludeTools = [...parsed.excludeTools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
	signal?: AbortSignal,
): Promise<string | undefined> {
	initTheme(settingsManager.getTheme());
	setKeybindings(KeybindingsManager.create());

	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal(), settingsManager.getShowHardwareCursor());
		ui.setClearOnShrink(settingsManager.getClearOnShrink());

		let settled = false;
		const finish = (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			signal?.removeEventListener("abort", cancel);
			ui.stop();
			resolve(result);
		};
		const cancel = () => finish(undefined);

		const selector = new ExtensionSelectorComponent(
			formatMissingSessionCwdPrompt(issue),
			["Continue", "Cancel"],
			(option) => finish(option === "Continue" ? issue.fallbackCwd : undefined),
			() => finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		ui.start();
		if (signal?.aborted) cancel();
		else signal?.addEventListener("abort", cancel, { once: true });
	});
}

export interface MainOptions {
	extensionFactories?: ExtensionFactory[];
	host?: MainHost;
}

export async function main(args: string[], options?: MainOptions) {
	resetTimings();
	const host = options?.host;
	if (host) configureHttpDispatcher();
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
	if (offlineMode) {
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";
	}

	if (!host && process.platform === "win32") {
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}

	if (!host && (await handlePackageCommand(args))) {
		return;
	}

	if (!host && (await handleConfigCommand(args))) {
		return;
	}

	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");
	if (parsed.version) {
		console.log(host?.version ?? VERSION);
		return;
	}
	if (host && parsed.help) {
		printHelp(undefined, host);
		return;
	}
	if (host && args[0] && ["install", "remove", "uninstall", "update", "list", "config"].includes(args[0])) {
		console.error(`Use pi ${args[0]} to manage packages or settings.`);
		process.exitCode = 1;
		return;
	}
	const appMode = resolveAppMode(parsed, process.stdin.isTTY);
	const shouldTakeOverStdout = appMode !== "interactive";
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, { outputPath, readOnly: !!host, appName: host?.name });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		restoreStdout();
		console.log(`Exported to: ${result}`);
		return;
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	validateForkFlags(parsed);
	validateSessionIdFlags(parsed);
	if (parsed.name !== undefined && !parsed.name.trim()) {
		console.error(chalk.red("Error: --name requires a non-empty value"));
		process.exit(1);
	}

	const startupAbort = new AbortController();
	const startupSignals: Array<[NodeJS.Signals, number]> = [
		["SIGINT", 130],
		["SIGTERM", 143],
	];
	if (process.platform !== "win32") startupSignals.push(["SIGHUP", 129]);
	const startupSignalHandlers = host
		? startupSignals.map(([signal, exitCode]) => {
				const handler = () => {
					process.exitCode = exitCode;
					startupAbort.abort();
				};
				process.on(signal, handler);
				return () => process.off(signal, handler);
			})
		: [];
	const clearStartupSignals = () => {
		for (const remove of startupSignalHandlers) remove();
	};
	let sessionManager: SessionManager | undefined;
	let runtime: AgentSessionRuntime | undefined;
	let hostProcess: MainHostProcess | undefined;
	try {
		const invocationCwd = process.cwd();
		const cwd = (await host?.resolveStartupCwd?.(invocationCwd)) ?? invocationCwd;
		const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd, {
			externalSessionFiles: !!host,
		});
		time("runMigrations");

		const agentDir = getAgentDir();
		const startupSettingsManager = SettingsManager.create(cwd, agentDir);
		reportDiagnostics(collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"));

		// Decide the final runtime cwd before creating cwd-bound runtime services.
		// --session and --resume may select a session from another project, so project-local
		// settings, resources, provider registrations, and models must be resolved only after
		// the target session cwd is known. The startup-cwd settings manager is used only for
		// sessionDir lookup during session selection.
		const envSessionDir = process.env[ENV_SESSION_DIR];
		const sessionDir = host
			? await host.files.resolveSessionDir({ agentDir, sessionDir: parsed.sessionDir })
			: ((parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
				(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
				startupSettingsManager.getSessionDir());
		if (startupAbort.signal.aborted) return;
		const fileHost = host && sessionDir !== undefined ? { files: host.files, sessionDir } : undefined;
		sessionManager = await createSessionManager(
			parsed,
			cwd,
			sessionDir,
			startupSettingsManager,
			fileHost,
			startupAbort.signal,
		);
		if (!sessionManager || startupAbort.signal.aborted) return;
		const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
		if (missingSessionCwdIssue) {
			if (appMode === "interactive") {
				const selectedCwd = await promptForMissingSessionCwd(
					missingSessionCwdIssue,
					startupSettingsManager,
					startupAbort.signal,
				);
				if (!selectedCwd) {
					return;
				}
				const path = missingSessionCwdIssue.sessionFile!;
				sessionManager = fileHost
					? await fileHost.files.open({
							path,
							cwd,
							sessionDir: fileHost.sessionDir,
							cwdOverride: selectedCwd,
							previous: sessionManager,
						})
					: SessionManager.open(path, sessionDir, selectedCwd);
			} else {
				console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
				process.exitCode = 1;
				return;
			}
		}
		if (parsed.name !== undefined) {
			sessionManager.appendSessionInfo(parsed.name.trim());
		}
		time("createSessionManager");
		if (host && parsed.listModels === undefined && !startupAbort.signal.aborted) {
			hostProcess = await host.start({ cwd, agentDir, mode: appMode });
		}
		if (startupAbort.signal.aborted) return;

		const resolvedExtensionPaths = resolveCliPaths(invocationCwd, parsed.extensions);
		const resolvedSkillPaths = resolveCliPaths(invocationCwd, parsed.skills);
		const resolvedPromptTemplatePaths = resolveCliPaths(invocationCwd, parsed.promptTemplates);
		const resolvedThemePaths = resolveCliPaths(invocationCwd, parsed.themes);
		const authStorage = AuthStorage.create();
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			agentDir,
			sessionManager,
			sessionStartEvent,
		}) => {
			let hostSession: MainHostSession | undefined;
			try {
				hostSession = await hostProcess?.prepareSession({ cwd, agentDir, sessionManager });
				const services = await createAgentSessionServices({
					cwd,
					runtimeCwd: hostSession?.runtimeCwd,
					executionBackend: hostSession?.executionBackend,
					runtimeEnvironmentOverride: hostSession?.runtimeEnvironmentOverride,
					agentDir,
					authStorage,
					extensionFlagValues: parsed.unknownFlags,
					resourceLoaderOptions: {
						additionalExtensionPaths: resolvedExtensionPaths,
						additionalSkillPaths: resolvedSkillPaths,
						additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
						additionalThemePaths: resolvedThemePaths,
						noExtensions: parsed.noExtensions,
						noSkills: parsed.noSkills,
						noPromptTemplates: parsed.noPromptTemplates,
						noThemes: parsed.noThemes,
						noContextFiles: parsed.noContextFiles,
						systemPrompt: parsed.systemPrompt,
						appendSystemPrompt: parsed.appendSystemPrompt,
						extensionFactories: [
							...(options?.extensionFactories ?? []),
							...(hostSession?.extensionFactories ?? []),
						],
					},
				});
				const { settingsManager, modelRegistry, resourceLoader } = services;
				const diagnostics: AgentSessionRuntimeDiagnostic[] = [
					...services.diagnostics,
					...collectSettingsDiagnostics(settingsManager, "runtime creation"),
					...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
						type: "error" as const,
						message: `Failed to load extension "${path}": ${error}`,
					})),
				];

				const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
				const scopedModels =
					modelPatterns && modelPatterns.length > 0 ? await resolveModelScope(modelPatterns, modelRegistry) : [];
				const {
					options: sessionOptions,
					cliThinkingFromModel,
					diagnostics: sessionOptionDiagnostics,
				} = buildSessionOptions(
					parsed,
					scopedModels,
					sessionManager.buildSessionContext().messages.length > 0,
					modelRegistry,
					settingsManager,
				);
				diagnostics.push(...sessionOptionDiagnostics);

				if (parsed.apiKey) {
					if (!sessionOptions.model) {
						diagnostics.push({
							type: "error",
							message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
						});
					} else {
						authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
					}
				}

				const createOptions: CreateAgentSessionFromServicesOptions = {
					services,
					sessionManager,
					sessionStartEvent,
					model: sessionOptions.model,
					thinkingLevel: sessionOptions.thinkingLevel,
					scopedModels: sessionOptions.scopedModels,
					tools: sessionOptions.tools,
					excludeTools: sessionOptions.excludeTools,
					noTools: sessionOptions.noTools,
					customTools: sessionOptions.customTools,
				};
				if (host && diagnostics.some(({ type }) => type === "error")) {
					throw new Error(
						diagnostics
							.filter(({ type }) => type === "error")
							.map(({ message }) => message)
							.join("\n"),
					);
				}
				const created = hostSession
					? await hostSession.createSession(createOptions)
					: await createAgentSessionFromServices(createOptions);
				const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
				if (created.session.model && cliThinkingOverride) {
					created.session.setThinkingLevel(created.session.thinkingLevel);
				}

				return {
					...created,
					services,
					diagnostics,
					hostSession,
				};
			} catch (error) {
				await hostSession?.close();
				throw error;
			}
		};
		time("createRuntime");
		runtime = await createAgentSessionRuntime(
			createRuntime,
			{
				cwd: sessionManager.getCwd(),
				agentDir,
				sessionManager,
			},
			{ files: fileHost?.files, sessionDir: fileHost?.sessionDir, onExit: hostProcess?.close.bind(hostProcess) },
		);
		time("createAgentSessionRuntime");
		const { services, session, modelFallbackMessage } = runtime;
		const { settingsManager, modelRegistry, resourceLoader } = services;
		configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

		if (parsed.help) {
			const extensionFlags = resourceLoader
				.getExtensions()
				.extensions.flatMap((extension) => Array.from(extension.flags.values()));
			restoreStdout();
			printHelp(extensionFlags);
			return;
		}

		if (parsed.listModels !== undefined) {
			const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
			restoreStdout();
			await listModels(modelRegistry, searchPattern);
			return;
		}

		// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
		let stdinContent: string | undefined;
		if (appMode !== "rpc") {
			stdinContent = await readPipedStdin(startupAbort.signal);
		}
		time("readPipedStdin");
		if (startupAbort.signal.aborted) return;

		const { initialMessage, initialImages } = await prepareInitialMessage(
			parsed,
			settingsManager.getImageAutoResize(),
			stdinContent,
			host ? runtime.cwd : undefined,
		);
		time("prepareInitialMessage");
		if (startupAbort.signal.aborted) return;
		initTheme(settingsManager.getTheme(), appMode === "interactive");
		time("initTheme");

		// Show deprecation warnings in interactive mode
		if (appMode === "interactive" && deprecationWarnings.length > 0) {
			await showDeprecationWarnings(deprecationWarnings, startupAbort.signal);
		}
		if (startupAbort.signal.aborted) return;

		time("resolveModelScope");
		reportDiagnostics(runtime.diagnostics);
		if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
			process.exitCode = 1;
			return;
		}
		time("createAgentSession");

		if (appMode !== "interactive" && !session.model) {
			console.error(chalk.red(formatNoModelsAvailableMessage()));
			process.exitCode = 1;
			return;
		}

		const startupBenchmark = isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK);
		if (startupBenchmark && appMode !== "interactive") {
			console.error(chalk.red("Error: PI_STARTUP_BENCHMARK only supports interactive mode"));
			process.exitCode = 1;
			return;
		}

		clearStartupSignals();
		if (appMode === "rpc") {
			printTimings();
			await runRpcMode(runtime);
		} else if (appMode === "interactive") {
			const interactiveMode = new InteractiveMode(runtime, {
				migratedProviders,
				modelFallbackMessage,
				initialMessage,
				initialImages,
				initialMessages: parsed.messages,
				verbose: parsed.verbose,
				identity: host,
			});
			if (startupBenchmark) {
				try {
					await interactiveMode.init();
				} finally {
					interactiveMode.stop();
				}
				time("interactiveMode.init");
				printTimings();
				stopThemeWatcher();
				if (process.stdout.writableLength > 0) {
					await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
				}
				if (process.stderr.writableLength > 0) {
					await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
				}
				return;
			}

			printTimings();
			try {
				await interactiveMode.run();
			} catch (error) {
				interactiveMode.stop();
				throw error;
			}
		} else {
			printTimings();
			const exitCode = await runPrintMode(runtime, {
				mode: toPrintOutputMode(appMode),
				messages: parsed.messages,
				initialMessage,
				initialImages,
			});
			stopThemeWatcher();
			restoreStdout();
			if (exitCode !== 0) {
				process.exitCode = exitCode;
			}
			return;
		}
	} catch (error) {
		if (!startupAbort.signal.aborted) {
			console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
			process.exitCode = 1;
		}
	} finally {
		try {
			if (runtime) await runtime.dispose();
			else {
				try {
					if (sessionManager) await host?.files.release(sessionManager);
				} finally {
					await hostProcess?.close();
				}
			}
		} finally {
			clearStartupSignals();
			stopThemeWatcher();
			restoreStdout();
		}
	}
}
