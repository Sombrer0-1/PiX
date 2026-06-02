<script setup lang="ts">
/**
 * BottomBar - Input area
 *
 * Multi-line text input with send/stop controls.
 * Supports slash command triggering.
 */
import { ref, computed, nextTick } from "vue";
import { useRpc } from "../../composables/useRpc";
import CommandPalette from "../input/CommandPalette.vue";
import ModelSelector from "../input/ModelSelector.vue";

const rpc = useRpc();

const inputText = ref("");
const searchQuery = ref("");
const showCommandPalette = ref(false);
const showModelSelector = ref(false);
const isSending = ref(false);
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const canSend = computed(() => inputText.value.trim().length > 0 && rpc.isConnected.value && !isSending.value);
const isStreaming = computed(() => rpc.isStreaming.value);
const modelDisplay = computed(() => {
  const model = rpc.sessionState.value?.model;
  return model ? `${model.provider}/${model.id}` : "No model";
});

function handleInput(e: Event): void {
  const target = e.target as HTMLTextAreaElement;
  inputText.value = target.value;
  void nextTick(autoResize);

  // Check for slash command trigger
  const cursorPos = target.selectionStart;
  const textBeforeCursor = target.value.slice(0, cursorPos);
  const lastSlashIndex = textBeforeCursor.lastIndexOf("/");

  if (lastSlashIndex !== -1) {
    // Check if we're at the start of a line or whitespace before the slash
    const charBefore = textBeforeCursor[lastSlashIndex - 1];
    if (lastSlashIndex === 0 || charBefore === " " || charBefore === "\n") {
      const query = textBeforeCursor.slice(lastSlashIndex + 1);
      if (query.length <= 20 && !query.includes(" ")) {
        searchQuery.value = query;
        showCommandPalette.value = true;
      } else {
        showCommandPalette.value = false;
      }
    } else {
      showCommandPalette.value = false;
    }
  } else {
    showCommandPalette.value = false;
  }
}

function handleKeydown(e: KeyboardEvent): void {
  // Send on Enter (without Shift)
  if (e.key === "Enter" && !e.shiftKey) {
    if (showCommandPalette.value) {
      // If palette is open, let it handle Enter
      return;
    }
    e.preventDefault();
    sendMessage();
  }
}

async function sendMessage(): Promise<void> {
  const text = inputText.value.trim();
  if (!text || (!canSend.value && !isStreaming.value)) return;

  isSending.value = true;
  try {
    if (isStreaming.value) {
      // Queue as steering message while agent is running
      rpc.sendCommandAsync({ type: "steer", message: text });
    } else {
      await rpc.sendPrompt(text);
    }
    inputText.value = "";
    if (textareaRef.value) {
      textareaRef.value.value = "";
      textareaRef.value.style.height = "auto";
    }
  } finally {
    isSending.value = false;
  }
}

async function stopAgent(): Promise<void> {
  await rpc.abort();
}

function onCommandSelected(commandName: string): void {
  if (textareaRef.value) {
    const cursorPos = textareaRef.value.selectionStart;
    const textBeforeCursor = inputText.value.slice(0, cursorPos);
    const lastSlashIndex = textBeforeCursor.lastIndexOf("/");

    if (lastSlashIndex !== -1) {
      const before = inputText.value.slice(0, lastSlashIndex);
      const after = inputText.value.slice(cursorPos);
      inputText.value = before + "/" + commandName + " " + after;
      textareaRef.value.value = inputText.value;
    }
  }
  showCommandPalette.value = false;
  textareaRef.value?.focus();
}

// Auto-resize textarea
function autoResize(): void {
  if (textareaRef.value) {
    textareaRef.value.style.height = "auto";
    textareaRef.value.style.height = Math.min(textareaRef.value.scrollHeight, 200) + "px";
  }
}
</script>

<template>
  <div class="bottom-bar">
    <div class="bottom-bar-inner">
      <!-- Command Palette -->
      <CommandPalette
        v-if="showCommandPalette"
        :search="searchQuery"
        @select="onCommandSelected"
        @close="showCommandPalette = false"
      />

      <!-- Input Area -->
      <div class="input-container">
        <textarea
          ref="textareaRef"
          class="input-textarea"
          :placeholder="isStreaming ? 'Agent is running... type to queue a follow-up or steering message' : 'Type a task or / for commands...'"
          @input="handleInput"
          @keydown="handleKeydown"
          rows="1"
          spellcheck="true"
        ></textarea>
      </div>

      <!-- Controls -->
      <div class="input-controls">
        <div class="controls-left">
          <button
            class="model-btn"
            @click="showModelSelector = !showModelSelector"
            :title="modelDisplay"
          >
            {{ modelDisplay }}
          </button>
          <ModelSelector
            v-if="showModelSelector"
            @close="showModelSelector = false"
          />
        </div>

        <div class="controls-right">
          <button
            v-if="isStreaming"
            class="control-btn stop-btn"
            @click="stopAgent"
          >
            Stop
          </button>
          <button
            v-else
            class="control-btn send-btn"
            :disabled="!canSend"
            @click="sendMessage"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bottom-bar {
  padding: var(--pix-space-md) var(--pix-space-xl);
}

.bottom-bar-inner {
  max-width: var(--pix-content-max-width);
  margin: 0 auto;
  position: relative;
}

.input-container {
  margin-bottom: var(--pix-space-sm);
}

.input-textarea {
  width: 100%;
  padding: var(--pix-space-md);
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-md);
  font-size: var(--pix-text-base);
  line-height: var(--pix-leading-base);
  background: var(--pix-bg-input);
  color: var(--pix-text-primary);
  resize: none;
  font-family: var(--pix-font-ui);
  transition: border-color var(--pix-transition-fast);
}

.input-textarea:focus {
  outline: none;
  border-color: var(--pix-border-focus);
}

.input-textarea:disabled {
  background: var(--pix-bg-code);
  color: var(--pix-text-secondary);
}

.input-textarea::placeholder {
  color: var(--pix-text-muted);
}

.input-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.controls-left {
  display: flex;
  gap: var(--pix-space-sm);
  position: relative;
}

.controls-right {
  display: flex;
  gap: var(--pix-space-sm);
}

.model-btn {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-sm);
  font-family: var(--pix-font-mono);
  max-width: 250px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-btn:hover {
  background: var(--pix-bg-hover);
  color: var(--pix-text-secondary);
}

.control-btn {
  padding: var(--pix-space-xs) var(--pix-space-lg);
  border-radius: var(--pix-radius-sm);
  font-size: var(--pix-text-sm);
  font-weight: 500;
}

.send-btn {
  background: var(--pix-accent);
  color: var(--pix-text-inverse);
}

.send-btn:hover:not(:disabled) {
  opacity: 0.9;
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.stop-btn {
  background: var(--pix-error-bg);
  color: var(--pix-error);
  border: 1px solid #e8d0d0;
}

.stop-btn:hover {
  background: #f5e0e0;
}
</style>
