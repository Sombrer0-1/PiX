<script setup lang="ts">
/**
 * WorkerDetailCard - worker/team detail card.
 *
 * Primarily observation: coordination happens through the Leader in the main
 * conversation. A small set of lifecycle controls (abort turn, restart, wake)
 * is exposed for direct intervention when a worker misbehaves.
 */
import { computed, onUnmounted, ref, watch } from "vue";
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

// Runtime display must tick while a worker is running; Date.now() is not a
// reactive dependency, so drive elapsed time from a `now` ref updated by a
// 1s interval that only runs while the focused agent is in "running" state.
const now = ref(Date.now());
let runtimeTimer: ReturnType<typeof setInterval> | undefined;

function startRuntimeTick(): void {
  if (runtimeTimer) return;
  runtimeTimer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
}

function stopRuntimeTick(): void {
  if (runtimeTimer) {
    clearInterval(runtimeTimer);
    runtimeTimer = undefined;
  }
}

const isRunning = computed(() => focusedAgent.value?.status === "running");

watch(
  isRunning,
  (running) => {
    if (running) {
      now.value = Date.now();
      startRuntimeTick();
    } else {
      stopRuntimeTick();
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  stopRuntimeTick();
});

const runtime = computed(() => {
  const agent = focusedAgent.value;
  if (!agent?.statusChangedAt) return "";
  const ms = now.value - agent.statusChangedAt;
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟`;
  return `${Math.floor(ms / 3_600_000)} 小时 ${Math.floor((ms % 3_600_000) / 60_000)} 分钟`;
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
    case "running": return "工作中";
    case "idle": return "就绪";
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
      <span v-if="focusedAgent">成员详情</span>
      <span v-else>团队概览</span>
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
          <span class="info-label">角色</span>
          <span class="info-value">{{ roleLabel(focusedAgent.role) }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">模型</span>
          <span class="info-value">{{ focusedAgent.model ?? "默认" }}</span>
        </div>
        <div v-if="focusedAgent.status === 'running' && runtime" class="info-row">
          <span class="info-label">运行时长</span>
          <span class="info-value">{{ runtime }}</span>
        </div>
        <div v-if="focusedAgent.specialization" class="info-row info-row--stack">
          <span class="info-label">专长</span>
          <span class="info-value wd-activity">{{ focusedAgent.specialization }}</span>
        </div>
        <div v-if="activity" class="info-row info-row--stack">
          <span class="info-label">当前活动</span>
          <span class="info-value wd-activity">{{ activity }}</span>
        </div>
        <div v-if="focusedAgent.error" class="info-row info-row--stack">
          <span class="info-label error-label">错误</span>
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
          停止本轮
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
          重启
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
          唤醒
        </v-btn>
      </div>

      <div class="wd-note">
        请通过主对话中的团队负责人进行协调。
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
