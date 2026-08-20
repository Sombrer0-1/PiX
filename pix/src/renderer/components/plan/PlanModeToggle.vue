<script setup lang="ts">
/**
 * PlanModeToggle - 输入区规划开关（PiX 1.4.0）
 *
 * 只维护当前 Solo 会话 composer 的 armed 状态：切换不发起任何 IPC，也不启动
 * 模型回合。真正的 enter_planning 由 CenterPanel 在用户提交非空需求时发送。
 * 仅在空闲时可切换；禁用时显示原因（文字+图标，不只靠颜色）。与 PlanPanel 和
 * CenterPanel 的会话状态文字共同构成三处明确的规划标识。
 */

const props = defineProps<{
  /** 当前 Solo composer 是否处于规划 armed 状态。 */
  armed: boolean;
  /** 非空闲场景（生成中/执行中/团队模式等）禁止切换。 */
  disabled?: boolean;
  /** 禁用原因；disabled 时显示。 */
  disableReason?: string | null;
}>();

const emit = defineEmits<{
  "update:armed": [value: boolean];
}>();

/** 点击或 Enter 键盘激活时切换；disabled 时不产生任何副作用。 */
function requestToggle(): void {
  if (props.disabled) return;
  emit("update:armed", !props.armed);
}
</script>

<template>
  <div class="plan-mode-toggle-wrap">
    <button
      type="button"
      role="switch"
      class="plan-mode-toggle"
      :class="{ armed }"
      :aria-checked="armed"
      :aria-label="armed ? '关闭规划模式' : '开启规划模式'"
      :disabled="disabled"
      :title="disabled && disableReason ? disableReason : '开启后，提交任务将先规划后执行'"
      @click="requestToggle"
      @keydown.enter.prevent="requestToggle"
    >
      <v-icon :icon="armed ? 'mdi-map-check-outline' : 'mdi-map-outline'" size="14" />
      <span class="plan-toggle-text">{{ armed ? "规划已开启" : "规划" }}</span>
    </button>
    <span v-if="disabled && disableReason" class="plan-toggle-disable-reason">
      <v-icon icon="mdi-alert-outline" size="13" />
      <span>{{ disableReason }}</span>
    </span>
  </div>
</template>

<style scoped>
.plan-mode-toggle-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.plan-mode-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-lg);
  background: var(--pix-bg-content);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-sm);
  font-family: var(--pix-font-ui);
  font-weight: var(--pix-weight-medium);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background var(--pix-transition-fast),
    border-color var(--pix-transition-fast),
    color var(--pix-transition-fast);
}

.plan-mode-toggle:hover:not(:disabled) {
  background: var(--pix-bg-hover);
  color: var(--pix-text-primary);
}

.plan-mode-toggle.armed {
  color: var(--pix-accent);
  background: var(--pix-accent-light);
  border-color: var(--pix-accent-soft);
}

.plan-mode-toggle:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.plan-toggle-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

.plan-toggle-disable-reason {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 160px;
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
