import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia } from "pinia";
import { defineComponent, h } from "vue";
import { createVuetify } from "vuetify/dist/vuetify.js";
import type { PixApi } from "../../main/preload";
import App from "../App.vue";
import AppLayout from "../components/layout/AppLayout.vue";
import WindowTitlebar from "../components/layout/WindowTitlebar.vue";

let wrapper: VueWrapper | undefined;
const windowMinimize = vi.fn();
const windowMaximize = vi.fn();
const windowClose = vi.fn();
const unsubscribe = vi.fn();
let maximizeChanged: (maximized: boolean) => void;

function resize(width: number): void {
  window.innerWidth = width;
  window.dispatchEvent(new Event("resize"));
}

const Workspace = defineComponent({
  setup() {
    return () => h(AppLayout, null, {
      center: ({ toggleRight, reserveWindowControls }: { toggleRight: () => void; reserveWindowControls: boolean }) =>
        h(WindowTitlebar, { reserveWindowControls }, () =>
          h("button", { "aria-label": "切换上下文", onClick: toggleRight }, "上下文")),
      right: () => h(WindowTitlebar, null, () => "上下文"),
    });
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  resize(1400);
  window.pixApi = {
    getSettings: vi.fn().mockResolvedValue({ theme: "light", recentProjects: [] }),
    windowIsMaximized: vi.fn().mockResolvedValue(false),
    onWindowMaximizeChange: (callback: (maximized: boolean) => void) => {
      maximizeChanged = callback;
      return unsubscribe;
    },
    windowMinimize,
    windowMaximize,
    windowClose,
  } as unknown as PixApi;
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = "";
});

function mountWorkspace(): VueWrapper {
  wrapper = mount(App, {
    attachTo: document.body,
    global: {
      plugins: [createPinia(), createVuetify()],
      stubs: { RouterView: Workspace },
    },
  });
  return wrapper;
}

describe("window chrome and sidebar layout", () => {
  it("reserves the center header when the right sidebar closes, including desktop widths", async () => {
    const page = mountWorkspace();
    await flushPromises();
    const centerHeader = () => page.get(".layout-center").getComponent(WindowTitlebar);
    expect(centerHeader().props("reserveWindowControls")).toBe(false);
    await page.get('button[aria-label="切换上下文"]').trigger("click");
    expect(centerHeader().props("reserveWindowControls")).toBe(true);
    await page.get('button[aria-label="切换上下文"]').trigger("click");
    expect(centerHeader().props("reserveWindowControls")).toBe(false);
    resize(1024);
    await flushPromises();
    expect(centerHeader().props("reserveWindowControls")).toBe(true);
    await page.get('button[aria-label="切换上下文"]').trigger("click");
    expect(centerHeader().props("reserveWindowControls")).toBe(true);
    await page.get('button[aria-label="关闭上下文面板"]').trigger("click");
    resize(1400);
    await flushPromises();
    expect(centerHeader().props("reserveWindowControls")).toBe(false);
  });

  it("dispatches window actions in both sidebar states and follows maximize events", async () => {
    const page = mountWorkspace();
    await flushPromises();
    for (let iteration = 0; iteration < 2; iteration++) {
      await page.get('button[aria-label="最小化"]').trigger("click");
      await page.get('button[aria-label="最大化"]').trigger("click");
      await page.get('button[aria-label="关闭"]').trigger("click");
      await page.get('button[aria-label="切换上下文"]').trigger("click");
    }
    expect(windowMinimize).toHaveBeenCalledTimes(2);
    expect(windowMaximize).toHaveBeenCalledTimes(2);
    expect(windowClose).toHaveBeenCalledTimes(2);
    maximizeChanged(true);
    await flushPromises();
    await page.get('button[aria-label="还原"]').trigger("click");
    expect(windowMaximize).toHaveBeenCalledTimes(3);
    page.unmount();
    wrapper = undefined;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
