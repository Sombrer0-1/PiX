<script setup lang="ts">
import { computed, ref } from "vue";
import { useTeamStore } from "../../stores/team-store";
import { useWorkbenchTab, type WorkbenchTab } from "../../composables/useWorkbenchTab";
import AllActivityView from "./AllActivityView.vue";
import FileChangeSummary from "./FileChangeSummary.vue";
import TeamProtocolPanel from "./TeamProtocolPanel.vue";
import TeamTimeline from "./TeamTimeline.vue";
import WorkerDetailCard from "./WorkerDetailCard.vue";
import WorkerSessionView from "./WorkerSessionView.vue";
import type { TeamTask, TeamTaskStatus } from "@shared/types.js";

const teamStore = useTeamStore();
const { activeTab, activityMode, showActivityFocused } = useWorkbenchTab();
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

const workingCount = computed(() => teamStore.teammates.filter((agent) => agent.status === "running").length);
const readyCount = computed(() =>
  teamStore.teammates.filter((agent) => agent.status === "idle" || agent.status === "standby").length,
);
const issueCount = computed(() => teamStore.problemTasks.length);
const activityCount = computed(() =>
  Object.values(teamStore.workerEvents).reduce((total, events) => total + events.length, 0),
);

const teamPulse = computed(() => [
  { label: "工作中", value: workingCount.value, icon: "mdi-run", tone: "green" },
  { label: "就绪", value: readyCount.value + teamStore.readyTasks.length, icon: "mdi-playlist-play", tone: "blue" },
  { label: "等待中", value: teamStore.waitingTasks.length, icon: "mdi-source-branch", tone: "amber" },
  { label: "问题", value: issueCount.value, icon: "mdi-alert-circle-outline", tone: "red" },
]);

const workbenchTabs = computed<Array<{ value: WorkbenchTab; label: string; icon: string; count?: number }>>(() => [
  { value: "tasks", label: "任务", icon: "mdi-format-list-checks", count: sortedOpenTasks.value.length },
  { value: "activity", label: "活动", icon: "mdi-pulse", count: activityCount.value },
  { value: "changes", label: "变更", icon: "mdi-file-edit-outline" },
  { value: "messages", label: "消息", icon: "mdi-message-text-outline", count: teamStore.teamMessages.length },
]);

const currentHeadline = computed(() => {
  if (focusedAgent.value) {
    const activity = teamStore.currentActivity[focusedAgent.value.agentId];
    return activity || `${focusedAgent.value.name}：${statusLabel(focusedAgent.value.status)}`;
  }
  const running = teamStore.teammates.filter((agent) => agent.status === "running");
  if (running.length > 0) return `${running.map((agent) => agent.name).join("、")} 正在工作`;
  const nextTask = sortedOpenTasks.value[0];
  return nextTask ? `下一项：${nextTask.subject}` : "等待负责人安排下一步";
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
  if (!task.ownerAgentId) return;
  teamStore.focusWorker(task.ownerAgentId);
  showActivityFocused();
}

function taskOwnerName(task: TeamTask): string {
  if (!task.ownerAgentId) return "未分配";
  const agent = teamStore.teamState?.teammates[task.ownerAgentId];
  return agent?.name ?? task.ownerAgentId.split("::")[0];
}

function statusLabel(status: string): string {
  switch (status) {
    case "running": return "工作中";
    case "idle":
    case "standby": return "就绪";
    case "dormant": return "已暂停";
    case "error": return "有问题";
    case "shutdown": return "已停止";
    default: return status;
  }
}

function roleLabel(role: string): string {
  switch (role) {
    case "planner": return "规划";
    case "coder": return "开发";
    case "reviewer": return "审查";
    case "tester": return "测试";
    case "researcher": return "调研";
    case "leader": return "负责人";
    default: return role;
  }
}

function taskStatusLabel(status: TeamTaskStatus): string {
  switch (status) {
    case "pending": return "排队中";
    case "assigned": return "已分配";
    case "in_progress": return "进行中";
    case "blocked": return "已阻塞";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "cancelled": return "已取消";
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
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatCount(value: number): string {
  return value > 99 ? "99+" : String(value);
}

function taskEvidenceSummary(task: TeamTask): string {
  const evidence = task.evidence;
  if (!evidence) return "";
  return [
    evidence.changedFiles.length ? `${evidence.changedFiles.length} 个文件` : "",
    evidence.completedScope.length ? `${evidence.completedScope.length} 项完成` : "",
    evidence.verification.length ? `${evidence.verification.length} 项验证` : "",
    evidence.missingScope.length ? `${evidence.missingScope.length} 项缺失` : "",
    evidence.risks.length ? `${evidence.risks.length} 项风险` : "",
  ].filter(Boolean).join(" / ");
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

    <div v-if="teamStore.isLoading && !teamActive" class="team-empty">
      <v-icon icon="mdi-loading" size="26" class="team-loading-icon" />
      <strong>正在启动团队...</strong>
    </div>

    <div v-else-if="!teamActive" class="team-empty">
      <span class="team-empty-icon">
        <v-icon icon="mdi-account-group-outline" size="28" />
      </span>
      <strong>当前没有活动团队</strong>
      <v-btn
        :loading="teamStore.isLoading"
        color="primary"
        variant="flat"
        size="small"
        prepend-icon="mdi-play"
        @click="handleStartTeam"
      >
        启动团队
      </v-btn>
    </div>

    <template v-else>
      <header class="workbench-header">
        <div class="workbench-title">
          <span class="workbench-mark">
            <v-icon icon="mdi-view-dashboard-outline" size="18" />
          </span>
          <span class="workbench-title-copy">
            <strong>{{ teamStore.teamName || "团队工作台" }}</strong>
            <span :title="currentHeadline">{{ currentHeadline }}</span>
          </span>
        </div>
        <v-btn
          icon="mdi-stop-circle-outline"
          size="small"
          color="error"
          variant="text"
          :loading="isStoppingTeam"
          title="停止并解散团队"
          aria-label="停止并解散团队"
          @click="showStopDialog = true"
        />
      </header>

      <TeamProtocolPanel />

      <div class="team-metrics" aria-label="团队概览">
        <div
          v-for="metric in teamPulse"
          :key="metric.label"
          class="team-metric"
          :class="`team-metric--${metric.tone}`"
        >
          <v-icon :icon="metric.icon" size="14" />
          <span>{{ metric.label }}</span>
          <strong>{{ metric.value }}</strong>
        </div>
      </div>

      <nav class="workbench-tabs" role="tablist" aria-label="团队工作台视图">
        <button
          v-for="tab in workbenchTabs"
          :key="tab.value"
          class="workbench-tab"
          :class="{ active: activeTab === tab.value }"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.value"
          @click="activeTab = tab.value"
        >
          <v-icon :icon="tab.icon" size="14" />
          <span>{{ tab.label }}</span>
          <span v-if="tab.count !== undefined" class="workbench-tab-count">{{ formatCount(tab.count) }}</span>
        </button>
      </nav>

      <div class="workbench-body" :class="{ 'workbench-body--activity': activeTab === 'activity' || activeTab === 'messages' }">
        <section v-if="activeTab === 'tasks'" class="workbench-section">
          <div class="section-heading">
            <div>
              <strong>当前工作</strong>
              <span>{{ sortedOpenTasks.length }} 项进行中 / {{ teamStore.doneTasks.length }} 项完成</span>
            </div>
          </div>

          <div v-if="sortedOpenTasks.length === 0" class="workbench-empty">
            <v-icon icon="mdi-check-circle-outline" size="24" />
            <strong>没有待处理任务</strong>
          </div>

          <div v-else class="task-list">
            <button
              v-for="task in sortedOpenTasks"
              :key="task.id"
              class="task-row"
              :class="{ 'task-row--actionable': task.ownerAgentId }"
              type="button"
              :disabled="!task.ownerAgentId"
              @click="focusTaskOwner(task)"
            >
              <span class="task-status" :class="`task-status--${taskStatusTone(task.status)}`">
                {{ taskStatusLabel(task.status) }}
              </span>
              <span class="task-copy">
                <strong>{{ task.subject }}</strong>
                <span>{{ task.description }}</span>
                <small v-if="taskEvidenceSummary(task)">{{ taskEvidenceSummary(task) }}</small>
              </span>
              <span class="task-meta">
                <strong>{{ taskOwnerName(task) }}</strong>
                <span>{{ formatTime(task.updatedAt) }}</span>
              </span>
              <v-icon v-if="task.ownerAgentId" icon="mdi-chevron-right" size="15" />
            </button>
          </div>
        </section>

        <section v-else-if="activeTab === 'activity'" class="workbench-section workbench-activity">
          <div class="activity-toolbar">
            <div>
              <strong>成员活动</strong>
              <span>{{ focusedAgent ? `${focusedAgent.name} / ${roleLabel(focusedAgent.role)}` : "全部成员" }}</span>
            </div>
            <div class="activity-toggle" role="group" aria-label="活动流范围">
              <button
                type="button"
                :class="{ active: activityMode === 'focused' }"
                @click="activityMode = 'focused'"
              >当前成员</button>
              <button
                type="button"
                :class="{ active: activityMode === 'all' }"
                @click="activityMode = 'all'"
              >全部</button>
            </div>
          </div>
          <WorkerDetailCard v-if="activityMode === 'focused' && focusedAgent" />
          <WorkerSessionView v-if="activityMode === 'focused'" />
          <AllActivityView v-else />
        </section>

        <section v-else-if="activeTab === 'changes'" class="workbench-section">
          <FileChangeSummary />
        </section>

        <section v-else class="workbench-section workbench-messages">
          <TeamTimeline
            :messages="teamStore.workerMessages"
            :teammates="teammateMap"
            :team-messages="teamStore.teamMessages"
            :lead-agent-id="leadAgentId"
            compact
          />
        </section>
      </div>
    </template>

    <v-dialog v-model="showStopDialog" max-width="400" :persistent="isStoppingTeam">
      <v-card class="stop-dialog-card">
        <div class="stop-dialog-title">停止团队</div>
        <div class="stop-dialog-text">
          确定停止团队 <strong>{{ teamStore.teamName }}</strong>？所有成员都会停止，团队将被解散，已完成的工作会保留在项目中。
        </div>
        <v-card-actions class="stop-dialog-actions">
          <v-spacer />
          <v-btn variant="text" :disabled="isStoppingTeam" @click="showStopDialog = false">取消</v-btn>
          <v-btn color="error" variant="tonal" :loading="isStoppingTeam" @click="handleStopTeam">停止团队</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.team-dashboard {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: #ffffff;
}

.team-alert {
  flex-shrink: 0;
  margin: var(--pix-space-sm);
}

.team-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--pix-space-sm);
  color: var(--pix-text-secondary);
}

.team-empty-icon,
.workbench-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: var(--pix-radius-lg);
  background: #eef7f2;
  color: #15805f;
}

.team-empty strong {
  font-size: var(--pix-text-sm);
}

.team-loading-icon {
  color: var(--pix-accent);
  animation: team-spin 900ms linear infinite;
}

@keyframes team-spin {
  to { transform: rotate(360deg); }
}

.workbench-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--pix-space-md);
  min-height: 62px;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border-bottom: 1px solid var(--pix-border-subtle);
  flex-shrink: 0;
}

.workbench-title {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  min-width: 0;
}

.workbench-mark {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
}

.workbench-title-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.workbench-title-copy strong,
.workbench-title-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workbench-title-copy strong {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
}

.workbench-title-copy span {
  color: var(--pix-text-muted);
  font-size: 10px;
}

.team-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-bottom: 1px solid var(--pix-border-subtle);
  flex-shrink: 0;
}

.team-metric {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 7px 9px;
  color: var(--pix-text-secondary);
  font-size: 10px;
}

.team-metric + .team-metric {
  border-left: 1px solid var(--pix-border-subtle);
}

.team-metric span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.team-metric strong {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-sm);
}

.team-metric--green { color: var(--pix-success); }
.team-metric--blue { color: #2563eb; }
.team-metric--amber { color: var(--pix-warning); }
.team-metric--red { color: var(--pix-error); }

.workbench-tabs {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 3px;
  padding: 5px var(--pix-space-sm);
  border-bottom: 1px solid var(--pix-border-subtle);
  background: #fafbfc;
  flex-shrink: 0;
}

.workbench-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  min-height: 30px;
  padding: 4px 6px;
  border-radius: var(--pix-radius-md);
  color: var(--pix-text-muted);
  font-size: 10px;
  font-weight: var(--pix-weight-medium);
}

.workbench-tab:hover {
  color: var(--pix-text-primary);
  background: var(--pix-bg-hover);
}

.workbench-tab.active {
  color: var(--pix-accent);
  background: #ffffff;
  box-shadow: var(--pix-shadow-xs);
}

.workbench-tab > span:not(.workbench-tab-count) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workbench-tab-count {
  min-width: 16px;
  padding: 1px 4px;
  border-radius: 8px;
  background: var(--pix-bg-active);
  color: inherit;
  font-size: 9px;
  line-height: 14px;
}

.workbench-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.workbench-body--activity {
  display: flex;
  overflow: hidden;
}

.workbench-section {
  min-height: 100%;
  padding: var(--pix-space-md);
}

.section-heading,
.activity-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--pix-space-sm);
  margin-bottom: var(--pix-space-sm);
}

.section-heading > div,
.activity-toolbar > div:first-child {
  display: flex;
  flex-direction: column;
}

.section-heading strong,
.activity-toolbar strong {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
}

.section-heading span,
.activity-toolbar span {
  color: var(--pix-text-muted);
  font-size: 10px;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.task-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--pix-space-sm);
  width: 100%;
  padding: 9px 8px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
  background: #ffffff;
  text-align: left;
}

.task-row--actionable:hover {
  border-color: var(--pix-border);
  background: var(--pix-bg-hover);
}

.task-row:disabled {
  opacity: 1;
}

.task-copy,
.task-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.task-copy strong,
.task-copy span,
.task-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-copy strong {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
}

.task-copy span,
.task-copy small,
.task-meta span {
  color: var(--pix-text-muted);
  font-size: 9px;
}

.task-copy small {
  color: var(--pix-text-secondary);
}

.task-meta {
  align-items: flex-end;
  flex-shrink: 0;
}

.task-meta strong {
  color: var(--pix-text-secondary);
  font-size: 10px;
  font-weight: var(--pix-weight-medium);
  text-transform: capitalize;
}

.task-status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 54px;
  min-height: 20px;
  padding: 2px 6px;
  border-radius: var(--pix-radius-sm);
  font-size: 9px;
  font-weight: var(--pix-weight-semibold);
}

.task-status--blue { background: #eff6ff; color: #2563eb; }
.task-status--cyan { background: #ecfeff; color: #0891b2; }
.task-status--grey { background: var(--pix-bg-hover); color: var(--pix-text-secondary); }
.task-status--amber { background: var(--pix-warning-bg); color: var(--pix-warning); }
.task-status--red { background: var(--pix-error-bg); color: var(--pix-error); }
.task-status--green { background: var(--pix-success-bg); color: var(--pix-success); }

.workbench-empty {
  display: flex;
  min-height: 180px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--pix-space-xs);
  color: var(--pix-success);
}

.workbench-empty strong {
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-sm);
}

.workbench-activity,
.workbench-messages {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.activity-toggle {
  display: inline-flex;
  flex-direction: row !important;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-hover);
}

.activity-toggle button {
  min-height: 24px;
  padding: 3px 8px;
  border-radius: var(--pix-radius-sm);
  color: var(--pix-text-secondary);
  font-size: 10px;
}

.activity-toggle button.active {
  background: #ffffff;
  color: var(--pix-accent);
  box-shadow: var(--pix-shadow-xs);
}

.stop-dialog-card {
  padding: var(--pix-space-lg);
  border-radius: var(--pix-radius-xl) !important;
}

.stop-dialog-title {
  margin-bottom: var(--pix-space-sm);
  color: var(--pix-text-primary);
  font-size: var(--pix-text-md);
  font-weight: var(--pix-weight-semibold);
}

.stop-dialog-text {
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-sm);
  line-height: 1.5;
}

.stop-dialog-actions {
  padding: var(--pix-space-sm) 0 0 !important;
}

@media (max-width: 1280px) {
  .workbench-tab {
    padding-right: 3px;
    padding-left: 3px;
  }

  .team-metric span {
    display: none;
  }

  .team-metric {
    grid-template-columns: auto auto;
    justify-content: center;
  }
}
</style>
