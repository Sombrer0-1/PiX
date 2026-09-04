/**
 * Display-block assembler (pure, framework-free).
 *
 * Extracted from session-store: folds raw AgentSessionEvent streams and
 * persisted session entry lists into DisplayBlock[] for rendering. The task
 * transcript view (TaskTranscriptView, P3) reuses this assembler with the
 * same SessionView render chain, so live task events and the main chat can
 * never diverge in folding semantics.
 *
 * Seam dedup for "disk replay + live watch" (Plan 4.7.2):
 * 1. A tool_execution_start whose toolCallId already exists in any work-status
 *    block is dropped (a toolCallId executes once per session).
 * 2. A message key (role:timestamp:textLength) set prevents re-folding a
 *    message already folded from disk or by an earlier message_end.
 * These guarantee that "watch 先订阅、get_transcript 后读盘" does not create
 * duplicate blocks: the same message arriving via both paths folds once.
 *
 * The caller may inject its own blocks array (e.g. a Vue reactive array);
 * this module never reassigns that reference, it only mutates the array in
 * place. No store / composable / Vue API is imported here.
 */

import type { AgentMessage, AgentSessionEvent } from "@shared/types.js";
import type { ChatMessageAttachment, DisplayBlock, ToolWorkItem } from "@/types/session";
import { classifyApiError } from "@/utils/api-error";
import { isInternalCustomMessageType } from "@shared/internal-notification";

// ============================================================================
// Public contract (Plan 4.7)
// ============================================================================

export interface DisplayBlockAssemblerOptions {
  /** 团队 leader 会话的 note 解析(任务 transcript 传 false/缺省)。 */
  teamLeader?: boolean;
  /** 外部提供的 blocks 数组(可为 Vue reactive 数组);缺省内部新建。组装器原地突变该数组。 */
  blocks?: DisplayBlock[];
}

export interface DisplayBlockAssembler {
  readonly blocks: DisplayBlock[];
  /**
   * 内部 id→block 索引（perf SDD §3.8/§4.3，Map 加速按 id 查找）。只读视图：
   * blocks 数组仍是唯一对外真源，此索引仅供 O(1) 查询与不变量校验
   * （任意操作后 blockById.size === blocks.length）。
   */
  readonly blockById: ReadonlyMap<string, DisplayBlock>;
  /** 直播事件折叠(即现 session-store.processEvent 语义 + 4.7.2 去重规则)。 */
  applyEvent(event: AgentSessionEvent): void;
  applyEvents(events: AgentSessionEvent[]): void;
  /**
   * 块数达到 maxBlocks 时从头部修剪至 floor(maxBlocks / 2)，同步维护内部
   * id→block 索引。返回实际剪掉的数量。length < maxBlocks 时返回 0 且不修改数组。
   */
  enforceBlockCap(maxBlocks: number): number;
  /**
   * 回放装载(全量重折叠语义):先 clear 再按序折叠传入的完整条目数组。
   * 幂等:同一数组重复调用结果一致。分页追加由调用方(store)拼全量数组后整体重折叠,
   * 组装器自身不提供 append 语义(与现 loadMessages 的 clear-then-fold 一致)。
   * 条目口径:type==="message" 走现有消息路径;type==="custom_message" 且
   * display!==false 折叠为 note 块(恢复说明等;display===false 跳过);其余类型跳过。
   */
  loadEntries(entries: unknown[]): void;
  clear(): void;
  /** 乐观用户消息(任务 transcript 不使用)。clipboardImages 的 path 必须与主进程一致。 */
  appendOptimisticUserMessage(
    text: string,
    filePaths?: string[],
    clipboardImages?: Array<{ mimeType: string }>,
  ): string | null;
  failOptimisticUserMessage(blockId: string | null, message: string): void;
  /** 最新可重试 API 错误块(渲染端决定是否给重试按钮)。 */
  readonly lastRetryableError: { blockId: string } | null;
}

// ============================================================================
// Implementation
// ============================================================================

function nextBlockId(): string {
  return `block_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

interface MessageDisplay {
  text: string;
  attachments: ChatMessageAttachment[];
  noteKind?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

/** Narrow the unknown assistantMessageEvent carried by message_update. */
interface AssistantMessageEventLike {
  type: string;
  delta?: unknown;
  content?: unknown;
}

function isAssistantMessageEvent(value: unknown): value is AssistantMessageEventLike {
  return isRecord(value) && typeof value.type === "string";
}

function messageTimestamp(message: AgentMessage): number {
  return typeof message.timestamp === "number" ? message.timestamp : Date.now();
}

function attachmentName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function attachmentFromPath(path: string): ChatMessageAttachment {
  return {
    path,
    name: attachmentName(path),
    kind: "file",
  };
}

/** Same path/name convention as SessionBridge._preparePromptInput. */
function clipboardImageAttachment(index: number, mimeType: string): ChatMessageAttachment {
  const ext = mimeType.split("/")[1] || "png";
  return {
    path: `clipboard-image-${index + 1}`,
    name: `clipboard-image-${index + 1}.${ext}`,
    kind: "image",
  };
}

function normalizeAttachment(value: unknown): ChatMessageAttachment | null {
  if (!isRecord(value) || typeof value.path !== "string") return null;
  const kind = value.kind === "image" || value.kind === "file" || value.kind === "text" ? value.kind : "file";
  return {
    path: value.path,
    name: typeof value.name === "string" ? value.name : attachmentName(value.path),
    kind,
    size: typeof value.size === "number" ? value.size : undefined,
    content: typeof value.content === "string" ? value.content : undefined,
  };
}

function extractContentText(message: AgentMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof (block as { text?: unknown }).text === "string")
      .map((block) => (block as { text: string }).text)
      .join("");
  }
  return "";
}

/** Display-layer defense: strip model-echoed ACP ref tags so they never leak in the UI. */
const ACP_DISPLAY_TAG_RE = /<acp\b[^>]*>[\s\S]*?<\/acp>/gi;

function stripAcpDisplayTags(text: string): string {
  // Display-only: drop echoed <acp> tags. Do not normalize unrelated whitespace
  // (Markdown hard breaks are two trailing spaces + newline).
  return text.replace(ACP_DISPLAY_TAG_RE, "");
}

function isInternalCustomMessage(message: AgentMessage): boolean {
  return message.role === "custom" && (
    message.context === "internal" ||
    isInternalCustomMessageType(message.customType)
  );
}

/**
 * Legacy internal-notification roots: opening tag paired with its required
 * closing tag. A text only matches when the WHOLE message is a single closed
 * envelope (starts with the opening tag, ends with the closing tag), so a user
 * message that merely mentions a reserved prefix (e.g. a pasted XML sample or
 * protocol discussion) is never silently hidden.
 */
const LEGACY_INTERNAL_NOTIFICATION_TAGS: ReadonlyArray<readonly [string, string]> = [
  ["</internal-message>", "<internal-message"],
  ["</task-notification>", "<task-notification"],
  ["</team-notification>", "<team-notification"],
  ["</plan-notification>", "<plan-notification"],
  ["</workflow-result>", "<workflow-result"],
  ["</orchestrator-event>", "<orchestrator-event"],
  ["</teammate-message>", "<teammate-message"],
  ["</worker-summary>", "<worker-summary"],
];

function isLegacyInternalNotificationText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  return LEGACY_INTERNAL_NOTIFICATION_TAGS.some(([closing, opening]) => {
    if (!lower.startsWith(opening) || !lower.endsWith(closing)) return false;
    const afterOpening = lower[opening.length];
    return afterOpening === undefined || afterOpening === ">" || afterOpening === "\n" || afterOpening === " " || afterOpening === "\t";
  });
}

/**
 * Compact note for a steered <teammate-message>. Unreachable for closed
 * envelopes: `isLegacyInternalNotificationText` returns first and hides them.
 * Kept so a future non-envelope teammate payload can reuse the formatter.
 */
function parseTeammateMessageNote(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("<teammate-message")) return null;
  const match = trimmed.match(
    /^<teammate-message\s+from="([^"]*)"(?:\s+role="([^"]*)")?[^>]*>\r?\n?([\s\S]*?)\r?\n?<\/teammate-message>\s*$/,
  );
  if (!match) return null;
  const from = match[1] || "团队成员";
  const role = match[2];
  const body = (match[3] ?? "").trim();
  const roleLabels: Record<string, string> = {
    planner: "规划",
    coder: "开发",
    reviewer: "审查",
    tester: "测试",
    researcher: "调研",
  };
  const roleLabel = role ? roleLabels[role] ?? role : undefined;
  const label = roleLabel && role !== from ? `${from}（${roleLabel}）` : from;
  return `来自 ${label} 的成员汇报：\n${body}`;
}

/**
 * One-line summary of an <orchestrator-event> prompt. Unreachable for closed
 * envelopes: the legacy-root check hides them before this branch. Kept for a
 * future non-envelope wake payload.
 */
function summarizeOrchestratorEvent(text: string): string {
  const events = [...text.matchAll(/^EVENT: (\S+)/gm)].map((m) => m[1]);
  if (events.length === 0) return "团队协调事件";
  const workers = [...new Set([...text.matchAll(/^Worker: ([^\n(]+)/gm)].map((m) => m[1].trim()))];
  const tasks = [...new Set([...text.matchAll(/^Task: "([^"]+)"/gm)].map((m) => m[1]))];
  const parts = [`团队事件：${[...new Set(events)].join("、")}`];
  if (workers.length > 0) parts.push(`成员：${workers.join("、")}`);
  if (tasks.length > 0) parts.push(`任务：${tasks.slice(0, 2).join("；")}`);
  return parts.join(" · ");
}

function parseEmbeddedFileBlocks(text: string): { text: string; attachments: ChatMessageAttachment[] } {
  const attachments: ChatMessageAttachment[] = [];
  const stripped = text.replace(/<file name="([^"]*)">\r?\n?([\s\S]*?)\r?\n?<\/file>\r?\n?/g, (_match, path, content) => {
    const filePath = String(path);
    const body = String(content);
    attachments.push({
      path: filePath,
      name: attachmentName(filePath),
      kind: body.trim().startsWith("[Image ") || body.trim().startsWith("Image ") ? "image" : "text",
      content: body,
    });
    return "";
  });
  return { text: stripped.trim(), attachments };
}

function mergeAttachments(...groups: ChatMessageAttachment[][]): ChatMessageAttachment[] {
  const merged = new Map<string, ChatMessageAttachment>();
  for (const group of groups) {
    for (const attachment of group) {
      const key = attachment.path || attachment.name;
      const existing = merged.get(key);
      merged.set(key, {
        ...existing,
        ...attachment,
        content: attachment.content ?? existing?.content,
        size: attachment.size ?? existing?.size,
      });
    }
  }
  return Array.from(merged.values());
}

function fingerprintUserMessage(text: string, attachments: ChatMessageAttachment[]): string {
  const paths = attachments.map((attachment) => attachment.path).sort();
  return JSON.stringify({ text: text.trim(), paths });
}

function extractMessageDisplay(message: AgentMessage): MessageDisplay {
  if (message.role === "custom" && message.customType === "pi.ui_note" && isRecord(message.details)) {
    return {
      text: typeof message.details.text === "string" ? message.details.text : "",
      attachments: [],
      noteKind: typeof message.details.kind === "string" ? message.details.kind : undefined,
    };
  }

  const rawText = extractContentText(message);
  const parsed = parseEmbeddedFileBlocks(rawText);
  const metadataAttachments = Array.isArray(message.attachments)
    ? message.attachments.map(normalizeAttachment).filter((a): a is ChatMessageAttachment => a !== null)
    : [];

  const displayText = typeof message.displayText === "string" ? message.displayText : undefined;
  const text = displayText !== undefined ? displayText : parsed.text;
  return {
    text: stripAcpDisplayTags(text),
    attachments: mergeAttachments(metadataAttachments, parsed.attachments),
  };
}

/** Seam-dedup message key: role:timestamp:textLength (Plan 4.7.2). */
function foldKeyOf(message: AgentMessage): string {
  return `${message.role}:${String(message.timestamp)}:${extractContentText(message).length}`;
}

/** The seam-dedup key rule only covers user/custom/assistant messages. */
function isFoldableRole(role: string | undefined): boolean {
  return role === "user" || role === "custom" || role === "assistant";
}

/** Build the AgentMessage view of a type==="custom_message" disk entry. */
function customMessageFromEntry(entry: Record<string, unknown>): AgentMessage {
  const entryTimestamp = typeof entry.timestamp === "number" ? entry.timestamp : new Date(String(entry.timestamp)).getTime();
  return {
    role: "custom",
    customType: typeof entry.customType === "string" ? entry.customType : undefined,
    content: entry.content as AgentMessage["content"],
    display: entry.display !== false,
    details: entry.details,
    ...(entry.context === "internal" ? { context: "internal" } : {}),
    timestamp: Number.isFinite(entryTimestamp) ? entryTimestamp : Date.now(),
  };
}

const ERROR_SUMMARY_MAX_CHARS = 120;

function truncateErrorSummary(message: string, maxChars = ERROR_SUMMARY_MAX_CHARS): string {
  const chars = Array.from(message);
  if (chars.length <= maxChars) return message;
  return `${chars.slice(0, maxChars).join("")}...`;
}

/** Seconds remaining until timestamp+delayMs, floored at 0. */
export function remainingSeconds(timestamp: number, delayMs: number, now: number): number {
  return Math.max(0, Math.ceil((timestamp + delayMs - now) / 1000));
}

export function createDisplayBlockAssembler(options: DisplayBlockAssemblerOptions = {}): DisplayBlockAssembler {
  const renderTeamLeaderNotes = options.teamLeader === true;
  const blocks = options.blocks ?? [];

  let currentAgentBlockId: string | null = null;
  let currentWorkStatusId: string | null = null;
  // Latest thinking block that has not been superseded yet. Superseding (first
  // text / tool call / agent end) clears it; thinking_end deliberately does not,
  // so the next move can still locate the block.
  let openThinkingBlockId: string | null = null;
  let legacyVisionStatusId: string | null = null;
  let visionStatusIds = new Map<string, string>();
  let optimisticUserMessages: Array<{ blockId: string; fingerprint: string; separatorId: string | null }> = [];
  let lastRetryableError: { blockId: string } | null = null;
  // Messages already folded from disk (loadEntries) or closed by a live
  // message_end. Seam dedup rule 2: matching live message_start/update/end
  // events are dropped, so the same message folds only once.
  let foldedMessageKeys = new Set<string>();

  // id→block 加速索引（perf SDD §3.8）。不变量：任意操作后
  // blockById.size === blocks.length，且 map.get(id) === 数组里同 id 的元素
  // （同一对象身份）。blocks 数组仍是唯一对外真源。
  // 所有按 id 查找的内部路径走 Map；创建/移除路径同步维护。
  const blockById = new Map<string, DisplayBlock>();

  /**
   * Index whatever identity `blocks[i]` currently yields. Session-store /
   * TaskTranscriptView / worker-thinking inject a Vue reactive array:
   * `push(plain)` stores the raw object, but reading `blocks[i]` returns the
   * reactive proxy. The Map must hold that proxy so in-place field writes
   * (thinking content, agent text, tool results) trigger Vue. Plain arrays
   * (unit tests) yield the same object either way.
   */
  function reindexAll(): void {
    blockById.clear();
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      blockById.set(block.id, block);
    }
  }

  reindexAll();

  /** Append a block and index the array-visible identity, not the raw argument. */
  function pushBlock(block: DisplayBlock): void {
    const index = blocks.length;
    blocks.push(block);
    const stored = blocks[index]!;
    blockById.set(stored.id, stored);
  }

  /** Filter blocks in place; the injected array may be a Vue reactive array,
   * so the reference is never swapped — only mutated. */
  function removeBlocks(keep: (block: DisplayBlock) => boolean): void {
    let write = 0;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (keep(block)) {
        blocks[write++] = block;
      }
    }
    if (write < blocks.length) blocks.length = write;
    reindexAll();
  }

  /** Drop assembler pointers that refer to blocks just trimmed from the head. */
  function dropRefsTo(removedIds: Set<string>): void {
    if (removedIds.size === 0) return;
    if (openThinkingBlockId && removedIds.has(openThinkingBlockId)) openThinkingBlockId = null;
    if (currentAgentBlockId && removedIds.has(currentAgentBlockId)) currentAgentBlockId = null;
    if (currentWorkStatusId && removedIds.has(currentWorkStatusId)) currentWorkStatusId = null;
    if (legacyVisionStatusId && removedIds.has(legacyVisionStatusId)) legacyVisionStatusId = null;
    if (lastRetryableError && removedIds.has(lastRetryableError.blockId)) lastRetryableError = null;
    for (const [key, blockId] of visionStatusIds) {
      if (removedIds.has(blockId)) visionStatusIds.delete(key);
    }
    optimisticUserMessages = optimisticUserMessages.filter(
      (item) => !removedIds.has(item.blockId) && (item.separatorId === null || !removedIds.has(item.separatorId)),
    );
  }

  /**
   * End the open thinking block (thinking_end, or the next move — first text,
   * tool call, agent end — starting). A non-empty chain-of-thought block stays
   * in the timeline collapsed (superseded); the empty placeholder is removed
   * so a model without thinking looks exactly like before.
   */
  function supersedeOpenThinking(): void {
    if (!openThinkingBlockId) return;
    const blockId = openThinkingBlockId;
    const block = blockById.get(blockId);
    if (block && block.type === "thinking") {
      block.phase = "ended";
      block.superseded = true;
      if (block.content === "") {
        removeBlocks((item) => item.id !== blockId);
      }
    }
    openThinkingBlockId = null;
  }

  function showThinkingBlock(timestamp = Date.now()): void {
    if (openThinkingBlockId) return;
    const block: DisplayBlock = {
      id: nextBlockId(),
      type: "thinking",
      content: "",
      phase: "streaming",
      superseded: false,
      timestamp,
    };
    openThinkingBlockId = block.id;
    pushBlock(block);
  }

  /**
   * Consume the assistantMessageEvent streamed inside message_update (PiX 1.5).
   * thinking_start reuses the placeholder block from the user turn; deltas
   * append to the open block; thinking_end marks it ended but keeps it open so
   * the next move (text / tool call) supersedes it; toolcall_start supersedes
   * immediately (it arrives before tool_execution_start — first one wins).
   * text_start / text_delta are folded by the text branch in message_update.
   */
  function applyAssistantMessageEvent(ame: AssistantMessageEventLike, timestamp: number): void {
    switch (ame.type) {
      case "thinking_start": {
        // Adjacent thinking segment (两段思考之间无正文/工具事件): thinking_end
        // keeps the block open, so an ended open block means a new segment
        // starts — supersede it first so each segment folds into its own block
        // (matches the replay path, which folds each thinking block separately).
        const openBlock = openThinkingBlockId ? blockById.get(openThinkingBlockId) : null;
        if (openBlock && openBlock.type === "thinking" && openBlock.phase === "ended") {
          supersedeOpenThinking();
        }
        if (!openThinkingBlockId) showThinkingBlock(timestamp);
        break;
      }
      case "thinking_delta": {
        if (!openThinkingBlockId) showThinkingBlock(timestamp);
        const block = openThinkingBlockId ? blockById.get(openThinkingBlockId) : null;
        if (block && block.type === "thinking" && typeof ame.delta === "string") {
          block.content = stripAcpDisplayTags(block.content + ame.delta);
        }
        break;
      }
      case "thinking_end": {
        const block = openThinkingBlockId ? blockById.get(openThinkingBlockId) : null;
        if (block && block.type === "thinking") {
          // Redacted thinking (Anthropic safety filter) and any provider that
          // emits no thinking_delta: the final value only arrives here.
          // Backfill an empty block so it survives into the timeline instead of
          // being removed at the first output (直播/回放一致).
          if (block.content === "" && typeof ame.content === "string" && ame.content !== "") {
            block.content = stripAcpDisplayTags(ame.content);
          }
          block.phase = "ended";
        }
        // openThinkingBlockId stays set: the next move supersedes (and clears) it.
        break;
      }
      case "toolcall_start":
        supersedeOpenThinking();
        break;
      // text_start / text_delta: the first text folds below via
      // createAgentBlock, which runs the supersede semantics internally.
    }
  }

  function appendTurnSeparator(timestamp = Date.now()): string | null {
    const last = blocks.at(-1);
    if (!last || last.type === "turn-separator") return null;
    const id = nextBlockId();
    pushBlock({ id, type: "turn-separator", timestamp });
    return id;
  }

  function appendUserOrNoteMessage(msg: AgentMessage, showLiveThinking = false): boolean {
    const rawText = extractContentText(msg).trimStart();
    // Older sessions may have stored an internal envelope under a generic
    // custom type. Reserved envelope roots are runtime signals regardless of
    // the message role or custom type.
    if ((msg.role === "user" || msg.role === "custom") && isLegacyInternalNotificationText(rawText)) {
      return false;
    }
    if (msg.role === "user") {
      // Older sessions stored team/runtime signals as ordinary user messages.
      // They are compatibility payloads, not user-authored chat, so do not
      // resurrect them as bubbles or notes after a reload.
      // Unreachable for closed <orchestrator-event> envelopes (legacy hide
      // above). Left so a non-closed wake payload can still render a note.
      if (renderTeamLeaderNotes && rawText.startsWith("<orchestrator-event>")) {
        pushBlock({
          id: nextBlockId(),
          type: "note",
          text: summarizeOrchestratorEvent(rawText),
          timestamp: messageTimestamp(msg),
        });
        if (showLiveThinking) showThinkingBlock(messageTimestamp(msg));
        return false;
      }
      // Steered worker report: render as a styled note, not a fake "user" bubble.
      const teammateNote = renderTeamLeaderNotes ? parseTeammateMessageNote(rawText) : null;
      if (teammateNote) {
        pushBlock({
          id: nextBlockId(),
          type: "note",
          text: teammateNote,
          timestamp: messageTimestamp(msg),
        });
        return false;
      }
    }

    const display = extractMessageDisplay(msg);
    if (msg.role === "custom" && display.noteKind && display.noteKind !== "user_command") {
      if (display.text) {
        pushBlock({
          id: nextBlockId(),
          type: "note",
          text: display.text,
          timestamp: messageTimestamp(msg),
        });
      }
      return true;
    }

    if (display.text || display.attachments.length > 0) {
      closeCurrentWorkStatus(true);
      if (msg.role === "user") {
        const fingerprint = fingerprintUserMessage(display.text, display.attachments);
        const optimistic = optimisticUserMessages.find((item) => item.fingerprint === fingerprint);
        if (optimistic) {
          const optimisticBlock = blockById.get(optimistic.blockId);
          if (optimisticBlock && optimisticBlock.type === "user-message") {
            optimisticBlock.text = display.text;
            optimisticBlock.attachments = display.attachments;
            optimisticBlock.timestamp = messageTimestamp(msg);
          }
          optimisticUserMessages = optimisticUserMessages.filter((item) => item.blockId !== optimistic.blockId);
          return true;
        }
        appendTurnSeparator(messageTimestamp(msg));
      }
      pushBlock({
        id: nextBlockId(),
        type: "user-message",
        text: display.text,
        attachments: display.attachments,
        timestamp: messageTimestamp(msg),
      });
      return true;
    }
    return false;
  }

  function appendOptimisticUserMessage(
    text: string,
    filePaths: string[] = [],
    clipboardImages: Array<{ mimeType: string }> = [],
  ): string | null {
    const attachments = [
      ...filePaths.map(attachmentFromPath),
      ...clipboardImages.map((image, index) => clipboardImageAttachment(index, image.mimeType)),
    ];
    if (!text.trim() && attachments.length === 0) return null;

    // Starting a new turn invalidates the retry affordance on any prior error.
    lastRetryableError = null;
    const timestamp = Date.now();
    closeCurrentWorkStatus(true);
    const separatorId = appendTurnSeparator(timestamp);
    const block: DisplayBlock = {
      id: nextBlockId(),
      type: "user-message",
      text: text.trim(),
      attachments,
      timestamp,
    };
    pushBlock(block);
    optimisticUserMessages.push({
      blockId: block.id,
      fingerprint: fingerprintUserMessage(text, attachments),
      separatorId,
    });
    return block.id;
  }

  function failOptimisticUserMessage(blockId: string | null, message: string): void {
    if (!blockId) return;
    const optimistic = optimisticUserMessages.find((item) => item.blockId === blockId);
    if (!optimistic) return;

    const removeIds = new Set([optimistic.blockId]);
    if (optimistic.separatorId) removeIds.add(optimistic.separatorId);
    removeBlocks((block) => !removeIds.has(block.id));
    optimisticUserMessages = optimisticUserMessages.filter((item) => item.blockId !== blockId);

    pushBlock({
      id: nextBlockId(),
      type: "error",
      message,
      source: "发送",
      timestamp: Date.now(),
    });
  }

  function showVisionStatus(event: Extract<AgentSessionEvent, { type: "eye_model_start" }>): void {
    const block: DisplayBlock = {
      id: nextBlockId(),
      type: "vision-status",
      provider: event.provider,
      modelId: event.modelId,
      imageCount: event.imageCount,
      status: "running",
      timestamp: Date.now(),
    };
    if (event.id) {
      visionStatusIds.set(event.id, block.id);
    } else {
      legacyVisionStatusId = block.id;
    }
    pushBlock(block);
  }

  function finishVisionStatus(event: Extract<AgentSessionEvent, { type: "eye_model_end" }>): void {
    const blockId = event.id ? visionStatusIds.get(event.id) : legacyVisionStatusId;
    const block = blockId ? blockById.get(blockId) : null;
    if (block && block.type === "vision-status") {
      block.status = event.success ? "success" : "error";
      block.timestamp = Date.now();
      if (event.id) {
        visionStatusIds.delete(event.id);
      } else {
        legacyVisionStatusId = null;
      }
      return;
    }
    pushBlock({
      id: nextBlockId(),
      type: "vision-status",
      provider: event.provider,
      modelId: event.modelId,
      imageCount: event.imageCount,
      status: event.success ? "success" : "error",
      timestamp: Date.now(),
    });
  }

  function closeCurrentWorkStatus(force = false): void {
    const ws = currentWorkStatusId ? blockById.get(currentWorkStatusId) : null;
    if (ws && ws.type === "work-status") {
      const hasPending = ws.tools.some((tool) => tool.result === null);
      if (ws.tools.length === 0) {
        // No tools were executed — remove the empty "thinking" block entirely
        removeBlocks((block) => block.id !== ws.id);
        currentWorkStatusId = null;
      } else if (!hasPending || force) {
        // All tools done, or agent ended (force) — mark as finished
        ws.isStreaming = false;
        currentWorkStatusId = null;
      }
      // else: tools still pending — keep currentWorkStatusId so we can
      // find and close this block when tools finish
    } else {
      currentWorkStatusId = null;
    }
  }

  function createAgentBlock(text: string, isStreamingBlock: boolean, timestamp = Date.now()): string {
    supersedeOpenThinking();
    closeCurrentWorkStatus();
    const block: DisplayBlock = {
      id: nextBlockId(),
      type: "agent-message",
      content: stripAcpDisplayTags(text),
      isStreaming: isStreamingBlock,
      timestamp,
    };
    pushBlock(block);
    return block.id;
  }

  function ensureWorkStatusBlock(timestamp = Date.now()): Extract<DisplayBlock, { type: "work-status" }> {
    if (!currentWorkStatusId) {
      const wsBlock: DisplayBlock = {
        id: nextBlockId(),
        type: "work-status",
        tools: [],
        isStreaming: true,
        timestamp,
      };
      currentWorkStatusId = wsBlock.id;
      pushBlock(wsBlock);
    }
    const ws = blockById.get(currentWorkStatusId);
    if (!ws || ws.type !== "work-status") {
      throw new Error("创建工作状态块失败");
    }
    return ws;
  }

  function findWorkStatusForTool(toolCallId: string): Extract<DisplayBlock, { type: "work-status" }> | null {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block.type === "work-status" && block.tools.some((tool) => tool.toolCallId === toolCallId)) {
        return block;
      }
    }
    return null;
  }

  function applyEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start": {
        lastRetryableError = null;
        break;
      }
      case "agent_end": {
        currentAgentBlockId = null;
        supersedeOpenThinking();
        closeCurrentWorkStatus(true);
        break;
      }

      case "message_start": {
        const msg = event.message;
        if (isFoldableRole(msg.role) && foldedMessageKeys.has(foldKeyOf(msg))) break;
        if (msg.role === "user" || msg.role === "custom") {
          if (isInternalCustomMessage(msg)) {
            if (isFoldableRole(msg.role)) foldedMessageKeys.add(foldKeyOf(msg));
            break;
          }
          if (msg.role === "custom" && msg.display === false) break;
          const appended = appendUserOrNoteMessage(msg, true);
          if (msg.role === "user" && appended) {
            showThinkingBlock(messageTimestamp(msg));
          }
        } else if (msg.role === "assistant") {
          const text = extractContentText(msg);
          // Only create agent block when there's real text — skip empty tool-call-only messages
          if (text) {
            currentAgentBlockId = createAgentBlock(text, true);
          }
        }
        break;
      }
      case "message_update": {
        const msg = event.message;
        if (isFoldableRole(msg.role) && foldedMessageKeys.has(foldKeyOf(msg))) break;
        if (msg.role === "assistant") {
          // Consume the streamed assistantMessageEvent (thinking / tool call
          // markers) before the text fold: a pure tool turn has no text
          // content, and the early return below would skip toolcall_start's
          // supersede.
          if (isAssistantMessageEvent(event.assistantMessageEvent)) {
            applyAssistantMessageEvent(event.assistantMessageEvent, messageTimestamp(msg));
          }
          const text = extractContentText(msg);
          if (!text) return;
          supersedeOpenThinking();
          if (!currentAgentBlockId) {
            // First text in this response — create the agent block now
            currentAgentBlockId = createAgentBlock(text, true);
          } else {
            const block = blockById.get(currentAgentBlockId);
            if (block && block.type === "agent-message") {
              block.content = stripAcpDisplayTags(text);
            }
          }
        }
        break;
      }
      case "message_end": {
        const msg = event.message;
        if (isFoldableRole(msg.role) && foldedMessageKeys.has(foldKeyOf(msg))) break;
        if (currentAgentBlockId) {
          const block = blockById.get(currentAgentBlockId);
          if (block && block.type === "agent-message") {
            block.isStreaming = false;
          }
          currentAgentBlockId = null;
        }
        if (isFoldableRole(msg.role)) {
          foldedMessageKeys.add(foldKeyOf(msg));
        }
        break;
      }

      // Tool lifecycle — aggregate into a single work-status block
      case "eye_model_start": {
        showVisionStatus(event);
        break;
      }

      case "eye_model_end": {
        finishVisionStatus(event);
        break;
      }

      case "tool_execution_start": {
        // Seam dedup rule 1: a toolCallId executes once per session — drop a
        // start whose tool already exists in any work-status block (e.g. the
        // live replay of a tool that was folded from disk).
        if (findWorkStatusForTool(event.toolCallId)) break;
        supersedeOpenThinking();
        ensureWorkStatusBlock().tools.push({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          result: null,
          isError: false,
        });
        break;
      }
      case "tool_execution_update": {
        const ws = findWorkStatusForTool(event.toolCallId);
        if (ws && ws.type === "work-status") {
          const tool = ws.tools.find((t) => t.toolCallId === event.toolCallId);
          if (tool) tool.result = event.partialResult;
        }
        break;
      }
      case "tool_execution_end": {
        const ws = findWorkStatusForTool(event.toolCallId);
        if (ws && ws.type === "work-status") {
          const tool = ws.tools.find((t) => t.toolCallId === event.toolCallId);
          if (tool) {
            tool.result = event.result;
            tool.isError = event.isError;
          }
          // Finalize if no more pending tools
          const hasPending = ws.tools.some((t) => t.result === null);
          if (!hasPending) {
            ws.isStreaming = false;
          }
        }
        break;
      }
      case "file_change": {
        const ws = findWorkStatusForTool(event.toolCallId);
        if (ws && ws.type === "work-status") {
          const tool = ws.tools.find((t) => t.toolCallId === event.toolCallId);
          if (tool) {
            tool.fileChange = event.change;
            tool.diff = { added: event.change.added, removed: event.change.removed };
          }
        }
        break;
      }
      case "verification_gate": {
        break;
      }

      case "compaction_start": {
        pushBlock({
          id: nextBlockId(),
          type: "compaction",
          reason: event.reason,
          result: "",
          aborted: false,
          timestamp: Date.now(),
        });
        break;
      }
      case "compaction_end": {
        const compactionSummary =
          (event.result && typeof event.result === "object" && "summary" in event.result
            ? String((event.result as Record<string, unknown>).summary)
            : undefined) ||
          event.errorMessage ||
          "压缩完成";
        pushBlock({
          id: nextBlockId(),
          type: "compaction",
          reason: event.reason,
          result: compactionSummary,
          aborted: event.aborted,
          timestamp: Date.now(),
        });
        break;
      }

      case "auto_retry_start": {
        pushBlock({
          id: nextBlockId(),
          type: "retry",
          success: false,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          category: event.category,
          errorSummary: truncateErrorSummary(event.errorMessage),
          retryAfterMs: event.retryAfterMs,
          timestamp: Date.now(),
        });
        break;
      }
      case "auto_retry_end": {
        // Settle the in-flight retry block so its cancel button cannot abort a
        // later turn's sleep. Success rewrites that block in place (keeps one
        // notice); failure/cancel only drops delayMs so RetryNotice hides cancel.
        let settled = false;
        for (let i = blocks.length - 1; i >= 0; i--) {
          const block = blocks[i];
          if (block.type === "retry" && !block.success && block.delayMs !== undefined) {
            if (event.success) {
              block.success = true;
              block.attempt = event.attempt;
              block.maxAttempts = 0;
            }
            block.delayMs = undefined;
            settled = true;
            break;
          }
        }
        if (event.success && !settled) {
          pushBlock({
            id: nextBlockId(),
            type: "retry",
            success: true,
            attempt: event.attempt,
            maxAttempts: 0,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case "api_error": {
        const blockId = nextBlockId();
        pushBlock({
          id: blockId,
          type: "error",
          message: event.errorMessage,
          category: event.category,
          httpStatus: event.httpStatus,
          title: event.title,
          retryable: event.retryable,
          autoRetried: event.autoRetried,
          retryAfterMs: event.retryAfterMs,
          timestamp: Date.now(),
        });
        // Only the latest retryable error (while idle) offers a retry button.
        lastRetryableError = event.retryable ? { blockId } : null;
        break;
      }

      case "queue_update": {
        break;
      }
    }
  }

  function applyEvents(events: AgentSessionEvent[]): void {
    for (const event of events) {
      applyEvent(event);
    }
  }

  /** Fold a type==="custom_message" entry into a note block (Plan 4.7). */
  function foldCustomMessageEntry(entry: Record<string, unknown>): void {
    const msg = customMessageFromEntry(entry);
    if (
      isInternalCustomMessage(msg) ||
      entry.display === false ||
      isLegacyInternalNotificationText(extractContentText(msg))
    ) {
      foldedMessageKeys.add(foldKeyOf(msg));
      return;
    }
    const display = extractMessageDisplay(msg);
    if (display.text) {
      pushBlock({
        id: nextBlockId(),
        type: "note",
        text: display.text,
        timestamp: messageTimestamp(msg),
      });
    }
    foldedMessageKeys.add(foldKeyOf(msg));
  }

  /**
   * Load messages from history.
   * AgentMessage = Message (from pi-ai) | CustomAgentMessages.
   * - AssistantMessage: content has TextContent | ThinkingContent | ToolCall blocks
   * - ToolResultMessage: role="toolResult", has toolCallId, toolName, content, isError
   */
  function loadEntries(entries: unknown[]): void {
    clear();

    const toolsById = new Map<string, ToolWorkItem>();

    function appendToolCall(block: { type: string; id?: string; name?: string; arguments?: unknown }, timestamp: number): void {
      const toolCallId = block.id || nextBlockId();
      const ws = ensureWorkStatusBlock(timestamp);
      const item: ToolWorkItem = {
        toolCallId,
        toolName: block.name || "任务",
        args: block.arguments,
        result: null,
        isError: false,
      };
      ws.tools.push(item);
      toolsById.set(toolCallId, item);
    }

    function finalizeWorkBlocks(): void {
      for (const block of blocks) {
        if (block.type === "work-status") {
          block.isStreaming = false;
        }
      }
      currentWorkStatusId = null;
    }

    // Fold only message/custom_message entries; other entry types are skipped.
    const foldedEntries: Array<{ entry: Record<string, unknown>; message: AgentMessage | null }> = [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      if (entry.type === "message" && isRecord(entry.message) && typeof entry.message.role === "string") {
        foldedEntries.push({ entry, message: entry.message as AgentMessage });
      } else if (entry.type === "custom_message") {
        foldedEntries.push({ entry, message: null });
      }
    }

    // The retry button belongs on the most recent failed assistant turn, but a
    // failed turn is not necessarily the last array element: agent-session's
    // finally block flushes pending bash toolResult messages after it. Track
    // the last assistant index so trailing tool results do not hide the button.
    let lastAssistantIndex = -1;
    for (let i = 0; i < foldedEntries.length; i++) {
      const message = foldedEntries[i].message;
      if (message && message.role === "assistant") lastAssistantIndex = i;
    }

    for (let i = 0; i < foldedEntries.length; i++) {
      const { message } = foldedEntries[i];
      if (!message) {
        foldCustomMessageEntry(foldedEntries[i].entry);
        continue;
      }

      const msg = message;
      if (msg.role === "user" || msg.role === "custom") {
        if (isInternalCustomMessage(msg)) {
          if (isFoldableRole(msg.role)) foldedMessageKeys.add(foldKeyOf(msg));
          continue;
        }
        if (msg.role === "custom" && msg.display === false) {
          if (isFoldableRole(msg.role)) foldedMessageKeys.add(foldKeyOf(msg));
          continue;
        }
        appendUserOrNoteMessage(msg);
      } else if (msg.role === "assistant") {
        const timestamp = messageTimestamp(msg);
        // A failed assistant turn (stopReason "error") carries its details in
        // errorMessage, not in content (which is empty). Render it as an error
        // block so the failure survives reloads / mode switches / restarts.
        if (msg.stopReason === "error" && typeof msg.errorMessage === "string" && msg.errorMessage) {
          const classified = classifyApiError(msg.errorMessage);
          const apiError = isRecord(msg.apiError) ? msg.apiError : undefined;
          const structuredStatus = typeof apiError?.status === "number" ? apiError.status : undefined;
          const structuredRetryAfterMs =
            typeof apiError?.retryAfterMs === "number" ? apiError.retryAfterMs : undefined;
          const errorBlockId = nextBlockId();
          pushBlock({
            id: errorBlockId,
            type: "error",
            message: msg.errorMessage,
            category: classified.category,
            httpStatus: structuredStatus ?? classified.httpStatus,
            title: classified.title,
            retryable: classified.retryable,
            retryAfterMs: structuredRetryAfterMs,
            timestamp,
          });
          // Keep the retry affordance for the latest error after a reload: the
          // solo session persists across mode switches, so retryLastTurn still
          // works. Match the last *assistant* message (not the last array
          // element: a failed turn can be followed by flushed bash toolResult
          // messages). Historical errors render without a button.
          if (i === lastAssistantIndex && classified.retryable) {
            lastRetryableError = { blockId: errorBlockId };
          }
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
              createAgentBlock(block.text, false, timestamp);
            } else if (block.type === "toolCall") {
              appendToolCall(block as { type: string; id?: string; name?: string; arguments?: unknown }, timestamp);
            } else if (block.type === "thinking") {
              // Fold persisted chain-of-thought in content order. Replay is a
              // settled turn, so thinking blocks fold collapsed (superseded).
              // Empty thinking blocks (redacted placeholder notes included)
              // are skipped — no blank placeholder blocks.
              const thinking = (block as { thinking?: unknown }).thinking;
              if (typeof thinking === "string" && thinking !== "") {
                pushBlock({
                  id: nextBlockId(),
                  type: "thinking",
                  content: stripAcpDisplayTags(thinking),
                  phase: "ended",
                  superseded: true,
                  timestamp,
                });
              }
            }
          }
        } else {
          const text = extractContentText(msg);
          if (text) createAgentBlock(text, false, timestamp);
        }
      } else if (msg.role === "toolResult") {
        // Match tool result to pending tool
        const tr = msg as {
          role: string; toolCallId: string; toolName: string;
          content: Array<{ type: string; text?: string }>;
          isError: boolean;
          details?: unknown;
        };
        const tool = toolsById.get(tr.toolCallId);
        if (tool) {
          // The `agent` / `workflow` / `ralph` tools keep the full
          // { content, details } result shape on replay so their rich renderers
          // (SubagentToolView / WorkflowRunPanel) can draw from the persisted
          // details; other tools keep the legacy content-only shape to avoid
          // replay bloat.
          tool.result =
            tr.toolName === "agent" || tr.toolName === "workflow" || tr.toolName === "ralph"
              ? { content: tr.content, details: tr.details }
              : tr.content;
          tool.isError = tr.isError;
          if (!tool.toolName && tr.toolName) tool.toolName = tr.toolName;
        }
      }

      if (isFoldableRole(msg.role)) {
        foldedMessageKeys.add(foldKeyOf(msg));
      }
    }

    finalizeWorkBlocks();
  }

  function clear(): void {
    blocks.splice(0, blocks.length);
    blockById.clear();
    currentAgentBlockId = null;
    currentWorkStatusId = null;
    openThinkingBlockId = null;
    legacyVisionStatusId = null;
    visionStatusIds = new Map();
    optimisticUserMessages = [];
    lastRetryableError = null;
    foldedMessageKeys = new Set();
  }

  /** perf SDD §4.3：块数达到 maxBlocks 时从头部修剪至 floor(maxBlocks/2)。 */
  function enforceBlockCap(maxBlocks: number): number {
    if (blocks.length < maxBlocks) return 0;
    const targetLength = Math.floor(maxBlocks / 2);
    const removeCount = blocks.length - targetLength;
    const removedIds = new Set<string>();
    for (let i = 0; i < removeCount; i++) {
      removedIds.add(blocks[i].id);
    }
    blocks.splice(0, removeCount);
    reindexAll();
    dropRefsTo(removedIds);
    return removeCount;
  }

  return {
    blocks,
    blockById,
    applyEvent,
    applyEvents,
    loadEntries,
    clear,
    enforceBlockCap,
    appendOptimisticUserMessage,
    failOptimisticUserMessage,
    get lastRetryableError() {
      return lastRetryableError;
    },
  };
}
