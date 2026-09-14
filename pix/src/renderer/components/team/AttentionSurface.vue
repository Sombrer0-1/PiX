<script setup lang="ts">
/**
 * AttentionSurface - 注意力面：只推用户需要知道的事，且可逐条确认。
 *
 * Kinds come straight from `AttentionItem.kind` (user_mentioned, permission,
 * write_conflict, seat_error, seat_stuck, soft_budget, wrap_up_ready,
 * hard_stop, deliverable_ready, exit_request, l2_fused). The surface never
 * filters by "opinion quality": an entry is here because the event type or a
 * user rule put it here (PRD FR-8). Acking one entry never touches the others.
 *
 * Permission entries carry inline approve/deny (the answer goes back into the
 * seat's inbox); exit negotiations carry an accept/decline pair.
 */
import { computed, ref } from "vue";
import { useTeamStore } from "../../stores/team-store";
import {
  attentionKindIcon,
  attentionKindLabel,
  formatClock,
  seatLabel,
} from "./roundtable-display";
import type { AttentionItem } from "@shared/team-types.js";

const teamStore = useTeamStore();

const showAcked = ref(false);

const visible = computed<AttentionItem[]>(() => {
  const items = teamStore.attention;
  return showAcked.value ? items : items.filter((item) => !item.acked);
});

const ackedCount = computed(() => teamStore.attention.filter((item) => item.acked).length);

const pendingExits = computed(() => teamStore.exitRequests);
/** 每张退出协商卡自己的输入（按键 = refId）：一张 ref 会让多张卡串台。 */
const exitStatements = ref<Record<string, string>>({});

function seatName(seatId: string | undefined): string {
  return seatId === undefined ? "全员" : seatLabel(seatId, teamStore.seats);
}

function permissionTool(refId: string | undefined): string {
  if (refId === undefined) return "";
  return teamStore.pendingPermissions.find((request) => request.id === refId)?.tool ?? "";
}

/**
 * A permission / exit entry is actionable while the *request* itself is pending,
 * never because the entry is merely unacked. Ack means "seen"; the request queue
 * is the only thing that makes 允许/拒绝 real. Keying on `!acked` left answered
 * requests with dead buttons on the surface forever (a restored discussion
 * replays attention but not the pending queue), and the surface has no way to
 * remove them — only the user can bury them.
 */
function isOpenPermission(item: AttentionItem): boolean {
  if (item.kind !== "permission" || item.refId === undefined) return false;
  return teamStore.pendingPermissions.some((request) => request.id === item.refId);
}

function isOpenExit(item: AttentionItem): boolean {
  if (item.kind !== "exit_request" || item.refId === undefined) return false;
  return teamStore.exitRequests.some((request) => request.id === item.refId);
}

function isActionable(item: AttentionItem): boolean {
  return isOpenPermission(item) || isOpenExit(item);
}

function handleAck(item: AttentionItem): void {
  void teamStore.ackAttention(item.id);
}

function toggleAcked(): void {
  showAcked.value = !showAcked.value;
}

/**
 * 答复成功即 ack：请求已经离开 pending 队列，卡片不该继续以「未处理」留在面上。
 * 失败（lastError 非空）时不 ack，用户还能再试一次。
 */
async function respondPermission(item: AttentionItem, approved: boolean): Promise<void> {
  if (item.refId === undefined) return;
  const ok = await teamStore.respondPermission(item.refId, approved, approved ? undefined : "用户拒绝");
  if (ok) await teamStore.ackAttention(item.id);
}

async function respondExit(item: AttentionItem, requestId: string, accept: boolean): Promise<void> {
  await teamStore.respondExit(requestId, (exitStatements.value[requestId] ?? "").trim(), accept);
  delete exitStatements.value[requestId];
  // respondExit 只回 void（store 把失败写进 lastError，且每次 send 都会先清空它）。
  if (teamStore.lastError === null) await teamStore.ackAttention(item.id);
}
</script>

<template>
  <div class="attention-surface" data-test="attention-surface">
    <div class="surface-heading">
      <span class="surface-title">
        <v-icon icon="mdi-bell-outline" size="14" />
        需要你知道
        <span v-if="teamStore.unackedAttention.length > 0" class="surface-count" data-test="attention-unacked-count">
          {{ teamStore.unackedAttention.length }}
        </span>
      </span>
      <button
        v-if="ackedCount > 0"
        type="button"
        class="surface-toggle"
        @click="toggleAcked"
      >
        {{ showAcked ? "隐藏已处理" : `显示已处理 (${ackedCount})` }}
      </button>
    </div>

    <div v-if="visible.length === 0" class="surface-empty">
      <v-icon icon="mdi-check-circle-outline" size="20" />
      <span>没有待处理事项</span>
    </div>

    <div
      v-for="item in visible"
      :key="item.id"
      class="attention-item"
      :class="{ 'attention-item--acked': item.acked }"
      data-test="attention-item"
    >
      <div class="attention-row">
        <span class="attention-kind">
          <v-icon :icon="attentionKindIcon(item.kind)" size="13" />
          {{ attentionKindLabel(item.kind) }}
        </span>
        <span class="attention-seat">{{ seatName(item.seatId) }}</span>
        <span class="attention-time">{{ formatClock(item.ts) }}</span>
      </div>
      <div class="attention-text">{{ item.text }}</div>

      <!-- 权限：唯一生产者是 request_permission，答复写回席位 inbox -->
      <div v-if="isOpenPermission(item)" class="attention-actions">
        <span v-if="permissionTool(item.refId)" class="attention-tool">{{ permissionTool(item.refId) }}</span>
        <v-btn
          size="x-small"
          color="green"
          variant="flat"
          density="compact"
          :disabled="item.refId === undefined"
          @click="respondPermission(item, true)"
        >
          允许
        </v-btn>
        <v-btn
          size="x-small"
          color="red"
          variant="tonal"
          density="compact"
          :disabled="item.refId === undefined"
          @click="respondPermission(item, false)"
        >
          拒绝
        </v-btn>
      </div>

      <!-- 退出协商：双方说法入时间线后移除席位 -->
      <div v-if="isOpenExit(item) && item.refId" class="attention-actions attention-actions--exit">
        <v-text-field
          v-model="exitStatements[item.refId]"
          density="compact"
          variant="outlined"
          hide-details
          placeholder="你的说法（可选）"
        />
        <v-btn size="x-small" color="primary" variant="flat" density="compact" @click="respondExit(item, item.refId, true)">
          同意退出
        </v-btn>
        <v-btn size="x-small" variant="text" density="compact" @click="respondExit(item, item.refId, false)">
          继续讨论
        </v-btn>
      </div>

      <!-- 待决策项不能只被「知道了」埋掉：答复前不显示 ack -->
      <div v-if="!item.acked && !isActionable(item)" class="attention-foot">
        <button type="button" class="attention-ack" @click="handleAck(item)">知道了</button>
      </div>
    </div>

    <div v-if="pendingExits.length > 0" class="attention-exits-hint">
      {{ pendingExits.length }} 条退出协商进行中
    </div>
  </div>
</template>

<style scoped>
.attention-surface {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-xs);
  padding: var(--pix-space-sm);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-lg);
  background: rgba(255, 255, 255, 0.92);
  box-shadow: var(--pix-shadow-xs);
}

.surface-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--pix-space-xs);
}

.surface-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--pix-text-primary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
}

.surface-count {
  min-width: 16px;
  padding: 1px 5px;
  border-radius: 8px;
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
  font-size: 9px;
  text-align: center;
}

.surface-toggle {
  border: none;
  background: transparent;
  color: var(--pix-accent);
  font-size: 10px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: var(--pix-radius-sm);
}

.surface-toggle:hover {
  background: var(--pix-bg-hover);
}

.surface-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: var(--pix-space-xs) 0;
  color: var(--pix-text-muted);
  font-size: 10px;
}

.attention-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 7px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
  background: #ffffff;
}

.attention-item--acked {
  opacity: 0.6;
}

.attention-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.attention-kind {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--pix-accent-light);
  color: var(--pix-accent);
  font-size: 9px;
  font-weight: var(--pix-weight-semibold);
}

.attention-seat {
  color: var(--pix-text-secondary);
  font-size: 10px;
  font-weight: var(--pix-weight-medium);
}

.attention-time {
  margin-left: auto;
  color: var(--pix-text-muted);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.attention-text {
  color: var(--pix-text-primary);
  font-size: 11px;
  line-height: 1.5;
  word-break: break-word;
  max-height: 96px;
  overflow-y: auto;
}

.attention-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--pix-space-xs);
  flex-wrap: wrap;
}

.attention-actions--exit :deep(.v-field) {
  font-size: var(--pix-text-xs);
}

.attention-tool {
  margin-right: auto;
  color: var(--pix-text-muted);
  font-family: var(--pix-font-mono);
  font-size: 10px;
}

.attention-foot {
  display: flex;
  justify-content: flex-end;
}

.attention-ack {
  border: none;
  background: transparent;
  color: var(--pix-accent);
  font-size: 10px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--pix-radius-sm);
}

.attention-ack:hover {
  background: var(--pix-bg-hover);
}

.attention-exits-hint {
  color: var(--pix-text-muted);
  font-size: 10px;
  text-align: right;
}
</style>
