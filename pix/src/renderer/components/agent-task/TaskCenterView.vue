<script setup lang="ts">
/**
 * TaskCenterView - 任务中心（中心区 viewMode='tasks'，PiX 1.5 P2）
 *
 * 左列（全高滚动，无 260px 上限）master-detail + 右侧 TaskDetailPanel。
 * 顶部「运行 | 历史」视图切换 + 「当前会话 | 全部」作用域切换：
 * - 作用域默认「当前会话」——只显示 parentSessionId === 当前会话 的任务
 *   （子代理任务按会话隔离,其他会话/工作区的任务不混入）;「全部」为全局
 *   逃生口(停止失控任务/waiting_input 的可及性不受会话切换影响);
 * - 当前会话未定(切换空窗期,projectStore.currentSession 为 null)时过滤
 *   回退为显示全部,避免瞬时空中心;
 * - 深链规则:openTaskCenter(taskId) 定位到不在当前会话的任务时,作用域
 *   自动切「全部」——通知中心/聊天深链永不落空;
 * - 孤儿 recovery issue 无 parentSessionId 可归属,仅在「全部」(或会话
 *   未定的回退态)显示。
 * - 运行 = waiting_input 置顶 → running（startedAt 升序）→ queued
 *   （queuePosition 升序）→ interrupted（瞬态殿后，按 updatedAt），排序锁死；
 * - 历史 = 全量终态镜像（endedAt 降序）+ interruptedTasks（行标注「残留」）
 *   + recoveryIssues 中「无对应任务镜像」的条目（按 taskId 在 tasks 镜像中
 *   存在与否过滤，避免自动恢复失败任务与同 taskId 的 failed 任务重复成两行；
 *   issue 行只读 + 导出诊断，无清理按钮）。
 *
 * watch store.selectedTaskId:选中任务为终态 → 本地视图切「历史」，否则切「运行」。
 * workflowOwned 行:显示「workflow」徽标，不渲染停止按钮（生命周期归 workflow
 * 引擎自管）。停止按钮是行内唯一操作。lastError 在顶部横幅展示（Plan 5.1）。
 *
 * 性能：不引入虚拟滚动库。每段列表只渲染前 MAX_LIST_ROWS 行并提供溢出计数，
 * 任意规模的任务镜像都不会产生无界 DOM。
 */
import { computed, ref, watch } from "vue";
import { useAgentTaskStore } from "../../stores/agent-task-store";
import { useProjectStore } from "../../stores/project-store";
import { useTeamStore } from "../../stores/team-store";
import { useLiveNow } from "../../composables/useLiveNow";
import TaskDetailPanel from "./TaskDetailPanel.vue";
import type {
  AgentTaskDiagnosticExport,
  AgentTaskInfo,
  AgentTaskRecoveryIssue,
  AgentTaskStatus,
} from "@shared/agent-task-types.js";

const props = defineProps<{
  /** 当前 workspace 的 sessionId -> 会话名，用于展示来源会话。 */
  sessionNames?: Record<string, string>;
}>();

const store = useAgentTaskStore();
const projectStore = useProjectStore();
const teamStore = useTeamStore();

const nowMs = useLiveNow(
  computed(() => store.tasks.some((task) => task.status === "running" || task.status === "waiting_input")),
);

function liveDurationMs(task: AgentTaskInfo): number {
  if ((task.status === "running" || task.status === "waiting_input") && task.startedAt !== undefined) {
    return Math.max(0, nowMs.value - task.startedAt);
  }
  return task.durationMs;
}

type CenterView = "running" | "history";
type TaskScope = "session" | "all";

const view = ref<CenterView>("running");
/** 作用域默认「当前会话」;TaskCenterView 卸载(关闭中心)即复位。 */
const scope = ref<TaskScope>("session");

/**
 * 当前会话 id:team 模式取 leader 会话(子代理由 leader 派生)。会话切换空窗期
 * 为 null,此时作用域过滤回退为显示全部(与 projectStore 状态同源)。
 */
const currentSessionId = computed(
  () => (teamStore.teamMode ? projectStore.currentTeamSession?.id : projectStore.currentSession?.id) ?? null,
);

/** 会话过滤是否实际生效(作用域为「当前会话」且当前会话已定)。 */
const scopeActive = computed(() => scope.value === "session" && currentSessionId.value !== null);

function inScope(task: AgentTaskInfo): boolean {
  return !scopeActive.value || task.parentSessionId === currentSessionId.value;
}

/** 每个列表段最多渲染的行数（增量渲染 + 窗口化，不做虚拟滚动库）。 */
const MAX_LIST_ROWS = 50;
/** 繁忙操作至少展示的进度时长，避免闪烁。 */
const MIN_BUSY_MS = 300;

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

const TERMINAL_STATUSES: ReadonlySet<AgentTaskStatus> = new Set(["completed", "failed", "cancelled"]);

/** 运行列表的组内排序 rank：waiting_input 置顶 → running → queued → interrupted（瞬态殿后）。 */
const RUN_STATUS_RANK: Partial<Record<AgentTaskStatus, number>> = {
  waiting_input: 0,
  running: 1,
  queued: 2,
  interrupted: 3,
};

function statusMeta(task: AgentTaskInfo): { label: string; icon: string } {
  return STATUS_META[task.status] ?? STATUS_META.queued;
}

function isTerminal(status: AgentTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
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

function recoveryIssueLabel(code: AgentTaskRecoveryIssue["code"]): string {
  return RECOVERY_ISSUE_LABELS[code] ?? code;
}

function isCancelable(task: AgentTaskInfo): boolean {
  return (
    (task.status === "queued" || task.status === "running" || task.status === "waiting_input")
    && !task.workflowOwned
  );
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

// ==========================================================================
// 运行列表（排序锁死）
// ==========================================================================

/**
 * waiting_input 置顶 → running（startedAt 升序）→ queued（queuePosition 升序；
 * queued 无 startedAt）→ interrupted（瞬态殿后，按 updatedAt）。作用域过滤先行。
 */
const runningList = computed(() => {
  const active = store.tasks.filter(
    (task) => inScope(task)
      && (task.status === "waiting_input" || task.status === "running" || task.status === "queued" || task.status === "interrupted"),
  );
  return active.slice().sort((a, b) => {
    const rank = (RUN_STATUS_RANK[a.status] ?? 4) - (RUN_STATUS_RANK[b.status] ?? 4);
    if (rank !== 0) return rank;
    switch (a.status) {
      case "waiting_input":
      case "running":
        return (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.updatedAt - b.updatedAt;
      case "queued":
        return (a.queuePosition ?? 0) - (b.queuePosition ?? 0);
      case "interrupted":
        return a.updatedAt - b.updatedAt;
      default:
        return 0;
    }
  });
});

const visibleRunning = computed(() => runningList.value.slice(0, MAX_LIST_ROWS));
const runningOverflow = computed(() => Math.max(0, runningList.value.length - MAX_LIST_ROWS));
const runningCount = computed(() => runningList.value.length);

// ==========================================================================
// 历史列表
// ==========================================================================

/**
 * recoveryIssues 中「无对应任务镜像」的条目（按 taskId 在 tasks 镜像中存在与否
 * 过滤——自动恢复失败任务已作为同 taskId 的 failed 任务存在，不再重复一行）。
 * 孤儿 issue 无 parentSessionId 可归属:仅会话过滤未生效时显示。
 */
const orphanIssues = computed(() => {
  if (scopeActive.value) {
    return [];
  }
  const live = new Set(store.tasks.map((task) => task.taskId));
  return store.recoveryIssues.filter((issue) => !live.has(issue.taskId));
});

/** 作用域过滤后的终态/中断残留镜像。 */
const scopedTerminal = computed(() => store.terminalTasks.filter(inScope));
const scopedInterrupted = computed(() => store.interruptedTasks.filter(inScope));

const terminalCount = computed(() => scopedTerminal.value.length);
const visibleTerminal = computed(() => scopedTerminal.value.slice(0, MAX_LIST_ROWS));
const terminalOverflow = computed(() => Math.max(0, scopedTerminal.value.length - MAX_LIST_ROWS));

const interruptedCount = computed(() => scopedInterrupted.value.length);
const visibleInterrupted = computed(() => scopedInterrupted.value.slice(0, MAX_LIST_ROWS));
const interruptedOverflow = computed(() => Math.max(0, scopedInterrupted.value.length - MAX_LIST_ROWS));

const visibleIssues = computed(() => orphanIssues.value.slice(0, MAX_LIST_ROWS));
const issuesOverflow = computed(() => Math.max(0, orphanIssues.value.length - MAX_LIST_ROWS));

// ==========================================================================
// 选中联动:终态任务自动切历史视图,否则切运行视图;深链规则——选中的任务
// 不属于当前会话时作用域自动切「全部」(单向,不回切),通知/聊天深链不落空。
// ==========================================================================

watch(
  () => store.selectedTaskId,
  (taskId) => {
    if (!taskId) return;
    const task = store.tasks.find((t) => t.taskId === taskId);
    if (!task) return;
    if (scopeActive.value && task.parentSessionId !== currentSessionId.value) {
      scope.value = "all";
    }
    view.value = isTerminal(task.status) ? "history" : "running";
  },
);

const selectedTask = computed(() => store.selectedTask);

// ==========================================================================
// 操作
// ==========================================================================

const busyKey = ref<string | null>(null);

/** 防重复提交 + 至少 300ms 的进度指示（同一视图同一时刻只允许一个繁忙操作）。 */
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

function cancelLabel(task: AgentTaskInfo): string {
  return task.status === "waiting_input" ? "中止" : "取消";
}

function busyText(task: AgentTaskInfo): string {
  return busyKey.value === `cancel-${task.taskId}` ? "处理中..." : cancelLabel(task);
}

function cancelTask(task: AgentTaskInfo): void {
  void runBusy(`cancel-${task.taskId}`, () => store.cancel(task.taskId, task.generation));
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
    console.error("[task-center] Failed to download diagnostics:", err);
  }
}
</script>

<template>
  <section class="task-center" data-test="task-center-view" aria-label="任务中心">
    <!-- 异常：lastError 在任务中心顶部横幅展示 -->
    <div v-if="store.lastError" class="task-center-error" data-test="task-center-last-error" role="alert">
      {{ store.lastError }}
    </div>

    <div class="task-center-toolbar">
      <div class="task-center-tabs" role="tablist" aria-label="任务视图">
        <button
          type="button"
          class="task-center-tab"
          :class="{ active: view === 'running' }"
          role="tab"
          :aria-selected="view === 'running'"
          data-test="task-center-tab-running"
          @click="view = 'running'"
        >
          运行 <span v-if="runningCount > 0" class="task-center-tab-count">{{ runningCount }}</span>
        </button>
        <button
          type="button"
          class="task-center-tab"
          :class="{ active: view === 'history' }"
          role="tab"
          :aria-selected="view === 'history'"
          data-test="task-center-tab-history"
          @click="view = 'history'"
        >
          历史 <span v-if="terminalCount > 0" class="task-center-tab-count">{{ terminalCount }}</span>
        </button>
      </div>
      <!-- 作用域切换:默认「当前会话」(会话隔离),「全部」为全局逃生口 -->
      <div class="task-center-scope" role="group" aria-label="任务作用域">
        <button
          type="button"
          class="task-center-scope-btn"
          :class="{ active: scope === 'session' }"
          data-test="task-center-scope-session"
          :aria-pressed="scope === 'session'"
          @click="scope = 'session'"
        >
          当前会话
        </button>
        <button
          type="button"
          class="task-center-scope-btn"
          :class="{ active: scope === 'all' }"
          data-test="task-center-scope-all"
          :aria-pressed="scope === 'all'"
          @click="scope = 'all'"
        >
          全部
        </button>
      </div>
    </div>

    <div class="task-center-body">
      <!-- 左列：master 列表（全高滚动） -->
      <div class="task-center-list" data-test="task-center-list">
        <!-- 运行视图 -->
        <template v-if="view === 'running'">
          <div v-if="runningList.length === 0" class="task-center-empty" data-test="task-center-running-empty">
            暂无运行任务
          </div>
          <section v-else class="task-center-group" data-test="task-center-group-running">
            <div class="task-center-group-list">
              <div
                v-for="task in visibleRunning"
                :key="task.taskId"
                class="task-center-row"
                :class="[`status-${task.status}`, { selected: store.selectedTaskId === task.taskId }]"
                :data-test="`task-center-row-${task.taskId}`"
              >
                <div class="task-center-row-top">
                  <button
                    type="button"
                    class="task-center-row-main"
                    :title="`${statusMeta(task).label} · ${agentName(task)}${task.description ? ` · ${task.description}` : ''}`"
                    @click="store.selectTask(task.taskId)"
                  >
                    <v-icon :icon="statusMeta(task).icon" size="14" aria-hidden="true" />
                    <span class="task-center-status" :class="`status-${task.status}`" data-test="task-center-status-text">
                      {{ statusMeta(task).label }}
                    </span>
                    <span v-if="task.workflowOwned" class="task-center-workflow-badge" data-test="task-center-workflow-badge">workflow</span>
                    <span class="task-center-agent" data-test="task-center-agent">{{ agentName(task) }}</span>
                    <span class="task-center-desc" :title="task.description">
                      {{ task.description ? truncateText(task.description, 40) : "—" }}
                    </span>
                  </button>
                  <div class="task-center-row-actions">
                    <button
                      v-if="isCancelable(task)"
                      type="button"
                      class="agent-task-action-btn danger"
                      data-test="task-center-cancel-btn"
                      :disabled="busyKey !== null"
                      :title="task.status === 'waiting_input' ? '中止任务并释放槽位' : '取消任务'"
                      @click="cancelTask(task)"
                    >
                      {{ busyText(task) }}
                    </button>
                  </div>
                </div>
                <div class="task-center-row-meta">
                  <span data-test="task-center-source" :title="task.parentSessionId">来源 {{ sourceLabel(task) }}</span>
                  <span data-test="task-center-duration">用时 {{ formatDuration(liveDurationMs(task)) }}</span>
                  <span data-test="task-center-model">模型 {{ modelLabel(task) }}</span>
                  <span data-test="task-center-cost">费用 {{ formatCost(task.usage.cost) }}</span>
                  <span v-if="task.status === 'queued'" class="queue-hint" data-test="task-center-queue">
                    队列 #{{ task.queuePosition ?? "?" }}
                  </span>
                  <span v-if="task.status === 'waiting_input'" class="slot-hint" data-test="task-center-slot">
                    占用槽位
                  </span>
                  <span v-if="task.autoBackground?.warningActive" class="bg-warning-hint" data-test="task-center-bg-warning">
                    即将自动转后台
                  </span>
                </div>
              </div>
              <div v-if="runningOverflow > 0" class="task-center-overflow" data-test="task-center-running-overflow">
                还有 {{ runningOverflow }} 个任务未显示
              </div>
            </div>
          </section>
        </template>

        <!-- 历史视图 -->
        <template v-else>
          <template v-if="scopedTerminal.length === 0 && scopedInterrupted.length === 0 && orphanIssues.length === 0">
            <div class="task-center-empty" data-test="task-center-history-empty">暂无历史任务</div>
          </template>

          <section v-if="scopedTerminal.length > 0" class="task-center-group" data-test="task-center-group-terminal">
            <h3 class="task-center-group-title">已完成</h3>
            <div class="task-center-group-list">
              <div
                v-for="task in visibleTerminal"
                :key="task.taskId"
                class="task-center-row"
                :class="[`status-${task.status}`, { selected: store.selectedTaskId === task.taskId }]"
                :data-test="`task-center-row-${task.taskId}`"
              >
                <div class="task-center-row-top">
                  <button
                    type="button"
                    class="task-center-row-main"
                    :title="`${statusMeta(task).label} · ${agentName(task)}${task.description ? ` · ${task.description}` : ''}`"
                    @click="store.selectTask(task.taskId)"
                  >
                    <v-icon :icon="statusMeta(task).icon" size="14" aria-hidden="true" />
                    <span class="task-center-status" :class="`status-${task.status}`" data-test="task-center-status-text">
                      {{ statusMeta(task).label }}
                    </span>
                    <span v-if="task.workflowOwned" class="task-center-workflow-badge" data-test="task-center-workflow-badge">workflow</span>
                    <span class="task-center-agent" data-test="task-center-agent">{{ agentName(task) }}</span>
                    <span class="task-center-desc" :title="task.description">
                      {{ task.description ? truncateText(task.description, 40) : "—" }}
                    </span>
                  </button>
                </div>
                <div class="task-center-row-meta">
                  <span data-test="task-center-source" :title="task.parentSessionId">来源 {{ sourceLabel(task) }}</span>
                  <span data-test="task-center-duration">用时 {{ formatDuration(liveDurationMs(task)) }}</span>
                  <span data-test="task-center-model">模型 {{ modelLabel(task) }}</span>
                  <span data-test="task-center-cost">费用 {{ formatCost(task.usage.cost) }}</span>
                </div>
              </div>
              <div v-if="terminalOverflow > 0" class="task-center-overflow" data-test="task-center-terminal-overflow">
                还有 {{ terminalOverflow }} 个任务未显示
              </div>
            </div>
          </section>

          <section v-if="scopedInterrupted.length > 0" class="task-center-group" data-test="task-center-group-residual">
            <h3 class="task-center-group-title">
              中断遗留
              <span class="task-center-residual-badge" data-test="task-center-residual-badge">残留</span>
            </h3>
            <div class="task-center-group-list">
              <div
                v-for="task in visibleInterrupted"
                :key="task.taskId"
                class="task-center-row"
                :class="[`status-${task.status}`, { selected: store.selectedTaskId === task.taskId }]"
                :data-test="`task-center-row-${task.taskId}`"
              >
                <div class="task-center-row-top">
                  <button
                    type="button"
                    class="task-center-row-main"
                    :title="`${statusMeta(task).label} · ${agentName(task)}${task.description ? ` · ${task.description}` : ''}`"
                    @click="store.selectTask(task.taskId)"
                  >
                    <v-icon :icon="statusMeta(task).icon" size="14" aria-hidden="true" />
                    <span class="task-center-status" :class="`status-${task.status}`" data-test="task-center-status-text">
                      {{ statusMeta(task).label }}
                    </span>
                    <span class="task-center-residual-badge" data-test="task-center-residual-badge">残留</span>
                    <span class="task-center-agent" data-test="task-center-agent">{{ agentName(task) }}</span>
                    <span class="task-center-desc" :title="task.description">
                      {{ task.description ? truncateText(task.description, 40) : "—" }}
                    </span>
                  </button>
                </div>
                <div class="task-center-row-meta">
                  <span data-test="task-center-source" :title="task.parentSessionId">来源 {{ sourceLabel(task) }}</span>
                  <span data-test="task-center-duration">用时 {{ formatDuration(liveDurationMs(task)) }}</span>
                  <span data-test="task-center-model">模型 {{ modelLabel(task) }}</span>
                  <span data-test="task-center-cost">费用 {{ formatCost(task.usage.cost) }}</span>
                  <span v-if="task.hasUnclosedToolCall" class="unclosed-hint" data-test="task-center-unclosed-hint">
                    存在未完成工具调用
                  </span>
                </div>
              </div>
              <div v-if="interruptedOverflow > 0" class="task-center-overflow" data-test="task-center-interrupted-overflow">
                还有 {{ interruptedOverflow }} 个任务未显示
              </div>
            </div>
          </section>

          <!-- 恢复数据损坏（无对应任务镜像的条目）：只读诊断/导出，无清理按钮 -->
          <section v-if="orphanIssues.length > 0" class="task-center-group" data-test="task-center-group-issues">
            <h3 class="task-center-group-title">恢复数据损坏</h3>
            <div class="task-center-group-list">
              <div
                v-for="issue in visibleIssues"
                :key="issue.taskId"
                class="task-center-row agent-task-issue-row"
                :data-test="`task-center-issue-${issue.taskId}`"
              >
                <div class="task-center-row-top">
                  <div class="task-center-row-main agent-task-issue-main">
                    <v-icon icon="mdi-alert-decagram-outline" size="14" aria-hidden="true" />
                    <span class="task-center-status status-issue" data-test="task-center-issue-code">{{ recoveryIssueLabel(issue.code) }}</span>
                    <span class="task-center-desc" :title="issue.message">{{ issue.message ? truncateText(issue.message, 40) : "—" }}</span>
                    <span v-if="issue.readOnly" class="agent-task-readonly-badge" data-test="task-center-issue-readonly">只读</span>
                  </div>
                  <div class="task-center-row-actions">
                    <button
                      type="button"
                      class="agent-task-action-btn"
                      data-test="task-center-issue-export-btn"
                      :disabled="busyKey !== null"
                      title="导出诊断信息"
                      @click="exportIssue(issue)"
                    >
                      导出诊断
                    </button>
                  </div>
                </div>
              </div>
              <div v-if="issuesOverflow > 0" class="task-center-overflow" data-test="task-center-issues-overflow">
                还有 {{ issuesOverflow }} 条未显示
              </div>
            </div>
          </section>
        </template>
      </div>

      <!-- 右列：详情 -->
      <div class="task-center-detail">
        <TaskDetailPanel
          v-if="selectedTask"
          :key="selectedTask.taskId"
          :task="selectedTask"
          :session-names="props.sessionNames"
        />
        <div v-else class="task-center-detail-empty" data-test="task-center-detail-empty">
          选择左侧任务查看详情
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.task-center {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--pix-bg-content);
}

.task-center-error {
  flex-shrink: 0;
  margin: var(--pix-space-sm) var(--pix-space-lg) 0;
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border: 1px solid var(--pix-error-light);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-error-bg);
  font-size: var(--pix-text-xs);
  color: var(--pix-error);
}

.task-center-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--pix-space-md);
  min-height: var(--pix-topbar-height);
  padding: 0 var(--pix-space-lg);
  border-bottom: 1px solid var(--pix-border-light);
  background: var(--pix-bg-topbar);
}

/* 作用域切换(当前会话|全部):次级控件,弱于主视图 tab */
.task-center-scope {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-code);
  flex-shrink: 0;
}

.task-center-scope-btn {
  padding: 3px 10px;
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-xs);
  font-family: var(--pix-font-ui);
  color: var(--pix-text-secondary);
  cursor: pointer;
  white-space: nowrap;
}

.task-center-scope-btn:hover {
  color: var(--pix-text-primary);
}

.task-center-scope-btn.active {
  color: var(--pix-accent);
  background: var(--pix-bg-content);
  font-weight: var(--pix-weight-medium);
}

.task-center-tabs {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-lg);
  background: rgba(248, 249, 255, 0.88);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
}

.task-center-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: var(--pix-radius-md);
  font-size: var(--pix-text-sm);
  font-family: var(--pix-font-ui);
  color: var(--pix-text-secondary);
  cursor: pointer;
  transition: background var(--pix-transition-fast), color var(--pix-transition-fast);
  font-weight: var(--pix-weight-normal);
}

.task-center-tab:hover {
  background: #ffffff;
  color: var(--pix-text-primary);
}

.task-center-tab.active {
  background: #ffffff;
  color: var(--pix-accent);
  font-weight: var(--pix-weight-medium);
  box-shadow: var(--pix-shadow-xs);
}

.task-center-tab-count {
  font-size: 10px;
  font-weight: var(--pix-weight-semibold);
  padding: 0 5px;
  border-radius: 999px;
  background: var(--pix-bg-code);
  color: var(--pix-text-secondary);
  font-variant-numeric: tabular-nums;
}

.task-center-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* 左列：约 360px 全高滚动 */
.task-center-list {
  width: 360px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: var(--pix-space-md);
  border-right: 1px solid var(--pix-border-subtle);
  min-width: 0;
}

.task-center-group {
  margin-bottom: var(--pix-space-md);
  min-width: 0;
}

.task-center-group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-secondary);
  margin: 0 0 var(--pix-space-xs);
}

.task-center-group-list {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-xs);
}

.task-center-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}

.task-center-row {
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  padding: var(--pix-space-xs) var(--pix-space-sm);
  min-width: 0;
  background: rgba(255, 255, 255, 0.6);
}

.task-center-row.selected {
  border-color: var(--pix-accent-light);
  background: var(--pix-accent-light);
}

.task-center-row.status-failed {
  border-color: var(--pix-error-light);
  background: var(--pix-error-bg);
}

.task-center-row-top {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.task-center-row-main {
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

.task-center-status {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--pix-bg-code);
  color: var(--pix-text-secondary);
  white-space: nowrap;
}

.task-center-status.status-running {
  color: var(--pix-accent);
  background: var(--pix-accent-light);
}

.task-center-status.status-waiting_input {
  color: var(--pix-warning);
  background: var(--pix-warning-light);
}

.task-center-status.status-completed {
  color: var(--pix-success);
  background: var(--pix-success-light);
}

.task-center-status.status-failed {
  color: var(--pix-error);
  background: var(--pix-error-light);
}

.task-center-status.status-cancelled {
  color: var(--pix-text-muted);
}

.task-center-status.status-issue {
  color: var(--pix-error);
  background: var(--pix-error-light);
}

.task-center-workflow-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: var(--pix-weight-semibold);
  padding: 0 6px;
  border-radius: 999px;
  color: var(--pix-accent);
  background: var(--pix-accent-light);
}

.task-center-residual-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: var(--pix-weight-semibold);
  padding: 0 6px;
  border-radius: 999px;
  color: var(--pix-warning);
  background: var(--pix-warning-light);
}

.task-center-agent {
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

.task-center-desc {
  flex: 1;
  min-width: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-center-row-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.task-center-row-meta {
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

.task-center-overflow {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  padding: var(--pix-space-xs) 0;
}

.queue-hint,
.slot-hint {
  color: var(--pix-warning);
  font-weight: var(--pix-weight-medium);
}

.bg-warning-hint {
  color: var(--pix-text-muted);
  font-weight: var(--pix-weight-medium);
}

.unclosed-hint {
  color: var(--pix-warning);
  font-weight: var(--pix-weight-medium);
}

/* recovery issue 行 */
.agent-task-issue-row {
  background: var(--pix-error-bg);
  border-color: var(--pix-error-light);
}

.agent-task-issue-main {
  cursor: default;
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

/* 右列：详情 flex */
.task-center-detail {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.task-center-detail-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
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
</style>
