import { join } from "node:path";
import {
  AuthStorage,
  createActiveCompressionExtension,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  type AgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ExtensionFactory,
  type RequestUserInputHandler,
  type SessionManager,
  type SessionShutdownEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { McpAdapter } from "pi-mcp-adapter";
import { workspaceIdOf } from "./agent-task/agent-task-identity.js";
import type { AgentTaskDeliveryContent, AgentTaskService } from "./agent-task/agent-task-service.js";
import { runParentAnswer } from "./agent-task/parent-answer.js";
import type { ProjectExecutionContext } from "./execution-context.js";
import { createPlanDelegation } from "./plan/plan-delegation.js";
import {
  isPlanRestrictedPhase,
  PlanController,
  type PlanControllerContext,
  type PlanDisposeReason,
  type PlanRestoreOptions,
  type PlanUserRequest,
} from "./plan/plan-controller.js";
import { createSubmitUserPlanTool, createUpdatePlanStepTool } from "./plan/plan-tools.js";
import { formatInternalNotification, INTERNAL_CUSTOM_MESSAGE_TYPES } from "./shared/internal-notification.js";
import { PRODUCT_EVENT_SCHEMA_VERSION, type ProductEvent } from "./shared/product-events.js";
import type { SubagentUsage } from "./shared/subagent-types.js";
import { WORKFLOW_RECORD_CUSTOM_TYPE, type WorkflowResult } from "./shared/workflow-types.js";
import { createInspectAgentTaskTool } from "./subagent/inspect-agent-task.js";
import { SHELL_BACKGROUND_TOOLS, SubagentRunner } from "./subagent/subagent-runner.js";
import { createSubagentToolDefinition } from "./subagent/subagent-tool.js";
import { TodoController } from "./todo/todo-controller.js";
import { createTodoWriteTool } from "./todo/todo-tool.js";
import { WorkflowChildCache } from "./workflow/child-cache.js";
import { createAgentTaskChildSpawner } from "./workflow/child-spawner.js";
import { WorkerThreadWorkflowEngine } from "./workflow/engine/index.js";
import { createWorkflowRecorder, type WorkflowRecorder } from "./workflow/recorder.js";
import { createRalphToolDefinition } from "./workflow/tool-ralph.js";
import { createWorkflowToolDefinition, type WorkflowToolHost } from "./workflow/tool-workflow.js";

export interface SoloSessionOptions {
  runtime: { taskService?: AgentTaskService; workflowCacheDir: string };
  context: ProjectExecutionContext;
  sessionOptions: CreateAgentSessionOptions & { agentDir: string; sessionManager: SessionManager };
  mcpAdapter?: McpAdapter;
  cli?: { foregroundOnly: boolean };
  requestUserInput?: RequestUserInputHandler;
  preparePlanningPrompt?: (request: PlanUserRequest) => Promise<{
    text: string;
    options?: Parameters<AgentSession["prompt"]>[1];
  }>;
  resolvePlanningModel?: (session: AgentSession) => ReturnType<PlanControllerContext["resolvePlanningModel"]>;
  recordAuxiliaryUsage?: (usage: SubagentUsage) => void;
  recordProductEvent?: (event: ProductEvent) => void;
  hostTools?: (refs: { getSession: () => AgentSession | null; isPlanRestricted: () => boolean }) => {
    extensionFactories?: ExtensionFactory[];
    customTools?: ToolDefinition[];
  };
}

export interface SoloSessionCloseOptions {
  reason?: SessionShutdownEvent["reason"];
  targetSessionFile?: string;
  planReason?: PlanDisposeReason;
  appShuttingDown?: boolean;
  markInputClosing?: () => void;
  closeInput?: () => void;
  onBeforeParentClose?: () => void;
  disposeHostTools?: () => void | Promise<void>;
}

export interface SoloSession extends CreateAgentSessionResult {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  runner: SubagentRunner;
  planController: PlanController;
  todoController: TodoController;
  workflowEngine: WorkerThreadWorkflowEngine;
  workflowRecorder: WorkflowRecorder;
  mcpAdapter: McpAdapter;
  initialize(options?: Pick<PlanRestoreOptions, "taskLinkHydration">): Promise<void>;
  suspendDelivery(): void;
  close(options?: SoloSessionCloseOptions): Promise<void>;
}

export function createSoloExtensionFactories(
  mcpAdapter: McpAdapter,
  getSessionManager: () => SessionManager,
): ExtensionFactory[] {
  return [(pi) => { mcpAdapter.register(pi); }, createActiveCompressionExtension(getSessionManager)];
}

export async function setSessionAcp(session: AgentSession, enabled: boolean): Promise<void> {
  if (session.isAcpLocked()) throw new Error("ACP_LOCKED");
  session.sessionManager.setAcp(enabled);
  await session.reload();
}

function formatDeliveryContent(content: AgentTaskDeliveryContent): string {
  return formatInternalNotification({
    notificationId: `task-result:${content.taskId}:${content.groupId}`,
    source: "agent-task",
    kind: "task-result",
    taskId: content.taskId,
    groupId: content.groupId,
    status: content.status,
    requiresAction: content.status !== "completed" || Boolean(content.errorMessage),
    result: content.finalOutput || content.summary,
    error: content.errorMessage,
    usage: content.usage,
    planLink: content.planLink,
    items: content.items.map((item) => ({
      id: item.id,
      index: item.index,
      step: item.step,
      agentName: item.agentName,
      agentSource: item.agentSource,
      status: item.status,
      ...(content.items.length > 1 ? { result: item.finalOutput } : {}),
      error: item.errorMessage,
      usage: item.usage,
    })),
  });
}

export async function createSoloSession(options: SoloSessionOptions): Promise<SoloSession> {
  const { context, sessionOptions, cli } = options;
  const { taskService, workflowCacheDir } = options.runtime;
  const { agentDir, sessionManager } = sessionOptions;
  const workspaceId = workspaceIdOf(context.physicalCwd);
  const authStorage = sessionOptions.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = sessionOptions.modelRegistry ?? ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  const mcpAdapter = options.mcpAdapter ?? new McpAdapter({ allowStdio: !context.isWsl });
  const requestUserInput: RequestUserInputHandler = options.requestUserInput ?? sessionOptions.requestUserInput ??
    (async (request) => ({ id: request.id, answers: {}, cancelled: true }));
  let parent: AgentSession | null = null;
  let resourceLoader = sessionOptions.resourceLoader;
  let deliveryEnabled = false;
  let unsubscribeDelivery: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  let acceptingWork = true;
  const finishingRuns = new Set<Promise<WorkflowResult>>();

  const runner = new SubagentRunner({
    agentDir,
    modelRegistry,
    foregroundOnly: cli?.foregroundOnly,
    getLoadedAgents: () => resourceLoader?.getAgents?.(),
    getParentRuntime: () => ({
      model: parent?.model,
      thinkingLevel: parent?.thinkingLevel ?? "off",
      executionMode: parent?.settingsManager.getExecutionMode() ?? "approval",
      verificationGate: parent?.settingsManager.getVerificationGateEnabled() ?? false,
      acp: sessionManager.getAcp() === true,
    }),
    requestUserInput,
    parentAnswer: (info, request, signal) => parent
      ? runParentAnswer(parent, info, request, signal)
      : Promise.resolve(undefined),
    recordAuxiliaryUsage: (usage) => options.recordAuxiliaryUsage?.(usage),
    getTaskService: () => acceptingWork ? taskService : undefined,
    getSessionId: () => sessionManager.getSessionId(),
    getProjectLocation: () => context.location,
  });
  const delegation = taskService ? createPlanDelegation(taskService, runner, context, sessionManager, cli !== undefined) : undefined;
  const planController = new PlanController({
    ...delegation?.controllerOptions,
    persistForegroundTaskResult: cli !== undefined,
    getSession: () => parent!,
    getSessionManager: () => sessionManager,
    getProjectLocation: () => context.location,
    getExecutionContext: () => context,
    getExecutionMode: () => parent?.settingsManager.getExecutionMode() ?? "approval",
    resolvePlanningModel: () => {
      if (!parent) return { error: "no active session" };
      if (options.resolvePlanningModel) return options.resolvePlanningModel(parent);
      if (!parent.model) return { error: "the session has no active model" };
      return { model: parent.model, thinkingLevel: parent.thinkingLevel };
    },
    promptPlanningRequest: async (request) => {
      const prepared = await options.preparePlanningPrompt?.(request);
      if (!parent) throw new Error("No active session.");
      await parent.prompt(prepared?.text ?? request.text, prepared?.options);
    },
    requestUserInput,
    recordProductEvent: (event) => options.recordProductEvent?.(event),
  });
  const todoController = new TodoController(() => sessionManager.getSessionId());
  const workflowEngine = new WorkerThreadWorkflowEngine(
    taskService ? createAgentTaskChildSpawner(taskService) : {
      async start() { throw new Error("The agent task service is not available."); },
    },
    {
      getRunningSlotCap: taskService ? () => taskService.getMaxConcurrentSlots() : undefined,
      cache: new WorkflowChildCache({ rootDir: workflowCacheDir }),
    },
  );
  const workflowRecorder = createWorkflowRecorder({
    append: (data) => sessionManager.appendCustomEntry(WORKFLOW_RECORD_CUSTOM_TYPE, data),
    engine: workflowEngine,
    onLifecycle: (event, payload) => options.recordProductEvent?.({
      schemaVersion: PRODUCT_EVENT_SCHEMA_VERSION,
      name: `workflow_${event}`,
      payload,
    }),
  });
  const deliveries = new Set<Promise<void>>();
  const deliver = async (content: string, details: unknown): Promise<void> => {
    if (!parent || !deliveryEnabled) throw new Error("target_session_not_open");
    const pending = parent.sendCustomMessage({
      customType: INTERNAL_CUSTOM_MESSAGE_TYPES.TASK_RESULT,
      content,
      display: false,
      details,
      context: "internal",
    }, parent.isStreaming ? { deliverAs: "followUp" } : { triggerTurn: true });
    deliveries.add(pending);
    try {
      await pending;
    } finally {
      deliveries.delete(pending);
    }
  };
  const workflowHost: WorkflowToolHost = {
    engine: workflowEngine,
    recorder: workflowRecorder,
    foregroundOnly: cli?.foregroundOnly,
    getParentRef: (toolCallId) => {
      if (!parent || !acceptingWork) throw new Error("workflow tool called without an active parent session");
      return {
        sessionId: sessionManager.getSessionId(),
        toolCallId,
        workspaceId,
        getSubmissionContext: () => runner.assembleSubmissionContext(toolCallId),
      };
    },
    deliverNotification: (notification) => deliver(formatInternalNotification(notification), notification),
    trackRun: (completion) => {
      finishingRuns.add(completion);
      void completion.then(() => finishingRuns.delete(completion), () => finishingRuns.delete(completion));
    },
  };
  const suspendDelivery = (): void => {
    deliveryEnabled = false;
    unsubscribeDelivery?.();
    unsubscribeDelivery = undefined;
  };
  const close = (closeOptions: SoloSessionCloseOptions = {}): Promise<void> => {
    acceptingWork = false;
    return closing ??= (async () => {
      suspendDelivery();
      try {
        await workflowEngine.disposeAll(closeOptions.appShuttingDown && !cli);
      } finally {
        await Promise.allSettled(finishingRuns);
        try {
          if (parent && !cli) {
            taskService?.detachForegroundGroupsForSession(parent.sessionId);
            // Let detached Plan waits persist their group link before disposal.
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
          const planDispose = planController.dispose(closeOptions.planReason ?? (closeOptions.appShuttingDown ? "app_shutdown" : "session_close"));
          todoController.dispose();
          closeOptions.markInputClosing?.();
          const runnerDispose = runner.dispose();
          closeOptions.closeInput?.();
          const hostDispose = Promise.resolve().then(closeOptions.disposeHostTools);
          const cleanup = [planDispose, runnerDispose, hostDispose];
          if (delegation) cleanup.push(delegation.close());
          if (cli && taskService) {
            cleanup.push(taskService.cancelAndWait(taskService.getAll(workspaceId).tasks
              .filter((task) => task.parentSessionId === sessionManager.getSessionId() && task.presentation === "foreground" && !task.planLink)
              .map((task) => task.taskId)));
          }
          const errors = (await Promise.allSettled(cleanup))
            .filter((result) => result.status === "rejected")
            .map((result) => result.reason);
          if (errors.length > 0) throw new AggregateError(errors, "Solo session cleanup failed");
        } finally {
          try {
            closeOptions.onBeforeParentClose?.();
            if (cli) {
              await parent?.abort();
              await Promise.allSettled(deliveries);
            }
            sessionManager.flushIfHasUserMessages();
          } finally {
            try {
              await parent?.dispose({ reason: closeOptions.reason, targetSessionFile: closeOptions.targetSessionFile });
            } finally {
              await mcpAdapter.dispose();
            }
          }
        }
      }
    })();
  };
  try {
    const hostTools = options.hostTools?.({
      getSession: () => parent,
      isPlanRestricted: () => isPlanRestrictedPhase(planController.getSnapshot().phase),
    });
    if (!resourceLoader) {
      resourceLoader = new DefaultResourceLoader({
        cwd: context.physicalCwd,
        agentDir,
        settingsManager: sessionOptions.settingsManager,
        extensionFactories: [
          ...createSoloExtensionFactories(mcpAdapter, () => sessionManager),
          ...hostTools?.extensionFactories ?? [],
        ],
      });
      await resourceLoader.reload();
    }
    const inspectTool = taskService ? createInspectAgentTaskTool({
      service: taskService,
      workspaceId,
      getParentSessionId: () => sessionManager.getSessionId(),
    }) : undefined;
    const result = await createAgentSession({
      ...sessionOptions,
      cwd: context.physicalCwd,
      runtimeCwd: context.logicalCwd,
      executionBackend: context.executionBackend,
      runtimeEnvironmentOverride: context.runtimeEnvironmentOverride,
      authStorage,
      modelRegistry,
      resourceLoader,
      requestUserInput,
      excludeTools: context.isWsl ? [...sessionOptions.excludeTools ?? [], ...SHELL_BACKGROUND_TOOLS] : sessionOptions.excludeTools,
      customTools: [
        ...sessionOptions.customTools ?? [],
        createSubagentToolDefinition({ getRunner: () => runner }) as ToolDefinition,
        ...(inspectTool ? [inspectTool as ToolDefinition] : []),
        createSubmitUserPlanTool({ controller: planController }) as ToolDefinition,
        createUpdatePlanStepTool({ controller: planController }) as ToolDefinition,
        createWorkflowToolDefinition(workflowHost) as ToolDefinition,
        createRalphToolDefinition(workflowHost) as ToolDefinition,
        createTodoWriteTool(todoController) as ToolDefinition,
        ...hostTools?.customTools ?? [],
      ],
      hostToolPolicyOverride: (input) => planController.decideToolPolicy(input) ?? sessionOptions.hostToolPolicyOverride?.(input),
    });
    parent = result.session;
    return {
      ...result,
      authStorage,
      modelRegistry,
      runner,
      planController,
      todoController,
      workflowEngine,
      workflowRecorder,
      mcpAdapter,
      initialize: async (restoreOptions) => {
        const entries = sessionManager.getEntries();
        await planController.restoreFromHistory(entries, {
          ...restoreOptions,
          ...(cli ? {
            taskLinkHydration: "session_reopen",
            canResumeTaskGroup: (groupId: string) => taskService?.hasSessionTaskGroup(groupId, sessionManager.getSessionId(), workspaceId) === true,
          } : undefined),
        });
        workflowRecorder.restore(entries);
        if (!acceptingWork) return;
        deliveryEnabled = true;
        unsubscribeDelivery = taskService?.registerSessionDeliverySink(result.session.sessionId, workspaceId,
          (content) => deliver(formatDeliveryContent(content), content));
      },
      suspendDelivery,
      close,
    };
  } catch (error) {
    await close({ planReason: "host_disposed" });
    throw error;
  }
}
