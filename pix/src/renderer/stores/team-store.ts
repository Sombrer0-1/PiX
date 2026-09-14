/**
 * Team store — the renderer projection of the roundtable runtime.
 *
 * The main process (`TeamManager`) is the authority: this store never decides
 * discussion state, it only mirrors what `TeamEvent`s pushed over IPC say
 * (dev plan §6.2). Every discussion collection below (roundtable, timeline,
 * attention, open items, deliverables, metrics, seat activity, protocol
 * queues) is written exclusively from `handleTeamEvent`; the pull paths
 * (`refresh`) exist only to rehydrate after a mount/restart.
 *
 * Public surface frozen for S7 (case-for-case): teamMode, isLoading,
 * isTeamActive, roundtable, timeline, attention, metrics, startTeamRuntime,
 * stopTeamRuntime, toggleTeamMode, refresh(), TaggedSessionEvent, and the
 * discussion commands the roundtable surfaces call.
 */

import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useRpc } from "../composables/useRpc";
import { useTeamLeaderRpc } from "../composables/useTeamLeaderRpc";
import { useProjectStore } from "./project-store";
import { toPlain } from "../utils/plain";
import {
  USER_SEAT_ID,
  type AttentionItem,
  type DeliverableVersion,
  type DeliveryState,
  type ExitRequest,
  type InboxEntry,
  type InterruptLevel,
  type OpenItem,
  type RoundtableMetricsSnapshot,
  type RoundtableSettings,
  type RoundtableState,
  type RoundtableTier,
  type SeatConfig,
  type SeatInfo,
  type SeatRuntimeStatus,
  type TeamCommand,
  type TeamEvent,
  type TimelineItem,
  type ToolAuthTier,
} from "@shared/team-types.js";
import type { AgentSessionEvent, ChatMessageAttachment, PermissionRequest, ProjectLocation } from "@shared/types.js";

/** Wrapper for a seat's raw AgentSessionEvent, tagged with seatId. */
export interface TaggedSessionEvent {
  seatId: string;
  event: AgentSessionEvent;
  timestamp: number;
}

/** Per-seat raw event buffer cap (streaming noise only; the timeline is the record). */
const MAX_SEAT_EVENTS = 200;

/** Empty metrics snapshot (no roundtable / nothing measured yet). */
export function emptyMetrics(): RoundtableMetricsSnapshot {
  return {
    perSeat: {},
    totals: { utterances: 0, tokens: 0, cost: 0, durationMs: 0 },
    health: { speakShare: {}, evidenceDensity: 0, interruptRate: 0 },
  };
}

/** Replace-or-append a record by id (pushed events are idempotent replays). */
function upsertById<T extends { id: string }>(list: T[], item: T): void {
  const index = list.findIndex((existing) => existing.id === item.id);
  if (index >= 0) {
    list.splice(index, 1, item);
  } else {
    list.push(item);
  }
}

export const useTeamStore = defineStore("team", () => {
  const singleRpc = useRpc();
  const teamLeaderRpc = useTeamLeaderRpc();
  const projectStore = useProjectStore();

  // ==========================================================================
  // Projected state (written only by handleTeamEvent / refresh)
  // ==========================================================================

  const roundtableState = ref<RoundtableState | null>(null);
  const timelineItems = ref<TimelineItem[]>([]);
  const deliveries = ref<Record<string, Record<string, DeliveryState>>>({});
  const attentionItems = ref<AttentionItem[]>([]);
  const openItems = ref<OpenItem[]>([]);
  const deliverables = ref<DeliverableVersion[]>([]);
  const metricsSnapshot = ref<RoundtableMetricsSnapshot>(emptyMetrics());
  const seatEventBuffers = ref<Record<string, TaggedSessionEvent[]>>({});
  const pendingPermissions = ref<PermissionRequest[]>([]);
  const exitRequests = ref<ExitRequest[]>([]);

  // View state (never a discussion authority)
  const teamMode = ref(false);
  const isLoading = ref(false);
  const lastError = ref<string | null>(null);
  const focusedSeatId = ref<string | null>(null);
  const mutedThreads = ref<string[]>([]);
  const legacyNotice = ref(false);
  const recordCorruptNotice = ref<string | null>(null);

  /** Active team-event unsubscribe handle (singleton store → one live subscription). */
  let unsubscribeTeamEvents: (() => void) | null = null;

  // ==========================================================================
  // Computed (frozen surface + component inputs)
  // ==========================================================================

  /** There is a roundtable to show (any lifecycle except none, incl. archived/read-only). */
  const roundtable = computed<RoundtableState | null>(() => roundtableState.value);

  /** A running roundtable (active or paused) — mirrors `TeamManager.hasActiveTeam()`. */
  const isTeamActive = computed(() => {
    const lifecycle = roundtableState.value?.lifecycle;
    return lifecycle === "active" || lifecycle === "paused";
  });

  const teamName = computed(() => roundtableState.value?.name ?? null);
  const orderedMode = computed(() => roundtableState.value?.orderedMode === true);
  const lifecycle = computed(() => roundtableState.value?.lifecycle ?? null);

  /** All seats keyed by seatId (exited seats kept: the timeline still points at them). */
  const seats = computed<Record<string, SeatInfo>>(() => roundtableState.value?.seats ?? {});

  /** Seats in creation order, exited included. */
  const seatList = computed<SeatInfo[]>(() => Object.values(seats.value));

  /** Seats that can still speak. */
  const activeSeats = computed<SeatInfo[]>(() => seatList.value.filter((seat) => seat.status !== "exited"));

  /** Timeline with the pushed delivery states merged in (delivery_changed may lead the item). */
  const timeline = computed<TimelineItem[]>(() =>
    timelineItems.value.map((item) => {
      const pushed = deliveries.value[item.id];
      if (pushed === undefined) return item;
      return { ...item, deliveryBySeat: { ...item.deliveryBySeat, ...pushed } };
    }),
  );

  /** Attention items, unacked first then by time (the surface order). */
  const attention = computed<AttentionItem[]>(() =>
    [...attentionItems.value].sort((a, b) => Number(a.acked) - Number(b.acked) || a.ts - b.ts),
  );

  const unackedAttention = computed(() => attention.value.filter((item) => !item.acked));

  const metrics = computed<RoundtableMetricsSnapshot>(() => metricsSnapshot.value);

  /** Deliverable versions, newest first. */
  const deliverableVersions = computed<DeliverableVersion[]>(() =>
    [...deliverables.value].sort((a, b) => b.version - a.version),
  );

  /** Open items: unresolved first, then by recency. */
  const openItemList = computed<OpenItem[]>(() =>
    [...openItems.value].sort((a, b) => {
      const openA = a.status === "open" || a.status === "claimed" ? 0 : 1;
      const openB = b.status === "open" || b.status === "claimed" ? 0 : 1;
      return openA - openB || b.updatedAt - a.updatedAt;
    }),
  );

  const pendingProtocolCount = computed(() => pendingPermissions.value.length + exitRequests.value.length);

  /** Per-seat "正在做什么" (last activity pushed with a seat_status). */
  const currentActivity = computed<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const seat of seatList.value) {
      if (seat.currentActivity) out[seat.seatId] = seat.currentActivity;
    }
    return out;
  });

  const focusedSeat = computed<SeatInfo | null>(() => {
    const id = focusedSeatId.value;
    return id === null ? null : seats.value[id] ?? null;
  });

  /** Seat raw event streams, keyed by seatId (tool activity surfaces read this). */
  const seatEvents = computed<Record<string, TaggedSessionEvent[]>>(() => seatEventBuffers.value);

  // ==========================================================================
  // IPC plumbing
  // ==========================================================================

  /**
   * Send one TeamCommand. Failures are recorded in `lastError` and returned as
   * null — the renderer surfaces never throw on a rejected command, and no
   * discussion state is written from a command result (events are the only
   * writer; `refresh` is the explicit pull path).
   */
  async function send<T>(command: TeamCommand): Promise<T | null> {
    if (!window.pixApi) {
      lastError.value = "PiX 预加载 API 不可用。";
      return null;
    }
    // Every command clears the previous failure, so `lastError !== null` after a
    // call always describes *this* call (used by the command wrappers below).
    lastError.value = null;
    try {
      const result = await window.pixApi.sendTeamCommand<T>(command);
      if (!result.success) {
        lastError.value = result.error ?? "团队命令失败";
        return null;
      }
      return (result.data ?? null) as T | null;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  // ==========================================================================
  // Event projection
  // ==========================================================================

  function clearRoundtable(): void {
    roundtableState.value = null;
    resetRoundtableCollections();
  }

  /** Drop everything that belongs to one roundtable (new场 or no场). */
  function resetRoundtableCollections(): void {
    timelineItems.value = [];
    deliveries.value = {};
    attentionItems.value = [];
    openItems.value = [];
    deliverables.value = [];
    metricsSnapshot.value = emptyMetrics();
    seatEventBuffers.value = {};
    pendingPermissions.value = [];
    exitRequests.value = [];
    mutedThreads.value = [];
    focusedSeatId.value = null;
  }

  function setRoundtable(next: RoundtableState): void {
    const previous = roundtableState.value;
    if (previous !== null && previous.roundtableId !== next.roundtableId) {
      resetRoundtableCollections();
    }
    roundtableState.value = next;
  }

  /** Insert/replace one timeline record, keeping the list seq-ordered. */
  function upsertTimelineItem(item: TimelineItem): void {
    const items = timelineItems.value;
    const index = items.findIndex((existing) => existing.id === item.id);
    if (index >= 0) {
      items.splice(index, 1, item);
      return;
    }
    const last = items[items.length - 1];
    if (last === undefined || last.seq <= item.seq) {
      items.push(item);
      return;
    }
    const at = items.findIndex((existing) => existing.seq > item.seq);
    items.splice(at < 0 ? items.length : at, 0, item);
  }

  function applySeatStatus(
    seatId: string,
    status: SeatRuntimeStatus,
    activity?: string,
    error?: string,
  ): void {
    const state = roundtableState.value;
    const seat = state?.seats[seatId];
    if (state === null || seat === undefined) return;
    const updated: SeatInfo = {
      ...seat,
      status,
      statusChangedAt: Date.now(),
      // Mirror the main-process roster semantics: the event carries the new
      // activity/error, and error only survives on the error status.
      currentActivity: activity,
      error: status === "error" ? error : undefined,
    };
    state.seats = { ...state.seats, [seatId]: updated };
  }

  function appendSeatEvent(seatId: string, event: AgentSessionEvent): void {
    // Ignore events from unknown seats: after a roundtable switch the previous
    // run's tail must not bleed into the new one's activity surfaces.
    if (roundtableState.value?.seats[seatId] === undefined) return;
    const buffer = seatEventBuffers.value[seatId] ?? [];
    buffer.push({ seatId, event, timestamp: Date.now() });
    if (buffer.length > MAX_SEAT_EVENTS) {
      buffer.splice(0, buffer.length - MAX_SEAT_EVENTS);
    }
    seatEventBuffers.value = { ...seatEventBuffers.value, [seatId]: buffer };
  }

  function applyDeliveryChanged(messageId: string, seatId: string, state: DeliveryState): void {
    const current = deliveries.value[messageId] ?? {};
    deliveries.value = { ...deliveries.value, [messageId]: { ...current, [seatId]: state } };
  }

  function handleTeamEvent(event: TeamEvent): void {
    switch (event.type) {
      case "roundtable_created":
        setRoundtable(event.state);
        // A live roundtable should always be visible: created ones come from the
        // setup dialog, restored ones should reopen the workbench by themselves.
        teamMode.value = true;
        break;
      case "roundtable_state":
        setRoundtable(event.state);
        break;
      case "timeline_item":
        upsertTimelineItem(event.item);
        break;
      case "seat_status":
        applySeatStatus(event.seatId, event.status, event.activity, event.error);
        break;
      case "seat_event":
        appendSeatEvent(event.seatId, event.event);
        break;
      case "attention":
        upsertById(attentionItems.value, event.item);
        break;
      case "open_item":
        upsertById(openItems.value, event.item);
        break;
      case "deliverable":
        upsertById(deliverables.value, event.item);
        break;
      case "delivery_changed":
        applyDeliveryChanged(event.messageId, event.seatId, event.state);
        break;
      case "metrics":
        metricsSnapshot.value = event.snapshot;
        break;
      case "legacy_snapshot_notice":
        legacyNotice.value = true;
        break;
      case "record_corrupt_notice":
        recordCorruptNotice.value = event.text;
        break;
      case "protocol_permission_request":
        upsertById(pendingPermissions.value, event.request);
        break;
      case "exit_request":
        if (event.request.status === "pending") {
          upsertById(exitRequests.value, event.request);
        } else {
          exitRequests.value = exitRequests.value.filter((request) => request.id !== event.request.id);
        }
        break;
      default: {
        const exhaustive: never = event;
        void exhaustive;
      }
    }
  }

  /** Subscribe to pushed roundtable events. Must be called once on app init. */
  function subscribeToEvents(): () => void {
    // Guard against duplicate subscriptions (window reopen, component remount):
    // a second handler would process every event twice.
    if (unsubscribeTeamEvents) {
      unsubscribeTeamEvents();
    }
    const off = window.pixApi.onTeamEvent((event: TeamEvent) => {
      handleTeamEvent(event);
    });
    unsubscribeTeamEvents = () => {
      off();
      unsubscribeTeamEvents = null;
    };
    return unsubscribeTeamEvents;
  }

  // ==========================================================================
  // Pull (rehydrate after mount/restart — the explicit refresh path)
  // ==========================================================================

  /** Re-read the current roundtable snapshot: state + timeline + metrics + attention. */
  async function refresh(): Promise<void> {
    isLoading.value = true;
    try {
      const [state, items, snapshot, attentions] = await Promise.all([
        send<RoundtableState | null>({ type: "get_state" }),
        send<TimelineItem[]>({ type: "get_timeline" }),
        send<RoundtableMetricsSnapshot>({ type: "get_metrics" }),
        send<AttentionItem[]>({ type: "get_attention" }),
      ]);

      if (state === null) {
        // 没有场（运行环境刚起来、还没 create_roundtable）或命令失败：只清圆桌投影。
        // teamMode 是用户选的前台模式（FR-13），不能由「有没有场」推导——在这里置
        // false 会让「新建团队会话」在 create_roundtable 之前弹回 solo，订阅随之断掉，
        // 于是 5 席在后台开跑而界面永远收不到 roundtable_created（AC-1 主入口不可达）。
        // 运行环境真的停了由 stopHostRuntime() 与下面的 piStatus watcher 负责。
        if (roundtableState.value !== null) {
          clearRoundtable();
        }
      } else {
        setRoundtable(state);
        if (items !== null) {
          timelineItems.value = [...items].sort((a, b) => a.seq - b.seq);
        }
        if (snapshot !== null) {
          metricsSnapshot.value = snapshot;
        }
        if (attentions !== null) {
          attentionItems.value = attentions;
        }
        if (isTeamActive.value) {
          // A live roundtable discovered on mount (restored after a restart)
          // opens the workbench without a manual toggle.
          teamMode.value = true;
        }
      }
    } finally {
      isLoading.value = false;
    }
  }

  /** 未决项 / 交付物 are not part of the frozen refresh: load them on demand. */
  async function refreshOpenItems(): Promise<void> {
    const items = await send<OpenItem[]>({ type: "get_open_items" });
    if (items !== null) openItems.value = items;
  }

  async function refreshDeliverables(): Promise<void> {
    const items = await send<DeliverableVersion[]>({ type: "get_deliverables" });
    if (items !== null) deliverables.value = items;
  }

  async function refreshInbox(seatId?: string): Promise<InboxEntry[]> {
    return (await send<InboxEntry[]>({ type: "get_inbox", seatId })) ?? [];
  }

  // ==========================================================================
  // Runtime start/stop (host SessionBridge only — never the discussion engine)
  // ==========================================================================

  async function startHostRuntime(target: ProjectLocation): Promise<boolean> {
    const started = await teamLeaderRpc.startTeamRuntime(target);
    if (!started) {
      lastError.value = teamLeaderRpc.lastError.value || "启动团队运行环境失败";
      return false;
    }
    teamMode.value = true;
    void window.pixApi.setWorkspaceMode(target, "team");
    return true;
  }

  async function stopHostRuntime(): Promise<boolean> {
    await teamLeaderRpc.stopTeamRuntime();
    teamMode.value = false;
    focusedSeatId.value = null;
    return true;
  }

  /** Start the team runtime (host session); the discussion runs through TeamCommand. */
  async function startTeamRuntime(location?: ProjectLocation): Promise<boolean> {
    if (!location) {
      lastError.value = "启动团队运行环境前需要先打开项目目录";
      return false;
    }
    isLoading.value = true;
    lastError.value = null;
    try {
      return await startHostRuntime(toPlain(location));
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    } finally {
      isLoading.value = false;
    }
  }

  /** Stop the team runtime. */
  async function stopTeamRuntime(): Promise<boolean> {
    isLoading.value = true;
    lastError.value = null;
    try {
      return await stopHostRuntime();
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    } finally {
      isLoading.value = false;
    }
  }

  /** Switch the workspace between the single and team runtimes (mutually exclusive). */
  async function toggleTeamMode(location?: ProjectLocation): Promise<boolean> {
    if (isLoading.value) return false;
    if (!location) {
      lastError.value = "切换模式前需要先打开项目目录";
      return false;
    }

    // projectStore.currentProject is a Vue reactive proxy; strip reactivity
    // before the location crosses the contextBridge/IPC boundary.
    const target = toPlain(location);

    isLoading.value = true;
    lastError.value = null;
    try {
      if (teamMode.value) {
        await stopHostRuntime();
        const started = await singleRpc.startRuntime(target);
        if (!started) {
          lastError.value = singleRpc.lastError.value || "启动单人运行环境失败";
          // Solo failed to start; restore the team runtime so the workspace is
          // not left with both runtimes down while the UI still shows team mode.
          const restored = await startHostRuntime(target);
          if (!restored) {
            lastError.value = `${lastError.value}\n恢复团队运行环境也失败：${teamLeaderRpc.lastError.value || "未知错误"}`;
            teamMode.value = false;
          }
          return false;
        }
        // FR-13：切到单人必须写回 mode.json，否则下一次挂载 / 重启时
        // `getWorkspaceMode() === "team" && hasTeamSnapshot()` 会把用户重新拉回团队。
        void window.pixApi.setWorkspaceMode(target, "solo");
        focusedSeatId.value = null;
        return true;
      }

      const started = await startHostRuntime(target);
      if (!started) {
        // start-team-runtime stops the single runtime before starting the team
        // runtime, so restore ordinary mode if Team startup fails.
        const restored = await singleRpc.startRuntime(target);
        if (!restored) {
          lastError.value = `${lastError.value}\n恢复单人运行环境也失败：${singleRpc.lastError.value || "未知错误"}`;
        }
        return false;
      }
      return true;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      return false;
    } finally {
      isLoading.value = false;
    }
  }

  // If the team runtime exits while team mode is on (e.g. it crashed while the
  // user was on another page and CenterPanel's watcher had been disposed with
  // the component), recover to a functional solo workspace from the singleton
  // store. The isLoading guard prevents a double switch when CenterPanel's
  // watcher fires at the same time, and blocks this callback during a normal
  // team→solo toggle (whose stopTeamRuntime flips piStatus to "stopped" while
  // teamMode is still true). Only an unsolicited exit triggers recovery.
  watch(teamLeaderRpc.piStatus, (status) => {
    if (status !== "stopped" || !teamMode.value || isLoading.value) return;
    const location = projectStore.currentProject;
    if (location) {
      void toggleTeamMode(location);
    } else {
      teamMode.value = false;
    }
  });

  // ==========================================================================
  // Discussion commands (state comes back through events)
  // ==========================================================================

  async function createRoundtable(input: {
    topic: string;
    name?: string;
    tier?: RoundtableTier;
    seats?: SeatConfig[];
    settings?: Partial<RoundtableSettings>;
    attachments?: ChatMessageAttachment[];
  }): Promise<RoundtableState | null> {
    isLoading.value = true;
    lastError.value = null;
    try {
      return await send<RoundtableState>({ type: "create_roundtable", ...input });
    } finally {
      isLoading.value = false;
    }
  }

  async function postUserMessage(input: {
    to: string;
    text: string;
    private?: boolean;
    interrupt?: InterruptLevel;
    attachments?: ChatMessageAttachment[];
  }): Promise<TimelineItem | null> {
    return await send<TimelineItem>({ type: "post_user_message", ...input });
  }

  async function setOrderedMode(on: boolean): Promise<void> {
    await send({ type: "set_ordered_mode", on });
  }

  /** Pause forbids every team model call but keeps pending permissions and inbox. */
  async function pause(): Promise<void> {
    await send({ type: "pause" });
  }

  async function resume(): Promise<void> {
    await send({ type: "resume" });
  }

  async function stopRoundtable(opts?: { wrapUp?: boolean }): Promise<void> {
    isLoading.value = true;
    try {
      await send({ type: "stop", wrapUp: opts?.wrapUp });
    } finally {
      isLoading.value = false;
    }
  }

  async function addSeat(config: SeatConfig): Promise<SeatInfo | null> {
    return await send<SeatInfo>({ type: "add_seat", config });
  }

  async function removeSeat(seatId: string, requestedBy: "user" | "self" | "peer" = "user"): Promise<void> {
    await send({ type: "remove_seat", seatId, requestedBy });
  }

  async function updateSeatAuth(seatId: string, auth: ToolAuthTier, pathAllowlist?: string[]): Promise<void> {
    await send({ type: "update_seat_auth", seatId, auth, pathAllowlist });
  }

  async function wakeSeat(seatId: string): Promise<void> {
    await send({ type: "wake_seat", seatId });
  }

  /** Mute is workspace-local view state; the main process keeps it for the snapshot. */
  async function muteThread(threadId: string, muted: boolean): Promise<void> {
    mutedThreads.value = muted
      ? [...mutedThreads.value.filter((id) => id !== threadId), threadId]
      : mutedThreads.value.filter((id) => id !== threadId);
    await send({ type: "mute_thread", threadId, muted });
  }

  async function requestWrapUp(author?: "system" | string): Promise<DeliverableVersion | null> {
    lastError.value = null;
    const version = await send<DeliverableVersion>({ type: "request_wrap_up", author });
    if (version === null && lastError.value === null) {
      lastError.value = "整理失败";
    }
    return version;
  }

  async function reviseDeliverable(
    id: string,
    markdown: string,
    expectedRevision: number,
  ): Promise<{ ok: true } | { ok: false; conflict: true; currentVersion: number; currentRevision: number } | null> {
    return await send({ type: "revise_deliverable", id, markdown, expectedRevision });
  }

  async function stanceOnDeliverable(
    id: string,
    stance: "support" | "oppose" | "conditional",
    opts?: { seatId?: string; reason?: string; confidence?: "low" | "medium" | "high" },
  ): Promise<{ ok: true } | { ok: false; error: string } | null> {
    // seatId omitted = the user (the IPC layer maps it to USER_SEAT_ID).
    return await send({
      type: "stance_on_deliverable",
      id,
      seatId: opts?.seatId,
      stance,
      reason: opts?.reason,
      confidence: opts?.confidence,
    });
  }

  async function exportMarkdown(): Promise<string | null> {
    return await send<string>({ type: "export_markdown" });
  }

  async function buildHandoff(
    deliverableId: string,
    target: "solo" | "plan",
  ): Promise<{ text: string } | null> {
    return await send<{ text: string }>({ type: "build_handoff", deliverableId, target });
  }

  /**
   * Ack one attention item. The main process has no ack event, so the local
   * flag flips optimistically (the next refresh re-reads the acked flags).
   */
  async function ackAttention(id: string): Promise<void> {
    const item = attentionItems.value.find((candidate) => candidate.id === id);
    if (item !== undefined) {
      item.acked = true;
    }
    await send({ type: "ack_attention", id });
    // 崩溃恢复的「确认后继续」（§5.11 / F5-4）：ack 只关闭提示，恢复动作要显式发
    // resume，否则 lifecycle 永远停在 paused，用户以为恢复失败。
    if (item?.action === "resume") {
      await send({ type: "resume" });
    }
  }

  /**
   * Approve/deny a pending permission. There is no response event (the answer
   * travels into the seat inbox), so the queue entry is dropped locally.
   */
  async function respondPermission(requestId: string, approved: boolean, reason?: string): Promise<boolean> {
    const ok = await send({ type: "respond_permission", requestId, approved, reason });
    if (ok === null && lastError.value !== null) return false;
    pendingPermissions.value = pendingPermissions.value.filter((request) => request.id !== requestId);
    return true;
  }

  async function respondExit(requestId: string, statement: string, accept?: boolean): Promise<void> {
    await send({ type: "respond_exit", requestId, statement, accept });
  }

  async function setSettings(settings: Partial<RoundtableSettings>): Promise<void> {
    await send({ type: "set_settings", settings });
  }

  async function downgradeModels(model: string): Promise<void> {
    await send({ type: "downgrade_models", model });
  }

  async function listPresets(): Promise<Array<{ name: string; seats: SeatConfig[] }>> {
    return (await send({ type: "list_presets" })) ?? [];
  }

  async function savePreset(name: string, presetSeats: SeatConfig[]): Promise<boolean> {
    await send({ type: "save_preset", name, seats: presetSeats });
    return lastError.value === null;
  }

  async function deletePreset(name: string): Promise<void> {
    await send({ type: "delete_preset", name });
  }

  /** Dismiss the one-time legacy-snapshot banner (workspace-level ack). */
  async function dismissLegacyNotice(location?: ProjectLocation): Promise<void> {
    legacyNotice.value = false;
    if (location) {
      await window.pixApi.ackLegacyTeamSnapshot(toPlain(location));
    }
  }

  function dismissRecordCorruptNotice(): void {
    recordCorruptNotice.value = null;
  }

  function focusSeat(seatId: string): void {
    focusedSeatId.value = seatId;
  }

  function clearFocus(): void {
    focusedSeatId.value = null;
  }

  function clearError(): void {
    lastError.value = null;
  }

  return {
    // ---- Frozen public surface (S7) ----
    teamMode,
    isLoading,
    isTeamActive,
    roundtable,
    timeline,
    attention,
    unackedAttention,
    metrics,
    startTeamRuntime,
    stopTeamRuntime,
    toggleTeamMode,
    refresh,

    // ---- Projected state / view state the roundtable surfaces read ----
    lastError,
    teamName,
    lifecycle,
    orderedMode,
    seats,
    seatList,
    activeSeats,
    openItems: openItemList,
    deliverables: deliverableVersions,
    pendingPermissions,
    exitRequests,
    pendingProtocolCount,
    currentActivity,
    focusedSeatId,
    focusedSeat,
    mutedThreads,
    seatEvents,
    legacyNotice,
    recordCorruptNotice,
    userSeatId: USER_SEAT_ID,

    // ---- Actions ----
    subscribeToEvents,
    createRoundtable,
    postUserMessage,
    setOrderedMode,
    pause,
    resume,
    stopRoundtable,
    addSeat,
    removeSeat,
    updateSeatAuth,
    wakeSeat,
    muteThread,
    requestWrapUp,
    reviseDeliverable,
    stanceOnDeliverable,
    exportMarkdown,
    buildHandoff,
    ackAttention,
    respondPermission,
    respondExit,
    setSettings,
    downgradeModels,
    listPresets,
    savePreset,
    deletePreset,
    refreshOpenItems,
    refreshDeliverables,
    refreshInbox,
    dismissLegacyNotice,
    dismissRecordCorruptNotice,
    focusSeat,
    clearFocus,
    clearError,
  };
});
