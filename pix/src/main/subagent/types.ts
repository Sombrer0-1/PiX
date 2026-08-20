/**
 * Main-only private contracts for the solo-mode subagent runner facade and the
 * SDK `agent` tool (design plan section 4.5, PiX 1.4.1).
 *
 * `SubagentExecutionContext` is the borrowed surface the SessionBridge hands
 * to the runner facade. Since 1.4.1 the facade owns no FIFO, nested session or
 * execution backend: it synchronously assembles an `AgentTaskSubmissionContext`
 * (parent session id, project, borrowed model registry snapshot, parent runtime
 * value snapshot, requestUserInput and the host-disposed promise) and delegates
 * to the app-level AgentTaskService. Borrowed objects are never disposed by the
 * facade, and the model registry is only ever queried through the submission
 * context - it is never exposed to extensions.
 *
 * `SubagentToolHost` (1.4.1) hands the SDK `agent` tool the per-generation
 * runner facade, the app-level agent task service and a synchronous submission
 * context captured per agent tool call. The tool submits through the facade to
 * the service, which owns task lifecycle, scheduling and input routing.
 * Foreground execution still resolves to `SubagentDetails`; a backgrounded
 * group resolves to `AgentTaskGroupHandle`.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentExecutionMode,
  AuthStorage,
  ExecutionBackend,
  LoadAgentsResult,
  ModelRegistry,
  RequestUserInputHandler,
  RuntimeEnvironmentContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentTaskGroupHandle } from "../../shared/agent-task-types.js";
import type { ProjectLocation } from "../../shared/project-location.js";
import type { SubagentDetails, SubagentAgentScope, SubagentMode, SubagentUsage } from "../../shared/subagent-types.js";
import type { AgentTaskService, AgentTaskSubmissionContext } from "../agent-task/agent-task-service.js";
import type { SubagentRunner } from "./subagent-runner.js";

/**
 * One runtime snapshot captured at the start of a `run()`. The model is only
 * read at capture time and is never passed into a nested session directly;
 * the runner hands createAgentSession a detached deep copy instead.
 */
export interface SubagentParentRuntimeSnapshot {
  model: Model<Api> | undefined;
  thinkingLevel: ThinkingLevel;
  executionMode: AgentExecutionMode;
  verificationGate: boolean;
}

/**
 * Borrowed context shared by the parent session and its subagent runner
 * facade. Values marked borrowed are owned by the SessionBridge and must never
 * be disposed by the facade. The facade only consumes these to assemble the
 * synchronous `AgentTaskSubmissionContext`; it holds no FIFO, nested session
 * or execution backend of its own (PiX 1.4.1).
 */
export interface SubagentExecutionContext {
  physicalCwd: string;
  logicalCwd: string;
  /** Same resolved path the parent settings/loader/models use. */
  agentDir: string;
  executionBackend?: ExecutionBackend; // borrowed
  runtimeEnvironmentOverride?: Partial<RuntimeEnvironmentContext>; // borrowed
  authStorage: AuthStorage; // borrowed
  /** Borrowed, same identity as the parent session; query-only for the submission context. */
  modelRegistry: ModelRegistry;
  isWsl: boolean;
  getLoadedAgents: () => LoadAgentsResult | undefined;
  getParentRuntime: () => SubagentParentRuntimeSnapshot;
  requestUserInput: RequestUserInputHandler;
  recordAuxiliaryUsage: (usage: SubagentUsage) => void;
  /** App-level agent task service (1.4.1); owned by index.ts, borrowed. */
  getTaskService: () => AgentTaskService | undefined;
  /** Current parent session id (1.4.1); used for detach scoping and delivery sinks. */
  getSessionId: () => string;
  /** Project location snapshot for the submission context (1.4.1). */
  getProjectLocation: () => ProjectLocation;
}

/**
 * Host surface for the SDK `agent` tool (PiX 1.4.1): the per-generation runner
 * facade, the app-level agent task service and a synchronous submission
 * context captured by the SessionBridge per agent tool call. All three are
 * borrowed; the tool never owns or disposes them.
 */
export interface SubagentToolHost {
  /** Per-generation runner facade; the foreground path routes through it. */
  getRunner(): SubagentRunner;
  /** App-level agent task service (1.4.1); owned by index.ts. */
  getTaskService(): AgentTaskService;
  /** Synchronous submission context captured per agent tool call. */
  getSubmissionContext(toolCallId: string): AgentTaskSubmissionContext;
}

/** One delegated task after normalization (single mode produces exactly one). */
export interface SubagentTaskItem {
  subagent_type?: string;
  prompt: string;
  description?: string;
}

export interface SubagentRunParams {
  mode: SubagentMode;
  agentScope: SubagentAgentScope;
  tasks: SubagentTaskItem[];
}

/** Progress event; `details` is always a fresh immutable snapshot. */
export interface SubagentProgressEvent {
  details: SubagentDetails;
}

/**
 * Structured tool-result payload (PiX 1.4.1). Foreground execution returns
 * SubagentDetails; a backgrounded group (direct/manual/auto) resolves to a
 * group handle (`kind: "agent_task_group"`). Parallel groups never pack a
 * handle array into the single-handle field.
 */
export type SubagentToolResult = AgentToolResult<SubagentDetails | AgentTaskGroupHandle>;
