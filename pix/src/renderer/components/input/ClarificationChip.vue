<script setup lang="ts">
/**
 * ClarificationChip — compact summary chip for answered clarification questions.
 * Shows field label, answer value, checkmark, and an edit button.
 * Clicking the chip emits "edit" so the user can jump back to that question.
 */
defineProps<{
  field: string;
  value: string;
}>();

const emit = defineEmits<{
  edit: [];
}>();
</script>

<template>
  <button class="clarification-chip" type="button" @click="emit('edit')">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="chip-check">
      <polyline points="20 6 9 17 4 12" />
    </svg>
    <span class="chip-field">{{ field }}</span>
    <span class="chip-sep">:</span>
    <span class="chip-value">{{ value }}</span>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="chip-edit-icon">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  </button>
</template>

<style scoped>
.clarification-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: 1px solid var(--pix-border-light);
  border-radius: 20px;
  background: var(--pix-accent-light);
  color: var(--pix-text-secondary);
  font-family: var(--pix-font-ui);
  font-size: var(--pix-text-xs);
  cursor: pointer;
  transition:
    background var(--pix-transition-fast),
    border-color var(--pix-transition-fast),
    box-shadow var(--pix-transition-fast);
  white-space: nowrap;
  max-width: 320px;
}

.clarification-chip:hover {
  background: var(--pix-accent-light-hover);
  border-color: var(--pix-accent-soft);
  box-shadow: 0 0 0 2px rgba(98, 84, 243, 0.1);
}

.chip-check {
  color: var(--pix-success);
  flex-shrink: 0;
}

.chip-field {
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-accent);
  flex-shrink: 0;
}

.chip-sep {
  color: var(--pix-text-muted);
  flex-shrink: 0;
}

.chip-value {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  color: var(--pix-text-primary);
}

.chip-edit-icon {
  color: var(--pix-text-muted);
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--pix-transition-fast);
}

.clarification-chip:hover .chip-edit-icon {
  opacity: 1;
}
</style>
