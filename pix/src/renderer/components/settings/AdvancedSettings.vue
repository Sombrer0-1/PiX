<script setup lang="ts">
/**
 * AdvancedSettings - Diagnostic and debug tools
 */

import { ref } from "vue";
import { useRpc } from "../../composables/useRpc";

const rpc = useRpc();
const stderrOutput = ref("");
const showingStderr = ref(false);

async function showStderr(): Promise<void> {
  try {
    stderrOutput.value = await window.pixApi.getPiStderr();
    showingStderr.value = true;
  } catch {
    stderrOutput.value = "Failed to retrieve stderr.";
  }
}
</script>

<template>
  <div class="advanced-settings">
    <div class="setting-item">
      <div class="item-info">
        <div class="item-label">Pi Data Directory</div>
        <div class="item-value mono">~/.pi/agent/</div>
      </div>
    </div>

    <div class="setting-item">
      <div class="item-info">
        <div class="item-label">Session Storage</div>
        <div class="item-value mono">~/.pi/agent/sessions/</div>
      </div>
    </div>

    <div class="setting-item">
      <div class="item-info">
        <div class="item-label">Settings File</div>
        <div class="item-value mono">~/.pi/agent/settings.json</div>
      </div>
    </div>

    <div class="setting-item">
      <div class="item-info">
        <div class="item-label">Pi Stderr Output</div>
        <button class="btn btn-sm" @click="showStderr">View Stderr</button>
      </div>
      <pre v-if="showingStderr && stderrOutput" class="stderr-block">{{ stderrOutput }}</pre>
    </div>

    <div class="setting-item">
      <div class="item-info">
        <div class="item-label">Pi Status</div>
        <div class="item-value">{{ rpc.isRunning.value ? 'Running' : (rpc.piStatus.value === 'error' ? 'Error' : 'Stopped') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.setting-item {
  margin-bottom: var(--pix-space-lg);
}

.item-info {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--pix-space-md);
}

.item-label {
  font-size: var(--pix-text-sm);
  font-weight: 500;
  color: var(--pix-text-primary);
}

.item-value {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-secondary);
}

.item-value.mono {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
}

.btn-sm {
  padding: var(--pix-space-xs) var(--pix-space-md);
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-sm);
  color: var(--pix-text-secondary);
  background: var(--pix-bg-content);
}

.btn-sm:hover {
  background: var(--pix-bg-hover);
}

.stderr-block {
  margin-top: var(--pix-space-sm);
  padding: var(--pix-space-md);
  background: var(--pix-bg-code);
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-sm);
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-tight);
  max-height: 300px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--pix-text-primary);
}
</style>
