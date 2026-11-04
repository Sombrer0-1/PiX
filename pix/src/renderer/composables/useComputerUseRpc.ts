/**
 * Computer-use RPC
 *
 * Wraps the renderer's computer-use IPC surface (preload sendComputerUseCommand
 * / onComputerUseEvent) into a small transport, mirroring the useTodoRpc
 * singleton-client pattern. This composable is the ONLY renderer module that
 * touches window.pixApi for computer use; the store consumes the transport and
 * components go through the store.
 */

import type { PixApi } from "../../main/preload";
import type { PixCommandResult } from "@shared/types.js";
import type { ComputerUseCommand, ComputerUseEvent, ComputerUseSnapshot } from "@shared/computer-use-types.js";

/** Minimal computer-use IPC surface the computer-use store needs over the preload pixApi. */
export interface ComputerUseTransport {
  sendComputerUseCommand: (command: ComputerUseCommand) => Promise<PixCommandResult<ComputerUseSnapshot>>;
  onComputerUseEvent: (callback: (event: ComputerUseEvent) => void) => () => void;
}

function api(): PixApi {
  if (!window.pixApi) {
    throw new Error("PiX 预加载 API 不可用。");
  }
  return window.pixApi;
}

export function createComputerUseTransport(): ComputerUseTransport {
  return {
    sendComputerUseCommand: (command) => api().sendComputerUseCommand(command),
    onComputerUseEvent: (callback) => api().onComputerUseEvent(callback),
  };
}

const singleComputerUseTransport = createComputerUseTransport();

export function useComputerUseRpc(): ComputerUseTransport {
  return singleComputerUseTransport;
}
