<script setup lang="ts">
/**
 * AgentTaskDetail - 任务详情（PiX 1.4.1；1.4.2 R5 加入恢复/清理）
 *
 * 由 AgentTaskPanel 在任务行展开时挂载：有界活动列表（AGENT_TASK_MAX_ACTIVITIES
 * 上限 + 固定高度滚动）、固定输出区（max-height + 滚动，截断时展示原始大小并
 * 可展开完整输出）、失败原因与下一步操作、Plan/parent link、以及发送结果到
 * 来源/当前同 workspace 会话（已发送过的目标需要二次确认，confirmDuplicate）。
 *
 * 1.4.2 已中断任务提供恢复区：先按 taskId+generation 取得恢复摘要（未完成工具
 * 调用不会自动重放、workspace 变化、模型/环境变化），摘要先于确认——用户明确
 * 确认 workspace 变化（勾选）与模型决策（沿用原模型 / 选择新模型）后才发起
 * resume；标记失败直接进入 failed(user_decision)。详情内的清除按钮同样受
 * 运行中拒绝与 Plan 保护约束（planLinkState=pending 不可清理）。
 *
 * 所有操作按钮至少展示 300ms 忙碌状态并防重复提交；状态不只靠颜色（文字标签
 * 始终存在）。
 */
import { computed, ref, watch } from "vue";
import { useAgentTaskStore } from "../../stores/agent-task-store";
import { AGENT_TASK_MAX_ACTIVITIES } from "@shared/agent-task-types.js";
import type { AgentTaskInfo, AgentTaskResumeSummary, ResumeDecision } from "@shared/agent-task-types.js";

const props = defineProps<{
  /** DOM id（由面板按 taskId 生成，配合 aria-controls）。 */
  id: string;
  task: AgentTaskInfo;
  /** 当前打开的 Solo 会话 id（供「发送到当前会话」）。 */
  currentSessionId?: string | null;
  /** 当前项目物理路径，用于判断「发送到当前会话」是否同 workspace。 */
  currentProjectPhysicalPath?: string | null;
  /** sessionId -> 会话名，用于展示来源会话。 */
  sessionNames?: Record<string, string>;
  /** 面板行内「续接」意图：详情挂载/变化时自动开始「摘要→确认」流程。 */
  resumeIntent?: string | null;
}>();

const emit = defineEmits<{
  /** 请求面板打开清除二次确认。 */
  (e: "clear", task: AgentTaskInfo): void;
  /** 行内「续接」一次性意图已被详情消费：面板应重置 resumeIntentTaskId，仅展开查看不再自动触发续接流程。 */
  (e: "resume-intent-consumed", taskId: string): void;
}>();

const store = useAgentTaskStore();

/** 繁忙操作至少展示的进度时长，避免闪烁。 */
const MIN_BUSY_MS = 300;

const outputExpanded = ref(false);
const sendBusy = ref<string | null>(null);
const confirmSendTarget = ref<string | null>(null);

const FAILURE_NEXT_STEP: Record<string, string> = {
  invalid_parameters: "请检查任务参数后重试。",
  max_turns: "达到最大轮次：可精简任务范围或提高 maxTurns 后重试。",
  api_error: "API 错误：请检查网络与模型服务状态后重试。",
  model_unavailable: "模型不可用：请检查模型配置后重试。",
  model_not_found: "未找到模型：请在设置中检查模型标识。",
  model_ambiguous: "模型不明确：请指定唯一的模型标识。",
  model_auth_unavailable: "模型未认证：请先完成模型认证。",
  unknown_agent: "未知 agent：请检查 agent 名称后重试。",
  tool_unavailable: "工具不可用：请检查 agent 定义的工具集。",
  project_agent_denied: "项目 agent 未获批准：请在设置中批准后重试。",
  prompt_too_large: "提示词过大：请精简任务描述后重试。",
  session_start_failed: "会话启动失败：可重试；持续失败请查看日志。",
  internal_error: "内部错误：可重试；持续失败请查看日志。",
};

const FAILURE_REASON_LABELS: Record<string, string> = {
  invalid_parameters: "参数无效",
  max_turns: "达到最大轮次",
  api_error: "API 错误",
  model_unavailable: "模型不可用",
  model_not_found: "未找到模型",
  model_ambiguous: "模型不明确",
  model_auth_unavailable: "模型未认证",
  unknown_agent: "未知 agent",
  tool_unavailable: "工具不可用",
  project_agent_denied: "项目 agent 未获批准",
  prompt_too_large: "提示词过大",
  session_start_failed: "会话启动失败",
  internal_error: "内部错误",
};

const ACTIVITY_STATUS_LABELS: Record<string, string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
};

const boundedActivities = computed(() => props.task.activities.slice(0, AGENT_TASK_MAX_ACTIVITIES));

const failureLabel = computed(() => {
  const reason = props.task.failureReason;
  return reason ? (FAILURE_REASON_LABELS[reason] ?? reason) : "";
});

const failureNextStep = computed(() => {
  const reason = props.task.failureReason;
  return reason ? (FAILURE_NEXT_STEP[reason] ?? "请重试；持续失败请查看日志。") : "";
});

const sourceLabel = computed(() => {
  const name = props.sessionNames?.[props.task.parentSessionId];
  return name ?? props.task.parentSessionId;
});

const currentSession = computed(() => props.currentSessionId || null);

const sameCurrentWorkspace = computed(() => {
  const current = props.currentProjectPhysicalPath;
  const taskPath = props.task.project.physicalPath;
  if (!current || !taskPath) {
    return false;
  }
  return current === taskPath || current.toLowerCase() === taskPath.toLowerCase();
});

const hasCurrentSession = computed(
  () =>
    !!currentSession.value &&
    currentSession.value !== props.task.parentSessionId &&
    sameCurrentWorkspace.value,
);

const isTerminal = computed(() => {
  return props.task.status === "completed" || props.task.status === "failed" || props.task.status === "cancelled";
});

const canSend = computed(() => isTerminal.value && props.task.finalOutput.trim().length > 0);

/**
 * 可清理：终态或已中断，且关联 Plan 的结果已被消费/释放
 * （planLinkState=pending 受 Plan 保护，必须先消费结果、标记失败或重新规划）。
 */
const isClearable = computed(() => {
  if (props.task.planLinkState === "pending") return false;
  return isTerminal.value || props.task.status === "interrupted";
});

const clearHint = computed(() => {
  if (props.task.planLinkState === "pending") {
    return "该任务关联的计划尚未消费结果：需先消费结果、标记失败或重新规划后才能清理";
  }
  if (props.task.status === "running" || props.task.status === "queued" || props.task.status === "waiting_input") {
    return "运行中的任务不能清理";
  }
  return "清除任务记录";
});

// ==========================================================================
// 1.4.2 恢复：摘要先于确认
// ==========================================================================

/** 恢复区当前阶段：idle（未取摘要）/ summary（仅查看）/ resume（确认续接）。 */
const resumeMode = ref<"idle" | "summary" | "resume">("idle");
const summary = ref<AgentTaskResumeSummary | null>(null);
const summaryError = ref<string | null>(null);
/** 恢复区繁忙动作 key：summary / resume / mark_failed。 */
const recoveryBusy = ref<string | null>(null);
const workspaceConfirmed = ref(false);
const modelDecision = ref<"continue" | "switch">("continue");
const switchProvider = ref("");
const switchModelId = ref("");

const hasWorkspaceChanges = computed(() => (summary.value?.workspaceChanges.length ?? 0) > 0);

const canConfirmResume = computed(() => {
  if (!summary.value) return false;
  if (hasWorkspaceChanges.value && !workspaceConfirmed.value) return false;
  if (modelDecision.value === "switch") {
    return switchProvider.value.trim().length > 0 && switchModelId.value.trim().length > 0;
  }
  return true;
});

/** 面板行内「续接」意图：详情挂载/变更时自动开始「摘要→确认」流程；命中即消费（emit 后由面板重置）。 */
watch(
  () => props.resumeIntent,
  (intent) => {
    if (intent && intent === props.task.taskId && props.task.status === "interrupted") {
      startResumeFlow();
      emit("resume-intent-consumed", props.task.taskId);
    }
  },
  { immediate: true },
);

function resetDecisionState(): void {
  workspaceConfirmed.value = false;
  modelDecision.value = "continue";
  const model = props.task.itemSummaries[0]?.model;
  switchProvider.value = model?.provider ?? "";
  switchModelId.value = model?.modelId ?? "";
}

/** 防重复提交 + 至少 300ms 的进度指示（同一详情同一时刻只允许一个恢复操作）；返回 fn 结果供调用方判断失败。 */
async function runRecoveryBusy<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (recoveryBusy.value) return undefined;
  recoveryBusy.value = key;
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    const elapsed = Date.now() - startedAt;
    const rest = Math.max(0, MIN_BUSY_MS - elapsed);
    if (rest > 0) {
      await new Promise((resolve) => setTimeout(resolve, rest));
    }
    recoveryBusy.value = null;
  }
}

function recoveryBusyText(action: string, idleText: string): string {
  return recoveryBusy.value === action ? "处理中..." : idleText;
}

/** 取得恢复摘要（get_resume_summary），成功后按 mode 展示或进入确认流程。 */
function loadSummary(mode: "summary" | "resume"): void {
  if (recoveryBusy.value) return;
  void runRecoveryBusy(mode === "resume" ? "resume" : "summary", async () => {
    summaryError.value = null;
    const result = await store.getResumeSummary(props.task.taskId, props.task.generation);
    if (result.success && result.data) {
      summary.value = result.data;
      resetDecisionState();
      resumeMode.value = mode;
    } else {
      summaryError.value = result.error ?? "无法取得恢复摘要";
    }
  });
}

function startResumeFlow(): void {
  if (recoveryBusy.value) return;
  if (summary.value) {
    resumeMode.value = "resume";
    return;
  }
  loadSummary("resume");
}

function cancelResume(): void {
  resumeMode.value = "summary";
}

/** 用户明确确认 workspace 变化/模型选择后发起 resume；失败时把原因展示到恢复区错误区（任务保持 interrupted 可重试）。 */
async function confirmResume(): Promise<void> {
  if (recoveryBusy.value || !canConfirmResume.value || !summary.value) return;
  const decision: ResumeDecision =
    modelDecision.value === "switch"
      ? {
          action: "switch_model",
          provider: switchProvider.value.trim(),
          modelId: switchModelId.value.trim(),
          confirmWorkspaceChanges: workspaceConfirmed.value,
        }
      : { action: "continue", confirmWorkspaceChanges: workspaceConfirmed.value };
  const result = await runRecoveryBusy("resume", () =>
    store.resume(props.task.taskId, props.task.generation, decision),
  );
  if (result && !result.success) {
    summaryError.value = result.error ? `续接失败：${result.error}` : "续接失败，请重试。";
  }
}

/** 标记失败（用户决定）：任务进入 failed(user_decision)，不再续接。 */
function markFailedTask(): void {
  if (recoveryBusy.value) return;
  void runRecoveryBusy("mark_failed", () => store.markFailed(props.task.taskId, props.task.generation));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m ${Math.round((ms % 60000) / 1000)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("zh-CN");
}

function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

function activityTime(activity: (typeof boundedActivities.value)[number]): string {
  const end = activity.endedAt ?? activity.startedAt;
  const ms = Math.max(0, end - activity.startedAt);
  return formatDuration(ms);
}

function isDeliveredTo(sessionId: string): boolean {
  return props.task.deliveredSessionIds.includes(sessionId);
}

/** 防重复提交 + 至少 300ms 的进度指示（同一详情同一时刻只允许一个发送操作）。 */
async function runSendBusy(targetSessionId: string, fn: () => Promise<unknown>): Promise<void> {
  if (sendBusy.value) return;
  sendBusy.value = targetSessionId;
  const startedAt = Date.now();
  try {
    await fn();
  } finally {
    const elapsed = Date.now() - startedAt;
    const rest = Math.max(0, MIN_BUSY_MS - elapsed);
    if (rest > 0) {
      await new Promise((resolve) => setTimeout(resolve, rest));
    }
    sendBusy.value = null;
  }
}

/** 发送到目标会话；已发送过的目标先进入二次确认。 */
function sendToSession(targetSessionId: string): void {
  if (sendBusy.value || !canSend.value) return;
  const already = isDeliveredTo(targetSessionId);
  if (already && confirmSendTarget.value !== targetSessionId) {
    confirmSendTarget.value = targetSessionId;
    return;
  }
  confirmSendTarget.value = null;
  void runSendBusy(targetSessionId, () =>
    store.sendToSession(props.task.taskId, props.task.generation, targetSessionId, already),
  );
}

function cancelSendConfirm(): void {
  confirmSendTarget.value = null;
}

function isBusyFor(targetSessionId: string): boolean {
  return sendBusy.value === targetSessionId;
}
</script>

<template>
  <div :id="id" class="agent-task-detail" data-test="agent-task-detail">
    <div
      v-if="store.lastError"
      class="agent-task-detail-error"
      data-test="agent-task-detail-last-error"
      role="alert"
    >
      {{ store.lastError }}
    </div>
    <div class="agent-task-detail-desc" data-test="agent-task-detail-desc">{{ task.description || "—" }}</div>

    <!-- 失败原因与下一步 -->
    <div v-if="task.status === 'failed'" class="agent-task-detail-error" data-test="agent-task-detail-error" role="alert">
      <div class="agent-task-detail-error-reason">
        <v-icon icon="mdi-alert-circle-outline" size="14" aria-hidden="true" />
        <span data-test="agent-task-failure-reason">{{ failureLabel }}</span>
        <span v-if="task.errorMessage" class="agent-task-detail-error-msg" data-test="agent-task-error-message">{{ task.errorMessage }}</span>
      </div>
      <div class="agent-task-detail-next-step" data-test="agent-task-next-step">{{ failureNextStep }}</div>
    </div>

    <!-- 1.4.2 恢复：中断任务的摘要/续接/标记失败（摘要先于确认） -->
    <div v-if="task.status === 'interrupted'" class="agent-task-recovery" data-test="agent-task-recovery">
      <h4 class="agent-task-detail-title">恢复</h4>
      <div class="agent-task-recovery-actions">
        <button
          type="button"
          class="agent-task-action-btn"
          data-test="agent-task-summary-btn"
          :disabled="recoveryBusy !== null"
          title="查看恢复摘要：未完成工具调用、工作区变化与模型/环境变化"
          @click="loadSummary('summary')"
        >
          {{ recoveryBusyText("summary", "查看恢复摘要") }}
        </button>
        <button
          type="button"
          class="agent-task-action-btn"
          data-test="agent-task-resume-btn"
          :disabled="recoveryBusy !== null"
          title="先取得恢复摘要，确认工作区/模型决策后续接"
          @click="loadSummary('resume')"
        >
          {{ recoveryBusyText("resume", "续接") }}
        </button>
        <button
          type="button"
          class="agent-task-action-btn danger"
          data-test="agent-task-mark-failed-btn"
          :disabled="recoveryBusy !== null"
          title="将任务标记为失败（用户决定），不再续接"
          @click="markFailedTask()"
        >
          {{ recoveryBusyText("mark_failed", "标记失败") }}
        </button>
      </div>
      <div v-if="summaryError" class="agent-task-recovery-error" data-test="agent-task-summary-error" role="alert">
        {{ summaryError }}
      </div>
      <div v-if="summary" class="agent-task-resume-summary" data-test="agent-task-resume-summary">
        <div v-if="summary.openToolCalls.length > 0" class="agent-task-summary-line" data-test="agent-task-summary-open-tools">
          未完成工具调用（结果未知，不会自动重放）：
          <span v-for="call in summary.openToolCalls" :key="call.toolCallId" class="agent-task-summary-tool" :title="`${call.toolCallId} · ${new Date(call.startedAt).toLocaleString()}`">
            {{ call.toolName }}
          </span>
        </div>
        <div v-if="summary.modelChanged" class="agent-task-summary-line" data-test="agent-task-summary-model-changed">
          原模型已变化：不会静默替换，请在下方选择续接模型。
        </div>
        <div v-if="summary.environmentChanged" class="agent-task-summary-line" data-test="agent-task-summary-env-changed">
          执行环境已变化，请确认环境可用后继续。
        </div>
        <div v-if="summary.workspaceChanges.length > 0" class="agent-task-summary-line" data-test="agent-task-summary-workspace-changes">
          工作区自退出后已变化（{{ summary.workspaceChanges.length }} 项）：
          <ul class="agent-task-summary-change-list">
            <li v-for="change in summary.workspaceChanges" :key="change" class="agent-task-summary-change">{{ change }}</li>
          </ul>
        </div>
        <div v-else class="agent-task-summary-line" data-test="agent-task-summary-workspace-clean">
          工作区未检测到变化。
        </div>
      </div>
      <!-- 续接决策：仅摘要已取得后出现；确认前不发起 resume -->
      <div v-if="resumeMode === 'resume' && summary" class="agent-task-resume-confirm" data-test="agent-task-resume-confirm" role="dialog" aria-label="确认续接任务">
        <label v-if="hasWorkspaceChanges" class="agent-task-confirm-line">
          <input
            v-model="workspaceConfirmed"
            type="checkbox"
            class="agent-task-checkbox"
            data-test="agent-task-confirm-workspace"
          />
          <span data-test="agent-task-workspace-confirm-text">我确认接受当前工作区变化后继续</span>
        </label>
        <div class="agent-task-model-decision">
          <label class="agent-task-confirm-line">
            <input v-model="modelDecision" type="radio" value="continue" class="agent-task-radio" data-test="agent-task-model-continue" />
            沿用原模型
          </label>
          <label class="agent-task-confirm-line">
            <input v-model="modelDecision" type="radio" value="switch" class="agent-task-radio" data-test="agent-task-model-switch" />
            选择新模型
          </label>
          <div v-if="modelDecision === 'switch'" class="agent-task-model-inputs" data-test="agent-task-model-inputs">
            <input
              v-model="switchProvider"
              type="text"
              class="agent-task-model-input"
              data-test="agent-task-model-provider"
              placeholder="provider"
              aria-label="provider"
            />
            <input
              v-model="switchModelId"
              type="text"
              class="agent-task-model-input"
              data-test="agent-task-model-id"
              placeholder="modelId"
              aria-label="modelId"
            />
          </div>
        </div>
        <div class="agent-task-recovery-confirm-actions">
          <button
            type="button"
            class="agent-task-action-btn"
            data-test="agent-task-resume-cancel-btn"
            :disabled="recoveryBusy !== null"
            @click="cancelResume()"
          >
            取消
          </button>
          <button
            type="button"
            class="agent-task-action-btn"
            data-test="agent-task-resume-confirm-btn"
            :disabled="recoveryBusy !== null || !canConfirmResume"
            :title="hasWorkspaceChanges && !workspaceConfirmed ? '需先确认接受工作区变化' : '确认续接'"
            @click="confirmResume()"
          >
            {{ recoveryBusyText("resume", "确认续接") }}
          </button>
        </div>
      </div>
    </div>

    <!-- 有界活动 -->
    <div v-if="task.activities.length > 0" class="agent-task-detail-section">
      <h4 class="agent-task-detail-title">活动</h4>
      <div class="agent-task-detail-activities" data-test="agent-task-activities" :aria-label="`活动 ${boundedActivities.length} 条`">
        <div v-for="activity in boundedActivities" :key="activity.toolCallId" class="agent-task-detail-activity" :data-test="`agent-task-activity-${activity.toolCallId}`">
          <span class="agent-task-detail-activity-status" :class="`status-${activity.status}`">{{ ACTIVITY_STATUS_LABELS[activity.status] ?? activity.status }}</span>
          <span class="agent-task-detail-activity-tool">{{ activity.toolName }}</span>
          <span v-if="activity.summary" class="agent-task-detail-activity-summary">{{ activity.summary }}</span>
          <span class="agent-task-detail-activity-time">{{ activityTime(activity) }}</span>
        </div>
      </div>
    </div>

    <!-- 固定输出区 + 截断原大小 + 展开 -->
    <div v-if="task.finalOutput" class="agent-task-detail-section">
      <div class="agent-task-detail-title-row">
        <h4 class="agent-task-detail-title">输出</h4>
        <span v-if="task.outputTruncated" class="agent-task-truncated-hint" data-test="agent-task-output-truncated">
          已截断（原始 {{ formatBytes(task.originalOutputBytes) }}）
        </span>
        <button
          v-if="task.outputTruncated"
          type="button"
          class="agent-task-action-btn"
          data-test="agent-task-output-expand-btn"
          :aria-expanded="outputExpanded"
          :aria-controls="`${id}-output`"
          :title="outputExpanded ? '收起完整输出' : '展开完整输出'"
          @click="outputExpanded = !outputExpanded"
        >
          {{ outputExpanded ? "收起" : "展开完整输出" }}
        </button>
      </div>
      <div
        :id="`${id}-output`"
        class="agent-task-detail-output"
        :class="{ expanded: outputExpanded }"
        data-test="agent-task-detail-output"
        :aria-label="`任务输出，原始大小 ${task.originalOutputBytes} 字节`"
      >
        <pre class="agent-task-detail-output-text">{{ task.finalOutput }}</pre>
      </div>
    </div>

    <!-- 用量 -->
    <div class="agent-task-detail-usage" data-test="agent-task-detail-usage">
      <span>Tokens {{ formatTokens(task.usage.totalTokens) }}</span>
      <span>费用 {{ formatCost(task.usage.cost) }}</span>
      <span>{{ task.usage.turns }} 轮</span>
      <span>工具 {{ task.toolUseCount }} 次</span>
      <span>用时 {{ formatDuration(task.durationMs) }}</span>
    </div>

    <!-- Plan link -->
    <div v-if="task.planLink" class="agent-task-detail-link" data-test="agent-task-plan-link">
      <v-icon icon="mdi-link-variant" size="13" aria-hidden="true" />
      <span class="agent-task-detail-link-text" :title="`计划 ${task.planLink.planId} 版本 ${task.planLink.version} 步骤 ${task.planLink.stepId}`">
        关联计划 {{ task.planLink.planId }} · v{{ task.planLink.version }} · 步骤 {{ task.planLink.stepId }}
      </span>
    </div>

    <!-- Plan 保护：结果未被计划消费前不可清理 -->
    <div v-if="task.planLinkState === 'pending'" class="agent-task-plan-protected" data-test="agent-task-plan-protected" role="status">
      该任务关联的计划尚未消费结果，清理被保护：需先消费结果、标记失败或重新规划。
    </div>

    <!-- 来源会话 / 发送到会话 -->
    <div class="agent-task-detail-source" data-test="agent-task-detail-source">
      <span class="agent-task-detail-source-label" :title="task.parentSessionId">
        <v-icon icon="mdi-account-arrow-right-outline" size="13" aria-hidden="true" />
        来源 {{ sourceLabel }}
      </span>
      <div class="agent-task-detail-send-actions">
        <button
          type="button"
          class="agent-task-action-btn"
          data-test="agent-task-send-source-btn"
          :disabled="sendBusy !== null || !canSend"
          :title="isDeliveredTo(task.parentSessionId) ? '该会话已收到过此结果，再次发送需要确认' : '将任务结果发送到来源会话'"
          @click="sendToSession(task.parentSessionId)"
        >
          {{ isBusyFor(task.parentSessionId) ? "处理中..." : `发送到来源${isDeliveredTo(task.parentSessionId) ? "（已发送）" : ""}` }}
        </button>
        <button
          v-if="hasCurrentSession && currentSession"
          type="button"
          class="agent-task-action-btn"
          data-test="agent-task-send-current-btn"
          :disabled="sendBusy !== null || !canSend"
          :title="isDeliveredTo(currentSession) ? '该会话已收到过此结果，再次发送需要确认' : '将任务结果发送到当前会话'"
          @click="sendToSession(currentSession)"
        >
          {{ isBusyFor(currentSession) ? "处理中..." : `发送到当前${isDeliveredTo(currentSession) ? "（已发送）" : ""}` }}
        </button>
        <button
          type="button"
          class="agent-task-action-btn"
          data-test="agent-task-detail-clear-btn"
          :disabled="sendBusy !== null || recoveryBusy !== null || !isClearable"
          :title="clearHint"
          @click="emit('clear', task)"
        >
          清除
        </button>
      </div>
      <div v-if="confirmSendTarget" class="agent-task-send-confirm" data-test="agent-task-send-confirm" role="alertdialog" aria-label="确认重复发送">
        <p class="agent-task-send-confirm-text">该会话已收到过此任务结果，确认再次发送？</p>
        <div class="agent-task-send-confirm-actions">
          <button type="button" class="agent-task-action-btn" data-test="agent-task-send-cancel-btn" @click="cancelSendConfirm">取消</button>
          <button type="button" class="agent-task-action-btn danger" data-test="agent-task-send-confirm-btn" @click="sendToSession(confirmSendTarget)">确认发送</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agent-task-detail {
  margin-top: var(--pix-space-sm);
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-content);
  min-width: 0;
}

.agent-task-detail-desc {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  line-height: var(--pix-leading-base);
  overflow-wrap: anywhere;
  margin-bottom: var(--pix-space-sm);
}

.agent-task-detail-error {
  margin-bottom: var(--pix-space-sm);
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-error-light);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-error-bg);
  color: var(--pix-error);
}

.agent-task-detail-error-reason {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  min-width: 0;
}

.agent-task-detail-error-msg {
  font-weight: var(--pix-weight-medium);
  overflow-wrap: anywhere;
}

.agent-task-detail-next-step {
  margin-top: 3px;
  font-size: var(--pix-text-xs);
  color: var(--pix-error);
  overflow-wrap: anywhere;
}

.agent-task-detail-section {
  margin-bottom: var(--pix-space-sm);
  min-width: 0;
}

.agent-task-detail-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: var(--pix-space-xs);
}

.agent-task-detail-title {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-secondary);
  margin: 0;
}

/* 有界活动：固定高度 + 滚动 */
.agent-task-detail-activities {
  max-height: 120px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.agent-task-detail-activity {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--pix-text-secondary);
  min-width: 0;
}

.agent-task-detail-activity-status {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: var(--pix-weight-medium);
  padding: 0 6px;
  border-radius: 999px;
  background: var(--pix-bg-code);
  color: var(--pix-text-secondary);
}

.agent-task-detail-activity-status.status-running {
  color: var(--pix-accent);
  background: var(--pix-accent-light);
}

.agent-task-detail-activity-status.status-completed {
  color: var(--pix-success);
  background: var(--pix-success-light);
}

.agent-task-detail-activity-status.status-failed {
  color: var(--pix-error);
  background: var(--pix-error-light);
}

.agent-task-detail-activity-tool {
  font-family: var(--pix-font-mono);
  flex-shrink: 0;
}

.agent-task-detail-activity-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-task-detail-activity-time {
  flex-shrink: 0;
  color: var(--pix-text-muted);
  font-variant-numeric: tabular-nums;
}

.agent-task-truncated-hint {
  flex: 1;
  font-size: 10px;
  color: var(--pix-warning);
  font-weight: var(--pix-weight-medium);
}

/* 固定输出区：默认 max-height + 滚动，展开后释放高度 */
.agent-task-detail-output {
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-code);
  min-width: 0;
}

.agent-task-detail-output.expanded {
  max-height: 480px;
}

.agent-task-detail-output-text {
  margin: 0;
  padding: var(--pix-space-sm) var(--pix-space-md);
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  line-height: 1.6;
  color: var(--pix-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.agent-task-detail-usage {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 10px;
  color: var(--pix-text-muted);
  font-variant-numeric: tabular-nums;
  margin-bottom: var(--pix-space-sm);
}

.agent-task-detail-link {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--pix-accent);
  margin-bottom: var(--pix-space-sm);
  min-width: 0;
}

.agent-task-detail-link-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.agent-task-detail-source {
  min-width: 0;
}

.agent-task-detail-source-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--pix-text-secondary);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: var(--pix-space-xs);
}

.agent-task-detail-send-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
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

.agent-task-send-confirm {
  margin-top: var(--pix-space-sm);
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-warning-light);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-warning-light);
}

.agent-task-send-confirm-text {
  margin: 0 0 var(--pix-space-sm);
  font-size: var(--pix-text-xs);
  color: var(--pix-warning);
}

.agent-task-send-confirm-actions {
  display: flex;
  gap: 6px;
}

/* 1.4.2 恢复区 */
.agent-task-recovery {
  margin-bottom: var(--pix-space-sm);
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-warning-light);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-warning-light);
  min-width: 0;
}

.agent-task-recovery-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: var(--pix-space-xs);
}

.agent-task-recovery-error {
  margin-top: var(--pix-space-xs);
  font-size: var(--pix-text-xs);
  color: var(--pix-error);
  overflow-wrap: anywhere;
}

.agent-task-resume-summary {
  margin-top: var(--pix-space-sm);
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.agent-task-summary-line {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  overflow-wrap: anywhere;
}

.agent-task-summary-tool {
  font-family: var(--pix-font-mono);
  background: var(--pix-bg-code);
  border-radius: var(--pix-radius-sm);
  padding: 0 5px;
  margin-left: 4px;
}

.agent-task-summary-change-list {
  margin: 3px 0 0;
  padding-left: 16px;
}

.agent-task-summary-change {
  font-size: var(--pix-text-xs);
  color: var(--pix-warning);
  overflow-wrap: anywhere;
}

.agent-task-resume-confirm {
  margin-top: var(--pix-space-sm);
  padding-top: var(--pix-space-sm);
  border-top: 1px solid var(--pix-border-light);
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.agent-task-confirm-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-primary);
}

.agent-task-checkbox,
.agent-task-radio {
  accent-color: var(--pix-accent);
}

.agent-task-model-decision {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.agent-task-model-inputs {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}

.agent-task-model-input {
  flex: 1;
  min-width: 0;
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  padding: 3px 6px;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-content);
  color: var(--pix-text-primary);
}

.agent-task-recovery-confirm-actions {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}

/* Plan 保护提示 */
.agent-task-plan-protected {
  margin-bottom: var(--pix-space-sm);
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border: 1px solid var(--pix-warning-light);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-warning-light);
  font-size: var(--pix-text-xs);
  color: var(--pix-warning);
  overflow-wrap: anywhere;
}
</style>
