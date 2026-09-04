/**
 * Shared Markdown Renderer
 *
 * Extracted from SessionView.vue: the marked configuration, HTML/link
 * sanitization and code-block enhancement are shared by the main answer and
 * the subagent output so both render through the same security policy.
 * Main-answer HTML must stay equivalent to the pre-extraction build; the
 * protocol whitelist is never relaxed.
 */
import { marked } from "marked";

marked.setOptions({ breaks: true, gfm: true });
const markdownRenderer = new marked.Renderer();
markdownRenderer.html = (html: string) => escapeHtml(html);
markdownRenderer.link = (href: string, title: string | null | undefined, text: string): string => {
  const safeText = text;
  const safeHref = sanitizeHref(href);
  if (!safeHref) {
    return `<a href="#" rel="noopener noreferrer" data-unsafe-link="true">${safeText}</a>`;
  }
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(safeHref)}"${titleAttr} data-external-link="true" rel="noopener noreferrer">${safeText}</a>`;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^[./#?]/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * renderMarkdown 结果 LRU 缓存（perf SDD §3.18/§4.9）。
 * renderMarkdown 是 content 的纯函数，缓存值即最终 HTML（含
 * enhanceCodeBlocks 后处理），命中返回与即时解析逐字节一致的字符串。
 * 插入序 Map 实现 LRU，不引入 LRU 库；空串与超 64KB 内容旁路不入缓存。
 */
export const MARKDOWN_CACHE_MAX_ENTRIES = 512;
export const MARKDOWN_CACHE_MAX_CONTENT_BYTES = 65536;

const markdownCache = new Map<string, string>();

function contentBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isCacheableContent(text: string): boolean {
  // UTF-16 length is a cheap upper bound on UTF-8 bytes. Only encode when
  // the string might actually exceed the 64KB cap (non-ASCII near the limit).
  if (text.length > MARKDOWN_CACHE_MAX_CONTENT_BYTES) return false;
  if (text.length * 3 <= MARKDOWN_CACHE_MAX_CONTENT_BYTES) return true;
  return contentBytes(text) <= MARKDOWN_CACHE_MAX_CONTENT_BYTES;
}

export function renderMarkdown(text: string, copyButton = true): string {
  if (!text) return "&nbsp;";
  // 缓存键只有原文内容（§7 注意事项），因此仅缓存默认 copyButton=true 的
  // 渲染结果；其他旗标组合（如 BtwCard 的 copyButton=false）旁路缓存。
  const cacheable = copyButton && isCacheableContent(text);
  if (cacheable) {
    const cached = markdownCache.get(text);
    if (cached !== undefined) {
      // 刷新 LRU 位：delete + 重新插入移到尾部。
      markdownCache.delete(text);
      markdownCache.set(text, cached);
      return cached;
    }
  }
  let html: string;
  try {
    const result = marked.parse(text, { async: false, renderer: markdownRenderer });
    html = typeof result !== "string" ? text : enhanceCodeBlocks(stripTrailingWhitespace(result), copyButton);
  } catch {
    html = escapeHtml(text);
  }
  if (cacheable) {
    markdownCache.set(text, html);
    if (markdownCache.size > MARKDOWN_CACHE_MAX_ENTRIES) {
      // Map 按插入序迭代：首个键即最旧键。
      const oldest = markdownCache.keys().next().value;
      if (oldest !== undefined) markdownCache.delete(oldest);
    }
  }
  return html;
}

/**
 * Strip trailing <br> tags and empty trailing <p> blocks that marked
 * generates from trailing newlines in the source text.  Without this,
 * short AI responses appear with an unwanted blank line underneath.
 */
function stripTrailingWhitespace(html: string): string {
  return html
    .replace(/(<br\s*\/?>)+\s*<\/p>/gi, "</p>")
    .replace(/<p>\s*(<br\s*\/?>|\s|&nbsp;)*<\/p>\s*$/gi, "");
}

export const codeCopyIcon =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
export const codeCheckIcon =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

function enhanceCodeBlocks(html: string, copyButton: boolean): string {
  const button = copyButton
    ? `<button class="code-copy-btn" type="button" data-copy-code="true" title="复制代码" aria-label="复制代码">${codeCopyIcon}</button>`
    : "";
  return html
    .replace(/<pre><code([^>]*)>/g, `<div class="code-block">${button}<pre><code$1>`)
    .replace(/<\/code><\/pre>/g, "</code></pre></div>");
}
