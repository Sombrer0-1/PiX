<script setup lang="ts">
/**
 * DiffRows - shared scrollable diff-row renderer (tool-details, follow-up fix).
 *
 * Renders DisplayDiffRow[] (parsed from the real details.diff, or synthesized
 * from args in the replay fallback) with a file line-number column, a +/- sign
 * column and per-kind tinting. The container is height-capped with an inner
 * scrollbar instead of an expand button, so a long diff never stretches the
 * tool card. A hard render cap guards against pathological DOM sizes.
 * Purely presentational.
 */
import { computed } from "vue";
import type { DisplayDiffRow } from "./result";

const props = defineProps<{
  rows: DisplayDiffRow[];
}>();

/** 滚动容器最大高度：长 diff 内部滚动，不再撑开工具卡片。 */
const MAX_HEIGHT_PX = 320;
/** 渲染上限：超过则截断并提示，防止数千行 DOM。 */
const RENDER_LINE_LIMIT = 2000;

const truncated = computed(() => props.rows.length > RENDER_LINE_LIMIT);

const visibleRows = computed(() =>
  truncated.value ? props.rows.slice(0, RENDER_LINE_LIMIT) : props.rows,
);

const hiddenCount = computed(() => props.rows.length - visibleRows.value.length);

const containerStyle = computed(() => ({ maxHeight: `${MAX_HEIGHT_PX}px` }));
</script>

<template>
  <div class="td-diff">
    <div class="td-diff-scroll" :style="containerStyle">
      <div
        v-for="(row, index) in visibleRows"
        :key="index"
        class="td-diff-line"
        :class="row.kind"
      >
        <span class="td-diff-sign">{{ row.kind === "added" ? "+" : row.kind === "removed" ? "-" : "" }}</span>
        <span class="td-diff-no">{{ row.lineNo }}</span>
        <span class="td-diff-text">{{ row.kind === "gap" ? row.text : row.text === "" ? "\u00a0" : row.text }}</span>
      </div>
    </div>
    <div v-if="truncated" class="td-diff-truncated">内容过长，已省略后 {{ hiddenCount }} 行</div>
  </div>
</template>

<style scoped>
.td-diff {
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  overflow: hidden;
  background: var(--pix-bg-content);
}

.td-diff-scroll {
  overflow-y: auto;
  overscroll-behavior: contain;
}

.td-diff-line {
  display: flex;
  align-items: flex-start;
  min-height: 20px;
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  line-height: 20px;
  color: var(--pix-text-primary);
}

.td-diff-line.removed {
  background: rgba(220, 38, 38, 0.07);
  border-left: 2px solid #dc2626;
}

.td-diff-line.added {
  background: rgba(4, 120, 87, 0.07);
  border-left: 2px solid #047857;
}

.td-diff-line.context {
  border-left: 2px solid transparent;
}

.td-diff-line.gap {
  justify-content: center;
  color: var(--pix-text-muted);
  background: var(--pix-bg-hover);
  border-left: 2px solid transparent;
}

.td-diff-sign {
  flex: 0 0 auto;
  width: 18px;
  text-align: center;
  font-weight: var(--pix-weight-semibold);
  user-select: none;
}

.td-diff-line.removed .td-diff-sign {
  color: #dc2626;
}

.td-diff-line.added .td-diff-sign {
  color: #047857;
}

.td-diff-line.context .td-diff-sign,
.td-diff-line.gap .td-diff-sign {
  color: transparent;
}

.td-diff-no {
  flex: 0 0 auto;
  min-width: 30px;
  padding-right: 8px;
  text-align: right;
  color: var(--pix-text-muted);
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.td-diff-line.gap .td-diff-no {
  display: none;
}

.td-diff-text {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.td-diff-truncated {
  padding: 3px 10px;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  background: var(--pix-bg-hover);
  border-top: 1px solid var(--pix-border-light);
}
</style>
