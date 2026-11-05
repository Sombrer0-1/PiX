<script setup lang="ts">
/**
 * ProjectOpenDialog
 *
 * Vuetify project picker (wsl_plan §4.9). Lets the user choose a project
 * environment (Windows or WSL2) and the corresponding working directory, then
 * emits a `ProjectLocationInput` for the parent to resolve via the main
 * process. The renderer performs NO path conversion: the native directory
 * dialog only fills the Windows physical path, and the WSL logical path is the
 * primary, user-typed input.
 *
 * WSL mode requires both an explicit distro (from the probed list) and an
 * absolute POSIX cwd; Windows mode disables both. WSL controls are disabled
 * when no distros are available.
 */
import { ref, computed, watch } from "vue";
import type { ProjectEnvironment, ProjectLocationInput, WslDistroInfo } from "@/types/session";
import { DESKTOP_API_UNAVAILABLE, isDesktopApiAvailable, mapDesktopApiError, sanitizeUserDiagnostic } from "../../utils/desktop-api";

const props = defineProps<{
  modelValue: boolean;
  defaultEnvironment: ProjectEnvironment;
  defaultCwd: string;
  distros: WslDistroInfo[];
  wslDiagnostic?: string;
  /** True while the WSL distro probe is in flight (wsl_plan §5.1 step 2). */
  distrosLoading?: boolean;
  /** Parent is resolving/opening the chosen location. */
  submitting?: boolean;
  /** Resolve/open failure to keep the dialog usable. */
  error?: string | null;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: boolean): void;
  (event: "open", value: ProjectLocationInput): void;
}>();

type Mode = "windows" | "wsl";

const mode = ref<Mode>("windows");
const windowsPath = ref("");
const distro = ref("");
const linuxCwd = ref("");
/** Once the user picks a mode, late WSL probes must not override it. */
const userChoseMode = ref(false);
const browseBusy = ref(false);
const browseError = ref<string | null>(null);

const open = computed<boolean>({
  get: () => props.modelValue,
  set: (value) => emit("update:modelValue", value),
});

const wslUnavailable = computed(() => props.distros.length === 0);

const wslDiagnosticDisplay = computed(() => sanitizeUserDiagnostic(props.wslDiagnostic));

const isWindowsMode = computed(() => mode.value === "windows");

const distroValid = computed(
  () => !!distro.value && props.distros.some((d) => d.name === distro.value),
);

const linuxCwdValid = computed(() => {
  const value = linuxCwd.value.trim();
  // Absolute POSIX path; reject Windows drive/UNC-style input.
  return value.startsWith("/") && !value.includes("\\") && !/^[A-Za-z]:/.test(value);
});

const canSubmit = computed(() => {
  if (isWindowsMode.value) return windowsPath.value.trim().length > 0;
  if (wslDiagnosticDisplay.value) return false;
  return distroValid.value && linuxCwdValid.value;
});

const distroItems = computed(() =>
  props.distros.map((d) => ({ title: d.name, value: d.name, subtitle: `v${d.version} · ${d.state}` })),
);

// Apply the global WSL defaults to the form's mode/distro selection. Shared by
// the dialog-open watcher and the distros-arrival watcher so a WSL-default user
// does not have to manually switch when the probe settles after open.
function applyEnvironmentDefaults(): void {
  const canUseWsl = props.defaultEnvironment.kind === "wsl" && props.distros.length > 0;
  mode.value = canUseWsl ? "wsl" : "windows";
  distro.value = props.defaultEnvironment.kind === "wsl" ? props.defaultEnvironment.distro : "";
  if (mode.value === "wsl" && !distro.value && props.distros.length > 0) {
    distro.value = props.distros.find((d) => d.isDefault)?.name ?? props.distros[0].name;
  }
}

// Re-initialize the form each time the dialog opens so stale values from a
// previous pick do not carry over, and so the default environment/cwd track
// the latest global WSL settings.
watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) return;
    userChoseMode.value = false;
    browseError.value = null;
    applyEnvironmentDefaults();
    linuxCwd.value = props.defaultCwd || "/home";
    windowsPath.value = "";
  },
);

// When the WSL distro probe settles after the dialog opened during an in-flight
// probe (HomePage fires loadWslDistros unawaited on mount), re-evaluate the
// mode so a WSL-default user is not left on Windows and forced to click WSL2
// or close/reopen (wsl_plan §5.1 step 2). Only acts on the empty -> populated
// transition, and only when the user has not already moved off the default.
watch(
  () => props.distros,
  (distros, prev) => {
    if (!props.modelValue) return;
    if (distros.length === 0) return;
    if (prev && prev.length > 0) return;
    if (userChoseMode.value) return;
    if (mode.value === "wsl") return;
    if (windowsPath.value.trim()) return;
    if (props.defaultEnvironment.kind !== "wsl") return;
    applyEnvironmentDefaults();
  },
);

async function browseWindowsPath(): Promise<void> {
  if (browseBusy.value || props.submitting) return;
  browseBusy.value = true;
  browseError.value = null;
  try {
    if (!isDesktopApiAvailable()) {
      browseError.value = DESKTOP_API_UNAVAILABLE;
      return;
    }
    const picked = await window.pixApi.selectProject();
    if (picked) windowsPath.value = picked;
  } catch (err) {
    browseError.value = mapDesktopApiError(err, "选择目录失败，请重试");
  } finally {
    browseBusy.value = false;
  }
}

function chooseMode(next: Mode): void {
  mode.value = next;
  userChoseMode.value = true;
}

function submit(): void {
  if (!canSubmit.value || props.submitting) return;
  if (isWindowsMode.value) {
    emit("open", { environment: { kind: "windows" }, physicalPath: windowsPath.value.trim() });
  } else {
    emit("open", { environment: { kind: "wsl", distro: distro.value }, logicalPath: linuxCwd.value.trim() });
  }
  // Parent closes on success and keeps the dialog open on failure.
}

function onFieldKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return;
  if (e.key !== "Enter" || e.shiftKey) return;
  // Append actions (e.g. 「浏览」) bubble Enter into the field; only submit from the input itself.
  const target = e.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  e.preventDefault();
  submit();
}
</script>

<template>
  <v-dialog v-model="open" max-width="560" :persistent="false">
    <v-card class="open-dialog-card">
      <div class="open-dialog-title">打开项目</div>
      <div class="open-dialog-body">
        <v-btn-toggle
          :model-value="mode"
          mandatory
          divided
          color="primary"
          class="mb-4"
          density="comfortable"
          :disabled="!!submitting"
          @update:model-value="(value) => value && chooseMode(value as Mode)"
        >
          <v-btn value="windows">Windows</v-btn>
          <v-btn value="wsl" :disabled="wslUnavailable">WSL2</v-btn>
        </v-btn-toggle>

        <v-alert
          v-if="error || browseError"
          type="error"
          variant="tonal"
          density="comfortable"
          class="mb-4"
          title="无法打开"
        >
          {{ error || browseError }}
        </v-alert>

        <v-alert
          v-if="distrosLoading"
          type="info"
          variant="tonal"
          density="comfortable"
          class="mb-4"
          title="正在探测 WSL 发行版"
        >
          正在列举可用的 WSL2 发行版，请稍候……
        </v-alert>

        <v-alert
          v-if="wslDiagnosticDisplay"
          type="warning"
          variant="tonal"
          density="comfortable"
          class="mb-4"
          title="WSL 不可用"
        >
          {{ wslDiagnosticDisplay }}
        </v-alert>

        <!-- Windows mode -->
        <template v-if="isWindowsMode">
          <v-text-field
            v-model="windowsPath"
            label="项目文件夹"
            hint="点击右侧「浏览」选择目录，或直接粘贴 Windows 路径。"
            persistent-hint
            class="mb-2"
            :disabled="!!submitting"
            @keydown="onFieldKeydown"
          >
            <template #append>
              <v-btn
                variant="tonal"
                density="comfortable"
                prepend-icon="mdi-folder-open-outline"
                :loading="browseBusy"
                :disabled="!!submitting || browseBusy"
                @click="browseWindowsPath"
              >
                浏览
              </v-btn>
            </template>
          </v-text-field>
        </template>

        <!-- WSL mode -->
        <template v-else>
          <v-select
            v-model="distro"
            label="WSL 发行版"
            :items="distroItems"
            item-title="title"
            item-value="value"
            no-data-text="未发现 WSL2 发行版"
            hint="必须显式选择发行版，不会使用默认发行版。"
            persistent-hint
            :disabled="wslUnavailable || !!submitting"
            class="mb-4"
          >
            <template #item="{ props: itemProps, item }">
              <v-list-item v-bind="itemProps" :subtitle="item.raw.subtitle" />
            </template>
          </v-select>

          <v-text-field
            v-model="linuxCwd"
            label="项目目录（Linux 路径）"
            placeholder="/home/user/project"
            hint="发行版内的绝对 POSIX 路径，例如 /home/user/project。"
            persistent-hint
            :disabled="wslUnavailable || !!submitting"
            :error-messages="linuxCwd && !linuxCwdValid ? '请输入以 / 开头的绝对 Linux 路径' : ''"
            class="mb-2"
            @keydown="onFieldKeydown"
          />
        </template>
      </div>
      <v-card-actions class="open-dialog-actions">
        <v-spacer />
        <v-btn variant="text" :disabled="!!submitting" @click="open = false">取消</v-btn>
        <v-btn color="primary" variant="flat" :loading="!!submitting" :disabled="!canSubmit || !!submitting" @click="submit">打开</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.open-dialog-card {
  padding: var(--pix-space-lg);
}

.open-dialog-title {
  font-size: var(--pix-text-lg);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-primary);
  margin-bottom: var(--pix-space-md);
}

.open-dialog-body {
  display: flex;
  flex-direction: column;
}

.open-dialog-actions {
  margin-top: var(--pix-space-sm);
  padding: 0;
}
</style>
