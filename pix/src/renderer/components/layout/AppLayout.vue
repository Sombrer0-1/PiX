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
</script>

<template>
  <div class="app-layout">
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
}

.layout-left {
  width: var(--pix-left-width);
  min-width: var(--pix-left-width);
  background: var(--pix-bg-left);
  border-right: 1px solid var(--pix-border-light);
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
}

.layout-center {
  flex: 1;
  min-width: 0;
  background: var(--pix-bg-content);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* Subtle inner shadow for depth separation from side panels */
  box-shadow: 1px 0 0 rgba(0, 0, 0, 0.02), -1px 0 0 rgba(0, 0, 0, 0.02);
  position: relative;
  z-index: 1;
}

.layout-right {
  width: var(--pix-right-width);
  min-width: var(--pix-right-width);
  background: var(--pix-bg-right);
  border-left: 1px solid var(--pix-border-light);
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
}
</style>
