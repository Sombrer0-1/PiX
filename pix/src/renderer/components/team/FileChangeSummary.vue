<script setup lang="ts">
/**
 * FileChangeSummary - Aggregated file change list from all workers.
 *
 * Extracts file_change events from workerEvents, deduplicates by file path,
 * aggregates diff stats, and shows the most recent changes first.
 */
import { computed, ref } from "vue";
import { useTeamStore } from "../../stores/team-store";
import type { AgentSessionEvent } from "@shared/types.js";

const teamStore = useTeamStore();

interface AggregatedChange {
  path: string;
  added: number;
  removed: number;
  lastModifiedAt: number;
  changedBy: string;
  toolName: string;
}

const MAX_ITEMS = 15;

const fileChanges = computed<AggregatedChange[]>(() => {
  const byPath = new Map<string, AggregatedChange>();

  for (const [agentId, events] of Object.entries(teamStore.workerEvents)) {
    for (const tagged of events) {
      const ev = tagged.event;
      if (ev.type !== "file_change") continue;

      const change = ev.change;
      // path is optional on FileChangeSummary; fall back to toolCallId so
      // changes without a resolved path don't collapse into one entry.
      const path = change.path ?? `(unknown #${ev.toolCallId})`;
      const existing = byPath.get(path);
      if (existing) {
        existing.added += change.added;
        existing.removed += change.removed;
        if (tagged.timestamp > existing.lastModifiedAt) {
          existing.lastModifiedAt = tagged.timestamp;
          existing.changedBy = agentName(agentId);
          existing.toolName = ev.toolName;
        }
      } else {
        byPath.set(path, {
          path,
          added: change.added,
          removed: change.removed,
          lastModifiedAt: tagged.timestamp,
          changedBy: agentName(agentId),
          toolName: ev.toolName,
        });
      }
    }
  }

  const list = Array.from(byPath.values());
  list.sort((a, b) => b.lastModifiedAt - a.lastModifiedAt);
  return list;
});

// Only the most recent MAX_ITEMS rows are rendered by default, but totals and
// the file count are computed over the full aggregated set so they stay
// accurate when more than MAX_ITEMS files changed. "显示全部" lifts the cap.
const showAll = ref(false);
const visibleFileChanges = computed(() =>
  showAll.value ? fileChanges.value : fileChanges.value.slice(0, MAX_ITEMS),
);
const hiddenCount = computed(() =>
  Math.max(0, fileChanges.value.length - MAX_ITEMS),
);

const totals = computed(() => fileChanges.value.reduce(
  (sum, change) => ({
    added: sum.added + change.added,
    removed: sum.removed + change.removed,
  }),
  { added: 0, removed: 0 },
));

function agentName(agentId: string): string {
  return teamStore.teamState?.teammates[agentId]?.name ?? agentId.split("::")[0];
}

function fileName(path: string | undefined): string {
  if (!path) return "(未知文件)";
  return path.split(/[/\\]/).pop() || path;
}

function dirName(path: string | undefined): string {
  if (!path) return "";
  const parts = path.split(/[/\\]/);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/") + "/";
}
</script>

<template>
  <div class="file-change-summary">
    <div class="card-title-row">
      <span class="card-title-copy">
        <strong>文件变更</strong>
        <span>已变更 {{ fileChanges.length }} 个文件</span>
      </span>
      <span v-if="fileChanges.length > 0" class="change-totals">
        <span class="fc-add">+{{ totals.added }}</span>
        <span class="fc-rem">-{{ totals.removed }}</span>
      </span>
    </div>

    <div v-if="fileChanges.length === 0" class="fc-empty">
      <v-icon icon="mdi-file-check-outline" size="24" />
      <strong>暂无文件变更</strong>
    </div>

    <div v-else class="fc-list">
      <div
        v-for="fc in visibleFileChanges"
        :key="fc.path"
        class="fc-item"
        :title="`${fc.path}\n${fc.changedBy} 通过 ${fc.toolName} 修改`"
      >
        <v-icon icon="mdi-file-document-outline" size="13" class="fc-icon" />
        <div class="fc-meta">
          <span class="fc-name">{{ fileName(fc.path) }}</span>
          <span class="fc-dir">{{ dirName(fc.path) }}</span>
          <span class="fc-by">{{ fc.changedBy }}</span>
        </div>
        <div class="fc-diff">
          <span class="fc-add">+{{ fc.added }}</span>
          <span class="fc-rem">-{{ fc.removed }}</span>
        </div>
      </div>

      <div v-if="hiddenCount > 0" class="fc-footer">
        <button
          v-if="!showAll"
          type="button"
          class="fc-toggle"
          @click="showAll = true"
        >
          还有 {{ hiddenCount }} 个未显示 · 显示全部
        </button>
        <button
          v-else
          type="button"
          class="fc-toggle"
          @click="showAll = false"
        >
          收起
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.file-change-summary {
  min-height: 100%;
}

.card-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--pix-space-sm);
}

.card-title-copy {
  display: flex;
  flex-direction: column;
}

.card-title-copy strong {
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
}

.card-title-copy span {
  font-size: 10px;
  color: var(--pix-text-muted);
}

.change-totals {
  display: inline-flex;
  gap: var(--pix-space-xs);
  font-family: var(--pix-font-mono);
  font-size: 10px;
}

.fc-empty {
  display: flex;
  min-height: 180px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--pix-space-xs);
  color: var(--pix-text-muted);
}

.fc-empty strong {
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-sm);
}

.fc-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.fc-item {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  min-height: 46px;
  padding: 6px 7px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
  background: #ffffff;
  transition: background var(--pix-transition-fast);
}

.fc-item:hover {
  border-color: var(--pix-border);
  background: var(--pix-bg-hover);
}

.fc-icon {
  color: var(--pix-text-muted);
  flex-shrink: 0;
}

.fc-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.fc-name {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  color: var(--pix-text-primary);
  font-family: var(--pix-font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fc-dir {
  font-size: 9px;
  color: var(--pix-text-muted);
  font-family: var(--pix-font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fc-by {
  font-size: 9px;
  color: var(--pix-accent);
  text-transform: capitalize;
}

.fc-diff {
  display: flex;
  gap: 3px;
  font-family: var(--pix-font-mono);
  font-size: 10px;
  flex-shrink: 0;
}

.fc-add {
  color: var(--pix-success);
}

.fc-rem {
  color: var(--pix-error);
}

.fc-footer {
  display: flex;
  justify-content: center;
  padding: var(--pix-space-xs) 0;
}

.fc-toggle {
  border: none;
  background: transparent;
  color: var(--pix-accent);
  font-size: 10px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--pix-radius-sm);
  transition: background var(--pix-transition-fast);
}

.fc-toggle:hover {
  background: var(--pix-bg-hover);
}
</style>
