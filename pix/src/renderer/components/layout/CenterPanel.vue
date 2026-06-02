<script setup lang="ts">
/**
 * CenterPanel - Session content area
 *
 * Displays the current session as a document-stream view.
 * No chat bubbles, no avatars.
 */
import { computed, ref, watch, nextTick } from "vue";
import { useSessionStore } from "../../stores/session-store";
import { useRpc } from "../../composables/useRpc";
import SessionView from "../session/SessionView.vue";
import RawOutputViewer from "../session/RawOutputViewer.vue";
import SessionTreeView from "../session/SessionTreeView.vue";
import ForkDialog from "../session/ForkDialog.vue";

const sessionStore = useSessionStore();
const rpc = useRpc();

type ViewMode = "session" | "raw" | "tree";
const viewMode = ref<ViewMode>("session");
const showExportMenu = ref(false);
const showForkDialog = ref(false);
const contentArea = ref<HTMLElement | null>(null);

// Auto-scroll to bottom when new content arrives
watch(
  () => sessionStore.displayBlocks.length,
  async () => {
    await nextTick();
    if (contentArea.value) {
      contentArea.value.scrollTop = contentArea.value.scrollHeight;
    }
  }
);

const sessionName = computed(() => rpc.sessionState.value?.sessionName || "Session");
const statusText = computed(() => {
  if (rpc.isStreaming.value) return "Running";
  if (rpc.sessionState.value?.isCompacting) return "Compacting";
  return "Idle";
});

const statusClass = computed(() => {
  if (rpc.isStreaming.value) return "status-running";
  if (rpc.sessionState.value?.isCompacting) return "status-compacting";
  return "status-idle";
});

async function copyLastReply(): Promise<void> {
  try {
    const result = await rpc.sendCommand<string>({ type: "get_last_assistant_text" });
    if (result) {
      await navigator.clipboard.writeText(result);
    }
  } catch (err) {
    console.error("[CenterPanel] Copy failed:", err);
  }
}

async function exportHtml(): Promise<void> {
  try {
    const result = await rpc.exportHtml();
    if (result) {
      alert(`Session exported to: ${result}`);
    }
  } catch (err) {
    console.error("[CenterPanel] Export HTML failed:", err);
  }
}

async function exportJsonl(): Promise<void> {
  try {
    const result = await rpc.exportJsonl();
    if (result) {
      alert(`Session exported to: ${result}`);
    }
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
</script>

<template>
  <div class="center-panel">
    <!-- Session Header -->
    <div class="session-header">
      <div class="session-header-left">
        <h1 class="session-title">{{ sessionName }}</h1>
        <span class="session-status" :class="statusClass">{{ statusText }}</span>
      </div>
      <div class="session-header-right">
        <button class="header-btn" :class="{ active: viewMode === 'session' }" @click="viewMode = 'session'" title="Session view">Session</button>
        <button class="header-btn" :class="{ active: viewMode === 'tree' }" @click="viewMode = 'tree'" title="Tree view">Tree</button>
        <button class="header-btn" :class="{ active: viewMode === 'raw' }" @click="viewMode = 'raw'" title="Raw events">Raw</button>
        <button class="header-btn" @click="showForkDialog = true" title="Fork session">Fork</button>
        <div class="export-dropdown">
          <button class="header-btn" @click="showExportMenu = !showExportMenu" title="Export / Copy">Export ▾</button>
          <div v-if="showExportMenu" class="export-menu">
            <button @click="exportHtml(); showExportMenu = false">Export HTML</button>
            <button @click="exportJsonl(); showExportMenu = false">Export JSONL</button>
            <button @click="copyLastReply(); showExportMenu = false">Copy Last Reply</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Content Area -->
    <div class="session-content" ref="contentArea">
      <!-- Empty State -->
      <div v-if="sessionStore.displayBlocks.length === 0" class="empty-state">
        <p class="empty-title">New Session</p>
        <p class="empty-hint">Enter a task below to get started with Pi.</p>
      </div>

      <!-- Session View, Tree View, or Raw Output -->
      <SessionView v-if="viewMode === 'session'" :blocks="sessionStore.displayBlocks" />
      <SessionTreeView v-else-if="viewMode === 'tree'" />
      <RawOutputViewer v-else :raw-json="sessionStore.getRawEventsJson()" />
    </div>

    <!-- Fork Dialog -->
    <ForkDialog
      v-if="showForkDialog"
      @close="showForkDialog = false"
      @fork="handleFork"
    />
  </div>
</template>

<style scoped>
.center-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.session-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--pix-space-md) var(--pix-space-xl);
  background: var(--pix-bg-content);
  border-bottom: 1px solid var(--pix-border-light);
  flex-shrink: 0;
}

.session-header-left {
  display: flex;
  align-items: center;
  gap: var(--pix-space-md);
}

.session-title {
  font-size: var(--pix-text-md);
  font-weight: 600;
  color: var(--pix-text-primary);
}

.session-status {
  font-size: var(--pix-text-xs);
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 10px;
}

.status-running {
  background: var(--pix-accent-light);
  color: var(--pix-accent);
}

.status-compacting {
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
}

.status-idle {
  background: var(--pix-bg-code);
  color: var(--pix-text-muted);
}

.session-header-right {
  display: flex;
  gap: var(--pix-space-sm);
}

.header-btn {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border-radius: var(--pix-radius-sm);
  border: 1px solid var(--pix-border);
}

.header-btn:hover {
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
}

.header-btn.active {
  background: var(--pix-accent-light);
  color: var(--pix-accent);
  border-color: var(--pix-accent);
}

/* Export dropdown */
.export-dropdown {
  position: relative;
}

.export-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  background: var(--pix-bg-content);
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-md);
  box-shadow: var(--pix-shadow-md);
  z-index: 50;
  min-width: 140px;
}

.export-menu button {
  display: block;
  width: 100%;
  padding: var(--pix-space-sm) var(--pix-space-md);
  text-align: left;
  font-size: var(--pix-text-sm);
  color: var(--pix-text-primary);
}

.export-menu button:hover {
  background: var(--pix-bg-hover);
}

.session-content {
  flex: 1;
  overflow-y: auto;
  padding: var(--pix-space-xl);
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
</style>
