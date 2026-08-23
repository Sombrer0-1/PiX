<script setup lang="ts">
/**
 * TaskDetailPanel - 任务详情 tabs 容器（PiX 1.5 P2; P3 起含工作记录 tab;P4 起含
 * 文件变更 tab）
 *
 * 任务中心 master-detail 的详情区。tabs:摘要(始终)| 工作记录(P3)| 文件变更(P4)。
 * 摘要 tab 顶部为该任务的 activeInputRequests（store.activeInputRequests
 * 按 taskId 过滤，审批在摘要最短路径可及），主体为 AgentTaskDetail（只读展示 +
 * 任务对应 recovery issue 诊断行）。原始事件 tab 已按产品决策移除（debug 价值低;
 * get_task_log 链路保留,文件变更 tab 依赖它;排障经 issue 行的导出诊断）。
 *
 * watcher 所有者（锁死）:onMounted 与 task 变更时 → store.watchTask(task.taskId);
 * onUnmounted / task 变更前 → store.unwatchTask(旧 taskId)。工作记录与文件变更
 * tab 共用此订阅（直接打开文件变更 tab 同样收到直播）;终态时 main 已清 watcher
 * 并停转发,卸载时仍补发 unwatch 命令（双保险幂等），终态观察期间无 runtime，
 * watch 无效果但幂等。
 *
 * TaskTranscriptView 以 :key="`${task.taskId}:${itemIndex}`" 渲染,taskId/itemIndex
 * 变更即整体重挂载,杜绝旧任务 blocks/游标残留(无 Vue 复用路径)。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useAgentTaskStore } from "../../stores/agent-task-store";
import AgentTaskDetail from "./AgentTaskDetail.vue";
import AgentTaskInputCard from "./AgentTaskInputCard.vue";
import TaskFileChanges from "./TaskFileChanges.vue";
import TaskTranscriptView from "./TaskTranscriptView.vue";
import type { AgentTaskInfo, AgentTaskStatus } from "@shared/agent-task-types.js";

const TERMINAL_STATUSES: ReadonlySet<AgentTaskStatus> = new Set(["completed", "failed", "cancelled"]);

const props = defineProps<{
  task: AgentTaskInfo;
  /** sessionId -> 会话名，用于展示来源会话。 */
  sessionNames?: Record<string, string>;
}>();

const store = useAgentTaskStore();

type DetailTab = "summary" | "transcript" | "files";

const activeTab = ref<DetailTab>("summary");

/** 当前工作记录 item(chain 任务由 TaskTranscriptView 子 tab 上报;0 缺省)。 */
const transcriptItemIndex = ref(0);

/** 摘要 tab 顶部:该任务的待审批输入。 */
const taskInputRequests = computed(() =>
  store.activeInputRequests.filter((request) => request.taskId === props.task.taskId),
);

// ==========================================================================
// watcher 所有权(工作记录 + 文件变更共用)
// ==========================================================================

function attachWatcher(taskId: string): void {
  void store.watchTask(taskId);
}

function detachWatcher(taskId: string): void {
  store.unwatchTask(taskId);
}

watch(
  () => props.task.taskId,
  (taskId, prevTaskId) => {
    if (prevTaskId && prevTaskId !== taskId) {
      detachWatcher(prevTaskId);
    }
    attachWatcher(taskId);
    transcriptItemIndex.value = 0;
  },
);

// 终态收敛(main 侧已清 watcher):本地补发 unwatch 命令,幂等。
watch(
  () => props.task.status,
  (status) => {
    if (TERMINAL_STATUSES.has(status)) {
      detachWatcher(props.task.taskId);
    }
  },
);

onMounted(() => {
  attachWatcher(props.task.taskId);
});

onBeforeUnmount(() => {
  detachWatcher(props.task.taskId);
});
</script>

<template>
  <div class="task-detail-panel" data-test="task-detail-panel">
    <div class="task-detail-tabs" role="tablist" aria-label="任务详情">
      <button
        type="button"
        class="task-detail-tab"
        :class="{ active: activeTab === 'summary' }"
        role="tab"
        :aria-selected="activeTab === 'summary'"
        data-test="task-detail-tab-summary"
        @click="activeTab = 'summary'"
      >
        摘要
      </button>
      <button
        type="button"
        class="task-detail-tab"
        :class="{ active: activeTab === 'transcript' }"
        role="tab"
        :aria-selected="activeTab === 'transcript'"
        data-test="task-detail-tab-transcript"
        @click="activeTab = 'transcript'"
      >
        工作记录
      </button>
      <button
        type="button"
        class="task-detail-tab"
        :class="{ active: activeTab === 'files' }"
        role="tab"
        :aria-selected="activeTab === 'files'"
        data-test="task-detail-tab-files"
        @click="activeTab = 'files'"
      >
        文件变更
      </button>
    </div>
    <div class="task-detail-body" :class="{ 'task-detail-body-transcript': activeTab === 'transcript' }">
      <TaskTranscriptView
        v-if="activeTab === 'transcript'"
        :key="`${props.task.taskId}:${transcriptItemIndex}`"
        :task="props.task"
        :item-index="transcriptItemIndex"
        @item-change="transcriptItemIndex = $event"
      />
      <TaskFileChanges v-else-if="activeTab === 'files'" :task="props.task" />
      <template v-else>
        <div v-if="taskInputRequests.length > 0" class="task-detail-inputs" data-test="task-detail-inputs">
          <AgentTaskInputCard
            v-for="request in taskInputRequests"
            :key="`${request.taskId}:${request.requestId}:${request.generation}`"
            :request="request"
          />
        </div>
        <AgentTaskDetail :task="props.task" :session-names="props.sessionNames" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.task-detail-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--pix-bg-content);
}

.task-detail-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 var(--pix-space-md);
  border-bottom: 1px solid var(--pix-border-light);
  flex-shrink: 0;
}

.task-detail-tab {
  padding: 7px 12px 9px;
  font-size: var(--pix-text-sm);
  font-family: var(--pix-font-ui);
  color: var(--pix-text-secondary);
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color var(--pix-transition-fast), border-color var(--pix-transition-fast);
}

.task-detail-tab:hover {
  color: var(--pix-text-primary);
}

.task-detail-tab.active {
  color: var(--pix-accent);
  border-bottom-color: var(--pix-accent);
  font-weight: var(--pix-weight-medium);
}

.task-detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--pix-space-md);
}

/* 工作记录 tab:内容区交给 TaskTranscriptView 自持滚动容器 */
.task-detail-body-transcript {
  overflow: hidden;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.task-detail-inputs {
  margin-bottom: var(--pix-space-md);
}
</style>
