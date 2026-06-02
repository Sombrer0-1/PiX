<script setup lang="ts">
/**
 * Settings Page
 *
 * Full pi settings configuration with tabbed layout.
 * Reads/writes settings via the Pi SettingsManager through SessionBridge.
 */
import { ref, onMounted, computed } from "vue";
import { useRouter } from "vue-router";
import { useSettingsStore } from "../stores/settings-store";
import { useAuthStore } from "../stores/auth-store";
import { useRpc } from "../composables/useRpc";
import type { ThinkingLevel } from "@/types/rpc";

const router = useRouter();
const settingsStore = useSettingsStore();
const authStore = useAuthStore();
const rpc = useRpc();

// ---- Tabs ----
type SettingsTab = "general" | "display" | "model" | "terminal" | "shell" | "resources" | "auth" | "advanced";
const activeTab = ref<SettingsTab>("general");
const tabs: { key: SettingsTab; label: string }[] = [
  { key: "general", label: "General" },
  { key: "display", label: "Display" },
  { key: "model", label: "Model" },
  { key: "terminal", label: "Terminal" },
  { key: "shell", label: "Shell" },
  { key: "resources", label: "Resources" },
  { key: "auth", label: "Auth" },
  { key: "advanced", label: "Advanced" },
];

// ---- Pi settings (from SettingsManager) ----
const piSettings = ref<Record<string, unknown>>({});

// ---- Form state for each field ----
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
  // Load GUI settings
  await settingsStore.load();
  defaultProvider.value = settingsStore.settings.defaultProvider || "";
  defaultModel.value = settingsStore.settings.defaultModel || "";
  defaultThinkingLevel.value = settingsStore.settings.defaultThinkingLevel || "medium";

  // Load pi settings from SettingsManager (if session is running)
  if (rpc.isConnected.value) {
    try {
      const s = await rpc.getPiSettings();
      if (s) {
        piSettings.value = s;
        applyPiSettings(s);
      }
    } catch {
      // Settings unavailable - use defaults
    }

    // Load auth status
    try {
      await authStore.refreshStatus();
    } catch {
      // Auth status unavailable
    }
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

  if (s.enabledModels && Array.isArray(s.enabledModels)) {
    enabledModels.value = s.enabledModels.join(", ");
  }
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
  if (s.npmCommand && Array.isArray(s.npmCommand)) {
    npmCommand.value = s.npmCommand.join(" ");
  }
  httpIdleTimeoutMs.value = (s.httpIdleTimeoutMs ?? 0) as number;

  if (s.extensionPaths && Array.isArray(s.extensionPaths)) {
    extensionPaths.value = s.extensionPaths.join(", ");
  }
  if (s.skillPaths && Array.isArray(s.skillPaths)) {
    skillPaths.value = s.skillPaths.join(", ");
  }
  if (s.promptTemplatePaths && Array.isArray(s.promptTemplatePaths)) {
    promptTemplatePaths.value = s.promptTemplatePaths.join(", ");
  }
  if (s.themePaths && Array.isArray(s.themePaths)) {
    themePaths.value = s.themePaths.join(", ");
  }
  enableSkillCommands.value = (s.enableSkillCommands ?? true) as boolean;

  sessionDir.value = (s.sessionDir ?? "") as string;
  doubleEscapeAction.value = (s.doubleEscapeAction ?? "tree") as "fork" | "tree" | "none";
  treeFilterMode.value = (s.treeFilterMode ?? "default") as "default" | "no-tools" | "user-only" | "labeled-only" | "all";
  autocompleteMaxVisible.value = (s.autocompleteMaxVisible ?? 5) as number;
}

// ---- Save ----
async function saveSettings(): Promise<void> {
  saving.value = true;
  saved.value = false;
  try {
    // Save GUI preferences
    await settingsStore.save({
      defaultModel: defaultModel.value || undefined,
      defaultProvider: defaultProvider.value || undefined,
      defaultThinkingLevel: defaultThinkingLevel.value,
    });

    // Save pi settings if session is running
    if (rpc.isConnected.value) {
      const setters: [string, unknown][] = [
        ["steeringMode", steeringMode.value],
        ["followUpMode", followUpMode.value],
        ["compactEnabled", autoCompact.value],
        ["quietStartup", quietStartup.value],
        ["enableInstallTelemetry", enableInstallTelemetry.value],
        ["theme", piTheme.value || undefined],
        ["hideThinkingBlock", hideThinkingBlock.value],
        ["collapseChangelog", collapseChangelog.value],
        ["showHardwareCursor", showHardwareCursor.value],
        ["editorPaddingX", editorPaddingX.value],
        ["enabledModels", enabledModels.value ? enabledModels.value.split(",").map((s) => s.trim()).filter(Boolean) : undefined],
        ["transport", transport.value],
        ["retryEnabled", retryEnabled.value],
        ["showImages", showImages.value],
        ["imageWidthCells", imageWidthCells.value],
        ["autoResizeImages", imageAutoResize.value],
        ["blockImages", blockImages.value],
        ["clearOnShrink", clearOnShrink.value],
        ["showTerminalProgress", showTerminalProgress.value],
        ["shellPath", shellPath.value || undefined],
        ["shellCommandPrefix", shellCommandPrefix.value || undefined],
        ["npmCommand", npmCommand.value ? npmCommand.value.split(/\s+/).filter(Boolean) : undefined],
        ["httpIdleTimeoutMs", httpIdleTimeoutMs.value || undefined],
        ["extensionPaths", extensionPaths.value ? extensionPaths.value.split(",").map((s) => s.trim()).filter(Boolean) : undefined],
        ["skillPaths", skillPaths.value ? skillPaths.value.split(",").map((s) => s.trim()).filter(Boolean) : undefined],
        ["promptTemplatePaths", promptTemplatePaths.value ? promptTemplatePaths.value.split(",").map((s) => s.trim()).filter(Boolean) : undefined],
        ["themePaths", themePaths.value ? themePaths.value.split(",").map((s) => s.trim()).filter(Boolean) : undefined],
        ["enableSkillCommands", enableSkillCommands.value],
        ["sessionDir", sessionDir.value || undefined],
        ["doubleEscapeAction", doubleEscapeAction.value],
        ["treeFilterMode", treeFilterMode.value],
        ["autocompleteMaxVisible", autocompleteMaxVisible.value],
      ];

      for (const [key, value] of setters) {
        if (value !== undefined) {
          await rpc.setPiSetting(key, value);
        }
      }

      // Session-level settings (immediate effect)
      await rpc.setSteeringMode(steeringMode.value);
      await rpc.setFollowUpMode(followUpMode.value);
    }

    saved.value = true;
    setTimeout(() => (saved.value = false), 2000);
  } finally {
    saving.value = false;
  }
}

function goBack(): void {
  router.back();
}
</script>

<template>
  <div class="settings-page">
    <div class="settings-container">
      <!-- Header -->
      <header class="settings-header">
        <button class="back-btn" @click="goBack">&larr; Back</button>
        <h1 class="settings-title">Settings</h1>
      </header>

      <!-- Tabs -->
      <nav class="settings-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="tab-btn"
          :class="{ active: activeTab === tab.key }"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </nav>

      <div class="settings-content">
        <!-- ================================================ -->
        <!-- General Tab -->
        <!-- ================================================ -->
        <section v-show="activeTab === 'general'" class="settings-section">
          <h2 class="section-title">General Settings</h2>
          <p class="section-desc">Default model and session behavior.</p>

          <div class="form-group">
            <label class="form-label">Default Provider</label>
            <input v-model="defaultProvider" type="text" class="form-input" placeholder="e.g., anthropic, openai, deepseek" spellcheck="false" />
            <span class="form-hint">Provider name for new sessions.</span>
          </div>
          <div class="form-group">
            <label class="form-label">Default Model</label>
            <input v-model="defaultModel" type="text" class="form-input" placeholder="e.g., claude-sonnet-4-6" spellcheck="false" />
            <span class="form-hint">Model ID for new sessions.</span>
          </div>
          <div class="form-group">
            <label class="form-label">Default Thinking Level</label>
            <select v-model="defaultThinkingLevel" class="form-select">
              <option v-for="level in thinkingLevels" :key="level" :value="level">{{ level }}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Steering Mode</label>
            <select v-model="steeringMode" class="form-select">
              <option v-for="mode in steeringModes" :key="mode" :value="mode">{{ mode }}</option>
            </select>
            <span class="form-hint">How steering messages are queued during streaming.</span>
          </div>
          <div class="form-group">
            <label class="form-label">Follow-Up Mode</label>
            <select v-model="followUpMode" class="form-select">
              <option v-for="mode in steeringModes" :key="mode" :value="mode">{{ mode }}</option>
            </select>
            <span class="form-hint">How follow-up messages are sent during streaming.</span>
          </div>

          <div class="form-row">
            <label class="form-checkbox">
              <input v-model="autoCompact" type="checkbox" />
              <span>Auto Compact</span>
            </label>
            <span class="form-hint-inline">Automatically compact context when threshold is reached.</span>
          </div>
          <div class="form-row">
            <label class="form-checkbox">
              <input v-model="quietStartup" type="checkbox" />
              <span>Quiet Startup</span>
            </label>
            <span class="form-hint-inline">Suppress startup messages.</span>
          </div>
          <div class="form-row">
            <label class="form-checkbox">
              <input v-model="enableInstallTelemetry" type="checkbox" />
              <span>Install Telemetry</span>
            </label>
            <span class="form-hint-inline">Send anonymous install attribution to model providers.</span>
          </div>
        </section>

        <!-- ================================================ -->
        <!-- Display Tab -->
        <!-- ================================================ -->
        <section v-show="activeTab === 'display'" class="settings-section">
          <h2 class="section-title">Display Settings</h2>
          <p class="section-desc">Terminal and editor visual preferences.</p>

          <div class="form-group">
            <label class="form-label">Pi Terminal Theme</label>
            <input v-model="piTheme" type="text" class="form-input" placeholder="default" spellcheck="false" />
            <span class="form-hint">Pi TUI theme name (affects CLI/TUI mode only).</span>
          </div>
          <div class="form-row">
            <label class="form-checkbox">
              <input v-model="hideThinkingBlock" type="checkbox" />
              <span>Hide Thinking Block</span>
            </label>
            <span class="form-hint-inline">Collapse the agent thinking section.</span>
          </div>
          <div class="form-row">
            <label class="form-checkbox">
              <input v-model="collapseChangelog" type="checkbox" />
              <span>Collapse Changelog</span>
            </label>
            <span class="form-hint-inline">Collapse changelog on startup.</span>
          </div>
          <div class="form-row">
            <label class="form-checkbox">
              <input v-model="showHardwareCursor" type="checkbox" />
              <span>Show Hardware Cursor</span>
            </label>
            <span class="form-hint-inline">Use the terminal hardware cursor instead of software cursor.</span>
          </div>
          <div class="form-group">
            <label class="form-label">Editor Padding X</label>
            <input v-model.number="editorPaddingX" type="number" class="form-input" min="0" max="3" style="max-width:80px" />
            <span class="form-hint">Horizontal padding in editor cells (0-3).</span>
          </div>
        </section>

        <!-- ================================================ -->
        <!-- Model Tab -->
        <!-- ================================================ -->
        <section v-show="activeTab === 'model'" class="settings-section">
          <h2 class="section-title">Model Settings</h2>
          <p class="section-desc">Model availability and transport configuration.</p>

          <div class="form-group">
            <label class="form-label">Enabled Models (glob patterns)</label>
            <input v-model="enabledModels" type="text" class="form-input" placeholder="anthropic/*, openai/gpt-5*" spellcheck="false" />
            <span class="form-hint">Comma-separated glob patterns. Leave empty for all models.</span>
          </div>
          <div class="form-group">
            <label class="form-label">Transport</label>
            <select v-model="transport" class="form-select">
              <option v-for="opt in transportOptions" :key="opt" :value="opt">{{ opt }}</option>
            </select>
            <span class="form-hint">HTTP transport method for API requests.</span>
          </div>
          <div class="form-row">
            <label class="form-checkbox">
              <input v-model="retryEnabled" type="checkbox" />
              <span>Auto Retry</span>
            </label>
            <span class="form-hint-inline">Automatically retry failed API requests.</span>
          </div>
        </section>

        <!-- ================================================ -->
        <!-- Terminal Tab -->
        <!-- ================================================ -->
        <section v-show="activeTab === 'terminal'" class="settings-section">
          <h2 class="section-title">Terminal Settings</h2>
          <p class="section-desc">Image display and terminal behavior.</p>

          <div class="form-row">
            <label class="form-checkbox">
              <input v-model="showImages" type="checkbox" />
              <span>Show Images</span>
            </label>
            <span class="form-hint-inline">Display inline images in the terminal (TUI mode).</span>
          </div>
          <div class="form-group">
            <label class="form-label">Image Width (cells)</label>
            <input v-model.number="imageWidthCells" type="number" class="form-input" min="10" max="200" style="max-width:100px" />
            <span class="form-hint">Width of displayed images in terminal cells.</span>
          </div>
          <div class="form-row">
            <label class="form-checkbox">
              <input v-model="imageAutoResize" type="checkbox" />
              <span>Auto-Resize Images</span>
            </label>
            <span class="form-hint-inline">Automatically resize large images before sending to model.</span>
          </div>
          <div class="form-row">
            <label class="form-checkbox">
              <input v-model="blockImages" type="checkbox" />
              <span>Block Images</span>
            </label>
            <span class="form-hint-inline">Block images from being sent to the model entirely.</span>
          </div>
          <div class="form-row">
            <label class="form-checkbox">
              <input v-model="clearOnShrink" type="checkbox" />
              <span>Clear on Shrink</span>
            </label>
            <span class="form-hint-inline">Clear terminal when it shrinks below a threshold.</span>
          </div>
          <div class="form-row">
            <label class="form-checkbox">
              <input v-model="showTerminalProgress" type="checkbox" />
              <span>Show Terminal Progress</span>
            </label>
            <span class="form-hint-inline">Show progress indicators in the terminal.</span>
          </div>
        </section>

        <!-- ================================================ -->
        <!-- Shell Tab -->
        <!-- ================================================ -->
        <section v-show="activeTab === 'shell'" class="settings-section">
          <h2 class="section-title">Shell Settings</h2>
          <p class="section-desc">Bash execution and networking configuration.</p>

          <div class="form-group">
            <label class="form-label">Shell Path</label>
            <input v-model="shellPath" type="text" class="form-input" placeholder="Auto-detected" spellcheck="false" />
            <span class="form-hint">Path to shell executable. Leave empty for auto-detect.</span>
          </div>
          <div class="form-group">
            <label class="form-label">Shell Command Prefix</label>
            <input v-model="shellCommandPrefix" type="text" class="form-input" placeholder="None" spellcheck="false" />
            <span class="form-hint">Prefix prepended to every bash command (e.g., "wsl").</span>
          </div>
          <div class="form-group">
            <label class="form-label">npm Command</label>
            <input v-model="npmCommand" type="text" class="form-input" placeholder="npm" spellcheck="false" />
            <span class="form-hint">Space-separated npm command and arguments.</span>
          </div>
          <div class="form-group">
            <label class="form-label">HTTP Idle Timeout (ms)</label>
            <input v-model.number="httpIdleTimeoutMs" type="number" class="form-input" min="0" style="max-width:150px" placeholder="Server default" />
            <span class="form-hint">HTTP idle timeout in milliseconds. 0 = server default.</span>
          </div>
        </section>

        <!-- ================================================ -->
        <!-- Resources Tab -->
        <!-- ================================================ -->
        <section v-show="activeTab === 'resources'" class="settings-section">
          <h2 class="section-title">Resource Paths</h2>
          <p class="section-desc">Extensions, skills, prompt templates, and themes.</p>

          <div class="form-group">
            <label class="form-label">Extension Paths</label>
            <input v-model="extensionPaths" type="text" class="form-input" placeholder="/path/to/ext1, /path/to/ext2" spellcheck="false" />
            <span class="form-hint">Comma-separated paths to extension files or directories.</span>
          </div>
          <div class="form-group">
            <label class="form-label">Skill Paths</label>
            <input v-model="skillPaths" type="text" class="form-input" placeholder="/path/to/skills1, /path/to/skills2" spellcheck="false" />
            <span class="form-hint">Comma-separated paths to skill directories.</span>
          </div>
          <div class="form-group">
            <label class="form-label">Prompt Template Paths</label>
            <input v-model="promptTemplatePaths" type="text" class="form-input" placeholder="/path/to/prompts1, /path/to/prompts2" spellcheck="false" />
            <span class="form-hint">Comma-separated paths to prompt template directories.</span>
          </div>
          <div class="form-group">
            <label class="form-label">Theme Paths</label>
            <input v-model="themePaths" type="text" class="form-input" placeholder="/path/to/themes1, /path/to/themes2" spellcheck="false" />
            <span class="form-hint">Comma-separated paths to custom theme directories.</span>
          </div>
          <div class="form-row">
            <label class="form-checkbox">
              <input v-model="enableSkillCommands" type="checkbox" />
              <span>Enable Skill Commands</span>
            </label>
            <span class="form-hint-inline">Allow skills to register slash commands.</span>
          </div>

          <div class="resource-actions">
            <button
              class="btn btn-secondary"
              :disabled="!rpc.isConnected.value"
              @click="async () => { await rpc.reloadResources(); }"
            >
              Reload Resources
            </button>
            <span class="form-hint">Reload all extensions, skills, prompts, and themes. Requires a session restart to take full effect.</span>
          </div>
        </section>

        <!-- ================================================ -->
        <!-- Auth Tab -->
        <!-- ================================================ -->
        <section v-show="activeTab === 'auth'" class="settings-section">
          <h2 class="section-title">Authentication</h2>
          <p class="section-desc">Configure API keys for each model provider. Keys are stored in <code>~/.pi/agent/auth.json</code>.</p>

          <div v-if="!rpc.isConnected.value" class="auth-notice">
            <p>Start a session first to configure API keys.</p>
          </div>
          <div v-else-if="authStore.providerCount === 0" class="auth-notice">
            <p>No model providers detected.</p>
          </div>
          <div v-else class="auth-list">
            <div
              v-for="(status, provider) in authStore.authStatus"
              :key="provider"
              class="auth-item"
              :class="{ configured: status.configured, expanded: editingProvider === provider }"
            >
              <div class="auth-provider-row" @click="toggleEditProvider(provider)">
                <div class="auth-provider-info">
                  <span class="auth-provider-name">{{ provider }}</span>
                  <span v-if="status.label" class="auth-provider-label">{{ status.label }}</span>
                </div>
                <div class="auth-status-info">
                  <span class="auth-dot" :class="status.configured ? 'configured' : 'unconfigured'"></span>
                  <span class="auth-status-text">{{ status.configured ? 'Configured' : 'Not configured' }}</span>
                  <span v-if="status.source" class="auth-source">via {{ status.source }}</span>
                  <span class="auth-expand-icon">{{ editingProvider === provider ? '▾' : '▸' }}</span>
                </div>
              </div>

              <!-- Expanded: API key input -->
              <div v-if="editingProvider === provider" class="auth-edit-row">
                <div class="auth-input-group">
                  <input
                    v-model="editingKeys[provider]"
                    type="password"
                    class="form-input"
                    :placeholder="status.configured ? 'Enter new key to replace...' : 'Paste your API key...'"
                    spellcheck="false"
                    @keydown.enter="saveKey(provider)"
                  />
                </div>
                <div class="auth-btn-group">
                  <button
                    class="btn btn-sm btn-primary"
                    :disabled="!editingKeys[provider]?.trim()"
                    @click="saveKey(provider)"
                  >
                    Save
                  </button>
                  <button
                    v-if="status.configured"
                    class="btn btn-sm btn-danger"
                    @click="deleteKey(provider)"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- ================================================ -->
        <!-- Advanced Tab -->
        <!-- ================================================ -->
        <section v-show="activeTab === 'advanced'" class="settings-section">
          <h2 class="section-title">Advanced Settings</h2>
          <p class="section-desc">Session storage, navigation, and UI behavior.</p>

          <div class="form-group">
            <label class="form-label">Session Directory</label>
            <input v-model="sessionDir" type="text" class="form-input" placeholder="~/.pi/agent/sessions/" spellcheck="false" />
            <span class="form-hint">Custom session storage directory. Leave empty for default.</span>
          </div>
          <div class="form-group">
            <label class="form-label">Double Escape Action</label>
            <select v-model="doubleEscapeAction" class="form-select">
              <option v-for="action in escapeActions" :key="action" :value="action">{{ action }}</option>
            </select>
            <span class="form-hint">Action on double Escape key press.</span>
          </div>
          <div class="form-group">
            <label class="form-label">Tree Filter Mode</label>
            <select v-model="treeFilterMode" class="form-select">
              <option v-for="mode in treeFilterModes" :key="mode" :value="mode">{{ mode }}</option>
            </select>
            <span class="form-hint">Default filter mode for session tree view.</span>
          </div>
          <div class="form-group">
            <label class="form-label">Autocomplete Max Visible</label>
            <input v-model.number="autocompleteMaxVisible" type="number" class="form-input" min="3" max="20" style="max-width:80px" />
            <span class="form-hint">Maximum visible autocomplete suggestions (3-20).</span>
          </div>

          <div class="advanced-info">
            <h3>Diagnostic Information</h3>
            <div class="info-row"><span>Integration:</span><span>Direct (AgentSession in-process)</span></div>
            <div class="info-row"><span>Data Directory:</span><code>~/.pi/agent/</code></div>
            <div class="info-row"><span>Session Storage:</span><code>~/.pi/agent/sessions/</code></div>
            <div class="info-row"><span>Settings File:</span><code>~/.pi/agent/settings.json</code></div>
          </div>
        </section>

        <!-- Save -->
        <div class="settings-actions">
          <button class="btn btn-primary" :disabled="saving" @click="saveSettings">
            {{ saving ? 'Saving...' : saved ? 'Saved!' : 'Save Settings' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  height: 100%;
  overflow-y: auto;
  background: var(--pix-bg-app);
}

.settings-container {
  max-width: 640px;
  margin: 0 auto;
  padding: var(--pix-space-2xl);
}

.settings-header {
  display: flex;
  align-items: center;
  gap: var(--pix-space-lg);
  margin-bottom: var(--pix-space-lg);
}

.back-btn {
  font-size: var(--pix-text-md);
  color: var(--pix-text-secondary);
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border-radius: var(--pix-radius-sm);
}

.back-btn:hover {
  background: var(--pix-bg-hover);
  color: var(--pix-text-primary);
}

.settings-title {
  font-size: var(--pix-text-xl);
  font-weight: 600;
}

/* Tabs */
.settings-tabs {
  display: flex;
  gap: 0;
  margin-bottom: var(--pix-space-xl);
  border-bottom: 1px solid var(--pix-border-light);
  overflow-x: auto;
}

.tab-btn {
  padding: var(--pix-space-sm) var(--pix-space-lg);
  font-size: var(--pix-text-sm);
  font-weight: 500;
  color: var(--pix-text-secondary);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: all var(--pix-transition-fast);
  white-space: nowrap;
}

.tab-btn:hover {
  color: var(--pix-text-primary);
  background: var(--pix-bg-hover);
}

.tab-btn.active {
  color: var(--pix-accent);
  border-bottom-color: var(--pix-accent);
}

.settings-content {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-2xl);
}

.settings-section {
  background: var(--pix-bg-content);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-lg);
  padding: var(--pix-space-xl);
}

.section-title {
  font-size: var(--pix-text-md);
  font-weight: 600;
  margin-bottom: var(--pix-space-xs);
}

.section-desc {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-muted);
  margin-bottom: var(--pix-space-lg);
}

.form-group {
  margin-bottom: var(--pix-space-lg);
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-label {
  display: block;
  font-size: var(--pix-text-sm);
  font-weight: 500;
  color: var(--pix-text-secondary);
  margin-bottom: var(--pix-space-xs);
}

.form-hint {
  display: block;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  margin-top: var(--pix-space-xs);
}

.form-hint-inline {
  display: block;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  margin-top: 2px;
  margin-left: 24px;
}

.form-input {
  width: 100%;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-base);
  background: var(--pix-bg-input);
  color: var(--pix-text-primary);
  font-family: var(--pix-font-mono);
}

.form-input:focus {
  outline: none;
  border-color: var(--pix-border-focus);
}

.form-select {
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-base);
  background: var(--pix-bg-input);
  color: var(--pix-text-primary);
  min-width: 200px;
}

.form-select:focus {
  outline: none;
  border-color: var(--pix-border-focus);
}

.form-select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Checkbox row */
.form-row {
  margin-bottom: var(--pix-space-md);
}

.form-checkbox {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  font-size: var(--pix-text-sm);
  font-weight: 500;
  color: var(--pix-text-secondary);
  cursor: pointer;
}

.form-checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--pix-accent);
  cursor: pointer;
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  gap: var(--pix-space-sm);
  padding: var(--pix-space-sm) var(--pix-space-lg);
  border-radius: var(--pix-radius-md);
  font-size: var(--pix-text-base);
  font-weight: 500;
  transition: all var(--pix-transition-fast);
}

.btn-primary {
  background: var(--pix-accent);
  color: var(--pix-text-inverse);
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-secondary {
  background: var(--pix-bg-content);
  color: var(--pix-text-secondary);
  border: 1px solid var(--pix-border);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--pix-bg-hover);
  color: var(--pix-text-primary);
}

.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
}

.resource-actions {
  margin-top: var(--pix-space-lg);
  padding-top: var(--pix-space-lg);
  border-top: 1px solid var(--pix-border-light);
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-sm);
}

/* Advanced info */
.advanced-info {
  margin-top: var(--pix-space-xl);
  padding-top: var(--pix-space-lg);
  border-top: 1px solid var(--pix-border-light);
}

.advanced-info h3 {
  font-size: var(--pix-text-sm);
  font-weight: 600;
  margin-bottom: var(--pix-space-md);
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--pix-space-xs) 0;
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

/* Auth */
.auth-notice {
  padding: var(--pix-space-lg);
  text-align: center;
  color: var(--pix-text-muted);
  font-size: var(--pix-text-sm);
}

.auth-list {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-sm);
}

.auth-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--pix-space-md);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-card);
}

.auth-item.configured {
  border-color: var(--pix-success);
}

.auth-item.expanded {
  border-color: var(--pix-border-focus);
  background: var(--pix-bg-card);
}

.auth-provider-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  user-select: none;
}

.auth-provider-info {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
}

.auth-provider-name {
  font-weight: 600;
  font-size: var(--pix-text-sm);
  font-family: var(--pix-font-mono);
}

.auth-provider-label {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}

.auth-status-info {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
}

.auth-expand-icon {
  font-size: 11px;
  color: var(--pix-text-muted);
  margin-left: var(--pix-space-sm);
}

.auth-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.auth-dot.configured {
  background: var(--pix-success);
}

.auth-dot.unconfigured {
  background: var(--pix-text-muted);
}

.auth-status-text {
  font-size: var(--pix-text-xs);
  font-weight: 500;
}

.auth-source {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}

/* Auth edit row */
.auth-edit-row {
  margin-top: var(--pix-space-md);
  padding-top: var(--pix-space-md);
  border-top: 1px solid var(--pix-border-light);
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-sm);
}

.auth-input-group {
  flex: 1;
}

.auth-input-group .form-input {
  width: 100%;
}

.auth-btn-group {
  display: flex;
  gap: var(--pix-space-sm);
  justify-content: flex-end;
}

.btn-sm {
  padding: 4px 12px;
  font-size: var(--pix-text-sm);
  border-radius: var(--pix-radius-sm);
  font-weight: 500;
  transition: all var(--pix-transition-fast);
}

.btn-sm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-danger {
  background: var(--pix-error);
  color: var(--pix-text-inverse);
}

.btn-danger:hover:not(:disabled) {
  opacity: 0.85;
}
</style>
