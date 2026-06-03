<script setup lang="ts">
/**
 * TopBar - Compact workspace header
 *
 * Now lives inside CenterPanel, not spanning the full window.
 * Shows project breadcrumb, connection status, session name, and actions
 * all in one tight 28px bar.
 */
import { computed } from "vue";
import { useRpc } from "../../composables/useRpc";
import { useProjectStore } from "../../stores/project-store";

const rpc = useRpc();
const projectStore = useProjectStore();

const projectName = computed(() => projectStore.currentProject?.name || "");
const sessionName = computed(() => rpc.sessionState.value?.sessionName || "");
</script>

<template>
  <div class="topbar">
    <div class="topbar-left">
      <span class="topbar-brand">PiX</span>
      <template v-if="projectName">
        <span class="topbar-sep">&rsaquo;</span>
        <span class="topbar-project">{{ projectName }}</span>
      </template>
      <template v-if="sessionName">
        <span class="topbar-sep">&rsaquo;</span>
        <span class="topbar-session">{{ sessionName }}</span>
      </template>
    </div>

    <div class="topbar-right">
      <span
        class="topbar-status"
        :class="{ connected: rpc.isConnected.value }"
        :title="rpc.isConnected.value ? 'Pi connected' : 'Disconnected'"
      >
        <span class="topbar-dot"></span>
        {{ rpc.isConnected.value ? 'Pi' : 'Offline' }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--pix-topbar-height);
  min-height: var(--pix-topbar-height);
  padding: 0 var(--pix-space-lg);
  background: var(--pix-bg-topbar);
  border-bottom: 1px solid var(--pix-border-light);
  -webkit-app-region: drag;
  user-select: none;
  flex-shrink: 0;
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  min-width: 0;
  overflow: hidden;
}

.topbar-brand {
  font-size: var(--pix-text-sm);
  font-weight: 600;
  color: var(--pix-text-primary);
  flex-shrink: 0;
}

.topbar-sep {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-muted);
  flex-shrink: 0;
}

.topbar-project,
.topbar-session {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: var(--pix-space-md);
  flex-shrink: 0;
}

.topbar-status {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  -webkit-app-region: no-drag;
}

.topbar-status.connected {
  color: var(--pix-success);
}

.topbar-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
</style>
