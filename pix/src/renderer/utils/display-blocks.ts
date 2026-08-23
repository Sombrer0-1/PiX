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
  /** 直播事件折叠(即现 session-store.processEvent 语义 + 4.7.2 去重规则)。 */
  applyEvent(event: AgentSessionEvent): void;
  applyEvents(events: AgentSessionEvent[]): void;
  /**
   * 回放装载(全量重折叠语义):先 clear 再按序折叠传入的完整条目数组。
   * 幂等:同一数组重复调用结果一致。分页追加由调用方(store)拼全量数组后整体重折叠,
   * 组装器自身不提供 append 语义(与现 loadMessages 的 clear-then-fold 一致)。
   * 条目口径:type==="message" 走现有消息路径;type==="custom_message" 且
   * display!==false 折叠为 note 块(恢复说明等;display===false 跳过);其余类型跳过。
   */
  loadEntries(entries: unknown[]): void;
  clear(): void;
  /** 乐观用户消息(任务 transcript 不使用)。 */
  appendOptimisticUserMessage(text: string, filePaths?: string[]): string | null;
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

/**
 * Turn a steered <teammate-message> (worker report injected into the Leader
 * session) into a compact human-readable note, or null if the text is not a
 * teammate message.
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
 * Produce a one-line summary of an internal <orchestrator-event> prompt so the
 * user sees WHY the leader is suddenly responding, without exposing the full
 * internal coordination payload.
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
  return {
    text: displayText !== undefined ? displayText : parsed.text,
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
    timestamp: Number.isFinite(entryTimestamp) ? entryTimestamp : Date.now(),
  };
}

export function createDisplayBlockAssembler(options: DisplayBlockAssemblerOptions = {}): DisplayBlockAssembler {
  const renderTeamLeaderNotes = options.teamLeader === true;
  const blocks = options.blocks ?? [];

  let currentAgentBlockId: string | null = null;
  let currentWorkStatusId: string | null = null;
  let currentThinkingBlockId: string | null = null;
  let legacyVisionStatusId: string | null = null;
  let visionStatusIds = new Map<string, string>();
  let optimisticUserMessages: Array<{ blockId: string; fingerprint: string; separatorId: string | null }> = [];
  let lastRetryableError: { blockId: string } | null = null;
  // Messages already folded from disk (loadEntries) or closed by a live
  // message_end. Seam dedup rule 2: matching live message_start/update/end
  // events are dropped, so the same message folds only once.
  let foldedMessageKeys = new Set<string>();

  /** Filter blocks in place; the injected array may be a Vue reactive array,
   * so the reference is never swapped — only mutated. */
  function removeBlocks(keep: (block: DisplayBlock) => boolean): void {
    let write = 0;
    for (let i = 0; i < blocks.length; i++) {
      if (keep(blocks[i])) blocks[write++] = blocks[i];
    }
    if (write < blocks.length) blocks.length = write;
  }

  function removeThinkingBlock(): void {
    if (!currentThinkingBlockId) return;
    const blockId = currentThinkingBlockId;
    removeBlocks((block) => block.id !== blockId);
    currentThinkingBlockId = null;
  }

  function showThinkingBlock(timestamp = Date.now()): void {
    if (currentThinkingBlockId) return;
    const block: DisplayBlock = {
      id: nextBlockId(),
      type: "thinking",
      timestamp,
    };
    currentThinkingBlockId = block.id;
    blocks.push(block);
  }

  function appendTurnSeparator(timestamp = Date.now()): string | null {
    const last = blocks.at(-1);
    if (!last || last.type === "turn-separator") return null;
    const id = nextBlockId();
    blocks.push({
      id,
      type: "turn-separator",
      timestamp,
    });
    return id;
  }

  function appendUserOrNoteMessage(msg: AgentMessage, showLiveThinking = false): boolean {
    if (msg.role === "user") {
      const rawText = extractContentText(msg).trimStart();
      // Internal orchestration turn: show a compact note (so the leader's
      // upcoming response has visible context) instead of the raw payload,
      // plus the thinking indicator since a leader turn is starting.
      if (renderTeamLeaderNotes && rawText.startsWith("<orchestrator-event>")) {
        blocks.push({
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
        blocks.push({
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
        blocks.push({
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
          const optimisticBlock = blocks.find((block) => block.id === optimistic.blockId);
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
      blocks.push({
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

  function appendOptimisticUserMessage(text: string, filePaths: string[] = []): string | null {
    const attachments = filePaths.map(attachmentFromPath);
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
    blocks.push(block);
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

    blocks.push({
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
    blocks.push(block);
  }

  function finishVisionStatus(event: Extract<AgentSessionEvent, { type: "eye_model_end" }>): void {
    const blockId = event.id ? visionStatusIds.get(event.id) : legacyVisionStatusId;
    const block = blockId
      ? blocks.find((item) => item.id === blockId && item.type === "vision-status")
      : null;
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
    blocks.push({
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
    const ws = currentWorkStatusId
      ? blocks.find((b) => b.id === currentWorkStatusId && b.type === "work-status")
      : null;
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
    removeThinkingBlock();
    closeCurrentWorkStatus();
    const block: DisplayBlock = {
      id: nextBlockId(),
      type: "agent-message",
      content: text,
      isStreaming: isStreamingBlock,
      timestamp,
    };
    blocks.push(block);
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
      blocks.push(wsBlock);
    }
    const ws = blocks.find(
      (b) => b.id === currentWorkStatusId && b.type === "work-status"
    );
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
        removeThinkingBlock();
        closeCurrentWorkStatus(true);
        break;
      }

      case "message_start": {
        const msg = event.message;
        if (isFoldableRole(msg.role) && foldedMessageKeys.has(foldKeyOf(msg))) break;
        if (msg.role === "user" || msg.role === "custom") {
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
          const text = extractContentText(msg);
          if (!text) return;
          removeThinkingBlock();
          if (!currentAgentBlockId) {
            // First text in this response — create the agent block now
            currentAgentBlockId = createAgentBlock(text, true);
          } else {
            const block = blocks.find((b) => b.id === currentAgentBlockId);
            if (block && block.type === "agent-message") {
              block.content = text;
            }
          }
        }
        break;
      }
      case "message_end": {
        const msg = event.message;
        if (isFoldableRole(msg.role) && foldedMessageKeys.has(foldKeyOf(msg))) break;
        if (currentAgentBlockId) {
          const block = blocks.find((b) => b.id === currentAgentBlockId);
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
        removeThinkingBlock();
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
        blocks.push({
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
        blocks.push({
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
        blocks.push({
          id: nextBlockId(),
          type: "retry",
          success: false,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          timestamp: Date.now(),
        });
        break;
      }
      case "auto_retry_end": {
        // On success, show a "retry succeeded" notice. On failure, skip the
        // block here - the subsequent api_error event surfaces the full error
        // (status code + retry button) and a second "retry failed" notice
        // would be redundant.
        if (event.success) {
          blocks.push({
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
        blocks.push({
          id: blockId,
          type: "error",
          message: event.errorMessage,
          category: event.category,
          httpStatus: event.httpStatus,
          title: event.title,
          retryable: event.retryable,
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
    if (entry.display === false) return;
    const msg = customMessageFromEntry(entry);
    const display = extractMessageDisplay(msg);
    if (display.text) {
      blocks.push({
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
          const errorBlockId = nextBlockId();
          blocks.push({
            id: errorBlockId,
            type: "error",
            message: msg.errorMessage,
            category: classified.category,
            httpStatus: classified.httpStatus,
            title: classified.title,
            retryable: classified.retryable,
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
    currentAgentBlockId = null;
    currentWorkStatusId = null;
    currentThinkingBlockId = null;
    legacyVisionStatusId = null;
    visionStatusIds = new Map();
    optimisticUserMessages = [];
    lastRetryableError = null;
    foldedMessageKeys = new Set();
  }

  return {
    blocks,
    applyEvent,
    applyEvents,
    loadEntries,
    clear,
    appendOptimisticUserMessage,
    failOptimisticUserMessage,
    get lastRetryableError() {
      return lastRetryableError;
    },
  };
}
