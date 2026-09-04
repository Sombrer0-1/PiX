/**
 * MessageUpdateCoalescer - merges streaming message_update events before they
 * cross the renderer IPC boundary (perf SDD §4.2).
 *
 * Every provider delta arrives as a message_update whose payload is the full
 * accumulated message, so forwarding each one verbatim makes the IPC traffic
 * quadratic in the reply length. This coalescer sits between the SessionBridge
 * listeners and webContents.send: consecutive thinking_delta events are
 * concatenated, text/toolcall deltas collapse latest-wins, and markers plus
 * every non-message_update event flush the pending update and pass through
 * immediately, preserving event order. Main-process consumers (task
 * transcripts, team manager) still receive each individual event upstream.
 *
 * This module only merges events: it holds no window reference and never calls
 * webContents.send itself - the sink is supplied by the caller.
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** Event exit point. The caller owns the window-alive check and webContents.send. */
export type CoalescedEventSink = (event: AgentSessionEvent) => void;

export const DEFAULT_COALESCE_INTERVAL_MS = 50;

/**
 * Narrowed pix-side view of the assistantMessageEvent carried by
 * message_update (same convention as the renderer's display-blocks.ts).
 */
type AssistantMessageEventLike = {
  type?: string;
  delta?: string;
  content?: string;
};

/** The message_update variant of AgentSessionEvent. */
type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;

export class MessageUpdateCoalescer {
  private readonly sink: CoalescedEventSink;
  private readonly intervalMs: number;
  private pending: AgentSessionEvent | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(sink: CoalescedEventSink, intervalMs: number = DEFAULT_COALESCE_INTERVAL_MS) {
    this.sink = sink;
    this.intervalMs = intervalMs;
  }

  /** Single entry point. Non-message_update events: flush pending, then sink immediately. */
  push(event: AgentSessionEvent): void {
    if (this.disposed) {
      this.sink(event);
      return;
    }
    if (event.type !== "message_update") {
      this.flush();
      this.sink(event);
      return;
    }

    const ame = this.ameOf(event);
    const ameType = ame.type;
    if (ameType === "thinking_delta") {
      const pendingAmeType = this.pending !== null ? this.ameOf(this.pending).type : undefined;
      if (pendingAmeType === "thinking_delta") {
        // Concatenate deltas and keep the newest accumulated message snapshot.
        // A fresh event object is built because the incoming event is shared
        // with main-process consumers and must not be mutated in place.
        const pendingDelta = this.ameOf(this.pending!).delta ?? "";
        // The spread keeps the incoming event's real ame fields (contentIndex,
        // partial, ...); only delta is replaced by the concatenated value.
        this.pending = {
          ...event,
          assistantMessageEvent: {
            ...ame,
            delta: pendingDelta + (ame.delta ?? ""),
          } as MessageUpdateEvent["assistantMessageEvent"],
        };
        return;
      }
      if (this.pending !== null) {
        this.flush();
      }
      this.pending = event;
      this.startTimer();
      return;
    }

    if (ameType === "text_delta" || ameType === "toolcall_delta") {
      const pendingAmeType = this.pending !== null ? this.ameOf(this.pending).type : undefined;
      if (pendingAmeType !== undefined && pendingAmeType !== ameType) {
        this.flush();
      }
      // Latest-wins: the renderer rebuilds text/toolcall content from the
      // accumulated message, so replacing the pending event is lossless.
      this.pending = event;
      if (this.timer === null) {
        this.startTimer();
      }
      return;
    }

    // Markers (thinking_start / thinking_end / text_start / text_end /
    // toolcall_start / toolcall_end) and unknown ame types: flush the pending
    // update so the marker lands after it, then pass through without buffering.
    this.flush();
    this.sink(event);
  }

  /** Emit the pending merged event immediately (no-op when idle) and cancel the timer. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending === null) {
      return;
    }
    const event = this.pending;
    this.pending = null;
    this.sink(event);
  }

  /** Flush, then release all resources. After dispose, push passes through unmerged. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.flush();
    this.disposed = true;
  }

  private startTimer(): void {
    // Fixed window: started when an event first becomes pending, never
    // restarted by later merges (no sliding).
    this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }

  private ameOf(event: AgentSessionEvent): AssistantMessageEventLike {
    return ((event as { assistantMessageEvent?: unknown }).assistantMessageEvent ?? {}) as AssistantMessageEventLike;
  }
}
