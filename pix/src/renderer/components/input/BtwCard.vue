<script setup lang="ts">
/**
 * BtwCard - Side-question (/btw) answer overlay card
 *
 * Rendered inside the composer, absolutely positioned above the input (same
 * bottom:100% pattern as CommandPalette). Read-only overlay: focus stays on
 * the main textarea; the card is tab-reachable (tabindex="0"), arrow keys
 * scroll the body, Esc closes. States follow the useBtw card state machine:
 * loading / answered / failed / usage.
 */
import { ref } from "vue";
import { useBtw } from "../../composables/useBtw";
import { renderMarkdown } from "@/utils/markdown";

const { card, close, retry, elapsedMs } = useBtw();
const emit = defineEmits<{ closed: [] }>();
const bodyRef = ref<HTMLElement | null>(null);

/** Esc/× 关闭路径：close() 置 idle 后通知宿主（CenterPanel）归还焦点给主输入框（PRD §5.3）。 */
function closeCard(): void {
  close();
  emit("closed");
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    closeCard();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const el = bodyRef.value;
    if (el) {
      e.preventDefault();
      el.scrollTop += e.key === "ArrowDown" ? 40 : -40;
    }
  }
}
</script>

<template>
  <div class="btw-card" tabindex="0" @keydown="handleKeydown">
    <div class="btw-title-row">
      <span class="btw-title-prefix">/btw</span>
      <span v-if="card.question" class="btw-title-question">{{ card.question }}</span>
      <button class="btw-close" type="button" title="关闭" aria-label="关闭侧问" @click="closeCard">×</button>
    </div>
    <div ref="bodyRef" class="btw-body">
      <div v-if="card.kind === 'loading'" class="btw-loading">
        <span class="btw-spinner" aria-hidden="true"></span>
        <span>正在回答...</span>
      </div>
      <div
        v-else-if="card.kind === 'answered'"
        class="btw-markdown"
        v-html="renderMarkdown(card.answer ?? '', false)"
      ></div>
      <div v-else-if="card.kind === 'failed'" class="btw-failed">
        <span class="btw-error">{{ card.errorMessage }}</span>
        <button class="btw-retry" type="button" @click="retry">重试</button>
      </div>
      <div v-else-if="card.kind === 'usage'" class="btw-usage">{{ card.errorMessage }}</div>
    </div>
    <div v-if="card.kind !== 'usage'" class="btw-footer">
      基于当前会话上下文 · 未使用工具 · {{ (elapsedMs / 1000).toFixed(1) }}s
    </div>
  </div>
</template>

<style scoped>
.btw-card {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: var(--pix-space-sm);
  display: flex;
  flex-direction: column;
  max-height: 40vh;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  box-shadow: var(--pix-shadow-xl);
  z-index: 100;
  color: var(--pix-text-primary);
}

.btw-title-row {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  padding: var(--pix-space-sm) var(--pix-space-md);
  border-bottom: 1px solid var(--pix-border-subtle);
  flex-shrink: 0;
}

/* 命令面板同款 accent 样式（palette-name）。 */
.btw-title-prefix {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-sm);
  font-weight: 600;
  color: var(--pix-accent);
  flex-shrink: 0;
}

.btw-title-question {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-medium);
}

.btw-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--pix-radius-sm);
  color: var(--pix-text-muted);
  font-size: 14px;
  line-height: 1;
  flex-shrink: 0;
  cursor: pointer;
}

.btw-close:hover {
  background: var(--pix-bg-hover);
  color: var(--pix-text-primary);
}

.btw-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--pix-space-md);
  font-size: var(--pix-text-sm);
  line-height: var(--pix-leading-base);
}

.btw-loading {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  color: var(--pix-text-secondary);
}

.btw-spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--pix-accent-light);
  border-top-color: var(--pix-accent);
  animation: btw-spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes btw-spin {
  to { transform: rotate(360deg); }
}

.btw-markdown :deep(p) {
  margin: 0 0 var(--pix-space-sm);
}

.btw-markdown :deep(p:last-child) {
  margin-bottom: 0;
}

.btw-failed {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--pix-space-sm);
}

.btw-error {
  color: var(--pix-error);
}

.btw-retry {
  padding: 4px 14px;
  border: 1px solid var(--pix-border-light);
  border-radius: 14px;
  background: var(--pix-bg-content);
  color: var(--pix-accent);
  font-family: var(--pix-font-ui);
  font-size: var(--pix-text-xs);
  cursor: pointer;
}

.btw-retry:hover {
  background: var(--pix-accent-light);
  border-color: var(--pix-accent-soft);
}

.btw-usage {
  color: var(--pix-text-secondary);
}

.btw-footer {
  padding: var(--pix-space-xs) var(--pix-space-md);
  border-top: 1px solid var(--pix-border-subtle);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  flex-shrink: 0;
}
</style>
