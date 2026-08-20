/**
 * Plan RPC (PiX 1.4.0)
 *
 * Wraps the renderer's plan IPC surface (preload sendPlanCommand / onPlanEvent)
 * into a small transport, mirroring the useRpc singleton-client pattern. The
 * plan store consumes this transport so the preload API stays behind one
 * seam; components normally go through the store instead of calling this
 * composable directly.
 */

import type { PixApi } from "../../main/preload";
import type {
  PlanCommand,
  PlanEvent,
  PlanRuntimeSnapshot,
  PixCommandResult,
} from "@shared/types.js";

/** Minimal plan IPC surface the plan store needs over the preload pixApi. */
export interface PlanTransport {
  sendPlanCommand: (command: PlanCommand) => Promise<PixCommandResult<PlanRuntimeSnapshot | undefined>>;
  onPlanEvent: (callback: (event: PlanEvent) => void) => () => void;
}

function api(): PixApi {
  if (!window.pixApi) {
    throw new Error("PiX 预加载 API 不可用。");
  }
  return window.pixApi;
}

export function createPlanTransport(): PlanTransport {
  return {
    sendPlanCommand: (command) => api().sendPlanCommand(command),
    onPlanEvent: (callback) => api().onPlanEvent(callback),
  };
}

const singlePlanTransport = createPlanTransport();

export function usePlanRpc(): PlanTransport {
  return singlePlanTransport;
}
