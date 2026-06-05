<script setup lang="ts">
/**
 * RawOutputViewer - Raw JSONL event log viewer
 *
 * Provides access to the raw event stream for debugging.
 */
defineProps<{
  rawJson: string;
}>();
</script>

<template>
  <div class="raw-viewer">
    <div class="raw-header">
      <span class="raw-label">Raw Event Output</span>
      <span class="raw-hint">All AgentSessionEvent objects as JSON</span>
    </div>
    <pre class="raw-content">{{ rawJson }}</pre>
  </div>
</template>

<style scoped>
.raw-viewer {
  max-width: var(--pix-content-max-width);
  margin: 0 auto;
  background: rgba(255, 255, 255, 0.94);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  box-shadow: var(--pix-shadow-xs);
  padding: var(--pix-space-lg);
}

.raw-header {
  display: flex;
  align-items: baseline;
  gap: var(--pix-space-sm);
  margin-bottom: var(--pix-space-md);
  padding-bottom: var(--pix-space-sm);
  border-bottom: 1px solid var(--pix-border-light);
}

.raw-label {
  font-weight: 600;
  font-size: var(--pix-text-sm);
  color: var(--pix-text-primary);
}

.raw-hint {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
}

.raw-content {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-tight);
  background: var(--pix-bg-code);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-lg);
  padding: var(--pix-space-md);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--pix-text-secondary);
}
</style>
