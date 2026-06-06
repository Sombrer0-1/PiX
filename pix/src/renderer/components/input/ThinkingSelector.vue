<script setup lang="ts">
import { computed, watch } from "vue";
import { useRpc } from "../../composables/useRpc";
import type { ModelInfo, ThinkingLevel } from "@/types/rpc";

const emit = defineEmits<{
  close: [];
}>();

const rpc = useRpc();

const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const THINKING_LEVEL_LABELS: Record<string, string> = {
  off: "关闭",
  minimal: "轻量",
  low: "低",
  medium: "标准",
  high: "深入",
  xhigh: "极深",
};

const THINKING_LEVEL_DESCRIPTIONS: Record<string, string> = {
  off: "不启用额外推理，适合直接任务",
  minimal: "最低推理开销，适合快速回答",
  low: "优先响应速度，适合简单任务",
  medium: "推荐日常使用",
  high: "更强推理，适合复杂问题",
  xhigh: "最充分思考，适合高难任务",
};

const currentModel = computed(() => rpc.sessionState.value?.model);
const currentThinkingLevel = computed(() => rpc.sessionState.value?.thinkingLevel ?? "medium");

const currentModelInfo = computed<ModelInfo | null>(() => {
  const model = currentModel.value;
  if (!model) return null;
  return rpc.availableModels.value.find((item) => item.provider === model.provider && item.id === model.id) ?? null;
});

const availableLevels = computed<ThinkingLevel[]>(() => {
  const model = currentModelInfo.value;
  if (!model) return ["off"];
  if (!model.reasoning) return ["off"];
  const supported = (model.thinkingLevels ?? []).filter((level): level is ThinkingLevel =>
    ALL_THINKING_LEVELS.includes(level as ThinkingLevel)
  );
  return supported.length > 0 ? supported : [...ALL_THINKING_LEVELS];
});

const modelTitle = computed(() => {
  const model = currentModel.value;
  return model ? `${model.provider}/${model.id}` : "未选择模型";
});

function thinkingLabel(level = String(currentThinkingLevel.value)): string {
  return THINKING_LEVEL_LABELS[level] ?? level;
}

function thinkingDescription(level: string): string {
  return THINKING_LEVEL_DESCRIPTIONS[level] ?? "选择该模型的思考深度";
}

async function selectThinkingLevel(level: ThinkingLevel): Promise<void> {
  await rpc.setThinkingLevel(level);
  emit("close");
}

watch(currentModel, () => {
  void rpc.refreshModels();
});
</script>

<template>
  <div class="thinking-selector">
    <div class="thinking-panel">
      <div class="thinking-header">
        <span>选择思考深度</span>
        <button class="thinking-close-btn" title="关闭" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="thinking-model-name">{{ modelTitle }}</div>

      <div class="thinking-options">
        <button
          v-for="level in availableLevels"
          :key="level"
          class="thinking-choice"
          :class="{ active: currentThinkingLevel === level }"
          @click="selectThinkingLevel(level)"
        >
          <span class="thinking-radio"></span>
          <span class="thinking-choice-text">
            <span class="thinking-choice-label">{{ thinkingLabel(level) }}</span>
            <span class="thinking-choice-desc">{{ thinkingDescription(level) }}</span>
          </span>
        </button>
      </div>

      <div class="thinking-note">
        <span class="thinking-note-icon">i</span>
        <span>可选档位会随当前模型实时变化。</span>
      </div>
    </div>
    <div class="dropdown-backdrop" @click="emit('close')"></div>
  </div>
</template>

<style scoped>
.thinking-selector {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 100;
}

.thinking-panel {
  position: relative;
  z-index: 101;
  width: 278px;
  padding: var(--pix-space-md);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  background: rgba(255, 255, 255, 0.98);
  box-shadow: var(--pix-shadow-xl);
}

.thinking-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #000000;
  font-size: var(--pix-text-base);
  font-weight: var(--pix-weight-semibold);
}

.thinking-model-name {
  margin: 3px 28px var(--pix-space-md) 0;
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thinking-close-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--pix-radius-md);
  color: var(--pix-text-secondary);
}

.thinking-close-btn:hover {
  background: var(--pix-bg-hover);
  color: #000000;
}

.thinking-options {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.thinking-choice {
  display: flex;
  align-items: flex-start;
  gap: var(--pix-space-sm);
  width: 100%;
  padding: 10px 8px;
  text-align: left;
  border-radius: var(--pix-radius-lg);
  color: #000000;
  transition: background var(--pix-transition-fast);
}

.thinking-choice:hover {
  background: #f7f8ff;
}

.thinking-radio {
  position: relative;
  width: 18px;
  height: 18px;
  margin-top: 2px;
  border: 1.5px solid #c8cede;
  border-radius: 50%;
  background: #ffffff;
  flex-shrink: 0;
}

.thinking-choice.active .thinking-radio {
  border-color: var(--pix-accent);
  box-shadow: 0 0 0 3px rgba(98, 84, 243, 0.12);
}

.thinking-choice.active .thinking-radio::after {
  content: "";
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: var(--pix-accent);
}

.thinking-choice-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.thinking-choice-label {
  color: #000000;
  font-size: var(--pix-text-sm);
  font-weight: var(--pix-weight-semibold);
}

.thinking-choice-desc {
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-tight);
}

.thinking-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: var(--pix-space-md);
  padding-top: var(--pix-space-md);
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-base);
}

.thinking-note-icon {
  width: 15px;
  height: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
  border: 1px solid var(--pix-text-muted);
  border-radius: 50%;
  font-size: 10px;
  font-family: var(--pix-font-mono);
  flex-shrink: 0;
}

.dropdown-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
}
</style>
