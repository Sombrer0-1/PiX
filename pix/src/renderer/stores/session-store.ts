/**
 * Session Store
 *
 * Manages the current session's event stream and display blocks.
 * Transforms raw AgentSessionEvents into organized DisplayBlocks for rendering.
 */

import { defineStore } from "pinia";
import { ref } from "vue";
import type { AgentMessage, AgentSessionEvent } from "@/types/rpc";
import type { DisplayBlock } from "@/types/session";

function nextBlockId(): string {
  return `block_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function extractMessageText(message: AgentMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
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

  // Track the current streaming agent message block for updates
  let currentAgentBlockId: string | null = null;
  // Track pending tool execution blocks
  const pendingTools: Map<string, string> = new Map(); // toolCallId -> blockId

  function addEvent(event: AgentSessionEvent): void {
    // Prune old events to prevent unbounded memory growth
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
      // Agent lifecycle
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
        displayBlocks.value.push({
          id: nextBlockId(),
          type: "status",
          status: "idle",
          timestamp: Date.now(),
        });
        break;
      }

      // Message lifecycle
      case "message_start": {
        const msg = event.message;
        if (msg.role === "user" || msg.role === "custom") {
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
        break;
      }
      case "message_update": {
        const msg = event.message;
        if (msg.role === "assistant" && currentAgentBlockId) {
          // agent-core's message_update provides event.message as the full
          // accumulated partial message. The assistantMessageEvent field carries
          // the delta from this specific chunk (text_delta, thinking_delta, etc.).
          // We use the accumulated message for content rendering.
          const text = extractMessageText(msg);
          const block = displayBlocks.value.find((b) => b.id === currentAgentBlockId);
          if (block && block.type === "agent-message") {
            block.content = text;
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

      // Tool lifecycle
      case "tool_execution_start": {
        const blockId = nextBlockId();
        pendingTools.set(event.toolCallId, blockId);
        displayBlocks.value.push({
          id: blockId,
          type: "tool-execution",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          result: null,
          isError: false,
          isStreaming: true,
          timestamp: Date.now(),
        });
        break;
      }
      case "tool_execution_update": {
        const blockId = pendingTools.get(event.toolCallId);
        if (blockId) {
          const block = displayBlocks.value.find((b) => b.id === blockId);
          if (block && block.type === "tool-execution") {
            block.result = event.partialResult;
          }
        }
        break;
      }
      case "tool_execution_end": {
        const blockId = pendingTools.get(event.toolCallId);
        if (blockId) {
          const block = displayBlocks.value.find((b) => b.id === blockId);
          if (block && block.type === "tool-execution") {
            block.result = event.result;
            block.isError = event.isError;
            block.isStreaming = false;
          }
          pendingTools.delete(event.toolCallId);
        }
        break;
      }

      // Compaction
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
        // compaction_end result is CompactionResult { summary, firstKeptEntryId, tokensBefore }
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

      // Retry
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

      // Queue update
      case "queue_update": {
        // Just note it; the input area can react to this.
        break;
      }
    }
  }

  function addEvents(newEvents: AgentSessionEvent[]): void {
    for (const event of newEvents) {
      addEvent(event);
    }
  }

  function loadMessages(messages: AgentMessage[]): void {
    clearSession();
    for (const message of messages) {
      if (message.role === "user" || message.role === "custom") {
        const text = extractMessageText(message);
        if (text) {
          displayBlocks.value.push({
            id: nextBlockId(),
            type: "user-message",
            text,
            timestamp: Date.now(),
          });
        }
      } else if (message.role === "assistant") {
        displayBlocks.value.push({
          id: nextBlockId(),
          type: "agent-message",
          content: extractMessageText(message),
          isStreaming: false,
          timestamp: Date.now(),
        });
      }
    }
  }

  function clearSession(): void {
    events.value = [];
    displayBlocks.value = [];
    isStreaming.value = false;
    errorMessage.value = null;
    currentAgentBlockId = null;
    pendingTools.clear();
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
