<script setup lang="ts">
/**
 * WorkerStatusBar - Compact horizontal worker status bar.
 *
 * Shows each worker as a clickable
 * chip with role icon, name, status dot, and last activity tooltip.
 */
import { computed } from "vue";
import { useTeamStore } from "../../stores/team-store";
import { useWorkbenchTab } from "../../composables/useWorkbenchTab";
import type { TeammateInfo } from "@shared/types.js";

const teamStore = useTeamStore();
const { showActivityFocused, showTasks } = useWorkbenchTab();

function roleIcon(role: string): string {
  switch (role) {
    case "planner": return "mdi-clipboard-text-outline";
    case "coder": return "mdi-code-braces";
    case "reviewer": return "mdi-magnify";
    case "tester": return "mdi-test-tube";
    case "researcher": return "mdi-book-search-outline";
    default: return "mdi-robot";
  }
}

function roleColor(role: string): string {
  switch (role) {
    case "planner": return "#6356f3";
    case "coder": return "#16a34a";
    case "reviewer": return "#f59e0b";
    case "tester": return "#0ea5e9";
    case "researcher": return "#a855f7";
    default: return "#7d859a";
  }
}

function statusDotColor(status: string): string {
  switch (status) {
    case "running": return "var(--pix-success)";
    case "idle": return "var(--pix-text-muted)";
    case "standby": return "var(--pix-warning)";
    case "dormant": return "var(--pix-border)";
    case "error": return "var(--pix-error)";
    case "shutdown": return "var(--pix-text-muted)";
    default: return "var(--pix-text-muted)";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "running": return "工作中";
    case "idle": return "就绪";
    case "standby": return "就绪";
    case "dormant": return "已暂停";
    case "error": return "有问题";
    case "shutdown": return "已停止";
    default: return status;
  }
}

function handleWorkerClick(agentId: string): void {
  if (teamStore.focusedAgentId === agentId) {
    teamStore.clearFocus();
  } else {
    teamStore.focusWorker(agentId);
    // Mirror focusTaskOwner: surface the worker's detail/error in the activity
    // tab instead of leaving the dashboard on the tasks tab.
    showActivityFocused();
  }
}

const workerChips = computed(() => {
  const teammates = teamStore.teammates;
  return teammates.map((agent: TeammateInfo) => {
    const activity = teamStore.currentActivity[agent.agentId] ?? "";
    return {
      agentId: agent.agentId,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      activity,
      error: agent.error,
      isFocused: teamStore.focusedAgentId === agent.agentId,
      icon: roleIcon(agent.role),
      // Per-teammate color keeps same-role teammates distinguishable.
      color: agent.color ?? roleColor(agent.role),
      dotColor: statusDotColor(agent.status),
      statusLabel: statusLabel(agent.status),
    };
  });
});

const workingCount = computed(() => workerChips.value.filter((worker) => worker.status === "running").length);
const openTaskCount = computed(() => teamStore.teamTasks.filter((task) => task.status !== "completed" && task.status !== "cancelled").length);
const issueCount = computed(() => teamStore.problemTasks.length + teamStore.pendingProtocolCount);
</script>

<template>
  <div class="worker-status-bar">
    <div class="wsb-summary">
      <span class="wsb-summary-icon">
        <v-icon icon="mdi-account-group-outline" size="16" />
      </span>
      <span class="wsb-summary-copy">
        <strong>{{ teamStore.teamName || "团队工作区" }}</strong>
        <span>{{ workingCount }} 人工作中 / {{ openTaskCount }} 项待处理</span>
      </span>
    </div>

    <div class="wsb-workers">
      <button
        class="wsb-chip wsb-chip--leader"
        :class="{ focused: !teamStore.focusedAgentId }"
        type="button"
        title="负责人是主对话，点击可取消成员聚焦。"
        @click="teamStore.clearFocus()"
      >
        <v-icon icon="mdi-star" size="14" color="#8b5cf6" />
        <span class="wsb-chip-name">负责人</span>
        <span class="wsb-chip-dot" style="background-color: #8b5cf6"></span>
        <span class="wsb-chip-status">在线</span>
      </button>

      <button
        v-for="chip in workerChips"
        :key="chip.agentId"
        class="wsb-chip"
        :class="{ focused: chip.isFocused, running: chip.status === 'running' }"
        type="button"
        :title="chip.activity || chip.statusLabel"
        @click="handleWorkerClick(chip.agentId)"
      >
        <v-icon :icon="chip.icon" size="14" :style="{ color: chip.color }" />
        <span class="wsb-chip-name">{{ chip.name }}</span>
        <span
          class="wsb-chip-dot"
          :class="chip.status"
          :style="{ backgroundColor: chip.dotColor }"
        ></span>
        <span class="wsb-chip-status">{{ chip.statusLabel }}</span>
      </button>
    </div>

    <button
      v-if="issueCount > 0"
      class="wsb-issues"
      type="button"
      title="需要处理的项目：点击查看任务（问题任务置顶）"
      aria-label="需要处理的项目，点击查看任务"
      @click="showTasks()"
    >
      <v-icon icon="mdi-alert-circle-outline" size="14" />
      {{ issueCount }}
    </button>
  </div>
</template>

<style scoped>
.worker-status-bar {
  display: grid;
  grid-template-columns: minmax(160px, auto) minmax(0, 1fr) auto;
  align-items: center;
  min-height: 52px;
  padding: 6px var(--pix-space-md);
  background: #ffffff;
  border-bottom: 1px solid var(--pix-border-subtle);
  flex-shrink: 0;
  gap: var(--pix-space-sm);
}

.wsb-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.wsb-summary-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: var(--pix-radius-md);
  background: #eef7f2;
  color: #15805f;
}

.wsb-summary-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.wsb-summary-copy strong,
.wsb-summary-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wsb-summary-copy strong {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
}

.wsb-summary-copy span {
  color: var(--pix-text-muted);
  font-size: 10px;
}

.wsb-workers {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  padding: 2px;
  scrollbar-width: thin;
}

.wsb-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 32px;
  padding: 4px 9px;
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-card);
  border: 1px solid var(--pix-border-subtle);
  cursor: pointer;
  transition: border-color var(--pix-transition-fast), background var(--pix-transition-fast), box-shadow var(--pix-transition-fast);
  font-family: var(--pix-font-ui);
  font-size: var(--pix-text-xs);
}

.wsb-chip:hover {
  border-color: var(--pix-border);
  background: var(--pix-bg-hover);
}

.wsb-chip.focused {
  border-color: var(--pix-accent);
  background: var(--pix-accent-light);
  box-shadow: 0 0 0 1px var(--pix-accent-soft);
}

.wsb-chip.running {
  border-color: var(--pix-success-light);
}

.wsb-chip--leader {
  border-color: #d8d3ff;
  background: #f5f3ff;
}

.wsb-chip--leader:hover {
  border-color: #7c3aed;
  background: rgba(139, 92, 246, 0.12);
}

.wsb-chip--leader.focused {
  border-color: #7c3aed;
  background: rgba(139, 92, 246, 0.15);
  box-shadow: 0 0 0 1px rgba(139, 92, 246, 0.3);
}

.wsb-issues {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 34px;
  min-height: 28px;
  padding: 3px 7px;
  border: 1px solid transparent;
  border-radius: var(--pix-radius-md);
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
  font-family: var(--pix-font-ui);
  font-size: 10px;
  font-weight: var(--pix-weight-semibold);
  cursor: pointer;
  transition: background var(--pix-transition-fast), border-color var(--pix-transition-fast);
}

.wsb-issues:hover {
  background: var(--pix-warning-light);
  border-color: var(--pix-warning);
}

.wsb-chip-name {
  font-weight: var(--pix-weight-medium);
  color: var(--pix-text-primary);
  text-transform: capitalize;
}

.wsb-chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.wsb-chip-dot.running {
  animation: wsb-pulse 1.5s ease-in-out infinite;
}

@keyframes wsb-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.wsb-chip-status {
  font-size: 10px;
  color: var(--pix-text-muted);
}

@media (max-width: 1100px) {
  .worker-status-bar {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .wsb-summary {
    display: none;
  }
}

</style>
