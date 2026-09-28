/**
 * Shared Markdown Renderer
 *
 * Extracted from SessionView.vue: the marked configuration, HTML/link
 * sanitization and code-block enhancement are shared by the main answer and
 * the subagent output so both render through the same security policy.
 * Main-answer HTML must stay equivalent to the pre-extraction build; the
 * protocol whitelist is never relaxed.
 */
import katex from "katex";
import { marked, type Tokens, type TokenizerAndRendererExtension } from "marked";

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
 * LaTeX 数学公式渲染（KaTeX 预渲染为 HTML 字符串）。
 *
 * 安全要点：数学 HTML 通过 marked 扩展 renderer 的返回值注入——Parser
 * 对扩展 token 直接拼入输出、不经过 renderer.html 的转义，这是唯一注入
 * 通道，原始 HTML 的 XSS 防线不受影响。KaTeX 侧保持 trust: false（默认，
 * \href 等危险命令按错误文本渲染）与 throwOnError: false（坏公式显示
 * 红色错误文本而不是让整条消息渲染失败）。
 *
 * 代码保护：block 层扩展 tokenizer 先于 fence、inline 层先于 codespan
 * 尝试，但正则锚定行首/串首，因此 fenced code 与 code span 由内建
 * tokenizer 在自身起点整体消费，内部的 $、$$、\[ 不会进入数学匹配。
 */
function renderMathHtml(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
    });
  } catch {
    // KaTeX 极端异常时退回字面文本，避免整条消息渲染失败
    return `<code class="katex-error">${escapeHtml(tex)}</code>`;
  }
}

// 货币防误伤：开 $ 后不能紧跟空白、闭 $ 前不能是空白、闭 $ 后不能紧跟数字；
// 行内 $ 公式限制单行，内容不含 $。支持 \$ 转义（marked escape tokenizer 处理）。
const inlineDollarMath = /^\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/;
// display 与 \(...\) 内容允许换行但不跨空行，避免误吞后续段落正文
const inlineDoubledDollarMath = /^\$\$((?:(?!\n\n)[\s\S])*?)\$\$/;
const inlineParenMath = /^\\\(((?:(?!\n\n)[\s\S])*?)\\\)/;
const inlineBracketMath = /^\\\[((?:(?!\n\n)[\s\S])*?)\\\]/;
const blockDollarMath = /^\$\$((?:(?!\n\n)[\s\S])*?)\$\$/;
const blockBracketMath = /^\\\[((?:(?!\n\n)[\s\S])*?)\\\]/;

/**
 * 行内数学扩展：处理段落文本中的 $...$、\(...\)，以及 block 层不剪切的
 * 位置（标题、表格单元格）里的 $$...$$、\[...\]。
 */
const inlineMathExtension: TokenizerAndRendererExtension = {
  name: "inlineMath",
  level: "inline",
  // $ 不是 inlineText 的停止字符，必须提供 start 让 marked 在公式
  // 起点截断普通文本 token，否则 $ 前的文本会把公式整段吞掉。
  start(src: string): number {
    return src.search(/\$|\\\(/);
  },
  tokenizer(src: string): Tokens.Generic | undefined {
    const paren = inlineParenMath.exec(src);
    if (paren) return mathToken("inlineMath", paren[0], paren[1], false);
    const dollar = inlineDollarMath.exec(src);
    if (dollar) return mathToken("inlineMath", dollar[0], dollar[1], false);
    const doubled = inlineDoubledDollarMath.exec(src);
    if (doubled) return mathToken("inlineMath", doubled[0], doubled[1], true);
    const bracket = inlineBracketMath.exec(src);
    if (bracket) return mathToken("inlineMath", bracket[0], bracket[1], true);
    return undefined;
  },
  renderer(token: Tokens.Generic): string {
    return renderMathHtml(readTex(token), token.displayMode === true);
  },
};

/** 块级数学扩展：独立成块的 $$...$$ 与 \[...\]（display 模式）。 */
const blockMathExtension: TokenizerAndRendererExtension = {
  name: "blockMath",
  level: "block",
  // 不提供 start：start 会把 paragraph 剪切到 code span 内部的 $$ 起点上，
  // 使块级扩展从 span 内部匹配（破坏代码保护）。独立成块的公式本来就在
  // block 词法起点被直接命中；段中 $$ 与 \[ 由 inline 扩展兜底渲染。
  tokenizer(src: string): Tokens.Generic | undefined {
    const dollar = blockDollarMath.exec(src);
    if (dollar) return mathToken("blockMath", dollar[0], dollar[1], true);
    const bracket = blockBracketMath.exec(src);
    if (bracket) return mathToken("blockMath", bracket[0], bracket[1], true);
    return undefined;
  },
  renderer(token: Tokens.Generic): string {
    return renderMathHtml(readTex(token), token.displayMode === true);
  },
};

function mathToken(type: string, raw: string, tex: string, displayMode: boolean): Tokens.Generic {
  return { type, raw, text: tex.trim(), displayMode };
}

function readTex(token: Tokens.Generic): string {
  return typeof token.text === "string" ? token.text : "";
}

marked.use({ extensions: [blockMathExtension, inlineMathExtension] });

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
