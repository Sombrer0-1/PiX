<script setup lang="ts">
/**
 * ThinkingBlock - collapsible chain-of-thought block (PiX 1.5, §4.1.3)
 *
 * Renders a single thinking DisplayBlock as pure text. Display state machine:
 * `override` (auto/expanded/collapsed) on top of the block's facts
 * (phase/superseded). Default state is auto: expanded until the block is
 * superseded (next move started). Manual clicks pin the state. A 10s fallback
 * timer collapses a settled block (phase="ended", not superseded, still auto)
 * whose move never started. Streaming content follows the bottom of the
 * block's own scroll container until the user scrolls up past a threshold.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { DisplayBlock } from "@/types/session";

const AUTO_COLLAPSE_DELAY_MS = 10_000;
const AUTO_SCROLL_THRESHOLD_PX = 48;
const SUMMARY_MAX_CHARS = 60;

const props = defineProps<{
  block: Extract<DisplayBlock, { type: "thinking" }>;
  effortLabel?: string;
}>();

const override = ref<"auto" | "expanded" | "collapsed">("auto");

const isPlaceholder = computed(() => props.block.content === "");

const effectiveExpanded = computed(() =>
  override.value === "expanded" ? true : override.value === "collapsed" ? false : !props.block.superseded,
);

/** 首行摘要：content 首个非空行去空白，Array.from 计字符截断到 ≤60。 */
const firstLineSummary = computed(() => {
  const line = props.block.content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  const chars = Array.from(line);
  if (chars.length <= SUMMARY_MAX_CHARS) return line;
  return chars.slice(0, SUMMARY_MAX_CHARS).join("");
});

/** 全文 N 字：Array.from 计字符。 */
const contentLength = computed(() => Array.from(props.block.content).length);

// ── 10s 兜底：phase="ended" && !superseded && override==="auto" 时启动，
// 触发时若三条件仍成立则自动折叠；任一条件变化或组件卸载即清除。
let autoCollapseTimer: ReturnType<typeof setTimeout> | null = null;

function clearAutoCollapseTimer(): void {
  if (autoCollapseTimer !== null) {
    clearTimeout(autoCollapseTimer);
    autoCollapseTimer = null;
  }
}

watch(
  () => [props.block.phase, props.block.superseded, override.value] as const,
  () => {
    clearAutoCollapseTimer();
    if (props.block.phase === "ended" && !props.block.superseded && override.value === "auto") {
      autoCollapseTimer = setTimeout(() => {
        autoCollapseTimer = null;
        if (props.block.phase === "ended" && !props.block.superseded && override.value === "auto") {
          override.value = "collapsed";
        }
      }, AUTO_COLLAPSE_DELAY_MS);
    }
  },
  { immediate: true },
);

onBeforeUnmount(clearAutoCollapseTimer);

// ── 点击标题：在 effectiveExpanded 当前值基础上取反并显式置 override（钉住）。
function toggle(): void {
  override.value = effectiveExpanded.value ? "collapsed" : "expanded";
}

// ── 流式跟随滚动：展开且 streaming 时容器滚到底；用户上滚超出阈值停止跟随。
const bodyEl = ref<HTMLElement | null>(null);
const shouldStickToBottom = ref(true);

function scrollBodyToBottom(): void {
  const el = bodyEl.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

function handleBodyScroll(): void {
  const el = bodyEl.value;
  if (!el) return;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  shouldStickToBottom.value = distance <= AUTO_SCROLL_THRESHOLD_PX;
}

watch(
  () => [props.block.content, props.block.phase, effectiveExpanded.value] as const,
  async () => {
    await nextTick();
    if (effectiveExpanded.value && props.block.phase === "streaming" && shouldStickToBottom.value) {
      scrollBodyToBottom();
    }
  },
);
</script>

<template>
  <div class="thinking-block">
    <!-- 占位态：无内容时渲染现状胶囊，不可点击 -->
    <div v-if="isPlaceholder" class="thinking-placeholder">
      <span class="thinking-spinner" aria-hidden="true"></span>
      <span>AI 正在思考...<template v-if="effortLabel"> · {{ effortLabel }}</template></span>
    </div>

    <div v-else class="thinking-panel">
      <button class="thinking-header" type="button" :aria-expanded="effectiveExpanded" @click="toggle">
        <span v-if="effectiveExpanded && block.phase === 'streaming'" class="thinking-spinner" aria-hidden="true"></span>
        <span class="thinking-title">
          <template v-if="effectiveExpanded">
            思考过程<template v-if="effortLabel"> · {{ effortLabel }}</template>
          </template>
          <template v-else>
            思考过程 · {{ firstLineSummary }} · 全文 {{ contentLength }} 字
          </template>
        </span>
      </button>

      <div v-if="effectiveExpanded" ref="bodyEl" class="thinking-body" @scroll="handleBodyScroll">
        {{ block.content }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.thinking-block {
  margin: 0 0 var(--pix-space-lg);
}

/* ── 占位胶囊（现状样式） ── */
.thinking-placeholder {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 11px;
  border: 1px solid var(--pix-border-light);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.94);
  color: var(--pix-accent);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  animation: block-in 0.16s ease-out;
}

/* ── 内容面板：淡背景 + 左侧 2px 细边框 ── */
.thinking-panel {
  border-left: 2px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  background: rgba(255, 255, 255, 0.9);
}

.thinking-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  text-align: left;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  font-family: var(--pix-font-ui);
  transition: background var(--pix-transition-fast);
}

.thinking-header:hover {
  background: var(--pix-bg-hover);
}

.thinking-title {
  font-weight: var(--pix-weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thinking-body {
  max-height: 240px;
  overflow-y: auto;
  padding: var(--pix-space-sm) var(--pix-space-md) var(--pix-space-md);
  font-size: var(--pix-text-sm);
  line-height: var(--pix-leading-relaxed);
  color: var(--pix-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── 旋转指示 ── */
.thinking-spinner {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border: 2px solid var(--pix-border-light);
  border-top-color: var(--pix-accent);
  border-radius: 50%;
  animation: pix-spin 0.7s linear infinite;
}

@keyframes pix-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes block-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
