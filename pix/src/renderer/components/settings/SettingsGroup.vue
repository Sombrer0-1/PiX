<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <section class="settings-group" :aria-label="title">
    <h2>{{ title }}</h2>
    <div class="settings-card"><slot /></div>
  </section>
</template>

<style scoped>
.settings-group {
  margin-bottom: 25px;
}
h2 {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 10px;
}
.settings-card {
  background: white;
  border: 1px solid #dfe3eb;
  border-radius: 11px;
  padding: 0 18px;
}
@media (max-width: 760px) {
  .settings-card {
    padding: 0 14px;
  }
}
</style>
