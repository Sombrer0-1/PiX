<script setup lang="ts">
/**
 * ProjectList - Recent projects list
 *
 * Used on the home page and for project switching.
 */
import type { ProjectInfo } from "@/types/session";

const props = defineProps<{
  projects: ProjectInfo[];
}>();

const emit = defineEmits<{
  select: [project: ProjectInfo];
  remove: [project: ProjectInfo];
}>();

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 3600000) return "Just now";
  if (diff < 86400000) return "Today";
  if (diff < 172800000) return "Yesterday";
  if (diff < 604800000) return `${Math.ceil(diff / 86400000)} days ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
</script>

<template>
  <div class="project-list">
    <div v-if="projects.length === 0" class="empty-state">
      <p class="empty-text">No recent projects</p>
    </div>
    <button
      v-for="project in projects"
      :key="project.path"
      class="project-item"
      @click="emit('select', project)"
    >
      <div class="project-icon" aria-hidden="true"></div>
      <div class="project-info">
        <div class="project-name">{{ project.name }}</div>
        <div class="project-path">{{ project.path }}</div>
        <div class="project-meta">
          <span>{{ formatDate(project.lastOpened) }}</span>
          <template v-if="project.sessionCount > 0">
            <span class="meta-sep">|</span>
            <span>{{ project.sessionCount }} sessions</span>
          </template>
        </div>
      </div>
    </button>
  </div>
</template>

<style scoped>
.project-list {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-xs);
}

.empty-state {
  padding: var(--pix-space-xl);
  text-align: center;
}

.empty-text {
  color: var(--pix-text-muted);
  font-size: var(--pix-text-sm);
}

.project-item {
  display: flex;
  align-items: flex-start;
  gap: var(--pix-space-md);
  padding: var(--pix-space-md);
  border-radius: var(--pix-radius-md);
  text-align: left;
  transition: background var(--pix-transition-fast);
}

.project-item:hover {
  background: var(--pix-bg-hover);
}

.project-icon {
  position: relative;
  width: 20px;
  height: 14px;
  border: 1px solid var(--pix-border);
  border-radius: 3px;
  background: var(--pix-bg-code);
  flex-shrink: 0;
  margin-top: 6px;
}

.project-icon::before {
  content: "";
  position: absolute;
  top: -5px;
  left: 2px;
  width: 9px;
  height: 5px;
  border: 1px solid var(--pix-border);
  border-bottom: 0;
  border-radius: 3px 3px 0 0;
  background: var(--pix-bg-code);
}

.project-info {
  flex: 1;
  min-width: 0;
}

.project-name {
  font-weight: 500;
  font-size: var(--pix-text-md);
  color: var(--pix-text-primary);
}

.project-path {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 2px;
}

.project-meta {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  margin-top: var(--pix-space-xs);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}

.meta-sep {
  color: var(--pix-border);
}
</style>
