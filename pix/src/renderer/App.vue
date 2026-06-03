<script setup lang="ts">
/**
 * Root App Component
 */
import { onMounted, ref, onUnmounted } from "vue";
import { useSettingsStore } from "./stores/settings-store";
import { useTheme } from "./composables/useTheme";

const settingsStore = useSettingsStore();
const { initTheme } = useTheme();

// Window controls
const isWindowMaximized = ref(false);
const hoverClose = ref(false);
const hoverMin = ref(false);
const hoverMax = ref(false);
let unsubMaximizeChange: (() => void) | null = null;

onMounted(async () => {
  await settingsStore.load();
  initTheme();

  try {
    isWindowMaximized.value = await window.pixApi.windowIsMaximized();
  } catch { /* ignore */ }
  unsubMaximizeChange = window.pixApi.onWindowMaximizeChange((maximized: boolean) => {
    isWindowMaximized.value = maximized;
  });
});

onUnmounted(() => {
  if (unsubMaximizeChange) {
    unsubMaximizeChange();
    unsubMaximizeChange = null;
  }
});

async function windowMinimize(): Promise<void> {
  await window.pixApi.windowMinimize();
}

async function windowMaximize(): Promise<void> {
  await window.pixApi.windowMaximize();
}

async function windowClose(): Promise<void> {
  await window.pixApi.windowClose();
}
</script>

<template>
  <v-app>
    <!-- Global window controls — macOS-style colored dots -->
    <div class="window-controls">
      <button
        class="win-dot win-dot-min"
        @click="windowMinimize"
        @mouseenter="hoverMin = true"
        @mouseleave="hoverMin = false"
        title="最小化"
      >
        <svg v-if="hoverMin" width="8" height="8" viewBox="0 0 8 8">
          <line x1="1.5" y1="4" x2="6.5" y2="4" stroke="#5a3e00" stroke-width="1.2"/>
        </svg>
      </button>
      <button
        class="win-dot win-dot-max"
        @click="windowMaximize"
        @mouseenter="hoverMax = true"
        @mouseleave="hoverMax = false"
        :title="isWindowMaximized ? '还原' : '最大化'"
      >
        <svg v-if="hoverMax" width="8" height="8" viewBox="0 0 8 8">
          <path d="M1.5,2 L6.5,2 L6.5,7 L1.5,7 Z" fill="none" stroke="#003a00" stroke-width="1.2"/>
          <line v-if="isWindowMaximized" x1="3.5" y1="0.5" x2="7.5" y2="0.5" stroke="#003a00" stroke-width="1"/>
        </svg>
      </button>
      <button
        class="win-dot win-dot-close"
        @click="windowClose"
        @mouseenter="hoverClose = true"
        @mouseleave="hoverClose = false"
        title="关闭"
      >
        <svg v-if="hoverClose" width="8" height="8" viewBox="0 0 8 8">
          <line x1="1.5" y1="1.5" x2="6.5" y2="6.5" stroke="#4a0000" stroke-width="1.2"/>
          <line x1="6.5" y1="1.5" x2="1.5" y2="6.5" stroke="#4a0000" stroke-width="1.2"/>
        </svg>
      </button>
    </div>
    <router-view />
  </v-app>
</template>

<style>
/* Global app styles are in assets/styles/main.css */

/* Window controls — fixed at top-right, macOS dot style */
.window-controls {
  position: fixed;
  top: 10px;
  right: 10px;
  z-index: 9999;
  display: flex;
  gap: 8px;
  -webkit-app-region: no-drag;
}

.win-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: filter 100ms ease;
}

.win-dot:hover {
  filter: brightness(0.9);
}

.win-dot-close {
  background: #ff5f57;
}

.win-dot-min {
  background: #febc2e;
}

.win-dot-max {
  background: #28c840;
}
</style>
