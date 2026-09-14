<script setup lang="ts">
/**
 * DeliverablePanel - 版本化交付物：版本列表、钉住的截止点、席位表态、移交。
 *
 * Each 整理 pins a timeline cutoff (`cutoffSeq`) and produces an independent
 * version; later discoveries never rewrite a pinned version (a revision is a
 * new version / explicit revision record). Concurrent revisions do not silently
 * overwrite: the CAS answer is shown when a successor already exists. Handoff
 * binds one concrete version (`build_handoff`) and only produces the payload —
 * entering solo/plan is the workspace entry's job.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useTeamStore } from "../../stores/team-store";
import { formatDateTime, seatLabel } from "./roundtable-display";
import type { DeliverableVersion } from "@shared/team-types.js";

const teamStore = useTeamStore();

const selectedId = ref<string | null>(null);
const revisionMarkdown = ref("");
const revisionError = ref<string | null>(null);
const revisionOpen = ref(false);
const isRevising = ref(false);

const stanceReason = ref("");
const stanceConfidence = ref<"low" | "medium" | "high">("medium");
const isStancing = ref(false);

const handoffTarget = ref<"solo" | "plan">("solo");
const handoffText = ref("");
const handoffOpen = ref(false);
const handoffBusy = ref(false);

const exportText = ref("");
const exportOpen = ref(false);
const exportBusy = ref(false);

const versions = computed(() => teamStore.deliverables);

const selected = computed<DeliverableVersion | null>(() => {
  const id = selectedId.value;
  if (id === null) return versions.value[0] ?? null;
  return versions.value.find((version) => version.id === id) ?? versions.value[0] ?? null;
});

/** Keep the selection valid when a new version replaces/supersedes the old one. */
watch(versions, (list) => {
  if (selectedId.value !== null && !list.some((version) => version.id === selectedId.value)) {
    selectedId.value = list[0]?.id ?? null;
  }
});

onMounted(() => {
  void teamStore.refreshDeliverables();
});

function statusLabel(status: DeliverableVersion["status"]): string {
  switch (status) {
    case "drafting": return "整理中";
    case "ready": return "可取用";
    case "superseded": return "已被取代";
  }
}

function statusTone(status: DeliverableVersion["status"]): "blue" | "green" | "grey" {
  switch (status) {
    case "drafting": return "blue";
    case "ready": return "green";
    case "superseded": return "grey";
  }
}

function authorLabel(author: string): string {
  return author === "system" ? "系统整理" : seatLabel(author, teamStore.seats);
}

function stanceLabel(stance: "support" | "oppose" | "conditional" | "absent"): string {
  switch (stance) {
    case "support": return "支持";
    case "oppose": return "反对";
    case "conditional": return "有条件";
    case "absent": return "缺席";
  }
}

function stanceTone(stance: "support" | "oppose" | "conditional" | "absent"): string {
  switch (stance) {
    case "support": return "support";
    case "oppose": return "oppose";
    case "conditional": return "conditional";
    case "absent": return "absent";
  }
}

async function refresh(): Promise<void> {
  await teamStore.refreshDeliverables();
}

async function requestWrapUp(): Promise<void> {
  await teamStore.requestWrapUp();
}

function openRevision(): void {
  const version = selected.value;
  if (version === null) return;
  revisionMarkdown.value = version.markdown;
  revisionError.value = null;
  revisionOpen.value = true;
}

async function submitRevision(): Promise<void> {
  const version = selected.value;
  if (version === null || isRevising.value) return;
  isRevising.value = true;
  revisionError.value = null;
  try {
    const result = await teamStore.reviseDeliverable(version.id, revisionMarkdown.value, version.revision);
    if (result === null) {
      revisionError.value = teamStore.lastError ?? "修订失败";
      return;
    }
    if (result.ok === false) {
      revisionError.value = `这一版已被 v${result.currentVersion} 取代：请基于最新版另开一版，不能静默覆盖。`;
      return;
    }
    revisionOpen.value = false;
    await teamStore.refreshDeliverables();
  } finally {
    isRevising.value = false;
  }
}

async function castStance(stance: "support" | "oppose" | "conditional"): Promise<void> {
  const version = selected.value;
  if (version === null || isStancing.value) return;
  isStancing.value = true;
  try {
    await teamStore.stanceOnDeliverable(version.id, stance, {
      reason: stanceReason.value.trim() || undefined,
      confidence: stanceConfidence.value,
    });
    stanceReason.value = "";
    await teamStore.refreshDeliverables();
  } finally {
    isStancing.value = false;
  }
}

async function buildHandoff(): Promise<void> {
  const version = selected.value;
  if (version === null || handoffBusy.value) return;
  handoffBusy.value = true;
  try {
    const result = await teamStore.buildHandoff(version.id, handoffTarget.value);
    if (result !== null) {
      handoffText.value = result.text;
      handoffOpen.value = true;
    }
  } finally {
    handoffBusy.value = false;
  }
}

async function exportMarkdown(): Promise<void> {
  if (exportBusy.value) return;
  exportBusy.value = true;
  try {
    const markdown = await teamStore.exportMarkdown();
    if (markdown !== null) {
      exportText.value = markdown;
      exportOpen.value = true;
    }
  } finally {
    exportBusy.value = false;
  }
}

async function copy(value: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // Clipboard may be unavailable (permissions / no browser context): the text
    // stays visible in the dialog so the user can copy it by hand.
  }
}
</script>

<template>
  <div class="deliverable-panel" data-test="deliverable-panel">
    <div class="dp-heading">
      <span class="dp-title">
        <v-icon icon="mdi-package-variant-closed" size="14" />
        交付物
        <span v-if="versions.length > 0" class="dp-count">{{ versions.length }}</span>
      </span>
      <div class="dp-heading-actions">
        <button type="button" class="dp-link" @click="refresh">刷新</button>
        <button type="button" class="dp-link" @click="requestWrapUp">整理当前方案</button>
        <button type="button" class="dp-link" @click="exportMarkdown">导出 Markdown</button>
      </div>
    </div>

    <div v-if="versions.length === 0" class="dp-empty">
      还没有交付物。随时点「整理当前方案」钉一个截止点，生成独立版本。
    </div>

    <template v-else>
      <div class="dp-versions">
        <button
          v-for="version in versions"
          :key="version.id"
          type="button"
          class="dp-version"
          :class="{ active: selected?.id === version.id }"
          :data-test="`deliverable-version-${version.version}`"
          @click="selectedId = version.id"
        >
          <span class="dp-version-no">v{{ version.version }}</span>
          <span class="dp-version-status" :class="`dp-version-status--${statusTone(version.status)}`">
            {{ statusLabel(version.status) }}
          </span>
          <span class="dp-version-meta">截止 #{{ version.cutoffSeq }} · {{ formatDateTime(version.createdAt) }}</span>
        </button>
      </div>

      <div v-if="selected" class="dp-detail" data-test="deliverable-detail">
        <div class="dp-detail-row">
          <span class="dp-label">版本</span>
          <span class="dp-value">v{{ selected.version }}（作者：{{ authorLabel(selected.author) }}）</span>
        </div>
        <div class="dp-detail-row">
          <span class="dp-label">钉住的截止点</span>
          <span class="dp-value" data-test="deliverable-cutoff">#{{ selected.cutoffSeq }}</span>
        </div>
        <div v-if="selected.basedOnVersion !== undefined" class="dp-detail-row">
          <span class="dp-label">基于</span>
          <span class="dp-value">v{{ selected.basedOnVersion }}</span>
        </div>

        <pre class="dp-markdown" data-test="deliverable-markdown">{{ selected.markdown || "（整理中，暂无正文）" }}</pre>

        <div class="dp-stances" data-test="deliverable-stances">
          <div class="dp-label">席位表态</div>
          <div v-if="!selected.stances || selected.stances.length === 0" class="dp-stance-empty">还没有表态</div>
          <div
            v-for="stance in selected.stances ?? []"
            :key="stance.seatId"
            class="dp-stance"
            :class="`dp-stance--${stanceTone(stance.stance)}`"
          >
            <span class="dp-stance-seat">{{ seatLabel(stance.seatId, teamStore.seats) }}</span>
            <span class="dp-stance-value">{{ stanceLabel(stance.stance) }}</span>
            <span v-if="stance.confidence" class="dp-stance-confidence">{{ stance.confidence }}</span>
            <span v-if="stance.reason" class="dp-stance-reason">{{ stance.reason }}</span>
          </div>
        </div>

        <div class="dp-stance-form">
          <v-text-field
            v-model="stanceReason"
            density="compact"
            variant="outlined"
            hide-details
            placeholder="你的理由（可选）"
            class="dp-stance-input"
          />
          <v-select
            v-model="stanceConfidence"
            :items="[{ title: '低', value: 'low' }, { title: '中', value: 'medium' }, { title: '高', value: 'high' }]"
            item-title="title"
            item-value="value"
            density="compact"
            variant="outlined"
            hide-details
            class="dp-stance-confidence-select"
          />
          <v-btn size="x-small" variant="tonal" color="green" :disabled="isStancing" @click="castStance('support')">支持</v-btn>
          <v-btn size="x-small" variant="tonal" color="red" :disabled="isStancing" @click="castStance('oppose')">反对</v-btn>
          <v-btn size="x-small" variant="tonal" color="amber" :disabled="isStancing" @click="castStance('conditional')">有条件</v-btn>
        </div>

        <div class="dp-actions">
          <v-btn
            size="x-small"
            variant="tonal"
            color="primary"
            prepend-icon="mdi-pencil-outline"
            :disabled="selected.status !== 'ready'"
            data-test="deliverable-revise"
            @click="openRevision"
          >
            修订此版本
          </v-btn>
          <v-select
            v-model="handoffTarget"
            :items="[{ title: '移交到单人会话', value: 'solo' }, { title: '移交到规划', value: 'plan' }]"
            item-title="title"
            item-value="value"
            density="compact"
            variant="outlined"
            hide-details
            class="dp-handoff-target"
          />
          <v-btn
            size="x-small"
            variant="tonal"
            color="primary"
            prepend-icon="mdi-export-variant"
            :loading="handoffBusy"
            @click="buildHandoff"
          >
            生成移交
          </v-btn>
        </div>
      </div>
    </template>

    <!-- 修订（并发修订不静默覆盖：冲突在对话框内显示） -->
    <v-dialog v-model="revisionOpen" max-width="720">
      <v-card class="dp-dialog">
        <div class="dp-dialog-title">修订 v{{ selected?.version }}</div>
        <v-textarea
          v-model="revisionMarkdown"
          rows="12"
          density="compact"
          variant="outlined"
          hide-details
          class="dp-dialog-textarea"
        />
        <div v-if="revisionError" class="dp-dialog-error" data-test="deliverable-revision-error">
          {{ revisionError }}
        </div>
        <v-card-actions class="dp-dialog-actions">
          <v-spacer />
          <v-btn variant="text" @click="revisionOpen = false">取消</v-btn>
          <v-btn color="primary" variant="tonal" :loading="isRevising" @click="submitRevision">提交修订</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- 移交 payload（绑定该版本；进入 solo/规划由工作区入口执行） -->
    <v-dialog v-model="handoffOpen" max-width="720">
      <v-card class="dp-dialog">
        <div class="dp-dialog-title">移交到{{ handoffTarget === "solo" ? "单人会话" : "规划" }}（绑定 v{{ selected?.version }}）</div>
        <pre class="dp-dialog-pre" data-test="handoff-text">{{ handoffText }}</pre>
        <v-card-actions class="dp-dialog-actions">
          <v-spacer />
          <v-btn variant="text" @click="copy(handoffText)">复制</v-btn>
          <v-btn variant="text" @click="handoffOpen = false">关闭</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- 讨论记录导出（Markdown） -->
    <v-dialog v-model="exportOpen" max-width="720">
      <v-card class="dp-dialog">
        <div class="dp-dialog-title">讨论记录（Markdown）</div>
        <pre class="dp-dialog-pre" data-test="export-markdown">{{ exportText }}</pre>
        <v-card-actions class="dp-dialog-actions">
          <v-spacer />
          <v-btn variant="text" @click="copy(exportText)">复制</v-btn>
          <v-btn variant="text" @click="exportOpen = false">关闭</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.deliverable-panel {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-xs);
  padding: var(--pix-space-sm);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-lg);
  background: rgba(255, 255, 255, 0.92);
  box-shadow: var(--pix-shadow-xs);
}

.dp-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--pix-space-xs);
  flex-wrap: wrap;
}

.dp-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--pix-text-primary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
}

.dp-count {
  min-width: 16px;
  padding: 1px 5px;
  border-radius: 8px;
  background: var(--pix-accent-light);
  color: var(--pix-accent);
  font-size: 9px;
  text-align: center;
}

.dp-heading-actions {
  display: inline-flex;
  gap: 6px;
}

.dp-link {
  border: none;
  background: transparent;
  color: var(--pix-accent);
  font-size: 10px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: var(--pix-radius-sm);
}

.dp-link:hover {
  background: var(--pix-bg-hover);
}

.dp-empty {
  color: var(--pix-text-muted);
  font-size: 10px;
  line-height: 1.5;
  padding: var(--pix-space-xs) 0;
}

.dp-versions {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.dp-version {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  padding: 4px 7px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
  background: #ffffff;
  text-align: left;
  cursor: pointer;
}

.dp-version:hover {
  border-color: var(--pix-border);
  background: var(--pix-bg-hover);
}

.dp-version.active {
  border-color: var(--pix-accent);
  background: var(--pix-accent-light);
}

.dp-version-no {
  color: var(--pix-text-primary);
  font-size: 10px;
  font-weight: var(--pix-weight-semibold);
}

.dp-version-status {
  padding: 0 5px;
  border-radius: 3px;
  font-size: 9px;
}

.dp-version-status--blue { background: var(--pix-accent-light); color: var(--pix-accent); }
.dp-version-status--green { background: var(--pix-success-bg); color: var(--pix-success); }
.dp-version-status--grey { background: var(--pix-bg-hover); color: var(--pix-text-muted); }

.dp-version-meta {
  min-width: 0;
  overflow: hidden;
  color: var(--pix-text-muted);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dp-detail {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: var(--pix-space-xs);
  border-top: 1px solid var(--pix-border-subtle);
}

.dp-detail-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
}

.dp-label {
  color: var(--pix-text-muted);
  font-size: 9px;
  flex-shrink: 0;
}

.dp-value {
  color: var(--pix-text-primary);
  font-weight: var(--pix-weight-medium);
}

.dp-markdown {
  margin: 0;
  max-height: 160px;
  overflow: auto;
  padding: var(--pix-space-xs);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-code);
  color: var(--pix-text-secondary);
  font-family: var(--pix-font-ui);
  font-size: 10px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.dp-stances {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.dp-stance,
.dp-stance-empty {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-size: 10px;
  color: var(--pix-text-secondary);
}

.dp-stance-empty {
  color: var(--pix-text-muted);
}

.dp-stance-seat {
  font-weight: var(--pix-weight-semibold);
}

.dp-stance-value {
  padding: 0 5px;
  border-radius: 3px;
  font-size: 9px;
}

.dp-stance--support .dp-stance-value { background: var(--pix-success-bg); color: var(--pix-success); }
.dp-stance--oppose .dp-stance-value { background: var(--pix-error-bg); color: var(--pix-error); }
.dp-stance--conditional .dp-stance-value { background: var(--pix-warning-bg); color: var(--pix-warning); }
.dp-stance--absent .dp-stance-value { background: var(--pix-bg-hover); color: var(--pix-text-muted); }

.dp-stance-confidence {
  color: var(--pix-text-muted);
  font-size: 9px;
}

.dp-stance-reason {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--pix-text-muted);
}

.dp-stance-form,
.dp-actions {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  flex-wrap: wrap;
}

.dp-stance-input {
  flex: 1;
  min-width: 120px;
}

.dp-stance-confidence-select {
  max-width: 78px;
}

.dp-stance-form :deep(.v-field),
.dp-actions :deep(.v-field) {
  font-size: 10px;
}

.dp-handoff-target {
  max-width: 150px;
}

.dp-dialog {
  padding: var(--pix-space-lg);
  border-radius: var(--pix-radius-xl) !important;
}

.dp-dialog-title {
  margin-bottom: var(--pix-space-sm);
  color: var(--pix-text-primary);
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
}

.dp-dialog-textarea :deep(textarea) {
  font-family: var(--pix-font-mono);
  font-size: 11px;
}

.dp-dialog-pre {
  margin: 0;
  max-height: 340px;
  overflow: auto;
  padding: var(--pix-space-sm);
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-code);
  color: var(--pix-text-secondary);
  font-family: var(--pix-font-mono);
  font-size: 10px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.dp-dialog-error {
  margin-top: var(--pix-space-xs);
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-error-bg);
  color: var(--pix-error);
  font-size: 11px;
}

.dp-dialog-actions {
  padding: var(--pix-space-sm) 0 0 !important;
}
</style>
