<script setup lang="ts">
import { useTeamStore } from "../../stores/team-store";

const teamStore = useTeamStore();

function agentName(agentId: string): string {
  return agentId.split("::")[0] || agentId;
}
</script>

<template>
  <div
    v-if="teamStore.permissionRequests.length > 0 || teamStore.planApprovals.length > 0"
    class="protocol-stack"
  >
    <div v-if="teamStore.permissionRequests.length > 0" class="protocol-card protocol-card--attention">
      <div class="card-title">
        <v-icon icon="mdi-shield-alert-outline" size="15" />
        权限请求
      </div>
      <div
        v-for="req in teamStore.permissionRequests"
        :key="req.id"
        class="protocol-item"
      >
        <span class="protocol-agent">{{ agentName(req.agentId) }}</span>
        <span class="protocol-text">
          请求使用 <strong>{{ req.tool }}</strong>
        </span>
        <span v-if="typeof req.args?.reason === 'string'" class="protocol-reason">
          {{ req.args.reason }}
        </span>
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

    <div v-if="teamStore.planApprovals.length > 0" class="protocol-card protocol-card--leader">
      <div class="card-title">
        <v-icon icon="mdi-clipboard-check-outline" size="15" />
        负责人审核
      </div>
      <div
        v-for="approval in teamStore.planApprovals"
        :key="approval.id"
        class="protocol-item"
      >
        <span class="protocol-agent">{{ agentName(approval.agentId) }}</span>
        <span class="protocol-text">已提交计划，等待负责人审核。</span>
        <span class="protocol-reason">{{ approval.plan }}</span>
        <span class="protocol-note">请在负责人对话中继续审核。</span>
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

.protocol-card--attention {
  border-color: var(--pix-warning-light);
  background: var(--pix-warning-bg);
}

.protocol-card--leader {
  border-color: var(--pix-border-light);
  background: var(--pix-bg-card);
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

.protocol-agent {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  text-transform: capitalize;
}

.protocol-text,
.protocol-reason,
.protocol-note {
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
}

.protocol-note {
  color: var(--pix-text-muted);
}

.protocol-actions {
  display: flex;
  gap: var(--pix-space-xs);
  justify-content: flex-end;
  position: relative;
  z-index: 1;
}
</style>
