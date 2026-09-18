/**
 * Tool result normalization (Stage D, SDD §2.2).
 *
 * Live tool_execution_end results are full AgentToolResult objects
 * { content: TextContent[], details }, while replayed non-whitelisted tools
 * carry only the content array. All tool-details components consume values
 * normalized here, so live and replay render identically.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Join the text blocks of a ToolResultMessage-style content array. */
function textFromBlocks(blocks: unknown[]): string {
  return blocks
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRecord(block) && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
}

/**
 * 归一化结果文本：{content:[{type:"text",text}]} → 拼接文本；字符串/块数组原样
 * 提取；其余 JSON.stringify。
 */
export function extractToolResultText(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return textFromBlocks(result);
  if (isRecord(result)) {
    const content = result.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return textFromBlocks(content);
  }
  return JSON.stringify(result, null, 2);
}

/** 归一化 details：result 为 {details} 对象时取 details，否则 undefined。 */
export function extractToolResultDetails(result: unknown): unknown {
  if (isRecord(result) && "details" in result) return result.details;
  return undefined;
}

/** First string among the given keys of a record, else undefined. */
export function getStringValue(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string") return item;
  }
  return undefined;
}

/** Clipboard write with the execCommand fallback (no store / IPC access). */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to a temporary textarea below.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

/** Split on newlines (CRLF/CR normalized); a trailing newline drops no row. */
export function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized === "") return [];
  const trimmedEnd = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return trimmedEnd.split("\n");
}

// ============================================================================
// Display diff parsing (edit/write result details.diff)
// ============================================================================

export type DisplayDiffKind = "added" | "removed" | "context" | "gap";

export interface DisplayDiffRow {
  kind: DisplayDiffKind;
  /** 文件行号（added=新文件行号，removed=旧文件行号，context=共同行号）；gap 行为空。 */
  lineNo: string;
  text: string;
}

/**
 * 解析 core 生成的 display diff（edit/write 工具 result 的 details.diff）。
 * 行格式（edit-diff.ts generateDiffString）：`+<n> <line>` / `-<n> <line>` /
 * ` <n> <line>`（上下文）/ `<空格>...`（被省略的上下文段）。行号为真实文件
 * 行号（新增行取新文件行号，删除行取旧文件行号）。
 */
export function parseDisplayDiff(diff: string): DisplayDiffRow[] {
  const rows: DisplayDiffRow[] = [];
  for (const raw of splitLines(diff)) {
    const match = /^([ +-])( *)(\d*) (.*)$/.exec(raw);
    if (!match) continue;
    const sign = match[1];
    const num = match[3];
    if (num === "") {
      rows.push({ kind: "gap", lineNo: "", text: "..." });
      continue;
    }
    rows.push({
      kind: sign === "+" ? "added" : sign === "-" ? "removed" : "context",
      lineNo: num,
      text: match[4] ?? "",
    });
  }
  return rows;
}

/**
 * 按 display diff 行统计增删行数。与主进程 file_change 事件的计数口径一致
 * （file-change.ts countDiffStat 也是数 +/- 行），保证内外层数字同源。
 */
export function countDiffRows(rows: DisplayDiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "added") added++;
    else if (row.kind === "removed") removed++;
  }
  return { added, removed };
}
