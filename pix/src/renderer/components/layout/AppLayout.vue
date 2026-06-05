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
  gap: 8px;
  padding: 10px 12px 10px 10px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.86), rgba(247, 248, 252, 0.94)),
    var(--pix-bg-app);
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
}
</style>
