/**
 * TeamCapacityPool - independent slot pool for roundtable seats and aux jobs
 * (dev plan §4.8 / §2.1).
 *
 * Roundtable seats must NOT go through AgentTaskScheduler (12 parallel seats
 * would break solo's 4/8 slot contract), so the team owns its own pool. This
 * file therefore imports nothing from `../agent-task` - no clamp helper, no
 * scheduler constants.
 *
 * `pause()` only stops NEW acquires; it releases nothing. The caller (S4
 * TeamManager) owns aborting whatever is already running, and must keep
 * pendingPermissions (H23).
 */

/** Default seat slots (= MAX_SEAT_SLOTS in team/constants.ts, H1: the user is not a seat). */
const DEFAULT_MAX_SEAT_SLOTS = 12;

/** Default aux slots for wrap-up / summary sessions (independent of seat slots). */
const DEFAULT_MAX_AUX_SLOTS = 2;

export class TeamCapacityPool {
  private readonly maxSeatSlots: number;
  private readonly maxAuxSlots: number;
  private readonly seats = new Set<string>();
  private readonly auxJobs = new Set<string>();
  private paused = false;

  constructor(maxSeatSlots: number = DEFAULT_MAX_SEAT_SLOTS, maxAuxSlots: number = DEFAULT_MAX_AUX_SLOTS) {
    this.maxSeatSlots = maxSeatSlots;
    this.maxAuxSlots = maxAuxSlots;
  }

  /** 一席一槽：同席重复 acquire 幂等成功；暂停或满槽则 false。 */
  acquireSeat(seatId: string): boolean {
    return this.acquire(this.seats, seatId, this.maxSeatSlots);
  }

  releaseSeat(seatId: string): void {
    this.seats.delete(seatId);
  }

  /** 辅助槽（整理 / 摘要），不占席位槽。 */
  acquireAux(jobId: string): boolean {
    return this.acquire(this.auxJobs, jobId, this.maxAuxSlots);
  }

  releaseAux(jobId: string): void {
    this.auxJobs.delete(jobId);
  }

  /** 新 acquire 全部失败（含已持槽席的重复 acquire）；不释放已持槽。 */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  private acquire(slots: Set<string>, id: string, max: number): boolean {
    if (this.paused) {
      return false;
    }
    if (slots.has(id)) {
      return true;
    }
    if (slots.size >= max) {
      return false;
    }
    slots.add(id);
    return true;
  }
}
