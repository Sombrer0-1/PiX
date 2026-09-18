<script setup lang="ts">
/**
 * WriteToolDetails - diff renderer for the write tool (Stage D, SDD §2.4 + follow-up).
 *
 * Primary mode: details.diff — the real old→new diff the core builds for the
 * overwrite (a brand-new file is all-added in that diff too). Rendering and
 * the +N/-M stat both derive from the parsed rows, so they match the outer
 * header counters (same details.diff the file_change event counts) instead of
 * the raw args.content length. Fallback (details absent, e.g. old-session
 * replay): all-added rows from args content with relative line numbers.
 * Rows render through DiffRows (scroll-capped). Purely presentational.
 */
import { computed } from "vue";
import type { ToolWorkItem } from "@/types/session";
import DiffRows from "./DiffRows.vue";
import JsonToolDetails from "./JsonToolDetails.vue";
import {
  copyTextToClipboard,
  countDiffRows,
  extractToolResultDetails,
  getStringValue,
  isRecord,
  parseDisplayDiff,
  splitLines,
  type DisplayDiffRow,
} from "./result";

const props = defineProps<{
  tool: ToolWorkItem;
}>();

const argsRecord = computed(() => (isRecord(props.tool.args) ? props.tool.args : null));

const path = computed(() =>
  argsRecord.value ? getStringValue(argsRecord.value, ["path", "file_path"]) ?? "" : "",
);

const content = computed(() =>
  argsRecord.value ? getStringValue(argsRecord.value, ["content", "contents", "text", "data"]) : undefined,
);

/** 真实 diff 模式：details.diff 解析结果（至少含一行增删才算有效）。 */
const diffRows = computed<DisplayDiffRow[] | null>(() => {
  const details = extractToolResultDetails(props.tool.result);
  if (!isRecord(details) || typeof details.diff !== "string") return null;
  const rows = parseDisplayDiff(details.diff);
  const { added, removed } = countDiffRows(rows);
  return added + removed > 0 ? rows : null;
});

/** 回退模式：args 内容全部按新增行渲染（相对 1 起行号）。 */
const fallbackRows = computed<DisplayDiffRow[] | null>(() => {
  if (content.value === undefined) return null;
  return splitLines(content.value).map((text, index) => ({
    kind: "added" as const,
    lineNo: String(index + 1),
    text,
  }));
});

/** 内层统计与外层同源：优先真实 diff 计数，回退时才数 args 内容行。 */
const stat = computed(() => {
  if (diffRows.value) return countDiffRows(diffRows.value);
  if (fallbackRows.value) return { added: fallbackRows.value.length, removed: 0 };
  return null;
});

const hasContent = computed(() => diffRows.value !== null || fallbackRows.value !== null);

function copyPathToClipboard(): void {
  if (path.value) void copyTextToClipboard(path.value);
}
</script>

<template>
  <div class="td-write">
    <div v-if="path || hasContent" class="td-write-meta">
      <button v-if="path" type="button" class="td-chip td-path-chip" title="点击复制路径" @click="copyPathToClipboard">
        {{ path }}
      </button>
      <span v-if="stat" class="td-write-stat">
        <span class="stat-added">+{{ stat.added }}</span>
        <span v-if="stat.removed > 0" class="stat-removed">-{{ stat.removed }}</span>
        <span class="stat-unit">行</span>
      </span>
    </div>
    <DiffRows v-if="diffRows" :rows="diffRows" />
    <DiffRows v-else-if="fallbackRows" :rows="fallbackRows" />
    <JsonToolDetails v-if="!hasContent" :tool="tool" />
  </div>
</template>

<style scoped>
.td-write {
  min-width: 0;
}

.td-write-meta {
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

.td-write-stat {
  flex-shrink: 0;
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-family: var(--pix-font-mono);
  font-size: 11px;
  font-weight: var(--pix-weight-semibold);
  font-variant-numeric: tabular-nums;
}

.stat-added {
  color: #047857;
}

.stat-removed {
  color: #dc2626;
}

.stat-unit {
  color: var(--pix-text-secondary);
  font-weight: var(--pix-weight-medium);
}
</style>
