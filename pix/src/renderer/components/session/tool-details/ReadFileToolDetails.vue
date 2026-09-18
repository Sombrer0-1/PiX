<script setup lang="ts">
/**
 * ReadFileToolDetails - file content renderer for the read tool (Stage D,
 * SDD §2.6 + follow-up). Path chip plus optional offset/limit range chip; the
 * content renders as line-numbered rows (numbering starts at args.offset when
 * present, else 1) inside a scroll-capped container with a hard render cap —
 * no expand button, long files scroll. Purely presentational.
 */
import { computed } from "vue";
import type { ToolWorkItem } from "@/types/session";
import { copyTextToClipboard, extractToolResultText, getStringValue, isRecord, splitLines } from "./result";

const props = defineProps<{
  tool: ToolWorkItem;
}>();

/** 滚动容器最大高度：长文件内部滚动，不再撑开工具卡片。 */
const MAX_HEIGHT_PX = 320;
/** 渲染上限：超过则截断并提示，防止数千行 DOM。 */
const RENDER_LINE_LIMIT = 2000;

const argsRecord = computed(() => (isRecord(props.tool.args) ? props.tool.args : null));

const path = computed(() =>
  argsRecord.value ? getStringValue(argsRecord.value, ["path", "file_path"]) ?? "" : "",
);

const offset = computed(() => {
  const value = argsRecord.value?.offset;
  return typeof value === "number" ? value : undefined;
});

const limit = computed(() => {
  const value = argsRecord.value?.limit;
  return typeof value === "number" ? value : undefined;
});

const rangeLabel = computed(() => {
  if (offset.value !== undefined && limit.value !== undefined) {
    return `行 ${offset.value}-${offset.value + limit.value - 1}`;
  }
  if (offset.value !== undefined) return `行 ${offset.value} 起`;
  if (limit.value !== undefined) return `前 ${limit.value} 行`;
  return "";
});

interface ReadRow {
  lineNo: number;
  text: string;
}

const rows = computed<ReadRow[]>(() => {
  const start = offset.value && offset.value > 0 ? offset.value : 1;
  return splitLines(extractToolResultText(props.tool.result)).map((text, index) => ({
    lineNo: start + index,
    text,
  }));
});

const truncated = computed(() => rows.value.length > RENDER_LINE_LIMIT);

const visibleRows = computed(() =>
  truncated.value ? rows.value.slice(0, RENDER_LINE_LIMIT) : rows.value,
);

const hiddenCount = computed(() => rows.value.length - visibleRows.value.length);

const containerStyle = computed(() => ({ maxHeight: `${MAX_HEIGHT_PX}px` }));

function copyPath(): void {
  if (path.value) void copyTextToClipboard(path.value);
}
</script>

<template>
  <div class="td-read">
    <div v-if="path || rangeLabel" class="td-read-meta">
      <button v-if="path" type="button" class="td-chip td-path-chip" title="点击复制路径" @click="copyPath">
        {{ path }}
      </button>
      <span v-if="rangeLabel" class="td-range-chip">{{ rangeLabel }}</span>
    </div>
    <div v-if="visibleRows.length > 0" class="td-read-content">
      <div class="td-read-scroll" :style="containerStyle">
        <div v-for="row in visibleRows" :key="row.lineNo" class="td-read-row">
          <span class="td-read-no">{{ row.lineNo }}</span>
          <span class="td-read-text">{{ row.text === "" ? "\u00a0" : row.text }}</span>
        </div>
      </div>
      <div v-if="truncated" class="td-read-truncated">内容过长，已省略后 {{ hiddenCount }} 行</div>
    </div>
  </div>
</template>

<style scoped>
.td-read {
  min-width: 0;
}

.td-read-meta {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  min-width: 0;
}

.td-chip {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  background: var(--pix-bg-code);
  border: 1px solid var(--pix-border-light);
  border-radius: 999px;
  padding: 1px 8px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.td-chip:hover {
  color: var(--pix-accent);
  border-color: rgba(98, 84, 243, 0.22);
}

.td-range-chip {
  flex-shrink: 0;
  font-family: var(--pix-font-mono);
  font-size: 11px;
  color: var(--pix-text-muted);
  border: 1px solid var(--pix-border-light);
  border-radius: 999px;
  padding: 1px 8px;
  white-space: nowrap;
}

.td-read-content {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  background: var(--pix-bg-code);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  margin-top: var(--pix-space-sm);
  overflow: hidden;
  min-width: 0;
}

.td-read-scroll {
  overflow: auto;
  overscroll-behavior: contain;
  padding: var(--pix-space-sm) var(--pix-space-md);
}

.td-read-row {
  display: flex;
  align-items: flex-start;
  min-height: 20px;
  line-height: 20px;
  color: var(--pix-text-primary);
  white-space: pre;
}

.td-read-no {
  flex: 0 0 auto;
  min-width: 30px;
  padding-right: 10px;
  text-align: right;
  color: var(--pix-text-muted);
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.td-read-text {
  flex: 1;
  min-width: 0;
}

.td-read-truncated {
  padding: 3px 10px;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  background: var(--pix-bg-hover);
  border-top: 1px solid var(--pix-border-light);
}
</style>
