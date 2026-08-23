<script setup lang="ts">
/**
 * TaskFileChanges - 文件变更 tab:历史(磁盘)∪ 直播(task_file_change)(PiX 1.5 P4)
 *
 * 历史 = get_task_log 过滤 type==="file_change" 的 change(main 在 get_task_log 前
 * 先 drain persist,终态后也能读到已 flush 的尾部);直播 = store.fileChanges[taskId]
 * (订阅归 TaskDetailPanel 所有——直接打开本 tab 同样收到直播)。合并去重键 =
 * change.toolCallId(历史优先);聚合键 = change.path ?? `${change.toolName}:${change.toolCallId}`
 * (path 可选);行内 +added/-removed 为渲染端逐条累计,展开渲染 change.diff/change.patch
 * (存在时)。历史获取失败(not_found / I/O)或旧任务日志无 file_change 条目 →
 * 显示「无记录」/错误占位,不抛未捕获异常。
 */
import { computed, onMounted, ref } from "vue";
import { useAgentTaskStore } from "../../stores/agent-task-store";
import type { AgentTaskInfo } from "@shared/agent-task-types.js";
import type { FileChangeSummary } from "@shared/types.js";

const props = defineProps<{
  task: AgentTaskInfo;
}>();

const store = useAgentTaskStore();

/** 历史 file_change 缓冲(挂载时经 get_task_log 拉取;失败置错误占位)。 */
const historyChanges = ref<FileChangeSummary[]>([]);
const historyError = ref(false);
const expandedKeys = ref<Set<string>>(new Set());

function isFileChangeSummary(value: unknown): value is FileChangeSummary {
  if (typeof value !== "object" || value === null) return false;
  const change = value as Record<string, unknown>;
  return (
    typeof change.toolCallId === "string" &&
    typeof change.toolName === "string" &&
    typeof change.added === "number" &&
    typeof change.removed === "number"
  );
}

async function loadHistory(): Promise<void> {
  const result = await store.getTaskLog(props.task.taskId);
  if (!result.success || !result.data) {
    historyError.value = true;
    return;
  }
  historyChanges.value = result.data.events
    .filter((event) => event.type === "file_change")
    .map((event) => event.change)
    .filter(isFileChangeSummary);
}

onMounted(() => {
  void loadHistory();
});

/** 合并:历史优先,按 toolCallId 去重,直播补齐历史缺失的 toolCallId。 */
const merged = computed<FileChangeSummary[]>(() => {
  const seen = new Set<string>();
  const result: FileChangeSummary[] = [];
  for (const change of historyChanges.value) {
    if (seen.has(change.toolCallId)) continue;
    seen.add(change.toolCallId);
    result.push(change);
  }
  for (const change of store.fileChanges[props.task.taskId] ?? []) {
    if (seen.has(change.toolCallId)) continue;
    seen.add(change.toolCallId);
    result.push(change);
  }
  return result;
});

interface FileChangeRow {
  key: string;
  path?: string;
  changes: FileChangeSummary[];
  added: number;
  removed: number;
}

/** 聚合:键 = change.path ?? `${change.toolName}:${change.toolCallId}`;行内累计 added/removed。 */
const rows = computed<FileChangeRow[]>(() => {
  const byKey = new Map<string, FileChangeRow>();
  for (const change of merged.value) {
    const key = change.path ?? `${change.toolName}:${change.toolCallId}`;
    let row = byKey.get(key);
    if (!row) {
      row = { key, path: change.path, changes: [], added: 0, removed: 0 };
      byKey.set(key, row);
    }
    row.changes.push(change);
    row.added += change.added;
    row.removed += change.removed;
  }
  return [...byKey.values()];
});

function toggleRow(key: string): void {
  const next = new Set(expandedKeys.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  expandedKeys.value = next;
}
</script>

<template>
  <div class="task-file-changes" data-test="task-file-changes">
    <div v-if="rows.length === 0" class="task-file-changes-empty">
      <div v-if="historyError" class="task-file-changes-placeholder" data-test="task-file-changes-error">
        文件变更记录读取失败,暂无可显示记录
      </div>
      <div v-else class="task-file-changes-placeholder" data-test="task-file-changes-empty">无记录</div>
    </div>
    <div
      v-for="row in rows"
      :key="row.key"
      class="task-file-change-row"
      data-test="task-file-change-row"
    >
      <button
        type="button"
        class="task-file-change-header"
        :aria-expanded="expandedKeys.has(row.key)"
        @click="toggleRow(row.key)"
      >
        <span class="task-file-change-path" :title="row.key">{{ row.path ?? row.key }}</span>
        <span class="task-file-change-diff">
          <span class="diff-added">+{{ row.added }}</span>
          <span class="diff-removed">-{{ row.removed }}</span>
        </span>
        <span class="task-file-change-toggle">{{ expandedKeys.has(row.key) ? "收起" : "展开" }}</span>
      </button>
      <div v-if="expandedKeys.has(row.key)" class="task-file-change-body">
        <template v-for="(change, index) in row.changes" :key="change.toolCallId">
          <div v-if="change.diff || change.patch" class="task-file-change-chunk" :data-test="`task-file-change-diff-${index}`">
            <div class="task-file-change-chunk-label">{{ change.toolName }} · {{ change.toolCallId }}</div>
            <pre v-if="change.diff" class="task-file-change-pre">{{ change.diff }}</pre>
            <pre v-if="change.patch" class="task-file-change-pre">{{ change.patch }}</pre>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-file-changes {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-xs);
  min-width: 0;
}

.task-file-changes-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}

.task-file-change-row {
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  overflow: hidden;
  background: var(--pix-bg-content);
}

.task-file-change-header {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  width: 100%;
  min-height: 32px;
  padding: 6px 10px;
  text-align: left;
  font-family: var(--pix-font-ui);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-primary);
  cursor: pointer;
  background: transparent;
  transition: background var(--pix-transition-fast);
}

.task-file-change-header:hover {
  background: var(--pix-bg-hover);
}

.task-file-change-path {
  flex: 1;
  min-width: 0;
  font-family: var(--pix-font-mono);
  font-weight: var(--pix-weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow-wrap: anywhere;
}

.task-file-change-diff {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  padding: 1px 7px;
  border: 1px solid var(--pix-border-light);
  border-radius: 999px;
  background: var(--pix-bg-code);
  font-family: var(--pix-font-mono);
  font-size: 11px;
  font-weight: var(--pix-weight-semibold);
  line-height: 16px;
}

.diff-added {
  color: #047857;
  font-variant-numeric: tabular-nums;
}

.diff-removed {
  color: #dc2626;
  font-variant-numeric: tabular-nums;
}

.task-file-change-toggle {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  font-weight: var(--pix-weight-medium);
}

.task-file-change-body {
  border-top: 1px solid var(--pix-border-light);
  padding: var(--pix-space-sm);
  background: rgba(255, 255, 255, 0.86);
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-xs);
}

.task-file-change-chunk-label {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  margin-bottom: var(--pix-space-xs);
}

.task-file-change-pre {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-tight);
  background: var(--pix-bg-code);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  padding: var(--pix-space-sm) var(--pix-space-md);
  overflow-x: auto;
  max-height: 260px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--pix-text-primary);
}
</style>
