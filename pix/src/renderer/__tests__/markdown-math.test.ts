/**
 * markdown 数学公式渲染测试（KaTeX 扩展）。
 *
 * 覆盖：
 * - 四种定界符（$$...$$、\[...\] display；$...$、\(...\) inline）与
 *   嵌套上下标等正常公式；
 * - 货币防误伤（$ 后空白、闭 $ 前空白、闭 $ 后紧跟数字、\$ 转义）；
 * - code span 与 fenced code 内的定界符不渲染；
 * - 流式未闭合定界符按字面输出；
 * - 坏公式不崩溃（throwOnError: false）；
 * - \href 等危险命令不产生链接（trust: false）；
 * - 含公式内容走 LRU 缓存且命中输出逐字节一致；
 * - copyButton=false 路径正常；
 * - 二次审计补充：CJK 邻接/标点边界、标题/引用/列表上下文、块级多行与
 *   空行、aligned/cases 环境、strong/em/链接交互、后处理不破坏 katex
 *   HTML、CSS 规则存在性（滚动与错误可见色）、对抗性非数学输入的
 *   HEAD 逐字节基线、流式重复渲染稳定。
 *
 * 缓存是模块级且跨测试共享，本文件所有用例使用互不相同的内容字符串。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { marked } from "marked";
import { MARKDOWN_CACHE_MAX_ENTRIES, renderMarkdown } from "../utils/markdown";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("数学公式：四种定界符", () => {
  it("渲染行内 $...$（非 display）", () => {
    const html = renderMarkdown("能量满足 $E = mc^2$ 关系");
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("katex-display");
    expect(html).not.toContain("$E");
  });

  it("渲染行内 \\(...\\)（非 display）", () => {
    const html = renderMarkdown("能量满足 \\(E = mc^2\\) 关系");
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("katex-display");
  });

  it("渲染块级 $$...$$（display）", () => {
    const html = renderMarkdown("公式：\n\n$$\\frac{a}{b} + \\frac{c}{d}$$");
    expect(html).toContain("katex-display");
    expect(html).not.toContain("$$");
  });

  it("渲染块级 \\[...\\]（display）", () => {
    const html = renderMarkdown("公式：\n\n\\[\\frac{a}{b}\\]");
    expect(html).toContain("katex-display");
    expect(html).not.toContain("\\[");
  });

  it("渲染嵌套上下标与根式", () => {
    const html = renderMarkdown("$x^{y_{z+1}} + \\sqrt{2x}$");
    expect(html).toContain('class="katex"');
    // MathML annotation 会合法保留 TeX 源，用结构锚点验证确实渲染了
    expect(html).toContain('class="katex-html"');
    expect(html).toContain("msupsub");
  });

  it("渲染多行 aligned display 公式", () => {
    const html = renderMarkdown(
      "$$\\begin{aligned} a &= 1 \\\\ b &= 2 \\end{aligned}$$"
    );
    expect(html).toContain("katex-display");
    expect(html).toContain('class="katex"');
  });

  it("同行文本中的 $$...$$ 也按 display 渲染", () => {
    const html = renderMarkdown("前置文本 $$a+b$$ 后置文本");
    expect(html).toContain("katex-display");
    expect(html).toContain("前置文本");
  });

  it("列表项与表格单元格内的行内公式", () => {
    const listHtml = renderMarkdown("- 第 $i$ 项\n- 第 $j$ 项");
    expect(listHtml).toContain("<li>");
    expect(listHtml).toContain('class="katex"');

    const tableHtml = renderMarkdown("| 列 $a$ | 列 b |\n| --- | --- |\n| $x$ | y |");
    expect(tableHtml).toContain("<td");
    expect(tableHtml).toContain('class="katex"');
  });
});

describe("数学公式：货币防误伤", () => {
  it("$ 后紧跟空白不匹配", () => {
    const html = renderMarkdown("花费 $ 5 美元");
    expect(html).not.toContain("katex");
    expect(html).toContain("$ 5");
  });

  it("闭 $ 前是空白不匹配", () => {
    const html = renderMarkdown("价格是 $5 和 $10");
    expect(html).not.toContain("katex");
    expect(html).toContain("$5 和 $10");
  });

  it("闭 $ 后紧跟数字不匹配（货币区间）", () => {
    const html = renderMarkdown("成本在 $100-$200 之间，区间 $1..$2 同理");
    expect(html).not.toContain("katex");
    expect(html).toContain("$100-$200");
  });

  it("单个 $ 的变量名不匹配", () => {
    const html = renderMarkdown("环境变量 $PATH 与 $HOME");
    expect(html).not.toContain("katex");
    expect(html).toContain("$PATH");
  });

  it("\\$ 转义输出字面 $ 且不渲染", () => {
    const html = renderMarkdown("成本 \\$5 整");
    expect(html).not.toContain("katex");
    expect(html).toContain("$5");
  });
});

describe("数学公式：代码保护", () => {
  it("code span 内的 $...$ 不渲染", () => {
    const html = renderMarkdown("执行 `calc $x^2$ now` 命令");
    expect(html).not.toContain("katex");
    expect(html).toContain("<code>calc $x^2$ now</code>");
  });

  it("code span 内的 $$ 与 \\[ 不渲染", () => {
    const html = renderMarkdown("原型 `$$x$$` 与 `\\[y\\]`");
    expect(html).not.toContain("katex");
    expect(html).toContain("<code>$$x$$</code>");
  });

  it("code span 前后正常公式仍渲染", () => {
    const html = renderMarkdown("`code` 与 $a+b$ 公式");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('class="katex"');
  });

  it("fenced code 内的 $、$$、\\[ 不渲染", () => {
    const html = renderMarkdown(
      "```bash\necho $PATH\nconst s = '$$x^2$$';\nconst t = '\\[y\\]';\n```"
    );
    expect(html).not.toContain("katex");
    expect(html).toContain("$$x^2$$");
    expect(html).toContain("$PATH");
  });

  it("含公式的 fenced code 仍带复制按钮（走 enhanceCodeBlocks）", () => {
    const html = renderMarkdown("```js\nconst a = 1;\n```\n\n$after$");
    expect(html).toContain("code-copy-btn");
    expect(html).toContain('class="katex"');
  });
});

describe("数学公式：流式未闭合定界符", () => {
  it("未闭合 $$ 按字面输出", () => {
    const html = renderMarkdown("正在推导 $$x^2 + 1");
    expect(html).not.toContain("katex");
    expect(html).toContain("$$x^2 + 1");
  });

  it("未闭合单个 $ 按字面输出", () => {
    const html = renderMarkdown("大概花了 $5");
    expect(html).not.toContain("katex");
    expect(html).toContain("$5");
  });

  it("未闭合 \\( 按字面输出且不崩溃", () => {
    const html = renderMarkdown("中间态 \\(x^2");
    expect(html).not.toContain("katex");
    expect(html).toContain("中间态");
  });

  it("闭合后同一内容正确渲染（流式完成态）", () => {
    const partial = renderMarkdown("正在推导 $$x^2 + 1");
    const done = renderMarkdown("正在推导 $$x^2 + 1$$ 完成");
    expect(partial).not.toContain("katex");
    expect(done).toContain("katex-display");
    expect(done).toContain("完成");
  });
});

describe("数学公式：容错与安全", () => {
  it("坏公式渲染为错误文本，消息其余部分不受影响", () => {
    const html = renderMarkdown("前文仍在。$\\frac{$ 后文仍在。");
    expect(html).toContain("katex-error");
    expect(html).toContain("前文仍在");
    expect(html).toContain("后文仍在");
  });

  it("\\href 在 trust:false 下不产生链接", () => {
    const html = renderMarkdown("$\\href{https://evil.example}{click}$");
    expect(html).not.toContain("href=\"https://evil.example");
    expect(html).not.toContain("<a href=");
  });

  it("公式内容中的 HTML 尖括号不被直通", () => {
    const html = renderMarkdown("$a < b > c$");
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("<script");
  });

  it("定界符内注入 HTML 标签不产生元素（img/onerror）", () => {
    const inline = renderMarkdown("$<img src=x onerror=alert(1)>$");
    expect(inline).not.toContain("<img");
    const block = renderMarkdown("$$<img src=x onerror=alert(1)>$$");
    // 尖括号全部转义为 &lt;/&gt;，注入内容只以文本形式出现，构不成标签
    expect(block).not.toContain("<img");
    expect(block).not.toMatch(/<annotation[^>]*>[^<]*<img/);
  });

  it("trust 门控命令不产生 HTML 属性或元素", () => {
    const html = renderMarkdown("$$\\htmlClass{x}{y} 与 \\htmlId{a}{b} 与 \\htmlStyle{c}{d}$$");
    // 三个命令均被拒绝：渲染为红色错误文本（color:#cc0000），参数未落入任何属性
    expect(html).toContain("#cc0000");
    expect(html).not.toContain('class="x"');
    expect(html).not.toContain('id="a"');
  });
});

describe("数学公式：缓存与旗标", () => {
  it("含公式内容命中缓存且不重复解析", () => {
    const spy = vi.spyOn(marked, "parse");
    const content = "缓存公式 $a^2 + b^2 = c^2$ 用例";

    const first = renderMarkdown(content);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(renderMarkdown(content)).toBe(first);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("缓存命中输出与强制重解析逐字节一致", () => {
    const spy = vi.spyOn(marked, "parse");
    const content = "逐字节一致 $$\\int_0^1 x\\,dx$$ 用例";

    const cached = renderMarkdown(content);
    for (let i = 0; i < MARKDOWN_CACHE_MAX_ENTRIES; i++) {
      renderMarkdown(`math-identity-fill-${i}`);
    }
    const before = spy.mock.calls.length;
    const immediate = renderMarkdown(content);
    expect(spy.mock.calls.length).toBe(before + 1);
    expect(immediate).toBe(cached);
  });

  it("copyButton=false 正常渲染公式且不加复制按钮", () => {
    const html = renderMarkdown("$$x^2$$\n\n```js\nconst a = 1;\n```", false);
    expect(html).toContain("katex-display");
    expect(html).not.toContain("code-copy-btn");
    expect(html).toContain("<pre>");
  });
});

describe("数学公式：非数学内容输出不受影响", () => {
  // 期望值来自改动前版本（git HEAD）对相同输入的实测输出，逐字节基线
  it("普通 markdown 输出与改动前逐字节一致", () => {
    expect(renderMarkdown("**加粗** 与 *斜体*")).toBe(
      "<p><strong>加粗</strong> 与 <em>斜体</em></p>\n"
    );
    expect(renderMarkdown("# 标题\n\n- 甲\n- 乙")).toBe(
      "<h1>标题</h1>\n<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>\n"
    );
    expect(renderMarkdown("`code` 与 [链接](https://example.com)")).toBe(
      '<p><code>code</code> 与 <a href="https://example.com" data-external-link="true" rel="noopener noreferrer">链接</a></p>\n'
    );
    expect(renderMarkdown("第一行\n第二行")).toBe("<p>第一行<br>第二行</p>\n");
    expect(renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(
      "<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody><tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody></table>\n"
    );
  });

  it("含 $ 的非公式文本输出与改动前逐字节一致", () => {
    expect(renderMarkdown("价格是 $5 和 $10")).toBe("<p>价格是 $5 和 $10</p>\n");
    expect(renderMarkdown("环境变量 $PATH 与 $HOME")).toBe(
      "<p>环境变量 $PATH 与 $HOME</p>\n"
    );
    expect(renderMarkdown("成本 \\$5 整")).toBe("<p>成本 $5 整</p>\n");
    expect(renderMarkdown("成本在 $100-$200 之间")).toBe(
      "<p>成本在 $100-$200 之间</p>\n"
    );
    expect(renderMarkdown("```bash\necho $PATH\n```")).toContain(
      '<code class="language-bash">echo $PATH\n</code>'
    );
  });

  // 期望值用 HEAD 版本（改动前）markdown.ts 实测生成并人工核对（审计
  // 修正：原期望串末尾 </b> 漏写转义，与 HEAD 实际输出不符）
  it("原始 HTML 仍然被转义（XSS 防线不变）", () => {
    expect(renderMarkdown("<script>alert(1)</script> 与 <b>bold</b>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt; 与 &lt;b&gt;bold&lt;/b&gt;"
    );
  });

  it("对抗性非数学输入与改动前逐字节一致（审计补充基线）", () => {
    // 全部期望值为 HEAD 版本 markdown-head 探针实测输出
    expect(renderMarkdown("含有 <tag> 与 & 符号 &amp; \"引号\"")).toBe(
      "<p>含有 &lt;tag&gt; 与 &amp; 符号 &amp; &quot;引号&quot;</p>\n"
    );
    expect(renderMarkdown("a<b>c</b>d 与 x<3 且 5>2")).toBe(
      "<p>a&lt;b&gt;c&lt;/b&gt;d 与 x&lt;3 且 5&gt;2</p>\n"
    );
    expect(renderMarkdown("<u>下划线</u> 原始标签")).toBe(
      "<p>&lt;u&gt;下划线&lt;/u&gt; 原始标签</p>\n"
    );
    expect(renderMarkdown("> 引用 <em>强调</em>")).toBe(
      "<blockquote>\n<p>引用 &lt;em&gt;强调&lt;/em&gt;</p>\n</blockquote>\n"
    );
    expect(renderMarkdown("删除 ~~x<y~~ 与 <del>标签</del>")).toBe(
      "<p>删除 <del>x&lt;y</del> 与 &lt;del&gt;标签&lt;/del&gt;</p>\n"
    );
    expect(renderMarkdown("换行<br>标签")).toBe(
      "<p>换行&lt;br&gt;标签</p>\n"
    );
    expect(renderMarkdown("1 < 2 > 0 的数学不等式")).toBe(
      "<p>1 &lt; 2 &gt; 0 的数学不等式</p>\n"
    );
    expect(renderMarkdown("自动链接 <https://example.com>")).toBe(
      '<p>自动链接 <a href="https://example.com" data-external-link="true" rel="noopener noreferrer">https://example.com</a></p>\n'
    );
    // 危险协议链接仍走 data-unsafe-link 白名单降级
    expect(renderMarkdown("[link](javascript:alert(1))")).toBe(
      '<p><a href="#" rel="noopener noreferrer" data-unsafe-link="true">link</a></p>\n'
    );
    expect(renderMarkdown("[x](data:text/html;base64,PHNjcmlwdD4)")).toBe(
      '<p><a href="#" rel="noopener noreferrer" data-unsafe-link="true">x</a></p>\n'
    );
  });
});

// ── 以下为二次审计补充的边界用例 ──

describe("数学公式：邻接与标点边界（审计补充）", () => {
  it("行内公式紧邻中日韩文字无空格（两种定界符）", () => {
    const dollar = renderMarkdown("这是$x$的公式");
    expect(dollar).toContain('class="katex"');
    expect(dollar).toContain("这是");
    expect(dollar).toContain("的公式");

    const paren = renderMarkdown("这是\\(x\\)的公式");
    expect(paren).toContain('class="katex"');
    expect(paren).toContain("的公式");
  });

  it("闭 $ 后紧跟句号/点号仍渲染", () => {
    const html = renderMarkdown("$x$.");
    expect(html).toContain('class="katex"');
    expect(html).toMatch(/\.<\/p>\s*$/);
  });

  it("闭 $ 后紧跟中文标点仍渲染", () => {
    const html = renderMarkdown("公式$E=mc^2$。");
    expect(html).toContain('class="katex"');
    expect(html).toContain("。");
  });

  it("US$ 后跟空白不匹配", () => {
    const html = renderMarkdown("花费 US$ 5 美元");
    expect(html).not.toContain("katex");
    expect(html).toContain("US$ 5");
  });

  it("US$5 形式货币（闭 $ 后跟数字）不匹配", () => {
    const html = renderMarkdown("价格：US$5，税费US$6");
    expect(html).not.toContain("katex");
    expect(html).toContain("US$5");
    expect(html).toContain("US$6");
  });

  it("同段落多个独立行内公式分别渲染", () => {
    const html = renderMarkdown("第一 $a$ 第二 $b$ 第三 $c$");
    expect((html.match(/class="katex"/g) ?? []).length).toBe(3);
    expect(html).toContain("第二");
  });

  it("公式位于段首与段尾", () => {
    const lead = renderMarkdown("$a$ 开头");
    expect(lead).toContain('class="katex"');
    expect(lead.indexOf('class="katex"')).toBeGreaterThan(lead.indexOf("<p>"));

    const tail = renderMarkdown("结尾 $b$");
    expect(tail).toContain('class="katex"');
    expect(tail.lastIndexOf("</p>")).toBeGreaterThan(tail.indexOf('class="katex"'));
  });

  it("未闭合 \\[ 按字面降级且不崩溃", () => {
    const html = renderMarkdown("未闭合 \\[x^2 部分");
    expect(html).not.toContain("katex");
    expect(html).toContain("未闭合");
  });
});

describe("数学公式：标题、引用、列表上下文（审计补充）", () => {
  it("标题中的行内公式", () => {
    const html = renderMarkdown("# 动力学 $x^2$ 基础");
    expect(html).toContain("<h1>");
    expect(html).toContain('class="katex"');
  });

  it("标题中的 $$ 也按 display 渲染", () => {
    const html = renderMarkdown("## $$a+b$$ 小节");
    expect(html).toContain("<h2>");
    expect(html).toContain("katex-display");
  });

  it("blockquote 中的行内与块级公式", () => {
    const inline = renderMarkdown("> 引用中的 $y$ 公式");
    expect(inline).toContain("<blockquote>");
    expect(inline).toContain('class="katex"');

    const block = renderMarkdown("> $$z^2$$ 引用块");
    expect(block).toContain("<blockquote>");
    expect(block).toContain("katex-display");
  });

  it("列表项第二行的块级公式", () => {
    const html = renderMarkdown("- 项目\n  $$q$$");
    expect(html).toContain("<li>");
    expect(html).toContain("katex-display");
  });
});

describe("数学公式：块级多行与空行（审计补充）", () => {
  it("$$ 跨多行渲染且前后段落分离", () => {
    const html = renderMarkdown("前文段落\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n后文段落");
    expect(html).toContain("katex-display");
    expect(html.indexOf("前文段落")).toBeLessThan(html.indexOf("katex-display"));
    expect(html.indexOf("katex-display")).toBeLessThan(html.indexOf("后文段落"));
  });

  it("$$ 内含空行时降级为字面文本且不吞后续段落", () => {
    const html = renderMarkdown("$$\np = 1\n\nq = 2\n$$");
    expect(html).not.toContain("katex");
    expect(html).toContain("$$");
    expect(html).toContain("q = 2");
  });

  it("\\begin{cases} 多行环境", () => {
    const html = renderMarkdown(
      "$$g(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}$$"
    );
    expect(html).toContain("katex-display");
    expect(html).toContain('class="katex"');
  });

  it("\\begin{aligned} 跨真实换行的多行环境", () => {
    const html = renderMarkdown(
      "$$\n\\begin{aligned}\na &= 1 \\\\\nb &= 2\n\\end{aligned}\n$$"
    );
    expect(html).toContain("katex-display");
    expect(html).not.toContain("$$");
  });
});

describe("数学公式：与行内元素交互（审计补充）", () => {
  it("**$x$** 公式在 strong 内渲染", () => {
    const html = renderMarkdown("**量 $q$ 证明**");
    expect(html).toContain("<strong>");
    expect(html.indexOf("<strong>")).toBeLessThan(html.indexOf('class="katex"'));
    expect(html.indexOf('class="katex"')).toBeLessThan(html.indexOf("</strong>"));
  });

  it("*$x$* 公式在 em 内渲染", () => {
    const html = renderMarkdown("*斜 $w$ 体*");
    expect(html).toContain("<em>");
    expect(html.indexOf("<em>")).toBeLessThan(html.indexOf('class="katex"'));
    expect(html.indexOf('class="katex"')).toBeLessThan(html.indexOf("</em>"));
  });

  it("公式出现在链接文本中", () => {
    const html = renderMarkdown("[系数 $k$ 说明](https://example.com/k)");
    expect(html).toContain('<a href="https://example.com/k"');
    expect(html.indexOf("<a ")).toBeLessThan(html.indexOf('class="katex"'));
    expect(html.indexOf('class="katex"')).toBeLessThan(html.indexOf("</a>"));
  });
});

describe("数学公式：后处理不破坏 katex HTML（审计补充）", () => {
  it("段尾公式加尾随空行不被 stripTrailingWhitespace 剥掉", () => {
    const html = renderMarkdown("结论是 $z$\n\n");
    expect(html).toContain('class="katex"');
    // 公式 span 仍在 <p> 内，且后面没有被剥离成孤立 <br>
    expect(html.indexOf("<p>")).toBeLessThan(html.indexOf('class="katex"'));
    expect(html.lastIndexOf("</p>")).toBeGreaterThan(html.indexOf('class="katex"'));
    expect(html).not.toMatch(/class="katex"[\s\S]*<br\s*\/?>\s*<\/p>/);
  });

  it("display 公式后跟 fenced code，enhanceCodeBlocks 包裹位置正确", () => {
    const html = renderMarkdown("$$s+t$$\n\n```js\nconst a = 1;\n```");
    expect(html).toContain("katex-display");
    expect(html).toContain("code-copy-btn");
    expect(html.indexOf("katex-display")).toBeLessThan(html.indexOf("code-block"));
  });
});

describe("数学公式：CSS 规则存在（审计补充）", () => {
  const mainCss = readFileSync(
    resolve(process.cwd(), "src/renderer/assets/styles/main.css"),
    "utf-8"
  );

  it(".katex-display 提供横向滚动与防裁剪 padding", () => {
    const rule = mainCss.match(/\.katex-display\s*\{[^}]*\}/);
    expect(rule?.[0]).toContain("overflow-x: auto");
    expect(rule?.[0]).toContain("overflow-y: hidden");
    expect(rule?.[0]).toContain("padding");
  });

  it(".katex-error 有可见的颜色（兜底 catch 分支）", () => {
    const rule = mainCss.match(/\.katex-error\s*\{[^}]*\}/);
    expect(rule?.[0]).toContain("color");
  });
});

describe("数学公式：流式重复渲染稳定（审计补充）", () => {
  it("同一段含公式文本重复渲染输出恒定", () => {
    const outputs = new Set<string>();
    for (let i = 0; i < 20; i++) {
      outputs.add(renderMarkdown("流式重复 $r^2$ 公式"));
    }
    expect(outputs.size).toBe(1);
    expect([...outputs][0]).toContain('class="katex"');
  });
});
