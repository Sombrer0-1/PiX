<script setup lang="ts">
/**
 * RetryNotice - Auto-retry countdown in the session stream.
 *
 * Unsuccessful retry blocks show a category prefix, countdown, attempt
 * fraction, cancel button, and a one-line error summary. Successful
 * retries keep the existing "重试成功 (第 N 次)" markup.
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { ApiErrorCategory } from "@/types/session";
import { remainingSeconds } from "@/utils/display-blocks";

const props = defineProps<{
  success: boolean;
  attempt: number;
  maxAttempts: number;
  delayMs?: number;
  timestamp: number;
  category?: ApiErrorCategory;
  errorSummary?: string;
  retryAfterMs?: number;
}>();

const emit = defineEmits<{ cancel: [] }>();

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  if (props.success || props.delayMs === undefined) return;
  if (remainingSeconds(props.timestamp, props.delayMs, now.value) === 0) return;
  timer = setInterval(() => {
    now.value = Date.now();
    if (props.delayMs === undefined) return;
    if (remainingSeconds(props.timestamp, props.delayMs, now.value) === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }, 1000);
});

onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer);
});

const remaining = computed(() => {
  if (props.delayMs === undefined) return 0;
  return remainingSeconds(props.timestamp, props.delayMs, now.value);
});

const categoryPrefix = computed(() => {
  switch (props.category) {
    case "rate_limit":
      return "服务限流";
    case "overloaded":
      return "服务过载";
    case "network":
      return "网络错误";
    case "server":
      return "服务器错误";
    default:
      return "请求失败";
  }
});

const headline = computed(() => {
  if (props.success) return `重试成功 (第 ${props.attempt} 次)`;
  if (props.delayMs === undefined) return `重试失败，已尝试 ${props.attempt} 次`;
  const prefix = props.retryAfterMs !== undefined
    ? `${categoryPrefix.value}，按服务器要求等待`
    : categoryPrefix.value;
  if (remaining.value === 0) {
    return `正在重试 (第 ${props.attempt}/${props.maxAttempts} 次)…`;
  }
  return `${prefix} · ${remaining.value}s 后自动重试 (第 ${props.attempt}/${props.maxAttempts} 次)`;
});

const showCancel = computed(() => !props.success && props.delayMs !== undefined);
</script>

<template>
  <div class="notice-block" :class="{ 'notice-error': !success }">
    <div class="retry-main">
      <span>{{ headline }}</span>
      <button
        v-if="showCancel"
        type="button"
        class="retry-cancel"
        @click="emit('cancel')"
      >
        取消
      </button>
    </div>
    <div v-if="!success && errorSummary" class="retry-summary">{{ errorSummary }}</div>
  </div>
</template>

<style scoped>
.notice-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--pix-space-xs);
  padding: var(--pix-space-sm) 0;
  margin-bottom: var(--pix-space-lg);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  font-weight: var(--pix-weight-medium);
}

.notice-error {
  color: var(--pix-error);
}

.retry-main {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--pix-space-sm);
}

.retry-cancel {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  color: var(--pix-text-secondary);
  background: transparent;
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-sm);
  cursor: pointer;
}

.retry-cancel:hover {
  color: var(--pix-text-primary);
  border-color: var(--pix-text-secondary);
}

.retry-summary {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-regular);
  color: var(--pix-text-muted);
}
</style>
