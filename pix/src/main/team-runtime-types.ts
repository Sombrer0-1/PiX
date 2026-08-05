import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { McpAdapter } from "pi-mcp-adapter";
import type { TeamLifecycleStatus, TeammateChatMessage, TeammateInfo, TeamEvent, TeamTask } from "../shared/types.js";
import type { TeamMessageBus } from "./team-message-bus.js";
import type { TeamProtocolManager } from "./team-protocol-manager.js";
import type { TeamTaskList } from "./team-task-list.js";
import type { WorkerRunner } from "./team-worker-runner.js";

export interface WorkerState {
  info: TeammateInfo;
  /** The AgentSession for this worker (null until launched). */
  session: AgentSession | null;
  /** MCP adapter owned by this worker session. */
  mcpAdapter: McpAdapter | null;
  /** AbortController for the worker's entire lifecycle. */
  lifecycleAbortController: AbortController | null;
  /** AbortController for the worker's current work turn only. */
  workAbortController: AbortController | null;
  /** Unsubscribe from session events. */
  unsubscribeEvents?: () => void;
  /** Worker runner instance (manages the execution loop). */
  runner: WorkerRunner | null;
  /** Internal identity of the current turn, used to reject stale callbacks. */
  activeTurnId?: string;
  /** Runtime epoch captured by the current turn. */
  activeTurnEpoch?: number;
  /**
   * Whether the current turn already sent a worker->leader message (which wakes
   * the leader on its own). Set in sendTeamMessage, reset at turn start, read by
   * the turn-outcome handlers to avoid a duplicate orphan-turn wake - and the
   * feedback loop that duplicate would create for ordinary peer conversation.
   */
  sentLeaderMessageThisTurn?: boolean;
  /** Message timeline for this worker. */
  messageHistory: TeammateChatMessage[];
}

export interface TeamData {
  name: string;
  status: TeamLifecycleStatus;
  leadAgentId: string;
  workers: Map<string, WorkerState>;
  bus: TeamMessageBus;
  taskList: TeamTaskList;
  protocolManager: TeamProtocolManager;
  createdAt: number;
}

export interface PersistedTeamSnapshot {
  version: 1;
  cwd: string;
  savedAt: number;
  team: {
    name: string;
    status: TeamLifecycleStatus;
    leadAgentId: string;
    createdAt: number;
    workers: TeammateInfo[];
    tasks: TeamTask[];
    bus: ReturnType<TeamMessageBus["snapshot"]>;
    messageHistory: Record<string, TeammateChatMessage[]>;
  };
}

/** Event queued for LeaderOrchestrator processing. */
export type TeamEventCallback = (event: TeamEvent) => void;
