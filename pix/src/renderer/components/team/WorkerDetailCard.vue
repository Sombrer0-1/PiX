<script setup lang="ts">
/**
 * WorkerDetailCard - one seat's detail card (or the whole-roster overview).
 *
 * A seat is a perspective, not a job: this card shows its 视角 / 模型 / 授权档位
 * / 状态 / 当前动作, plus the interrupt record that explains why it was cut off
 * (L2/L3 pushes and the L2 budget fuse notice). Nothing here is "coordinated via
 * the leader" — seats talk to each other through the timeline.
 */
import { computed, onUnmounted, ref, watch } from "vue";
import { useTeamStore } from "../../stores/team-store";
import {
  authTierLabel,
  interruptLabel,
  seatStatusDot,
  seatStatusLabel,
  seatStatusTone,
} from "./roundtable-display";
import type { ToolAuthTier } from "@shared/team-types.js";

const teamStore = useTeamStore();

const focusedSeat = computed(() => teamStore.focusedSeat);

// Runtime display must tick while a seat is working; Date.now() is not a
// reactive dependency, so drive elapsed time from a `now` ref updated by a 1s
// interval that only runs while the focused seat is active.
const now = ref(Date.now());
let runtimeTimer: ReturnType<typeof setInterval> | undefined;

function startRuntimeTick(): void {
  if (runtimeTimer) return;
  runtimeTimer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
}

function stopRuntimeTick(): void {
  if (runtimeTimer) {
    clearInterval(runtimeTimer);
    runtimeTimer = undefined;
  }
}

const isRunning = computed(() => {
  const status = focusedSeat.value?.status;
  return status === "speaking" || status === "exploring";
});

watch(
  isRunning,
  (running) => {
    if (running) {
      now.value = Date.now();
      startRuntimeTick();
    } else {
      stopRuntimeTick();
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  stopRuntimeTick();
});

const runtime = computed(() => {
  const seat = focusedSeat.value;
  if (!seat || !isRunning.value) return "";
  const ms = now.value - seat.statusChangedAt;
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟`;
  return `${Math.floor(ms / 3_600_000)} 小时 ${Math.floor((ms % 3_600_000) / 60_000)} 分钟`;
});

/** Interrupt record: the L2/L3 pushes aimed at this seat, newest first. */
const interruptRecord = computed(() => {
  const seatId = teamStore.focusedSeatId;
  if (seatId === null) return [];
  return teamStore.timeline
    .filter((item) => item.toId === seatId && item.interrupt !== undefined && item.interrupt !== "L0")
    .slice(-3)
    .reverse()
    .map((item) => ({
      id: item.id,
      ts: item.ts,
      level: interruptLabel(item.interrupt),
      text: item.summary || item.text,
    }));
});

/** L2 budget fuse notice for this seat (attention item raised by the controller). */
const l2FuseNotice = computed(() => {
  const seatId = teamStore.focusedSeatId;
  if (seatId === null) return null;
  const items = teamStore.attention.filter((item) => item.kind === "l2_fused" && item.seatId === seatId);
  return items.length > 0 ? items[items.length - 1] : null;
});

// ---- Auth tier editing (讨论中可改；受限档带路径白名单) ----
const authOptions: Array<{ title: string; value: ToolAuthTier }> = [
  { title: "只读", value: "read_only" },
  { title: "可写", value: "write" },
  { title: "受限", value: "restricted" },
];

const authDraft = ref<ToolAuthTier>("read_only");
const allowlistDraft = ref("");
const actionInFlight = ref(false);

function syncAuthDraft(): void {
  const seat = focusedSeat.value;
  authDraft.value = seat?.auth ?? "read_only";
  allowlistDraft.value = (seat?.pathAllowlist ?? []).join(", ");
}

// watch 标量而不是席位对象：每次 seat_status / tool_execution_start 推送都会重建
// SeatInfo，用对象当 watch 源会把用户正在编辑的授权档位/白名单草稿静默重置
// （FR-5「讨论中可改授权」几乎没法完成）。只有换席位才重置草稿。
watch(
  () => focusedSeat.value?.seatId ?? null,
  () => {
    syncAuthDraft();
  },
  { immediate: true },
);

// 授权档位/白名单真的变了（应用后主进程回推，或外部改动）才同步草稿；标量签名
// 保证同席的状态推送不会触发。
watch(
  () => `${focusedSeat.value?.auth ?? ""}|${(focusedSeat.value?.pathAllowlist ?? []).join(",")}`,
  () => {
    syncAuthDraft();
  },
);

/** 已退出席位没有 runner：唤醒必然抛错、移除是静默 no-op，索性禁用并说明原因。 */
const seatExited = computed(() => focusedSeat.value?.status === "exited");

const canApplyAuth = computed(() => {
  const seat = focusedSeat.value;
  if (!seat) return false;
  if (authDraft.value !== seat.auth) return true;
  if (authDraft.value !== "restricted") return false;
  // 受限档的路径白名单可以就地改，授权档位不变也要能提交。
  return allowlistDraft.value.trim() !== (seat.pathAllowlist ?? []).join(", ");
});

async function applyAuth(): Promise<void> {
  const seat = focusedSeat.value;
  if (!seat || actionInFlight.value) return;
  actionInFlight.value = true;
  try {
    const allowlist = authDraft.value === "restricted"
      ? allowlistDraft.value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
      : undefined;
    await teamStore.updateSeatAuth(seat.seatId, authDraft.value, allowlist);
  } finally {
    actionInFlight.value = false;
  }
}

async function wake(): Promise<void> {
  const seat = focusedSeat.value;
  if (!seat || actionInFlight.value) return;
  actionInFlight.value = true;
  try {
    await teamStore.wakeSeat(seat.seatId);
  } finally {
    actionInFlight.value = false;
  }
}

async function removeSeat(): Promise<void> {
  const seat = focusedSeat.value;
  if (!seat || actionInFlight.value) return;
  actionInFlight.value = true;
  try {
    await teamStore.removeSeat(seat.seatId, "user");
    teamStore.clearFocus();
  } finally {
    actionInFlight.value = false;
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
</script>

<template>
  <div class="seat-detail-card" data-test="seat-detail-card">
    <div class="card-title">
      <span v-if="focusedSeat">席位详情</span>
      <span v-else>席位总览</span>
    </div>

    <template v-if="focusedSeat">
      <div class="sd-header">
        <span class="sd-dot" :style="{ backgroundColor: seatStatusDot(focusedSeat.status) }"></span>
        <span class="sd-name" :style="{ color: focusedSeat.color }">{{ focusedSeat.name }}</span>
        <v-chip :color="seatStatusTone(focusedSeat.status)" size="x-small" label variant="flat">
          {{ seatStatusLabel(focusedSeat.status) }}
        </v-chip>
      </div>

      <div class="sd-rows">
        <div class="sd-row sd-row--stack">
          <span class="sd-label">视角</span>
          <span class="sd-value sd-value--wrap">{{ focusedSeat.perspective || "未设置" }}</span>
        </div>
        <div class="sd-row">
          <span class="sd-label">模型</span>
          <span class="sd-value">{{ focusedSeat.model ?? "默认" }}</span>
        </div>
        <div class="sd-row">
          <span class="sd-label">授权</span>
          <span class="sd-value" data-test="seat-auth-value">{{ authTierLabel(focusedSeat.auth) }}</span>
        </div>
        <div class="sd-row">
          <span class="sd-label">席位 ID</span>
          <span class="sd-value sd-value--mono">{{ focusedSeat.seatId }}</span>
        </div>
        <div v-if="isRunning && runtime" class="sd-row">
          <span class="sd-label">持续</span>
          <span class="sd-value">{{ runtime }}</span>
        </div>
        <div v-if="focusedSeat.currentActivity" class="sd-row sd-row--stack">
          <span class="sd-label">当前动作</span>
          <span class="sd-value sd-value--wrap sd-value--muted">{{ focusedSeat.currentActivity }}</span>
        </div>
        <div v-if="focusedSeat.error" class="sd-row sd-row--stack">
          <span class="sd-label sd-label--error">异常</span>
          <span class="sd-value sd-value--wrap sd-value--error">{{ focusedSeat.error }}</span>
        </div>
      </div>

      <!-- 改授权（受限档带路径白名单） -->
      <div class="sd-auth-editor">
        <v-select
          v-model="authDraft"
          :items="authOptions"
          item-title="title"
          item-value="value"
          density="compact"
          variant="outlined"
          hide-details
          label="工具授权"
        />
        <v-text-field
          v-if="authDraft === 'restricted'"
          v-model="allowlistDraft"
          density="compact"
          variant="outlined"
          hide-details
          placeholder="允许的路径（逗号分隔）"
          label="路径白名单"
        />
        <v-btn
          size="x-small"
          variant="tonal"
          color="primary"
          data-test="seat-apply-auth"
          :disabled="!canApplyAuth || actionInFlight"
          @click="applyAuth"
        >
          应用授权
        </v-btn>
      </div>

      <div v-if="interruptRecord.length > 0 || l2FuseNotice" class="sd-interrupts" data-test="seat-interrupt-record">
        <div class="sd-label">打断记录</div>
        <div v-if="l2FuseNotice" class="sd-interrupt sd-interrupt--fuse">
          <v-icon icon="mdi-call-split" size="12" />
          <span>{{ l2FuseNotice.text }}</span>
        </div>
        <div v-for="entry in interruptRecord" :key="entry.id" class="sd-interrupt">
          <span class="sd-interrupt-level">{{ entry.level }}</span>
          <span class="sd-interrupt-text">{{ entry.text }}</span>
          <span class="sd-interrupt-time">{{ formatTime(entry.ts) }}</span>
        </div>
      </div>

      <div class="sd-actions">
        <v-btn
          size="x-small"
          variant="tonal"
          color="primary"
          prepend-icon="mdi-bell-ring-outline"
          data-test="seat-wake"
          :disabled="actionInFlight || seatExited"
          :title="seatExited ? '席位已退出，无法唤醒' : '唤醒该席位'"
          @click="wake"
        >
          唤醒
        </v-btn>
        <v-btn
          size="x-small"
          variant="tonal"
          color="error"
          prepend-icon="mdi-account-minus-outline"
          data-test="seat-remove"
          :disabled="actionInFlight || seatExited"
          :title="seatExited ? '席位已退出' : '移除该席位'"
          @click="removeSeat"
        >
          移除席位
        </v-btn>
      </div>
    </template>

    <template v-else>
      <div class="sd-overview">
        <button
          v-for="seat in teamStore.seatList"
          :key="seat.seatId"
          class="sd-overview-row"
          type="button"
          :title="seat.perspective"
          @click="teamStore.focusSeat(seat.seatId)"
        >
          <span class="sd-overview-dot" :style="{ backgroundColor: seatStatusDot(seat.status) }"></span>
          <span class="sd-overview-name" :style="{ color: seat.color }">{{ seat.name }}</span>
          <span class="sd-overview-perspective">{{ seat.perspective }}</span>
          <span class="sd-overview-status">{{ seatStatusLabel(seat.status) }}</span>
        </button>
        <div v-if="teamStore.seatList.length === 0" class="sd-overview-empty">暂无席位</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.seat-detail-card {
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-lg);
  padding: var(--pix-space-md);
  box-shadow: var(--pix-shadow-xs);
}

.card-title {
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  margin-bottom: var(--pix-space-sm);
}

.sd-header {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  margin-bottom: var(--pix-space-sm);
}

.sd-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.sd-name {
  font-weight: var(--pix-weight-semibold);
  font-size: var(--pix-text-sm);
}

.sd-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sd-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 22px;
  gap: var(--pix-space-xs);
}

.sd-row--stack {
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.sd-label {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  flex-shrink: 0;
}

.sd-label--error {
  color: var(--pix-error);
}

.sd-value {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-primary);
  font-weight: var(--pix-weight-medium);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 62%;
}

.sd-value--wrap {
  max-width: 100%;
  text-align: left;
  white-space: normal;
  font-weight: var(--pix-weight-normal);
  line-height: 1.45;
}

.sd-value--muted {
  color: var(--pix-text-secondary);
  font-style: italic;
}

.sd-value--error {
  color: var(--pix-error);
}

.sd-value--mono {
  font-family: var(--pix-font-mono);
  font-size: 10px;
}

.sd-auth-editor {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-xs);
  margin-top: var(--pix-space-sm);
  padding-top: var(--pix-space-sm);
  border-top: 1px solid var(--pix-border-subtle);
}

.sd-auth-editor :deep(.v-field) {
  font-size: var(--pix-text-xs);
}

.sd-interrupts {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: var(--pix-space-sm);
  padding-top: var(--pix-space-sm);
  border-top: 1px solid var(--pix-border-subtle);
}

.sd-interrupt {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-size: 10px;
  color: var(--pix-text-secondary);
}

.sd-interrupt--fuse {
  color: var(--pix-warning);
}

.sd-interrupt-level {
  flex-shrink: 0;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
  font-weight: var(--pix-weight-semibold);
}

.sd-interrupt-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sd-interrupt-time {
  flex-shrink: 0;
  color: var(--pix-text-muted);
  font-variant-numeric: tabular-nums;
}

.sd-actions {
  display: flex;
  gap: var(--pix-space-xs);
  margin-top: var(--pix-space-sm);
  flex-wrap: wrap;
}

.sd-overview {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sd-overview-row {
  display: grid;
  grid-template-columns: auto minmax(52px, auto) minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  padding: 4px 5px;
  border-radius: var(--pix-radius-sm);
  background: transparent;
  text-align: left;
  font-size: var(--pix-text-xs);
}

.sd-overview-row:hover {
  background: var(--pix-bg-hover);
}

.sd-overview-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.sd-overview-name {
  font-weight: var(--pix-weight-medium);
}

.sd-overview-perspective {
  min-width: 0;
  overflow: hidden;
  color: var(--pix-text-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sd-overview-status {
  color: var(--pix-text-muted);
  font-size: 10px;
  white-space: nowrap;
}

.sd-overview-empty {
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
  padding: var(--pix-space-sm) 0;
}
</style>
