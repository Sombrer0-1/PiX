<script setup lang="ts">
/**
 * WorkerSessionView - optional seat tool activity (not the conversation).
 *
 * The main surface of team mode is TeamTimeline: this view only exists to look
 * inside one seat's run — streaming fragments, tool calls, file changes and the
 * folded thinking blocks. Talking to a seat happens on the timeline (composer
 * with `@席位` or a private message), so there is no per-seat composer here.
 */
import { computed, ref, watch, nextTick, onMounted } from "vue";
import { useTeamStore, type TaggedSessionEvent } from "../../stores/team-store";
import {
  authTierLabel,
  seatLabel,
  seatStatusDot,
  seatStatusLabel,
} from "./roundtable-display";
import type { AgentMessage, AgentSessionEvent } from "@shared/types.js";
import ThinkingBlock from "../session/ThinkingBlock.vue";
import { collectWorkerThinkingBlocks, type ThinkingBlockData } from "../../utils/worker-thinking";

const teamStore = useTeamStore();

const scrollContainer = ref<HTMLElement | null>(null);
const shouldAutoScroll = ref(true);
const expandedErrors = ref<Record<string, boolean>>({});

const focusedSeatId = computed(() => teamStore.focusedSeatId);
const focusedSeat = computed(() => teamStore.focusedSeat);

const rawEvents = computed<TaggedSessionEvent[]>(() => {
  const seatId = focusedSeatId.value;
  return seatId === null ? [] : teamStore.seatEvents[seatId] ?? [];
});

interface CoalescedEntry {
  events: TaggedSessionEvent[];
  finalText: string;
  firstTs: number;
  lastTs: number;
  message: AgentMessage;
}

type StreamEntry =
  | { kind: "event"; tagged: TaggedSessionEvent }
  | { kind: "coalesced"; entry: CoalescedEntry };

type TimelineEntry =
  | StreamEntry
  | { kind: "thinking"; block: ThinkingBlockData };

const streamEntries = computed<StreamEntry[]>(() => {
  const raw = rawEvents.value;
  const result: StreamEntry[] = [];
  let i = 0;

  while (i < raw.length) {
    const tagged = raw[i];
    const ev = tagged.event;

    if (ev.type !== "message_update") {
      result.push({ kind: "event", tagged });
      i++;
      continue;
    }

    const group: TaggedSessionEvent[] = [];
    let groupText = "";
    while (i < raw.length && raw[i].event.type === "message_update") {
      const current = raw[i];
      const text = extractText(current.event.message.content);
      if (text.trim()) {
        group.push(current);
        groupText = text;
      }
      i++;
    }

    if (group.length > 0 && groupText) {
      const first = group[0];
      const last = group[group.length - 1];
      result.push({
        kind: "coalesced",
        entry: {
          events: group,
          finalText: groupText,
          firstTs: first.timestamp,
          lastTs: last.timestamp,
          message: last.event.message as AgentMessage,
        },
      });
    }
  }

  return result;
});

/**
 * Thinking blocks folded from the seat's raw event stream by the shared
 * display-block assembler. One assembler instance per seat; identity-cursor
 * incremental application keeps recomputes cheap, and a slid or cleared buffer
 * (team-store 200-event cap, roundtable rebuild) triggers a full replay of the
 * current window.
 */
const thinkingBlocks = computed<ThinkingBlockData[]>(() => {
  const seatId = focusedSeatId.value;
  return seatId === null ? [] : collectWorkerThinkingBlocks(seatId, rawEvents.value);
});

/**
 * Stable merge: thinking blocks interleave into the streamEntries timeline by
 * timestamp. On equal timestamps a thinking block goes before a coalesced
 * entry, while an event entry keeps its existing position (the thinking block
 * lands after it); ties among thinking blocks keep their own order.
 */
const timelineEntries = computed<TimelineEntry[]>(() => {
  const entries = streamEntries.value;
  const thinking = thinkingBlocks.value;
  if (thinking.length === 0) return entries;
  const result: TimelineEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < entries.length || j < thinking.length) {
    const entry = entries[i];
    const block = thinking[j];
    if (block === undefined) {
      result.push(entry);
      i++;
      continue;
    }
    if (entry === undefined) {
      result.push({ kind: "thinking", block });
      j++;
      continue;
    }
    const entryTs = entry.kind === "coalesced" ? entry.entry.firstTs : entry.tagged.timestamp;
    if (block.timestamp < entryTs) {
      result.push({ kind: "thinking", block });
      j++;
    } else if (block.timestamp === entryTs && entry.kind === "coalesced") {
      // Tie against a coalesced entry: the thinking block goes first.
      result.push({ kind: "thinking", block });
      j++;
    } else {
      // Thinking block is later, or tied with an event entry (existing order kept).
      result.push(entry);
      i++;
    }
  }
  return result;
});

const workStats = computed(() => {
  let tools = 0;
  let messages = 0;
  let errors = 0;
  // 与「变更」tab 的 FileChangeSummary 同口径：按 path 去重（同一文件被改多次仍是
  // 1 个文件），没解析出 path 时用 toolCallId 兜底，避免多个未知文件塌成一个。
  const paths = new Set<string>();
  for (const tagged of rawEvents.value) {
    const ev = tagged.event;
    if (ev.type === "tool_execution_start") tools++;
    if (ev.type === "file_change") paths.add(ev.change.path ?? `(unknown #${ev.toolCallId})`);
    if (ev.type === "message_update" || ev.type === "message_start") messages++;
    if (ev.type === "tool_execution_end" && ev.isError) errors++;
  }
  return { tools, files: paths.size, messages, errors };
});

watch(
  () => timelineEntries.value.length,
  async () => {
    if (!shouldAutoScroll.value) return;
    await nextTick();
    scrollToBottom();
  },
);

onMounted(async () => {
  if (streamEntries.value.length > 0) {
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
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  shouldAutoScroll.value = distance <= 48;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block.type === "text" && block.text).map((block) => block.text!).join("");
}

function formatToolArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  const raw = typeof args === "string" ? args : JSON.stringify(args);
  return raw.length > 140 ? `${raw.slice(0, 140)}...` : raw;
}

function formatToolResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.errorMessage === "string") return obj.errorMessage;
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

function toggleErrorExpand(toolCallId: string): void {
  expandedErrors.value[toolCallId] = !expandedErrors.value[toolCallId];
}

function isToolStart(ev: AgentSessionEvent): ev is { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown } {
  return ev.type === "tool_execution_start";
}

function isToolEnd(ev: AgentSessionEvent): ev is { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean } {
  return ev.type === "tool_execution_end";
}

function isFileChange(ev: AgentSessionEvent): ev is {
  type: "file_change";
  toolCallId: string;
  toolName: string;
  change: { path?: string; added: number; removed: number };
  aggregate: unknown;
} {
  return ev.type === "file_change";
}

function isTurnStart(ev: AgentSessionEvent): ev is { type: "turn_start" } {
  return ev.type === "turn_start";
}

function isTurnEnd(ev: AgentSessionEvent): ev is { type: "turn_end"; message: unknown; toolResults: unknown[] } {
  return ev.type === "turn_end";
}
</script>

<template>
  <div class="seat-session-view" data-test="seat-session-view">
    <div v-if="!focusedSeatId" class="ssv-empty">
      <v-icon icon="mdi-account-search-outline" size="32" color="grey-lighten-1" />
      <p>选择上方席位条中的席位，查看它的工具活动。</p>
    </div>

    <template v-else>
      <div class="ssv-header">
        <div class="ssv-seat">
          <span class="ssv-dot" :style="{ backgroundColor: seatStatusDot(focusedSeat?.status ?? 'idle') }"></span>
          <strong :style="{ color: focusedSeat?.color ?? undefined }">
            {{ focusedSeat?.name ?? seatLabel(focusedSeatId, teamStore.seats) }}
          </strong>
          <span>{{ seatStatusLabel(focusedSeat?.status ?? "idle") }}</span>
          <em v-if="focusedSeat">{{ authTierLabel(focusedSeat.auth) }}</em>
        </div>
        <div class="ssv-stats">
          <span>{{ streamEntries.length }} 条事件</span>
          <span>{{ workStats.tools }} 次工具调用</span>
          <span data-test="seat-file-count">{{ workStats.files }} 个文件</span>
          <span v-if="workStats.errors" class="ssv-stat-error">{{ workStats.errors }} 个错误</span>
        </div>
      </div>

      <div v-if="timelineEntries.length === 0" class="ssv-empty ssv-empty--inside">
        <v-icon icon="mdi-clock-outline" size="30" color="grey-lighten-1" />
        <p>该席位当前空闲，暂无工具活动。</p>
      </div>

      <div
        v-else
        ref="scrollContainer"
        class="ssv-stream"
        @scroll="handleScroll"
      >
        <template
          v-for="(entry, index) in timelineEntries"
          :key="entry.kind === 'event' ? `e-${index}` : entry.kind === 'coalesced' ? `c-${entry.entry.firstTs}-${index}` : entry.block.id"
        >
          <div v-if="entry.kind === 'coalesced'" class="ssv-message-block">
            <div class="ssv-msg-header">
              <v-icon icon="mdi-comment-text-outline" size="14" color="purple" />
              <span class="ssv-msg-label">助手</span>
              <span v-if="entry.entry.events.length > 1" class="ssv-msg-count">
                {{ entry.entry.events.length }} 个片段
              </span>
            </div>
            <div class="ssv-msg-body">
              <pre class="ssv-msg-text">{{ entry.entry.finalText }}</pre>
            </div>
            <div class="ssv-msg-time">{{ formatTime(entry.entry.lastTs) }}</div>
          </div>

          <ThinkingBlock v-else-if="entry.kind === 'thinking'" :block="entry.block" />

          <template v-else>
            <div v-if="isTurnStart(entry.tagged.event)" class="ssv-turn-sep">
              <span class="ssv-turn-line"></span>
              <span class="ssv-turn-label">新一轮</span>
              <span class="ssv-turn-line"></span>
            </div>

            <div v-else-if="isToolStart(entry.tagged.event)" class="ssv-entry ssv-entry--tool-start">
              <v-icon icon="mdi-cog" size="14" class="ssv-entry-icon" color="blue" />
              <span class="ssv-entry-tool">{{ entry.tagged.event.toolName }}</span>
              <span v-if="formatToolArgs(entry.tagged.event.args)" class="ssv-entry-args">
                {{ formatToolArgs(entry.tagged.event.args) }}
              </span>
              <span class="ssv-entry-time">{{ formatTime(entry.tagged.timestamp) }}</span>
            </div>

            <template v-else-if="isToolEnd(entry.tagged.event)">
              <div class="ssv-entry ssv-entry--tool-end">
                <v-icon
                  :icon="entry.tagged.event.isError ? 'mdi-alert-circle' : 'mdi-check-circle'"
                  size="14"
                  class="ssv-entry-icon"
                  :color="entry.tagged.event.isError ? 'red' : 'green'"
                />
                <span class="ssv-entry-tool">{{ entry.tagged.event.toolName }}</span>
                <span
                  v-if="entry.tagged.event.isError"
                  class="ssv-entry-error"
                  :class="{ 'ssv-entry-error--toggle': formatToolResult(entry.tagged.event.result) }"
                  :title="formatToolResult(entry.tagged.event.result) || undefined"
                  @click="formatToolResult(entry.tagged.event.result) && toggleErrorExpand(entry.tagged.event.toolCallId)"
                >
                  错误
                  <v-icon
                    v-if="formatToolResult(entry.tagged.event.result)"
                    :icon="expandedErrors[entry.tagged.event.toolCallId] ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                    size="11"
                    class="ssv-entry-error-chev"
                  />
                </span>
                <span class="ssv-entry-time">{{ formatTime(entry.tagged.timestamp) }}</span>
              </div>
              <div
                v-if="entry.tagged.event.isError && expandedErrors[entry.tagged.event.toolCallId] && formatToolResult(entry.tagged.event.result)"
                class="ssv-entry-error-detail"
              >
                <pre class="ssv-error-text">{{ formatToolResult(entry.tagged.event.result) }}</pre>
              </div>
            </template>

            <div v-else-if="isFileChange(entry.tagged.event)" class="ssv-entry ssv-entry--file-change">
              <v-icon icon="mdi-file-edit-outline" size="14" class="ssv-entry-icon" color="amber" />
              <span class="ssv-entry-path">{{ entry.tagged.event.change.path || '(未知文件)' }}</span>
              <span class="ssv-entry-diff">
                <span class="ssv-diff-add">+{{ entry.tagged.event.change.added }}</span>
                <span class="ssv-diff-rem">-{{ entry.tagged.event.change.removed }}</span>
              </span>
              <span class="ssv-entry-time">{{ formatTime(entry.tagged.timestamp) }}</span>
            </div>

            <div v-else-if="isTurnEnd(entry.tagged.event)" class="ssv-turn-sep ssv-turn-sep--end">
              <span class="ssv-turn-line"></span>
              <span class="ssv-turn-label">本轮完成</span>
              <span class="ssv-turn-line"></span>
            </div>
          </template>
        </template>
      </div>
    </template>

    <div v-if="!shouldAutoScroll && streamEntries.length > 0" class="ssv-scroll-btn">
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
.seat-session-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  position: relative;
}

.ssv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--pix-space-sm);
  padding: var(--pix-space-sm);
  border-bottom: 1px solid var(--pix-border-subtle);
  background: rgba(255, 255, 255, 0.72);
  flex-shrink: 0;
}

.ssv-seat {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.ssv-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  align-self: center;
}

.ssv-seat strong {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-sm);
}

.ssv-seat span,
.ssv-seat em {
  color: var(--pix-text-muted);
  font-size: 10px;
  font-style: normal;
}

.ssv-stats {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  flex-wrap: wrap;
  color: var(--pix-text-muted);
  font-size: 10px;
}

.ssv-stats span {
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--pix-bg-code);
  line-height: 18px;
}

.ssv-stats .ssv-stat-error {
  color: var(--pix-error);
  background: var(--pix-error-bg);
}

.ssv-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--pix-space-sm);
  color: var(--pix-text-muted);
  text-align: center;
  padding: var(--pix-space-md);
}

.ssv-empty--inside {
  min-height: 180px;
}

.ssv-empty p {
  margin: 0;
  font-size: var(--pix-text-sm);
}

.ssv-stream {
  flex: 1;
  overflow-y: auto;
  padding: var(--pix-space-sm);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ssv-turn-sep {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  padding: var(--pix-space-sm) 0;
}

.ssv-turn-line {
  flex: 1;
  height: 1px;
  background: var(--pix-border-subtle);
}

.ssv-turn-label {
  font-size: 10px;
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-muted);
  flex-shrink: 0;
}

.ssv-turn-sep--end .ssv-turn-label {
  color: var(--pix-success);
}

.ssv-entry {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 7px;
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-xs);
  transition: background var(--pix-transition-fast);
}

.ssv-entry:hover {
  background: var(--pix-bg-hover);
}

.ssv-entry--tool-start {
  border-left: 2px solid #3b82f6;
}

.ssv-entry--tool-end {
  border-left: 2px solid #16a34a;
}

.ssv-entry--file-change {
  border-left: 2px solid #f59e0b;
}

.ssv-entry-icon {
  flex-shrink: 0;
}

.ssv-entry-tool {
  flex: 0 0 auto;
  max-width: 120px;
  overflow: hidden;
  color: var(--pix-text-primary);
  font-weight: var(--pix-weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssv-entry-args {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--pix-text-muted);
  font-family: var(--pix-font-mono);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssv-entry-error {
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-error);
  font-size: 10px;
  flex-shrink: 0;
}

.ssv-entry-error--toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  cursor: pointer;
}

.ssv-entry-error-chev {
  flex-shrink: 0;
}

.ssv-entry-error-detail {
  margin: 0 7px 2px 16px;
  padding: 4px 6px;
  border-left: 2px solid var(--pix-error);
  background: var(--pix-error-bg);
  border-radius: var(--pix-radius-sm);
  max-height: 160px;
  overflow-y: auto;
}

.ssv-error-text {
  margin: 0;
  font-family: var(--pix-font-mono);
  font-size: 10px;
  line-height: 1.4;
  color: var(--pix-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.ssv-entry-path {
  color: var(--pix-text-primary);
  font-family: var(--pix-font-mono);
  font-size: 11px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssv-entry-diff {
  display: inline-flex;
  gap: 4px;
  font-family: var(--pix-font-mono);
  font-size: 10px;
  flex-shrink: 0;
}

.ssv-diff-add {
  color: var(--pix-success);
}

.ssv-diff-rem {
  color: var(--pix-error);
}

.ssv-entry-time {
  font-size: 10px;
  color: var(--pix-text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  min-width: 56px;
  text-align: right;
}

.ssv-message-block {
  background: var(--pix-bg-card);
  border: 1px solid var(--pix-border-subtle);
  border-left: 3px solid #8b5cf6;
  border-radius: var(--pix-radius-md);
  padding: var(--pix-space-sm);
  margin: 2px 0;
}

.ssv-msg-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.ssv-msg-label {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
}

.ssv-msg-count {
  font-size: 10px;
  color: var(--pix-text-muted);
  background: var(--pix-bg-hover);
  padding: 0 5px;
  border-radius: 6px;
}

.ssv-msg-body {
  max-height: 300px;
  overflow-y: auto;
}

.ssv-msg-text {
  margin: 0;
  font-family: var(--pix-font-ui);
  font-size: var(--pix-text-xs);
  line-height: 1.5;
  color: var(--pix-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

.ssv-msg-time {
  font-size: 10px;
  color: var(--pix-text-muted);
  text-align: right;
  margin-top: 4px;
}

.ssv-scroll-btn {
  position: absolute;
  bottom: 16px;
  right: 16px;
  z-index: 1;
}
</style>
