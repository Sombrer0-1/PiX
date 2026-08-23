<script setup lang="ts">
/**
 * AgentTaskLauncher - 任务启动器（右栏 Agent 任务卡，PiX 1.5 P2）
 *
 * 右栏入口层:状态行（「● N 运行中 · M 等待输入」，点击 openTaskCenter() 打开
 * 任务中心）、activeInputRequests 的 InputCard 直渲染、AgentTaskNotificationCenter
 * 唯一挂载、存储警告/满横幅（被动提示，自旧 AgentTaskPanel 迁入）。
 *
 * 会话隔离(与任务中心默认作用域一致):状态行计数只统计当前会话的任务;
 * 其他会话存在活跃任务时显示次级提示行「+N 个其他会话任务」,点击经
 * openTaskCenter(其他会话任务 id) 打开中心(深链规则自动切「全部」作用域)。
 * 当前会话未定(切换空窗期)时计数回退为全局,与中心过滤回退一致。
 * InputCard 与通知中心保持全局——审批是最短路径,隔离会让后台任务无限期卡死;
 * 完成通知是 app 级语义(瞬时、10 条封顶)。
 *
 * subscribeToEvents 的唯一挂载点（AgentTaskPanel 删除后）:onMounted 订阅、
 * onUnmounted 退订——任务镜像、输入请求与 retention task_removed 全部依赖它。
 */
import { computed, onMounted, onUnmounted } from "vue";
import { useAgentTaskStore } from "../../stores/agent-task-store";
import { useProjectStore } from "../../stores/project-store";
import { useTeamStore } from "../../stores/team-store";
import AgentTaskInputCard from "./AgentTaskInputCard.vue";
import AgentTaskNotificationCenter from "./AgentTaskNotificationCenter.vue";

defineProps<{
  /** 当前 workspace 的 sessionId -> 会话名（内容由 NotificationCenter 消费，保留按 4.9 契约）。 */
  sessionNames?: Record<string, string>;
}>();

const store = useAgentTaskStore();
const projectStore = useProjectStore();
const teamStore = useTeamStore();

/** 与 TaskCenterView 同源:team 模式取 leader 会话;切换空窗期为 null。 */
const currentSessionId = computed(
  () => (teamStore.teamMode ? projectStore.currentTeamSession?.id : projectStore.currentSession?.id) ?? null,
);

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "waiting_input"]);

/** 当前会话作用域内的活跃任务(null 时为全局,与中心过滤回退一致)。 */
const scopedActiveTasks = computed(() => {
  const sessionId = currentSessionId.value;
  return store.tasks.filter(
    (task) => ACTIVE_STATUSES.has(task.status) && (sessionId === null || task.parentSessionId === sessionId),
  );
});

/** 其他会话的活跃任务(仅当前会话已定时才有意义)。 */
const otherSessionActiveTasks = computed(() => {
  const sessionId = currentSessionId.value;
  if (sessionId === null) return [];
  return store.tasks.filter((task) => ACTIVE_STATUSES.has(task.status) && task.parentSessionId !== sessionId);
});

const runningCount = computed(() => scopedActiveTasks.value.filter((task) => task.status === "running").length);
const waitingCount = computed(() => scopedActiveTasks.value.filter((task) => task.status === "waiting_input").length);
const hasActive = computed(() => scopedActiveTasks.value.length > 0);

/** 状态行文本：「● N 运行中 · M 等待输入」；无活跃任务时显示空闲。 */
const statusLine = computed(() => {
  if (!hasActive.value) return "暂无运行任务";
  return `${runningCount.value} 运行中 · ${waitingCount.value} 等待输入`;
});

/**
 * 提示行深链目标:优先 waiting_input(最紧急),否则镜像序(createdAt 升序)首个。
 * 经 openTaskCenter(id) 触发中心深链规则 → 作用域切「全部」并定位该任务。
 */
const otherSessionHintTarget = computed(() => {
  const list = otherSessionActiveTasks.value;
  return list.find((task) => task.status === "waiting_input") ?? list[0] ?? null;
});

function openOtherSessions(): void {
  const target = otherSessionHintTarget.value;
  if (target) {
    store.openTaskCenter(target.taskId);
  } else {
    store.openTaskCenter();
  }
}

function storagePercent(status: { usedBytes: number; reservedBytes: number; limitBytes: number }): number {
  if (status.limitBytes <= 0) return 0;
  return Math.min(100, Math.round(((status.usedBytes + status.reservedBytes) / status.limitBytes) * 100));
}

// 挂载时订阅 agent-task 事件（store 内部处理重挂载去重）；卸载时退订。
let unsubscribeEvents: (() => void) | null = null;
onMounted(() => {
  unsubscribeEvents = store.subscribeToEvents();
});
onUnmounted(() => {
  unsubscribeEvents?.();
  unsubscribeEvents = null;
});
</script>

<template>
  <section class="agent-task-launcher" data-test="agent-task-launcher" aria-label="Agent 任务">
    <!-- 状态行:点击打开任务中心 -->
    <button
      type="button"
      class="agent-task-status-line"
      data-test="agent-task-status-line"
      :aria-label="`${statusLine}，打开任务中心`"
      @click="store.openTaskCenter()"
    >
      <span class="agent-task-status-dot" :class="{ active: hasActive }"></span>
      <span class="agent-task-status-text" data-test="agent-task-status-text">{{ statusLine }}</span>
      <v-icon icon="mdi-chevron-right" size="13" aria-hidden="true" />
    </button>

    <!-- 其他会话的活跃任务:次级提示行,点击深链任务中心(自动切「全部」作用域) -->
    <button
      v-if="otherSessionActiveTasks.length > 0"
      type="button"
      class="agent-task-other-sessions"
      data-test="agent-task-launcher-other-sessions"
      :title="`其他会话有 ${otherSessionActiveTasks.length} 个活跃任务,点击在任务中心查看`"
      @click="openOtherSessions"
    >
      <v-icon icon="mdi-open-in-new" size="12" aria-hidden="true" />
      <span>+{{ otherSessionActiveTasks.length }} 个其他会话任务</span>
    </button>

    <!-- 待审批输入:InputCard 直渲染 -->
    <div v-if="store.activeInputRequests.length > 0" class="agent-task-launcher-inputs" data-test="agent-task-launcher-inputs">
      <AgentTaskInputCard
        v-for="request in store.activeInputRequests"
        :key="`${request.taskId}:${request.requestId}:${request.generation}`"
        :request="request"
      />
    </div>

    <!-- 通知中心:唯一挂载点 -->
    <AgentTaskNotificationCenter />

    <!-- 存储状态:80% 阈值提示;满后为被动提示(自动回收在 main 触发) -->
    <div v-if="store.storageWarnings.length > 0" class="agent-task-storage-warning" data-test="agent-task-storage-warning" role="status">
      存储空间已达 {{ storagePercent(store.storageWarnings[0]) }}%，超出保留策略的终态任务将被自动回收。
    </div>
    <div v-if="store.storageFulls.length > 0" class="agent-task-storage-full" data-test="agent-task-storage-full" role="alert">
      存储空间已满（{{ storagePercent(store.storageFulls[0]) }}%）：新任务暂不可启动，紧急自动回收已触发，超出保留窗口的终态任务记录将被清理。
    </div>
  </section>
</template>

<style scoped>
.agent-task-launcher {
  min-width: 0;
}

.agent-task-status-line {
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
  cursor: pointer;
  margin-bottom: var(--pix-space-sm);
  transition: background var(--pix-transition-fast), border-color var(--pix-transition-fast);
}

.agent-task-status-line:hover {
  border-color: var(--pix-accent-light);
  background: var(--pix-accent-light);
}

.agent-task-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--pix-text-muted);
}

.agent-task-status-dot.active {
  background: var(--pix-accent);
  animation: status-pulse 1.5s ease-in-out infinite;
}

@keyframes status-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.agent-task-status-text {
  flex: 1;
  min-width: 0;
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 其他会话活跃任务提示行:次级、弱于主状态行 */
.agent-task-other-sessions {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 2px var(--pix-space-sm);
  margin-bottom: var(--pix-space-sm);
  border: none;
  border-radius: var(--pix-radius-sm);
  background: transparent;
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
  font-family: var(--pix-font-ui);
  text-align: left;
  cursor: pointer;
}

.agent-task-other-sessions:hover {
  color: var(--pix-accent);
  background: var(--pix-accent-light);
}

.agent-task-launcher-inputs {
  margin-bottom: var(--pix-space-sm);
}

.agent-task-storage-warning {
  margin-bottom: var(--pix-space-sm);
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border: 1px solid var(--pix-warning-light);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-warning-light);
  font-size: var(--pix-text-xs);
  color: var(--pix-warning);
}

.agent-task-storage-full {
  margin-bottom: var(--pix-space-sm);
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border: 1px solid var(--pix-error-light);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-error-bg);
  font-size: var(--pix-text-xs);
  color: var(--pix-error);
}
</style>
