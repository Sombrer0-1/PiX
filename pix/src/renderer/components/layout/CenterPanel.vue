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
import { computed, ref, watch, nextTick } from "vue";
import { useSessionStore } from "../../stores/session-store";
import { useRpc } from "../../composables/useRpc";
import { useProjectStore } from "../../stores/project-store";
import SessionView from "../session/SessionView.vue";
import RawOutputViewer from "../session/RawOutputViewer.vue";
import SessionTreeView from "../session/SessionTreeView.vue";
import ForkDialog from "../session/ForkDialog.vue";
import CommandPalette from "../input/CommandPalette.vue";
import ModelSelector from "../input/ModelSelector.vue";

const sessionStore = useSessionStore();
const rpc = useRpc();
const projectStore = useProjectStore();

type ViewMode = "session" | "raw" | "tree";
const viewMode = ref<ViewMode>("session");
const showExportMenu = ref(false);
const showForkDialog = ref(false);
const contentArea = ref<HTMLElement | null>(null);

// Composer state
const inputText = ref("");
const searchQuery = ref("");
const showCommandPalette = ref(false);
const showModelSelector = ref(false);
const isSending = ref(false);
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const projectName = computed(() => projectStore.currentProject?.name || "");
const sessionName = computed(() => rpc.sessionState.value?.sessionName || "Session");
const canSend = computed(() => inputText.value.trim().length > 0 && rpc.isConnected.value && !isSending.value);
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

// Auto-scroll
watch(
  () => sessionStore.displayBlocks.length,
  async () => {
    await nextTick();
    if (contentArea.value) {
      contentArea.value.scrollTop = contentArea.value.scrollHeight;
    }
  }
);

// Session ops
async function copyLastReply(): Promise<void> {
  try {
    const result = await rpc.sendCommand<string>({ type: "get_last_assistant_text" });
    if (result) await navigator.clipboard.writeText(result);
  } catch (err) {
    console.error("[CenterPanel] Copy failed:", err);
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

async function sendMessage(): Promise<void> {
  const text = inputText.value.trim();
  if (!text || (!canSend.value && !isStreaming.value)) return;

  isSending.value = true;
  // Clear input immediately — don't wait for response
  inputText.value = "";
  if (textareaRef.value) {
    textareaRef.value.value = "";
    textareaRef.value.style.height = "auto";
  }
  try {
    if (isStreaming.value) {
      rpc.sendCommandAsync({ type: "steer", message: text });
    } else {
      await rpc.sendPrompt(text);
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
    <!-- Header bar -->
    <div class="center-topbar">
      <div class="topbar-left">
        <span class="topbar-brand">PiX</span>
        <template v-if="projectName">
          <span class="topbar-sep">&rsaquo;</span>
          <span class="topbar-path">{{ projectName }}</span>
        </template>
        <template v-if="sessionName !== 'Session'">
          <span class="topbar-sep">&rsaquo;</span>
          <span class="topbar-path">{{ sessionName }}</span>
        </template>
        <v-chip
          size="small"
          :color="rpc.isStreaming.value ? 'primary' : (rpc.sessionState.value?.isCompacting ? 'warning' : undefined)"
          :variant="rpc.isStreaming.value || rpc.sessionState.value?.isCompacting ? 'tonal' : 'text'"
        >
          {{ statusText }}
        </v-chip>
      </div>

      <div class="topbar-center">
        <v-btn-group density="compact" variant="outlined" divided>
          <v-btn
            :color="viewMode === 'session' ? 'primary' : undefined"
            :variant="viewMode === 'session' ? 'tonal' : 'text'"
            size="small"
            @click="viewMode = 'session'"
          >会话</v-btn>
          <v-btn
            :color="viewMode === 'tree' ? 'primary' : undefined"
            :variant="viewMode === 'tree' ? 'tonal' : 'text'"
            size="small"
            @click="viewMode = 'tree'"
          >树</v-btn>
          <v-btn
            :color="viewMode === 'raw' ? 'primary' : undefined"
            :variant="viewMode === 'raw' ? 'tonal' : 'text'"
            size="small"
            @click="viewMode = 'raw'"
          >原始</v-btn>
        </v-btn-group>
        <v-btn variant="text" size="small" @click="showForkDialog = true">分支</v-btn>
        <v-menu v-model="showExportMenu" :close-on-content-click="true" location="bottom end">
          <template #activator="{ props: menuProps }">
            <v-btn variant="text" size="small" v-bind="menuProps">导出</v-btn>
          </template>
          <v-list density="compact">
            <v-list-item @click="exportHtml(); showExportMenu = false" title="导出 HTML" />
            <v-list-item @click="exportJsonl(); showExportMenu = false" title="导出 JSONL" />
            <v-list-item @click="copyLastReply(); showExportMenu = false" title="复制最后回复" />
          </v-list>
        </v-menu>
      </div>

      <div class="topbar-right">
        <v-chip
          size="small"
          :color="rpc.isConnected.value ? 'success' : undefined"
          :variant="rpc.isConnected.value ? 'tonal' : 'text'"
        >
          {{ rpc.isConnected.value ? '已连接' : '离线' }}
        </v-chip>
      </div>
    </div>

    <!-- Session content -->
    <div class="session-content" ref="contentArea">
      <div v-if="sessionStore.displayBlocks.length === 0" class="empty-state">
        <p class="empty-title">新建会话</p>
        <p class="empty-hint">在下方输入任务开始使用 Pi。</p>
      </div>

      <SessionView v-if="viewMode === 'session'" :blocks="sessionStore.displayBlocks" />
      <SessionTreeView v-else-if="viewMode === 'tree'" />
      <RawOutputViewer v-else :raw-json="sessionStore.getRawEventsJson()" />
    </div>

    <!-- Composer -->
    <div class="center-composer">
      <div class="composer-inner">
        <CommandPalette
          v-if="showCommandPalette"
          :search="searchQuery"
          @select="onCommandSelected"
          @close="showCommandPalette = false"
        />

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
            <v-btn
              variant="text"
              size="small"
              class="model-btn"
              :title="modelDisplay"
              @click="showModelSelector = !showModelSelector"
            >
              <span class="model-btn-text">{{ modelDisplay }}</span>
            </v-btn>
            <ModelSelector v-if="showModelSelector" @close="showModelSelector = false" />
          </div>
          <div class="composer-right">
            <v-btn
              v-if="isStreaming"
              variant="tonal"
              color="error"
              size="small"
              @click="stopAgent"
            >停止</v-btn>
            <v-btn
              v-else
              variant="tonal"
              color="primary"
              size="small"
              :disabled="!canSend"
              @click="sendMessage"
            >发送</v-btn>
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

/* Header bar */
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
  font-size: var(--pix-text-md);
  font-weight: 600;
  color: var(--pix-text-primary);
  flex-shrink: 0;
}

.topbar-sep {
  font-size: var(--pix-text-md);
  color: var(--pix-text-muted);
  flex-shrink: 0;
  line-height: 1;
}

.topbar-path {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topbar-center {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}

.topbar-right {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  margin-left: auto;
  -webkit-app-region: no-drag;
}

/* Session content */
.session-content {
  flex: 1;
  overflow-y: auto;
  padding: var(--pix-space-2xl);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
}

.empty-title {
  font-size: var(--pix-text-lg);
  font-weight: 500;
  color: var(--pix-text-secondary);
}

.empty-hint {
  margin-top: var(--pix-space-sm);
  font-size: var(--pix-text-md);
  color: var(--pix-text-muted);
}

/* Composer */
.center-composer {
  flex-shrink: 0;
  padding: var(--pix-space-md) var(--pix-space-lg);
  border-top: 1px solid var(--pix-border-light);
  background: var(--pix-bg-content);
}

.composer-inner {
  position: relative;
}

.composer-textarea {
  width: 100%;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-base);
  line-height: var(--pix-leading-base);
  background: var(--pix-bg-input);
  color: var(--pix-text-primary);
  resize: none;
  font-family: var(--pix-font-ui);
}

.composer-textarea:focus {
  outline: none;
  border-color: var(--pix-accent);
  box-shadow: 0 0 0 1px var(--pix-accent-light);
}

.composer-textarea::placeholder {
  color: var(--pix-text-muted);
}

.composer-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--pix-space-sm);
}

.composer-left {
  display: flex;
  gap: var(--pix-space-sm);
  position: relative;
}

.composer-right {
  display: flex;
  gap: var(--pix-space-sm);
}

.model-btn {
  max-width: 280px;
}

.model-btn-text {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--pix-text-muted);
}
</style>
