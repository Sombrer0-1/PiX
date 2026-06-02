<script setup lang="ts">
/**
 * TopBar - Minimal title bar
 */
import { useRpc } from "../../composables/useRpc";
import { useProjectStore } from "../../stores/project-store";

const rpc = useRpc();
const projectStore = useProjectStore();
</script>

<template>
  <div class="topbar">
    <div class="topbar-left">
      <span class="app-name">PiX</span>
      <span v-if="projectStore.currentProject" class="topbar-separator">/</span>
      <span v-if="projectStore.currentProject" class="project-name">{{ projectStore.currentProject.name }}</span>
    </div>

    <div class="topbar-center">
      <div class="pi-indicator" :class="{ connected: rpc.isConnected.value }">
        <span class="pi-dot"></span>
        <span class="pi-text">{{ rpc.isConnected.value ? 'Pi Connected' : 'Disconnected' }}</span>
      </div>
    </div>

    <div class="topbar-right">
      <!-- Reserved for future minimal controls -->
    </div>
  </div>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 100%;
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
}

.app-name {
  font-size: var(--pix-text-sm);
  font-weight: 600;
  color: var(--pix-text-primary);
}

.topbar-separator {
  color: var(--pix-text-muted);
  font-size: var(--pix-text-sm);
}

.project-name {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-secondary);
}

.topbar-center {
  display: flex;
  align-items: center;
}

.pi-indicator {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  padding: 2px var(--pix-space-md);
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}

.pi-indicator.connected {
  color: var(--pix-success);
}

.pi-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pix-text-muted);
}

.pi-indicator.connected .pi-dot {
  background: var(--pix-success);
}

.pi-text {
  font-weight: 500;
}

.topbar-right {
  display: flex;
  align-items: center;
}
</style>
