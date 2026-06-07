<script setup lang="ts">
/**
 * ClarificationCard — single question card rendered above the composer input.
 *
 * Displays one question at a time with optional shortcut options and a free-form
 * textarea. Feels like the AI is asking a follow-up question, not a form.
 */
import type { RequestUserInputQuestion } from "@/types/rpc";

const props = defineProps<{
  question: RequestUserInputQuestion;
  questionIndex: number;
  totalQuestions: number;
  answer: string;
}>();

const emit = defineEmits<{
  "update:answer": [value: string];
  next: [];
  cancel: [];
}>();

function onTextareaInput(e: Event): void {
  const target = e.target as HTMLTextAreaElement;
  emit("update:answer", target.value);
}
</script>

<template>
  <div class="clarification-card">
    <div class="card-header">
      <span class="question-label">{{ question.header }}</span>
      <span class="question-progress">{{ questionIndex }} / {{ totalQuestions }}</span>
    </div>

    <div class="card-body">
      <p class="question-text">{{ question.question }}</p>

      <div v-if="question.options?.length" class="option-chips">
        <button
          v-for="opt in question.options"
          :key="opt.label"
          type="button"
          class="option-chip"
          :class="{ active: answer === opt.label }"
          @click="emit('update:answer', opt.label)"
        >
          <span class="option-label">{{ opt.label }}</span>
          <span v-if="opt.description" class="option-desc">{{ opt.description }}</span>
        </button>
      </div>

      <textarea
        class="card-textarea"
        :value="answer"
        :placeholder="question.options?.length ? '其他回答...' : '输入回答...'"
        rows="2"
        @input="onTextareaInput"
      ></textarea>
    </div>

    <div class="card-footer">
      <button class="footer-btn skip-btn" type="button" @click="emit('cancel')">跳过</button>
      <button
        class="footer-btn next-btn"
        type="button"
        :disabled="!answer.trim()"
        @click="emit('next')"
      >
        {{ questionIndex === totalQuestions ? '提交' : '继续' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.clarification-card {
  background: var(--pix-bg-card);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-lg);
  padding: var(--pix-space-md);
  animation: card-enter 220ms ease-out;
}

@keyframes card-enter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--pix-space-sm);
}

.question-label {
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-accent);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.question-progress {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  font-weight: var(--pix-weight-medium);
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-sm);
}

.question-text {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-primary);
  line-height: var(--pix-leading-base);
  margin: 0;
}

.option-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--pix-space-xs);
}

.option-chip {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-lg);
  background: var(--pix-bg-content);
  color: var(--pix-text-primary);
  font-family: var(--pix-font-ui);
  font-size: var(--pix-text-sm);
  cursor: pointer;
  transition:
    background var(--pix-transition-fast),
    border-color var(--pix-transition-fast),
    box-shadow var(--pix-transition-fast);
  text-align: left;
  min-width: 90px;
}

.option-chip:hover {
  background: var(--pix-bg-hover);
  border-color: var(--pix-border);
}

.option-chip.active {
  border-color: var(--pix-accent);
  background: var(--pix-accent-light);
  box-shadow: inset 0 0 0 1px rgba(98, 84, 243, 0.18);
}

.option-label {
  font-weight: var(--pix-weight-medium);
}

.option-desc {
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-tight);
}

.card-textarea {
  width: 100%;
  resize: vertical;
  min-height: 52px;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-input);
  color: var(--pix-text-primary);
  font-family: var(--pix-font-ui);
  font-size: var(--pix-text-sm);
  line-height: var(--pix-leading-base);
}

.card-textarea:focus {
  outline: none;
  border-color: var(--pix-accent);
  box-shadow: 0 0 0 3px rgba(98, 84, 243, 0.1);
}

.card-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: var(--pix-space-sm);
  margin-top: var(--pix-space-md);
}

.footer-btn {
  padding: 6px 16px;
  border-radius: var(--pix-radius-md);
  font-family: var(--pix-font-ui);
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-medium);
  cursor: pointer;
  transition:
    background var(--pix-transition-fast),
    color var(--pix-transition-fast),
    box-shadow var(--pix-transition-fast),
    opacity var(--pix-transition-fast);
  border: none;
}

.skip-btn {
  background: transparent;
  color: var(--pix-text-secondary);
}

.skip-btn:hover {
  background: var(--pix-bg-hover);
  color: var(--pix-text-primary);
}

.next-btn {
  background: var(--pix-accent);
  color: var(--pix-text-inverse);
}

.next-btn:hover:not(:disabled) {
  background: var(--pix-accent-hover);
  box-shadow: 0 4px 12px rgba(98, 84, 243, 0.28);
}

.next-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
