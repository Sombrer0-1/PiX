<script setup lang="ts">
/**
 * ThreadFilter - 主线默认可见；按 threadId 少看；结论上浮。
 *
 * The main line is always part of the visible set (a member may see less of a
 * thread but can never miss the main line). Muting a thread hides its items on
 * this client (`少看`) while keeping the record intact; promoting a conclusion
 * is a timeline event (`thread_promo`), so it is listed here and can be
 * located in the group chat.
 */
import { computed } from "vue";
import { useTeamStore } from "../../stores/team-store";
import { formatClock, seatLabel, timelineTypeIcon } from "./roundtable-display";
import type { TimelineItem } from "@shared/team-types.js";

const props = defineProps<{
  /** Timeline records the chat shows (main line + threads). */
  items: TimelineItem[];
  /** Selected threadId; null = the whole (non-muted) line. */
  selected: string | null;
}>();

const emit = defineEmits<{
  (e: "update:selected", threadId: string | null): void;
  (e: "locate", itemId: string): void;
}>();

const teamStore = useTeamStore();

interface ThreadSummary {
  threadId: string;
  count: number;
  muted: boolean;
  lastTs: number;
}

/** Threads in first-appearance order with their record counts. */
const threads = computed<ThreadSummary[]>(() => {
  const byId = new Map<string, ThreadSummary>();
  for (const item of props.items) {
    const threadId = item.threadId;
    // 空串与 undefined 都算主线（TeamTimeline 用 v-if="item.threadId" 判主线，
    // 这里如果只跳过 undefined，空串会生成一个点不动的无名 chip）。
    if (!threadId) continue;
    const existing = byId.get(threadId);
    if (existing === undefined) {
      byId.set(threadId, { threadId, count: 1, muted: isMuted(threadId), lastTs: item.ts });
    } else {
      existing.count += 1;
      existing.lastTs = Math.max(existing.lastTs, item.ts);
    }
  }
  return [...byId.values()].sort((a, b) => a.lastTs - b.lastTs);
});

/** Promoted conclusions (主线 float-up records). */
const promoted = computed(() =>
  props.items
    .filter((item) => item.type === "thread_promo")
    .slice(-5)
    .reverse(),
);

function isMuted(threadId: string): boolean {
  return teamStore.mutedThreads.includes(threadId);
}

function toggleMute(threadId: string): void {
  void teamStore.muteThread(threadId, !isMuted(threadId));
}

function shortThread(threadId: string): string {
  return threadId.length > 10 ? `${threadId.slice(0, 10)}…` : threadId;
}

function locate(item: TimelineItem): void {
  emit("update:selected", null);
  emit("locate", item.id);
}

function fromName(item: TimelineItem): string {
  return seatLabel(item.fromId, teamStore.seats);
}
</script>

<template>
  <div class="thread-filter" data-test="thread-filter">
    <div class="tf-row">
      <span class="tf-label">可见范围</span>
      <button
        type="button"
        class="tf-chip"
        :class="{ active: selected === null }"
        data-test="thread-main"
        @click="emit('update:selected', null)"
      >
        <v-icon icon="mdi-message-text-outline" size="12" />
        主线
      </button>
      <button
        v-for="thread in threads"
        :key="thread.threadId"
        type="button"
        class="tf-chip"
        :class="{ active: selected === thread.threadId, muted: thread.muted }"
        :title="`线程 ${thread.threadId}`"
        :data-test="`thread-chip-${thread.threadId}`"
        @click="emit('update:selected', selected === thread.threadId ? null : thread.threadId)"
      >
        <v-icon icon="mdi-source-branch" size="12" />
        {{ shortThread(thread.threadId) }}
        <span class="tf-count">{{ thread.count }}</span>
      </button>
      <button
        v-for="thread in threads"
        :key="`mute-${thread.threadId}`"
        type="button"
        class="tf-mute"
        :class="{ 'tf-mute--on': thread.muted }"
        :title="thread.muted ? `恢复显示线程 ${thread.threadId}` : `少看线程 ${thread.threadId}`"
        :aria-label="thread.muted ? '恢复该线程' : '少看该线程'"
        @click="toggleMute(thread.threadId)"
      >
        <v-icon :icon="thread.muted ? 'mdi-eye-off-outline' : 'mdi-eye-outline'" size="12" />
      </button>
    </div>

    <div v-if="promoted.length > 0" class="tf-promoted" data-test="thread-promoted">
      <span class="tf-label">结论上浮</span>
      <button
        v-for="item in promoted"
        :key="item.id"
        type="button"
        class="tf-conclusion"
        :title="item.text"
        @click="locate(item)"
      >
        <v-icon :icon="timelineTypeIcon(item.type)" size="12" />
        <span class="tf-conclusion-from">{{ fromName(item) }}</span>
        <span class="tf-conclusion-text">{{ item.summary || item.text }}</span>
        <span class="tf-conclusion-time">{{ formatClock(item.ts) }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.thread-filter {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px var(--pix-space-sm);
  border-bottom: 1px solid var(--pix-border-subtle);
  background: rgba(255, 255, 255, 0.72);
  flex-shrink: 0;
}

.tf-row,
.tf-promoted {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  flex-wrap: wrap;
}

.tf-label {
  color: var(--pix-text-muted);
  font-size: 9px;
  flex-shrink: 0;
}

.tf-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 22px;
  padding: 2px 7px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
  background: #ffffff;
  color: var(--pix-text-secondary);
  font-size: 10px;
  cursor: pointer;
  transition: border-color var(--pix-transition-fast), background var(--pix-transition-fast);
}

.tf-chip:hover {
  border-color: var(--pix-border);
  background: var(--pix-bg-hover);
}

.tf-chip.active {
  border-color: var(--pix-accent);
  background: var(--pix-accent-light);
  color: var(--pix-accent);
}

.tf-chip.muted {
  opacity: 0.5;
}

.tf-count {
  color: var(--pix-text-muted);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.tf-mute {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
  background: #ffffff;
  color: var(--pix-text-muted);
  cursor: pointer;
}

.tf-mute--on {
  border-color: var(--pix-warning);
  color: var(--pix-warning);
  background: var(--pix-warning-bg);
}

.tf-conclusion {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 320px;
  min-height: 22px;
  padding: 2px 7px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
  background: #ffffff;
  color: var(--pix-text-secondary);
  font-size: 10px;
  cursor: pointer;
}

.tf-conclusion:hover {
  border-color: var(--pix-accent);
  color: var(--pix-accent);
}

.tf-conclusion-from {
  flex-shrink: 0;
  font-weight: var(--pix-weight-semibold);
}

.tf-conclusion-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tf-conclusion-time {
  flex-shrink: 0;
  color: var(--pix-text-muted);
  font-variant-numeric: tabular-nums;
}
</style>
