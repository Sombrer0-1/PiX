<script setup lang="ts">
/**
 * ErrorBlock - Error display in session stream
 *
 * Clear but not intrusive error presentation.
 */
defineProps<{
  message: string;
  source?: string;
}>();
</script>

<template>
  <div class="error-block">
    <div class="error-header">
      <span class="error-icon" aria-hidden="true">!</span>
      <span class="error-label">Error</span>
      <span v-if="source" class="error-source">{{ source }}</span>
    </div>
    <div class="error-message">{{ message }}</div>
  </div>
</template>

<style scoped>
.error-block {
  margin-bottom: var(--pix-space-xl);
  padding: var(--pix-space-md);
  background: var(--pix-error-bg);
  border: 1px solid var(--pix-error-light);
  border-radius: var(--pix-radius-lg);
  box-shadow: var(--pix-shadow-xs);
}

.error-header {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  margin-bottom: var(--pix-space-sm);
}

.error-icon {
  color: var(--pix-error);
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #ffffff;
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-bold);
}

.error-label {
  font-size: var(--pix-text-xs);
  font-weight: 600;
  color: var(--pix-error);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.error-source {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  font-family: var(--pix-font-mono);
}

.error-message {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-primary);
  line-height: var(--pix-leading-base);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}
</style>
