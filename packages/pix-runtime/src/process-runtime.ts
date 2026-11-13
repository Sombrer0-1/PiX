import { randomUUID } from "node:crypto";
import { closeAllMcpConnections } from "pi-mcp-adapter";
import { AgentTaskService, type AgentTaskSettings } from "./agent-task/agent-task-service.js";
import {
  AGENT_TASK_DEFAULT_MAX_TASK_BYTES,
  AGENT_TASK_DEFAULT_MAX_WORKSPACE_BYTES,
  AgentTaskStore,
} from "./agent-task/agent-task-store.js";
import type { ProductEvent } from "./shared/product-events.js";

export interface PixProcessRuntimeOptions {
  taskDir: string;
  workflowCacheDir: string;
  settings?: AgentTaskSettings;
  recordProductEvent?: (event: ProductEvent) => void;
  runId?: string;
}

export function createPixProcessRuntime(options: PixProcessRuntimeOptions) {
  const runId = options.runId ?? randomUUID();
  const taskStore = new AgentTaskStore({
    rootDir: options.taskDir,
    maxTaskBytes: AGENT_TASK_DEFAULT_MAX_TASK_BYTES,
    maxWorkspaceBytes: AGENT_TASK_DEFAULT_MAX_WORKSPACE_BYTES,
  });
  const taskService = new AgentTaskService({
    store: taskStore,
    settings: options.settings ?? {},
    recordProductEvent: options.recordProductEvent,
    runId,
  });
  let closing: Promise<void> | undefined;
  return {
    runId,
    taskStore,
    taskService,
    workflowCacheDir: options.workflowCacheDir,
    close({ desktop = false } = {}): Promise<void> {
      return closing ??= (async () => {
        try {
          // The desktop service is already frozen and disposed before its bridges close.
          if (!desktop) {
            try {
              await taskService.cancelAndWait(taskService.getAll().tasks.map((task) => task.taskId));
            } finally {
              await taskService.dispose("app_shutdown");
            }
          }
        } finally {
          await closeAllMcpConnections();
        }
      })();
    },
  };
}

export type PixProcessRuntime = ReturnType<typeof createPixProcessRuntime>;
