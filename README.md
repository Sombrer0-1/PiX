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
