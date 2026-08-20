<script setup lang="ts">
/**
 * AgentTaskPanel - 全局任务面板（PiX 1.4.1；1.4.2 R5 加入恢复/清理）
 *
 * 挂载于 RightPanel 的 Agent 任务卡内，分组顺序：需要处理（waiting_input）、
 * 已中断（interrupted，1.4.2 重启水合）、进行中（running+queued）、最近完成
 * （completed/failed/cancelled，store 已按 AGENT_TASK_MAX_RECENT_ACTIVITIES
 * 封顶）。每行稳定展示状态文字（图标+文字，不只靠颜色）、agent、摘要、来源
 * 会话、用时、模型、成本与 queue/占槽提示；行内提供当前状态对应的操作按钮
 * （取消/中止、转后台、继续前台等待、续接/标记失败、清除），点击行主体展开
 * AgentTaskDetail。
 *
 * 1.4.2 恢复/清理：
 * - 已中断任务提供「续接」「标记失败」「清除」行内操作；续接经 detail 先取得
 *   恢复摘要，用户确认 workspace 变化/模型决策后才发 resume（摘要先于确认）。
 * - 存储状态（80% 阈值提示；满后拒绝启动横幅 + 清理入口）来自
 *   storage_status 事件镜像。
 * - recovery issue 独立分组只读展示（代码/消息/只读标记），提供导出诊断与
 *   清理入口，不影响其他任务。
 * - 单项清理只对终态/已中断开放，运行中一律拒绝；planLinkState=pending 的
 *   任务受 Plan 保护不可清理。clearAllTerminal 只清理终态，返回的
 *   protectedTaskIds（已中断/损坏记录）必须明示未删除。
 *
 * 性能：不引入虚拟滚动库。每个分组列表是固定高度的稳定滚动容器
 * （max-height + overflow-y auto），需要处理/已中断/进行中只渲染前
 * MAX_GROUP_ROWS 行并提供溢出计数，最近完成由 store 封顶，因此任意规模
 * 的任务镜像（含 500 task）都不会产生无界 DOM。任务输入请求经
 * AgentTaskInputCard 渲染在本面板的「需要处理」分组顶部（taskId+requestId+
 * generation 三元展示，respond_input 由卡片发出）。
 *
 * 所有操作按钮至少展示 300ms 忙碌状态并防重复提交；清除操作必须二次确认
 * （confirmDataLoss）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useAgentTaskStore } from "../../stores/agent-task-store";
import AgentTaskDetail from "./AgentTaskDetail.vue";
import AgentTaskInputCard from "./AgentTaskInputCard.vue";
import type {
  AgentTaskClearAllResult,
  AgentTaskDiagnosticExport,
  AgentTaskInfo,
  AgentTaskRecoveryIssue,
  AgentTaskStatus,
} from "@shared/agent-task-types.js";

const props = defineProps<{
  /** 当前打开的 Solo 会话 id（供详情「发送到当前会话」）。 */
  currentSessionId?: string | null;
  /** 当前项目物理路径，用于同 workspace 发送判断。 */
  currentProjectPhysicalPath?: string | null;
  /** 当前 workspace 的 sessionId -> 会话名，用于展示来源会话。 */
  sessionNames?: Record<string, string>;
}>();

const store = useAgentTaskStore();

const STATUS_META: Record<AgentTaskStatus, { label: string; icon: string }> = {
  queued: { label: "排队中", icon: "mdi-clock-outline" },
  running: { label: "运行中", icon: "mdi-loading" },
  waiting_input: { label: "等待输入", icon: "mdi-help-circle-outline" },
  interrupted: { label: "已中断", icon: "mdi-pause-circle-outline" },
  completed: { label: "已完成", icon: "mdi-check-circle-outline" },
  failed: { label: "失败", icon: "mdi-alert-circle-outline" },
  cancelled: { label: "已取消", icon: "mdi-cancel" },
};

const RECOVERY_ISSUE_LABELS: Record<string, string> = {
  tail_corrupt: "日志尾部损坏",
  mid_log_corrupt: "日志中段损坏",
  session_header_corrupt: "会话头损坏",
  index_corrupt: "索引损坏",
  unknown_schema: "未知 schema 版本",
  migration_failed: "迁移失败",
};

/** 每个分组列表最多渲染的行数（增量渲染 + 窗口化，不做虚拟滚动库）。 */
const MAX_GROUP_ROWS = 50;
/** 繁忙操作至少展示的进度时长，避免闪烁。 */
const MIN_BUSY_MS = 300;

/** 清除确认的目标（任务行或 recovery issue），统一二次确认入口。 */
interface ClearTarget {
  taskId: string;
  generation: number;
  description: string;
}

const collapsed = ref(false);
const busyKey = ref<string | null>(null);
const confirmClearTarget = ref<ClearTarget | null>(null);
/** 行内「续接」点击后传给详情的一次性意图（详情挂载时消费，消费后经 resume-intent-consumed 重置）。 */
const resumeIntentTaskId = ref<string | null>(null);
const clearAllOpen = ref(false);
const clearAllResult = ref<AgentTaskClearAllResult | null>(null);
const clearAllError = ref<string | null>(null);

// 需要处理/已中断/进行中分组只渲染前 MAX_GROUP_ROWS 行；最近完成由 store 封顶。
const visibleWaiting = computed(() => store.waitingTasks.slice(0, MAX_GROUP_ROWS));
const visibleInterrupted = computed(() => store.interruptedTasks.slice(0, MAX_GROUP_ROWS));
const visibleActive = computed(() => store.activeTasks.slice(0, MAX_GROUP_ROWS));
const waitingOverflow = computed(() => Math.max(0, store.waitingTasks.length - MAX_GROUP_ROWS));
const interruptedOverflow = computed(() => Math.max(0, store.interruptedTasks.length - MAX_GROUP_ROWS));
const activeOverflow = computed(() => Math.max(0, store.activeTasks.length - MAX_GROUP_ROWS));

const waitingCount = computed(() => store.waitingTasks.length);
const interruptedCount = computed(() => store.interruptedTasks.length);
const activeCount = computed(() => store.activeTasks.length);
const recentCount = computed(() => store.recentTasks.length);

// 通知中心经 store.selectTask 选中任务时，自动展开面板并定位到详情。
watch(
  () => store.selectedTaskId,
  (id) => {
    if (id) collapsed.value = false;
  },
);

// 挂载时订阅 agent-task 事件（store 内部处理重挂载去重）；卸载时退订。
let unsubscribeEvents: (() => void) | null = null;
onMounted(() => {
  unsubscribeEvents = store.subscribeToEvents();
});
onUnmounted(() => {
  unsubscribeEvents?.();
  unsubscribeEvents = null;
});

function statusMeta(task: AgentTaskInfo): { label: string; icon: string } {
  return STATUS_META[task.status] ?? STATUS_META.queued;
}

function agentName(task: AgentTaskInfo): string {
  return task.itemSummaries[0]?.agentName ?? "agent";
}

function modelLabel(task: AgentTaskInfo): string {
  const model = task.itemSummaries[0]?.model;
  return model ? `${model.provider}/${model.modelId}` : "—";
}

function sourceLabel(task: AgentTaskInfo): string {
  const name = props.sessionNames?.[task.parentSessionId];
  return name ?? task.parentSessionId;
}

function isSelected(task: AgentTaskInfo): boolean {
  return store.selectedTaskId === task.taskId;
}

function toggleSelect(task: AgentTaskInfo): void {
  store.selectTask(isSelected(task) ? null : task.taskId);
}

function isCancelable(task: AgentTaskInfo): boolean {
  return task.status === "queued" || task.status === "running" || task.status === "waiting_input";
}

function isTerminal(task: AgentTaskInfo): boolean {
  return task.status === "completed" || task.status === "failed" || task.status === "cancelled";
}

/**
 * 可清理：终态或已中断，且关联 Plan 的结果已被消费/释放
 * （planLinkState=pending 受 Plan 保护，必须先消费结果、标记失败或重新规划）。
 */
function isClearable(task: AgentTaskInfo): boolean {
  if (task.planLinkState === "pending") return false;
  return isTerminal(task) || task.status === "interrupted";
}

function clearHint(task: AgentTaskInfo): string {
  if (task.planLinkState === "pending") {
    return "该任务关联的计划尚未消费结果：需先消费结果、标记失败或重新规划后才能清理";
  }
  return "清除任务记录";
}

function recoveryIssueLabel(code: AgentTaskRecoveryIssue["code"]): string {
  return RECOVERY_ISSUE_LABELS[code] ?? code;
}

function storagePercent(status: { usedBytes: number; reservedBytes: number; limitBytes: number }): number {
  if (status.limitBytes <= 0) return 0;
  return Math.min(100, Math.round(((status.usedBytes + status.reservedBytes) / status.limitBytes) * 100));
}

function cancelLabel(task: AgentTaskInfo): string {
  return task.status === "waiting_input" ? "中止" : "取消";
}

function truncateText(text: string, maxLength: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  return `${chars.slice(0, maxLength).join("")}…`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) {
    const seconds = Math.round((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

/** 防重复提交 + 至少 300ms 的进度指示（同一面板同一时刻只允许一个繁忙操作）。 */
async function runBusy(key: string, fn: () => Promise<unknown>): Promise<void> {
  if (busyKey.value) return;
  busyKey.value = key;
  const startedAt = Date.now();
  try {
    await fn();
  } finally {
    const elapsed = Date.now() - startedAt;
    const rest = Math.max(0, MIN_BUSY_MS - elapsed);
    if (rest > 0) {
      await new Promise((resolve) => setTimeout(resolve, rest));
    }
    busyKey.value = null;
  }
}

function cancelTask(task: AgentTaskInfo): void {
  void runBusy(`cancel-${task.taskId}`, () => store.cancel(task.taskId, task.generation));
}

function backgroundTask(task: AgentTaskInfo): void {
  void runBusy(`background-${task.taskId}`, () => store.background(task.taskId, task.generation));
}

function continueForegroundWait(task: AgentTaskInfo): void {
  void runBusy(`wait-${task.taskId}`, () =>
    store.continueForegroundWait(task.taskId, task.generation),
  );
}

/**
 * 行内「续接」：展开任务详情并携带一次意图；详情挂载/变更时先取得恢复摘要
 * （get_resume_summary），用户确认 workspace 变化/模型决策后才发 resume。
 */
function startResume(task: AgentTaskInfo): void {
  if (busyKey.value || task.status !== "interrupted") return;
  store.selectTask(task.taskId);
  resumeIntentTaskId.value = task.taskId;
}

/** 详情已消费行内「续接」意图：重置一次性意图，仅展开查看不再自动触发续接流程（再次主动点「续接」会重新赋值）。 */
function consumeResumeIntent(taskId: string): void {
  if (resumeIntentTaskId.value === taskId) {
    resumeIntentTaskId.value = null;
  }
}

/** 行内「标记失败」：用户决定，任务进入 failed(user_decision)，不再续接。 */
function markFailedTask(task: AgentTaskInfo): void {
  void runBusy(`mark-${task.taskId}`, () => store.markFailed(task.taskId, task.generation));
}

function openClearConfirm(task: AgentTaskInfo): void {
  if (busyKey.value || !isClearable(task)) return;
  confirmClearTarget.value = {
    taskId: task.taskId,
    generation: task.generation,
    description: task.description || task.taskId,
  };
}

/** recovery issue 的清理入口（只读记录，同样必须二次确认）。 */
function openIssueClear(issue: AgentTaskRecoveryIssue): void {
  if (busyKey.value) return;
  confirmClearTarget.value = {
    taskId: issue.taskId,
    generation: issue.generation,
    description: `${recoveryIssueLabel(issue.code)}：${issue.message || issue.taskId}`,
  };
}

function cancelClear(): void {
  confirmClearTarget.value = null;
}

function confirmClear(): void {
  const target = confirmClearTarget.value;
  confirmClearTarget.value = null;
  if (!target) return;
  void runBusy(`clear-${target.taskId}`, () => store.clearTask(target.taskId, target.generation, true));
}

/** 导出 recovery issue 诊断（Blob 下载；happy-dom 无 createObjectURL 时仅发命令）。 */
function exportIssue(issue: AgentTaskRecoveryIssue): void {
  void runBusy(`export-${issue.taskId}`, async () => {
    const result = await store.exportDiagnostics(issue.taskId);
    if (result.success && result.data) {
      downloadDiagnostics(result.data);
    }
  });
}

function downloadDiagnostics(exportData: AgentTaskDiagnosticExport): void {
  if (typeof URL.createObjectURL !== "function") return;
  try {
    const blob = new Blob([exportData.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exportData.fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("[agent-task-panel] Failed to download diagnostics:", err);
  }
}

/** 清理所有终态任务（含存储满后的清理入口）。 */
function openClearAll(): void {
  if (busyKey.value) return;
  clearAllResult.value = null;
  clearAllError.value = null;
  clearAllOpen.value = true;
}

function cancelClearAll(): void {
  clearAllOpen.value = false;
}

function confirmClearAll(): void {
  clearAllOpen.value = false;
  void runBusy("clear-all", async () => {
    const result = await store.clearAllTerminal(undefined, true);
    if (result.success && result.data) {
      clearAllResult.value = result.data;
      clearAllError.value = null;
    } else {
      clearAllError.value = result.error ?? "清理所有终态任务失败";
    }
  });
}

function isBusyFor(task: AgentTaskInfo, action: string): boolean {
  return busyKey.value === `${action}-${task.taskId}`;
}

function busyText(task: AgentTaskInfo, action: string): string {
  return isBusyFor(task, action) ? "处理中..." : cancelLabel(task);
}
</script>

<template>
  <section class="agent-task-panel" data-test="agent-task-panel" :aria-label="`任务面板：需要处理 ${waitingCount}，已中断 ${interruptedCount}，进行中 ${activeCount}`">
    <header class="agent-task-header">
      <button
        type="button"
        class="agent-task-panel-toggle"
        data-test="agent-task-panel-toggle"
        :aria-expanded="!collapsed"
        aria-controls="agent-task-panel-body"
        @click="collapsed = !collapsed"
      >
        <v-icon icon="mdi-format-list-checks" size="15" aria-hidden="true" />
        <span class="agent-task-title">Agent 任务</span>
        <span class="agent-task-counts" data-test="agent-task-counts">
          需要处理 {{ waitingCount }} · 已中断 {{ interruptedCount }} · 进行中 {{ activeCount }} · 最近 {{ recentCount }}
        </span>
        <span class="agent-task-toggle">{{ collapsed ? "展开" : "收起" }}</span>
      </button>
    </header>

    <div v-show="!collapsed" id="agent-task-panel-body" class="agent-task-body">
      <div v-if="store.lastError" class="agent-task-storage-full" data-test="agent-task-last-error" role="alert">
        {{ store.lastError }}
      </div>
      <!-- 存储状态（PRD C5）：80% 阈值提示；满后拒绝启动并给清理入口 -->
      <div v-if="store.storageWarnings.length > 0" class="agent-task-storage-warning" data-test="agent-task-storage-warning" role="status">
        存储空间已达 {{ storagePercent(store.storageWarnings[0]) }}%，建议清理任务记录。
      </div>
      <div v-if="store.storageFulls.length > 0" class="agent-task-storage-full" data-test="agent-task-storage-full" role="alert">
        <span class="agent-task-storage-full-text">存储空间已满（{{ storagePercent(store.storageFulls[0]) }}%），无法启动新任务。</span>
        <button type="button" class="agent-task-action-btn" data-test="agent-task-storage-clean-btn" :disabled="busyKey !== null" title="清理所有终态任务记录" @click="openClearAll()">
          清理任务记录
        </button>
      </div>

      <div v-if="store.tasks.length === 0" class="agent-task-empty" data-test="agent-task-empty">
        暂无任务
      </div>
      <template v-else>
        <!-- 需要处理：任务输入请求卡片 + waiting_input 任务行 -->
        <section v-if="visibleWaiting.length > 0 || store.activeInputRequests.length > 0" class="agent-task-group" data-test="agent-task-group-waiting">
          <h3 class="agent-task-group-title">需要处理</h3>
          <div class="agent-task-group-list">
            <AgentTaskInputCard
              v-for="request in store.activeInputRequests"
              :key="`${request.taskId}:${request.requestId}:${request.generation}`"
              :request="request"
            />
            <div
              v-for="task in visibleWaiting"
              :key="task.taskId"
              class="agent-task-row"
              :class="[`status-${task.status}`, { selected: isSelected(task) }]"
              :data-test="`agent-task-row-${task.taskId}`"
            >
              <div class="agent-task-row-top">
                <button
                  type="button"
                  class="agent-task-row-main"
                  :aria-expanded="isSelected(task)"
                  :aria-controls="`agent-task-detail-${task.taskId}`"
                  :title="`${statusMeta(task).label} · ${agentName(task)}${task.description ? ` · ${task.description}` : ''}`"
                  @click="toggleSelect(task)"
                >
                  <v-icon :icon="statusMeta(task).icon" size="14" aria-hidden="true" />
                  <span class="agent-task-status" :class="`status-${task.status}`" data-test="agent-task-status-text">
                    {{ statusMeta(task).label }}
                  </span>
                  <span class="agent-task-agent" data-test="agent-task-agent">{{ agentName(task) }}</span>
                  <span class="agent-task-desc" :title="task.description">
                    {{ task.description ? truncateText(task.description, 40) : "—" }}
                  </span>
                  <span class="agent-task-toggle-hint">{{ isSelected(task) ? "收起" : "展开" }}</span>
                </button>
                <div class="agent-task-row-actions">
                  <button
                    v-if="task.status === 'running' && task.presentation === 'foreground' && task.autoBackground?.warningActive"
                    type="button"
                    class="agent-task-action-btn"
                    data-test="agent-task-continue-wait-btn"
                    :disabled="busyKey !== null"
                    title="取消本次自动后台化计时，继续在前台等待"
                    @click="continueForegroundWait(task)"
                  >
                    继续等待
                  </button>
                  <button
                    v-if="task.status === 'running' && task.presentation === 'foreground'"
                    type="button"
                    class="agent-task-action-btn"
                    data-test="agent-task-background-btn"
                    :disabled="busyKey !== null"
                    title="转为后台任务，不重启"
                    @click="backgroundTask(task)"
                  >
                    转后台
                  </button>
                  <button
                    v-if="isCancelable(task)"
                    type="button"
                    class="agent-task-action-btn danger"
                    data-test="agent-task-cancel-btn"
                    :disabled="busyKey !== null"
                    :title="task.status === 'waiting_input' ? '中止任务并释放槽位' : '取消任务'"
                    @click="cancelTask(task)"
                  >
                    {{ busyText(task, "cancel") }}
                  </button>
                  <button
                    v-if="isTerminal(task)"
                    type="button"
                    class="agent-task-action-btn"
                    data-test="agent-task-clear-btn"
                    :disabled="busyKey !== null || !isClearable(task)"
                    :title="clearHint(task)"
                    @click="openClearConfirm(task)"
                  >
                    清除
                  </button>
                </div>
              </div>
              <div class="agent-task-row-meta">
                <span data-test="agent-task-source" :title="task.parentSessionId">来源 {{ sourceLabel(task) }}</span>
                <span data-test="agent-task-duration">用时 {{ formatDuration(task.durationMs) }}</span>
                <span data-test="agent-task-model">模型 {{ modelLabel(task) }}</span>
                <span data-test="agent-task-cost">费用 {{ formatCost(task.usage.cost) }}</span>
                <span v-if="task.status === 'queued'" class="queue-hint" data-test="agent-task-queue">
                  队列 #{{ task.queuePosition ?? "?" }}
                </span>
                <span v-if="task.status === 'waiting_input'" class="slot-hint" data-test="agent-task-slot">
                  占用槽位
                </span>
                <span v-if="task.autoBackground?.warningActive" class="bg-warning-hint" data-test="agent-task-bg-warning">
                  即将自动转后台
                </span>
              </div>
              <AgentTaskDetail
                v-if="isSelected(task)"
                :id="`agent-task-detail-${task.taskId}`"
                :task="task"
                :current-session-id="props.currentSessionId"
                :current-project-physical-path="props.currentProjectPhysicalPath"
                :session-names="props.sessionNames"
                @clear="openClearConfirm(task)"
              />
            </div>
            <div v-if="waitingOverflow > 0" class="agent-task-overflow" data-test="agent-task-waiting-overflow">
              还有 {{ waitingOverflow }} 个任务未显示
            </div>
          </div>
        </section>

        <!-- 已中断：1.4.2 重启水合的 interrupted 分组（位于需要处理后、进行中前） -->
        <section v-if="visibleInterrupted.length > 0" class="agent-task-group" data-test="agent-task-group-interrupted">
          <h3 class="agent-task-group-title">已中断</h3>
          <div class="agent-task-group-list">
            <div
              v-for="task in visibleInterrupted"
              :key="task.taskId"
              class="agent-task-row"
              :class="[`status-${task.status}`, { selected: isSelected(task) }]"
              :data-test="`agent-task-row-${task.taskId}`"
            >
              <div class="agent-task-row-top">
                <button
                  type="button"
                  class="agent-task-row-main"
                  :aria-expanded="isSelected(task)"
                  :aria-controls="`agent-task-detail-${task.taskId}`"
                  :title="`${statusMeta(task).label} · ${agentName(task)}${task.description ? ` · ${task.description}` : ''}`"
                  @click="toggleSelect(task)"
                >
                  <v-icon :icon="statusMeta(task).icon" size="14" aria-hidden="true" />
                  <span class="agent-task-status" :class="`status-${task.status}`" data-test="agent-task-status-text">
                    {{ statusMeta(task).label }}
                  </span>
                  <span class="agent-task-agent" data-test="agent-task-agent">{{ agentName(task) }}</span>
                  <span class="agent-task-desc" :title="task.description">
                    {{ task.description ? truncateText(task.description, 40) : "—" }}
                  </span>
                  <span class="agent-task-toggle-hint">{{ isSelected(task) ? "收起" : "展开" }}</span>
                </button>
                <div class="agent-task-row-actions">
                  <button
                    v-if="task.status === 'interrupted'"
                    type="button"
                    class="agent-task-action-btn"
                    data-test="agent-task-row-resume-btn"
                    :disabled="busyKey !== null"
                    title="展开任务，先查看恢复摘要并确认工作区/模型决策后续接"
                    @click="startResume(task)"
                  >
                    续接
                  </button>
                  <button
                    v-if="task.status === 'interrupted'"
                    type="button"
                    class="agent-task-action-btn danger"
                    data-test="agent-task-row-mark-failed-btn"
                    :disabled="busyKey !== null"
                    title="将任务标记为失败（用户决定），不再续接"
                    @click="markFailedTask(task)"
                  >
                    标记失败
                  </button>
                  <button
                    v-if="task.status === 'interrupted'"
                    type="button"
                    class="agent-task-action-btn"
                    data-test="agent-task-clear-btn"
                    :disabled="busyKey !== null || !isClearable(task)"
                    :title="clearHint(task)"
                    @click="openClearConfirm(task)"
                  >
                    清除
                  </button>
                </div>
              </div>
              <div class="agent-task-row-meta">
                <span data-test="agent-task-source" :title="task.parentSessionId">来源 {{ sourceLabel(task) }}</span>
                <span data-test="agent-task-duration">用时 {{ formatDuration(task.durationMs) }}</span>
                <span data-test="agent-task-model">模型 {{ modelLabel(task) }}</span>
                <span data-test="agent-task-cost">费用 {{ formatCost(task.usage.cost) }}</span>
                <span v-if="task.hasUnclosedToolCall" class="unclosed-hint" data-test="agent-task-unclosed-hint">
                  存在未完成工具调用
                </span>
              </div>
              <AgentTaskDetail
                v-if="isSelected(task)"
                :id="`agent-task-detail-${task.taskId}`"
                :task="task"
                :current-session-id="props.currentSessionId"
                :current-project-physical-path="props.currentProjectPhysicalPath"
                :session-names="props.sessionNames"
                :resume-intent="resumeIntentTaskId"
                @clear="openClearConfirm(task)"
                @resume-intent-consumed="consumeResumeIntent"
              />
            </div>
            <div v-if="interruptedOverflow > 0" class="agent-task-overflow" data-test="agent-task-interrupted-overflow">
              还有 {{ interruptedOverflow }} 个任务未显示
            </div>
          </div>
        </section>

        <!-- 进行中：running + queued -->
        <section v-if="visibleActive.length > 0" class="agent-task-group" data-test="agent-task-group-active">
          <h3 class="agent-task-group-title">进行中</h3>
          <div class="agent-task-group-list">
            <div
              v-for="task in visibleActive"
              :key="task.taskId"
              class="agent-task-row"
              :class="[`status-${task.status}`, { selected: isSelected(task) }]"
              :data-test="`agent-task-row-${task.taskId}`"
            >
              <div class="agent-task-row-top">
                <button
                  type="button"
                  class="agent-task-row-main"
                  :aria-expanded="isSelected(task)"
                  :aria-controls="`agent-task-detail-${task.taskId}`"
                  :title="`${statusMeta(task).label} · ${agentName(task)}${task.description ? ` · ${task.description}` : ''}`"
                  @click="toggleSelect(task)"
                >
                  <v-icon :icon="statusMeta(task).icon" size="14" aria-hidden="true" />
                  <span class="agent-task-status" :class="`status-${task.status}`" data-test="agent-task-status-text">
                    {{ statusMeta(task).label }}
                  </span>
                  <span class="agent-task-agent" data-test="agent-task-agent">{{ agentName(task) }}</span>
                  <span class="agent-task-desc" :title="task.description">
                    {{ task.description ? truncateText(task.description, 40) : "—" }}
                  </span>
                  <span class="agent-task-toggle-hint">{{ isSelected(task) ? "收起" : "展开" }}</span>
                </button>
                <div class="agent-task-row-actions">
                  <button
                    v-if="task.status === 'running' && task.presentation === 'foreground' && task.autoBackground?.warningActive"
                    type="button"
                    class="agent-task-action-btn"
                    data-test="agent-task-continue-wait-btn"
                    :disabled="busyKey !== null"
                    title="取消本次自动后台化计时，继续在前台等待"
                    @click="continueForegroundWait(task)"
                  >
                    继续等待
                  </button>
                  <button
                    v-if="task.status === 'running' && task.presentation === 'foreground'"
                    type="button"
                    class="agent-task-action-btn"
                    data-test="agent-task-background-btn"
                    :disabled="busyKey !== null"
                    title="转为后台任务，不重启"
                    @click="backgroundTask(task)"
                  >
                    转后台
                  </button>
                  <button
                    v-if="isCancelable(task)"
                    type="button"
                    class="agent-task-action-btn danger"
                    data-test="agent-task-cancel-btn"
                    :disabled="busyKey !== null"
                    :title="task.status === 'waiting_input' ? '中止任务并释放槽位' : '取消任务'"
                    @click="cancelTask(task)"
                  >
                    {{ busyText(task, "cancel") }}
                  </button>
                  <button
                    v-if="isTerminal(task)"
                    type="button"
                    class="agent-task-action-btn"
                    data-test="agent-task-clear-btn"
                    :disabled="busyKey !== null || !isClearable(task)"
                    :title="clearHint(task)"
                    @click="openClearConfirm(task)"
                  >
                    清除
                  </button>
                </div>
              </div>
              <div class="agent-task-row-meta">
                <span data-test="agent-task-source" :title="task.parentSessionId">来源 {{ sourceLabel(task) }}</span>
                <span data-test="agent-task-duration">用时 {{ formatDuration(task.durationMs) }}</span>
                <span data-test="agent-task-model">模型 {{ modelLabel(task) }}</span>
                <span data-test="agent-task-cost">费用 {{ formatCost(task.usage.cost) }}</span>
                <span v-if="task.status === 'queued'" class="queue-hint" data-test="agent-task-queue">
                  队列 #{{ task.queuePosition ?? "?" }}
                </span>
                <span v-if="task.status === 'waiting_input'" class="slot-hint" data-test="agent-task-slot">
                  占用槽位
                </span>
                <span v-if="task.autoBackground?.warningActive" class="bg-warning-hint" data-test="agent-task-bg-warning">
                  即将自动转后台
                </span>
              </div>
              <AgentTaskDetail
                v-if="isSelected(task)"
                :id="`agent-task-detail-${task.taskId}`"
                :task="task"
                :current-session-id="props.currentSessionId"
                :current-project-physical-path="props.currentProjectPhysicalPath"
                :session-names="props.sessionNames"
                @clear="openClearConfirm(task)"
              />
            </div>
            <div v-if="activeOverflow > 0" class="agent-task-overflow" data-test="agent-task-active-overflow">
              还有 {{ activeOverflow }} 个任务未显示
            </div>
          </div>
        </section>

        <!-- 最近完成 -->
        <section v-if="store.recentTasks.length > 0" class="agent-task-group" data-test="agent-task-group-recent">
          <h3 class="agent-task-group-title">最近完成</h3>
          <div class="agent-task-group-list">
            <div
              v-for="task in store.recentTasks"
              :key="task.taskId"
              class="agent-task-row"
              :class="[`status-${task.status}`, { selected: isSelected(task) }]"
              :data-test="`agent-task-row-${task.taskId}`"
            >
              <div class="agent-task-row-top">
                <button
                  type="button"
                  class="agent-task-row-main"
                  :aria-expanded="isSelected(task)"
                  :aria-controls="`agent-task-detail-${task.taskId}`"
                  :title="`${statusMeta(task).label} · ${agentName(task)}${task.description ? ` · ${task.description}` : ''}`"
                  @click="toggleSelect(task)"
                >
                  <v-icon :icon="statusMeta(task).icon" size="14" aria-hidden="true" />
                  <span class="agent-task-status" :class="`status-${task.status}`" data-test="agent-task-status-text">
                    {{ statusMeta(task).label }}
                  </span>
                  <span class="agent-task-agent" data-test="agent-task-agent">{{ agentName(task) }}</span>
                  <span class="agent-task-desc" :title="task.description">
                    {{ task.description ? truncateText(task.description, 40) : "—" }}
                  </span>
                  <span class="agent-task-toggle-hint">{{ isSelected(task) ? "收起" : "展开" }}</span>
                </button>
                <div class="agent-task-row-actions">
                  <button
                    v-if="isCancelable(task)"
                    type="button"
                    class="agent-task-action-btn danger"
                    data-test="agent-task-cancel-btn"
                    :disabled="busyKey !== null"
                    :title="task.status === 'waiting_input' ? '中止任务并释放槽位' : '取消任务'"
                    @click="cancelTask(task)"
                  >
                    {{ busyText(task, "cancel") }}
                  </button>
                  <button
                    v-if="isTerminal(task)"
                    type="button"
                    class="agent-task-action-btn"
                    data-test="agent-task-clear-btn"
                    :disabled="busyKey !== null || !isClearable(task)"
                    :title="clearHint(task)"
                    @click="openClearConfirm(task)"
                  >
                    清除
                  </button>
                </div>
              </div>
              <div class="agent-task-row-meta">
                <span data-test="agent-task-source" :title="task.parentSessionId">来源 {{ sourceLabel(task) }}</span>
                <span data-test="agent-task-duration">用时 {{ formatDuration(task.durationMs) }}</span>
                <span data-test="agent-task-model">模型 {{ modelLabel(task) }}</span>
                <span data-test="agent-task-cost">费用 {{ formatCost(task.usage.cost) }}</span>
                <span v-if="task.status === 'queued'" class="queue-hint" data-test="agent-task-queue">
                  队列 #{{ task.queuePosition ?? "?" }}
                </span>
                <span v-if="task.status === 'waiting_input'" class="slot-hint" data-test="agent-task-slot">
                  占用槽位
                </span>
                <span v-if="task.autoBackground?.warningActive" class="bg-warning-hint" data-test="agent-task-bg-warning">
                  即将自动转后台
                </span>
              </div>
              <AgentTaskDetail
                v-if="isSelected(task)"
                :id="`agent-task-detail-${task.taskId}`"
                :task="task"
                :current-session-id="props.currentSessionId"
                :current-project-physical-path="props.currentProjectPhysicalPath"
                :session-names="props.sessionNames"
                @clear="openClearConfirm(task)"
              />
            </div>
          </div>
        </section>
      </template>

      <!-- 恢复数据损坏（1.4.2）：recovery issue 只读诊断/导出/清理，不影响其他任务 -->
      <section v-if="store.recoveryIssues.length > 0" class="agent-task-group" data-test="agent-task-group-recovery">
        <h3 class="agent-task-group-title">恢复数据损坏</h3>
        <div class="agent-task-group-list">
          <div
            v-for="issue in store.recoveryIssues"
            :key="issue.taskId"
            class="agent-task-row agent-task-issue-row"
            :data-test="`agent-task-issue-${issue.taskId}`"
          >
            <div class="agent-task-row-top">
              <div class="agent-task-row-main agent-task-issue-main">
                <v-icon icon="mdi-alert-decagram-outline" size="14" aria-hidden="true" />
                <span class="agent-task-status status-issue" data-test="agent-task-issue-code">{{ recoveryIssueLabel(issue.code) }}</span>
                <span class="agent-task-desc" :title="issue.message">{{ issue.message ? truncateText(issue.message, 40) : "—" }}</span>
                <span v-if="issue.readOnly" class="agent-task-readonly-badge" data-test="agent-task-issue-readonly">只读</span>
              </div>
              <div class="agent-task-row-actions">
                <button
                  type="button"
                  class="agent-task-action-btn"
                  data-test="agent-task-issue-export-btn"
                  :disabled="busyKey !== null"
                  title="导出诊断信息"
                  @click="exportIssue(issue)"
                >
                  导出诊断
                </button>
                <button
                  type="button"
                  class="agent-task-action-btn danger"
                  data-test="agent-task-issue-clear-btn"
                  :disabled="busyKey !== null"
                  title="清理损坏记录"
                  @click="openIssueClear(issue)"
                >
                  清理
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 所有终态清理（1.4.2）：不删除已中断/损坏记录，结果明示 protectedTaskIds -->
      <div v-if="store.tasks.length > 0" class="agent-task-footer" data-test="agent-task-footer">
        <button
          type="button"
          class="agent-task-action-btn"
          data-test="agent-task-clear-all-btn"
          :disabled="busyKey !== null"
          title="清理所有已完成/失败/已取消任务（已中断与损坏记录不会被删除）"
          @click="openClearAll()"
        >
          清理所有终态任务
        </button>
      </div>
      <div v-if="clearAllError" class="agent-task-clear-all-error" data-test="agent-task-clear-all-error" role="alert">
        {{ clearAllError }}
      </div>
      <div v-if="clearAllResult" class="agent-task-clear-all-result" data-test="agent-task-clear-all-result" role="status">
        已清理 {{ clearAllResult.cleared }} 个任务。
        <span v-if="clearAllResult.protectedTaskIds.length" class="agent-task-clear-all-protected" data-test="agent-task-clear-all-protected">
          以下任务受保护未删除：{{ clearAllResult.protectedTaskIds.join("、") }}
        </span>
      </div>

      <!-- 单项清除确认（clear 二次确认；interrupted/recovery issue 同入口） -->
      <div v-if="confirmClearTarget" class="agent-task-clear-confirm" data-test="agent-task-clear-confirm" role="alertdialog" aria-label="确认清除任务">
        <p class="agent-task-clear-confirm-text">
          清除任务 {{ truncateText(confirmClearTarget.description || confirmClearTarget.taskId, 60) }}？该记录将不可恢复。
        </p>
        <div class="agent-task-clear-confirm-actions">
          <button type="button" class="agent-task-action-btn" data-test="agent-task-clear-cancel-btn" @click="cancelClear">
            取消
          </button>
          <button type="button" class="agent-task-action-btn danger" data-test="agent-task-clear-confirm-btn" @click="confirmClear">
            确认清除
          </button>
        </div>
      </div>

      <!-- 所有终态清理确认 -->
      <div v-if="clearAllOpen" class="agent-task-clear-all-confirm" data-test="agent-task-clear-all-confirm" role="alertdialog" aria-label="确认清理所有终态任务">
        <p class="agent-task-clear-all-confirm-text">
          将清理所有已完成、失败、已取消任务（包括已关联计划但已消费/释放结果的任务）。已中断与恢复数据损坏记录不会被删除。该操作不可恢复。
        </p>
        <div class="agent-task-clear-all-confirm-actions">
          <button type="button" class="agent-task-action-btn" data-test="agent-task-clear-all-cancel-btn" @click="cancelClearAll">
            取消
          </button>
          <button type="button" class="agent-task-action-btn danger" data-test="agent-task-clear-all-confirm-btn" @click="confirmClearAll">
            确认清理
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.agent-task-panel {
  min-width: 0;
}

.agent-task-header {
  border-bottom: 1px solid var(--pix-border-light);
  margin-bottom: var(--pix-space-sm);
}

.agent-task-panel-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 2px 0 6px;
  color: var(--pix-text-primary);
  font-family: var(--pix-font-ui);
  text-align: left;
  min-width: 0;
}

.agent-task-title {
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
  flex-shrink: 0;
}

.agent-task-counts {
  flex: 1;
  min-width: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-task-toggle {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  font-weight: var(--pix-weight-medium);
}

.agent-task-body {
  min-width: 0;
}

.agent-task-empty {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  padding: var(--pix-space-sm) 0;
}

.agent-task-group {
  margin-bottom: var(--pix-space-md);
  min-width: 0;
}

.agent-task-group-title {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-secondary);
  margin: 0 0 var(--pix-space-xs);
}

/* 稳定容器：固定高度 + 滚动，任意规模的任务镜像都不会撑破布局。 */
.agent-task-group-list {
  max-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-xs);
  padding-right: 2px;
}

.agent-task-row {
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  padding: var(--pix-space-xs) var(--pix-space-sm);
  min-width: 0;
  background: rgba(255, 255, 255, 0.6);
}

.agent-task-row.selected {
  border-color: var(--pix-accent-light);
  background: var(--pix-accent-light);
}

.agent-task-row.status-failed {
  border-color: var(--pix-error-light);
  background: var(--pix-error-bg);
}

.agent-task-row-top {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.agent-task-row-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  padding: 2px 0;
  color: var(--pix-text-primary);
  font-family: var(--pix-font-ui);
  text-align: left;
}

.agent-task-status {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--pix-bg-code);
  color: var(--pix-text-secondary);
  white-space: nowrap;
}

.agent-task-status.status-running {
  color: var(--pix-accent);
  background: var(--pix-accent-light);
}

.agent-task-status.status-waiting_input {
  color: var(--pix-warning);
  background: var(--pix-warning-light);
}

.agent-task-status.status-completed {
  color: var(--pix-success);
  background: var(--pix-success-light);
}

.agent-task-status.status-failed {
  color: var(--pix-error);
  background: var(--pix-error-light);
}

.agent-task-status.status-cancelled {
  color: var(--pix-text-muted);
}

.agent-task-agent {
  flex-shrink: 0;
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-accent);
  max-width: 30%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-task-desc {
  flex: 1;
  min-width: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-task-toggle-hint {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}

.agent-task-row-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.agent-task-action-btn {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  padding: 2px 8px;
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-hover);
  color: var(--pix-text-primary);
  border: 1px solid var(--pix-border-light);
  cursor: pointer;
  white-space: nowrap;
}

.agent-task-action-btn:hover {
  background: var(--pix-accent-light);
  color: var(--pix-accent);
}

.agent-task-action-btn.danger {
  color: var(--pix-error);
  background: var(--pix-error-bg);
}

.agent-task-action-btn.danger:hover {
  background: var(--pix-error-light);
  color: var(--pix-error);
}

.agent-task-action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.agent-task-action-btn:disabled:hover {
  background: var(--pix-bg-hover);
  color: var(--pix-text-primary);
}

.agent-task-row-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 3px;
  font-size: 10px;
  color: var(--pix-text-muted);
  font-variant-numeric: tabular-nums;
  min-width: 0;
}

.queue-hint {
  color: var(--pix-warning);
  font-weight: var(--pix-weight-medium);
}

.slot-hint {
  color: var(--pix-warning);
  font-weight: var(--pix-weight-medium);
}

.bg-warning-hint {
  color: var(--pix-error);
  font-weight: var(--pix-weight-medium);
}

.agent-task-overflow {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  padding: var(--pix-space-xs) 0;
}

/* 存储状态（PRD C5）：80% 提示 / 满后横幅 */
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
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: var(--pix-space-sm);
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border: 1px solid var(--pix-error-light);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-error-bg);
  font-size: var(--pix-text-xs);
  color: var(--pix-error);
}

.agent-task-storage-full-text {
  flex: 1;
  min-width: 0;
}

/* recovery issue 行 */
.agent-task-issue-row {
  background: var(--pix-error-bg);
  border-color: var(--pix-error-light);
}

.agent-task-issue-main {
  cursor: default;
}

.agent-task-status.status-issue {
  color: var(--pix-error);
  background: var(--pix-error-light);
}

.agent-task-readonly-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: var(--pix-weight-semibold);
  padding: 0 6px;
  border-radius: 999px;
  color: var(--pix-text-secondary);
  background: var(--pix-bg-code);
}

/* 已中断行提示 */
.unclosed-hint {
  color: var(--pix-warning);
  font-weight: var(--pix-weight-medium);
}

/* 所有终态清理 */
.agent-task-footer {
  margin-top: var(--pix-space-sm);
}

.agent-task-clear-all-confirm {
  margin-top: var(--pix-space-sm);
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-error-light);
  border-radius: var(--pix-radius-md);
  background: var(--pix-error-bg);
}

.agent-task-clear-all-confirm-text {
  font-size: var(--pix-text-xs);
  color: var(--pix-error);
  margin-bottom: var(--pix-space-sm);
  overflow-wrap: anywhere;
}

.agent-task-clear-all-confirm-actions {
  display: flex;
  gap: 6px;
}

.agent-task-clear-all-error {
  margin-top: var(--pix-space-sm);
  font-size: var(--pix-text-xs);
  color: var(--pix-error);
}

.agent-task-clear-all-result {
  margin-top: var(--pix-space-sm);
  font-size: var(--pix-text-xs);
  color: var(--pix-success);
}

.agent-task-clear-all-protected {
  color: var(--pix-warning);
}

/* 单项清除确认 */
.agent-task-clear-confirm {
  margin-top: var(--pix-space-sm);
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-error-light);
  border-radius: var(--pix-radius-md);
  background: var(--pix-error-bg);
}

.agent-task-clear-confirm-text {
  font-size: var(--pix-text-xs);
  color: var(--pix-error);
  margin-bottom: var(--pix-space-sm);
  overflow-wrap: anywhere;
}

.agent-task-clear-confirm-actions {
  display: flex;
  gap: 6px;
}
</style>
