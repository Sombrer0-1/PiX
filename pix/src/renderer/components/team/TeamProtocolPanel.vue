<script setup lang="ts">
import { useTeamStore } from "../../stores/team-store";

const teamStore = useTeamStore();

function agentName(agentId: string): string {
  return agentId.split("::")[0] || agentId;
}
</script>

<template>
  <div v-if="teamStore.permissionRequests.length > 0" class="info-card protocol-card">
    <div class="card-title">Permission Request</div>
    <div
      v-for="req in teamStore.permissionRequests"
      :key="req.id"
      class="protocol-item"
    >
      <span class="protocol-agent">{{ agentName(req.agentId) }}</span>
      <span class="protocol-text">
        Requests permission to use <strong>{{ req.tool }}</strong>
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
          Allow
        </v-btn>
        <v-btn
          size="x-small"
          color="red"
          variant="flat"
          density="compact"
          @click="teamStore.respondPermission(req.id, false, 'Rejected by user')"
        >
          Deny
        </v-btn>
      </div>
    </div>
  </div>

  <div v-if="teamStore.planApprovals.length > 0" class="info-card protocol-card protocol-card--leader">
    <div class="card-title">Leader Review</div>
    <div
      v-for="approval in teamStore.planApprovals"
      :key="approval.id"
      class="protocol-item"
    >
      <span class="protocol-agent">{{ agentName(approval.agentId) }}</span>
      <span class="protocol-text">Submitted a plan for Leader review.</span>
      <span class="protocol-reason">{{ approval.plan }}</span>
      <span class="protocol-note">
        The Leader will approve, reject, or ask you a synthesized question in the main conversation.
      </span>
    </div>
  </div>
</template>

<style scoped>
.info-card {
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

.protocol-card {
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
