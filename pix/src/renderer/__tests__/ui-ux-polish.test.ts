import { describe, expect, it, vi, beforeEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { createVuetify } from "vuetify/dist/vuetify.js";
import { formatRelativeDay } from "../utils/relative-day";
import CommandPalette from "../components/input/CommandPalette.vue";
import InputArea from "../components/input/InputArea.vue";
import ProjectOpenDialog from "../components/project/ProjectOpenDialog.vue";
import ToolExecutionBlock from "../components/session/ToolExecutionBlock.vue";
import type { PixApi } from "../../main/preload";

const vuetify = createVuetify();

describe("formatRelativeDay", () => {
  it("uses calendar midnights instead of rolling 24h windows", () => {
    const now = new Date(2026, 10, 5, 1, 0, 0);
    const lateYesterday = new Date(2026, 10, 4, 23, 0, 0).getTime();
    const earlierToday = new Date(2026, 10, 5, 0, 30, 0).getTime();
    expect(formatRelativeDay(lateYesterday, now)).toBe("昨天");
    expect(formatRelativeDay(earlierToday, now)).toBe("今天");
  });
});

describe("InputArea IME", () => {
  it("does not send while composing", async () => {
    const w = mount(InputArea, {
      props: { modelValue: "ni" },
      global: { plugins: [vuetify] },
    });
    await w.get("textarea").trigger("keydown", { key: "Enter", isComposing: true });
    expect(w.emitted("send")).toBeUndefined();
    await w.get("textarea").trigger("keydown", { key: "Enter", isComposing: false });
    expect(w.emitted("send")).toHaveLength(1);
  });
});

describe("CommandPalette IME", () => {
  it("ignores Enter during composition in the capture listener", async () => {
    const w = mount(CommandPalette, {
      props: {
        search: "/",
        commands: [{ name: "help", description: "帮助", source: "builtin" }],
      },
      global: { plugins: [vuetify] },
    });
    const composing = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(composing, "isComposing", { value: true });
    window.dispatchEvent(composing);
    await nextTick();
    expect(w.emitted("select")).toBeUndefined();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await nextTick();
    expect(w.emitted("select")?.[0]).toEqual(["help"]);
    w.unmount();
  });
});

describe("ProjectOpenDialog", () => {
  beforeEach(() => {
    window.pixApi = {
      selectProject: vi.fn().mockResolvedValue(null),
    } as unknown as PixApi;
  });

  const dialogStubs = {
    VDialog: {
      props: ["modelValue"],
      template: '<div class="v-dialog-stub"><slot /></div>',
    },
  };

  it("keeps the dialog open after submit so the parent can show errors", async () => {
    const w = mount(ProjectOpenDialog, {
      props: {
        modelValue: true,
        defaultEnvironment: { kind: "windows" },
        defaultCwd: "/home",
        distros: [],
      },
      global: { plugins: [vuetify], stubs: dialogStubs },
    });
    await flushPromises();
    const pathField = w.find("input");
    expect(pathField.exists()).toBe(true);
    await pathField.setValue("C:/repo/demo");
    await flushPromises();
    const openBtn = w.findAll("button").find((b) => b.text().trim() === "打开");
    expect(openBtn).toBeTruthy();
    await openBtn!.trigger("click");
    expect(w.emitted("open")?.[0]?.[0]).toMatchObject({
      environment: { kind: "windows" },
      physicalPath: "C:/repo/demo",
    });
    expect(w.emitted("update:modelValue")).toBeUndefined();
    w.unmount();
  });

  it("shows the parent error without clearing the typed path", async () => {
    const w = mount(ProjectOpenDialog, {
      props: {
        modelValue: true,
        defaultEnvironment: { kind: "windows" },
        defaultCwd: "/home",
        distros: [],
        error: "目录不存在",
      },
      global: { plugins: [vuetify], stubs: dialogStubs },
    });
    await flushPromises();
    expect(w.text()).toContain("目录不存在");
    w.unmount();
  });
});

describe("ToolExecutionBlock error precedence", () => {
  it("shows failure mark even when streaming flag is still true", () => {
    const w = mount(ToolExecutionBlock, {
      props: {
        toolName: "bash",
        args: { command: "false" },
        result: null,
        isError: true,
        isStreaming: true,
        timestamp: Date.now(),
      },
      global: { plugins: [vuetify] },
    });
    expect(w.find(".error-mark").exists()).toBe(true);
    expect(w.find(".spinner").exists()).toBe(false);
    expect(w.get(".tool-header").attributes("aria-expanded")).toBe("false");
  });
});
