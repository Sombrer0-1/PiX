<script setup lang="ts">
/**
 * ErrorBlock - Error display in session stream
 *
 * Clear but not intrusive error presentation. For API errors it shows a
 * status-code badge and a short title; when the error is retryable and the
 * agent is idle, a retry button is offered so the user can re-run the turn.
 */
import { computed } from "vue";
import type { ApiErrorCategory } from "@/types/session";

const props = defineProps<{
  message: string;
  source?: string;
  category?: ApiErrorCategory;
  httpStatus?: number;
  title?: string;
  retryable?: boolean;
  /** Whether the retry button should be active on this block right now. */
  canRetry?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();

// Non-retryable errors that require user action (red); transient/retryable
// errors use the warning palette (amber).
const severityClass = computed(() => {
  if (props.category === "auth" || props.category === "quota") return "severity-error";
  if (
    props.category === "overloaded" ||
    props.category === "server" ||
    props.category === "rate_limit" ||
    props.category === "network"
  )
    return "severity-warning";
  return "";
});

const badgeText = computed(() => {
  if (props.httpStatus) return String(props.httpStatus);
  return null;
});

const hint = computed(() => {
  switch (props.category) {
    case "auth":
      return "API key 无效或已过期，请在设置中检查认证配置。";
    case "quota":
      return "账户配额或余额不足，请前往服务商账户查看用量与套餐。";
    default:
      return null;
  }
});

const showRetry = computed(() => props.retryable === true && props.canRetry === true);
</script>

<template>
  <div class="error-block" :class="severityClass">
    <div class="error-header">
      <span class="error-icon" aria-hidden="true">!</span>
      <span v-if="badgeText" class="error-badge">{{ badgeText }}</span>
      <span class="error-label">{{ title || "错误" }}</span>
      <span v-if="source" class="error-source">{{ source }}</span>
    </div>
    <div v-if="hint" class="error-hint">{{ hint }}</div>
    <div class="error-message">{{ message }}</div>
    <div v-if="showRetry" class="error-actions">
      <button type="button" class="retry-btn" @click="emit('retry')">重试</button>
    </div>
  </div>
</template>

<style scoped>
.error-block {
  margin-bottom: var(--pix-space-xl);
  padding: var(--pix-space-md);
  background: var(--pix-error-bg);
  border: 1px solid var(--pix-error-light);
  border-radius: var(--pix-radius-lg);
  box-shadow: var(--pix-shadow-xs);
}

.error-block.severity-warning {
  background: var(--pix-warning-bg);
  border-color: var(--pix-warning-light);
}

.error-header {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  margin-bottom: var(--pix-space-sm);
}

.error-icon {
  color: var(--pix-error);
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #ffffff;
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-bold);
}

.severity-warning .error-icon {
  color: var(--pix-warning);
}

.error-badge {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-bold);
  font-family: var(--pix-font-mono);
  color: #ffffff;
  background: var(--pix-error);
  padding: 1px 6px;
  border-radius: var(--pix-radius-xs);
  letter-spacing: 0.3px;
}

.severity-warning .error-badge {
  background: var(--pix-warning);
}

.error-label {
  font-size: var(--pix-text-xs);
  font-weight: 600;
  color: var(--pix-error);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.severity-warning .error-label {
  color: var(--pix-warning);
}

.error-source {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  font-family: var(--pix-font-mono);
}

.error-hint {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-secondary);
  margin-bottom: var(--pix-space-sm);
  line-height: var(--pix-leading-base);
}

.error-message {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-primary);
  line-height: var(--pix-leading-base);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}

.error-actions {
  margin-top: var(--pix-space-md);
  display: flex;
  gap: var(--pix-space-sm);
}

.retry-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--pix-space-xs);
  padding: 6px 16px;
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-inverse);
  background: var(--pix-accent);
  border: 1px solid var(--pix-accent);
  border-radius: var(--pix-radius-md);
  cursor: pointer;
  transition: background var(--pix-transition-fast), border-color var(--pix-transition-fast);
}

.retry-btn:hover {
  background: var(--pix-accent-hover);
  border-color: var(--pix-accent-hover);
}

.retry-btn:active {
  transform: translateY(1px);
}
</style>
