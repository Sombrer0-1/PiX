<script setup lang="ts">
/**
 * AgentTaskDetail - 任务详情摘要（任务中心「摘要」tab 内容，PiX 1.5 P1/P2）
 *
 * 只读展示:描述、失败原因与下一步、有界活动列表（AGENT_TASK_MAX_ACTIVITIES
 * 上限 + 固定高度滚动）、固定输出区（max-height + 滚动，截断时展示原始大小并
 * 可展开完整输出）、spec 行（agent/模型/思考/模式/maxTurns）、用量与来源。
 *
 * 1.5 (P1)：发送到会话、单项清除、恢复（摘要→确认）区全部移除——结果投递由
 * main 的 sink 补投自动化，恢复由重启自动恢复收敛（失败码 resume_blocked），
 * 记录回收由 retention 自动完成。本组件只读展示。
 * 1.5 (P2)：从「任务行内展开」迁为「摘要 tab 内容」——移除行内展开语义
 * （行按钮 aria-controls/aria-expanded），保留全部只读展示；新增 spec 行
 * （取 itemSummaries/thinkingLevel/executionMode）与任务对应 recovery issue
 * 的只读诊断行 + 导出按钮。
 */
import { computed, ref } from "vue";
import { useAgentTaskStore } from "../../stores/agent-task-store";
import { useLiveNow } from "../../composables/useLiveNow";
import { AGENT_TASK_MAX_ACTIVITIES } from "@shared/agent-task-types.js";
import type { AgentTaskDiagnosticExport, AgentTaskInfo, AgentTaskRecoveryIssue } from "@shared/agent-task-types.js";
import { thinkingLevelLabel } from "../../utils/thinking-labels";

const props = defineProps<{
  task: AgentTaskInfo;
  /** sessionId -> 会话名，用于展示来源会话。 */
  sessionNames?: Record<string, string>;
}>();

const store = useAgentTaskStore();

const nowMs = useLiveNow(
  computed(() => props.task.status === "running" || props.task.status === "waiting_input"),
);

function liveDurationMs(task: AgentTaskInfo): number {
  if ((task.status === "running" || task.status === "waiting_input") && task.startedAt !== undefined) {
    return Math.max(0, nowMs.value - task.startedAt);
  }
  return task.durationMs;
}

const outputExpanded = ref(false);
const busyKey = ref<string | null>(null);

/** 繁忙操作至少展示的进度时长，避免闪烁。 */
const MIN_BUSY_MS = 300;

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
  resume_blocked: "重启后自动恢复未通过安全检查（工作区变化/记录损坏/模型不可用），任务已按失败收敛；可查看恢复诊断了解具体原因。",
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
  storage_limit: "存储超限",
  user_decision: "用户决定",
  resume_blocked: "自动恢复未通过",
};

const ACTIVITY_STATUS_LABELS: Record<string, string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
};

const RECOVERY_ISSUE_LABELS: Record<string, string> = {
  tail_corrupt: "日志尾部损坏",
  mid_log_corrupt: "日志中段损坏",
  session_header_corrupt: "会话头损坏",
  index_corrupt: "索引损坏",
  unknown_schema: "未知 schema 版本",
  migration_failed: "迁移失败",
};

const EXECUTION_MODE_LABELS: Record<string, string> = {
  "read-only": "只读",
  approval: "需要审批",
  unattended: "自动执行",
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

const agentName = computed(() => props.task.itemSummaries[0]?.agentName ?? "agent");
const modelLabel = computed(() => {
  const model = props.task.itemSummaries[0]?.model;
  return model ? `${model.provider}/${model.modelId}` : "—";
});
const thinkingLabel = computed(() => thinkingLevelLabel(props.task.thinkingLevel));
const executionModeLabel = computed(
  () => EXECUTION_MODE_LABELS[props.task.executionMode] ?? props.task.executionMode,
);
const maxTurnsLabel = computed(() => {
  const maxTurns = props.task.itemSummaries[0]?.maxTurns;
  return maxTurns !== undefined ? `最多 ${maxTurns} 轮` : "不限";
});

/** 任务对应的 recovery issue（存在时只读诊断行 + 导出）。 */
const taskIssue = computed<AgentTaskRecoveryIssue | null>(
  () => store.recoveryIssues.find((issue) => issue.taskId === props.task.taskId) ?? null,
);

function recoveryIssueLabel(code: AgentTaskRecoveryIssue["code"]): string {
  return RECOVERY_ISSUE_LABELS[code] ?? code;
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

/** 防重复提交 + 至少 300ms 的进度指示。 */
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
    console.error("[agent-task-detail] Failed to download diagnostics:", err);
  }
}
</script>

<template>
  <div class="agent-task-detail" data-test="agent-task-detail">
    <div class="agent-task-detail-desc" data-test="agent-task-detail-desc">{{ task.description || "—" }}</div>

    <!-- spec 行：agent/模型/思考/模式/maxTurns（取 itemSummaries/thinkingLevel/executionMode） -->
    <div class="agent-task-detail-spec" data-test="agent-task-spec">
      <span class="agent-task-detail-spec-item">Agent <b data-test="agent-task-spec-agent">{{ agentName }}</b></span>
      <span class="agent-task-detail-spec-item">模型 <b data-test="agent-task-spec-model">{{ modelLabel }}</b></span>
      <span class="agent-task-detail-spec-item">思考 <b data-test="agent-task-spec-thinking">{{ thinkingLabel }}</b></span>
      <span class="agent-task-detail-spec-item">模式 <b data-test="agent-task-spec-mode">{{ executionModeLabel }}</b></span>
      <span class="agent-task-detail-spec-item">轮次 <b data-test="agent-task-spec-maxturns">{{ maxTurnsLabel }}</b></span>
    </div>

    <!-- 失败原因与下一步 -->
    <div v-if="task.status === 'failed'" class="agent-task-detail-error" data-test="agent-task-detail-error" role="alert">
      <div class="agent-task-detail-error-reason">
        <v-icon icon="mdi-alert-circle-outline" size="14" aria-hidden="true" />
        <span data-test="agent-task-failure-reason">{{ failureLabel }}</span>
        <span v-if="task.errorMessage" class="agent-task-detail-error-msg" data-test="agent-task-error-message">{{ task.errorMessage }}</span>
      </div>
      <div class="agent-task-detail-next-step" data-test="agent-task-next-step">{{ failureNextStep }}</div>
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

    <!-- 固定输出区 + 截断原大小 + 展开（只读展示；无行内展开语义） -->
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
          :title="outputExpanded ? '收起完整输出' : '展开完整输出'"
          @click="outputExpanded = !outputExpanded"
        >
          {{ outputExpanded ? "收起" : "展开完整输出" }}
        </button>
      </div>
      <div
        class="agent-task-detail-output"
        :class="{ expanded: outputExpanded }"
        data-test="agent-task-detail-output"
        :aria-label="`任务输出，原始大小 ${task.originalOutputBytes} 字节`"
      >
        <pre class="agent-task-detail-output-text">{{ task.finalOutput }}</pre>
      </div>
    </div>

    <!-- 任务对应 recovery issue：只读诊断行 + 导出（记录由保留策略管理，无清理按钮） -->
    <div v-if="taskIssue" class="agent-task-detail-issue" data-test="agent-task-issue" role="status">
      <div class="agent-task-detail-issue-row">
        <v-icon icon="mdi-alert-decagram-outline" size="14" aria-hidden="true" />
        <span class="agent-task-detail-issue-code" data-test="agent-task-issue-code">{{ recoveryIssueLabel(taskIssue.code) }}</span>
        <span class="agent-task-detail-issue-message" :title="taskIssue.message">{{ taskIssue.message || "—" }}</span>
        <span v-if="taskIssue.readOnly" class="agent-task-detail-issue-readonly" data-test="agent-task-issue-readonly">只读</span>
      </div>
      <div class="agent-task-detail-issue-actions">
        <button
          type="button"
          class="agent-task-action-btn"
          data-test="agent-task-issue-export-btn"
          :disabled="busyKey !== null"
          title="导出诊断信息"
          @click="exportIssue(taskIssue)"
        >
          导出诊断
        </button>
      </div>
    </div>

    <!-- 用量 -->
    <div class="agent-task-detail-usage" data-test="agent-task-detail-usage">
      <span>Tokens {{ formatTokens(task.usage.totalTokens) }}</span>
      <span>费用 {{ formatCost(task.usage.cost) }}</span>
      <span>{{ task.usage.turns }} 轮</span>
      <span>工具 {{ task.toolUseCount }} 次</span>
      <span>用时 {{ formatDuration(liveDurationMs(task)) }}</span>
    </div>

    <!-- Plan link -->
    <div v-if="task.planLink" class="agent-task-detail-link" data-test="agent-task-plan-link">
      <v-icon icon="mdi-link-variant" size="13" aria-hidden="true" />
      <span class="agent-task-detail-link-text" :title="`计划 ${task.planLink.planId} 版本 ${task.planLink.version} 步骤 ${task.planLink.stepId}`">
        关联计划 {{ task.planLink.planId }} · v{{ task.planLink.version }} · 步骤 {{ task.planLink.stepId }}
      </span>
    </div>

    <!-- Plan 结果尚未消费提示（只读说明） -->
    <div v-if="task.planLinkState === 'pending'" class="agent-task-plan-protected" data-test="agent-task-plan-protected" role="status">
      该任务关联的计划尚未消费结果。
    </div>

    <!-- 来源会话 -->
    <div class="agent-task-detail-source" data-test="agent-task-detail-source">
      <span class="agent-task-detail-source-label" :title="task.parentSessionId">
        <v-icon icon="mdi-account-arrow-right-outline" size="13" aria-hidden="true" />
        来源 {{ sourceLabel }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.agent-task-detail {
  padding: var(--pix-space-md);
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

/* spec 行 */
.agent-task-detail-spec {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-bottom: var(--pix-space-sm);
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-code);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  min-width: 0;
}

.agent-task-detail-spec-item {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-task-detail-spec-item b {
  color: var(--pix-text-primary);
  font-weight: var(--pix-weight-medium);
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
}

.agent-task-plan-protected {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  margin-bottom: var(--pix-space-sm);
}

/* recovery issue 只读诊断行 */
.agent-task-detail-issue {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--pix-space-sm);
  margin-bottom: var(--pix-space-sm);
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border: 1px solid var(--pix-error-light);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-error-bg);
  min-width: 0;
}

.agent-task-detail-issue-row {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--pix-text-xs);
  color: var(--pix-error);
  min-width: 0;
}

.agent-task-detail-issue-code {
  flex-shrink: 0;
  font-weight: var(--pix-weight-semibold);
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--pix-error-light);
  white-space: nowrap;
}

.agent-task-detail-issue-message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--pix-text-secondary);
}

.agent-task-detail-issue-readonly {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: var(--pix-weight-semibold);
  padding: 0 6px;
  border-radius: 999px;
  color: var(--pix-text-secondary);
  background: var(--pix-bg-code);
}

.agent-task-detail-issue-actions {
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

.agent-task-action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background: var(--pix-bg-hover);
  color: var(--pix-text-primary);
}
</style>
