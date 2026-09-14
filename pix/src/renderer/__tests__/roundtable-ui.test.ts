/**
 * Roundtable UI tests (stage S6 acceptance).
 *
 * Demonstrates the three things S6 is judged on, all through the real Pinia
 * store driven by pushed `TeamEvent`s (the renderer is a projection, so nothing
 * here writes discussion state directly):
 *
 * 1. CostStrip surfaces the three `metrics.health` numbers — 发言分布
 *    (speakShare), 证据密度 (evidenceDensity), 打断率 (interruptRate) — plus the
 *    per-seat/total cost facts (FR-10 / AC-22 / PRD §11.12).
 * 2. TeamTimeline renders the three delivery states (已记录 / 待注入 / 已注入,
 *    AC-8) and the long-session collapse 「整理中 N 条」 with a working expand
 *    affordance (FR-2 / FR-6).
 * 3. The store's frozen public surface exists with exactly the four commands
 *    behind `refresh()`, and the forbidden names are absent (source gate).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import type { Pinia } from "pinia";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// Use the pre-bundled dist entry: the ESM lib entry imports per-component CSS
// files, which a Node-side externalized import cannot load in happy-dom.
import { components as vuetifyComponents, createVuetify, directives as vuetifyDirectives } from "vuetify/dist/vuetify.js";
import type { PixApi } from "../../main/preload";
import { useTeamStore } from "../stores/team-store";
import { useWorkspaceRpc } from "../composables/useWorkspaceRpc";
import AllActivityView from "../components/team/AllActivityView.vue";
import AttentionSurface from "../components/team/AttentionSurface.vue";
import CostStrip from "../components/team/CostStrip.vue";
import DeliverablePanel from "../components/team/DeliverablePanel.vue";
import FileChangeSummary from "../components/team/FileChangeSummary.vue";
import RosterSetupDialog from "../components/team/RosterSetupDialog.vue";
import RoundtableComposer from "../components/team/RoundtableComposer.vue";
import TeamDashboard from "../components/team/TeamDashboard.vue";
import TeamProtocolPanel from "../components/team/TeamProtocolPanel.vue";
import TeamTimeline from "../components/team/TeamTimeline.vue";
import ThreadFilter from "../components/team/ThreadFilter.vue";
import WorkerDetailCard from "../components/team/WorkerDetailCard.vue";
import WorkerSessionView from "../components/team/WorkerSessionView.vue";
import WorkerStatusBar from "../components/team/WorkerStatusBar.vue";
import { TIMELINE_OVERFLOW_CAP, deliveryStateLabel } from "../components/team/roundtable-display";
import type { AgentSessionEvent } from "@shared/types.js";
import {
  PERSPECTIVE_TEMPLATES,
  USER_SEAT_ID,
  type AttentionItem,
  type DeliverableVersion,
  type OpenItem,
  type RoundtableMetricsSnapshot,
  type RoundtableState,
  type SeatInfo,
  type TeamEvent,
  type TimelineItem,
} from "@shared/team-types.js";

const vuetify = createVuetify({
  components: { ...vuetifyComponents },
  directives: { ...vuetifyDirectives },
});

let sendTeamCommand: ReturnType<typeof vi.fn>;
let onTeamEvent: ReturnType<typeof vi.fn>;
let setWorkspaceMode: ReturnType<typeof vi.fn>;
let eventCallback: ((event: TeamEvent) => void) | null = null;

function installPixApiMock(): void {
  sendTeamCommand = vi.fn().mockResolvedValue({ success: true, data: null });
  onTeamEvent = vi.fn((callback: (event: TeamEvent) => void) => {
    eventCallback = callback;
    return () => {
      eventCallback = null;
    };
  });
  setWorkspaceMode = vi.fn().mockResolvedValue(undefined);
  window.pixApi = {
    sendTeamCommand,
    onTeamEvent,
    selectChatFiles: vi.fn().mockResolvedValue([]),
    ackLegacyTeamSnapshot: vi.fn().mockResolvedValue({ success: true }),
    setWorkspaceMode,
    // team→solo 切换会真的走一遍 host transport：停团队运行环境、启单人运行环境、
    // 挂监听、拉一次会话数据。这些桩只要不抛，toggle 就会走到写 mode.json 那一步。
    stopTeamRuntime: vi.fn().mockResolvedValue({ success: true }),
    startPi: vi.fn().mockResolvedValue({ success: true }),
    sendCommand: vi.fn().mockResolvedValue({ success: true, data: null }),
    getExecutionEnvironment: vi.fn().mockResolvedValue(null),
    onPiEvent: vi.fn(() => () => {}),
    onPiReady: vi.fn(() => () => {}),
    onPiExit: vi.fn(() => () => {}),
    onPiError: vi.fn(() => () => {}),
    onUserInputRequest: vi.fn(() => () => {}),
  } as unknown as PixApi;
}

/** Push one event exactly like the main process would. */
function push(event: TeamEvent): void {
  if (eventCallback === null) throw new Error("team store is not subscribed");
  eventCallback(event);
}

let pinia: Pinia;

function subscribeStore() {
  pinia = createPinia();
  setActivePinia(pinia);
  const store = useTeamStore();
  store.subscribeToEvents();
  return store;
}

function makeSeat(slug: string, name: string, color: string): SeatInfo {
  return {
    seatId: `${slug}::rt-test`,
    slug,
    name,
    perspective: `${name}的视角`,
    auth: "read_only",
    color,
    status: "idle",
    createdAt: 1,
    statusChangedAt: 1,
  };
}

const seats: SeatInfo[] = [
  makeSeat("sources", "资料", "#2563eb"),
  makeSeat("counterexample", "反例", "#16a34a"),
];

function makeState(): RoundtableState {
  return {
    roundtableId: "rt-test",
    name: "测试圆桌",
    lifecycle: "active",
    createdAt: 1,
    tier: "standard",
    settings: {
      orderedMode: false,
      waitForUserQuestions: false,
      autoContinueAfterCrash: false,
      unattendedGuard: false,
      suggestWrapUp: false,
      orderedReleaseMs: 60_000,
      exitRequestTimeoutMs: 120_000,
      l2: { perSeatPerTurn: 1, minIntervalMs: 30_000, globalWindowMs: 60_000, globalMaxInWindow: 8, consecutiveFuse: 2 },
    },
    seats: Object.fromEntries(seats.map((seat) => [seat.seatId, seat])),
    orderedMode: false,
  };
}

function makeItem(overrides: Partial<TimelineItem> & { id: string; seq: number }): TimelineItem {
  return {
    ts: 1000 + overrides.seq,
    type: "utterance",
    fromId: seats[0].seatId,
    toId: "*",
    text: `第 ${overrides.seq} 条`,
    summary: `第 ${overrides.seq} 条`,
    mentionIds: [],
    ...overrides,
  };
}

function makeDeliverable(): DeliverableVersion {
  return {
    id: "d-1",
    version: 1,
    revision: 1,
    cutoffSeq: 12,
    createdAt: 5000,
    author: seats[0].seatId,
    status: "ready",
    markdown: "# 结论\n\n- 方向可行",
    stances: [{ seatId: seats[1].seatId, stance: "conditional", reason: "先做一个最小验证", confidence: "medium" }],
    sections: {
      conclusions: "方向可行",
      evidenceIndex: "见 #3",
      disagreements: "验证范围",
      nextActions: "做最小验证",
      processIndex: "资料 → 反例",
    },
  };
}

function makeOpenItem(): OpenItem {
  return {
    id: "oi-1",
    subject: "实验口径未定",
    body: "两种口径差别不大，选一个即可",
    status: "open",
    createdAt: 1,
    updatedAt: 2,
  };
}

function makeMetrics(): RoundtableMetricsSnapshot {
  return {
    perSeat: {
      [seats[0].seatId]: { utterances: 4, tokensIn: 1200, tokensOut: 800, cost: 0.0125, durationMs: 65_000 },
      [seats[1].seatId]: { utterances: 2, tokensIn: 300, tokensOut: 200, cost: 0.0031, durationMs: 30_000 },
    },
    totals: { utterances: 6, tokens: 2500, cost: 0.0156, durationMs: 95_000 },
    health: {
      speakShare: { [seats[0].seatId]: 0.5, [seats[1].seatId]: 0.25 },
      evidenceDensity: 0.6,
      interruptRate: 0.125,
    },
  };
}

/** Mount a surface that renders straight from the store projection. */
function mountFromStore(component: Parameters<typeof h>[0], extraProps: Record<string, unknown> = {}) {
  const Host = defineComponent({
    name: "RoundtableHost",
    setup() {
      const store = useTeamStore();
      return () => h(component, { items: store.timeline, seats: store.seats, ...extraProps });
    },
  });
  return mount(Host, { global: { plugins: [pinia, vuetify] } });
}

beforeEach(() => {
  installPixApiMock();
  eventCallback = null;
});

// ============================================================================
// Frozen store surface (S7 contract)
// ============================================================================

describe("team store frozen surface", () => {
  it("exports the frozen public surface and none of the forbidden names", () => {
    const store = subscribeStore();
    for (const key of [
      "teamMode",
      "isLoading",
      "isTeamActive",
      "roundtable",
      "timeline",
      "attention",
      "metrics",
      "startTeamRuntime",
      "stopTeamRuntime",
      "toggleTeamMode",
      "refresh",
    ]) {
      expect(key in store, `missing frozen export ${key}`).toBe(true);
    }
    for (const forbidden of ["fetchTeamHistory", "get_team_history", "leadAgentId", "workerSummaries"]) {
      expect(forbidden in store).toBe(false);
    }
    // The user is a participant, not an LLM seat.
    expect(store.userSeatId).toBe(USER_SEAT_ID);
    expect(store.roundtable).toBeNull();
    expect(store.metrics.health.speakShare).toEqual({});

    // Source gate: the forbidden names must not exist anywhere in the module.
    // vitest runs with the pix directory as root (see vitest.config.ts).
    const source = readFileSync(resolve(process.cwd(), "src/renderer/stores/team-store.ts"), "utf8");
    for (const forbidden of ["fetchTeamHistory", "get_team_history", "leadAgentId", "workerSummaries"]) {
      expect(source.includes(forbidden), `team-store.ts still mentions ${forbidden}`).toBe(false);
    }
    expect(source).toContain("export interface TaggedSessionEvent");
  });

  it("refresh() pulls exactly get_state + get_timeline + get_metrics + get_attention", async () => {
    const store = subscribeStore();
    await store.refresh();
    expect(sendTeamCommand.mock.calls.map((call) => (call[0] as { type: string }).type)).toEqual([
      "get_state",
      "get_timeline",
      "get_metrics",
      "get_attention",
    ]);
  });
});

// ============================================================================
// F5：teamMode 生命周期 / mode.json 回写 / 恢复 ack / token 口径
// ============================================================================

describe("teamMode 生命周期（F5-1 / F5-2）", () => {
  it("keeps teamMode when refresh() finds no roundtable yet (AC-1 入口不弹回 solo)", async () => {
    const store = subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    await nextTick();
    expect(store.roundtable?.roundtableId).toBe("rt-test");
    expect(store.teamMode).toBe(true);

    // 「运行环境起来了、还没 create_roundtable」时 get_state 就是 null：
    // 只清圆桌投影，前台模式不能被「有没有场」推着走。
    await store.refresh();
    expect(store.roundtable).toBeNull();
    expect(store.isTeamActive).toBe(false);
    expect(store.teamMode).toBe(true);
  });

  it("writes mode.json back to solo when the team runtime is swapped for the single one (FR-13)", async () => {
    const store = subscribeStore();
    store.teamMode = true;
    const target = {
      path: "E:/proj",
      physicalPath: "E:/proj",
      name: "proj",
      environment: { kind: "windows" as const },
    };

    const switched = await store.toggleTeamMode(target);

    expect(switched).toBe(true);
    expect(store.teamMode).toBe(false);
    // 不写回 mode.json，下次挂载 / 重启会按 getWorkspaceMode()==="team" 把用户拉回团队。
    expect(setWorkspaceMode).toHaveBeenCalledWith(expect.objectContaining({ physicalPath: "E:/proj" }), "solo");
  });
});

describe("注意力 ack 与恢复（F5-4）", () => {
  it("sends resume after acking a 「确认后继续」 attention, and only for that one", async () => {
    const store = subscribeStore();
    push({
      type: "attention",
      item: { id: "a-crash", ts: 1, kind: "seat_error", text: "重启后已恢复到「暂停」，确认后继续", acked: false, action: "resume" },
    });
    await nextTick();
    await store.ackAttention("a-crash");
    expect(sendTeamCommand.mock.calls.map((call) => (call[0] as { type: string }).type)).toEqual(["ack_attention", "resume"]);

    // 普通提示只是关掉：不能顺带 resume 一个用户想保持暂停的场。
    push({ type: "attention", item: { id: "a-info", ts: 2, kind: "seat_stuck", text: "反例 可能卡住了", acked: false } });
    await nextTick();
    await store.ackAttention("a-info");
    expect(sendTeamCommand.mock.calls.map((call) => (call[0] as { type: string }).type)).toEqual([
      "ack_attention",
      "resume",
      "ack_attention",
    ]);
  });
});

describe("team 模式 token 口径（F5-5）", () => {
  it("reports total = input + output while cost stays the whole-roundtable total", async () => {
    const store = subscribeStore();
    store.teamMode = true;
    push({ type: "roundtable_created", state: makeState() });
    // totals.tokens 含 aux 整理会话（3100），与 perSeat 之和（1200+300+800+200=2500）不同：
    // 同一张卡片必须自洽，total 只能取分项之和；cost 仍取整场口径（FR-10）。
    const snapshot = makeMetrics();
    snapshot.totals = { ...snapshot.totals, tokens: 3100 };
    push({ type: "metrics", snapshot });
    await nextTick();

    const stats = useWorkspaceRpc().sessionStats.value;
    expect(stats).not.toBeNull();
    expect(stats?.tokens.input).toBe(1500);
    expect(stats?.tokens.output).toBe(1000);
    expect(stats?.tokens.total).toBe(2500);
    expect(stats?.cost).toBe(snapshot.totals.cost);
  });
});

// ============================================================================
// Event projection → group chat
// ============================================================================

describe("store projection", () => {
  it("writes timeline / attention / metrics only from pushed events", async () => {
    const store = subscribeStore();
    push({ type: "roundtable_created", state: makeState() });

    // delivery_changed may arrive before its timeline_item: the projection must
    // still surface it once the record lands.
    push({ type: "delivery_changed", messageId: "m-1", seatId: seats[1].seatId, state: "injected" });
    push({ type: "timeline_item", item: makeItem({ id: "m-1", seq: 1, type: "user", fromId: "user", toId: "*" }) });
    push({ type: "attention", item: { id: "a-1", ts: 5, kind: "wrap_up_ready", text: "可以整理一版", acked: false } as AttentionItem });
    push({ type: "metrics", snapshot: makeMetrics() });

    await nextTick();
    expect(store.timeline).toHaveLength(1);
    expect(store.timeline[0].deliveryBySeat?.[seats[1].seatId]).toBe("injected");
    expect(store.attention).toHaveLength(1);
    expect(store.unackedAttention).toHaveLength(1);
    expect(store.metrics.health.evidenceDensity).toBe(0.6);
    expect(store.isTeamActive).toBe(true);
  });
});

// ============================================================================
// AC-8: the three delivery states
// ============================================================================

describe("TeamTimeline delivery states (AC-8)", () => {
  it("renders 已记录 / 待注入 / 已注入 for one record", async () => {
    const store = subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    push({
      type: "timeline_item",
      item: makeItem({
        id: "m-1",
        seq: 1,
        type: "user",
        fromId: "user",
        toId: "*",
        text: "大家看下这个方向",
        deliveryBySeat: { [seats[0].seatId]: "pending_inject", [seats[1].seatId]: "injected" },
      }),
    });
    await nextTick();

    const wrapper = mountFromStore(TeamTimeline);
    await nextTick();

    // 已记录 is implied by the record itself; the two per-seat chips spell out
    // 待注入 / 已注入 (落盘成功 ≠ 模型已看到).
    const recorded = wrapper.find('[data-test="delivery-recorded"]');
    expect(recorded.exists()).toBe(true);
    expect(recorded.text()).toContain("已记录");

    const pending = wrapper.find('[data-test="delivery-pending_inject"]');
    expect(pending.exists()).toBe(true);
    expect(pending.text()).toContain("待注入");
    expect(pending.text()).toContain("资料");

    const injected = wrapper.find('[data-test="delivery-injected"]');
    expect(injected.exists()).toBe(true);
    expect(injected.text()).toContain("已注入");
    expect(injected.text()).toContain("反例");

    wrapper.unmount();
  });

  it("shows the user and the seats interleaved without any lead row (群聊混排)", async () => {
    subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    push({ type: "timeline_item", item: makeItem({ id: "m-1", seq: 1, type: "user", fromId: "user", toId: "*", text: "开始吧" }) });
    push({ type: "timeline_item", item: makeItem({ id: "m-2", seq: 2, fromId: seats[0].seatId, toId: "*", text: "先核对资料" }) });
    push({ type: "timeline_item", item: makeItem({ id: "m-3", seq: 3, fromId: seats[1].seatId, toId: seats[0].seatId, text: "@资料 我找一个反例" }) });
    await nextTick();

    const wrapper = mountFromStore(TeamTimeline);
    await nextTick();

    expect(wrapper.findAll('[data-test^="timeline-item-"]')).toHaveLength(3);
    expect(wrapper.text()).toContain("用户");
    expect(wrapper.text()).toContain("资料");
    expect(wrapper.text()).toContain("反例");
    expect(wrapper.text()).not.toContain("负责人");
    expect(wrapper.html()).not.toContain("leadAgentId");

    wrapper.unmount();
  });

  it("renders a multi-line system notice in full, not just its first line (原文优先)", async () => {
    subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    // 开场公告是 system 记录：text 是多行原文，summary 只是首行摘要。时间线是
    // 记录面，用 summary 渲染会把议题与硬停止告知整段吃掉。
    push({
      type: "timeline_item",
      item: makeItem({
        id: "m-1",
        seq: 1,
        type: "system",
        fromId: "user",
        toId: "*",
        text: "圆桌讨论开始。\n\n议题：复现问题\n\n硬停止：成本上限 2 USD",
        summary: "圆桌讨论开始。",
      }),
    });
    await nextTick();

    const wrapper = mountFromStore(TeamTimeline);
    await nextTick();
    const item = wrapper.find('[data-test="timeline-item-m-1"]');
    expect(item.text()).toContain("圆桌讨论开始。");
    expect(item.text()).toContain("议题：复现问题");
    expect(item.text()).toContain("硬停止：成本上限 2 USD");

    wrapper.unmount();
  });

  it("renders a private message as a stub without the body (私密痕迹)", async () => {
    subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    push({
      type: "timeline_item",
      item: makeItem({
        id: "m-1",
        seq: 1,
        type: "private_stub",
        fromId: "user",
        toId: seats[0].seatId,
        text: "",
        summary: "私密消息 → 资料",
        privateStub: { fromId: "user", toId: seats[0].seatId },
        deliveryBySeat: { [seats[0].seatId]: "pending_inject" },
      }),
    });
    await nextTick();

    const wrapper = mountFromStore(TeamTimeline);
    await nextTick();
    const item = wrapper.find('[data-test="timeline-item-m-1"]');
    expect(item.text()).toContain("私密消息：正文只在该席位的收件箱里");
    expect(item.find('[data-test="timeline-text"]').exists()).toBe(false);
    expect(item.find('[data-test="delivery-pending_inject"]').exists()).toBe(true);

    wrapper.unmount();
  });
});

// ============================================================================
// FR-2 / FR-6: 整理中 N 条
// ============================================================================

describe("TeamTimeline long-session collapse", () => {
  it("collapses the older prefix to 「整理中 N 条」 and expands on demand", async () => {
    subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    const total = TIMELINE_OVERFLOW_CAP + 7;
    for (let seq = 1; seq <= total; seq++) {
      push({ type: "timeline_item", item: makeItem({ id: `m-${seq}`, seq, fromId: seats[seq % 2].seatId }) });
    }
    await nextTick();

    const wrapper = mountFromStore(TeamTimeline);
    await nextTick();

    // Only the newest window renders; the older prefix is one click away.
    expect(wrapper.findAll('[data-test^="timeline-item-"]')).toHaveLength(TIMELINE_OVERFLOW_CAP);
    const toggle = wrapper.find('[data-test="timeline-overflow-toggle"]');
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain(`整理中 ${total - TIMELINE_OVERFLOW_CAP} 条`);
    expect(wrapper.find('[data-test="timeline-render-note"]').text()).toContain(`${TIMELINE_OVERFLOW_CAP} / ${total} 条`);

    await toggle.trigger("click");
    await nextTick();

    // 展开后原文一条不少（记录零丢失).
    expect(wrapper.findAll('[data-test^="timeline-item-"]')).toHaveLength(total);
    expect(wrapper.find('[data-test="timeline-item-m-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="timeline-collapse-toggle"]').exists()).toBe(true);

    wrapper.unmount();
  });
});

// ============================================================================
// FR-10 / AC-22 / PRD §11.12: 成本 + 讨论体检
// ============================================================================

describe("CostStrip", () => {
  it("surfaces the three metrics.health numbers plus the cost facts", async () => {
    const store = subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    push({ type: "metrics", snapshot: makeMetrics() });
    await nextTick();

    const wrapper = mountFromStore(CostStrip, { items: undefined, seats: undefined });
    await nextTick();

    // 发言分布（speakShare）：每席 share 都渲染出来
    const shares = wrapper.findAll('[data-test="health-speak-share-item"]');
    const shareText = shares.map((node) => node.text()).join(" | ");
    expect(shareText).toContain("资料 50%");
    expect(shareText).toContain("反例 25%");

    // 证据密度 / 打断率
    expect(wrapper.find('[data-test="health-evidence-density"]').text()).toBe("60%");
    expect(wrapper.find('[data-test="health-interrupt-rate"]').text()).toBe("13%");

    // 每席与合计的 token / 成本 / 时长
    expect(wrapper.find('[data-test="cost-total-tokens"]').text()).toBe("2.5k");
    expect(wrapper.find('[data-test="cost-total-cost"]').text()).toBe("$0.02");
    expect(wrapper.find('[data-test="cost-total-utterances"]').text()).toBe("6");
    expect(wrapper.find('[data-test="cost-total-duration"]').text()).toBe("1 分");
    expect(wrapper.findAll('[data-test="cost-seat-row"]')).toHaveLength(2);
    expect(store.metrics.health.speakShare[seats[0].seatId]).toBe(0.5);

    wrapper.unmount();
  });
});

// ============================================================================
// The rest of the S6 surfaces render from the same projection
// ============================================================================

describe("roundtable surfaces", () => {
  /** Populate the store the way a live roundtable would look. */
  async function seedRoundtable() {
    const store = subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    push({ type: "timeline_item", item: makeItem({ id: "m-1", seq: 1, type: "user", fromId: "user", toId: "*", text: "开始吧" }) });
    push({
      type: "timeline_item",
      item: makeItem({ id: "m-2", seq: 2, fromId: seats[0].seatId, toId: "*", threadId: "th-1", text: "核对了一下资料" }),
    });
    push({
      type: "timeline_item",
      item: makeItem({
        id: "m-3",
        seq: 3,
        type: "thread_promo",
        fromId: seats[0].seatId,
        toId: "*",
        text: "方向可行，先做最小验证",
        summary: "线程 th-1 结论上浮：方向可行，先做最小验证",
      }),
    });
    push({ type: "attention", item: { id: "a-1", ts: 5, kind: "permission", seatId: seats[0].seatId, refId: "p-1", text: "资料请求使用 edit", acked: false } });
    push({ type: "attention", item: { id: "a-2", ts: 6, kind: "seat_stuck", seatId: seats[1].seatId, text: "反例 可能卡住了", acked: false } });
    push({ type: "open_item", item: makeOpenItem() });
    push({ type: "deliverable", item: makeDeliverable() });
    push({ type: "metrics", snapshot: makeMetrics() });
    push({ type: "protocol_permission_request", request: { id: "p-1", teamName: "测试圆桌", agentId: seats[0].seatId, tool: "edit", args: {}, status: "pending", createdAt: 5, updatedAt: 5 } });
    push({ type: "seat_status", seatId: seats[0].seatId, status: "speaking", activity: "正在读文件" });
    const toolStart: AgentSessionEvent = { type: "tool_execution_start", toolCallId: "t-1", toolName: "read", args: { path: "README.md" } };
    push({ type: "seat_event", seatId: seats[0].seatId, event: toolStart });
    await nextTick();
    return store;
  }

  function mountDirect(component: Parameters<typeof mount>[0], props: Record<string, unknown> = {}) {
    return mount(component, { props, global: { plugins: [pinia, vuetify] } });
  }

  it("TeamDashboard is the workbench: timeline + attention + open items + deliverables + changes", async () => {
    await seedRoundtable();
    const wrapper = mountDirect(TeamDashboard);
    await nextTick();

    expect(wrapper.find('[data-test="team-dashboard"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="team-timeline"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="roundtable-composer"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="attention-surface"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="open-items"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="deliverable-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="seat-detail-card"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="thread-filter"]').exists()).toBe(true);

    // 变更 tab keeps the aggregated FileChangeSummary one click away.
    await wrapper.find('[data-test="workbench-tab-changes"]').trigger("click");
    await nextTick();
    expect(wrapper.find('[data-test="file-change-summary"]').exists()).toBe(true);

    // 活动 tab shows the seat tool activity (focused seat) or the merged stream.
    await wrapper.find('[data-test="workbench-tab-activity"]').trigger("click");
    await nextTick();
    expect(wrapper.find('[data-test="all-activity-view"], [data-test="seat-session-view"], [data-test="all-activity"]').exists()).toBe(true);

    wrapper.unmount();
  });

  it("WorkerStatusBar is a peer seat strip (no leader chip)", async () => {
    await seedRoundtable();
    const wrapper = mountDirect(WorkerStatusBar);
    await nextTick();

    expect(wrapper.find('[data-test="seat-status-bar"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="seat-chip-sources"]').text()).toContain("资料");
    expect(wrapper.find('[data-test="seat-chip-counterexample"]').text()).toContain("反例");
    expect(wrapper.text()).not.toContain("负责人");

    wrapper.unmount();
  });

  it("WorkerDetailCard shows 视角 / 授权 / 状态 / 打断记录", async () => {
    const store = await seedRoundtable();
    store.focusSeat(seats[1].seatId);
    push({ type: "timeline_item", item: makeItem({ id: "m-4", seq: 4, fromId: "user", toId: seats[1].seatId, text: "先停一下", interrupt: "L2" }) });
    await nextTick();

    const wrapper = mountDirect(WorkerDetailCard);
    await nextTick();

    expect(wrapper.find('[data-test="seat-auth-value"]').text()).toBe("只读");
    expect(wrapper.text()).toContain("反例的视角");
    expect(wrapper.find('[data-test="seat-interrupt-record"]').text()).toContain("打断");
    expect(wrapper.text()).not.toContain("经负责人协调");

    wrapper.unmount();
  });

  it("AttentionSurface lists entries and acks them one by one", async () => {
    const store = await seedRoundtable();
    const wrapper = mountDirect(AttentionSurface);
    await nextTick();

    expect(wrapper.findAll('[data-test="attention-item"]')).toHaveLength(2);
    expect(wrapper.find('[data-test="attention-unacked-count"]').text()).toBe("2");

    // A pending permission stays answerable: the decision buttons are rendered
    // and the entry cannot be buried with a plain "知道了" ack.
    const permission = wrapper.find('[data-test="attention-item"]');
    expect(permission.text()).toContain("待批权限");
    expect(permission.text()).toContain("允许");
    expect(permission.text()).toContain("拒绝");
    expect(permission.find(".attention-ack").exists()).toBe(false);

    // Ordinary entries are ack-able one by one.
    await wrapper.find(".attention-ack").trigger("click");
    await nextTick();
    expect(store.unackedAttention).toHaveLength(1);
    expect(wrapper.findAll('[data-test="attention-item"]')).toHaveLength(1);

    wrapper.unmount();
  });

  it("RoundtableComposer covers broadcast / @ / private / ordered / wrap-up / pause / material", async () => {
    await seedRoundtable();
    const wrapper = mountDirect(RoundtableComposer);
    await nextTick();

    expect(wrapper.find('[data-test="composer-send"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="composer-attach"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("有序模式");
    expect(wrapper.text()).toContain("整理当前方案");
    expect(wrapper.text()).toContain("暂停");
    expect(wrapper.text()).toContain("私密");
    expect(wrapper.text()).toContain("广播（全员可见）");

    wrapper.unmount();
  });

  it("RosterSetupDialog defaults to the five template seats (中文 label)", async () => {
    // happy-dom has no visualViewport; VOverlay's connected strategy reads it.
    vi.stubGlobal("visualViewport", {
      addEventListener: () => {},
      removeEventListener: () => {},
      width: 1024,
      height: 768,
      offsetLeft: 0,
      offsetTop: 0,
      scale: 1,
      pageLeft: 0,
      pageTop: 0,
    });
    subscribeStore();
    const wrapper = mountDirect(RosterSetupDialog, { modelValue: true, mode: "create" });
    await nextTick();
    await nextTick();

    // VOverlay renders the dialog body through a teleport, so query the document.
    expect(document.body.querySelector('[data-test="roster-setup-dialog"]')).not.toBeNull();
    for (const [index, template] of PERSPECTIVE_TEMPLATES.entries()) {
      const seat = document.body.querySelector(`[data-test="roster-seat-${index + 1}"]`);
      expect(seat, `missing default seat ${index + 1}`).not.toBeNull();
      const nameInput = seat?.querySelector("input") as HTMLInputElement | null;
      expect(nameInput?.value).toBe(template.label);
    }
    const text = document.body.textContent ?? "";
    expect(text).toContain("标准 5");
    expect(text).toContain("攻坚 12");
    expect(text).toContain("自定义");

    wrapper.unmount();
  });

  it("DeliverablePanel pins the cutoff, lists versions and stances", async () => {
    await seedRoundtable();
    const wrapper = mountDirect(DeliverablePanel);
    await nextTick();

    expect(wrapper.find('[data-test="deliverable-version-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="deliverable-cutoff"]').text()).toBe("#12");
    expect(wrapper.find('[data-test="deliverable-stances"]').text()).toContain("有条件");
    expect(wrapper.find('[data-test="deliverable-stances"]').text()).toContain("反例");

    wrapper.unmount();
  });

  it("DeliverablePanel disables revise while drafting", async () => {
    const store = subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    push({ type: "deliverable", item: { ...makeDeliverable(), status: "drafting", markdown: "" } });
    await nextTick();
    const wrapper = mountDirect(DeliverablePanel);
    await nextTick();
    expect(wrapper.get('[data-test="deliverable-revise"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
    expect(store.roundtable?.roundtableId).toBe("rt-test");
  });

  it("TeamDashboard surfaces corrupt-record notice and the settings button", async () => {
    await seedRoundtable();
    const store = useTeamStore();
    push({ type: "record_corrupt_notice", text: "圆桌记录损坏：测试" });
    await nextTick();
    expect(store.recordCorruptNotice).toBe("圆桌记录损坏：测试");

    const wrapper = mountDirect(TeamDashboard);
    await nextTick();
    expect(wrapper.get('[data-test="record-corrupt-notice"]').text()).toContain("圆桌记录损坏");
    expect(wrapper.find('[data-test="roundtable-settings"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("ThreadFilter keeps the main line, mutes a thread and floats conclusions up", async () => {
    const store = await seedRoundtable();
    const wrapper = mountDirect(ThreadFilter, { items: store.timeline, selected: null });
    await nextTick();

    expect(wrapper.find('[data-test="thread-main"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="thread-promoted"]').text()).toContain("方向可行，先做最小验证");

    await wrapper.find('[data-test="thread-chip-th-1"] ~ .tf-mute, .tf-mute').trigger("click");
    await nextTick();
    expect(store.mutedThreads).toEqual(["th-1"]);

    wrapper.unmount();
  });

  it("seat-scoped surfaces (activity stream, changes, tool activity) read the projection", async () => {
    const store = await seedRoundtable();
    store.focusSeat(seats[0].seatId);
    await nextTick();

    const activity = mountDirect(AllActivityView);
    await nextTick();
    expect(activity.text()).toContain("资料");
    expect(activity.text()).toContain("开始执行 read");
    activity.unmount();

    const session = mountDirect(WorkerSessionView);
    await nextTick();
    expect(session.find('[data-test="seat-session-view"]').exists()).toBe(true);
    expect(session.text()).toContain("资料");
    expect(session.text()).toContain("read");
    session.unmount();

    const changes = mountDirect(FileChangeSummary);
    await nextTick();
    expect(changes.find('[data-test="file-change-summary"]').exists()).toBe(true);
    changes.unmount();
  });
});

// ============================================================================
// G6：圆桌组件的定向标签 / 可操作注意力 / 席位草稿 / 线程归属 / 成本口径
// ============================================================================

describe("G6 圆桌组件修复", () => {
  function mountDirect(component: Parameters<typeof mount>[0], props: Record<string, unknown> = {}) {
    return mount(component, { props, global: { plugins: [pinia, vuetify] } });
  }

  /** 源码里从 openIndex 处的 `{` 开始的整段花括号正文（含嵌套规则）。 */
  function braceBody(source: string, openIndex: number): string {
    let depth = 0;
    for (let i = openIndex; i < source.length; i++) {
      const char = source[i];
      if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) return source.slice(openIndex + 1, i);
      }
    }
    return source.slice(openIndex + 1);
  }

  it("F6-1 只有 private_stub 标「私密」，公开 @ 单席不是私密（AC-20）", async () => {
    subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    push({
      type: "timeline_item",
      item: makeItem({ id: "m-1", seq: 1, type: "user", fromId: "user", toId: seats[0].seatId, text: "@资料 看下这个" }),
    });
    push({
      type: "timeline_item",
      item: makeItem({
        id: "m-2",
        seq: 2,
        type: "private_stub",
        fromId: "user",
        toId: seats[0].seatId,
        text: "",
        summary: "私密消息 → 资料",
        privateStub: { fromId: "user", toId: seats[0].seatId },
      }),
    });
    await nextTick();

    const wrapper = mountFromStore(TeamTimeline);
    await nextTick();

    // 公开 @单席是全员可见的定向消息，标签必须是 @ 而不是 私密。
    const direct = wrapper.find('[data-test="timeline-item-m-1"]');
    expect(direct.find(".tt-target").text()).toBe("@ → 资料");
    expect(direct.find(".tt-target").text()).not.toContain("私密");

    // 真私密：时间线只留痕迹，标签才是 私密（AC-20）。
    const priv = wrapper.find('[data-test="timeline-item-m-2"]');
    expect(priv.find(".tt-target").text()).toBe("私密 → 资料");

    wrapper.unmount();
  });

  it("U-2 composer 的目标标签：@点名是全员可见，只有私密开关才写「私密」（AC-20）", async () => {
    subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    await nextTick();

    const wrapper = mountDirect(RoundtableComposer);
    await nextTick();
    const targetSelect = wrapper.findAllComponents({ name: "VSelect" })[0];
    const privateSwitch = wrapper.findAllComponents({ name: "VSwitch" })[0];

    // 公开 @单席：同一条消息的发送意图标签必须说「全员可见」。
    targetSelect.vm.$emit("update:modelValue", seats[0].seatId);
    await nextTick();
    expect(wrapper.find(".rc-hint").text()).toContain("@点名（全员可见");
    expect(wrapper.find(".rc-hint").text()).not.toContain("私密");

    // 私密标签只属于私密开关打开的那条路径。
    privateSwitch.vm.$emit("update:modelValue", true);
    await nextTick();
    expect(wrapper.find(".rc-hint").text()).toContain("私密（仅该席位可见");

    wrapper.unmount();
  });

  it("F6-2 答复后注意力卡不再挂着失效按钮（答复即 ack）", async () => {
    const store = subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    push({
      type: "attention",
      item: { id: "a-perm", ts: 5, kind: "permission", seatId: seats[0].seatId, refId: "p-1", text: "资料请求使用 edit", acked: false },
    });
    push({
      type: "protocol_permission_request",
      request: { id: "p-1", teamName: "测试圆桌", agentId: seats[0].seatId, tool: "edit", args: {}, status: "pending", createdAt: 5, updatedAt: 5 },
    });
    await nextTick();

    const wrapper = mountDirect(AttentionSurface);
    await nextTick();
    const card = wrapper.find('[data-test="attention-item"]');
    expect(card.text()).toContain("允许");

    const allow = card.findAll("button").find((node) => node.text().trim() === "允许");
    expect(allow, "missing 允许 button").toBeDefined();
    await allow!.trigger("click");
    await flushPromises();
    await nextTick();

    // 请求离开 pending 队列 + 条目已 ack：默认视图里这张卡整个消失，不可能再点到
    // 已经失效的「允许/拒绝」。
    expect(store.pendingPermissions).toHaveLength(0);
    expect(store.attention.find((item) => item.id === "a-perm")?.acked).toBe(true);
    expect(wrapper.findAll('[data-test="attention-item"]')).toHaveLength(0);

    wrapper.unmount();
  });

  it("F6-2 已失效的权限条目只留「知道了」，不再显示可点的批准按钮", async () => {
    const store = subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    // 恢复出来的场会重放注意力，但不会重放 pending 队列：这条 requestId 已经不在
    // pendingPermissions 里，批准/拒绝点了都是空操作。
    push({
      type: "attention",
      item: { id: "a-stale", ts: 5, kind: "permission", seatId: seats[0].seatId, refId: "p-gone", text: "资料请求使用 edit", acked: false },
    });
    await nextTick();

    const wrapper = mountDirect(AttentionSurface);
    await nextTick();
    const card = wrapper.find('[data-test="attention-item"]');
    expect(card.text()).toContain("待批权限");
    expect(card.text()).not.toContain("允许");

    const ack = card.findAll("button").find((node) => node.text().trim() === "知道了");
    expect(ack, "失效的权限条目应退回普通 ack").toBeDefined();
    await ack!.trigger("click");
    await flushPromises();
    expect(store.attention.find((item) => item.id === "a-stale")?.acked).toBe(true);

    wrapper.unmount();
  });

  it("F6-3 两张退出协商卡的输入互不串台", async () => {
    const store = subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    push({
      type: "attention",
      item: { id: "a-exit-1", ts: 5, kind: "exit_request", seatId: seats[0].seatId, refId: "x-1", text: "反例 请 资料 退出", acked: false },
    });
    push({
      type: "attention",
      item: { id: "a-exit-2", ts: 6, kind: "exit_request", seatId: seats[1].seatId, refId: "x-2", text: "资料 请 反例 退出", acked: false },
    });
    push({
      type: "exit_request",
      request: { id: "x-1", targetSeatId: seats[0].seatId, requestedBy: seats[1].seatId, requestedAt: 5, statements: [], status: "pending" },
    });
    push({
      type: "exit_request",
      request: { id: "x-2", targetSeatId: seats[1].seatId, requestedBy: seats[0].seatId, requestedAt: 6, statements: [], status: "pending" },
    });
    await nextTick();

    const wrapper = mountDirect(AttentionSurface);
    await nextTick();
    const cards = wrapper.findAll('[data-test="attention-item"]');
    expect(cards).toHaveLength(2);

    const inputs = wrapper.findAll('input[type="text"]');
    expect(inputs).toHaveLength(2);
    await inputs[0].setValue("只属于第一张卡");
    await nextTick();
    expect((inputs[0].element as HTMLInputElement).value).toBe("只属于第一张卡");
    expect((inputs[1].element as HTMLInputElement).value).toBe("");

    // 点第二张卡时它自己的输入是空的：不能把第一张卡的说法记到 x-2 的协商上。
    const acceptSecond = cards[1].findAll("button").find((node) => node.text().trim() === "同意退出");
    expect(acceptSecond, "missing 同意退出 button").toBeDefined();
    await acceptSecond!.trigger("click");
    await flushPromises();
    await nextTick();

    const respond = sendTeamCommand.mock.calls
      .map((call) => call[0] as { type: string })
      .find((command) => command.type === "respond_exit");
    expect(respond).toEqual({ type: "respond_exit", requestId: "x-2", statement: "", accept: true });
    // 答复即 ack：答过的卡不留成「未处理」。
    expect(store.attention.find((item) => item.id === "a-exit-2")?.acked).toBe(true);
    expect(store.attention.find((item) => item.id === "a-exit-1")?.acked).toBe(false);

    wrapper.unmount();
  });

  it("F6-4 1400 宽下每席消耗仍渲染（没有静默隐藏的 media query）", async () => {
    subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    push({ type: "metrics", snapshot: makeMetrics() });
    // PiX 默认窗口正是 1400×900：max-width 含等号，这一档必须能看到每席消耗（FR-10）。
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 1400, configurable: true });
    try {
      await nextTick();

      const wrapper = mountDirect(CostStrip);
      await nextTick();
      expect(wrapper.findAll('[data-test="cost-seat-row"]').length).toBeGreaterThanOrEqual(1);

      // happy-dom 不应用 scoped CSS，所以用源码门禁钉住「别再把每席消耗藏起来」。
      // 门禁钉的是行为（@media 里任何 .cost-seat* 的选择器都不许 display:none + 任何
      // .cost-seats 规则自身不许 display:none），不是 1400 这个字面值：换一档 max-width、
      // 把每席行（.cost-seat-row）而不是容器藏起来、或在 media 之外再加一条规则，都要红。
      const source = readFileSync(resolve(process.cwd(), "src/renderer/components/team/CostStrip.vue"), "utf8");
      const style = source.slice(source.indexOf("<style"));
      const mediaBlocks = [...style.matchAll(/@media[^{]*\{/g)].map((match) =>
        braceBody(style, (match.index ?? 0) + match[0].length - 1),
      );
      for (const block of mediaBlocks) {
        expect(
          /\.cost-seat/.test(block) && /display\s*:\s*none/i.test(block),
          `media query hides per-seat spend: ${block.slice(0, 80)}`,
        ).toBe(false);
      }
      // 逐条检查所有 .cost-seats 规则（exec 只看第一条：在 media 之外补第二条同样要红）。
      const seatRules = [...style.matchAll(/\.cost-seats\s*\{/g)];
      expect(seatRules.length, "missing .cost-seats rule").toBeGreaterThan(0);
      for (const rule of seatRules) {
        expect(braceBody(style, (rule.index ?? 0) + rule[0].length - 1), "rule hides .cost-seats").not.toMatch(/display\s*:\s*none/i);
      }

      wrapper.unmount();
    } finally {
      // 别把窗口宽度泄漏给同一文件里后面的用例。
      Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
    }
  });

  it("F6-12 已退出席位在成本条上标「已退出」，数字仍是真实值", async () => {
    const store = subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    push({ type: "metrics", snapshot: makeMetrics() });
    push({ type: "seat_status", seatId: seats[1].seatId, status: "exited" });
    await nextTick();

    const wrapper = mountDirect(CostStrip);
    await nextTick();
    const rows = wrapper.findAll('[data-test="cost-seat-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].find('[data-test="cost-seat-exited"]').exists()).toBe(false);
    expect(rows[1].find('[data-test="cost-seat-exited"]').text()).toBe("已退出");
    // 退出只加标注，不把消耗洗成 0：perSeat 里反例的数字照常显示。
    expect(rows[1].text()).toContain("500 token");
    expect(rows[1].text()).toContain("$0.0031");
    expect(store.metrics.perSeat[seats[1].seatId]?.utterances).toBe(2);

    wrapper.unmount();
  });

  it("F6-5 同席的状态推送不再重置用户正在编辑的授权草稿", async () => {
    const store = subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    store.focusSeat(seats[0].seatId);
    await nextTick();

    const wrapper = mountDirect(WorkerDetailCard);
    await nextTick();
    const select = wrapper.findComponent({ name: "VSelect" });

    select.vm.$emit("update:modelValue", "write");
    await nextTick();
    expect(select.props("modelValue")).toBe("write");
    expect(wrapper.find('[data-test="seat-apply-auth"]').attributes("disabled")).toBeUndefined();

    // seat_status 推送会重建 SeatInfo 对象；席位没换，草稿不能被吃掉（FR-5）。
    push({ type: "seat_status", seatId: seats[0].seatId, status: "speaking", activity: "正在读文件" });
    await nextTick();
    expect(select.props("modelValue")).toBe("write");
    expect(wrapper.find('[data-test="seat-apply-auth"]').attributes("disabled")).toBeUndefined();

    wrapper.unmount();
  });

  it("F6-6 已退出席位的「唤醒 / 移除」被禁用", async () => {
    const store = subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    push({ type: "seat_status", seatId: seats[1].seatId, status: "exited" });
    store.focusSeat(seats[1].seatId);
    await nextTick();

    const wrapper = mountDirect(WorkerDetailCard);
    await nextTick();
    expect(wrapper.find('[data-test="seat-wake"]').attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-test="seat-remove"]').attributes("disabled")).toBeDefined();

    // 对照：没退出的席位照旧可点（禁用是给退出席位的，不是把所有按钮都关掉）。
    store.focusSeat(seats[0].seatId);
    await nextTick();
    expect(wrapper.find('[data-test="seat-wake"]').attributes("disabled")).toBeUndefined();

    wrapper.unmount();
  });

  it("F6-7 空串 threadId 与 undefined 一样算主线", async () => {
    const store = subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    push({ type: "timeline_item", item: makeItem({ id: "m-1", seq: 1, threadId: "", text: "这条属于主线" }) });
    push({ type: "timeline_item", item: makeItem({ id: "m-2", seq: 2, threadId: "th-1", text: "这条属于线程" }) });
    await nextTick();

    const filter = mountDirect(ThreadFilter, { items: store.timeline, selected: null });
    await nextTick();
    expect(filter.find('[data-test="thread-chip-th-1"]').exists()).toBe(true);
    // 主线 chip + th-1 chip；空串不该生成一个点不动的无名 chip。
    expect(filter.findAll(".tf-chip")).toHaveLength(2);
    filter.unmount();

    const dashboard = mountDirect(TeamDashboard);
    await nextTick();
    await dashboard.find('[data-test="thread-chip-th-1"]').trigger("click");
    await nextTick();
    // 选中真实线程后，空串线程的记录仍留在群聊里。
    expect(dashboard.find('[data-test="timeline-item-m-1"]').exists()).toBe(true);
    expect(dashboard.find('[data-test="timeline-item-m-2"]').exists()).toBe(true);
    dashboard.unmount();
  });

  it("F6-8 权限卡理由读顶层 req.reason，args 为空对象时不渲染 {}", async () => {
    subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    push({
      type: "protocol_permission_request",
      request: {
        id: "p-1",
        teamName: "测试圆桌",
        agentId: seats[0].seatId,
        tool: "edit",
        args: { path: "README.md" },
        status: "pending",
        createdAt: 5,
        updatedAt: 5,
        reason: "要改 README 里的结论段",
      },
    });
    push({
      type: "protocol_permission_request",
      request: { id: "p-2", teamName: "测试圆桌", agentId: seats[1].seatId, tool: "bash", args: {}, status: "pending", createdAt: 6, updatedAt: 6 },
    });
    await nextTick();

    const wrapper = mountDirect(TeamProtocolPanel);
    await nextTick();
    const reasons = wrapper.findAll('[data-test="protocol-reason"]');
    // 只有带理由的那张卡有理由行：空 args（也没理由）不显示 "{}"。
    expect(reasons).toHaveLength(1);
    expect(reasons[0].text()).toBe("要改 README 里的结论段");

    wrapper.unmount();
  });

  it("F6-9 席位头部的文件数按 path 去重（与变更 tab 同口径）", async () => {
    const store = subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    store.focusSeat(seats[0].seatId);
    await nextTick();

    const makeChange = (toolCallId: string, path: string): AgentSessionEvent => ({
      type: "file_change",
      toolCallId,
      toolName: "edit",
      change: { path, toolCallId, toolName: "edit", added: 3, removed: 1 },
      aggregate: { files: 1, added: 3, removed: 1, changes: [] },
    });
    push({ type: "seat_event", seatId: seats[0].seatId, event: makeChange("t-1", "src/a.ts") });
    push({ type: "seat_event", seatId: seats[0].seatId, event: makeChange("t-2", "src/a.ts") });
    push({ type: "seat_event", seatId: seats[0].seatId, event: makeChange("t-3", "src/b.ts") });
    await nextTick();

    const wrapper = mountDirect(WorkerSessionView);
    await nextTick();
    expect(wrapper.find('[data-test="seat-file-count"]').text()).toBe("2 个文件");

    wrapper.unmount();
  });

  it("F6-10 目标切回「全员」时私密开关复位", async () => {
    subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    await nextTick();

    const wrapper = mountDirect(RoundtableComposer);
    await nextTick();
    const targetSelect = wrapper.findAllComponents({ name: "VSelect" })[0];
    const privateSwitch = wrapper.findAllComponents({ name: "VSwitch" })[0];

    targetSelect.vm.$emit("update:modelValue", seats[0].seatId);
    await nextTick();
    privateSwitch.vm.$emit("update:modelValue", true);
    await nextTick();
    expect(privateSwitch.props("modelValue")).toBe(true);

    // 切回全员必须复位：否则之后再选席位会静默恢复私密，用户以为在广播。
    targetSelect.vm.$emit("update:modelValue", "*");
    await nextTick();
    expect(privateSwitch.props("modelValue")).toBe(false);

    wrapper.unmount();
  });

  it("F6-11 DeliveryState folded 渲染成「已折叠」", async () => {
    subscribeStore();
    push({ type: "roundtable_created", state: makeState() });
    push({ type: "delivery_changed", messageId: "m-1", seatId: seats[0].seatId, state: "folded" });
    push({ type: "timeline_item", item: makeItem({ id: "m-1", seq: 1, type: "user", fromId: "user", toId: "*", text: "被背压折叠掉的一条" }) });
    await nextTick();

    const wrapper = mountFromStore(TeamTimeline);
    await nextTick();
    const chip = wrapper.find('[data-test="delivery-folded"]');
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toContain("已折叠");
    expect(deliveryStateLabel("folded")).toBe("已折叠");

    wrapper.unmount();
  });
});
