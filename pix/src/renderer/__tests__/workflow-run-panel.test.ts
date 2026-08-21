/**
 * WorkflowRunPanel tests + session-store replay assertions (PiX 1.4.3, stage S11).
 *
 * Acceptance: the SessionView toolName branch mounts the panel for
 * workflow/ralph; running is forced expanded with no toggle button; completed
 * is collapsible; member click calls agent-task-store.selectTask; session-store
 * replay keeps { content, details } for workflow/ralph; a landed isError
 * result without a stopReason renders interrupted; an empty snapshot renders
 * 无记录 without throwing. The panel reads the real workflow store (fallback
 * for interrupted runs), so the harness stubs window.pixApi like
 * workflow-store.test.ts and feeds upsert events through the onWorkflowEvent
 * callback. No Electron runtime is loaded.
 *
 * Run with: npm exec vitest run src/renderer/__tests__/workflow-run-panel.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { WORKFLOW_RECORD_SCHEMA_VERSION, WorkflowRunId } from "@shared/workflow-types.js";
import type {
  WorkflowEvent,
  WorkflowMemberState,
  WorkflowToolDetails,
  WorkflowViewState,
} from "@shared/workflow-types.js";
import type { AgentMessage } from "@/types/rpc";
import type { PixApi } from "../../main/preload";
import WorkflowRunPanel from "../components/session/WorkflowRunPanel.vue";
import { useAgentTaskStore } from "../stores/agent-task-store";
import { useSessionStore } from "../stores/session-store";
import { useWorkflowStore } from "../stores/workflow-store";

// ============================================================================
// Fixtures
// ============================================================================

function makeMember(overrides?: Partial<WorkflowMemberState>): WorkflowMemberState {
  return {
    seq: 1,
    label: "audit pkg",
    childId: "task-1",
    ...overrides,
  };
}

function makeView(overrides?: Partial<WorkflowViewState>): WorkflowViewState {
  return {
    runId: WorkflowRunId("run-1"),
    toolCallId: "tc-1",
    toolName: "workflow",
    name: "audit-all",
    members: [],
    logs: [],
    status: "running",
    ...overrides,
  };
}

function makeDetails(view: WorkflowViewState): WorkflowToolDetails {
  return {
    kind: "pix-workflow-run",
    schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
    view,
    value: null,
    agentsStarted: view.members.length,
  };
}

/** A landed tool result carrying workflow details (live or replayed). */
function resultWithDetails(view: WorkflowViewState): unknown {
  return {
    content: [{ type: "text", text: `workflow "${view.name}" status` }],
    details: makeDetails(view),
  };
}

// ============================================================================
// Harness: stub window.pixApi so the real workflow store transport works
// ============================================================================

let sendWorkflowCommand: ReturnType<typeof vi.fn>;
let onWorkflowEvent: ReturnType<typeof vi.fn>;
let workflowEventCallback: ((event: WorkflowEvent) => void) | null;

function installPixApiMock(): void {
  workflowEventCallback = null;
  sendWorkflowCommand = vi.fn().mockResolvedValue({ success: true });
  onWorkflowEvent = vi.fn((callback: (event: WorkflowEvent) => void) => {
    workflowEventCallback = callback;
    return () => {};
  });
  window.pixApi = { sendWorkflowCommand, onWorkflowEvent } as unknown as PixApi;
}

/** Deliver a WorkflowEvent through the currently registered onWorkflowEvent callback. */
function emitUpsert(run: WorkflowViewState): void {
  workflowEventCallback?.({ type: "upsert", run });
}

beforeEach(() => {
  installPixApiMock();
});

// ============================================================================
// Mount helper
// ============================================================================

function mountPanel(props: {
  result?: unknown;
  args?: unknown;
  isError?: boolean;
  toolCallId?: string;
} = {}): {
  wrapper: ReturnType<typeof mount>;
  store: ReturnType<typeof useWorkflowStore>;
  taskStore: ReturnType<typeof useAgentTaskStore>;
} {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useWorkflowStore();
  store.subscribeToEvents();
  const taskStore = useAgentTaskStore();
  const wrapper = mount(WorkflowRunPanel, {
    props: {
      result: props.result ?? null,
      args: props.args ?? {},
      isError: props.isError ?? false,
      toolCallId: props.toolCallId ?? "tc-1",
    },
    global: { plugins: [pinia] },
  });
  return { wrapper, store, taskStore };
}

function statusText(wrapper: ReturnType<typeof mount>): string {
  return wrapper.get('[data-test="wfp-status"]').text();
}

// ============================================================================
// Disclosure
// ============================================================================

describe("disclosure", () => {
  it("running is forced expanded with no toggle button", () => {
    const view = makeView({
      members: [makeMember()],
      currentPhase: "scan",
    });
    const { wrapper } = mountPanel({ result: resultWithDetails(view) });

    expect(statusText(wrapper)).toBe("运行中");
    expect(wrapper.get('[data-test="workflow-run-panel"]').attributes("data-run-status")).toBe("running");
    // Forced open: the body renders without any interaction.
    expect(wrapper.find(".wfp-body").exists()).toBe(true);
    expect(wrapper.find('[data-test="wfp-member"]').exists()).toBe(true);
    // No toggle button at all while running.
    expect(wrapper.find("button.wfp-header").exists()).toBe(false);
    expect(wrapper.find('[data-test="wfp-toggle"]').exists()).toBe(false);
  });

  it("completed is collapsible and starts expanded", async () => {
    const view = makeView({
      status: "completed",
      stopReason: "completed",
      members: [makeMember({ outcome: "completed" })],
    });
    const { wrapper } = mountPanel({ result: resultWithDetails(view) });

    expect(statusText(wrapper)).toBe("已完成");
    const header = wrapper.get("button.wfp-header");
    expect(header.attributes("aria-expanded")).toBe("true");

    await header.trigger("click");
    expect(wrapper.find(".wfp-body").exists()).toBe(false);
    expect(header.attributes("aria-expanded")).toBe("false");

    await header.trigger("click");
    expect(wrapper.find(".wfp-body").exists()).toBe(true);
  });

  it("failed / cancelled / interrupted keep the collapsible SubagentToolView conventions", async () => {
    const failed = mountPanel({
      result: resultWithDetails(makeView({ status: "failed", stopReason: "error", members: [makeMember({ outcome: "failed" })] })),
    });
    expect(statusText(failed.wrapper)).toBe("失败");
    expect(failed.wrapper.find("button.wfp-header").exists()).toBe(true);
    expect(failed.wrapper.find(".wfp-body").exists()).toBe(true);
    await failed.wrapper.get("button.wfp-header").trigger("click");
    expect(failed.wrapper.find(".wfp-body").exists()).toBe(false);

    const cancelled = mountPanel({
      result: resultWithDetails(makeView({ status: "cancelled", stopReason: "cancelled", members: [makeMember({ outcome: "cancelled" })] })),
    });
    expect(statusText(cancelled.wrapper)).toBe("已取消");
    expect(cancelled.wrapper.find("button.wfp-header").exists()).toBe(true);

    const interrupted = mountPanel({
      result: resultWithDetails(makeView({ members: [makeMember()] })),
      isError: true,
    });
    expect(statusText(interrupted.wrapper)).toBe("已中断");
    expect(interrupted.wrapper.find("button.wfp-header").exists()).toBe(true);
  });
});

// ============================================================================
// Interrupted override
// ============================================================================

describe("interrupted override", () => {
  it("a landed isError result without stopReason shows interrupted (replay path)", () => {
    // Replay of an interrupted run: the folded view has no run-end, so the
    // fold status is "running"; the panel override flips it to interrupted.
    const view = makeView({ members: [makeMember()] });
    const { wrapper } = mountPanel({ result: resultWithDetails(view), isError: true });

    expect(statusText(wrapper)).toBe("已中断");
    expect(wrapper.get('[data-test="workflow-run-panel"]').attributes("data-run-status")).toBe("interrupted");
    // Members without an outcome also render interrupted.
    expect(wrapper.get('[data-test="wfp-member"]').attributes("data-member-status")).toBe("interrupted");
  });

  it("a live running update with isError false stays running", () => {
    const view = makeView({ members: [makeMember()] });
    const { wrapper } = mountPanel({ result: resultWithDetails(view), isError: false });

    expect(statusText(wrapper)).toBe("运行中");
    expect(wrapper.get('[data-test="wfp-member"]').attributes("data-member-status")).toBe("running");
  });

  it("falls back to the store when the toolResult has no details (interrupted run)", async () => {
    const view = makeView({
      runId: WorkflowRunId("run-1"),
      toolCallId: "tc-1",
      members: [makeMember()],
    });
    const { wrapper } = mountPanel({ result: null, isError: true });

    // Before the store has anything the panel renders the no-records fallback.
    expect(wrapper.find('[data-test="wfp-no-records"]').exists()).toBe(true);
    expect(statusText(wrapper)).toBe("失败");

    // The session-activation restore feeds the folded view; isError without a
    // stopReason turns it interrupted.
    emitUpsert(view);
    await flushPromises();

    expect(statusText(wrapper)).toBe("已中断");
    expect(wrapper.get('[data-test="wfp-member"]').attributes("data-member-status")).toBe("interrupted");
  });

  it("a completed run restored from the store renders completed", async () => {
    const view = makeView({
      status: "completed",
      stopReason: "completed",
      members: [makeMember({ outcome: "completed" })],
    });
    const { wrapper } = mountPanel({ result: null, isError: false });

    emitUpsert(view);
    await flushPromises();

    expect(statusText(wrapper)).toBe("已完成");
  });
});

// ============================================================================
// Empty snapshot / no records
// ============================================================================

describe("empty snapshot", () => {
  it("renders 无记录 for an empty folded view without throwing", () => {
    const view = makeView(); // no members, no logs
    const { wrapper } = mountPanel({ result: resultWithDetails(view) });

    expect(statusText(wrapper)).toBe("运行中");
    expect(wrapper.get('[data-test="wfp-no-records"]').text()).toBe("无记录");
    expect(wrapper.find('[data-test="wfp-member"]').exists()).toBe(false);
  });

  it("renders the fallback when neither details nor store has a record", () => {
    const { wrapper } = mountPanel({ result: null, args: { meta: { name: "audit-all" } } });

    expect(wrapper.get('[data-test="wfp-no-records"]').text()).toBe("无记录");
    expect(wrapper.get(".wfp-title").text()).toBe("audit-all");
    expect(statusText(wrapper)).toBe("运行中");
  });

  it("shows 失败 for an errored result without any record", () => {
    const { wrapper } = mountPanel({ result: null, isError: true });

    expect(wrapper.get('[data-test="wfp-no-records"]').text()).toBe("无记录");
    expect(statusText(wrapper)).toBe("失败");
  });
});

describe("member failure reason", () => {
  it("renders the folded member error on a failed row", () => {
    const view = makeView({
      status: "completed",
      stopReason: "completed",
      members: [
        makeMember({
          outcome: "failed",
          error: "max_turns: The agent exceeded its turn limit (12).",
        }),
      ],
    });
    const { wrapper } = mountPanel({ result: resultWithDetails(view) });
    expect(wrapper.get('[data-test="wfp-member-error"]').text()).toContain("max_turns");
    expect(wrapper.get('[data-test="wfp-member"]').attributes("data-member-status")).toBe("failed");
  });
});

// ============================================================================
// Member jump
// ============================================================================

describe("member jump", () => {
  it("member click calls agent-task-store.selectTask", async () => {
    // Both members share the "scan" phase; the phase stays forced open because
    // member 1 has no outcome yet, so both jump buttons are visible.
    const view = makeView({
      members: [
        makeMember({ phase: "scan" }),
        makeMember({ seq: 2, label: "audit docs", childId: "task-2", phase: "scan", outcome: "completed" }),
      ],
    });
    const { wrapper, taskStore } = mountPanel({ result: resultWithDetails(view) });

    const buttons = wrapper.findAll('[data-test="wfp-member-jump"]');
    expect(buttons).toHaveLength(2);

    await buttons[1].trigger("click");
    expect(taskStore.selectedTaskId).toBe("task-2");
  });
});

// ============================================================================
// Phase grouping, logs, currentPhase
// ============================================================================

describe("phase grouping", () => {
  it("groups members by phase identity; undefined and empty string are distinct", () => {
    const view = makeView({
      members: [
        makeMember({ seq: 1, label: "a", phase: "scan" }),
        makeMember({ seq: 2, label: "b", phase: "scan", outcome: "completed" }),
        makeMember({ seq: 3, label: "c", outcome: "completed" }),
        makeMember({ seq: 4, label: "d", phase: "", outcome: "completed" }),
      ],
    });
    const { wrapper } = mountPanel({ result: resultWithDetails(view) });

    const phases = wrapper.findAll('[data-test="wfp-phase"]');
    expect(phases).toHaveLength(3);
    expect(phases[0].attributes("data-phase-key")).toBe("value:4:scan");
    expect(phases[1].attributes("data-phase-key")).toBe("missing");
    expect(phases[2].attributes("data-phase-key")).toBe("value:0:");

    // Members stay in append order within their group.
    const labels = phases[0].findAll('[data-test="wfp-member"]').map((row) => row.find(".wfp-member-label").text());
    expect(labels).toEqual(["a", "b"]);

    // A phase with a non-completed member is forced open (no toggle button)...
    expect(phases[0].find("button.wfp-phase-header").exists()).toBe(false);
    // ...while all-completed phases are collapsible.
    expect(phases[1].find("button.wfp-phase-header").exists()).toBe(true);
    expect(phases[2].find("button.wfp-phase-header").exists()).toBe(true);
  });

  it("collapses and reopens an all-completed phase on toggle", async () => {
    const view = makeView({
      status: "completed",
      stopReason: "completed",
      members: [makeMember({ phase: "scan", outcome: "completed" })],
    });
    const { wrapper } = mountPanel({ result: resultWithDetails(view) });

    const phaseHeader = wrapper.get("button.wfp-phase-header");
    expect(phaseHeader.attributes("aria-expanded")).toBe("false");
    expect(wrapper.find('[data-test="wfp-member"]').exists()).toBe(false);

    await phaseHeader.trigger("click");
    expect(phaseHeader.attributes("aria-expanded")).toBe("true");
    expect(wrapper.find('[data-test="wfp-member"]').exists()).toBe(true);
  });

  it("renders currentPhase and capped logs", async () => {
    const view = makeView({
      members: [makeMember({ outcome: "completed" })],
      logs: [{ message: "scanning packages..." }, { message: "done" }],
      currentPhase: "scan",
    });
    const { wrapper } = mountPanel({ result: resultWithDetails(view) });

    expect(wrapper.get(".wfp-current-phase").text()).toBe("当前阶段：scan");

    const logsToggle = wrapper.get("button.wfp-logs-toggle");
    expect(logsToggle.text()).toContain("2 条");
    await logsToggle.trigger("click");
    const lines = wrapper.findAll(".wfp-log-line");
    expect(lines).toHaveLength(2);
    expect(lines[0].text()).toBe("scanning packages...");
    expect(lines[1].text()).toBe("done");
  });
});

// ============================================================================
// session-store replay keeps { content, details } for workflow / ralph
// ============================================================================

describe("session-store replay", () => {
  /** AgentMessage.content only admits { type, text? } blocks; toolCall blocks
   *  carry extra fields the store reads, so the content array is narrowed here. */
  function toolCallContent(name: string): Array<{ type: string; text?: string }> {
    return [
      { type: "toolCall", id: "tc-1", name, arguments: { script: "phase('scan');" } },
    ] as unknown as Array<{ type: string; text?: string }>;
  }

  function replayMessages(toolName: string, details: unknown): AgentMessage[] {
    return [
      {
        role: "assistant",
        content: toolCallContent(toolName),
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName,
        content: [{ type: "text", text: "ok" }],
        isError: false,
        details,
        timestamp: 2,
      },
    ];
  }

  function firstToolResult(): unknown {
    const store = useSessionStore();
    const ws = store.displayBlocks.find((block) => block.type === "work-status");
    if (!ws || ws.type !== "work-status") return undefined;
    return ws.tools[0]?.result;
  }

  it("keeps { content, details } for workflow tool results on replay", () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useSessionStore();
    const details = makeDetails(makeView({ status: "completed", stopReason: "completed" }));

    store.loadMessages(replayMessages("workflow", details));

    expect(firstToolResult()).toEqual({
      content: [{ type: "text", text: "ok" }],
      details,
    });
  });

  it("keeps { content, details } for ralph tool results on replay", () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useSessionStore();
    const details = makeDetails(makeView({ toolName: "ralph", name: "ralph-1", status: "completed", stopReason: "completed" }));

    store.loadMessages(replayMessages("ralph", details));

    expect(firstToolResult()).toEqual({
      content: [{ type: "text", text: "ok" }],
      details,
    });
  });

  it("keeps the legacy content-only shape for other tools on replay", () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useSessionStore();

    store.loadMessages(replayMessages("bash", { not: "kept" }));

    expect(firstToolResult()).toEqual([{ type: "text", text: "ok" }]);
  });

  it("replays an interrupted error result with the details shape intact", () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useSessionStore();
    const details = makeDetails(makeView({ members: [makeMember()] }));

    store.loadMessages([
      {
        role: "assistant",
        content: toolCallContent("workflow"),
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "workflow",
        content: [{ type: "text", text: "workflow run was cancelled" }],
        isError: true,
        details,
        timestamp: 2,
      },
    ]);

    expect(firstToolResult()).toEqual({
      content: [{ type: "text", text: "workflow run was cancelled" }],
      details,
    });
    // The replayed result feeds the panel: isError without a stopReason means
    // the interrupted run lands on the panel as 已中断.
    const { wrapper } = mountPanel({
      result: firstToolResult(),
      isError: true,
    });
    expect(statusText(wrapper)).toBe("已中断");
  });
});
