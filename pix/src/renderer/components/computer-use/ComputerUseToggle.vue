<script setup lang="ts">
/**
 * ComputerUseToggle - 输入区电脑操控会话开关
 *
 * 全局开关关闭（availability "disabled"）时不渲染，由快照事件驱动出现。
 * 点击只发送 set_session_enabled，真相由主进程快照回推；可用性、禁用原因与
 * 告警文案全部来自 store 的 computeToggleState 包装（闭合映射）。
 * 禁用原因放在 tooltip 上（按钮 disabled 时鼠标事件不触发 title，故用
 * span 包裹作为 tooltip activator）。
 */

import { computed, onMounted } from "vue";
import { useComputerUseStore } from "../../stores/computer-use-store";

const store = useComputerUseStore();

onMounted(() => store.start());

const hint = computed(
  () =>
    store.toggleDisabledReason ??
    store.toggleWarning ??
    (store.sessionEnabled ? "关闭本会话的电脑操控" : "开启后，Agent 可观察并操作本机桌面"),
);

function toggle(): void {
  if (!store.canToggle) return;
  void store.setSessionEnabled(!store.sessionEnabled);
}
</script>

<template>
  <div v-if="store.globallyEnabled" class="computer-use-toggle-wrap">
    <v-tooltip location="top" :text="hint">
      <template #activator="{ props: tooltipProps }">
        <span v-bind="tooltipProps" class="computer-use-toggle-anchor">
          <button
            type="button"
            role="switch"
            class="computer-use-toggle"
            :class="{ active: store.sessionEnabled }"
            :aria-checked="store.sessionEnabled"
            :aria-label="store.sessionEnabled ? '关闭电脑操控' : '开启电脑操控'"
            :disabled="!store.canToggle"
            @click="toggle"
          >
            <v-icon :icon="store.sessionEnabled ? 'mdi-monitor-eye' : 'mdi-monitor'" size="14" />
            <span class="computer-use-toggle-text">{{ store.sessionEnabled ? "电脑操控已开启" : "电脑操控" }}</span>
            <v-icon
              v-if="store.toggleWarning"
              class="computer-use-toggle-warn"
              icon="mdi-alert-circle-outline"
              size="13"
            />
          </button>
        </span>
      </template>
    </v-tooltip>
  </div>
</template>

<style scoped>
.computer-use-toggle-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.computer-use-toggle-anchor {
  display: inline-flex;
  min-width: 0;
}

.computer-use-toggle {
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

.computer-use-toggle:hover:not(:disabled) {
  background: var(--pix-bg-hover);
  color: var(--pix-text-primary);
}

.computer-use-toggle.active {
  color: var(--pix-accent);
  background: var(--pix-accent-light);
  border-color: var(--pix-accent-soft);
}

.computer-use-toggle:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.computer-use-toggle-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

.computer-use-toggle-warn {
  color: var(--pix-warning);
}
</style>
