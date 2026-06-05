<script setup lang="ts">
/**
 * ForkDialog - Choose a user message to fork from.
 */
import { ref, onMounted } from "vue";
import { useRpc } from "../../composables/useRpc";
import type { UserMessageForForking } from "@/types/rpc";

const emit = defineEmits<{
  close: [];
  fork: [entryId: string, label?: string];
}>();

const rpc = useRpc();
const messages = ref<UserMessageForForking[]>([]);
const loading = ref(true);
const forkLabel = ref("");

onMounted(async () => {
  try {
    const result = await rpc.getUserMessagesForForking();
    if (result) {
      messages.value = result;
    }
  } catch (err) {
    console.error("[ForkDialog] Failed to load messages:", err);
  } finally {
    loading.value = false;
  }
});

function selectMessage(entryId: string): void {
  emit("fork", entryId, forkLabel.value || undefined);
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}
</script>

<template>
  <div class="fork-dialog-overlay" @click.self="emit('close')">
    <div class="fork-dialog">
      <div class="dialog-header">
        <span class="dialog-title">Fork Session</span>
        <button class="dialog-close" @click="emit('close')">&times;</button>
      </div>

      <p class="dialog-desc">
        Choose a message to fork from. A new session will be created with history up to that point.
      </p>

      <div class="dialog-label-input">
        <input
          v-model="forkLabel"
          type="text"
          class="form-input"
          placeholder="Optional: label for the fork point"
          spellcheck="false"
        />
      </div>

      <div class="dialog-list">
        <div v-if="loading" class="loading-state">Loading messages...</div>
        <div v-else-if="messages.length === 0" class="empty-state">No user messages found in this session.</div>
        <button
          v-for="msg in messages"
          :key="msg.entryId"
          class="fork-item"
          @click="selectMessage(msg.entryId)"
        >
          <span class="fork-text">{{ truncate(msg.text, 120) }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fork-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(18, 24, 47, 0.28);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.fork-dialog {
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  box-shadow: var(--pix-shadow-xl);
  width: 520px;
  max-height: 560px;
  display: flex;
  flex-direction: column;
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--pix-space-lg) var(--pix-space-xl);
  border-bottom: 1px solid var(--pix-border-light);
}

.dialog-title {
  font-size: var(--pix-text-md);
  font-weight: 600;
}

.dialog-close {
  font-size: var(--pix-text-xl);
  color: var(--pix-text-muted);
  line-height: 1;
  width: 30px;
  height: 30px;
  border-radius: var(--pix-radius-md);
}

.dialog-close:hover {
  color: var(--pix-text-primary);
  background: var(--pix-bg-hover);
}

.dialog-desc {
  padding: var(--pix-space-md) var(--pix-space-xl);
  font-size: var(--pix-text-sm);
  color: var(--pix-text-secondary);
  margin: 0;
}

.dialog-label-input {
  padding: 0 var(--pix-space-xl) var(--pix-space-md);
}

.form-input {
  width: 100%;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-lg);
  font-size: var(--pix-text-sm);
  background: var(--pix-bg-input);
  color: var(--pix-text-primary);
}

.form-input:focus {
  outline: none;
  border-color: var(--pix-accent);
  box-shadow: 0 0 0 3px rgba(98, 84, 243, 0.12);
}

.dialog-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 var(--pix-space-md) var(--pix-space-md);
}

.loading-state,
.empty-state {
  padding: var(--pix-space-xl);
  text-align: center;
  color: var(--pix-text-muted);
  font-size: var(--pix-text-sm);
}

.fork-item {
  display: block;
  width: 100%;
  padding: var(--pix-space-md);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-lg);
  text-align: left;
  margin-bottom: var(--pix-space-xs);
  font-size: var(--pix-text-sm);
  color: var(--pix-text-primary);
}

.fork-item:hover {
  background: var(--pix-bg-hover);
  border-color: var(--pix-accent-light-hover);
}

.fork-text {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
