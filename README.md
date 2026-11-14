# PiX

PiX 是一个基于 Pi 的编码代理，提供终端命令 `pix` 和 Electron 桌面应用。两端的 Solo 会话共用模型配置、文件与 Shell 工具、MCP、原生子代理、workflow、Ralph、Plan 和 Todo。Team 圆桌和 Computer Use 由桌面应用提供。

## 技术栈

- **前端**: Vue 3 + Vuetify 3 + Pinia + Vue Router
- **桌面框架**: Electron
- **构建工具**: Vite + TypeScript
- **AI 后端**: Pi Agent Core (支持 OpenAI、Anthropic、Google 等多模型)

## 功能特性

- 多会话管理，支持创建、切换、删除会话
- 集成 Pi 编码代理，支持代码编辑、文件操作、终端命令执行
- 可视化设置面板，配置模型、API Key、工作目录等
- 会话历史记录和文件变更追踪
- 支持多种 AI 模型和深度思考模式

## WSL2 原生执行（v1）

PiX 支持将项目在 WSL2 发行版内执行：Agent 会话获得 Linux 语义（POSIX 路径、platform=linux、Linux bash、apt），read/write/edit/ls 通过宿主 Node 进程访问发行版文件，find/grep 在 WSL 内运行 fd/rg。项目级选择发行版，Windows 模式不受影响。

### 前置条件

- **WSL2**：Windows 10/11 需已启用 WSL2。v1 仅支持 WSL 版本 2 的发行版，WSL1 直接报告不可用。
- **显式发行版**：每个 WSL 项目必须显式选择发行版（列表来自探测结果）。不会读取系统默认发行版来推断项目归属，也不会静默回退到其它发行版。
- **项目逻辑路径**：WSL 项目的工作目录是发行版内的绝对 POSIX 路径（如 `/home/user/work/project`），启动时校验目录存在。模型和工具只见逻辑路径；宿主侧以物理路径（ext4 项目为 UNC，/mnt/c 项目为盘符）访问文件，两者转换由主进程完成。
- **rg 和 fd 由用户在发行版内自行安装**（v1 不自动下载二进制）：
  - ripgrep：`sudo apt install ripgrep`
  - fd：Debian/Ubuntu 包名为 `fd-find`，安装后命令是 `fdfind`；其它发行版（Fedora/Arch 等）命令名为 `fd`。backend 依次探测 `fd`、`fdfind`，缺失时报含发行版名与安装提示的错误，不会回退到 Windows 侧二进制。
- **配置入口**：桌面在打开项目时选择 WSL 发行版和目录。终端使用 `pix --wsl-distro Ubuntu-22.04 --wsl-path /home/user/project`。

### 使用限制（v1）

- **不支持 PTY / 交互式 stdin**：vim、ssh、交互式确认等交互式命令不可用。
- **不支持后台任务**：run_background / read_output / stop_process 在 v1 不可用。
- **无长驻 bash 会话**：每条命令独立执行，cwd 固定在项目逻辑路径，不支持跨命令 cd 持久化。
- **MCP 限制**：WSL 模式禁用 Windows 侧 stdio 类型 MCP server（提示改用 HTTP/SSE，或将 server 运行在 WSL 内）；HTTP/SSE 保留但返回值不承诺路径改写。
- **扩展与 MCP 边界**：扩展和 MCP server 运行在宿主（Windows）侧，可能返回 `C:\...` 或 `\\wsl.localhost\...` 路径，遇到时用 `/mnt/c/...` 转换后交给 bash，或回传给同一工具。
- 工具错误与 PiX 生成的诊断只显示 Linux 逻辑路径，不泄露 UNC / 盘符；任意命令的原始 stdout/stderr 不重写。

## 项目结构

```text
packages/agent          Agent loop 和工具调用
packages/ai             模型目录、认证协议和流式模型调用
packages/coding-agent   Pi SDK、AgentSession、扩展、会话文件及终端模式
packages/pix-runtime    PiX Solo 会话工厂、任务服务、workflow worker、Plan、Todo 和 WSL
packages/pix-cli        pix 终端入口、会话文件锁与宿主命令
pix/                    Electron 主进程、IPC、preload 和 Vue
```

## 终端

使用 Node.js 22.19 或以上，通过 npm 全局安装。Windows 下运行 Bash 工具需要 Git Bash 或配置好的 Bash。

```bash
npm install -g @sombrer0/pix
pix --help
pix -p "检查这个项目"
```

从源码开发时，在仓库根目录安装依赖并构建 CLI。

```bash
npm install --ignore-scripts
npm run build:cli
npx --no-install pix --help
npx --no-install pix -p "检查这个项目"
npx --no-install pix --mode json -p "用子代理梳理测试目录"
npx --no-install pix --mode rpc
```

交互模式使用 `/plan` 查看计划命令，使用 `/tasks` 查询任务，用 `/cancel-task <id>` 取消任务。新会话默认关闭 ACP，可用 `--acp` 启用，空会话可用 `/acp on` 或 `/acp off` 调整。终端会话保存在 `<agentDir>/pix-cli-sessions`，`--session-dir` 选择其中的子目录。模型、凭据和扩展仍从原 `agentDir` 读取。

交互会话里，Ctrl+R 或 `/pix:history` 打开当前会话历史。列表用方向键、翻页、Home 和 End 移动，Enter 查看正文，Esc 或再按一次历史键关闭。Ctrl+O 批量展开主屏上的工具输出。Ctrl+T 切换主屏思考预览，设置里的对应项是 Hide thinking previews。这两项只影响主屏，历史里仍可查看思考和工具正文。会话选择器里的 Ctrl+R 仍是改名。

只重定向 stdout，或 stdin 不是终端时，走非交互输出。显式指定 JSON、RPC 或 `-p` 时，这些模式仍然优先。

开发时运行 `npm run dev:cli` 和 `npm run watch:pix-runtime`，分别监听 CLI 和共享运行时。

在 Linux、macOS 或 WSL 的 Linux 文件系统中运行 `npm ci --ignore-scripts` 和 `npm run pack:cli`，可生成包含运行依赖的 `dist/npm/sombrer0-pix-<version>.tgz`。

## 桌面开发与打包

在仓库根目录安装工作区依赖后，单独安装桌面依赖。开发环境需要已安装的 Electron 二进制。

```bash
npm --prefix pix install --ignore-scripts
npm --prefix pix run build
npm --prefix pix run dev
npm --prefix pix run package
```

打包前确认 `packages/ai/src/models.generated.ts`（以及 `image-models.generated.ts`）的改动已提交并推送。这两份文件是 `@earendil-works/pi-ai` 的模型目录源码，不是 `dist/` 产物；未进仓库则安装包里的模型列表、定价和上下文窗口仍是上一份已提交内容。

打包产物位于 `pix/release/`。发版时在仓库根目录运行 `npm run version:pix -- <version>`，同步三个 PiX 包的产品版本和两个锁文件。

运行 `npm run test:pix-runtime` 验证 CLI、共享运行时和桌面主进程。设置 `PIX_WSL_TEST_DISTRO` 可运行真实 WSL 用例，设置 `PIX_PACKAGED_EXE` 可验证打包后的桌面应用。另用 `-- --live` 运行需要真实模型凭据的任务用例。

## 依赖包

| 包名 | 说明 |
|------|------|
| `@earendil-works/pi-coding-agent` | Pi 编码代理核心 |
| `@earendil-works/pi-agent-core` | Agent 运行时 |
| `@earendil-works/pi-ai` | 多模型 LLM API |
| `pi-mcp-adapter` | MCP 协议适配器 |

## 许可证

MIT
