<script setup lang="ts">
/**
 * MessageBlock - User message display block
 *
 * Shows user input as a right-docked chat bubble.
 */
import { ref } from "vue";
import type { ChatMessageAttachment } from "@/types/session";

defineProps<{
  text: string;
  attachments?: ChatMessageAttachment[];
  timestamp: number;
}>();

const selectedAttachment = ref<ChatMessageAttachment | null>(null);

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSize(size?: number): string {
  if (size === undefined) return "";
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function kindLabel(kind: ChatMessageAttachment["kind"]): string {
  if (kind === "image") return "图片";
  if (kind === "text") return "文本";
  return "文件";
}
</script>

<template>
  <div class="message-block">
    <div class="message-indicator">
      <span class="message-label">你</span>
      <span class="message-time">{{ formatTime(timestamp) }}</span>
    </div>
    <div v-if="text" class="message-content">{{ text }}</div>
    <div v-if="attachments && attachments.length > 0" class="message-attachments">
      <button
        v-for="attachment in attachments"
        :key="`${attachment.path}:${attachment.name}`"
        class="attachment-chip"
        :title="attachment.path"
        @click="selectedAttachment = attachment"
      >
        <span class="attachment-kind">{{ kindLabel(attachment.kind) }}</span>
        <span class="attachment-name">{{ attachment.name }}</span>
        <span v-if="formatSize(attachment.size)" class="attachment-size">{{ formatSize(attachment.size) }}</span>
      </button>
    </div>

    <v-dialog
      :model-value="!!selectedAttachment"
      max-width="780"
      @update:model-value="(open) => { if (!open) selectedAttachment = null }"
    >
      <v-card v-if="selectedAttachment" class="attachment-dialog">
        <div class="attachment-dialog-title">{{ selectedAttachment.name }}</div>
        <div class="attachment-dialog-path">{{ selectedAttachment.path }}</div>
        <pre v-if="selectedAttachment.content" class="attachment-content">{{ selectedAttachment.content }}</pre>
        <div v-else class="attachment-empty">此附件已作为 {{ kindLabel(selectedAttachment.kind) }} 发送。</div>
        <v-card-actions class="attachment-dialog-actions">
          <v-spacer />
          <v-btn variant="text" @click="selectedAttachment = null">关闭</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.message-block {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  margin-bottom: var(--pix-space-xl);
  animation: message-in 0.18s ease-out;
}

.message-indicator {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--pix-space-sm);
  margin-bottom: var(--pix-space-xs);
}

.message-label {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0;
}

.message-time {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
  font-family: var(--pix-font-mono);
}

.message-content {
  max-width: min(78%, 760px);
  font-size: var(--pix-text-sm);
  line-height: var(--pix-leading-relaxed);
  color: var(--pix-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  padding: var(--pix-space-sm) var(--pix-space-md);
  background: #f8fafc;
  border-radius: var(--pix-radius-md);
  border: 1px solid var(--pix-border);
}

.message-attachments {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--pix-space-xs);
  margin-top: var(--pix-space-sm);
  max-width: min(78%, 760px);
}

.attachment-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 280px;
  padding: 5px 8px;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-content);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  cursor: pointer;
}

.attachment-chip:hover {
  border-color: var(--pix-border);
  background: var(--pix-bg-hover);
  color: var(--pix-text-primary);
}

.attachment-kind {
  color: var(--pix-accent);
  font-weight: var(--pix-weight-semibold);
  flex-shrink: 0;
}

.attachment-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.attachment-size {
  flex-shrink: 0;
  color: var(--pix-text-muted);
}

.attachment-dialog {
  padding: var(--pix-space-lg);
}

.attachment-dialog-title {
  font-size: var(--pix-text-lg);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
}

.attachment-dialog-path {
  margin-top: var(--pix-space-xs);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  word-break: break-all;
}

.attachment-content {
  margin-top: var(--pix-space-md);
  max-height: 55vh;
  overflow: auto;
  padding: var(--pix-space-md);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-code);
  color: var(--pix-text-primary);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-base);
  white-space: pre-wrap;
  word-break: break-word;
}

.attachment-empty {
  margin-top: var(--pix-space-md);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-sm);
}

.attachment-dialog-actions {
  padding: var(--pix-space-md) 0 0;
}

@keyframes message-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
