<script setup lang="ts">
/**
 * CenterPanel - Main workspace column
 *
 * ┌──────────────────────────────┐
 * │ TopBar (breadcrumb, status,  │
 * │   connection, session ops)   │
 * ├──────────────────────────────┤
 * │ Session content (scrollable) │
 * ├──────────────────────────────┤
 * │ Composer                     │
 * └──────────────────────────────┘
 */
import { computed, ref, watch, nextTick, onMounted } from "vue";
import { useSessionStore } from "../../stores/session-store";
import { useRpc } from "../../composables/useRpc";
import { useProjectStore } from "../../stores/project-store";
import SessionView from "../session/SessionView.vue";
import RawOutputViewer from "../session/RawOutputViewer.vue";
import SessionTreeView from "../session/SessionTreeView.vue";
import ForkDialog from "../session/ForkDialog.vue";
import CommandPalette from "../input/CommandPalette.vue";
import ModelSelector from "../input/ModelSelector.vue";
import ThinkingSelector from "../input/ThinkingSelector.vue";
import { deriveSessionTitle } from "@/utils/session-title";
import { useSettingsStore } from "../../stores/settings-store";

const sessionStore = useSessionStore();
const rpc = useRpc();
const projectStore = useProjectStore();
const settingsStore = useSettingsStore();

type ViewMode = "session" | "raw" | "tree";
type ExecutionMode = "read-only" | "approval" | "unattended";
const viewMode = ref<ViewMode>("session");
const showExportMenu = ref(false);
const showForkDialog = ref(false);
const showExecutionModeMenu = ref(false);
const contentArea = ref<HTMLElement | null>(null);
const shouldStickToBottom = ref(true);

// Composer state
const inputText = ref("");
const searchQuery = ref("");
const showCommandPalette = ref(false);
const showModelSelector = ref(false);
const showThinkingSelector = ref(false);
const isSending = ref(false);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const isDraggingFiles = ref(false);
const AUTO_SCROLL_THRESHOLD_PX = 48;
let programmaticScrollFrame: number | null = null;
let isProgrammaticScroll = false;

interface ChatAttachment {
  path: string;
  name: string;
}

const attachments = ref<ChatAttachment[]>([]);

const projectName = computed(() => projectStore.currentProject?.name || "");
const sessionName = computed(() => {
  const explicitName = rpc.sessionState.value?.sessionName?.trim();
  if (explicitName) return explicitName;
  return deriveSessionTitle(projectStore.currentSession);
});
const canSend = computed(() =>
  (inputText.value.trim().length > 0 || attachments.value.length > 0) &&
  rpc.isConnected.value &&
  !isSending.value
);
const isStreaming = computed(() => rpc.isStreaming.value);

const statusText = computed(() => {
  if (rpc.isStreaming.value) return "运行中";
  if (rpc.sessionState.value?.isCompacting) return "压缩中";
  return "空闲";
});

const statusClass = computed(() => {
  if (rpc.isStreaming.value) return "status-running";
  if (rpc.sessionState.value?.isCompacting) return "status-compacting";
  return "status-idle";
});

const modelDisplay = computed(() => {
  const model = rpc.sessionState.value?.model;
  return model ? `${model.provider}/${model.id}` : "未选择模型";
});

const thinkingDisplay = computed(() => {
  const labels: Record<string, string> = {
    off: "关闭",
    minimal: "极简",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
  };
  return labels[rpc.sessionState.value?.thinkingLevel || "medium"] || rpc.sessionState.value?.thinkingLevel || "中";
});

const modelButtonDisplay = computed(() => {
  const model = rpc.sessionState.value?.model;
  if (!model) return "未选择模型";
  return `${model.provider}/${model.id} · ${thinkingDisplay.value}`;
});

const currentModelInfo = computed(() => {
  const model = rpc.sessionState.value?.model;
  if (!model) return null;
  return rpc.availableModels.value.find((item) => item.provider === model.provider && item.id === model.id) ?? null;
});

const modelOnlyDisplay = computed(() => {
  const model = rpc.sessionState.value?.model;
  return model ? `${model.provider}/${model.id}` : "未选择模型";
});

const cleanThinkingDisplay = computed(() => {
  const labels: Record<string, string> = {
    off: "关闭",
    minimal: "轻量",
    low: "低",
    medium: "标准",
    high: "深入",
    xhigh: "极深",
  };
  const level = rpc.sessionState.value?.thinkingLevel || "medium";
  return labels[level] || level;
});
const thinkingButtonDisplay = computed(() => `思考 ${cleanThinkingDisplay.value}`);
const thinkingButtonDisabled = computed(() => !rpc.sessionState.value?.model);

const takeHerEyesEnabled = computed(() => settingsStore.settings.takeHerEyes?.enabled ?? false);
const takeHerEyesConfigured = computed(() =>
  takeHerEyesEnabled.value &&
  !!settingsStore.settings.takeHerEyes?.provider &&
  !!settingsStore.settings.takeHerEyes?.modelId
);
const currentModelSupportsImages = computed(() => currentModelInfo.value?.input?.includes("image") ?? false);
const imagesBlocked = computed(() => rpc.sessionState.value?.blockImages ?? false);
const eyeIndicatorVisible = computed(() => takeHerEyesEnabled.value);
const eyeIndicatorActive = computed(() => takeHerEyesConfigured.value && !currentModelSupportsImages.value && !imagesBlocked.value);
const eyeIndicatorTitle = computed(() => {
  if (!takeHerEyesConfigured.value) return "眼睛已启用，但还没有选择视觉模型";
  if (imagesBlocked.value) return "眼睛已启用，但已开启阻止图片，不会调用视觉模型";
  if (currentModelSupportsImages.value) return "眼睛已启用，但当前主模型支持图片，已自动停用";
  return "眼睛已启用：当前主模型不能看图，上传图片时会自动调用视觉模型";
});

const executionModes: Array<{ value: ExecutionMode; label: string; description: string; icon: string }> = [
  { value: "read-only", label: "只读", description: "只能读取和搜索，禁止修改文件。", icon: "mdi-eye-outline" },
  { value: "approval", label: "审批", description: "高风险操作需要确认。", icon: "mdi-shield-check-outline" },
  { value: "unattended", label: "无监管", description: "工具调用不弹出审批。", icon: "mdi-lightning-bolt-outline" },
];
const executionMode = computed<ExecutionMode>(() => rpc.sessionState.value?.executionMode ?? "approval");
const currentExecutionMode = computed(() =>
  executionModes.find((mode) => mode.value === executionMode.value) ?? executionModes[1]
);
const isSwitchingExecutionMode = ref(false);

// Auto-scroll
watch(
  () => sessionStore.displayBlocks,
  async () => {
    await nextTick();
    if (shouldStickToBottom.value) {
      scrollContentToBottom();
    }
  },
  { deep: true }
);

// Scroll to bottom on mount when there are existing blocks (e.g. navigating back from settings)
onMounted(async () => {
  if (sessionStore.displayBlocks.length > 0) {
    await nextTick();
    scrollContentToBottom();
  }
});

function scrollContentToBottom(): void {
  const el = contentArea.value;
  if (!el) return;
  isProgrammaticScroll = true;
  el.scrollTop = el.scrollHeight;
  if (programmaticScrollFrame !== null) cancelAnimationFrame(programmaticScrollFrame);
  programmaticScrollFrame = requestAnimationFrame(() => {
    isProgrammaticScroll = false;
    programmaticScrollFrame = null;
  });
}

function handleContentScroll(): void {
  if (isProgrammaticScroll) return;
  const el = contentArea.value;
  if (!el) return;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  shouldStickToBottom.value = distance <= AUTO_SCROLL_THRESHOLD_PX;
}

// Session ops
async function setExecutionMode(mode: ExecutionMode): Promise<void> {
  if (isSwitchingExecutionMode.value) return;
  if (executionMode.value === mode) {
    showExecutionModeMenu.value = false;
    return;
  }
  isSwitchingExecutionMode.value = true;
  try {
    await rpc.setPiSetting("executionMode", mode);
    await rpc.refreshState();
  } catch (err) {
    console.error("[CenterPanel] Failed to toggle execution mode:", err);
  } finally {
    isSwitchingExecutionMode.value = false;
    showExecutionModeMenu.value = false;
  }
}

async function exportHtml(): Promise<void> {
  try {
    const result = await rpc.exportHtml();
    if (result) alert(`Session exported to: ${result}`);
  } catch (err) {
    console.error("[CenterPanel] Export HTML failed:", err);
  }
}

async function exportJsonl(): Promise<void> {
  try {
    const result = await rpc.exportJsonl();
    if (result) alert(`Session exported to: ${result}`);
  } catch (err) {
    console.error("[CenterPanel] Export JSONL failed:", err);
  }
}

async function handleFork(entryId: string, label?: string): Promise<void> {
  try {
    await rpc.forkSession(entryId, "before", label);
    showForkDialog.value = false;
    sessionStore.clearSession();
    await rpc.getMessages().then((msgs: unknown) => {
      if (Array.isArray(msgs)) {
        sessionStore.loadMessages(msgs as Array<{ role: string; content: unknown }>);
      }
    });
    await rpc.refreshState();
    await projectStore.listSessions();
    projectStore.syncCurrentSession(
      rpc.sessionState.value?.sessionFile,
      rpc.sessionState.value?.sessionId
    );
  } catch (err) {
    console.error("[CenterPanel] Fork failed:", err);
  }
}

// Composer methods
function handleInput(e: Event): void {
  const target = e.target as HTMLTextAreaElement;
  inputText.value = target.value;
  void nextTick(autoResize);

  const cursorPos = target.selectionStart;
  const textBeforeCursor = target.value.slice(0, cursorPos);
  const lastSlashIndex = textBeforeCursor.lastIndexOf("/");

  if (lastSlashIndex !== -1) {
    const charBefore = textBeforeCursor[lastSlashIndex - 1];
    if (lastSlashIndex === 0 || charBefore === " " || charBefore === "\n") {
      const query = textBeforeCursor.slice(lastSlashIndex + 1);
      if (query.length <= 20 && !query.includes(" ")) {
        searchQuery.value = query;
        showCommandPalette.value = true;
      } else {
        showCommandPalette.value = false;
      }
    } else {
      showCommandPalette.value = false;
    }
  } else {
    showCommandPalette.value = false;
  }
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    if (showCommandPalette.value) return;
    e.preventDefault();
    sendMessage();
  }
}

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function addAttachmentPaths(paths: string[]): void {
  const existing = new Set(attachments.value.map((file) => file.path));
  const next = [...attachments.value];

  for (const path of paths) {
    const trimmed = path.trim();
    if (!trimmed || existing.has(trimmed)) continue;
    next.push({ path: trimmed, name: fileNameFromPath(trimmed) });
    existing.add(trimmed);
  }

  attachments.value = next;
}

function removeAttachment(path: string): void {
  attachments.value = attachments.value.filter((file) => file.path !== path);
}

async function pickFiles(): Promise<void> {
  try {
    const paths = await window.pixApi.selectChatFiles();
    addAttachmentPaths(paths);
    textareaRef.value?.focus();
  } catch (err) {
    console.error("[CenterPanel] Select files failed:", err);
  }
}

function hasDraggedFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

function handleDragEnter(e: DragEvent): void {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
  isDraggingFiles.value = true;
}

function handleDragOver(e: DragEvent): void {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
  isDraggingFiles.value = true;
}

function handleDragLeave(e: DragEvent): void {
  const target = e.currentTarget as HTMLElement | null;
  const related = e.relatedTarget as Node | null;
  if (!target || !related || !target.contains(related)) {
    isDraggingFiles.value = false;
  }
}

function handleDrop(e: DragEvent): void {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
  isDraggingFiles.value = false;

  const files = Array.from(e.dataTransfer?.files ?? []);
  const paths = files
    .map((file) => window.pixApi.getPathForFile(file))
    .filter((path) => path.length > 0);
  addAttachmentPaths(paths);
}

function sendErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sendMessage(): Promise<void> {
  const text = inputText.value.trim();
  if (!text && attachments.value.length === 0) return;
  if (!canSend.value) return;

  isSending.value = true;
  const originalText = text;
  const originalAttachments = [...attachments.value];
  const filePaths = attachments.value.map((file) => file.path);
  // Clear input immediately while the request is being sent.
  inputText.value = "";
  attachments.value = [];
  if (textareaRef.value) {
    textareaRef.value.value = "";
    textareaRef.value.style.height = "auto";
  }
  let optimisticBlockId: string | null = null;
  try {
    optimisticBlockId = sessionStore.appendOptimisticUserMessage(text, filePaths);
    if (isStreaming.value) {
      void rpc.sendCommandAsync({ type: "steer", message: text, filePaths }).catch((error) => {
        sessionStore.failOptimisticUserMessage(optimisticBlockId, sendErrorMessage(error));
      });
    } else {
      await rpc.sendPrompt(text, filePaths);
    }
  } catch (error) {
    sessionStore.failOptimisticUserMessage(optimisticBlockId, sendErrorMessage(error));
    inputText.value = originalText;
    attachments.value = originalAttachments;
    if (textareaRef.value) {
      textareaRef.value.value = originalText;
      void nextTick(autoResize);
    }
  } finally {
    isSending.value = false;
  }
}

async function stopAgent(): Promise<void> {
  await rpc.abort();
}

function onCommandSelected(commandName: string): void {
  if (textareaRef.value) {
    const cursorPos = textareaRef.value.selectionStart;
    const textBeforeCursor = inputText.value.slice(0, cursorPos);
    const lastSlashIndex = textBeforeCursor.lastIndexOf("/");
    if (lastSlashIndex !== -1) {
      const before = inputText.value.slice(0, lastSlashIndex);
      const after = inputText.value.slice(cursorPos);
      inputText.value = before + "/" + commandName + " " + after;
      textareaRef.value.value = inputText.value;
    }
  }
  showCommandPalette.value = false;
  textareaRef.value?.focus();
}

function autoResize(): void {
  if (textareaRef.value) {
    textareaRef.value.style.height = "auto";
    textareaRef.value.style.height = Math.min(textareaRef.value.scrollHeight, 200) + "px";
  }
}
</script>

<template>
  <div class="center-panel">
    <!-- TopBar -->
    <div class="center-topbar">
      <div class="topbar-left">
        <span class="topbar-brand">PiX</span>
        <template v-if="projectName">
          <span class="topbar-sep">&rsaquo;</span>
          <span class="topbar-path">{{ projectName }}</span>
        </template>
        <template v-if="sessionName">
          <span class="topbar-sep">&rsaquo;</span>
          <span class="topbar-path">{{ sessionName }}</span>
        </template>
        <span class="status-pill" :class="statusClass">
          <span class="status-dot"></span>
          {{ statusText }}
        </span>
      </div>

      <div class="topbar-center">
        <button
          class="view-tab"
          :class="{ active: viewMode === 'session' }"
          @click="viewMode = 'session'"
        >会话</button>
        <button
          class="view-tab"
          :class="{ active: viewMode === 'tree' }"
          @click="viewMode = 'tree'"
        >树</button>
        <button
          class="view-tab"
          :class="{ active: viewMode === 'raw' }"
          @click="viewMode = 'raw'"
        >原始</button>
        <button class="topbar-action" @click="showForkDialog = true">分支</button>
        <v-menu v-model="showExportMenu" :close-on-content-click="true" location="bottom end">
          <template #activator="{ props: menuProps }">
            <button class="topbar-action" v-bind="menuProps">导出</button>
          </template>
          <v-list density="compact">
            <v-list-item @click="exportHtml(); showExportMenu = false" title="导出 HTML" />
            <v-list-item @click="exportJsonl(); showExportMenu = false" title="导出 JSONL" />
          </v-list>
        </v-menu>
      </div>

      <div class="topbar-right">
        <v-menu v-model="showExecutionModeMenu" location="bottom end" :close-on-content-click="false">
          <template #activator="{ props: menuProps }">
            <button
              class="execution-mode-select"
              :class="executionMode"
              type="button"
              :title="currentExecutionMode.description"
              :aria-label="`执行模式：${currentExecutionMode.label}`"
              :disabled="isSwitchingExecutionMode"
              v-bind="menuProps"
            >
              <v-icon :icon="currentExecutionMode.icon" size="14" />
              <span>{{ currentExecutionMode.label }}</span>
              <v-icon icon="mdi-chevron-down" size="13" />
            </button>
          </template>
          <div class="execution-mode-menu">
            <button
              v-for="mode in executionModes"
              :key="mode.value"
              class="execution-mode-option"
              :class="{ active: executionMode === mode.value }"
              type="button"
              @click="setExecutionMode(mode.value)"
            >
              <span class="mode-option-icon" :class="mode.value">
                <v-icon :icon="mode.icon" size="16" />
              </span>
              <span class="mode-option-text">
                <span class="mode-option-label">{{ mode.label }}</span>
                <span class="mode-option-desc">{{ mode.description }}</span>
              </span>
              <v-icon v-if="executionMode === mode.value" icon="mdi-check" size="15" />
            </button>
          </div>
        </v-menu>
        <span class="conn-pill" :class="rpc.isConnected.value ? 'connected' : 'offline'">
          <span class="conn-dot"></span>
          {{ rpc.isConnected.value ? '已连接' : '离线' }}
        </span>
      </div>
    </div>

    <!-- Session content -->
    <div class="session-content" ref="contentArea" @scroll="handleContentScroll">
      <div v-if="sessionStore.displayBlocks.length === 0" class="empty-state">
        <div class="empty-orbit" aria-hidden="true">
          <span class="empty-planet"></span>
          <span class="empty-ring"></span>
          <span class="empty-star empty-star-a"></span>
          <span class="empty-star empty-star-b"></span>
        </div>
        <p class="empty-title">新建会话</p>
        <p class="empty-hint">在下方输入任务开始使用 Pi。</p>
      </div>

      <SessionView v-if="viewMode === 'session'" :blocks="sessionStore.displayBlocks" />
      <SessionTreeView v-else-if="viewMode === 'tree'" />
      <RawOutputViewer v-else :raw-json="sessionStore.getRawEventsJson()" />
    </div>

    <!-- Composer -->
    <div class="center-composer">
      <div
        class="composer-inner"
        :class="{ 'dragging-files': isDraggingFiles }"
        @dragenter="handleDragEnter"
        @dragover="handleDragOver"
        @dragleave="handleDragLeave"
        @drop="handleDrop"
      >
        <CommandPalette
          v-if="showCommandPalette"
          :search="searchQuery"
          @select="onCommandSelected"
          @close="showCommandPalette = false"
        />

        <div v-if="attachments.length > 0" class="attachment-list">
          <span
            v-for="file in attachments"
            :key="file.path"
            class="attachment-chip"
            :title="file.path"
          >
            <span class="attachment-icon">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
            </span>
            <span class="attachment-name">{{ file.name }}</span>
            <button class="attachment-remove" @click="removeAttachment(file.path)" title="移除文件">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </span>
        </div>

        <textarea
          ref="textareaRef"
          class="composer-textarea"
          :placeholder="isStreaming ? 'AI 正在运行... 输入以操控' : '输入任务或按 / 使用命令...'"
          @input="handleInput"
          @keydown="handleKeydown"
          rows="2"
          spellcheck="true"
        ></textarea>

        <div class="composer-controls">
          <div class="composer-left">
            <button
              class="composer-icon-btn"
              @click="pickFiles"
              title="添加文件"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            </button>
            <span class="selector-anchor">
              <button
                class="model-btn"
                :title="modelOnlyDisplay"
                @click="showModelSelector = !showModelSelector; showThinkingSelector = false"
              >
                <span>{{ modelOnlyDisplay }}</span>
                <span class="model-btn-chevron">&#9660;</span>
              </button>
              <ModelSelector v-if="showModelSelector" @close="showModelSelector = false" />
            </span>
            <span class="selector-anchor">
              <button
                class="thinking-btn"
                :title="thinkingButtonDisplay"
                :disabled="thinkingButtonDisabled"
                @click="showThinkingSelector = !showThinkingSelector; showModelSelector = false"
              >
                <v-icon icon="mdi-brain" size="14" />
                <span>{{ thinkingButtonDisplay }}</span>
                <span class="model-btn-chevron">&#9660;</span>
              </button>
              <ThinkingSelector v-if="showThinkingSelector" @close="showThinkingSelector = false" />
            </span>
            <span
              v-if="eyeIndicatorVisible"
              class="eye-indicator"
              :class="{ active: eyeIndicatorActive, inactive: !eyeIndicatorActive }"
              :title="eyeIndicatorTitle"
            >
              <v-icon :icon="eyeIndicatorActive ? 'mdi-eye-outline' : 'mdi-eye-off-outline'" size="14" />
            </span>
          </div>
          <div class="composer-right">
            <button
              v-if="isStreaming"
              class="composer-action-btn primary-action"
              type="button"
              :disabled="!canSend"
              title="发送引导"
              aria-label="发送引导"
              @click="sendMessage"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M22 2 11 13" />
                <path d="m22 2-7 20-4-9-9-4Z" />
              </svg>
            </button>
            <button
              v-if="isStreaming"
              class="composer-action-btn stop-action"
              type="button"
              title="停止"
              aria-label="停止"
              @click="stopAgent"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
            <button
              v-else
              class="composer-action-btn primary-action"
              type="button"
              :disabled="!canSend"
              title="发送"
              aria-label="发送"
              @click="sendMessage"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M22 2 11 13" />
                <path d="m22 2-7 20-4-9-9-4Z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <ForkDialog v-if="showForkDialog" @close="showForkDialog = false" @fork="handleFork" />
  </div>
</template>

<style scoped>
.center-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(255, 255, 255, 0.94)),
    var(--pix-bg-content);
}

/* ── TopBar ── */
.center-topbar {
  display: flex;
  align-items: center;
  height: var(--pix-topbar-height);
  min-height: var(--pix-topbar-height);
  padding: 0 var(--pix-space-lg) 0 var(--pix-space-xl);
  background: var(--pix-bg-topbar);
  border-bottom: 1px solid var(--pix-border-light);
  -webkit-app-region: drag;
  user-select: none;
  flex-shrink: 0;
  gap: var(--pix-space-md);
  backdrop-filter: blur(14px);
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  min-width: 0;
  overflow: hidden;
  flex-shrink: 1;
}

.topbar-brand {
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  flex-shrink: 0;
  letter-spacing: 0.3px;
}

.topbar-sep {
  font-size: var(--pix-text-md);
  color: #b7bdce;
  flex-shrink: 0;
  line-height: 1;
}

.topbar-path {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-secondary);
  font-weight: var(--pix-weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topbar-breadcrumb {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
}

/* Status pill */
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 12px;
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  flex-shrink: 0;
  margin-left: var(--pix-space-sm);
}
.status-pill .status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-pill.status-idle {
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
}
.status-pill.status-idle .status-dot {
  background: var(--pix-text-secondary);
}
.status-pill.status-running {
  background: var(--pix-accent-light);
  color: var(--pix-accent);
}
.status-pill.status-running .status-dot {
  background: var(--pix-accent);
  animation: status-pulse 1.5s ease-in-out infinite;
}
.status-pill.status-compacting {
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
}
.status-pill.status-compacting .status-dot {
  background: var(--pix-warning);
}

@keyframes status-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.topbar-center {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
  padding: 3px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-lg);
  background: rgba(248, 249, 255, 0.88);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
}

/* View mode tabs */
.view-tab {
  padding: 5px 12px;
  border-radius: var(--pix-radius-md);
  font-size: var(--pix-text-sm);
  font-family: var(--pix-font-ui);
  color: var(--pix-text-secondary);
  cursor: pointer;
  transition: background var(--pix-transition-fast), color var(--pix-transition-fast);
  font-weight: var(--pix-weight-normal);
}

.view-tab:hover {
  background: #ffffff;
  color: var(--pix-text-primary);
}

.view-tab.active {
  background: #ffffff;
  color: var(--pix-accent);
  font-weight: var(--pix-weight-medium);
  box-shadow: var(--pix-shadow-xs);
}

.topbar-action {
  padding: 5px 10px;
  border-radius: var(--pix-radius-md);
  font-size: var(--pix-text-sm);
  font-family: var(--pix-font-ui);
  color: var(--pix-text-secondary);
  cursor: pointer;
  transition: background var(--pix-transition-fast), color var(--pix-transition-fast);
}

.topbar-action:hover {
  background: #ffffff;
  color: var(--pix-text-primary);
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  flex-shrink: 0;
  margin-left: auto;
  -webkit-app-region: no-drag;
}

.execution-mode-select {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--pix-border-light);
  border-radius: 12px;
  background: #ffffff;
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  cursor: pointer;
  transition:
    background var(--pix-transition-fast),
    border-color var(--pix-transition-fast),
    color var(--pix-transition-fast);
}

.execution-mode-select:hover {
  background: var(--pix-accent-light);
  border-color: var(--pix-border);
  color: var(--pix-text-primary);
}

.execution-mode-select:disabled {
  opacity: 0.65;
  cursor: wait;
}

.execution-mode-select.read-only {
  color: #2563eb;
  background: #eff6ff;
  border-color: #dbeafe;
}

.execution-mode-select.approval {
  color: var(--pix-warning);
  background: var(--pix-warning-bg);
  border-color: var(--pix-warning-light);
}

.execution-mode-select.unattended {
  color: var(--pix-success);
  background: var(--pix-success-bg);
  border-color: var(--pix-success-light);
}

.execution-mode-menu {
  width: 244px;
  padding: var(--pix-space-xs);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  background: rgba(255, 255, 255, 0.98);
  box-shadow: var(--pix-shadow-xl);
}

.execution-mode-option {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  width: 100%;
  min-height: 52px;
  padding: var(--pix-space-sm);
  border-radius: var(--pix-radius-lg);
  text-align: left;
  color: var(--pix-text-primary);
}

.execution-mode-option:hover,
.execution-mode-option.active {
  background: var(--pix-bg-hover);
}

.mode-option-icon {
  width: 30px;
  height: 30px;
  border-radius: var(--pix-radius-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: var(--pix-bg-code);
  color: var(--pix-text-secondary);
}

.mode-option-icon.read-only {
  background: #eff6ff;
  color: #2563eb;
}

.mode-option-icon.approval {
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
}

.mode-option-icon.unattended {
  background: var(--pix-success-bg);
  color: var(--pix-success);
}

.mode-option-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.mode-option-label {
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
}

.mode-option-desc {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  line-height: 1.35;
}

/* Connection pill */
.conn-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 12px;
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
}
.conn-pill .conn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.conn-pill.connected {
  background: var(--pix-success-bg);
  color: var(--pix-success);
}
.conn-pill.connected .conn-dot {
  background: var(--pix-success);
}
.conn-pill.offline {
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
}
.conn-pill.offline .conn-dot {
  background: var(--pix-text-secondary);
}

/* ── Session content ── */
.session-content {
  flex: 1;
  overflow-y: auto;
  padding: var(--pix-space-3xl) var(--pix-space-xl) var(--pix-space-xl);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  padding-bottom: 9vh;
}

.empty-orbit {
  position: relative;
  width: 92px;
  height: 78px;
  margin-bottom: var(--pix-space-lg);
}

.empty-planet {
  position: absolute;
  left: 25px;
  top: 12px;
  width: 50px;
  height: 50px;
  border-radius: 50%;
  background:
    radial-gradient(circle at 32% 26%, rgba(255, 255, 255, 0.88), transparent 28%),
    linear-gradient(145deg, #c7c0ff 0%, #7567f5 72%);
  box-shadow: 0 18px 38px rgba(98, 84, 243, 0.23);
}

.empty-ring {
  position: absolute;
  left: 12px;
  top: 22px;
  width: 78px;
  height: 34px;
  border: 4px solid rgba(188, 151, 235, 0.28);
  border-left-color: rgba(98, 84, 243, 0.72);
  border-radius: 50%;
  transform: rotate(-24deg);
}

.empty-star {
  position: absolute;
  width: 7px;
  height: 7px;
  color: var(--pix-accent-soft);
}

.empty-star::before,
.empty-star::after {
  content: "";
  position: absolute;
  background: currentColor;
  border-radius: 999px;
}

.empty-star::before {
  left: 3px;
  top: 0;
  width: 1px;
  height: 7px;
}

.empty-star::after {
  left: 0;
  top: 3px;
  width: 7px;
  height: 1px;
}

.empty-star-a {
  left: 9px;
  top: 20px;
}

.empty-star-b {
  right: 5px;
  bottom: 18px;
}

.empty-title {
  font-size: var(--pix-text-xl);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  margin-bottom: var(--pix-space-xs);
}

.empty-hint {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-secondary);
}

/* ── Composer ── */
.center-composer {
  flex-shrink: 0;
  padding: var(--pix-space-md) var(--pix-space-xl) var(--pix-space-xl);
}

.composer-inner {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-sm);
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  padding: 12px;
  box-shadow: var(--pix-shadow-lg);
  transition: border-color var(--pix-transition-base), box-shadow var(--pix-transition-base);
}

.composer-inner:focus-within {
  border-color: var(--pix-accent);
  box-shadow: var(--pix-shadow-lg), 0 0 0 3px rgba(98, 84, 243, 0.12);
}

.composer-inner.dragging-files {
  border-color: var(--pix-accent);
  background: var(--pix-accent-light);
}

.attachment-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--pix-space-xs);
  padding: 0 var(--pix-space-xs);
}

.attachment-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 220px;
  padding: 4px 6px;
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
}

.attachment-icon {
  display: inline-flex;
  color: var(--pix-text-secondary);
  flex-shrink: 0;
}

.attachment-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.attachment-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: var(--pix-radius-xs);
  color: var(--pix-text-secondary);
  flex-shrink: 0;
}

.attachment-remove:hover {
  background: var(--pix-bg-active);
  color: var(--pix-text-primary);
}

.composer-textarea {
  width: 100%;
  padding: var(--pix-space-sm) var(--pix-space-sm);
  border: none;
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-base);
  line-height: var(--pix-leading-base);
  background: transparent;
  color: var(--pix-text-primary);
  resize: none;
  font-family: var(--pix-font-ui);
  min-height: 46px;
}

.composer-textarea:focus {
  outline: none;
}

.composer-textarea::placeholder {
  color: var(--pix-text-muted);
}

.composer-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
}

.composer-left {
  display: flex;
  gap: var(--pix-space-xs);
  position: relative;
  align-items: center;
}

.composer-right {
  display: flex;
  gap: var(--pix-space-xs);
  align-items: center;
}

/* Icon action in composer */
.composer-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--pix-radius-md);
  color: var(--pix-text-secondary);
  cursor: pointer;
  transition: background var(--pix-transition-fast), color var(--pix-transition-fast);
}

.composer-icon-btn:hover {
  background: var(--pix-accent-light);
  color: var(--pix-text-primary);
}

.selector-anchor {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

/* Model button in composer */
.model-btn,
.thinking-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: var(--pix-radius-md);
  font-size: var(--pix-text-sm);
  font-family: var(--pix-font-ui);
  color: var(--pix-text-secondary);
  cursor: pointer;
  transition: background var(--pix-transition-fast), color var(--pix-transition-fast);
  white-space: nowrap;
  max-width: min(420px, 48vw);
}

.thinking-btn {
  max-width: 180px;
  color: var(--pix-accent);
  background: var(--pix-accent-light);
}

.thinking-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.model-btn span:first-child,
.thinking-btn span:first-of-type {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.model-btn:hover,
.thinking-btn:hover:not(:disabled) {
  background: var(--pix-bg-hover);
  color: var(--pix-text-primary);
}

.model-btn-chevron {
  font-size: 10px;
  color: var(--pix-text-secondary);
  transition: transform var(--pix-transition-fast);
}

.eye-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  background: #ffffff;
  color: var(--pix-text-muted);
}

.eye-indicator.active {
  color: #2563eb;
  background: #eff6ff;
  border-color: #dbeafe;
}

.eye-indicator.inactive {
  color: var(--pix-text-muted);
  background: var(--pix-bg-hover);
}

/* Send / Stop icon actions */
.composer-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: var(--pix-radius-lg);
  cursor: pointer;
  transition:
    background var(--pix-transition-fast),
    box-shadow var(--pix-transition-fast),
    opacity var(--pix-transition-fast),
    transform var(--pix-transition-fast);
  border: none;
}

.composer-action-btn.primary-action {
  background: linear-gradient(135deg, #7567f5 0%, #5142df 100%);
  color: var(--pix-text-inverse);
  box-shadow: 0 12px 24px rgba(98, 84, 243, 0.26);
}

.composer-action-btn.primary-action:hover:not(:disabled) {
  box-shadow: 0 15px 30px rgba(98, 84, 243, 0.32);
  transform: translateY(-1px);
}

.composer-action-btn.primary-action:disabled {
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
  cursor: not-allowed;
  box-shadow: none;
  opacity: 0.62;
}

.composer-action-btn.stop-action {
  background: var(--pix-error-bg);
  color: var(--pix-error);
}

.composer-action-btn.stop-action:hover {
  background: var(--pix-error-light);
  transform: translateY(-1px);
}
</style>
