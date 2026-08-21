/**
 * Workflow RPC (PiX 1.4.3)
 *
 * Wraps the renderer's workflow IPC surface (preload sendWorkflowCommand /
 * onWorkflowEvent) into a small transport, mirroring the useRpc
 * singleton-client pattern. The workflow store consumes this transport so the
 * preload API stays behind one seam; components normally go through the store
 * instead of calling this composable directly.
 */

import type { PixApi } from "../../main/preload";
import type {
  PixCommandResult,
  WorkflowCommand,
  WorkflowEvent,
  WorkflowViewState,
} from "@shared/types.js";

/** Minimal workflow IPC surface the workflow store needs over the preload pixApi. */
export interface WorkflowTransport {
  sendWorkflowCommand: (command: WorkflowCommand) => Promise<PixCommandResult<WorkflowViewState[]>>;
  onWorkflowEvent: (callback: (event: WorkflowEvent) => void) => () => void;
}

function api(): PixApi | undefined {
  return window.pixApi;
}

export function createWorkflowTransport(): WorkflowTransport {
  return {
    sendWorkflowCommand: (command) => {
      const send = api()?.sendWorkflowCommand;
      if (typeof send !== "function") {
        return Promise.resolve({ success: false, error: "PiX 预加载 API 不可用。" });
      }
      return send(command);
    },
    onWorkflowEvent: (callback) => {
      const subscribe = api()?.onWorkflowEvent;
      if (typeof subscribe !== "function") {
        return () => {};
      }
      return subscribe(callback);
    },
  };
}

const singleWorkflowTransport = createWorkflowTransport();

export function useWorkflowRpc(): WorkflowTransport {
  return singleWorkflowTransport;
}
