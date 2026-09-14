<script setup lang="ts">
/**
 * RoundtableSettingsDialog - 圆桌运行设置（有序、等我、崩溃续跑、阈值与超时）。
 *
 * 不塞进 RosterSetupDialog：组建名册和改运行策略是两件事。l2 打断预算放在折叠的
 * 高级区；未改的字段按 setSettings 的 Partial 语义保留。
 */
import { computed, ref, watch } from "vue";
import { useTeamStore } from "../../stores/team-store";
import type { RoundtableSettings } from "@shared/team-types.js";

const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", open: boolean): void;
}>();

const teamStore = useTeamStore();

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value),
});

const orderedMode = ref(false);
const waitForUserQuestions = ref(false);
const autoContinueAfterCrash = ref(false);
const unattendedGuard = ref(false);
const suggestWrapUp = ref(false);
const cheaperModel = ref("");
const orderedReleaseSec = ref(60);
const exitRequestTimeoutSec = ref(120);

const softBudgetOn = ref(false);
const softBudgetCost = ref<number | null>(null);
const softBudgetMinutes = ref<number | null>(null);

const hardStopOn = ref(false);
const hardStopCost = ref<number | null>(null);
const hardStopMinutes = ref<number | null>(null);
const allowWrapUpOnStop = ref(false);

const l2PerSeat = ref(1);
const l2MinIntervalSec = ref(30);
const l2WindowSec = ref(60);
const l2GlobalMax = ref(8);
const l2Fuse = ref(2);

const showAdvanced = ref(false);
const isSaving = ref(false);
const saveError = ref<string | null>(null);

function hydrate(settings: RoundtableSettings | undefined): void {
  if (settings === undefined) return;
  orderedMode.value = settings.orderedMode;
  waitForUserQuestions.value = settings.waitForUserQuestions;
  autoContinueAfterCrash.value = settings.autoContinueAfterCrash;
  unattendedGuard.value = settings.unattendedGuard;
  suggestWrapUp.value = settings.suggestWrapUp;
  cheaperModel.value = settings.cheaperModel ?? "";
  orderedReleaseSec.value = Math.max(1, Math.round(settings.orderedReleaseMs / 1000));
  exitRequestTimeoutSec.value = Math.max(1, Math.round(settings.exitRequestTimeoutMs / 1000));

  const soft = settings.softBudget;
  const softCost = soft?.maxCostUsd;
  const softDuration = soft?.maxDurationMs;
  softBudgetOn.value = (softCost !== undefined && softCost > 0) || (softDuration !== undefined && softDuration > 0);
  softBudgetCost.value = softCost !== undefined && softCost > 0 ? softCost : null;
  softBudgetMinutes.value = softDuration !== undefined && softDuration > 0 ? Math.round(softDuration / 60_000) : null;

  const hard = settings.hardStop;
  hardStopOn.value = hard?.enabled === true;
  hardStopCost.value = hard?.maxCostUsd !== undefined && hard.maxCostUsd > 0 ? hard.maxCostUsd : null;
  hardStopMinutes.value = hard?.maxDurationMs !== undefined && hard.maxDurationMs > 0
    ? Math.round(hard.maxDurationMs / 60_000)
    : null;
  allowWrapUpOnStop.value = hard?.allowWrapUpOnStop === true;

  l2PerSeat.value = settings.l2.perSeatPerTurn;
  l2MinIntervalSec.value = Math.max(1, Math.round(settings.l2.minIntervalMs / 1000));
  l2WindowSec.value = Math.max(1, Math.round(settings.l2.globalWindowMs / 1000));
  l2GlobalMax.value = settings.l2.globalMaxInWindow;
  l2Fuse.value = settings.l2.consecutiveFuse;
}

watch(
  () => [props.modelValue, teamStore.roundtable?.settings] as const,
  ([isOpen]) => {
    if (isOpen) {
      saveError.value = null;
      hydrate(teamStore.roundtable?.settings);
    }
  },
);

function positiveOrUndefined(value: number | null): number | undefined {
  return value !== null && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function save(): Promise<void> {
  if (isSaving.value) return;
  isSaving.value = true;
  saveError.value = null;
  try {
    const patch: Partial<RoundtableSettings> = {
      orderedMode: orderedMode.value,
      waitForUserQuestions: waitForUserQuestions.value,
      autoContinueAfterCrash: autoContinueAfterCrash.value,
      unattendedGuard: unattendedGuard.value,
      suggestWrapUp: suggestWrapUp.value,
      cheaperModel: cheaperModel.value.trim(),
      orderedReleaseMs: Math.max(1, orderedReleaseSec.value) * 1000,
      exitRequestTimeoutMs: Math.max(1, exitRequestTimeoutSec.value) * 1000,
      softBudget: softBudgetOn.value
        ? {
            maxCostUsd: positiveOrUndefined(softBudgetCost.value),
            maxDurationMs: (() => {
              const minutes = positiveOrUndefined(softBudgetMinutes.value);
              return minutes === undefined ? undefined : minutes * 60_000;
            })(),
          }
        : {},
      hardStop: {
        enabled: hardStopOn.value,
        allowWrapUpOnStop: allowWrapUpOnStop.value,
        maxCostUsd: positiveOrUndefined(hardStopCost.value),
        maxDurationMs: (() => {
          const minutes = positiveOrUndefined(hardStopMinutes.value);
          return minutes === undefined ? undefined : minutes * 60_000;
        })(),
      },
      l2: {
        perSeatPerTurn: Math.max(1, l2PerSeat.value),
        minIntervalMs: Math.max(1, l2MinIntervalSec.value) * 1000,
        globalWindowMs: Math.max(1, l2WindowSec.value) * 1000,
        globalMaxInWindow: Math.max(1, l2GlobalMax.value),
        consecutiveFuse: Math.max(1, l2Fuse.value),
      },
    };
    await teamStore.setSettings(patch);
    if (teamStore.lastError) {
      saveError.value = teamStore.lastError;
      return;
    }
    open.value = false;
  } finally {
    isSaving.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="560" scrollable>
    <v-card class="rs-dialog" data-test="roundtable-settings-dialog">
      <div class="rs-title">
        <v-icon icon="mdi-cog-outline" size="18" />
        圆桌设置
      </div>

      <div class="rs-body">
        <label class="rs-switch">
          <v-switch v-model="orderedMode" density="compact" hide-details color="primary" />
          <span>
            <strong>有序发言</strong>
            <em>同一时刻只放行一个论证，避免互相打断</em>
          </span>
        </label>
        <label class="rs-switch">
          <v-switch v-model="waitForUserQuestions" density="compact" hide-details color="primary" />
          <span>
            <strong>等我回答</strong>
            <em>已 @ 用户且还没收到回复的席位先停发新一轮</em>
          </span>
        </label>
        <label class="rs-switch">
          <v-switch v-model="autoContinueAfterCrash" density="compact" hide-details color="primary" />
          <span>
            <strong>崩溃后续跑</strong>
            <em>重启后自动把上一场从暂停拉起来（默认关）</em>
          </span>
        </label>
        <label class="rs-switch">
          <v-switch v-model="unattendedGuard" density="compact" hide-details color="primary" />
          <span>
            <strong>无人值守保护</strong>
            <em>过软预算后降速，再过则只探索，再翻倍则暂停</em>
          </span>
        </label>
        <label class="rs-switch">
          <v-switch v-model="suggestWrapUp" density="compact" hide-details color="primary" />
          <span>
            <strong>建议整理</strong>
            <em>连续 10 分钟没有新证据时提醒可以出一版</em>
          </span>
        </label>

        <div class="rs-field">
          <label class="rs-label" for="rs-cheaper">预授权降档模型</label>
          <v-text-field
            id="rs-cheaper"
            v-model="cheaperModel"
            density="compact"
            variant="outlined"
            hide-details
            placeholder="provider/id，空=不预授权"
            data-test="settings-cheaper-model"
          />
        </div>

        <div class="rs-row">
          <div class="rs-field">
            <label class="rs-label" for="rs-ordered-ms">有序放行（秒）</label>
            <v-text-field
              id="rs-ordered-ms"
              v-model.number="orderedReleaseSec"
              type="number"
              min="1"
              density="compact"
              variant="outlined"
              hide-details
            />
          </div>
          <div class="rs-field">
            <label class="rs-label" for="rs-exit-ms">退出协商超时（秒）</label>
            <v-text-field
              id="rs-exit-ms"
              v-model.number="exitRequestTimeoutSec"
              type="number"
              min="1"
              density="compact"
              variant="outlined"
              hide-details
            />
          </div>
        </div>

        <div class="rs-group">
          <label class="rs-switch">
            <v-switch v-model="softBudgetOn" density="compact" hide-details color="primary" />
            <span>
              <strong>软预算</strong>
              <em>到达只提示，不拒绝发言</em>
            </span>
          </label>
          <div v-if="softBudgetOn" class="rs-row">
            <v-text-field
              v-model.number="softBudgetCost"
              type="number"
              min="0"
              step="0.01"
              density="compact"
              variant="outlined"
              hide-details
              label="成本上限 USD"
              data-test="settings-soft-cost"
            />
            <v-text-field
              v-model.number="softBudgetMinutes"
              type="number"
              min="0"
              density="compact"
              variant="outlined"
              hide-details
              label="时长上限（分钟）"
            />
          </div>
        </div>

        <div class="rs-group">
          <label class="rs-switch">
            <v-switch v-model="hardStopOn" density="compact" hide-details color="primary" />
            <span>
              <strong>硬停止</strong>
              <em>到达后停止团队模型调用</em>
            </span>
          </label>
          <div v-if="hardStopOn" class="rs-hard">
            <div class="rs-row">
              <v-text-field
                v-model.number="hardStopCost"
                type="number"
                min="0"
                step="0.01"
                density="compact"
                variant="outlined"
                hide-details
                label="成本上限 USD"
              />
              <v-text-field
                v-model.number="hardStopMinutes"
                type="number"
                min="0"
                density="compact"
                variant="outlined"
                hide-details
                label="时长上限（分钟）"
              />
            </div>
            <label class="rs-switch">
              <v-switch v-model="allowWrapUpOnStop" density="compact" hide-details color="primary" />
              <span>
                <strong>停止后允许整理一次</strong>
              </span>
            </label>
          </div>
        </div>

        <button type="button" class="rs-link" data-test="settings-advanced" @click="showAdvanced = !showAdvanced">
          {{ showAdvanced ? "收起高级：L2 打断预算" : "高级：L2 打断预算" }}
        </button>
        <div v-if="showAdvanced" class="rs-group">
          <div class="rs-row">
            <v-text-field v-model.number="l2PerSeat" type="number" min="1" density="compact" variant="outlined" hide-details label="每席每轮" />
            <v-text-field v-model.number="l2MinIntervalSec" type="number" min="1" density="compact" variant="outlined" hide-details label="最小间隔（秒）" />
          </div>
          <div class="rs-row rs-row-3">
            <v-text-field v-model.number="l2WindowSec" type="number" min="1" density="compact" variant="outlined" hide-details label="窗口（秒）" />
            <v-text-field v-model.number="l2GlobalMax" type="number" min="1" density="compact" variant="outlined" hide-details label="窗口内上限" />
            <v-text-field v-model.number="l2Fuse" type="number" min="1" density="compact" variant="outlined" hide-details label="连续熔断" />
          </div>
        </div>

        <div v-if="saveError" class="rs-error">{{ saveError }}</div>
      </div>

      <v-card-actions class="rs-actions">
        <v-spacer />
        <v-btn variant="text" @click="open = false">取消</v-btn>
        <v-btn color="primary" variant="flat" :loading="isSaving" data-test="settings-save" @click="save">保存</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.rs-dialog {
  display: flex;
  flex-direction: column;
  max-height: 86vh;
  padding: var(--pix-space-lg);
  border-radius: var(--pix-radius-xl) !important;
}

.rs-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: var(--pix-space-sm);
  color: var(--pix-text-primary);
  font-size: var(--pix-text-md);
  font-weight: var(--pix-weight-semibold);
}

.rs-body {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-sm);
  overflow-y: auto;
  padding-right: 2px;
}

.rs-switch {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
}

.rs-switch span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 4px;
}

.rs-switch strong {
  color: var(--pix-text-primary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
}

.rs-switch em {
  color: var(--pix-text-muted);
  font-size: 9px;
  font-style: normal;
  line-height: 1.4;
}

.rs-field,
.rs-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rs-label {
  color: var(--pix-text-muted);
  font-size: 10px;
  font-weight: var(--pix-weight-medium);
}

.rs-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--pix-space-xs);
}

.rs-hard {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rs-body :deep(.v-field) {
  font-size: var(--pix-text-xs);
}

.rs-row-3 {
  grid-template-columns: 1fr 1fr 1fr;
}

.rs-link {
  align-self: flex-start;
  border: none;
  background: transparent;
  color: var(--pix-accent);
  font-size: 10px;
  cursor: pointer;
  padding: 2px 0;
}

.rs-error {
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-error-bg);
  color: var(--pix-error);
  font-size: 11px;
}

.rs-actions {
  padding: var(--pix-space-sm) 0 0 !important;
}
</style>
