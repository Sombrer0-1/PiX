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
import { deriveSessionTitle } from "@/utils/session-title";

const sessionStore = useSessionStore();
const rpc = useRpc();
const projectStore = useProjectStore();

type ViewMode = "session" | "raw" | "tree";
const viewMode = ref<ViewMode>("session");
const showExportMenu = ref(false);
const showForkDialog = ref(false);
const contentArea = ref<HTMLElement | null>(null);
const shouldStickToBottom = ref(true);

// Composer state
const inputText = ref("");
const searchQuery = ref("");
const showCommandPalette = ref(false);
const showModelSelector = ref(false);
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

const executionMode = computed(() => rpc.sessionState.value?.executionMode ?? "approval");
const executionModeLabel = computed(() => executionMode.value === "unattended" ? "无监管" : "审批");
const executionModeTitle = computed(() =>
  executionMode.value === "unattended"
    ? "当前是无监管模式：Agent 工具调用不会请求审批。点击切换到审批模式。"
    : "当前是审批模式：高风险工具调用会请求你审批。点击切换到无监管模式。"
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
async function toggleExecutionMode(): Promise<void> {
  if (isSwitchingExecutionMode.value) return;
  isSwitchingExecutionMode.value = true;
  const nextMode = executionMode.value === "unattended" ? "approval" : "unattended";
  try {
    await rpc.setPiSetting("executionMode", nextMode);
    await rpc.refreshState();
  } catch (err) {
    console.error("[CenterPanel] Failed to toggle execution mode:", err);
  } finally {
    isSwitchingExecutionMode.value = false;
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

async function sendMessage(): Promise<void> {
  const text = inputText.value.trim();
  if (!text && attachments.value.length === 0) return;
  if (!canSend.value) return;

  isSending.value = true;
  const filePaths = attachments.value.map((file) => file.path);
  // Clear input immediately — don't wait for response
  inputText.value = "";
  attachments.value = [];
  if (textareaRef.value) {
    textareaRef.value.value = "";
    textareaRef.value.style.height = "auto";
  }
  try {
    if (isStreaming.value) {
      rpc.sendCommandAsync({ type: "steer", message: text, filePaths });
    } else {
      await rpc.sendPrompt(text, filePaths);
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
        <button
          class="execution-mode-toggle"
          :class="executionMode"
          type="button"
          :title="executionModeTitle"
          :aria-label="executionModeTitle"
          :disabled="isSwitchingExecutionMode"
          @click="toggleExecutionMode"
        >
          <span class="mode-dot"></span>
          {{ executionModeLabel }}
        </button>
        <span class="conn-pill" :class="rpc.isConnected.value ? 'connected' : 'offline'">
          <span class="conn-dot"></span>
          {{ rpc.isConnected.value ? '已连接' : '离线' }}
        </span>
      </div>
    </div>

    <!-- Session content -->
    <div class="session-content" ref="contentArea" @scroll="handleContentScroll">
      <div v-if="sessionStore.displayBlocks.length === 0" class="empty-state">
        <div class="empty-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
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
            <button
              class="model-btn"
              :title="modelButtonDisplay"
              @click="showModelSelector = !showModelSelector"
            >
              <span>{{ modelButtonDisplay }}</span>
              <span class="model-btn-chevron">&#9660;</span>
            </button>
            <ModelSelector v-if="showModelSelector" @close="showModelSelector = false" />
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
}

/* ── TopBar ── */
.center-topbar {
  display: flex;
  align-items: center;
  height: var(--pix-topbar-height);
  min-height: var(--pix-topbar-height);
  padding: 0 var(--pix-space-lg);
  background: var(--pix-bg-topbar);
  border-bottom: 1px solid var(--pix-border-light);
  -webkit-app-region: drag;
  user-select: none;
  flex-shrink: 0;
  gap: var(--pix-space-md);
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
  color: var(--pix-text-secondary);
  flex-shrink: 0;
  letter-spacing: 0.3px;
}

.topbar-sep {
  font-size: var(--pix-text-md);
  color: var(--pix-border);
  flex-shrink: 0;
  line-height: 1;
}

.topbar-path {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-primary);
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
  padding: 2px 10px;
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
}

/* View mode tabs */
.view-tab {
  padding: 4px 12px;
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-sm);
  font-family: var(--pix-font-ui);
  color: var(--pix-text-secondary);
  cursor: pointer;
  transition: background var(--pix-transition-fast), color var(--pix-transition-fast);
  font-weight: var(--pix-weight-normal);
}

.view-tab:hover {
  background: var(--pix-bg-hover);
  color: var(--pix-text-primary);
}

.view-tab.active {
  background: var(--pix-accent-light);
  color: var(--pix-accent);
  font-weight: var(--pix-weight-medium);
}

.topbar-action {
  padding: 4px 10px;
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-sm);
  font-family: var(--pix-font-ui);
  color: var(--pix-text-secondary);
  cursor: pointer;
  transition: background var(--pix-transition-fast), color var(--pix-transition-fast);
}

.topbar-action:hover {
  background: var(--pix-bg-hover);
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

.execution-mode-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  border: 1px solid var(--pix-border-light);
  border-radius: 12px;
  background: var(--pix-bg-content);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  cursor: pointer;
  transition:
    background var(--pix-transition-fast),
    border-color var(--pix-transition-fast),
    color var(--pix-transition-fast);
}

.execution-mode-toggle:hover {
  background: var(--pix-bg-hover);
  border-color: var(--pix-border);
  color: var(--pix-text-primary);
}

.execution-mode-toggle:disabled {
  opacity: 0.65;
  cursor: wait;
}

.execution-mode-toggle .mode-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.execution-mode-toggle.approval .mode-dot {
  background: var(--pix-warning);
}

.execution-mode-toggle.unattended .mode-dot {
  background: var(--pix-success);
}

/* Connection pill */
.conn-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
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
  padding: var(--pix-space-3xl) var(--pix-space-xl);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
}

.empty-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--pix-bg-hover);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--pix-space-lg);
  color: var(--pix-text-secondary);
}

.empty-title {
  font-size: var(--pix-text-lg);
  font-weight: var(--pix-weight-medium);
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
  padding: var(--pix-space-md) var(--pix-space-xl) var(--pix-space-lg);
}

.composer-inner {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-sm);
  background: var(--pix-bg-content);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-lg);
  padding: var(--pix-space-sm);
  box-shadow: var(--pix-shadow-sm);
  transition: border-color var(--pix-transition-base), box-shadow var(--pix-transition-base);
}

.composer-inner:focus-within {
  border-color: var(--pix-accent);
  box-shadow: var(--pix-shadow-md), 0 0 0 2px var(--pix-accent-light);
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
  border-radius: var(--pix-radius-sm);
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
  min-height: 48px;
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
  padding: 0 var(--pix-space-xs);
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
  width: 28px;
  height: 28px;
  border-radius: var(--pix-radius-sm);
  color: var(--pix-text-secondary);
  cursor: pointer;
  transition: background var(--pix-transition-fast), color var(--pix-transition-fast);
}

.composer-icon-btn:hover {
  background: var(--pix-bg-hover);
  color: var(--pix-text-primary);
}

/* Model button in composer */
.model-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-sm);
  font-family: var(--pix-font-ui);
  color: var(--pix-text-secondary);
  cursor: pointer;
  transition: background var(--pix-transition-fast), color var(--pix-transition-fast);
  white-space: nowrap;
  max-width: min(420px, 48vw);
}

.model-btn span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.model-btn:hover {
  background: var(--pix-bg-hover);
  color: var(--pix-text-primary);
}

.model-btn-chevron {
  font-size: 10px;
  color: var(--pix-text-secondary);
  transition: transform var(--pix-transition-fast);
}

/* Send / Stop icon actions */
.composer-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--pix-radius-sm);
  cursor: pointer;
  transition:
    background var(--pix-transition-fast),
    box-shadow var(--pix-transition-fast),
    opacity var(--pix-transition-fast),
    transform var(--pix-transition-fast);
  border: none;
}

.composer-action-btn.primary-action {
  background: var(--pix-accent);
  color: var(--pix-text-inverse);
  box-shadow: var(--pix-shadow-xs);
}

.composer-action-btn.primary-action:hover:not(:disabled) {
  background: var(--pix-accent-hover);
  box-shadow: var(--pix-shadow-sm);
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
