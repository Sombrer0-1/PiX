import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createVuetify } from "vuetify/dist/vuetify.js";
import type { PixApi } from "../../main/preload";
import CenterPanel from "../components/layout/CenterPanel.vue";
import { useSessionStore } from "../stores/session-store";

vi.mock("../composables/useWorkspaceRpc", () => ({
  useWorkspaceRpc: () => ({
    sessionState: { value: { model: { provider: "test", id: "reasoning-model" }, thinkingLevel: "high" } },
    availableModels: { value: [{ provider: "test", id: "reasoning-model", reasoning: true }] },
    isConnected: { value: false },
    isStreaming: { value: false },
    stopRequested: { value: false },
    executionEnvironment: { value: null },
    commands: { value: [] },
  }),
}));

let wrapper: VueWrapper | undefined;

beforeEach(() => {
  const pinia = createPinia();
  setActivePinia(pinia);
  window.pixApi = {
    sendPlanCommand: vi.fn().mockResolvedValue({ success: true }),
    sendTodoCommand: vi.fn().mockResolvedValue({ success: true }),
    onPlanEvent: () => () => {},
    onWorkflowEvent: () => () => {},
    onTodoEvent: () => () => {},
  } as unknown as PixApi;
  useSessionStore().displayBlocks = [{
    id: "history-thinking",
    type: "thinking",
    content: "历史会话中的思考过程",
    phase: "ended",
    superseded: true,
    timestamp: 1,
  }];
  wrapper = mount(CenterPanel, {
    attachTo: document.body,
    props: {
      pendingUserInput: null,
      currentQuestionIndex: 0,
      currentAnswer: "",
      currentQuestion: null,
      totalQuestions: 0,
      answeredSummary: [],
    },
    global: { plugins: [pinia, createVuetify()] },
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("composer selector focus with historical thinking blocks", () => {
  it("keeps repeated model open/close focus out of the transcript without scrolling", async () => {
    await flushPromises();
    const page = wrapper!;
    const history = page.get<HTMLButtonElement>(".session-content .thinking-header");
    const historyFocus = vi.spyOn(history.element, "focus");
    const trigger = page.get<HTMLButtonElement>(".model-btn");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    for (let iteration = 0; iteration < 5; iteration++) {
      trigger.element.focus();
      await trigger.trigger("click");
      await flushPromises();
      expect(document.activeElement).toBe(page.get(".model-selector .search-input").element);
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
      await trigger.trigger("click");
      await flushPromises();
      expect(document.activeElement).toBe(trigger.element);
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    }
    expect(historyFocus).not.toHaveBeenCalled();
  });

  it.each(["model", "thinking"])("wraps %s selector keyboard focus inside its own panel and restores it on Escape", async (selector) => {
    await flushPromises();
    const page = wrapper!;
    const trigger = page.get<HTMLButtonElement>(`.${selector}-btn`);
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(trigger.attributes('aria-haspopup')).toBe('dialog');
    trigger.element.focus();
    await trigger.trigger("click");
    await flushPromises();
    const panel = page.get(`.${selector}-selector`);
    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(panel.find('[role="dialog"]').exists()).toBe(true);
    expect(panel.element.contains(document.activeElement)).toBe(true);
    const controls = panel.findAll<HTMLElement>("button:not(:disabled), input:not(:disabled)");
    const first = controls[0];
    const last = controls[controls.length - 1];
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    last.element.focus();
    await last.trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(first.element);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    await first.trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last.element);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    await last.trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(page.find(`.${selector}-selector`).exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });
});
