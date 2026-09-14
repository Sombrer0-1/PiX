<script setup lang="ts">
/**
 * TeamDashboard - the roundtable workbench.
 *
 * Main surface = the group chat (TeamTimeline + composer); the rail carries the
 * attention surface, the open items board, the deliverables and the seat detail
 * card; the secondary tabs keep the activity stream and the aggregated change
 * summary one click away. There is no leader conversation here: the discussion
 * is the timeline, and the host runtime only runs the seats.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useTeamStore } from "../../stores/team-store";
import { useProjectStore } from "../../stores/project-store";
import AllActivityView from "./AllActivityView.vue";
import AttentionSurface from "./AttentionSurface.vue";
import CostStrip from "./CostStrip.vue";
import DeliverablePanel from "./DeliverablePanel.vue";
import FileChangeSummary from "./FileChangeSummary.vue";
import RosterSetupDialog from "./RosterSetupDialog.vue";
import RoundtableSettingsDialog from "./RoundtableSettingsDialog.vue";
import RoundtableComposer from "./RoundtableComposer.vue";
import TeamTimeline from "./TeamTimeline.vue";
import ThreadFilter from "./ThreadFilter.vue";
import WorkerDetailCard from "./WorkerDetailCard.vue";
import WorkerSessionView from "./WorkerSessionView.vue";
import { formatClock, seatLabel } from "./roundtable-display";
import type { OpenItem } from "@shared/team-types.js";

type WorkbenchTab = "discussion" | "activity" | "changes";

const teamStore = useTeamStore();
const projectStore = useProjectStore();

const activeTab = ref<WorkbenchTab>("discussion");
const activityScope = ref<"focused" | "all">("focused");
const selectedThread = ref<string | null>(null);
const locatedId = ref<string | null>(null);
const showRoster = ref(false);
const rosterMode = ref<"create" | "add">("create");
const showSettings = ref(false);
const showStopDialog = ref(false);
const stopWithWrapUp = ref(false);
const isStopping = ref(false);

const roundtable = computed(() => teamStore.roundtable);
const isRunning = computed(() => teamStore.isTeamActive);
const allowWrapUpOnStop = computed(() => roundtable.value?.settings.hardStop?.allowWrapUpOnStop === true);

/** 主线永远可见；线程默认可见，少看（mute）的隐藏，选中线程后只看它。 */
const visibleTimeline = computed(() =>
  teamStore.timeline.filter((item) => {
    const threadId = item.threadId;
    // 空串也算主线（与 TeamTimeline 的 v-if="item.threadId" 一致）：否则选中任一
    // 真实线程后，这批 threadId === "" 的记录会从群聊里整段消失。
    if (!threadId) return true;
    if (teamStore.mutedThreads.includes(threadId)) return false;
    if (selectedThread.value !== null && threadId !== selectedThread.value) return false;
    return true;
  }),
);

const openItems = computed(() => teamStore.openItems);
const activeOpenItems = computed(() => openItems.value.filter((item) => item.status === "open" || item.status === "claimed"));

const tabs = computed<Array<{ value: WorkbenchTab; label: string; icon: string; count?: number }>>(() => [
  { value: "discussion", label: "讨论", icon: "mdi-forum-outline", count: teamStore.timeline.length },
  {
    value: "activity",
    label: "活动",
    icon: "mdi-pulse",
    count: Object.values(teamStore.seatEvents).reduce((total, events) => total + events.length, 0),
  },
  { value: "changes", label: "变更", icon: "mdi-file-edit-outline" },
]);

const lifecycleLabel = computed(() => {
  switch (teamStore.lifecycle) {
    case "active": return "进行中";
    case "paused": return "已暂停";
    case "stopped": return "已归档";
    default: return "未开始";
  }
});

const statusLine = computed(() => {
  const speaking = teamStore.activeSeats.filter((seat) => seat.status === "speaking" || seat.status === "exploring");
  if (speaking.length === 0) return "空闲";
  return `${speaking.map((seat) => seat.name).join("、")} 正在推进`;
});

onMounted(() => {
  void teamStore.refreshOpenItems();
  void teamStore.refreshDeliverables();
});

// A new roundtable starts on the discussion tab with no thread focus.
watch(() => roundtable.value?.roundtableId, () => {
  selectedThread.value = null;
  locatedId.value = null;
  activeTab.value = "discussion";
});

function openRoster(mode: "create" | "add"): void {
  rosterMode.value = mode;
  showRoster.value = true;
}

function onLocated(itemId: string): void {
  locatedId.value = itemId;
}

function selectThread(threadId: string | null): void {
  selectedThread.value = threadId;
  locatedId.value = null;
}

function toggleActivityScope(): void {
  activityScope.value = activityScope.value === "focused" ? "all" : "focused";
}

function openItemStatusLabel(status: OpenItem["status"]): string {
  switch (status) {
    case "open": return "未决";
    case "claimed": return "认领中";
    case "resolved": return "已解决";
    case "dropped": return "已丢弃";
  }
}

function openItemTone(status: OpenItem["status"]): string {
  switch (status) {
    case "open": return "open";
    case "claimed": return "claimed";
    case "resolved": return "resolved";
    case "dropped": return "dropped";
  }
}

function openItemOwner(item: OpenItem): string {
  return item.claimedBy === undefined ? "无人认领" : seatLabel(item.claimedBy, teamStore.seats);
}

async function confirmStop(): Promise<void> {
  if (isStopping.value) return;
  isStopping.value = true;
  try {
    await teamStore.stopRoundtable({ wrapUp: allowWrapUpOnStop.value && stopWithWrapUp.value });
    showStopDialog.value = false;
    stopWithWrapUp.value = false;
  } finally {
    isStopping.value = false;
  }
}

async function dismissLegacy(): Promise<void> {
  // The ack is workspace-level (one notice per workspace, not per roundtable).
  await teamStore.dismissLegacyNotice(projectStore.currentProject ?? undefined);
}
</script>

<template>
  <div class="team-dashboard" data-test="team-dashboard">
    <v-alert
      v-if="teamStore.lastError"
      type="error"
      variant="tonal"
      density="compact"
      closable
      class="team-alert"
      @click:close="teamStore.clearError()"
    >
      {{ teamStore.lastError }}
    </v-alert>

    <div v-if="teamStore.legacyNotice" class="legacy-banner" data-test="legacy-notice">
      <v-icon icon="mdi-alert-outline" size="14" />
      <span>检测到旧版团队快照：不会出现在可恢复列表里，讨论记录需要重新开始。</span>
      <button type="button" class="legacy-ack" @click="dismissLegacy">知道了</button>
    </div>

    <div v-if="teamStore.recordCorruptNotice" class="legacy-banner" data-test="record-corrupt-notice">
      <v-icon icon="mdi-alert-outline" size="14" />
      <span>{{ teamStore.recordCorruptNotice }}</span>
      <button type="button" class="legacy-ack" @click="teamStore.dismissRecordCorruptNotice()">知道了</button>
    </div>

    <div v-if="teamStore.isLoading && roundtable === null" class="team-empty">
      <v-icon icon="mdi-loading" size="26" class="team-loading-icon" />
      <strong>正在读取圆桌...</strong>
    </div>

    <div v-else-if="roundtable === null" class="team-empty" data-test="team-empty">
      <span class="team-empty-icon">
        <v-icon icon="mdi-forum-outline" size="28" />
      </span>
      <strong>当前没有圆桌</strong>
      <span class="team-empty-hint">选一个档位、写议题，用户和席位在同一个群聊里讨论。</span>
      <v-btn color="primary" variant="flat" size="small" prepend-icon="mdi-table-chair" @click="openRoster('create')">
        组建圆桌
      </v-btn>
    </div>

    <template v-else>
      <header class="workbench-header">
        <div class="workbench-title">
          <span class="workbench-mark">
            <v-icon icon="mdi-forum-outline" size="18" />
          </span>
          <span class="workbench-title-copy">
            <strong>{{ roundtable.name }}</strong>
            <span :title="statusLine">{{ statusLine }}</span>
          </span>
        </div>
        <div class="workbench-controls">
          <span class="lifecycle-chip" :class="`lifecycle-chip--${teamStore.lifecycle ?? 'inactive'}`">
            {{ lifecycleLabel }}
          </span>
          <span class="seat-count">{{ teamStore.activeSeats.length }} 席</span>
          <v-btn
            v-if="isRunning"
            icon="mdi-cog-outline"
            size="small"
            variant="text"
            title="圆桌设置"
            aria-label="圆桌设置"
            data-test="roundtable-settings"
            @click="showSettings = true"
          />
          <v-btn
            v-if="isRunning"
            size="small"
            variant="text"
            prepend-icon="mdi-account-plus-outline"
            @click="openRoster('add')"
          >
            加席位
          </v-btn>
          <v-btn
            v-if="teamStore.lifecycle === 'stopped'"
            size="small"
            variant="tonal"
            color="primary"
            prepend-icon="mdi-table-chair"
            @click="openRoster('create')"
          >
            新圆桌
          </v-btn>
          <v-btn
            v-else
            icon="mdi-stop-circle-outline"
            size="small"
            color="error"
            variant="text"
            title="停止并归档"
            aria-label="停止并归档"
            @click="showStopDialog = true"
          />
        </div>
      </header>

      <CostStrip />

      <nav class="workbench-tabs" role="tablist" aria-label="圆桌工作台视图">
        <button
          v-for="tab in tabs"
          :key="tab.value"
          class="workbench-tab"
          :class="{ active: activeTab === tab.value }"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.value"
          :data-test="`workbench-tab-${tab.value}`"
          @click="activeTab = tab.value"
        >
          <v-icon :icon="tab.icon" size="14" />
          <span>{{ tab.label }}</span>
          <span v-if="tab.count !== undefined" class="workbench-tab-count">{{ tab.count > 99 ? "99+" : tab.count }}</span>
        </button>
      </nav>

      <div v-if="activeTab === 'discussion'" class="workbench-discussion">
        <section class="workbench-main">
          <ThreadFilter
            :items="teamStore.timeline"
            :selected="selectedThread"
            @update:selected="selectThread"
            @locate="onLocated"
          />
          <TeamTimeline
            :items="visibleTimeline"
            :seats="teamStore.seats"
            :highlight-id="locatedId"
          />
          <RoundtableComposer />
        </section>

        <aside class="workbench-rail">
          <WorkerDetailCard />
          <AttentionSurface />

          <div class="open-items" data-test="open-items">
            <div class="oi-heading">
              <span class="oi-title">
                <v-icon icon="mdi-format-list-checks" size="14" />
                未决
                <span v-if="activeOpenItems.length > 0" class="oi-count">{{ activeOpenItems.length }}</span>
              </span>
              <button type="button" class="oi-refresh" @click="teamStore.refreshOpenItems()">刷新</button>
            </div>
            <div v-if="openItems.length === 0" class="oi-empty">没有未决项</div>
            <div
              v-for="item in openItems.slice(0, 12)"
              :key="item.id"
              class="oi-item"
              :class="`oi-item--${openItemTone(item.status)}`"
              :data-test="`open-item-${item.id}`"
            >
              <div class="oi-subject">{{ item.subject }}</div>
              <div class="oi-meta">
                <span class="oi-status">{{ openItemStatusLabel(item.status) }}</span>
                <span>{{ openItemOwner(item) }}</span>
                <span class="oi-time">{{ formatClock(item.updatedAt) }}</span>
              </div>
            </div>
          </div>

          <DeliverablePanel />
        </aside>
      </div>

      <div v-else-if="activeTab === 'activity'" class="workbench-body">
        <div class="activity-toolbar">
          <div>
            <strong>席位活动</strong>
            <span>{{ activityScope === "focused" ? "当前席位" : "全部席位" }}</span>
          </div>
          <v-btn size="x-small" variant="tonal" @click="toggleActivityScope">
            {{ activityScope === "focused" ? "看全部" : "看当前席位" }}
          </v-btn>
        </div>
        <template v-if="activityScope === 'focused'">
          <WorkerSessionView />
        </template>
        <AllActivityView v-if="activityScope === 'all'" />
      </div>

      <div v-else class="workbench-body workbench-body--changes">
        <FileChangeSummary />
      </div>
    </template>

    <RosterSetupDialog v-model="showRoster" :mode="rosterMode" @created="showRoster = false" />
    <RoundtableSettingsDialog v-model="showSettings" />

    <v-dialog v-model="showStopDialog" max-width="420" :persistent="isStopping">
      <v-card class="stop-dialog-card">
        <div class="stop-dialog-title">停止并归档圆桌</div>
        <div class="stop-dialog-text">
          确定停止 <strong>{{ roundtable?.name }}</strong>？席位会全部停下，这一场归档为只读记录，已完成的记录与交付物都保留。
        </div>
        <label v-if="allowWrapUpOnStop" class="stop-dialog-option">
          <v-checkbox
            v-model="stopWithWrapUp"
            density="compact"
            hide-details
            color="primary"
            label="停止前做一次整理（开场已授权）"
          />
        </label>
        <v-card-actions class="stop-dialog-actions">
          <v-spacer />
          <v-btn variant="text" :disabled="isStopping" @click="showStopDialog = false">取消</v-btn>
          <v-btn color="error" variant="tonal" :loading="isStopping" @click="confirmStop">停止并归档</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.team-dashboard {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: #ffffff;
}

.team-alert {
  flex-shrink: 0;
  margin: var(--pix-space-sm);
}

.legacy-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: var(--pix-space-sm) var(--pix-space-sm) 0;
  padding: 6px 9px;
  border: 1px solid var(--pix-warning-light);
  border-radius: var(--pix-radius-md);
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
  font-size: 10px;
}

.legacy-ack {
  margin-left: auto;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 10px;
  cursor: pointer;
  text-decoration: underline;
}

.team-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--pix-space-sm);
  color: var(--pix-text-secondary);
  padding: var(--pix-space-lg);
  text-align: center;
}

.team-empty-icon,
.workbench-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: var(--pix-radius-lg);
  background: var(--pix-accent-light);
  color: var(--pix-accent);
}

.team-empty strong {
  font-size: var(--pix-text-sm);
}

.team-empty-hint {
  color: var(--pix-text-muted);
  font-size: 11px;
}

.team-loading-icon {
  color: var(--pix-accent);
  animation: team-spin 900ms linear infinite;
}

@keyframes team-spin {
  to { transform: rotate(360deg); }
}

.workbench-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--pix-space-md);
  min-height: 58px;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border-bottom: 1px solid var(--pix-border-subtle);
  flex-shrink: 0;
}

.workbench-title {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  min-width: 0;
}

.workbench-mark {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
}

.workbench-title-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.workbench-title-copy strong,
.workbench-title-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workbench-title-copy strong {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
}

.workbench-title-copy span {
  color: var(--pix-text-muted);
  font-size: 10px;
}

.workbench-controls {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  flex-shrink: 0;
}

.lifecycle-chip,
.seat-count {
  padding: 1px 7px;
  border-radius: 9px;
  font-size: 10px;
  font-weight: var(--pix-weight-medium);
}

.lifecycle-chip--active { background: var(--pix-success-bg); color: var(--pix-success); }
.lifecycle-chip--paused { background: var(--pix-warning-bg); color: var(--pix-warning); }
.lifecycle-chip--stopped,
.lifecycle-chip--inactive { background: var(--pix-bg-hover); color: var(--pix-text-muted); }

.seat-count {
  background: var(--pix-accent-light);
  color: var(--pix-accent);
}

.workbench-tabs {
  display: flex;
  gap: 3px;
  padding: 5px var(--pix-space-sm);
  border-bottom: 1px solid var(--pix-border-subtle);
  background: #fafbfc;
  flex-shrink: 0;
}

.workbench-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 76px;
  min-height: 28px;
  padding: 4px 8px;
  border-radius: var(--pix-radius-md);
  color: var(--pix-text-muted);
  font-size: 10px;
  font-weight: var(--pix-weight-medium);
}

.workbench-tab:hover {
  color: var(--pix-text-primary);
  background: var(--pix-bg-hover);
}

.workbench-tab.active {
  color: var(--pix-accent);
  background: #ffffff;
  box-shadow: var(--pix-shadow-xs);
}

.workbench-tab-count {
  min-width: 16px;
  padding: 1px 4px;
  border-radius: 8px;
  background: var(--pix-bg-active);
  color: inherit;
  font-size: 9px;
  line-height: 14px;
}

.workbench-discussion {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
  flex: 1;
  min-height: 0;
}

.workbench-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--pix-border-subtle);
}

.workbench-rail {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-sm);
  padding: var(--pix-space-sm);
  overflow-y: auto;
  min-height: 0;
  background: #fbfcfe;
}

.open-items {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-xs);
  padding: var(--pix-space-sm);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-lg);
  background: rgba(255, 255, 255, 0.92);
  box-shadow: var(--pix-shadow-xs);
}

.oi-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.oi-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--pix-text-primary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
}

.oi-count {
  min-width: 16px;
  padding: 1px 5px;
  border-radius: 8px;
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
  font-size: 9px;
  text-align: center;
}

.oi-refresh {
  border: none;
  background: transparent;
  color: var(--pix-accent);
  font-size: 10px;
  cursor: pointer;
}

.oi-empty {
  color: var(--pix-text-muted);
  font-size: 10px;
}

.oi-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 7px;
  border-left: 3px solid var(--pix-border);
  border-radius: var(--pix-radius-sm);
  background: #ffffff;
}

.oi-item--open { border-left-color: var(--pix-warning); }
.oi-item--claimed { border-left-color: var(--pix-accent); }
.oi-item--resolved { border-left-color: var(--pix-success); opacity: 0.7; }
.oi-item--dropped { border-left-color: var(--pix-border); opacity: 0.6; }

.oi-subject {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
  line-height: 1.4;
}

.oi-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--pix-text-muted);
  font-size: 9px;
}

.oi-status {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--pix-bg-hover);
}

.oi-time {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.workbench-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  padding: var(--pix-space-sm);
}

.workbench-body--changes {
  padding: var(--pix-space-md);
  overflow-y: auto;
}

.activity-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--pix-space-sm);
  margin-bottom: var(--pix-space-sm);
}

.activity-toolbar > div {
  display: flex;
  flex-direction: column;
}

.activity-toolbar strong {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
}

.activity-toolbar span {
  color: var(--pix-text-muted);
  font-size: 10px;
}

.stop-dialog-card {
  padding: var(--pix-space-lg);
  border-radius: var(--pix-radius-xl) !important;
}

.stop-dialog-title {
  margin-bottom: var(--pix-space-sm);
  color: var(--pix-text-primary);
  font-size: var(--pix-text-md);
  font-weight: var(--pix-weight-semibold);
}

.stop-dialog-text {
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-sm);
  line-height: 1.5;
}

.stop-dialog-option {
  display: block;
  margin-top: var(--pix-space-xs);
}

.stop-dialog-actions {
  padding: var(--pix-space-sm) 0 0 !important;
}

@media (max-width: 1320px) {
  .workbench-discussion {
    grid-template-columns: minmax(0, 1fr) minmax(260px, 300px);
  }
}
</style>
