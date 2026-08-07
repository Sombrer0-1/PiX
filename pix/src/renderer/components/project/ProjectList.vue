<script setup lang="ts">
/**
 * ProjectList - Recent projects list
 *
 * Used on the home page and for project switching. Shows the project
 * environment (Windows / WSL2 + distro) alongside the logical path; the
 * `select` event carries the full ProjectInfo (a ProjectLocation) so callers
 * never have to re-guess the environment from a string.
 */
import { computed } from "vue";
import type { ProjectInfo, ProjectEnvironment } from "@/types/session";

const props = defineProps<{
  projects: ProjectInfo[];
}>();

const emit = defineEmits<{
  select: [project: ProjectInfo];
  remove: [project: ProjectInfo];
}>();

const items = computed(() =>
  props.projects.map((project) => ({
    project,
    key: projectKey(project),
    envLabel: envLabel(project.environment),
  })),
);

function envLabel(env: ProjectEnvironment): string {
  return env.kind === "wsl" ? `WSL2 · ${env.distro}` : "Windows";
}

function projectKey(project: ProjectInfo): string {
  return project.environment.kind === "wsl"
    ? `wsl:${project.environment.distro}:${project.path}`
    : `win:${project.path.toLowerCase()}`;
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 3600000) return "刚刚";
  if (diff < 86400000) return "今天";
  if (diff < 172800000) return "昨天";
  if (diff < 604800000) return `${Math.ceil(diff / 86400000)} 天前`;
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}
</script>

<template>
  <div class="project-list">
    <div v-if="projects.length === 0" class="empty-state">
      <p class="empty-text">暂无最近项目</p>
    </div>
    <button
      v-for="{ project, key, envLabel } in items"
      :key="key"
      class="project-item"
      @click="emit('select', project)"
    >
      <div class="project-icon" aria-hidden="true"></div>
      <div class="project-info">
        <div class="project-name-row">
          <span class="project-name">{{ project.name }}</span>
          <span class="project-env" :class="{ 'env-wsl': project.environment.kind === 'wsl' }">{{ envLabel }}</span>
        </div>
        <div class="project-path">{{ project.path }}</div>
        <div class="project-meta">
          <span>{{ formatDate(project.lastOpened) }}</span>
          <template v-if="project.sessionCount > 0">
            <span class="meta-sep">|</span>
            <span>{{ project.sessionCount }} 个会话</span>
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

.project-name-row {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  min-width: 0;
}

.project-name {
  font-weight: 500;
  font-size: var(--pix-text-md);
  color: var(--pix-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-env {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  font-family: var(--pix-font-mono);
  color: var(--pix-text-muted);
  padding: 1px 6px;
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-hover);
}

.project-env.env-wsl {
  color: var(--pix-text-inverse);
  background: linear-gradient(135deg, #7567f5 0%, #5142df 100%);
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
