<script setup lang="ts">
/**
 * StatusPanel - Session status indicator
 *
 * Shows running/idle/error state with a colored indicator.
 */
import { computed } from "vue";

const props = defineProps<{
  isRunning: boolean;
  isError: boolean;
  errorMessage?: string | null;
}>();

const statusLabel = computed(() => {
  if (props.isRunning) return "Running";
  if (props.isError) return "Error";
  return "Idle";
});

const statusClass = computed(() => {
  if (props.isRunning) return "status-running";
  if (props.isError) return "status-error";
  return "status-idle";
});
</script>

<template>
  <div class="status-panel" :class="statusClass">
    <div class="status-row">
      <span class="status-dot"></span>
      <span class="status-label">{{ statusLabel }}</span>
    </div>
    <div v-if="isError && errorMessage" class="status-error">{{ errorMessage }}</div>
  </div>
</template>

<style scoped>
.status-panel {
  padding: var(--pix-space-md);
  border-radius: var(--pix-radius-md);
  border: 1px solid var(--pix-border-light);
}

.status-panel.status-running {
  background: var(--pix-accent-light);
  border-color: #d0dde8;
}

.status-panel.status-error {
  background: var(--pix-error-bg);
  border-color: #e8d0d0;
}

.status-panel.status-idle {
  background: var(--pix-bg-content);
}

.status-row {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
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

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.status-label {
  font-size: var(--pix-text-sm);
  font-weight: 500;
}

.status-running .status-label {
  color: var(--pix-accent);
}

.status-error .status-label {
  color: var(--pix-error);
}

.status-idle .status-label {
  color: var(--pix-text-muted);
}

.status-error {
  margin-top: var(--pix-space-sm);
  font-size: var(--pix-text-xs);
  color: var(--pix-error);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 80px;
  overflow-y: auto;
}
</style>
