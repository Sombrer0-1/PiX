<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

defineProps<{ teamMode?: boolean }>();
const width = ref(window.innerWidth);
const leftOpen = ref(width.value > 760);
const rightOpen = ref(width.value > 1100);
const leftPanel = ref<HTMLElement | null>(null);
const rightPanel = ref<HTMLElement | null>(null);
const drawer = computed(() =>
  leftOpen.value && width.value <= 760 ? "left" : rightOpen.value && width.value <= 1100 ? "right" : null,
);
let returnFocus: HTMLElement | null = null;

function resize(): void {
  const next = window.innerWidth;
  if (next > 760 !== width.value > 760) leftOpen.value = next > 760;
  if (next > 1100 !== width.value > 1100) rightOpen.value = next > 1100;
  width.value = next;
}
function toggleLeft(): void {
  if (!leftOpen.value && width.value <= 760) rightOpen.value = false;
  leftOpen.value = !leftOpen.value;
}
function toggleRight(): void {
  if (!rightOpen.value && width.value <= 760) leftOpen.value = false;
  rightOpen.value = !rightOpen.value;
}
function closeDrawer(): void {
  if (drawer.value === "left") leftOpen.value = false;
  if (drawer.value === "right") rightOpen.value = false;
}
function handleKey(event: KeyboardEvent): void {
  if (!drawer.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeDrawer();
  } else if (event.key === "Tab") {
    const panel = drawer.value === "left" ? leftPanel.value : rightPanel.value;
    const controls = Array.from(
      panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [],
    ).filter((element) => element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
}
watch(drawer, async (current, previous) => {
  if (current && !previous) returnFocus = document.activeElement as HTMLElement;
  await nextTick();
  if (current) {
    (current === "left" ? leftPanel.value : rightPanel.value)
      ?.querySelector<HTMLElement>(".drawer-close")
      ?.focus();
  } else if (previous) returnFocus?.focus();
});
onMounted(() => {
  window.addEventListener("resize", resize);
  window.addEventListener("keydown", handleKey);
});
onUnmounted(() => {
  window.removeEventListener("resize", resize);
  window.removeEventListener("keydown", handleKey);
});
</script>

<template>
  <div class="app-layout" :class="{ 'app-layout--team': teamMode }">
    <aside
      ref="leftPanel"
      class="layout-left"
      :class="{ open: leftOpen }"
      :inert="!leftOpen || drawer === 'right'"
      aria-label="项目与会话"
    >
      <slot name="left" />
      <button v-if="width <= 760 && leftOpen" class="drawer-close" aria-label="关闭会话列表" @click="closeDrawer">
        关闭
      </button>
    </aside>
    <main class="layout-center" :inert="drawer !== null">
      <slot
        name="center"
        :toggle-left="toggleLeft"
        :toggle-right="toggleRight"
        :left-open="leftOpen"
        :right-open="rightOpen"
        :reserve-window-controls="!rightOpen || width <= 1100"
      />
    </main>
    <button v-if="drawer" class="drawer-backdrop" aria-label="关闭侧栏" tabindex="-1" @click="closeDrawer" />
    <aside
      ref="rightPanel"
      class="layout-right"
      :class="{ open: rightOpen }"
      :inert="!rightOpen || drawer === 'left'"
      aria-label="上下文"
    >
      <slot name="right" />
      <button v-if="width <= 1100 && rightOpen" class="drawer-close" aria-label="关闭上下文面板" @click="closeDrawer">
        关闭
      </button>
    </aside>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  height: 100%;
  overflow: hidden;
  position: relative;
  background: var(--pix-bg-content);
}
.layout-left,
.layout-right {
  display: none;
  flex-direction: column;
  min-height: 0;
  flex-shrink: 0;
  overflow: hidden;
}
.layout-left.open,
.layout-right.open {
  display: flex;
}
.layout-left {
  width: var(--pix-left-width);
  background: var(--pix-bg-left);
  border-right: 1px solid var(--pix-border-light);
}
.layout-right {
  width: var(--pix-right-width);
  background: var(--pix-bg-right);
  border-left: 1px solid var(--pix-border-light);
}
.layout-center {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.drawer-backdrop {
  position: absolute;
  inset: 0;
  background: #20273740;
  z-index: 20;
}
.drawer-close {
  position: absolute;
  right: 14px;
  top: 12px;
  min-height: 30px;
  padding: 0 8px;
  border-radius: 6px;
  z-index: 1;
  font-size: 13px;
  -webkit-app-region: no-drag;
}
.drawer-close:hover {
  background: var(--pix-accent-light);
}
.layout-right .drawer-close {
  right: calc(var(--pix-window-controls-width) + 14px);
}
.layout-left .drawer-close {
  right: max(14px, calc(var(--pix-window-controls-width) - (100vw - var(--pix-left-width)) + 14px));
}
@media (max-width: 1100px) {
  .layout-right {
    position: absolute;
    inset: 0 0 0 auto;
    width: min(var(--pix-right-width), 100%);
    z-index: 21;
    box-shadow: var(--pix-shadow-lg);
  }
}
@media (max-width: 760px) {
  .layout-left {
    position: absolute;
    inset: 0 auto 0 0;
    width: min(var(--pix-left-width), 100%);
    z-index: 21;
    box-shadow: var(--pix-shadow-lg);
  }
}
</style>
