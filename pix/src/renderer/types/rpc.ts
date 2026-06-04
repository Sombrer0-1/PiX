/**
 * RPC communication types for the renderer process.
 * Re-exports shared types and adds renderer-specific types.
 */

export type {
  RpcCommand,
  RpcSessionState,
  RpcSlashCommand,
  SessionStats,
  ModelInfo,
  AgentSessionEvent,
  AgentMessage,
  ThinkingLevel,
  ThreadGoal,
  ThreadGoalStatus,
  RequestUserInputRequest,
  RequestUserInputResponse,
} from "../../shared/types";
