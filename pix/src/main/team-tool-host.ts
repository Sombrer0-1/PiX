import type {
  MessageKind,
  TeamTask,
  TeamTaskContextPack,
  TeamTaskEvidence,
  TeamTaskFileConflict,
  TeamTaskGateState,
  TeamTaskHandoffPacket,
  TeamTaskStatus,
  TeamTaskType,
  TeammateInfo,
  TeammateRole,
} from "../shared/types.js";
import type { TeamData, WorkerState } from "./team-runtime-types.js";
import type { OrchestrationEvent } from "./team-orchestration.js";

export interface TeamToolHost {
  getTeam(): TeamData | null;
  setLeaderTurnActive(active: boolean): void;
  scheduleOrchestratorQueue(delayMs?: number): void;
  sendTeamMessage(fromAgentId: string, toAgentId: string, text: string, summary?: string, kind?: MessageKind): Promise<void>;
  createTask(subject: string, description: string, assignTo?: string, blockedBy?: string[], taskType?: TeamTaskType): TeamTask;
  assignTask(taskId: string, agentId: string): TeamTask | null;
  activateMember(agentId: string): Promise<void>;
  pauseMember(agentId: string): Promise<void>;
  addWorker(options: {
    name?: string;
    role: TeammateRole;
    model?: string;
    specialization?: string;
    activateNow?: boolean;
  }): Promise<TeammateInfo>;
  requestShutdown(agentId?: string): Promise<{ agentId: string; confirmed: boolean }[]>;
  respondShutdown(agentId: string, confirmed: boolean, reason?: string): boolean;
  requestPermission(agentId: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ approved: boolean; reason?: string }>;
  requestPlanApproval(agentId: string, plan: string, files: string[], signal?: AbortSignal): Promise<{ approved: boolean; feedback?: string }>;
  respondPlanApproval(approvalId: string, approved: boolean, feedback?: string): boolean;
  updateTask(taskId: string, changes: {
    status?: TeamTaskStatus;
    result?: string;
    evidence?: TeamTaskEvidence;
    contextPack?: TeamTaskContextPack;
    handoff?: TeamTaskHandoffPacket;
    gateState?: TeamTaskGateState;
    fileConflicts?: TeamTaskFileConflict[];
    ownerAgentId?: string;
  }): TeamTask;
  createTaskHandoff(task: TeamTask, agentId: string, result: string, evidence: TeamTaskEvidence): TeamTaskHandoffPacket;
  completionGateState(task: TeamTask, result: string): TeamTaskGateState;
  emitWorkerCompletionSummary(agentId: string, task: TeamTask, workerName: string, workerRole: TeammateRole, result: string): void;
  coordinateAfterTaskCompletion(task: TeamTask, agentId: string, result: string): void;
  wakeLeaderForOrchestration(event: OrchestrationEvent): void;
  selectWorkerForRole(role: TeammateRole): WorkerState | null;
}
