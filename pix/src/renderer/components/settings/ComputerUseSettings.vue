<script setup lang="ts">
/**
 * ComputerUseSettings - 设置 › 电脑操控 分区内容
 *
 * 表单值（全局开关、自定义驱动路径、截图长边/字节预算、保留截图数、新会话
 * 默认值）经 modelValue/update:modelValue 与 SettingsPage 的加载/脏检查/保存
 * 流程对接（与 takeHerEyes 同模式，本组件不做持久化）；驱动状态、安装进度与
 * 权限引导来自 computer-use store（快照 + install_progress 事件）。
 * 隐私说明在全局开关旁写明：截图（明文 base64）与可访问性树文本会
 * 写入本机会话 JSONL 并作为上下文发送给当前模型提供方，会话 HTML 导出也会
 * 连带包含截图。驱动由 Cua Driver（MIT，trycua/cua）提供。
 */

import { computed, onMounted } from "vue";
import SettingsGroup from "./SettingsGroup.vue";
import SettingsRow from "./SettingsRow.vue";
import { useComputerUseStore } from "../../stores/computer-use-store";
import {
  computerUseDegradedLabel,
  computerUsePermissionLabel,
  COMPUTER_USE_DEFAULTS,
  COMPUTER_USE_LIMITS,
  normalizeComputerUseDriverPath,
  type ComputerUseSettings,
} from "@shared/computer-use-types.js";

const props = defineProps<{
  /** 分区表单值（保存由 SettingsPage 统一执行）。 */
  modelValue: ComputerUseSettings;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: ComputerUseSettings];
}>();

const store = useComputerUseStore();

onMounted(() => store.start());

const limits = COMPUTER_USE_LIMITS;
const defaults = COMPUTER_USE_DEFAULTS;

const snapshot = computed(() => store.snapshot);
const availability = computed(() => snapshot.value?.availability ?? null);
const missingPermissions = computed(() => snapshot.value?.missingPermissions ?? []);
const permissionUndecided = computed(() => snapshot.value?.permissionUndecided ?? []);
const degradedCapabilities = computed(() => snapshot.value?.degradedCapabilities ?? []);

// ============================================================================
// Form plumbing
// ============================================================================

function patch(part: Partial<ComputerUseSettings>): void {
  emit("update:modelValue", { ...props.modelValue, ...part });
}

type NumberSettingKey = "maxImageDimension" | "screenshotMaxBytes" | "keepRecentScreenshots";

/** 数值输入：空串/非法值回落到 undefined（= 使用缺省值），整数按四舍五入保留。 */
function setNumber(key: NumberSettingKey, raw: unknown): void {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const parsed = text.trim() === "" ? Number.NaN : Number.parseFloat(text);
  const value = Number.isFinite(parsed) ? Math.round(parsed) : undefined;
  patch({ [key]: value });
}

// ============================================================================
// Driver status (snapshot)
// ============================================================================

const AVAILABILITY_LABELS: Readonly<Record<string, string>> = {
  disabled: "全局未开启",
  unsupported_platform: "当前平台不支持",
  driver_missing: "未安装驱动",
  driver_incompatible: "驱动版本不兼容",
  installing: "正在安装驱动",
  stopped: "已就绪（未启动）",
  starting: "正在启动",
  ready: "已就绪",
  permission_required: "缺少系统权限",
  failed: "驱动异常",
};

const availabilityLabel = computed(() => (availability.value ? AVAILABILITY_LABELS[availability.value] ?? availability.value : "未连接"));

const driverSourceLabel = computed(() => {
  const source = snapshot.value?.driver.source;
  if (source === "managed") return "托管安装";
  if (source === "custom") return "自定义路径";
  return null;
});

const installing = computed(() => availability.value === "installing");

const canInstall = computed(() => {
  const a = availability.value;
  return a !== null && a !== "disabled" && a !== "unsupported_platform" && a !== "installing";
});

const installButtonLabel = computed(() => {
  if (availability.value === "driver_missing") return "安装驱动";
  if (availability.value === "failed") return "重试安装";
  return "重新安装";
});

/**
 * 全局关闭（availability "disabled"）时驱动行只显示“全局未开启”徽标，
 * 仍按 snapshot.driver（source/path/version）推断并展示安装状态；安装按钮
 * 保持不可用（canInstall 已排除 disabled）。
 */
const driverInstallStateLabel = computed(() => {
  if (availability.value !== "disabled") return null;
  const driver = snapshot.value?.driver;
  const sourceLabel = driver?.source === "custom" ? "自定义" : "托管";
  if (driver?.version) return `已安装 cua-driver v${driver.version}（${sourceLabel}）`;
  if (driver?.source === "custom" && driver.path) return "已配置自定义驱动路径";
  if (driver?.source === "managed" && driver.path) return "已安装 cua-driver（托管）";
  return "驱动未安装";
});

const installProgress = computed(() => store.installProgress);

const installPercent = computed<number | null>(() => {
  const progress = installProgress.value;
  if (!progress || progress.totalBytes === null || progress.totalBytes <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((progress.receivedBytes / progress.totalBytes) * 100)));
});

const installBarVisible = computed(() => {
  const phase = installProgress.value?.phase;
  return phase === "downloading" || phase === "verifying" || phase === "extracting";
});

const installLabel = computed(() => {
  const progress = installProgress.value;
  if (!progress) return null;
  switch (progress.phase) {
    case "downloading":
      return installPercent.value === null ? "正在下载操控驱动…" : `正在下载操控驱动 ${installPercent.value}%`;
    case "verifying":
      return "正在校验驱动完整性（sha256）…";
    case "extracting":
      return "正在解压操控驱动…";
    case "done":
      return "操控驱动安装完成";
    case "cancelled":
      return "操控驱动安装已取消";
    case "failed":
      return null;
  }
});

const installError = computed(() => (installProgress.value?.phase === "failed" ? installProgress.value.error ?? "安装失败" : null));

// ============================================================================
// Permissions / platform notes
// ============================================================================

const missingPermissionText = computed(() => missingPermissions.value.map(computerUsePermissionLabel).join("、"));

/** 驱动未上报的权限项（不可判断、不阻断），中文名拼接；空则 null。 */
const permissionUndecidedText = computed(() =>
  permissionUndecided.value.length > 0 ? permissionUndecided.value.map(computerUsePermissionLabel).join("、") : null,
);

/** macOS（唯一支持 open_permission_settings 跳转的平台）。 */
const isMac = computed(() => snapshot.value?.platform === "darwin-universal");

const macPermissionButtons = computed<Array<"accessibility" | "screen_recording">>(() => {
  if (!isMac.value) return [];
  const missing = missingPermissions.value.filter(
    (permission): permission is "accessibility" | "screen_recording" =>
      permission === "accessibility" || permission === "screen_recording",
  );
  if (missing.length > 0) return missing;
  if (snapshot.value.availability === "permission_required") return ["accessibility", "screen_recording"];
  return [];
});

const platformNote = computed(() => {
  const notes: string[] = [];
  // XDG_SESSION_TYPE 在驱动启动前即可探测，提示不受限于 degradedCapabilities。
  if (snapshot.value?.linuxDisplayServer === "wayland") {
    notes.push("检测到 Wayland 会话：后台输入受限，Agent 需要前台授权才能输入。");
  }
  if (degradedCapabilities.value.includes("accessibility_tree")) {
    notes.push("可访问性树不可用：Agent 只能依赖截图定位元素。");
  }
  if (degradedCapabilities.value.includes("background_input")) {
    notes.push("驱动报告：Wayland 会话下无法后台输入，Agent 需要前台授权才能输入。");
  }
  for (const capability of degradedCapabilities.value) {
    if (capability !== "accessibility_tree" && capability !== "background_input") {
      notes.push(`能力受限：${computerUseDegradedLabel(capability)}。`);
    }
  }
  return notes.length > 0 ? notes.join(" ") : null;
});

function permissionButtonLabel(permission: "accessibility" | "screen_recording"): string {
  return permission === "accessibility"
    ? `打开“${computerUsePermissionLabel("accessibility")}”设置`
    : `打开“${computerUsePermissionLabel("screen_recording")}”设置`;
}

function openPermission(permission: "accessibility" | "screen_recording"): void {
  void store.openPermissionSettings(permission);
}

// ============================================================================
// Driver actions
// ============================================================================

function installDriver(): void {
  void store.installDriver();
}

function cancelInstall(): void {
  void store.cancelInstall();
}

function recheckDriver(): void {
  void store.recheckDriver();
}
</script>

<template>
  <div class="cu-settings">
    <SettingsGroup title="电脑操控">
      <SettingsRow
        title="启用电脑操控"
        control-id="setting-computerUseEnabled"
        description="允许 Agent 观察并操作本机桌面；每个会话还需在输入框旁单独打开开关。"
      >
        <v-switch
          id="setting-computerUseEnabled"
          aria-label="启用电脑操控"
          density="compact"
          label="启用电脑操控"
          hide-details
          :model-value="modelValue.enabled"
          @update:model-value="(value: unknown) => patch({ enabled: value === true })"
        />
      </SettingsRow>
      <SettingsRow
        title="新会话默认开启"
        control-id="setting-computerUseDefaultSessionEnabled"
        description="新建会话的电脑操控开关默认打开；已有会话不受影响。"
      >
        <v-switch
          id="setting-computerUseDefaultSessionEnabled"
          aria-label="新会话默认开启"
          density="compact"
          label="新会话默认开启"
          hide-details
          :model-value="modelValue.defaultSessionEnabled === true"
          @update:model-value="(value: unknown) => patch({ defaultSessionEnabled: value === true })"
        />
      </SettingsRow>
      <div class="cu-privacy" role="note" aria-label="隐私说明">
        <div class="cu-privacy-title">
          <v-icon icon="mdi-shield-alert" size="14" />
          <span>隐私说明</span>
        </div>
        <ul class="cu-privacy-list">
          <li>截图（明文 base64）与可访问性树文本会写入本机会话 JSONL，与会话同寿命，删除会话即一并删除。</li>
          <li>同样的内容会作为上下文发送给当前模型提供方。</li>
          <li>会话 HTML 导出会连带包含这些截图。</li>
        </ul>
      </div>
    </SettingsGroup>

    <SettingsGroup title="操控驱动">
      <SettingsRow title="驱动状态" :description="snapshot?.availabilityDetail ?? '驱动为跨平台 cua-driver（MCP stdio），仅在需要时启动。'" wide>
        <div class="cu-driver">
          <div class="cu-driver-line">
            <span class="cu-driver-badge" :class="`cu-driver-${availability ?? 'unknown'}`">{{ availabilityLabel }}</span>
            <span v-if="driverInstallStateLabel" class="cu-driver-meta">{{ driverInstallStateLabel }}</span>
            <template v-if="availability !== 'disabled'">
              <span v-if="snapshot?.driver.version" class="cu-driver-meta">v{{ snapshot.driver.version }}</span>
              <span v-if="driverSourceLabel" class="cu-driver-meta">{{ driverSourceLabel }}</span>
            </template>
            <span v-if="snapshot?.emergencyShortcut" class="cu-driver-meta">紧急停止 {{ snapshot.emergencyShortcut }}</span>
          </div>
          <div v-if="snapshot?.driver.path" class="cu-driver-path" :title="snapshot.driver.path">
            {{ snapshot.driver.path }}
          </div>
          <div v-if="installLabel || installError" class="cu-install">
            <div v-if="installLabel" class="cu-install-label">{{ installLabel }}</div>
            <v-progress-linear
              v-if="installBarVisible"
              class="cu-install-bar"
              :model-value="installPercent"
              :indeterminate="installPercent === null"
              color="primary"
              height="6"
              rounded
            />
            <div v-if="installError" class="cu-install-error">安装失败：{{ installError }}</div>
          </div>
          <div v-if="store.lastError" class="cu-driver-error">{{ store.lastError }}</div>
          <div class="cu-driver-actions">
            <v-btn
              v-if="canInstall"
              class="cu-install-btn"
              size="small"
              variant="tonal"
              color="primary"
              prepend-icon="mdi-download"
              @click="installDriver"
            >
              {{ installButtonLabel }}
            </v-btn>
            <v-btn v-if="installing" class="cu-cancel-btn" size="small" variant="text" @click="cancelInstall">
              取消安装
            </v-btn>
            <v-btn v-if="canInstall" class="cu-recheck-btn" size="small" variant="text" prepend-icon="mdi-refresh" @click="recheckDriver">
              重新检查
            </v-btn>
          </div>
        </div>
      </SettingsRow>
      <SettingsRow
        title="自定义驱动路径"
        control-id="setting-computerUseDriverPath"
        description="留空使用 PiX 托管安装；填写绝对路径后不再下载驱动。"
        wide
      >
        <v-text-field
          id="setting-computerUseDriverPath"
          aria-label="自定义驱动路径"
          density="compact"
          hide-details="auto"
          placeholder="自动检测（托管安装）"
          :model-value="modelValue.driverPath ?? ''"
          @update:model-value="(value: string) => patch({ driverPath: normalizeComputerUseDriverPath(value) })"
        />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="截图与上下文">
      <SettingsRow
        title="截图长边（像素）"
        control-id="setting-computerUseMaxImageDimension"
        :description="`${limits.maxImageDimension.min}–${limits.maxImageDimension.max}，缺省 ${defaults.maxImageDimension}`"
        wide
      >
        <v-text-field
          id="setting-computerUseMaxImageDimension"
          aria-label="截图长边（像素）"
          type="number"
          density="compact"
          hide-details
          :min="limits.maxImageDimension.min"
          :max="limits.maxImageDimension.max"
          :placeholder="String(defaults.maxImageDimension)"
          :model-value="modelValue.maxImageDimension ?? ''"
          @update:model-value="(value: string) => setNumber('maxImageDimension', value)"
        />
      </SettingsRow>
      <SettingsRow
        title="截图字节预算"
        control-id="setting-computerUseScreenshotMaxBytes"
        :description="`单张截图 base64 字节上限 ${limits.screenshotMaxBytes.min}–${limits.screenshotMaxBytes.max}，缺省 ${defaults.screenshotMaxBytes}`"
        wide
      >
        <v-text-field
          id="setting-computerUseScreenshotMaxBytes"
          aria-label="截图字节预算"
          type="number"
          density="compact"
          hide-details
          :min="limits.screenshotMaxBytes.min"
          :max="limits.screenshotMaxBytes.max"
          :placeholder="String(defaults.screenshotMaxBytes)"
          :model-value="modelValue.screenshotMaxBytes ?? ''"
          @update:model-value="(value: string) => setNumber('screenshotMaxBytes', value)"
        />
      </SettingsRow>
      <SettingsRow
        title="保留最近截图数"
        control-id="setting-computerUseKeepRecentScreenshots"
        :description="`上下文中保留的最近截图数量 ${limits.keepRecentScreenshots.min}–${limits.keepRecentScreenshots.max}，缺省 ${defaults.keepRecentScreenshots}`"
        wide
      >
        <v-text-field
          id="setting-computerUseKeepRecentScreenshots"
          aria-label="保留最近截图数"
          type="number"
          density="compact"
          hide-details
          :min="limits.keepRecentScreenshots.min"
          :max="limits.keepRecentScreenshots.max"
          :placeholder="String(defaults.keepRecentScreenshots)"
          :model-value="modelValue.keepRecentScreenshots ?? ''"
          @update:model-value="(value: string) => setNumber('keepRecentScreenshots', value)"
        />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="系统权限">
      <SettingsRow title="权限状态" wide>
        <div class="cu-permissions">
          <div v-if="missingPermissions.length > 0" class="cu-permission-list">缺少：{{ missingPermissionText }}</div>
          <div v-else class="cu-permission-ok">当前未发现缺失权限（驱动启动后由驱动检查）。</div>
          <div v-if="permissionUndecidedText" class="cu-permission-undecided">
            以下权限状态无法确认：{{ permissionUndecidedText }}（不阻断使用）
          </div>
          <div v-if="missingPermissions.length > 0 && isMac" class="cu-permission-hint">
            驱动以 PiX 自身的身份运行，请在系统设置中为 PiX 授权。
          </div>
          <div v-if="macPermissionButtons.length > 0" class="cu-permission-actions">
            <v-btn
              v-for="permission in macPermissionButtons"
              :key="permission"
              class="cu-permission-btn"
              size="small"
              variant="tonal"
              prepend-icon="mdi-cog-outline"
              @click="openPermission(permission)"
            >
              {{ permissionButtonLabel(permission) }}
            </v-btn>
          </div>
          <div v-if="platformNote" class="cu-platform-note">{{ platformNote }}</div>
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="许可与归属">
      <SettingsRow
        title="Cua Driver"
        description="PiX 的电脑操控由 Cua Driver（MIT，trycua/cua）提供支持；驱动仅在需要时下载官方发布产物，不随 PiX 分发，遥测已关闭。"
      >
        <a class="cu-attribution-link" href="https://github.com/trycua/cua" target="_blank" rel="noopener noreferrer">
          trycua/cua
        </a>
      </SettingsRow>
    </SettingsGroup>
  </div>
</template>

<style scoped>
.cu-settings {
  min-width: 0;
}

.cu-privacy {
  margin: 0 0 var(--pix-space-md);
  padding: var(--pix-space-sm) var(--pix-space-md);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-left);
}

.cu-privacy-title {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-semibold);
  color: var(--pix-text-secondary);
}

.cu-privacy-list {
  margin: var(--pix-space-xs) 0 0;
  padding-left: 18px;
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-base);
}

.cu-driver {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  min-width: 0;
  text-align: right;
}

.cu-driver-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--pix-space-xs);
}

.cu-driver-badge {
  padding: 1px 7px;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-bg-left);
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
  font-weight: var(--pix-weight-medium);
}

.cu-driver-ready,
.cu-driver-stopped {
  border-color: var(--pix-success-light);
  background: var(--pix-success-bg);
  color: var(--pix-success);
}

.cu-driver-driver_missing,
.cu-driver-driver_incompatible,
.cu-driver-failed {
  border-color: var(--pix-error-light);
  background: var(--pix-error-bg);
  color: var(--pix-error);
}

.cu-driver-permission_required,
.cu-driver-installing,
.cu-driver-starting {
  border-color: var(--pix-warning-light);
  background: var(--pix-warning-bg);
  color: var(--pix-warning);
}

.cu-driver-meta {
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
}

.cu-driver-path {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--pix-text-muted);
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
}

.cu-install {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.cu-install-label {
  color: var(--pix-text-secondary);
  font-size: var(--pix-text-xs);
}

.cu-install-bar {
  width: 100%;
}

.cu-install-error,
.cu-driver-error {
  color: var(--pix-error);
  font-size: var(--pix-text-xs);
  overflow-wrap: anywhere;
  text-align: right;
}

.cu-driver-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--pix-space-xs);
}

.cu-permissions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  min-width: 0;
}

.cu-permission-list {
  color: var(--pix-error);
  font-size: var(--pix-text-xs);
}

.cu-permission-ok {
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
}

.cu-permission-hint,
.cu-permission-undecided,
.cu-platform-note {
  color: var(--pix-text-muted);
  font-size: var(--pix-text-xs);
  text-align: right;
}

.cu-permission-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--pix-space-xs);
}

.cu-attribution-link {
  color: var(--pix-text-link);
  font-size: var(--pix-text-sm);
}
</style>
