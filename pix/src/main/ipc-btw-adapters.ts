/**
 * Side-question (BTW) IPC adapters (PiX 1.5.0, design plan §4.2.4).
 *
 * Pure registration for the btw-ask / btw-cancel IPC surface, so
 * btw-ipc.test.ts can register and exercise the REAL production handlers in
 * pure Node without loading the Electron runtime (ipc-handlers.ts imports
 * electron at the top level). Production registerIpcHandlers passes the real
 * ipcMain and the SessionBridge-backed ask/cancel deps; the test passes a
 * fake adapter and fake deps.
 *
 * The IpcMainLike adapter type lives in ipc-plan-adapters.ts and is reused
 * here. The adapter never imports SessionBridge: ask/cancel are injected as
 * BtwIpcDeps by ipc-handlers.
 */

import type { BtwAskResult } from "../shared/btw-types.js";
import { btwValidateQuestion } from "../shared/btw-types.js";
import type { IpcMainLike } from "./ipc-plan-adapters.js";

export interface BtwIpcDeps {
  ask: (question: string) => Promise<BtwAskResult>;
  cancel: () => void;
}

/** 注册 "btw-ask"（question: string → BtwAskResult）与 "btw-cancel"（→ void）。 */
export function registerBtwIpcHandlers(ipcMainLike: IpcMainLike, deps: BtwIpcDeps): void {
  ipcMainLike.handle("btw-ask", async (_event: unknown, question: unknown): Promise<BtwAskResult> => {
    // Guard: resolve an error result instead of throwing so the renderer
    // always receives a BtwAskResult (§4.2.4).
    if (typeof question !== "string") {
      return { status: "error", errorMessage: "用法：/btw <问题>" };
    }
    const validationError = btwValidateQuestion(question);
    if (validationError !== null) {
      return { status: "error", errorMessage: validationError };
    }
    return deps.ask(question);
  });
  ipcMainLike.handle("btw-cancel", () => {
    deps.cancel();
  });
}
