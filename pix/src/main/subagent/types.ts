/**
 * Main-only private contracts for the solo-mode subagent runner and the SDK
 * `agent` tool (design plan section 4.5).
 *
 * `SubagentExecutionContext` is the borrowed surface the SessionBridge hands
 * to the runner: borrowed objects (execution backend, auth storage, model
 * registry, runtime environment override) are never disposed by the runner,
 * and the model registry is only ever queried through runner/core paths -
 * it is never exposed to extensions.
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
import type { SubagentDetails, SubagentAgentScope, SubagentMode, SubagentUsage } from "../../shared/subagent-types.js";
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
 * Borrowed context shared by the parent session and its subagent runner.
 * Values marked borrowed are owned by the SessionBridge and must never be
 * disposed by the runner.
 */
export interface SubagentExecutionContext {
  physicalCwd: string;
  logicalCwd: string;
  /** Same resolved path the parent settings/loader/models use. */
  agentDir: string;
  executionBackend?: ExecutionBackend; // borrowed
  runtimeEnvironmentOverride?: Partial<RuntimeEnvironmentContext>; // borrowed
  authStorage: AuthStorage; // borrowed
  /** Borrowed, same identity as the parent session; query-only for runner/core. */
  modelRegistry: ModelRegistry;
  isWsl: boolean;
  getLoadedAgents: () => LoadAgentsResult | undefined;
  getParentRuntime: () => SubagentParentRuntimeSnapshot;
  requestUserInput: RequestUserInputHandler;
  recordAuxiliaryUsage: (usage: SubagentUsage) => void;
}

/** Minimal host surface: the tool only needs the shared runner. */
export interface SubagentToolHost {
  getRunner(): SubagentRunner;
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

export type SubagentToolResult = AgentToolResult<SubagentDetails>;
