<script setup lang="ts">
/**
 * RightPanel - Status summary panel
 *
 * Shows lightweight, real information about the current session.
 * Only shows what pi actually provides.
 */
import { computed } from "vue";
import { useRpc } from "../../composables/useRpc";
import { useProjectStore } from "../../stores/project-store";
import TokenStats from "../status/TokenStats.vue";

const rpc = useRpc();
const projectStore = useProjectStore();

const modelDisplay = computed(() => {
  const model = rpc.sessionState.value?.model;
  if (!model) return "Not set";
  return `${model.provider}/${model.id}`;
});

const thinkingLevel = computed(() => rpc.sessionState.value?.thinkingLevel || "medium");

const sessionId = computed(() => rpc.sessionState.value?.sessionId || "-");

const sessionName = computed(() => rpc.sessionState.value?.sessionName);

const isStreaming = computed(() => rpc.isStreaming.value);
const isError = computed(() => rpc.lastError.value !== null);

const statusLabel = computed(() => {
  if (isStreaming.value) return "Running";
  if (isError.value) return "Error";
  return "Idle";
});

const statusClass = computed(() => {
  if (isStreaming.value) return "status-running";
  if (isError.value) return "status-error";
  return "status-idle";
});

const projectPath = computed(() => projectStore.currentProject?.path || "-");

const messageCount = computed(() => rpc.sessionState.value?.messageCount || 0);
</script>

<template>
  <div class="right-panel">
    <!-- Status Card -->
    <div class="status-card">
      <div class="status-indicator" :class="statusClass">
        <span class="status-dot"></span>
        {{ statusLabel }}
      </div>
    </div>

    <!-- Session Info -->
    <div class="info-section">
      <div class="info-item">
        <div class="info-label">Model</div>
        <div class="info-value mono">{{ modelDisplay }}</div>
      </div>

      <div class="info-item">
        <div class="info-label">Thinking</div>
        <div class="info-value">{{ thinkingLevel }}</div>
      </div>

      <div class="info-item">
        <div class="info-label">Session</div>
        <div class="info-value mono" :title="sessionId">
          {{ sessionName || sessionId.slice(0, 12) }}
        </div>
      </div>

      <div class="info-item">
        <div class="info-label">Messages</div>
        <div class="info-value">{{ messageCount }}</div>
      </div>

      <div class="info-item">
        <div class="info-label">Project</div>
        <div class="info-value mono" :title="projectPath">{{ projectPath.split(/[/\\]/).pop() }}</div>
      </div>

      <div class="info-item">
        <div class="info-label">Pi Status</div>
        <div class="info-value">
          <span v-if="rpc.isConnected.value" class="pi-ok">Connected</span>
          <span v-else class="pi-nok">Disconnected</span>
        </div>
      </div>
    </div>

    <!-- Token Stats -->
    <div class="info-section">
      <div class="section-title">Token Usage</div>
      <TokenStats />
    </div>

    <!-- Error Summary -->
    <div v-if="rpc.lastError.value" class="info-section error-section">
      <div class="section-title">Last Error</div>
      <div class="error-text">{{ rpc.lastError.value }}</div>
    </div>
  </div>
</template>

<style scoped>
.right-panel {
  padding: var(--pix-space-lg);
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-lg);
}

.status-card {
  padding: var(--pix-space-md);
  background: var(--pix-bg-content);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  font-size: var(--pix-text-sm);
  font-weight: 500;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-running .status-dot {
  background: var(--pix-accent);
  animation: pulse 1.5s ease-in-out infinite;
}

.status-error .status-dot {
  background: var(--pix-error);
}

.status-idle .status-dot {
  background: var(--pix-text-muted);
}

.status-running {
  color: var(--pix-accent);
}

.status-error {
  color: var(--pix-error);
}

.status-idle {
  color: var(--pix-text-muted);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.info-section {
  padding: var(--pix-space-md);
  background: var(--pix-bg-content);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
}

.section-title {
  font-size: var(--pix-text-xs);
  font-weight: 600;
  color: var(--pix-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: var(--pix-space-md);
}

.info-item {
  margin-bottom: var(--pix-space-sm);
}

.info-item:last-child {
  margin-bottom: 0;
}

.info-label {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  margin-bottom: 1px;
}

.info-value {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-primary);
  font-weight: 500;
}

.info-value.mono {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pi-ok {
  color: var(--pix-success);
  font-size: var(--pix-text-sm);
}

.pi-nok {
  color: var(--pix-error);
  font-size: var(--pix-text-sm);
}

.error-section {
  border-color: #e8d0d0;
}

.error-text {
  font-size: var(--pix-text-xs);
  color: var(--pix-error);
  line-height: var(--pix-leading-base);
  max-height: 100px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
