<script setup lang="ts">
/**
 * Root App Component
 */
import { onMounted } from "vue";
import { useSettingsStore } from "./stores/settings-store";
import { useTheme } from "./composables/useTheme";

const settingsStore = useSettingsStore();
const { initTheme } = useTheme();

onMounted(async () => {
  await settingsStore.load();
  initTheme();
});
</script>

<template>
  <router-view />
</template>

<style>
/* Global app styles are in assets/styles/main.css */
</style>
