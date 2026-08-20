<script setup lang="ts">
/**
 * SubagentToolView - Rich renderer for the `agent` tool work item
 *
 * Replaces the generic tool item in the work-status list when the tool is the
 * solo-mode `agent` tool. Result parsing order is fixed by the renderer
 * contract (pix-subagent-plan.md 4.10, extended by PiX-1.4-PLAN §3 for 1.4.1):
 * 1. result is { details } and isSubagentDetails(details) -> rich render
 * 2. result is { details } and isAgentTaskGroupHandle(details) -> backgrounded
 *    group: 已转后台 + 任务数/摘要 + 逐任务跳转入口 (no SubagentDetails)
 * 3. details missing/unknown schemaVersion -> extract text from result.content
 *    or the replay content array and show a compatible fallback
 * 4. result === null -> queued/starting placeholder derived from args, never
 *    raw JSON
 *
 * Not a nested card: the root is the work-status item itself and body sections
 * are separated by divider lines. Status is never color-only, collapse controls
 * are semantic buttons, the running region uses aria-live="polite" and all
 * motion is disabled under prefers-reduced-motion.
 */
import { computed, ref, watch } from "vue";
import { aggregateSubagentUsage, isSubagentDetails } from "@shared/subagent-types.js";
import { isAgentTaskGroupHandle } from "@shared/agent-task-types.js";
import type { AgentTaskGroupHandle } from "@shared/agent-task-types.js";
import type {
  SubagentActivity,
  SubagentDetails,
  SubagentMode,
  SubagentSingleResult,
  SubagentStatus,
} from "@shared/subagent-types.js";
import { useAgentTaskStore } from "../../stores/agent-task-store";
import { renderMarkdown } from "@/utils/markdown";

const props = defineProps<{
  result: unknown;
  args: unknown;
  isError: boolean;
}>();

const taskStore = useAgentTaskStore();

const expanded = ref(false);

// ── Parse (fixed order, plan 4.10) ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Join text blocks of a ToolResultMessage-style content value. */
function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
      .map((block) => String(block.text))
      .join("");
  }
  return "";
}

const details = computed<SubagentDetails | null>(() => {
  if (isRecord(props.result) && isSubagentDetails(props.result.details)) {
    return props.result.details;
  }
  return null;
});

/** Case 4: backgrounded agent_task_group handle (1.4.1 §3). */
const groupHandle = computed<AgentTaskGroupHandle | null>(() => {
  if (isRecord(props.result) && isAgentTaskGroupHandle(props.result.details)) {
    return props.result.details;
  }
  return null;
});

const AGENT_TASK_STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  waiting_input: "等待输入",
  interrupted: "已中断",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function agentTaskStatusLabel(status: string): string {
  return AGENT_TASK_STATUS_LABELS[status] ?? status;
}

function groupModeLabel(mode: AgentTaskGroupHandle["mode"]): string {
  const labels: Record<AgentTaskGroupHandle["mode"], string> = {
    single: "单任务",
    parallel: "并行",
    chain: "链式",
  };
  return labels[mode] ?? mode;
}

/** 逐任务跳转：选中任务，让右侧任务面板展开并定位到该任务。 */
function jumpToTask(taskId: string): void {
  taskStore.selectTask(taskId);
}

/** Case 2 fallback: text from result.content, then the result value itself. */
const fallbackText = computed<string>(() => {
  if (props.result === null || props.result === undefined) return "";
  const fromContent = isRecord(props.result) ? textFromContent(props.result.content) : "";
  if (fromContent) return fromContent;
  return textFromContent(props.result);
});

// ── Args helpers (queued/starting placeholder, plan 4.10 case 3) ──

function argsRecord(args: unknown): Record<string, unknown> | null {
  return isRecord(args) ? args : null;
}

function firstTaskName(args: Record<string, unknown>): string | undefined {
  for (const key of ["tasks", "chain"]) {
    const list = args[key];
    if (Array.isArray(list) && list.length > 0 && isRecord(list[0])) {
      const name = list[0].subagent_type;
      if (typeof name === "string" && name) return name;
    }
  }
  return undefined;
}

function modeFromArgs(args: Record<string, unknown>): SubagentMode {
  if (Array.isArray(args.tasks)) return "parallel";
  if (Array.isArray(args.chain)) return "chain";
  return "single";
}

function truncate(text: string, maxLength: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  return `${chars.slice(0, maxLength).join("")}...`;
}

function summaryFromArgs(args: Record<string, unknown>): string {
  if (typeof args.description === "string" && args.description.trim()) return args.description;
  if (typeof args.prompt === "string" && args.prompt.trim()) return truncate(args.prompt.trim(), 90);
  return "";
}

const placeholderAgentName = computed<string>(() => {
  const args = argsRecord(props.args);
  if (!args) return "general-purpose";
  const named = typeof args.subagent_type === "string" && args.subagent_type ? args.subagent_type : firstTaskName(args);
  return named || "general-purpose";
});

const placeholderMode = computed<SubagentMode>(() => {
  const args = argsRecord(props.args);
  return args ? modeFromArgs(args) : "single";
});

const placeholderSummary = computed<string>(() => {
  const args = argsRecord(props.args);
  return args ? summaryFromArgs(args) : "";
});

// ── Overall state ──

const results = computed<SubagentSingleResult[]>(() => details.value?.results ?? []);

const isMulti = computed(() => {
  const mode = details.value?.mode;
  return mode === "parallel" || mode === "chain";
});

const overallStatus = computed<SubagentStatus>(() => {
  const list = results.value;
  if (list.length === 0) return "queued";
  if (list.some((r) => r.status === "running")) return "running";
  if (list.some((r) => r.status === "queued")) return "queued";
  if (list.some((r) => r.status === "failed")) return "failed";
  if (list.some((r) => r.status === "aborted")) return "aborted";
  return "completed";
});

const hasRunning = computed(() => results.value.some((r) => r.status === "running"));

/** Body stays open while anything is running so activity and streaming text
 *  are always visible without interaction. */
const bodyOpen = computed(() => expanded.value || hasRunning.value);

const completedCount = computed(() => results.value.filter((r) => r.status === "completed").length);

const failedCount = computed(() => results.value.filter((r) => r.status === "failed").length);

const abortedCount = computed(() => results.value.filter((r) => r.status === "aborted").length);

const isFullyTerminal = computed(
  () => results.value.length > 0 && results.value.every((r) => r.status !== "queued" && r.status !== "running"),
);

/** Terminal results expand by default so final output and tokens/cost are
 *  visible without interaction; the user can still collapse afterwards. */
watch(isFullyTerminal, (terminal) => {
  if (terminal) expanded.value = true;
}, { immediate: true });

const aggregate = computed(() => (details.value ? aggregateSubagentUsage(details.value) : null));

/** The runner's one-line bounded status summary (result.content) while running. */
const liveSummary = computed(() => {
  if (!hasRunning.value) return "";
  if (isRecord(props.result)) return textFromContent(props.result.content);
  return "";
});

const firstResult = computed(() => results.value[0]);

const headerTitle = computed(() => {
  if (isMulti.value) {
    return details.value?.mode === "parallel" ? "并行任务" : "链式任务";
  }
  return firstResult.value?.agentName ?? "agent";
});

const headerSource = computed(() => {
  if (isMulti.value || !firstResult.value) return "";
  return sourceLabel(firstResult.value.agentSource);
});

const headerSummary = computed(() => {
  if (isMulti.value) {
    const mode = details.value?.mode ?? "single";
    return mode === "parallel" ? `并行 ${results.value.length} 项任务` : `链式 ${results.value.length} 步`;
  }
  return firstResult.value?.description ?? "";
});

const singleMeta = computed(() => {
  if (isMulti.value || !firstResult.value) return "";
  return `工具 ${firstResult.value.toolUseCount} 次 · ${formatDuration(firstResult.value.durationMs)}`;
});

const overallStatusLabel = computed(() => statusLabel(overallStatus.value));

const overallStatusIcon = computed(() => {
  switch (overallStatus.value) {
    case "queued": return "mdi-clock-outline";
    case "completed": return "mdi-check-circle";
    case "failed": return "mdi-alert-circle";
    case "aborted": return "mdi-cancel";
    default: return "mdi-progress-clock";
  }
});

// ── Labels and formatting ──

const STATUS_LABELS: Record<SubagentStatus, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  aborted: "已中止",
};

const SOURCE_LABELS: Record<string, string> = {
  user: "用户",
  project: "项目",
  "built-in": "内置",
  unknown: "未知",
};

const FAILURE_REASON_LABELS: Record<string, string> = {
  invalid_parameters: "参数无效",
  unknown_agent: "未知 agent",
  tool_unavailable: "工具不可用",
  project_agent_denied: "项目 agent 未获批准",
  model_unavailable: "模型不可用",
  model_not_found: "未找到模型",
  model_ambiguous: "模型不明确",
  model_auth_unavailable: "模型未认证",
  prompt_too_large: "提示词过大",
  max_turns: "达到最大轮次",
  api_error: "API 错误",
  aborted: "已中止",
  host_disposed: "会话已关闭",
  session_start_failed: "会话启动失败",
  internal_error: "内部错误",
};

function statusLabel(status: SubagentStatus): string {
  return STATUS_LABELS[status] ?? status;
}

function modeLabel(mode: SubagentMode): string {
  const labels: Record<SubagentMode, string> = {
    single: "单任务",
    parallel: "并行",
    chain: "链式",
  };
  return labels[mode] ?? mode;
}

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function failureReasonLabel(reason: string | undefined): string {
  if (!reason) return "";
  return FAILURE_REASON_LABELS[reason] ?? reason;
}

function isTerminalStatus(status: SubagentStatus): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

function errorLabel(item: SubagentSingleResult): string {
  const reason = failureReasonLabel(item.failureReason);
  const base =
    item.status === "aborted" ? (reason ? `已中止（${reason}）` : "已中止") : reason ? `失败：${reason}` : "失败";
  return item.errorMessage ? `${base}：${item.errorMessage}` : base;
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

function formatTokens(n: number): string {
  return n.toLocaleString("zh-CN");
}

function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

function statusClass(status: SubagentStatus): string {
  return status;
}

function activityStatusClass(activity: SubagentActivity): string {
  return activity.status;
}

function toggleBody(): void {
  expanded.value = !expanded.value;
}
</script>

<template>
  <div class="subagent-tool" :class="{ error: isError }">
    <!-- Case 3: queued/starting placeholder derived from args -->
    <div v-if="props.result === null || props.result === undefined" class="subagent-placeholder" role="status" aria-live="polite">
      <span class="subagent-icon" aria-hidden="true">
        <span class="spinner"></span>
      </span>
      <span class="subagent-title">{{ placeholderAgentName }}</span>
      <span class="subagent-source">{{ modeLabel(placeholderMode) }}</span>
      <span class="subagent-status running">{{ isError ? "失败" : "排队中" }}</span>
      <span v-if="placeholderSummary" class="subagent-summary">{{ placeholderSummary }}</span>
    </div>

    <!-- Case 1: rich details -->
    <template v-else-if="details">
      <button type="button" class="subagent-header" :aria-expanded="bodyOpen" @click="toggleBody">
        <span class="subagent-icon" aria-hidden="true">
          <span v-if="hasRunning" class="spinner"></span>
          <v-icon v-else :icon="overallStatusIcon" size="14" />
        </span>
        <span class="subagent-title">{{ headerTitle }}</span>
        <span v-if="headerSource" class="subagent-source">{{ headerSource }}</span>
        <span class="subagent-status" :class="statusClass(overallStatus)">{{ overallStatusLabel }}</span>
        <span v-if="isMulti" class="subagent-progress">
          已完成 {{ completedCount }}/{{ results.length }}<template v-if="failedCount > 0"> · 失败 {{ failedCount }}</template><template v-if="abortedCount > 0"> · 已中止 {{ abortedCount }}</template>
        </span>
        <span v-if="singleMeta" class="subagent-meta">{{ singleMeta }}</span>
        <span class="subagent-summary">{{ headerSummary }}</span>
        <span class="subagent-toggle">
          {{ bodyOpen ? "收起" : "展开" }}
          <v-icon :icon="bodyOpen ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="14" />
        </span>
      </button>

      <div v-if="bodyOpen" class="subagent-body">
        <div v-if="liveSummary" class="subagent-live-summary" aria-live="polite">{{ liveSummary }}</div>

        <!-- single mode: one result, header already carries name/source/meta -->
        <template v-if="!isMulti">
          <div v-if="hasRunning && firstResult" class="subagent-live" aria-live="polite">
            <div v-for="activity in firstResult.activities" :key="activity.toolCallId" class="subagent-activity" :class="activityStatusClass(activity)">
              <span class="subagent-activity-icon" aria-hidden="true">
                <span v-if="activity.status === 'running'" class="spinner"></span>
                <span v-else class="subagent-dot"></span>
              </span>
              <span class="subagent-activity-tool">{{ activity.toolName }}</span>
              <span v-if="activity.summary" class="subagent-activity-text">{{ activity.summary }}</span>
            </div>
            <div v-if="firstResult.finalOutput" class="subagent-streaming streaming" v-html="renderMarkdown(firstResult.finalOutput)"></div>
          </div>
          <template v-else-if="firstResult && isTerminalStatus(firstResult.status)">
            <div v-if="firstResult.finalOutput" class="subagent-output" v-html="renderMarkdown(firstResult.finalOutput)"></div>
            <div v-if="firstResult.failureReason || firstResult.errorMessage" class="subagent-error">
              <v-icon icon="mdi-alert-circle-outline" size="14" />
              <span class="subagent-error-text">{{ errorLabel(firstResult) }}</span>
            </div>
            <div class="subagent-usage">
              Tokens {{ formatTokens(firstResult.usage.totalTokens) }} · 费用 {{ formatCost(firstResult.usage.cost) }} · {{ firstResult.usage.turns }} 轮
            </div>
          </template>
          <div v-else class="subagent-empty">暂无任务结果</div>
        </template>

        <!-- parallel/chain: one row per result with the full item contract -->
        <template v-else>
          <div v-for="item in details.results" :key="item.id" class="subagent-item">
            <div class="subagent-item-header">
              <span class="subagent-status" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span>
              <span v-if="item.step" class="subagent-item-step">第 {{ item.step }} 步</span>
              <span class="subagent-item-name">{{ item.agentName }}</span>
              <span class="subagent-source">{{ sourceLabel(item.agentSource) }}</span>
              <span class="subagent-item-meta">工具 {{ item.toolUseCount }} 次 · {{ formatDuration(item.durationMs) }}</span>
              <span v-if="item.model" class="subagent-item-model" :title="item.model">{{ item.model }}</span>
            </div>
            <div v-if="item.status === 'running'" class="subagent-live" aria-live="polite">
              <div v-for="activity in item.activities" :key="activity.toolCallId" class="subagent-activity" :class="activityStatusClass(activity)">
                <span class="subagent-activity-icon" aria-hidden="true">
                  <span v-if="activity.status === 'running'" class="spinner"></span>
                  <span v-else class="subagent-dot"></span>
                </span>
                <span class="subagent-activity-tool">{{ activity.toolName }}</span>
                <span v-if="activity.summary" class="subagent-activity-text">{{ activity.summary }}</span>
              </div>
              <div v-if="item.finalOutput" class="subagent-streaming streaming" v-html="renderMarkdown(item.finalOutput)"></div>
            </div>
            <div v-else-if="item.finalOutput" class="subagent-output" v-html="renderMarkdown(item.finalOutput)"></div>
            <div v-if="item.failureReason || item.errorMessage" class="subagent-error">
              <v-icon icon="mdi-alert-circle-outline" size="14" />
              <span class="subagent-error-text">{{ errorLabel(item) }}</span>
            </div>
            <div v-if="isTerminalStatus(item.status)" class="subagent-usage">
              Tokens {{ formatTokens(item.usage.totalTokens) }} · 费用 {{ formatCost(item.usage.cost) }} · {{ item.usage.turns }} 轮
            </div>
          </div>
          <div v-if="isFullyTerminal && aggregate" class="subagent-total">
            <span class="subagent-total-label">总计</span>
            <span>Tokens {{ formatTokens(aggregate.totalTokens) }} · 费用 {{ formatCost(aggregate.cost) }} · {{ aggregate.turns }} 轮</span>
          </div>
        </template>
      </div>
    </template>

    <!-- Case 4: backgrounded group handle -> 已转后台 + 任务数/摘要 + 逐任务跳转 -->
    <template v-else-if="groupHandle">
      <div class="subagent-backgrounded" data-test="agent-task-group-handle">
        <div class="subagent-backgrounded-header">
          <span class="subagent-icon" aria-hidden="true">
            <v-icon icon="mdi-arrow-up-bold-circle-outline" size="14" />
          </span>
          <span class="subagent-title">已转后台</span>
          <span class="subagent-source">{{ groupModeLabel(groupHandle.mode) }}</span>
          <span class="subagent-status backgrounded">{{ groupHandle.tasks.length }} 个任务</span>
          <span class="subagent-summary">任务已转为后台执行，可在右侧任务面板查看进度与结果</span>
        </div>
        <div class="subagent-group-tasks">
          <div
            v-for="task in groupHandle.tasks"
            :key="task.taskId"
            class="subagent-group-task"
            :data-test="`agent-task-jump-${task.taskId}`"
          >
            <span class="subagent-status" :class="task.status">{{ agentTaskStatusLabel(task.status) }}</span>
            <span class="subagent-group-task-desc" :title="task.description">{{ truncate(task.description, 60) || "—" }}</span>
            <span class="subagent-group-task-presentation">{{ task.presentation === "background" ? "后台" : "前台" }}</span>
            <button
              type="button"
              class="subagent-jump-btn"
              data-test="agent-task-jump-btn"
              :title="`跳转到任务 ${task.taskId}`"
              @click="jumpToTask(task.taskId)"
            >
              跳转到任务
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- Case 2: compatible fallback from content text -->
    <div v-else class="subagent-fallback">
      <div class="subagent-fallback-header">
        <span class="subagent-title">agent</span>
        <span class="subagent-status" :class="isError ? 'failed' : 'completed'">{{ isError ? "失败" : "结果" }}</span>
      </div>
      <div v-if="fallbackText" class="subagent-output" v-html="renderMarkdown(fallbackText)"></div>
      <span v-else class="subagent-empty">无结果</span>
    </div>
  </div>
</template>

<style scoped>
.subagent-tool {
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  overflow: hidden;
  margin-bottom: var(--pix-space-xs);
  background: var(--pix-bg-content);
  animation: subagent-row-in 0.18s ease-out;
  min-width: 0;
  max-width: 100%;
}

.subagent-tool:last-child {
  margin-bottom: 0;
}

.subagent-tool.error {
  border-color: var(--pix-error-light);
  background: var(--pix-error-bg);
}

/* ── Header / placeholder row ── */
.subagent-header,
.subagent-placeholder {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  text-align: left;
  color: var(--pix-text-primary);
  font-family: var(--pix-font-ui);
  min-width: 0;
}

.subagent-header:hover {
  background: var(--pix-bg-hover);
}

.subagent-placeholder {
  cursor: default;
}

.subagent-icon {
  flex-shrink: 0;
  width: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pix-text-secondary);
}

.subagent-title {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-accent);
  flex: 0 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.subagent-source {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: var(--pix-weight-semibold);
  font-family: var(--pix-font-mono);
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--pix-accent-light);
  color: var(--pix-accent);
  white-space: nowrap;
}

.subagent-status {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--pix-bg-code);
  color: var(--pix-text-secondary);
  white-space: nowrap;
}

.subagent-status.queued {
  color: var(--pix-text-muted);
}

.subagent-status.running {
  color: var(--pix-accent);
  background: var(--pix-accent-light);
}

.subagent-status.completed {
  color: var(--pix-success);
  background: var(--pix-success-light);
}

.subagent-status.failed {
  color: var(--pix-error);
  background: var(--pix-error-light);
}

.subagent-status.aborted {
  color: var(--pix-warning);
  background: var(--pix-warning-light);
}

.subagent-progress,
.subagent-meta {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  font-variant-numeric: tabular-nums;
}

.subagent-summary {
  flex: 1;
  min-width: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  overflow-wrap: anywhere;
}

.subagent-toggle {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  font-weight: var(--pix-weight-medium);
}

/* ── Body ── */
.subagent-body {
  border-top: 1px solid var(--pix-border-light);
  padding: var(--pix-space-sm) var(--pix-space-md);
  background: rgba(255, 255, 255, 0.86);
  min-width: 0;
}

.subagent-live-summary {
  font-size: var(--pix-text-xs);
  color: var(--pix-accent);
  font-weight: var(--pix-weight-medium);
  margin-bottom: var(--pix-space-sm);
  overflow-wrap: anywhere;
}

.subagent-live {
  margin-bottom: var(--pix-space-sm);
}

.subagent-activity {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  margin-bottom: 3px;
  min-width: 0;
}

.subagent-activity.completed {
  color: var(--pix-success);
}

.subagent-activity.failed {
  color: var(--pix-error);
}

.subagent-activity-icon {
  flex-shrink: 0;
  width: 10px;
  height: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.subagent-activity-icon .spinner {
  width: 8px;
  height: 8px;
  border-width: 1.5px;
}

.subagent-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.subagent-activity-tool {
  font-family: var(--pix-font-mono);
  flex-shrink: 0;
}

.subagent-activity-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* ── Streaming / final output (shared markdown render) ── */
.subagent-streaming,
.subagent-output {
  font-size: var(--pix-text-base);
  line-height: var(--pix-leading-relaxed);
  color: #000000;
  max-width: 100%;
  overflow-wrap: anywhere;
}

.subagent-streaming {
  margin-top: var(--pix-space-sm);
}

.subagent-output {
  margin-top: var(--pix-space-sm);
}

.subagent-streaming :deep(p),
.subagent-output :deep(p) {
  margin-bottom: var(--pix-space-sm);
}

.subagent-streaming :deep(p:last-child),
.subagent-output :deep(p:last-child) {
  margin-bottom: 0;
}

.subagent-streaming :deep(ul),
.subagent-streaming :deep(ol),
.subagent-output :deep(ul),
.subagent-output :deep(ol) {
  margin: var(--pix-space-sm) 0;
  padding-left: var(--pix-space-xl);
}

.subagent-streaming :deep(li),
.subagent-output :deep(li) {
  margin-bottom: var(--pix-space-xs);
}

.subagent-streaming :deep(h1),
.subagent-streaming :deep(h2),
.subagent-streaming :deep(h3),
.subagent-streaming :deep(h4),
.subagent-output :deep(h1),
.subagent-output :deep(h2),
.subagent-output :deep(h3),
.subagent-output :deep(h4) {
  margin: var(--pix-space-lg) 0 var(--pix-space-sm);
  font-weight: var(--pix-weight-semibold);
  line-height: var(--pix-leading-tight);
}

.subagent-streaming :deep(h1),
.subagent-output :deep(h1) {
  font-size: var(--pix-text-xl);
}

.subagent-streaming :deep(h2),
.subagent-output :deep(h2) {
  font-size: var(--pix-text-lg);
}

.subagent-streaming :deep(h3),
.subagent-output :deep(h3) {
  font-size: var(--pix-text-md);
}

.subagent-streaming :deep(h4),
.subagent-output :deep(h4) {
  font-size: var(--pix-text-base);
}

.subagent-streaming :deep(blockquote),
.subagent-output :deep(blockquote) {
  border-left: 3px solid var(--pix-border);
  padding-left: var(--pix-space-md);
  color: var(--pix-text-secondary);
  margin: var(--pix-space-md) 0;
}

.subagent-streaming :deep(table),
.subagent-output :deep(table) {
  border-collapse: collapse;
  margin: var(--pix-space-md) 0;
  font-size: var(--pix-text-sm);
  width: 100%;
}

.subagent-streaming :deep(th),
.subagent-streaming :deep(td),
.subagent-output :deep(th),
.subagent-output :deep(td) {
  border: 1px solid var(--pix-border-light);
  padding: var(--pix-space-xs) var(--pix-space-md);
  text-align: left;
}

.subagent-streaming :deep(th),
.subagent-output :deep(th) {
  background: var(--pix-bg-code);
  font-weight: var(--pix-weight-semibold);
}

.subagent-streaming :deep(hr),
.subagent-output :deep(hr) {
  border: none;
  border-top: 1px solid var(--pix-border-light);
  margin: var(--pix-space-lg) 0;
}

.subagent-streaming :deep(strong),
.subagent-output :deep(strong) {
  font-weight: var(--pix-weight-semibold);
}

.subagent-streaming :deep(a),
.subagent-output :deep(a) {
  color: var(--pix-accent);
  overflow-wrap: anywhere;
}

.subagent-streaming :deep(code),
.subagent-output :deep(code) {
  font-size: 0.94em;
}

.subagent-streaming :deep(.code-block),
.subagent-output :deep(.code-block) {
  position: relative;
  margin: var(--pix-space-md) 0;
}

.subagent-streaming :deep(.code-block pre),
.subagent-output :deep(.code-block pre) {
  margin: 0;
  padding: var(--pix-space-lg);
  padding-top: 38px;
  background: #f7f8fc;
  border-color: var(--pix-border-light);
  color: #000000;
  font-size: var(--pix-text-sm);
  line-height: 1.65;
}

.subagent-streaming :deep(.code-block code),
.subagent-output :deep(.code-block code) {
  font-size: inherit;
  color: inherit;
}

.subagent-streaming :deep(.code-copy-btn),
.subagent-output :deep(.code-copy-btn) {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--pix-radius-md);
  background: #ffffff;
  border: 1px solid var(--pix-border);
  color: var(--pix-text-secondary);
  box-shadow: var(--pix-shadow-xs);
}

.subagent-streaming :deep(.code-copy-btn:hover),
.subagent-output :deep(.code-copy-btn:hover) {
  color: var(--pix-text-primary);
  background: var(--pix-accent-light);
}

.subagent-streaming :deep(.code-copy-btn.copied),
.subagent-output :deep(.code-copy-btn.copied) {
  color: var(--pix-success);
  border-color: #bbf7d0;
}

.subagent-streaming.streaming :deep(p:last-child::after) {
  content: "";
  display: inline-block;
  width: 6px;
  height: 14px;
  background: var(--pix-accent);
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: subagent-cursor-blink 1s step-end infinite;
}

@keyframes subagent-cursor-blink {
  50% { opacity: 0; }
}

/* ── Multi-item rows ── */
.subagent-item {
  border-top: 1px solid var(--pix-border-light);
  padding: var(--pix-space-sm) 0;
  min-width: 0;
}

.subagent-item:first-of-type {
  border-top: none;
  padding-top: 0;
}

.subagent-item:last-of-type {
  padding-bottom: 0;
}

.subagent-item-header {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  min-width: 0;
}

.subagent-item-step {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}

.subagent-item-name {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  min-width: 0;
  overflow-wrap: anywhere;
}

.subagent-item-meta {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  font-variant-numeric: tabular-nums;
}

.subagent-item-model {
  min-width: 0;
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  overflow-wrap: anywhere;
  word-break: break-all;
}

/* ── Error / usage / total ── */
.subagent-error {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin-top: var(--pix-space-sm);
  padding: 6px 8px;
  border-radius: var(--pix-radius-sm);
  background: var(--pix-error-bg);
  color: var(--pix-error);
  font-size: var(--pix-text-xs);
  min-width: 0;
}

.subagent-error-text {
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.subagent-usage {
  margin-top: var(--pix-space-sm);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.subagent-total {
  display: flex;
  align-items: center;
  gap: 7px;
  border-top: 1px solid var(--pix-border-light);
  margin-top: var(--pix-space-sm);
  padding-top: var(--pix-space-sm);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.subagent-total-label {
  font-weight: var(--pix-weight-semibold);
  flex-shrink: 0;
}

.subagent-empty {
  display: block;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  padding: var(--pix-space-sm) 0;
}

/* ── Backgrounded group (case 4) ── */
.subagent-backgrounded {
  border-top: 1px solid var(--pix-border-light);
  padding: var(--pix-space-sm) var(--pix-space-md);
  background: rgba(255, 255, 255, 0.86);
  min-width: 0;
}

.subagent-backgrounded-header {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  min-width: 0;
  margin-bottom: var(--pix-space-sm);
}

.subagent-status.backgrounded {
  color: var(--pix-warning);
  background: var(--pix-warning-light);
}

.subagent-group-tasks {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-xs);
}

.subagent-group-task {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-sm);
  min-width: 0;
}

.subagent-group-task .subagent-status.failed {
  color: var(--pix-error);
  background: var(--pix-error-light);
}

.subagent-group-task .subagent-status.completed {
  color: var(--pix-success);
  background: var(--pix-success-light);
}

.subagent-group-task .subagent-status.waiting_input {
  color: var(--pix-warning);
  background: var(--pix-warning-light);
}

.subagent-group-task-desc {
  flex: 1;
  min-width: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subagent-group-task-presentation {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--pix-text-muted);
}

.subagent-jump-btn {
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

.subagent-jump-btn:hover {
  background: var(--pix-accent-light);
  color: var(--pix-accent);
}

/* ── Fallback (case 2) ── */
.subagent-fallback {
  padding: var(--pix-space-sm) var(--pix-space-md);
  min-width: 0;
}

.subagent-fallback-header {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
}

/* ── Spinner ── */
.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--pix-border-light);
  border-top-color: var(--pix-accent);
  border-radius: 50%;
  animation: subagent-spin 0.6s linear infinite;
}

@keyframes subagent-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes subagent-row-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner,
  .subagent-streaming.streaming :deep(p:last-child::after) {
    animation: none;
  }

  .subagent-tool {
    animation: none;
  }
}
</style>
