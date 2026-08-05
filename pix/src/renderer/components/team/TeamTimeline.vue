<script setup lang="ts">
/**
 * TeamTimeline - Chronological message feed for the Team Dashboard.
 *
 * Shows rich bus messages with from/to direction, role colors, and kind badges.
 * Falls back to legacy per-worker messages when bus messages are empty.
 * Auto-scrolls to bottom when new messages arrive, unless the user scrolled up
 * to read history; a scroll-to-bottom button re-enables auto-scroll.
 */
import { ref, watch, nextTick, computed, onMounted } from "vue";
import type { TeammateChatMessage, TeammateInfo, TeamMessage } from "@shared/types.js";

const props = defineProps<{
  /** All worker messages, keyed by agentId (legacy). */
  messages: Record<string, TeammateChatMessage[]>;
  /** Teammate info map for name lookup. */
  teammates: Record<string, TeammateInfo>;
  /** Rich bus messages (primary source when non-empty). */
  teamMessages: TeamMessage[];
  /** Leader agent ID for identifying leader messages. */
  leadAgentId: string;
  compact?: boolean;
}>();

const scrollContainer = ref<HTMLElement | null>(null);
const shouldAutoScroll = ref(true);

/** Resolve an agentId to a display name. */
function agentName(agentId: string): string {
  if (agentId === props.leadAgentId) return "负责人";
  const info = props.teammates[agentId];
  return info?.name ?? agentId.split("::")[0];
}

/** Resolve an agentId to a role. */
function agentRole(agentId: string): string {
  if (agentId === props.leadAgentId) return "leader";
  return props.teammates[agentId]?.role ?? "unknown";
}

/** Resolve an agentId to a display color (per-teammate color wins over role color). */
function agentDisplayColor(agentId: string, role: string): string {
  const teammateColor = props.teammates[agentId]?.color;
  return teammateColor ?? roleColor(role);
}

interface TimelineEntry {
  id: string;
  fromName: string;
  fromRole: string;
  fromColor: string;
  toName: string;
  toRole: string;
  toColor: string;
  text: string;
  summary: string;
  kind: string;
  timestamp: number;
}

/** Build timeline from bus messages (primary) or legacy messages (fallback). */
const timeline = computed<TimelineEntry[]>(() => {
  // Primary: use rich bus messages
  if (props.teamMessages.length > 0) {
    return props.teamMessages.map((m) => {
      const toRole = m.toAgentId === "*" ? "broadcast" : agentRole(m.toAgentId);
      return {
        id: m.id,
        fromName: agentName(m.fromAgentId),
        fromRole: m.fromRole,
        fromColor: agentDisplayColor(m.fromAgentId, m.fromRole),
        toName: m.toAgentId === "*" ? "全员" : agentName(m.toAgentId),
        toRole,
        toColor: m.toAgentId === "*" ? roleColor("broadcast") : agentDisplayColor(m.toAgentId, toRole),
        text: m.text,
        summary: m.summary,
        kind: m.kind,
        timestamp: m.timestamp,
      };
    });
  }

  // Fallback: legacy per-worker messages
  const entries: TimelineEntry[] = [];
  for (const [agentId, msgs] of Object.entries(props.messages)) {
    const info = props.teammates[agentId];
    const name = info?.name ?? agentId.split("::")[0];
    const role = info?.role ?? "unknown";
    const color = info?.color ?? roleColor(role);
    for (const msg of msgs) {
      if (msg.role === "user") {
        entries.push({
          id: msg.id,
          fromName: "负责人",
          fromRole: "leader",
          fromColor: roleColor("leader"),
          toName: name,
          toRole: role,
          toColor: color,
          text: msg.content,
          summary: "",
          kind: "leader_message",
          timestamp: msg.timestamp,
        });
      } else {
        entries.push({
          id: msg.id,
          fromName: name,
          fromRole: role,
          fromColor: color,
          toName: "负责人",
          toRole: "leader",
          toColor: roleColor("leader"),
          text: msg.content,
          summary: "",
          kind: "peer_message",
          timestamp: msg.timestamp,
        });
      }
    }
  }
  entries.sort((a, b) => a.timestamp - b.timestamp);
  return entries;
});

const roleColor = (role: string): string => {
  switch (role) {
    case "planner": return "#6356f3";
    case "coder": return "#16a34a";
    case "reviewer": return "#f59e0b";
    case "tester": return "#0ea5e9";
    case "researcher": return "#a855f7";
    case "leader": return "#3b82f6";
    default: return "#7d859a";
  }
};

const roleIcon = (role: string): string => {
  switch (role) {
    case "planner": return "mdi-clipboard-text-outline";
    case "coder": return "mdi-code-braces";
    case "reviewer": return "mdi-magnify";
    case "tester": return "mdi-test-tube";
    case "researcher": return "mdi-book-search-outline";
    case "leader": return "mdi-account-star";
    default: return "mdi-robot";
  }
};

const kindColor = (kind: string): string => {
  switch (kind) {
    case "shutdown": return "#ef4444";
    case "blocked": return "#ef4444";
    case "objection": return "#f97316";
    case "fix_request": return "#f97316";
    case "leader_message": return "#3b82f6";
    case "decision": return "#3b82f6";
    case "peer_message": return "#22c55e";
    case "answer": return "#22c55e";
    case "broadcast": return "#a855f7";
    case "task_message": return "#6b7280";
    case "permission_request": return "#f59e0b";
    case "permission_response": return "#f59e0b";
    case "plan_approval": return "#0ea5e9";
    default: return "#7d859a";
  }
};

const kindLabel = (kind: string): string => {
  switch (kind) {
    case "shutdown": return "停止";
    case "leader_message": return "负责人";
    case "peer_message": return "成员";
    case "broadcast": return "广播";
    case "task_message": return "任务";
    case "question": return "提问";
    case "answer": return "回答";
    case "proposal": return "建议";
    case "objection": return "异议";
    case "decision": return "决定";
    case "handoff": return "交接";
    case "review_request": return "审查";
    case "fix_request": return "修复";
    case "task_result": return "结果";
    case "blocked": return "阻塞";
    case "permission_request": return "权限";
    case "permission_response": return "权限";
    case "plan_approval": return "计划";
    case "worker_summary": return "摘要";
    default: return kind;
  }
};

const formatTime = (ts: number): string => {
  const d = new Date(ts);
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

// Auto-scroll to bottom when timeline grows, unless the user scrolled up.
watch(
  () => timeline.value.length,
  async () => {
    if (!shouldAutoScroll.value) return;
    await nextTick();
    scrollToBottom();
  }
);

onMounted(async () => {
  if (timeline.value.length > 0) {
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
</script>

<template>
  <div class="team-timeline" :class="{ 'team-timeline--compact': compact }">
    <div v-if="!compact" class="team-timeline__header">
      <v-icon icon="mdi-message-text-outline" size="16" />
      <span>团队消息</span>
      <span class="team-timeline__count">{{ timeline.length }}</span>
    </div>
    <div ref="scrollContainer" class="team-timeline__body" @scroll="handleScroll">
      <div v-if="timeline.length === 0" class="team-timeline__empty">
        暂无消息
      </div>
      <div
        v-for="entry in timeline"
        :key="entry.id"
        class="team-timeline__entry"
      >
        <div class="team-timeline__meta">
          <v-icon
            :icon="roleIcon(entry.fromRole)"
            size="14"
            :style="{ color: entry.fromColor }"
          />
          <span class="team-timeline__agent" :style="{ color: entry.fromColor }">
            {{ entry.fromName }}
          </span>
          <span class="team-timeline__arrow">&rarr;</span>
          <v-icon
            v-if="entry.toRole !== 'broadcast'"
            :icon="roleIcon(entry.toRole)"
            size="14"
            :style="{ color: entry.toColor }"
          />
          <span class="team-timeline__agent" :style="{ color: entry.toColor }">
            {{ entry.toName }}
          </span>
          <span
            class="team-timeline__kind"
            :style="{ color: kindColor(entry.kind), borderColor: kindColor(entry.kind) }"
          >
            {{ kindLabel(entry.kind) }}
          </span>
          <span class="team-timeline__time">{{ formatTime(entry.timestamp) }}</span>
        </div>
        <div v-if="entry.summary && entry.summary !== entry.text" class="team-timeline__summary">
          {{ entry.summary }}
        </div>
        <div class="team-timeline__content">{{ entry.text }}</div>
      </div>
    </div>
    <div v-if="!shouldAutoScroll && timeline.length > 0" class="team-timeline__scroll-btn">
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
.team-timeline {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-lg);
  overflow: hidden;
  background: var(--pix-bg-card);
  position: relative;
}

.team-timeline--compact {
  border: 0;
  border-radius: 0;
  background: transparent;
}

.team-timeline__header {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  padding: var(--pix-space-xs) var(--pix-space-sm);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-secondary);
  border-bottom: 1px solid var(--pix-border-subtle);
  background: var(--pix-bg-hover);
}

.team-timeline__count {
  margin-left: auto;
  background: var(--pix-accent-light);
  color: var(--pix-accent);
  padding: 1px 6px;
  border-radius: var(--pix-radius-xs);
  font-size: 11px;
}

.team-timeline__body {
  flex: 1;
  overflow-y: auto;
  padding: var(--pix-space-xs) var(--pix-space-sm);
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-xs);
}

.team-timeline--compact .team-timeline__body {
  padding: var(--pix-space-sm);
}

.team-timeline__empty {
  text-align: center;
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
  padding: var(--pix-space-lg) 0;
}

.team-timeline__entry {
  padding: 6px 8px;
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-hover);
  transition: background var(--pix-transition-fast);
}

.team-timeline__entry:hover {
  background: var(--pix-bg-active);
}

.team-timeline__meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 2px;
}

.team-timeline__agent {
  font-size: 11px;
  font-weight: var(--pix-weight-semibold);
  text-transform: capitalize;
}

.team-timeline__arrow {
  font-size: 10px;
  color: var(--pix-text-muted);
  margin: 0 2px;
}

.team-timeline__kind {
  font-size: 9px;
  font-weight: var(--pix-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0;
  padding: 1px 4px;
  border-radius: 3px;
  border: 1px solid;
  opacity: 0.8;
  margin-left: 4px;
}

.team-timeline__summary {
  font-size: 10px;
  color: var(--pix-text-muted);
  font-style: italic;
  margin-bottom: 2px;
}

.team-timeline__time {
  margin-left: auto;
  font-size: 10px;
  color: var(--pix-text-muted);
  font-family: var(--pix-font-mono);
}

.team-timeline__content {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-primary);
  line-height: var(--pix-leading-tight);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow-y: auto;
}

.team-timeline--compact .team-timeline__content {
  max-height: 72px;
}

.team-timeline__scroll-btn {
  position: absolute;
  bottom: 8px;
  right: 8px;
  z-index: 1;
}
</style>
