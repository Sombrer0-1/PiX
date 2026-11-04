<script setup lang="ts">
/**
 * ComputerToolDetails - computer_observe / computer_act 详情
 *
 * 摘要行（视图/动作）、目标、结果文本、截图缩略图（来自 tool.result.content
 * 的 image 块）与错误码。纯展示组件：成功结果读 details，错误结果没有 details
 * （agent-loop 丢弃），错误码用 COMPUTER_USE_ERROR_PATTERN 从文本前缀解析
 * （shared/computer-use-types.ts）。直播与回放取数同一套归一化
 * （result.ts），回放由 display-blocks 的 keepsDetails 白名单保留 details。
 */

import { computed } from "vue";
import type { ToolWorkItem } from "@/types/session";
import {
  computerUseGrantLabel,
  COMPUTER_USE_ERROR_PATTERN,
  type ComputerActAction,
  type ComputerObserveView,
  type ComputerToolDetails as ComputerToolDetailsData,
} from "@shared/computer-use-types.js";
import { extractToolResultDetails, extractToolResultText, isRecord } from "./result";

const props = defineProps<{
  tool: ToolWorkItem;
}>();

const VIEW_LABELS: Readonly<Record<string, string>> = {
  apps: "应用列表",
  windows: "窗口列表",
  window: "窗口",
  desktop: "桌面",
  zoom: "局部放大",
  verify: "条件校验",
};

const ACTION_LABELS: Readonly<Record<string, string>> = {
  click: "点击",
  double_click: "双击",
  right_click: "右键点击",
  type_text: "输入文本",
  press_key: "按键",
  hotkey: "快捷键",
  scroll: "滚动",
  drag: "拖拽",
  move_cursor: "移动光标",
  set_value: "赋值",
  invoke_menu: "菜单调用",
  launch_app: "启动应用",
  focus_window: "聚焦窗口",
  wait: "等待",
};

const OMITTED_LABELS: Readonly<Record<string, string>> = {
  non_vision_model: "当前模型不支持图像",
  images_blocked: "图片已按设置阻止",
  not_requested: "本次未请求截图",
};

const TEXT_MAX_CHARS = 4000;

function truncate(text: string, maxLength: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  return `${chars.slice(0, maxLength).join("")}...`;
}

/**
 * [pix] capture_id/frame/screenshot/grant/effect 与 Hint 修复提示拼在
 * 文本末尾，静默截断会让它们永不可见。splitTrailer 把尾部关键信息从主体
 * 文本中分离为独立底栏：最后一个 [pix] 行起的所有行（[pix] 行 + 其后的驱动
 * 附注）都属尾部；没有 [pix] 行时退而收集末尾连续的 Hint: 行。主体截断时
 * 由省略标记 + 底栏保证尾部关键信息始终可见。
 */
function splitTrailer(text: string): { body: string; trailer: string | null } {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;
  let start = -1;
  for (let i = end - 1; i >= 0; i -= 1) {
    if (lines[i].trim().startsWith("[pix]")) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    // 无 [pix] 行：只收集末尾连续的 Hint: 修复提示（空行分隔不越过非 Hint 行）。
    for (let i = end - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (line === "") continue;
      if (/^Hint:/i.test(line)) {
        start = i;
        continue;
      }
      break;
    }
    if (start === -1) return { body: text, trailer: null };
  }
  let bodyEnd = start;
  while (bodyEnd > 0 && lines[bodyEnd - 1].trim() === "") bodyEnd -= 1;
  return { body: lines.slice(0, bodyEnd).join("\n"), trailer: lines.slice(start, end).join("\n") };
}

/** details 结构守卫：只信任形状正确的对象（直播/回放共用）。 */
function parseDetails(raw: unknown): ComputerToolDetailsData | null {
  if (!isRecord(raw)) return null;
  if (raw.kind !== "observe" && raw.kind !== "act") return null;
  if (raw.grant !== "none" && raw.grant !== "background" && raw.grant !== "foreground") return null;
  if (typeof raw.durationMs !== "number") return null;
  return {
    kind: raw.kind,
    view: typeof raw.view === "string" ? (raw.view as ComputerObserveView) : undefined,
    action: typeof raw.action === "string" ? (raw.action as ComputerActAction) : undefined,
    target: isRecord(raw.target) ? (raw.target as ComputerToolDetailsData["target"]) : undefined,
    screenshot: isRecord(raw.screenshot) ? (raw.screenshot as ComputerToolDetailsData["screenshot"]) : undefined,
    grant: raw.grant,
    durationMs: raw.durationMs,
  };
}

const details = computed(() => parseDetails(extractToolResultDetails(props.tool.result)));

const resultText = computed(() => extractToolResultText(props.tool.result));

const splitText = computed(() => splitTrailer(resultText.value));

const displayText = computed(() => {
  const body = splitText.value.body;
  const chars = Array.from(body);
  return chars.length <= TEXT_MAX_CHARS ? body : chars.slice(0, TEXT_MAX_CHARS).join("");
});

/** 主体被截断时明示省略字符数（截断只作用于主体文本，不含尾部底栏）。 */
const omittedChars = computed(() => Math.max(0, Array.from(splitText.value.body).length - TEXT_MAX_CHARS));

/** 尾部关键信息（[pix] 捕获信息 / Hint 修复提示）：独立底栏，主体截断也始终可见。 */
const trailerText = computed(() => splitText.value.trailer);

const errorCode = computed(() => {
  // 屏幕内容等成功结果也可能以 “[computer_use:xxx]” 开头，错误码只在
  // tool.isError 为真时解析，避免成功 observe 被误标错误码。
  if (!props.tool.isError) return null;
  const match = COMPUTER_USE_ERROR_PATTERN.exec(resultText.value);
  return match ? match[1] : null;
});

interface ToolImage {
  src: string;
}

/** 结果内容里的 image 块（base64 截图）；直播与回放都从这里取图。 */
const image = computed<ToolImage | null>(() => {
  const result = props.tool.result;
  if (!isRecord(result) || !Array.isArray(result.content)) return null;
  for (const block of result.content) {
    if (isRecord(block) && block.type === "image" && typeof block.data === "string") {
      const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image/png";
      return { src: `data:${mimeType};base64,${block.data}` };
    }
  }
  return null;
});

const argsRecord = computed<Record<string, unknown> | null>(() => (isRecord(props.tool.args) ? props.tool.args : null));

/** 摘要：details 优先；错误结果没有 details 时从 args 降级解析。 */
const summary = computed(() => {
  const d = details.value;
  if (d?.kind === "observe") return `观察 · ${VIEW_LABELS[d.view ?? ""] ?? d.view ?? "窗口"}`;
  if (d?.kind === "act") {
    const action = ACTION_LABELS[d.action ?? ""] ?? d.action ?? "";
    return action ? `操作 · ${action}` : "操作";
  }
  const args = argsRecord.value;
  if (args) {
    if (typeof args.action === "string") return `操作 · ${ACTION_LABELS[args.action] ?? args.action}`;
    if (typeof args.view === "string") return `观察 · ${VIEW_LABELS[args.view] ?? args.view}`;
  }
  return "电脑操控";
});

/** 目标：应用/窗口标题 + 窗口 id / pid。 */
const target = computed(() => {
  const target = details.value?.target;
  if (!target) return null;
  const parts: string[] = [];
  if (target.appName) parts.push(target.appName);
  if (target.windowTitle) parts.push(target.windowTitle);
  if (typeof target.windowId === "number") parts.push(`窗口 ${target.windowId}`);
  if (typeof target.pid === "number") parts.push(`PID ${target.pid}`);
  return parts.length > 0 ? parts.join(" · ") : null;
});

/** 截图信息：尺寸 + 字节数，或省略原因（非视觉模型等降级）。 */
const screenshotLabel = computed(() => {
  const screenshot = details.value?.screenshot;
  if (!screenshot) return null;
  if (screenshot.omitted) return `截图省略：${OMITTED_LABELS[screenshot.omitted] ?? screenshot.omitted}`;
  const kb = Math.max(1, Math.round(screenshot.bytes / 1024));
  return `截图 ${screenshot.width}×${screenshot.height} · ${kb} KB`;
});

const grantLabel = computed(() => (details.value ? computerUseGrantLabel(details.value.grant) : null));

const durationLabel = computed(() => {
  const ms = details.value?.durationMs;
  if (typeof ms !== "number") return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
});

/** 动作参数补充（错误结果没有 details 时仍能看到模型意图；截断展示）。 */
const argsLine = computed(() => {
  const args = argsRecord.value;
  if (!args) return null;
  const parts: string[] = [];
  if (typeof args.text === "string") parts.push(`文本：${truncate(args.text, 200)}`);
  if (typeof args.key === "string") parts.push(`按键：${args.key}`);
  if (Array.isArray(args.keys) && args.keys.every((key) => typeof key === "string")) {
    parts.push(`组合键：${(args.keys as string[]).join("+")}`);
  }
  if (typeof args.value === "string") parts.push(`值：${truncate(args.value, 200)}`);
  if (typeof args.app === "string") parts.push(`应用：${args.app}`);
  if (Array.isArray(args.menu_path) && args.menu_path.every((item) => typeof item === "string")) {
    parts.push(`菜单：${(args.menu_path as string[]).join(" › ")}`);
  }
  return parts.length > 0 ? parts.join("；") : null;
});
</script>

<template>
  <div class="td-computer" :class="{ 'td-cu-error': tool.isError }">
    <div class="td-cu-head">
      <span class="td-cu-summary">{{ summary }}</span>
      <span v-if="grantLabel" class="td-cu-chip">{{ grantLabel }}</span>
      <span v-if="errorCode" class="td-cu-error-code" :title="errorCode">错误码 {{ errorCode }}</span>
      <span v-if="durationLabel" class="td-cu-chip td-cu-duration">{{ durationLabel }}</span>
    </div>
    <div v-if="target" class="td-cu-target" :title="target">{{ target }}</div>
    <div v-if="argsLine" class="td-cu-args" :title="argsLine">{{ argsLine }}</div>
    <img v-if="image" class="td-cu-thumb" :src="image.src" :alt="screenshotLabel ?? '电脑截图'" />
    <div v-if="screenshotLabel" class="td-cu-shot">{{ screenshotLabel }}</div>
    <pre v-if="displayText" class="td-pre td-cu-text">{{ displayText }}</pre>
    <div v-if="omittedChars > 0" class="td-cu-omitted" role="note">…已省略 {{ omittedChars }} 字符</div>
    <div v-if="trailerText" class="td-cu-trailer">{{ trailerText }}</div>
  </div>
</template>

<style scoped>
.td-computer {
  min-width: 0;
  font-size: var(--pix-text-xs);
  color: var(--pix-text-primary);
}

.td-cu-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--pix-space-xs);
  padding: 2px 0;
}

.td-cu-summary {
  font-weight: var(--pix-weight-medium);
}

.td-cu-chip {
  padding: 1px 6px;
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-sm);
  color: var(--pix-text-secondary);
}

.td-cu-error-code {
  padding: 1px 6px;
  border: 1px solid var(--pix-error-light);
  border-radius: var(--pix-radius-sm);
  background: var(--pix-error-bg);
  color: var(--pix-error);
  font-family: var(--pix-font-mono);
}

.td-cu-target,
.td-cu-args,
.td-cu-shot {
  padding: 1px 0;
  color: var(--pix-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.td-cu-shot {
  color: var(--pix-text-muted);
  font-variant-numeric: tabular-nums;
}

.td-cu-thumb {
  display: block;
  max-width: min(420px, 100%);
  max-height: 260px;
  margin-top: var(--pix-space-xs);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-code);
}

.td-pre {
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  line-height: var(--pix-leading-tight);
  background: var(--pix-bg-code);
  border: 1px solid var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  padding: var(--pix-space-sm) var(--pix-space-md);
  margin-top: var(--pix-space-sm);
  overflow-x: auto;
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--pix-text-primary);
  min-width: 0;
}

.td-cu-omitted {
  padding: 2px 0;
  color: var(--pix-text-muted);
  overflow-wrap: anywhere;
}

.td-cu-trailer {
  margin-top: var(--pix-space-xs);
  padding: 4px var(--pix-space-md);
  border: 1px dashed var(--pix-border-light);
  border-radius: var(--pix-radius-md);
  background: var(--pix-bg-code);
  font-family: var(--pix-font-mono);
  font-size: var(--pix-text-xs);
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--pix-text-secondary);
  overflow-wrap: anywhere;
}
</style>
