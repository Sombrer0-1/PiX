/**
 * CustomProviders「从 API 获取模型」组件测试（S4 风格，无 Electron）。
 *
 * 覆盖：按钮启用/禁用门槛（baseUrl 空 / 非 openai 兼容协议）、点击后
 * fetchProviderModels 的参数（表单密钥优先；已配置未改动时传 providerName 交主进程
 * 回读）、候选对话框渲染（已存在行禁勾 + 标注）、确认导入合并进草稿（已存在行
 * 不动、新行默认值、不自动保存）、失败时的行内错误展示。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { components as vuetifyComponents, createVuetify, directives as vuetifyDirectives } from "vuetify/dist/vuetify.js";
import type { CustomProviderConfig } from "@shared/custom-providers";
import CustomProviders from "../components/settings/CustomProviders.vue";

// ============================================================================
// Mocks
// ============================================================================

const rpcMock = vi.hoisted(() => ({
  state: {
    isConnected: { value: true },
  },
  getCustomProviders: vi.fn(),
  setCustomProviders: vi.fn(),
  fetchProviderModels: vi.fn(),
  refreshModels: vi.fn().mockResolvedValue(undefined),
  getAuthStatus: vi.fn().mockResolvedValue({}),
}));

vi.mock("../composables/useWorkspaceRpc", () => ({
  useWorkspaceRpc: () => ({
    isConnected: rpcMock.state.isConnected,
    getCustomProviders: rpcMock.getCustomProviders,
    setCustomProviders: rpcMock.setCustomProviders,
    fetchProviderModels: rpcMock.fetchProviderModels,
    refreshModels: rpcMock.refreshModels,
    getAuthStatus: rpcMock.getAuthStatus,
  }),
}));

// ============================================================================
// Harness
// ============================================================================

const vuetify = createVuetify({
  components: { ...vuetifyComponents },
  directives: { ...vuetifyDirectives },
});

let wrapper: VueWrapper | undefined;

function providersFixture(providers: Record<string, CustomProviderConfig>): void {
  rpcMock.getCustomProviders.mockReset().mockResolvedValue({ providers });
}

function mountPanel(): VueWrapper {
  wrapper = mount(CustomProviders, {
    attachTo: document.body,
    global: { plugins: [createPinia(), vuetify] },
  });
  return wrapper;
}

function findFetchButton(): ReturnType<VueWrapper["findAll"]>[number] | undefined {
  return wrapper
    ?.findAll("button")
    .find((b) => b.text().includes("从 API 获取模型"));
}

async function expandFirstProvider(): Promise<void> {
  const header = wrapper!.find(".provider-header");
  await header.trigger("click");
}

function dialogButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")];
}

beforeEach(() => {
  setActivePinia(createPinia());
  rpcMock.state.isConnected = ref(true);
  // happy-dom 没有 visualViewport；VOverlay（v-dialog/v-tooltip）的 connected 策略会读它。
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
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// ============================================================================

describe("CustomProviders 从 API 获取模型", () => {
  it("button is disabled while baseUrl is empty or the api is not OpenAI-compatible", async () => {
    providersFixture({
      relay: { baseUrl: "https://relay.example.com/v1", api: "anthropic-messages", models: [] },
    });
    const panel = mountPanel();
    await flushPromises();
    await expandFirstProvider();

    const btn = findFetchButton();
    expect(btn, "fetch button rendered").toBeTruthy();
    expect(btn!.attributes("disabled")).toBeDefined();
    expect(rpcMock.fetchProviderModels).not.toHaveBeenCalled();
    void panel;
  });

  it("fetches candidates, marks existing ids, and merges picked ones into the draft", async () => {
    providersFixture({
      relay: {
        baseUrl: "https://relay.example.com/v1",
        api: "openai-completions",
        // apiKey SENTINEL -> keyConfigured true（已配置，回读主进程密钥）。
        apiKey: "__PIX_KEY_MASKED__",
        models: [{ id: "keep-me", reasoning: true, input: ["text"] }],
      },
    });
    rpcMock.fetchProviderModels.mockResolvedValue({
      success: true,
      models: [
        { id: "keep-me", name: "已有人工配置" },
        { id: "new-a", name: "New A", contextWindow: 128000 },
        { id: "new-b", maxTokens: 4096 },
      ],
    });
    mountPanel();
    await flushPromises();
    await expandFirstProvider();

    const btn = findFetchButton();
    expect(btn!.attributes("disabled")).toBeUndefined();
    await btn!.trigger("click");
    await flushPromises();

    // 表单未输入密钥且已配置未改动：不带 apiKey，带 providerName 交主进程回读。
    expect(rpcMock.fetchProviderModels).toHaveBeenCalledTimes(1);
    expect(rpcMock.fetchProviderModels).toHaveBeenCalledWith({
      baseUrl: "https://relay.example.com/v1",
      api: "openai-completions",
      apiKey: undefined,
      providerName: "relay",
    });

    // 对话框（teleport 到 body）：3 行候选，已存在行禁勾 + 标注。
    const rows = document.querySelectorAll(".candidate-list .v-list-item");
    expect(rows.length).toBe(3);
    const checkboxes = [
      ...document.querySelectorAll(".candidate-list input[type=checkbox]"),
    ] as HTMLInputElement[];
    expect(checkboxes.length).toBe(3);
    expect(checkboxes[0]!.disabled, "existing id row checkbox disabled").toBe(true);
    expect(checkboxes[1]!.disabled).toBe(false);
    expect(document.body.textContent).toContain("已存在");
    expect(document.body.textContent).toContain("128K");

    // 确认导入：默认勾选的 2 个新模型并入草稿；不触发保存。
    const confirm = dialogButtons().find((b) => b.textContent?.includes("导入所选"));
    expect(confirm, "confirm button rendered").toBeTruthy();
    confirm!.click();
    await flushPromises();

    expect(rpcMock.setCustomProviders).not.toHaveBeenCalled();
    // 草稿模型 1 个已有 + 2 个新增 = 3 行（按「模型 ID」输入框取值）。
    const modelIds = wrapper!
      .findAll(".model-block .model-id-field input")
      .map((i) => (i.element as HTMLInputElement).value);
    expect(modelIds).toEqual(["keep-me", "new-a", "new-b"]);

    // 确认后候选清空（happy-dom 不触发离场过渡动画，overlay 残壳不算未关闭）。
    expect(document.querySelectorAll(".candidate-list .v-list-item").length).toBe(0);
  });

  it("sends the typed key instead of providerName when the form carries one", async () => {
    providersFixture({
      relay: {
        baseUrl: "https://relay.example.com/v1",
        api: "openai-responses",
        apiKey: "__PIX_KEY_MASKED__",
        models: [],
      },
    });
    rpcMock.fetchProviderModels.mockResolvedValue({ success: true, models: [{ id: "only" }] });
    mountPanel();
    await flushPromises();
    await expandFirstProvider();

    // keyConfigured 时占位文案是「留空不修改…」；本用例只取 API Key 字段本身。
    const keyInput = wrapper!.find('input[type="password"]');
    expect(keyInput.exists(), "api key field rendered").toBe(true);
    await keyInput.setValue("sk-form-key");

    await findFetchButton()!.trigger("click");
    await flushPromises();
    expect(rpcMock.fetchProviderModels).toHaveBeenCalledWith({
      baseUrl: "https://relay.example.com/v1",
      api: "openai-responses",
      apiKey: "sk-form-key",
      providerName: undefined,
    });
  });

  it("shows the inline error when the probe fails", async () => {
    providersFixture({
      relay: { baseUrl: "https://relay.example.com/v1", api: "openai-completions", models: [] },
    });
    rpcMock.fetchProviderModels.mockResolvedValue({
      success: false,
      error: "https://relay.example.com/v1/models 返回 HTTP 401；请检查 API Key 是否有效",
    });
    mountPanel();
    await flushPromises();
    await expandFirstProvider();

    await findFetchButton()!.trigger("click");
    await flushPromises();

    expect(wrapper!.find(".fetch-error-hint").exists()).toBe(true);
    expect(wrapper!.text()).toContain("HTTP 401");
    expect(document.querySelector(".candidate-list")).toBeNull();
  });

  it("shows the inline error when the listing is empty", async () => {
    providersFixture({
      relay: { baseUrl: "https://relay.example.com/v1", api: "openai-completions", models: [] },
    });
    rpcMock.fetchProviderModels.mockResolvedValue({ success: true, models: [] });
    mountPanel();
    await flushPromises();
    await expandFirstProvider();

    await findFetchButton()!.trigger("click");
    await flushPromises();

    expect(wrapper!.text()).toContain("API 未返回任何模型");
    expect(document.querySelector(".candidate-list")).toBeNull();
  });

  it("discards a late-arriving fetch while another candidate dialog is open", async () => {
    providersFixture({
      alpha: { baseUrl: "https://alpha.example.com/v1", api: "openai-completions", models: [] },
      beta: { baseUrl: "https://beta.example.com/v1", api: "openai-completions", models: [] },
    });
    let resolveAlpha: (value: unknown) => void = () => {};
    let resolveBeta: (value: unknown) => void = () => {};
    rpcMock.fetchProviderModels
      .mockReturnValueOnce(new Promise((resolve) => { resolveAlpha = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveBeta = resolve; }));
    mountPanel();
    await flushPromises();
    // Expand both cards, click both fetch buttons before either resolves.
    const headers = wrapper!.findAll(".provider-header");
    await headers[0]!.trigger("click");
    await headers[1]!.trigger("click");
    const buttons = wrapper!.findAll("button").filter((b) => b.text().includes("从 API 获取模型"));
    expect(buttons.length).toBe(2);
    await buttons[0]!.trigger("click");
    await buttons[1]!.trigger("click");

    resolveAlpha({ success: true, models: [{ id: "from-alpha" }] });
    await flushPromises();
    resolveBeta({ success: true, models: [{ id: "from-beta" }] });
    await flushPromises();

    // Dialog still shows alpha's candidates; beta got the discard error instead.
    const ids = [...document.querySelectorAll(".candidate-id")].map((e) => e.textContent);
    expect(ids).toEqual(["from-alpha"]);
    const errorHints = wrapper!.findAll(".fetch-error-hint");
    expect(errorHints.length).toBe(1);
    expect(errorHints[0]!.text()).toContain("已有候选列表待确认");

    const confirm = dialogButtons().find((b) => b.textContent?.includes("导入所选"));
    confirm!.click();
    await flushPromises();

    // Confirm merges into alpha only; beta's draft stays empty.
    const modelIds = wrapper!
      .findAll(".model-block .model-id-field input")
      .map((i) => (i.element as HTMLInputElement).value);
    expect(modelIds).toEqual(["from-alpha"]);
  });
});


describe("CustomProviders save recovery", () => {
  it("keeps a pending deletion blocked during reload and rejects its stale target afterwards", async () => {
    const beta: CustomProviderConfig = { baseUrl: 'https://beta.example.com/v1', api: 'openai-completions', models: [] };
    providersFixture({ alpha: { ...beta }, beta });
    const panel = mountPanel();
    await flushPromises();
    await expandFirstProvider();
    await panel.findAll('button').find(button => button.text() === '删除')!.trigger('click');
    await flushPromises();
    rpcMock.state.isConnected.value = false;
    await flushPromises();
    let finishLoad!: (value: { providers: Record<string, CustomProviderConfig> }) => void;
    rpcMock.getCustomProviders.mockReturnValueOnce(new Promise(resolve => { finishLoad = resolve; }));
    rpcMock.state.isConnected.value = true;
    await flushPromises();
    const confirm = dialogButtons().find(button => button.textContent?.trim() === '确认删除')!;
    expect(confirm.disabled).toBe(true);
    confirm.click();
    expect(panel.findAll('.provider-card')).toHaveLength(2);
    expect(rpcMock.setCustomProviders).not.toHaveBeenCalled();
    finishLoad({ providers: { beta } });
    await flushPromises();
    confirm.click();
    await flushPromises();
    expect(panel.findAll('.provider-card')).toHaveLength(1);
    expect(panel.get('.provider-name').text()).toBe('beta');
    expect(rpcMock.setCustomProviders).not.toHaveBeenCalled();
    expect(panel.text()).toContain('请重新选择要删除的 Provider');
  });

  it("locks deletion and editing while a provider write is pending", async () => {
    providersFixture({ relay: { baseUrl: 'https://relay.example.com/v1', api: 'openai-completions', models: [] } });
    let finishSave!: (value: { success: boolean }) => void;
    rpcMock.setCustomProviders.mockReturnValueOnce(new Promise(resolve => { finishSave = resolve; }));
    const panel = mountPanel();
    await flushPromises();
    await expandFirstProvider();
    await panel.findAll('button').find(button => button.text() === '保存全部')!.trigger('click');
    await flushPromises();
    const deleteButton = panel.findAll('button').find(button => button.text() === '删除')!;
    expect(deleteButton.attributes('disabled')).toBeDefined();
    expect(panel.get<HTMLInputElement>('input[aria-label="Provider 名"]').element.disabled).toBe(true);
    await deleteButton.trigger('click');
    expect(panel.findAll('.provider-card')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('确认删除');
    finishSave({ success: true });
    await flushPromises();
    expect(deleteButton.attributes('disabled')).toBeUndefined();
  });

  it("preserves opened cards, model details and advanced options after saving", async () => {
    providersFixture({ relay: { baseUrl: 'https://relay.example.com/v1', api: 'openai-completions', models: [{ id: 'model', input: ['text'], reasoning: true }] } });
    rpcMock.setCustomProviders.mockResolvedValue({ success: true });
    const panel = mountPanel();
    await flushPromises();
    await expandFirstProvider();
    for (const details of panel.findAll<HTMLDetailsElement>('details')) {
      details.element.open = true;
      await details.trigger('toggle');
    }
    await panel.findAll('button').find(button => button.text().includes('高级：compat'))!.trigger('click');
    await panel.findAll('button').find(button => button.text().includes('思考档位映射 thinkingLevelMap'))!.trigger('click');
    await panel.findAll('button').find(button => button.text() === '保存全部')!.trigger('click');
    await flushPromises();
    expect(panel.get('.provider-header').attributes('aria-expanded')).toBe('true');
    expect(panel.findAll<HTMLDetailsElement>('details').every(details => details.element.open)).toBe(true);
    expect(panel.find('textarea[aria-label="compat 覆盖 JSON"]').exists()).toBe(true);
    expect(panel.find('textarea[aria-label="思考档位映射 JSON"]').exists()).toBe(true);
    expect(panel.text()).not.toContain('有未保存的修改');
  });

  it("focuses and scrolls to the newly added provider", async () => {
    providersFixture({});
    const panel = mountPanel();
    await flushPromises();
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    await panel.findAll('button').find(button => button.text() === '添加 Provider')!.trigger('click');
    await flushPromises();
    expect(document.activeElement).toBe(panel.get('input[aria-label="Provider 名"]').element);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    scroll.mockRestore();
  });

  it("retains the edited provider after the write is rejected", async () => {
    providersFixture({ relay: { baseUrl: "https://relay.example.com/v1", api: "openai-completions", models: [{ id: "model", input: ["text"], reasoning: false }] } });
    rpcMock.setCustomProviders.mockResolvedValue({ success: false, error: "配置写入失败" });
    const panel = mountPanel();
    await flushPromises();
    await expandFirstProvider();
    await panel.get('input[aria-label="Provider 名"]').setValue("edited-relay");
    await panel.findAll('button').find(button => button.text() === '保存全部')!.trigger('click');
    await flushPromises();
    expect(panel.text()).toContain("配置写入失败");
    expect((panel.get('input[aria-label="Provider 名"]').element as HTMLInputElement).value).toBe("edited-relay");
    expect(panel.text()).toContain("有未保存的修改");
  });

  it("restores a deleted card and retains sibling edits when deletion cannot persist", async () => {
    providersFixture({
      alpha: { baseUrl: "https://alpha.example.com/v1", api: "openai-completions", models: [{ id: "alpha", input: ["text"], reasoning: false }] },
      beta: { baseUrl: "https://beta.example.com/v1", api: "openai-completions", models: [{ id: "beta", input: ["text"], reasoning: false }] },
    });
    rpcMock.setCustomProviders.mockResolvedValue({ success: false, error: "配置写入失败" });
    const panel = mountPanel();
    await flushPromises();
    await panel.findAll('.provider-header')[1].trigger('click');
    await panel.get('input[aria-label="Provider 名"]').setValue('edited-beta');
    await panel.findAll('.provider-header')[0].trigger('click');
    await panel.findAll('.provider-card')[0].findAll('button').find(button => button.text() === '删除')!.trigger('click');
    await flushPromises();
    dialogButtons().find(button => button.textContent?.trim() === '确认删除')!.click();
    await flushPromises();
    expect(panel.findAll('.provider-card')).toHaveLength(2);
    expect(panel.findAll('input[aria-label="Provider 名"]').map(input => (input.element as HTMLInputElement).value)).toEqual(['alpha', 'edited-beta']);
    expect(panel.text()).toContain('配置写入失败');
  });
});
