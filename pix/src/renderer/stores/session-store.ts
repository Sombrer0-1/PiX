/**
 * Session Store
 *
 * Manages the current session's event stream and display blocks.
 * Transforms raw AgentSessionEvents into organized DisplayBlocks for rendering.
 *
 * Tool executions are aggregated into a single "work-status" block instead of
 * individual inline blocks. This keeps the chat mainline clean.
 */

import { defineStore } from "pinia";
import { ref } from "vue";
import type { AgentMessage, AgentSessionEvent } from "@/types/rpc";
import type { DisplayBlock, ToolWorkItem } from "@/types/session";

function nextBlockId(): string {
  return `block_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function extractMessageText(message: AgentMessage): string {
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

const MAX_EVENTS = 50000;
const MAX_DISPLAY_BLOCKS = 20000;

export const useSessionStore = defineStore("session", () => {
  const events = ref<AgentSessionEvent[]>([]);
  const displayBlocks = ref<DisplayBlock[]>([]);
  const isStreaming = ref(false);
  const errorMessage = ref<string | null>(null);

  let currentAgentBlockId: string | null = null;
  let currentWorkStatusId: string | null = null;

  function addEvent(event: AgentSessionEvent): void {
    if (events.value.length >= MAX_EVENTS) {
      events.value = events.value.slice(-Math.floor(MAX_EVENTS / 2));
    }
    if (displayBlocks.value.length >= MAX_DISPLAY_BLOCKS) {
      displayBlocks.value = displayBlocks.value.slice(-Math.floor(MAX_DISPLAY_BLOCKS / 2));
    }
    events.value.push(event);
    processEvent(event);
  }

  function processEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start": {
        isStreaming.value = true;
        errorMessage.value = null;
        displayBlocks.value.push({
          id: nextBlockId(),
          type: "status",
          status: "running",
          timestamp: Date.now(),
        });
        break;
      }
      case "agent_end": {
        isStreaming.value = false;
        currentAgentBlockId = null;
        currentWorkStatusId = null;
        displayBlocks.value.push({
          id: nextBlockId(),
          type: "status",
          status: "idle",
          timestamp: Date.now(),
        });
        break;
      }

      case "message_start": {
        const msg = event.message;
        if (msg.role === "user" || msg.role === "custom") {
          // New user message = new conversation turn
          currentWorkStatusId = null;
          const text = extractMessageText(msg);
          if (text) {
            displayBlocks.value.push({
              id: nextBlockId(),
              type: "user-message",
              text,
              timestamp: Date.now(),
            });
          }
        } else if (msg.role === "assistant") {
          const text = extractMessageText(msg);
          // Only create agent block when there's real text — skip empty tool-call-only messages
          if (text) {
            const block: DisplayBlock = {
              id: nextBlockId(),
              type: "agent-message",
              content: text,
              isStreaming: true,
              timestamp: Date.now(),
            };
            currentAgentBlockId = block.id;
            displayBlocks.value.push(block);
          }
        }
        break;
      }
      case "message_update": {
        const msg = event.message;
        if (msg.role === "assistant") {
          const text = extractMessageText(msg);
          if (!text) return;
          if (!currentAgentBlockId) {
            // First text in this response — create the agent block now
            const block: DisplayBlock = {
              id: nextBlockId(),
              type: "agent-message",
              content: text,
              isStreaming: true,
              timestamp: Date.now(),
            };
            currentAgentBlockId = block.id;
            displayBlocks.value.push(block);
          } else {
            const block = displayBlocks.value.find((b) => b.id === currentAgentBlockId);
            if (block && block.type === "agent-message") {
              block.content = text;
            }
          }
        }
        break;
      }
      case "message_end": {
        if (currentAgentBlockId) {
          const block = displayBlocks.value.find((b) => b.id === currentAgentBlockId);
          if (block && block.type === "agent-message") {
            block.isStreaming = false;
          }
          currentAgentBlockId = null;
        }
        break;
      }

      // Tool lifecycle — aggregate into a single work-status block
      case "tool_execution_start": {
        if (!currentWorkStatusId) {
          const wsBlock: DisplayBlock = {
            id: nextBlockId(),
            type: "work-status",
            tools: [],
            isStreaming: true,
            timestamp: Date.now(),
          };
          currentWorkStatusId = wsBlock.id;
          displayBlocks.value.push(wsBlock);
        }
        const ws = displayBlocks.value.find(
          (b) => b.id === currentWorkStatusId && b.type === "work-status"
        );
        if (ws && ws.type === "work-status") {
          ws.tools.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            result: null,
            isError: false,
          });
        }
        break;
      }
      case "tool_execution_update": {
        const ws = currentWorkStatusId
          ? displayBlocks.value.find((b) => b.id === currentWorkStatusId && b.type === "work-status")
          : null;
        if (ws && ws.type === "work-status") {
          const tool = ws.tools.find((t) => t.toolCallId === event.toolCallId);
          if (tool) tool.result = event.partialResult;
        }
        break;
      }
      case "tool_execution_end": {
        const ws = currentWorkStatusId
          ? displayBlocks.value.find((b) => b.id === currentWorkStatusId && b.type === "work-status")
          : null;
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

      case "compaction_start": {
        displayBlocks.value.push({
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
          "Compacted";
        displayBlocks.value.push({
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
        displayBlocks.value.push({
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
        displayBlocks.value.push({
          id: nextBlockId(),
          type: "retry",
          success: event.success,
          attempt: event.attempt,
          maxAttempts: 0,
          timestamp: Date.now(),
        });
        if (!event.success && event.finalError) {
          errorMessage.value = event.finalError;
        }
        break;
      }

      case "queue_update": {
        break;
      }
    }
  }

  function addEvents(newEvents: AgentSessionEvent[]): void {
    for (const event of newEvents) {
      addEvent(event);
    }
  }

  /**
   * Load messages from history.
   * AgentMessage = Message (from pi-ai) | CustomAgentMessages.
   * - AssistantMessage: content has TextContent | ThinkingContent | ToolCall blocks
   * - ToolResultMessage: role="toolResult", has toolCallId, toolName, content, isError
   */
  function loadMessages(messages: AgentMessage[]): void {
    clearSession();

    // Collect ALL tool calls across a full conversation turn (between user messages)
    let turnTools: ToolWorkItem[] = [];
    let turnText = "";

    function emitTurn(): void {
      if (turnTools.length > 0) {
        displayBlocks.value.push({
          id: nextBlockId(),
          type: "work-status",
          tools: [...turnTools],
          isStreaming: false,
          timestamp: Date.now(),
        });
      }
      if (turnText) {
        displayBlocks.value.push({
          id: nextBlockId(),
          type: "agent-message",
          content: turnText,
          isStreaming: false,
          timestamp: Date.now(),
        });
      }
      turnTools = [];
      turnText = "";
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === "user" || msg.role === "custom") {
        const text = extractMessageText(msg);
        if (text) {
          // User message with real text starts a new turn
          emitTurn();
          displayBlocks.value.push({
            id: nextBlockId(),
            type: "user-message",
            text,
            timestamp: Date.now(),
          });
        }
      } else if (msg.role === "assistant") {
        // Collect tool calls
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "toolCall") {
              const tc = block as { type: string; id: string; name: string; arguments: unknown };
              turnTools.push({
                toolCallId: tc.id,
                toolName: tc.name,
                args: tc.arguments,
                result: null,
                isError: false,
              });
            }
          }
        }
        // Collect text (last assistant message with text wins)
        const text = extractMessageText(msg);
        if (text) turnText = text;
      } else if (msg.role === "toolResult") {
        // Match tool result to pending tool
        const tr = msg as {
          role: string; toolCallId: string; toolName: string;
          content: Array<{ type: string; text?: string }>;
          isError: boolean;
        };
        const tool = turnTools.find((t) => t.toolCallId === tr.toolCallId);
        if (tool) {
          tool.result = tr.content;
          tool.isError = tr.isError;
          if (!tool.toolName && tr.toolName) tool.toolName = tr.toolName;
        }
      }
    }

    // Emit final turn
    emitTurn();
  }

  function clearSession(): void {
    events.value = [];
    displayBlocks.value = [];
    isStreaming.value = false;
    errorMessage.value = null;
    currentAgentBlockId = null;
    currentWorkStatusId = null;
  }

  function getRawEventsJson(): string {
    return JSON.stringify(events.value, null, 2);
  }

  return {
    events,
    displayBlocks,
    isStreaming,
    errorMessage,
    addEvent,
    addEvents,
    loadMessages,
    clearSession,
    getRawEventsJson,
  };
});
