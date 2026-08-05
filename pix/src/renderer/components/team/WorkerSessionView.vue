<script setup lang="ts">
/**
 * WorkerSessionView - focused work log for one worker.
 *
 * The view coalesces streaming assistant fragments, keeps tool/file events
 * visible, and shows small counters so the user can see what the worker is
 * actually doing during a long-running team task.
 */
import { computed, ref, watch, nextTick, onMounted } from "vue";
import { useTeamStore, type TaggedSessionEvent } from "../../stores/team-store";
import type { AgentMessage, AgentSessionEvent } from "@shared/types.js";

const teamStore = useTeamStore();

const scrollContainer = ref<HTMLElement | null>(null);
const shouldAutoScroll = ref(true);
const expandedErrors = ref<Record<string, boolean>>({});

const focusedId = computed(() => teamStore.focusedAgentId);
const focusedAgent = computed(() => {
  const id = focusedId.value;
  return id ? teamStore.teamState?.teammates[id] ?? null : null;
});

// Direct user-to-worker messaging (delivered via the team bus as a
// leader-priority message; the worker picks it up on its next idle cycle).
const directMessage = ref("");
const isSendingDirect = ref(false);
const canSendDirect = computed(() => {
  const status = focusedAgent.value?.status;
  return Boolean(focusedId.value) && status !== "shutdown" && status !== "error";
});

async function sendDirectMessage(): Promise<void> {
  const text = directMessage.value.trim();
  const id = focusedId.value;
  if (!text || !id || isSendingDirect.value) return;
  isSendingDirect.value = true;
  try {
    const ok = await teamStore.sendMessageToWorker(id, text);
    if (ok) directMessage.value = "";
  } finally {
    isSendingDirect.value = false;
  }
}
const rawEvents = computed<TaggedSessionEvent[]>(() => {
  const id = focusedId.value;
  return id ? teamStore.workerEvents[id] ?? [] : [];
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

const workStats = computed(() => {
  let tools = 0;
  let files = 0;
  let messages = 0;
  let errors = 0;
  for (const tagged of rawEvents.value) {
    const ev = tagged.event;
    if (ev.type === "tool_execution_start") tools++;
    if (ev.type === "file_change") files++;
    if (ev.type === "message_update" || ev.type === "message_start") messages++;
    if (ev.type === "tool_execution_end" && ev.isError) errors++;
  }
  return { tools, files, messages, errors };
});

watch(
  () => streamEntries.value.length,
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

function statusLabel(status?: string): string {
  switch (status) {
    case "running": return "工作中";
    case "idle": return "就绪";
    case "standby": return "就绪";
    case "dormant": return "已暂停";
    case "error": return "有问题";
    case "shutdown": return "已停止";
    default: return status ?? "";
  }
}

function roleLabel(role?: string): string {
  switch (role) {
    case "planner": return "规划";
    case "coder": return "开发";
    case "reviewer": return "审查";
    case "tester": return "测试";
    case "researcher": return "调研";
    default: return role ?? "成员";
  }
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
  <div class="worker-session-view">
    <div v-if="!focusedId" class="wsv-empty">
      <v-icon icon="mdi-account-group-outline" size="36" color="grey-lighten-1" />
      <p>未选择团队成员。</p>
    </div>

    <template v-else>
      <div class="wsv-header">
        <div class="wsv-worker">
          <strong>{{ focusedAgent?.name ?? focusedId.split('::')[0] }}</strong>
          <span>{{ roleLabel(focusedAgent?.role) }}</span>
          <em>{{ statusLabel(focusedAgent?.status) }}</em>
        </div>
        <div class="wsv-stats">
          <span>{{ streamEntries.length }} 条事件</span>
          <span>{{ workStats.tools }} 次工具调用</span>
          <span>{{ workStats.files }} 个文件</span>
          <span v-if="workStats.errors" class="wsv-stat-error">{{ workStats.errors }} 个错误</span>
        </div>
      </div>

      <div v-if="streamEntries.length === 0" class="wsv-empty wsv-empty--inside">
        <v-icon icon="mdi-clock-outline" size="32" color="grey-lighten-1" />
        <p>该成员当前空闲，暂无事件。</p>
      </div>

      <div
        v-else
        ref="scrollContainer"
        class="wsv-stream"
        @scroll="handleScroll"
      >
        <template v-for="entry in streamEntries" :key="entry.kind === 'event' ? entry.tagged.timestamp : entry.entry.firstTs">
          <div
            v-if="entry.kind === 'coalesced'"
            class="wsv-message-block"
          >
            <div class="wsv-msg-header">
              <v-icon icon="mdi-comment-text-outline" size="14" color="purple" />
              <span class="wsv-msg-label">助手</span>
              <span class="wsv-msg-count" v-if="entry.entry.events.length > 1">
                {{ entry.entry.events.length }} 个片段
              </span>
            </div>
            <div class="wsv-msg-body">
              <pre class="wsv-msg-text">{{ entry.entry.finalText }}</pre>
            </div>
            <div class="wsv-msg-time">{{ formatTime(entry.entry.lastTs) }}</div>
          </div>

          <template v-else>
            <div v-if="isTurnStart(entry.tagged.event)" class="wsv-turn-sep">
              <span class="wsv-turn-line"></span>
              <span class="wsv-turn-label">新一轮</span>
              <span class="wsv-turn-line"></span>
            </div>

            <div v-else-if="isToolStart(entry.tagged.event)" class="wsv-entry wsv-entry--tool-start">
              <v-icon icon="mdi-cog" size="14" class="wsv-entry-icon" color="blue" />
              <span class="wsv-entry-tool">{{ entry.tagged.event.toolName }}</span>
              <span v-if="formatToolArgs(entry.tagged.event.args)" class="wsv-entry-args">
                {{ formatToolArgs(entry.tagged.event.args) }}
              </span>
              <span class="wsv-entry-time">{{ formatTime(entry.tagged.timestamp) }}</span>
            </div>

            <template v-else-if="isToolEnd(entry.tagged.event)">
              <div class="wsv-entry wsv-entry--tool-end">
                <v-icon
                  :icon="entry.tagged.event.isError ? 'mdi-alert-circle' : 'mdi-check-circle'"
                  size="14"
                  class="wsv-entry-icon"
                  :color="entry.tagged.event.isError ? 'red' : 'green'"
                />
                <span class="wsv-entry-tool">{{ entry.tagged.event.toolName }}</span>
                <span
                  v-if="entry.tagged.event.isError"
                  class="wsv-entry-error"
                  :class="{ 'wsv-entry-error--toggle': formatToolResult(entry.tagged.event.result) }"
                  :title="formatToolResult(entry.tagged.event.result) || undefined"
                  @click="formatToolResult(entry.tagged.event.result) && toggleErrorExpand(entry.tagged.event.toolCallId)"
                >
                  错误
                  <v-icon
                    v-if="formatToolResult(entry.tagged.event.result)"
                    :icon="expandedErrors[entry.tagged.event.toolCallId] ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                    size="11"
                    class="wsv-entry-error-chev"
                  />
                </span>
                <span class="wsv-entry-time">{{ formatTime(entry.tagged.timestamp) }}</span>
              </div>
              <div
                v-if="entry.tagged.event.isError && expandedErrors[entry.tagged.event.toolCallId] && formatToolResult(entry.tagged.event.result)"
                class="wsv-entry-error-detail"
              >
                <pre class="wsv-error-text">{{ formatToolResult(entry.tagged.event.result) }}</pre>
              </div>
            </template>

            <div v-else-if="isFileChange(entry.tagged.event)" class="wsv-entry wsv-entry--file-change">
              <v-icon icon="mdi-file-edit-outline" size="14" class="wsv-entry-icon" color="amber" />
              <span class="wsv-entry-path">{{ entry.tagged.event.change.path || '(未知文件)' }}</span>
              <span class="wsv-entry-diff">
                <span class="wsv-diff-add">+{{ entry.tagged.event.change.added }}</span>
                <span class="wsv-diff-rem">-{{ entry.tagged.event.change.removed }}</span>
              </span>
              <span class="wsv-entry-time">{{ formatTime(entry.tagged.timestamp) }}</span>
            </div>

            <div v-else-if="isTurnEnd(entry.tagged.event)" class="wsv-turn-sep wsv-turn-sep--end">
              <span class="wsv-turn-line"></span>
              <span class="wsv-turn-label">本轮完成</span>
              <span class="wsv-turn-line"></span>
            </div>
          </template>
        </template>
      </div>

      <div v-if="canSendDirect" class="wsv-composer">
        <input
          v-model="directMessage"
          class="wsv-composer-input"
          type="text"
          :placeholder="`直接向 ${focusedAgent?.name ?? '该成员'} 发送消息...`"
          :disabled="isSendingDirect"
          @keydown.enter.prevent="sendDirectMessage"
        />
        <button
          class="wsv-composer-send"
          type="button"
          :disabled="!directMessage.trim() || isSendingDirect"
          title="向该成员发送直接消息"
          aria-label="向该成员发送直接消息"
          @click="sendDirectMessage"
        >
          <v-icon icon="mdi-send" size="14" />
        </button>
      </div>
    </template>

    <div v-if="!shouldAutoScroll && streamEntries.length > 0" class="wsv-scroll-btn">
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
.worker-session-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  position: relative;
}

.wsv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--pix-space-sm);
  padding: var(--pix-space-sm);
  border-bottom: 1px solid var(--pix-border-subtle);
  background: rgba(255, 255, 255, 0.72);
  flex-shrink: 0;
}

.wsv-worker {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.wsv-worker strong {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-sm);
  text-transform: capitalize;
}

.wsv-worker span,
.wsv-worker em {
  color: var(--pix-text-muted);
  font-size: 10px;
  font-style: normal;
  text-transform: capitalize;
}

.wsv-stats {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  flex-wrap: wrap;
  color: var(--pix-text-muted);
  font-size: 10px;
}

.wsv-stats span {
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--pix-bg-code);
  line-height: 18px;
}

.wsv-stats .wsv-stat-error {
  color: var(--pix-error);
  background: var(--pix-error-bg);
}

.wsv-empty {
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

.wsv-empty--inside {
  min-height: 220px;
}

.wsv-empty p {
  margin: 0;
  font-size: var(--pix-text-sm);
}

.wsv-stream {
  flex: 1;
  overflow-y: auto;
  padding: var(--pix-space-sm);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.wsv-turn-sep {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  padding: var(--pix-space-sm) 0;
}

.wsv-turn-line {
  flex: 1;
  height: 1px;
  background: var(--pix-border-subtle);
}

.wsv-turn-label {
  font-size: 10px;
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-muted);
  text-transform: uppercase;
  letter-spacing: 0;
  flex-shrink: 0;
}

.wsv-turn-sep--end .wsv-turn-label {
  color: var(--pix-success);
}

.wsv-entry {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 7px;
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-xs);
  transition: background var(--pix-transition-fast);
}

.wsv-entry:hover {
  background: var(--pix-bg-hover);
}

.wsv-entry--tool-start {
  border-left: 2px solid #3b82f6;
}

.wsv-entry--tool-end {
  border-left: 2px solid #16a34a;
}

.wsv-entry--file-change {
  border-left: 2px solid #f59e0b;
}

.wsv-entry-icon {
  flex-shrink: 0;
}

.wsv-entry-tool {
  flex: 0 0 auto;
  max-width: 120px;
  overflow: hidden;
  color: var(--pix-text-primary);
  font-weight: var(--pix-weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wsv-entry-args {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--pix-text-muted);
  font-family: var(--pix-font-mono);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wsv-entry-error {
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-error);
  font-size: 10px;
  flex-shrink: 0;
}

.wsv-entry-error--toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  cursor: pointer;
}

.wsv-entry-error-chev {
  flex-shrink: 0;
}

.wsv-entry-error-detail {
  margin: 0 7px 2px 16px;
  padding: 4px 6px;
  border-left: 2px solid var(--pix-error);
  background: var(--pix-error-bg);
  border-radius: var(--pix-radius-sm);
  max-height: 160px;
  overflow-y: auto;
}

.wsv-error-text {
  margin: 0;
  font-family: var(--pix-font-mono);
  font-size: 10px;
  line-height: 1.4;
  color: var(--pix-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.wsv-entry-path {
  color: var(--pix-text-primary);
  font-family: var(--pix-font-mono);
  font-size: 11px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wsv-entry-diff {
  display: inline-flex;
  gap: 4px;
  font-family: var(--pix-font-mono);
  font-size: 10px;
  flex-shrink: 0;
}

.wsv-diff-add {
  color: var(--pix-success);
}

.wsv-diff-rem {
  color: var(--pix-error);
}

.wsv-entry-time {
  font-size: 10px;
  color: var(--pix-text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  min-width: 56px;
  text-align: right;
}

.wsv-message-block {
  background: var(--pix-bg-card);
  border: 1px solid var(--pix-border-subtle);
  border-left: 3px solid #8b5cf6;
  border-radius: var(--pix-radius-md);
  padding: var(--pix-space-sm);
  margin: 2px 0;
}

.wsv-msg-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.wsv-msg-label {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
}

.wsv-msg-count {
  font-size: 10px;
  color: var(--pix-text-muted);
  background: var(--pix-bg-hover);
  padding: 0 5px;
  border-radius: 6px;
}

.wsv-msg-body {
  max-height: 300px;
  overflow-y: auto;
}

.wsv-msg-text {
  margin: 0;
  font-family: var(--pix-font-ui);
  font-size: var(--pix-text-xs);
  line-height: 1.5;
  color: var(--pix-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

.wsv-msg-time {
  font-size: 10px;
  color: var(--pix-text-muted);
  text-align: right;
  margin-top: 4px;
}

.wsv-scroll-btn {
  position: absolute;
  bottom: 52px;
  right: 16px;
  z-index: 1;
}

.wsv-composer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px var(--pix-space-sm);
  border-top: 1px solid var(--pix-border-subtle);
  background: rgba(255, 255, 255, 0.85);
  flex-shrink: 0;
}

.wsv-composer-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
  background: #ffffff;
  color: var(--pix-text-primary);
  font-family: var(--pix-font-ui);
  font-size: var(--pix-text-xs);
}

.wsv-composer-input:focus {
  outline: none;
  border-color: var(--pix-accent);
}

.wsv-composer-input::placeholder {
  color: var(--pix-text-muted);
}

.wsv-composer-send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--pix-radius-md);
  background: var(--pix-accent-light);
  color: var(--pix-accent);
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--pix-transition-fast), opacity var(--pix-transition-fast);
}

.wsv-composer-send:hover:not(:disabled) {
  background: var(--pix-accent-soft);
}

.wsv-composer-send:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
