<script setup lang="ts">
/**
 * PlanPanel - 计划面板（PiX 1.4.0）
 *
 * 计划面板：标题/版本/状态/模型/时间、摘要、当前步骤/总步骤进度、步骤列表
 * （折叠、文件可点击、风险图标+文字）、底部操作（批准并执行/修订/放弃）。
 * 错误紧邻 Plan/step 且携下一步操作：planning_failed 提供重试生成、改用会话
 * 模型重试、精简重新生成（truncated）与放弃；修订失败提供重试修订、返回上一
 * 版本与放弃；步骤失败提供重试步骤。批准后显式启动：awaiting_approval 时
 * 「批准并执行」依次发送 approve + start_execution；read-only 停在 approved
 * 后由「开始执行」显式启动。所有繁忙操作至少展示 300ms 进度指示并防重复提交。
 *
 * 数据全部来自 plan-store 镜像，本组件不直接触碰 IPC。failure/revision 是
 * store 的独立响应式 ref（applySnapshot 时更新）：即使 planPhase 值不变
 * （如修订失败保持 revising、仅 failure 更新），错误与下一步操作也能立即反映。
 */
import { computed, ref } from "vue";
import { usePlanStore } from "../../stores/plan-store";
import PlanStepCard from "./PlanStepCard.vue";
import type {
  PlanDeviation,
  PlanGenerationFailure,
  PlanStatus,
  PlanStep,
} from "@shared/types.js";

const store = usePlanStore();

const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  planning: "规划中",
  planning_failed: "规划失败",
  awaiting_approval: "待批准",
  revising: "修订中",
  approved: "已批准",
  executing: "执行中",
  paused: "已暂停",
  completed: "已完成",
  failed: "已失败",
  cancelled: "已取消",
};

/** 繁忙操作（approve/start/retry/cancel 等）至少展示 300ms 的进度状态，避免闪烁。 */
const MIN_BUSY_MS = 300;

const showAbandonConfirm = ref(false);
const revisionOpen = ref(false);
const revisionFeedback = ref("");
const busy = ref(false);
const approveBusy = ref(false);

const plan = computed(() => store.currentPlan);
const phase = computed(() => store.planPhase);
const failure = computed<PlanGenerationFailure | null>(() => store.failure);

const stepDeviations = computed(() => {
  const map = new Map<string, PlanDeviation[]>();
  for (const deviation of store.deviations) {
    const list = map.get(deviation.stepId) ?? [];
    list.push(deviation);
    map.set(deviation.stepId, list);
  }
  return map;
});

const completedCount = computed(
  () => plan.value?.steps.filter((s) => s.status === "completed" || s.status === "skipped").length ?? 0,
);
const runningStepIndex = computed(() => {
  const steps = plan.value?.steps ?? [];
  const idx = steps.findIndex((s) => s.status === "running" || s.status === "waiting_input");
  return idx >= 0 ? idx + 1 : null;
});
const progressText = computed(() => {
  const steps = plan.value?.steps ?? [];
  if (steps.length === 0) return "";
  if (runningStepIndex.value != null) return `${runningStepIndex.value}/${steps.length}`;
  return `${completedCount.value}/${steps.length}`;
});
const statusLabel = computed(() => (phase.value ? PLAN_STATUS_LABELS[phase.value] : ""));
const revisionAllowed = computed(() => phase.value === "awaiting_approval");
const canSubmitRevision = computed(() => revisionFeedback.value.trim().length > 0);
const canContinueExecution = computed(() => {
  const steps = plan.value?.steps ?? [];
  const waitingTask = steps.some(
    (step) =>
      (step.status === "waiting_input" || step.status === "interrupted") &&
      step.waitingReason === "agent_task",
  );
  const verifying = steps.some(
    (step) => step.status === "running" && typeof step.consumedTaskGroupId === "string" && step.consumedTaskGroupId !== "",
  );
  if (waitingTask || verifying) {
    return true;
  }
  return !steps.some((step) => step.status === "failed");
});
const showGenerating = computed(
  () => (phase.value === "planning" || phase.value === "revising") && !failure.value,
);
const generatingText = computed(() =>
  phase.value === "revising" ? "正在修订计划..." : "正在生成计划...",
);
const hasFooterActions = computed(() => {
  const p = phase.value;
  return p === "awaiting_approval" || p === "approved" || p === "paused" || p === "executing";
});
const commandError = computed(() => store.lastError);

function formatTime(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return "";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 防重复提交 + 至少 300ms 的进度指示。 */
async function runBusy(fn: () => Promise<unknown>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  const startedAt = Date.now();
  try {
    await fn();
  } finally {
    const elapsed = Date.now() - startedAt;
    const rest = Math.max(0, MIN_BUSY_MS - elapsed);
    if (rest > 0) {
      await new Promise((resolve) => setTimeout(resolve, rest));
    }
    busy.value = false;
  }
}

/** awaiting_approval：先 approve，再显式 start_execution（read-only 时停在 approved）。 */
async function approveAndStart(): Promise<void> {
  const current = plan.value;
  if (!current || busy.value || store.isApproving) return;
  approveBusy.value = true;
  busy.value = true;
  const startedAt = Date.now();
  try {
    const approved = await store.approve(current.planId, current.version);
    if (!approved.success) return;
    await store.startExecution(current.planId, current.version);
  } finally {
    const elapsed = Date.now() - startedAt;
    const rest = Math.max(0, MIN_BUSY_MS - elapsed);
    if (rest > 0) {
      await new Promise((resolve) => setTimeout(resolve, rest));
    }
    approveBusy.value = false;
    busy.value = false;
  }
}

function startExecution(): void {
  const current = plan.value;
  if (!current) return;
  void runBusy(() => store.startExecution(current.planId, current.version));
}

function continuePlan(): void {
  const current = plan.value;
  if (!current) return;
  void runBusy(() => store.continuePlan(current.planId, current.version));
}

function retryFailedStep(step: PlanStep): void {
  const current = plan.value;
  if (!current) return;
  void runBusy(() => store.retryStep(current.planId, current.version, step.stepId));
}

function requestStepRevision(step: PlanStep, feedback: string): void {
  const current = plan.value;
  if (!current) return;
  void runBusy(() => store.requestRevision(current.planId, current.version, feedback, step.stepKey));
}

function submitPanelRevision(): void {
  const current = plan.value;
  const feedback = revisionFeedback.value.trim();
  if (!current || !feedback || busy.value) return;
  void runBusy(async () => {
    await store.requestRevision(current.planId, current.version, feedback);
    revisionOpen.value = false;
    revisionFeedback.value = "";
  });
}

function retryGeneration(): void {
  const id = failure.value?.generationId;
  if (!id) return;
  void runBusy(() => store.retryGeneration(id));
}

function useSessionModelAndRetry(): void {
  const id = failure.value?.generationId;
  if (!id) return;
  void runBusy(() => store.useSessionModelAndRetry(id));
}

function regenerateConcise(): void {
  const id = failure.value?.generationId;
  if (!id) return;
  void runBusy(() => store.regeneratePlan(id, true));
}

function retryRevision(): void {
  // 修订失败时 phase 仍为 revising，request_revision 会被 controller 拒绝；
  // 正确命令是 retry_generation（controller 在 revising 下接受，且按
  // failure.generationId 重试同一 revision generation）。
  const id = failure.value?.generationId;
  if (!id) return;
  void runBusy(() => store.retryGeneration(id));
}

function returnPreviousVersion(): void {
  const current = plan.value;
  const baseVersion = store.revision?.baseVersion ?? current?.version;
  if (!current || baseVersion === undefined) return;
  void runBusy(() => store.returnPreviousVersion(current.planId, baseVersion));
}

function openAbandonConfirm(): void {
  if (busy.value) return;
  showAbandonConfirm.value = true;
}

function confirmAbandon(): void {
  showAbandonConfirm.value = false;
  const current = plan.value;
  if (phase.value === "revising") {
    // cancel 在 revising 下被 controller 拒绝；先回退到上一版本
    // （awaiting_approval），用户随后可在底部操作区放弃整个计划。
    returnPreviousVersion();
    return;
  }
  const ref = current
    ? { planId: current.planId, version: current.version }
    : {
        planId: store.latestSnapshot?.planId ?? "",
        generationId:
          store.latestSnapshot?.generation?.generationId ??
          store.latestSnapshot?.failure?.generationId ??
          "",
      };
  void runBusy(() => store.cancel(ref));
}
</script>

<template>
  <section class="plan-panel" data-test="plan-panel" :aria-label="`计划面板：${statusLabel}`">
    <header class="plan-panel-header">
      <div class="plan-panel-title-row">
        <v-icon icon="mdi-map-outline" size="16" aria-hidden="true" />
        <h2 class="plan-panel-title" data-test="plan-title">{{ plan?.title || "规划" }}</h2>
        <span v-if="plan" class="plan-panel-version" data-test="plan-version">v{{ plan.version }}</span>
        <span class="plan-panel-status" :class="`phase-${phase}`" data-test="plan-status">{{ statusLabel }}</span>
      </div>
      <div class="plan-panel-meta">
        <span v-if="plan" class="plan-panel-model" data-test="plan-model">
          {{ plan.planningModel.provider }}/{{ plan.planningModel.modelId }}
        </span>
        <span v-if="plan" class="plan-panel-time" data-test="plan-time">更新于 {{ formatTime(plan.updatedAt) }}</span>
        <span v-if="progressText" class="plan-panel-progress" data-test="plan-progress">{{ progressText }}</span>
      </div>
      <p v-if="plan?.summary" class="plan-panel-summary" data-test="plan-summary">{{ plan.summary }}</p>
    </header>

    <!-- 生成/修订进度 -->
    <div v-if="showGenerating" class="plan-generating" data-test="plan-generating" role="status">
      <v-icon icon="mdi-loading" class="spin" size="16" aria-hidden="true" />
      <span>{{ generatingText }}</span>
    </div>

    <!-- 错误紧邻 Plan/step 且携下一步操作 -->
    <div v-if="failure" class="plan-failure" data-test="plan-failure" role="alert">
      <div class="plan-failure-header">
        <v-icon icon="mdi-alert-outline" size="15" aria-hidden="true" />
        <span>{{ failure.message || "规划生成失败" }}</span>
      </div>
      <div v-if="failure.fieldErrors.length > 0" class="plan-failure-fields">
        <p v-for="error in failure.fieldErrors" :key="error.path">{{ error.path }}：{{ error.message }}</p>
      </div>
      <div class="plan-failure-actions">
        <button
          v-if="failure.phase === 'initial'"
          type="button"
          class="plan-action-btn"
          data-test="plan-retry-generation"
          :disabled="busy"
          @click="retryGeneration"
        >重试生成</button>
        <button
          v-if="failure.phase === 'initial'"
          type="button"
          class="plan-action-btn"
          data-test="plan-use-session-model"
          :disabled="busy"
          @click="useSessionModelAndRetry"
        >改用会话模型重试</button>
        <button
          v-if="failure.code === 'truncated'"
          type="button"
          class="plan-action-btn"
          data-test="plan-regenerate-concise"
          :disabled="busy"
          @click="regenerateConcise"
        >精简重新生成</button>
        <button
          v-if="failure.phase === 'revision'"
          type="button"
          class="plan-action-btn"
          data-test="plan-retry-revision"
          :disabled="busy"
          @click="retryRevision"
        >重试修订</button>
        <button
          v-if="failure.phase === 'revision'"
          type="button"
          class="plan-action-btn"
          data-test="plan-return-previous"
          :disabled="busy"
          @click="returnPreviousVersion"
        >返回上一版本</button>
        <button
          type="button"
          class="plan-action-btn plan-action-danger"
          data-test="plan-abandon-failure"
          :disabled="busy"
          @click="openAbandonConfirm"
        >放弃</button>
      </div>
    </div>

    <!-- 命令错误（stale_version/read_only 等） -->
    <div v-if="commandError" class="plan-command-error" data-test="plan-command-error" role="alert">
      <v-icon icon="mdi-alert-outline" size="14" aria-hidden="true" />
      <span>{{ commandError }}</span>
      <button type="button" class="plan-error-dismiss" data-test="plan-error-dismiss" @click="store.clearError()">
        知道了
      </button>
    </div>

    <!-- 步骤列表（折叠、文件可点击、风险图标+文字、偏离标识） -->
    <ol v-if="plan" class="plan-steps" data-test="plan-steps">
      <li v-for="(step, idx) in plan.steps" :key="step.stepId" class="plan-step-item">
        <PlanStepCard
          :step="step"
          :index="idx + 1"
          :deviations="stepDeviations.get(step.stepId) ?? []"
          :revision-allowed="revisionAllowed"
          @revise="(feedback: string) => requestStepRevision(step, feedback)"
          @retry="() => retryFailedStep(step)"
        />
      </li>
    </ol>

    <!-- 底部操作 -->
    <footer v-if="hasFooterActions" class="plan-panel-actions" data-test="plan-actions">
      <template v-if="phase === 'awaiting_approval'">
        <button
          type="button"
          class="plan-action-btn plan-action-primary"
          data-test="plan-approve-btn"
          :disabled="busy || store.isApproving"
          @click="approveAndStart"
        >
          <v-icon v-if="busy" icon="mdi-loading" class="spin" size="14" aria-hidden="true" />
          <span>{{ busy ? "处理中..." : "批准并执行" }}</span>
        </button>
        <button
          type="button"
          class="plan-action-btn"
          data-test="plan-revise-btn"
          :disabled="busy"
          @click="revisionOpen = true"
        >修订</button>
        <button
          type="button"
          class="plan-action-btn"
          data-test="plan-abandon-btn"
          :disabled="busy"
          @click="openAbandonConfirm"
        >放弃</button>
      </template>
      <template v-else-if="phase === 'approved'">
        <button
          type="button"
          class="plan-action-btn plan-action-primary"
          data-test="plan-start-btn"
          :disabled="busy"
          @click="startExecution"
        >
          <v-icon v-if="busy" icon="mdi-loading" class="spin" size="14" aria-hidden="true" />
          <span>{{ busy ? "处理中..." : "开始执行" }}</span>
        </button>
        <button
          type="button"
          class="plan-action-btn"
          data-test="plan-abandon-btn"
          :disabled="busy"
          @click="openAbandonConfirm"
        >放弃</button>
      </template>
      <template v-else-if="phase === 'paused'">
        <button
          v-if="canContinueExecution"
          type="button"
          class="plan-action-btn plan-action-primary"
          data-test="plan-continue-btn"
          :disabled="busy"
          @click="continuePlan"
        >继续执行</button>
        <button
          type="button"
          class="plan-action-btn"
          data-test="plan-abandon-btn"
          :disabled="busy"
          @click="openAbandonConfirm"
        >放弃</button>
      </template>
      <template v-else-if="phase === 'executing'">
        <button
          type="button"
          class="plan-action-btn"
          data-test="plan-abandon-btn"
          :disabled="busy"
          @click="openAbandonConfirm"
        >放弃</button>
      </template>
    </footer>

    <!-- 面板级修订输入 -->
    <div v-if="revisionOpen" class="plan-revision-panel" data-test="plan-revision-panel">
      <textarea
        v-model="revisionFeedback"
        rows="2"
        class="plan-revision-textarea"
        placeholder="输入整体修订意见..."
        aria-label="修订意见"
        data-test="plan-revision-feedback"
      ></textarea>
      <div class="plan-revision-actions">
        <button
          type="button"
          class="plan-action-btn plan-action-primary"
          data-test="plan-revision-submit"
          :disabled="!canSubmitRevision || busy"
          @click="submitPanelRevision"
        >提交修订</button>
        <button
          type="button"
          class="plan-action-btn"
          data-test="plan-revision-cancel"
          @click="revisionOpen = false; revisionFeedback = ''"
        >取消</button>
      </div>
    </div>

    <!-- 放弃二次确认 -->
    <div
      v-if="showAbandonConfirm"
      class="plan-abandon-confirm"
      data-test="plan-abandon-confirm"
      role="alertdialog"
      aria-label="放弃计划确认"
    >
      <v-icon icon="mdi-help-circle-outline" size="15" aria-hidden="true" />
      <span v-if="phase === 'revising'">确定放弃本次修订？将回退到上一版本，可在待批准后放弃整个计划。</span>
      <span v-else>确定放弃当前计划？放弃后计划将标记为已取消。</span>
      <div class="plan-abandon-actions">
        <button
          type="button"
          class="plan-action-btn"
          data-test="plan-abandon-cancel"
          @click="showAbandonConfirm = false"
        >取消</button>
        <button
          type="button"
          class="plan-action-btn plan-action-danger"
          data-test="plan-abandon-confirm-btn"
          @click="confirmAbandon"
        >确认放弃</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.plan-panel {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-sm);
  flex-shrink: 0;
  max-height: 46vh;
  overflow-y: auto;
  padding: var(--pix-space-md);
  margin: 0 var(--pix-space-xl) var(--pix-space-sm);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  background: rgba(255, 255, 255, 0.96);
  box-shadow: var(--pix-shadow-lg);
}

.plan-panel-header {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.plan-panel-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--pix-accent);
}

.plan-panel-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--pix-text-primary);
  font-size: var(--pix-text-md);
  font-weight: var(--pix-weight-semibold);
}

.plan-panel-version {
  flex-shrink: 0;
  padding: 2px 7px;
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-code);
  color: var(--pix-text-secondary);
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
}

.plan-panel-status {
  flex-shrink: 0;
  padding: 2px 9px;
  border-radius: 10px;
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
}

.plan-panel-status.phase-planning,
.plan-panel-status.phase-revising,
.plan-panel-status.phase-executing,
.plan-panel-status.phase-approved {
  background: var(--pix-accent-light);
  color: var(--pix-accent);
}

.plan-panel-status.phase-awaiting_approval {
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
}

.plan-panel-status.phase-planning_failed,
.plan-panel-status.phase-failed {
  background: var(--pix-error-bg);
  color: var(--pix-error);
}

.plan-panel-status.phase-completed {
  background: var(--pix-success-bg);
  color: var(--pix-success);
}

.plan-panel-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
}

.plan-panel-model {
  font-family: var(--pix-font-mono);
}

.plan-panel-progress {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--pix-bg-code);
  color: var(--pix-text-secondary);
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
}

.plan-panel-summary {
  font-size: var(--pix-text-sm);
  line-height: 1.55;
  color: var(--pix-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.plan-generating {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: var(--pix-radius-md);
  background: var(--pix-accent-light);
  color: var(--pix-accent);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
}

.spin {
  animation: plan-spin 1s linear infinite;
}

@keyframes plan-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.plan-failure,
.plan-command-error {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--pix-radius-md);
  background: var(--pix-error-bg);
  color: var(--pix-error);
  font-size: var(--pix-text-xs);
  line-height: 1.5;
}

.plan-failure-header {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: var(--pix-weight-medium);
}

.plan-failure-fields {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 20px;
  color: var(--pix-text-secondary);
}

.plan-failure-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-left: 20px;
}

.plan-command-error {
  flex-direction: row;
  align-items: center;
}

.plan-error-dismiss {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--pix-error);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  cursor: pointer;
}

.plan-steps {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-sm);
  margin: 0;
  padding: 0;
  list-style: none;
}

.plan-step-item {
  min-width: 0;
}

.plan-panel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: var(--pix-space-xs);
  border-top: 1px solid var(--pix-border-subtle);
}

.plan-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-content);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  font-family: var(--pix-font-ui);
  cursor: pointer;
}

.plan-action-btn:hover:not(:disabled) {
  background: var(--pix-accent-light);
  color: var(--pix-text-primary);
}

.plan-action-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.plan-action-primary {
  background: var(--pix-accent);
  border-color: var(--pix-accent);
  color: var(--pix-text-inverse);
}

.plan-action-primary:hover:not(:disabled) {
  background: var(--pix-accent);
  color: var(--pix-text-inverse);
}

.plan-action-danger {
  border-color: var(--pix-error-light);
  color: var(--pix-error);
}

.plan-action-danger:hover:not(:disabled) {
  background: var(--pix-error-bg);
  color: var(--pix-error);
}

.plan-revision-panel,
.plan-abandon-confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: var(--pix-radius-lg);
  background: var(--pix-bg-hover);
}

.plan-revision-textarea {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  font-family: var(--pix-font-ui);
  font-size: var(--pix-text-sm);
  color: var(--pix-text-primary);
  background: var(--pix-bg-content);
  resize: vertical;
}

.plan-revision-textarea:focus {
  outline: none;
  border-color: var(--pix-accent);
}

.plan-revision-actions,
.plan-abandon-actions {
  display: flex;
  gap: 6px;
}

.plan-abandon-confirm {
  flex-direction: row;
  align-items: center;
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  line-height: 1.5;
}

.plan-abandon-actions {
  margin-left: auto;
}
</style>
