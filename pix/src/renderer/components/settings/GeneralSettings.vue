<script setup lang="ts">
/**
 * GeneralSettings - Integration and connection settings
 *
 * v2: piPath removed; direct AgentSession integration.
 */

import { ref, onMounted } from "vue";
import { useSettingsStore } from "../../stores/settings-store";

const settingsStore = useSettingsStore();
const detection = ref<{ found: boolean; path: string; note?: string } | null>(null);

onMounted(async () => {
  await detect();
});

async function detect(): Promise<void> {
  detection.value = await settingsStore.detectPi();
}
</script>

<template>
  <div class="general-settings">
    <div class="setting-group">
      <label class="setting-label">Agent Integration</label>
      <p class="setting-desc">
        PiX runs pi in-process via direct AgentSession integration.
        No external pi binary is needed.
      </p>

      <div v-if="detection" class="detect-result" :class="detection.found ? 'found' : 'not-found'">
        <template v-if="detection.found">
          Direct integration active - {{ detection.note || detection.path }}
        </template>
        <template v-else>
          {{ detection.note || 'Integration not available' }}
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.setting-group {
  margin-bottom: var(--pix-space-lg);
}

.setting-label {
  display: block;
  font-size: var(--pix-text-sm);
  font-weight: 600;
  color: var(--pix-text-primary);
  margin-bottom: var(--pix-space-xs);
}

.setting-desc {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  margin-bottom: var(--pix-space-sm);
}

.setting-row {
  display: flex;
  gap: var(--pix-space-sm);
}

.setting-input {
  flex: 1;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-sm);
  background: var(--pix-bg-input);
  color: var(--pix-text-primary);
  font-family: var(--pix-font-mono);
}

.setting-input:focus {
  outline: none;
  border-color: var(--pix-border-focus);
}

.btn-sm {
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-sm);
  color: var(--pix-text-secondary);
  background: var(--pix-bg-content);
}

.btn-sm:hover {
  background: var(--pix-bg-hover);
}

.detect-result {
  margin-top: var(--pix-space-sm);
  padding: var(--pix-space-xs) var(--pix-space-md);
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-xs);
}

.detect-result.found {
  background: var(--pix-success-bg);
  color: var(--pix-success);
}

.detect-result.not-found {
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
}
</style>
