<script setup lang="ts">
/**
 * WorkflowRunPanel - Rich renderer for the `workflow` / `ralph` tool work items
 *
 * Replaces the generic tool item in the work-status list for the solo-mode
 * `workflow` and `ralph` tools. Rendering order is fixed:
 * 1. result carries { details } and isWorkflowToolDetails(details) -> rich
 *    render from details.view (live tool_execution_update.details, and the
 *    persisted details on replay)
 * 2. details missing -> the folded view from the workflow store (interrupted
 *    runs whose toolResult lost its details), keyed by toolCallId
 * 3. no folded view at all -> 无记录 fallback (old-version results, or a
 *    snapshot that never reached the store); never throws
 *
 * The run is collapsible in every status and starts collapsed (matching
 * SubagentToolView). Running still shows a header spinner. Members
 * are grouped by phase identity (workflowPhaseKey: undefined and "" are
 * distinct), in append order, and each member row jumps to its child AgentTask
 * via agent-task-store.openTaskCenter - the panel never touches AgentTaskService.
 * The interrupted override: when the parent toolResult landed with isError and
 * the run never settled (no stopReason in the fold), the run is interrupted -
 * an interrupted run's toolResult is ALWAYS isError. Live updates never set
 * isError (session-store sets it only on tool_execution_end), so this cannot
 * misfire on an in-flight run.
 */
import { computed, ref } from "vue";
import { isWorkflowToolDetails, workflowPhaseKey } from "@shared/workflow-types.js";
import type {
  WorkflowMemberState,
  WorkflowRunStatus,
  WorkflowToolDetails,
  WorkflowViewState,
} from "@shared/workflow-types.js";
import { useAgentTaskStore } from "../../stores/agent-task-store";
import { useWorkflowStore } from "../../stores/workflow-store";

const props = defineProps<{
  result: unknown;
  args: unknown;
  isError: boolean;
  toolCallId: string;
}>();

const taskStore = useAgentTaskStore();
const workflowStore = useWorkflowStore();

// ── Parse ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const details = computed<WorkflowToolDetails | null>(() => {
  if (isRecord(props.result) && isWorkflowToolDetails(props.result.details)) {
    return props.result.details;
  }
  return null;
});

/** Interrupted runs whose toolResult carries no final details fall back to the
 *  folded store view, keyed by toolCallId (the panel lookup key). */
const storeView = computed<WorkflowViewState | null>(
  () => workflowStore.byToolCallId.get(props.toolCallId) ?? null,
);

/** Live updates (tool_execution_update.details) win; the store is the
 *  session-switch / interruption fallback. */
const view = computed<WorkflowViewState | null>(() => details.value?.view ?? storeView.value);

const interrupted = computed(
  () => props.isError && view.value !== null && view.value.stopReason === undefined,
);

const status = computed<WorkflowRunStatus>(() => {
  if (interrupted.value) return "interrupted";
  return view.value?.status ?? (props.isError ? "failed" : "running");
});

// ── Labels and formatting ──

const STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

function statusLabel(statusValue: WorkflowRunStatus): string {
  return STATUS_LABELS[statusValue] ?? statusValue;
}

function statusClass(statusValue: WorkflowRunStatus): string {
  return statusValue;
}

function argsMetaName(args: unknown): string {
  if (isRecord(args) && isRecord(args.meta) && typeof args.meta.name === "string" && args.meta.name) {
    return args.meta.name;
  }
  return "";
}

const displayName = computed(() => view.value?.name || argsMetaName(props.args) || "workflow");

const memberCount = computed(() => view.value?.members.length ?? 0);

const currentPhase = computed(() => view.value?.currentPhase);

const logs = computed(() => view.value?.logs ?? []);
const logsOpen = ref(false);

const errorText = computed(() => details.value?.error);

// ── Disclosure ──

const expanded = ref(false);
const bodyOpen = computed(() => expanded.value);

// ── Member grouping (workflowPhaseKey semantics: undefined vs "" distinct) ──

function memberStatus(member: WorkflowMemberState): WorkflowRunStatus {
  if (member.outcome !== undefined) return member.outcome;
  return interrupted.value ? "interrupted" : "running";
}

interface PhaseGroup {
  key: string;
  label: string;
  members: WorkflowMemberState[];
}

function phaseLabel(phase: string | undefined): string {
  if (phase === undefined) return "未分配阶段";
  return phase === "" ? "（空阶段）" : phase;
}

const phaseGroups = computed<PhaseGroup[]>(() => {
  const run = view.value;
  if (!run) return [];
  const groups = new Map<string, PhaseGroup>();
  for (const member of run.members) {
    const key = workflowPhaseKey(member.phase);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: phaseLabel(member.phase), members: [] };
      groups.set(key, group);
    }
    group.members.push(member);
  }
  return [...groups.values()];
});

const expandedPhases = ref<Set<string>>(new Set());

function isPhaseOpen(group: PhaseGroup): boolean {
  return expandedPhases.value.has(group.key);
}

function togglePhase(key: string): void {
  const next = new Set(expandedPhases.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedPhases.value = next;
}

function phaseSummary(group: PhaseGroup): string {
  const counts: Partial<Record<WorkflowRunStatus, number>> = {};
  for (const member of group.members) {
    const memberState = memberStatus(member);
    counts[memberState] = (counts[memberState] ?? 0) + 1;
  }
  const parts = [`已完成 ${counts.completed ?? 0}/${group.members.length}`];
  for (const key of ["failed", "cancelled", "interrupted", "running"] as const) {
    if (counts[key]) parts.push(`${STATUS_LABELS[key]} ${counts[key]}`);
  }
  return parts.join(" · ");
}

function taskRecordExists(taskId: string): boolean {
  return taskStore.tasks.some((task) => task.taskId === taskId);
}

/** Jump to the child AgentTask so the task center opens on it. */
function jumpToTask(childId: string): void {
  if (!taskRecordExists(childId)) return;
  taskStore.openTaskCenter(childId);
}
</script>

<template>
  <div
    class="wfp-panel"
    :class="{ error: isError }"
    data-test="workflow-run-panel"
    :data-run-status="status"
  >
    <!-- No folded record at all (interrupted runs whose store also lost the
         prefix, or old-version results): header + 无记录 fallback. -->
    <template v-if="view === null">
      <div class="wfp-header wfp-header-forced" role="status" aria-live="polite">
        <span class="wfp-icon" aria-hidden="true">
          <span v-if="!isError" class="spinner"></span>
          <span v-else class="wfp-dot err"></span>
        </span>
        <span class="wfp-title">{{ displayName }}</span>
        <span class="wfp-status" :class="status" data-test="wfp-status">{{ isError ? "失败" : "运行中" }}</span>
      </div>
      <div class="wfp-body">
        <div class="wfp-empty" data-test="wfp-no-records">无记录</div>
      </div>
    </template>

    <!-- Folded view: status-driven disclosure -->
    <template v-else>
      <button
        type="button"
        class="wfp-header"
        :aria-expanded="bodyOpen"
        @click="expanded = !expanded"
      >
        <span class="wfp-icon" aria-hidden="true">
          <span v-if="status === 'running'" class="spinner"></span>
          <span v-else class="wfp-dot" :class="statusClass(status)"></span>
        </span>
        <span class="wfp-title">{{ displayName }}</span>
        <span class="wfp-status" :class="status" data-test="wfp-status">{{ statusLabel(status) }}</span>
        <span v-if="currentPhase && status === 'running'" class="wfp-count">{{ currentPhase }}</span>
        <span v-if="memberCount > 0" class="wfp-count">{{ memberCount }} 个子任务</span>
        <span class="wfp-toggle" data-test="wfp-toggle">{{ bodyOpen ? "收起" : "展开" }}</span>
      </button>

      <div v-if="bodyOpen" class="wfp-body">
        <div v-if="currentPhase" class="wfp-current-phase">当前阶段：{{ currentPhase }}</div>

        <template v-if="phaseGroups.length > 0 || logs.length > 0">
          <div
            v-for="group in phaseGroups"
            :key="group.key"
            class="wfp-phase"
            data-test="wfp-phase"
            :data-phase-key="group.key"
          >
            <button
              type="button"
              class="wfp-phase-header"
              :aria-expanded="isPhaseOpen(group)"
              @click="togglePhase(group.key)"
            >
              <span class="wfp-phase-title">{{ group.label }}</span>
              <span class="wfp-phase-count">{{ group.members.length }} 个成员</span>
              <span class="wfp-phase-summary">{{ phaseSummary(group) }}</span>
              <span class="wfp-toggle">{{ isPhaseOpen(group) ? "收起" : "展开" }}</span>
            </button>
            <div v-if="isPhaseOpen(group)" class="wfp-phase-body">
              <div
                v-for="member in group.members"
                :key="member.seq"
                class="wfp-member"
                data-test="wfp-member"
                :data-member-status="memberStatus(member)"
              >
                <span class="wfp-member-icon" aria-hidden="true">
                  <span v-if="memberStatus(member) === 'running'" class="spinner wfp-spinner-sm"></span>
                  <span v-else class="wfp-dot" :class="statusClass(memberStatus(member))"></span>
                </span>
                <span class="wfp-member-label" :title="member.label">{{ member.label }}</span>
                <span class="wfp-member-status" :class="statusClass(memberStatus(member))">
                  {{ statusLabel(memberStatus(member)) }}
                </span>
                <button
                  type="button"
                  class="wfp-jump-btn"
                  data-test="wfp-member-jump"
                  :disabled="!taskRecordExists(member.childId)"
                  :title="taskRecordExists(member.childId) ? `跳转到任务 ${member.childId}` : '任务记录已清理'"
                  @click="jumpToTask(member.childId)"
                >
                  查看任务
                </button>
                <p
                  v-if="member.error"
                  class="wfp-member-error"
                  data-test="wfp-member-error"
                  :title="member.error"
                >
                  {{ member.error }}
                </p>
              </div>
            </div>
          </div>

          <div v-if="logs.length > 0" class="wfp-logs">
            <button
              type="button"
              class="wfp-logs-toggle"
              :aria-expanded="logsOpen"
              @click="logsOpen = !logsOpen"
            >
              <span class="wfp-logs-label">日志</span>
              <span class="wfp-logs-count">{{ logs.length }} 条</span>
              <span class="wfp-toggle">{{ logsOpen ? "收起" : "展开" }}</span>
            </button>
            <div v-if="logsOpen" class="wfp-logs-body">
              <div v-for="(line, index) in logs" :key="index" class="wfp-log-line">
                {{ line.message }}
              </div>
            </div>
          </div>

          <div v-if="errorText" class="wfp-error" data-test="wfp-error">{{ errorText }}</div>
        </template>

        <div v-else class="wfp-empty" data-test="wfp-no-records">无记录</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.wfp-panel {
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  overflow: hidden;
  margin-bottom: var(--pix-space-xs);
  background: var(--pix-bg-content);
  animation: wfp-row-in 0.18s ease-out;
  min-width: 0;
  max-width: 100%;
}

.wfp-panel:last-child {
  margin-bottom: 0;
}

.wfp-panel.error {
  border-color: var(--pix-error-light);
  background: var(--pix-error-bg);
}

/* ── Header / fallback row ── */
.wfp-header {
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

button.wfp-header {
  cursor: pointer;
}

button.wfp-header:hover {
  background: var(--pix-bg-hover);
}

.wfp-header-forced {
  cursor: default;
}

.wfp-icon {
  flex-shrink: 0;
  width: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pix-text-secondary);
}

.wfp-title {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-accent);
  flex: 0 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.wfp-status {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--pix-bg-code);
  color: var(--pix-text-secondary);
  white-space: nowrap;
}

.wfp-status.running {
  color: var(--pix-accent);
  background: var(--pix-accent-light);
}

.wfp-status.completed {
  color: var(--pix-success);
  background: var(--pix-success-light);
}

.wfp-status.failed {
  color: var(--pix-error);
  background: var(--pix-error-light);
}

.wfp-status.cancelled,
.wfp-status.interrupted {
  color: var(--pix-warning);
  background: var(--pix-warning-light);
}

.wfp-count {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  font-variant-numeric: tabular-nums;
}

.wfp-toggle {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  font-weight: var(--pix-weight-medium);
}

/* ── Body ── */
.wfp-body {
  border-top: 1px solid var(--pix-border-light);
  padding: var(--pix-space-sm) var(--pix-space-md);
  background: rgba(255, 255, 255, 0.86);
  min-width: 0;
}

.wfp-current-phase {
  font-size: var(--pix-text-xs);
  color: var(--pix-accent);
  font-weight: var(--pix-weight-medium);
  margin-bottom: var(--pix-space-sm);
  overflow-wrap: anywhere;
}

/* ── Phase groups ── */
.wfp-phase {
  border-top: 1px solid var(--pix-border-light);
  padding: var(--pix-space-xs) 0;
  min-width: 0;
}

.wfp-phase:first-of-type {
  border-top: none;
  padding-top: 0;
}

.wfp-phase:last-of-type {
  padding-bottom: 0;
}

.wfp-phase-header {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  width: 100%;
  padding: 3px 4px;
  text-align: left;
  color: var(--pix-text-primary);
  font-family: var(--pix-font-ui);
  border: none;
  background: transparent;
  border-radius: var(--pix-radius-sm);
  min-width: 0;
}

button.wfp-phase-header {
  cursor: pointer;
}

button.wfp-phase-header:hover {
  background: var(--pix-bg-hover);
}

.wfp-phase-header-forced {
  cursor: default;
}

.wfp-phase-title {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  flex-shrink: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.wfp-phase-count,
.wfp-phase-summary {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  font-variant-numeric: tabular-nums;
}

.wfp-phase-body {
  padding: var(--pix-space-xs) 0 0;
}

/* ── Member rows ── */
.wfp-member {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-sm);
  margin-bottom: var(--pix-space-xs);
  min-width: 0;
}

.wfp-member:last-child {
  margin-bottom: 0;
}

.wfp-member-icon {
  flex-shrink: 0;
  width: 10px;
  height: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.wfp-member-label {
  flex: 1;
  min-width: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wfp-member-status {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}

.wfp-member-status.completed {
  color: var(--pix-success);
}

.wfp-member-status.failed {
  color: var(--pix-error);
}

.wfp-member-status.cancelled,
.wfp-member-status.interrupted {
  color: var(--pix-warning);
}

.wfp-member-status.running {
  color: var(--pix-accent);
}

.wfp-jump-btn {
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

.wfp-jump-btn:hover:not(:disabled) {
  background: var(--pix-accent-light);
  color: var(--pix-accent);
}

.wfp-member-error {
  flex: 1 0 100%;
  margin: 0 0 0 17px;
  font-size: var(--pix-text-xs);
  color: var(--pix-error);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Logs ── */
.wfp-logs {
  margin-top: var(--pix-space-xs);
}

.wfp-logs-toggle {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  width: 100%;
  padding: 3px 4px;
  text-align: left;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-primary);
  font-family: var(--pix-font-ui);
  background: transparent;
  border: none;
  border-radius: var(--pix-radius-sm);
  cursor: pointer;
  min-width: 0;
}

.wfp-logs-toggle:hover {
  background: var(--pix-bg-hover);
}

.wfp-logs-label {
  font-weight: var(--pix-weight-semibold);
}

.wfp-logs-count {
  flex-shrink: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  font-variant-numeric: tabular-nums;
}

.wfp-logs-body {
  margin-top: var(--pix-space-xs);
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-code);
  padding: var(--pix-space-xs) var(--pix-space-sm);
}

.wfp-log-line {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-tight);
  color: var(--pix-text-secondary);
  overflow-wrap: anywhere;
  padding: 1px 0;
}

/* ── Error / empty ── */
.wfp-error {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin-top: var(--pix-space-sm);
  padding: 6px 8px;
  border-radius: var(--pix-radius-sm);
  background: var(--pix-error-bg);
  color: var(--pix-error);
  font-size: var(--pix-text-xs);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.wfp-empty {
  display: block;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  padding: var(--pix-space-sm) 0;
}

/* ── Status dots / spinner ── */
.wfp-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.wfp-dot.completed {
  color: var(--pix-success);
}

.wfp-dot.failed {
  color: var(--pix-error);
}

.wfp-dot.cancelled,
.wfp-dot.interrupted {
  color: var(--pix-warning);
}

.wfp-dot.err {
  color: var(--pix-error);
}

.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--pix-border-light);
  border-top-color: var(--pix-accent);
  border-radius: 50%;
  animation: wfp-spin 0.6s linear infinite;
}

.wfp-spinner-sm {
  width: 8px;
  height: 8px;
  border-width: 1.5px;
}

@keyframes wfp-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes wfp-row-in {
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
  .spinner {
    animation: none;
  }

  .wfp-panel {
    animation: none;
  }
}
</style>
