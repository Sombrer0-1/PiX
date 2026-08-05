import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TeammateChatMessage } from "../shared/types.js";
import { TeamMessageBus } from "./team-message-bus.js";
import { normalizeRestoredTeamTasks } from "./team-orchestration.js";
import { TeamProtocolManager } from "./team-protocol-manager.js";
import type { PersistedTeamSnapshot, TeamData } from "./team-runtime-types.js";
import { TeamTaskList } from "./team-task-list.js";

export function teamSnapshotPath(cwd: string): string {
  const cwdHash = createHash("sha1").update(cwd).digest("hex");
  return join(getAgentDir(), "team-state", cwdHash, "team.json");
}

/** The user's last-chosen workspace mode for a project, persisted per-cwd. */
export type WorkspaceMode = "team" | "solo";

export function workspaceModePath(cwd: string): string {
  const cwdHash = createHash("sha1").update(cwd).digest("hex");
  return join(getAgentDir(), "team-state", cwdHash, "mode.json");
}

/** Read the persisted workspace mode. Returns null when no preference exists. */
export async function readWorkspaceMode(cwd: string): Promise<WorkspaceMode | null> {
  try {
    const raw = await readFile(workspaceModePath(cwd), "utf-8");
    const parsed = JSON.parse(raw) as { mode?: unknown };
    return parsed.mode === "team" || parsed.mode === "solo" ? parsed.mode : null;
  } catch {
    return null;
  }
}

/** Persist the user's chosen workspace mode for a project. */
export async function writeWorkspaceMode(cwd: string, mode: WorkspaceMode): Promise<void> {
  const path = workspaceModePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  // Atomic write (same approach as the team snapshot) so a crash mid-write
  // can never leave a half-written mode.json.
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ mode }, null, 2), "utf-8");
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export function createPersistedTeamSnapshot(cwd: string, team: TeamData): PersistedTeamSnapshot {
  const messageHistory: Record<string, TeammateChatMessage[]> = {};
  for (const [agentId, worker] of team.workers) {
    messageHistory[agentId] = worker.messageHistory.map((msg) => ({ ...msg }));
  }

  return {
    version: 1,
    cwd,
    savedAt: Date.now(),
    team: {
      name: team.name,
      status: team.status,
      leadAgentId: team.leadAgentId,
      createdAt: team.createdAt,
      workers: Array.from(team.workers.values()).map((worker) => ({ ...worker.info })),
      tasks: team.taskList.getAll(),
      bus: team.bus.snapshot(),
      messageHistory,
    },
  };
}

export async function persistTeamSnapshot(cwd: string, team: TeamData): Promise<void> {
  const snapshot = createPersistedTeamSnapshot(cwd, team);
  const path = teamSnapshotPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  // Atomic write: serialize to a unique temp file, then rename over the target.
  // rename() is atomic on the same filesystem, so a crash mid-write can never
  // leave a half-written team.json that fails to parse on restore.
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf-8");
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function deletePersistedTeamSnapshot(cwd: string): Promise<void> {
  await rm(teamSnapshotPath(cwd), { force: true }).catch(() => {});
}

export async function readPersistedTeamSnapshot(cwd: string): Promise<PersistedTeamSnapshot | null> {
  try {
    const raw = await readFile(teamSnapshotPath(cwd), "utf-8");
    return JSON.parse(raw) as PersistedTeamSnapshot;
  } catch {
    return null;
  }
}

export function isRestorableTeamSnapshot(snapshot: PersistedTeamSnapshot, cwd: string): boolean {
  return snapshot.version === 1 && snapshot.cwd === cwd && snapshot.team.status !== "stopping";
}

export function hydratePersistedTeam(snapshot: PersistedTeamSnapshot): TeamData {
  const now = Date.now();
  const team: TeamData = {
    name: snapshot.team.name,
    status: "active",
    leadAgentId: snapshot.team.leadAgentId,
    workers: new Map(),
    bus: new TeamMessageBus(),
    taskList: new TeamTaskList(),
    protocolManager: new TeamProtocolManager(),
    createdAt: snapshot.team.createdAt,
  };

  for (const info of snapshot.team.workers) {
    const status = info.status === "running" ? "idle" :
      info.status === "shutdown" ? (info.activationPolicy === "always" ? "idle" : "dormant") :
      info.status;
    team.workers.set(info.agentId, {
      info: {
        ...info,
        status,
        error: status === "error" ? info.error : undefined,
        statusChangedAt: now,
      },
      session: null,
      mcpAdapter: null,
      lifecycleAbortController: null,
      workAbortController: null,
      runner: null,
      messageHistory: (snapshot.team.messageHistory[info.agentId] ?? []).map((msg) => ({ ...msg })),
    });
  }

  const restoredTasks = normalizeRestoredTeamTasks(snapshot.team.tasks, team.workers.keys());
  team.taskList.replaceAll(restoredTasks);
  team.bus.restore(snapshot.team.bus);
  return team;
}
