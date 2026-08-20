/**
 * Agent Task RPC (PiX 1.4.1; 1.4.2 R3/R5 expands the command surface)
 *
 * Wraps the renderer's agent-task IPC surface (preload sendAgentTaskCommand /
 * onAgentTaskEvent / onAgentTaskInputRequest) into a small transport, mirroring
 * the useRpc singleton-client pattern. The agent-task store consumes this
 * transport so the preload API stays behind one seam; components normally go
 * through the store instead of calling this composable directly.
 *
 * Input requests arrive on their own channel (agent-task-input-request),
 * separate from the ordinary agent-task-event stream, and are never duplicated
 * onto that stream (design plan §4.9). 1.4.2 (R2/R3) adds the recovery
 * commands (resume / mark_failed / get_resume_summary / export_diagnostics /
 * clear_all_terminal) and the storage_status / recovery_issue events; the
 * transport follows the V142 command union with its per-command data shapes.
 */

import type { PixApi } from "../../main/preload";
import type {
  AgentTaskCommandDataV142,
  AgentTaskCommandV142,
  AgentTaskEvent,
  AgentTaskInputRequest,
  PixCommandResult,
} from "@shared/types.js";

/** Minimal agent-task IPC surface the task store needs over the preload pixApi. */
export interface AgentTaskTransport {
  sendAgentTaskCommand: <C extends AgentTaskCommandV142>(
    command: C,
  ) => Promise<PixCommandResult<AgentTaskCommandDataV142<C>>>;
  onAgentTaskEvent: (callback: (event: AgentTaskEvent) => void) => () => void;
  onAgentTaskInputRequest: (callback: (request: AgentTaskInputRequest) => void) => () => void;
}

function api(): PixApi {
  if (!window.pixApi) {
    throw new Error("PiX 预加载 API 不可用。");
  }
  return window.pixApi;
}

export function createAgentTaskTransport(): AgentTaskTransport {
  return {
    sendAgentTaskCommand: (command) => api().sendAgentTaskCommand(command),
    onAgentTaskEvent: (callback) => api().onAgentTaskEvent(callback),
    onAgentTaskInputRequest: (callback) => api().onAgentTaskInputRequest(callback),
  };
}

const singleAgentTaskTransport = createAgentTaskTransport();

export function useAgentTaskRpc(): AgentTaskTransport {
  return singleAgentTaskTransport;
}
