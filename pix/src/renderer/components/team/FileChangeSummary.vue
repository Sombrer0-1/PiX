<script setup lang="ts">
/**
 * FileChangeSummary - Aggregated file change list from all workers.
 *
 * Extracts file_change events from workerEvents, deduplicates by file path,
 * aggregates diff stats, and shows the most recent changes first.
 */
import { computed } from "vue";
import { useTeamStore } from "../../stores/team-store";
import type { AgentSessionEvent } from "@shared/types.js";

const teamStore = useTeamStore();

interface AggregatedChange {
  filePath: string;
  addedLines: number;
  removedLines: number;
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
      // Narrow the type
      const fc = ev as {
        type: "file_change";
        toolCallId: string;
        toolName: string;
        change: { filePath: string; addedLines: number; removedLines: number };
        aggregate: unknown;
      };

      const path = fc.change.filePath;
      const existing = byPath.get(path);
      if (existing) {
        existing.addedLines += fc.change.addedLines;
        existing.removedLines += fc.change.removedLines;
        if (tagged.timestamp > existing.lastModifiedAt) {
          existing.lastModifiedAt = tagged.timestamp;
          existing.changedBy = agentName(agentId);
          existing.toolName = fc.toolName;
        }
      } else {
        byPath.set(path, {
          filePath: path,
          addedLines: fc.change.addedLines,
          removedLines: fc.change.removedLines,
          lastModifiedAt: tagged.timestamp,
          changedBy: agentName(agentId),
          toolName: fc.toolName,
        });
      }
    }
  }

  const list = Array.from(byPath.values());
  list.sort((a, b) => b.lastModifiedAt - a.lastModifiedAt);
  return list.slice(0, MAX_ITEMS);
});

function agentName(agentId: string): string {
  return teamStore.teamState?.teammates[agentId]?.name ?? agentId.split("::")[0];
}

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function dirName(path: string): string {
  const parts = path.split(/[/\\]/);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/") + "/";
}
</script>

<template>
  <div class="info-card" v-if="fileChanges.length > 0">
    <div class="card-title-row">
      <span class="card-title">File Changes</span>
      <span class="card-count">{{ fileChanges.length }}</span>
    </div>

    <div class="fc-list">
      <div
        v-for="fc in fileChanges"
        :key="fc.filePath"
        class="fc-item"
        :title="`${fc.filePath}\n${fc.toolName} by ${fc.changedBy}`"
      >
        <v-icon icon="mdi-file-document-outline" size="13" class="fc-icon" />
        <div class="fc-meta">
          <span class="fc-name">{{ fileName(fc.filePath) }}</span>
          <span class="fc-dir">{{ dirName(fc.filePath) }}</span>
          <span class="fc-by">{{ fc.changedBy }}</span>
        </div>
        <div class="fc-diff">
          <span class="fc-add">+{{ fc.addedLines }}</span>
          <span class="fc-rem">-{{ fc.removedLines }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.info-card {
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  padding: var(--pix-space-md);
  box-shadow: var(--pix-shadow-xs);
}

.card-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--pix-space-sm);
}

.card-title {
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
}

.card-count {
  font-size: 10px;
  color: var(--pix-text-muted);
  background: var(--pix-bg-hover);
  padding: 1px 6px;
  border-radius: 8px;
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
  padding: 3px 4px;
  border-radius: var(--pix-radius-sm);
  transition: background var(--pix-transition-fast);
}

.fc-item:hover {
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
</style>
