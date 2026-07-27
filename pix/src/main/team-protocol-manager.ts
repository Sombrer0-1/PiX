import { randomUUID } from "crypto";
import type { PermissionRequest, PlanApproval, RolePermissionPolicy, ShutdownRequest, TeammateRole } from "../shared/types.js";
import { ROLE_PERMISSIONS } from "./team-constants.js";

/**
 * Manages structured protocol messages: shutdown negotiation,
 * permission requests, and plan approvals.
 *
 * Protocol messages flow through the bus but are intercepted by
 * WorkerRunner before reaching the LLM context. They use a
 * promise-based request/response pattern:
 *   worker sends request -> protocol manager creates promise -> an approved
 *   responder resolves it -> worker continues.
 */
export class TeamProtocolManager {
  private _permissionRequests = new Map<string, {
    request: PermissionRequest;
    resolve: (approved: boolean, reason?: string) => void;
  }>();
  private _planApprovals = new Map<string, {
    approval: PlanApproval;
    resolve: (approved: boolean, feedback?: string) => void;
  }>();
  private _shutdownRequests = new Map<string, ShutdownRequest>();
  private _pendingShutdownResolves = new Map<string, (confirmed: boolean) => void>();

  // -- Permission Requests --

  /**
   * Create a permission request from a worker. Returns a promise that
   * resolves when the user approves or rejects via the UI.
   */
  requestPermission(
    agentId: string,
    teamName: string,
    tool: string,
    args: Record<string, unknown>,
  ): { request: PermissionRequest; promise: Promise<{ approved: boolean; reason?: string }> } {
    const id = randomUUID();
    const now = Date.now();
    const request: PermissionRequest = {
      id,
      teamName,
      agentId,
      tool,
      args,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    let resolve!: (value: { approved: boolean; reason?: string }) => void;
    const promise = new Promise<{ approved: boolean; reason?: string }>((r) => { resolve = r; });

    this._permissionRequests.set(id, {
      request,
      resolve: (approved, reason) => resolve({ approved, reason }),
    });

    return { request, promise };
  }

  /**
   * Respond to a permission request (called from UI via IPC).
   */
  respondPermission(requestId: string, approved: boolean, reason?: string): PermissionRequest | null {
    const entry = this._permissionRequests.get(requestId);
    if (!entry) return null;

    entry.request.status = approved ? "approved" : "rejected";
    entry.request.reason = reason;
    entry.request.updatedAt = Date.now();
    entry.resolve(approved, reason);
    this._permissionRequests.delete(requestId);

    return { ...entry.request };
  }

  /** Get all pending permission requests. */
  getPendingPermissionRequests(): PermissionRequest[] {
    return Array.from(this._permissionRequests.values()).map((e) => ({ ...e.request }));
  }

  // -- Plan Approvals --

  /**
   * Create a plan approval request from a worker. Returns a promise.
   */
  requestPlanApproval(
    agentId: string,
    teamName: string,
    plan: string,
    files: string[],
  ): { approval: PlanApproval; promise: Promise<{ approved: boolean; feedback?: string }> } {
    const id = randomUUID();
    const now = Date.now();
    const approval: PlanApproval = {
      id,
      teamName,
      agentId,
      plan,
      files,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    let resolve!: (value: { approved: boolean; feedback?: string }) => void;
    const promise = new Promise<{ approved: boolean; feedback?: string }>((r) => { resolve = r; });

    this._planApprovals.set(id, {
      approval,
      resolve: (approved, feedback) => resolve({ approved, feedback }),
    });

    return { approval, promise };
  }

  /**
   * Resolve a plan approval ID or unique ID prefix among pending approvals.
   * The Leader LLM sometimes echoes an abbreviated ID back into
   * respond_to_plan_approval; a unique prefix (min 4 chars) is accepted.
   */
  resolvePlanApprovalId(idOrPrefix: string): string | null {
    const token = idOrPrefix.trim();
    if (!token) return null;
    if (this._planApprovals.has(token)) return token;
    if (token.length < 4) return null;

    let match: string | null = null;
    for (const id of this._planApprovals.keys()) {
      if (!id.startsWith(token)) continue;
      if (match) return null;
      match = id;
    }
    return match;
  }

  /**
   * Respond to a plan approval request. Accepts a full ID or unique prefix.
   */
  respondPlanApproval(approvalId: string, approved: boolean, feedback?: string): PlanApproval | null {
    const resolvedId = this.resolvePlanApprovalId(approvalId);
    const entry = resolvedId ? this._planApprovals.get(resolvedId) : undefined;
    if (!entry) return null;

    entry.approval.status = approved ? "approved" : "rejected";
    entry.approval.feedback = feedback;
    entry.approval.updatedAt = Date.now();
    entry.resolve(approved, feedback);
    this._planApprovals.delete(resolvedId!);

    return { ...entry.approval };
  }

  /** Get all pending plan approvals. */
  getPendingPlanApprovals(): PlanApproval[] {
    return Array.from(this._planApprovals.values()).map((e) => ({ ...e.approval }));
  }

  /**
   * Cancel a pending plan approval request (e.g. on timeout or abort).
   * Resolves the pending promise with false and removes the entry.
   */
  cancelPlanApproval(approvalId: string): void {
    const entry = this._planApprovals.get(approvalId);
    if (entry) {
      entry.resolve(false, "Timed out");
      this._planApprovals.delete(approvalId);
    }
  }

  /**
   * Cancel a pending permission request (e.g. on timeout or abort).
   * Resolves the pending promise with false and removes the entry.
   */
  cancelPermissionRequest(requestId: string): void {
    const entry = this._permissionRequests.get(requestId);
    if (entry) {
      entry.resolve(false, "Timed out");
      this._permissionRequests.delete(requestId);
    }
  }

  /**
   * Cancel all pending protocol requests for a specific agent (e.g. on turn abort).
   * Resolves all pending promises with false and removes the entries.
   */
  cancelAllForAgent(agentId: string): void {
    // Collect IDs first, then delete. This keeps Map iteration predictable.
    // the current entry but fragile if a future refactor deletes a different key.
    const permIds: string[] = [];
    for (const [id, entry] of this._permissionRequests) {
      if (entry.request.agentId === agentId) {
        entry.resolve(false, "Turn aborted");
        permIds.push(id);
      }
    }
    for (const id of permIds) this._permissionRequests.delete(id);

    const planIds: string[] = [];
    for (const [id, entry] of this._planApprovals) {
      if (entry.approval.agentId === agentId) {
        entry.resolve(false, "Turn aborted");
        planIds.push(id);
      }
    }
    for (const id of planIds) this._planApprovals.delete(id);
  }

  // -- Shutdown Negotiation --

  /**
   * Request shutdown for a specific worker. Returns a promise that
   * resolves when the worker confirms or rejects.
   */
  requestShutdown(agentId: string): { request: ShutdownRequest; promise: Promise<boolean> } {
    const now = Date.now();
    const request: ShutdownRequest = {
      agentId,
      state: "pending",
      requestedAt: now,
    };

    let resolve!: (confirmed: boolean) => void;
    const promise = new Promise<boolean>((r) => { resolve = r; });

    this._shutdownRequests.set(agentId, request);
    this._pendingShutdownResolves.set(agentId, resolve);

    return { request, promise };
  }

  /**
   * Worker responds to a shutdown request. Returns null when there is no live
   * pending request (never asked, already answered, timed out, or cancelled),
   * so a stale model response cannot mutate resolved protocol state.
   * The answered entry is kept in _shutdownRequests until cleanup: the
   * requester's TOCTOU guard reads its state after the response race.
   */
  respondShutdown(agentId: string, confirmed: boolean, reason?: string): ShutdownRequest | null {
    const request = this._shutdownRequests.get(agentId);
    const resolve = this._pendingShutdownResolves.get(agentId);
    if (!request || request.state !== "pending" || !resolve) return null;

    request.state = confirmed ? "confirmed" : "rejected";
    request.reason = reason;
    request.respondedAt = Date.now();

    resolve(confirmed);
    this._pendingShutdownResolves.delete(agentId);

    return { ...request };
  }

  /**
   * Cancel a pending shutdown request (e.g. on timeout).
   * Resolves the pending promise with false and removes the entry.
   */
  cancelShutdownRequest(agentId: string): void {
    const resolve = this._pendingShutdownResolves.get(agentId);
    if (resolve) {
      resolve(false);
      this._pendingShutdownResolves.delete(agentId);
    }
    this._shutdownRequests.delete(agentId);
  }

  /** Get all shutdown states. */
  getShutdownStates(): ShutdownRequest[] {
    return Array.from(this._shutdownRequests.values()).map((r) => ({ ...r }));
  }

  /** Clear all protocol state. */
  clearAll(): void {
    // Resolve all pending promises with false (cancelled)
    for (const [, entry] of this._permissionRequests) {
      entry.resolve(false, "Team stopped");
    }
    this._permissionRequests.clear();

    for (const [, entry] of this._planApprovals) {
      entry.resolve(false, "Team stopped");
    }
    this._planApprovals.clear();

    for (const [agentId, resolve] of this._pendingShutdownResolves) {
      resolve(false);
    }
    this._pendingShutdownResolves.clear();
    this._shutdownRequests.clear();
  }

  /** Get the role permission policy for a given role. */
  getRolePermissions(role: TeammateRole): RolePermissionPolicy {
    return ROLE_PERMISSIONS[role];
  }

  /** Check if a tool is allowed for a given role. */
  isToolAllowed(role: TeammateRole, toolName: string): boolean {
    const policy = ROLE_PERMISSIONS[role];
    if (policy.deniedTools.includes(toolName)) return false;
    return policy.allowedTools.includes(toolName);
  }
}
