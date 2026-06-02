<script setup lang="ts">
/**
 * InputArea - The multi-line text input component
 *
 * Reusable text input with auto-resize and keybindings.
 */
import { ref } from "vue";

const props = defineProps<{
  placeholder?: string;
  disabled?: boolean;
  modelValue: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  "send": [];
}>();

const textareaRef = ref<HTMLTextAreaElement | null>(null);

function onInput(e: Event): void {
  const target = e.target as HTMLTextAreaElement;
  emit("update:modelValue", target.value);
  autoResize();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    emit("send");
  }
}

function autoResize(): void {
  if (textareaRef.value) {
    textareaRef.value.style.height = "auto";
    textareaRef.value.style.height = Math.min(textareaRef.value.scrollHeight, 200) + "px";
  }
}

function focus(): void {
  textareaRef.value?.focus();
}

defineExpose({ focus });
</script>

<template>
  <textarea
    ref="textareaRef"
    class="input-area"
    :value="modelValue"
    :placeholder="placeholder || 'Type a task...'"
    :disabled="disabled"
    @input="onInput"
    @keydown="onKeydown"
    rows="1"
    spellcheck="true"
  ></textarea>
</template>

<style scoped>
.input-area {
  width: 100%;
  padding: var(--pix-space-md);
  border: 1px solid var(--pix-border);
  border-radius: var(--pix-radius-md);
  font-family: var(--pix-font-ui);
  font-size: var(--pix-text-base);
  line-height: var(--pix-leading-base);
  color: var(--pix-text-primary);
  background: var(--pix-bg-input);
  resize: none;
  transition: border-color var(--pix-transition-fast);
}

.input-area:focus {
  outline: none;
  border-color: var(--pix-border-focus);
}

.input-area:disabled {
  background: var(--pix-bg-code);
  color: var(--pix-text-secondary);
}

.input-area::placeholder {
  color: var(--pix-text-muted);
}
</style>
