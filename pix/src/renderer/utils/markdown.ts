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

export function renderMarkdown(text: string, copyButton = true): string {
  if (!text) return "&nbsp;";
  try {
    const result = marked.parse(text, { async: false, renderer: markdownRenderer });
    if (typeof result !== "string") return text;
    return enhanceCodeBlocks(stripTrailingWhitespace(result), copyButton);
  } catch {
    return escapeHtml(text);
  }
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
