<script setup lang="ts">
withDefaults(defineProps<{ reserveWindowControls?: boolean }>(), { reserveWindowControls: true });
</script>

<template>
  <header class="window-titlebar">
    <div class="titlebar-content"><slot /></div>
    <div v-if="reserveWindowControls" class="titlebar-controls-space" aria-hidden="true" />
  </header>
</template>

<style scoped>
.window-titlebar {
  display: flex;
  flex-shrink: 0;
  min-width: 0;
  height: var(--pix-topbar-height);
  background: var(--pix-bg-topbar);
  border-bottom: 1px solid var(--pix-border-light);
  -webkit-app-region: no-drag;
}
.titlebar-content {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  gap: inherit;
  padding: 0 var(--pix-titlebar-padding, 18px);
  -webkit-app-region: drag;
}
.titlebar-content :deep(button) {
  -webkit-app-region: no-drag;
}
/* This gutter is outside the drag rectangle and always matches the native controls. */
.titlebar-controls-space {
  flex: 0 0 var(--pix-window-controls-width);
  -webkit-app-region: no-drag;
}
</style>
