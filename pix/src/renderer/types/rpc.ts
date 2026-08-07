/**
 * RPC communication types for the renderer process.
 * Re-exports shared types and adds renderer-specific types.
 */

export type {
  ClipboardImage,
  GuiSettings,
  AuthStatusMap,
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
  ThemeInfo,
  TreeEntry,
  UserMessageForForking,
  ResourceStatus,
  McpConfigInfo,
  McpResourceContent,
  McpResourceInfo,
  McpServerInfo,
  WslDistroInfo,
  ExecutionEnvironmentInfo,
} from "../../shared/types";
