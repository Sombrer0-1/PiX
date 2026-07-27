<script setup lang="ts">
/**
 * TeamDashboard - observable team workbench.
 *
 * Users coordinate through the Leader conversation. This panel makes the
 * team's internal work visible without exposing worker task dispatch as a
 * primary user workflow.
 */
import { computed, ref } from "vue";
import { useTeamStore } from "../../stores/team-store";
import WorkerSessionView from "./WorkerSessionView.vue";
import AllActivityView from "./AllActivityView.vue";
import TeamTimeline from "./TeamTimeline.vue";
import type { TeamTask, TeamTaskStatus } from "@shared/types.js";

const teamStore = useTeamStore();

/** Worker Activity view: focused worker log vs merged all-worker stream. */
const activityTab = ref<"focused" | "all">("focused");
const showStopDialog = ref(false);
const isStoppingTeam = ref(false);

const teamActive = computed(() => teamStore.isTeamActive);
const teammateMap = computed(() => teamStore.teamState?.teammates ?? {});
const leadAgentId = computed(() => teamStore.teamState?.leadAgentId ?? "");
const focusedAgent = computed(() => {
  const id = teamStore.focusedAgentId;
  return id ? teamStore.teamState?.teammates[id] ?? null : null;
});

const sortedOpenTasks = computed(() => {
  const order: Record<TeamTaskStatus, number> = {
    failed: 0,
    blocked: 1,
    in_progress: 2,
    assigned: 3,
    pending: 4,
    completed: 5,
    cancelled: 6,
  };
  return teamStore.teamTasks
    .filter((task) => task.status !== "completed" && task.status !== "cancelled")
    .sort((a, b) => {
      const statusDiff = order[a.status] - order[b.status];
      return statusDiff !== 0 ? statusDiff : b.updatedAt - a.updatedAt;
    });
});

const visibleOpenTasks = computed(() => sortedOpenTasks.value.slice(0, 8));
const recentMessages = computed(() => teamStore.teamMessages.slice(-5));

const workingCount = computed(() => teamStore.teammates.filter((agent) => agent.status === "running").length);
const readyCount = computed(() =>
  teamStore.teammates.filter((agent) => agent.status === "idle" || agent.status === "standby").length,
);
const issueCount = computed(() => teamStore.problemTasks.length);

const teamPulse = computed(() => [
  { label: "Working", value: workingCount.value, icon: "mdi-run", tone: "green" },
  { label: "Ready", value: readyCount.value + teamStore.readyTasks.length, icon: "mdi-playlist-play", tone: "blue" },
  { label: "Waiting", value: teamStore.waitingTasks.length, icon: "mdi-source-branch", tone: "amber" },
  { label: "Issues", value: issueCount.value, icon: "mdi-alert-circle-outline", tone: "red" },
]);

const currentHeadline = computed(() => {
  if (focusedAgent.value) {
    const activity = teamStore.currentActivity[focusedAgent.value.agentId];
    return activity || `${focusedAgent.value.name} is ${statusLabel(focusedAgent.value.status).toLowerCase()}`;
  }
  const running = teamStore.teammates.filter((agent) => agent.status === "running");
  if (running.length > 0) {
    return `${running.map((agent) => agent.name).join(", ")} working now`;
  }
  const nextTask = sortedOpenTasks.value[0];
  return nextTask ? `Next visible work: ${nextTask.subject}` : "The team is waiting for the Leader's next move";
});

async function handleStartTeam(): Promise<void> {
  await teamStore.createTeam();
}

async function handleStopTeam(): Promise<void> {
  isStoppingTeam.value = true;
  try {
    await teamStore.stopTeam();
  } finally {
    isStoppingTeam.value = false;
    showStopDialog.value = false;
  }
}

function focusTaskOwner(task: TeamTask): void {
  if (task.ownerAgentId) {
    teamStore.focusWorker(task.ownerAgentId);
  }
}

function taskOwnerName(task: TeamTask): string {
  if (!task.ownerAgentId) return "Unassigned";
  const agent = teamStore.teamState?.teammates[task.ownerAgentId];
  return agent?.name ?? task.ownerAgentId.split("::")[0];
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

function taskStatusLabel(status: TeamTaskStatus): string {
  switch (status) {
    case "pending": return "Queued";
    case "assigned": return "Assigned";
    case "in_progress": return "Working";
    case "blocked": return "Blocked";
    case "completed": return "Done";
    case "failed": return "Issue";
    case "cancelled": return "Cancelled";
    default: return status;
  }
}

function taskStatusTone(status: TeamTaskStatus): string {
  switch (status) {
    case "in_progress": return "blue";
    case "assigned": return "cyan";
    case "pending": return "grey";
    case "blocked": return "amber";
    case "failed": return "red";
    case "completed": return "green";
    case "cancelled": return "grey";
    default: return "grey";
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function taskEvidenceSummary(task: TeamTask): string {
  const evidence = task.evidence;
  if (!evidence) return "";
  const parts = [
    evidence.changedFiles.length ? `${evidence.changedFiles.length} files` : "",
    evidence.completedScope.length ? `${evidence.completedScope.length} done` : "",
    evidence.verification.length ? `${evidence.verification.length} checks` : "",
    evidence.missingScope.length ? `${evidence.missingScope.length} gaps` : "",
    evidence.risks.length ? `${evidence.risks.length} risks` : "",
  ].filter(Boolean);
  return parts.join(" / ");
}
</script>

<template>
  <div class="team-dashboard">
    <v-alert
      v-if="teamStore.lastError"
      type="error"
      variant="tonal"
      density="compact"
      closable
      class="team-alert"
      @click:close="teamStore.clearError()"
    >
      {{ teamStore.lastError }}
    </v-alert>

    <div v-if="!teamActive && !teamStore.isLoading" class="team-empty">
      <v-icon icon="mdi-account-group-outline" size="40" color="grey-lighten-1" />
      <p>No team is active for this session.</p>
      <v-btn
        :loading="teamStore.isLoading"
        color="primary"
        variant="flat"
        size="small"
        prepend-icon="mdi-play"
        @click="handleStartTeam"
      >
        Start Team
      </v-btn>
    </div>

    <template v-else>
      <section class="team-now">
        <div class="team-now__header">
          <div>
            <p class="team-eyebrow">Current Team State</p>
            <h3>{{ currentHeadline }}</h3>
          </div>
          <v-btn
            size="x-small"
            color="error"
            variant="text"
            prepend-icon="mdi-stop-circle-outline"
            :loading="isStoppingTeam"
            @click="showStopDialog = true"
          >
            Stop Team
          </v-btn>
        </div>

        <div class="team-metrics">
          <div
            v-for="metric in teamPulse"
            :key="metric.label"
            class="team-metric"
            :class="`team-metric--${metric.tone}`"
          >
            <v-icon :icon="metric.icon" size="14" />
            <strong>{{ metric.value }}</strong>
            <span>{{ metric.label }}</span>
          </div>
        </div>
      </section>

      <section class="team-section team-section--work">
        <div class="team-section__header">
          <div>
            <p class="team-eyebrow">Worker Activity</p>
            <h3>{{ activityTab === "all" ? "All workers, merged event stream" : focusedAgent ? `${focusedAgent.name} / ${focusedAgent.role}` : "Select a worker to inspect their live process" }}</h3>
          </div>
          <div class="activity-tabs">
            <button
              class="activity-tab"
              :class="{ active: activityTab === 'focused' }"
              type="button"
              @click="activityTab = 'focused'"
            >Focused</button>
            <button
              class="activity-tab"
              :class="{ active: activityTab === 'all' }"
              type="button"
              @click="activityTab = 'all'"
            >All</button>
          </div>
        </div>
        <WorkerSessionView v-if="activityTab === 'focused'" />
        <AllActivityView v-else />
      </section>

      <section class="team-section team-section--tasks">
        <div class="team-section__header">
          <div>
            <p class="team-eyebrow">Task Flow</p>
            <h3>{{ sortedOpenTasks.length }} open task{{ sortedOpenTasks.length === 1 ? "" : "s" }}</h3>
          </div>
          <span class="section-count">{{ teamStore.doneTasks.length }} done</span>
        </div>

        <div v-if="visibleOpenTasks.length === 0" class="team-mini-empty">
          No open worker tasks. Continue with the Leader in the main conversation.
        </div>

        <div v-else class="task-flow">
          <button
            v-for="task in visibleOpenTasks"
            :key="task.id"
            class="task-card"
            type="button"
            @click="focusTaskOwner(task)"
          >
            <div class="task-card__top">
              <span class="task-status" :class="`task-status--${taskStatusTone(task.status)}`">
                {{ taskStatusLabel(task.status) }}
              </span>
              <span class="task-owner">{{ taskOwnerName(task) }}</span>
            </div>
            <strong>{{ task.subject }}</strong>
            <p>{{ task.description }}</p>
            <div class="task-card__meta">
              <span v-if="task.taskType">{{ task.taskType }}</span>
              <span v-if="taskEvidenceSummary(task)">{{ taskEvidenceSummary(task) }}</span>
              <span>{{ formatTime(task.updatedAt) }}</span>
            </div>
          </button>
        </div>
      </section>

      <section class="team-section team-section--messages">
        <div class="team-section__header">
          <div>
            <p class="team-eyebrow">Team Discussion</p>
            <h3>{{ recentMessages.length ? "Recent messages" : "No team messages yet" }}</h3>
          </div>
          <span class="section-count">{{ teamStore.teamMessages.length }}</span>
        </div>
        <TeamTimeline
          :messages="teamStore.workerMessages"
          :teammates="teammateMap"
          :team-messages="recentMessages"
          :lead-agent-id="leadAgentId"
          compact
        />
      </section>
    </template>

    <v-dialog v-model="showStopDialog" max-width="400">
      <v-card class="stop-dialog-card">
        <div class="stop-dialog-title">Stop Team</div>
        <div class="stop-dialog-text">
          Stop team <strong>{{ teamStore.teamName }}</strong>?
          All workers will be shut down and the team disbanded. Completed work stays in your project.
        </div>
        <v-card-actions class="stop-dialog-actions">
          <v-spacer />
          <v-btn variant="text" @click="showStopDialog = false">Cancel</v-btn>
          <v-btn color="error" variant="tonal" :loading="isStoppingTeam" @click="handleStopTeam">Stop Team</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.team-dashboard {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-sm);
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: var(--pix-space-sm);
  background: var(--pix-bg-content);
}

.team-alert {
  flex-shrink: 0;
}

.team-empty,
.team-mini-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--pix-text-muted);
  font-size: var(--pix-text-sm);
  text-align: center;
}

.team-empty {
  flex: 1;
  flex-direction: column;
  gap: var(--pix-space-sm);
  min-height: 220px;
}

.team-now,
.team-section {
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-lg);
  background: rgba(255, 255, 255, 0.92);
  box-shadow: var(--pix-shadow-xs);
}

.team-now {
  padding: var(--pix-space-md);
  flex-shrink: 0;
}

.team-now__header,
.team-section__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--pix-space-sm);
}

.team-eyebrow {
  margin: 0 0 3px;
  color: var(--pix-text-muted);
  font-size: 11px;
  font-weight: var(--pix-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.team-now h3,
.team-section h3 {
  margin: 0;
  color: var(--pix-text-primary);
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
  line-height: 1.35;
}

.team-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--pix-space-xs);
  margin-top: var(--pix-space-sm);
}

.team-metric {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 6px 7px;
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
  font-size: 11px;
}

.team-metric strong {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-sm);
}

.team-metric--green {
  background: var(--pix-success-bg);
  color: var(--pix-success);
}

.team-metric--blue {
  background: #eff6ff;
  color: #2563eb;
}

.team-metric--amber {
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
}

.team-metric--red {
  background: var(--pix-error-bg);
  color: var(--pix-error);
}

.team-section {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: var(--pix-space-sm);
}

.team-section--work {
  flex: 1 1 420px;
  min-height: 320px;
}

.team-section--tasks,
.team-section--messages {
  flex-shrink: 0;
}

.section-count {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--pix-bg-hover);
  color: var(--pix-text-muted);
  font-size: 11px;
  white-space: nowrap;
}

.team-mini-empty {
  min-height: 74px;
  padding: var(--pix-space-md);
  border: 1px dashed var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
  margin-top: var(--pix-space-sm);
}

.task-flow {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-xs);
  margin-top: var(--pix-space-sm);
}

.task-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  padding: var(--pix-space-sm);
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-card);
  text-align: left;
  cursor: pointer;
}

.task-card:hover {
  border-color: var(--pix-border);
  background: var(--pix-bg-hover);
}

.task-card__top,
.task-card__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.task-card strong {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-sm);
  line-height: 1.3;
}

.task-card p {
  margin: 0;
  color: var(--pix-text-secondary);
  font-size: 11px;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.task-card__meta {
  color: var(--pix-text-muted);
  font-size: 10px;
  flex-wrap: wrap;
}

.task-status {
  display: inline-flex;
  align-items: center;
  min-height: 18px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: var(--pix-weight-semibold);
}

.task-status--blue {
  background: #eff6ff;
  color: #2563eb;
}

.task-status--cyan {
  background: #ecfeff;
  color: #0891b2;
}

.task-status--grey {
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
}

.task-status--amber {
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
}

.task-status--red {
  background: var(--pix-error-bg);
  color: var(--pix-error);
}

.task-status--green {
  background: var(--pix-success-bg);
  color: var(--pix-success);
}

.task-owner {
  color: var(--pix-text-muted);
  font-size: 10px;
  text-transform: capitalize;
}

.activity-tabs {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-hover);
  flex-shrink: 0;
}

.activity-tab {
  padding: 3px 10px;
  border-radius: var(--pix-radius-sm);
  font-size: 11px;
  color: var(--pix-text-secondary);
  cursor: pointer;
  transition: background var(--pix-transition-fast), color var(--pix-transition-fast);
}

.activity-tab:hover {
  color: var(--pix-text-primary);
}

.activity-tab.active {
  background: #ffffff;
  color: var(--pix-accent);
  font-weight: var(--pix-weight-medium);
  box-shadow: var(--pix-shadow-xs);
}

.stop-dialog-card {
  padding: var(--pix-space-lg);
  border-radius: var(--pix-radius-xl) !important;
}

.stop-dialog-title {
  font-size: var(--pix-text-md);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  margin-bottom: var(--pix-space-sm);
}

.stop-dialog-text {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-secondary);
  line-height: 1.5;
}

.stop-dialog-actions {
  padding: var(--pix-space-sm) 0 0 !important;
}
</style>
