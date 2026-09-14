<script setup lang="ts">
/**
 * RosterSetupDialog - 组建圆桌：档位 3/5/8/12 + 自定义视角 + 预设。
 *
 * The default roster is the five perspective templates with `name = 中文 label`
 * and `perspective = 模板 prompt`; the main process derives each template seat's
 * slug from the template id (附录 A), so a Chinese display name never goes near
 * `sanitizeAgentName`. Names stay editable afterwards — the slug does not
 * follow the display name.
 *
 * mode="add" reuses the same editor to add one seat to a running roundtable
 * (FR-1: 讨论中可增减席位).
 */
import { computed, ref, watch } from "vue";
import { useTeamStore } from "../../stores/team-store";
import {
  MAX_SEATS,
  MIN_SEATS,
  PERSPECTIVE_TEMPLATES,
  type RoundtableTier,
  type SeatConfig,
  type ToolAuthTier,
} from "@shared/team-types.js";

const props = withDefaults(defineProps<{
  modelValue: boolean;
  mode?: "create" | "add";
}>(), {
  mode: "create",
});

const emit = defineEmits<{
  (e: "update:modelValue", open: boolean): void;
  (e: "created"): void;
}>();

const teamStore = useTeamStore();

type TierChoice = RoundtableTier | "custom";

const tierOptions: Array<{ title: string; value: TierChoice; seats: number }> = [
  { title: "精简 3", value: "compact", seats: 3 },
  { title: "标准 5", value: "standard", seats: 5 },
  { title: "深度 8", value: "deep", seats: 8 },
  { title: "攻坚 12", value: "blitz", seats: 12 },
  { title: "自定义", value: "custom", seats: 0 },
];

const topic = ref("");
const name = ref("");
const tierChoice = ref<TierChoice>("standard");
const seatDrafts = ref<SeatConfig[]>([]);
const presets = ref<Array<{ name: string; seats: SeatConfig[] }>>([]);
const presetName = ref("");
const error = ref<string | null>(null);
const isSubmitting = ref(false);

const isAddMode = computed(() => props.mode === "add");
const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value),
});

const authItems: Array<{ title: string; value: ToolAuthTier }> = [
  { title: "只读", value: "read_only" },
  { title: "可写", value: "write" },
  { title: "受限", value: "restricted" },
];

/** 档位默认席位：前 5 个模板视角（name = 中文 label），其后是「视角 N」占位。 */
function defaultSeatsFor(count: number): SeatConfig[] {
  const seats: SeatConfig[] = [];
  for (let index = 0; index < count; index++) {
    const template = PERSPECTIVE_TEMPLATES[index];
    if (template !== undefined) {
      seats.push({ name: template.label, perspective: template.prompt, auth: "read_only" });
      continue;
    }
    const placeholder = index - PERSPECTIVE_TEMPLATES.length + 1;
    seats.push({
      name: `视角 ${placeholder}`,
      perspective: `自定义视角占位席 ${placeholder}：按议题需要自行确定关注点，并与已有视角错开。`,
      auth: "read_only",
    });
  }
  return seats;
}

/** The five default seats (附录 A) — used when nothing has been edited yet. */
const DEFAULT_SEAT_COUNT = PERSPECTIVE_TEMPLATES.length;

function applyTier(choice: TierChoice): void {
  const option = tierOptions.find((candidate) => candidate.value === choice);
  if (option === undefined || option.seats === 0) return;
  seatDrafts.value = defaultSeatsFor(option.seats);
}

// Open → seed the editor (create: tier defaults; add: one blank seat).
watch(
  () => props.modelValue,
  (isOpen) => {
    if (!isOpen) return;
    error.value = null;
    if (isAddMode.value) {
      seatDrafts.value = [{ name: "", perspective: "", auth: "read_only" }];
      void loadPresets();
      return;
    }
    topic.value = "";
    name.value = "";
    tierChoice.value = "standard";
    seatDrafts.value = defaultSeatsFor(DEFAULT_SEAT_COUNT);
    void loadPresets();
  },
  { immediate: true },
);

async function loadPresets(): Promise<void> {
  presets.value = await teamStore.listPresets();
}

function addSeatDraft(): void {
  if (seatDrafts.value.length >= MAX_SEATS) return;
  seatDrafts.value = [...seatDrafts.value, { name: "", perspective: "", auth: "read_only" }];
}

function removeSeatDraft(index: number): void {
  if (seatDrafts.value.length <= MIN_SEATS) return;
  seatDrafts.value = seatDrafts.value.filter((_, candidate) => candidate !== index);
}

function onTierChange(choice: TierChoice): void {
  tierChoice.value = choice;
  applyTier(choice);
}

function loadPreset(preset: { name: string; seats: SeatConfig[] }): void {
  seatDrafts.value = preset.seats.map((seat) => ({ ...seat }));
  presetName.value = preset.name;
  error.value = null;
}

async function savePreset(): Promise<void> {
  const presetLabel = presetName.value.trim();
  if (presetLabel.length === 0) {
    error.value = "预设需要一个名字。";
    return;
  }
  await teamStore.savePreset(presetLabel, seatDrafts.value.map((seat) => ({ ...seat })));
  await loadPresets();
}

async function deletePreset(preset: { name: string }): Promise<void> {
  await teamStore.deletePreset(preset.name);
  await loadPresets();
}

/** Trimmed configs; a blank name/perspective is rejected before it reaches main. */
function normalizedSeats(): SeatConfig[] | null {
  const seats: SeatConfig[] = [];
  for (const draft of seatDrafts.value) {
    const seatName = draft.name.trim();
    const perspective = draft.perspective.trim();
    if (seatName.length === 0) {
      error.value = "每个席位都需要展示名。";
      return null;
    }
    seats.push({ ...draft, name: seatName, perspective });
  }
  const names = new Set(seats.map((seat) => seat.name));
  if (names.size !== seats.length) {
    error.value = "活跃席位的展示名必须唯一。";
    return null;
  }
  return seats;
}

async function submit(): Promise<void> {
  if (isSubmitting.value) return;
  error.value = null;

  if (isAddMode.value) {
    const seats = normalizedSeats();
    if (seats === null || seats.length === 0) return;
    isSubmitting.value = true;
    try {
      const seat = await teamStore.addSeat(seats[0]);
      if (seat === null) {
        error.value = teamStore.lastError ?? "加入席位失败";
        return;
      }
      open.value = false;
      emit("created");
    } finally {
      isSubmitting.value = false;
    }
    return;
  }

  const trimmedTopic = topic.value.trim();
  if (trimmedTopic.length === 0) {
    error.value = "先写下议题。";
    return;
  }
  const seats = normalizedSeats();
  if (seats === null) return;
  if (seats.length < MIN_SEATS || seats.length > MAX_SEATS) {
    error.value = `圆桌席位数量必须在 ${MIN_SEATS}–${MAX_SEATS} 之间。`;
    return;
  }

  isSubmitting.value = true;
  try {
    const state = await teamStore.createRoundtable({
      topic: trimmedTopic,
      name: name.value.trim() || undefined,
      tier: tierChoice.value === "custom" ? undefined : tierChoice.value,
      seats,
    });
    if (state === null) {
      error.value = teamStore.lastError ?? "组建圆桌失败";
      return;
    }
    open.value = false;
    emit("created");
  } finally {
    isSubmitting.value = false;
  }
}

function displaySeatIndex(index: number): number {
  return index + 1;
}
</script>

<template>
  <v-dialog v-model="open" max-width="760" scrollable>
    <v-card class="roster-dialog" data-test="roster-setup-dialog">
      <div class="rd-title">
        <v-icon icon="mdi-account-group-outline" size="18" />
        {{ isAddMode ? "加入席位" : "组建圆桌" }}
      </div>

      <div class="rd-body">
        <template v-if="!isAddMode">
          <div class="rd-field">
            <label class="rd-label" for="rd-topic">议题</label>
            <v-text-field id="rd-topic" v-model="topic" density="compact" variant="outlined" hide-details placeholder="这次要讨论什么？" data-test="roster-topic" />
          </div>
          <div class="rd-field">
            <label class="rd-label" for="rd-name">圆桌名（可空，默认取议题）</label>
            <v-text-field id="rd-name" v-model="name" density="compact" variant="outlined" hide-details data-test="roster-name" />
          </div>

          <div class="rd-field">
            <span class="rd-label">档位</span>
            <v-btn-toggle
              :model-value="tierChoice"
              mandatory
              divided
              density="compact"
              variant="outlined"
              color="primary"
              @update:model-value="onTierChange"
            >
              <v-btn
                v-for="option in tierOptions"
                :key="option.value"
                :value="option.value"
                size="small"
                :data-test="`roster-tier-${option.value}`"
              >
                {{ option.title }}
              </v-btn>
            </v-btn-toggle>
            <span class="rd-help">
              默认 {{ DEFAULT_SEAT_COUNT }} 席用五个模板视角（slug = 模板 id，展示名 = 中文名）。席位上限 {{ MAX_SEATS }}，用户不占名额。
            </span>
          </div>
        </template>

        <div class="rd-seats">
          <div class="rd-seats-head">
            <span class="rd-label">{{ isAddMode ? "新席位" : `席位（${seatDrafts.length}）` }}</span>
            <button v-if="!isAddMode" type="button" class="rd-link" :disabled="seatDrafts.length >= MAX_SEATS" @click="addSeatDraft">
              + 加一席
            </button>
          </div>

          <div
            v-for="(draft, index) in seatDrafts"
            :key="index"
            class="rd-seat"
            :data-test="`roster-seat-${displaySeatIndex(index)}`"
          >
            <div class="rd-seat-row">
              <v-text-field
                v-model="draft.name"
                density="compact"
                variant="outlined"
                hide-details
                label="展示名"
                class="rd-seat-name"
              />
              <v-select
                v-model="draft.auth"
                :items="authItems"
                item-title="title"
                item-value="value"
                density="compact"
                variant="outlined"
                hide-details
                label="授权"
                class="rd-seat-auth"
              />
              <v-text-field
                v-model="draft.model"
                density="compact"
                variant="outlined"
                hide-details
                label="模型（可空）"
                class="rd-seat-model"
              />
              <v-btn
                v-if="!isAddMode"
                icon="mdi-close"
                size="x-small"
                variant="text"
                :disabled="seatDrafts.length <= MIN_SEATS"
                aria-label="移除该席位"
                @click="removeSeatDraft(index)"
              />
            </div>
            <v-textarea
              v-model="draft.perspective"
              rows="1"
              auto-grow
              density="compact"
              variant="outlined"
              hide-details
              label="视角"
              class="rd-seat-perspective"
            />
          </div>
        </div>

        <div class="rd-presets">
          <span class="rd-label">预设</span>
          <div v-if="presets.length === 0" class="rd-help">还没有保存的预设。</div>
          <div
            v-for="preset in presets"
            :key="preset.name"
            class="rd-preset"
          >
            <span class="rd-preset-name">{{ preset.name }}</span>
            <span class="rd-preset-count">{{ preset.seats.length }} 席</span>
            <button type="button" class="rd-link" @click="loadPreset(preset)">载入</button>
            <button type="button" class="rd-link rd-link--danger" @click="deletePreset(preset)">删除</button>
          </div>
          <div class="rd-preset-save">
            <v-text-field
              v-model="presetName"
              density="compact"
              variant="outlined"
              hide-details
              placeholder="预设名"
              class="rd-preset-input"
            />
            <v-btn size="small" variant="text" @click="savePreset">保存当前席位为预设</v-btn>
          </div>
        </div>

        <div v-if="error" class="rd-error" data-test="roster-error">{{ error }}</div>
      </div>

      <v-card-actions class="rd-actions">
        <v-spacer />
        <v-btn variant="text" :disabled="isSubmitting" @click="open = false">取消</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :loading="isSubmitting"
          data-test="roster-submit"
          @click="submit"
        >
          {{ isAddMode ? "加入席位" : "开始讨论" }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.roster-dialog {
  display: flex;
  flex-direction: column;
  max-height: 86vh;
  padding: var(--pix-space-lg);
  border-radius: var(--pix-radius-xl) !important;
}

.rd-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: var(--pix-space-sm);
  color: var(--pix-text-primary);
  font-size: var(--pix-text-md);
  font-weight: var(--pix-weight-semibold);
}

.rd-body {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-sm);
  overflow-y: auto;
  padding-right: 2px;
}

.rd-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rd-label {
  color: var(--pix-text-muted);
  font-size: 10px;
  font-weight: var(--pix-weight-medium);
}

.rd-help {
  color: var(--pix-text-muted);
  font-size: 9px;
  line-height: 1.5;
}

.rd-body :deep(.v-field) {
  font-size: var(--pix-text-xs);
}

.rd-seats {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rd-seats-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.rd-seat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 7px;
  border: 1px solid var(--pix-border-subtle);
  border-radius: var(--pix-radius-md);
  background: #ffffff;
}

.rd-seat-row {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
}

.rd-seat-name {
  flex: 1;
  min-width: 90px;
}

.rd-seat-auth {
  max-width: 96px;
}

.rd-seat-model {
  max-width: 150px;
}

.rd-presets {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: var(--pix-space-xs);
  border-top: 1px solid var(--pix-border-subtle);
}

.rd-preset {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
}

.rd-preset-name {
  color: var(--pix-text-primary);
  font-weight: var(--pix-weight-medium);
}

.rd-preset-count {
  color: var(--pix-text-muted);
  font-size: 9px;
}

.rd-preset-save {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
}

.rd-preset-input {
  max-width: 180px;
}

.rd-link {
  border: none;
  background: transparent;
  color: var(--pix-accent);
  font-size: 10px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: var(--pix-radius-sm);
}

.rd-link:hover:not(:disabled) {
  background: var(--pix-bg-hover);
}

.rd-link:disabled {
  color: var(--pix-text-muted);
  cursor: not-allowed;
}

.rd-link--danger {
  color: var(--pix-error);
}

.rd-error {
  padding: var(--pix-space-xs) var(--pix-space-sm);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-error-bg);
  color: var(--pix-error);
  font-size: 11px;
}

.rd-actions {
  padding: var(--pix-space-sm) 0 0 !important;
}
</style>
