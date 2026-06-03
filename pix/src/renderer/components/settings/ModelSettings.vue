<script setup lang="ts">
/**
 * ModelSettings - Model and thinking level defaults
 */
</script>

<template>
  <div class="model-settings">
    <p class="settings-note">模型设置通过 PiX 设置页面进行配置。您也可以在会话过程中使用底部栏的模型选择器切换模型。</p>
  </div>
</template>

<style scoped>
.model-settings {
  padding: var(--pix-space-md) 0;
}

.settings-note {
  font-size: var(--pix-text-sm);
  color: var(--pix-text-secondary);
  line-height: var(--pix-leading-base);
}
</style>
