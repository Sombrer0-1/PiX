/**
 * Computer-use UI tests.
 *
 * Acceptance: the toggle sends set_session_enabled on click (hidden while the
 * global switch is off, disabled with the reason tooltip while the driver is
 * not ready), the activity bar shows the action summary + grant level and its
 * stop / revoke buttons send emergency_stop / revoke_grants, ComputerToolDetails
 * renders the screenshot thumbnail and recovers the error code from the text
 * prefix through COMPUTER_USE_ERROR_PATTERN, and ComputerUseSettings shows the
 * install progress plus the privacy copy and attribution.
 *
 * The components talk to main only through the injected store transport, so no
 * Electron runtime and no window.pixApi stub are needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, ref, type Component, type PropType } from "vue";
// Use the pre-bundled dist entry (same as btw-card.test.ts): the ESM lib entry
// imports per-component CSS files that happy-dom cannot load.
import { components as vuetifyComponents, createVuetify, directives as vuetifyDirectives } from "vuetify/dist/vuetify.js";
import type { PixCommandResult } from "@shared/types.js";
import type {
  ComputerUseCommand,
  ComputerUseEvent,
  ComputerUseSessionSnapshot,
  ComputerUseSettings,
  ComputerUseSnapshot,
} from "@shared/computer-use-types.js";
import type { ToolWorkItem } from "@/types/session";
import { useComputerUseStore } from "../stores/computer-use-store";
import ComputerUseToggle from "../components/computer-use/ComputerUseToggle.vue";
import ComputerUseActivityBar from "../components/computer-use/ComputerUseActivityBar.vue";
import ComputerUseSettingsPanel from "../components/settings/ComputerUseSettings.vue";
import ComputerToolDetails from "../components/session/tool-details/ComputerToolDetails.vue";
import { makeComputerUseSession as makeSession, makeStoppedComputerUseSnapshot as makeSnapshot } from "./helpers/computer-use-fixtures";

// ============================================================================
// Harness
// ============================================================================

const vuetify = createVuetify({
  components: { ...vuetifyComponents },
  directives: { ...vuetifyDirectives },
});

function makeTool(overrides?: Partial<ToolWorkItem>): ToolWorkItem {
  return {
    toolCallId: "t-1",
    toolName: "computer_observe",
    args: {},
    result: "",
    isError: false,
    ...overrides,
  };
}

let pinia: ReturnType<typeof createPinia>;
let transport: ReturnType<typeof makeTransport>;
let wrapper: ReturnType<typeof mount> | undefined;

function makeTransport() {
  const commands: ComputerUseCommand[] = [];
  let listener: ((event: ComputerUseEvent) => void) | null = null;
  const sendComputerUseCommand = vi.fn(
    async (command: ComputerUseCommand): Promise<PixCommandResult<ComputerUseSnapshot>> => {
      commands.push(command);
      return { success: true, data: makeSnapshot() };
    },
  );
  const onComputerUseEvent = vi.fn((callback: (event: ComputerUseEvent) => void) => {
    listener = callback;
    return () => {
      listener = null;
    };
  });
  return {
    commands,
    emit: (event: ComputerUseEvent) => listener?.(event),
    sendComputerUseCommand,
    onComputerUseEvent,
  };
}

/**
 * Mount a component with the shared store already subscribed to the fake
 * transport. The store start's get_snapshot response is awaited first so a
 * snapshot emitted by the test is not overwritten by the pending boot response.
 */
async function mountWithStore(component: Component, props?: Record<string, unknown>) {
  const store = useComputerUseStore();
  transport = makeTransport();
  // 预先订阅：组件 onMounted 里的 start() 因幂等直接返回，不会触碰 window.pixApi。
  store.start(transport);
  await flushPromises();
  wrapper = mount(component, {
    global: { plugins: [pinia, vuetify] },
    props,
  });
  return { store, wrapper };
}

/** 最近一次 emit 的首个参数。 */
function lastEmitted(w: ReturnType<typeof mount>, event: string): unknown {
  const entries = w.emitted(event);
  return entries ? entries[entries.length - 1][0] : undefined;
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

// ============================================================================
// ComputerUseToggle
// ============================================================================

describe("ComputerUseToggle", () => {
  it("does not render while the global switch is off", async () => {
    const { store } = await mountWithStore(ComputerUseToggle);
    transport.emit({ type: "snapshot", snapshot: makeSnapshot({ availability: "disabled" }) });
    await flushPromises();

    expect(store.globallyEnabled).toBe(false);
    expect(wrapper!.find(".computer-use-toggle").exists()).toBe(false);
  });

  it("clicking sends set_session_enabled with the flipped value", async () => {
    const { store } = await mountWithStore(ComputerUseToggle);
    transport.emit({
      type: "snapshot",
      snapshot: makeSnapshot({ availability: "ready", session: makeSession({ sessionEnabled: false }) }),
    });
    await flushPromises();

    const button = wrapper!.find(".computer-use-toggle");
    expect(button.exists()).toBe(true);
    expect(store.canToggle).toBe(true);

    await button.trigger("click");

    expect(transport.commands).toContainEqual({ type: "set_session_enabled", enabled: true });
  });

  it("is disabled with the reason while the driver is missing", async () => {
    const { store } = await mountWithStore(ComputerUseToggle);
    transport.emit({ type: "snapshot", snapshot: makeSnapshot({ availability: "driver_missing" }) });
    await flushPromises();

    const button = wrapper!.find(".computer-use-toggle");
    expect(button.exists()).toBe(true);
    expect(button.attributes("disabled")).toBeDefined();
    // 禁用原因经 v-tooltip 展示（按钮不携带 title），断言其数据源。
    expect(store.toggleDisabledReason).toBe("未安装操控驱动，请在设置中安装");
    expect(store.canToggle).toBe(false);
  });

  it("keeps toggling available when only system permissions are missing (warning shown)", async () => {
    const { store } = await mountWithStore(ComputerUseToggle);
    transport.emit({
      type: "snapshot",
      snapshot: makeSnapshot({
        availability: "permission_required",
        platform: "darwin-universal",
        missingPermissions: ["accessibility"],
      }),
    });
    await flushPromises();

    const button = wrapper!.find(".computer-use-toggle");
    expect(button.attributes("disabled")).toBeUndefined();
    expect(wrapper!.find(".computer-use-toggle-warn").exists()).toBe(true);
    // 告警文案经 v-tooltip 展示（按钮不携带 title），断言其数据源。
    expect(store.toggleWarning).toBe("缺少系统权限：辅助功能，请在设置中授权");
    expect(store.canToggle).toBe(true);
  });
});

// ============================================================================
// ComputerUseActivityBar
// ============================================================================

describe("ComputerUseActivityBar", () => {
  async function showBar(storeOverrides?: Partial<ComputerUseSessionSnapshot>) {
    const mounted = await mountWithStore(ComputerUseActivityBar);
    transport.emit({
      type: "snapshot",
      snapshot: makeSnapshot({
        availability: "ready",
        session: makeSession({ sessionEnabled: true, grant: "background", holdsLease: true, ...storeOverrides }),
      }),
    });
    transport.emit({
      type: "activity",
      sessionId: "session-1",
      activity: { toolCallId: "t-1", tool: "act", summary: "点击 记事本 · 保存 按钮", startedAt: 5, state: "running" },
    });
    return mounted;
  }

  it("shows the action summary and the grant level while the session holds the lease", async () => {
    await showBar();
    await flushPromises();

    expect(wrapper!.find(".cu-activity-bar").exists()).toBe(true);
    expect(wrapper!.find(".cu-activity-summary").text()).toBe("点击 记事本 · 保存 按钮");
    expect(wrapper!.find(".cu-activity-grant").text()).toBe("后台授权");
    expect(wrapper!.find(".cu-activity-state").text()).toBe("执行中");
  });

  it("the stop button sends emergency_stop", async () => {
    await showBar();
    await flushPromises();

    await wrapper!.find(".cu-activity-stop").trigger("click");

    expect(transport.commands).toContainEqual({ type: "emergency_stop" });
  });

  it("the revoke button sends revoke_grants and stays disabled without a grant", async () => {
    const { store } = await showBar({ grant: "foreground" });
    await flushPromises();

    const revoke = wrapper!.find(".cu-activity-revoke");
    await revoke.trigger("click");
    expect(transport.commands).toContainEqual({ type: "revoke_grants" });

    transport.emit({
      type: "snapshot",
      snapshot: makeSnapshot({
        availability: "ready",
        session: makeSession({ sessionEnabled: true, grant: "none", holdsLease: true }),
      }),
    });
    await flushPromises();
    expect(store.grant).toBe("none");
    expect(wrapper!.find(".cu-activity-revoke").attributes("disabled")).toBeDefined();
  });

  it("stays hidden while the session switch is off", async () => {
    const { store } = await mountWithStore(ComputerUseActivityBar);
    transport.emit({
      type: "snapshot",
      snapshot: makeSnapshot({ availability: "ready", session: makeSession({ sessionEnabled: false, holdsLease: true }) }),
    });
    await flushPromises();

    expect(store.sessionEnabled).toBe(false);
    expect(wrapper!.find(".cu-activity-bar").exists()).toBe(false);
  });

  it("stays hidden without a lease and shows once an activity arrives", async () => {
    await mountWithStore(ComputerUseActivityBar);
    transport.emit({
      type: "snapshot",
      snapshot: makeSnapshot({
        availability: "ready",
        session: makeSession({ sessionEnabled: true, grant: "none", holdsLease: false, activity: null }),
      }),
    });
    await flushPromises();
    expect(wrapper!.find(".cu-activity-bar").exists()).toBe(false);

    transport.emit({
      type: "activity",
      sessionId: "session-1",
      activity: { toolCallId: "t-9", tool: "observe", summary: "观察 桌面", startedAt: 9, state: "succeeded" },
    });
    await flushPromises();
    expect(wrapper!.find(".cu-activity-bar").exists()).toBe(true);
    expect(wrapper!.find(".cu-activity-summary").text()).toBe("观察 桌面");
  });

  it("hides while the global switch is off even with stale controller state", async () => {
    await mountWithStore(ComputerUseActivityBar);
    // availability "disabled"：主进程可能仍保留 controller 的
    // _sessionEnabled/_holdsLease 残留，活动条必须立即隐藏。
    transport.emit({
      type: "snapshot",
      snapshot: makeSnapshot({
        availability: "disabled",
        session: makeSession({ sessionEnabled: true, grant: "background", holdsLease: true }),
      }),
    });
    await flushPromises();
    expect(wrapper!.find(".cu-activity-bar").exists()).toBe(false);

    // availability 已恢复但会话因全局关闭未激活：同样隐藏。
    transport.emit({
      type: "snapshot",
      snapshot: makeSnapshot({
        availability: "stopped",
        session: makeSession({ sessionEnabled: true, holdsLease: true, inactiveReason: "global_disabled" }),
      }),
    });
    await flushPromises();
    expect(wrapper!.find(".cu-activity-bar").exists()).toBe(false);
  });
});

// ============================================================================
// ComputerToolDetails
// ============================================================================

describe("ComputerToolDetails", () => {
  it("renders the action summary, screenshot thumbnail and screenshot meta from details", () => {
    wrapper = mount(ComputerToolDetails, {
      props: {
        tool: makeTool({
          toolName: "computer_act",
          args: { action: "click", pid: 4242, window_id: 77 },
          result: {
            content: [
              { type: "text", text: "Clicked 保存\n\n[pix] capture_id=c_9 frame=window screenshot=1280x800 grant=background" },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
            details: {
              kind: "act",
              action: "click",
              target: { pid: 4242, windowId: 77, appName: "记事本", windowTitle: "未命名 - 记事本", frame: "window" },
              captureId: "c_9",
              screenshot: { width: 1280, height: 800, mimeType: "image/png", bytes: 212344 },
              grant: "background",
              durationMs: 640,
              driverTool: "click",
            },
          },
        }),
      },
    });

    expect(wrapper.find(".td-cu-summary").text()).toBe("操作 · 点击");
    const thumb = wrapper.find(".td-cu-thumb");
    expect(thumb.exists()).toBe(true);
    expect(thumb.attributes("src")).toBe("data:image/png;base64,aGVsbG8=");
    expect(wrapper.find(".td-cu-shot").text()).toContain("1280×800");
    expect(wrapper.find(".td-cu-target").text()).toContain("记事本");
    expect(wrapper.find(".td-cu-target").text()).toContain("窗口 77");
    expect(wrapper.text()).toContain("后台授权");
    expect(wrapper.find(".td-cu-error-code").exists()).toBe(false);
  });

  it("recovers the error code from the text prefix for error results (no details)", () => {
    wrapper = mount(ComputerToolDetails, {
      props: {
        tool: makeTool({
          toolName: "computer_act",
          isError: true,
          args: { action: "click", pid: 4242, window_id: 77, element_token: "s1a2b3c4d:5" },
          result: {
            content: [
              {
                type: "text",
                text: "[computer_use:stale_reference] Element token expired.\nHint: call computer_observe again.",
              },
            ],
          },
        }),
      },
    });

    const code = wrapper.find(".td-cu-error-code");
    expect(code.exists()).toBe(true);
    expect(code.text()).toBe("错误码 stale_reference");
    // 错误结果没有 details：摘要从 args 降级解析，且没有缩略图。
    expect(wrapper.find(".td-cu-summary").text()).toBe("操作 · 点击");
    expect(wrapper.find(".td-cu-thumb").exists()).toBe(false);
    expect(wrapper.find(".td-cu-text").text()).toContain("[computer_use:stale_reference]");
    // Hint 修复提示位于尾部底栏，始终可见。
    expect(wrapper.find(".td-cu-trailer").text()).toContain("Hint: call computer_observe again.");
  });

  it("does not badge a successful result whose screen text merely starts with the error prefix", () => {
    wrapper = mount(ComputerToolDetails, {
      props: {
        tool: makeTool({
          toolName: "computer_observe",
          args: { view: "desktop" },
          result: {
            content: [
              {
                type: "text",
                text: "[computer_use:driver_error] 窗口标题\n\n[pix] capture_id=c_2 frame=desktop screenshot=omitted:not_requested grant=background",
              },
            ],
          },
        }),
      },
    });

    expect(wrapper.find(".td-cu-error-code").exists()).toBe(false);
  });

  it("keeps the trailing [pix] line and the omission marker visible when the body is truncated", () => {
    const longBody = "屏".repeat(4321);
    wrapper = mount(ComputerToolDetails, {
      props: {
        tool: makeTool({
          toolName: "computer_observe",
          args: { view: "desktop" },
          result: {
            content: [
              {
                type: "text",
                text: `${longBody}\n\n[pix] capture_id=c_long frame=desktop screenshot=omitted:not_requested grant=background effect=applied`,
              },
            ],
          },
        }),
      },
    });

    const omitted = wrapper.find(".td-cu-omitted");
    expect(omitted.exists()).toBe(true);
    expect(omitted.text()).toContain("已省略 321 字符");
    const trailer = wrapper.find(".td-cu-trailer");
    expect(trailer.exists()).toBe(true);
    expect(trailer.text()).toContain("capture_id=c_long");
    expect(trailer.text()).toContain("effect=applied");
    // 主体截断后不再夹带 [pix] 尾行。
    expect(wrapper.find(".td-cu-text").text()).not.toContain("[pix]");
  });

  it("renders an observe view summary and the omitted-screenshot degrade note", () => {
    wrapper = mount(ComputerToolDetails, {
      props: {
        tool: makeTool({
          toolName: "computer_observe",
          args: { view: "window", pid: 7, window_id: 3 },
          result: {
            content: [{ type: "text", text: "window state" }],
            details: {
              kind: "observe",
              view: "window",
              target: { pid: 7, windowId: 3, frame: "window" },
              screenshot: { width: 0, height: 0, mimeType: "image/png", bytes: 0, omitted: "non_vision_model" },
              grant: "background",
              durationMs: 120,
            },
          },
        }),
      },
    });

    expect(wrapper.find(".td-cu-summary").text()).toBe("观察 · 窗口");
    expect(wrapper.find(".td-cu-shot").text()).toBe("截图省略：当前模型不支持图像");
    expect(wrapper.find(".td-cu-thumb").exists()).toBe(false);
  });
});

// ============================================================================
// ComputerUseSettings
// ============================================================================

describe("ComputerUseSettings", () => {
  const mountSettings = (modelValue = { enabled: true }) =>
    mountWithStore(ComputerUseSettingsPanel, { modelValue });

  /**
   * v-model 宿主：像 SettingsPage 一样把 update:modelValue 应用回 prop。
   * Vuetify 字段是受控组件，测试若不回写，第二次输入（如清空）不会发出事件。
   */
  const settingsEmits: ComputerUseSettings[] = [];
  const HostSettings = defineComponent({
    name: "HostSettings",
    props: { initial: { type: Object as PropType<ComputerUseSettings>, required: true } },
    setup(hostProps) {
      const model = ref<ComputerUseSettings>(hostProps.initial);
      return () =>
        h(ComputerUseSettingsPanel, {
          modelValue: model.value,
          "onUpdate:modelValue": (value: ComputerUseSettings) => {
            model.value = value;
            settingsEmits.push(value);
          },
        });
    },
  });
  const mountSettingsVModel = (initial: ComputerUseSettings) => {
    settingsEmits.length = 0;
    return mountWithStore(HostSettings, { initial });
  };
  const lastPatch = () => settingsEmits[settingsEmits.length - 1];

  it("shows the privacy copy next to the global switch", async () => {
    await mountSettings();

    const privacy = wrapper!.find(".cu-privacy");
    expect(privacy.exists()).toBe(true);
    const text = privacy.text();
    expect(text).toContain("截图（明文 base64）与可访问性树文本会写入本机会话 JSONL");
    expect(text).toContain("会作为上下文发送给当前模型提供方");
    expect(text).toContain("会话 HTML 导出会连带包含这些截图");
  });

  it("renders the install progress phase and percentage", async () => {
    await mountSettings();
    transport.emit({
      type: "install_progress",
      progress: { phase: "downloading", receivedBytes: 5_000_000, totalBytes: 31_346_745 },
    });
    await flushPromises();

    expect(wrapper!.find(".cu-install-label").text()).toBe("正在下载操控驱动 16%");
    expect(wrapper!.find(".cu-install-bar").exists()).toBe(true);
  });

  it("shows the install failure with its error text", async () => {
    await mountSettings();
    transport.emit({
      type: "install_progress",
      progress: { phase: "failed", receivedBytes: 100, totalBytes: 200, error: "校验失败，已拒绝安装" },
    });
    await flushPromises();

    expect(wrapper!.find(".cu-install-error").text()).toContain("校验失败，已拒绝安装");
  });

  it("emits update:modelValue when the form fields change", async () => {
    await mountSettings({ enabled: false });

    await wrapper!.find("#setting-computerUseEnabled").setValue(true);
    expect(lastEmitted(wrapper!, "update:modelValue")).toEqual({ enabled: true });

    await wrapper!.find("#setting-computerUseMaxImageDimension").setValue("2048");
    expect(lastEmitted(wrapper!, "update:modelValue")).toEqual({
      enabled: false,
      maxImageDimension: 2048,
    });
  });

  it("emits driverPath trimmed and clears it back to undefined on blank input", async () => {
    await mountSettingsVModel({ enabled: false });

    await wrapper!.find("#setting-computerUseDriverPath").setValue("  C:\\tools\\cua-driver.exe  ");
    expect(lastPatch()).toEqual({
      enabled: false,
      driverPath: "C:\\tools\\cua-driver.exe",
    });

    await wrapper!.find("#setting-computerUseDriverPath").setValue("   ");
    expect(lastPatch()).toEqual({ enabled: false, driverPath: undefined });
  });

  it("strips one layer of surrounding double quotes from a pasted driver path", async () => {
    await mountSettingsVModel({ enabled: false });

    await wrapper!.find("#setting-computerUseDriverPath").setValue('"C:\\tools\\cua-driver.exe"');
    expect(lastPatch()).toEqual({
      enabled: false,
      driverPath: "C:\\tools\\cua-driver.exe",
    });
  });

  it("rounds the numeric fields and falls back to undefined on blank input", async () => {
    await mountSettingsVModel({ enabled: false });

    await wrapper!.find("#setting-computerUseScreenshotMaxBytes").setValue("500000");
    expect(lastPatch()).toEqual({ enabled: false, screenshotMaxBytes: 500000 });
    await wrapper!.find("#setting-computerUseScreenshotMaxBytes").setValue("");
    expect(lastPatch()).toEqual({ enabled: false, screenshotMaxBytes: undefined });

    await wrapper!.find("#setting-computerUseKeepRecentScreenshots").setValue("6");
    expect(lastPatch()).toEqual({ enabled: false, keepRecentScreenshots: 6 });
    await wrapper!.find("#setting-computerUseKeepRecentScreenshots").setValue("abc");
    expect(lastPatch()).toEqual({ enabled: false, keepRecentScreenshots: undefined });
  });

  it("shows the Wayland note from linuxDisplayServer before the driver reports degradation", async () => {
    await mountSettings({ enabled: true });
    transport.emit({
      type: "snapshot",
      snapshot: makeSnapshot({ platform: "linux-x64", availability: "stopped", linuxDisplayServer: "wayland" }),
    });
    await flushPromises();

    const note = wrapper!.find(".cu-platform-note");
    expect(note.exists()).toBe(true);
    expect(note.text()).toContain("检测到 Wayland 会话");

    // 驱动启动后叠加 degraded 提示，两条文案可区分。
    transport.emit({
      type: "snapshot",
      snapshot: makeSnapshot({
        platform: "linux-x64",
        availability: "stopped",
        linuxDisplayServer: "wayland",
        degradedCapabilities: ["background_input"],
      }),
    });
    await flushPromises();
    const both = wrapper!.find(".cu-platform-note").text();
    expect(both).toContain("检测到 Wayland 会话");
    expect(both).toContain("驱动报告");
  });

  it("lists permissions the driver did not report as non-blocking unknowns", async () => {
    await mountSettings({ enabled: true });
    transport.emit({
      type: "snapshot",
      snapshot: makeSnapshot({
        availability: "permission_required",
        platform: "darwin-universal",
        missingPermissions: ["accessibility"],
        permissionUndecided: ["screen_recording"],
      }),
    });
    await flushPromises();

    const note = wrapper!.find(".cu-permission-undecided");
    expect(note.exists()).toBe(true);
    expect(note.text()).toBe("以下权限状态无法确认：屏幕录制（不阻断使用）");
  });

  it("still infers the driver install state while the global switch is off", async () => {
    await mountSettings({ enabled: true });
    transport.emit({
      type: "snapshot",
      snapshot: makeSnapshot({ availability: "disabled" }),
    });
    await flushPromises();

    expect(wrapper!.find(".cu-driver-badge").text()).toBe("全局未开启");
    expect(wrapper!.find(".cu-driver").text()).toContain("已安装 cua-driver v0.34.1（托管）");
    // 安装按钮保持不可用（disabled 下不渲染）。
    expect(wrapper!.find(".cu-install-btn").exists()).toBe(false);

    transport.emit({
      type: "snapshot",
      snapshot: makeSnapshot({
        availability: "disabled",
        driver: { version: null, source: null, path: null, expectedVersion: "0.34.1" },
      }),
    });
    await flushPromises();
    expect(wrapper!.find(".cu-driver").text()).toContain("驱动未安装");
    expect(wrapper!.find(".cu-install-btn").exists()).toBe(false);
  });

  it("runs the driver actions through the store", async () => {
    await mountSettings({ enabled: true });
    transport.emit({
      type: "snapshot",
      snapshot: makeSnapshot({ availability: "driver_missing", driver: { version: null, source: null, path: null, expectedVersion: "0.34.1" } }),
    });
    await flushPromises();

    await wrapper!.find(".cu-install-btn").trigger("click");
    expect(transport.commands).toContainEqual({ type: "install_driver" });

    await wrapper!.find(".cu-recheck-btn").trigger("click");
    expect(transport.commands).toContainEqual({ type: "recheck_driver" });
  });

  it("offers the macOS permission buttons and the attribution link", async () => {
    await mountSettings({ enabled: true });
    transport.emit({
      type: "snapshot",
      snapshot: makeSnapshot({
        availability: "permission_required",
        platform: "darwin-universal",
        missingPermissions: ["accessibility", "screen_recording"],
      }),
    });
    await flushPromises();

    const buttons = wrapper!.findAll(".cu-permission-btn");
    expect(buttons).toHaveLength(2);
    await buttons[1].trigger("click");
    expect(transport.commands).toContainEqual({ type: "open_permission_settings", permission: "screen_recording" });

    const link = wrapper!.find(".cu-attribution-link");
    expect(link.attributes("href")).toBe("https://github.com/trycua/cua");
    // 许可/归属文案。
    expect(wrapper!.text()).toContain("由 Cua Driver（MIT，trycua/cua）提供支持");
  });
});
