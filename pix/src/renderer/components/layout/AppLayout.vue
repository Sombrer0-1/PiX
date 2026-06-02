<script setup lang="ts">
/**
 * AppLayout - Four-panel layout shell
 *
 * ┌──────────────────────────────────────────┐
 * │ TopBar                                   │
 * ├──────────┬───────────────────┬───────────┤
 * │ Left     │ Center            │ Right     │
 * ├──────────┴───────────────────┴───────────┤
 * │ BottomBar                                │
 * └──────────────────────────────────────────┘
 */
import TopBar from "./TopBar.vue";
</script>

<template>
  <div class="app-layout">
    <header class="layout-topbar">
      <slot name="topbar">
        <TopBar />
      </slot>
    </header>

    <div class="layout-main">
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

    <footer class="layout-bottom">
      <slot name="bottom" />
    </footer>
  </div>
</template>

<style scoped>
.app-layout {
  display: grid;
  grid-template-areas:
    "topbar topbar topbar"
    "left center right"
    "bottom bottom bottom";
  grid-template-columns: var(--pix-left-width) 1fr var(--pix-right-width);
  grid-template-rows: var(--pix-topbar-height) 1fr auto;
  height: 100%;
  overflow: hidden;
}

.layout-topbar {
  grid-area: topbar;
  background: var(--pix-bg-topbar);
  border-bottom: 1px solid var(--pix-border);
  display: flex;
  align-items: center;
  padding: 0 var(--pix-space-lg);
  -webkit-app-region: drag;
  user-select: none;
}

.topbar-content {
  display: flex;
  align-items: center;
}

.topbar-title {
  font-size: var(--pix-text-sm);
  font-weight: 600;
  color: var(--pix-text-secondary);
}

.layout-main {
  grid-area: left / left / center / right;
  display: contents;
}

.layout-left {
  grid-area: left;
  background: var(--pix-bg-left);
  border-right: 1px solid var(--pix-border);
  overflow-y: auto;
  overflow-x: hidden;
}

.layout-center {
  grid-area: center;
  background: var(--pix-bg-content);
  overflow-y: auto;
  overflow-x: hidden;
}

.layout-right {
  grid-area: right;
  background: var(--pix-bg-right);
  border-left: 1px solid var(--pix-border);
  overflow-y: auto;
  overflow-x: hidden;
}

.layout-bottom {
  grid-area: bottom;
  background: var(--pix-bg-bottom);
  border-top: 1px solid var(--pix-border);
}
</style>
