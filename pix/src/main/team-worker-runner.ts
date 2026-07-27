import { randomUUID } from "crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TeammateChatMessage, TeamMessage, TeammateRole } from "../shared/types.js";
import {
  IDLE_POLL_INTERVAL_MS,
  LEADER_AGENT_NAME,
  PROTOCOL_MESSAGE_KINDS,
  WORKER_TURN_HARD_TIMEOUT_MS,
} from "./team-constants.js";
import { summarizeText } from "./team-debug-logger.js";
import type { TeamMessageBus } from "./team-message-bus.js";
import type { TeamManager } from "./team-manager.js";
import type { WorkerState } from "./team-runtime-types.js";
import { formatAgentId, parseAgentId, pushHistory, sleep } from "./team-utils.js";

/**
 * Manages the execution loop for a single worker agent.
 *
 * Lifecycle: launch -> (execute -> idle -> wait -> execute)* -> dispose
 *
 * Workers persist in idle state indefinitely until:
 * - User clicks Stop Team / Stop Worker
 * - Application exits
 * - Unrecoverable fatal error
 *
 * Inspired by Claude Code's InProcessRunner:
 * - Two-level AbortController: lifecycle (kills worker) vs work (interrupts current turn only)
 * - Uses session.abort() for proper in-flight cancellation
 * - Polling-based inbox (in-memory, no file-system mailbox needed)
 */
export class WorkerRunner {
  private _agentId: string;
  private _teamName: string;
  private _role: TeammateRole;
  private _session: AgentSession;
  private _workerState: WorkerState;
  private _teamManager: TeamManager;
  private _bus: TeamMessageBus;
  private _lifecycleAbortController: AbortController;
  private _running = false;
  private _disposed = false;

  constructor(
    agentId: string,
    teamName: string,
    role: TeammateRole,
    session: AgentSession,
    workerState: WorkerState,
    teamManager: TeamManager,
    bus: TeamMessageBus,
    lifecycleAbortController: AbortController,
  ) {
    this._agentId = agentId;
    this._teamName = teamName;
    this._role = role;
    this._session = session;
    this._workerState = workerState;
    this._teamManager = teamManager;
    this._bus = bus;
    this._lifecycleAbortController = lifecycleAbortController;
  }

  /**
   * Start the worker execution loop. Returns immediately (fire-and-forget).
   *
   * The worker's role identity lives in its system prompt (worker-identity
   * extension), so no priming turn is needed: the loop goes straight to idle
   * and waits for the first task or message.
   */
  start(): void {
    if (this._running || this._disposed) {
      console.warn(`[TeamManager] Worker ${this._agentId} start() called but already running/disposed`);
      this._teamManager.logTeamDebug("worker_runner.start.ignored", {
        agentId: this._agentId,
        running: this._running,
        disposed: this._disposed,
      });
      return;
    }
    this._running = true;
    this._teamManager.logTeamDebug("worker_runner.start", {
      agentId: this._agentId,
      role: this._role,
    });
    // Fire-and-forget: the loop runs autonomously
    void this._runLoop().catch((err) => {
      if (!this._disposed) {
        console.error(`[TeamManager] Worker ${this._agentId} fatal loop error:`, err);
        this._teamManager.logTeamDebug("worker_runner.loop.fatal_error", {
          agentId: this._agentId,
          error: err,
        });
        this._teamManager.updateWorkerStatus(this._agentId, "error", String(err));
      }
    });
  }

  /**
   * Abort the current work turn (does not kill the worker).
   * Uses session.abort() for proper in-flight cancellation, then the worker
   * returns to idle and waits for the next message.
   */
  abortCurrentTurn(): void {
    this._teamManager.logTeamDebug("worker_runner.abort_current_turn", {
      agentId: this._agentId,
      status: this._workerState.info.status,
      hasWorkAbortController: Boolean(this._workerState.workAbortController),
    });
    // Signal the work-level abort controller (used by _waitForIdle race)
    this._workerState.workAbortController?.abort();

    // Resolve any pending protocol requests (plan approvals, permissions)
    // so blocked tool calls can return and session.abort() can complete
    this._teamManager.cancelProtocolRequestsForAgent(this._agentId);

    // Also call session.abort() which properly cancels the agent run,
    // aborts retries, and waits for idle
    void this._session.abort().catch((err) => {
      console.error(`[TeamManager] Error during session.abort() for ${this._agentId}:`, err);
      this._teamManager.logTeamDebug("worker_runner.abort_current_turn.error", {
        agentId: this._agentId,
        error: err,
      });
    });
  }

  /** Dispose the worker: abort lifecycle, dispose session. */
  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._teamManager.logTeamDebug("worker_runner.dispose.start", {
      agentId: this._agentId,
      running: this._running,
      status: this._workerState.info.status,
    });
    this._disposed = true;
    this._running = false;
    this._lifecycleAbortController.abort();
    this._workerState.workAbortController?.abort();
    this._workerState.unsubscribeEvents?.();

    // Abort any in-flight turn before disposing the session.
    // session.abort() interrupts the running agent and waits for idle,
    // which prevents session.dispose() from hanging on an active run.
    try {
      await this._session.abort();
    } catch {
      // session.abort() may throw if the session is not running; that is fine.
    }

    try {
      // Time-box session disposal; it must not hang the stop flow.
      await Promise.race([
        this._session.dispose({ reason: "quit" }),
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
      ]);
    } catch (err) {
      console.error(`[TeamManager] Error disposing session for ${this._agentId}:`, err);
    }

    if (this._workerState.mcpAdapter) {
      try {
        await this._workerState.mcpAdapter.dispose();
      } catch (err) {
        console.error(`[TeamManager] Error disposing MCP adapter for ${this._agentId}:`, err);
      }
      this._workerState.mcpAdapter = null;
    }
    this._teamManager.logTeamDebug("worker_runner.dispose.completed", { agentId: this._agentId });
  }

  // ==========================================================================
  // Private: Main Execution Loop
  // ==========================================================================

  private async _runLoop(): Promise<void> {
    const signal = this._lifecycleAbortController.signal;
    this._teamManager.logTeamDebug("worker_runner.loop.start", { agentId: this._agentId });

    // Idle loop: wait for messages, execute, repeat.
    // Workers persist indefinitely; only lifecycle abort or dispose breaks the loop.
    while (!signal.aborted && !this._disposed) {
      this._teamManager.updateWorkerStatus(this._agentId, "idle");
      this._teamManager.logTeamDebug("worker_runner.wait_for_message", { agentId: this._agentId });

      const next = await this._waitForNextMessage(signal);
      if (!next || signal.aborted || this._disposed) break;
      const { message, taskId, shutdownDecision } = next;

      this._teamManager.updateWorkerStatus(this._agentId, "running");
      this._workerState.info.lastActiveAt = Date.now();
      this._teamManager.logTeamDebug("worker_runner.message.dispatch", {
        agentId: this._agentId,
        taskId,
        shutdownDecision: shutdownDecision ?? false,
        message: {
          id: message.id,
          fromAgentId: message.fromAgentId,
          toAgentId: message.toAgentId,
          kind: message.kind,
          summary: message.summary,
          textLength: message.text.length,
        },
      });
      try {
        // Format message with XML wrapper for teammate context injection.
        // Shutdown-decision prompts carry their own wrapper and instructions.
        const formattedText = shutdownDecision ? message.text : this._formatMessageForPrompt(message);
        await this._executeTurn(formattedText, signal, taskId, !shutdownDecision);
      } catch (err) {
        // Turn-level error: log and continue the loop (don't kill the worker).
        // Fatal errors (unrecoverable) are distinguished by crashing the loop entirely.
        console.error(`[TeamManager] Worker ${this._agentId} turn failed, returning to idle:`, err);
        this._teamManager.logTeamDebug("worker_runner.turn.error_returning_idle", {
          agentId: this._agentId,
          error: err,
        });
      }
    }

    if (!this._disposed) {
      this._teamManager.updateWorkerStatus(this._agentId, "shutdown");
    }
    this._running = false;
    this._teamManager.logTeamDebug("worker_runner.loop.end", {
      agentId: this._agentId,
      disposed: this._disposed,
      lifecycleAborted: signal.aborted,
    });
  }

  /**
   * Execute a single turn: send prompt, wait for completion, record response.
   *
   * `taskId` identifies the shared task this turn is executing, or null when the
   * turn is driven by a plain message (no claimed task). It is threaded to the
   * turn-outcome handlers so a completion/failure is attributed to the exact
   * task rather than "whatever in_progress task this agent happens to own",
   * and so message-driven turns are not silently dropped.
   *
   * `reportOutcome` is false for protocol-decision turns (shutdown negotiation):
   * their outcome is delivered through the protocol manager, so routing them
   * through the task/orphan handlers would double-report.
   *
   * Abort semantics:
   * - workAbortController.abort(): cancels this turn only; worker returns to idle
   * - lifecycleAbortController.abort(): kills the entire worker
   * - session.abort() is called by abortCurrentTurn() for proper in-flight cancellation
   */
  private async _executeTurn(text: string, signal: AbortSignal, taskId: string | null, reportOutcome = true): Promise<void> {
    if (signal.aborted) return;

    // Create a work-level AbortController for this turn
    const workController = new AbortController();
    this._workerState.workAbortController = workController;
    const turnStartedAt = Date.now();
    this._teamManager.logTeamDebug("worker_runner.turn.start", {
      agentId: this._agentId,
      prompt: summarizeText(text, 2_000),
    });

    try {
      // Send the prompt to the session
      await this._session.prompt(text);

      // Wait for the agent to finish (idle), distinguishing the reason it stopped.
      const idleResult = await this._waitForIdle(workController.signal, signal);

      // Lifecycle abort: worker is being torn down; do not touch task state.
      if (idleResult === "lifecycle_aborted") {
        this._teamManager.logTeamDebug("worker_runner.turn.lifecycle_aborted", { agentId: this._agentId });
        return;
      }

      // Record the assistant's response (even partial output is useful context).
      const lastAssistant = this._session.getLastAssistantText();
      this._teamManager.logTeamDebug("worker_runner.turn.idle", {
        agentId: this._agentId,
        durationMs: Date.now() - turnStartedAt,
        outcome: idleResult,
        assistant: summarizeText(lastAssistant ?? "", 2_000),
      });
      if (lastAssistant) {
        const msg: TeammateChatMessage = {
          id: randomUUID(),
          role: "assistant",
          content: lastAssistant,
          timestamp: Date.now(),
        };
        pushHistory(this._workerState.messageHistory, msg);
        this._emitMessage(msg);
        this._teamManager.markStateDirtyForPersistence();
      }

      // A turn cut short by work-abort or the safety timeout did NOT finish the
      // task. Routing it through handleWorkerTurnFinished would let an
      // interrupted turn be mis-classified as a completion. Treat both as a
      // failed turn so the leader is woken to decide next steps.
      if (idleResult === "work_aborted") {
        if (reportOutcome) {
          this._teamManager.handleWorkerTurnFailed(this._agentId, "Worker turn was interrupted before completion.", taskId);
        }
        this._workerState.info.lastActiveAt = Date.now();
        return;
      }
      if (idleResult === "timeout") {
        if (reportOutcome) {
          this._teamManager.handleWorkerTurnFailed(this._agentId, "Worker turn timed out before reaching idle.", taskId);
        }
        this._workerState.info.lastActiveAt = Date.now();
        return;
      }

      if (reportOutcome) {
        this._teamManager.handleWorkerTurnFinished(this._agentId, lastAssistant, taskId);
      }
      this._workerState.info.lastActiveAt = Date.now();
    } catch (err) {
      if (signal.aborted) {
        // Lifecycle abort: worker is being shut down.
        this._teamManager.logTeamDebug("worker_runner.turn.lifecycle_aborted", { agentId: this._agentId });
        return;
      }
      if (workController.signal.aborted) {
        // Work abort: turn was interrupted, worker will return to idle.
        this._teamManager.logTeamDebug("worker_runner.turn.work_aborted", { agentId: this._agentId });
        if (reportOutcome) {
          this._teamManager.handleWorkerTurnFailed(this._agentId, "Worker turn was interrupted before completion.", taskId);
        }
        return;
      }
      this._teamManager.logTeamDebug("worker_runner.turn.failed", {
        agentId: this._agentId,
        error: err,
      });
      if (reportOutcome) {
        this._teamManager.handleWorkerTurnFailed(this._agentId, err instanceof Error ? err.message : String(err), taskId);
      }
      // Actual error: re-throw so _runLoop can catch and decide.
      throw err;
    } finally {
      this._workerState.workAbortController = null;
      this._teamManager.logTeamDebug("worker_runner.turn.end", {
        agentId: this._agentId,
        durationMs: Date.now() - turnStartedAt,
      });
    }
  }

  /**
   * Wait for the session to become idle (not streaming).
   * Races between agent.waitForIdle() and abort signals, returning which one
   * won so the caller can tell a real completion from an interruption/timeout.
   */
  private async _waitForIdle(
    workSignal: AbortSignal,
    lifecycleSignal: AbortSignal,
  ): Promise<"idle" | "work_aborted" | "lifecycle_aborted" | "timeout"> {
    if (lifecycleSignal.aborted) return "lifecycle_aborted";
    if (workSignal.aborted) return "work_aborted";

    type IdleOutcome = "idle" | "work_aborted" | "lifecycle_aborted" | "timeout";
    const timeoutController = new AbortController();
    try {
      // Race: agent idle vs work abort vs lifecycle abort vs hard ceiling.
      // Inactivity-based stuck-turn recovery is the health check's job (it
      // aborts via abortCurrentTurn, resolving this race as work_aborted); the
      // ceiling here only catches a turn that stays "active" forever.
      this._teamManager.logTeamDebug("worker_runner.wait_idle.start", {
        agentId: this._agentId,
        timeoutMs: WORKER_TURN_HARD_TIMEOUT_MS,
      });
      const outcome = await Promise.race<IdleOutcome>([
        this._session.agent.waitForIdle().then(() => "idle" as const),
        new Promise<IdleOutcome>((resolve) => {
          if (workSignal.aborted) { resolve("work_aborted"); return; }
          workSignal.addEventListener("abort", () => resolve("work_aborted"), { once: true });
        }),
        new Promise<IdleOutcome>((resolve) => {
          if (lifecycleSignal.aborted) { resolve("lifecycle_aborted"); return; }
          lifecycleSignal.addEventListener("abort", () => resolve("lifecycle_aborted"), { once: true });
        }),
        sleep(WORKER_TURN_HARD_TIMEOUT_MS, timeoutController.signal).then(() => "timeout" as const),
      ]);

      if (outcome === "timeout") {
        console.warn(`[TeamManager] Worker ${this._agentId} waitForIdle timed out, aborting session`);
        this._teamManager.logTeamDebug("worker_runner.wait_idle.timeout", { agentId: this._agentId });
        // Abort the session to clear activeRun so the next prompt() doesn't throw
        try {
          await this._session.abort();
        } catch (abortErr) {
          console.error(`[TeamManager] Error aborting session after timeout for ${this._agentId}:`, abortErr);
          this._teamManager.logTeamDebug("worker_runner.wait_idle.abort_after_timeout_error", {
            agentId: this._agentId,
            error: abortErr,
          });
        }
      }
      return outcome;
    } catch (err) {
      if (lifecycleSignal.aborted) return "lifecycle_aborted";
      if (workSignal.aborted) return "work_aborted";
      this._teamManager.logTeamDebug("worker_runner.wait_idle.error", {
        agentId: this._agentId,
        error: err,
      });
      throw err;
    } finally {
      timeoutController.abort();
    }
  }

  /**
   * Poll the message bus for the next message, with task auto-claiming.
   * Waits indefinitely until:
   * - A message arrives (consumed from the bus in priority order)
   * - A task is auto-claimed (returns a synthetic message with the task prompt)
   * - The lifecycle signal is aborted (stop team / stop worker)
   *
   * Returns the message to run plus the id of the task it claimed (null for a
   * plain message that is not a task assignment), or null when the worker should
   * shut down. `shutdownDecision` marks a shutdown request delivered to the
   * model for a respond_to_shutdown decision.
   */
  private async _waitForNextMessage(signal: AbortSignal): Promise<{ message: TeamMessage; taskId: string | null; shutdownDecision?: boolean } | null> {
    while (!signal.aborted && !this._disposed) {
      // 1. Check bus for pending messages (priority-ordered). Messages take priority over tasks.
      const message = this._bus.consumeNext(this._agentId);
      if (message) {
        this._teamManager.markStateDirtyForPersistence();
        this._teamManager.logTeamDebug("worker_runner.inbox.message", {
          agentId: this._agentId,
          message: {
            id: message.id,
            fromAgentId: message.fromAgentId,
            toAgentId: message.toAgentId,
            kind: message.kind,
            summary: message.summary,
            textLength: message.text.length,
          },
        });
        // Negotiated shutdown: deliver the request to the model as a decision
        // turn (Claude Code style). The model accepts or rejects via the
        // respond_to_shutdown tool; the runtime never auto-confirms, so a
        // worker with critical in-flight work can refuse and explain.
        if (message.kind === "shutdown") {
          this._teamManager.logTeamDebug("worker_runner.inbox.shutdown_decision", {
            agentId: this._agentId,
            messageId: message.id,
          });
          const decisionPrompt = [
            `<shutdown-request from="${LEADER_AGENT_NAME}">`,
            message.text,
            `</shutdown-request>`,
            "",
            "The team leader requests a graceful shutdown of this teammate session.",
            "Decide now by calling respond_to_shutdown:",
            "- approve=true when you have no unfinished critical work. The session terminates immediately after.",
            "- approve=false with a concrete reason when shutting down now would lose important in-flight work.",
            "Do not start new work in this turn.",
          ].join("\n");

          const chatMsg: TeammateChatMessage = {
            id: message.id,
            role: "user",
            content: decisionPrompt,
            timestamp: message.timestamp,
            senderAgentId: message.fromAgentId,
          };
          pushHistory(this._workerState.messageHistory, chatMsg);
          this._emitMessage(chatMsg);
          this._teamManager.markStateDirtyForPersistence();
          return { message: { ...message, text: decisionPrompt }, taskId: null, shutdownDecision: true };
        }

        // Intercept protocol messages in-process; do not deliver them to the LLM.
        if (PROTOCOL_MESSAGE_KINDS.has(message.kind)) {
          this._teamManager.logTeamDebug("worker_runner.inbox.protocol_intercept", {
            agentId: this._agentId,
            kind: message.kind,
            messageId: message.id,
          });
          this._handleProtocolMessage(message);
          continue; // Do not return to caller; loop back for the next message.
        }

        let messageForPrompt = message;
        let claimedTaskId: string | null = null;

        // If this is a task assignment from the bus, claim that exact task now
        // so the status transitions from assigned to in_progress before execution begins.
        if (message.kind === "task_message") {
          const taskId = this._resolveTaskIdFromTaskMessage(message);
          if (!taskId) {
            this._teamManager.logTeamDebug("worker_runner.inbox.task_message_skipped", {
              agentId: this._agentId,
              messageId: message.id,
              reason: "missing_or_ambiguous_task_id",
              summary: message.summary,
            });
            continue;
          }

          const claimed = this._teamManager.claimTask(taskId, this._agentId);
          if (!claimed) {
            this._teamManager.logTeamDebug("worker_runner.inbox.task_message_skipped", {
              agentId: this._agentId,
              messageId: message.id,
              taskId,
              reason: "task_not_claimable",
              summary: message.summary,
            });
            continue;
          }

          this._teamManager.logTeamDebug("worker_runner.inbox.task_message_claimed", {
            agentId: this._agentId,
            taskId: claimed.task.id,
            subject: claimed.task.subject,
          });
          messageForPrompt = {
            ...message,
            text: claimed.prompt,
            summary: `Task assigned: ${claimed.task.subject}`,
          };
          claimedTaskId = claimed.task.id;
        }

        // Record the received message in history (with sender for correct persistence attribution)
        const chatMsg: TeammateChatMessage = {
          id: messageForPrompt.id,
          role: "user",
          content: messageForPrompt.text,
          timestamp: messageForPrompt.timestamp,
          senderAgentId: messageForPrompt.fromAgentId,
        };
        pushHistory(this._workerState.messageHistory, chatMsg);
        this._emitMessage(chatMsg);
        this._teamManager.markStateDirtyForPersistence();
        return { message: messageForPrompt, taskId: claimedTaskId };
      }

      // 2. Try to auto-claim a task from the shared task list
      const claimed = this._teamManager.tryClaimNextTask(this._agentId);
      if (claimed) {
        this._teamManager.logTeamDebug("worker_runner.auto_claim", {
          agentId: this._agentId,
          taskId: claimed.task.id,
          subject: claimed.task.subject,
          taskType: claimed.task.taskType,
        });
        // Create a synthetic message for the claimed task
        const taskMsg: TeamMessage = {
          id: randomUUID(),
          teamName: this._teamName,
          fromAgentId: formatAgentId(LEADER_AGENT_NAME, this._teamName),
          toAgentId: this._agentId,
          text: claimed.prompt,
          timestamp: Date.now(),
          read: false,
          delivered: false,
          summary: `Task assigned: ${claimed.task.subject}`,
          kind: "task_message",
          fromRole: "leader",
        };

        // Record in history (sender is leader for task assignment)
        const chatMsg: TeammateChatMessage = {
          id: taskMsg.id,
          role: "user",
          content: claimed.prompt,
          timestamp: taskMsg.timestamp,
          senderAgentId: taskMsg.fromAgentId,
        };
        pushHistory(this._workerState.messageHistory, chatMsg);
        this._emitMessage(chatMsg);
        this._teamManager.markStateDirtyForPersistence();
        return { message: taskMsg, taskId: claimed.task.id };
      }

      // 3. Wait before next poll (forward signal so stopTeam can interrupt immediately)
      await sleep(IDLE_POLL_INTERVAL_MS, signal);
      // After sleep, re-check signal (may have been aborted during sleep)
    }
    return null;
  }

  private _resolveTaskIdFromTaskMessage(message: TeamMessage): string | null {
    const match = message.text.match(/Task #([a-zA-Z0-9-]{4,36})/);
    const token = match?.[1];
    if (!token) return null;

    const matches = this._teamManager.getTasks()
      .filter((task) => task.ownerAgentId === this._agentId)
      .filter((task) => task.id === token || task.id.startsWith(token));
    return matches.length === 1 ? matches[0]!.id : null;
  }

  /**
   * Format a TeamMessage for injection into the LLM prompt.
   * Uses a <teammate-message> XML wrapper to give the agent context about who
   * sent the message. Only attributes are escaped — escaping the body would
   * mangle code snippets and markdown the model needs to read verbatim.
   */
  private _formatMessageForPrompt(message: TeamMessage): string {
    const escapeAttr = (s: string): string =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const fromName = message.fromRole === "leader"
      ? LEADER_AGENT_NAME
      : parseAgentId(message.fromAgentId)?.agentName ?? message.fromAgentId;

    return [
      `<teammate-message from="${escapeAttr(fromName)}" role="${message.fromRole}" kind="${message.kind}">`,
      message.text,
      `</teammate-message>`,
    ].join("\n");
  }

  /**
   * Handle a protocol message intercepted from the bus. These messages are NOT
   * delivered to the LLM context. Shutdown requests are handled earlier in
   * _waitForNextMessage (delivered to the model as a decision turn), so
   * anything reaching this point should not normally arrive at a worker:
   * permission_request/plan_approval are sent BY workers, and
   * shutdown_response/permission_response flow through the protocol manager.
   */
  private _handleProtocolMessage(message: TeamMessage): void {
    console.warn(`[TeamManager] Worker ${this._agentId} received unexpected protocol message kind=${message.kind}, ignoring`);
    this._teamManager.logTeamDebug("worker_runner.protocol.unexpected", {
      agentId: this._agentId,
      kind: message.kind,
      messageId: message.id,
    });
  }

  private _emitMessage(message: TeammateChatMessage): void {
    this._teamManager.emitTeammateMessage(this._agentId, message);
  }
}
