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
  { key: "general", label: "General", icon: "mdi-cog-outline" },
  { key: "display", label: "Display", icon: "mdi-monitor" },
  { key: "model", label: "Model", icon: "mdi-cube-outline" },
  { key: "terminal", label: "Terminal", icon: "mdi-console" },
  { key: "shell", label: "Shell", icon: "mdi-bash" },
  { key: "resources", label: "Resources", icon: "mdi-package-variant" },
  { key: "mcp", label: "MCP", icon: "mdi-puzzle-outline" },
  { key: "auth", label: "Auth", icon: "mdi-shield-key" },
  { key: "advanced", label: "Advanced", icon: "mdi-tune" },
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
          <v-btn variant="text" prepend-icon="mdi-arrow-left" @click="goBack">Back</v-btn>
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
        <!-- ============ General ============ -->
        <div v-show="activeSection === 'general'" class="section-panel">
          <h2 class="section-title">General</h2>
          <p class="section-desc">Default model and session behavior.</p>
          <div class="form-fields">
            <v-text-field v-model="defaultProvider" label="Default Provider" placeholder="e.g., anthropic, openai" hint="Provider name for new sessions." persistent-hint class="mb-4" />
            <v-text-field v-model="defaultModel" label="Default Model" placeholder="e.g., claude-sonnet-4-6" hint="Model ID for new sessions." persistent-hint class="mb-4" />
            <v-select v-model="defaultThinkingLevel" label="Default Thinking Level" :items="thinkingLevels" class="mb-4" />
            <v-select v-model="steeringMode" label="Steering Mode" :items="steeringModes" hint="How steering messages are queued during streaming." persistent-hint class="mb-4" />
            <v-select v-model="followUpMode" label="Follow-Up Mode" :items="steeringModes" hint="How follow-up messages are sent during streaming." persistent-hint class="mb-4" />
            <v-switch v-model="autoCompact" label="Auto Compact" hint="Automatically compact context when threshold is reached." persistent-hint class="mb-4" />
            <v-switch v-model="quietStartup" label="Quiet Startup" hint="Suppress startup messages." persistent-hint class="mb-4" />
            <v-switch v-model="enableInstallTelemetry" label="Install Telemetry" hint="Send anonymous install attribution." persistent-hint class="mb-4" />
          </div>
        </div>

        <!-- ============ Display ============ -->
        <div v-show="activeSection === 'display'" class="section-panel">
          <h2 class="section-title">Display</h2>
          <p class="section-desc">Terminal and editor visual preferences.</p>
          <div class="form-fields">
            <v-text-field v-model="piTheme" label="Pi Terminal Theme" placeholder="default" hint="Pi TUI theme name (affects CLI/TUI mode only)." persistent-hint class="mb-4" />
            <v-switch v-model="hideThinkingBlock" label="Hide Thinking Block" hint="Collapse the agent thinking section." persistent-hint class="mb-4" />
            <v-switch v-model="collapseChangelog" label="Collapse Changelog" hint="Collapse changelog on startup." persistent-hint class="mb-4" />
            <v-switch v-model="showHardwareCursor" label="Show Hardware Cursor" hint="Use the terminal hardware cursor." persistent-hint class="mb-4" />
            <v-text-field v-model.number="editorPaddingX" label="Editor Padding X" type="number" min="0" max="3" hint="Horizontal padding in editor cells (0-3)." persistent-hint style="max-width:200px" class="mb-4" />
          </div>
        </div>

        <!-- ============ Model ============ -->
        <div v-show="activeSection === 'model'" class="section-panel">
          <h2 class="section-title">Model</h2>
          <p class="section-desc">Model availability and transport configuration.</p>
          <div class="form-fields">
            <v-text-field v-model="enabledModels" label="Enabled Models (glob patterns)" placeholder="anthropic/*, openai/gpt-5*" hint="Comma-separated glob patterns. Leave empty for all models." persistent-hint class="mb-4" />
            <v-select v-model="transport" label="Transport" :items="transportOptions" hint="HTTP transport method for API requests." persistent-hint class="mb-4" />
            <v-switch v-model="retryEnabled" label="Auto Retry" hint="Automatically retry failed API requests." persistent-hint class="mb-4" />
          </div>
        </div>

        <!-- ============ Terminal ============ -->
        <div v-show="activeSection === 'terminal'" class="section-panel">
          <h2 class="section-title">Terminal</h2>
          <p class="section-desc">Image display and terminal behavior.</p>
          <div class="form-fields">
            <v-switch v-model="showImages" label="Show Images" hint="Display inline images in the terminal (TUI mode)." persistent-hint class="mb-4" />
            <v-text-field v-model.number="imageWidthCells" label="Image Width (cells)" type="number" min="10" max="200" hint="Width of displayed images in terminal cells." persistent-hint style="max-width:200px" class="mb-4" />
            <v-switch v-model="imageAutoResize" label="Auto-Resize Images" hint="Automatically resize large images before sending to model." persistent-hint class="mb-4" />
            <v-switch v-model="blockImages" label="Block Images" hint="Block images from being sent to the model entirely." persistent-hint class="mb-4" />
            <v-switch v-model="clearOnShrink" label="Clear on Shrink" hint="Clear terminal when it shrinks below a threshold." persistent-hint class="mb-4" />
            <v-switch v-model="showTerminalProgress" label="Show Terminal Progress" hint="Show progress indicators in the terminal." persistent-hint class="mb-4" />
          </div>
        </div>

        <!-- ============ Shell ============ -->
        <div v-show="activeSection === 'shell'" class="section-panel">
          <h2 class="section-title">Shell</h2>
          <p class="section-desc">Bash execution and networking configuration.</p>
          <div class="form-fields">
            <v-text-field v-model="shellPath" label="Shell Path" placeholder="Auto-detected" hint="Path to shell executable." persistent-hint class="mb-4" />
            <v-text-field v-model="shellCommandPrefix" label="Shell Command Prefix" placeholder="None" hint="Prefix prepended to every bash command (e.g., wsl)." persistent-hint class="mb-4" />
            <v-text-field v-model="npmCommand" label="npm Command" placeholder="npm" hint="Space-separated npm command and arguments." persistent-hint class="mb-4" />
            <v-text-field v-model.number="httpIdleTimeoutMs" label="HTTP Idle Timeout (ms)" type="number" min="0" placeholder="Server default" hint="HTTP idle timeout in milliseconds. 0 = server default." persistent-hint style="max-width:240px" class="mb-4" />
          </div>
        </div>

        <!-- ============ Resources ============ -->
        <div v-show="activeSection === 'resources'" class="section-panel">
          <h2 class="section-title">Resources</h2>
          <p class="section-desc">Extensions, skills, prompt templates, and themes.</p>
          <div class="form-fields">
            <v-text-field v-model="extensionPaths" label="Extension Paths" placeholder="/path/to/ext1, /path/to/ext2" hint="Comma-separated paths to extension files or directories." persistent-hint class="mb-4" />
            <v-text-field v-model="skillPaths" label="Skill Paths" placeholder="/path/to/skills1, /path/to/skills2" hint="Comma-separated paths to skill directories." persistent-hint class="mb-4" />
            <v-text-field v-model="promptTemplatePaths" label="Prompt Template Paths" placeholder="/path/to/prompts1, /path/to/prompts2" hint="Comma-separated paths to prompt template directories." persistent-hint class="mb-4" />
            <v-text-field v-model="themePaths" label="Theme Paths" placeholder="/path/to/themes1, /path/to/themes2" hint="Comma-separated paths to custom theme directories." persistent-hint class="mb-4" />
            <v-switch v-model="enableSkillCommands" label="Enable Skill Commands" hint="Allow skills to register slash commands." persistent-hint class="mb-4" />
            <div class="resource-actions">
              <v-btn variant="outlined" :disabled="!rpc.isConnected.value" @click="async () => { await rpc.reloadResources(); }">Reload Resources</v-btn>
              <span class="inline-hint">Reload all extensions, skills, prompts, and themes.</span>
            </div>
          </div>
        </div>

        <!-- ============ MCP ============ -->
        <div v-show="activeSection === 'mcp'" class="section-panel">
          <McpSettings />
        </div>

        <!-- ============ Auth ============ -->
        <div v-show="activeSection === 'auth'" class="section-panel">
          <h2 class="section-title">Authentication</h2>
          <p class="section-desc">Configure API keys for each model provider. Keys are stored in <code>~/.pi/agent/auth.json</code>.</p>
          <div v-if="!rpc.isConnected.value" class="auth-notice"><p>Start a session first to configure API keys.</p></div>
          <div v-else-if="authStore.providerCount === 0" class="auth-notice"><p>No model providers detected.</p></div>
          <div v-else class="auth-list">
            <v-card v-for="(status, provider) in authStore.authStatus" :key="provider" :border="status.configured ? 'success' : undefined" variant="outlined" class="auth-card mb-3">
              <div class="auth-provider-row" @click="toggleEditProvider(provider)">
                <div class="auth-provider-info">
                  <span class="auth-provider-name">{{ provider }}</span>
                  <span v-if="status.label" class="auth-provider-label">{{ status.label }}</span>
                </div>
                <div class="auth-status-info">
                  <v-icon size="small" :color="status.configured ? 'success' : undefined" :icon="status.configured ? 'mdi-check-circle' : 'mdi-circle-outline'" />
                  <span class="auth-status-text">{{ status.configured ? 'Configured' : 'Not configured' }}</span>
                  <span v-if="status.source" class="auth-source">via {{ status.source }}</span>
                  <v-icon size="small" class="ml-2">{{ editingProvider === provider ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon>
                </div>
              </div>
              <div v-if="editingProvider === provider" class="auth-edit-row">
                <v-text-field v-model="editingKeys[provider]" type="password" :placeholder="status.configured ? 'Enter new key to replace...' : 'Paste your API key...'" hide-details density="comfortable" @keydown.enter="saveKey(provider)" class="mb-3" />
                <div class="auth-btn-group">
                  <v-btn size="small" color="primary" variant="tonal" :disabled="!editingKeys[provider]?.trim()" @click="saveKey(provider)">Save</v-btn>
                  <v-btn v-if="status.configured" size="small" color="error" variant="text" @click="deleteKey(provider)">Delete</v-btn>
                </div>
              </div>
            </v-card>
          </div>
        </div>

        <!-- ============ Advanced ============ -->
        <div v-show="activeSection === 'advanced'" class="section-panel">
          <h2 class="section-title">Advanced</h2>
          <p class="section-desc">Session storage, navigation, and UI behavior.</p>
          <div class="form-fields">
            <v-text-field v-model="sessionDir" label="Session Directory" placeholder="~/.pi/agent/sessions/" hint="Custom session storage directory." persistent-hint class="mb-4" />
            <v-select v-model="doubleEscapeAction" label="Double Escape Action" :items="escapeActions" hint="Action on double Escape key press." persistent-hint class="mb-4" />
            <v-select v-model="treeFilterMode" label="Tree Filter Mode" :items="treeFilterModes" hint="Default filter mode for session tree view." persistent-hint class="mb-4" />
            <v-text-field v-model.number="autocompleteMaxVisible" label="Autocomplete Max Visible" type="number" min="3" max="20" hint="Maximum visible autocomplete suggestions (3-20)." persistent-hint style="max-width:200px" class="mb-4" />
            <div class="advanced-info">
              <h3>Diagnostic Information</h3>
              <div class="info-row"><span>Integration</span><span>Direct (AgentSession in-process)</span></div>
              <div class="info-row"><span>Data Directory</span><code>~/.pi/agent/</code></div>
              <div class="info-row"><span>Session Storage</span><code>~/.pi/agent/sessions/</code></div>
              <div class="info-row"><span>Settings File</span><code>~/.pi/agent/settings.json</code></div>
            </div>
          </div>
        </div>

        <!-- Save -->
        <div class="settings-actions">
          <v-btn color="primary" variant="tonal" size="large" :loading="saving" @click="saveSettings">
            {{ saved ? 'Saved!' : 'Save Settings' }}
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
