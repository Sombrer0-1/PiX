<script setup lang="ts">
/**
 * Settings Page
 *
 * Sidebar + content layout. Left nav selects the section,
 * right panel shows the form fields for that section.
 */
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useSettingsStore } from "../stores/settings-store";
import { useAuthStore } from "../stores/auth-store";
import { useRpc } from "../composables/useRpc";
import type { ThinkingLevel } from "@/types/rpc";
import McpSettings from "../components/settings/McpSettings.vue";

const router = useRouter();
const settingsStore = useSettingsStore();
const authStore = useAuthStore();
const rpc = useRpc();

// ---- Navigation ----
type SettingsSection = "general" | "display" | "model" | "terminal" | "shell" | "resources" | "mcp" | "auth" | "advanced";
const activeSection = ref<SettingsSection>("general");
const sections: { key: SettingsSection; label: string; icon: string }[] = [
  { key: "general", label: "常规", icon: "mdi-cog-outline" },
  { key: "display", label: "显示", icon: "mdi-monitor" },
  { key: "model", label: "模型", icon: "mdi-cube-outline" },
  { key: "terminal", label: "终端", icon: "mdi-console" },
  { key: "shell", label: "Shell", icon: "mdi-bash" },
  { key: "resources", label: "资源", icon: "mdi-package-variant" },
  { key: "mcp", label: "MCP", icon: "mdi-puzzle-outline" },
  { key: "auth", label: "认证", icon: "mdi-shield-key" },
  { key: "advanced", label: "高级", icon: "mdi-tune" },
];

// ---- Form state ----
const defaultProvider = ref("");
const defaultModel = ref("");
const defaultThinkingLevel = ref<ThinkingLevel>("medium");
const steeringMode = ref<"all" | "one-at-a-time">("one-at-a-time");
const followUpMode = ref<"all" | "one-at-a-time">("one-at-a-time");
const autoCompact = ref(true);
const quietStartup = ref(false);
const enableInstallTelemetry = ref(true);

const piTheme = ref("");
const hideThinkingBlock = ref(false);
const collapseChangelog = ref(false);
const showHardwareCursor = ref(false);
const editorPaddingX = ref(0);

const enabledModels = ref("");
const transport = ref("auto");
const retryEnabled = ref(true);

const showImages = ref(true);
const imageWidthCells = ref(60);
const imageAutoResize = ref(true);
const blockImages = ref(false);
const clearOnShrink = ref(false);
const showTerminalProgress = ref(false);

const shellPath = ref("");
const shellCommandPrefix = ref("");
const npmCommand = ref("");
const httpIdleTimeoutMs = ref(0);

const extensionPaths = ref("");
const skillPaths = ref("");
const promptTemplatePaths = ref("");
const themePaths = ref("");
const enableSkillCommands = ref(true);

const sessionDir = ref("");
const doubleEscapeAction = ref<"fork" | "tree" | "none">("tree");
const treeFilterMode = ref<"default" | "no-tools" | "user-only" | "labeled-only" | "all">("default");
const autocompleteMaxVisible = ref(5);

const saving = ref(false);
const saved = ref(false);

// ---- Auth editing state ----
const editingProvider = ref<string | null>(null);
const editingKeys = ref<Record<string, string>>({});

function toggleEditProvider(provider: string): void {
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
  if (!key) return;
  try {
    await rpc.setApiKey(provider, key);
    editingKeys.value[provider] = "";
    editingProvider.value = null;
    await authStore.refreshStatus();
  } catch (err) {
    console.error("[SettingsPage] Failed to save API key:", err);
  }
}

async function deleteKey(provider: string): Promise<void> {
  try {
    await rpc.removeAuth(provider);
    editingKeys.value[provider] = "";
    editingProvider.value = null;
    await authStore.refreshStatus();
  } catch (err) {
    console.error("[SettingsPage] Failed to remove API key:", err);
  }
}

// ---- Option lists ----
const thinkingLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const steeringModes = ["all", "one-at-a-time"] as const;
const transportOptions = ["auto", "sse", "websocket"] as const;
const escapeActions = ["fork", "tree", "none"] as const;
const treeFilterModes = ["default", "no-tools", "user-only", "labeled-only", "all"] as const;

// ---- Load ----
onMounted(async () => {
  await settingsStore.load();
  defaultProvider.value = settingsStore.settings.defaultProvider || "";
  defaultModel.value = settingsStore.settings.defaultModel || "";
  defaultThinkingLevel.value = settingsStore.settings.defaultThinkingLevel || "medium";

  if (rpc.isConnected.value) {
    try {
      const s = await rpc.getPiSettings();
      if (s) applyPiSettings(s);
    } catch { /* use defaults */ }
    try { await authStore.refreshStatus(); } catch { /* unavailable */ }
  }
});

function applyPiSettings(s: Record<string, unknown>): void {
  steeringMode.value = (s.steeringMode as "all" | "one-at-a-time") ?? "one-at-a-time";
  followUpMode.value = (s.followUpMode as "all" | "one-at-a-time") ?? "one-at-a-time";
  autoCompact.value = (s.compactionEnabled ?? s.compaction?.enabled ?? true) as boolean;
  quietStartup.value = (s.quietStartup ?? false) as boolean;
  enableInstallTelemetry.value = (s.enableInstallTelemetry ?? true) as boolean;
  piTheme.value = (s.theme ?? "") as string;
  hideThinkingBlock.value = (s.hideThinkingBlock ?? false) as boolean;
  collapseChangelog.value = (s.collapseChangelog ?? false) as boolean;
  showHardwareCursor.value = (s.showHardwareCursor ?? false) as boolean;
  editorPaddingX.value = (s.editorPaddingX ?? 0) as number;
  if (s.enabledModels && Array.isArray(s.enabledModels)) enabledModels.value = s.enabledModels.join(", ");
  transport.value = (s.transport ?? "auto") as string;
  retryEnabled.value = (s.retry?.enabled ?? true) as boolean;
  showImages.value = (s.terminal?.showImages ?? true) as boolean;
  imageWidthCells.value = (s.terminal?.imageWidthCells ?? 60) as number;
  imageAutoResize.value = (s.images?.autoResize ?? true) as boolean;
  blockImages.value = (s.images?.blockImages ?? false) as boolean;
  clearOnShrink.value = (s.terminal?.clearOnShrink ?? false) as boolean;
  showTerminalProgress.value = (s.terminal?.showTerminalProgress ?? false) as boolean;
  shellPath.value = (s.shellPath ?? "") as string;
  shellCommandPrefix.value = (s.shellCommandPrefix ?? "") as string;
  if (s.npmCommand && Array.isArray(s.npmCommand)) npmCommand.value = s.npmCommand.join(" ");
  httpIdleTimeoutMs.value = (s.httpIdleTimeoutMs ?? 0) as number;
  if (s.extensionPaths && Array.isArray(s.extensionPaths)) extensionPaths.value = s.extensionPaths.join(", ");
  if (s.skillPaths && Array.isArray(s.skillPaths)) skillPaths.value = s.skillPaths.join(", ");
  if (s.promptTemplatePaths && Array.isArray(s.promptTemplatePaths)) promptTemplatePaths.value = s.promptTemplatePaths.join(", ");
  if (s.themePaths && Array.isArray(s.themePaths)) themePaths.value = s.themePaths.join(", ");
  enableSkillCommands.value = (s.enableSkillCommands ?? true) as boolean;
  sessionDir.value = (s.sessionDir ?? "") as string;
  doubleEscapeAction.value = (s.doubleEscapeAction ?? "tree") as "fork" | "tree" | "none";
  treeFilterMode.value = (s.treeFilterMode ?? "default") as "default" | "no-tools" | "user-only" | "labeled-only" | "all";
  autocompleteMaxVisible.value = (s.autocompleteMaxVisible ?? 5) as number;
}

async function saveSettings(): Promise<void> {
  saving.value = true;
  saved.value = false;
  try {
    await settingsStore.save({
      defaultModel: defaultModel.value || undefined,
      defaultProvider: defaultProvider.value || undefined,
      defaultThinkingLevel: defaultThinkingLevel.value,
    });
    if (rpc.isConnected.value) {
      const setters: [string, unknown][] = [
        ["steeringMode", steeringMode.value], ["followUpMode", followUpMode.value],
        ["compactEnabled", autoCompact.value], ["quietStartup", quietStartup.value],
        ["enableInstallTelemetry", enableInstallTelemetry.value],
        ["theme", piTheme.value || undefined], ["hideThinkingBlock", hideThinkingBlock.value],
        ["collapseChangelog", collapseChangelog.value], ["showHardwareCursor", showHardwareCursor.value],
        ["editorPaddingX", editorPaddingX.value],
        ["enabledModels", enabledModels.value ? enabledModels.value.split(",").map(s => s.trim()).filter(Boolean) : undefined],
        ["transport", transport.value], ["retryEnabled", retryEnabled.value],
        ["showImages", showImages.value], ["imageWidthCells", imageWidthCells.value],
        ["autoResizeImages", imageAutoResize.value], ["blockImages", blockImages.value],
        ["clearOnShrink", clearOnShrink.value], ["showTerminalProgress", showTerminalProgress.value],
        ["shellPath", shellPath.value || undefined], ["shellCommandPrefix", shellCommandPrefix.value || undefined],
        ["npmCommand", npmCommand.value ? npmCommand.value.split(/\s+/).filter(Boolean) : undefined],
        ["httpIdleTimeoutMs", httpIdleTimeoutMs.value || undefined],
        ["extensionPaths", extensionPaths.value ? extensionPaths.value.split(",").map(s => s.trim()).filter(Boolean) : undefined],
        ["skillPaths", skillPaths.value ? skillPaths.value.split(",").map(s => s.trim()).filter(Boolean) : undefined],
        ["promptTemplatePaths", promptTemplatePaths.value ? promptTemplatePaths.value.split(",").map(s => s.trim()).filter(Boolean) : undefined],
        ["themePaths", themePaths.value ? themePaths.value.split(",").map(s => s.trim()).filter(Boolean) : undefined],
        ["enableSkillCommands", enableSkillCommands.value],
        ["sessionDir", sessionDir.value || undefined], ["doubleEscapeAction", doubleEscapeAction.value],
        ["treeFilterMode", treeFilterMode.value], ["autocompleteMaxVisible", autocompleteMaxVisible.value],
      ];
      for (const [key, value] of setters) {
        if (value !== undefined) await rpc.setPiSetting(key, value);
      }
      await rpc.setSteeringMode(steeringMode.value);
      await rpc.setFollowUpMode(followUpMode.value);
    }
    saved.value = true;
    setTimeout(() => (saved.value = false), 2000);
  } finally { saving.value = false; }
}

function goBack(): void { router.back(); }
</script>

<template>
  <div class="settings-page">
    <div class="drag-bar"></div>
    <div class="settings-layout">
      <!-- Sidebar -->
      <nav class="settings-sidebar">
        <div class="sidebar-header">
          <v-btn variant="text" prepend-icon="mdi-arrow-left" @click="goBack">返回</v-btn>
        </div>
        <v-list density="default" nav bg-color="transparent">
          <v-list-item
            v-for="section in sections"
            :key="section.key"
            :title="section.label"
            :prepend-icon="section.icon"
            :active="activeSection === section.key"
            color="primary"
            @click="activeSection = section.key"
            class="sidebar-item"
            rounded="lg"
          />
        </v-list>
      </nav>

      <!-- Content -->
      <div class="settings-content">
        <!-- ============ 常规 ============ -->
        <div v-show="activeSection === 'general'" class="section-panel">
          <h2 class="section-title">常规</h2>
          <p class="section-desc">默认模型与会话行为设置。</p>
          <div class="form-fields">
            <v-text-field v-model="defaultProvider" label="默认提供商" placeholder="例如 anthropic, openai" hint="新会话使用的提供商名称。" persistent-hint class="mb-4" />
            <v-text-field v-model="defaultModel" label="默认模型" placeholder="例如 claude-sonnet-4-6" hint="新会话使用的模型 ID。" persistent-hint class="mb-4" />
            <v-select v-model="defaultThinkingLevel" label="默认思考级别" :items="thinkingLevels" class="mb-4" />
            <v-select v-model="steeringMode" label="操控模式" :items="steeringModes" hint="流式输出期间操控消息的排队方式。" persistent-hint class="mb-4" />
            <v-select v-model="followUpMode" label="跟进模式" :items="steeringModes" hint="流式输出期间跟进消息的发送方式。" persistent-hint class="mb-4" />
            <v-switch v-model="autoCompact" label="自动压缩" hint="达到阈值时自动压缩上下文。" persistent-hint class="mb-4" />
            <v-switch v-model="quietStartup" label="静默启动" hint="隐藏启动消息。" persistent-hint class="mb-4" />
            <v-switch v-model="enableInstallTelemetry" label="安装统计" hint="发送匿名安装归因数据。" persistent-hint class="mb-4" />
          </div>
        </div>

        <!-- ============ 显示 ============ -->
        <div v-show="activeSection === 'display'" class="section-panel">
          <h2 class="section-title">显示</h2>
          <p class="section-desc">终端与编辑器视觉偏好。</p>
          <div class="form-fields">
            <v-text-field v-model="piTheme" label="Pi 终端主题" placeholder="default" hint="Pi TUI 主题名称（仅影响 CLI/TUI 模式）。" persistent-hint class="mb-4" />
            <v-switch v-model="hideThinkingBlock" label="隐藏思考块" hint="折叠 agent 思考区域。" persistent-hint class="mb-4" />
            <v-switch v-model="collapseChangelog" label="折叠更新日志" hint="启动时折叠更新日志。" persistent-hint class="mb-4" />
            <v-switch v-model="showHardwareCursor" label="显示硬件光标" hint="使用终端硬件光标。" persistent-hint class="mb-4" />
            <v-text-field v-model.number="editorPaddingX" label="编辑器水平内边距" type="number" min="0" max="3" hint="编辑器单元格的水平内边距 (0-3)。" persistent-hint style="max-width:200px" class="mb-4" />
          </div>
        </div>

        <!-- ============ 模型 ============ -->
        <div v-show="activeSection === 'model'" class="section-panel">
          <h2 class="section-title">模型</h2>
          <p class="section-desc">模型可用性与传输配置。</p>
          <div class="form-fields">
            <v-text-field v-model="enabledModels" label="启用的模型（glob 模式）" placeholder="anthropic/*, openai/gpt-5*" hint="逗号分隔的 glob 模式。留空则启用所有模型。" persistent-hint class="mb-4" />
            <v-select v-model="transport" label="传输方式" :items="transportOptions" hint="API 请求的 HTTP 传输方式。" persistent-hint class="mb-4" />
            <v-switch v-model="retryEnabled" label="自动重试" hint="自动重试失败的 API 请求。" persistent-hint class="mb-4" />
          </div>
        </div>

        <!-- ============ 终端 ============ -->
        <div v-show="activeSection === 'terminal'" class="section-panel">
          <h2 class="section-title">终端</h2>
          <p class="section-desc">图片显示与终端行为。</p>
          <div class="form-fields">
            <v-switch v-model="showImages" label="显示图片" hint="在终端中显示内联图片（TUI 模式）。" persistent-hint class="mb-4" />
            <v-text-field v-model.number="imageWidthCells" label="图片宽度（单元格）" type="number" min="10" max="200" hint="终端中图片显示的宽度（单元格数）。" persistent-hint style="max-width:200px" class="mb-4" />
            <v-switch v-model="imageAutoResize" label="自动调整图片大小" hint="发送给模型前自动调整大图片尺寸。" persistent-hint class="mb-4" />
            <v-switch v-model="blockImages" label="阻止图片" hint="完全阻止将图片发送给模型。" persistent-hint class="mb-4" />
            <v-switch v-model="clearOnShrink" label="缩小时清屏" hint="终端缩小到阈值以下时清屏。" persistent-hint class="mb-4" />
            <v-switch v-model="showTerminalProgress" label="显示终端进度" hint="在终端中显示进度指示器。" persistent-hint class="mb-4" />
          </div>
        </div>

        <!-- ============ Shell ============ -->
        <div v-show="activeSection === 'shell'" class="section-panel">
          <h2 class="section-title">Shell</h2>
          <p class="section-desc">Bash 执行与网络配置。</p>
          <div class="form-fields">
            <v-text-field v-model="shellPath" label="Shell 路径" placeholder="自动检测" hint="Shell 可执行文件路径。" persistent-hint class="mb-4" />
            <v-text-field v-model="shellCommandPrefix" label="Shell 命令前缀" placeholder="无" hint="每个 bash 命令的前缀（例如 wsl）。" persistent-hint class="mb-4" />
            <v-text-field v-model="npmCommand" label="npm 命令" placeholder="npm" hint="空格分隔的 npm 命令及参数。" persistent-hint class="mb-4" />
            <v-text-field v-model.number="httpIdleTimeoutMs" label="HTTP 空闲超时（毫秒）" type="number" min="0" placeholder="服务器默认" hint="HTTP 空闲超时毫秒数。0 = 服务器默认值。" persistent-hint style="max-width:240px" class="mb-4" />
          </div>
        </div>

        <!-- ============ 资源 ============ -->
        <div v-show="activeSection === 'resources'" class="section-panel">
          <h2 class="section-title">资源</h2>
          <p class="section-desc">扩展、技能、提示模板与主题。</p>
          <div class="form-fields">
            <v-text-field v-model="extensionPaths" label="扩展路径" placeholder="/path/to/ext1, /path/to/ext2" hint="逗号分隔的扩展文件或目录路径。" persistent-hint class="mb-4" />
            <v-text-field v-model="skillPaths" label="技能路径" placeholder="/path/to/skills1, /path/to/skills2" hint="逗号分隔的技能目录路径。" persistent-hint class="mb-4" />
            <v-text-field v-model="promptTemplatePaths" label="提示模板路径" placeholder="/path/to/prompts1, /path/to/prompts2" hint="逗号分隔的提示模板目录路径。" persistent-hint class="mb-4" />
            <v-text-field v-model="themePaths" label="主题路径" placeholder="/path/to/themes1, /path/to/themes2" hint="逗号分隔的自定义主题目录路径。" persistent-hint class="mb-4" />
            <v-switch v-model="enableSkillCommands" label="启用技能命令" hint="允许技能注册斜杠命令。" persistent-hint class="mb-4" />
            <div class="resource-actions">
              <v-btn variant="outlined" :disabled="!rpc.isConnected.value" @click="async () => { await rpc.reloadResources(); }">重新加载资源</v-btn>
              <span class="inline-hint">重新加载所有扩展、技能、提示和主题。</span>
            </div>
          </div>
        </div>

        <!-- ============ MCP ============ -->
        <div v-show="activeSection === 'mcp'" class="section-panel">
          <McpSettings />
        </div>

        <!-- ============ 认证 ============ -->
        <div v-show="activeSection === 'auth'" class="section-panel">
          <h2 class="section-title">认证</h2>
          <p class="section-desc">配置各模型提供商的 API 密钥。密钥存储在 <code>~/.pi/agent/auth.json</code>。</p>
          <div v-if="!rpc.isConnected.value" class="auth-notice"><p>请先启动会话再配置 API 密钥。</p></div>
          <div v-else-if="authStore.providerCount === 0" class="auth-notice"><p>未检测到模型提供商。</p></div>
          <div v-else class="auth-list">
            <v-card v-for="(status, provider) in authStore.authStatus" :key="provider" :border="status.configured ? 'success' : undefined" variant="outlined" class="auth-card mb-3">
              <div class="auth-provider-row" @click="toggleEditProvider(provider)">
                <div class="auth-provider-info">
                  <span class="auth-provider-name">{{ provider }}</span>
                  <span v-if="status.label" class="auth-provider-label">{{ status.label }}</span>
                </div>
                <div class="auth-status-info">
                  <v-icon size="small" :color="status.configured ? 'success' : undefined" :icon="status.configured ? 'mdi-check-circle' : 'mdi-circle-outline'" />
                  <span class="auth-status-text">{{ status.configured ? '已配置' : '未配置' }}</span>
                  <span v-if="status.source" class="auth-source">来源 {{ status.source }}</span>
                  <v-icon size="small" class="ml-2">{{ editingProvider === provider ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon>
                </div>
              </div>
              <div v-if="editingProvider === provider" class="auth-edit-row">
                <v-text-field v-model="editingKeys[provider]" type="password" :placeholder="status.configured ? '输入新密钥以替换...' : '粘贴 API 密钥...'" hide-details density="comfortable" @keydown.enter="saveKey(provider)" class="mb-3" />
                <div class="auth-btn-group">
                  <v-btn size="small" color="primary" variant="tonal" :disabled="!editingKeys[provider]?.trim()" @click="saveKey(provider)">保存</v-btn>
                  <v-btn v-if="status.configured" size="small" color="error" variant="text" @click="deleteKey(provider)">删除</v-btn>
                </div>
              </div>
            </v-card>
          </div>
        </div>

        <!-- ============ 高级 ============ -->
        <div v-show="activeSection === 'advanced'" class="section-panel">
          <h2 class="section-title">高级</h2>
          <p class="section-desc">会话存储、导航与 UI 行为。</p>
          <div class="form-fields">
            <v-text-field v-model="sessionDir" label="会话目录" placeholder="~/.pi/agent/sessions/" hint="自定义会话存储目录。" persistent-hint class="mb-4" />
            <v-select v-model="doubleEscapeAction" label="双击 Esc 操作" :items="escapeActions" hint="双击 Escape 键时的操作。" persistent-hint class="mb-4" />
            <v-select v-model="treeFilterMode" label="树过滤器模式" :items="treeFilterModes" hint="会话树视图的默认过滤器模式。" persistent-hint class="mb-4" />
            <v-text-field v-model.number="autocompleteMaxVisible" label="自动补全最大显示数" type="number" min="3" max="20" hint="自动补全建议的最大显示数量 (3-20)。" persistent-hint style="max-width:200px" class="mb-4" />
            <div class="advanced-info">
              <h3>诊断信息</h3>
              <div class="info-row"><span>集成方式</span><span>Direct (AgentSession in-process)</span></div>
              <div class="info-row"><span>数据目录</span><code>~/.pi/agent/</code></div>
              <div class="info-row"><span>会话存储</span><code>~/.pi/agent/sessions/</code></div>
              <div class="info-row"><span>设置文件</span><code>~/.pi/agent/settings.json</code></div>
            </div>
          </div>
        </div>

        <!-- Save -->
        <div class="settings-actions">
          <v-btn color="primary" variant="tonal" size="large" :loading="saving" @click="saveSettings">
            {{ saved ? '已保存！' : '保存设置' }}
          </v-btn>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--pix-bg-app);
}

.drag-bar {
  height: 32px;
  min-height: 32px;
  -webkit-app-region: drag;
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--pix-bg-app);
  margin-right: 64px;
}

.settings-layout {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* Sidebar */
.settings-sidebar {
  width: 220px;
  min-width: 220px;
  border-right: 1px solid var(--pix-border-light);
  background: var(--pix-bg-left);
  display: flex;
  flex-direction: column;
  padding: var(--pix-space-sm);
}

.sidebar-header {
  padding: var(--pix-space-sm) var(--pix-space-sm) var(--pix-space-md);
}

.sidebar-item {
  border-radius: 8px;
  margin-bottom: 2px;
}

/* Content */
.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: var(--pix-space-2xl);
  display: flex;
  flex-direction: column;
}

.section-panel {
  max-width: 640px;
}

.section-title {
  font-size: var(--pix-text-xl);
  font-weight: 600;
  margin-bottom: var(--pix-space-xs);
}

.section-desc {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-muted);
  margin-bottom: var(--pix-space-2xl);
}

.form-fields {
  display: flex;
  flex-direction: column;
}

.mb-3 { margin-bottom: 12px; }
.mb-4 { margin-bottom: 20px; }

.resource-actions {
  margin-top: var(--pix-space-lg);
  padding-top: var(--pix-space-lg);
  border-top: 1px solid var(--pix-border-light);
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-sm);
}

.inline-hint {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}

.advanced-info {
  margin-top: var(--pix-space-xl);
  padding-top: var(--pix-space-lg);
  border-top: 1px solid var(--pix-border-light);
}

.advanced-info h3 {
  font-size: var(--pix-text-md);
  font-weight: 600;
  margin-bottom: var(--pix-space-md);
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 0;
  font-size: var(--pix-text-sm);
  color: var(--pix-text-secondary);
}

.info-row code {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  background: var(--pix-bg-code);
  padding: 2px 6px;
  border-radius: var(--pix-radius-sm);
}

.auth-notice {
  padding: var(--pix-space-2xl);
  text-align: center;
  color: var(--pix-text-muted);
  font-size: var(--pix-text-sm);
}

.auth-list {
  display: flex;
  flex-direction: column;
}

.auth-card {
  padding: var(--pix-space-sm);
}

.auth-provider-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  user-select: none;
  padding: var(--pix-space-sm) 0;
}

.auth-provider-info {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
}

.auth-provider-name {
  font-weight: 600;
  font-size: var(--pix-text-md);
  font-family: var(--pix-font-mono);
}

.auth-provider-label {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}

.auth-status-info {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
}

.auth-status-text {
  font-size: var(--pix-text-sm);
  font-weight: 500;
}

.auth-source {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}

.auth-edit-row {
  margin-top: var(--pix-space-md);
  padding-top: var(--pix-space-md);
  border-top: 1px solid var(--pix-border-light);
  display: flex;
  flex-direction: column;
}

.auth-btn-group {
  display: flex;
  gap: var(--pix-space-sm);
  justify-content: flex-end;
}

.settings-actions {
  margin-top: var(--pix-space-2xl);
  padding-top: var(--pix-space-lg);
  border-top: 1px solid var(--pix-border-light);
  display: flex;
  justify-content: flex-end;
}

.ml-2 { margin-left: var(--pix-space-sm); }
</style>
