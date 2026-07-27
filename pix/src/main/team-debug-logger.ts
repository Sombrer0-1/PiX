import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const MAX_STRING_LENGTH = 20_000;
const MAX_ARRAY_LENGTH = 80;
const MAX_OBJECT_KEYS = 120;
const MAX_DEPTH = 6;

export class TeamDebugLogger {
  private _filePath: string | null = null;
  private _sequence = 0;

  get filePath(): string | null {
    return this._filePath;
  }

  start(cwd: string, teamName: string, reason: string): void {
    // Logs live under the agent dir, not the user's project — writing into the
    // project cwd pollutes it (and risks the logs getting committed).
    const logsDir = join(getAgentDir(), "team-logs");
    mkdirSync(logsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeTeamName = teamName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "team";
    this._filePath = join(logsDir, `team-${stamp}-${safeTeamName}.jsonl`);
    this._sequence = 0;
    this.log("logger.started", { cwd, teamName, reason, filePath: this._filePath });
  }

  stop(reason: string): void {
    this.log("logger.stopped", { reason });
    this._filePath = null;
  }

  log(event: string, payload: unknown = {}): void {
    if (!this._filePath) return;
    const entry = {
      ts: new Date().toISOString(),
      seq: ++this._sequence,
      event,
      payload: normalizeForLog(payload),
    };

    try {
      appendFileSync(this._filePath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (err) {
      console.warn("[TeamDebugLogger] Failed to write team debug log:", err);
    }
  }
}

export function summarizeText(text: string | undefined, maxLength = 4_000): Record<string, unknown> {
  const value = text ?? "";
  return {
    length: value.length,
    text: value.length > maxLength ? `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]` : value,
  };
}

function normalizeForLog(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (value instanceof Map) {
    return normalizeForLog(Object.fromEntries(value), depth + 1, seen);
  }
  if (value instanceof Set) {
    return normalizeForLog(Array.from(value), depth + 1, seen);
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `[array depth limit length=${value.length}]`;
    const items = value.slice(0, MAX_ARRAY_LENGTH).map((item) => normalizeForLog(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_LENGTH) {
      items.push(`[truncated ${value.length - MAX_ARRAY_LENGTH} items]`);
    }
    return items;
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (depth >= MAX_DEPTH) return "[object depth limit]";
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
      out[key] = normalizeForLog(item, depth + 1, seen);
    }
    if (entries.length > MAX_OBJECT_KEYS) {
      out.__truncatedKeys = entries.length - MAX_OBJECT_KEYS;
    }
    seen.delete(value);
    return out;
  }
  return String(value);
}
