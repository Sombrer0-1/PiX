import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AppMode,
	MainHost,
	MainHostSession,
	RequestUserInputHandler,
	SessionHostIO,
} from "@earendil-works/pi-coding-agent";
import {
	createPixProcessRuntime,
	createProjectExecutionContext,
	createSoloExtensionFactories,
	createSoloSession,
	disposeProjectExecutionContext,
	McpAdapter,
	type SoloSession,
	workspaceIdOf,
} from "@earendil-works/pix-runtime";
import type { AgentTaskInputRequest } from "@earendil-works/pix-runtime/shared";
import { cliCommands, formatPlan, formatTodo } from "./commands.js";
import { CliProjects } from "./project.js";
import { CliSessionFiles } from "./session-files.js";

interface CliOptions {
	acp: boolean;
	wsl?: { distro: string; logicalPath: string };
}

export function parseCliOptions(args: string[]): { args: string[]; options: CliOptions } {
	const remaining: string[] = [];
	let acp = false;
	let distro: string | undefined;
	let logicalPath: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const [flag, ...valueParts] = arg.split("=");
		if (arg === "--acp" || arg === "--no-acp") {
			acp = arg === "--acp";
		} else if (flag === "--wsl-distro" || flag === "--wsl-path") {
			const value = valueParts.length ? valueParts.join("=") : args[++i];
			if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
			if (flag === "--wsl-distro") distro = value;
			else logicalPath = value;
		} else {
			remaining.push(arg);
		}
	}
	if (distro && logicalPath) return { args: remaining, options: { acp, wsl: { distro, logicalPath } } };
	if (distro || logicalPath) throw new Error("WSL2 projects require both --wsl-distro and --wsl-path.");
	return { args: remaining, options: { acp } };
}

export function createCliHost(version: string, options: CliOptions): MainHost {
	const projects = new CliProjects(options.wsl);
	return {
		name: "pix",
		version,
		help: {
			sessionDirDescription: "Select a subdirectory within <agentDir>/pix-cli-sessions",
			additionalOptions: [
				"  --acp, --no-acp                Enable or disable active compression for new sessions (default: off)",
				"  --wsl-distro <name>            WSL2 distribution name on the Windows host",
				"  --wsl-path <absolute path>     Project path inside that WSL2 distribution",
			].join("\n"),
		},
		files: new CliSessionFiles(options.acp, (manager, parent) => projects.markNewProject(manager, parent)),
		resolveStartupCwd: (cwd) => projects.resolveStartupCwd(cwd),
		async start({ mode }) {
			const runDir = await mkdtemp(join(tmpdir(), "pix-cli-"));
			try {
				const runtime = createPixProcessRuntime({
					taskDir: join(runDir, "agent-tasks"),
					workflowCacheDir: join(runDir, "workflow-cache"),
				});
				return {
					async prepareSession({ sessionManager, agentDir }) {
						const project = await projects.resolveSessionProject(sessionManager);
						const context = await createProjectExecutionContext(project);
						const mcpAdapter = new McpAdapter({ allowStdio: !context.isWsl });
						const sessionId = sessionManager.getSessionId();
						const workspaceId = workspaceIdOf(context.physicalCwd);
						const inputRequests = new Map<string, AbortController>();
						const unsubscribe: (() => void)[] = [];
						const taskStatuses = new Map<string, string>();
						const workflowProgress = new Map<string, string>();
						const observedWorkflowStarts = new Set<string>();
						let observingWorkflowStarts = false;
						let solo: SoloSession | undefined;
						let io: SessionHostIO | undefined;
						const observeWorkflowStarts = () => {
							if (observingWorkflowStarts || mode !== "interactive" || !solo) return;
							observingWorkflowStarts = true;
							unsubscribe.push(
								solo.workflowEngine.on("workflow/start", (info) => {
									observedWorkflowStarts.add(info.id);
								}),
							);
						};
						let closing: Promise<void> | undefined;
						const requestUserInput: RequestUserInputHandler = (request, signal) =>
							io?.requestUserInput(request, signal) ??
							Promise.resolve({ id: request.id, answers: {}, cancelled: true });
						const getSolo = () => {
							if (!solo) throw new Error("PiX session is unavailable.");
							return solo;
						};
						const showTaskInput = (input: AgentTaskInputRequest) => {
							const { taskId, requestId, request, generation } = input;
							const controller = new AbortController();
							inputRequests.set(requestId, controller);
							void requestUserInput(request, controller.signal)
								.then(
									(response) => {
										if (io?.signal?.aborted) return;
										if (response.cancelled) runtime.taskService.cancelInput(taskId, requestId, generation);
										else runtime.taskService.respondInput(taskId, requestId, generation, response);
									},
									(error: unknown) => {
										if (io?.signal?.aborted) return;
										runtime.taskService.cancelInput(taskId, requestId, generation);
										console.error(error instanceof Error ? error.message : String(error));
									},
								)
								.finally(() => inputRequests.delete(requestId));
						};
						const hostSession: MainHostSession = {
							runtimeCwd: context.logicalCwd,
							executionBackend: context.executionBackend,
							runtimeEnvironmentOverride: context.runtimeEnvironmentOverride,
							extensionFactories: createSoloExtensionFactories(mcpAdapter, () => sessionManager),
							commands: cliCommands({ getSolo, taskService: runtime.taskService }),
							async createSession({ services, ...sessionOptions }) {
								solo = await createSoloSession({
									runtime,
									context,
									mcpAdapter,
									cli: { foregroundOnly: isBatchMode(mode) },
									requestUserInput,
									sessionOptions: {
										...sessionOptions,
										agentDir,
										authStorage: services.authStorage,
										modelRegistry: services.modelRegistry,
										settingsManager: services.settingsManager,
										resourceLoader: services.resourceLoader,
									},
								});
								return solo;
							},
							setIO(nextIO) {
								io = nextIO;
								observeWorkflowStarts();
							},
							async initialize() {
								const { planController, todoController, workflowRecorder } = getSolo();
								unsubscribe.push(
									planController.onEvent((event) => {
										io?.emit(
											{ ...event, sessionId },
											event.type === "plan_state" ? formatPlan(event.snapshot) : undefined,
										);
									}),
									todoController.onEvent((event) =>
										io?.emit({ ...event, sessionId }, formatTodo(event.snapshot)),
									),
									workflowRecorder.onViewChange((run) => {
										const phase = run.currentPhase ? ` - ${run.currentPhase}` : "";
										const settled = run.members.filter((member) => member.outcome).length;
										const children = run.members.length
											? ` (${settled}/${run.members.length} tasks complete)`
											: "";
										const progress = `[${run.toolName}] ${run.name} ${run.runId}: ${run.status}${phase}${children}`;
										const text = workflowProgress.get(run.runId) === progress ? undefined : progress;
										workflowProgress.set(run.runId, progress);
										io?.emit(
											mode === "interactive"
												? {
														type: "workflow_event",
														sessionId,
														event: { type: "upsert", run },
														observedStart: observedWorkflowStarts.has(run.runId),
													}
												: { type: "workflow_event", sessionId, event: { type: "upsert", run } },
											text,
										);
									}),
									runtime.taskService.onEvent((event) => {
										if (event.type === "task_removed") {
											if (taskStatuses.delete(event.taskId)) io?.emit({ ...event, sessionId });
											return;
										}
										const task =
											event.type === "task_state"
												? event.task
												: event.type === "task_input"
													? runtime.taskService.get(event.request.taskId)
													: "taskId" in event
														? runtime.taskService.get(event.taskId)
														: undefined;
										if (task?.parentSessionId !== sessionId || task.workspaceId !== workspaceId) return;
										let text: string | undefined;
										if (event.type === "task_state" && taskStatuses.get(task.taskId) !== task.status) {
											taskStatuses.set(task.taskId, task.status);
											text = `[task] ${task.description} ${task.taskId}: ${task.status}`;
										}
										io?.emit({ ...event, sessionId }, text);
										if (event.type === "task_input" && !closing) {
											showTaskInput(event.request);
										} else if (event.type === "task_input_dismissed") {
											inputRequests.get(event.requestId)?.abort();
										}
									}),
								);
								for (const request of runtime.taskService.getActiveInputRequests()) {
									const task = runtime.taskService.get(request.taskId);
									if (task?.parentSessionId === sessionId && task.workspaceId === workspaceId) {
										io?.emit({ type: "task_input", request, sessionId });
										showTaskInput(request);
									}
								}
								await getSolo().initialize();
								if (mode !== "interactive") return;
								const tasks = runtime.taskService
									.getAll(workspaceId)
									.tasks.filter(
										(task) => task.parentSessionId === sessionId && task.workspaceId === workspaceId,
									);
								for (const task of tasks) taskStatuses.set(task.taskId, task.status);
								io?.emit({
									type: "pix_tui_snapshot",
									sessionId,
									tasks,
									plan: getSolo().planController.getSnapshot(),
								});
							},
							close(shutdown) {
								closing ??= (async () => {
									try {
										if (solo) {
											await solo.close({
												...shutdown,
												closeInput: () => {
													for (const controller of inputRequests.values()) controller.abort();
												},
											});
										} else {
											await mcpAdapter.dispose();
										}
									} finally {
										for (const stop of unsubscribe) stop();
										await disposeProjectExecutionContext(context);
									}
								})();
								return closing;
							},
						};
						return hostSession;
					},
					async close() {
						try {
							await runtime.close();
						} finally {
							await rm(runDir, { recursive: true, force: true });
						}
					},
				};
			} catch (error) {
				await rm(runDir, { recursive: true, force: true });
				throw error;
			}
		},
	};
}

function isBatchMode(mode: AppMode): boolean {
	return mode === "print" || mode === "json";
}
