# PiX

PiX 是一个基于 Electron 的桌面 GUI 应用，为 Pi AI 编码代理提供图形化界面。

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
- **配置入口**：设置 → WSL 分区（启用开关、默认发行版、默认 Linux 项目目录）；打开项目时选择 Windows/WSL 环境与发行版。WSL 不可用或未探测到发行版时相关控件禁用并显示诊断。

### 使用限制（v1）

- **不支持 PTY / 交互式 stdin**：vim、ssh、交互式确认等交互式命令不可用。
- **不支持后台任务**：run_background / read_output / stop_process 在 v1 不可用。
- **无长驻 bash 会话**：每条命令独立执行，cwd 固定在项目逻辑路径，不支持跨命令 cd 持久化。
- **MCP 限制**：WSL 模式禁用 Windows 侧 stdio 类型 MCP server（提示改用 HTTP/SSE，或将 server 运行在 WSL 内）；HTTP/SSE 保留但返回值不承诺路径改写。
- **扩展与 MCP 边界**：扩展和 MCP server 运行在宿主（Windows）侧，可能返回 `C:\...` 或 `\\wsl.localhost\...` 路径，遇到时用 `/mnt/c/...` 转换后交给 bash，或回传给同一工具。
- 工具错误与 PiX 生成的诊断只显示 Linux 逻辑路径，不泄露 UNC / 盘符；任意命令的原始 stdout/stderr 不重写。

## 项目结构

```
pix/
├── src/
│   ├── main/           # Electron 主进程
│   │   ├── index.ts    # 应用入口
│   │   ├── session-bridge.ts  # 会话管理桥接
│   │   ├── settings-store.ts  # 设置持久化
│   │   └── ipc-handlers.ts    # IPC 通信处理
│   ├── renderer/       # Vue 渲染进程
│   │   ├── components/ # UI 组件
│   │   ├── pages/      # 页面视图
│   │   ├── stores/     # Pinia 状态管理
│   │   └── composables/# 组合式函数
│   └── shared/         # 共享类型定义
├── package.json
└── tsconfig.json
```

## 开发

```bash
# 安装依赖
npm install --ignore-scripts

# 开发模式（同时启动 Vite 和 Electron）
npm run dev

# 仅启动渲染进程开发服务器
npm run dev:renderer

# 构建
npm run build

# 打包为可执行文件
npm run package
```

## 构建打包

```bash
# 构建并打包为安装程序
npm run package
```

打包产物位于 `release/` 目录，包含：
- Windows: `PiX Setup x.x.x.exe`
- macOS: `PiX-x.x.x.dmg`
- Linux: `PiX-x.x.x.AppImage`

## 依赖包

| 包名 | 说明 |
|------|------|
| `@earendil-works/pi-coding-agent` | Pi 编码代理核心 |
| `@earendil-works/pi-agent-core` | Agent 运行时 |
| `@earendil-works/pi-ai` | 多模型 LLM API |
| `pi-mcp-adapter` | MCP 协议适配器 |

## 许可证

MIT
