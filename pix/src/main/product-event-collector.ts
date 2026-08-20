/**
 * Anonymous product-event collector (PiX-1.4-PLAN.md §6.3 / PRD §4.4).
 *
 * App-level singleton created by index.ts; producers (PlanController in 1.4.0,
 * AgentTaskService in 1.4.1) call record() for lifecycle milestones. Events are
 * accumulated in memory and flushed to a rolling local baseline log at
 * `<agentDir>/product-events.log`; the first release never sends events over
 * the network.
 *
 * Everything is gated by the app-level `enableProductAnalytics` setting.
 * record()/isEnabled() read the current setting on every call, so disabling
 * mid-run stops new records in the same process immediately, and the log is
 * neither created nor appended to while disabled.
 *
 * Privacy: the collector stamps a fresh random taskId per event and runs every
 * payload through sanitizeProductEventPayload before appending, so prompt/code/
 * file content/command text/model output can never reach the log. The collector
 * also keeps a local count of valid Solo sessions (>= 1 non-empty user message)
 * - the denominator for the Plan-usage metric - persisting it as a baseline
 * line in the same log; message content is never recorded.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  isProductEvent,
  sanitizeProductEventPayload,
  type ProductEvent,
  type ProductEventName,
  type ProductEventPayload,
} from "../shared/product-events.js";
import type { SettingsStore } from "./settings-store.js";

const PRODUCT_EVENTS_LOG_NAME = "product-events.log";
const DEFAULT_PRODUCT_EVENTS_LOG_MAX_BYTES = 512 * 1024;
/** Bounded memory: overflow drops the oldest buffered event. */
const MAX_BUFFERED_EVENTS = 512;
/** Flush automatically once the buffer reaches this many events. */
const AUTO_FLUSH_THRESHOLD = 256;
const BASELINE_KIND_VALID_SOLO_SESSIONS = "valid_solo_sessions";

/** One line of the JSONL baseline log. */
interface ProductEventLogRecord {
  record: "event";
  taskId: string;
  name: ProductEventName;
  occurredAt: number;
  payload: ProductEventPayload;
}

interface SoloSessionBaselineRecord {
  record: "baseline";
  kind: "valid_solo_sessions";
  count: number;
  occurredAt: number;
}

export interface ProductEventCollectorOptions {
  /** App-level settings store; enableProductAnalytics is read live. */
  settings: SettingsStore;
  /** App data directory; the baseline log lives at <agentDir>/product-events.log. */
  agentDir: string;
  /** Test-injectable rolling size in bytes; defaults to 512 KiB. */
  maxLogBytes?: number;
}

export class ProductEventCollector {
  private readonly _settings: SettingsStore;
  private readonly _agentDir: string;
  private readonly _logPath: string;
  private readonly _maxLogBytes: number;
  private _buffer: ProductEventLogRecord[] = [];
  private _flushing: Promise<void> | null = null;
  private _validSoloSessionCount: number;
  private _flushedSoloSessionCount: number;

  constructor(opts: ProductEventCollectorOptions) {
    this._settings = opts.settings;
    this._agentDir = opts.agentDir;
    this._logPath = join(opts.agentDir, PRODUCT_EVENTS_LOG_NAME);
    this._maxLogBytes = opts.maxLogBytes ?? DEFAULT_PRODUCT_EVENTS_LOG_MAX_BYTES;
    this._validSoloSessionCount = this._seedSoloSessionCount();
    this._flushedSoloSessionCount = this._validSoloSessionCount;
  }

  /** Current enableProductAnalytics; read live so mid-run toggles take effect. */
  isEnabled(): boolean {
    return this._settings.get("enableProductAnalytics") === true;
  }

  /**
   * Records one anonymous product event. No-op when disabled (zero new records
   * in the same process after the switch is turned off) or when the event does
   * not pass the shared guard. A fresh random taskId is stamped per event.
   */
  record(event: ProductEvent): void {
    if (!this.isEnabled()) return;
    if (!isProductEvent(event)) return;
    this._buffer.push({
      record: "event",
      taskId: randomUUID(),
      name: event.name,
      occurredAt: Date.now(),
      payload: sanitizeProductEventPayload(event.payload),
    });
    if (this._buffer.length > MAX_BUFFERED_EVENTS) {
      this._buffer.shift();
    }
    if (this._buffer.length >= AUTO_FLUSH_THRESHOLD) {
      void this.flushLog();
    }
  }

  /**
   * Local denominator for the Plan-usage metric: one valid Solo session (>= 1
   * non-empty user message). Only the count is recorded, never content. The
   * caller decides validity; this method only checks the analytics switch.
   */
  recordValidSoloSession(): void {
    if (!this.isEnabled()) return;
    this._validSoloSessionCount += 1;
  }

  /** Flushes buffered events (and the solo-session baseline when it changed) to the log. */
  async flushLog(): Promise<void> {
    if (this._flushing) return this._flushing;
    const flushing = this._flushNow().finally(() => {
      this._flushing = null;
    });
    this._flushing = flushing;
    return flushing;
  }

  private async _flushNow(): Promise<void> {
    const records = this._buffer.splice(0, this._buffer.length);
    // Snapshot the baseline count ONCE: recordValidSoloSession() may run while
    // the append is in flight. Reading the live counter at line-build time and
    // again at watermark-advance time could write the old count while marking
    // the new one as flushed, permanently dropping the delta.
    const soloSessionCountAtFlush = this._validSoloSessionCount;
    const lines: string[] = [];
    for (const record of records) {
      lines.push(JSON.stringify(record));
    }
    const baselineChanged = soloSessionCountAtFlush !== this._flushedSoloSessionCount;
    if (baselineChanged) {
      lines.push(
        JSON.stringify({
          record: "baseline",
          kind: BASELINE_KIND_VALID_SOLO_SESSIONS,
          count: soloSessionCountAtFlush,
          occurredAt: Date.now(),
        } satisfies SoloSessionBaselineRecord),
      );
    }
    if (lines.length === 0) return;
    try {
      await this._appendLines(lines);
      // Advance the baseline watermark only after the write succeeded, so a
      // transient write failure cannot permanently drop the baseline line:
      // the count stays unflushed and the next flush rebuilds it (buffered
      // event lines are replayed in the catch below instead).
      if (baselineChanged) {
        this._flushedSoloSessionCount = soloSessionCountAtFlush;
      }
    } catch (err) {
      // Re-queue so a transient write failure does not silently lose events;
      // memory stays bounded by MAX_BUFFERED_EVENTS on the next record().
      this._buffer.unshift(...records);
      console.error("[product-events] flushLog failed:", err);
    }
  }

  /** Appends JSONL lines, rolling the log to <name>.1 before exceeding maxLogBytes. */
  private async _appendLines(lines: string[]): Promise<void> {
    await mkdir(this._agentDir, { recursive: true });
    const payload = lines.join("\n") + "\n";
    let size = 0;
    try {
      size = (await stat(this._logPath)).size;
    } catch {
      // First write: no log file yet.
    }
    if (size > 0 && size + Buffer.byteLength(payload, "utf-8") > this._maxLogBytes) {
      const rolledPath = `${this._logPath}.1`;
      await rm(rolledPath, { force: true });
      await rename(this._logPath, rolledPath);
    }
    await appendFile(this._logPath, payload, "utf-8");
  }

  /**
   * Resumes the in-memory solo-session count from the last baseline line of an
   * existing log, so the Plan-usage denominator survives app restarts. Tolerant
   * of a missing or partially corrupt log; the last valid baseline wins.
   */
  private _seedSoloSessionCount(): number {
    const rolledPath = `${this._logPath}.1`;
    let count = 0;
    if (existsSync(rolledPath)) {
      count = this._lastBaselineCount(rolledPath, count);
    }
    if (existsSync(this._logPath)) {
      count = this._lastBaselineCount(this._logPath, count);
    }
    return count;
  }

  private _lastBaselineCount(path: string, fallback: number): number {
    try {
      const content = readFileSync(path, "utf-8");
      let count = fallback;
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { record?: unknown; kind?: unknown; count?: unknown };
          if (
            parsed.record === "baseline" &&
            parsed.kind === BASELINE_KIND_VALID_SOLO_SESSIONS &&
            typeof parsed.count === "number" &&
            Number.isFinite(parsed.count) &&
            parsed.count >= 0
          ) {
            count = parsed.count;
          }
        } catch {
          // Skip corrupt lines.
        }
      }
      return count;
    } catch {
      return fallback;
    }
  }
}
