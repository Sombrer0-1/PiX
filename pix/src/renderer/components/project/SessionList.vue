<script setup lang="ts">
/**
 * SessionList - Session history list
 */
import type { SessionInfo } from "@/types/session";

defineProps<{
  sessions: SessionInfo[];
  currentSessionId?: string | null;
  loading?: boolean;
}>();

const emit = defineEmits<{
  select: [session: SessionInfo];
}>();

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}
</script>

<template>
  <div class="session-list">
    <div v-if="loading" class="loading-state">
      <span class="spinner"></span>
      <span class="loading-text">Loading sessions...</span>
    </div>

    <div v-else-if="sessions.length === 0" class="empty-state">
      <p class="empty-text">No sessions found</p>
    </div>

    <button
      v-for="session in sessions"
      :key="session.id"
      class="session-item"
      :class="{ active: currentSessionId === session.id }"
      @click="emit('select', session)"
    >
      <div class="session-header-row">
        <div class="session-name">{{ session.name || session.id.slice(0, 8) }}</div>
        <div class="session-date">{{ formatDate(session.modified) }}</div>
      </div>
      <div class="session-preview">{{ truncateText(session.firstMessage, 80) }}</div>
      <div class="session-meta">{{ session.messageCount }} messages</div>
    </button>
  </div>
</template>

<style scoped>
.session-list {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-xs);
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--pix-space-sm);
  padding: var(--pix-space-xl);
}

.loading-text {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-muted);
}

.empty-state {
  padding: var(--pix-space-xl);
  text-align: center;
}

.empty-text {
  color: var(--pix-text-muted);
  font-size: var(--pix-text-sm);
}

.session-item {
  display: flex;
  flex-direction: column;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border-radius: var(--pix-radius-sm);
  text-align: left;
  margin: 0 calc(-1 * var(--pix-space-md));
  width: calc(100% + 2 * var(--pix-space-md));
  border-radius: 0;
}

.session-item:hover {
  background: var(--pix-bg-hover);
}

.session-item.active {
  background: var(--pix-bg-active);
}

.session-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.session-name {
  font-weight: 500;
  font-size: var(--pix-text-sm);
  color: var(--pix-text-primary);
}

.session-date {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  font-family: var(--pix-font-mono);
}

.session-preview {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-meta {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  margin-top: 1px;
}
</style>
