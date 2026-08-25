/**
 * TeamManager
 *
 * Manages the lifecycle of agent teams in the main process.
 * Coordinates worker agent sessions, in-memory message queues,
 * team state transitions, and Leader orchestration.
 */

import { randomUUID } from "crypto";
import { rm } from "fs/promises";
import { join } from "path";
import {
	type AgentSession,
	type ExtensionAPI,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	type ExecutionBackend,
	type RuntimeEnvironmentContext,
	createAgentSession,
	SessionManager,
	SettingsManager,
	AuthStorage,
	DefaultResourceLoader,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { McpAdapter } from "pi-mcp-adapter";
import type { ProjectExecutionContext } from "./execution-context.js";
import {
  formatInternalNotification,
  INTERNAL_CUSTOM_MESSAGE_TYPES,
} from "../shared/internal-notification.js";
import type {
	TeamState,
	TeammateInfo,
	TeammateRole,
	TeammateStatus,
	TeamEvent,
	TeammateChatMessage,
	TeamMessage,
	TeamHistory,
	MessageKind,
	TeamTask,
	TeamTaskEvidence,
	TeamTaskContextPack,
	TeamTaskGateState,
	TeamTaskHandoffPacket,
	TeamTaskFileConflict,
	TeamTaskStatus,
	TeamTaskType,
	AgentSessionEvent as LocalAgentSessionEvent,
	WorkerConfig,
} from "../shared/types.js";
import {
  DEFAULT_WORKER_CONFIGS,
  LEADER_AGENT_NAME,
  PROTOCOL_TIMEOUT_MS,
  ROLE_PERMISSIONS,
  ROLE_TASK_CAPABILITIES,
  SHUTDOWN_TIMEOUT_MS,
  WORKER_STUCK_TURN_TIMEOUT_MS,
  LEADER_STUCK_TURN_TIMEOUT_MS,
  ORCHESTRATION_STALL_RECOVERY_INTERVAL_MS,
} from "./team-constants.js";
import { TeamMessageBus } from "./team-message-bus.js";
import {
  buildTeamOrchestrationPrompt,
  buildWorkerUnavailableOrchestrationEvents,
  classifyTeamResult,
  MAX_AUTO_COMPLETION_RESULT_LENGTH,
  MAX_COORDINATION_GENERATION,
  ORCHESTRATOR_WAKE_BASE_RETRY_MS,
  OrchestrationEventQueue,
  planTeamCoordination,
  processOrchestrationWakeQueue,
  type OrchestrationEvent,
  type TeamCoordinationPolicy,
} from "./team-orchestration.js";
import {
  deletePersistedTeamSnapshot,
  hydratePersistedTeam,
  isRestorableTeamSnapshot,
  persistTeamSnapshot,
  readPersistedTeamSnapshot,
} from "./team-persistence.js";
import { TeamProtocolManager } from "./team-protocol-manager.js";
import { classifyWorkerTurnOutcome, mergeEvidenceItems, mergeTeamTaskEvidence } from "./team-results.js";
import type { TeamData, TeamEventCallback, WorkerState } from "./team-runtime-types.js";
import { TeamTaskList, canTransitionTeamTaskStatus } from "./team-task-list.js";
import { registerLeaderTools } from "./team-leader-tools.js";
import type { TeamToolHost } from "./team-tool-host.js";
import {
  registerTeamMessagingTool,
  registerTeamProtocolTool,
  registerTeamTaskTool,
  registerWorkerIdentityPrompt,
} from "./team-worker-tools.js";
import { TeamDebugLogger, summarizeText } from "./team-debug-logger.js";
import { formatAgentId, generateTeamName, parseAgentId, pickTeammateColor, sanitizeAgentName, sleep } from "./team-utils.js";
import { WorkerRunner } from "./team-worker-runner.js";

// ============================================================================
// TeamManager
// ============================================================================

export class TeamManager {
  private _team: TeamData | null = null;
  private _eventCallbacks: TeamEventCallback[] = [];
  /**
   * Host/bootstrap cwd and snapshot/hash key. Settings/Resource/Session managers
   * and the debug logger read this; it is always the physical path, never the
   * model-visible logical path (wsl_plan.md §4.8: snapshot/workspace hash input
   * MUST be physicalCwd).
   */
  private _physicalCwd = "";
  /**
   * Runtime/logical cwd passed to createAgentSession as `runtimeCwd` for both
   * leader and workers. Equals _physicalCwd on Windows; the POSIX path inside
   * the distro under WSL.
   */
  private _logicalCwd = "";
  /**
   * Shared execution backend borrowed from the leader ProjectExecutionContext.
   * Workers reuse this exact object (identity) and never dispose it; only the
   * context owner (SessionBridge) releases the backend (wsl_plan.md §4.8).
   */
  private _executionBackend: ExecutionBackend | null = null;
  /**
   * Explicit WSL marker used to decide MCP allowStdio and worker wiring. It is
   * taken from context.isWsl, NOT inferred from backend existence, so future
   * non-WSL backends are not misclassified (wsl_plan.md §4.8/§4.10).
   */
  private _isWsl = false;
  /** Runtime environment override forwarded to every worker createAgentSession. */
  private _runtimeEnvironmentOverride: Partial<RuntimeEnvironmentContext> | undefined;
  private _authStorage: AuthStorage | null = null;
  /**
   * Session factory used by _launchWorkerInner. Defaults to the real
   * createAgentSession; overridable for tests so the worker bootstrap path can
   * be asserted without a live distro (wsl_plan.md §9.3.7: real
   * createAgentSession object-identity is a distro-gated integration test).
   */
  private readonly _sessionFactory: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
  private _healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  /** Timestamp of the last orchestration stall-recovery nudge (health-check throttle). */
  private _lastStallRecoveryAt = 0;
  /** Reference to the Leader (main) AgentSession for summary injection. */
  private _leaderSession: AgentSession | null = null;
  /** Whether the Leader session is currently in an active turn. */
  private _leaderTurnActive = false;
  /** Watchdog that force-resets _leaderTurnActive if agent_end never fires. */
  private _leaderTurnWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** Agent IDs whose _launchWorker is in flight (prevents concurrent double-launch). */
  private _launchingAgents = new Set<string>();
  /** Pending worker-context-hygiene timers, cleared on team stop/dispose. */
  private _hygieneTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Pending leader-steer retry timers, cleared on team stop/dispose. */
  private _steerRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Queue of orchestration events waiting to be processed by the Leader. */
  private _orchestratorEvents = new OrchestrationEventQueue();
  /** Prevent overlapping Leader wake prompts from racing each other. */
  private _leaderWakeInFlight = false;
  private _orchestratorRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private _orchestratorRetryDueAt = 0;
  private _persistTimer: ReturnType<typeof setTimeout> | null = null;
  private _isRestoringTeam = false;
  /**
   * Worker->leader messages that were being steered into a leader turn when the
   * runtime epoch changed (abort). The leader wake path is a no-op while the
   * runtime is paused, so without deferral these messages would be permanently
   * lost; resumeRuntime re-delivers them.
   */
  private _deferredLeaderMessages: TeamMessage[] = [];
  /** Runtime execution gate; a restored Team is viewable but paused. */
  private _executionState: "active" | "paused" = "paused";
  /** Invalidates all callbacks from work that was aborted or superseded. */
  private _runtimeEpoch = 0;
  private _debugLogger = new TeamDebugLogger();
  /**
   * Last contextual state emitted to the debug log. Each logTeamDebug line only
   * records the fields that changed since the previous line; a reader carries the
   * previous value forward, which keeps the log fully reconstructable while
   * dropping the bulk of repeated context.
   */
  private _lastLoggedContext: {
    teamStatus?: TeamData["status"];
    leaderTurnActive?: boolean;
    leaderWakeInFlight?: boolean;
    pendingOrchestrationEvents?: number;
  } = {};

  /**
   * @param options.sessionFactory Override the AgentSession factory (tests only).
   *   Production callers omit it; `new TeamManager()` uses the real
   *   createAgentSession, preserving existing behavior.
   */
  constructor(options: { sessionFactory?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult> } = {}) {
    this._sessionFactory = options.sessionFactory ?? createAgentSession;
  }

  /**
   * Set the Leader (main) AgentSession reference.
   * Called by SessionBridge after the main session is activated.
   * The Leader session is where team tools are registered and where worker
   * summaries are injected.
   */
  setLeaderSession(session: AgentSession | null): void {
    this.logTeamDebug("leader.session.set", {
      hasSession: Boolean(session),
      hadSession: Boolean(this._leaderSession),
    });
    this._leaderSession = session;
    this._setLeaderTurnActive(false);
    // Do not clear `_leaderWakeInFlight` here. A process may still be awaiting
    // prompt(); forcing the flag false lets the new session schedule a second
    // concurrent process. The in-flight finally block releases the flag.
    if (this._orchestratorRetryTimer) {
      clearTimeout(this._orchestratorRetryTimer);
      this._orchestratorRetryTimer = null;
    }
    if (session && this.isRuntimeActive() && this._orchestratorEvents.hasPending) {
      this._scheduleOrchestratorQueue();
    }
  }

  /** Register a callback to receive team events (for IPC forwarding). Multiple subscribers supported. */
  onEvent(callback: TeamEventCallback): () => void {
    this._eventCallbacks.push(callback);
    return () => {
      const idx = this._eventCallbacks.indexOf(callback);
      if (idx >= 0) this._eventCallbacks.splice(idx, 1);
    };
  }

  /**
   * Store the leader ProjectExecutionContext and auth storage, called after the
   * leader SessionBridge.start succeeds. The borrowed backend is shared with all
   * workers; TeamManager never disposes it (the context owner does). On failure
   * the IPC layer stops the leader (wsl_plan.md §4.8).
   */
  async initialize(context: ProjectExecutionContext, authStorage: AuthStorage): Promise<void> {
    this._physicalCwd = context.physicalCwd;
    this._logicalCwd = context.logicalCwd;
    this._executionBackend = context.executionBackend ?? null;
    this._isWsl = context.isWsl;
    this._runtimeEnvironmentOverride = context.runtimeEnvironmentOverride;
    this._authStorage = authStorage;
    this._executionState = "paused";
    this._runtimeEpoch++;
    this.logTeamDebug("manager.initialize", {
      physicalCwd: context.physicalCwd,
      logicalCwd: context.logicalCwd,
      isWsl: context.isWsl,
      hasBackend: Boolean(context.executionBackend),
      hasAuthStorage: Boolean(authStorage),
    });
    await this._restorePersistedTeamIfPresent();
  }

  logTeamDebug(event: string, payload: unknown = {}): void {
    const team = this._team;
    // Only emit contextual state fields when they change since the last line.
    // teamName is omitted entirely: the log file is per-team (name is in the
    // filename and the logger.started event), so repeating it on every line is
    // pure noise.
    const context: Record<string, unknown> = {};
    const teamStatus = team?.status;
    const pendingOrchestrationEvents = this._orchestratorEvents.length;
    if (teamStatus !== this._lastLoggedContext.teamStatus) {
      context.teamStatus = teamStatus;
      this._lastLoggedContext.teamStatus = teamStatus;
    }
    if (this._leaderTurnActive !== this._lastLoggedContext.leaderTurnActive) {
      context.leaderTurnActive = this._leaderTurnActive;
      this._lastLoggedContext.leaderTurnActive = this._leaderTurnActive;
    }
    if (this._leaderWakeInFlight !== this._lastLoggedContext.leaderWakeInFlight) {
      context.leaderWakeInFlight = this._leaderWakeInFlight;
      this._lastLoggedContext.leaderWakeInFlight = this._leaderWakeInFlight;
    }
    if (pendingOrchestrationEvents !== this._lastLoggedContext.pendingOrchestrationEvents) {
      context.pendingOrchestrationEvents = pendingOrchestrationEvents;
      this._lastLoggedContext.pendingOrchestrationEvents = pendingOrchestrationEvents;
    }
    this._debugLogger.log(event, {
      ...context,
      ...(
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? payload as Record<string, unknown>
          : { value: payload }
      ),
    });
  }

  // ==========================================================================
  // Team Lifecycle
  // ==========================================================================

  /** Create a new team with the default capability roster. */
  async createTeam(teamName?: string): Promise<TeamState> {
    if (this._team) {
      throw new Error("A team is already active. Stop the current team first.");
    }
    if (!this._physicalCwd) {
      throw new Error("TeamManager not initialized. Start a project session first.");
    }

    const name = teamName ?? generateTeamName();
    const now = Date.now();
    const leadAgentId = formatAgentId(LEADER_AGENT_NAME, name);
    this._executionState = "active";
    this._runtimeEpoch++;

    const workerConfigs: WorkerConfig[] = DEFAULT_WORKER_CONFIGS;

    const team: TeamData = {
      name,
      status: "active",
      leadAgentId,
      workers: new Map(),
      bus: new TeamMessageBus(),
      taskList: new TeamTaskList(),
      protocolManager: new TeamProtocolManager(),
      createdAt: now,
    };

    // Create worker entries from the roster. customName lets multiple workers share a role.
    const usedNames = new Set<string>();
    let colorIndex = 0;
    for (const wc of workerConfigs) {
      const worker = this._buildWorkerEntry(name, wc, usedNames, colorIndex++, now);
      team.workers.set(worker.info.agentId, worker);
    }

    this._team = team;
    this._lastLoggedContext = {};
    this._debugLogger.start(this._physicalCwd, name, "create_team");
    this.logTeamDebug("team.create", {
      teamName: name,
      leadAgentId,
      workers: Array.from(team.workers.values()).map((worker) => worker.info),
    });

    // Start health check
    this._startHealthCheck();

    const state = this.getTeamState()!;
    this._emitEvent({ type: "team_created", team: state });
    this._emitEvent({ type: "team_state_changed", team: state });
    this._schedulePersist();

    // Launch always-on workers. They run autonomously after startup.
    // Iterate the Map to use the actual (possibly deduplicated) agentIds.
    for (const [agentId, worker] of team.workers) {
      if (worker.info.activationPolicy !== "always") continue;
      void this._launchWorker(agentId).catch((err) => {
        console.error(`[TeamManager] Failed to launch worker ${agentId}:`, err);
        this.logTeamDebug("worker.launch.error", { agentId, error: err });
        this.updateWorkerStatus(agentId, "error", String(err));
      });
    }

    return state;
  }

  /**
   * Build a fresh WorkerState from a roster/spawn config. Names are sanitized
   * and deduplicated by suffix ("coder", "coder-2", ...); every teammate gets
   * a palette color so same-role teammates stay distinguishable in the UI.
   */
  private _buildWorkerEntry(
    teamName: string,
    wc: WorkerConfig,
    usedNames: Set<string>,
    colorIndex: number,
    now: number,
  ): WorkerState {
    const baseName = sanitizeAgentName(wc.customName ?? "") || wc.role;
    let workerName = baseName;
    let suffix = 2;
    while (usedNames.has(workerName)) {
      workerName = `${baseName}-${suffix}`;
      suffix++;
    }
    usedNames.add(workerName);

    const activationPolicy = wc.activationPolicy ?? (wc.mode === "core" ? "always" : "when_needed");
    return {
      info: {
        agentId: formatAgentId(workerName, teamName),
        name: workerName,
        role: wc.role,
        mode: wc.mode ?? (activationPolicy === "always" ? "core" : "on_demand"),
        activationPolicy,
        model: wc.model,
        specialization: wc.specialization,
        color: pickTeammateColor(colorIndex),
        status: activationPolicy === "always" ? "idle" : "dormant",
        createdAt: now,
        statusChangedAt: now,
        lastActiveAt: now,
      },
      session: null,
      mcpAdapter: null,
      lifecycleAbortController: null,
      workAbortController: null,
      runner: null,
      messageHistory: [],
    };
  }

  /**
   * Add a new teammate to the active team at runtime (Leader: spawn_teammate).
   *
   * Inspired by Claude Code's dynamic teammate spawning: the leader is not
   * limited to the initial roster and can add parallel capacity (a second
   * coder) or a specialized variant of a role. The teammate gets the standard
   * role toolset/permissions; `specialization` is appended to its identity
   * system prompt.
   */
  async addWorker(options: {
    name?: string;
    role: TeammateRole;
    model?: string;
    specialization?: string;
    activateNow?: boolean;
  }): Promise<TeammateInfo> {
    const team = this._team;
    this._assertRuntimeActive("spawn_teammate");
    if (!team) throw new Error("No active team.");

    const usedNames = new Set(Array.from(team.workers.values()).map((worker) => worker.info.name));
    const worker = this._buildWorkerEntry(team.name, {
      role: options.role,
      customName: options.name,
      model: options.model,
      specialization: options.specialization,
      mode: "on_demand",
      // "manual": restored snapshots never auto-launch spawned teammates
      // unless they own open tasks; the leader re-activates them by need.
      activationPolicy: "manual",
    }, usedNames, team.workers.size, Date.now());
    team.workers.set(worker.info.agentId, worker);
    this.logTeamDebug("worker.spawned", {
      worker: worker.info,
      activateNow: options.activateNow ?? true,
    });

    this._emitEvent({
      type: "teammate_status_changed",
      teamName: team.name,
      agentId: worker.info.agentId,
      status: worker.info.status,
      timestamp: worker.info.statusChangedAt,
    });
    this._emitTeamStateChanged();

    if (options.activateNow ?? true) {
      await this.activateMember(worker.info.agentId);
    }
    return { ...worker.info };
  }

  /** Stop the active team and clean up all resources. */
  async stopTeam(options: { deleteSnapshot?: boolean } = {}): Promise<void> {
    // deleteSnapshot defaults to true so an explicit user "stop team" disbands
    // and forgets the team. Graceful shutdown paths (app quit, session stop)
    // pass false so the team can be restored on reopen.
    const deleteSnapshot = options.deleteSnapshot ?? true;
    const team = this._team;
    if (!team) {
      throw new Error("No active team to stop.");
    }
    if (team.status === "stopping") {
      console.warn("[TeamManager] stopTeam() called while already stopping");
      this.logTeamDebug("team.stop.ignored", { reason: "already_stopping" });
      return;
    }

    // Invalidate worker/Leader callbacks before any teardown or snapshot work.
    // The TeamData snapshot remains compatible because runtime execution state
    // is intentionally not persisted.
    this._executionState = "paused";
    this._runtimeEpoch++;

    // When preserving, flush a final restorable snapshot while the team is still
    // "active" (isRestorableTeamSnapshot rejects "stopping"). This captures the
    // latest worker chat history/tasks/bus that the debounced timer may not have
    // written yet.
    if (!deleteSnapshot && this._physicalCwd) {
      if (this._persistTimer) {
        clearTimeout(this._persistTimer);
        this._persistTimer = null;
      }
      try {
        await persistTeamSnapshot(this._physicalCwd, team);
      } catch (err) {
        console.warn("[TeamManager] Failed to flush team snapshot before stop:", err);
      }
    }

    this.logTeamDebug("team.stop.start", {
      workers: Array.from(team.workers.values()).map((worker) => worker.info),
      taskCount: team.taskList.size(),
      busSize: team.bus.size(),
      deleteSnapshot,
    });
    team.status = "stopping";
    this._emitTeamStateChanged();

    // Clear intervals and subscriptions
    this._stopHealthCheck();
    this._cleanupSubscriptions();

    // Dispose all worker runners and sessions
    const disposePromises: Promise<void>[] = [];
    for (const [agentId, worker] of team.workers) {
      disposePromises.push(
        (async () => {
          try {
            if (worker.runner) {
              await worker.runner.dispose();
              worker.runner = null;
            } else {
              // Fallback: abort and dispose manually
              worker.lifecycleAbortController?.abort();
              worker.workAbortController?.abort();
              worker.unsubscribeEvents?.();
              if (worker.session) {
                await worker.session.dispose({ reason: "quit" });
              }
              if (worker.mcpAdapter) {
                await worker.mcpAdapter.dispose();
              }
            }
            worker.session = null;
            worker.mcpAdapter = null;
            worker.lifecycleAbortController = null;
            worker.workAbortController = null;
            worker.info.status = "shutdown";
            worker.info.statusChangedAt = Date.now();
          } catch (err) {
            console.error(`[TeamManager] Error disposing worker ${agentId}:`, err);
            this.logTeamDebug("worker.dispose.error", { agentId, error: err });
          }
        })(),
      );
    }

    await Promise.allSettled(disposePromises);

    // Remove the workers' session files. Workers always get fresh sessions on
    // (re)launch — their durable history lives in the team snapshot — so the
    // per-team session directory is pure garbage once the sessions are disposed.
    await rm(join(getAgentDir(), "team-sessions", team.name), { recursive: true, force: true })
      .catch((err) => {
        console.warn(`[TeamManager] Failed to clean up team session directory for ${team.name}:`, err);
      });

    // Clear the message bus, task list, and protocol state
    team.bus.clearAll();
    team.taskList.clearAll();
    team.protocolManager.clearAll();

    const teamName = team.name;
    this._team = null;
    this._setLeaderTurnActive(false);
    this._orchestratorEvents.clear();
    this._leaderWakeInFlight = false;
    this._deferredLeaderMessages = [];
    this._clearHygieneTimers();
    this._clearSteerRetryTimers();
    if (this._orchestratorRetryTimer) {
      clearTimeout(this._orchestratorRetryTimer);
      this._orchestratorRetryTimer = null;
    }

    this._emitEvent({ type: "team_deleted", teamName });
    this.logTeamDebug("team.stop.completed", { teamName });
    this._debugLogger.stop("team_stopped");
    if (deleteSnapshot) {
      await this._deletePersistedSnapshot();
    }
  }

  /** Get the current team state snapshot. Returns null if no team is active. */
  getTeamState(): TeamState | null {
    const team = this._team;
    if (!team) return null;

    const teammates: Record<string, TeammateInfo> = {};
    for (const [agentId, worker] of team.workers) {
      teammates[agentId] = { ...worker.info };
    }

    return {
      name: team.name,
      status: team.status,
      leadAgentId: team.leadAgentId,
      teammates,
      createdAt: team.createdAt,
    };
  }

  /** Check if a team is currently active. */
  hasActiveTeam(): boolean {
    return this._team !== null && this._team.status === "active";
  }

  /** Whether Team work is currently allowed to consume messages or mutate tasks. */
  isRuntimeActive(): boolean {
    return this.hasActiveTeam() && this._executionState === "active";
  }

  /** Current internal execution epoch used by workers to reject stale callbacks. */
  getRuntimeEpoch(): number {
    return this._runtimeEpoch;
  }

  isRuntimeEpochCurrent(epoch: number): boolean {
    return this.isRuntimeActive() && epoch === this._runtimeEpoch;
  }

  /** Resume a restored or user-paused Team after an explicit Team action. */
  resumeRuntime(reason = "explicit_action"): void {
    const team = this._team;
    if (!team || team.status !== "active") return;

    const wasPaused = this._executionState !== "active";
    if (wasPaused) {
      this._executionState = "active";
      this._runtimeEpoch++;
      this.logTeamDebug("team.runtime.resumed", {
        reason,
        runtimeEpoch: this._runtimeEpoch,
      });
    }
    this._startHealthCheck();

    // Restored workers have roster state but no live sessions. Explicit
    // activity is the only point at which those sessions may be recreated.
    for (const [agentId, worker] of team.workers) {
      const hasOwnedOpenTask = team.taskList.getAll().some((task) =>
        task.ownerAgentId === agentId && (task.status === "assigned" || task.status === "in_progress"),
      );
      if (worker.info.activationPolicy !== "always" && !hasOwnedOpenTask) continue;
      if (worker.info.status === "shutdown" || worker.info.status === "error") continue;
      if (worker.session && worker.runner) continue;
      void this._launchWorker(agentId).catch((err) => {
        console.error(`[TeamManager] Failed to resume worker ${agentId}:`, err);
        this.logTeamDebug("worker.resume_launch.error", { agentId, error: err });
        this.updateWorkerStatus(agentId, "error", String(err));
      });
    }

    if (wasPaused) {
      // Events enqueued after the abort (user Stop) carry the pre-pause epoch;
      // retag them to the resumed epoch so the canRetry guard does not drop
      // them as stale on their first delivery failure.
      this._orchestratorEvents.retag(this._runtimeEpoch);
      // Re-engage the leader for work paused by an abort or restored from a
      // snapshot, and flush any messages/events deferred during the pause.
      this._reengageLeaderAfterResume(team);
    }
  }

  private _assertRuntimeActive(operation: string): void {
    if (!this._team || this._team.status !== "active") {
      throw new Error("No active team.");
    }
    if (this._executionState !== "active") {
      throw new Error(`Team runtime is paused; ${operation} requires an explicit Team action to resume it.`);
    }
  }

  /**
   * Snapshot the persisted team history (worker chat timelines, pending bus
   * messages, task list) for the renderer to hydrate after a restore. Returns
   * null if no team is active.
   */
  getTeamHistory(): TeamHistory | null {
    const team = this._team;
    if (!team) return null;

    const workerMessages: Record<string, TeammateChatMessage[]> = {};
    for (const [agentId, worker] of team.workers) {
      workerMessages[agentId] = worker.messageHistory.map((msg) => ({ ...msg }));
    }

    // Rebuild the team timeline from the bus's append-only history (which
    // survives consumption), not from pending queues — otherwise messages a
    // worker already consumed would be missing after a restore.
    const seen = new Set<string>();
    const teamMessages: TeamMessage[] = [];
    for (const msg of team.bus.history()) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
      teamMessages.push(msg);
    }
    teamMessages.sort((a, b) => a.timestamp - b.timestamp);

    return {
      workerMessages,
      teamMessages,
      tasks: team.taskList.getAll(),
    };
  }

  /** Get the team name, or null if no team is active. */
  getTeamName(): string | null {
    return this._team?.name ?? null;
  }

  /** Cancel all pending protocol requests for a specific agent. */
  cancelProtocolRequestsForAgent(agentId: string): void {
    this.logTeamDebug("protocol.cancel_for_agent", { agentId });
    this._team?.protocolManager.cancelAllForAgent(agentId);
  }

  /**
   * Interrupt the current team turn without shutting the team down.
   * Used when the user presses Stop in the shared composer: leader work,
   * worker turns, pending protocol waits, and queued orchestration wakes should
   * all stop together so stale internal events do not resume as a new turn.
   */
  async abortActiveTurns(): Promise<void> {
    const team = this._team;
    if (!team || team.status !== "active") return;

    const abortRequestId = randomUUID();
    this._executionState = "paused";
    this._runtimeEpoch++;
    this.logTeamDebug("team.abort_active_turns", {
      abortRequestId,
      runtimeEpoch: this._runtimeEpoch,
      workers: Array.from(team.workers.values()).map((worker) => ({
        agentId: worker.info.agentId,
        status: worker.info.status,
        hasWorkAbortController: Boolean(worker.workAbortController),
        turnId: worker.activeTurnId,
        turnEpoch: worker.activeTurnEpoch,
      })),
    });
    this._orchestratorEvents.clear();
    if (this._orchestratorRetryTimer) {
      clearTimeout(this._orchestratorRetryTimer);
      this._orchestratorRetryTimer = null;
      this._orchestratorRetryDueAt = 0;
    }
    this._leaderWakeInFlight = false;
    this._setLeaderTurnActive(false);
    const clearedMessages = team.bus.clearPending();
    this.logTeamDebug("team.abort_pending_messages_cleared", {
      abortRequestId,
      clearedMessages,
      historyLength: team.bus.history().length,
    });

    // Keep in-progress/assigned tasks with their owners. Releasing them to
    // pending here would let workers auto-reclaim on the next resume and
    // silently restart the in-flight work the user just stopped; the leader
    // re-engages with the paused tasks on resume instead (see resumeRuntime).

    const abortPromises: Promise<void>[] = [];
    for (const [agentId, worker] of team.workers) {
      team.protocolManager.cancelAllForAgent(agentId);
      if (worker.info.status === "running" || worker.workAbortController) {
        if (worker.runner) {
          abortPromises.push(worker.runner.abortCurrentTurn());
        } else {
          worker.workAbortController?.abort();
        }
      }
    }
    await Promise.allSettled(abortPromises);

    // Reset worker statuses so the UI does not keep showing "running" workers
    // with a Stop button that can never succeed while the runtime is paused:
    // the idle loop's isRuntimeActive() gate prevents the natural "idle" reset
    // while paused, so without this the statuses stay "running" after Stop.
    for (const [agentId, worker] of team.workers) {
      if (worker.info.status === "running") {
        this.updateWorkerStatus(agentId, "idle");
      }
    }
  }

  // ==========================================================================
  // Worker Agent Management
  // ==========================================================================

  /**
   * Launch a worker agent: create AgentSession, subscribe to events, start execution loop.
   */
  private async _launchWorker(agentId: string): Promise<void> {
    // Concurrency guard: activateMember / _wakeAssignedTask / sendMessageToWorker
    // can all trigger a launch at nearly the same time. Without this, two calls
    // could both pass the "already running" check (which only flips after the
    // session+runner are assigned) and create two sessions/runners for one
    // worker, leaking the first and double-consuming its messages.
    if (this._launchingAgents.has(agentId)) {
      this.logTeamDebug("worker.launch.skipped", { agentId, reason: "already_launching" });
      return;
    }
    this._launchingAgents.add(agentId);
    try {
      await this._launchWorkerInner(agentId);
    } finally {
      this._launchingAgents.delete(agentId);
    }
  }

  private async _launchWorkerInner(agentId: string): Promise<void> {
    const team = this._team;
    if (!team || team.status !== "active") {
      this.logTeamDebug("worker.launch.skipped", { agentId, reason: "no_active_team" });
      return;
    }
    if (!this._authStorage) throw new Error("AuthStorage not initialized.");

    const worker = team.workers.get(agentId);
    if (!worker) throw new Error(`Worker ${agentId} not found in team.`);
    if (worker.session && worker.runner && (worker.info.status === "idle" || worker.info.status === "running")) {
      this.logTeamDebug("worker.launch.skipped", { agentId, reason: "already_running", status: worker.info.status });
      return;
    }

    this.logTeamDebug("worker.launch.start", {
      agentId,
      worker: worker.info,
    });
    worker.info.lastActiveAt = Date.now();
    // No priming turn is executed at launch (identity lives in the system
    // prompt), so the worker becomes idle-ready as soon as the runner starts.
    this.updateWorkerStatus(agentId, "idle");

    // Create AgentSession (same pattern as SessionBridge._createSession)
    const agentDir = getAgentDir();
    const sessionDir = join(agentDir, "team-sessions", team.name, worker.info.name);
    // Bootstrap consumers (Session/Settings/Resource loaders) use the physical
    // cwd; the Agent runtime uses the logical cwd via runtimeCwd below
    // (wsl_plan.md §4.8: worker bootstrap uses physical cwd).
    const sessionManager = SessionManager.create(this._physicalCwd, sessionDir);
    const settingsManager = SettingsManager.create(this._physicalCwd);
    // WSL mode disables Windows-side stdio MCP (decided by _isWsl, not by
    // backend existence). HTTP/SSE remain configurable (wsl_plan.md §4.10).
    const mcpAdapter = new McpAdapter({ allowStdio: this._isWsl ? false : true });
    const bus = team.bus;
    const resourceLoader = new DefaultResourceLoader({
      cwd: this._physicalCwd,
      agentDir,
      settingsManager,
      extensionFactories: [
        (pi) => { mcpAdapter.register(pi); },
        (pi) => { registerWorkerIdentityPrompt(this._teamToolHost(), pi, agentId); },
        (pi) => { this._registerTeamMessagingTool(pi, agentId); },
        (pi) => { this._registerTeamTaskTool(pi, agentId); },
        (pi) => { this._registerTeamProtocolTool(pi, agentId); },
      ],
    });
    await resourceLoader.reload();
    this.logTeamDebug("worker.resource_loader.reloaded", {
      agentId,
      deniedTools: ROLE_PERMISSIONS[worker.info.role]?.deniedTools ?? [],
    });

    // Enforce role-based tool restrictions at the SDK level.
    // Denied tools are stripped from the session's tool registry so workers
    // physically cannot call them (no need to rely on request_permission alone).
    const roleDenied = ROLE_PERMISSIONS[worker.info.role]?.deniedTools ?? [];

    // Workers reuse the leader's backend object identity and runtime cwd
    // (logical). bootstrap cwd above is physical. When no backend is injected
    // (Windows) runtimeCwd === physicalCwd and behavior is byte-identical to
    // the previous single-cwd path (wsl_plan.md §4.1/§4.8). The worker never
    // disposes the shared backend; only the context owner does.
    const result = await this._sessionFactory({
      cwd: this._physicalCwd,
      runtimeCwd: this._logicalCwd,
      executionBackend: this._executionBackend ?? undefined,
      runtimeEnvironmentOverride: this._runtimeEnvironmentOverride,
      sessionManager,
      settingsManager,
      resourceLoader,
      authStorage: this._authStorage,
      sessionStartEvent: { type: "session_start", reason: "new" },
      excludeTools: roleDenied.length > 0 ? roleDenied : undefined,
    });

    // Guard: team may have been stopped while we were creating the session
    if (!this._team || this._team.status !== "active") {
      this.logTeamDebug("worker.launch.aborted", { agentId, reason: "team_stopped_during_session_create" });
      await result.session.dispose({ reason: "quit" }).catch(() => {});
      await mcpAdapter.dispose().catch(() => {});
      return;
    }

    const session = result.session;
    worker.session = session;
    worker.mcpAdapter = mcpAdapter;

    // Apply a per-worker model override ("provider/modelId" or bare model id).
    // Unset means the worker inherits the default model from settings.
    const modelSpec = worker.info.model?.trim();
    if (modelSpec) {
      const slash = modelSpec.indexOf("/");
      const model = slash > 0
        ? session.modelRegistry.find(modelSpec.slice(0, slash), modelSpec.slice(slash + 1))
        : session.modelRegistry.getAvailable().find((candidate) => candidate.id === modelSpec);
      if (model) {
        await session.setModel(model);
        this.logTeamDebug("worker.model.applied", { agentId, model: `${model.provider}/${model.id}` });
      } else {
        console.warn(`[TeamManager] Worker ${agentId} model "${modelSpec}" not found; using default model`);
        this.logTeamDebug("worker.model.not_found", { agentId, modelSpec });
      }
    }

    // Subscribe to session events and forward as team events.
    // SDK AgentSessionEvent and local AgentSessionEvent are structurally equivalent
    // but distinct types due to different AgentMessage definitions.
    // Validate the event has a 'type' field at runtime so SDK changes don't
    // silently produce malformed events in the renderer.
    const unsubscribe = session.subscribe((rawEvent) => {
      if (rawEvent && typeof rawEvent === "object" && "type" in rawEvent && typeof (rawEvent as Record<string, unknown>).type === "string") {
        worker.info.lastActiveAt = Date.now();
        this._emitEvent({
          type: "teammate_event",
          teamName: team.name,
          agentId,
          event: rawEvent as unknown as LocalAgentSessionEvent,
        } as TeamEvent);
      } else {
        console.warn(`[TeamManager] Worker ${agentId} emitted an unrecognized session event shape, skipping:`, typeof rawEvent);
        this.logTeamDebug("worker.session_event.invalid", { agentId, rawType: typeof rawEvent });
      }
    });
    worker.unsubscribeEvents = unsubscribe;

    // Create lifecycle abort controller
    const lifecycleAbortController = new AbortController();
    worker.lifecycleAbortController = lifecycleAbortController;

    // Create and start the worker runner
    const runner = new WorkerRunner(
      agentId,
      team.name,
      worker.info.role,
      session,
      worker,
      this,
      bus,
      lifecycleAbortController,
    );
    worker.runner = runner;
    this.logTeamDebug("worker.runner.created", {
      agentId,
      role: worker.info.role,
      sessionDir,
    });

    // Start the execution loop (fire-and-forget). The worker idles until a
    // task or message arrives; role identity is injected via system prompt.
    runner.start();
    this.logTeamDebug("worker.runner.started", {
      agentId,
      role: worker.info.role,
    });
  }

  /**
   * Send a message to a specific worker. Backward-compatible API that delegates to the bus.
   */
  async sendMessageToWorker(agentId: string, message: string): Promise<void> {
    this.resumeRuntime("send_message_to_worker");
    const team = this._team;
    if (!team) throw new Error("No active team.");
    if (team.status !== "active") throw new Error("Team is not active.");

    const worker = team.workers.get(agentId);
    if (!worker) throw new Error(`Worker ${agentId} not found in team.`);
    if (worker.info.status === "shutdown" || worker.info.status === "error") {
      throw new Error(`Worker ${agentId} is ${worker.info.status}.`);
    }
    if (worker.info.status === "dormant" || worker.info.status === "standby") {
      await this.activateMember(agentId);
    }

    await this.sendTeamMessage(team.leadAgentId, agentId, message, undefined, "leader_message");
  }

  /**
   * Send a rich message through the bus. Supports all directions:
   * leader-to-worker, worker-to-leader, worker-to-worker, and broadcast.
   */
  async sendTeamMessage(
    fromAgentId: string,
    toAgentId: string,
    text: string,
    summary?: string,
    kind?: MessageKind,
  ): Promise<void> {
    const team = this._team;
    this._assertRuntimeActive("send_team_message");
    if (!team) throw new Error("No active team.");
    this.logTeamDebug("message.send.request", {
      fromAgentId,
      toAgentId,
      kind,
      summary,
      text: summarizeText(text),
    });

    // Resolve fromRole and validate that the sender is either the leader or a known worker.
    const isLeader = fromAgentId === team.leadAgentId;
    const senderWorker = team.workers.get(fromAgentId);
    if (!isLeader && !senderWorker) {
      throw new Error(`Cannot send message: unknown sender "${fromAgentId}". Must be the leader or a team worker.`);
    }
    const fromRole: TeammateRole | "leader" = isLeader ? "leader" : senderWorker!.info.role;

    // Default kind based on direction
    const resolvedKind: MessageKind = kind ?? (
      toAgentId === "*" ? "broadcast" :
      fromAgentId === team.leadAgentId ? "leader_message" :
      "peer_message"
    );

    if (toAgentId === fromAgentId) {
      this.logTeamDebug("message.self_ignored", {
        fromAgentId,
        toAgentId,
        kind: resolvedKind,
        summary,
      });
      return;
    }

    if (toAgentId !== "*" && toAgentId !== team.leadAgentId) {
      const targetWorker = team.workers.get(toAgentId);
      if (!targetWorker) {
        throw new Error(`Cannot send message: unknown recipient "${toAgentId}".`);
      }
      if (targetWorker.info.status === "shutdown" || targetWorker.info.status === "error") {
        throw new Error(`Cannot send message: recipient "${toAgentId}" is ${targetWorker.info.status}.`);
      }
      if (targetWorker.info.status === "dormant" || targetWorker.info.status === "standby") {
        await this.activateMember(toAgentId);
      }
    }

    const msg: TeamMessage = {
      id: randomUUID(),
      teamName: team.name,
      fromAgentId,
      toAgentId,
      text,
      timestamp: Date.now(),
      read: false,
      delivered: false,
      summary: summary ?? text.slice(0, 80),
      kind: resolvedKind,
      fromRole,
    };

    // The Leader has no WorkerRunner mailbox. Keep worker-to-Leader messages
    // in the timeline for history/UI, but only enqueue messages that a worker
    // can actually consume.
    if (toAgentId === team.leadAgentId) {
      team.bus.recordHistoryOnly(msg);
    } else {
      team.bus.send(msg);
    }
    this.logTeamDebug("message.bus.sent", {
      message: summarizeTeamMessage(msg),
      busSize: team.bus.size(),
    });

    // Emit bus message event (for renderer timeline)
    this._emitEvent({ type: "team_message", teamName: team.name, message: msg });

    if (!isLeader) {
      if (toAgentId === team.leadAgentId) {
        // Direct worker-to-leader message. Surface it to the renderer, then
        // deliver it to the leader LLM exactly once: steer it into an active
        // leader turn for mid-turn visibility, or — when the leader is idle —
        // wake it with an orchestration turn that already carries the text.
        // Doing both would duplicate the content in the leader's context.
        const workerName = parseAgentId(fromAgentId)?.agentName ?? fromAgentId;
        const summaryText = [
          `<teammate-message from="${workerName}" role="${fromRole}">`,
          text,
          `</teammate-message>`,
        ].join("\n");

        this._emitEvent({
          type: "worker_summary",
          teamName: team.name,
          fromAgentId,
          summary: summaryText,
        });

        // This turn delivered content to the leader; record it so the
        // turn-outcome handler does not emit a duplicate orphan-turn wake.
        senderWorker!.sentLeaderMessageThisTurn = true;
        // Only steer into a live stream. `_leaderTurnActive` can stay true after
        // the turn has stopped streaming (agent_end not yet observed); persist-
        // steering in that window writes a stale notification that abort cannot
        // clear. Queue a wake instead so the message is delivered as a turn.
        if (this._leaderSession?.isStreaming) {
          this._steerLeaderWithRetry(summaryText, msg);
        } else {
          this._wakeLeaderForMessage(msg);
        }
      } else if (this._shouldWakeLeaderForMessage(msg)) {
        // Broadcasts and coordination-relevant peer traffic wake the leader.
        senderWorker!.sentLeaderMessageThisTurn = true;
        this._wakeLeaderForMessage(msg);
      }
    }
  }

  /**
   * Inject text into the Leader session with bounded retries. Fire-and-forget so
   * it never blocks the worker's tool call. Re-reads _leaderSession each attempt
   * so it stops cleanly if the team is torn down mid-retry. If every attempt
   * fails and a source message is provided, fall back to the orchestration wake
   * so the leader still learns about the report.
   */
  private _steerLeaderWithRetry(
    text: string,
    sourceMessage?: TeamMessage,
    attempt = 0,
    runtimeEpoch = this._runtimeEpoch,
  ): void {
    if (!this.isRuntimeEpochCurrent(runtimeEpoch)) {
      // The runtime epoch changed (typically an abort) while this steer was in
      // flight or queued for retry. The leader wake path is a no-op while the
      // runtime is paused, so silently returning here would lose the
      // worker->leader message forever. Defer it for re-delivery on resume.
      if (sourceMessage) {
        this._deferLeaderMessage(sourceMessage);
      }
      this.logTeamDebug("leader.steer.skipped_stale", {
        attempt,
        runtimeEpoch,
        currentRuntimeEpoch: this._runtimeEpoch,
        sourceMessageId: sourceMessage?.id,
        deferred: Boolean(sourceMessage),
      });
      return;
    }
    const session = this._leaderSession;
    if (!session) {
      if (sourceMessage) this._wakeLeaderForMessage(sourceMessage);
      return;
    }
    const internalContent = sourceMessage
      ? this._formatTeamMessageNotification(sourceMessage, text)
      : text;
    const delivery = session.sendCustomMessage
      ? session.sendCustomMessage(
        {
          customType: INTERNAL_CUSTOM_MESSAGE_TYPES.TEAM_NOTIFICATION,
          content: internalContent,
          display: false,
          context: "internal",
        },
        { deliverAs: "steer" },
      )
      : session.steer(text);
    void delivery.catch((err) => {
      const maxAttempts = 3;
      if (attempt + 1 >= maxAttempts) {
        console.warn("[TeamManager] Failed to steer worker summary into leader after retries:", err);
        this.logTeamDebug("leader.steer.failed", { attempt: attempt + 1, error: err });
        if (sourceMessage) this._wakeLeaderForMessage(sourceMessage);
        return;
      }
      const delayMs = 500 * 2 ** attempt;
      const timer = setTimeout(() => {
        this._steerRetryTimers.delete(timer);
        this._steerLeaderWithRetry(text, sourceMessage, attempt + 1, runtimeEpoch);
      }, delayMs);
      this._steerRetryTimers.add(timer);
    });
  }

  private _formatTeamMessageNotification(message: TeamMessage, fallbackText: string): string {
    const team = this._team;
    const worker = team?.workers.get(message.fromAgentId);
    const workerName = worker?.info.name ?? parseAgentId(message.fromAgentId)?.agentName ?? message.fromAgentId;
    const actionable = new Set<MessageKind>([
      "question",
      "proposal",
      "objection",
      "review_request",
      "fix_request",
      "blocked",
    ]);
    return formatInternalNotification({
      notificationId: `team-message:${message.id}`,
      source: "team",
      kind: message.kind,
      agentName: workerName,
      status: "received",
      requiresAction: actionable.has(message.kind),
      result: message.text || fallbackText,
    });
  }

  /**
   * Broadcast a message to all workers in the team.
   */
  async broadcastTeamMessage(
    fromAgentId: string,
    text: string,
    summary?: string,
    kind?: MessageKind,
  ): Promise<void> {
    await this.sendTeamMessage(fromAgentId, "*", text, summary, kind ?? "broadcast");
  }

  // ==========================================================================
  // Task Management
  // ==========================================================================

  /**
   * Create a new task in the team's shared task list.
   * If assignTo is provided, the task is immediately assigned to that agent.
   */
  createTask(
    subject: string,
    description: string,
    assignTo?: string,
    blockedBy?: string[],
    taskType?: TeamTaskType,
    metadata?: Record<string, unknown>,
  ): TeamTask {
    const team = this._team;
    this._assertRuntimeActive("create_task");
    if (!team) throw new Error("No active team.");
    this.logTeamDebug("task.create.request", {
      subject,
      assignTo,
      blockedBy,
      taskType,
      metadata,
      description: summarizeText(description),
    });

    // Resolve blockedBy references. Leader-facing prompts abbreviate task IDs
    // to 8 characters, so accept full IDs or unique prefixes.
    const resolvedBlockedBy: string[] = [];
    for (const depId of blockedBy ?? []) {
      const resolved = team.taskList.resolveTaskId(depId);
      if (!resolved) {
        throw new Error(`Dependency task ${depId} not found.`);
      }
      resolvedBlockedBy.push(resolved);
    }

    // Tasks always start as pending. Status transitions:
    //   pending -> assigned (via assignTask) -> in_progress (worker claims) -> completed
    const task = team.taskList.create({
      id: randomUUID(),
      teamName: team.name,
      subject,
      description,
      taskType,
      status: "pending",
      blockedBy: resolvedBlockedBy,
      blocks: [],
      metadata,
      gateState: this._createInitialGateState(taskType, metadata),
    });

    // Register this task as a downstream dependent in each blocking task's blocks array
    for (const depId of resolvedBlockedBy) {
      const dep = team.taskList.get(depId);
      if (dep) {
        team.taskList.update(depId, { blocks: [...dep.blocks, task.id] });
      }
    }

    this._refreshFileConflicts();
    const createdTask = team.taskList.get(task.id) ?? task;
    this.logTeamDebug("task.created", { task: summarizeTeamTask(createdTask) });
    this._emitEvent({ type: "task_created", teamName: team.name, task: createdTask });
    this._emitTeamStateChanged();

    if (!assignTo && taskType) {
      assignTo = this._selectWorkerForTaskType(taskType)?.info.agentId;
    }

    // If assigned to a specific worker, use assignTask to transition to "assigned"
    // and send the wake message.
    if (assignTo) {
      try {
        const assigned = this.assignTask(task.id, assignTo);
        if (assigned) {
          return assigned;
        }
      } catch (err) {
        console.warn(`[TeamManager] Task created but assignment to ${assignTo} failed:`, err);
      }
    }

    return createdTask;
  }

  /**
   * Get all tasks, optionally filtered by status.
   */
  getTasks(status?: TeamTaskStatus): TeamTask[] {
    const team = this._team;
    if (!team) return [];
    return team.taskList.getAll(status);
  }

  /**
   * Update a task's status, result, or owner.
   */
  updateTask(taskId: string, changes: {
    status?: TeamTaskStatus;
    result?: string;
    evidence?: TeamTaskEvidence;
    contextPack?: TeamTaskContextPack;
    handoff?: TeamTaskHandoffPacket;
    gateState?: TeamTaskGateState;
    fileConflicts?: TeamTaskFileConflict[];
    ownerAgentId?: string;
  }): TeamTask {
    const team = this._team;
    this._assertRuntimeActive("update_task");
    if (!team) throw new Error("No active team.");

    taskId = team.taskList.resolveTaskId(taskId) ?? taskId;
    const current = team.taskList.get(taskId);
    if (!current) throw new Error(`Task ${taskId} not found.`);
    this.logTeamDebug("task.update.request", {
      taskId,
      before: summarizeTeamTask(current),
      changes,
    });
    if (changes.status && !canTransitionTeamTaskStatus(current.status, changes.status)) {
      throw new Error(`Invalid task status transition: ${current.status} -> ${changes.status}.`);
    }

    const updated = team.taskList.update(taskId, changes);
    if (!updated) throw new Error(`Task ${taskId} not found.`);
    this._refreshFileConflicts();
    const finalTask = team.taskList.get(taskId) ?? updated;
    this.logTeamDebug("task.updated", { task: summarizeTeamTask(finalTask) });

    this._emitEvent({ type: "task_updated", teamName: team.name, task: finalTask });
    this._emitTeamStateChanged();

    if (changes.status === "completed") {
      this._wakeTasksUnblockedBy(finalTask.id);
    }

    return finalTask;
  }

  /**
   * Delete a task from the team's task list.
   */
  deleteTask(taskId: string): void {
    const team = this._team;
    this._assertRuntimeActive("delete_task");
    if (!team) throw new Error("No active team.");

    taskId = team.taskList.resolveTaskId(taskId) ?? taskId;
    team.taskList.delete(taskId);
    this._refreshFileConflicts();
    this.logTeamDebug("task.deleted", { taskId });
    this._emitEvent({ type: "task_deleted", teamName: team.name, taskId });
    this._emitTeamStateChanged();

  }

  /**
   * Assign a specific task to a specific worker (Leader tool).
   * Only works for pending, unassigned tasks.
   */
  assignTask(taskId: string, agentId: string): TeamTask | null {
    const team = this._team;
    this._assertRuntimeActive("assign_task");
    if (!team) throw new Error("No active team.");
    this.logTeamDebug("task.assign.request", { taskId, agentId });

    // Verify agent exists
    const worker = team.workers.get(agentId);
    if (!worker) throw new Error(`Worker ${agentId} not found in team.`);
    if (worker.info.status === "shutdown" || worker.info.status === "error") {
      throw new Error(`Worker ${agentId} is ${worker.info.status}.`);
    }

    taskId = team.taskList.resolveTaskId(taskId) ?? taskId;
    const task = team.taskList.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found.`);
    if (task.status !== "pending") throw new Error(`Task ${taskId} is not pending (current: ${task.status}).`);
    if (task.ownerAgentId) throw new Error(`Task ${taskId} already assigned to ${task.ownerAgentId}.`);

    // Check role capability if taskType is set
    if (task.taskType && worker.info.role) {
      const capabilities = ROLE_TASK_CAPABILITIES[worker.info.role];
      if (!capabilities.includes(task.taskType)) {
        throw new Error(
          `Role "${worker.info.role}" cannot handle task type "${task.taskType}". ` +
          `Capabilities: ${capabilities.join(", ")}`,
        );
      }
    }

    const openDependencies = team.taskList.getOpenDependencies(taskId);

    // Set owner and transition to "assigned". The worker will transition
    // to "in_progress" when it actually claims and starts executing the task.
    const updated = team.taskList.update(taskId, {
      ownerAgentId: agentId,
      status: "assigned",
    });
    if (!updated) return null;
    this._refreshFileConflicts();
    const assignedTask = team.taskList.get(taskId) ?? updated;
    this.logTeamDebug("task.assigned", {
      task: summarizeTeamTask(assignedTask),
      agentId,
    });

    this._emitEvent({ type: "task_updated", teamName: team.name, task: assignedTask });
    this._emitTeamStateChanged();

    if (openDependencies.length > 0) {
      this.logTeamDebug("task.assigned.waiting_for_dependencies", {
        task: summarizeTeamTask(assignedTask),
        agentId,
        openDependencies,
      });
      return assignedTask;
    }

    this._wakeAssignedTask(assignedTask, agentId, "assigned_ready");

    return assignedTask;
  }

  private _wakeTasksUnblockedBy(completedTaskId: string): void {
    const team = this._team;
    if (!team || team.status !== "active") return;

    for (const task of team.taskList.getAll("assigned")) {
      if (!task.ownerAgentId || !task.blockedBy.includes(completedTaskId)) continue;
      const openDependencies = team.taskList.getOpenDependencies(task.id);
      if (openDependencies.length > 0) continue;
      this._wakeAssignedTask(task, task.ownerAgentId, "dependencies_completed");
    }
  }

  private _wakeAssignedTask(task: TeamTask, agentId: string, reason: string): void {
    const team = this._team;
    if (!team || team.status !== "active") return;

    const worker = team.workers.get(agentId);
    if (!worker) return;
    if (worker.info.status === "shutdown" || worker.info.status === "error") {
      this.logTeamDebug("task.assign.wake_skipped", {
        task: summarizeTeamTask(task),
        agentId,
        reason: "worker_unavailable",
        workerStatus: worker.info.status,
      });
      return;
    }

    if (worker.info.status === "dormant" || worker.info.status === "standby") {
      void this.activateMember(agentId).catch((err) => {
        console.error(`[TeamManager] Failed to activate ${agentId} for assigned task ${task.id}:`, err);
        this.updateWorkerStatus(agentId, "error", String(err));
      });
    }

    const wakeMsg: TeamMessage = {
      id: randomUUID(),
      teamName: team.name,
      fromAgentId: team.leadAgentId,
      toAgentId: agentId,
      text: this._formatTaskPrompt(task),
      timestamp: Date.now(),
      read: false,
      delivered: false,
      summary: `Task assigned: ${task.subject}`,
      kind: "task_message",
      fromRole: "leader",
    };
    team.bus.send(wakeMsg);
    this.logTeamDebug("task.assign.wake_message_sent", {
      reason,
      message: summarizeTeamMessage(wakeMsg),
      busSize: team.bus.size(),
    });
    this._emitEvent({ type: "team_message", teamName: team.name, message: wakeMsg });
  }

  /**
   * Attempt to claim the next available task for the given agent.
   * Returns the claimed task (with formatted prompt) or null.
   * This is called by workers during their idle loop.
   *
   * Role-based filtering: if a task has a taskType, only workers whose
   * ROLE_TASK_CAPABILITIES include that type can claim it. Tasks without
   * a taskType are claimable by any role (backward compat).
   */
  tryClaimNextTask(agentId: string): { task: TeamTask; prompt: string } | null {
    const team = this._team;
    if (!team || team.status !== "active" || !this.isRuntimeActive()) return null;

    // Get worker role for capability check
    const worker = team.workers.get(agentId);

    const task = team.taskList.tryClaimNextTask(agentId, worker?.info.role);
    if (!task) {
      return null;
    }

    const contextPack = this._buildTaskContextPack(task);
    const claimGateState = this._updateGateStatus(task, "active", "Task claimed by worker.");
    const enrichedTask = team.taskList.update(task.id, {
      contextPack,
      gateState: claimGateState,
    }) ?? { ...task, contextPack, gateState: claimGateState };
    this._refreshFileConflicts();
    const finalTask = team.taskList.get(task.id) ?? enrichedTask;
    this.logTeamDebug("task.claimed", {
      agentId,
      role: worker?.info.role,
      task: summarizeTeamTask(finalTask),
    });

    // Emit task_updated event (status changed to in_progress)
    this._emitEvent({ type: "task_updated", teamName: team.name, task: finalTask });
    this._emitTeamStateChanged();

    const prompt = this._formatTaskPrompt(finalTask);

    return { task: finalTask, prompt };
  }

  /**
   * Claim a specific task by ID for the given agent.
   * Returns the claimed task (with formatted prompt) or null if not claimable.
   */
  claimTask(taskId: string, agentId: string): { task: TeamTask; prompt: string } | null {
    const team = this._team;
    if (!team || team.status !== "active" || !this.isRuntimeActive()) return null;

    const task = team.taskList.claimTask(taskId, agentId);
    if (!task) {
      this.logTeamDebug("task.claim_specific.none", { taskId, agentId });
      return null;
    }

    const contextPack = this._buildTaskContextPack(task);
    const claimGateState = this._updateGateStatus(task, "active", "Task claimed by worker.");
    const enrichedTask = team.taskList.update(task.id, {
      contextPack,
      gateState: claimGateState,
    }) ?? { ...task, contextPack, gateState: claimGateState };
    this._refreshFileConflicts();
    const finalTask = team.taskList.get(task.id) ?? enrichedTask;
    this.logTeamDebug("task.claim_specific", {
      agentId,
      task: summarizeTeamTask(finalTask),
    });

    // Emit both task_updated and team_state_changed so the renderer
    // sees the status transition from pending to in_progress.
    this._emitEvent({ type: "task_updated", teamName: team.name, task: finalTask });
    this._emitTeamStateChanged();

    const prompt = this._formatTaskPrompt(finalTask);

    return { task: finalTask, prompt };
  }

  private _formatTaskPrompt(task: TeamTask): string {
    const contextPack = task.contextPack ? this._formatTaskContextPack(task.contextPack) : "";
    return [
      `You have been assigned a new task (Task #${task.id.slice(0, 8)}):`,
      "",
      `**${task.subject}**`,
      "",
      task.description,
      ...(contextPack ? ["", contextPack] : []),
      "",
      "Complete this task as your current unit of work.",
      "If you need a decision, find a risk, or need another role, use send_team_message with kind question, objection, review_request, fix_request, blocked, handoff, or proposal.",
      "When you finish successfully, call mark_task_complete as your final action. Include a concise result plus structured evidence:",
      "- changedFiles: files or important paths you changed",
      "- completedScope: assigned scope items you believe are complete",
      "- missingScope: scope items not completed, uncertain, or intentionally deferred",
      "- verification: tests, commands, builds, or manual checks performed",
      "- risks: known risks, assumptions, fragile areas, or gaps",
      "- followUps: suggested next work, if any",
      "- confidence: low, medium, or high",
      "Be honest about missingScope and risks; the reviewer will compare your evidence with the repository state.",
      "If you are blocked or cannot complete it, call update_task_status with status \"blocked\" or \"failed\" and explain why.",
      "Do not just stop after writing a normal assistant response; the team workflow only advances when the task status is updated.",
    ].join("\n");
  }

  private _buildTaskContextPack(task: TeamTask): TeamTaskContextPack {
    const team = this._team;
    const dependencyEvidence = (team ? task.blockedBy.map((depId) => team.taskList.get(depId)).filter((dep): dep is TeamTask => Boolean(dep)) : [])
      .map((dep) => ({
        taskId: dep.id,
        subject: dep.subject,
        result: dep.result,
        evidence: dep.evidence,
      }));

    const parentTaskId = typeof task.metadata?.parentTaskId === "string" ? task.metadata.parentTaskId : undefined;
    const parentTask = parentTaskId && team ? team.taskList.get(parentTaskId) : undefined;
    const relatedTasks = team?.taskList.getAll().filter((candidate) =>
      candidate.id !== task.id &&
      (candidate.status === "completed" || candidate.status === "failed" || candidate.status === "blocked"),
    ) ?? [];

    const relevantRisks = mergeEvidenceItems(
      dependencyEvidence.flatMap((dep) => dep.evidence?.risks ?? []),
      [
        ...(parentTask?.evidence?.risks ?? []),
        ...relatedTasks.flatMap((candidate) => candidate.evidence?.risks ?? []),
      ],
    ).slice(0, 12);
    const touchedFiles = mergeEvidenceItems(
      dependencyEvidence.flatMap((dep) => dep.evidence?.changedFiles ?? []),
      [
        ...(parentTask?.evidence?.changedFiles ?? []),
        ...relatedTasks.flatMap((candidate) => candidate.evidence?.changedFiles ?? []),
      ],
    ).slice(0, 30);
    const openQuestions = mergeEvidenceItems(
      dependencyEvidence.flatMap((dep) => dep.evidence?.followUps ?? []),
      [
        ...(parentTask?.evidence?.followUps ?? []),
        ...relatedTasks.flatMap((candidate) => candidate.evidence?.followUps ?? []),
      ],
    ).slice(0, 12);

    return {
      taskId: task.id,
      generatedAt: Date.now(),
      objective: task.subject,
      assignedScope: task.description,
      dependencyEvidence,
      parentEvidence: parentTask ? {
        taskId: parentTask.id,
        subject: parentTask.subject,
        result: parentTask.result,
        evidence: parentTask.evidence,
      } : undefined,
      relevantRisks,
      touchedFiles,
      openQuestions,
      coordinationHints: this._buildTaskCoordinationHints(task),
    };
  }

  private _buildTaskCoordinationHints(task: TeamTask): string[] {
    switch (task.taskType) {
      case "implement":
      case "fix":
        return [
          "Treat the assigned scope as the acceptance contract; do not claim completion for unimplemented modules.",
          "Expect a separate reviewer to compare your evidence with the repository state.",
          "Report missingScope and risks explicitly when anything is incomplete or uncertain.",
        ];
      case "review":
      case "audit":
        return [
          "Audit completeness before style: compare assigned scope, worker evidence, and actual repository files.",
          "Look for promised files or modules that were not created, unwired entry points, placeholders, and skipped verification.",
          "State pass/fail clearly so the coordinator can decide whether to create a fix task.",
        ];
      case "test":
        return [
          "Prefer executable verification when possible and report exact commands and outcomes.",
          "If tests cannot run, explain the blocker and what evidence is still missing.",
        ];
      case "plan":
      case "research":
        return [
          "Produce decision-ready findings that other workers can act on without rereading the whole codebase.",
          "Call out unknowns, risks, and dependencies that should block implementation.",
        ];
      case "summarize":
        return [
          "Summarize accepted work, unresolved risks, and user-facing next steps.",
        ];
      default:
        return [
          "Keep the task boundary explicit and report uncertainty instead of assuming completion.",
        ];
    }
  }

  private _formatTaskContextPack(contextPack: TeamTaskContextPack): string {
    const lines = [
      "<task-context-pack>",
      `Objective: ${contextPack.objective}`,
      "",
      "Assigned scope:",
      contextPack.assignedScope,
    ];

    if (contextPack.parentEvidence) {
      lines.push(
        "",
        `Parent task: ${contextPack.parentEvidence.subject} (${contextPack.parentEvidence.taskId.slice(0, 8)})`,
        this._formatEvidenceBlock(contextPack.parentEvidence.evidence, contextPack.parentEvidence.result),
      );
    }

    if (contextPack.dependencyEvidence.length > 0) {
      lines.push("", "Dependency evidence:");
      for (const dep of contextPack.dependencyEvidence) {
        lines.push(`- ${dep.subject} (${dep.taskId.slice(0, 8)}): ${dep.evidence?.summary ?? dep.result ?? "No result reported."}`);
      }
    }

    lines.push(
      "",
      "Touched files from related work:",
      ...(contextPack.touchedFiles.length ? contextPack.touchedFiles.map((file) => `- ${file}`) : ["- (none reported)"]),
      "Known risks:",
      ...(contextPack.relevantRisks.length ? contextPack.relevantRisks.map((risk) => `- ${risk}`) : ["- (none reported)"]),
      "Open questions / follow-ups:",
      ...(contextPack.openQuestions.length ? contextPack.openQuestions.map((question) => `- ${question}`) : ["- (none reported)"]),
      "Coordination hints:",
      ...(contextPack.coordinationHints?.length ? contextPack.coordinationHints.map((hint) => `- ${hint}`) : ["- (none)"]),
      "</task-context-pack>",
    );

    return lines.join("\n");
  }

  private _formatEvidenceBlock(evidence?: TeamTaskEvidence, result?: string): string {
    if (!evidence) return result ?? "No evidence reported.";
    return [
      `Summary: ${evidence.summary}`,
      `Changed files: ${evidence.changedFiles.length ? evidence.changedFiles.join(", ") : "(none reported)"}`,
      `Missing scope: ${evidence.missingScope.length ? evidence.missingScope.join("; ") : "(none reported)"}`,
      `Verification: ${evidence.verification.length ? evidence.verification.join("; ") : "(none reported)"}`,
      `Risks: ${evidence.risks.length ? evidence.risks.join("; ") : "(none reported)"}`,
    ].join("\n");
  }

  private _createInitialGateState(taskType?: TeamTaskType, metadata?: Record<string, unknown>): TeamTaskGateState {
    const gateFromMetadata = metadata?.gate;
    const gate = gateFromMetadata === "review" ? "review" :
      gateFromMetadata === "fix" ? "fix" :
      taskType === "review" || taskType === "audit" ? "review" :
      taskType === "fix" ? "fix" :
      taskType === "test" ? "verification" :
      taskType === "implement" ? "implementation" :
      taskType === "summarize" ? "summary" :
      "none";
    return {
      gate,
      status: "waiting",
      parentTaskId: typeof metadata?.parentTaskId === "string" ? metadata.parentTaskId : undefined,
      updatedAt: Date.now(),
    };
  }

  private _updateGateStatus(task: TeamTask, status: TeamTaskGateState["status"], reason?: string): TeamTaskGateState {
    return {
      ...(task.gateState ?? this._createInitialGateState(task.taskType, task.metadata)),
      status,
      reason,
      updatedAt: Date.now(),
    };
  }

  private _completionGateState(task: TeamTask, result: string): TeamTaskGateState {
    const signal = classifyTeamResult(result);
    const status: TeamTaskGateState["status"] =
      task.taskType === "review" || task.taskType === "test" || task.taskType === "audit"
        ? (signal === "issues" ? "issues" : "passed")
        : "passed";
    return this._updateGateStatus(task, status, status === "issues" ? "Completion result reported issues." : "Task completed.");
  }

  private _createTaskHandoff(
    task: TeamTask,
    workerAgentId: string,
    result: string,
    evidence: TeamTaskEvidence,
  ): TeamTaskHandoffPacket {
    return {
      taskId: task.id,
      createdAt: Date.now(),
      workerAgentId,
      summary: evidence.summary || result,
      evidence,
      contextPack: task.contextPack,
    };
  }

  private _refreshFileConflicts(): void {
    const team = this._team;
    if (!team) return;

    const tasks = team.taskList.getAll().map((task) => ({ ...task, fileConflicts: [] as TeamTaskFileConflict[] }));
    const openStatuses = new Set<TeamTaskStatus>(["assigned", "in_progress"]);
    const fileMap = new Map<string, string[]>();

    for (const task of tasks) {
      if (!openStatuses.has(task.status)) continue;
      for (const file of this._taskTouchedFiles(task)) {
        const normalized = this._normalizeTaskFile(file);
        if (!normalized) continue;
        const owners = fileMap.get(normalized) ?? [];
        owners.push(task.id);
        fileMap.set(normalized, owners);
      }
    }

    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const [file, taskIds] of fileMap) {
      if (taskIds.length < 2) continue;
      for (const taskId of taskIds) {
        const task = byId.get(taskId);
        if (!task) continue;
        for (const otherId of taskIds) {
          if (otherId === taskId) continue;
          const other = byId.get(otherId);
          if (!other) continue;
          const existing = task.fileConflicts?.find((conflict) => conflict.withTaskId === otherId);
          if (existing) {
            if (!existing.files.includes(file)) existing.files.push(file);
          } else {
            task.fileConflicts = [
              ...(task.fileConflicts ?? []),
              {
                withTaskId: otherId,
                withSubject: other.subject,
                files: [file],
                severity: "warning",
                reason: "Concurrent open tasks reference the same touched file.",
              },
            ];
          }
        }
      }
    }

    team.taskList.setFileConflicts(new Map(tasks.map((task) => [task.id, task.fileConflicts ?? []])));
  }

  private _taskTouchedFiles(task: TeamTask): string[] {
    const metadataFiles = Array.isArray(task.metadata?.touchedFiles)
      ? task.metadata.touchedFiles.filter((file): file is string => typeof file === "string")
      : [];
    return mergeEvidenceItems(
      [
        ...(task.evidence?.changedFiles ?? []),
        ...(task.handoff?.evidence.changedFiles ?? []),
        ...(task.contextPack?.touchedFiles ?? []),
      ],
      metadataFiles,
    );
  }

  private _normalizeTaskFile(file: string): string {
    const trimmed = file.trim();
    if (!trimmed || trimmed.startsWith("(")) return "";
    return trimmed.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  }

  private _selectWorkerForTaskType(taskType: TeamTaskType): WorkerState | null {
    const team = this._team;
    if (!team) return null;

    const candidates = Array.from(team.workers.values()).filter((worker) => {
      if (worker.info.status === "shutdown" || worker.info.status === "error") return false;
      return ROLE_TASK_CAPABILITIES[worker.info.role]?.includes(taskType) ?? false;
    });
    return this._selectBestWorker(candidates);
  }

  private _selectWorkerForRole(role: TeammateRole): WorkerState | null {
    const team = this._team;
    if (!team) return null;

    const candidates = Array.from(team.workers.values()).filter((worker) => {
      if (worker.info.status === "shutdown" || worker.info.status === "error") return false;
      return worker.info.role === role;
    });
    return this._selectBestWorker(candidates);
  }

  private _selectBestWorker(candidates: WorkerState[]): WorkerState | null {
    if (candidates.length === 0) return null;

    const statusRank: Record<TeammateStatus, number> = {
      idle: 0,
      standby: 1,
      dormant: 2,
      running: 3,
      shutdown: 4,
      error: 5,
    };
    candidates.sort((a, b) => {
      const rank = statusRank[a.info.status] - statusRank[b.info.status];
      if (rank !== 0) return rank;
      return (a.info.lastActiveAt ?? 0) - (b.info.lastActiveAt ?? 0);
    });
    return candidates[0] ?? null;
  }

  // ==========================================================================
  // Protocol: Shutdown Negotiation
  // ==========================================================================

  /**
   * Request graceful shutdown for a specific worker (or all workers if no agentId).
   * Sends a shutdown message via the bus and waits for the worker to confirm.
   * Returns a promise that resolves to true if confirmed, false if rejected/timeout.
   */
  async requestShutdown(agentId?: string): Promise<{ agentId: string; confirmed: boolean }[]> {
    const team = this._team;
    this._assertRuntimeActive("request_shutdown");
    if (!team) throw new Error("No active team.");
    this.logTeamDebug("protocol.shutdown.request", { agentId });

    const targetIds = agentId
      ? [agentId]
      : Array.from(team.workers.keys()).filter((id) => {
          const w = team.workers.get(id);
          return w && w.info.status !== "shutdown" && w.info.status !== "error";
        });

    const results: { agentId: string; confirmed: boolean }[] = [];

    for (const targetId of targetIds) {
      const worker = team.workers.get(targetId);
      if (!worker || worker.info.status === "shutdown" || worker.info.status === "error") {
        results.push({ agentId: targetId, confirmed: false });
        continue;
      }
      if (worker.info.status === "dormant" || worker.info.status === "standby") {
        await this.stopWorker(targetId);
        results.push({ agentId: targetId, confirmed: true });
        this._emitEvent({
          type: "protocol_shutdown_response",
          teamName: team.name,
          agentId: targetId,
          confirmed: true,
          reason: "No active session",
        });
        continue;
      }

      // Create protocol request
      const { request, promise } = team.protocolManager.requestShutdown(targetId);
      this.logTeamDebug("protocol.shutdown.pending", { targetId, request });

      // Emit protocol event for UI
      this._emitEvent({
        type: "protocol_shutdown_request",
        teamName: team.name,
        agentId: targetId,
      });

      // Send shutdown message via bus
      const shutdownMsg: TeamMessage = {
        id: randomUUID(),
        teamName: team.name,
        fromAgentId: team.leadAgentId,
        toAgentId: targetId,
        text: "Graceful shutdown requested. Please finish your current work and confirm shutdown.",
        timestamp: Date.now(),
        read: false,
        delivered: false,
        summary: "Shutdown requested",
        kind: "shutdown",
        fromRole: "leader",
      };
      team.bus.send(shutdownMsg);
      this.logTeamDebug("protocol.shutdown.message_sent", {
        targetId,
        message: summarizeTeamMessage(shutdownMsg),
        busSize: team.bus.size(),
      });

      // Wait for response with timeout
      const timeoutController = new AbortController();
      type ShutdownRaceResult =
        | { type: "response"; confirmed: boolean }
        | { type: "timeout" };
      const responsePromise: Promise<ShutdownRaceResult> = promise.then((confirmed) => ({ type: "response", confirmed }));
      const timeoutPromise: Promise<ShutdownRaceResult> = sleep(SHUTDOWN_TIMEOUT_MS, timeoutController.signal)
        .then(() => ({ type: "timeout" }));
      const raceResult = await Promise.race([responsePromise, timeoutPromise]);
      timeoutController.abort(); // Clean up the sleep timer
      this.logTeamDebug("protocol.shutdown.race_result", { targetId, raceResult });

      // TOCTOU guard: if the timeout won the race but the real response arrived
      // between the race resolving and this check, the protocol entry will have
      // been responded to (state !== "pending"). Trust the real response in that case.
      const staleRequest = team.protocolManager.getShutdownStates().find((s) => s.agentId === targetId);
      const confirmed = (raceResult.type === "timeout" && staleRequest && staleRequest.state !== "pending")
        ? staleRequest.state === "confirmed"
        : raceResult.type === "response" && raceResult.confirmed;

      // Clean up stale protocol entry on timeout (the promise resolved via timeout,
      // but the protocol manager still holds the request and dangling resolve callback)
      if (!confirmed) {
        team.protocolManager.cancelShutdownRequest(targetId);
      }

      results.push({ agentId: targetId, confirmed });
      this.logTeamDebug("protocol.shutdown.completed", {
        targetId,
        confirmed,
        staleRequest,
      });

      // Emit response event
      this._emitEvent({
        type: "protocol_shutdown_response",
        teamName: team.name,
        agentId: targetId,
        confirmed,
        reason: request.reason,
      });

      // If confirmed, dispose the worker
      if (confirmed) {
        await this.stopWorker(targetId);
      }
    }

    return results;
  }

  /**
   * Worker responds to a shutdown request. Returns false when no request is
   * pending (e.g. it already timed out), so the caller can tell the model
   * the response had no effect.
   */
  respondShutdown(agentId: string, confirmed: boolean, reason?: string): boolean {
    const team = this._team;
    this._assertRuntimeActive("respond_to_shutdown");
    if (!team) throw new Error("No active team.");

    const request = team.protocolManager.respondShutdown(agentId, confirmed, reason);
    if (!request) {
      console.warn(`[TeamManager] No pending shutdown request for ${agentId}`);
      return false;
    }

    this._emitEvent({
      type: "protocol_shutdown_response",
      teamName: team.name,
      agentId,
      confirmed,
      reason,
    });
    return true;
  }

  // ==========================================================================
  // Protocol: Permission Requests
  // ==========================================================================

  /**
   * Worker requests permission for a tool operation.
   * Returns a promise that resolves when the user approves or rejects.
   */
  async requestPermission(
    agentId: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ approved: boolean; reason?: string }> {
    const team = this._team;
    this._assertRuntimeActive("request_permission");
    if (!team) throw new Error("No active team.");
    this.logTeamDebug("protocol.permission.request", {
      agentId,
      tool,
      args,
      signalAborted: signal?.aborted ?? false,
    });

    const { request, promise } = team.protocolManager.requestPermission(
      agentId,
      team.name,
      tool,
      args,
    );
    this.logTeamDebug("protocol.permission.pending", { request });

    // Emit protocol event for UI
    this._emitEvent({
      type: "protocol_permission_request",
      teamName: team.name,
      request,
    });

    // Also emit as a team_message for the timeline
    const timelineMsg: TeamMessage = {
      id: request.id,
      teamName: team.name,
      fromAgentId: agentId,
      toAgentId: team.leadAgentId,
      text: `Permission request: ${tool}(${JSON.stringify(args).slice(0, 200)})`,
      timestamp: request.createdAt,
      read: false,
      delivered: false,
      summary: `Permission requested: ${tool}`,
      kind: "permission_request",
      fromRole: team.workers.get(agentId)?.info.role ?? "leader",
    };
    this._emitEvent({ type: "team_message", teamName: team.name, message: timelineMsg });

    // Race: permission response vs timeout vs abort signal
    const timeoutController = new AbortController();
    const timeoutPromise = sleep(PROTOCOL_TIMEOUT_MS, timeoutController.signal).then(() => ({
      approved: false,
      reason: "Timed out waiting for permission",
    }));

    const abortPromise = signal
      ? new Promise<{ approved: boolean; reason?: string }>((resolve) => {
          if (signal.aborted) { resolve({ approved: false, reason: "Aborted" }); return; }
          signal.addEventListener("abort", () => {
            resolve({ approved: false, reason: "Aborted" });
          }, { once: true });
        })
      : null;

    const result = await Promise.race(
      [promise, timeoutPromise, abortPromise].filter(Boolean) as Promise<{ approved: boolean; reason?: string }>[],
    );
    timeoutController.abort(); // Clean up the sleep timer
    this.logTeamDebug("protocol.permission.result", {
      requestId: request.id,
      agentId,
      tool,
      result,
    });

    // Clean up stale protocol entry on timeout/abort
    if (!result.approved && (result.reason === "Timed out waiting for permission" || result.reason === "Aborted")) {
      team.protocolManager.cancelPermissionRequest(request.id);
      this.logTeamDebug("protocol.permission.cancelled", {
        requestId: request.id,
        reason: result.reason,
      });
    }

    return result;
  }

  /**
   * User responds to a permission request via the UI.
   */
  respondPermission(requestId: string, approved: boolean, reason?: string): void {
    const team = this._team;
    this._assertRuntimeActive("respond_permission");
    if (!team) throw new Error("No active team.");

    const request = team.protocolManager.respondPermission(requestId, approved, reason);
    if (!request) {
      console.warn(`[TeamManager] Permission request ${requestId} not found`);
      this.logTeamDebug("protocol.permission.respond_missing", { requestId, approved, reason });
      return;
    }
    this.logTeamDebug("protocol.permission.responded", { requestId, approved, reason, request });

    this._emitEvent({
      type: "protocol_permission_response",
      teamName: team.name,
      requestId,
      approved,
      reason,
    });

    // Timeline message
    const timelineMsg: TeamMessage = {
      id: randomUUID(),
      teamName: team.name,
      fromAgentId: team.leadAgentId,
      toAgentId: request.agentId,
      text: `Permission ${approved ? "approved" : "rejected"}: ${request.tool}${reason ? ` - ${reason}` : ""}`,
      timestamp: Date.now(),
      read: false,
      delivered: false,
      summary: `Permission ${approved ? "approved" : "rejected"}: ${request.tool}`,
      kind: "permission_response",
      fromRole: "leader",
    };
    this._emitEvent({ type: "team_message", teamName: team.name, message: timelineMsg });

  }

  // ==========================================================================
  // Protocol: Plan Approval
  // ==========================================================================

  /**
   * Worker submits a plan for Leader approval before executing.
   * Returns a promise that resolves when the Leader approves or rejects.
   */
  async requestPlanApproval(
    agentId: string,
    plan: string,
    files: string[],
    signal?: AbortSignal,
  ): Promise<{ approved: boolean; feedback?: string }> {
    const team = this._team;
    this._assertRuntimeActive("submit_plan");
    if (!team) throw new Error("No active team.");
    this.logTeamDebug("protocol.plan.request", {
      agentId,
      files,
      signalAborted: signal?.aborted ?? false,
      plan: summarizeText(plan),
    });

    const { approval, promise } = team.protocolManager.requestPlanApproval(
      agentId,
      team.name,
      plan,
      files,
    );
    this.logTeamDebug("protocol.plan.pending", { approval });

    const worker = team.workers.get(agentId);
    const workerName = worker?.info.name ?? agentId;
    const workerRole = worker?.info.role ?? "coder";

    // Timeline message visible to the user as team activity. The decision is
    // made by the Leader through respond_to_plan_approval, not by a worker
    // directly asking the user.
    const timelineMsg: TeamMessage = {
      id: approval.id,
      teamName: team.name,
      fromAgentId: agentId,
      toAgentId: team.leadAgentId,
      text: [
        `Worker ${workerName} submitted a plan for Leader review.`,
        "",
        plan,
        files.length ? `\nFiles: ${files.join(", ")}` : "",
      ].join("\n"),
      timestamp: approval.createdAt,
      read: false,
      delivered: false,
      summary: `Plan submitted for Leader review: ${plan.slice(0, 80)}`,
      kind: "plan_approval",
      fromRole: workerRole,
    };
    this._emitEvent({ type: "team_message", teamName: team.name, message: timelineMsg });
    this._wakeLeaderForOrchestration({
      type: "plan_submitted",
      sourceId: approval.id,
      runtimeEpoch: this._runtimeEpoch,
      workerName,
      workerRole,
      fromAgentId: agentId,
      toAgentId: team.leadAgentId,
      messageKind: "plan_approval",
      messageText: `Approval ID: ${approval.id}\nFiles: ${files.join(", ") || "none"}\n\n${plan}`,
    });

    // Race: approval response vs timeout vs abort signal
    const timeoutController = new AbortController();
    const timeoutPromise = sleep(PROTOCOL_TIMEOUT_MS, timeoutController.signal).then(() => ({
      approved: false,
      feedback: "Timed out waiting for plan approval",
    }));

    const abortPromise = signal
      ? new Promise<{ approved: boolean; feedback?: string }>((resolve) => {
          if (signal.aborted) { resolve({ approved: false, feedback: "Aborted" }); return; }
          signal.addEventListener("abort", () => {
            resolve({ approved: false, feedback: "Aborted" });
          }, { once: true });
        })
      : null;

    const result = await Promise.race(
      [promise, timeoutPromise, abortPromise].filter(Boolean) as Promise<{ approved: boolean; feedback?: string }>[],
    );
    timeoutController.abort(); // Clean up the sleep timer
    this.logTeamDebug("protocol.plan.result", {
      approvalId: approval.id,
      agentId,
      result,
    });

    // Clean up stale protocol entry on timeout/abort (the promise resolved via race,
    // but the protocol manager still holds the request and dangling resolve callback)
    if (!result.approved && (result.feedback === "Timed out waiting for plan approval" || result.feedback === "Aborted")) {
      team.protocolManager.cancelPlanApproval(approval.id);
      this.logTeamDebug("protocol.plan.cancelled", {
        approvalId: approval.id,
        reason: result.feedback,
      });
    }

    return result;
  }

  /**
   * User responds to a plan approval request.
   */
  respondPlanApproval(approvalId: string, approved: boolean, feedback?: string): boolean {
    const team = this._team;
    this._assertRuntimeActive("respond_to_plan_approval");
    if (!team) throw new Error("No active team.");

    const approval = team.protocolManager.respondPlanApproval(approvalId, approved, feedback);
    if (!approval) {
      console.warn(`[TeamManager] Plan approval ${approvalId} not found`);
      this.logTeamDebug("protocol.plan.respond_missing", { approvalId, approved, feedback });
      return false;
    }
    this.logTeamDebug("protocol.plan.responded", { approvalId, approved, feedback, approval });

    this._emitEvent({
      type: "protocol_plan_response",
      teamName: team.name,
      approvalId,
      approved,
      feedback,
    });

    // Timeline message
    const timelineMsg: TeamMessage = {
      id: randomUUID(),
      teamName: team.name,
      fromAgentId: team.leadAgentId,
      toAgentId: approval.agentId,
      text: `Plan ${approved ? "approved" : "rejected"}${feedback ? `: ${feedback}` : ""}`,
      timestamp: Date.now(),
      read: false,
      delivered: false,
      summary: `Plan ${approved ? "approved" : "rejected"}`,
      kind: "plan_approval",
      fromRole: "leader",
    };
    this._emitEvent({ type: "team_message", teamName: team.name, message: timelineMsg });

    return true;
  }

  // ==========================================================================
  // Worker Management
  // ==========================================================================

  /**
   * Bring a dormant or standby team member into active participation.
   * Existing active members are left untouched.
   */
  async activateMember(agentId: string): Promise<void> {
    const team = this._team;
    this._assertRuntimeActive("activate_member");
    if (!team) throw new Error("No active team.");

    const worker = team.workers.get(agentId);
    if (!worker) throw new Error(`Worker ${agentId} not found in team.`);
    if (worker.info.status === "error") throw new Error(`Worker ${agentId} is in error state. Restart it first.`);
    if (worker.info.status === "idle" || worker.info.status === "running") return;

    worker.info.status = "idle";
    worker.info.statusChangedAt = Date.now();
    worker.info.error = undefined;
    this._emitEvent({
      type: "teammate_status_changed",
      teamName: team.name,
      agentId,
      status: "idle",
      timestamp: worker.info.statusChangedAt,
    });
    this._emitTeamStateChanged();

    await this._launchWorker(agentId);
  }

  /**
   * Pause a member after its current turn. The member remains on the roster and
   * keeps message/task history, but its session is disposed until reactivated.
   */
  async pauseMember(agentId: string): Promise<void> {
    const team = this._team;
    this._assertRuntimeActive("pause_member");
    if (!team) throw new Error("No active team.");

    const worker = team.workers.get(agentId);
    if (!worker) throw new Error(`Worker ${agentId} not found in team.`);
    if (worker.info.status === "dormant" || worker.info.status === "standby") return;
    if (worker.info.status === "shutdown") throw new Error(`Worker ${agentId} has been shut down.`);

    if (worker.runner) {
      await worker.runner.dispose();
      worker.runner = null;
    } else {
      worker.lifecycleAbortController?.abort();
      worker.workAbortController?.abort();
      worker.unsubscribeEvents?.();
      if (worker.session) {
        await worker.session.dispose({ reason: "quit" }).catch(() => {});
      }
      if (worker.mcpAdapter) {
        await worker.mcpAdapter.dispose().catch(() => {});
      }
    }

    worker.session = null;
    worker.mcpAdapter = null;
    worker.lifecycleAbortController = null;
    worker.workAbortController = null;
    this._releaseWorkerOpenTasks(agentId, "worker was paused");
    worker.info.status = "standby";
    worker.info.statusChangedAt = Date.now();
    team.bus.clearAgent(agentId);

    this._emitEvent({
      type: "teammate_status_changed",
      teamName: team.name,
      agentId,
      status: "standby",
      timestamp: worker.info.statusChangedAt,
    });
    this._emitTeamStateChanged();
  }

  /**
   * Abort a specific worker's current turn (does not kill the worker).
   * After abort, the worker returns to idle and can receive new messages.
   */
  async abortWorker(agentId: string): Promise<void> {
    const team = this._team;
    this._assertRuntimeActive("abort_worker");
    if (!team) throw new Error("No active team.");

    const worker = team.workers.get(agentId);
    if (!worker) throw new Error(`Worker ${agentId} not found in team.`);
    if (worker.info.status !== "running") {
      console.warn(`[TeamManager] abortWorker called on non-running worker ${agentId} (status: ${worker.info.status})`);
    }

    // Abort the in-flight turn only. Do NOT release the worker's open tasks to
    // pending: the runtime stays active, so the worker would immediately
    // re-claim and re-execute the turn the user just stopped. The worker's
    // work_aborted path calls handleWorkerTurnFailed, which marks the active
    // task blocked and wakes the leader to decide whether to reassign; tasks
    // the worker already resolved during the turn are left untouched.
    team.bus.clearAgent(agentId);
    if (worker.runner) {
      await worker.runner.abortCurrentTurn();
    } else {
      worker.workAbortController?.abort();
    }

  }

  /**
   * Stop a specific worker (graceful shutdown).
   * The worker will be disposed and enter "shutdown" status.
   */
  async stopWorker(agentId: string): Promise<void> {
    const team = this._team;
    this._assertRuntimeActive("stop_worker");
    if (!team) throw new Error("No active team.");

    const worker = team.workers.get(agentId);
    if (!worker) throw new Error(`Worker ${agentId} not found in team.`);
    if (worker.info.status === "shutdown") {
      console.warn(`[TeamManager] stopWorker called on already-shutdown worker ${agentId}`);
      return;
    }

    if (worker.runner) {
      await worker.runner.dispose();
      worker.runner = null;
    } else {
      worker.lifecycleAbortController?.abort();
      worker.workAbortController?.abort();
      worker.unsubscribeEvents?.();
      if (worker.session) {
        await worker.session.dispose({ reason: "quit" }).catch(() => {});
      }
      if (worker.mcpAdapter) {
        await worker.mcpAdapter.dispose().catch(() => {});
      }
    }

    worker.session = null;
    worker.mcpAdapter = null;
    worker.lifecycleAbortController = null;
    worker.workAbortController = null;
    this._releaseWorkerOpenTasks(agentId, "worker was stopped");
    worker.info.status = "shutdown";
    worker.info.statusChangedAt = Date.now();

    // Clean up the worker's message bus entries to prevent memory leaks
    team.bus.clearAgent(agentId);

    this._emitEvent({
      type: "teammate_status_changed",
      teamName: team.name,
      agentId,
      status: "shutdown",
      timestamp: worker.info.statusChangedAt,
    });
    this._emitTeamStateChanged();

  }

  /**
   * Update a worker's status and emit a status change event.
   */
  updateWorkerStatus(agentId: string, status: TeammateStatus, error?: string): void {
    const team = this._team;
    if (!team) return;

    const worker = team.workers.get(agentId);
    if (!worker) return;

    const previousStatus = worker.info.status;
    worker.info.status = status;
    worker.info.statusChangedAt = Date.now();
    if (error !== undefined) {
      worker.info.error = error;
    } else if (status !== "error") {
      worker.info.error = undefined;
    }

    if (status === "error" || status === "shutdown") {
      this._releaseWorkerOpenTasks(agentId, error ?? `worker status changed to ${status}`);
    }
    this.logTeamDebug("worker.status.changed", {
      agentId,
      previousStatus,
      status,
      error,
      worker: worker.info,
    });

    this._emitEvent({
      type: "teammate_status_changed",
      teamName: team.name,
      agentId,
      status,
      error,
      timestamp: worker.info.statusChangedAt,
    });
    this._emitTeamStateChanged();
  }

  /**
   * Emit a teammate message event (called by WorkerRunner).
   */
  emitTeammateMessage(agentId: string, message: TeammateChatMessage): void {
    const team = this._team;
    if (!team) return;

    this._emitEvent({
      type: "teammate_message",
      teamName: team.name,
      agentId,
      message,
    });
  }

  private _isCurrentWorkerTurn(agentId: string, turnEpoch: number, turnId?: string): boolean {
    const worker = this._team?.workers.get(agentId);
    return this.isRuntimeEpochCurrent(turnEpoch) && (!turnId || worker?.activeTurnId === turnId);
  }

  /**
   * Called after a worker turn finishes. If the worker forgot to call the
   * task-status tool, close its current task using the final assistant text so
   * the leader workflow does not stall with everyone idle.
   */
  handleWorkerTurnFinished(
    agentId: string,
    assistantText?: string,
    taskId?: string | null,
    turnEpoch = this._runtimeEpoch,
    turnId?: string,
  ): void {
    const team = this._team;
    if (!team || team.status !== "active") {
      this.logTeamDebug("worker.turn_finished.skipped", { agentId, reason: "no_active_team" });
      return;
    }
    if (!this._isCurrentWorkerTurn(agentId, turnEpoch, turnId)) {
      this.logTeamDebug("worker.turn_finished.stale", {
        agentId,
        taskId: taskId ?? null,
        turnId,
        turnEpoch,
        currentRuntimeEpoch: this._runtimeEpoch,
      });
      return;
    }

    // Resolve the task this turn was actually executing. Keying off the turn's
    // own taskId (rather than "any in_progress task owned by the agent") means a
    // message-driven turn cannot be mis-attributed to an unrelated task.
    const turnTask = taskId ? team.taskList.get(taskId) : undefined;
    const activeTask = turnTask && turnTask.ownerAgentId === agentId && turnTask.status === "in_progress"
      ? turnTask
      : undefined;

    if (!activeTask) {
      // taskId given but no longer in_progress: the worker already resolved it
      // during the turn (mark_task_complete / update_task_status), which already
      // woke the leader. Stay silent to avoid double-handling.
      if (taskId && turnTask) {
        this.logTeamDebug("worker.turn_finished.task_already_resolved", {
          agentId,
          taskId,
          status: turnTask.status,
        });
        return;
      }
      // No task at all is a normal outcome for a peer-message turn. The message
      // send path already wakes the Leader when the message is actionable, so a
      // turn that already delivered a worker->leader message must not wake again
      // (that would duplicate the content and feedback-loop ordinary peer
      // conversation). A turn that produced output WITHOUT reaching the leader,
      // however, deadlocks an idle leader that never learns the work happened -
      // surface it as an orphaned turn so the leader can record, route, or fold
      // it into the plan.
      const workerState = team.workers.get(agentId);
      if (!workerState?.sentLeaderMessageThisTurn) {
        this._reportOrphanedWorkerTurn(agentId, assistantText, false, turnId);
      } else {
        this.logTeamDebug("worker.turn_finished.no_active_task", {
          agentId,
          taskId: taskId ?? null,
          assistantText: summarizeText(assistantText),
          alreadyWokeLeader: true,
        });
      }
      return;
    }

    const workerInfo = team.workers.get(agentId)?.info;
    const workerName = workerInfo?.name ?? parseAgentId(agentId)?.agentName ?? agentId;
    const workerRole = workerInfo?.role ?? "coder";
    const result = assistantText?.trim()
      ? assistantText.trim().slice(0, MAX_AUTO_COMPLETION_RESULT_LENGTH)
      : "Worker turn finished without a textual summary.";
    const evidence = mergeTeamTaskEvidence(result);

    const outcome = classifyWorkerTurnOutcome(result);
    this.logTeamDebug("worker.turn_finished", {
      agentId,
      workerName,
      workerRole,
      task: summarizeTeamTask(activeTask),
      outcome,
      result: summarizeText(result),
    });
    if (outcome !== "complete") {
      const reason = outcome === "blocked"
        ? "Worker turn ended with a blocking or incomplete signal."
        : "Worker turn ended without an explicit completion signal.";
      const blockedTask = this.updateTask(activeTask.id, {
        status: "blocked",
        result,
        evidence,
        gateState: this._updateGateStatus(activeTask, "blocked", reason),
      });
      this._wakeLeaderForOrchestration({
        type: "task_blocked",
        sourceId: `${activeTask.id}:blocked`,
        runtimeEpoch: turnEpoch,
        taskId: blockedTask.id,
        taskSubject: blockedTask.subject,
        taskType: blockedTask.taskType,
        workerName,
        workerRole,
        result: `${reason}\n\nWorker output:\n${result}`,
      });
      return;
    }

    const handoff = this._createTaskHandoff(activeTask, agentId, result, evidence);

    const completedTask = this.updateTask(activeTask.id, {
      status: "completed",
      result,
      evidence,
      handoff,
      gateState: this._completionGateState(activeTask, result),
    });
    this._emitWorkerCompletionSummary(agentId, completedTask, workerName, workerRole, result);
    this._coordinateAfterTaskCompletion(completedTask, agentId, result);
  }

  handleWorkerTurnFailed(
    agentId: string,
    error: string,
    taskId?: string | null,
    turnEpoch = this._runtimeEpoch,
    turnId?: string,
  ): void {
    const team = this._team;
    if (!team || team.status !== "active") {
      this.logTeamDebug("worker.turn_failed.skipped", { agentId, error, reason: "no_active_team" });
      return;
    }
    if (!this._isCurrentWorkerTurn(agentId, turnEpoch, turnId)) {
      this.logTeamDebug("worker.turn_failed.stale", {
        agentId,
        taskId: taskId ?? null,
        turnId,
        turnEpoch,
        currentRuntimeEpoch: this._runtimeEpoch,
      });
      return;
    }

    const turnTask = taskId ? team.taskList.get(taskId) : undefined;
    const activeTask = turnTask && turnTask.ownerAgentId === agentId && turnTask.status === "in_progress"
      ? turnTask
      : undefined;

    if (!activeTask) {
      // Task already resolved during the turn: the resolving tool already woke
      // the leader; do not double-report the interruption.
      if (taskId && turnTask) {
        this.logTeamDebug("worker.turn_failed.task_already_resolved", {
          agentId,
          taskId,
          status: turnTask.status,
          error,
        });
        return;
      }
      // A failure of a message-only turn (timeout, abort, thrown error) is not
      // task progress, but it can still stall an idle leader that never learns
      // the turn did not complete. Surface it as an orphaned failure so the
      // leader can react; the originating message path carries intent, not the
      // failure outcome.
      this._reportOrphanedWorkerTurn(agentId, error, true, turnId);
      return;
    }

    const workerInfo = team.workers.get(agentId)?.info;
    const workerName = workerInfo?.name ?? parseAgentId(agentId)?.agentName ?? agentId;
    const workerRole = workerInfo?.role ?? "coder";
    const result = `Worker turn failed before completion: ${error || "unknown error"}`.slice(0, MAX_AUTO_COMPLETION_RESULT_LENGTH);
    this.logTeamDebug("worker.turn_failed", {
      agentId,
      workerName,
      workerRole,
      task: summarizeTeamTask(activeTask),
      error,
    });
    const blockedTask = this.updateTask(activeTask.id, {
      status: "blocked",
      result,
      gateState: this._updateGateStatus(activeTask, "blocked", "Worker turn failed before completion."),
    });
    this._wakeLeaderForOrchestration({
      type: "task_blocked",
      sourceId: `${activeTask.id}:failed`,
      runtimeEpoch: turnEpoch,
      taskId: blockedTask.id,
      taskSubject: blockedTask.subject,
      taskType: blockedTask.taskType,
      workerName,
      workerRole,
      result,
    });
  }

  /**
   * Surface a worker turn that finished/failed without being tied to a task.
   *
   * Workers can run substantial turns driven by a plain message (or the initial
   * prompt) rather than a claimed task. Those turns bypass the task lifecycle, so
   * their completion never reaches the leader through task_completed/task_blocked.
   * Without this, the leader (already idle) is never re-engaged and the team
   * deadlocks — exactly the "leader and worker both stop" stall. We wake the
   * leader with a team_message event carrying the worker's latest output so it
   * can record, route, or fold the work into the plan.
   */
  private _reportOrphanedWorkerTurn(agentId: string, text: string | undefined, failed: boolean, turnId?: string): void {
    const team = this._team;
    if (!team || team.status !== "active") return;

    const workerInfo = team.workers.get(agentId)?.info;
    const workerName = workerInfo?.name ?? parseAgentId(agentId)?.agentName ?? agentId;
    const workerRole = workerInfo?.role ?? "coder";
    const trimmed = text?.trim();

    // A finished turn with no output is not actionable; skip it to avoid waking
    // the leader for nothing. Failures are always reported so a silent
    // timeout/abort on a non-task turn cannot vanish.
    if (!failed && !trimmed) {
      this.logTeamDebug("worker.orphaned_turn.skipped_empty", { agentId });
      return;
    }

    const detail = (trimmed ?? "(no textual output)").slice(0, MAX_AUTO_COMPLETION_RESULT_LENGTH);
    const messageText = failed
      ? `${workerName} (${workerRole}) ended a turn that was not tied to any task after an interruption or failure. Latest output:\n${detail}`
      : `${workerName} (${workerRole}) finished a turn that ran from a direct message rather than a task assignment, so it is not tracked as task progress. Decide whether this work needs a tracked task, review, follow-up, or can be folded into the plan. Latest output:\n${detail}`;

    this.logTeamDebug("worker.orphaned_turn.wake_leader", {
      agentId,
      failed,
      text: summarizeText(detail),
    });
    this._wakeLeaderForOrchestration({
      type: "team_message",
      sourceId: `orphan:${turnId ?? randomUUID()}`,
      fromAgentId: agentId,
      workerName,
      workerRole,
      messageText,
      result: failed
        ? "Worker turn ended outside task tracking after a failure."
        : "Worker produced output outside task tracking.",
    });
  }

  /**
   * Queue a worker->leader message that could not be delivered because the
   * runtime epoch changed (abort paused the runtime). resumeRuntime drains the
   * list so the message is not permanently lost.
   */
  private _deferLeaderMessage(message: TeamMessage): void {
    // No active team: the message belongs to a team that was stopped. Deferring
    // it would leak a stale worker->leader message into the next team created in
    // this manager (createTeam does not clear _deferredLeaderMessages).
    if (!this._team) return;
    if (this._deferredLeaderMessages.some((m) => m.id === message.id)) return;
    this._deferredLeaderMessages.push(message);
    this.logTeamDebug("leader.deferred_message.queued", {
      messageId: message.id,
      count: this._deferredLeaderMessages.length,
    });
  }

  /**
   * Re-engage the leader after the runtime resumes from a pause. Work paused by
   * an abort (in-progress tasks whose owner is no longer running) or restored
   * from a snapshot (blocked/failed tasks) has no event-driven wake of its own:
   * workers cannot re-claim in_progress tasks they own, and the stall heartbeat
   * does not cover blocked/failed tasks. Wake the leader once per resume so it
   * decides whether to resume, reassign, or finalize - rather than silently
   * restarting or stranding the work. Also flush messages/events deferred
   * during the pause.
   */
  private _reengageLeaderAfterResume(team: TeamData): void {
    const blockedOrFailed = team.taskList.getAll().filter((task) =>
      task.status === "blocked" || task.status === "failed",
    );
    const staleInProgress = team.taskList.getAll("in_progress").filter((task) => {
      const owner = task.ownerAgentId ? team.workers.get(task.ownerAgentId) : undefined;
      return !owner || owner.info.status !== "running";
    });

    if (blockedOrFailed.length > 0 || staleInProgress.length > 0) {
      this._wakeLeaderForOrchestration({
        type: "team_message",
        sourceId: `resume:${blockedOrFailed.map((t) => t.id).join(",")}:${staleInProgress.map((t) => t.id).join(",")}`,
        runtimeEpoch: this._runtimeEpoch,
        messageText:
          "Team runtime resumed after being paused. The following work was in flight and needs a decision: " +
          `${blockedOrFailed.length} blocked/failed task(s) and ${staleInProgress.length} in-progress task(s) with no active worker. ` +
          "Review the task list and decide whether to resume, reassign, split, or finalize each item; do not silently restart interrupted work.",
        result: "Resumed after pause with in-flight work requiring a leader decision.",
      });
    }

    if (this._deferredLeaderMessages.length > 0) {
      const deferred = this._deferredLeaderMessages;
      this._deferredLeaderMessages = [];
      this.logTeamDebug("leader.deferred_messages.redelivered", { count: deferred.length });
      for (const msg of deferred) {
        this._wakeLeaderForMessage(msg);
      }
    }

    if (this._orchestratorEvents.hasPending) {
      this._scheduleOrchestratorQueue();
    }
  }

  private _releaseWorkerOpenTasks(agentId: string, reason: string): TeamTask[] {
    const team = this._team;
    if (!team || team.status !== "active") return [];

    const workerInfo = team.workers.get(agentId)?.info;
    const workerName = workerInfo?.name ?? parseAgentId(agentId)?.agentName ?? agentId;
    const workerRole = workerInfo?.role ?? "coder";
    const releaseResult = `Released from ${workerName}: ${reason}`;
    const released = team.taskList
      .releaseOwnedOpenTasks(agentId, releaseResult)
      .map((task) => this.updateTask(task.id, {
        gateState: this._updateGateStatus(task, "waiting", reason),
      }));

    for (const event of buildWorkerUnavailableOrchestrationEvents({
      releasedTasks: released,
      workerName,
      workerRole,
      reason,
    })) {
      this._wakeLeaderForOrchestration({
        ...event,
        sourceId: `${event.taskId ?? agentId}:released`,
        runtimeEpoch: this._runtimeEpoch,
      });
    }

    return released;
  }

  private _emitWorkerCompletionSummary(
    agentId: string,
    task: TeamTask,
    workerName: string,
    workerRole: TeammateRole,
    result: string,
  ): void {
    const team = this._team;
    if (!team) return;

    const summaryText = [
      `<worker-summary agent="${workerName}" role="${workerRole}" taskId="${task.id}">`,
      `**${workerName}** completed task **${task.subject}**`,
      "",
      `Result: ${result}`,
      ...(task.evidence ? ["", "Evidence:"] : []),
      ...(task.evidence ? this._formatTaskEvidenceForPrompt(task, result).split("\n") : []),
      `</worker-summary>`,
    ].join("\n");

    this._emitEvent({
      type: "worker_summary",
      teamName: team.name,
      fromAgentId: agentId,
      summary: summaryText,
      taskId: task.id,
    });
  }

  private _coordinateAfterTaskCompletion(task: TeamTask, agentId: string, result: string): void {
    const team = this._team;
    if (!team || team.status !== "active") return;

    const workerInfo = team.workers.get(agentId)?.info;
    const workerName = workerInfo?.name ?? parseAgentId(agentId)?.agentName ?? agentId;
    const workerRole = workerInfo?.role ?? "coder";
    const policy = this._coordinationPolicyForTask(task, result);
    const followUps = this._createCoordinatorFollowUps(task, result);
    const followUpSummary = followUps.length > 0
      ? [
        "",
        "Coordinator-created follow-up tasks:",
        ...followUps.map((followUp) => `- ${followUp.subject} (${followUp.id.slice(0, 8)}) [${followUp.taskType ?? "general"}]`),
      ].join("\n")
      : "";

    this._wakeLeaderForOrchestration({
      type: "task_completed",
      sourceId: `${task.id}:completed`,
      runtimeEpoch: this._runtimeEpoch,
      taskId: task.id,
      taskSubject: task.subject,
      taskType: task.taskType,
      workerName,
      workerRole,
      result: `${result}\n\nCoordination decision: ${policy.leaderInstruction}${followUpSummary}`,
    });
    this._scheduleWorkerContextHygiene(agentId, task);
  }

  private _coordinationPolicyForTask(task: TeamTask, result: string): TeamCoordinationPolicy {
    return planTeamCoordination({ taskType: task.taskType, result }, {
      hasReviewChild: this._hasCoordinatorChild(task.id, "review"),
      hasFixChild: this._hasCoordinatorChild(task.id, "fix"),
    });
  }

  private _createCoordinatorFollowUps(task: TeamTask, result: string): TeamTask[] {
    const team = this._team;
    if (!team || team.status !== "active") return [];

    const followUps: TeamTask[] = [];
    const policy = this._coordinationPolicyForTask(task, result);
    const generation = this._coordinationGeneration(task);
    const rootTaskId = this._coordinationRootTaskId(task);
    const canCreateFollowUp = generation < MAX_COORDINATION_GENERATION;

    if (!canCreateFollowUp && (policy.needsReview || policy.needsFix)) {
      this.logTeamDebug("coordination.followup.limit_reached", {
        taskId: task.id,
        rootTaskId,
        generation,
        maxGeneration: MAX_COORDINATION_GENERATION,
        signal: policy.signal,
      });
    }

    if (policy.needsReview && canCreateFollowUp) {
      const evidenceText = this._formatTaskEvidenceForPrompt(task, result);
      const handoffText = this._formatTaskHandoffForPrompt(task, result);
      followUps.push(this.createTask(
        `Review: ${task.subject}`,
        [
          `Review the completed ${task.taskType} task: ${task.subject}.`,
          "",
          "Audit completeness before style: compare the assigned scope, the worker's claimed result, and the actual repository state.",
          "Look specifically for missing modules, files that were promised but not created, unwired entry points, placeholder code, skipped tests, and unsupported completion claims.",
          "Then check correctness, integration risks, missing tests, and file-level issues.",
          "Report pass/fail clearly. If issues exist, include specific files, missing scope, and actionable fix guidance.",
          "",
          "Assigned scope:",
          task.description,
          "",
          "Handoff packet:",
          handoffText,
          "",
          "Worker evidence ledger:",
          evidenceText,
        ].join("\n"),
        undefined,
        [],
        "review",
        {
          generatedBy: "coordinator",
          parentTaskId: task.id,
          rootTaskId,
          coordinationGeneration: generation + 1,
          gate: "review",
        },
      ));
    }

    if (policy.needsFix && canCreateFollowUp) {
      followUps.push(this.createTask(
        `Fix: ${task.subject}`,
        [
          `Address the issues found by the ${task.taskType} task: ${task.subject}.`,
          "",
          "Make the smallest safe code changes needed, then summarize exactly what changed.",
          "",
          `Review/test result:\n${result}`,
        ].join("\n"),
        undefined,
        [],
        "fix",
        {
          generatedBy: "coordinator",
          parentTaskId: task.id,
          rootTaskId,
          coordinationGeneration: generation + 1,
          gate: "fix",
        },
      ));
    }

    return followUps;
  }

  private _coordinationGeneration(task: TeamTask): number {
    const value = task.metadata?.coordinationGeneration;
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : 0;
  }

  private _coordinationRootTaskId(task: TeamTask): string {
    const rootTaskId = task.metadata?.rootTaskId;
    if (typeof rootTaskId === "string" && rootTaskId) return rootTaskId;
    return task.id;
  }

  private _hasCoordinatorChild(parentTaskId: string, gate: "review" | "fix"): boolean {
    const team = this._team;
    if (!team) return false;

    return team.taskList.getAll().some((task) =>
      task.metadata?.generatedBy === "coordinator" &&
      task.metadata?.parentTaskId === parentTaskId &&
      task.metadata?.gate === gate &&
      task.status !== "cancelled",
    );
  }

  private _formatTaskEvidenceForPrompt(task: TeamTask, fallbackResult: string): string {
    const evidence = task.evidence ?? mergeTeamTaskEvidence(fallbackResult);
    const lines = [
      `Summary: ${evidence.summary || fallbackResult}`,
      `Changed files: ${evidence.changedFiles.length ? evidence.changedFiles.join(", ") : "(none reported)"}`,
      "Completed scope:",
      ...(evidence.completedScope.length ? evidence.completedScope.map((item) => `- ${item}`) : ["- (none reported)"]),
      "Missing scope:",
      ...(evidence.missingScope.length ? evidence.missingScope.map((item) => `- ${item}`) : ["- (none reported)"]),
      "Verification:",
      ...(evidence.verification.length ? evidence.verification.map((item) => `- ${item}`) : ["- (none reported)"]),
      "Risks:",
      ...(evidence.risks.length ? evidence.risks.map((item) => `- ${item}`) : ["- (none reported)"]),
      "Follow-ups:",
      ...(evidence.followUps.length ? evidence.followUps.map((item) => `- ${item}`) : ["- (none reported)"]),
    ];
    if (evidence.confidence) lines.push(`Confidence: ${evidence.confidence}`);
    return lines.join("\n");
  }

  private _formatTaskHandoffForPrompt(task: TeamTask, fallbackResult: string): string {
    const handoff = task.handoff ?? this._createTaskHandoff(
      task,
      task.ownerAgentId ?? "unknown",
      fallbackResult,
      task.evidence ?? mergeTeamTaskEvidence(fallbackResult),
    );
    return [
      `Task: ${task.subject} (${handoff.taskId.slice(0, 8)})`,
      `Worker: ${handoff.workerAgentId ?? "unknown"}`,
      `Summary: ${handoff.summary}`,
      `Context pack generated: ${handoff.contextPack ? new Date(handoff.contextPack.generatedAt).toISOString() : "none"}`,
      `Gate: ${task.gateState?.gate ?? "none"} / ${task.gateState?.status ?? "unknown"}`,
    ].join("\n");
  }

  private _scheduleWorkerContextHygiene(agentId: string, completedTask: TeamTask, attempt = 0): void {
    const team = this._team;
    const worker = team?.workers.get(agentId);
    if (!team || !worker?.session) return;

    const delayMs = attempt === 0 ? 2_500 : 8_000;
    const timer = setTimeout(() => {
      this._hygieneTimers.delete(timer);
      const currentTeam = this._team;
      const currentWorker = currentTeam?.workers.get(agentId);
      const session = currentWorker?.session;
      if (!currentTeam || !currentWorker || !session) return;
      if (currentWorker.info.status === "shutdown" || currentWorker.info.status === "error") return;

      const workerBusy = currentWorker.info.status === "running" || session.isStreaming || session.isCompacting;
      if (workerBusy) {
        if (attempt < 1) this._scheduleWorkerContextHygiene(agentId, completedTask, attempt + 1);
        return;
      }

      const readyForWorker = currentTeam.taskList.getReadyTasks(currentWorker.info.role)
        .some((task) => !task.ownerAgentId || task.ownerAgentId === agentId);
      if (readyForWorker) return;

      const instructions = [
        "Compact this teammate session after completing a team task.",
        "Preserve the teammate identity, role, team name, and active project facts.",
        "Preserve only durable engineering facts, the latest task handoff, changed files, completed scope, missing scope, verification, risks, and follow-ups.",
        "Drop transient tool logs, repetitive status chatter, and resolved discussion details.",
        "",
        "Latest task handoff:",
        this._formatTaskHandoffForPrompt(completedTask, completedTask.result ?? ""),
        "",
        this._formatTaskEvidenceForPrompt(completedTask, completedTask.result ?? ""),
      ].join("\n");

      void session.compact(instructions).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Nothing to compact") && !msg.includes("Already compacted")) {
          console.warn(`[TeamManager] Context hygiene compaction failed for ${agentId}:`, err);
        }
      });
    }, delayMs);
    this._hygieneTimers.add(timer);
  }

  /** Cancel all pending worker-context-hygiene timers (team stop / dispose). */
  private _clearHygieneTimers(): void {
    for (const timer of this._hygieneTimers) {
      clearTimeout(timer);
    }
    this._hygieneTimers.clear();
  }

  /** Cancel all pending leader-steer retry timers (team stop / dispose). */
  private _clearSteerRetryTimers(): void {
    for (const timer of this._steerRetryTimers) {
      clearTimeout(timer);
    }
    this._steerRetryTimers.clear();
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  /** Dispose all resources. Called on app quit. */
  async dispose(): Promise<void> {
    this._stopHealthCheck();
    if (this._team) {
      try {
        // Preserve the snapshot: app quit / shutdown should allow restore on reopen.
        await this.stopTeam({ deleteSnapshot: false });
      } catch (err) {
        console.error("[TeamManager] Error during dispose:", err);
      }
    }
    this._leaderSession = null;
    this._setLeaderTurnActive(false);
    this._orchestratorEvents.clear();
    this._leaderWakeInFlight = false;
    this._deferredLeaderMessages = [];
    this._clearHygieneTimers();
    this._clearSteerRetryTimers();
    if (this._orchestratorRetryTimer) {
      clearTimeout(this._orchestratorRetryTimer);
      this._orchestratorRetryTimer = null;
      this._orchestratorRetryDueAt = 0;
    }
    this._eventCallbacks.length = 0;
  }

  // ==========================================================================
  // Health Check & Cleanup
  // ==========================================================================

  /** Start periodic health check for failed workers. */
  private _startHealthCheck(): void {
    if (this._healthCheckInterval) return;
    this._healthCheckInterval = setInterval(() => {
      this._checkWorkerHealth();
    }, 30_000); // Check every 30 seconds
  }

  /** Stop periodic health check. */
  private _stopHealthCheck(): void {
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }
  }

  /** Check worker health and auto-recover stuck workers. */
  private _checkWorkerHealth(): void {
    const team = this._team;
    if (!team || !this.isRuntimeActive()) return;

    // Prune fully-delivered broadcasts to prevent unbounded memory growth
    const activeAgentIds = Array.from(team.workers.entries())
      .filter(([, worker]) => worker.info.status === "idle" || worker.info.status === "running")
      .map(([agentId]) => agentId);
    const prunedBroadcasts = team.bus.pruneBroadcasts(activeAgentIds);
    this.logTeamDebug("health_check", {
      activeAgentIds,
      prunedBroadcasts,
      busSize: team.bus.size(),
      workers: Array.from(team.workers.values()).map((worker) => worker.info),
    });

    const now = Date.now();
    for (const [agentId, worker] of team.workers) {
      // Check for workers stuck in error state
      if (worker.info.status === "error") {
        const errorDuration = now - worker.info.statusChangedAt;
        if (errorDuration > 300_000) { // 5 minutes
          console.warn(`[TeamManager] Worker ${agentId} has been in error state for ${Math.floor(errorDuration / 60_000)} minutes, restarting`);
          this.logTeamDebug("health_check.worker_restart", { agentId, errorDuration });
          void this.restartWorker(agentId).catch((err) => {
            console.error(`[TeamManager] Error restarting stuck worker ${agentId}:`, err);
            this.logTeamDebug("health_check.worker_restart.error", { agentId, error: err });
          });
        }
      }

      // Check for workers that haven't been active for a long time (stuck on tool call)
      if (worker.info.status === "running" && worker.info.lastActiveAt) {
        const inactiveDuration = now - worker.info.lastActiveAt;
        if (inactiveDuration > WORKER_STUCK_TURN_TIMEOUT_MS) {
          console.warn(`[TeamManager] Worker ${agentId} has been inactive for ${Math.floor(inactiveDuration / 60_000)} minutes, aborting stuck turn`);
          this.logTeamDebug("health_check.worker_abort_stuck_turn", {
            agentId,
            inactiveDuration,
            timeoutMs: WORKER_STUCK_TURN_TIMEOUT_MS,
          });
          // Abort the stuck turn to unblock any pending protocol requests
          worker.runner?.abortCurrentTurn();
        }
      }
    }

    // Orchestration safety-net: catch a silently-stalled team that the
    // event-driven wakes missed.
    this._maybeRecoverOrchestrationStall();
  }

  /**
   * Detect and recover an orchestration stall.
   *
   * The leader is woken purely by events. If every wake path misses (e.g. a
   * worker's output never reached the task system and no wake-eligible message
   * was sent), an idle leader can sit forever while runnable work is stranded.
   * This heartbeat — driven by the 30s health check — nudges the leader when:
   *   - the leader is fully idle (no active turn, no wake in flight, empty queue,
   *     not streaming), AND
   *   - no worker is currently executing, AND
   *   - there is runnable work: a ready task nobody picked up, or an in_progress
   *     task whose owner is not actually running.
   * It is throttled so a leader legitimately waiting on the user is not spammed.
   */
  private _maybeRecoverOrchestrationStall(): void {
    const team = this._team;
    if (!team || !this.isRuntimeActive()) return;
    const leaderSession = this._leaderSession;
    if (!leaderSession) return;

    // Leader must be fully idle, or there is no stall to recover.
    if (this._leaderTurnActive || this._leaderWakeInFlight) return;
    if (this._orchestratorEvents.hasPending) return;
    if (leaderSession.isStreaming) return;

    // If any worker is executing, progress is still happening.
    const anyWorkerRunning = Array.from(team.workers.values())
      .some((worker) => worker.info.status === "running");
    if (anyWorkerRunning) return;

    // Is there work that should be moving but isn't?
    const readyTasks = team.taskList.getReadyTasks();
    const stuckInProgress = team.taskList.getAll("in_progress").filter((task) => {
      const owner = task.ownerAgentId ? team.workers.get(task.ownerAgentId) : undefined;
      return !owner || owner.info.status !== "running";
    });
    if (readyTasks.length === 0 && stuckInProgress.length === 0) return;

    const now = Date.now();
    if (now - this._lastStallRecoveryAt < ORCHESTRATION_STALL_RECOVERY_INTERVAL_MS) return;
    this._lastStallRecoveryAt = now;

    this.logTeamDebug("orchestrator.stall_recovery", {
      readyTaskCount: readyTasks.length,
      stuckInProgressCount: stuckInProgress.length,
      workers: Array.from(team.workers.values()).map((worker) => ({
        agentId: worker.info.agentId,
        status: worker.info.status,
      })),
    });
    this._wakeLeaderForOrchestration({
      type: "team_message",
      sourceId: `stall:${readyTasks.map((task) => task.id).join(",")}:${stuckInProgress.map((task) => task.id).join(",")}`,
      runtimeEpoch: this._runtimeEpoch,
      messageText:
        "Orchestration heartbeat: the team is idle but runnable work is stranded " +
        `(${readyTasks.length} ready task(s), ${stuckInProgress.length} in-progress task(s) with no active worker). ` +
        "Review task and worker state and take the next coordination step: activate or assign a teammate, " +
        "reassign or split the work, or — if you are blocked on a user decision — summarize and ask the user. " +
        "If all meaningful work is genuinely complete, summarize results and stop.",
      result: "Idle team with stranded runnable work detected by the health check.",
    });
  }

  /** Clean up event subscriptions for all workers. */
  private _cleanupSubscriptions(): void {
    const team = this._team;
    if (!team) return;

    for (const [, worker] of team.workers) {
      if (worker.unsubscribeEvents) {
        worker.unsubscribeEvents();
        worker.unsubscribeEvents = undefined;
      }
    }
  }

  // ==========================================================================
  // Worker Restart
  // ==========================================================================

  /**
   * Restart a failed or shutdown worker.
   * Disposes the old worker state and launches a fresh session.
   */
  async restartWorker(agentId: string): Promise<void> {
    const team = this._team;
    this._assertRuntimeActive("restart_worker");
    if (!team) throw new Error("No active team.");

    const worker = team.workers.get(agentId);
    if (!worker) throw new Error(`Worker ${agentId} not found in team.`);

    // Only restart workers that are in error or shutdown state
    if (worker.info.status !== "error" && worker.info.status !== "shutdown") {
      throw new Error(`Worker ${agentId} is ${worker.info.status}. Only error/shutdown workers can be restarted.`);
    }
    // Dispose old resources
    if (worker.runner) {
      await worker.runner.dispose().catch(() => {});
      worker.runner = null;
    }
    worker.lifecycleAbortController?.abort();
    worker.workAbortController?.abort();
    worker.unsubscribeEvents?.();
    if (worker.session) {
      await worker.session.dispose({ reason: "quit" }).catch(() => {});
    }
    if (worker.mcpAdapter) {
      await worker.mcpAdapter.dispose().catch(() => {});
    }

    // Reset worker state
    worker.session = null;
    worker.mcpAdapter = null;
    worker.lifecycleAbortController = null;
    worker.workAbortController = null;
    worker.messageHistory = [];
    worker.info.status = "idle";
    worker.info.error = undefined;
    worker.info.statusChangedAt = Date.now();

    this._emitEvent({
      type: "teammate_status_changed",
      teamName: team.name,
      agentId,
      status: "idle",
      timestamp: worker.info.statusChangedAt,
    });
    this._emitTeamStateChanged();

    // Relaunch the worker
    void this._launchWorker(agentId).catch((err) => {
      console.error(`[TeamManager] Failed to restart worker ${agentId}:`, err);
      this.updateWorkerStatus(agentId, "error", String(err));
    });
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private _emitEvent(event: TeamEvent): void {
    for (const cb of [...this._eventCallbacks]) {
      try {
        cb(event);
      } catch (err) {
        console.error("[TeamManager] Event callback error:", err);
      }
    }
    if (event.type !== "team_deleted") {
      this._schedulePersist();
    }
  }

  private _emitTeamStateChanged(): void {
    const state = this.getTeamState();
    if (state) {
      this._emitEvent({ type: "team_state_changed", team: state });
    }
  }

  markStateDirtyForPersistence(): void {
    this._schedulePersist();
  }

  private _schedulePersist(): void {
    if (this._isRestoringTeam || !this._team || !this._physicalCwd) return;
    // Never persist during teardown: a "stopping" snapshot is non-restorable and
    // would clobber the final "active" snapshot flushed at the start of stopTeam.
    if (this._team.status === "stopping") return;
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      void this._persistTeamSnapshot().catch((err) => {
        console.warn("[TeamManager] Failed to persist team snapshot:", err);
      });
    }, 250);
  }

  private async _persistTeamSnapshot(): Promise<void> {
    if (!this._team || !this._physicalCwd || this._team.status === "stopping") return;
    await persistTeamSnapshot(this._physicalCwd, this._team);
  }

  private async _deletePersistedSnapshot(): Promise<void> {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    if (!this._physicalCwd) return;
    await deletePersistedTeamSnapshot(this._physicalCwd);
  }

  private async _restorePersistedTeamIfPresent(): Promise<void> {
    if (this._team || !this._physicalCwd || !this._authStorage) return;

    const snapshot = await readPersistedTeamSnapshot(this._physicalCwd);
    if (!snapshot || !isRestorableTeamSnapshot(snapshot, this._physicalCwd)) {
      return;
    }

    this._isRestoringTeam = true;
    try {
      const team = hydratePersistedTeam(snapshot);
      this._team = team;
      this._executionState = "paused";
      this._runtimeEpoch++;
      this._lastLoggedContext = {};
      this._debugLogger.start(this._physicalCwd, team.name, "restore_persisted_team");
      this.logTeamDebug("team.restore.start", {
        snapshotSavedAt: snapshot.savedAt,
        teamCreatedAt: snapshot.team.createdAt,
        workerCount: team.workers.size,
        taskCount: team.taskList.size(),
        executionState: this._executionState,
        runtimeEpoch: this._runtimeEpoch,
      });
      this._refreshFileConflicts();

      const openTasks = team.taskList.getAll().filter((task) =>
        task.status === "assigned" || task.status === "pending" || task.status === "blocked" || task.status === "failed",
      );
      for (const [, worker] of team.workers) {
        const hasOwnedOpenTask = openTasks.some((task) =>
          task.ownerAgentId === worker.info.agentId && task.status !== "blocked",
        );
        if (worker.info.activationPolicy !== "always" && !hasOwnedOpenTask && worker.info.status === "idle") {
          // The roster is restored for viewing, but no session exists yet.
          // Standby makes the lack of a live worker explicit until resume.
          worker.info.status = "standby";
          worker.info.statusChangedAt = Date.now();
        }
      }

      const state = this.getTeamState();
      if (state) {
        this._emitEvent({ type: "team_created", team: state });
        this._emitEvent({ type: "team_state_changed", team: state });
      }
      // Restore is deliberately history-only. A user viewing a completed Team
      // must not start a new Leader turn or revive workers just by opening it.
    } finally {
      this._isRestoringTeam = false;
      this._schedulePersist();
    }
  }

  private _shouldWakeLeaderForMessage(message: TeamMessage): boolean {
    if (!this._team) return false;
    if (message.toAgentId === this._team.leadAgentId) return true;
    if (message.toAgentId === "*") {
      // Broadcasts the leader must coordinate on: questions, proposals, and
      // objections that may change the plan; review/fix requests; blocked
      // signals; and — critically — completion-style announcements
      // (broadcast/decision/handoff/task_result). Without the latter, a worker
      // announcing finished work to the team never re-engages the leader.
      return message.kind === "question" ||
        message.kind === "proposal" ||
        message.kind === "objection" ||
        message.kind === "review_request" ||
        message.kind === "fix_request" ||
        message.kind === "blocked" ||
        message.kind === "broadcast" ||
        message.kind === "decision" ||
        message.kind === "handoff" ||
        message.kind === "task_result";
    }
    return false;
  }

  private _wakeLeaderForMessage(message: TeamMessage): void {
    const fromWorker = this._team?.workers.get(message.fromAgentId);
    const workerName = fromWorker?.info.name ?? parseAgentId(message.fromAgentId)?.agentName ?? message.fromAgentId;
    const workerRole = fromWorker?.info.role;
    const eventType: OrchestrationEvent["type"] =
      message.kind === "proposal" || message.kind === "task_message" ? "task_proposed" :
      message.kind === "question" ? "question_asked" :
      message.kind === "objection" ? "objection_raised" :
      message.kind === "review_request" ? "review_requested" :
      message.kind === "fix_request" ? "fix_requested" :
      message.kind === "blocked" ? "task_blocked" :
      "team_message";

    this._wakeLeaderForOrchestration({
      type: eventType,
      sourceId: message.id,
      runtimeEpoch: this._runtimeEpoch,
      fromAgentId: message.fromAgentId,
      toAgentId: message.toAgentId,
      messageKind: message.kind,
      messageText: message.text,
      workerName,
      workerRole,
      result: message.summary,
    });
    this.logTeamDebug("message.wake_leader", {
      message: summarizeTeamMessage(message),
      eventType,
      workerName,
      workerRole,
    });
  }

  // ==========================================================================
  // LeaderOrchestrator: Event-Driven Wake Mechanism
  // ==========================================================================

  /**
   * Set the Leader-turn-active flag with a safety watchdog.
   *
   * _leaderTurnActive gates all orchestration processing. It is normally flipped
   * true on agent_start and false on agent_end. If the SDK ever fails to emit
   * agent_end (turn swallowed or errored without an end event), the flag would
   * stick true and every queued orchestration event would be stranded behind the
   * guard in _processOrchestratorQueue — the team silently stops dispatching.
   * The watchdog force-clears the flag after LEADER_STUCK_TURN_TIMEOUT_MS and
   * drains any pending events.
   */
  private _setLeaderTurnActive(active: boolean): void {
    if (active && this._team && !this.isRuntimeActive()) {
      this.logTeamDebug("orchestrator.leader_turn.ignored", {
        reason: "team_runtime_paused",
        runtimeEpoch: this._runtimeEpoch,
      });
      return;
    }
    this._leaderTurnActive = active;
    if (this._leaderTurnWatchdog) {
      clearTimeout(this._leaderTurnWatchdog);
      this._leaderTurnWatchdog = null;
    }
    if (active) {
      this._leaderTurnWatchdog = setTimeout(() => {
        this._leaderTurnWatchdog = null;
        if (!this._leaderTurnActive) return;
        console.warn("[TeamManager] Leader turn watchdog fired; forcing leaderTurnActive=false");
        this.logTeamDebug("orchestrator.leader_turn.watchdog_reset", {
          timeoutMs: LEADER_STUCK_TURN_TIMEOUT_MS,
        });
        this._leaderTurnActive = false;
        if (this.isRuntimeActive() && this._orchestratorEvents.hasPending && this._leaderSession) {
          this._scheduleOrchestratorQueue();
        }
      }, LEADER_STUCK_TURN_TIMEOUT_MS);
    }
  }

  /**
   * Queue an orchestration event and wake the Leader for a decision turn.
   * If the Leader is idle, processes immediately. If busy, queues for agent_end.
   */
  private _wakeLeaderForOrchestration(event: OrchestrationEvent): void {
    if (!this._team) {
      this.logTeamDebug("orchestrator.wake.skipped", {
        reason: "no_team",
        event,
      });
      return;
    }

    const queuedEvent = {
      ...event,
      runtimeEpoch: event.runtimeEpoch ?? this._runtimeEpoch,
    };
    const accepted = this._orchestratorEvents.enqueue(queuedEvent);
    if (!this.isRuntimeActive() || !this._leaderSession) {
      this.logTeamDebug("orchestrator.event.queued_without_dispatch", {
        event: queuedEvent,
        accepted,
        queueLength: this._orchestratorEvents.length,
        reason: this._executionState !== "active" ? "runtime_paused" : "no_leader_session",
      });
      return;
    }
    this.logTeamDebug("orchestrator.event.enqueued", {
      event: queuedEvent,
      accepted,
      queueLength: this._orchestratorEvents.length,
      leaderTurnActive: this._leaderTurnActive,
      leaderStreaming: this._leaderSession.isStreaming,
    });

    // If leader is idle, process immediately
    if (!this._leaderTurnActive) {
      this._scheduleOrchestratorQueue();
    }
    // Otherwise, queue will be drained on agent_end hook
  }

  private _scheduleOrchestratorQueue(delayMs = 0): void {
    if (!this.isRuntimeActive()) return;
    const normalizedDelay = Math.max(0, delayMs);
    const dueAt = Date.now() + normalizedDelay;
    if (this._orchestratorRetryTimer) {
      if (this._orchestratorRetryDueAt <= dueAt) {
        this.logTeamDebug("orchestrator.schedule.ignored", {
          delayMs: normalizedDelay,
          existingDueAt: this._orchestratorRetryDueAt,
          requestedDueAt: dueAt,
        });
        return;
      }
      clearTimeout(this._orchestratorRetryTimer);
      this._orchestratorRetryTimer = null;
      this._orchestratorRetryDueAt = 0;
      this.logTeamDebug("orchestrator.schedule.replaced", {
        delayMs: normalizedDelay,
        requestedDueAt: dueAt,
      });
    }
    this._orchestratorRetryDueAt = dueAt;
    this.logTeamDebug("orchestrator.schedule", {
      delayMs: normalizedDelay,
      dueAt,
    });
    this._orchestratorRetryTimer = setTimeout(() => {
      this._orchestratorRetryTimer = null;
      this._orchestratorRetryDueAt = 0;
      void this._processOrchestratorQueue();
    }, normalizedDelay);
  }

  /**
   * Process all pending orchestration events by waking the Leader session.
   * Batches multiple events into a single prompt for efficiency.
   */
  private async _processOrchestratorQueue(): Promise<void> {
    if (!this.isRuntimeActive()) {
      this.logTeamDebug("orchestrator.process.skipped", { reason: "runtime_paused" });
      return;
    }
    if (this._leaderWakeInFlight || this._leaderTurnActive) {
      this.logTeamDebug("orchestrator.process.skipped", {
        reason: this._leaderWakeInFlight ? "wake_in_flight" : "leader_turn_active",
      });
      // If a turn is active and events are still pending, keep a retry armed.
      // agent_end normally drains the queue, but an event enqueued just after
      // that drain (or a swallowed agent_end) would otherwise sit here forever.
      // A wake-in-flight call reschedules itself in its own finally block.
      if (this._leaderTurnActive && !this._leaderWakeInFlight && this._orchestratorEvents.hasPending) {
        this._scheduleOrchestratorQueue(ORCHESTRATOR_WAKE_BASE_RETRY_MS);
      }
      return;
    }
    if (!this._leaderSession || !this._team) {
      this.logTeamDebug("orchestrator.process.skipped", {
        reason: !this._leaderSession ? "no_leader_session" : "no_team",
      });
      return;
    }
    if (!this._orchestratorEvents.hasPending) {
      this.logTeamDebug("orchestrator.process.skipped", { reason: "empty_queue" });
      return;
    }
    if (this._leaderSession.isStreaming) {
      this.logTeamDebug("orchestrator.process.deferred", { reason: "leader_streaming" });
      this._scheduleOrchestratorQueue(ORCHESTRATOR_WAKE_BASE_RETRY_MS);
      return;
    }

    this._leaderWakeInFlight = true;
    this.logTeamDebug("orchestrator.process.start", {
      queueLength: this._orchestratorEvents.length,
    });
    try {
      const result = await processOrchestrationWakeQueue({
        queue: this._orchestratorEvents,
        session: this._leaderSession,
        canProcess: () => this.isRuntimeActive() && !this._leaderTurnActive && Boolean(this._leaderSession && this._team),
        buildPrompt: (events) => this._buildOrchestrationPrompt(events),
        scheduleRetry: (delayMs) => this._scheduleOrchestratorQueue(delayMs),
        canRetry: (events) => this.isRuntimeActive() && events.every((event) => event.runtimeEpoch === this._runtimeEpoch),
        onWakeFailed: (err, retry) => {
          console.error("[TeamManager] Orchestrator wake failed, re-queuing events:", err);
          this.logTeamDebug("orchestrator.process.wake_failed", { error: err, retry });
          if (retry.circuitOpen) {
            console.error(`[TeamManager] Orchestrator wake circuit opened after ${retry.attempts} attempts; retrying in ${retry.delayMs}ms`);
          }
        },
      });
      this.logTeamDebug("orchestrator.process.result", result);
    } finally {
      this._leaderWakeInFlight = false;
      if (
        this.isRuntimeActive() &&
        this._orchestratorEvents.hasPending &&
        !this._leaderTurnActive &&
        this._leaderSession
      ) {
        this._scheduleOrchestratorQueue(this._leaderSession.isStreaming ? ORCHESTRATOR_WAKE_BASE_RETRY_MS : 0);
      }
    }
  }

  /**
   * Build a structured orchestration prompt from a batch of events.
   * Includes event details, current task/worker status, and action guidance.
   */
  private _buildOrchestrationPrompt(events: OrchestrationEvent[]): string {
    const team = this._team!;
    const allTasks = team.taskList.getAll();
    const readyTasks = team.taskList.getReadyTasks();
    const dependencyBlocked = team.taskList.getBlockedByDependencies();
    const workers = Array.from(team.workers.values()).map((worker) => worker.info);
    const prompt = buildTeamOrchestrationPrompt(events, {
      allTasks,
      readyTasks,
      dependencyBlockedTasks: dependencyBlocked,
      workers,
      getOpenDependencies: (task) => team.taskList.getOpenDependencies(task.id),
    });
    this.logTeamDebug("orchestrator.prompt.built", {
      eventCount: events.length,
      events,
      taskCount: allTasks.length,
      readyTaskCount: readyTasks.length,
      dependencyBlockedTaskCount: dependencyBlocked.length,
      prompt: summarizeText(prompt),
    });
    return prompt;
  }

  private _teamToolHost(): TeamToolHost {
    return {
      getTeam: () => this._team,
      isRuntimeActive: () => this.isRuntimeActive(),
      setLeaderTurnActive: (active) => { this._setLeaderTurnActive(active); },
      scheduleOrchestratorQueue: (delayMs) => this._scheduleOrchestratorQueue(delayMs),
      sendTeamMessage: (fromAgentId, toAgentId, text, summary, kind) =>
        this.sendTeamMessage(fromAgentId, toAgentId, text, summary, kind),
      createTask: (subject, description, assignTo, blockedBy, taskType) =>
        this.createTask(subject, description, assignTo, blockedBy, taskType),
      assignTask: (taskId, agentId) => this.assignTask(taskId, agentId),
      activateMember: (agentId) => this.activateMember(agentId),
      pauseMember: (agentId) => this.pauseMember(agentId),
      addWorker: (options) => this.addWorker(options),
      requestShutdown: (agentId) => this.requestShutdown(agentId),
      respondShutdown: (agentId, confirmed, reason) => this.respondShutdown(agentId, confirmed, reason),
      requestPermission: (agentId, tool, args, signal) => this.requestPermission(agentId, tool, args, signal),
      requestPlanApproval: (agentId, plan, files, signal) => this.requestPlanApproval(agentId, plan, files, signal),
      respondPlanApproval: (approvalId, approved, feedback) => this.respondPlanApproval(approvalId, approved, feedback),
      updateTask: (taskId, changes) => this.updateTask(taskId, changes),
      createTaskHandoff: (task, agentId, result, evidence) => this._createTaskHandoff(task, agentId, result, evidence),
      completionGateState: (task, result) => this._completionGateState(task, result),
      emitWorkerCompletionSummary: (agentId, task, workerName, workerRole, result) =>
        this._emitWorkerCompletionSummary(agentId, task, workerName, workerRole, result),
      coordinateAfterTaskCompletion: (task, agentId, result) =>
        this._coordinateAfterTaskCompletion(task, agentId, result),
      wakeLeaderForOrchestration: (event) => this._wakeLeaderForOrchestration(event),
      selectWorkerForRole: (role) => this._selectWorkerForRole(role),
    };
  }

  private _registerTeamMessagingTool(pi: ExtensionAPI, agentId: string): void {
    registerTeamMessagingTool(this._teamToolHost(), pi, agentId);
  }

  private _registerTeamTaskTool(pi: ExtensionAPI, agentId: string): void {
    registerTeamTaskTool(this._teamToolHost(), pi, agentId);
  }

  private _registerTeamProtocolTool(pi: ExtensionAPI, agentId: string): void {
    registerTeamProtocolTool(this._teamToolHost(), pi, agentId);
  }

  registerLeaderTools(pi: ExtensionAPI): void {
    registerLeaderTools(this._teamToolHost(), pi);
  }

}

function summarizeTeamTask(task: TeamTask): Record<string, unknown> {
  return {
    id: task.id,
    subject: task.subject,
    taskType: task.taskType,
    status: task.status,
    ownerAgentId: task.ownerAgentId,
    blockedBy: task.blockedBy,
    blocks: task.blocks,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    result: summarizeText(task.result, 2_000),
    evidence: task.evidence ? {
      summary: summarizeText(task.evidence.summary, 1_000),
      changedFiles: task.evidence.changedFiles,
      completedScope: task.evidence.completedScope,
      missingScope: task.evidence.missingScope,
      verification: task.evidence.verification,
      risks: task.evidence.risks,
      followUps: task.evidence.followUps,
      confidence: task.evidence.confidence,
    } : undefined,
    gateState: task.gateState,
    fileConflicts: task.fileConflicts,
    contextPack: task.contextPack ? {
      generatedAt: task.contextPack.generatedAt,
      objective: task.contextPack.objective,
      assignedScope: summarizeText(task.contextPack.assignedScope, 1_000),
      touchedFiles: task.contextPack.touchedFiles,
      relevantRisks: task.contextPack.relevantRisks,
      openQuestions: task.contextPack.openQuestions,
      coordinationHints: task.contextPack.coordinationHints,
      dependencyEvidence: task.contextPack.dependencyEvidence.map((dep) => ({
        taskId: dep.taskId,
        subject: dep.subject,
        result: summarizeText(dep.result, 1_000),
        evidenceSummary: summarizeText(dep.evidence?.summary, 1_000),
      })),
      parentEvidence: task.contextPack.parentEvidence ? {
        taskId: task.contextPack.parentEvidence.taskId,
        subject: task.contextPack.parentEvidence.subject,
        result: summarizeText(task.contextPack.parentEvidence.result, 1_000),
        evidenceSummary: summarizeText(task.contextPack.parentEvidence.evidence?.summary, 1_000),
      } : undefined,
    } : undefined,
  };
}

function summarizeTeamMessage(message: TeamMessage): Record<string, unknown> {
  return {
    id: message.id,
    teamName: message.teamName,
    fromAgentId: message.fromAgentId,
    toAgentId: message.toAgentId,
    fromRole: message.fromRole,
    kind: message.kind,
    summary: message.summary,
    timestamp: message.timestamp,
    read: message.read,
    delivered: message.delivered,
    text: summarizeText(message.text, 2_000),
  };
}
