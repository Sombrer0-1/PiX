<script setup lang="ts">
defineProps<{ title: string; description?: string; controlId?: string; wide?: boolean }>();
</script>

<template>
  <div class="setting-row">
    <div class="setting-copy">
      <label v-if="controlId" :for="controlId" class="setting-title">{{ title }}</label>
      <span v-else class="setting-title">{{ title }}</span>
      <p v-if="description" class="setting-description">{{ description }}</p>
    </div>
    <div class="setting-control" :class="{ wide }"><slot /></div>
  </div>
</template>

<style scoped>
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 32px;
  min-height: 70px;
  padding: 13px 0;
}
.setting-row + .setting-row {
  border-top: 1px solid #e9ebf0;
}
.setting-copy {
  flex: 1;
  min-width: 0;
}
.setting-title {
  display: block;
  font-size: 14px;
  font-weight: 550;
  color: var(--pix-text-primary);
}
.setting-description {
  margin-top: 4px;
  color: #747b87;
  font-size: 12.5px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.setting-control {
  display: flex;
  justify-content: flex-end;
  width: 250px;
  max-width: 50%;
  flex-shrink: 0;
}
.setting-control.wide {
  width: 320px;
}
.setting-control :deep(.v-input) {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 13px;
}
.setting-control :deep(.v-field) {
  font-size: 13px;
  --v-input-control-height: 34px;
  --v-field-padding-top: 0px;
  --v-field-padding-bottom: 0px;
  border-radius: 7px;
}
.setting-control :deep(.v-field__input) {
  min-height: 34px;
  padding-top: 5px;
  padding-bottom: 5px;
}
.setting-control :deep(.v-label) {
  font-size: 13px;
}
.setting-control :deep(.v-switch .v-selection-control) {
  justify-content: flex-end;
  min-height: 34px;
}
.setting-control :deep(.v-switch .v-label) {
  display: none;
}
.setting-control :deep(.v-switch__track) {
  width: 36px;
  height: 21px;
  opacity: 1;
  background: #dce0e8;
}
.setting-control :deep(.v-selection-control--dirty .v-switch__track) {
  background: var(--pix-accent);
}
.setting-control :deep(.v-switch__thumb) {
  width: 17px;
  height: 17px;
  background: white !important;
  color: white !important;
  transform: none;
}
.setting-control :deep(.v-switch .v-selection-control__input) {
  transform: translateX(-7.5px);
}
.setting-control :deep(.v-switch .v-selection-control--dirty .v-selection-control__input) {
  transform: translateX(7.5px);
}
.setting-control :deep(.v-input__details) {
  padding: 4px 0 0;
  min-height: 0;
}
@media (max-width: 760px) {
  .setting-row {
    gap: 12px;
    flex-wrap: wrap;
  }
  .setting-copy {
    flex-basis: 55%;
  }
  .setting-control {
    margin-left: auto;
    max-width: 100%;
    width: 200px;
  }
  .setting-control.wide {
    flex-basis: 100%;
    width: 100%;
  }
  .setting-row:has(.v-switch) {
    flex-wrap: nowrap;
  }
  .setting-row:has(.v-switch) .setting-control {
    width: 44px;
  }
  .setting-row:has(.v-switch) .setting-copy {
    flex-basis: auto;
  }
}
</style>
