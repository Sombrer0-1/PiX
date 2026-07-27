<script setup lang="ts">
/**
 * WorkerDetailCard - worker/team detail card.
 *
 * Primarily observation: coordination happens through the Leader in the main
 * conversation. A small set of lifecycle controls (abort turn, restart, wake)
 * is exposed for direct intervention when a worker misbehaves.
 */
import { computed, ref } from "vue";
import { useTeamStore } from "../../stores/team-store";
import type { TeammateInfo } from "@shared/types.js";

const teamStore = useTeamStore();

const focusedId = computed(() => teamStore.focusedAgentId);
const actionInFlight = ref(false);

async function runWorkerAction(action: (agentId: string) => Promise<boolean>): Promise<void> {
  const agentId = focusedId.value;
  if (!agentId || actionInFlight.value) return;
  actionInFlight.value = true;
  try {
    await action(agentId);
  } finally {
    actionInFlight.value = false;
  }
}

const canAbort = computed(() => focusedAgent.value?.status === "running");
const canRestart = computed(() => focusedAgent.value?.status === "error" || focusedAgent.value?.status === "shutdown");
const canWake = computed(() => focusedAgent.value?.status === "dormant" || focusedAgent.value?.status === "standby");

const focusedAgent = computed<TeammateInfo | null>(() => {
  if (!focusedId.value || !teamStore.teamState) return null;
  return teamStore.teamState.teammates[focusedId.value] ?? null;
});

const activity = computed(() => {
  if (!focusedId.value) return "";
  return teamStore.currentActivity[focusedId.value] ?? "";
});

const runtime = computed(() => {
  const agent = focusedAgent.value;
  if (!agent?.statusChangedAt) return "";
  const ms = Date.now() - agent.statusChangedAt;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
});

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

function statusColor(status: string): string {
  switch (status) {
    case "running": return "green";
    case "idle": return "grey";
    case "standby": return "grey";
    case "dormant": return "blue-grey";
    case "error": return "red";
    case "shutdown": return "grey-darken-1";
    default: return "grey";
  }
}

function statusDot(status: string): string {
  switch (status) {
    case "running": return "var(--pix-success)";
    case "error": return "var(--pix-error)";
    case "dormant": return "var(--pix-border)";
    case "shutdown": return "var(--pix-text-muted)";
    default: return "var(--pix-text-muted)";
  }
}
</script>

<template>
  <div class="info-card">
    <div class="card-title">
      <span v-if="focusedAgent">Worker Detail</span>
      <span v-else>Team Overview</span>
    </div>

    <template v-if="focusedAgent">
      <div class="wd-header">
        <v-icon :icon="roleIcon(focusedAgent.role)" size="18" class="wd-role-icon" />
        <span class="wd-name">{{ focusedAgent.name }}</span>
        <v-chip
          :color="statusColor(focusedAgent.status)"
          size="x-small"
          label
          variant="flat"
        >
          {{ statusLabel(focusedAgent.status) }}
        </v-chip>
      </div>

      <div class="info-rows">
        <div class="info-row">
          <span class="info-label">Role</span>
          <span class="info-value">{{ focusedAgent.role }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Model</span>
          <span class="info-value">{{ focusedAgent.model ?? "default" }}</span>
        </div>
        <div v-if="focusedAgent.status === 'running' && runtime" class="info-row">
          <span class="info-label">Runtime</span>
          <span class="info-value">{{ runtime }}</span>
        </div>
        <div v-if="focusedAgent.specialization" class="info-row info-row--stack">
          <span class="info-label">Specialization</span>
          <span class="info-value wd-activity">{{ focusedAgent.specialization }}</span>
        </div>
        <div v-if="activity" class="info-row info-row--stack">
          <span class="info-label">Activity</span>
          <span class="info-value wd-activity">{{ activity }}</span>
        </div>
        <div v-if="focusedAgent.error" class="info-row info-row--stack">
          <span class="info-label error-label">Error</span>
          <span class="info-value wd-error">{{ focusedAgent.error }}</span>
        </div>
      </div>

      <div v-if="canAbort || canRestart || canWake" class="wd-actions">
        <v-btn
          v-if="canAbort"
          size="x-small"
          color="warning"
          variant="tonal"
          prepend-icon="mdi-stop"
          :disabled="actionInFlight"
          @click="runWorkerAction(teamStore.abortWorker)"
        >
          Stop turn
        </v-btn>
        <v-btn
          v-if="canRestart"
          size="x-small"
          color="primary"
          variant="tonal"
          prepend-icon="mdi-restart"
          :disabled="actionInFlight"
          @click="runWorkerAction(teamStore.restartWorker)"
        >
          Restart
        </v-btn>
        <v-btn
          v-if="canWake"
          size="x-small"
          color="primary"
          variant="tonal"
          prepend-icon="mdi-play"
          :disabled="actionInFlight"
          @click="runWorkerAction(teamStore.activateMember)"
        >
          Wake
        </v-btn>
      </div>

      <div class="wd-note">
        Coordinate through the Leader in the main conversation.
      </div>
    </template>

    <template v-else>
      <div class="wd-overview">
        <div
          v-for="agent in teamStore.teammates"
          :key="agent.agentId"
          class="wd-overview-row"
        >
          <v-icon :icon="roleIcon(agent.role)" size="13" class="wd-overview-icon" />
          <span class="wd-overview-name">{{ agent.name }}</span>
          <span class="wd-overview-dot" :style="{ backgroundColor: statusDot(agent.status) }"></span>
          <span class="wd-overview-status">{{ statusLabel(agent.status) }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.info-card {
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-lg);
  padding: var(--pix-space-md);
  box-shadow: var(--pix-shadow-xs);
}

.card-title {
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  margin-bottom: var(--pix-space-sm);
}

.wd-header {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  margin-bottom: var(--pix-space-sm);
}

.wd-role-icon {
  color: var(--pix-accent);
}

.wd-name {
  font-weight: var(--pix-weight-semibold);
  font-size: var(--pix-text-sm);
  color: var(--pix-text-primary);
  text-transform: capitalize;
}

.info-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 24px;
}

.info-row--stack {
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.info-label {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  flex-shrink: 0;
}

.info-value {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-primary);
  font-weight: var(--pix-weight-medium);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}

.wd-activity {
  max-width: 100% !important;
  font-weight: var(--pix-weight-normal) !important;
  color: var(--pix-text-secondary) !important;
  font-style: italic;
  white-space: normal !important;
  font-size: 11px;
}

.wd-error {
  max-width: 100% !important;
  color: var(--pix-error) !important;
  font-size: 11px;
  white-space: normal !important;
}

.error-label {
  color: var(--pix-error) !important;
}

.wd-actions {
  display: flex;
  gap: var(--pix-space-xs);
  margin-top: var(--pix-space-sm);
  flex-wrap: wrap;
}

.wd-note {
  margin-top: var(--pix-space-sm);
  padding-top: var(--pix-space-sm);
  border-top: 1px solid var(--pix-border-subtle);
  color: var(--pix-text-muted);
  font-size: 11px;
  line-height: 1.4;
}

.wd-overview {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.wd-overview-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--pix-text-xs);
}

.wd-overview-icon {
  color: var(--pix-accent);
  flex-shrink: 0;
}

.wd-overview-name {
  color: var(--pix-text-primary);
  font-weight: var(--pix-weight-medium);
  text-transform: capitalize;
  flex: 1;
}

.wd-overview-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.wd-overview-status {
  font-size: 10px;
  color: var(--pix-text-muted);
  white-space: nowrap;
}
</style>
