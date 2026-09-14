<script setup lang="ts">
/**
 * AllActivityView - Merged tool/stream activity of every seat.
 *
 * This is the "what is everyone doing right now" surface, not the discussion
 * record: the group chat lives in TeamTimeline. Events come from the store's
 * per-seat buffers (keyed by seatId) and are labelled with the seat colour and
 * display name.
 */
import { computed, ref, watch, nextTick, onMounted } from "vue";
import { useTeamStore, type TaggedSessionEvent } from "../../stores/team-store";
import { seatColor, seatLabel } from "./roundtable-display";
import type { AgentSessionEvent } from "@shared/types.js";

const teamStore = useTeamStore();

const scrollContainer = ref<HTMLElement | null>(null);
const shouldAutoScroll = ref(true);

/** All seat events, sorted by arrival. Skips streaming fragments (noise). */
const allEvents = computed<TaggedSessionEvent[]>(() => {
  const merged: TaggedSessionEvent[] = [];
  for (const events of Object.values(teamStore.seatEvents)) {
    for (const ev of events) {
      // Skip streaming message fragments — only show actionable events
      if (ev.event.type === "message_update" || ev.event.type === "message_start" || ev.event.type === "message_end") continue;
      merged.push(ev);
    }
  }
  merged.sort((a, b) => a.timestamp - b.timestamp);
  return merged;
});

watch(
  () => allEvents.value.length,
  async () => {
    if (!shouldAutoScroll.value) return;
    await nextTick();
    scrollToBottom();
  }
);

onMounted(async () => {
  if (allEvents.value.length > 0) {
    await nextTick();
    scrollToBottom();
  }
});

function scrollToBottom(): void {
  const el = scrollContainer.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function handleScroll(): void {
  const el = scrollContainer.value;
  if (!el) return;
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
  shouldAutoScroll.value = dist <= 48;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function nameOf(seatId: string): string {
  return seatLabel(seatId, teamStore.seats);
}

function colorOf(seatId: string): string {
  return seatColor(seatId, teamStore.seats);
}

function eventSummary(tagged: TaggedSessionEvent): string {
  const ev = tagged.event;
  switch (ev.type) {
    case "tool_execution_start": return `开始执行 ${ev.toolName}`;
    case "tool_execution_end": return ev.isError ? `${ev.toolName} 执行出错` : `${ev.toolName} 执行完成`;
    case "message_update":
    case "message_start":
    case "message_end":
      return "消息更新";
    case "file_change": return `${ev.toolName}: ${ev.change.path || "(未知文件)"} (+${ev.change.added}/-${ev.change.removed})`;
    case "turn_start": return "新一轮开始";
    case "turn_end": return "本轮完成";
    case "agent_start": return "席位开始工作";
    case "agent_end": return "席位结束本轮";
    case "compaction_start": return "正在压缩上下文...";
    case "compaction_end": return "上下文压缩完成";
    case "verification_gate": return "等待完成前验证";
    default: return ev.type;
  }
}

function isFileChangeEvent(ev: AgentSessionEvent): ev is {
  type: "file_change";
  toolCallId: string;
  toolName: string;
  change: { path?: string; added: number; removed: number };
  aggregate: unknown;
} {
  return ev.type === "file_change";
}

function isToolStart(ev: AgentSessionEvent): ev is { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown } {
  return ev.type === "tool_execution_start";
}

function isToolEnd(ev: AgentSessionEvent): ev is { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean } {
  return ev.type === "tool_execution_end";
}
</script>

<template>
  <div class="all-activity-view" data-test="all-activity">
    <div v-if="allEvents.length === 0" class="aav-empty">
      <v-icon icon="mdi-clock-outline" size="36" color="grey-lighten-1" />
      <p>暂无活动，正在等待席位开始探索...</p>
    </div>

    <div
      v-else
      ref="scrollContainer"
      class="aav-stream"
      @scroll="handleScroll"
    >
      <div
        v-for="(tagged, index) in allEvents"
        :key="`${tagged.seatId}-${index}`"
        class="aav-entry"
        :class="{
          'aav-entry--tool': isToolStart(tagged.event) || isToolEnd(tagged.event),
          'aav-entry--file': isFileChangeEvent(tagged.event),
          'aav-entry--error': tagged.event.type === 'tool_execution_end' && tagged.event.isError,
        }"
      >
        <!-- Seat label chip -->
        <span
          class="aav-seat-chip"
          :style="{ color: colorOf(tagged.seatId), borderColor: colorOf(tagged.seatId) }"
          :title="tagged.seatId"
        >
          {{ nameOf(tagged.seatId) }}
        </span>

        <!-- Event icon -->
        <v-icon
          v-if="isToolStart(tagged.event)"
          icon="mdi-play-circle-outline"
          size="13"
          color="blue"
          class="aav-icon"
        />
        <v-icon
          v-else-if="isToolEnd(tagged.event) && tagged.event.isError"
          icon="mdi-alert-circle"
          size="13"
          color="red"
          class="aav-icon"
        />
        <v-icon
          v-else-if="isToolEnd(tagged.event)"
          icon="mdi-check-circle-outline"
          size="13"
          color="green"
          class="aav-icon"
        />
        <v-icon
          v-else-if="isFileChangeEvent(tagged.event)"
          icon="mdi-file-edit-outline"
          size="13"
          color="amber"
          class="aav-icon"
        />
        <v-icon
          v-else
          icon="mdi-circle-small"
          size="13"
          color="grey-lighten-1"
          class="aav-icon"
        />

        <span class="aav-summary">{{ eventSummary(tagged) }}</span>
        <span class="aav-time">{{ formatTime(tagged.timestamp) }}</span>
      </div>
    </div>

    <div v-if="!shouldAutoScroll && allEvents.length > 0" class="aav-scroll-btn">
      <v-btn
        size="x-small"
        variant="flat"
        icon="mdi-chevron-down"
        color="primary"
        @click="shouldAutoScroll = true; scrollToBottom()"
      />
    </div>
  </div>
</template>

<style scoped>
.all-activity-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  position: relative;
}

.aav-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--pix-space-sm);
  color: var(--pix-text-muted);
}

.aav-empty p {
  margin: 0;
  font-size: var(--pix-text-sm);
}

.aav-stream {
  flex: 1;
  overflow-y: auto;
  padding: var(--pix-space-xs) var(--pix-space-sm);
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.aav-entry {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 4px;
  border-radius: var(--pix-radius-sm);
  font-size: 11px;
  transition: background var(--pix-transition-fast);
}

.aav-entry:hover {
  background: var(--pix-bg-hover);
}

.aav-seat-chip {
  font-size: 10px;
  font-weight: var(--pix-weight-semibold);
  padding: 0 4px;
  border: 1px solid;
  border-radius: 3px;
  line-height: 16px;
  flex-shrink: 0;
  min-width: 48px;
  text-align: center;
}

.aav-icon {
  flex-shrink: 0;
}

.aav-summary {
  color: var(--pix-text-secondary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aav-time {
  font-size: 10px;
  color: var(--pix-text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  min-width: 54px;
  text-align: right;
}

.aav-scroll-btn {
  position: absolute;
  bottom: 8px;
  right: 16px;
  z-index: 1;
}
</style>
