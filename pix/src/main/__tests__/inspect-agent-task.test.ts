import type {
  AgentTaskInfo,
  AgentTaskLogSnapshot,
  AgentTaskTranscriptPage,
} from "../../shared/agent-task-types.js";
import type { AgentTaskService } from "../agent-task/agent-task-service.js";
import { createInspectAgentTaskTool } from "../subagent/inspect-agent-task.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

const task = {
  taskId: "task-1",
  groupId: "group-1",
  workspaceId: "workspace-1",
  parentSessionId: "parent-1",
  status: "completed",
  presentation: "background",
  description: "Inspect the repository",
  itemSummaries: [{ index: 0, agentName: "researcher", status: "completed" }],
  usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: 0.01, turns: 1 },
  finalOutput: "The repository is consistent.",
  results: [
    {
      id: "item-1",
      index: 0,
      agentName: "researcher",
      agentSource: "user",
      status: "completed",
      finalOutput: "The repository is consistent.",
      usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: 0.01, turns: 1 },
    },
  ],
} as unknown as AgentTaskInfo;

const transcript: AgentTaskTranscriptPage = {
  taskId: "task-1",
  itemIndex: 0,
  entries: [{ type: "message", message: { role: "assistant", content: "evidence" } }],
  nextCursor: "next",
  totalCount: 1,
};

const log: AgentTaskLogSnapshot = {
  taskId: "task-1",
  events: [{ seq: 1, ts: 1, type: "completed" }],
  truncated: false,
};

const service = {
  getAll: () => ({ tasks: [task] }),
  getTranscriptPage: async () => transcript,
  getTaskLog: async () => log,
} as unknown as AgentTaskService;

const tool = createInspectAgentTaskTool({
  service,
  workspaceId: "workspace-1",
  getParentSessionId: () => "parent-1",
});

type Execute = (toolCallId: string, params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}>;

const execute = tool.execute as unknown as Execute;

const summary = await execute("inspect-1", { taskId: "task-1" });
assertEqual(summary.isError, undefined, "summary succeeds for a visible task");
assert(summary.content[0]?.text?.includes("The repository is consistent.") === true, "summary includes the task result");
assert(summary.details.task !== task, "summary details are cloned for the caller");

const group = await execute("inspect-2", { groupId: "group-1" });
assertEqual(group.isError, undefined, "group summary succeeds");
assert(group.content[0]?.text?.includes("group-1") === true, "group summary includes the group id");

const transcriptResult = await execute("inspect-3", {
  taskId: "task-1",
  view: "transcript",
  itemIndex: 0,
  cursor: "cursor-1",
  limit: 5,
});
assertEqual(transcriptResult.isError, undefined, "transcript view succeeds");
assertEqual(JSON.stringify(transcriptResult.details.transcript), JSON.stringify(transcript), "transcript details are returned");

const logResult = await execute("inspect-4", { taskId: "task-1", view: "log" });
assertEqual(logResult.isError, undefined, "log view succeeds");
assertEqual(JSON.stringify(logResult.details.log), JSON.stringify(log), "log details are returned");

const unauthorizedTool = createInspectAgentTaskTool({
  service,
  workspaceId: "workspace-1",
  getParentSessionId: () => "other-parent",
});
const unauthorized = await (unauthorizedTool.execute as unknown as Execute)("inspect-5", { taskId: "task-1" });
assert(typeof unauthorized.details.error === "string", "task lookup is scoped to the parent session");

const invalid = await execute("inspect-6", { taskId: "task-1", groupId: "group-1" });
assert(typeof invalid.details.error === "string", "taskId and groupId cannot be combined");

const missingService = {
  getAll: () => ({ tasks: [task] }),
  getTranscriptPage: async () => {
    throw new Error("not_found");
  },
  getTaskLog: async () => {
    throw new Error("not_found");
  },
} as unknown as AgentTaskService;
const missingTool = createInspectAgentTaskTool({
  service: missingService,
  workspaceId: "workspace-1",
  getParentSessionId: () => "parent-1",
});
const missingTranscript = await (missingTool.execute as unknown as Execute)("inspect-7", {
  taskId: "task-1",
  view: "transcript",
});
assert(typeof missingTranscript.details.error === "string", "transcript not_found becomes a failureResult");
assert(missingTranscript.details.error.includes("no longer available") === true, "transcript not_found names the missing task");
const missingLog = await (missingTool.execute as unknown as Execute)("inspect-8", {
  taskId: "task-1",
  view: "log",
});
assert(typeof missingLog.details.error === "string", "log not_found becomes a failureResult");

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
