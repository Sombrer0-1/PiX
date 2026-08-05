<script setup lang="ts">
/**
 * AppLayout - Three-panel workspace shell
 *
 * ┌────────┬────────────────────────┬────────┐
 * │ Left   │ Center                 │ Right  │
 * │        │ (topbar+content+       │        │
 * │        │  composer internal)    │        │
 * └────────┴────────────────────────┴────────┘
 *
 * Left and Right are full-height. Center manages its own
 * internal header / content / composer structure.
 */
defineProps<{
  teamMode?: boolean;
}>();
</script>

<template>
  <div class="app-layout" :class="{ 'app-layout--team': teamMode }">
    <div class="layout-titlebar-drag" aria-hidden="true"></div>
    <aside class="layout-left">
      <slot name="left" />
    </aside>

    <main class="layout-center">
      <slot name="center" />
    </main>

    <aside class="layout-right">
      <slot name="right" />
    </aside>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  height: 100%;
  overflow: hidden;
  gap: 8px;
  padding: calc(10px + var(--pix-window-controls-height)) 12px 10px 10px;
  position: relative;
  -webkit-app-region: no-drag;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.86), rgba(247, 248, 252, 0.94)),
    var(--pix-bg-app);
}

.layout-titlebar-drag {
  position: absolute;
  top: 0;
  right: var(--pix-window-controls-width);
  left: 0;
  height: calc(var(--pix-window-controls-height) + 10px);
  -webkit-app-region: drag;
}

.layout-left {
  width: var(--pix-left-width);
  min-width: var(--pix-left-width);
  background: var(--pix-bg-left);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: var(--pix-shadow-sm);
  -webkit-app-region: no-drag;
}

.layout-center {
  flex: 1;
  min-width: 0;
  background: var(--pix-bg-content);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--pix-shadow-sm);
  position: relative;
  z-index: 1;
  -webkit-app-region: no-drag;
}

.layout-right {
  width: var(--pix-right-width);
  min-width: var(--pix-right-width);
  background: var(--pix-bg-right);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-xl);
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: var(--pix-shadow-sm);
  -webkit-app-region: no-drag;
}

.app-layout--team .layout-left {
  width: 264px;
  min-width: 264px;
}

@media (max-width: 1180px) {
  .app-layout {
    padding: calc(8px + var(--pix-window-controls-height)) 8px 8px;
    gap: 6px;
  }

  .layout-titlebar-drag {
    height: calc(var(--pix-window-controls-height) + 8px);
  }

  .app-layout--team .layout-left {
    width: 232px;
    min-width: 232px;
  }
}
</style>
