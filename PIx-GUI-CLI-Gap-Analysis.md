# PiX GUI vs CLI 功能对齐分析

> 基于 `packages/coding-agent` (CLI) 与 `pix/` (GUI) 源码逐行对比
> 生成日期：2026-06-02

---

## 结论先行

**GUI 覆盖了 CLI 约 15% 的功能。** 以下六大模块存在严重缺口：

| 模块 | CLI 功能数 | GUI 已实现 | 覆盖率 |
|------|-----------|-----------|--------|
| 认证系统 (Auth) | 6 | 0 | 0% |
| 设置系统 (Settings) | 25+ | 3 | ~12% |
| 会话管理 (Session) | 13 | 4 | ~30% |
| 模型管理 (Model) | 6 | 2 | ~20% |
| 扩展/技能/模板/主题 | 7 | 0 | 0% |
| 快捷键系统 | 20+ | 0 | 0% |

---

## 一、认证系统 — GUI 完全缺失 (0/6)

| 功能 | CLI 实现 | GUI 状态 |
|------|---------|---------|
| OAuth 登录 | `/login` → OAuth 选择器 + 浏览器跳转 + token 存入 `auth.json` | ❌ 无 |
| OAuth 登出 | `/logout` → 删除存储的凭证 | ❌ 无 |
| API Key 输入 | `--api-key` flag / `/login` 手动输入 | ❌ 无 |
| 环境变量读取 | 自动读取 `ANTHROPIC_API_KEY` 等 20+ 环境变量 | ⚠️ 底层 SDK 自动读取，但 GUI 无法感知状态 |
| auth.json 管理 | 读写 `~/.pi/agent/auth.json` | ❌ 无 UI |
| 认证状态展示 | 模型选择器显示哪些 provider 已认证/未认证 | ❌ 无 |

**影响：** 用户无法通过 GUI 完成任何认证操作。必须预先通过 CLI 执行 `pi /login` 或手动设置环境变量，GUI 才能正常工作。

---

## 二、模型管理 — GUI 严重不足 (2/6)

| 功能 | CLI 实现 | GUI 状态 |
|------|---------|---------|
| 模型选择器 | `/model` → 带搜索、分组、auth 状态标注的完整 TUI 选择器 | ⚠️ 基础下拉框，无搜索无分组 |
| Scoped Models | `/scoped-models` → 配置 Ctrl+P 循环的模型子集，支持 glob 匹配 | ❌ 无 |
| 模型循环 | Ctrl+P / Shift+Ctrl+P 前后切换 scoped 模型 | ⚠️ `cycleModel()` 有，但无 scoped 过滤 |
| CLI 模型指定 | `--model <pattern>`, `--provider <name>`, `--models <patterns>` | ❌ 无（仅设置页默认值） |
| 模型列表查看 | `--list-models [search]` 列出所有可用模型 | ❌ 无 |
| 模型 auth 检查 | 选择器只显示已认证 provider 的模型，未认证的显示 `/login` 提示 | ❌ 无 |

---

## 三、会话管理 — GUI 部分覆盖 (4/13)

| 功能 | CLI 实现 | GUI 状态 |
|------|---------|---------|
| 新建会话 | `/new` | ✅ 有 |
| 恢复会话 | `/resume` → 会话选择器（搜索、排序、跨项目） | ⚠️ 只有列表，无搜索无排序 |
| Fork 会话 | `/fork` → 从历史消息创建分叉 | ❌ `throw new Error("Fork is not implemented")` |
| Clone 会话 | `/clone` → 复制当前会话到新文件 | ❌ `throw new Error("Clone is not implemented")` |
| 会话树导航 | `/tree` → 树形选择器切换分支 | ❌ 无 |
| 会话信息 | `/session` → 显示 session ID、文件路径、消息数、token 统计 | ⚠️ 有 token stats，但无完整 session info |
| 会话命名 | `/name <name>` | ✅ 有 |
| 导出会话 | `/export [path]` → HTML 或 JSONL 格式 | ❌ 无 |
| 导入会话 | `/import <path.jsonl>` → 导入并恢复 | ❌ 无 |
| 分享会话 | `/share` → 生成 GitHub secret gist 链接 | ❌ 无 |
| 复制最后回复 | `/copy` → 复制到剪贴板 | ❌ 无 |
| 会话目录配置 | `--session-dir` | ❌ 无 |
| 无会话模式 | `--no-session`（不保存会话） | ❌ 无 |

**代码证据 — fork/clone 直接抛异常：**
```typescript
// pix/src/main/session-bridge.ts:137-139
async fork(_entryId: string): Promise<CommandResult> {
    throw new Error("Fork is not implemented in PiX yet.");
}
```

---

## 四、设置系统 — GUI 只覆盖 3/25+ 设置项

CLI 的 `/settings` 提供完整的 TUI 设置面板，包含以下所有设置项：

| 设置项 | CLI | GUI |
|--------|-----|-----|
| defaultProvider | ✅ | ✅ |
| defaultModel | ✅ | ✅ |
| thinkingLevel | ✅ | ✅ |
| theme | ✅ | ⚠️ 只有 light，select 被 disabled |
| autoCompact | ✅ | ❌ |
| showImages | ✅ | ❌ |
| imageWidthCells | ✅ | ❌ |
| autoResizeImages | ✅ | ❌ |
| blockImages | ✅ | ❌ |
| enableSkillCommands | ✅ | ❌ |
| steeringMode | ✅ | ❌ |
| followUpMode | ✅ | ❌ |
| transport (SSE/WebSocket/auto) | ✅ | ❌ |
| httpIdleTimeoutMs | ✅ | ❌ |
| hideThinkingBlock | ✅ | ❌ |
| collapseChangelog | ✅ | ❌ |
| enableInstallTelemetry | ✅ | ❌ |
| doubleEscapeAction | ✅ | ❌ |
| treeFilterMode | ✅ | ❌ |
| showHardwareCursor | ✅ | ❌ |
| editorPaddingX | ✅ | ❌ |
| autocompleteMaxVisible | ✅ | ❌ |
| quietStartup | ✅ | ❌ |
| clearOnShrink | ✅ | ❌ |
| showTerminalProgress | ✅ | ❌ |
| warnings | ✅ | ❌ |

**GUI 的 Settings 页面仅包含：** Provider 名称输入框、Model 名称输入框、Thinking Level 下拉框、Theme 下拉框（disabled）。

---

## 五、扩展/技能/模板/主题 — GUI 完全缺失 (0/7)

| 功能 | CLI 实现 | GUI 状态 |
|------|---------|---------|
| 扩展加载 | `--extension <path>`, `--no-extensions` | ❌ 无 |
| 技能加载 | `--skill <path>`, `--no-skills` | ❌ 无 |
| 提示模板 | `--prompt-template <path>`, `--no-prompt-templates` | ❌ 无 |
| 主题加载 | `--theme <path>`, `--no-themes` | ❌ 无 |
| 上下文文件 | `--no-context-files`（AGENTS.md/CLAUDE.md） | ❌ 无 |
| 重载资源 | `/reload` → 重载 keybindings、extensions、skills、prompts、themes | ❌ 无 |
| 扩展管理 | `pi install/remove/update/list/config` | ❌ 无 |

---

## 六、快捷键系统 — GUI 完全缺失 (0/20+)

CLI 定义了 20+ 键盘快捷键（`core/keybindings.ts`），GUI 无任何快捷键：

| 快捷键 | CLI 功能 | GUI |
|--------|---------|-----|
| Ctrl+P | 模型循环（scoped） | ❌ |
| Shift+Ctrl+P | 反向模型循环 | ❌ |
| Ctrl+L | 打开模型选择器 | ❌ |
| Ctrl+O | 展开/折叠工具输出 | ❌ |
| Ctrl+T | 主题选择器 | ❌ |
| Ctrl+N | 新建会话 | ❌ |
| Ctrl+G | 搜索（grep/find） | ❌ |
| Alt+Enter | 多行输入 | ❌ |
| Ctrl+D | 退出（空编辑器时） | ❌ |
| Ctrl+C | 清空编辑器 | ❌ |
| Ctrl+S | 保存/发送 | ❌ |
| Ctrl+R | 恢复会话 | ❌ |
| Ctrl+A | 全选 | ❌ |
| Ctrl+X | 剪切 | ❌ |
| Ctrl+Backspace | 删除单词 | ❌ |
| Alt+Up/Down | 历史消息导航 | ❌ |
| Ctrl+Left/Right | 词级光标移动 | ❌ |

---

## 七、其他功能缺口

| 功能 | CLI 实现 | GUI 状态 |
|------|---------|---------|
| 手动压缩 | `/compact [instructions]` | ✅ `compact()` 有 |
| Changelog 查看 | `/changelog` → 显示更新日志 | ❌ 无 |
| 快捷键帮助 | `/hotkeys` → 显示所有快捷键 | ❌ 无 |
| Bash 直接执行 | `!command` / `!!command`（后者不计入上下文） | ❌ 无 |
| 系统提示词 | `--system-prompt`, `--append-system-prompt` | ❌ 无 |
| 离线模式 | `--offline` | ❌ 无 |
| 详细输出 | `--verbose` | ❌ 无 |
| 非交互模式 | `--print`（处理完即退出） | ❌ 无 |
| 文件参数 | `@file.md @image.png "prompt"` | ❌ 无 |
| 版本信息 | `--version` | ❌ 无 |
| HTML 导出 | `--export <file>` | ❌ 无 |
| stdin 管道 | `echo "prompt" \| pi` | ❌ 无 |

---

## 架构层面的问题

### GUI 不是 CLI 的壳

PiX 直接调用 SDK（`createAgentSession`），不经过 CLI。这本身没问题。

**问题在于：GUI 只用了 SDK 的一小部分能力。** SDK 已经完整导出了：

- `AuthStorage` — 认证管理（login/logout/getApiKey/hasAuth）
- `ModelRegistry` — 模型注册与发现
- `SettingsManager` — 全部 25+ 设置项
- `SessionManager` — 会话管理（fork/clone/list/listAll）
- `ExtensionRunner` — 扩展运行时
- `ResourceLoader` — 资源加载（skills/prompts/themes/extensions）

PiX 的 `SessionBridge` 只调用了 `createAgentSession`、`SessionManager`、`SettingsManager` 的极小子集，完全忽略了 Auth、ModelRegistry、Extension、Resource 等模块。

### 认证缺失导致的连锁问题

没有认证 UI → 用户无法通过 GUI 配置 API key → `ModelRegistry` 找不到已认证的 provider → `createAgentSession` 返回 `model: undefined` → `modelFallbackMessage: "No models available"` → 会话无法正常工作。

---

## 附录：CLI 完整 Slash 命令列表

| 命令 | 描述 | GUI 对应 |
|------|------|---------|
| `/settings` | 打开设置菜单 | ⚠️ 有页面，但只有 3 项 |
| `/model` | 选择模型（带搜索选择器） | ⚠️ 基础下拉框 |
| `/scoped-models` | 配置模型循环子集 | ❌ |
| `/export` | 导出会话（HTML/JSONL） | ❌ |
| `/import` | 导入会话 | ❌ |
| `/share` | 分享为 GitHub gist | ❌ |
| `/copy` | 复制最后回复到剪贴板 | ❌ |
| `/name` | 设置会话名称 | ✅ |
| `/session` | 显示会话信息 | ⚠️ 部分 |
| `/changelog` | 显示更新日志 | ❌ |
| `/hotkeys` | 显示快捷键 | ❌ |
| `/fork` | 从历史消息分叉 | ❌ |
| `/clone` | 复制当前会话 | ❌ |
| `/tree` | 导航会话树 | ❌ |
| `/login` | 配置 provider 认证 | ❌ |
| `/logout` | 删除 provider 认证 | ❌ |
| `/new` | 新建会话 | ✅ |
| `/compact` | 手动压缩上下文 | ✅ |
| `/resume` | 恢复其他会话 | ⚠️ 有，但无搜索 |
| `/reload` | 重载扩展/技能/模板/主题 | ❌ |
| `/quit` | 退出 | N/A（GUI 有窗口关闭） |
