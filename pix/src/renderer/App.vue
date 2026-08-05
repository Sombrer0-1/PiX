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
    <div class="window-controls" role="group" aria-label="窗口控制">
      <button
        class="window-control"
        type="button"
        @click="windowMinimize"
        title="最小化"
        aria-label="最小化"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 8.5h8" />
        </svg>
      </button>
      <button
        class="window-control"
        type="button"
        @click="windowMaximize"
        :title="isWindowMaximized ? '还原' : '最大化'"
        :aria-label="isWindowMaximized ? '还原' : '最大化'"
      >
        <svg v-if="!isWindowMaximized" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <rect x="2.5" y="2.5" width="7" height="7" />
        </svg>
        <svg v-else width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M4 3h5v5M3 4h5v5H3z" />
        </svg>
      </button>
      <button
        class="window-control window-control--close"
        type="button"
        @click="windowClose"
        title="关闭"
        aria-label="关闭"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m2.5 2.5 7 7m0-7-7 7" />
        </svg>
      </button>
    </div>
    <router-view />
  </v-app>
</template>

<style>
/* Global app styles are in assets/styles/main.css */

/* Full-size hit targets keep frameless window controls reliable. */
.window-controls {
  position: fixed;
  top: 0;
  right: 0;
  z-index: 10000;
  display: flex;
  width: var(--pix-window-controls-width);
  height: var(--pix-window-controls-height);
  -webkit-app-region: no-drag;
  pointer-events: auto;
  user-select: none;
  background: var(--pix-bg-topbar);
  border-bottom: 1px solid var(--pix-border-light);
}

.window-control {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 46px;
  width: 46px;
  height: var(--pix-window-controls-height);
  min-width: 46px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: #475569;
  cursor: default;
  -webkit-app-region: no-drag;
  transition: background 100ms ease, color 100ms ease;
}

.window-control svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.15;
  stroke-linecap: square;
  stroke-linejoin: miter;
}

.window-control:hover {
  background: rgba(15, 23, 42, 0.06);
  color: #0f172a;
}

.window-control:active {
  background: rgba(15, 23, 42, 0.11);
}

.window-control--close:hover {
  background: #c42b1c;
  color: #ffffff;
}

.window-control--close:active {
  background: #a82318;
}

.window-control:focus-visible {
  position: relative;
  z-index: 1;
  outline: 2px solid var(--pix-accent);
  outline-offset: -2px;
}
</style>
