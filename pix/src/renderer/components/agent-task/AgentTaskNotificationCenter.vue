<script setup lang="ts">
/**
 * AgentTaskNotificationCenter - 应用内任务通知中心（PiX 1.4.1）
 *
 * 展示 waiting_input / completed / failed 三类应用内通知与入口计数。1.5 (P2)
 * 起唯一挂载于 AgentTaskLauncher（右栏启动器内部），点击通知经
 * store.openTaskCenter(taskId) 打开任务中心并定位该任务——终态任务由
 * TaskCenterView 自动切历史视图并高亮。全局仅此一处挂载。
 *
 * 可访问性：错误（failed）用 role="alert" 的 live region，普通状态
 * （waiting_input/completed）用 aria-live="polite"；每条的图标带 title 与
 * aria-label。普通进度（running/queued）不产生通知，不做 OS 级通知。
 *
 * 通知列表是组件本地状态：watch store.tasks 的状态迁移（waiting_input /
 * completed / failed 进入才记录），按 MAX_NOTIFICATIONS 封顶，因此任意规模
 * 的任务镜像不会产生无界 DOM。store 的 bulkHydrationVersion 变化（get_all
 * 批量替换镜像）时只重建基线不推通知——否则启动/重挂载时会把恢复出的
 * 历史终态任务当作新状态迁移洪泛弹通知。
 */
import { computed, ref, watch } from "vue";
import { useAgentTaskStore } from "../../stores/agent-task-store";
import type { AgentTaskInfo, AgentTaskStatus } from "@shared/agent-task-types.js";

/** 通知堆叠最大条数（增量渲染 + 封顶，不做虚拟滚动库）。 */
const MAX_NOTIFICATIONS = 10;

type NotifyStatus = "waiting_input" | "completed" | "failed";

interface NotificationEntry {
  taskId: string;
  status: NotifyStatus;
  at: number;
  updatedAt: number;
  description: string;
}

const store = useAgentTaskStore();

const NOTIFY_ICONS: Record<NotifyStatus, string> = {
  waiting_input: "mdi-help-circle-outline",
  completed: "mdi-check-circle-outline",
  failed: "mdi-alert-circle-outline",
};

const NOTIFY_LABELS: Record<NotifyStatus, string> = {
  waiting_input: "需要输入",
  completed: "已完成",
  failed: "失败",
};

const notifications = ref<NotificationEntry[]>([]);

const NOTIFY_STATUSES: ReadonlySet<AgentTaskStatus> = new Set(["waiting_input", "completed", "failed"]);

/** 状态迁移键；普通进度（running/queued）不在其中，不产生通知。 */
function isNotifyStatus(status: AgentTaskStatus): status is NotifyStatus {
  return NOTIFY_STATUSES.has(status);
}

function pushNotification(task: AgentTaskInfo): void {
  if (!isNotifyStatus(task.status)) return;
  const last = notifications.value[0];
  // 同一任务同一状态的同一转换只通知一次（重复事件幂等）；updatedAt 每次
  // 状态转换都会更新，同状态的不同次转换（如第二轮 waiting_input）仍产生
  // 新通知，同一快照的重复事件（updatedAt 相同）仍被去重。
  if (last && last.taskId === task.taskId && last.status === task.status && last.updatedAt === task.updatedAt) return;
  notifications.value = [
    { taskId: task.taskId, status: task.status, at: Date.now(), updatedAt: task.updatedAt, description: task.description },
    ...notifications.value,
  ].slice(0, MAX_NOTIFICATIONS);
}

let seenStatuses = new Map<string, string>();
// 挂载时刻的水合版本快照：若 store 在挂载前已完成批量水合，直接以其为基线。
let seenBulkVersion = store.bulkHydrationVersion;

watch(
  () => store.tasks,
  (tasks) => {
    const bulkVersion = store.bulkHydrationVersion;
    if (bulkVersion !== seenBulkVersion) {
      // get_all 批量替换镜像（重挂载补偿/启动恢复）：本次观察整体作为
      // 基线，只重建 seenStatuses 不推通知，避免历史终态任务洪泛通知。
      seenStatuses = new Map(tasks.map((task) => [task.taskId, task.status]));
      seenBulkVersion = bulkVersion;
      return;
    }
    for (const task of tasks) {
      const previous = seenStatuses.get(task.taskId);
      if (previous !== task.status) {
        seenStatuses.set(task.taskId, task.status);
        pushNotification(task);
      }
    }
    // 已从镜像移除（clear）的任务不再保留本地通知。
    const liveIds = new Set(tasks.map((t) => t.taskId));
    for (const taskId of [...seenStatuses.keys()]) {
      if (!liveIds.has(taskId)) seenStatuses.delete(taskId);
    }
  },
  { deep: true },
);

/** 需要处理的实时计数（waiting_input 任务）。 */
const waitingCount = computed(() => store.waitingTasks.length);

/** 本地通知中 completed 的计数。 */
const completedCount = computed(() => notifications.value.filter((n) => n.status === "completed").length);

/** 本地通知中 failed 的计数。 */
const failedCount = computed(() => notifications.value.filter((n) => n.status === "failed").length);

/** 最近的普通状态通知（polite live region 内容）。 */
const latestNormal = computed(() => {
  const entry = notifications.value.find((n) => n.status === "waiting_input" || n.status === "completed");
  return entry ? `${NOTIFY_LABELS[entry.status]}：${entry.description || entry.taskId}` : "";
});

/** 最近的失败通知（alert live region 内容）。 */
const latestFailed = computed(() => {
  const entry = notifications.value.find((n) => n.status === "failed");
  return entry ? `任务失败：${entry.description || entry.taskId}` : "";
});

function openTask(taskId: string): void {
  store.openTaskCenter(taskId);
}

function truncateText(text: string, maxLength: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  return `${chars.slice(0, maxLength).join("")}…`;
}
</script>

<template>
  <section class="agent-task-notification-center" data-test="agent-task-notification-center" :aria-label="`任务通知：需要输入 ${waitingCount}，已完成 ${completedCount}，失败 ${failedCount}`">
    <div class="agent-task-notification-counts" data-test="agent-task-notification-counts">
      <span class="agent-task-notification-count" data-test="agent-task-notification-waiting-count">需要输入 {{ waitingCount }}</span>
      <span class="agent-task-notification-count" data-test="agent-task-notification-completed-count">已完成 {{ completedCount }}</span>
      <span class="agent-task-notification-count" data-test="agent-task-notification-failed-count">失败 {{ failedCount }}</span>
    </div>

    <div v-if="notifications.length > 0" class="agent-task-notification-stack" data-test="agent-task-notification-stack">
      <button
        v-for="entry in notifications"
        :key="`${entry.taskId}:${entry.status}:${entry.updatedAt}`"
        type="button"
        class="agent-task-notification-entry"
        :class="`status-${entry.status}`"
        :data-test="`agent-task-notification-${entry.taskId}`"
        :aria-label="`${NOTIFY_LABELS[entry.status]}：${entry.description || entry.taskId}，点击查看任务`"
        :title="`${NOTIFY_LABELS[entry.status]}：${entry.description || entry.taskId}`"
        @click="openTask(entry.taskId)"
      >
        <v-icon :icon="NOTIFY_ICONS[entry.status]" size="13" :title="NOTIFY_LABELS[entry.status]" aria-hidden="true" />
        <span class="agent-task-notification-status">{{ NOTIFY_LABELS[entry.status] }}</span>
        <span class="agent-task-notification-desc">{{ truncateText(entry.description || entry.taskId, 32) }}</span>
        <span class="agent-task-notification-jump">查看</span>
      </button>
    </div>

    <!-- 普通状态用 polite live region；错误用 alert -->
    <div class="agent-task-live-region" aria-live="polite" data-test="agent-task-live-region">{{ latestNormal }}</div>
    <div class="agent-task-live-region" role="alert" data-test="agent-task-alert-region">{{ latestFailed }}</div>
  </section>
</template>

<style scoped>
.agent-task-notification-center {
  min-width: 0;
  margin-bottom: var(--pix-space-sm);
}

.agent-task-notification-counts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 10px;
  color: var(--pix-text-muted);
  margin-bottom: var(--pix-space-xs);
}

.agent-task-notification-count {
  font-variant-numeric: tabular-nums;
}

/* 固定高度 + 滚动：通知列表封顶 MAX_NOTIFICATIONS，任意规模镜像不撑破布局 */
.agent-task-notification-stack {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-xs);
  max-height: 180px;
  overflow-y: auto;
}

.agent-task-notification-entry {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  background: rgba(255, 255, 255, 0.6);
  color: var(--pix-text-primary);
  font-family: var(--pix-font-ui);
  text-align: left;
  min-width: 0;
}

.agent-task-notification-entry:hover {
  background: var(--pix-accent-light);
}

.agent-task-notification-entry.status-failed {
  border-color: var(--pix-error-light);
  background: var(--pix-error-bg);
}

.agent-task-notification-entry.status-waiting_input {
  border-color: var(--pix-warning-light);
  background: var(--pix-warning-light);
}

.agent-task-notification-status {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--pix-bg-code);
  color: var(--pix-text-secondary);
  white-space: nowrap;
}

.agent-task-notification-entry.status-completed .agent-task-notification-status {
  color: var(--pix-success);
  background: var(--pix-success-light);
}

.agent-task-notification-entry.status-failed .agent-task-notification-status {
  color: var(--pix-error);
  background: var(--pix-error-light);
}

.agent-task-notification-entry.status-waiting_input .agent-task-notification-status {
  color: var(--pix-warning);
  background: #ffffff;
}

.agent-task-notification-desc {
  flex: 1;
  min-width: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-task-notification-jump {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-accent);
  font-weight: var(--pix-weight-medium);
}

/* 无障碍 live region：视觉上占位但始终存在（内容为空时无影响） */
.agent-task-live-region {
  position: fixed;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
