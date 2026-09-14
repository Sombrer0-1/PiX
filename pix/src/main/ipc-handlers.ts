/**
 * IPC Handlers
 *
 * Bridges between renderer and main process.
 * Registers all ipcMain handlers for session control, settings, and file dialogs.
 *
 * v2: Uses SessionBridge for direct AgentSession integration (no RPC subprocess).
 */

import { createReadStream, existsSync, readFileSync, rmSync } from "fs";
import { createInterface } from "readline";
import { isAbsolute, join, relative, resolve } from "path";
import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { getAgentDir, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import electronUpdater from "electron-updater";
import { selectChatFiles, selectProjectDirectory, selectSessionFile } from "./file-dialogs.js";
import { resolveProjectLocation } from "./execution-context.js";
import { createGitStatusService } from "./git/git-status-service.js";
import { MessageUpdateCoalescer } from "./message-update-coalescer.js";
import type { SessionBridge } from "./session-bridge.js";
import type { SettingsStore } from "./settings-store.js";
import type {
  GuiSettings,
  ProjectInfo,
  ProjectLocation,
  ProjectLocationInput,
  RpcCommand,
  TeamCommand,
  TeamEvent,
  ThinkingLevel,
  WslSettings,
} from "../shared/types.js";
import { USER_SEAT_ID } from "../shared/team-types.js";
import type { AgentTaskService } from "./agent-task/agent-task-service.js";
import { parseAgentTaskMaxConcurrent } from "../shared/agent-task-types.js";
// Plan/agent-task command registration and dispatch live in pure modules that
// do not import electron at the top level, so plan-ipc.test.ts and
// agent-task-ipc.test.ts exercise the REAL handlers with a fake adapter
// (design plan §3 IPC harness rule). These are re-exported at the bottom.
import {
  registerAgentTaskIpcHandlers,
  subscribeAgentTaskEventForwarding,
} from "./ipc-agent-task-adapters.js";
import { registerBtwIpcHandlers } from "./ipc-btw-adapters.js";
import { registerGitIpcHandlers } from "./ipc-git-adapters.js";
import {
  registerPlanIpcHandlers,
  resyncPlanEventForwarding,
  subscribePlanEventForwarding,
} from "./ipc-plan-adapters.js";
import {
  registerWorkflowIpcHandlers,
  resyncWorkflowEventForwarding,
  subscribeWorkflowEventForwarding,
} from "./ipc-workflow-adapters.js";
import type { TeamManager } from "./team-manager.js";
import { readWorkspaceMode, writeWorkspaceMode } from "./team-persistence.js";
import { ROUNDTABLE_FILES, roundtableFilePath } from "./team/constants.js";
import { detectLegacyTeamSnapshot } from "./team/legacy-snapshot.js";
import { RoundtablePersistence, SNAPSHOT_DEBOUNCE_MS } from "./team/persistence.js";
import { WslDistroResolver } from "./wsl/wsl-distro.js";

const { autoUpdater } = electronUpdater;

let handlersRegistered = false;
let eventForwardingSetup = false;
let eventForwardingUnsubscribes: Array<() => void> = [];
let currentWindow: BrowserWindow | null = null;
let detachWindowStateListeners: (() => void) | null = null;

const SETTING_KEYS = new Set([
  "piPath",
  "theme",
  "recentProjects",
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "takeHerEyes",
  "wsl",
  "planModel",
  "planThinkingLevel",
  "enableProductAnalytics",
  "autoBackgroundMs",
  "agentTaskMaxConcurrent",
  "defaultAcp",
]);

const AUTO_BACKGROUND_MS_VALUES = new Set<number>([0, 60_000, 120_000, 300_000]);

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel);
}

function isProjectInfo(value: unknown): value is ProjectInfo {
  if (!value || typeof value !== "object") return false;
  const project = value as Record<string, unknown>;
  return (
    typeof project.path === "string" &&
    typeof project.name === "string" &&
    typeof project.lastOpened === "number" &&
    typeof project.sessionCount === "number"
  );
}

function isProjectEnvironment(value: unknown): value is ProjectLocation["environment"] {
  if (!value || typeof value !== "object") return false;
  const env = value as Record<string, unknown>;
  if (env.kind === "windows") return true;
  if (env.kind === "wsl") return typeof env.distro === "string" && env.distro.length > 0;
  return false;
}

/**
 * Runtime type guard for ProjectLocation received from the renderer. Structural
 * only; deeper validation (distro existence, directory probes) happens in
 * resolveProjectLocation / createProjectExecutionContext. physicalPath must be
 * non-empty because it is the sole hash/key input in the main process
 * (wsl_plan.md §4.8).
 */
function isProjectLocation(value: unknown): value is ProjectLocation {
  if (!value || typeof value !== "object") return false;
  const loc = value as Record<string, unknown>;
  return (
    typeof loc.path === "string" &&
    typeof loc.physicalPath === "string" &&
    loc.physicalPath.length > 0 &&
    typeof loc.name === "string" &&
    isProjectEnvironment(loc.environment)
  );
}

/**
 * Runtime type guard for ProjectLocationInput received from the renderer. The
 * resolver validates distro/version/path absoluteness and returns a structured
 * error; this guard only ensures the shape is safe to hand to it.
 */
function isProjectLocationInput(value: unknown): value is ProjectLocationInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  if (!isProjectEnvironment(input.environment)) return false;
  if (input.logicalPath !== undefined && typeof input.logicalPath !== "string") return false;
  if (input.physicalPath !== undefined && typeof input.physicalPath !== "string") return false;
  if (input.name !== undefined && typeof input.name !== "string") return false;
  return true;
}

function sanitizeTakeHerEyes(value: unknown): GuiSettings["takeHerEyes"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const result: GuiSettings["takeHerEyes"] = {
    enabled: raw.enabled === true,
  };
  if (typeof raw.provider === "string" && raw.provider.trim()) {
    result.provider = raw.provider;
  }
  if (typeof raw.modelId === "string" && raw.modelId.trim()) {
    result.modelId = raw.modelId;
  }
  return result;
}

function sanitizeWslSettings(value: unknown): WslSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  return {
    enabled: raw.enabled === true,
    distro: typeof raw.distro === "string" ? raw.distro : "",
    defaultCwd: typeof raw.defaultCwd === "string" ? raw.defaultCwd : "/home",
  };
}

function sanitizeSettings(settings: Record<string, unknown>): Partial<GuiSettings> {
  const sanitized: Partial<GuiSettings> = {};

  for (const key of Object.keys(settings)) {
    if (!SETTING_KEYS.has(key)) {
      console.warn(`[ipc] Ignoring unknown setting key: ${key}`);
    }
  }

  if (Object.hasOwn(settings, "piPath")) {
    const value = settings.piPath;
    if (value === undefined || typeof value === "string") {
      sanitized.piPath = value;
    }
  }
  if (settings.theme === "light") {
    sanitized.theme = "light";
  }
  if (Array.isArray(settings.recentProjects) && settings.recentProjects.every(isProjectInfo)) {
    sanitized.recentProjects = settings.recentProjects;
  }
  if (Object.hasOwn(settings, "defaultProvider")) {
    const value = settings.defaultProvider;
    if (value === undefined || typeof value === "string") {
      sanitized.defaultProvider = value;
    }
  }
  if (Object.hasOwn(settings, "defaultModel")) {
    const value = settings.defaultModel;
    if (value === undefined || typeof value === "string") {
      sanitized.defaultModel = value;
    }
  }
  if (Object.hasOwn(settings, "defaultThinkingLevel")) {
    const value = settings.defaultThinkingLevel;
    if (value === undefined || isThinkingLevel(value)) {
      sanitized.defaultThinkingLevel = value;
    }
  }
  if (Object.hasOwn(settings, "takeHerEyes")) {
    const value = settings.takeHerEyes;
    if (value === undefined) {
      sanitized.takeHerEyes = undefined;
    } else {
      const cleaned = sanitizeTakeHerEyes(value);
      if (cleaned) sanitized.takeHerEyes = cleaned;
    }
  }
  if (Object.hasOwn(settings, "wsl")) {
    const value = settings.wsl;
    if (value === undefined) {
      sanitized.wsl = undefined;
    } else {
      const cleaned = sanitizeWslSettings(value);
      if (cleaned) sanitized.wsl = cleaned;
    }
  }
  if (Object.hasOwn(settings, "planModel")) {
    const value = settings.planModel;
    if (value === undefined) {
      sanitized.planModel = undefined;
    } else if (value && typeof value === "object") {
      const raw = value as Record<string, unknown>;
      if (typeof raw.provider === "string" && raw.provider.trim() && typeof raw.modelId === "string" && raw.modelId.trim()) {
        sanitized.planModel = { provider: raw.provider, modelId: raw.modelId };
      }
    }
  }
  if (Object.hasOwn(settings, "planThinkingLevel")) {
    const value = settings.planThinkingLevel;
    if (value === undefined || isThinkingLevel(value)) {
      sanitized.planThinkingLevel = value;
    }
  }
  if (Object.hasOwn(settings, "enableProductAnalytics")) {
    const value = settings.enableProductAnalytics;
    if (value === undefined || typeof value === "boolean") {
      sanitized.enableProductAnalytics = value;
    }
  }
  if (Object.hasOwn(settings, "autoBackgroundMs")) {
    const value = settings.autoBackgroundMs;
    if (value === undefined) {
      sanitized.autoBackgroundMs = undefined;
    } else if (typeof value === "number" && AUTO_BACKGROUND_MS_VALUES.has(value)) {
      sanitized.autoBackgroundMs = value;
    }
  }
  if (Object.hasOwn(settings, "agentTaskMaxConcurrent")) {
    const value = settings.agentTaskMaxConcurrent;
    if (value === undefined) {
      sanitized.agentTaskMaxConcurrent = undefined;
    } else {
      const parsed = parseAgentTaskMaxConcurrent(value);
      if (parsed !== undefined) {
        sanitized.agentTaskMaxConcurrent = parsed;
      }
    }
  }
  if (Object.hasOwn(settings, "defaultAcp")) {
    const value = settings.defaultAcp;
    if (value === undefined || typeof value === "boolean") {
      sanitized.defaultAcp = value;
    }
  }

  return sanitized;
}

function getUsableWindow(win: BrowserWindow | null | undefined): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

function getWindowFromEvent(event: IpcMainInvokeEvent): BrowserWindow | null {
  return getUsableWindow(BrowserWindow.fromWebContents(event.sender)) ?? getUsableWindow(currentWindow);
}

function sendWindowMaximizeChange(win: BrowserWindow, maximized: boolean): void {
  if (!win.isDestroyed()) {
    win.webContents.send("window-maximize-change", maximized);
  }
}

function setCurrentWindow(win: BrowserWindow): void {
  currentWindow = win;
  detachWindowStateListeners?.();

  const onMaximize = () => sendWindowMaximizeChange(win, true);
	const onUnmaximize = () => sendWindowMaximizeChange(win, false);
	const onClosed = () => {
		if (currentWindow === win) {
			currentWindow = null;
			detachWindowStateListeners = null;
		}
	};

  win.on("maximize", onMaximize);
  win.on("unmaximize", onUnmaximize);
  win.on("closed", onClosed);
  detachWindowStateListeners = () => {
    win.off("maximize", onMaximize);
    win.off("unmaximize", onUnmaximize);
    win.off("closed", onClosed);
  };
}

function isPathInsideDirectory(candidatePath: string, directoryPath: string): boolean {
  const relativePath = relative(directoryPath, candidatePath);
  // Strictly INSIDE the directory: reject the directory itself (relativePath === "")
  // and any path outside it or on a different drive root. Mirrors
  // SessionBridge._assertSessionPathInNamespace, which throws on rel === "".
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

async function readSessionHeaderId(sessionPath: string): Promise<string | undefined> {
  const rl = createInterface({
    input: createReadStream(sessionPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { type?: unknown; id?: unknown };
        if (parsed.type === "session" && typeof parsed.id === "string" && parsed.id) {
          return parsed.id;
        }
      } catch {
        return undefined;
      }
      return undefined;
    }
  } finally {
    rl.close();
  }
  return undefined;
}

/**
 * 读一场的 meta.json lifecycle。`null` = 文件此刻还读不到/损坏/roundtableId 不符，
 * 与「读到了但 lifecycle 是 stopped」明确区分：只有前者才值得等下一次重试。
 */
function readRoundtableLifecycle(physicalCwd: string, roundtableId: string): string | null {
  try {
    const raw = readFileSync(roundtableFilePath(physicalCwd, roundtableId, ROUNDTABLE_FILES.meta), "utf8");
    const meta = JSON.parse(raw) as { roundtableId?: unknown; state?: { lifecycle?: unknown } };
    if (meta.roundtableId !== roundtableId) {
      return null;
    }
    return typeof meta.state?.lifecycle === "string" ? meta.state.lifecycle : null;
  } catch {
    return null;
  }
}

/**
 * H33: 本工作区是否存在可恢复的圆桌。读 `roundtables/<sha1(physicalCwd)>/current.json`
 * 拿到 roundtableId，再读该场 `meta.json` 的 `state.lifecycle`：只有 `active` /
 * `paused` 才算可恢复（归档场在 archive/ 下，指针也已清，永远读不到）。禁止
 * `existsSync` 带 `*`，禁止把旧 `team-state/<sha1>/team.json` 当作可恢复场（H14）。
 *
 * 指针解析复用 RoundtablePersistence（与 TeamManager 同一套容错）；meta.json 只读
 * 这一份小文件，不走 loadLatest（后者会 replay 整条 timeline.jsonl）。
 */
async function hasResumableRoundtable(physicalCwd: string): Promise<boolean> {
  // 工作区级探针：实例的 roundtableId 不参与指针读取（TeamManager 同理）。
  const probe = new RoundtablePersistence({ physicalCwd, roundtableId: "bootstrap" });
  const roundtableId = await probe.readCurrentPointer().catch((): string | null => null);
  if (roundtableId === null) {
    return false;
  }
  // TeamManager 的快照写盘是 debounce 的（SNAPSHOT_DEBOUNCE_MS，且窗口不会被后续
  // 写入推后），所以「刚建出来的场」可能只有指针、meta.json 还没落盘。等一个窗口
  // 再读，免得把正在跑的场报成不可恢复；窗口过后仍读不到才是真正的悬空指针
  // （崩溃在两次写之间、目录被删），照旧 false。
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_DEBOUNCE_MS + 20));
    }
    const lifecycle = readRoundtableLifecycle(physicalCwd, roundtableId);
    if (lifecycle !== null) {
      return lifecycle === "active" || lifecycle === "paused";
    }
  }
  return false;
}

/** 工作区级 legacy ack（H14）：`roundtables/<sha1>/ack.json`，与 roundtableId 无关。 */
async function writeLegacySnapshotAck(physicalCwd: string): Promise<void> {
  const probe = new RoundtablePersistence({ physicalCwd, roundtableId: "bootstrap" });
  await probe.writeAck(physicalCwd, { legacySnapshotNoticeAck: true });
}

export function registerIpcHandlers(
  win: BrowserWindow,
  singleSessionBridge: SessionBridge,
  teamLeaderSessionBridge: SessionBridge,
  settingsStore: SettingsStore,
  teamManager: TeamManager,
  agentTaskService: AgentTaskService,
): void {
  setCurrentWindow(win);

  // Prevent duplicate registration (e.g. macOS activate)
  if (handlersRegistered) {
    return;
  }
  handlersRegistered = true;

  // =========================================================================
  // File Dialogs
  // =========================================================================

  // File dialogs: resolve the calling window from event.sender so the
  // handler works after macOS window close/reopen (where the original `win`
  // captured at registration time may be destroyed).
  ipcMain.handle("select-project", async (event) => {
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    if (!callerWin) {
      return null;
    }
    return selectProjectDirectory(callerWin);
  });

  // select-pi-path is kept for backward compat, but now just opens a file dialog
  // since pi path configuration is no longer needed
  ipcMain.handle("select-pi-path", async () => {
    return null; // No longer needed with direct integration.
  });

  ipcMain.handle("select-session-file", async (event) => {
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    if (!callerWin) return null;
    return selectSessionFile(callerWin);
  });

  ipcMain.handle("select-chat-files", async (event) => {
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    if (!callerWin) return [];
    return selectChatFiles(callerWin);
  });

  // =========================================================================
  // Session Lifecycle
  // =========================================================================

  async function disposeTeamRuntime(preserveSnapshot: boolean): Promise<void> {
    try {
      if (teamManager.hasActiveTeam()) {
        if (preserveSnapshot) {
          // 保留快照 = 暂停：停一切团队模型调用，指针与 snapshot 都不动，下次进入
          // team 模式仍能恢复（§7.4）。归档是显式 stop 的语义（§6.3）。
          await teamManager.pause();
        } else {
          await teamManager.stop();
        }
      }
    } finally {
      // Always detach the leader bridge even if worker shutdown reports an
      // error; otherwise the old mode can keep receiving commands/events.
      await teamLeaderSessionBridge.dispose();
    }
  }

  ipcMain.handle("start-pi", async (_event, location: unknown) => {
    if (!isProjectLocation(location)) {
      return { success: false, error: "Invalid project location." };
    }
    try {
      // Starting the single runtime is also a mode switch. Preserve any team
      // snapshot so it can be restored when Team mode is entered again.
      await disposeTeamRuntime(true);
      await singleSessionBridge.start(location, settingsStore.getAll());
      // start() created a fresh PlanController; re-attach the plan-event
      // forwarding so the mirror converges without waiting for the next
      // plan command.
      resyncPlanEventForwarding();
      resyncWorkflowEventForwarding();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("stop-pi", async () => {
    try {
      await singleSessionBridge.dispose();
    } catch (err) {
      console.error("[ipc] Error during single session dispose:", err);
    }
    resyncPlanEventForwarding();
    resyncWorkflowEventForwarding();
    return { success: true };
  });

  ipcMain.handle("start-team-runtime", async (_event, location: unknown) => {
    if (!isProjectLocation(location)) {
      return { success: false, error: "Invalid project location." };
    }
    try {
      // A workspace has one active mode. Clear any previous Team runtime and
      // stop the single runtime before bringing up the independent leader.
      await disposeTeamRuntime(true);
      await singleSessionBridge.dispose();
      resyncPlanEventForwarding();
      resyncWorkflowEventForwarding();
      await teamLeaderSessionBridge.start(location, settingsStore.getAll());
      // TeamManager.initialize takes the borrowed leader context (S8); the
      // leader SessionBridge owns the backend and TeamManager never disposes it
      // (wsl_plan.md §4.8).
      const context = teamLeaderSessionBridge.getExecutionContext();
      if (!context) {
        throw new Error("TeamManager initialization failed: execution context unavailable");
      }
      const authStorage = teamLeaderSessionBridge.getAuthStorage();
      if (!authStorage) {
        throw new Error("TeamManager initialization failed: auth storage unavailable");
      }
      await teamManager.initialize(context, authStorage);
      return { success: true };
    } catch (err: unknown) {
      try {
        if (teamManager.hasActiveTeam()) {
          await teamManager.pause();
        }
      } catch (stopErr) {
        console.error("[ipc] TeamManager rollback failed:", stopErr);
      }
      try {
        await teamLeaderSessionBridge.dispose();
      } catch (disposeErr) {
        console.error("[ipc] Team leader rollback failed:", disposeErr);
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("stop-team-runtime", async () => {
    try {
      // Preserve the snapshot. Explicit stop_team remains the disband action.
      await disposeTeamRuntime(true);
    } catch (err) {
      console.error("[ipc] Error during team leader session dispose:", err);
    }
    return { success: true };
  });

  ipcMain.handle("has-team-snapshot", async (_event, location: unknown) => {
    // H33: the active-roundtable pointer is keyed by the physical cwd hash
    // (team/persistence.ts); the logical path never participates in the key
    // (wsl_plan.md §4.8). The old team.json is NOT a snapshot (H14).
    if (!isProjectLocation(location)) return false;
    return hasResumableRoundtable(location.physicalPath);
  });

  ipcMain.handle("has-legacy-team-snapshot", async (_event, location: unknown) => {
    // H14 / AC-13: only probes the old `team-state/<sha1>/team.json`; it never
    // counts as a restorable roundtable (LEGACY_SNAPSHOT_RESTORABLE === false).
    if (!isProjectLocation(location)) return false;
    if (!detectLegacyTeamSnapshot(location.physicalPath)) return false;
    // AC-13「只提示一次」的判定必须在主进程：ack 落盘（ack-legacy-team-snapshot）
    // 之后探针就得是 false，否则每次从首页打开这个工作区都会再弹一次确认框。
    // ack.json 是工作区级的，与 roundtableId 无关（readAck 自身容错，读不出来=没确认）。
    const probe = new RoundtablePersistence({ physicalCwd: location.physicalPath, roundtableId: "bootstrap" });
    const ack = await probe.readAck(location.physicalPath);
    return ack.legacySnapshotNoticeAck !== true;
  });

  ipcMain.handle("ack-legacy-team-snapshot", async (_event, location: unknown) => {
    if (!isProjectLocation(location)) {
      return { success: false, error: "Invalid project location." };
    }
    try {
      await writeLegacySnapshotAck(location.physicalPath);
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("get-workspace-mode", async (_event, location: unknown) => {
    if (!isProjectLocation(location)) return null;
    return readWorkspaceMode(location.physicalPath);
  });

  ipcMain.handle("set-workspace-mode", async (_event, location: unknown, mode: "team" | "solo") => {
    if (!isProjectLocation(location)) return;
    if (mode !== "team" && mode !== "solo") return;
    await writeWorkspaceMode(location.physicalPath, mode);
  });

  // =========================================================================
  // Project location, distro & execution environment
  // =========================================================================

  ipcMain.handle("list-wsl-distros", async () => {
    try {
      const resolver = new WslDistroResolver();
      const distros = await resolver.list();
      // v1 accepts only WSL2 (version 2) distros (wsl_plan §4.4 / §1.5). Filter
      // at the source so both the open-project dialog and the global settings
      // page only ever offer v2 distros; a v1-only host surfaces a diagnostic
      // instead of a selectable-but-failing list (wsl_plan §5.1 step 2).
      const v2Distros = distros.filter((d) => d.version === 2);
      if (v2Distros.length === 0) {
        const diagnostic =
          distros.length === 0
            ? "No WSL2 distros found. Install WSL2 and at least one distro (e.g. `wsl --install -d Ubuntu`), then ensure it is version 2."
            : "Found WSL distros, but none are version 2. Convert or reinstall a distro as version 2 (e.g. `wsl --set-version <Distro> 2`).";
        return { distros: v2Distros, diagnostic };
      }
      return { distros: v2Distros };
    } catch (err: unknown) {
      return {
        distros: [],
        diagnostic: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle("resolve-project-location", async (_event, input: unknown) => {
    if (!isProjectLocationInput(input)) {
      return { success: false, error: "Invalid project location input." };
    }
    try {
      const location = await resolveProjectLocation(input);
      return { success: true, location };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("get-execution-environment", () => {
    // The workspace has one active mode. Prefer the team leader environment
    // when a team runtime is active; otherwise report the single runtime.
    return (
      teamLeaderSessionBridge.getExecutionEnvironment() ??
      singleSessionBridge.getExecutionEnvironment()
    );
  });

  // =========================================================================
  // RPC Commands dispatched directly to SessionBridge methods.
  // =========================================================================

  ipcMain.handle("rpc-command", async (_event, command: unknown) => {
    if (!isRpcCommand(command)) {
      return { success: false, error: `Invalid command: ${JSON.stringify(command)}` };
    }
    try {
      const result = await executeCommand(singleSessionBridge, command);
      return { success: true, data: result };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("rpc-command-async", async (_event, command: unknown) => {
    if (!isRpcCommand(command)) {
      console.error("[ipc] Invalid async command:", command);
      return { success: false, error: `Invalid command: ${JSON.stringify(command)}` };
    }
    try {
      await executeCommand(singleSessionBridge, command);
      return { success: true };
    } catch (err) {
      console.error("[ipc] Async command error:", err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // =========================================================================
  // Plan Commands (PiX 1.4.0; always routed through the singleSessionBridge
  // PlanController, design plan §3)
  // =========================================================================

  registerPlanIpcHandlers(ipcMain, () => singleSessionBridge.getPlanController());

  // =========================================================================
  // Workflow Commands (PiX 1.4.3; recorder of the current solo generation,
  // design plan §3)
  // =========================================================================

  registerWorkflowIpcHandlers(ipcMain, () => singleSessionBridge.getWorkflowRecorder());

  // =========================================================================
  // Agent Task Commands (PiX 1.4.1; app-level AgentTaskService, design plan §3)
  // =========================================================================

  registerAgentTaskIpcHandlers(ipcMain, agentTaskService);

  // =========================================================================
  // Git Workdir Commands (PiX 1.5.0; read-only git status + open folder,
  // design plan §4.3.4)
  // =========================================================================

  const gitStatusService = createGitStatusService();
  registerGitIpcHandlers(ipcMain, {
    getStatus: (location) => gitStatusService.getStatus(location as ProjectLocation),
    openFolder: async (location) => {
      // The isProjectLocationLike guard already ran in ipc-git-adapters, so
      // physicalPath is only read for locations that passed it.
      const loc = location as ProjectLocation;
      const result = await shell.openPath(loc.physicalPath);
      if (result) {
        console.warn("[ipc] Failed to open project folder:", result);
        return { success: false, error: result };
      }
      return { success: true };
    },
  });

  // =========================================================================
  // Side-question (/btw) Commands (PiX 1.5.0; design plan §4.2.4)
  // =========================================================================

  registerBtwIpcHandlers(ipcMain, {
    ask: (question) => singleSessionBridge.askSideQuestion(question),
    cancel: () => singleSessionBridge.cancelSideQuestion(),
  });

  // =========================================================================
  // Team Commands
  // =========================================================================

  ipcMain.handle("team-command", async (_event, command: unknown) => {
    if (!isTeamCommand(command)) {
      return { success: false, code: "invalid_team_command", error: `Invalid team command: ${JSON.stringify(command)}` };
    }
    try {
      const result = await executeTeamCommand(teamManager, command);
      return { success: true, data: result };
    } catch (err: unknown) {
      return { success: false, code: "team_command_failed", error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("team-leader-command", async (_event, command: unknown) => {
    if (!isRpcCommand(command)) {
      return { success: false, error: `Invalid command: ${JSON.stringify(command)}` };
    }
    try {
      const result = await executeCommand(teamLeaderSessionBridge, command);
      return { success: true, data: result };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("team-leader-command-async", async (_event, command: unknown) => {
    if (!isRpcCommand(command)) {
      return { success: false, error: `Invalid command: ${JSON.stringify(command)}` };
    }
    try {
      await executeCommand(teamLeaderSessionBridge, command);
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // =========================================================================
  // Active user-input snapshot (remount catch-up)
  // =========================================================================

  ipcMain.handle("get-pending-user-input-request", () => {
    return singleSessionBridge.getActiveUserInputRequest();
  });

  ipcMain.handle("get-team-leader-pending-user-input-request", () => {
    return teamLeaderSessionBridge.getActiveUserInputRequest();
  });

  // =========================================================================
  // Session listing
  // =========================================================================

  ipcMain.handle("list-sessions", async (_event, location: unknown) => {
    if (!isProjectLocation(location)) return [];
    try {
      // Route through SessionBridge so SessionInfo.cwd is translated back to
      // the logical path in WSL mode (wsl_plan.md §4.8). The bridge lists from
      // disk and does not require an active session.
      return await singleSessionBridge.listSessions(location);
    } catch (err) {
      console.error("[ipc] Error listing sessions:", err);
      return [];
    }
  });

  ipcMain.handle("list-team-leader-sessions", async (_event, location: unknown) => {
    if (!isProjectLocation(location)) return [];
    try {
      return await teamLeaderSessionBridge.listSessions(location);
    } catch (err) {
      console.error("[ipc] Error listing team leader sessions:", err);
      return [];
    }
  });

  // =========================================================================
  // Settings
  // =========================================================================

  ipcMain.handle("get-settings", () => {
    return settingsStore.getAll();
  });

  ipcMain.handle("set-settings", (_event, settings: unknown) => {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return { success: false, error: "invalid_settings" };
    }
    settingsStore.setMany(sanitizeSettings(settings as Record<string, unknown>));
    const nextSettings = settingsStore.getAll();
    singleSessionBridge.updateGuiSettings(nextSettings);
    teamLeaderSessionBridge.updateGuiSettings(nextSettings);
    agentTaskService.syncMaxConcurrentSlotsFromSettings();
    return { success: true };
  });

  // =========================================================================
  // Pi Detection (simplified; always "found" with direct integration)
  // =========================================================================

  ipcMain.handle("detect-pi", () => {
    return { found: true, path: "direct", note: "Using direct AgentSession integration (no external pi binary)" };
  });

  ipcMain.handle("get-pi-stderr", () => {
    return ""; // No subprocess, no stderr
  });

  ipcMain.handle("is-pi-running", () => {
    return singleSessionBridge.isRunning();
  });

  ipcMain.handle("is-team-leader-running", () => {
    return teamLeaderSessionBridge.isRunning();
  });

  ipcMain.handle("get-background-tasks", () => {
    return singleSessionBridge.getBackgroundTasks();
  });

  ipcMain.handle("stop-background-task", (_event, taskId: string) => {
    return singleSessionBridge.stopBackgroundTask(taskId);
  });

  ipcMain.handle("get-team-leader-background-tasks", () => {
    return teamLeaderSessionBridge.getBackgroundTasks();
  });

  ipcMain.handle("stop-team-leader-background-task", (_event, taskId: string) => {
    return teamLeaderSessionBridge.stopBackgroundTask(taskId);
  });


  // =========================================================================
  // MCP Queries
  // =========================================================================

  ipcMain.handle("mcp-get-servers", () => {
    return singleSessionBridge.mcpGetServers();
  });

  ipcMain.handle("mcp-get-config", () => {
    return singleSessionBridge.mcpGetConfig();
  });

  ipcMain.handle("mcp-list-resources", async (_event, serverName?: string) => {
    return singleSessionBridge.mcpListResources(serverName);
  });

  ipcMain.handle("mcp-read-resource", async (_event, serverName: string | undefined, uri: string) => {
    return singleSessionBridge.mcpReadResource(serverName, uri);
  });

  ipcMain.handle("team-leader-mcp-get-servers", () => {
    return teamLeaderSessionBridge.mcpGetServers();
  });

  ipcMain.handle("team-leader-mcp-get-config", () => {
    return teamLeaderSessionBridge.mcpGetConfig();
  });

  ipcMain.handle("team-leader-mcp-list-resources", async (_event, serverName?: string) => {
    return teamLeaderSessionBridge.mcpListResources(serverName);
  });

  ipcMain.handle("team-leader-mcp-read-resource", async (_event, serverName: string | undefined, uri: string) => {
    return teamLeaderSessionBridge.mcpReadResource(serverName, uri);
  });

  // =========================================================================
  // Auto Update
  // =========================================================================

  ipcMain.handle("check-for-updates", async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      const currentVersion = autoUpdater.currentVersion.version;
      if (!result) {
        return { success: true, hasUpdate: false, currentVersion };
      }
      const latestVersion = result.updateInfo.version;
      return {
        success: true,
        hasUpdate: latestVersion !== currentVersion,
        currentVersion,
        latestVersion,
        releaseNotes: result.updateInfo.releaseNotes,
        releaseDate: result.updateInfo.releaseDate,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("download-update", async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("install-update", () => {
    autoUpdater.quitAndInstall();
  });

  // =========================================================================
  // External Links
  // =========================================================================

  ipcMain.handle("open-external", async (_event, url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
        await shell.openExternal(url);
      }
    } catch (err) {
      console.error("[ipc] Failed to open external URL:", url, err);
    }
  });

  // =========================================================================
  // Window Controls (frameless window)
  // =========================================================================

  ipcMain.handle("window-minimize", (event) => {
    getWindowFromEvent(event)?.minimize();
  });

  ipcMain.handle("window-maximize", (event) => {
    const targetWin = getWindowFromEvent(event);
    if (!targetWin) return;
    if (targetWin.isMaximized()) {
      targetWin.unmaximize();
    } else {
      targetWin.maximize();
    }
  });

  ipcMain.handle("window-close", (event) => {
    getWindowFromEvent(event)?.close();
  });

  ipcMain.handle("window-is-maximized", (event) => {
    return getWindowFromEvent(event)?.isMaximized() ?? false;
  });

  // =========================================================================
  // Session Management (delete, pin)
  // =========================================================================

  ipcMain.handle("delete-session", async (_event, sessionPath: string) => {
    try {
      const resolved = resolve(sessionPath);
      // Guard: only delete session files, never arbitrary paths
      const agentDir = resolve(getAgentDir());
      const sessionDirs = [
        resolve(join(agentDir, "sessions")),
        resolve(join(agentDir, "team-leader-sessions")),
      ];
      if (!sessionDirs.some((sessionDir) => isPathInsideDirectory(resolved, sessionDir))) {
        return { success: false, error: "Invalid session path" };
      }
      if (existsSync(resolved)) {
        const sessionId = await readSessionHeaderId(resolved);
        if (sessionId) {
          await agentTaskService.deleteTasksForParentSession(sessionId);
        }
        rmSync(resolved, { recursive: true, force: true });
        return { success: true };
      }
      return { success: false, error: "Session file not found" };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

// ===========================================================================
// Command Dispatch
// ===========================================================================

function isRpcCommand(cmd: unknown): cmd is RpcCommand {
  return (
    typeof cmd === "object" &&
    cmd !== null &&
    "type" in cmd &&
    typeof (cmd as Record<string, unknown>).type === "string"
  );
}

async function executeCommand(bridge: SessionBridge, cmd: RpcCommand): Promise<unknown> {
  switch (cmd.type) {
    // Prompting
    case "prompt":
      await bridge.prompt(cmd.message, cmd.filePaths, cmd.images);
      return null;
    case "steer":
      await bridge.steer(cmd.message, cmd.filePaths, cmd.images);
      return null;
    case "follow_up":
      await bridge.followUp(cmd.message, cmd.filePaths, cmd.images);
      return null;
    case "abort":
      await bridge.abort();
      return null;
    case "retry":
      await bridge.retry();
      return null;
    case "abort_retry":
      bridge.abortRetry();
      return null;
    case "respond_user_input":
      bridge.respondUserInput(cmd.response);
      return null;

    // State
    case "get_state":
      return bridge.getState();

    // Model
    case "set_model":
      await bridge.setModel(cmd.provider, cmd.modelId);
      return null;
    case "cycle_model":
      await bridge.cycleModel(cmd.direction ?? "forward");
      return null;
    case "get_available_models":
      return { models: bridge.getAvailableModels() };
    case "get_available_thinking_levels":
      return bridge.getAvailableThinkingLevels();
    case "supports_thinking":
      return bridge.supportsThinking();
    case "set_scoped_models":
      await bridge.setScopedModels(cmd.patterns);
      return null;
    case "get_scoped_models":
      return bridge.getScopedModels();

    // Thinking
    case "set_thinking_level":
      bridge.setThinkingLevel(cmd.level);
      return null;
    case "cycle_thinking_level":
      bridge.cycleThinkingLevel();
      return null;

    // Compaction
    case "compact":
      await bridge.compact(cmd.customInstructions);
      return null;
    case "set_acp":
      await bridge.setAcp(cmd.enabled);
      return null;

    // Session
    case "get_session_stats":
      return bridge.getSessionStats();
    case "switch_session": {
      const result = await bridge.switchSession(cmd.sessionPath);
      // The switch replaced the PlanController instance; re-sync the
      // plan-event forwarding so the renderer mirror converges to the new
      // session's plan (the re-sync pushes a fresh snapshot on change).
      resyncPlanEventForwarding();
      resyncWorkflowEventForwarding();
      return result;
    }
    case "fork": {
      const result = await bridge.fork(cmd.entryId, cmd.position ?? "before", cmd.label);
      resyncPlanEventForwarding();
      resyncWorkflowEventForwarding();
      return result;
    }
    case "navigate_tree": {
      const result = await bridge.navigateTree(cmd.targetId, {
        summarize: cmd.summarize,
        customInstructions: cmd.customInstructions,
        replaceInstructions: cmd.replaceInstructions,
        label: cmd.label,
      });
      resyncPlanEventForwarding();
      resyncWorkflowEventForwarding();
      return result;
    }
    case "clone": {
      const result = await bridge.clone();
      resyncPlanEventForwarding();
      resyncWorkflowEventForwarding();
      return result;
    }
    case "get_last_assistant_text":
      return bridge.getLastAssistantText();
    case "set_session_name":
      bridge.setSessionName(cmd.name);
      return null;
    case "get_tree":
      return bridge.getTree();
    case "get_user_messages_for_forking":
      return bridge.getUserMessagesForForking();
    case "set_steering_mode":
      bridge.setSteeringMode(cmd.mode);
      return null;
    case "set_follow_up_mode":
      bridge.setFollowUpMode(cmd.mode);
      return null;

    // Messages
    case "get_messages":
      return bridge.getMessages();

    // Commands
    case "get_commands":
      return { commands: await bridge.getCommands() };

    // Session management (new)
    case "new_session": {
      const result = await bridge.newSession(cmd.parentSession);
      // Like switch_session/fork/clone: the new session owns a fresh
      // PlanController, so re-sync plan-event forwarding to it.
      resyncPlanEventForwarding();
      resyncWorkflowEventForwarding();
      return result;
    }

    // Export
    case "export_html":
      return { path: await bridge.exportToHtml(cmd.outputPath) };
    case "export_jsonl":
      return { path: await bridge.exportToJsonl(cmd.outputPath) };

    // Auth
    case "set_api_key":
      bridge.setApiKey(cmd.provider, cmd.key);
      return null;
    case "remove_auth":
      bridge.removeAuth(cmd.provider);
      return null;
    case "get_auth_status":
      return bridge.getAuthStatus();
    case "get_custom_providers":
      return bridge.getCustomProviders();
    case "set_custom_providers":
      return bridge.setCustomProviders(cmd.providers);

    // Settings (full pi settings)
    case "get_pi_settings":
      return bridge.getPiSettings();
    case "set_pi_setting":
      await bridge.setPiSetting(cmd.key, cmd.value);
      return null;
    case "set_pi_settings":
      await bridge.setPiSettings(cmd.entries);
      return null;

    // Resources
    case "reload_resources":
      await bridge.reloadResources();
      return null;
    case "get_themes":
      return bridge.getThemes();
    case "get_resource_status":
      return bridge.getResourceStatus();

    default:
      throw new Error(`Unknown command type: ${(cmd as { type: string }).type}`);
  }
}

// ===========================================================================
// Event Forwarding
// ===========================================================================

/**
 * §4.12 的 seat_event 载荷。TeamEvent 用的是 shared/types.ts 的 AgentSessionEvent，
 * 而 SDK 事件（消息更新合并器的入参）是 pi-coding-agent 自己的结构等价类型：两套
 * AgentMessage 定义只有 index signature 的差别，跨界沿用既有的一次性断言约定。
 */
type TeamSeatEvent = Extract<TeamEvent, { type: "seat_event" }>;

/**
 * Set up event forwarding from SessionBridge to renderer.
 *
 * Uses a getter for the current window so that forwarding survives
 * window close/reopen cycles on macOS (where the app stays alive
 * after all windows close and `activate` creates a new window).
 */
export function setupEventForwarding(
  getWin: () => BrowserWindow | null,
  singleSessionBridge: SessionBridge,
  teamLeaderSessionBridge: SessionBridge,
  teamManager: TeamManager,
  agentTaskService: AgentTaskService,
): void {
  if (eventForwardingSetup) return;
  eventForwardingSetup = true;

  // Forward TeamManager roundtable events. Only the `seat_event` stream (a seat
  // AgentSession's raw events) is coalesced, and it gets its OWN coalescer
  // instance(s) - never the pi-event one (plan §7.2). `timeline_item` and every
  // other roundtable event reach the renderer immediately (AC-2 / §5.2: the
  // timeline has a 2s budget and must not wait for a 50ms merge window).
  //
  // One coalescer per seat: a single shared instance would merge the
  // thinking/text deltas of two seats that stream concurrently (the class holds
  // exactly one pending message_update), mis-attributing one seat's tokens to
  // another. Per-seat instances keep the documented merge rules inside one
  // seat's own stream. DEFAULT_COALESCE_INTERVAL_MS is untouched.
  const seatEventCoalescers = new Map<string, MessageUpdateCoalescer>();
  function seatEventCoalescer(seatId: string): MessageUpdateCoalescer {
    let coalescer = seatEventCoalescers.get(seatId);
    if (coalescer === undefined) {
      coalescer = new MessageUpdateCoalescer((event) => {
        const win = getWin();
        if (win && !win.isDestroyed()) {
          const seatEvent: TeamSeatEvent = {
            type: "seat_event",
            seatId,
            event: event as unknown as TeamSeatEvent["event"],
          };
          win.webContents.send("team-event", seatEvent);
        }
      });
      seatEventCoalescers.set(seatId, coalescer);
    }
    return coalescer;
  }
  eventForwardingUnsubscribes.push(teamManager.onEvent((event) => {
    if (event.type === "seat_event") {
      seatEventCoalescer(event.seatId).push(event.event as AgentSessionEvent);
      return;
    }
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("team-event", event);
    }
  }));
  eventForwardingUnsubscribes.push(() => {
    for (const coalescer of seatEventCoalescers.values()) {
      coalescer.dispose();
    }
    seatEventCoalescers.clear();
  });

  // Forward ordinary session events. message_update events are coalesced on a
  // fixed 50ms window before crossing the IPC boundary (perf SDD §4.2); markers
  // and all other event types flush the pending update and pass through
  // immediately, preserving event order. The sink keeps the window-alive check.
  // The bridge types its events with the shared serialized AgentSessionEvent;
  // at runtime they are the core AgentSessionEvent objects (session-bridge
  // casts on emit), so the coalescer sees the core type.
  const piEventCoalescer = new MessageUpdateCoalescer((event) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("pi-event", event);
    }
  });
  eventForwardingUnsubscribes.push(singleSessionBridge.onEvent((event) => {
    piEventCoalescer.push(event as AgentSessionEvent);
  }));
  eventForwardingUnsubscribes.push(() => piEventCoalescer.dispose());

  eventForwardingUnsubscribes.push(singleSessionBridge.onUserInputRequest((request) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("user-input-request", request);
    }
  }));

  // Dismissals forward on their own channels, preserving the bridge's event
  // order (a dismissal always precedes the following request). ipc-handlers
  // never generates dismissals and never maintains UI state.
  eventForwardingUnsubscribes.push(singleSessionBridge.onUserInputDismissed((event) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("user-input-dismissed", event);
    }
  }));

  // Lifecycle: ready
  eventForwardingUnsubscribes.push(singleSessionBridge.onLifecycle("ready", () => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("pi-ready");
    }
  }));

  // Lifecycle: exit
  eventForwardingUnsubscribes.push(singleSessionBridge.onLifecycle("exit", (data) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("pi-exit", data);
    }
  }));

  // Lifecycle: error
  eventForwardingUnsubscribes.push(singleSessionBridge.onLifecycle("error", (err) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("pi-error", { message: err.message ?? String(err) });
    }
  }));

  // Forward PlanController events (PiX 1.4.0) on the dedicated plan-event
  // channel. The controller instance is re-resolved per event because each
  // solo runtime generation owns its own PlanController.
  eventForwardingUnsubscribes.push(
    subscribePlanEventForwarding(
      () => {
        const win = getWin();
        return win && !win.isDestroyed() ? win.webContents : null;
      },
      () => singleSessionBridge.getPlanController(),
    ),
  );

  // Forward WorkflowRecorder fold changes (PiX 1.4.3) on the dedicated
  // workflow-event channel. Like the PlanController, each solo runtime
  // generation owns its own recorder, so the subscription is re-synced to
  // the current instance (command-time hook + the session-switching paths
  // via resyncWorkflowEventForwarding). The entry stream for the recorder's
  // restore fallback is injected here: the adapter never imports
  // SessionBridge, and the bridge restores the same entries at generation
  // activation (plan §2.3), so a swapped-instance resync re-folding them is
  // idempotent (the recorder dedups restored records).
  eventForwardingUnsubscribes.push(
    subscribeWorkflowEventForwarding(
      () => {
        const win = getWin();
        return win && !win.isDestroyed() ? win.webContents : null;
      },
      () => singleSessionBridge.getWorkflowRecorder(),
      () => singleSessionBridge.getSessionWorkflowEntries(),
    ),
  );

  // Forward AgentTaskService events (PiX 1.4.1) on the dedicated agent-task
  // channels. The service is app-level and stable for the process lifetime, so
  // one subscription at setup time is enough (unlike the per-session
  // PlanController, which needs the command-time re-sync hook).
  eventForwardingUnsubscribes.push(
    subscribeAgentTaskEventForwarding(
      () => {
        const win = getWin();
        return win && !win.isDestroyed() ? win.webContents : null;
      },
      agentTaskService,
    ),
  );

  // Forward Team leader AgentSession events on dedicated channels. Same
  // message_update coalescing as the pi-event channel above (perf SDD §4.2).
  const teamLeaderEventCoalescer = new MessageUpdateCoalescer((event) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("team-leader-event", event);
    }
  });
  eventForwardingUnsubscribes.push(teamLeaderSessionBridge.onEvent((event) => {
    teamLeaderEventCoalescer.push(event as AgentSessionEvent);
  }));
  eventForwardingUnsubscribes.push(() => teamLeaderEventCoalescer.dispose());

  eventForwardingUnsubscribes.push(teamLeaderSessionBridge.onUserInputRequest((request) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("team-leader-user-input-request", request);
    }
  }));

  eventForwardingUnsubscribes.push(teamLeaderSessionBridge.onUserInputDismissed((event) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("team-leader-user-input-dismissed", event);
    }
  }));

  eventForwardingUnsubscribes.push(teamLeaderSessionBridge.onLifecycle("ready", () => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("team-leader-ready");
    }
  }));

  eventForwardingUnsubscribes.push(teamLeaderSessionBridge.onLifecycle("exit", (data) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("team-leader-exit", data);
    }
  }));

  eventForwardingUnsubscribes.push(teamLeaderSessionBridge.onLifecycle("error", (err) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send("team-leader-error", { message: err.message ?? String(err) });
    }
  }));
}

export function teardownEventForwarding(): void {
  for (const unsubscribe of eventForwardingUnsubscribes.splice(0)) {
    try {
      unsubscribe();
    } catch (err) {
      console.error("[ipc] Error tearing down event forwarding:", err);
    }
  }
  eventForwardingSetup = false;
}

// ===========================================================================
// Team Command Dispatch
// ===========================================================================

const VALID_TEAM_COMMAND_TYPES = new Set([
  "create_roundtable",
  "get_state",
  "get_timeline",
  "get_attention",
  "get_open_items",
  "get_deliverables",
  "get_metrics",
  "post_user_message",
  "set_ordered_mode",
  "pause",
  "resume",
  "stop",
  "add_seat",
  "remove_seat",
  "update_seat_auth",
  "wake_seat",
  "mute_thread",
  "request_wrap_up",
  "revise_deliverable",
  "stance_on_deliverable",
  "export_markdown",
  "build_handoff",
  "get_inbox",
  "ack_attention",
  "respond_permission",
  "respond_exit",
  "set_settings",
  "downgrade_models",
  "list_presets",
  "save_preset",
  "delete_preset",
]);

/**
 * Runtime guard for the roundtable command union (plan §4.12). The switch is
 * exhaustive: adding a TeamCommand member without a case here (and without the
 * required sub-field checks) fails to compile.
 */
function isTeamCommand(cmd: unknown): cmd is TeamCommand {
  if (typeof cmd !== "object" || cmd === null || !("type" in cmd)) return false;
  const c = cmd as Record<string, unknown>;
  const type = c.type as TeamCommand["type"];
  if (typeof c.type !== "string" || !VALID_TEAM_COMMAND_TYPES.has(c.type)) return false;

  // Validate required sub-fields per command type
  switch (type) {
    case "create_roundtable":
      return typeof c.topic === "string";
    case "get_state":
    case "get_attention":
    case "get_open_items":
    case "get_deliverables":
    case "get_metrics":
    case "pause":
    case "resume":
    case "request_wrap_up":
    case "export_markdown":
    case "get_inbox":
    case "list_presets":
      return true;
    case "get_timeline":
      return c.filter === undefined || (typeof c.filter === "object" && c.filter !== null);
    case "post_user_message":
      return typeof c.to === "string" && typeof c.text === "string";
    case "set_ordered_mode":
      return typeof c.on === "boolean";
    case "stop":
      return c.wrapUp === undefined || typeof c.wrapUp === "boolean";
    case "add_seat":
      return typeof c.config === "object" && c.config !== null;
    case "remove_seat":
      return typeof c.seatId === "string" &&
        (c.requestedBy === "user" || c.requestedBy === "self" || c.requestedBy === "peer");
    case "update_seat_auth":
      return typeof c.seatId === "string" &&
        (c.auth === "read_only" || c.auth === "write" || c.auth === "restricted") &&
        (c.pathAllowlist === undefined || Array.isArray(c.pathAllowlist));
    case "wake_seat":
      return typeof c.seatId === "string";
    case "mute_thread":
      return typeof c.threadId === "string" && typeof c.muted === "boolean";
    case "revise_deliverable":
      return typeof c.id === "string" && typeof c.markdown === "string" &&
        (c.expectedRevision === undefined || typeof c.expectedRevision === "number");
    case "stance_on_deliverable":
      return typeof c.id === "string" &&
        (c.stance === "support" || c.stance === "oppose" || c.stance === "conditional") &&
        (c.seatId === undefined || typeof c.seatId === "string");
    case "build_handoff":
      return typeof c.deliverableId === "string" && (c.target === "solo" || c.target === "plan");
    case "ack_attention":
      return typeof c.id === "string";
    case "respond_permission":
      return typeof c.requestId === "string" && typeof c.approved === "boolean";
    case "respond_exit":
      return typeof c.requestId === "string" && typeof c.statement === "string";
    case "set_settings":
      return typeof c.settings === "object" && c.settings !== null;
    case "downgrade_models":
      return typeof c.model === "string";
    case "save_preset":
      return typeof c.name === "string" && Array.isArray(c.seats);
    case "delete_preset":
      return typeof c.name === "string";
    default: {
      // Compile-time exhaustiveness: a new TeamCommand member without a case
      // above leaves `type` non-never and fails this assignment.
      const exhaustive: never = type;
      void exhaustive;
      return false;
    }
  }
}

/**
 * Dispatch one roundtable command onto the TeamManager facade (plan §4.12).
 * Plan / AgentTask / RPC commands never come through here.
 */
async function executeTeamCommand(teamManager: TeamManager, cmd: TeamCommand): Promise<unknown> {
  switch (cmd.type) {
    case "create_roundtable":
      return teamManager.createRoundtable({
        topic: cmd.topic,
        name: cmd.name,
        tier: cmd.tier,
        seats: cmd.seats,
        settings: cmd.settings,
        attachments: cmd.attachments,
      });
    case "get_state":
      return teamManager.getState();
    case "get_timeline":
      return teamManager.getTimeline(cmd.filter);
    case "get_attention":
      return teamManager.getAttention();
    case "get_open_items":
      return teamManager.getOpenItems();
    case "get_deliverables":
      return teamManager.getDeliverables();
    case "get_metrics":
      return teamManager.getMetrics();
    case "get_inbox":
      return teamManager.getInbox(cmd.seatId);
    case "post_user_message":
      return teamManager.postUserMessage({
        to: cmd.to,
        text: cmd.text,
        private: cmd.private,
        interrupt: cmd.interrupt,
        attachments: cmd.attachments,
      });
    case "set_ordered_mode":
      // H27: only writes settings.orderedMode; RoundtableState.orderedMode is a
      // read-only projection the facade re-emits with `roundtable_state`.
      teamManager.setOrderedMode(cmd.on);
      return null;
    case "pause":
      await teamManager.pause();
      return null;
    case "resume":
      teamManager.resume("renderer_resume");
      return null;
    case "stop":
      await teamManager.stop({ wrapUp: cmd.wrapUp });
      return null;
    case "add_seat":
      return teamManager.addSeat(cmd.config);
    case "remove_seat":
      await teamManager.removeSeat(cmd.seatId, cmd.requestedBy);
      return null;
    case "update_seat_auth":
      await teamManager.updateSeatAuth(cmd.seatId, cmd.auth, cmd.pathAllowlist);
      return null;
    case "wake_seat":
      await teamManager.wakeSeat(cmd.seatId);
      return null;
    case "mute_thread":
      teamManager.muteThread(cmd.threadId, cmd.muted);
      return null;
    case "request_wrap_up":
      return teamManager.requestWrapUp(cmd.author);
    case "revise_deliverable":
      // 用户经 IPC 修订：以 USER_SEAT_ID 记名（用户不是席位，但时间线/交付物
      // 里用户的固定 id 就是它）。revision 令牌必须是面板打开时读到的值。
      return teamManager.reviseDeliverable(cmd.id, cmd.markdown, USER_SEAT_ID, cmd.expectedRevision);
    case "stance_on_deliverable":
      return teamManager.stanceOnDeliverable(
        cmd.id,
        cmd.seatId ?? USER_SEAT_ID,
        cmd.stance,
        cmd.reason,
        cmd.confidence,
      );
    case "export_markdown":
      return teamManager.exportMarkdown();
    case "build_handoff":
      return teamManager.buildHandoff(cmd.deliverableId, cmd.target);
    case "ack_attention":
      teamManager.ackAttention(cmd.id);
      return null;
    case "respond_permission":
      teamManager.respondPermission(cmd.requestId, cmd.approved, cmd.reason);
      return null;
    case "respond_exit":
      await teamManager.respondExit(cmd.requestId, cmd.statement, cmd.accept);
      return null;
    case "set_settings":
      teamManager.setSettings(cmd.settings);
      return null;
    case "downgrade_models":
      await teamManager.downgradeModels(cmd.model);
      return null;
    case "list_presets":
      return teamManager.listPresets();
    case "save_preset":
      await teamManager.savePreset(cmd.name, cmd.seats);
      return null;
    case "delete_preset":
      await teamManager.deletePreset(cmd.name);
      return null;
    default: {
      // Compile-time exhaustiveness: a new TeamCommand member without a case
      // above leaves `cmd` non-never and fails this assignment.
      const exhaustive: never = cmd;
      throw new Error(`Unknown team command type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// Re-export the pure plan/agent-task IPC adapters (see ipc-plan-adapters.ts /
// ipc-agent-task-adapters.ts) so callers that import the registration
// functions, event-forwarding subscriptions or adapter types from
// ipc-handlers keep working.
export {
  executePlanCommand,
  isPlanCommand,
  registerPlanIpcHandlers,
  resyncPlanEventForwarding,
  subscribePlanEventForwarding,
  type IpcMainLike,
  type WebContentsLike,
} from "./ipc-plan-adapters.js";

export {
  executeAgentTaskCommand,
  isAgentTaskCommand,
  registerAgentTaskIpcHandlers,
  subscribeAgentTaskEventForwarding,
} from "./ipc-agent-task-adapters.js";

export {
  executeWorkflowCommand,
  registerWorkflowIpcHandlers,
  resyncWorkflowEventForwarding,
  subscribeWorkflowEventForwarding,
} from "./ipc-workflow-adapters.js";
