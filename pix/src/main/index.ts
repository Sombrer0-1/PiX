/**
 * Electron Main Process Entry Point
 *
 * v2: Uses SessionBridge for direct AgentSession integration.
 * No more subprocess spawning; the coding agent runs in-process.
 */

import { randomUUID } from "crypto";
import { BrowserWindow, Menu, app, shell } from "electron";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerIpcHandlers, setupEventForwarding, teardownEventForwarding } from "./ipc-handlers.js";
import { SessionBridge } from "./session-bridge.js";
import { SettingsStore } from "./settings-store.js";
import { TeamManager } from "./team-manager.js";
import { ProductEventCollector } from "./product-event-collector.js";
import {
  AGENT_TASK_DEFAULT_MAX_TASK_BYTES,
  AGENT_TASK_DEFAULT_MAX_WORKSPACE_BYTES,
  AgentTaskStore,
} from "./agent-task/agent-task-store.js";
import { AgentTaskService } from "./agent-task/agent-task-service.js";
import { setRestoreGate } from "./ipc-agent-task-adapters.js";

// ESM doesn't have __dirname; derive it from import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;
/** Mutable ref that always points to the current active window (survives close/reopen). */
let activeWin: BrowserWindow | null = null;
let singleSessionBridge: SessionBridge | null = null;
let teamLeaderSessionBridge: SessionBridge | null = null;
let settingsStore: SettingsStore;
let teamManager: TeamManager | null = null;
let productEventCollector: ProductEventCollector | null = null;
let agentTaskStore: AgentTaskStore | null = null;
let agentTaskService: AgentTaskService | null = null;
/** Frozen at service construction; prepareShutdown writes matching close markers with it. */
let agentTaskRunId = "";

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

function isAllowedAppNavigation(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") {
      return url === pathToFileURL(join(__dirname, "..", "..", "renderer", "index.html")).href;
    }

    const devServer = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";
    if (process.env.NODE_ENV === "development" || process.env.VITE_DEV_SERVER_URL) {
      return parsed.origin === new URL(devServer).origin;
    }
  } catch {
    return false;
  }
  return false;
}

function openExternalIfSafe(url: string): void {
  if (isSafeExternalUrl(url)) {
    void shell.openExternal(url);
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: "PiX",
    backgroundColor: "#f0f0f0",
    frame: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url)) return;
    event.preventDefault();
    openExternalIfSafe(url);
  });

  // Load app
  if (process.env.NODE_ENV === "development" || process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || "http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    // __dirname is dist/main/main, renderer build is at dist/renderer/
    mainWindow.loadFile(join(__dirname, "..", "..", "renderer", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function cleanup(): Promise<void> {
  teardownEventForwarding();

  // AgentTask shutdown runs before the bridges dispose, so the parent signals
  // of the bridge dispose path never misclassify an app shutdown as
  // user_cancel; product events flush last (PiX 1.4.2). prepareShutdown first
  // freezes pre-status, bounded-aborts and writes matching runId close
  // markers; the idempotent dispose afterwards only releases service resources.
  if (agentTaskService) {
    try {
      await agentTaskService.prepareShutdown();
    } catch (err) {
      console.error("[main] Error during agent task prepareShutdown:", err);
    }
    try {
      await agentTaskService.dispose("app_shutdown");
    } catch (err) {
      console.error("[main] Error during agent task service cleanup:", err);
    }
  }
  if (teamManager) {
    try {
      await teamManager.dispose();
    } catch (err) {
      console.error("[main] Error during team manager cleanup:", err);
    }
  }
  if (teamLeaderSessionBridge) {
    try {
      // 1.4.2 (R4): only the app cleanup marks the bridges as app-shutting-down;
      // stop-pi / project switch / team-mode switch keep session_close semantics.
      teamLeaderSessionBridge.markAppShuttingDown();
      await teamLeaderSessionBridge.dispose();
    } catch (err) {
      console.error("[main] Error during team leader session cleanup:", err);
    }
  }
  if (singleSessionBridge) {
    try {
      singleSessionBridge.markAppShuttingDown();
      await singleSessionBridge.dispose();
    } catch (err) {
      console.error("[main] Error during single session cleanup:", err);
    }
  }
  // Flush the local baseline log last so no product event is lost (PiX 1.4.0).
  if (productEventCollector) {
    try {
      await productEventCollector.flushLog();
    } catch (err) {
      console.error("[main] Error during product event flush:", err);
    }
  }
}

app.whenReady().then(async () => {
  // Remove default Electron menu bar (File, Edit, View, Window, Help)
  Menu.setApplicationMenu(null);

  try {
    settingsStore = new SettingsStore();
  } catch (err) {
    console.error("[main] SettingsStore FAILED:", err);
    throw err;
  }

  // App-level singleton product collector; gated by enableProductAnalytics.
  try {
    productEventCollector = new ProductEventCollector({
      settings: settingsStore,
      agentDir: getAgentDir(),
    });
  } catch (err) {
    console.error("[main] ProductEventCollector FAILED:", err);
    throw err;
  }

  // App-level agent task store (1.4.2) + service. The runId is frozen at
  // construction; index writes never bypass the store. restoreAll() starts
  // here WITHOUT awaiting (perf SDD §4.5): the first window and the IPC
  // registration below no longer wait for the restore - the task query
  // commands hold on the restore gate instead, so the renderer's first get_all
  // still sees the fully hydrated task set (design plan §3, §5.5).
  let restorePromise: Promise<unknown>;
  try {
    agentTaskStore = new AgentTaskStore({
      rootDir: join(getAgentDir(), "agent-tasks"),
      maxTaskBytes: AGENT_TASK_DEFAULT_MAX_TASK_BYTES,
      maxWorkspaceBytes: AGENT_TASK_DEFAULT_MAX_WORKSPACE_BYTES,
    });
    agentTaskRunId = randomUUID();
    agentTaskService = new AgentTaskService({
      settings: settingsStore,
      events: productEventCollector!,
      store: agentTaskStore,
      runId: agentTaskRunId,
    });
    restorePromise = agentTaskService.restoreAll();
  } catch (err) {
    console.error("[main] AgentTaskService FAILED:", err);
    throw err;
  }
  // The gate never rejects: queries pending on a failed restore still settle;
  // the original "restore failure fails startup" semantics live in the await
  // further below. Wired before SessionBridge construction / IPC so a later
  // throw cannot leave get_all hanging on an unset gate.
  const whenRestored = restorePromise.catch(() => {});
  setRestoreGate(whenRestored);

  try {
    singleSessionBridge = new SessionBridge({
      role: "single",
      productEventCollector: productEventCollector ?? undefined,
      agentTaskService: agentTaskService ?? undefined,
    });
  } catch (err) {
    console.error("[main] Single SessionBridge FAILED:", err);
    setRestoreGate(Promise.resolve());
    throw err;
  }

  try {
    teamManager = new TeamManager();
  } catch (err) {
    console.error("[main] TeamManager FAILED:", err);
    setRestoreGate(Promise.resolve());
    throw err;
  }

  // Wire TeamManager → SessionBridge so Leader tools are registered on the main session
  try {
    teamLeaderSessionBridge = new SessionBridge({ role: "team-leader", teamManager: teamManager ?? undefined });
  } catch (err) {
    console.error("[main] Team leader SessionBridge FAILED:", err);
    setRestoreGate(Promise.resolve());
    throw err;
  }

  createWindow();
  activeWin = mainWindow;

  if (activeWin && singleSessionBridge && teamLeaderSessionBridge && teamManager && agentTaskService) {
    registerIpcHandlers(activeWin, singleSessionBridge, teamLeaderSessionBridge, settingsStore, teamManager, agentTaskService);
    setupEventForwarding(() => activeWin, singleSessionBridge, teamLeaderSessionBridge, teamManager, agentTaskService);
  } else {
    setRestoreGate(Promise.resolve());
  }

  try {
    await restorePromise;
  } catch (err) {
    console.error("[main] AgentTaskService FAILED:", err);
    throw err;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      activeWin = mainWindow;
      if (activeWin && singleSessionBridge && teamLeaderSessionBridge && teamManager && agentTaskService) {
        // Re-register IPC handlers for the new window (handler guard prevents duplicates)
        registerIpcHandlers(activeWin, singleSessionBridge, teamLeaderSessionBridge, settingsStore, teamManager, agentTaskService);
        // Event forwarding is already set up with a getter; updating activeWin is enough.
      }
    }
  });
});

let quitting = false;

app.on("window-all-closed", () => {
  // On macOS, the app stays alive in the Dock; keep the session alive
  // so event forwarding works when the user reopens a window via activate.
  // On other platforms, quit when all windows close.
  if (process.platform !== "darwin") {
    quitting = true;
    void cleanup().finally(() => app.quit());
  }
});

app.on("before-quit", async (event) => {
  if (!quitting) {
    event.preventDefault();
    quitting = true;
    await cleanup();
    app.quit();
  }
});
