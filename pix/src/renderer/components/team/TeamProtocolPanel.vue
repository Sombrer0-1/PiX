<script setup lang="ts">
/**
 * TeamProtocolPanel - pending permission cards.
 *
 * The only permission producer is the seat tool `request_permission`; the seat
 * gets `submitted` immediately and the answer travels back through its inbox.
 * A pause never drops these (H23), so the cards stay until answered here or on
 * the roundtable attention surface.
 */
import { computed } from "vue";
import { useTeamStore } from "../../stores/team-store";
import { seatLabel } from "./roundtable-display";
import type { PermissionRequest } from "@shared/types.js";

const teamStore = useTeamStore();

const requests = computed(() => teamStore.pendingPermissions);

function seatName(seatId: string | undefined): string {
  return seatId === undefined ? "未知席位" : seatLabel(seatId, teamStore.seats);
}

/**
 * 理由行的数据源是 `PermissionRequest.reason`（席位的理由写在顶层，生产者见
 * `TeamManager.requestPermission`）。曾经的 `args.reason` 只有在被请求工具恰好
 * 有个叫 reason 的参数时才有值 → 理由行永远对不上；`args` 为空对象时还会显示 `{}`。
 */
function reasonText(req: PermissionRequest): string {
  if (req.reason !== undefined && req.reason.length > 0) return req.reason;
  const args = req.args;
  if (args === undefined || Object.keys(args).length === 0) return "";
  try {
    const raw = JSON.stringify(args);
    return raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
  } catch {
    return "";
  }
}
</script>

<template>
  <div v-if="requests.length > 0" class="protocol-stack" data-test="protocol-panel">
    <div class="protocol-card protocol-card--attention">
      <div class="card-title">
        <v-icon icon="mdi-shield-alert-outline" size="15" />
        权限请求
        <span class="card-count">{{ requests.length }}</span>
      </div>
      <div v-for="req in requests" :key="req.id" class="protocol-item" data-test="protocol-permission">
        <span class="protocol-seat">{{ seatName(req.agentId) }}</span>
        <span class="protocol-text">
          请求使用 <strong>{{ req.tool }}</strong>
        </span>
        <span v-if="reasonText(req)" class="protocol-reason" data-test="protocol-reason">{{ reasonText(req) }}</span>
        <div class="protocol-actions">
          <v-btn
            size="x-small"
            color="green"
            variant="flat"
            density="compact"
            @click="teamStore.respondPermission(req.id, true)"
          >
            允许
          </v-btn>
          <v-btn
            size="x-small"
            color="red"
            variant="tonal"
            density="compact"
            @click="teamStore.respondPermission(req.id, false, '用户拒绝')"
          >
            拒绝
          </v-btn>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.protocol-stack {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-xs);
  padding: var(--pix-space-sm) var(--pix-space-md) 0;
  flex-shrink: 0;
  max-height: 220px;
  overflow-y: auto;
}

.protocol-card {
  background: #ffffff;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  padding: var(--pix-space-sm);
}

.card-title {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  margin-bottom: var(--pix-space-sm);
}

.card-count {
  min-width: 16px;
  padding: 1px 5px;
  border-radius: 8px;
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
  font-size: 10px;
  font-weight: var(--pix-weight-semibold);
  text-align: center;
}

.protocol-card--attention {
  border-color: var(--pix-warning-light);
  background: var(--pix-warning-bg);
}

.protocol-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: var(--pix-space-xs) 0;
  border-bottom: 1px solid var(--pix-border-subtle);
}

.protocol-item:last-child {
  border-bottom: none;
}

.protocol-seat {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
}

.protocol-text,
.protocol-reason {
  font-size: 11px;
  line-height: 1.45;
  color: var(--pix-text-secondary);
}

.protocol-reason {
  max-height: 92px;
  overflow: auto;
  padding: var(--pix-space-xs);
  border-radius: var(--pix-radius-md);
  background: rgba(255, 255, 255, 0.62);
  font-family: var(--pix-font-mono);
  word-break: break-word;
}

.protocol-actions {
  display: flex;
  gap: var(--pix-space-xs);
  justify-content: flex-end;
  position: relative;
  z-index: 1;
}
</style>
