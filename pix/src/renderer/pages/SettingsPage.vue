<script setup lang="ts">
/**
 * Settings Page
 *
 * Sidebar + content layout. Left nav selects the section,
 * right panel shows the form fields for that section.
 */
import { computed, ref, onMounted, onUnmounted, watch, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSettingsStore } from "../stores/settings-store";
import { useAuthStore } from "../stores/auth-store";
import { useWorkspaceRpc } from "../composables/useWorkspaceRpc";
import type { ModelInfo, ThinkingLevel } from "@/types/rpc";
import { thinkingLevelItems } from "../utils/thinking-labels";
import { AGENT_TASK_DEFAULT_RUNNING_SLOTS, AGENT_TASK_MAX_RUNNING_SLOTS } from "@shared/agent-task-types.js";
import SettingsGroup from "../components/settings/SettingsGroup.vue";
import SettingsRow from "../components/settings/SettingsRow.vue";
import WindowTitlebar from "../components/layout/WindowTitlebar.vue";
import McpSettings from "../components/settings/McpSettings.vue";
import CustomProviders from "../components/settings/CustomProviders.vue";

const router = useRouter();
const route = useRoute();
const settingsStore = useSettingsStore();
const authStore = useAuthStore();
const rpc = useWorkspaceRpc();

// ---- Navigation ----
type SettingsSection =
  | "general"
  | "plan"
  | "images"
  | "environment"
  | "resources"
  | "model"
  | "custom"
  | "auth"
  | "mcp"
  | "advanced";
const activeSection = ref<SettingsSection>("general");
const searchQuery = ref("");
const navigationOpen = ref(false);
const navigation = ref<HTMLElement | null>(null);
const menuButton = ref<HTMLButtonElement | null>(null);
const settingsScroll = ref<HTMLElement | null>(null);
const sections: {
  key: SettingsSection;
  label: string;
  icon: string;
  group: string;
  description: string;
  keywords: string;
}[] = [
  {
    key: "general",
    label: "常规",
    icon: "mdi-cog-outline",
    group: "使用偏好",
    description: "设置 Agent 的执行权限与日常对话行为。",
    keywords: "执行模式 审批 只读 无监管 完成前验证 默认思考 引导 后续 自动压缩 主动压缩 ACP 安静启动",
  },
  {
    key: "plan",
    label: "规划与任务",
    icon: "mdi-clipboard-list-outline",
    group: "使用偏好",
    description: "配置规划模型与后台 Agent 任务。",
    keywords: "规划模型 思考强度 自动后台 阈值 子 Agent 并发 排队",
  },
  {
    key: "images",
    label: "图片理解",
    icon: "mdi-eye-outline",
    group: "使用偏好",
    description: "管理图片输入与眼睛模型。",
    keywords: "自动缩放 禁图 阻止图片 视觉 takeHerEyes 提供商",
  },
  {
    key: "environment",
    label: "执行环境",
    icon: "mdi-console",
    group: "工作区",
    description: "配置 Shell、网络及新项目的 WSL 默认值。",
    keywords: "Shell 路径 Bash 命令前缀 npm HTTP 空闲超时 WSL2 发行版 Linux 目录",
  },
  {
    key: "resources",
    label: "扩展与资源",
    icon: "mdi-layers-outline",
    group: "工作区",
    description: "配置扩展、技能、提示模板与主题路径。",
    keywords: "扩展路径 技能命令 skill prompt 提示模板 主题 重新加载",
  },
  {
    key: "model",
    label: "模型与连接",
    icon: "mdi-chip",
    group: "模型与集成",
    description: "管理可用模型与 API 连接方式。",
    keywords: "enabledModels glob 规则 传输 transport SSE WebSocket 自动重试",
  },
  {
    key: "custom",
    label: "自定义提供商",
    icon: "mdi-connection",
    group: "模型与集成",
    description: "",
    keywords:
      "Provider 模型目录 baseUrl API Key Headers Bearer compat 协议 兼容 JSON thinkingLevelMap 从 API 获取 导入",
  },
  {
    key: "auth",
    label: "认证",
    icon: "mdi-key-outline",
    group: "模型与集成",
    description: "配置内置提供商的 API 密钥。",
    keywords: "API Key auth.json 来源 密钥 保存 替换 删除",
  },
  {
    key: "mcp",
    label: "MCP 服务器",
    icon: "mdi-power-plug-outline",
    group: "模型与集成",
    description: "",
    keywords: "连接 工具 配置文件 刷新 stderr 错误 required",
  },
  {
    key: "advanced",
    label: "高级",
    icon: "mdi-tune",
    group: "应用",
    description: "管理应用更新与诊断信息。",
    keywords: "自动补全 数量 匿名使用数据 分析 遥测 更新 下载 安装 诊断 路径 数据目录 会话存储 设置文件",
  },
];
const sectionKeys = new Set<SettingsSection>(sections.map((section) => section.key));
const currentSection = computed(() => sections.find((section) => section.key === activeSection.value)!);
const filteredGroups = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  return ["使用偏好", "工作区", "模型与集成", "应用"]
    .map((label) => ({
      label,
      sections: sections.filter(
        (section) =>
          section.group === label &&
          (!query || `${section.label} ${section.description} ${section.keywords}`.toLowerCase().includes(query)),
      ),
    }))
    .filter((group) => group.sections.length > 0);
});
function selectSection(section: SettingsSection): void {
  activeSection.value = section;
  if (typeof router.replace === "function") void router.replace({ path: "/settings", query: { section } });
  closeNavigation();
}
function closeNavigation(): void {
  const wasOpen = navigationOpen.value;
  navigationOpen.value = false;
  if (wasOpen) void nextTick(() => menuButton.value?.focus());
}
watch(navigationOpen, async (open) => {
  if (open) {
    await nextTick();
    navigation.value?.querySelector<HTMLInputElement>("input")?.focus();
  }
});
function handleNavigationKey(event: KeyboardEvent): void {
  if (!navigationOpen.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeNavigation();
  }
  if (event.key === "Tab") {
    const controls = Array.from(navigation.value?.querySelectorAll<HTMLElement>("button, input, a") ?? []);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
}
function handleResize(): void {
  if (window.innerWidth > 560) closeNavigation();
}
onMounted(() => {
  window.addEventListener("keydown", handleNavigationKey);
  window.addEventListener("resize", handleResize);
});
onUnmounted(() => {
  window.removeEventListener("keydown", handleNavigationKey);
  window.removeEventListener("resize", handleResize);
});

// ---- Form state ----
const defaultProvider = ref("");
const defaultModel = ref("");
const defaultThinkingLevel = ref<ThinkingLevel>("xhigh");
const steeringMode = ref<"all" | "one-at-a-time">("one-at-a-time");
const followUpMode = ref<"all" | "one-at-a-time">("one-at-a-time");
const executionMode = ref<"read-only" | "approval" | "unattended">("approval");
const verificationGate = ref(true);
const autoCompact = ref(true);
const defaultAcp = ref(false);
const quietStartup = ref(false);

const enabledModels = ref("");
const transport = ref("auto");
const retryEnabled = ref(true);

const imageAutoResize = ref(true);
const blockImages = ref(false);
const takeHerEyesEnabled = ref(false);
const takeHerEyesModel = ref("");

// Plan-mode settings (1.4.0). Empty planModelKey/planThinkingLevel mean
// "inherit the current session model" and persist as undefined.
const planModelKey = ref("");
const planThinkingLevel = ref<ThinkingLevel | "">("");
const enableProductAnalytics = ref(false);

// 1.4.1: auto-background threshold for foreground agent tasks (ms);
// 0 = off. Hydrated from the store on mount, which defaults absent to 0.
const autoBackgroundMs = ref(0);
const agentTaskMaxConcurrent = ref(AGENT_TASK_DEFAULT_RUNNING_SLOTS);
const agentTaskConcurrentTicks: Record<number, string> = {
  1: "1",
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
};

const shellPath = ref("");
const shellCommandPrefix = ref("");
const npmCommand = ref("");
const httpIdleTimeoutMs = ref(0);

// WSL global defaults. These only seed new-project dialog defaults; the
// persisted per-project environment remains authoritative (wsl_plan §6.1).
const wslEnabled = ref(false);
const wslDistro = ref("");
const wslDefaultCwd = ref("/home");

const extensionPaths = ref("");
const skillPaths = ref("");
const promptTemplatePaths = ref("");
const themePaths = ref("");
const enableSkillCommands = ref(true);

const autocompleteMaxVisible = ref(5);

const saving = ref(false);
const saved = ref(false);
const loading = ref(true);
const loadError = ref("");
const saveError = ref("");
const piReady = ref(false);
const guiReady = ref(false);
const authError = ref("");
const authBusy = ref<string | null>(null);
const pendingAuthDelete = ref<string | null>(null);
const showAuthDeleteDialog = computed({
  get: () => pendingAuthDelete.value !== null,
  set: (open: boolean) => { if (!open) pendingAuthDelete.value = null; },
});
const showDiscardDialog = ref(false);
const providersDirty = ref(false);
const baseline = ref("");
const piBaseline = ref("");
const piSnapshot = computed(() =>
  JSON.stringify([
    steeringMode.value,
    followUpMode.value,
    executionMode.value,
    verificationGate.value,
    autoCompact.value,
    quietStartup.value,
    enabledModels.value,
    transport.value,
    retryEnabled.value,
    imageAutoResize.value,
    blockImages.value,
    shellPath.value,
    shellCommandPrefix.value,
    npmCommand.value,
    httpIdleTimeoutMs.value,
    extensionPaths.value,
    skillPaths.value,
    promptTemplatePaths.value,
    themePaths.value,
    enableSkillCommands.value,
    autocompleteMaxVisible.value,
  ]),
);
const formSnapshot = computed(() =>
  JSON.stringify([
    defaultThinkingLevel.value,
    steeringMode.value,
    followUpMode.value,
    executionMode.value,
    verificationGate.value,
    autoCompact.value,
    defaultAcp.value,
    quietStartup.value,
    enabledModels.value,
    transport.value,
    retryEnabled.value,
    imageAutoResize.value,
    blockImages.value,
    takeHerEyesEnabled.value,
    takeHerEyesModel.value,
    planModelKey.value,
    planThinkingLevel.value,
    enableProductAnalytics.value,
    autoBackgroundMs.value,
    agentTaskMaxConcurrent.value,
    shellPath.value,
    shellCommandPrefix.value,
    npmCommand.value,
    httpIdleTimeoutMs.value,
    wslEnabled.value,
    wslDistro.value,
    wslDefaultCwd.value,
    extensionPaths.value,
    skillPaths.value,
    promptTemplatePaths.value,
    themePaths.value,
    enableSkillCommands.value,
    autocompleteMaxVisible.value,
  ]),
);
const dirty = computed(() => baseline.value !== "" && formSnapshot.value !== baseline.value);
const reloadingResources = ref(false);
const resourceFeedback = ref("");
const resourceError = ref(false);
async function reloadResources(): Promise<void> {
  reloadingResources.value = true;
  resourceFeedback.value = "";
  resourceError.value = false;
  try {
    await rpc.reloadResources();
    resourceFeedback.value = "资源已重新加载";
  } catch (error) {
    resourceError.value = true;
    resourceFeedback.value = error instanceof Error ? error.message : String(error);
  } finally {
    reloadingResources.value = false;
  }
}
watch(formSnapshot, () => {
  saved.value = false;
});

// ---- Update state ----
const checkingUpdate = ref(false);
const downloading = ref(false);
const updateInfo = ref<{
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseNotes?: string;
} | null>(null);
const updateError = ref<string | null>(null);

// ---- Auth editing state ----
const editingProvider = ref<string | null>(null);
const editingKeys = ref<Record<string, string>>({});
// Provider names defined in ~/.pi/agent/models.json. Their API keys are managed
// in the "自定义模型" section, so the auth section disables set/delete to avoid
// auth.json silently overriding the models.json apiKey (double-source guard).
const customProviderNames = ref<Set<string>>(new Set());

function toggleEditProvider(provider: string): void {
  if (customProviderNames.value.has(provider)) return;
  if (editingProvider.value === provider) {
    editingProvider.value = null;
  } else {
    editingProvider.value = provider;
    if (!(provider in editingKeys.value)) {
      editingKeys.value[provider] = "";
    }
  }
}

async function saveKey(provider: string): Promise<void> {
  const key = editingKeys.value[provider]?.trim();
  if (!key || authBusy.value) return;
  authBusy.value = provider;
  authError.value = "";
  try {
    await rpc.setApiKey(provider, key);
    editingKeys.value[provider] = "";
    editingProvider.value = null;
    await authStore.refreshStatus();
  } catch (err) {
    authError.value = err instanceof Error ? err.message : String(err);
  } finally {
    authBusy.value = null;
  }
}

async function deleteKey(provider: string): Promise<void> {
  if (authBusy.value || customProviderNames.value.has(provider)) return;
  authBusy.value = provider;
  authError.value = "";
  try {
    await rpc.removeAuth(provider);
    editingKeys.value[provider] = "";
    editingProvider.value = null;
    await authStore.refreshStatus();
  } catch (err) {
    authError.value = err instanceof Error ? err.message : String(err);
  } finally {
    authBusy.value = null;
  }
}

async function confirmDeleteKey(): Promise<void> {
  const provider = pendingAuthDelete.value;
  pendingAuthDelete.value = null;
  if (provider !== null) await deleteKey(provider);
}

// ---- Option lists ----

const steeringModeItems = [
  { title: "全部排队", value: "all" },
  { title: "逐条处理", value: "one-at-a-time" },
] as const;
const executionModeItems = [
  { title: "只读模式", value: "read-only", icon: "mdi-eye-outline", subtitle: "只允许读取和搜索，禁止修改文件。" },
  { title: "审批模式", value: "approval", icon: "mdi-shield-check-outline", subtitle: "高风险操作需要确认。" },
  { title: "无监管模式", value: "unattended", icon: "mdi-lightning-bolt-outline", subtitle: "工具调用不弹出审批。" },
] as const;
const transportOptions = [
  { title: "自动", value: "auto" },
  { title: "SSE", value: "sse" },
  { title: "WebSocket", value: "websocket" },
] as const;

const visionModelItems = computed(() =>
  rpc.availableModels.value
    .filter((model: ModelInfo) => model.input?.includes("image") && authStore.authStatus[model.provider]?.configured)
    .map((model: ModelInfo) => ({
      title: `${model.provider}/${model.id}`,
      value: modelKey(model),
      props: {
        subtitle: model.contextWindow ? `${formatContextWindow(model.contextWindow)} 上下文` : undefined,
      },
    })),
);

// Plan-mode model choices; the first entry (empty value) means "inherit the
// current session model" and is never persisted as a planModel.
const planModelItems = computed(() => {
  const inherit = [{ title: "继承当前会话模型", value: "" }];
  const models = rpc.availableModels.value
    .filter((model: ModelInfo) => authStore.authStatus[model.provider]?.configured)
    .map((model: ModelInfo) => ({
      title: `${model.provider}/${model.id}`,
      value: modelKey(model),
      props: {
        subtitle: model.contextWindow ? `${formatContextWindow(model.contextWindow)} 上下文` : undefined,
      },
    }));
  return [...inherit, ...models];
});

const planThinkingLevelItems: Array<{ title: string; value: ThinkingLevel | "" }> = [
  { title: "继承会话默认", value: "" },
  ...thinkingLevelItems,
];

// 1.4.1: auto-background threshold choices; 0 = off (never auto-background).
const autoBackgroundMsItems: Array<{ title: string; value: number }> = [
  { title: "关闭", value: 0 },
  { title: "1 分钟", value: 60_000 },
  { title: "2 分钟", value: 120_000 },
  { title: "5 分钟", value: 300_000 },
];

const wslDistroItems = computed(() =>
  settingsStore.wslDistros.map((d) => ({
    title: d.name,
    value: d.name,
    subtitle: `v${d.version} · ${d.state}`,
  })),
);

const wslDefaultCwdValid = computed(() => {
  const value = wslDefaultCwd.value.trim();
  return value.startsWith("/") && !value.includes("\\");
});

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function parseModelKey(key: string): { provider: string; modelId: string } | undefined {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash >= key.length - 1) return undefined;
  return {
    provider: key.slice(0, slash),
    modelId: key.slice(slash + 1),
  };
}

function formatContextWindow(contextWindow: number): string {
  if (contextWindow >= 1_000_000) return `${(contextWindow / 1_000_000).toFixed(1)}M`;
  if (contextWindow >= 1000) return `${Math.round(contextWindow / 1000)}K`;
  return String(contextWindow);
}

function syncSectionFromRoute(): void {
  const section = route.query.section;
  if (typeof section === "string" && sectionKeys.has(section as SettingsSection)) {
    activeSection.value = section as SettingsSection;
  }
}

// ---- Load ----
async function loadSettings(): Promise<void> {
  if (settingsStore.isLoaded && baseline.value) {
    loadError.value = "";
    const wasDirty = dirty.value;
    await loadPiSettings();
    if (!wasDirty) baseline.value = formSnapshot.value;
    return;
  }
  loading.value = true;
  loadError.value = "";
  syncSectionFromRoute();
  await settingsStore.load();
  if (!settingsStore.isLoaded || settingsStore.loadError) {
    loadError.value = settingsStore.loadError || "读取应用设置失败，请重试。";
    loading.value = false;
    return;
  }
  guiReady.value = true;
  defaultProvider.value = settingsStore.settings.defaultProvider || "";
  defaultModel.value = settingsStore.settings.defaultModel || "";
  defaultThinkingLevel.value = settingsStore.settings.defaultThinkingLevel || "xhigh";
  takeHerEyesEnabled.value = settingsStore.settings.takeHerEyes?.enabled ?? false;
  takeHerEyesModel.value =
    settingsStore.settings.takeHerEyes?.provider && settingsStore.settings.takeHerEyes?.modelId
      ? `${settingsStore.settings.takeHerEyes.provider}/${settingsStore.settings.takeHerEyes.modelId}`
      : "";
  planModelKey.value =
    settingsStore.settings.planModel?.provider && settingsStore.settings.planModel?.modelId
      ? `${settingsStore.settings.planModel.provider}/${settingsStore.settings.planModel.modelId}`
      : "";
  planThinkingLevel.value = settingsStore.settings.planThinkingLevel ?? "";
  enableProductAnalytics.value = settingsStore.settings.enableProductAnalytics ?? false;
  autoBackgroundMs.value = settingsStore.autoBackgroundMs;
  agentTaskMaxConcurrent.value = settingsStore.agentTaskMaxConcurrent;
  defaultAcp.value = settingsStore.settings.defaultAcp === true;
  wslEnabled.value = settingsStore.settings.wsl?.enabled ?? false;
  wslDistro.value = settingsStore.settings.wsl?.distro ?? "";
  wslDefaultCwd.value = settingsStore.settings.wsl?.defaultCwd || "/home";
  // Probe distros for the WSL section. Failures land in wslDiagnostic and only
  // disable the WSL controls, never the rest of the settings page. The store
  // tracks wslDistrosLoaded internally; the page only reads the results.
  void settingsStore.loadWslDistros();

  await loadPiSettings();
  baseline.value = formSnapshot.value;
  loading.value = false;
}
async function loadPiSettings(): Promise<void> {
  if (!rpc.isConnected.value) return;
  try {
    const s = await rpc.getPiSettings();
    if (!s) throw new Error("读取 Agent 配置失败，请重试。");
    applyPiSettings(s);
    piReady.value = true;
    piBaseline.value = piSnapshot.value;
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  }
  await Promise.allSettled([rpc.refreshModels(), authStore.refreshStatus()]);
  try {
    const result = await rpc.getCustomProviders();
    if (result) customProviderNames.value = new Set(Object.keys(result.providers));
  } catch (error) {
    authError.value = error instanceof Error ? error.message : String(error);
  }
}
onMounted(loadSettings);
watch(
  () => rpc.isConnected.value,
  async (connected) => {
    if (!connected || loading.value || piReady.value) return;
    const wasDirty = dirty.value;
    await loadPiSettings();
    if (!wasDirty) baseline.value = formSnapshot.value;
  },
);

watch(() => route.query.section, syncSectionFromRoute);

// Re-sync custom provider names when entering the auth section so the
// double-source guard reflects any providers added/removed in "自定义模型"
// since mount (CustomProviders.vue refreshes auth status on save but not this set).
watch(activeSection, async (section) => {
  await nextTick();
  if (settingsScroll.value) settingsScroll.value.scrollTop = 0;
  if (section !== "auth" || !rpc.isConnected.value) return;
  try {
    const result = await rpc.getCustomProviders();
    if (result) customProviderNames.value = new Set(Object.keys(result.providers));
  } catch {
    /* unavailable */
  }
});

function applyPiSettings(s: Record<string, unknown>): void {
  steeringMode.value = (s.steeringMode as "all" | "one-at-a-time") ?? "one-at-a-time";
  followUpMode.value = (s.followUpMode as "all" | "one-at-a-time") ?? "one-at-a-time";
  const execution = (s.execution && typeof s.execution === "object" ? s.execution : {}) as Record<string, unknown>;
  executionMode.value = execution.mode === "read-only" || execution.mode === "unattended" ? execution.mode : "approval";
  verificationGate.value = (execution.verificationGate ?? true) as boolean;
  const compaction = s.compaction as { enabled?: boolean } | undefined;
  const images = s.images as { autoResize?: boolean; blockImages?: boolean } | undefined;
  const retry = s.retry as { enabled?: boolean } | undefined;
  autoCompact.value = (s.compactionEnabled ?? compaction?.enabled ?? true) as boolean;
  quietStartup.value = (s.quietStartup ?? false) as boolean;
  if (s.enabledModels && Array.isArray(s.enabledModels)) enabledModels.value = s.enabledModels.join(", ");
  transport.value = (s.transport ?? "auto") as string;
  retryEnabled.value = (retry?.enabled ?? true) as boolean;
  imageAutoResize.value = (images?.autoResize ?? true) as boolean;
  blockImages.value = (images?.blockImages ?? false) as boolean;
  shellPath.value = (s.shellPath ?? "") as string;
  shellCommandPrefix.value = (s.shellCommandPrefix ?? "") as string;
  if (s.npmCommand && Array.isArray(s.npmCommand)) npmCommand.value = s.npmCommand.join(" ");
  httpIdleTimeoutMs.value = (s.httpIdleTimeoutMs ?? 0) as number;
  if (s.extensionPaths && Array.isArray(s.extensionPaths)) extensionPaths.value = s.extensionPaths.join(", ");
  if (s.skillPaths && Array.isArray(s.skillPaths)) skillPaths.value = s.skillPaths.join(", ");
  if (s.promptTemplatePaths && Array.isArray(s.promptTemplatePaths))
    promptTemplatePaths.value = s.promptTemplatePaths.join(", ");
  if (s.themePaths && Array.isArray(s.themePaths)) themePaths.value = s.themePaths.join(", ");
  enableSkillCommands.value = (s.enableSkillCommands ?? true) as boolean;
  autocompleteMaxVisible.value = (s.autocompleteMaxVisible ?? 5) as number;
}

function commaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalCommaList(value: string): string[] | undefined {
  const items = commaList(value);
  return items.length > 0 ? items : undefined;
}

function optionalSpaceList(value: string): string[] | undefined {
  const items = value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

async function saveSettings(): Promise<void> {
  if (saving.value || loading.value) return;
  saveError.value = "";
  if (piReady.value && piSnapshot.value !== piBaseline.value && !rpc.isConnected.value) {
    saveError.value = "Agent 配置尚未保存，请恢复会话连接后重试。";
    return;
  }
  if (wslEnabled.value && !wslDefaultCwdValid.value) {
    saveError.value = "请输入以 / 开头且不含反斜杠的 Linux 路径。";
    selectSection("environment");
    return;
  }
  if (
    !Number.isInteger(agentTaskMaxConcurrent.value) ||
    agentTaskMaxConcurrent.value < 1 ||
    agentTaskMaxConcurrent.value > AGENT_TASK_MAX_RUNNING_SLOTS
  ) {
    saveError.value = "Agent 并发上限须为 1–8 的整数。";
    selectSection("plan");
    return;
  }
  if (
    !Number.isInteger(autocompleteMaxVisible.value) ||
    autocompleteMaxVisible.value < 3 ||
    autocompleteMaxVisible.value > 20
  ) {
    saveError.value = "自动补全显示数须为 3–20 的整数。";
    selectSection("advanced");
    return;
  }
  saving.value = true;
  saved.value = false;
  const submittedForm = formSnapshot.value;
  const submittedPi = piSnapshot.value;
  const setters: [string, unknown][] = [
    ["steeringMode", steeringMode.value],
    ["followUpMode", followUpMode.value],
    ["executionMode", executionMode.value],
    ["verificationGate", verificationGate.value],
    ["compactEnabled", autoCompact.value],
    ["quietStartup", quietStartup.value],
    ["enabledModels", optionalCommaList(enabledModels.value)],
    ["transport", transport.value],
    ["retryEnabled", retryEnabled.value],
    ["autoResizeImages", imageAutoResize.value],
    ["blockImages", blockImages.value],
    ["shellPath", shellPath.value || undefined],
    ["shellCommandPrefix", shellCommandPrefix.value || undefined],
    ["npmCommand", optionalSpaceList(npmCommand.value)],
    ["httpIdleTimeoutMs", httpIdleTimeoutMs.value || 0],
    ["extensionPaths", commaList(extensionPaths.value)],
    ["skillPaths", commaList(skillPaths.value)],
    ["promptTemplatePaths", commaList(promptTemplatePaths.value)],
    ["themePaths", commaList(themePaths.value)],
    ["enableSkillCommands", enableSkillCommands.value],
    ["autocompleteMaxVisible", autocompleteMaxVisible.value],
  ];
  try {
    const selectedEyeModel = parseModelKey(takeHerEyesModel.value);
    const selectedPlanModel = parseModelKey(planModelKey.value);
    await settingsStore.save({
      defaultModel: defaultModel.value || undefined,
      defaultProvider: defaultProvider.value || undefined,
      defaultThinkingLevel: defaultThinkingLevel.value,
      takeHerEyes: {
        enabled: takeHerEyesEnabled.value,
        provider: selectedEyeModel?.provider,
        modelId: selectedEyeModel?.modelId,
      },
      // 1.4.0 plan-mode settings; empty selection persists as undefined
      // ("inherit the session model").
      planModel: selectedPlanModel,
      planThinkingLevel: planThinkingLevel.value || undefined,
      enableProductAnalytics: enableProductAnalytics.value,
      // 1.4.1: auto-background threshold; 0 = off.
      autoBackgroundMs: autoBackgroundMs.value,
      agentTaskMaxConcurrent: agentTaskMaxConcurrent.value,
      defaultAcp: defaultAcp.value === true ? true : undefined,
      wsl: {
        enabled: wslEnabled.value,
        distro: wslDistro.value,
        defaultCwd: wslDefaultCwd.value.trim() || "/home",
      },
    });
    if (rpc.isConnected.value && piReady.value) {
      await rpc.setPiSettings(setters.map(([key, value]) => ({ key, value })));
      piBaseline.value = submittedPi;
      await Promise.all([rpc.refreshState(), rpc.refreshModels(), rpc.refreshCommands()]);
    }
    baseline.value = submittedForm;
    saved.value = !dirty.value;
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error);
  } finally {
    saving.value = false;
  }
}

function goBack(): void {
  if (saving.value || authBusy.value) return;
  if (dirty.value || providersDirty.value || Object.values(editingKeys.value).some((key) => key.trim() !== "")) {
    showDiscardDialog.value = true;
    return;
  }
  leaveSettings();
}

function leaveSettings(): void {
  showDiscardDialog.value = false;
  if (typeof router.push === "function") void router.push(rpc.isConnected.value ? "/workspace" : "/");
  else router.back();
}

async function checkForUpdates(): Promise<void> {
  checkingUpdate.value = true;
  updateError.value = null;
  updateInfo.value = null;
  try {
    const result = await window.pixApi.checkForUpdates();
    if (result.success) {
      updateInfo.value = {
        hasUpdate: result.hasUpdate ?? false,
        currentVersion: result.currentVersion ?? "",
        latestVersion: result.latestVersion,
        releaseNotes: result.releaseNotes,
      };
    } else {
      updateError.value = result.error ?? "检查更新失败";
    }
  } catch (err) {
    updateError.value = err instanceof Error ? err.message : String(err);
  } finally {
    checkingUpdate.value = false;
  }
}

async function downloadAndInstall(): Promise<void> {
  downloading.value = true;
  updateError.value = null;
  try {
    const result = await window.pixApi.downloadUpdate();
    if (result.success) {
      window.pixApi.installUpdate();
    } else {
      updateError.value = result.error ?? "下载更新失败";
    }
  } catch (err) {
    updateError.value = err instanceof Error ? err.message : String(err);
  } finally {
    downloading.value = false;
  }
}
</script>

<template>
  <div class="settings-page">
    <nav ref="navigation" class="settings-sidebar" :class="{ open: navigationOpen }" aria-label="设置分类">
      <div class="sidebar-brand"><span class="brand-mark">P</span><strong>PiX</strong><span>设置</span></div>
      <input
        v-model="searchQuery"
        class="settings-search"
        type="search"
        placeholder="搜索设置…"
        aria-label="搜索设置"
      />
      <div class="navigation-groups">
        <div v-for="group in filteredGroups" :key="group.label" class="navigation-group">
          <h2>{{ group.label }}</h2>
          <button
            v-for="section in group.sections"
            :key="section.key"
            class="sidebar-item"
            :class="{ active: activeSection === section.key }"
            :aria-current="activeSection === section.key ? 'page' : undefined"
            @click="selectSection(section.key)"
          >
            <v-icon :icon="section.icon" size="18" /><span>{{ section.label }}</span>
          </button>
        </div>
        <p v-if="filteredGroups.length === 0" class="empty-search">没有匹配的设置</p>
      </div>
      <button class="sidebar-back" :disabled="saving || !!authBusy" @click="goBack"><v-icon icon="mdi-arrow-left" size="18" />返回对话</button>
    </nav>
    <button
      v-if="navigationOpen"
      class="navigation-backdrop"
      tabindex="-1"
      aria-label="关闭设置分类"
      @click="closeNavigation"
    />
    <main class="settings-main" :inert="navigationOpen">
      <WindowTitlebar class="settings-topbar">
        <button
          ref="menuButton"
          class="settings-mobile-menu"
          aria-label="打开设置分类"
          :aria-expanded="navigationOpen"
          @click="navigationOpen = true"
        >
          <v-icon icon="mdi-menu" size="20" />
        </button>
        <span>设置</span><span class="breadcrumb-separator">/</span><strong>{{ currentSection.label }}</strong>
      </WindowTitlebar>
      <div ref="settingsScroll" class="settings-scroll">
        <div class="settings-content">
          <div v-if="loading" class="load-notice" role="status">正在读取设置…</div>
          <v-alert v-if="loadError" type="error" density="compact" class="mb-4"
            >{{ loadError }}<button class="inline-retry" @click="loadSettings">重试</button></v-alert
          >
          <div v-if="!loading && (!rpc.isConnected.value || !piReady)" class="connection-notice" role="status">
            {{ rpc.isConnected.value ? "Agent 配置尚未读取。" : "会话未连接，Agent 配置暂不可编辑。" }}
          </div>
          <div :inert="loading || !guiReady" class="settings-panels">
            <section v-show="activeSection === 'general'" class="section-panel" aria-label="general">
              <h1 class="section-title">{{ sections.find((section) => section.key === "general")?.label }}</h1>
              <p class="section-desc">{{ sections.find((section) => section.key === "general")?.description }}</p>
              <SettingsGroup title="权限">
                <SettingsRow
                  title="默认执行模式"
                  control-id="setting-executionMode"
                  description="高风险操作执行前，向你请求批准。"
                >
                  <v-select
                    v-model="executionMode"
                    data-test="execution-mode-select"
                    id="setting-executionMode"
                    aria-label="默认执行模式"
                    density="compact"
                    :items="executionModeItems"
                    item-title="title"
                    item-value="value"
                    hide-details
                    :disabled="!piReady || !rpc.isConnected.value"
                  />
                </SettingsRow>
                <SettingsRow
                  title="完成前验证"
                  control-id="setting-verificationGate"
                  description="提醒 Agent 在宣告完成前检查结果。"
                >
                  <v-switch
                    v-model="verificationGate"
                    id="setting-verificationGate"
                    aria-label="完成前验证"
                    density="compact"
                    label="完成前验证"
                    hide-details
                    :disabled="!piReady || !rpc.isConnected.value"
                  />
                </SettingsRow>
              </SettingsGroup>
              <SettingsGroup title="对话">
                <SettingsRow
                  title="默认思考强度"
                  control-id="setting-defaultThinkingLevel"
                  description="新会话采用的推理深度，可在对话中调整。"
                >
                  <v-select
                    v-model="defaultThinkingLevel"
                    id="setting-defaultThinkingLevel"
                    aria-label="默认思考强度"
                    density="compact"
                    :items="thinkingLevelItems"
                    item-title="title"
                    item-value="value"
                    hide-details
                  />
                </SettingsRow>
                <SettingsRow
                  title="运行中的引导消息"
                  control-id="setting-steeringMode"
                  description="Agent 运行时发送的新消息如何进入当前流程。"
                >
                  <v-select
                    v-model="steeringMode"
                    id="setting-steeringMode"
                    aria-label="运行中的引导消息"
                    density="compact"
                    :items="steeringModeItems"
                    item-title="title"
                    item-value="value"
                    hide-details
                    :disabled="!piReady || !rpc.isConnected.value"
                  />
                </SettingsRow>
                <SettingsRow
                  title="后续消息"
                  control-id="setting-followUpMode"
                  description="本轮结束后，如何处理等待中的消息。"
                >
                  <v-select
                    v-model="followUpMode"
                    id="setting-followUpMode"
                    aria-label="后续消息"
                    density="compact"
                    :items="steeringModeItems"
                    item-title="title"
                    item-value="value"
                    hide-details
                    :disabled="!piReady || !rpc.isConnected.value"
                  />
                </SettingsRow>
              </SettingsGroup>
              <SettingsGroup title="上下文与启动">
                <SettingsRow
                  title="自动压缩上下文"
                  control-id="setting-autoCompact"
                  description="接近上下文容量上限时自动压缩。"
                >
                  <v-switch
                    v-model="autoCompact"
                    id="setting-autoCompact"
                    aria-label="自动压缩上下文"
                    density="compact"
                    label="自动压缩上下文"
                    hide-details
                    :disabled="!piReady || !rpc.isConnected.value"
                  />
                </SettingsRow>
                <SettingsRow
                  title="新会话默认主动压缩"
                  control-id="setting-defaultAcp"
                  description="仅影响新建的空会话，当前会话可在对话中切换。"
                >
                  <v-switch
                    v-model="defaultAcp"
                    id="setting-defaultAcp"
                    aria-label="新会话默认主动压缩"
                    density="compact"
                    label="新会话默认主动压缩"
                    hide-details
                    data-test="default-acp-switch"
                  />
                </SettingsRow>
                <SettingsRow title="安静启动" control-id="setting-quietStartup" description="减少启动时的提示信息。">
                  <v-switch
                    v-model="quietStartup"
                    id="setting-quietStartup"
                    aria-label="安静启动"
                    density="compact"
                    label="安静启动"
                    hide-details
                    :disabled="!piReady || !rpc.isConnected.value"
                  />
                </SettingsRow>
              </SettingsGroup>
            </section>
            <section v-show="activeSection === 'plan'" class="section-panel" aria-label="plan">
              <h1 class="section-title">{{ sections.find((section) => section.key === "plan")?.label }}</h1>
              <p class="section-desc">{{ sections.find((section) => section.key === "plan")?.description }}</p>
              <SettingsGroup title="规划">
                <SettingsRow
                  title="规划模型"
                  control-id="setting-planModelKey"
                  description="未指定时继承当前会话模型。"
                >
                  <v-select
                    v-model="planModelKey"
                    id="setting-planModelKey"
                    aria-label="规划模型"
                    density="compact"
                    :items="planModelItems"
                    item-title="title"
                    item-value="value"
                    hide-details
                    data-test="plan-model-select"
                  />
                </SettingsRow>
                <SettingsRow
                  title="规划思考强度"
                  control-id="setting-planThinkingLevel"
                  description="未指定时继承会话默认。"
                >
                  <v-select
                    v-model="planThinkingLevel"
                    id="setting-planThinkingLevel"
                    aria-label="规划思考强度"
                    density="compact"
                    :items="planThinkingLevelItems"
                    item-title="title"
                    item-value="value"
                    hide-details
                    data-test="plan-thinking-select"
                  />
                </SettingsRow>
              </SettingsGroup>
              <SettingsGroup title="Agent 任务">
                <SettingsRow
                  title="自动后台化阈值"
                  control-id="setting-autoBackgroundMs"
                  description="到达阈值后显示后台提示，父 Agent 仍等待结果；手动转后台或 run_in_background 才会立即返回。"
                >
                  <v-select
                    v-model="autoBackgroundMs"
                    id="setting-autoBackgroundMs"
                    aria-label="自动后台化阈值"
                    density="compact"
                    :items="autoBackgroundMsItems"
                    item-title="title"
                    item-value="value"
                    hide-details
                    data-test="auto-background-select"
                  />
                </SettingsRow>
                <SettingsRow
                  title="子 Agent 并发上限"
                  control-id="setting-agentTaskMaxConcurrent"
                  description="运行和等待输入的任务合计，超额排队。"
                >
                  <v-slider
                    v-model="agentTaskMaxConcurrent"
                    id="setting-agentTaskMaxConcurrent"
                    aria-label="子 Agent 并发上限"
                    density="compact"
                    :min="1"
                    :max="AGENT_TASK_MAX_RUNNING_SLOTS"
                    :step="1"
                    show-ticks="always"
                    :ticks="agentTaskConcurrentTicks"
                    tick-size="4"
                    thumb-label="always"
                    hide-details
                    data-test="agent-task-max-concurrent-slider"
                  />
                </SettingsRow>
              </SettingsGroup>
            </section>
            <section v-show="activeSection === 'images'" class="section-panel" aria-label="images">
              <h1 class="section-title">{{ sections.find((section) => section.key === "images")?.label }}</h1>
              <p class="section-desc">{{ sections.find((section) => section.key === "images")?.description }}</p>
              <SettingsGroup title="图片输入">
                <SettingsRow
                  title="自动调整图片大小"
                  control-id="setting-imageAutoResize"
                  description="发送前自动缩放大图片。"
                >
                  <v-switch
                    v-model="imageAutoResize"
                    id="setting-imageAutoResize"
                    aria-label="自动调整图片大小"
                    density="compact"
                    label="自动调整图片大小"
                    hide-details
                    :disabled="!piReady || !rpc.isConnected.value"
                  />
                </SettingsRow>
                <SettingsRow
                  title="阻止图片"
                  control-id="setting-blockImages"
                  description="阻止向任何模型发送图片，优先于眼睛模型。"
                >
                  <v-switch
                    v-model="blockImages"
                    id="setting-blockImages"
                    aria-label="阻止图片"
                    density="compact"
                    label="阻止图片"
                    hide-details
                    :disabled="!piReady || !rpc.isConnected.value"
                  />
                </SettingsRow>
              </SettingsGroup>
              <SettingsGroup title="眼睛模型">
                <SettingsRow
                  title="启用眼睛模型"
                  control-id="setting-takeHerEyesEnabled"
                  description="主模型不支持图片时，使用视觉模型生成图片上下文。"
                >
                  <v-switch
                    v-model="takeHerEyesEnabled"
                    id="setting-takeHerEyesEnabled"
                    aria-label="启用眼睛模型"
                    density="compact"
                    label="启用眼睛模型"
                    hide-details
                    :disabled="blockImages"
                  />
                </SettingsRow>
                <SettingsRow
                  title="眼睛模型"
                  control-id="setting-takeHerEyesModel"
                  description="仅显示已认证且支持图片输入的模型。"
                >
                  <v-select
                    v-model="takeHerEyesModel"
                    id="setting-takeHerEyesModel"
                    aria-label="眼睛模型"
                    density="compact"
                    :items="visionModelItems"
                    item-title="title"
                    item-value="value"
                    hide-details
                    :disabled="!takeHerEyesEnabled || blockImages"
                    no-data-text="没有可用的视觉模型"
                  />
                </SettingsRow>
              </SettingsGroup>
            </section>
            <section v-show="activeSection === 'environment'" class="section-panel" aria-label="environment">
              <h1 class="section-title">{{ sections.find((section) => section.key === "environment")?.label }}</h1>
              <p class="section-desc">{{ sections.find((section) => section.key === "environment")?.description }}</p>
              <SettingsGroup title="Shell 与网络">
                <SettingsRow
                  title="Shell 路径"
                  control-id="setting-shellPath"
                  description="Shell 可执行文件路径；WSL 在下方配置。"
                  wide
                >
                  <v-text-field
                    v-model="shellPath"
                    id="setting-shellPath"
                    aria-label="Shell 路径"
                    density="compact"
                    hide-details="auto"
                    :disabled="!piReady || !rpc.isConnected.value"
                    placeholder="自动检测"
                  />
                </SettingsRow>
                <SettingsRow
                  title="Shell 命令前缀"
                  control-id="setting-shellCommandPrefix"
                  description="每个 Bash 命令的前缀。"
                  wide
                >
                  <v-text-field
                    v-model="shellCommandPrefix"
                    id="setting-shellCommandPrefix"
                    aria-label="Shell 命令前缀"
                    density="compact"
                    hide-details="auto"
                    :disabled="!piReady || !rpc.isConnected.value"
                    placeholder="无"
                  />
                </SettingsRow>
                <SettingsRow title="npm 命令" control-id="setting-npmCommand" description="命令与参数使用空格分隔。">
                  <v-text-field
                    v-model="npmCommand"
                    id="setting-npmCommand"
                    aria-label="npm 命令"
                    density="compact"
                    hide-details="auto"
                    :disabled="!piReady || !rpc.isConnected.value"
                    placeholder="npm"
                  />
                </SettingsRow>
                <SettingsRow
                  title="HTTP 空闲超时（毫秒）"
                  control-id="setting-httpIdleTimeoutMs"
                  description="0 使用服务器默认值。"
                >
                  <v-text-field
                    v-model.number="httpIdleTimeoutMs"
                    id="setting-httpIdleTimeoutMs"
                    aria-label="HTTP 空闲超时（毫秒）"
                    density="compact"
                    type="number"
                    hide-details="auto"
                    :disabled="!piReady || !rpc.isConnected.value"
                    min="0"
                  />
                </SettingsRow>
              </SettingsGroup>
              <v-alert
                v-if="settingsStore.wslDiagnostic"
                type="warning"
                variant="tonal"
                density="compact"
                class="mb-4"
                title="WSL 不可用"
                >{{ settingsStore.wslDiagnostic
                }}<button class="inline-retry" @click="settingsStore.loadWslDistros()">重新探测</button></v-alert
              ><SettingsGroup title="WSL2">
                <SettingsRow
                  title="启用 WSL2"
                  control-id="setting-wslEnabled"
                  description="作为新建项目的默认环境，不影响当前项目。"
                >
                  <v-switch
                    v-model="wslEnabled"
                    id="setting-wslEnabled"
                    aria-label="启用 WSL2"
                    density="compact"
                    label="启用 WSL2"
                    hide-details
                  />
                </SettingsRow>
                <SettingsRow title="默认发行版" control-id="setting-wslDistro" description="新项目须显式选择发行版。">
                  <v-select
                    v-model="wslDistro"
                    id="setting-wslDistro"
                    aria-label="默认发行版"
                    density="compact"
                    :items="wslDistroItems"
                    item-title="title"
                    item-value="value"
                    hide-details
                    :disabled="!wslEnabled || !settingsStore.wslDistrosLoaded || wslDistroItems.length === 0"
                    no-data-text="未发现 WSL2 发行版"
                  />
                </SettingsRow>
                <SettingsRow
                  title="默认项目目录"
                  control-id="setting-wslDefaultCwd"
                  description="绝对 Linux 路径，以 / 开头。"
                  wide
                >
                  <v-text-field
                    v-model="wslDefaultCwd"
                    id="setting-wslDefaultCwd"
                    aria-label="默认项目目录"
                    density="compact"
                    hide-details="auto"
                    :disabled="!wslEnabled"
                    :error-messages="wslDefaultCwd && !wslDefaultCwdValid ? '请输入绝对 Linux 路径' : ''"
                  />
                </SettingsRow>
              </SettingsGroup>
            </section>
            <section v-show="activeSection === 'resources'" class="section-panel" aria-label="resources">
              <h1 class="section-title">{{ sections.find((section) => section.key === "resources")?.label }}</h1>
              <p class="section-desc">{{ sections.find((section) => section.key === "resources")?.description }}</p>
              <SettingsGroup title="资源路径">
                <SettingsRow
                  title="扩展路径"
                  control-id="setting-extensionPaths"
                  description="逗号分隔的扩展文件或目录路径。"
                  wide
                >
                  <v-text-field
                    v-model="extensionPaths"
                    id="setting-extensionPaths"
                    aria-label="扩展路径"
                    density="compact"
                    hide-details="auto"
                    :disabled="!piReady || !rpc.isConnected.value"
                  />
                </SettingsRow>
                <SettingsRow
                  title="技能路径"
                  control-id="setting-skillPaths"
                  description="逗号分隔的技能目录路径。"
                  wide
                >
                  <v-text-field
                    v-model="skillPaths"
                    id="setting-skillPaths"
                    aria-label="技能路径"
                    density="compact"
                    hide-details="auto"
                    :disabled="!piReady || !rpc.isConnected.value"
                  />
                </SettingsRow>
                <SettingsRow
                  title="提示模板路径"
                  control-id="setting-promptTemplatePaths"
                  description="逗号分隔的提示模板目录路径。"
                  wide
                >
                  <v-text-field
                    v-model="promptTemplatePaths"
                    id="setting-promptTemplatePaths"
                    aria-label="提示模板路径"
                    density="compact"
                    hide-details="auto"
                    :disabled="!piReady || !rpc.isConnected.value"
                  />
                </SettingsRow>
                <SettingsRow
                  title="主题路径"
                  control-id="setting-themePaths"
                  description="逗号分隔的主题目录路径。"
                  wide
                >
                  <v-text-field
                    v-model="themePaths"
                    id="setting-themePaths"
                    aria-label="主题路径"
                    density="compact"
                    hide-details="auto"
                    :disabled="!piReady || !rpc.isConnected.value"
                  />
                </SettingsRow>
              </SettingsGroup>
              <SettingsGroup title="加载">
                <SettingsRow
                  title="启用技能命令"
                  control-id="setting-enableSkillCommands"
                  description="允许技能注册斜杠命令。"
                >
                  <v-switch
                    v-model="enableSkillCommands"
                    id="setting-enableSkillCommands"
                    aria-label="启用技能命令"
                    density="compact"
                    label="启用技能命令"
                    hide-details
                    :disabled="!piReady || !rpc.isConnected.value"
                  />
                </SettingsRow>
                <SettingsRow title="重新加载资源"
                  ><v-btn
                    variant="outlined"
                    :loading="reloadingResources"
                    :disabled="!rpc.isConnected.value"
                    @click="reloadResources"
                    >重新加载资源</v-btn
                  ></SettingsRow
                >
                <p v-if="resourceFeedback" class="resource-feedback" :class="{ error: resourceError }" role="status">
                  {{ resourceFeedback }}
                </p></SettingsGroup
              >
            </section>
            <section v-show="activeSection === 'model'" class="section-panel" aria-label="model">
              <h1 class="section-title">{{ sections.find((section) => section.key === "model")?.label }}</h1>
              <p class="section-desc">{{ sections.find((section) => section.key === "model")?.description }}</p>
              <SettingsGroup title="模型目录">
                <SettingsRow
                  title="启用的模型"
                  control-id="setting-enabledModels"
                  description="逗号分隔的 glob 规则；留空启用所有模型。"
                  wide
                >
                  <v-text-field
                    v-model="enabledModels"
                    id="setting-enabledModels"
                    aria-label="启用的模型"
                    density="compact"
                    hide-details="auto"
                    :disabled="!piReady || !rpc.isConnected.value"
                    placeholder="anthropic/*, openai/gpt-5*"
                  />
                </SettingsRow>
              </SettingsGroup>
              <SettingsGroup title="连接">
                <SettingsRow title="传输方式" control-id="setting-transport">
                  <v-select
                    v-model="transport"
                    id="setting-transport"
                    aria-label="传输方式"
                    density="compact"
                    :items="transportOptions"
                    item-title="title"
                    item-value="value"
                    hide-details
                    :disabled="!piReady || !rpc.isConnected.value"
                  />
                </SettingsRow>
                <SettingsRow title="自动重试" control-id="setting-retryEnabled" description="自动重试失败的 API 请求。">
                  <v-switch
                    v-model="retryEnabled"
                    id="setting-retryEnabled"
                    aria-label="自动重试"
                    density="compact"
                    label="自动重试"
                    hide-details
                    :disabled="!piReady || !rpc.isConnected.value"
                  />
                </SettingsRow>
              </SettingsGroup>
            </section>
            <div v-show="activeSection === 'custom'" class="section-panel"><CustomProviders @dirty-change="providersDirty = $event" /></div>
            <div v-show="activeSection === 'mcp'" class="section-panel"><McpSettings /></div>
            <section v-show="activeSection === 'auth'" class="section-panel" aria-label="auth">
              <h1 class="section-title">{{ sections.find((section) => section.key === "auth")?.label }}</h1>
              <p class="section-desc">{{ sections.find((section) => section.key === "auth")?.description }}</p>
              <v-alert v-if="authError" type="error" density="compact" class="mb-4">{{ authError }}</v-alert>
              <div v-if="!rpc.isConnected.value" class="auth-notice"><p>请先启动会话再配置 API 密钥。</p></div>
              <div v-else-if="authStore.providerCount === 0" class="auth-notice"><p>未检测到模型提供商。</p></div>
              <div v-else class="auth-list">
                <v-card
                  v-for="(status, provider) in authStore.authStatus"
                  :key="provider"
                  :border="status.configured ? 'success' : undefined"
                  variant="outlined"
                  class="auth-card mb-3"
                >
                  <div
                    class="auth-provider-row"
                    role="button"
                    tabindex="0"
                    @keydown.enter="toggleEditProvider(provider)"
                    @keydown.space.prevent="toggleEditProvider(provider)"
                    @click="toggleEditProvider(provider)"
                  >
                    <div class="auth-provider-info">
                      <span class="auth-provider-name">{{ provider }}</span>
                      <span v-if="status.label" class="auth-provider-label">{{ status.label }}</span>
                      <button v-if="customProviderNames.has(provider)" class="auth-custom-hint" type="button" @click.stop="selectSection('custom')"
                        >前往「自定义提供商」管理密钥</button
                      >
                    </div>
                    <div class="auth-status-info">
                      <v-icon
                        size="small"
                        :color="status.configured ? 'success' : undefined"
                        :icon="status.configured ? 'mdi-check-circle' : 'mdi-circle-outline'"
                      />
                      <span class="auth-status-text">{{ status.configured ? "已配置" : "未配置" }}</span>
                      <span v-if="status.source" class="auth-source">来源 {{ status.source }}</span>
                      <v-icon
                        v-if="customProviderNames.has(provider)"
                        size="small"
                        class="ml-2"
                        icon="mdi-lock-outline"
                      />
                      <v-icon v-else size="small" class="ml-2">{{
                        editingProvider === provider ? "mdi-chevron-up" : "mdi-chevron-down"
                      }}</v-icon>
                    </div>
                  </div>
                  <div v-if="editingProvider === provider" class="auth-edit-row">
                    <v-text-field
                      v-model="editingKeys[provider]"
                      type="password"
                      aria-label="API 密钥"
                      :disabled="customProviderNames.has(provider)"
                      :placeholder="status.configured ? '输入新密钥以替换...' : '粘贴 API 密钥...'"
                      hide-details
                      density="comfortable"
                      @keydown.enter="saveKey(provider)"
                      class="mb-3"
                    />
                    <div class="auth-btn-group">
                      <v-btn
                        size="small"
                        color="primary"
                        variant="tonal"
                        :loading="authBusy === provider"
                        :disabled="!!authBusy || customProviderNames.has(provider) || !editingKeys[provider]?.trim()"
                        @click="saveKey(provider)"
                        >保存</v-btn
                      >
                      <v-btn
                        v-if="status.configured"
                        size="small"
                        color="error"
                        variant="text"
                        :disabled="!!authBusy || customProviderNames.has(provider)"
                        @click="pendingAuthDelete = provider"
                        >删除</v-btn
                      >
                    </div>
                  </div>
                </v-card>
              </div>
            </section>
            <section v-show="activeSection === 'advanced'" class="section-panel" aria-label="advanced">
              <h1 class="section-title">{{ sections.find((section) => section.key === "advanced")?.label }}</h1>
              <p class="section-desc">{{ sections.find((section) => section.key === "advanced")?.description }}</p>
              <SettingsGroup title="交互与使用数据">
                <SettingsRow
                  title="自动补全最大显示数"
                  control-id="setting-autocompleteMaxVisible"
                  description="显示 3–20 条补全建议。"
                >
                  <v-text-field
                    v-model.number="autocompleteMaxVisible"
                    id="setting-autocompleteMaxVisible"
                    aria-label="自动补全最大显示数"
                    density="compact"
                    type="number"
                    hide-details="auto"
                    :disabled="!piReady || !rpc.isConnected.value"
                    min="3"
                    max="20"
                  />
                </SettingsRow>
                <SettingsRow
                  title="匿名使用数据"
                  control-id="setting-enableProductAnalytics"
                  description="收集匿名规划使用数据，默认关闭。"
                >
                  <v-switch
                    v-model="enableProductAnalytics"
                    id="setting-enableProductAnalytics"
                    aria-label="匿名使用数据"
                    density="compact"
                    label="匿名使用数据"
                    hide-details
                    data-test="analytics-switch"
                  />
                </SettingsRow>
              </SettingsGroup>
              <SettingsGroup title="应用更新">
                <div class="update-section">
                  <div class="setting-subheader">
                    <v-icon size="20" icon="mdi-update" />
                    <div>
                      <div class="setting-subtitle">应用更新</div>
                      <div class="setting-caption">检查并安装最新版本。</div>
                    </div>
                  </div>
                  <div class="update-actions">
                    <v-btn
                      variant="outlined"
                      :loading="checkingUpdate"
                      :disabled="downloading"
                      @click="checkForUpdates"
                    >
                      检查更新
                    </v-btn>
                    <v-btn
                      v-if="updateInfo?.hasUpdate"
                      color="primary"
                      variant="tonal"
                      :loading="downloading"
                      :disabled="checkingUpdate"
                      @click="downloadAndInstall"
                    >
                      下载并安装
                    </v-btn>
                  </div>
                  <div v-if="updateInfo && !updateInfo.hasUpdate" class="update-status success">
                    <v-icon size="small" icon="mdi-check-circle" />
                    <span>当前已是最新版本 ({{ updateInfo.currentVersion }})</span>
                  </div>
                  <div v-if="updateInfo?.hasUpdate" class="update-status info">
                    <v-icon size="small" icon="mdi-information" />
                    <span>发现新版本 {{ updateInfo.latestVersion }} (当前: {{ updateInfo.currentVersion }})</span>
                  </div>
                  <div v-if="updateError" class="update-status error">
                    <v-icon size="small" icon="mdi-alert-circle" />
                    <span>{{ updateError }}</span>
                  </div>
                </div>
              </SettingsGroup>
              <SettingsGroup title="诊断信息">
                <div class="advanced-info">
                  <div class="info-row"><span>集成方式</span><span>AgentSession 进程内直连</span></div>
                  <div class="info-row"><span>数据目录</span><code>~/.pi/agent/</code></div>
                  <div class="info-row"><span>会话存储</span><code>~/.pi/agent/sessions/</code></div>
                  <div class="info-row"><span>设置文件</span><code>~/.pi/agent/settings.json</code></div>
                </div></SettingsGroup
              >
            </section>
          </div>
        </div>
      </div>
      <footer class="settings-actions">
        <div class="save-feedback" role="status" :class="{ error: saveError }">
          <span v-if="saveError">{{ saveError }}</span>
          <span v-else-if="saving">正在保存…</span>
          <span v-else-if="dirty || providersDirty">有未保存的修改</span>
          <span v-else-if="saved">{{ rpc.isConnected.value && piReady ? "已保存" : "应用设置已保存" }}</span>
          <span v-else-if="activeSection === 'custom'">提供商配置单独保存</span>
          <span v-else-if="activeSection === 'auth'">密钥单独保存</span>
          <span v-else-if="activeSection === 'mcp'">编辑配置文件后刷新连接</span>
          <span v-else>尚未修改</span>
        </div>
        <v-btn
          v-if="!['custom', 'auth', 'mcp'].includes(activeSection)"
          color="primary"
          variant="flat"
          :loading="saving"
          :disabled="loading || !guiReady || saving"
          @click="saveSettings"
          >保存设置</v-btn
        >
      </footer>
    </main>
    <v-dialog v-model="showDiscardDialog" max-width="420">
      <v-card title="放弃未保存的修改？">
        <v-card-text>离开后，未保存的设置和密钥输入将丢失。</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="showDiscardDialog = false">继续编辑</v-btn>
          <v-btn color="error" variant="tonal" @click="leaveSettings">放弃并返回</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog v-model="showAuthDeleteDialog" max-width="420">
      <v-card title="删除 API 密钥">
        <v-card-text>确定删除「{{ pendingAuthDelete }}」已保存的 API 密钥？删除后需重新输入才能恢复。</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="pendingAuthDelete = null">取消</v-btn>
          <v-btn color="error" variant="tonal" :disabled="!!authBusy" @click="confirmDeleteKey">确认删除</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
<style scoped>
.settings-page {
  height: 100%;
  display: flex;
  overflow: hidden;
  position: relative;
  background: white;
}
.settings-sidebar {
  width: 258px;
  flex: 0 0 258px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--pix-border-light);
  background: var(--pix-bg-left);
}
.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 76px;
  padding: 0 22px;
  -webkit-app-region: drag;
}
.sidebar-brand strong {
  font-size: 22px;
}
.sidebar-brand > span:last-child {
  border-left: 1px solid var(--pix-border);
  padding-left: 12px;
  margin-left: 3px;
  font-size: 16px;
  font-weight: 600;
}
.brand-mark {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--pix-accent);
  color: white;
  border-radius: 9px;
  font-size: 23px;
  font-weight: 600;
}
.settings-search {
  height: 38px;
  min-height: 38px;
  margin: 0 16px 16px;
  padding: 0 12px;
  background: white;
  border: 1px solid var(--pix-border);
  border-radius: 8px;
  font-size: 13px;
}
.navigation-groups {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 12px 20px;
}
.navigation-group {
  margin-bottom: 16px;
}
.navigation-group h2 {
  padding: 10px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--pix-text-secondary);
}
.sidebar-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 40px;
  padding: 10px 13px;
  border-radius: 7px;
  font-size: 14px;
  text-align: left;
}
.sidebar-item.active {
  color: var(--pix-accent);
  background: #eeeaf9;
  font-weight: 600;
}
.sidebar-item:hover {
  background: var(--pix-accent-light);
}
.sidebar-back {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 65px;
  border-top: 1px solid var(--pix-border-light);
  padding: 0 24px;
  font-size: 14px;
}
.sidebar-back:hover {
  color: var(--pix-accent);
}
.settings-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.settings-topbar {
  --pix-titlebar-padding: 38px;
  gap: 12px;
  font-size: 14px;
}
.settings-topbar strong {
  font-weight: 600;
}
.breadcrumb-separator {
  color: var(--pix-text-muted);
}
.settings-mobile-menu {
  display: none;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  -webkit-app-region: no-drag;
}
.settings-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.settings-content {
  max-width: 1080px;
  margin: 0 auto;
  padding: 32px 44px;
}
.section-panel {
  width: 100%;
  min-width: 0;
}
.section-title,
.settings-content :deep(.section-title) {
  font-size: 26px;
  font-weight: 600;
  margin: 0 0 6px;
  line-height: 1.4;
}
.section-desc,
.settings-content :deep(.section-desc) {
  font-size: 12.5px;
  color: #747b87;
  margin-bottom: 30px;
  line-height: 1.7;
}
.settings-actions {
  min-height: 65px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 44px;
  border-top: 1px solid var(--pix-border-light);
  flex-shrink: 0;
}
.save-feedback {
  font-size: 13px;
  overflow-wrap: anywhere;
  min-width: 0;
}
.save-feedback.error {
  color: var(--pix-error);
}
.resource-feedback {
  padding: 10px 0;
  font-size: 13px;
  color: var(--pix-success);
}
.resource-feedback.error {
  color: var(--pix-error);
}
.settings-actions .v-btn {
  min-width: 104px;
  height: 34px;
  font-size: 13px;
  flex-shrink: 0;
}
.load-notice,
.connection-notice {
  padding: 12px 14px;
  margin-bottom: 20px;
  background: var(--pix-bg-code);
  border: 1px solid var(--pix-border);
  border-radius: 8px;
  font-size: 13px;
}
.inline-retry {
  margin-left: 12px;
  color: var(--pix-accent);
  font-size: 13px;
}
.empty-search {
  padding: 20px 12px;
  font-size: 13px;
  color: var(--pix-text-muted);
}
.auth-list {
  display: flex;
  flex-direction: column;
}
.auth-card {
  padding: 0 18px;
  border: 1px solid var(--pix-border);
  border-radius: 11px !important;
  margin-bottom: 14px;
  box-shadow: none;
}
.auth-provider-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  min-height: 70px;
  padding: 13px 0;
  cursor: pointer;
  flex-wrap: wrap;
}
.auth-provider-info,
.auth-status-info {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
}
.auth-provider-name {
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.auth-provider-label,
.auth-source,
.auth-custom-hint {
  font-size: 12px;
  color: var(--pix-text-muted);
}
.auth-custom-hint {
  color: var(--pix-accent);
}
.auth-status-text {
  font-size: 13px;
}
.auth-edit-row {
  border-top: 1px solid var(--pix-border-light);
  padding: 14px 0;
}
.auth-btn-group {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.auth-notice {
  padding: 20px;
  background: var(--pix-bg-code);
  border: 1px solid var(--pix-border);
  border-radius: 11px;
  font-size: 14px;
}
.update-section {
  padding: 16px 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.setting-subheader {
  display: none;
}
.update-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.update-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.update-status.success {
  color: var(--pix-success);
}
.update-status.error {
  color: var(--pix-error);
}
.advanced-info {
  padding: 8px 0;
}
.info-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  font-size: 13px;
}
.info-row + .info-row {
  border-top: 1px solid var(--pix-border-light);
}
.info-row code {
  text-align: right;
  overflow-wrap: anywhere;
  min-width: 0;
}
.settings-content :deep(.v-field__outline) {
  color: var(--pix-border) !important;
}
.settings-content :deep(.v-label) {
  color: var(--pix-text-primary) !important;
}
.settings-content :deep(.v-messages) {
  color: #747b87 !important;
}
.settings-content :deep(.v-messages__message) {
  line-height: 1.6;
}
.settings-content :deep(.v-input--error .v-messages) {
  color: var(--pix-error) !important;
}
.settings-content :deep(.text-medium-emphasis) {
  color: var(--pix-text-secondary) !important;
}
.settings-content :deep(.section-panel > .d-flex) {
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start !important;
}
.settings-content :deep(.section-panel > .d-flex > div:first-child) {
  flex: 1;
  min-width: 200px;
}
.mb-3 {
  margin-bottom: 12px;
}
.mb-4 {
  margin-bottom: 20px;
}
.navigation-backdrop {
  display: none;
}
@media (min-width: 1700px) {
  .settings-content {
    max-width: 1160px;
  }
}
@media (max-width: 1100px) {
  .settings-sidebar {
    width: 230px;
    flex-basis: 230px;
  }
  .settings-content {
    padding: 28px;
  }
  .settings-topbar {
    --pix-titlebar-padding: 28px;
  }
  .settings-actions {
    padding-left: 28px;
    padding-right: 28px;
  }
}
@media (max-width: 760px) {
  .settings-sidebar {
    width: 205px;
    flex-basis: 205px;
  }
  .sidebar-brand {
    padding: 0 16px;
  }
  .settings-content {
    padding: 24px 20px;
  }
  .settings-topbar {
    --pix-titlebar-padding: 20px;
  }
  .settings-actions {
    padding-left: 20px;
    padding-right: 20px;
  }
}
@media (max-width: 560px) {
  .settings-sidebar {
    display: none;
    position: absolute;
    inset: 0 auto 0 0;
    width: 250px;
    z-index: 21;
    box-shadow: var(--pix-shadow-lg);
  }
  .settings-sidebar.open {
    display: flex;
  }
  .navigation-backdrop {
    display: block;
    position: absolute;
    inset: 0;
    background: #20273740;
    z-index: 20;
  }
  .settings-mobile-menu {
    display: inline-flex;
  }
  .settings-topbar {
    --pix-titlebar-padding: 14px;
    gap: 8px;
  }
  .settings-content {
    padding: 24px 16px 32px;
  }
  .section-title,
  .settings-content :deep(.section-title) {
    font-size: 24px;
  }
  .settings-actions {
    padding: 12px 16px;
  }
}
</style>
