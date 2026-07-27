<script setup lang="ts">
/**
 * WorkerStatusBar - Compact horizontal worker status bar.
 *
 * Shows each worker as a clickable
 * chip with role icon, name, status dot, and last activity tooltip.
 */
import { computed } from "vue";
import { useTeamStore } from "../../stores/team-store";
import type { TeammateInfo } from "@shared/types.js";

const teamStore = useTeamStore();

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
    case "running": return "Working";
    case "idle": return "Ready";
    case "standby": return "Ready";
    case "dormant": return "Paused";
    case "error": return "Issue";
    case "shutdown": return "Stopped";
    default: return status;
  }
}

function handleWorkerClick(agentId: string): void {
  if (teamStore.focusedAgentId === agentId) {
    teamStore.clearFocus();
  } else {
    teamStore.focusWorker(agentId);
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
</script>

<template>
  <div class="worker-status-bar">
    <div class="wsb-workers">
      <!-- Leader chip: always shown, represents the main session -->
      <button
        class="wsb-chip wsb-chip--leader"
        :class="{ focused: !teamStore.focusedAgentId }"
        title="Leader is your main conversation. Click to clear worker focus."
        @click="teamStore.clearFocus()"
      >
        <v-icon icon="mdi-star" size="14" color="#8b5cf6" />
        <span class="wsb-chip-name">Leader</span>
        <span class="wsb-chip-dot" style="background-color: #8b5cf6"></span>
        <span class="wsb-chip-status">Active</span>
      </button>

      <!-- Worker chips are observation-only. Users coordinate through Leader. -->
      <button
        v-for="chip in workerChips"
        :key="chip.agentId"
        class="wsb-chip"
        :class="{ focused: chip.isFocused, running: chip.status === 'running' }"
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
  </div>
</template>

<style scoped>
.worker-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px var(--pix-space-sm);
  background: var(--pix-bg-topbar);
  border-bottom: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
  flex-shrink: 0;
  gap: var(--pix-space-sm);
}

.wsb-workers {
  display: flex;
  align-items: center;
  gap: 4px;
}

.wsb-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
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
  border-color: #8b5cf6;
  background: rgba(139, 92, 246, 0.06);
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

</style>
