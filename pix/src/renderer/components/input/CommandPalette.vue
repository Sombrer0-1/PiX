<script setup lang="ts">
/**
 * CommandPalette - Slash command suggestion dropdown
 *
 * Appears when user types "/" in the input area.
 * Shows available commands filtered by the search text.
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { RpcSlashCommand } from "@/types/rpc";

const props = defineProps<{
  search: string;
  commands: RpcSlashCommand[];
}>();

const emit = defineEmits<{
  select: [commandName: string];
  close: [];
}>();

const selectedIndex = ref(0);

const results = computed(() => {
  const query = props.search.toLowerCase().replace(/^\//, "");
  const commands = query
    ? props.commands.filter((command) =>
        command.name.toLowerCase().includes(query) ||
        (command.description?.toLowerCase().includes(query) ?? false),
      )
    : props.commands;
  return commands.slice(0, 10);
});

// Reset selection when results change
watch(results, () => {
  selectedIndex.value = 0;
});

function handleKeydown(e: KeyboardEvent): void {
  if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key)) return;
  e.stopPropagation();
  e.stopImmediatePropagation();
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      selectedIndex.value = Math.min(selectedIndex.value + 1, results.value.length - 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
      break;
    case "Enter":
      e.preventDefault();
      if (results.value[selectedIndex.value]) {
        emit("select", results.value[selectedIndex.value].name);
      }
      break;
    case "Escape":
      e.preventDefault();
      emit("close");
      break;
  }
}

onMounted(() => {
  window.addEventListener("keydown", handleKeydown, true);
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeydown, true);
});

function getSourceLabel(source: string): string {
  switch (source) {
    case "builtin": return "内置";
    case "skill": return "技能";
    case "prompt": return "提示";
    case "extension": return "扩展";
    default: return "";
  }
}
</script>

<template>
  <div class="command-palette" v-if="results.length > 0" @keydown="handleKeydown" tabindex="0" ref="paletteRef">
    <div class="palette-list">
      <button
        v-for="(cmd, idx) in results"
        :key="cmd.name"
        class="palette-item"
        :class="{ 'palette-selected': idx === selectedIndex }"
        @click="emit('select', cmd.name)"
      >
        <span class="palette-name">/{{ cmd.name }}</span>
        <span v-if="cmd.description" class="palette-desc">{{ cmd.description }}</span>
        <span class="palette-source">{{ getSourceLabel(cmd.source) }}</span>
      </button>
    </div>
    <div class="palette-hint">
      <span>&uarr;&darr; 移动，Enter 选择，Esc 关闭</span>
    </div>
  </div>
</template>

<style scoped>
.command-palette {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: var(--pix-space-sm);
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  box-shadow: var(--pix-shadow-xl);
  max-height: 240px;
  display: flex;
  flex-direction: column;
  z-index: 100;
}

.palette-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--pix-space-xs);
}

.palette-item {
  display: flex;
  align-items: baseline;
  gap: var(--pix-space-sm);
  width: 100%;
  padding: var(--pix-space-sm) var(--pix-space-md);
  border-radius: var(--pix-radius-lg);
  text-align: left;
  font-size: var(--pix-text-sm);
}

.palette-item:hover,
.palette-selected {
  background: var(--pix-bg-hover);
}

.palette-selected {
  background: var(--pix-accent-light);
  box-shadow: inset 3px 0 0 var(--pix-accent);
}

.palette-name {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-sm);
  font-weight: 600;
  color: var(--pix-accent);
  flex-shrink: 0;
}

.palette-desc {
  color: var(--pix-text-secondary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.palette-source {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  font-family: var(--pix-font-mono);
  flex-shrink: 0;
}

.palette-hint {
  padding: var(--pix-space-xs) var(--pix-space-md);
  border-top: 1px solid var(--pix-border-light);
  font-size: var(--pix-text-xs);
  color: var(--pix-text-muted);
  text-align: center;
}
</style>
