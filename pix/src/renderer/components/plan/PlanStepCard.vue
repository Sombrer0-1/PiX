<script setup lang="ts">
/**
 * PlanStepCard - 单步骤渲染（PiX 1.4.0）
 *
 * 渲染一个 PlanStep：标题/状态/风险（图标+文字，不只靠颜色）、可折叠详情
 * （描述/涉及文件/验证/风险理由）、文件点击展示完整路径、偏离标识、修订输入。
 * 命令由 PlanPanel 统一发出，本组件只通过事件上报意图。
 */
import { computed, ref } from "vue";
import type { PlanDeviation, PlanStep, PlanStepFile, PlanStepRisk, PlanStepStatus } from "@shared/types.js";

const props = defineProps<{
  step: PlanStep;
  /** 1-based 展示序号。 */
  index: number;
  /** 绑定到本步骤的偏离（步骤同时标识）。 */
  deviations: PlanDeviation[];
  /** 当前阶段是否允许修订（awaiting_approval）。 */
  revisionAllowed: boolean;
}>();

const emit = defineEmits<{
  revise: [feedback: string];
  retry: [];
}>();

const STEP_STATUS_META: Record<PlanStepStatus, { label: string; icon: string }> = {
  pending: { label: "待执行", icon: "mdi-circle-outline" },
  running: { label: "执行中", icon: "mdi-loading" },
  waiting_input: { label: "等待输入", icon: "mdi-help-circle-outline" },
  completed: { label: "已完成", icon: "mdi-check-circle-outline" },
  failed: { label: "失败", icon: "mdi-alert-circle-outline" },
  skipped: { label: "已跳过", icon: "mdi-skip-next-outline" },
  cancelled: { label: "已取消", icon: "mdi-cancel" },
  // 1.4.2（R4）：task-linked step 异常退出水合为 interrupted，可续接
  interrupted: { label: "已中断", icon: "mdi-pause-circle-outline" },
};

const RISK_META: Record<PlanStepRisk, { label: string; icon: string }> = {
  low: { label: "低风险", icon: "mdi-arrow-down-circle-outline" },
  medium: { label: "中风险", icon: "mdi-minus-circle-outline" },
  high: { label: "高风险", icon: "mdi-arrow-up-circle-outline" },
};

const FILE_OPERATION_LABELS: Record<PlanStepFile["operation"], string> = {
  read: "读取",
  create: "创建",
  modify: "修改",
  delete: "删除",
};

/** 超出该长度的文本折叠并提供展开/收起。 */
const LONG_TEXT_LIMIT = 160;

function expandableText(full: string, expanded: { value: boolean }): { display: string; isLong: boolean } {
  const isLong = full.length > LONG_TEXT_LIMIT;
  return {
    display: isLong && !expanded.value ? `${full.slice(0, LONG_TEXT_LIMIT)}…` : full,
    isLong,
  };
}

const expanded = ref(false);
const descriptionExpanded = ref(false);
const verificationExpanded = ref(false);
const riskReasonExpanded = ref(false);
const revisionOpen = ref(false);
const revisionText = ref("");
const revealedPath = ref<string | null>(null);

const description = computed(() => expandableText(props.step.description, descriptionExpanded));
const verification = computed(() => expandableText(props.step.verification, verificationExpanded));
const riskReason = computed(() => expandableText(props.step.riskReason, riskReasonExpanded));

const statusMeta = computed(() => STEP_STATUS_META[props.step.status]);
const riskMeta = computed(() => RISK_META[props.step.risk]);
const canSubmitRevision = computed(() => revisionText.value.trim().length > 0);

function openRevision(): void {
  revisionOpen.value = true;
  revisionText.value = "";
}

function cancelRevision(): void {
  revisionOpen.value = false;
  revisionText.value = "";
}

function submitRevision(): void {
  const feedback = revisionText.value.trim();
  if (!feedback) return;
  emit("revise", feedback);
  revisionOpen.value = false;
  revisionText.value = "";
}

function toggleFile(path: string): void {
  revealedPath.value = revealedPath.value === path ? null : path;
}
</script>

<template>
  <article class="plan-step-card" :class="[`step-${step.status}`, { 'has-deviation': deviations.length > 0 }]">
    <div class="plan-step-header">
      <button
        type="button"
        class="plan-step-toggle"
        :aria-expanded="expanded"
        :aria-controls="`plan-step-body-${step.stepId}`"
        @click="expanded = !expanded"
      >
        <span class="plan-step-number" aria-hidden="true">{{ index }}</span>
        <span class="step-status-icon" :class="`status-${step.status}`" aria-hidden="true">
          <v-icon :icon="statusMeta.icon" size="14" />
        </span>
        <span class="plan-step-title">{{ step.title }}</span>
        <span class="plan-step-status-text">{{ statusMeta.label }}</span>
        <span class="plan-step-risk" :class="`risk-${step.risk}`">
          <v-icon :icon="riskMeta.icon" size="13" aria-hidden="true" />
          <span>{{ riskMeta.label }}</span>
        </span>
        <span class="plan-step-chevron" aria-hidden="true">
          <v-icon :icon="expanded ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="16" />
        </span>
      </button>

      <div v-if="deviations.length > 0" class="plan-step-deviation" role="status">
        <v-icon icon="mdi-alert-triangle-outline" size="14" aria-hidden="true" />
        <span>
          偏离（{{ deviations.length }}）：{{ deviations[0].reason
          }}<template v-if="deviations[0].path"> · {{ deviations[0].path }}</template>
        </span>
      </div>
    </div>

    <div v-if="expanded" :id="`plan-step-body-${step.stepId}`" class="plan-step-body">
      <p v-if="step.description" class="plan-step-description">
        {{ description.display }}
        <button
          v-if="description.isLong"
          type="button"
          class="text-expand-btn"
          :aria-expanded="descriptionExpanded"
          @click="descriptionExpanded = !descriptionExpanded"
        >{{ descriptionExpanded ? "收起" : "展开" }}</button>
      </p>

      <p v-if="step.scopeNote" class="plan-step-meta">
        <span class="plan-meta-label">范围说明</span>
        <span>{{ step.scopeNote }}</span>
      </p>

      <div v-if="step.files.length > 0" class="plan-step-files">
        <span class="plan-files-label">涉及文件</span>
        <button
          v-for="file in step.files"
          :key="file.path"
          type="button"
          class="plan-file-chip"
          :title="file.path"
          :aria-expanded="revealedPath === file.path"
          @click="toggleFile(file.path)"
        >
          <v-icon icon="mdi-file-outline" size="13" aria-hidden="true" />
          <span class="plan-file-name">{{ file.path }}</span>
          <span class="plan-file-operation">{{ FILE_OPERATION_LABELS[file.operation] }}</span>
        </button>
      </div>
      <p v-if="revealedPath" class="plan-file-path">完整路径：{{ revealedPath }}</p>

      <p v-if="step.expectedCommands && step.expectedCommands.length > 0" class="plan-step-meta">
        <span class="plan-meta-label">预期命令</span>
        <code v-for="command in step.expectedCommands" :key="command" class="plan-command-chip">{{ command }}</code>
      </p>
      <p v-if="step.dependsOn.length > 0" class="plan-step-meta">
        <span class="plan-meta-label">依赖步骤</span>
        <span class="plan-depends-on">{{ step.dependsOn.join("、") }}</span>
      </p>
      <p v-if="step.verification" class="plan-step-meta">
        <span class="plan-meta-label">验证方式</span>
        <span>{{ verification.display }}</span>
        <button
          v-if="verification.isLong"
          type="button"
          class="text-expand-btn"
          :aria-expanded="verificationExpanded"
          @click="verificationExpanded = !verificationExpanded"
        >{{ verificationExpanded ? "收起" : "展开" }}</button>
      </p>
      <p v-if="step.riskReason" class="plan-step-meta">
        <span class="plan-meta-label">风险理由</span>
        <span>{{ riskReason.display }}</span>
        <button
          v-if="riskReason.isLong"
          type="button"
          class="text-expand-btn"
          :aria-expanded="riskReasonExpanded"
          @click="riskReasonExpanded = !riskReasonExpanded"
        >{{ riskReasonExpanded ? "收起" : "展开" }}</button>
      </p>

      <button
        v-if="step.status === 'failed'"
        type="button"
        class="plan-step-retry-btn"
        @click="emit('retry')"
      >重试此步骤</button>

      <div v-if="revisionAllowed" class="plan-step-revision">
        <button
          v-if="!revisionOpen"
          type="button"
          class="plan-step-revise-btn"
          @click="openRevision"
        >修订此步骤</button>
        <div v-else class="plan-revision-input">
          <textarea
            v-model="revisionText"
            rows="2"
            class="plan-revision-textarea"
            placeholder="输入修订意见..."
            aria-label="步骤修订意见"
          ></textarea>
          <div class="plan-revision-actions">
            <button
              type="button"
              class="plan-action-btn plan-action-primary"
              :disabled="!canSubmitRevision"
              @click="submitRevision"
            >提交修订</button>
            <button type="button" class="plan-action-btn" @click="cancelRevision">取消</button>
          </div>
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.plan-step-card {
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-lg);
  background: var(--pix-bg-content);
  overflow: hidden;
}

.plan-step-card.has-deviation {
  border-color: var(--pix-warning-light);
}

.plan-step-header {
  display: flex;
  flex-direction: column;
}

.plan-step-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border-radius: var(--pix-radius-lg);
  text-align: left;
  color: var(--pix-text-primary);
  cursor: pointer;
}

.plan-step-toggle:hover {
  background: var(--pix-bg-hover);
}

.plan-step-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--pix-bg-code);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  flex-shrink: 0;
}

.step-status-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--pix-text-muted);
}

.step-status-icon.status-running {
  color: var(--pix-accent);
}

.step-status-icon.status-completed {
  color: var(--pix-success);
}

.step-status-icon.status-failed {
  color: var(--pix-error);
}

.step-status-icon.status-waiting_input {
  color: var(--pix-warning);
}

.step-status-icon.status-interrupted {
  color: var(--pix-warning);
}

.plan-step-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-medium);
}

.plan-step-status-text {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
}

.plan-step-risk {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  color: var(--pix-text-secondary);
}

.plan-step-risk.risk-high {
  color: var(--pix-error);
}

.plan-step-risk.risk-medium {
  color: var(--pix-warning);
}

.plan-step-risk.risk-low {
  color: var(--pix-success);
}

.plan-step-chevron {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--pix-text-muted);
}

.plan-step-deviation {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin: 0 10px 8px;
  padding: 6px 8px;
  border-radius: var(--pix-radius-md);
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
  font-size: var(--pix-text-xs);
  line-height: 1.4;
}

.plan-step-body {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-sm);
  padding: 0 10px 10px 38px;
}

.plan-step-description {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-primary);
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.text-expand-btn {
  display: inline;
  margin-left: 6px;
  color: var(--pix-accent);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  cursor: pointer;
  vertical-align: baseline;
}

.plan-step-files {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}

.plan-files-label {
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
}

.plan-file-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 260px;
  padding: 3px 7px;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  cursor: pointer;
}

.plan-file-chip:hover {
  background: var(--pix-accent-light);
  color: var(--pix-text-primary);
}

.plan-file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.plan-file-operation {
  flex-shrink: 0;
  color: var(--pix-text-muted);
}

.plan-file-path {
  margin-top: -2px;
  padding: 5px 8px;
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-code);
  color: var(--pix-text-secondary);
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  word-break: break-all;
}

.plan-step-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 5px;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  line-height: 1.5;
}

.plan-meta-label {
  color: var(--pix-text-muted);
  font-weight: var(--pix-weight-semibold);
}

.plan-command-chip {
  padding: 2px 6px;
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-code);
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
}

.plan-depends-on {
  word-break: break-all;
}

.plan-step-retry-btn,
.plan-step-revise-btn {
  align-self: flex-start;
  padding: 4px 10px;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-content);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  font-family: var(--pix-font-ui);
  cursor: pointer;
}

.plan-step-retry-btn:hover,
.plan-step-revise-btn:hover {
  background: var(--pix-accent-light);
  color: var(--pix-text-primary);
}

.plan-revision-input {
  display: flex;
  flex-direction: column;
  gap: 6px;
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

.plan-revision-actions {
  display: flex;
  gap: 6px;
}

.plan-action-btn {
  padding: 4px 12px;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-content);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  font-family: var(--pix-font-ui);
  cursor: pointer;
}

.plan-action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.plan-action-primary {
  background: var(--pix-accent);
  border-color: var(--pix-accent);
  color: var(--pix-text-inverse);
}
</style>
