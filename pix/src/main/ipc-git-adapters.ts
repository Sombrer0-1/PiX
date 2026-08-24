/**
 * Git workdir IPC adapters (PiX 1.5.0, design plan §4.3.4).
 *
 * Pure registration/dispatch for the git panel IPC surface, extracted from
 * ipc-handlers.ts so git-ipc.test.ts can register and exercise the REAL
 * production handlers in pure Node without loading the Electron runtime
 * (ipc-handlers.ts imports electron at the top level). Production
 * registerIpcHandlers passes the real ipcMain and injects the git status
 * service plus a shell.openPath wrapper for openFolder; the test passes a
 * fake adapter (same rule as the plan / agent-task adapters).
 *
 * The location argument is guarded structurally with isProjectLocationLike
 * (shared/git-types.ts leaf module) before reaching the injected deps:
 * invalid locations are answered with a static failure snapshot / {success:false}
 * and never reach the service.
 */

import { isProjectLocationLike, type GitWorkdirSnapshot } from "../shared/git-types.js";
import type { IpcMainLike } from "./ipc-plan-adapters.js";

export interface GitIpcDeps {
  getStatus: (location: unknown) => Promise<GitWorkdirSnapshot>;
  /** 打开项目文件夹（ipc-handlers 注入 shell.openPath 包装）。 */
  openFolder: (location: unknown) => Promise<{ success: boolean; error?: string }>;
}

/**
 * Register the git panel handlers on an injectable ipcMain adapter.
 * Production passes the real ipcMain; git-ipc.test.ts passes a fake adapter.
 */
export function registerGitIpcHandlers(ipcMainLike: IpcMainLike, deps: GitIpcDeps): void {
  ipcMainLike.handle("git-get-status", async (_event: unknown, location: unknown) => {
    if (!isProjectLocationLike(location)) {
      return { kind: "unavailable", files: [], complete: false, observedAt: Date.now(), errorCode: "invalid_location" };
    }
    return deps.getStatus(location);
  });

  ipcMainLike.handle("git-open-folder", async (_event: unknown, location: unknown) => {
    if (!isProjectLocationLike(location)) {
      return { success: false };
    }
    return deps.openFolder(location);
  });
}
