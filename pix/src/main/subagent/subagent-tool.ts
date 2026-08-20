/**
 * The SDK `agent` tool (design plan section 4.7).
 *
 * Mounted as a parent-session SDK custom tool by the SessionBridge (solo role
 * only). The TypeBox schema is locked; normalize produces exactly one of the
 * three mutually exclusive input modes and returns a structured failed result
 * (never a throw) for invalid parameters. Tool failures are ordinary
 * `AgentToolResult` values: error text goes into content, status lives in
 * details; `AgentToolResult` has no `isError` field and no extra fields are
 * written.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MAX_AGENT_NAME_LENGTH } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
  SUBAGENT_MAX_DESCRIPTION_CHARS,
  SUBAGENT_MAX_ERROR_MESSAGE_BYTES,
  SUBAGENT_MAX_RESULTS,
  type SubagentAgentScope,
  type SubagentDetails,
  type SubagentMode,
  type SubagentSingleResult,
} from "../../shared/subagent-types.js";
import type { AgentTaskGroupHandle } from "../../shared/agent-task-types.js";
import type { SubagentToolHost, SubagentTaskItem } from "./types.js";
import { MAX_TOOL_CONTENT_BYTES } from "./subagent-runner.js";

export const SUBAGENT_TOOL_NAME = "agent";

// MAX_AGENT_NAME_LENGTH comes from the coding-agent package root; the other
// SUBAGENT_* caps come from shared.
const SubagentTaskItemSchema = Type.Object({
  subagent_type: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: MAX_AGENT_NAME_LENGTH,
      description: "Agent definition name to delegate to; defaults to general-purpose.",
    }),
  ),
  prompt: Type.String({
    minLength: 1,
    description: "Self-contained task prompt for the subagent.",
  }),
  description: Type.Optional(
    Type.String({
      maxLength: SUBAGENT_MAX_DESCRIPTION_CHARS,
      description: "Short result label for the UI; defaults to a prompt preview.",
    }),
  ),
});

const SubagentParams = Type.Object({
  subagent_type: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: MAX_AGENT_NAME_LENGTH,
      description: "Agent definition name to delegate to; defaults to general-purpose.",
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Self-contained task prompt for a single subagent.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      maxLength: SUBAGENT_MAX_DESCRIPTION_CHARS,
      description: "Short result label for the UI; defaults to a prompt preview.",
    }),
  ),
  tasks: Type.Optional(
    Type.Array(SubagentTaskItemSchema, {
      minItems: 1,
      maxItems: SUBAGENT_MAX_RESULTS,
      description: "Parallel subagent tasks; each item runs independently in its own context window.",
    }),
  ),
  chain: Type.Optional(
    Type.Array(SubagentTaskItemSchema, {
      minItems: 1,
      maxItems: SUBAGENT_MAX_RESULTS,
      description: "Sequential subagent steps; each step receives the previous step output through {previous}.",
    }),
  ),
  agentScope: Type.Optional(
    StringEnum(["user", "project", "both"] as const, {
      default: "user",
      description: "Which agent definitions may be selected (user, project, both); defaults to user. Project agents require explicit user approval.",
    }),
  ),
  run_in_background: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Start the delegated task(s) directly in the background and return a group handle immediately instead of waiting. Defaults to false: only set this when the USER explicitly asked for the work to run in the background; never set it merely because the task might take a while.",
    }),
  ),
});

type SubagentParamsStatic = Static<typeof SubagentParams>;

interface NormalizedRun {
  mode: SubagentMode;
  agentScope: SubagentAgentScope;
  tasks: SubagentTaskItem[];
  runInBackground: boolean;
}

const TOOL_DESCRIPTION = [
  "Delegate a self-contained task to an independent subagent with its own context window, tools and transcript.",
  "Exactly one of three mutually exclusive input modes must be provided:",
  "- prompt: single subagent task (top-level subagent_type/description apply).",
  "- tasks: parallel subagents; each item must be independent and self-contained.",
  "- chain: sequential steps; the first step replaces {previous} with an empty string, later steps replace every {previous} with the previous step's output.",
  "subagent_type defaults to general-purpose when omitted.",
  "agentScope defaults to user; project or both may select project-defined agents, which require explicit user approval.",
  "run_in_background defaults to false and waits for the result. Only set run_in_background=true when the USER explicitly requested background execution; never infer it from how long the task might take - long tasks are backgrounded automatically.",
].join(" ");

/**
 * Result description: caller description wins; otherwise the first non-empty
 * single-line preview of the prompt, truncated to the shared cap. The agent
 * definition description is never used to describe a task.
 */
function describeTask(task: SubagentTaskItem): string {
  if (task.description && task.description.trim() !== "") {
    return task.description.slice(0, SUBAGENT_MAX_DESCRIPTION_CHARS);
  }
  for (const rawLine of task.prompt.split("\n")) {
    const line = rawLine.trim();
    if (line !== "") {
      const singleLine = line.replace(/\s+/g, " ").trim();
      return singleLine.length > SUBAGENT_MAX_DESCRIPTION_CHARS
        ? `${singleLine.slice(0, SUBAGENT_MAX_DESCRIPTION_CHARS - 3)}...`
        : singleLine;
    }
  }
  return "";
}

function normalizeParams(params: SubagentParamsStatic): NormalizedRun | { invalid: string } {
  const hasPrompt = typeof params.prompt === "string" && params.prompt !== "";
  const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0;
  const hasChain = Array.isArray(params.chain) && params.chain.length > 0;
  const modeCount = [hasPrompt, hasTasks, hasChain].filter(Boolean).length;
  if (modeCount !== 1) {
    return { invalid: "Exactly one of prompt, tasks or chain must be provided." };
  }

  const agentScope: SubagentAgentScope = params.agentScope ?? "user";
  const runInBackground = params.run_in_background === true;
  if (hasPrompt) {
    const task: SubagentTaskItem = {
      subagent_type: params.subagent_type,
      prompt: params.prompt!,
      description: params.description,
    };
    return { mode: "single", agentScope, tasks: [task], runInBackground };
  }
  if (hasTasks) {
    return {
      mode: "parallel",
      agentScope,
      tasks: params.tasks!.map((item) => ({ ...item })),
      runInBackground,
    };
  }
  return {
    mode: "chain",
    agentScope,
    tasks: params.chain!.map((item) => ({ ...item })),
    runInBackground,
  };
}

function textContent(text: string): TextContent {
  return { type: "text", text };
}

/** UTF-8-safe bounded error text, capped at the shared error-message limit. */
function boundedErrorMessage(message: string): string {
  const maxBytes = SUBAGENT_MAX_ERROR_MESSAGE_BYTES;
  const originalBytes = new TextEncoder().encode(message).length;
  if (originalBytes <= maxBytes) {
    return message;
  }
  let slice = Buffer.from(message, "utf-8").subarray(0, maxBytes);
  while (slice.length > 0 && (slice[slice.length - 1] & 0xc0) === 0x80) {
    slice = slice.subarray(0, slice.length - 1);
  }
  if (slice.length > 0 && (slice[slice.length - 1] & 0x80) !== 0) {
    slice = slice.subarray(0, slice.length - 1);
  }
  return slice.toString("utf-8");
}

function emptyDetails(mode: SubagentMode, agentScope: SubagentAgentScope, task: SubagentTaskItem): SubagentDetails {
  const now = Date.now();
  return {
    schemaVersion: 1,
    mode,
    agentScope,
    results: [
      {
        id: `invalid-${now}`,
        index: 0,
        agentName: task.subagent_type ?? "general-purpose",
        agentSource: "unknown",
        description: describeTask(task),
        status: "failed",
        finalOutput: "",
        outputTruncated: false,
        originalOutputBytes: 0,
        toolUseCount: 0,
        activities: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
        failureReason: "invalid_parameters",
        errorMessage: undefined,
        endedAt: now,
        durationMs: 0,
      },
    ],
    startedAt: now,
    updatedAt: now,
    durationMs: 0,
  };
}

/**
 * Bounded structured failed result for unexpected internal tool errors (host
 * getter, runner preflight clone, progress callback or content formatting).
 * Parallel mode reports one failed result per requested task. Chain mode has
 * no observable partial state on this fallback path, so only its first step
 * enters results; later steps were never known to have started.
 */
function internalErrorDetails(
  mode: SubagentMode,
  agentScope: SubagentAgentScope,
  tasks: SubagentTaskItem[],
  errorMessage: string,
): SubagentDetails {
  const now = Date.now();
  const failedTasks = mode === "chain" ? tasks.slice(0, 1) : tasks;
  const results: SubagentSingleResult[] = failedTasks.map((task, index) => ({
    id: `internal-${now}-${index}`,
    index,
    step: mode === "chain" ? index + 1 : undefined,
    agentName: task.subagent_type ?? "general-purpose",
    agentSource: "unknown",
    description: describeTask(task),
    status: "failed",
    finalOutput: "",
    outputTruncated: false,
    originalOutputBytes: 0,
    toolUseCount: 0,
    activities: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
    failureReason: "internal_error",
    errorMessage,
    endedAt: now,
    durationMs: 0,
  }));
  return {
    schemaVersion: 1,
    mode,
    agentScope,
    results,
    startedAt: now,
    updatedAt: now,
    durationMs: 0,
  };
}

function statusText(result: SubagentSingleResult): string {
  if (result.status === "completed") {
    return "completed";
  }
  if (result.status === "failed" || result.status === "aborted") {
    return `${result.status}${result.failureReason ? ` (${result.failureReason})` : ""}`;
  }
  return result.status;
}

function resultLine(result: SubagentSingleResult): string {
  const header = `- ${result.agentName} [${statusText(result)}]`;
  if (result.status === "failed" || result.status === "aborted") {
    return `${header}: ${result.errorMessage ?? "no error details"}`;
  }
  if (result.finalOutput !== "") {
    return `${header}: ${result.finalOutput}`;
  }
  return `${header}: no output`;
}

function formatSingleContent(result: SubagentSingleResult): string {
  if (result.status === "failed" || result.status === "aborted") {
    return `${result.agentName} ${statusText(result)}: ${result.errorMessage ?? "no error details"}`;
  }
  return result.finalOutput !== "" ? result.finalOutput : "The subagent completed without producing text.";
}

function formatParallelContent(details: SubagentDetails): string {
  const succeeded = details.results.filter((result) => result.status === "completed").length;
  const lines = [`${succeeded}/${details.results.length} subagent tasks succeeded.`];
  for (const result of details.results) {
    lines.push(resultLine(result));
  }
  return lines.join("\n");
}

function formatChainContent(details: SubagentDetails): string {
  const lines: string[] = [];
  for (const result of details.results) {
    const step = result.step ?? result.index + 1;
    lines.push(`Step ${step} (${result.agentName}) ${statusText(result)}`);
  }
  const lastSuccessful = [...details.results].reverse().find((result) => result.status === "completed");
  if (lastSuccessful) {
    lines.push(`\nFinal output:\n${lastSuccessful.finalOutput}`);
  } else {
    const stopped = details.results[details.results.length - 1];
    lines.push(
      `\nChain stopped at step ${stopped.step ?? stopped.index + 1}: ${statusText(stopped)}${stopped.errorMessage ? ` - ${stopped.errorMessage}` : ""}`,
    );
  }
  return lines.join("\n");
}

/** Bounded aggregate cap for the model-visible final content. */
function truncateContent(text: string): string {
  const maxBytes = MAX_TOOL_CONTENT_BYTES;
  const originalBytes = new TextEncoder().encode(text).length;
  if (originalBytes <= maxBytes) {
    return text;
  }
  let slice = Buffer.from(text, "utf-8").subarray(0, maxBytes);
  while (slice.length > 0 && (slice[slice.length - 1] & 0xc0) === 0x80) {
    slice = slice.subarray(0, slice.length - 1);
  }
  if (slice.length > 0 && (slice[slice.length - 1] & 0x80) !== 0) {
    slice = slice.subarray(0, slice.length - 1);
  }
  return `${slice.toString("utf-8")}\n[output truncated]`;
}

/** One bounded status line for onUpdate progress events. */
function progressStatusLine(details: SubagentDetails): string {
  const counts = { queued: 0, running: 0, completed: 0, failed: 0, aborted: 0 };
  for (const result of details.results) {
    counts[result.status]++;
  }
  const runningNames = details.results
    .filter((result) => result.status === "running")
    .map((result) => result.agentName);
  const summary =
    `${details.mode} ${counts.completed}/${details.results.length} done` +
    (counts.running > 0 ? `, ${counts.running} running${runningNames.length > 0 ? ` (${runningNames.join(", ")})` : ""}` : "") +
    (counts.queued > 0 ? `, ${counts.queued} queued` : "") +
    (counts.failed > 0 ? `, ${counts.failed} failed` : "") +
    (counts.aborted > 0 ? `, ${counts.aborted} aborted` : "");
  return summary;
}

/**
 * One bounded status line for a backgrounded group handle (1.4.1): the group
 * id, the task count and each task's id/status. Never rendered as
 * SubagentDetails.
 */
function formatHandleContent(handle: AgentTaskGroupHandle): string {
  const lines = [
    `The delegated task${handle.tasks.length === 1 ? "" : "s"} started in the background (${handle.tasks.length} task${handle.tasks.length === 1 ? "" : "s"}).`,
    `Group ID: ${handle.groupId}`,
    `Tasks: ${handle.tasks.map((task) => `${task.taskId} [${task.status}]`).join(", ")}`,
  ];
  return lines.join("\n");
}

/**
 * Create the `agent` ToolDefinition bound to the runner facade of the host
 * session (PiX 1.4.1): execute routes to createTaskGroup/awaitGroup through
 * the facade, foreground resolves to the existing SubagentDetails and a
 * backgrounded group (direct/manual/auto) resolves to an AgentTaskGroupHandle.
 * Business failures return ordinary AgentToolResult values; nothing here
 * throws for a business failure.
 */
export function createSubagentToolDefinition(host: SubagentToolHost): ToolDefinition<typeof SubagentParams, SubagentDetails | AgentTaskGroupHandle> {
  return {
    name: SUBAGENT_TOOL_NAME,
    label: "Agent",
    description: TOOL_DESCRIPTION,
    promptSnippet: "Delegate a self-contained task to an independent subagent with its own context window.",
    promptGuidelines: [
      "Each delegated task must be fully self-contained; the subagent has its own context window and cannot see the parent conversation.",
      "Parallel task items must be independent of each other; ordering is not guaranteed.",
      "Chain steps may reference the previous step output with the {previous} placeholder.",
      "run_in_background defaults to false. Only set it to true when the user explicitly asked for the work to run in the background; never set it merely because the task might take a while - long-running tasks are backgrounded automatically.",
    ],
    parameters: SubagentParams,
    executionMode: "parallel",
    async execute(toolCallId, params, signal, onUpdate) {
      const normalized = normalizeParams(params);
      if ("invalid" in normalized) {
        const task: SubagentTaskItem = {
          subagent_type: params.subagent_type,
          prompt: params.prompt ?? "",
          description: params.description,
        };
        const details = emptyDetails("single", params.agentScope ?? "user", task);
        const content = textContent(`Invalid agent tool parameters: ${normalized.invalid}`);
        onUpdate?.({ content: [content], details });
        return { content: [content], details };
      }

      try {
        const runner = host.getRunner();
        const result = await runner.run(
          { mode: normalized.mode, agentScope: normalized.agentScope, tasks: normalized.tasks },
          signal,
          (event) => {
            onUpdate?.({ content: [textContent(progressStatusLine(event.details))], details: event.details });
          },
          undefined,
          { parentToolCallId: toolCallId, runInBackground: normalized.runInBackground },
        );

        // Backgrounded outcome (direct/manual/auto): the single parent tool
        // await resolves with the group handle, never with SubagentDetails.
        if ("kind" in result) {
          const contentText = formatHandleContent(result);
          return { content: [textContent(truncateContent(contentText))], details: result };
        }

        const details = result;
        let contentText: string;
        if (details.mode === "single") {
          contentText = formatSingleContent(details.results[0]);
        } else if (details.mode === "parallel") {
          contentText = formatParallelContent(details);
        } else {
          contentText = formatChainContent(details);
        }
        return { content: [textContent(truncateContent(contentText))], details };
      } catch (error) {
        // Unexpected internal failure (host getter, submission context,
        // progress callback or content formatting): return a bounded
        // structured failed result, never throw. onUpdate is intentionally NOT
        // called on this path: if the failure source was the progress callback
        // itself, that would repeat its side effects.
        const errorMessage = boundedErrorMessage(error instanceof Error ? error.message : String(error));
        const details = internalErrorDetails(normalized.mode, normalized.agentScope, normalized.tasks, errorMessage);
        const content = textContent(`The subagent tool failed internally: ${errorMessage}`);
        return { content: [content], details };
      }
    },
  };
}
