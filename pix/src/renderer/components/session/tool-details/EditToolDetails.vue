<script setup lang="ts">
/**
 * EditToolDetails - diff-row renderer for the edit tool (Stage D, SDD §2.4 + follow-up).
 *
 * Primary mode: the tool result's details.diff (the real old→new file diff the
 * core generates, same source the outer +N/-N counters use), parsed with
 * parseDisplayDiff so inner rows/stats and the header counters agree and rows
 * carry true file line numbers. Fallback (details absent, e.g. replays from
 * before the details whitelist): hunks from args.edits ([{oldText, newText}])
 * or legacy top-level fields, with per-block relative line numbers. A
 * JSON-string edits value or non-string fields degrade to JsonToolDetails.
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

/** Legacy single-edit key sets (mirror SessionView diffSummaryFromArgs). */
const LEGACY_OLD_KEYS = ["old_string", "oldString", "old_text", "oldText", "from"];
const LEGACY_NEW_KEYS = ["new_string", "newString", "new_text", "newText", "to"];

const argsRecord = computed(() => (isRecord(props.tool.args) ? props.tool.args : null));

const path = computed(() =>
  argsRecord.value ? getStringValue(argsRecord.value, ["path", "file_path"]) ?? "" : "",
);

/** 真实 diff 模式：details.diff 解析结果（至少含一行增删才算有效）。 */
const diffRows = computed<DisplayDiffRow[] | null>(() => {
  const details = extractToolResultDetails(props.tool.result);
  if (!isRecord(details) || typeof details.diff !== "string") return null;
  const rows = parseDisplayDiff(details.diff);
  const { added, removed } = countDiffRows(rows);
  return added + removed > 0 ? rows : null;
});

interface EditHunk {
  rows: DisplayDiffRow[];
}

/** 回退模式：args 推导的 hunk（相对行号，旧块/新块各自 1 起）。 */
const hunks = computed<EditHunk[] | null>(() => {
  const args = argsRecord.value;
  if (!args) return null;
  if (args.edits !== undefined) {
    // JSON-string edits or a non-array shape degrade to the JSON fallback.
    if (!Array.isArray(args.edits)) return null;
    const result: EditHunk[] = [];
    for (const edit of args.edits) {
      if (!isRecord(edit)) return null;
      const oldText = getStringValue(edit, ["oldText", "old_string"]);
      const newText = getStringValue(edit, ["newText", "new_string"]);
      // A present-but-non-string field is a contract violation: degrade.
      if (
        (edit.oldText !== undefined && typeof edit.oldText !== "string") ||
        (edit.newText !== undefined && typeof edit.newText !== "string") ||
        (edit.old_string !== undefined && typeof edit.old_string !== "string") ||
        (edit.new_string !== undefined && typeof edit.new_string !== "string")
      ) {
        return null;
      }
      if (oldText === undefined && newText === undefined) return null;
      result.push(hunkOf(oldText, newText));
    }
    if (result.length > 0) return result;
    // An empty edits array falls through to the legacy top-level fields.
  }
  const oldText = getStringValue(args, LEGACY_OLD_KEYS);
  const newText = getStringValue(args, LEGACY_NEW_KEYS);
  if (oldText === undefined && newText === undefined) return null;
  return [hunkOf(oldText, newText)];
});

function hunkOf(oldText: string | undefined, newText: string | undefined): EditHunk {
  const rows: DisplayDiffRow[] = [];
  splitLines(oldText ?? "").forEach((text, index) => {
    rows.push({ kind: "removed", lineNo: String(index + 1), text });
  });
  splitLines(newText ?? "").forEach((text, index) => {
    rows.push({ kind: "added", lineNo: String(index + 1), text });
  });
  return { rows };
}

/** SDD §2.4 divider label: `path 内第 k 处修改` (path dropped when unknown). */
function hunkDividerLabel(index: number): string {
  return path.value ? `${path.value} 内第 ${index + 1} 处修改` : `第 ${index + 1} 处修改`;
}

function copyPathToClipboard(): void {
  if (path.value) void copyTextToClipboard(path.value);
}
</script>

<template>
  <div class="td-edit">
    <button v-if="path" type="button" class="td-chip td-path-chip" title="点击复制路径" @click="copyPathToClipboard">
      {{ path }}
    </button>
    <!-- 真实 diff 模式：整文件单块渲染（含上下文行与省略段），与外层计数同源。 -->
    <DiffRows v-if="diffRows" :rows="diffRows" />
    <template v-else-if="hunks">
      <div v-for="(hunk, index) in hunks" :key="index" class="td-hunk">
        <div v-if="hunks.length > 1" class="td-hunk-divider">{{ hunkDividerLabel(index) }}</div>
        <DiffRows :rows="hunk.rows" />
      </div>
    </template>
    <JsonToolDetails v-else :tool="tool" />
  </div>
</template>

<style scoped>
.td-edit {
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

.td-hunk {
  margin-top: var(--pix-space-sm);
}

.td-hunk-divider {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  padding: 2px 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
