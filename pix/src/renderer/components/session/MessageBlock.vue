<script setup lang="ts">
/**
 * MessageBlock - User message display block
 *
 * Shows user input in the document stream.
 * Not a chat bubble: subtle left indicator, plain text.
 */
defineProps<{
  text: string;
  timestamp: number;
}>();

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}
</script>

<template>
  <div class="message-block">
    <div class="message-indicator">
      <span class="message-label">你</span>
      <span class="message-time">{{ formatTime(timestamp) }}</span>
    </div>
    <div class="message-content">{{ text }}</div>
  </div>
</template>

<style scoped>
.message-block {
  margin-bottom: var(--pix-space-xl);
}

.message-indicator {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  margin-bottom: var(--pix-space-xs);
}

.message-label {
  font-size: var(--pix-text-xs);
  font-weight: 600;
  color: var(--pix-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.message-time {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  font-family: var(--pix-font-mono);
}

.message-content {
  font-size: var(--pix-text-md);
  line-height: var(--pix-leading-relaxed);
  color: var(--pix-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  padding: var(--pix-space-md);
  background: var(--pix-bg-code);
  border-radius: var(--pix-radius-md);
  border: 1px solid var(--pix-border-light);
}
</style>
