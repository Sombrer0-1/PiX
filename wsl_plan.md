
# PiX WSL2 原生执行支持工程实施方案

文档状态：可执行设计，目标版本 v1（Phase 0-2）。已经过四路对抗式验证（fidelity / contract+stage / technical / scope）修订。

本计划供 workflow 编排器及其下游 Coding Agent 使用。它锁定模块边界、数据结构、调用方向和验收标准；显然的 CRUD、Vue 模板细节、变量命名和常规 TypeScript 写法交给执行 Agent。

> 行号与现有代码已于 2026-08-07 逐项核对（核对结论见文末「附：核对勘误」）。executor 仍应以实际代码为准；若发现行号漂移，以符号名定位。
>

## 1. 整体设计理念

### 1.1 核心目标

在不改变 Windows 默认行为的前提下，让 PiX 中的 Agent 在项目级选择的 WSL2 distro 中获得一致的 Linux 工作语义：

- 模型看到 POSIX cwd、platform=linux、Linux shell、apt、正斜杠和 /dev/null。
- bash 在 WSL 原生 bash 中执行。
- read/write/edit/ls 通过 Windows Node 进程访问同一 distro 的 ext4 文件；find/grep 在 WSL 内运行 Linux fd/rg。
- 工具结果和 PiX 自己产生的错误不泄露 UNC 或 Windows 盘符路径。
- Team leader 与所有 worker 使用同一个执行 backend，不出现一部分 worker 跑 Windows、一部分 worker 跑 WSL 的混合团队。

本阶段交付单命令、无 PTY 的 WSL 后端和完整的单会话/团队接入。executionBackend 为 undefined 时必须保持现有 Windows 路径，不能因为 SDK 改造而改变现有默认行为。

### 1.2 采用 Host-Bridge + ExecutionBackend 的原因

PiX 是 Windows Electron 应用，主进程不能整体迁移到 WSL。把 WSL 细节散落到七个工具、SessionBridge 和 UI 会造成路径命名空间不一致，且未来无法支持第二种远程执行环境。因此采用两层：

1. SDK 只增加与平台无关的 ExecutionBackend 注入点，负责路径解析、七类 operations、运行环境描述和生命周期。
2. PiX 主进程实现 WSL backend，负责 wsl.exe、distro、UNC/盘符映射、WSL 进程清理和冷启动。

所有 WSL 识别、distro 名称和 UNC 字符串只允许出现在 pix/src/main/wsl/ 与主进程适配层，packages/coding-agent 不得依赖 PiX 文件。

### 1.3 双 cwd 是不可省略的设计

每个运行时同时保存：

- logicalCwd：模型和内建工具使用的 Linux POSIX 路径，例如 /home/bishe/work/fan-web。
- physicalCwd：Windows 主进程可访问的真实路径。ext4 项目是 \\wsl.localhost\<distro>\home\...，/mnt/c/... 项目是 C:\...。

SettingsManager、DefaultResourceLoader、SessionManager、扩展加载器、项目校验和主进程文件 IO 使用 physicalCwd。系统提示、内建工具路径解析、bash --cd 和模型可见附件名称使用 logicalCwd。禁止把一个字符串同时传给两个命名空间。

SDK 兼容规则：现有 `CreateAgentSessionOptions.cwd` 继续表示 host/bootstrap cwd（物理路径）；新增 `runtimeCwd` 表示 Agent runtime cwd（逻辑路径）。Windows 调用不传 `runtimeCwd`，SDK 自动令 `runtimeCwd = hostCwd`；WSL 调用显式传入双 cwd。

### 1.4 可扩展性

ExecutionBackend 的 operations 是按能力拆分的可选字段，未来可以实现 SSH、容器或远程 Linux，而不修改工具协议。路径上下文按 Session/backend 实例传递，不使用模块级 setter，允许同一 Electron 进程并行存在不同 distro 的 session。backend 在 session 生命周期外由主进程拥有，允许 Team worker 共享而不重复释放。

### 1.5 必须遵守的原则

1. **显式环境**：WSL 项目必须有明确 distro；禁止读取系统默认 distro 来推断项目归属。
2. **单向沉浸**：内建工具和 SDK 诊断只向模型呈现 Linux 路径；外部命令的任意 stdout/stderr 是原样数据，不做破坏性改写。
3. **实例隔离**：路径转换、home、distro 和 keep-alive 状态都绑定 backend/session，禁止全局 setWslPathContext。
4. **失败快速且可操作**：WSL 不可用、distro 不存在、逻辑 cwd 不存在、rg/fd 缺失都必须在启动或首次能力调用时给出明确诊断（含 distro 名与 apt 安装提示），不能静默退回另一个 distro 或 Windows 工具。
5. **Windows 无回归**：无 backend 的 operations、路径结果、grep 流式解析、ls broken-link 行为、bash 的 `shellPath`/`commandPrefix` 设置和现有设置全部保持原语义。
6. **生命周期确定**：每条 bash 命令独立 spawn，固定 --cd；不实现跨命令 cd、长驻 bash、PTY 或 v1 后台任务。
7. **边界分层**：扩展宿主/MCP 是宿主能力，不能假定已获得内建工具的 WSL 沉浸保证；系统提示须显式告知模型这一边界。
8. **不引入新依赖**：使用仓库已有 TypeScript、Node child_process/fs 和 Vuetify；不得为 v1 添加 node-pty、WSL 专用 npm 包或自动下载器。

### 1.6 v1 明确不做的内容

- PTY、交互式 stdin、vim/ssh/交互式确认。
- run_background、read_output、stop_process 的 WSL 进程组生命周期。
- 自动下载 Linux rg/fd 二进制。
- 长驻 bash 会话和跨命令 cwd 持久化。
- 通用 MCP 返回值路径猜测或 schema 无关的路径重写。
- 全仓 fs.watch/chokidar 审计：v1 的 7 个内建工具不使用 fs.watch；若主进程存在项目级 watcher（settings 热重载等），其属于宿主能力而非沉浸表面，须在 S13 用 `grep -r "fs.watch\|chokidar" pix/src/main` 审计，任何受 9P 影响的站点需先追加到 §3 再修，不得在 v1 静默放行。

以上 v1 不做项只能作为 v2 独立设计，执行 Agent 不得为了"顺手完成"而扩大范围。

## 2. 系统架构设计

### 2.1 分层结构

~~~text
Vue renderer
  -> typed preload IPC
Electron main
  -> ProjectLocation / ProjectExecutionContext
  -> SessionBridge (one context per active runtime)
       -> SettingsManager / ResourceLoader / SessionManager: physicalCwd
       -> createAgentSession({ cwd: physicalCwd, runtimeCwd: logicalCwd,
                              executionBackend, runtimeEnvironmentOverride })
            -> AgentSession: logical cwd for prompt/tools, host cwd for extensions
            -> seven built-in tools <- ExecutionBackend operations
       -> TeamManager: same backend object for leader and workers
  -> WslExecutionBackend
       -> WslBashOperations -> wsl.exe -> bash -c
       -> WslFileOperations -> Node fs over UNC/drive, fd/rg via wsl.exe
       -> WslPathConverter / WslDistroResolver / WslRuntime
~~~

宿主平台和执行平台必须分开：process.platform 仍然是 Windows，负责 Electron、windowsHide、主进程 taskkill 和平台资产；WSL backend 通过 runtimeEnvironmentOverride 让模型看到 platform=linux。任何宿主决策不得读取模型可见的 platform 字段。

### 2.2 模块职责

- **SDK backend contract**：只定义接口和注入优先级；不认识 WSL、distro、UNC。
- **工具路径层**：把模型的相对/POSIX 路径解析成 backend 可消费的绝对路径；保留本地 Windows 路径实现作为未注入时的 fallback。
- **WSL resolver/path**：列举显式 distro、校验版本和目录、解析 automount 根、执行 Linux/Windows 路径转换。
- **WSL runtime**：集中管理 wsl.exe spawn、ready timeout、keep-alive、abort/timeout 双杀。
- **WSL operations**：把 runtime 和 converter 适配为七个 SDK operations；所有文件错误在这里回译。
- **Project execution context**：将可持久化的 ProjectLocation 解析成双 cwd、backend 和 runtime prompt override。
- **SessionBridge**：一个活跃会话拥有一个不可变 context；启动、切换、fork、reload 都复用该 context；停止时负责关闭 backend。
- **TeamManager**：保存 leader context/backend；worker 只复用，不创建、不释放 backend。
- **Settings/IPC/renderer**：管理全局 WSL 默认值和项目级环境选择；UI 不执行路径转换和 wsl.exe。
- **MCP adapter**：在 WSL 模式拒绝 Windows 侧 stdio server，并返回诊断；HTTP/SSE 保留，输出不承诺沉浸。

### 2.3 数据流与调用关系

#### 打开项目

1. Renderer 从全局设置得到 WSL 默认值，ProjectOpenDialog 产生 ProjectLocationInput。
2. IPC 主进程调用 resolveProjectLocation。Windows 项目要求 physicalPath；WSL 项目要求显式 distro 和绝对 POSIX logicalPath，再转换出 physicalPath。
3. createProjectExecutionContext 验证物理目录和 WSL 目录，构造 backend；WSL backend 启动预热/keep-alive。
4. SessionBridge.start(context.location, guiSettings) 关闭旧会话，向所有 bootstrap 消费者传 physicalCwd，向 SDK 传 runtimeCwd=logicalCwd。
5. SDK 将 backend operations 注入七个工具，运行时系统提示使用 Linux override。成功后 IPC 返回环境状态；失败不替换当前已运行会话。

#### Agent 工具调用

1. 模型只产生相对路径或 POSIX 绝对路径。
2. 工具先使用显式 per-tool resolver，否则使用 backend resolver，最后才使用本地默认 resolver。
3. read/write/edit/ls/access/stat/mkdir 将逻辑路径转换为 physical path；find/grep 的搜索进程接收逻辑路径和固定 distro。
4. WSL 文件 operations 将 Node 错误中的 UNC/盘符转换回逻辑路径后再抛出。bash 的任意命令输出不重写，只在检测到明显 Windows 路径失败时追加提示。

#### Team

Leader 的 ProjectExecutionContext.backend 传给 TeamManager.initialize。每个 worker 使用同一 backend 实例、同一 distro、同一 logical/physical cwd；worker 的 SettingsManager、ResourceLoader、SessionManager 仍以 physical cwd 创建。Team snapshot 和 workspace mode 继续以 physical cwd hash。

### 2.4 禁止的耦合

- SDK 的**新增 backend-contract 代码**不得 import pix/src/main，不得引入 wsl.exe、WSL_DISTRO_NAME、\\wsl.localhost（注：`packages/coding-agent/src/utils/clipboard-image.ts:144` 已有 `WSL_DISTRO_NAME` 用于宿主剪贴板检测，属既有代码、与本计划无关、不在修改范围）。
- Renderer 不得 import Node path/fs，不得自行拼 UNC 或调用 wsl.exe（原生目录对话框与路径转换由主进程 `file-dialogs.ts`/`resolveProjectLocation` 完成）。
- SettingsManager/ResourceLoader/SessionManager 不得接收 logical cwd；内建工具不得直接读取 physicalCwd。
- Team worker 不得各自 createWslExecutionBackend，不得在 worker dispose 时释放 shared backend。
- MCP adapter 不得假设任意 HTTP/SSE 返回值是可安全转换的路径；v1 不做 schema 无关 shim。
- 不得通过全局变量记录当前 distro、home 或 cwd。

## 3. 文件级设计

以下是 v1 唯一允许新增/修改的源码和文档范围。除非本节列出的接口编译需要，否则不得修改其它相邻文件。**`packages/coding-agent/src/main.ts` 不在本计划修改范围**（见 §4.1 说明）。

### 3.1 SDK 与工具层

| 文件 | 操作 | 职责、原因、关系和接口边界 |
|---|---|---|
| packages/coding-agent/src/core/tools/execution-backend.ts | 新增 | 定义 generic ExecutionBackend、ToolPathContext、ToolPathResolver；只 type-import 七类 operations 和 RuntimeEnvironmentContext。它是 SDK 与任何远程执行实现的唯一接缝。 |
| packages/coding-agent/src/core/agent-session.ts | 修改 | `AgentSessionConfig`（:212）复用现有 `cwd` 作 hostCwd，新增 `runtimeCwd?`、`executionBackend?`、`runtimeEnvironmentOverride?`；存为 `_executionBackend`/`_runtimeCwd`。`_buildRuntime`（:3056，注入缺口 :3071-3074 只传 read/bash）改为从 backend 取 ops 填充全部 7 工具，并改用 `_runtimeCwd`；`reload`（:3110，内调 `_buildRuntime` :3116）读取同一实例字段；`executeBash`（:3254，cwd 当前读 `sessionManager.getCwd()` :3269）改用 `_runtimeCwd`、默认 `options?.operations ?? this._executionBackend?.bash ?? createLocalBashOperations({ shellPath })`（**必须保留 `{ shellPath }`**）；approval policy（:573，当前读 `sessionManager.getCwd()`）、`exportToHtml` 的 tool renderer cwd（:3699，当前读 `sessionManager.getCwd()`）改用 `_runtimeCwd`；`exportToJsonl` header（:3730，当前读 `sessionManager.getCwd()`）显式存 physicalCwd 并文档化；`_rebuildSystemPrompt`（:1214，cwd 在 `BuildSystemPromptOptions.cwd` :1238）改用 `_runtimeCwd`；ExtensionRunner（:3090）、extension resource discovery（:2773）、background tool definitions（:445）**保留 `_cwd`（hostCwd）不动**。`_runtimeEnvironmentContext`（:1189）只承载 platform/osName/shell，优先合并 override。 |
| packages/coding-agent/src/core/sdk.ts | 修改 | `CreateAgentSessionOptions`（:35）增 `runtimeCwd?`、`executionBackend?`、`runtimeEnvironmentOverride?`；`createAgentSession` 在 :415-431 转发这些字段到 `new AgentSession`。PiX 直接调用本函数（session-bridge.ts:1302、team-manager.ts:794）。 |
| packages/coding-agent/src/core/agent-session-services.ts | 修改 | `AgentSessionServices.cwd`（:69）固定表示 host cwd，新增 `runtimeCwd?`、`executionBackend?`、`runtimeEnvironmentOverride?`；`createAgentSessionFromServices`（:181）转发到 `createAgentSession`（:185）。`createAgentSessionServices` 用 `cwd` 构造 SettingsManager（:137）/ResourceLoader（:139），SessionManager 由调用方传入。CLI/TUI 走此路径，不传 runtimeCwd 时 SDK 令 `runtimeCwd ??= hostCwd`，故 main.ts 无需改动。 |
| packages/coding-agent/src/core/agent-session-runtime.ts | 修改 | `CreateAgentSessionRuntimeFactory`（:30-35）与 `switchSession`（:187）/`newSession`（:212）/`fork`（:246）/`importFromJsonl`（:340）的 `createRuntime` 调用均转发 `runtimeCwd`/`executionBackend`/`runtimeEnvironmentOverride`；`services.cwd` 仍是 host cwd。 |
| packages/coding-agent/src/core/tools/index.ts | 修改 | `ToolsOptions`（:102-110，仅含 7 个 ops 字段）增 `executionBackend?`；合并优先级「显式 per-tool > backend > local default」集中在**一个** merge helper，`createToolDefinition`（:112）、`createAllToolDefinitions`（:172-181）、`createCodingToolDefinitions`（:154）、`createReadOnlyToolDefinitions`（:163）、`createAllTools`（:202）**全部**经此 helper。helper 形如 `{ ...perToolOptions, operations: perToolOptions.operations ?? backend.<tool>, pathContext: perToolOptions.pathContext ?? backend.paths }`（spread 在前），**保留全部既有字段**（`autoResizeImages`、`commandPrefix`、`shellPath`、`spawnHook`）。 |
| packages/coding-agent/src/core/tools/bash.ts | 修改 | `BashToolOptions`（:144）增 `pathContext?: ToolPathContext`；`BashOperations` 接口（:41）不改（S5 的 `createWslBashOperations` 实现它，见 §4.6）。 |
| packages/coding-agent/src/core/tools/read.ts | 修改 | `ReadToolOptions`（:58）增 `pathContext?`；以 resolved physical path 调 operations；WSL 模式跳过 macOS 专用探测；生成逻辑路径错误（当前 :332-334 直接 `reject(error)` 原样上抛）。 |
| packages/coding-agent/src/core/tools/write.ts | 修改 | `WriteToolOptions`（:47）增 `pathContext?`；保持现有 diff/行尾/BOM 逻辑；将 mutation queue 使用的 key 交给 WSL context。 |
| packages/coding-agent/src/core/tools/edit.ts | 修改 | `EditToolOptions`（:89）增 `pathContext?`；预览和执行使用同一逻辑 cwd；保持整文件 read-modify-write 与现有 edit contract（:339-346 BOM/行尾逻辑 fs-agnostic）。 |
| packages/coding-agent/src/core/tools/grep.ts | 修改 | `GrepToolOptions`（:63）增 `pathContext?`；`GrepOperations`（:51）增 `spawnRipgrep?`（§4.2）；`:172` `ensureTool('rg')` 移进 `!spawnRipgrep` 分支；rg spawn 增独立 timeout，按路径类别翻倍（`/mnt/c` 跨界翻倍，ext4 `/home/...` 默认）；`formatPath`（:190-198）按 pathStyle 选 posix。 |
| packages/coding-agent/src/core/tools/find.ts | 修改 | `FindToolOptions`（:54）增 `pathContext?`；`customOps?.glob`（:155 escape hatch）可返回 Linux absolute path；fd 输出相对化（:300-313）WSL 模式用 `path.posix`。 |
| packages/coding-agent/src/core/tools/ls.ts | 修改 | `LsToolOptions`（:47）增 `pathContext?`；`LsOperations`（:32）增 `readdirWithTypes?`；`:164-168` 存在时跳过 stat 循环；**`:161` `nodePath.join` 改按 pathStyle 选 `path.posix.join`**（win32 join 会 mangle Linux 路径，损坏传给 `ops.stat` 的路径）；明确 broken symlink 显示行为。 |
| packages/coding-agent/src/core/tools/path-utils.ts | 修改 | `resolveToCwd`（:48）/`resolveReadPathAsync`（:86）/`resolveReadPath`（:59 macOS NFD 变体 :59-81）接受 ToolPathContext 或 resolver；WSL 模式不做无意义的 macOS 专用 fs 探测。 |
| packages/coding-agent/src/core/tools/edit-diff.ts | 修改 | `computeEditsDiff`（:418）当前**直接**调 Node `fs.access`（:428）/`fs.readFile`（:435），不经 operations，路径经 `resolveToCwd`（:423）。WSL 模式必须把文件读取改走 operations（与 edit.ts 一致）或在 fs 调用前把逻辑路径转 physical，并接受 resolver；**新增参数全部 optional，带 local-fs 默认**，以保持 `computeEditsDiff(filePath, edits, cwd)` 三参调用（test/edit-tool-no-full-redraw.test.ts、tools.test.ts 等范围外调用方）不变。 |
| packages/coding-agent/src/utils/paths.ts | 修改 | `PathInputOptions`（:9-20）**已含 `homeDir?`**（:15）；本计划**仅新增 `posix?`** 选项让 `resolvePath`（:81）/`normalizePath`（:57）用 `path.posix.isAbsolute/resolve`。保留未传选项的原有 win32 行为；`canonicalizePath`（:28 realpathSync）在 WSL 模式禁用或改 `wsl -e realpath`，不用 Windows realpathSync 解析 Linux 逻辑路径。 |
| packages/coding-agent/src/core/tools/render-utils.ts | 修改 | `shortenPath`（:10，用 `os.homedir()` :12）改用注入 home；`linkPath`（:19，`pathToFileURL` :22）可把逻辑路径转 Windows 可打开的 file URL，但不把 UNC 写入模型工具文本。 |
| packages/coding-agent/src/core/tools/file-mutation-queue.ts | 修改 | `getMutationQueueKey`（:16-17 resolve+realpath）支持 `getKey?: ToolMutationKeyResolver`（`withFileMutationQueue` 当前无 key 选项）；WSL context 先 `linuxToWindows` 再 resolve/realpath，保证 symlink 去重。 |
| packages/coding-agent/src/core/skills.ts | 修改 | `formatSkillsForPrompt`（:335）当前把 `skill.filePath`（win32）直接写进 `<location>`（:354）；增可选 display formatter，使 prompt 中 location 使用逻辑路径，真实加载路径仍 host/physical。 |
| packages/coding-agent/src/core/file-change.ts | 修改 | `isPathInsideCwd`（:61，用 node:path win32）接受 resolver/path style，按逻辑 cwd 判断编辑边界。 |
| packages/coding-agent/src/core/tool-execution-policy.ts | 修改 | `inspectToolExecution`（:56，经 `isPathInsideCwd` :77、`isWindowsReservedDevicePath` :71/:24）用 logical resolver 计算边界和诊断；当前只拒 Windows 保留设备名、**不拒 UNC**，WSL 文件工具须显式拒绝 Windows/UNC 输入并附引导。 |
| packages/coding-agent/src/core/system-prompt.ts | 修改 | `RuntimeEnvironmentContext`（:29，**无 cwd 字段**，含 platform/osName/timezone/executionMode/verificationGate/shell）；`shell.kind`（:38）增 `'wsl'`；`shellKindFromPath`（:126）识别 wsl；`renderEnvironmentContext`（:140）新增 WSL 提示词分支（含 MCP/扩展路径边界提示，见 §7.3）；`editing_contract`（:427-428）Windows `/dev/null` 与保留设备文本改为 platform 条件渲染，WSL 下保留 `/mnt/<drive>` 保留设备名警告。 |
| packages/coding-agent/src/utils/shell.ts | 修改 | 仅让 `isPosixLikeShell`（:11）认识 wsl；`getShellConfig`（:139）、`getShellEnv`（:194，注入 `getBinDir()` `~/.pi/agent/bin`，跨平台）、`killProcessTree`（:272 taskkill /F /T）不为 WSL 改；WSL bash 完全绕开 getShellConfig。 |
| packages/coding-agent/src/core/index.ts | 修改 | re-export 新 backend/runtime contract（若当前 barrel 不自动暴露）。 |
| packages/coding-agent/src/index.ts | 修改 | 对外导出 ExecutionBackend、ToolPathContext 和新增 SDK 类型（当前 re-export core/sdk 与 core/tools/index，需在 tools 导出块补新类型）。 |
| packages/coding-agent/test/execution-backend.test.ts | 新增（S2 独占） | 覆盖双 cwd、backend/per-tool 优先级、reload/session replacement、POSIX 路径上下文、merge helper 保留 `commandPrefix`/`shellPath`/`autoResizeImages`、未注入 backend 的 Windows 回归（含 `sessionManager.getCwd()===_cwd` 不变式）。 |

### 3.2 MCP 层

| 文件 | 操作 | 职责、原因、关系和接口边界 |
|---|---|---|
| packages/mcp-adapter/src/index.ts | 修改 | `McpAdapterOptions`（:72-79，当前无 allowStdio）增 `allowStdio?: boolean`（默认 true）；`createTransport`（:659）的 stdio 分支（:661）在 `allowStdio=false` 时跳过 spawn 并产出明确诊断。HTTP/SSE（:687/694/700）不变。adapter 不负责通用路径重写。v2 可评估「经 wsl.exe 在 WSL 内 spawn stdio server」作为更宽松替代（见 §4.10）。 |

### 3.3 PiX 主进程与共享契约

| 文件 | 操作 | 职责、原因、关系和接口边界 |
|---|---|---|
| pix/src/shared/project-location.ts | 新增 | 定义可序列化 ProjectEnvironment、ProjectLocation、ProjectLocationInput、WslSettings、WslDistroInfo、WslDistroListResult、ResolveProjectLocationResult、ExecutionEnvironmentInfo；renderer/preload/main 共用。 |
| pix/src/main/execution-context.ts | 新增 | 将 location 解析为 ProjectExecutionContext，创建/销毁 backend，校验双 cwd；不承载 UI 状态。 |
| pix/src/main/wsl/wsl-distro.ts | 新增 | 解析 wsl.exe -l -v UTF-16LE 输出、显式 distro 校验、Linux directory/home/automount 探测。 |
| pix/src/main/wsl/wsl-paths.ts | 新增 | 实现 WslPathConverter：ext4 -> UNC，/mnt/<single-letter-drive> -> Windows drive，反向转换和 cross-distro guard。 |
| pix/src/main/wsl/wsl-runtime.ts | 新增 | 集中 wsl.exe spawn、warm-up、keep-alive、ready timeout、abort/timeout 双杀与 pgid 控制文件；供 bash/file/grep operations 复用。 |
| pix/src/main/wsl/wsl-bash-operations.ts | 新增 | 实现 SDK BashOperations（包装 `runtime.spawnBash`），每命令 --cd + bash -c，固定 stdio 和最小 Linux env。 |
| pix/src/main/wsl/wsl-file-operations.ts | 新增 | 组装 Read/Write/Edit/Ls/Find/Grep operations；UNC/drive IO、WSL 原生 fd/rg/mkdir、错误回译和 mutation queue key。 |
| pix/src/main/wsl/wsl-execution-backend.ts | 新增 | 组合 resolver/runtime/operations，返回 SDK ExecutionBackend、logical cwd、physical cwd、runtime override；backend 实例不可变。 |
| pix/src/main/session-bridge.ts | 修改 | `start(projectDir:string,...)`（:169）改为接收 ProjectLocation/context；`_cwd`（声明 :138，赋值 :173）、`_assertProjectDirectory`（:1462 existsSync :1466）、`_createSession`（:1283，`createAgentSession` :1302，cwd :1303）、`listSessions`（:208）、`switchSession`（:303，重赋 `_cwd` :313）、`fork`（:356）全部以 context 来源：bootstrap 用 physicalCwd，`createAgentSession` 传 `runtimeCwd=logicalCwd`+backend；生命周期拥有并释放 backend。`_getSessionDir`（:1270）hash 输入改用 physicalCwd。MCP adapter `new McpAdapter()`（:1289，无 options）WSL 模式传 `{allowStdio:false}`。`processChatFiles` 调用点（:996）传入 displayPath。 |
| pix/src/main/team-manager.ts | 修改 | `initialize(cwd:string,authStorage)`（:182）改为接收 leader ProjectExecutionContext；`_launchWorkerInner`（:740）的 `createAgentSession`（:794-802，当前不传 operations、用 `this._cwd` :795）改为传同一 backend + `runtimeCwd=logicalCwd`、bootstrap 用 physical；`_restorePersistedTeamIfPresent`（:3379）贯穿 backend；worker SessionManager/SettingsManager/ResourceLoader（:767-772）用 physical。MCP adapter `new McpAdapter()`（:769，无 options）WSL 模式传 `{allowStdio:false}`（allowStdio 由 context 显式传入，不从 backend 存在性推断）。不在 worker dispose backend。 |
| pix/src/main/chat-files.ts | 修改 | `processChatFiles`（:22-26，:149 `resolve(cwd,expanded)`）新增**可选** `displayPath?: (physical: string) => string`（或 `pathContext?`）参数（调用方 session-bridge.ts:996 传入）；产生的绝对路径当前泄漏到附件 `path` 字段（:44/:56/:92）与 `<file name="${absolutePath}">` 标签（:67/:86-87/:98），WSL 模式这两处经 displayPath 回译为 logical，物理路径只用于实际读文件。内部 `resolveReadPath`/`buildPathCandidates`（:113-124）的 NFC/NFD/NFKC/NFKD + curly-quote `existsSync` 探测在 WSL 模式跳过（macOS 专用、10+ 9P 往返无意义）；IO 仍用 physicalCwd。 |
| pix/src/main/settings-store.ts | 修改 | electron-store（:24-27 仅 defaults，无 JSON schema）持久化/迁移 `schemaVersion=2`、`wsl` 和新 ProjectInfo；`addRecentProject`（:93-98）、`projectPathExists`（:120-126 `existsSync&&isDirectory`）按 physicalPath 检查项目存在，不能对 Linux logical path 调 win32 fs。 |
| pix/src/main/ipc-handlers.ts | 修改 | `start-pi`（:233）、`start-team-runtime`（:254，`teamManager.initialize` :265）、`has-team-snapshot`（:294）、`get-workspace-mode`（:298，调 `readWorkspaceMode`）、`set-workspace-mode`（:303，调 `writeWorkspaceMode`）、`list-sessions`（:383）当前均收 string `projectDir`，改为校验 location/settings；新增 distro/environment/location IPC；所有 snapshot/mode/session 查询以 physical cwd 为 key。 |
| pix/src/main/preload.ts | 修改 | `pixApi`（:263）暴露与主进程一致的 typed location、distro、environment API（`startPi` :35、`startTeamRuntime` :37、`hasTeamSnapshot` :39、`getWorkspaceMode` :40、`setWorkspaceMode` :41、`listSessions` :71、`listTeamLeaderSessions` :72 当前均 string）；保持 contextBridge 边界。注：`pix/tsconfig.main.json:15` exclude preload.ts，S9 的 tsc gate 不覆盖它，其类型正确性由 `build:renderer` 兜底。 |
| pix/src/shared/types.ts | 修改 | `ProjectInfo`（:280）、`GuiSettings`（:302，无 schemaVersion）、`RpcSessionState`（:87，**无 cwd 字段**，`executionMode` 是 approval 模式，与新 `executionEnvironment` 无关，不得混淆）、`SessionInfo`（:287，**含 `cwd` 与 `path`**，WSL 模式 listSessions 返回时 `cwd` 须回译 logical；`path` 为 session JSONL 物理路径，不展示给模型）引用新共享类型并增加 execution environment。 |
| pix/src/main/__tests__/wsl.test.ts | 新增（S3→S4→S5 串行扩展） | converter/resolver/runtime/operations 的独立测试入口；支持 `--filter paths|runtime|operations`；真实 WSL 用例由环境变量 `PIX_WSL_TEST_DISTRO` 显式启用，无 distro 时 skip。 |
| pix/src/main/__tests__/execution-context.test.ts | 新增（S6 独占） | 覆盖 ProjectLocation 迁移、双 cwd、显式 distro、context 生命周期和 physical key。 |
| pix/src/main/__tests__/team-manager.test.ts | 修改（S8 独占） | 增加 shared backend、physical snapshot key 和 worker bootstrap 的回归断言；保持 standalone（plain tsx + assert）运行方式。 |

`packages/coding-agent/src/core/background-task-registry.ts`（由 `AgentSession` 在 `agent-session.ts:438` 内部 `new`，**未从 package barrel 导出**；其 `start`（:26）在 :28 调 `getShellConfig()` 无参、Windows 侧 spawn，`stop`（:153））、`pix/src/main/team-persistence.ts`（`teamSnapshotPath` :13、`workspaceModePath` :21、`readWorkspaceMode` :26、`writeWorkspaceMode` :37，由 ipc-handlers 调用）和已有 UI 样式文件在 v1 不需要结构性修改；前者通过 excludeTools 禁用，后两者由调用方继续传 physical cwd。

### 3.4 Renderer 与文档

| 文件 | 操作 | 职责、原因、关系和接口边界 |
|---|---|---|
| pix/src/renderer/types/session.ts | 修改 | re-export ProjectLocation、ProjectEnvironment、WslSettings 等共享类型。 |
| pix/src/renderer/types/rpc.ts | 修改 | re-export WslDistroInfo、ExecutionEnvironmentInfo 和更新后的 RpcSessionState。 |
| pix/src/renderer/types/ipc.ts | 修改 | re-export 新 IPC 入参/返回类型。 |
| pix/src/renderer/stores/settings-store.ts | 修改 | 加载/保存全局 WSL 设置，维护 distro 列表和不可用诊断。 |
| pix/src/renderer/stores/project-store.ts | 修改 | 以 ProjectLocation 管理当前/最近项目（`openProject(dirPath:string,...)` :78 当前为 string）；Windows key 可大小写归一，POSIX 项目保持大小写敏感；启动和 session 列表传 location。 |
| pix/src/renderer/stores/team-store.ts | 修改 | `toggleTeamMode(projectDir?:string)`（:409，当前 string，调 `singleRpc.startRuntime` :421/426/450、`teamLeaderRpc.startTeamRuntime` :445、`setWorkspaceMode` :440/457）改为接收 location；拒绝 leader/worker 环境混用；切换环境前要求先停止并新建 runtime。 |
| pix/src/renderer/composables/useRpc.ts | 修改 | `startRuntime: (projectDir:string)=>...`（:31，IPC :59，wrapper :232，别名 `startPi` :496）和 session API 使用 ProjectLocation；连接状态消费 execution environment。 |
| pix/src/renderer/composables/useTeamLeaderRpc.ts | 修改 | `startRuntime: (projectDir:string)=>api().startTeamRuntime(projectDir)`（:15）改为与单人 transport 完全相同的 location 契约。 |
| pix/src/renderer/components/project/ProjectOpenDialog.vue | 新增 | Vuetify 项目选择器：Windows/WSL 分段模式、distro select、Linux cwd 输入、原生对话框辅助转换（主进程完成）；通过 props/emits 输出 ProjectLocationInput。 |
| pix/src/renderer/components/project/ProjectList.vue | 修改 | `{{ project.path }}`（:44）改为显示环境 kind/distro 和 logical path；点击传完整 location。 |
| pix/src/renderer/pages/HomePage.vue | 修改 | `rpc.startPi(dirPath)`（:94）、`toggleTeamMode(dirPath)`（:66/:84）、`openProject(dirPath,...)`（:36/:72）、`openRecentProject`（:108）改用 ProjectOpenDialog 打开项目；最近项目恢复使用 persisted physicalPath + logical path，team snapshot/mode API 传 location。 |
| pix/src/renderer/pages/SettingsPage.vue | 修改 | 独立 WSL 设置区：启用开关、distro、defaultCwd、不可用诊断。WSL hint 实际在 `shellCommandPrefix` 字段（:436，"例如 wsl"），`shellPath` 是相邻 :435；须清理该 hint 指向独立 WSL 区，避免用户把 shellCommandPrefix/shellPath 填成 wsl 触发 `getShellConfig` 抛错。实现前必须再次查阅仓库根目录 vuetify_guide。 |
| pix/src/renderer/pages/WorkspacePage.vue | 修改 | workspace mode、session 查询和环境状态使用 location；显示 backend 启动错误而不吞掉 distro/路径诊断；MCP stdio-disabled 错误须以具体消息显示，不得折叠为通用启动失败。 |
| pix/src/renderer/components/layout/LeftPanel.vue | 修改 | team toggle/list/delete 流程使用当前完整 location；显示 logical path 和环境标签。 |
| pix/src/renderer/components/layout/CenterPanel.vue | 修改 | team/solo 切换传 location；不从 location 自行拼 physical path。 |
| pix/src/renderer/components/layout/RightPanel.vue | 修改 | `projectPath.split(/[/\\]/).pop()`（:62/:267 basename）改为显示 logical cwd 和执行环境，避免显示 UNC。 |
| pix/src/renderer/components/layout/TopBar.vue | 修改 | `currentProject?.name`（:16/:26）旁增加紧凑的 Windows/WSL+distro 状态显示，来源只读 RpcSessionState.executionEnvironment。 |
| README.md | 修改 | 记录 WSL2/显式 distro/项目 logical path/rg+fd 前置条件、MCP 限制和 v1 不支持 PTY/后台任务。 |


## 4. 接口与数据结构设计（自包含契约）

> 本节是 workflow 下游 agent 的唯一协调依据。所有被引用的既有类型在本节内联或显式标注 `file:line`。新增字段的 operations 接口给出「现有形状 + 新字段」。

### 4.1 SDK backend 与双 cwd 契约

~~~typescript
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type ToolPathResolver = (input: string, cwd: string) => string;
export type ToolMutationKeyResolver = (absolutePath: string) => Promise<string>;

export interface ToolPathContext {
  readonly pathStyle: "win32" | "posix";
  readonly homeDir: string; // 对应 paths.ts 已有的 PathInputOptions.homeDir
  /** Resolve to an absolute path in the runtime namespace, never the host namespace. */
  readonly resolvePath: ToolPathResolver;
  /** Convert a host path back to a model-visible runtime path; logical input returned unchanged. */
  readonly displayPath?: (path: string) => string;
  /** Build a host-openable URL without changing model-visible tool text. */
  readonly toFileUrl?: (absolutePath: string) => string;
  /** Return an opaque, canonical identity used only by the mutation queue. */
  readonly getMutationKey?: ToolMutationKeyResolver;
}

export interface ExecutionBackend {
  readonly paths: ToolPathContext;
  readonly bash?: BashOperations;
  readonly read?: ReadOperations;
  readonly write?: WriteOperations;
  readonly edit?: EditOperations;
  readonly grep?: GrepOperations;
  readonly find?: FindOperations;
  readonly ls?: LsOperations;
  readonly runtimeEnvironment?: Partial<RuntimeEnvironmentContext>;
  readonly assertProjectDirectory?: (runtimeCwd: string) => Promise<void> | void;
  readonly getCwd?: () => string;
  readonly dispose?: () => Promise<void>;
}

export interface ToolsOptions {
  executionBackend?: ExecutionBackend;
  read?: ReadToolOptions;
  bash?: BashToolOptions;
  write?: WriteToolOptions;
  edit?: EditToolOptions;
  grep?: GrepToolOptions;
  find?: FindToolOptions;
  ls?: LsToolOptions;
}

export function resolveToCwd(input: string, cwd: string, paths?: ToolPathContext): string;
export function resolveReadPathAsync(input: string, cwd: string, paths?: ToolPathContext): Promise<string>;
export function withFileMutationQueue<T>(
  absolutePath: string,
  fn: () => Promise<T>,
  options?: { getKey?: ToolMutationKeyResolver },
): Promise<T>;
~~~

`AgentSessionConfig`（agent-session.ts:212）复用现有 `cwd` 作为 hostCwd，新增 `runtimeCwd?`、`executionBackend?`、`runtimeEnvironmentOverride?`。`CreateAgentSessionOptions`（sdk.ts:35）新增 `runtimeCwd?`、`executionBackend?`、`runtimeEnvironmentOverride?`，`createAgentSession`（:415-431）转发。SDK 必须按以下顺序计算：

1. hostCwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd())。
2. runtimeCwd = options.runtimeCwd ?? options.executionBackend?.getCwd?.() ?? hostCwd。
3. 默认 Settings/Resource/Session manager 使用 hostCwd，AgentSession 的 runtime cwd 使用 runtimeCwd，ExtensionRunner 使用 hostCwd。
4. executeBash、approval path policy、`exportToHtml` tool renderer、七个工具和系统提示使用 runtime cwd；`exportToJsonl` header 存 physicalCwd（见重定向表）。
5. 运行环境按"本地探测值 < backend.runtimeEnvironment < 显式 runtimeEnvironmentOverride"**浅合并**（`shell` 字段整体替换，backend 须提供完整 shell 对象）；backend 不得覆盖 settings 提供的 executionMode/verificationGate。
6. Windows 不传 runtimeCwd/backend 时，二者相同，行为保持不变。

`AgentSessionServices.cwd`（:69）固定表示 host cwd，新增 `runtimeCwd?`、`executionBackend?`、`runtimeEnvironmentOverride?`；`createAgentSessionFromServices`（:181）和 `AgentSessionRuntime` 的 new/resume/fork/import factory 必须转发这些字段；不传时 SDK 令 `runtimeCwd ??= hostCwd`，故 `main.ts` 与 CLI/TUI 调用路径无需改动。各 `*ToolOptions`（见 §4.2）各增加 `pathContext?: ToolPathContext`；合并优先级「显式 per-tool `operations`/`pathContext` > `executionBackend.<tool>`/`executionBackend.paths` > 既有 local default」，由 §3.1 的单一 merge helper 实现。WSL 的 `paths.resolvePath` 只做 POSIX 解析与 home 展开，返回 /home/... 或 /mnt/c/... 逻辑绝对路径；它绝不能返回 UNC/盘符。read/write/edit/ls operations 在边界内部将逻辑绝对路径转换为 physical path，find/grep 直接消费逻辑绝对路径。`paths.getMutationKey` 才允许短暂转换成 physical realpath，返回值只作为 Map key；`paths.toFileUrl` 只用于 TUI/GUI hyperlink。这个命名空间约定适用于 policy、diff preview、file-change 和所有错误消息。

**agent-session.ts 内部 cwd 重定向（实现约束，非可选）**：当前 `AgentSession` 只有一个 `this._cwd`（:403，赋值 :448），同时被 runtime 与 host 两侧消费；`sessionManager.getCwd()` 在四处被用作 cwd 来源。引入 `this._runtimeCwd` 后，必须按下表重定向，**不得整体替换 `this._cwd`**：

| 调用点 | 现状 | 改为 |
|---|---|---|
| `_buildRuntime` -> `createAllToolDefinitions` cwd（:3071） | `this._cwd` | `this._runtimeCwd` |
| `_rebuildSystemPrompt` `BuildSystemPromptOptions.cwd`（:1238） | `this._cwd` | `this._runtimeCwd` |
| `executeBash` cwd（:3269） | `this.sessionManager.getCwd()` | `this._runtimeCwd` |
| tool approval policy cwd（:573） | `this.sessionManager.getCwd()` | `this._runtimeCwd` |
| `exportToHtml` tool renderer cwd（:3699） | `this.sessionManager.getCwd()` | `this._runtimeCwd`（HTML 导出相对化逻辑路径需 logical） |
| `exportToJsonl` header cwd（:3730） | `this.sessionManager.getCwd()` | **保留 physicalCwd**（导出元数据存物理路径，文档化；renderer 不直接展示） |
| ExtensionRunner 构造（:3090） | `this._cwd` | **保留 `this._cwd`（hostCwd）** |
| extension resource discovery（:2773） | `this._cwd` | **保留 `this._cwd`（hostCwd）** |
| background tool definitions（:445） | `this._cwd` | **保留 `this._cwd`（hostCwd）**（v1 已 exclude，无关） |

**Windows 无回归不变式**（须在 execution-backend.test.ts 断言）：未注入 backend 时 `runtimeCwd === hostCwd`，且 `sessionManager.getCwd() === this._cwd`（SessionManager 由 `config.cwd` 构造，二者恒等），因此 executeBash/approval/export 改读 `_runtimeCwd` 对 Windows 字节级无变化。

`_runtimeEnvironmentContext`（:1189）**没有 cwd 字段**，只承载 platform/osName/shell/timezone/executionMode/verificationGate；`runtimeEnvironmentOverride` 合并到这里。系统提示里的 logical cwd 来自 `_rebuildSystemPrompt:1238` 的 cwd（即 `this._runtimeCwd`），**不要**试图经 `runtimeEnvironmentOverride.cwd` 注入（RuntimeEnvironmentContext 无此字段）。`main.ts` **不在本计划修改范围**：PiX 直接调用 `createAgentSession`（session-bridge.ts:1302、team-manager.ts:794）显式传 `runtimeCwd`；CLI/TUI 走 `createAgentSessionFromServices`，由 SDK 函数令 `runtimeCwd ??= hostCwd` 默认。

### 4.2 Operations 与工具选项契约

下列接口为**现有形状 + 新字段**；现有字段不得改动，以确保 Windows fallback 字节级不变。

~~~typescript
// bash.ts:41（接口不改；S5 实现它）
export interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}

// read.ts:43
export interface ReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

// write.ts:32
export interface WriteOperations {
  readFile?: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}

// edit.ts:74
export interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}

// grep.ts:51（新增 spawnRipgrep）
export interface GrepOperations {
  isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
  readFile: (absolutePath: string) => Promise<string> | string;
  /** 新增：返回 live child，保留既有 readline/JSON/limit 提前 kill；不能换缓冲 Promise。 */
  spawnRipgrep?: (
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => ChildProcessWithoutNullStreams;
}

// find.ts:41
export interface FindOperations {
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

// ls.ts:32（新增 readdirWithTypes）
export interface LsOperations {
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
  readdir: (absolutePath: string) => Promise<string[]> | string[];
  /** 新增：存在时跳过逐条 stat 循环；d_type 不可用回退 lstat。 */
  readdirWithTypes?: (absolutePath: string) => Promise<Array<{ name: string; isDirectory: boolean }>>;
}
~~~

各 per-tool options（均新增 `pathContext?: ToolPathContext`；merge helper 把 `executionBackend.<tool>` 映射进既有 `operations?` 字段）：

~~~typescript
// read.ts:58
export interface ReadToolOptions { autoResizeImages?: boolean; operations?: ReadOperations; pathContext?: ToolPathContext; }
// bash.ts:144
export interface BashToolOptions { operations?: BashOperations; commandPrefix?: string; shellPath?: string; spawnHook?: BashSpawnHook; pathContext?: ToolPathContext; }
// write.ts:47 / edit.ts:89 / grep.ts:63 / find.ts:54 / ls.ts:47
export interface WriteToolOptions { operations?: WriteOperations; pathContext?: ToolPathContext; }
export interface EditToolOptions  { operations?: EditOperations;  pathContext?: ToolPathContext; }
export interface GrepToolOptions  { operations?: GrepOperations;  pathContext?: ToolPathContext; }
export interface FindToolOptions  { operations?: FindOperations;  pathContext?: ToolPathContext; }
export interface LsToolOptions    { operations?: LsOperations;    pathContext?: ToolPathContext; }
~~~

`RuntimeEnvironmentContext`（system-prompt.ts:29，全字段可选，**无 cwd**）：

~~~typescript
export interface RuntimeEnvironmentContext {
  platform?: NodeJS.Platform | string;
  osName?: string;
  timezone?: string;
  executionMode?: "approval" | "unattended" | "read-only";
  verificationGate?: boolean;
  shell?: { path?: string; args?: string[]; kind?: "posix" | "powershell" | "cmd" | "unknown" | "wsl"; error?: string };
}
~~~

`spawnRipgrep` 必须返回 live `ChildProcessWithoutNullStreams`，以保留既有 readline、JSON 解析、limit 达到后的提前 kill；不能换成缓冲 Promise。参数 cwd 和 isDirectory/readFile 的 absolutePath 都位于当前 runtime namespace：WSL 时是 POSIX 逻辑路径，转换物理路径是 WSL operations 的职责。grep 的 `formatPath`、find 的 relative、ls 的 join 必须根据 `ToolPathContext.pathStyle` 选择 `path.posix`/`path.win32`，禁止继续隐式使用 Windows 默认 path。

`readdirWithTypes` 只影响提供该能力的 backend；Windows fallback 的逐条 stat 保持不变。`shell.kind` 增加 `'wsl'`。WSL override 至少包含 `platform='linux'`、`osName` 为 WSL2 加 distro、`shell` 为完整对象 `{ kind:'wsl', path:'wsl.exe' }`（浅合并整体替换，避免残留 Git Bash path）；`shell.kind` 只控制提示词，不得传给 `getShellConfig`。override **不含 cwd**（见 §4.1）。

`AuthStorage`（TeamManager.initialize 第二参）是 SDK 类型（`@earendil-works/pi-coding-agent` 导出），本计划**透传不改**。

### 4.3 Project location 与持久化类型

~~~typescript
export type ProjectEnvironment =
  | { kind: "windows" }
  | { kind: "wsl"; distro: string };

export interface ProjectLocation {
  /** Runtime/model-visible path; equals physicalPath for Windows. */
  path: string;
  /** Host/bootstrap path; never displayed to the model. */
  physicalPath: string;
  name: string;
  environment: ProjectEnvironment;
}

export interface ProjectInfo extends ProjectLocation {
  lastOpened: number;
  sessionCount: number;
}

export interface ProjectLocationInput {
  environment: ProjectEnvironment;
  logicalPath?: string;
  physicalPath?: string;
  name?: string;
}

export interface WslSettings { enabled: boolean; distro: string; defaultCwd: string; }
export interface WslDistroInfo { name: string; state: string; version: number; isDefault: boolean; }
export interface WslDistroListResult { distros: WslDistroInfo[]; diagnostic?: string; }
export type ResolveProjectLocationResult =
  | { success: true; location: ProjectLocation }
  | { success: false; error: string };
export type ExecutionEnvironmentInfo =
  | { kind: "windows"; logicalCwd: string }
  | { kind: "wsl"; distro: string; logicalCwd: string; ready: boolean; diagnostic?: string };

// 更新后的 GuiSettings（settings-store.ts Store<GuiSettings>，新增 schemaVersion 与 wsl）
export interface GuiSettings {
  piPath?: string;
  theme: string;
  recentProjects: ProjectInfo[];
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  takeHerEyes?: boolean;
  schemaVersion?: number;   // 新增，迁移后 = 2
  wsl?: WslSettings;        // 新增
}

// SessionInfo（types.ts:287，不改字段；WSL 模式 listSessions 返回时 cwd 回译 logical，path 为物理 JSONL 路径不展示给模型）
export interface SessionInfo {
  path: string; id: string; cwd: string; name?: string;
  created: number; modified: number; messageCount: number; firstMessage: string;
}
~~~

`ProjectLocation.path` 固定表示 logical path：Windows 时 `path===physicalPath`，WSL 时 `path===logicalPath`。Windows input 必须有绝对 physicalPath；WSL input 必须有显式 distro 和绝对 POSIX logicalPath。WSL physicalPath 缺失时由 converter 推导；两者同时存在时必须 round-trip 相等；跨 distro UNC、相对逻辑路径、WSL 文件工具中的 C:\ 或 UNC 输入直接拒绝。name 分别用 `path.win32.basename(physicalPath)` 或 `path.posix.basename(logicalPath)` 计算。distro 名以 `wsl.exe -l -v` 输出原样为准（大小写敏感），保证 UNC 与 snapshot hash 跨重启一致。

主进程导出：

~~~typescript
export interface ProjectExecutionContext {
  readonly location: ProjectLocation;
  readonly logicalCwd: string;
  readonly physicalCwd: string;
  readonly executionBackend?: ExecutionBackend;
  readonly runtimeEnvironmentOverride?: Partial<RuntimeEnvironmentContext>;
  /** 显式标记，供 MCP adapter 决定 allowStdio；不从 backend 存在性推断。 */
  readonly isWsl: boolean;
}

export async function resolveProjectLocation(input: ProjectLocationInput, resolver?: WslDistroResolver): Promise<ProjectLocation>;
export async function createProjectExecutionContext(location: ProjectLocation): Promise<ProjectExecutionContext>;
export async function disposeProjectExecutionContext(context: ProjectExecutionContext | null): Promise<void>;
~~~

Windows context 的 backend/override 为 undefined 且 `isWsl=false`；WSL context 在创建 backend 前完成 distro、WSL2 version、`test -d logicalCwd` 和 physical directory 校验。`createProjectExecutionContext` 静态 import `createWslExecutionBackend`（故 S6 硬依赖 S5，见 §8）。


### 4.4 WslDistroResolver

~~~typescript
export interface WslAutomountConfig { enabled: boolean; root: string; }
export interface WslDistroResolverOptions { executable?: string; listTimeoutMs?: number; probeTimeoutMs?: number; }
export function parseWslListOutput(output: Buffer | string): WslDistroInfo[];
export class WslDistroResolver {
  constructor(options?: WslDistroResolverOptions);
  list(): Promise<WslDistroInfo[]>;
  requireDistro(name: string): Promise<WslDistroInfo>;
  assertDirectory(distro: string, logicalCwd: string): Promise<void>;
  getHome(distro: string): Promise<string>;
  getAutomountConfig(distro: string): Promise<WslAutomountConfig>;
}
~~~

解析器去 BOM/NUL，按连续两个以上空格分列，不能依赖固定列宽。ENOENT、非 WSL 主机和超时由上层转成诊断。`requireDistro` 只接受调用方传入的名称，不读取默认标记来替换名称；v1 只接受 version 2。

### 4.5 WslPathConverter

~~~typescript
export interface WslPathContext { distro: string; home: string; automountRoot: string; automountEnabled: boolean; }
export class WslPathConverter {
  constructor(context: WslPathContext);
  linuxToWindows(linuxPath: string): string;
  windowsToLinux(windowsPath: string): string;
  assertLogicalPath(path: string): void;
  assertSameDistro(path: string): void;
  displayPath(path: string): string;
}
~~~

转换规则固定：

- 按实际 automount root（默认 /mnt）匹配 `/<automountRoot>/<one ASCII letter>/`，映射为对应 Windows 盘符；`/mnt/c` 根映射为 `C:\`。
- 其它绝对 POSIX 路径映射为 UNC `\\wsl.localhost\<distro>\...`；反向转换同时识别 legacy `\\wsl$\<distro>\...`。
- `/mnt/wsl`、`/mnt/wslg` 等多字母挂载不走 drive 特判，落到 UNC。
- Windows drive path 反向映射为 `/mnt/<lowercase-drive>/`；同 distro UNC 去除 distro 前缀；其它 distro UNC 抛 cross-distro error。
- `wslpath` 只作非默认 automount root、歧义输入或纯字符串转换后 stat 失败的回退，不能进入普通热路径。
- automount disabled 时 /mnt 访问报可操作错误，不能伪造 UNC。

必须通过以下 round-trip（distro 名以 `wsl.exe -l -v` 输出为准，此处用 `Ubuntu-22.04`，与 §6.1 一致）：

~~~text
linuxToWindows("/home/u/repo")              == "\\wsl.localhost\Ubuntu-22.04\home\u\repo"
linuxToWindows("/mnt/c/Users/u/repo")       == "C:\Users\u\repo"
linuxToWindows("/mnt/wsl/foo")              == "\\wsl.localhost\Ubuntu-22.04\mnt\wsl\foo"   # 多字母落 UNC
windowsToLinux("C:\\Users\\u\\repo")         == "/mnt/c/Users/u/repo"
windowsToLinux("\\wsl.localhost\\Ubuntu-22.04\\home\\u\\repo") == "/home/u/repo"
windowsToLinux("\\wsl$\\Ubuntu-22.04\\home\\u\\repo")          == "/home/u/repo"            # legacy
assertSameDistro("\\wsl.localhost\\Debian\\home\\u")           # cross-distro -> throw
displayPath("\\wsl.localhost\\Ubuntu-22.04\\home\\u\\repo")    == "/home/u/repo"
~~~

### 4.6 WslRuntime 和 bash

~~~typescript
export interface WslRuntimeOptions {
  distro: string; executable?: string;
  readyTimeoutMs: number; killTimeoutMs: number; keepAliveIntervalMs: number;
}
export interface WslCommandResult { exitCode: number | null; stdout: Buffer; stderr: Buffer; }
export interface WslRuntime {
  /** argv is the command vector after wsl.exe -d <distro> [--cd ...] -e. */
  spawn(argv: readonly string[], options?: { logicalCwd?: string; env?: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams;
  run(argv: readonly string[], options?: { logicalCwd?: string; timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<WslCommandResult>;
  spawnBash(command: string, logicalCwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv; }): Promise<{ exitCode: number | null }>;
  /** bash 与 grep 共用的 pgid 控制文件清理入口。 */
  killProcessGroup(controlFile: string): Promise<void>;
  warmUp(): Promise<void>;
  dispose(): Promise<void>;
}
export function createWslRuntime(options: WslRuntimeOptions): WslRuntime;
export function createWslBashOperations(options: { runtime: WslRuntime; logicalCwd: string; }): BashOperations;
~~~

普通命令的语义必须等价于 `wsl.exe -d distro --cd logicalCwd -e bash -c command`。command 始终作为独立 argv 传递，不与 cwd、distro 或固定 shell 片段做字符串拼接；stdio 固定 ignore/pipe/pipe，windowsHide=true；不调用 getShellConfig/getShellEnv。inner bash 使用 distro 的非 login 默认环境（`bash -c`，非 `-lc`）；options.env 只允许显式 POSIX 安全键值作 env argv overlay，拒绝 PATH、HOME、USERPROFILE 及含盘符/UNC 的值。`createWslBashOperations` 把 `BashOperations.exec(command,cwd,opts)` 适配为 `runtime.spawnBash(command, cwd, { onData, signal, timeout, env })`。

**进程组与 abort/timeout（并发敏感，固定思路）**：

- **wrapper 结构**：每条命令用一个固定 wrapper 脚本（经 `wsl.exe -d distro --cd logicalCwd -e bash -c '<wrapper>' bash "$command"`，command 作为 `$1` 传入，**不**拼进 wrapper 字符串）。wrapper：`setsid bash -c '"$@"' bash "$command" & echo $! > "$CTRL"; wait $!; exit $?`（具体 setsid 标志/后台化写法由 executor 决定，但须满足：pgid 可靠获得 = 新会话 leader pid、exit code 正确传播、控制信息只写控制文件不写 stdout/stderr）。
- **控制文件**：路径 `/tmp/pix-wsl/<host-pid>-<id>.pgid`，内容由 wrapper 写入 pgid。目录在 `warmUp` 时 `mkdir -p` 并 `setsid` 可用性探测（缓存）；`setsid` 缺失时降级为不开新会话 + best-effort `kill <child-pid>`，并记日志（不拒绝整个 backend 启动）。
- **abort/timeout 顺序（固定）**：(1) 先 `taskkill /F /T /PID` 杀 Windows 侧 wsl.exe，使主 promise 立即 settle；(2) 再异步 `killProcessGroup(controlFile)`：独立 `wsl.exe -d distro -e bash -c 'kill -KILL -<pgid> 2>/dev/null; rm -f <controlFile>'`，5s timeout，失败仅记日志。控制文件删除放进同一清理命令（kill 成功则一并删），避免清理 spawn 超时后文件残留。
- **abort 竞态**：abort 可能在 wrapper 写入 pgid 之前触发；`killProcessGroup` 须重试读取控制文件（如 10×100ms），仍为空则放弃（孤儿进程由 keep-alive/VM 生命周期兜底，§11 风险 3）。为防 PID 回收误杀，控制文件内同时记录启动时间戳，清理前校验 pgid 仍属本会话窗口（best-effort）。
- **grep 复用**：`spawnRipgrep` 同样经 setsid 起 pgid 并登记控制文件，在 child `close` 事件触发 `killProcessGroup`，使 `matchCount>=limit` 提前 kill 能清理 WSL 内 rg（见 §4.7）。
- **启动清理**：`warmUp` 顺带扫除 `/tmp/pix-wsl/*.pgid` 残留。

warmUp 执行一次显式 distro 的 `true` 后启动 interval keep-alive；dispose 清 timer、终止仍跟踪的 host child，并等待有限时长的 best-effort Linux 清理。并发命令只共享 runtime 的 distro/keep-alive，不共享控制文件或 abort state。

### 4.7 WslFileOperations 与 ToolPathContext 合成

~~~typescript
export interface WslFileOperationsOptions {
  converter: WslPathConverter; runtime: WslRuntime; logicalCwd: string; physicalCwd: string;
}
export interface WslOperationSet {
  read: ReadOperations; write: WriteOperations; edit: EditOperations;
  grep: GrepOperations; find: FindOperations; ls: LsOperations;
}
export function createWslFileOperations(options: WslFileOperationsOptions): WslOperationSet;

export interface CreateWslExecutionBackendOptions {
  distro: string; logicalCwd: string; physicalCwd: string;
  home: string; automount: WslAutomountConfig;
  runtimeOptions?: Partial<Omit<WslRuntimeOptions, "distro">>;
}
export async function createWslExecutionBackend(options: CreateWslExecutionBackendOptions): Promise<ExecutionBackend>;

// 错误回译（签名与策略固定）
export function toLogicalError(e: unknown, converter: WslPathConverter): Error;
~~~

**ToolPathContext 合成（S5 必须按此构造 `backend.paths`）**：

~~~text
resolvePath   = (input, cwd) => path.posix.resolve(cwd, expandTilde(input, home))   // 仅 POSIX + home 展开，返回 /home/... 或 /mnt/c/...
displayPath   = (p) => converter.displayPath(p)                                       // 物理/逻辑 -> 逻辑
toFileUrl     = (abs) => pathToFileURL(converter.linuxToWindows(abs)).href            // 逻辑 -> Windows 可打开 file URL
getMutationKey = async (abs) => linuxRealpath(converter.linuxToWindows(abs))         // 先转 physical，再用 Linux realpath（wsl.exe -e realpath）去重
homeDir       = WslPathContext.home
pathStyle     = "posix"
~~~

`getMutationKey` 用 `wsl.exe -e realpath <logicalPath>`（Linux realpath）而非 Windows `realpathSync` over UNC，避免 ext4 符号链接（指向 /proc、/dev 等）在 9P 下解析失败导致 symlink 去重失效（§10.8）。

- read/write/edit/ls 收到的 absolutePath 一律是 POSIX 逻辑绝对路径；每个 operation 在最外层 guard 后用 converter 得到 physical path，再调用 Node fs。Node fs 保持 Buffer/UTF-8 和行尾原有语义，physical path 不得返回 SDK。
- write mkdir 收到逻辑目录，用一次 `wsl.exe -d distro -e mkdir -p -- logicalDir`，避免 UNC recursive mkdir 的多次 9P 往返。
- find glob 在 WSL 中运行 fd 或 Debian/Ubuntu 的 fdfind，请求 absolute-path 和 glob，返回绝对 Linux 路径；缺失时报 apt 安装提示，不使用 Windows fd 静默替代。
- grep spawnRipgrep 在 WSL 中运行 rg（经 setsid + 控制文件，§4.6）；**WSL rg 探活由 hook 负责**，不能先执行 Windows ensureTool；**缺失 rg 时 hook 必须抛出含 distro 名与 `apt install ripgrep` 提示的 Error**（grep.ts 外层 catch 不得吞成裸 "rg not found"）。context 大于零时 `WslGrepOperations.readFile` 用 `wsl.exe -e cat <logicalPath>`（原生读，避免 9P 内容读取），保持 `getFileLines` 流不变。
- ls 首选 readdir withFileTypes，d_type 不可用才逐条 lstat；broken symlink 可列出，不能让整个目录失败。
- `toLogicalError(e, converter)`：若 `e.path` 存在则用 `converter.windowsToLinux` 改写；再用正则替换 `error.message` 与 `error.cause.message`（递归）中的 `\\wsl.localhost\<distro>\...`、`\\wsl$\<distro>\...` 与 `[A-Z]:\...` 片段为 logical；返回新 Error（保留 cause）。覆盖 read/write/edit/ls 所有自构错误与 Node fs 原样错误（read.ts:332-334）。

createWslExecutionBackend 创建并拥有唯一 WslRuntime，组合 paths、六类文件 operations、bash 和 runtimeEnvironment；完成 warmUp 后才 resolve，dispose 幂等且只由 context owner 调用。文件工具对输入中的 Windows drive/UNC 做硬拒绝并提示使用 /home 或 /mnt/c；bash 只能 best-effort 检测命令文本，不解析变量拼接。


### 4.8 SessionBridge、TeamManager 与 IPC

~~~typescript
class SessionBridge {
  start(location: ProjectLocation, guiSettings?: GuiSettings): Promise<void>;
  stop(): Promise<void>;
  listSessions(location: ProjectLocation): Promise<SessionInfo[]>;
  getLocation(): ProjectLocation | null;
  /** Borrowed reference; callers must not dispose it. */
  getExecutionContext(): ProjectExecutionContext | null;
  getExecutionEnvironment(): ExecutionEnvironmentInfo | null;
}
class TeamManager {
  initialize(context: ProjectExecutionContext, authStorage: AuthStorage): Promise<void>;
}
~~~

SessionBridge 内部字段必须分名保存 `_logicalCwd`、`_physicalCwd`、`_executionContext`。start 先创建并 warm-up candidate context，成功后才停止旧 runtime 并接管新 context；candidate 创建失败时旧 runtime 不变。完成接管后若 AgentSession 初始化失败，必须释放 candidate 并进入 stopped/error，不伪装恢复旧 runtime。SessionBridge 是 context/backend 的唯一 owner，getExecutionContext 只返回 borrowed reference。

SessionManager header 可以保存 physical cwd，但 listSessions 返回给 renderer 的 `SessionInfo.cwd`（types.ts:287）在 WSL 模式必须回译为 logical cwd；`SessionInfo.path`（session JSONL 物理路径）不展示给模型。newSession、switchSession、fork 只能更换 session manager，不能重建或替换 backend；distro 变更要求先停止并重新 start。

TeamManager 保存 `_physicalCwd` 作为 snapshot/hash key、`_logicalCwd` 作为 worker runtime cwd、`_executionBackend` 与 `_isWsl`（显式）作为 shared object/标记。team IPC 在 leader SessionBridge.start 成功后取得 borrowed context，再调用 initialize；initialize 失败时由 IPC stop leader，不能由 TeamManager dispose backend。worker createAgentSession 的 cwd 传 physical、runtimeCwd 传 logical，且传同一 backend；worker dispose 不调用 backend.dispose。MCP adapter 在 team-manager.ts:769 按 `_isWsl` 决定 `allowStdio`（不从 backend 存在性推断，以便未来非 WSL backend）。

snapshot/workspace 哈希与持久化函数位置固定：`teamSnapshotPath`（team-persistence.ts:13）、`workspaceModePath`（:21）、`readWorkspaceMode`（:26）、`writeWorkspaceMode`（:37）由 ipc-handlers.ts:298/303 调用；`_getSessionDir`（session-bridge.ts:1270）hash team-leader session namespace。**三处 hash 输入必须是 physicalCwd**，不得混入 logical。

Preload PixApi 新增或修改：

~~~typescript
listWslDistros: () => Promise<WslDistroListResult>;
resolveProjectLocation: (input: ProjectLocationInput) => Promise<ResolveProjectLocationResult>;
startPi: (location: ProjectLocation) => Promise<{ success: boolean; error?: string }>;
startTeamRuntime: (location: ProjectLocation) => Promise<{ success: boolean; error?: string }>;
hasTeamSnapshot: (location: ProjectLocation) => Promise<boolean>;
getWorkspaceMode: (location: ProjectLocation) => Promise<"team" | "solo" | null>;
setWorkspaceMode: (location: ProjectLocation, mode: "team" | "solo") => Promise<void>;
getExecutionEnvironment: () => Promise<ExecutionEnvironmentInfo | null>;
listSessions: (location: ProjectLocation) => Promise<SessionInfo[]>;
listTeamLeaderSessions: (location: ProjectLocation) => Promise<SessionInfo[]>;
~~~

`processChatFiles` 更新签名（chat-files.ts:22-26）：

~~~typescript
export function processChatFiles(
  filePaths: string[],
  cwd: string,                       // physicalCwd，用于 IO
  options: { /* 既有选项 */ displayPath?: (physical: string) => string },
): Promise<...>;
~~~

IPC 对 renderer 输入做运行时校验。teamSnapshotPath、workspaceModePath、SessionManager.list 只接收 `location.physicalPath`。未知 setting key、空 distro、相对 logical path 和不存在目录都返回结构化错误，不得让 renderer 看到未捕获的 Node exception。

### 4.9 Renderer 组件/状态契约

ProjectOpenDialog.vue 的 public contract：

~~~typescript
interface Props {
  modelValue: boolean;
  defaultEnvironment: ProjectEnvironment;
  defaultCwd: string;
  distros: WslDistroInfo[];
  wslDiagnostic?: string;
}
interface Emits {
  (event: "update:modelValue", value: boolean): void;
  (event: "open", value: ProjectLocationInput): void;
}
~~~

WSL 模式必须同时显示 distro 和绝对 Linux cwd；Windows 模式禁用它们。原生目录对话框只提供 physical path 辅助值（由主进程转换），主输入仍是 WSL logical path。project-store.openProject(location)、team-store.toggleTeamMode(location) 和 useRpc.startRuntime(location) 只传完整对象，不从字符串重新猜环境。

### 4.10 MCP 契约

~~~typescript
export interface McpAdapterOptions {
  // existing fields: servers?, configPaths?, autoDiscover?, registerResourceTools?, startupTimeoutMs?, requestTimeoutMs?
  allowStdio?: boolean; // default true
}
~~~

WSL backend 创建的 session 使用 `allowStdio=false`。接入点：`McpAdapter` 当前在 `session-bridge.ts:1289` 与 `team-manager.ts:769` 两处均以 `new McpAdapter()`（无 options）构造；WSL 模式**两处都必须**传 `{ allowStdio: false }`（由 `context.isWsl` 决定）。过滤实现加在 `McpAdapterOptions.allowStdio` + `createTransport()`（:659）的 stdio 分支（:661）。被过滤的 stdio server 在 McpConfigInfo.errors 和 McpServerStatus.error 中包含明确提示：`MCP stdio server is disabled in WSL mode; use HTTP/SSE or run the server inside WSL`。required server 按现有 required 语义决定启动失败；非 required 只显示诊断。HTTP/SSE（:687/694/700）不过滤、不改写返回 JSON。**v2** 可评估更宽松替代：经 `wsl.exe` 在 WSL 内 spawn stdio MCP server，使其自报 Linux 环境与路径（reference §8.4 推荐项），届时 `allowStdio` 可放开。

## 5. 核心流程设计

### 5.1 正常启动流程

1. SettingsStore 加载 GuiSettings.wsl 和最近项目；若 WSL 未启用，项目选择默认 Windows。
2. 打开 WSL 对话框时先调用 list-wsl-distros。列表为空、WSL 命令不可执行或没有 version 2 时禁用提交并显示诊断。
3. 用户选择显式 distro 并填写 POSIX cwd；主进程 resolver 校验 test -d，转换 physical cwd，检查 physical directory。
4. IPC 在停止旧单人/团队 runtime 后创建 context。若 context 创建失败，恢复旧 runtime 状态，不写入最近项目。
5. SessionBridge 以 physical cwd 初始化 settings/resources/session；以 logical cwd + backend 初始化 AgentSession；MCP adapter 使用 WSL policy。
6. backend warm-up 成功后发送 ready，RpcSessionState 携带 kind=wsl、distro 和 logicalCwd；renderer 更新 TopBar/项目列表。
7. 成功启动后再迁移/写入最近项目记录，最多保留现有 20 条限制。

### 5.2 bash 正常流程

1. bash tool 将 command 与固定 logical cwd 传给 WslBashOperations.exec -> runtime.spawnBash。
2. runtime 启动 wsl.exe，在 ready timeout 内建立 stdout/stderr pipe；每次命令都带 -d 和 --cd；wrapper 起 setsid 会话、写控制文件、wait 传播 exit code。
3. stdout/stderr 通过既有 onData 流到工具；不加载 ~/.profile，使用 bash -c。
4. 命令结束返回原有 exit code；cd 只影响该命令，下一命令回到 project logical cwd。

### 5.3 文件工具正常流程

1. 工具 resolver 用 POSIX 语义处理 ~、相对路径和绝对路径。
2. 文件操作将逻辑路径转为 drive/UNC physical path；搜索操作将逻辑路径传入 WSL fd/rg（rg 经 setsid+控制文件）。
3. read/write/edit 的 diff、行尾、BOM 和图片 MIME 逻辑沿用原实现；ls 使用 typed entries；find/grep 结果统一回到 Linux absolute/relative path。
4. 错误经 toLogicalError 回译后把结果送到模型，渲染器如需打开路径再使用 display formatter 生成 Windows file URL。

### 5.4 Team 正常流程

1. start-team-runtime 先启动 leader context，再把同一 context/backend 传给 TeamManager.initialize。
2. 每个 worker bootstrap 使用 physical cwd 读取 settings/resources/MCP；Agent runtime 使用同一 logical cwd/backend/runtime override。
3. worker restart、resume snapshot 和新建 worker 都复用 backend；不允许从 persisted snapshot 的字符串 cwd 推断新 distro。
4. Team stop 先停止 worker/leader，再由 context owner 释放 runtime/keep-alive；snapshot 仍以 physical cwd hash 写入。

### 5.5 reload、session switch 与设置变更

- AgentSession.reload() 重新生成 tool definitions 时继续使用同一 backend、path context 和 runtime override。
- new/resume/fork/import 只重新创建 session manager/session，沿用 context；host resource loader 仍以 physical cwd 工作。
- 全局 WSL 设置只影响新项目默认值；已持久化项目的 environment 是权威配置。
- 活跃会话中改变 distro 或 logical cwd 不热切换；UI 标记重启项目会话后生效，并要求先 stop/start。

### 5.6 异常流程

- **WSL 不存在/ENOENT**：listWslDistros 返回空和诊断；未启用 WSL 的 Windows 模式仍可启动。
- **distro 未安装或 version != 2**：启动失败，错误包含用户选择的名称和安装/选择提示；不回退默认 distro。
- **logical cwd 不存在**：test -d 失败，启动失败，不创建半成品 session。
- **/mnt drive 映射失败**：若 automount disabled 或 stat 失败，返回提示检查 WSL automount；不生成错误 UNC。
- **rg/fd 缺失**：spawnRipgrep hook 抛含 distro 名与 apt 提示的 Error（ripgrep / fd-find）；不调用 Windows binary。
- **abort/timeout**：先 taskkill Windows wsl.exe（promise 立即 settle），再异步 kill Linux pgid（5s，失败仅日志）；命令结果按现有 aborted/timeout 语义处理。
- **MCP stdio**：被过滤并显示明确错误；HTTP/SSE 连接失败按现有 MCP reconnect/required 逻辑处理。
- **Team worker backend 不一致**：初始化阶段拒绝，记录环境摘要；不得静默启动 Windows worker。

### 5.7 边界情况

- /mnt/c/Users/x 在 bash 和 read 工具中必须指向同一 Windows 文件；验证值为 drive path，不是 UNC 下的 /mnt/c。
- /mnt/wsl、/mnt/wslg 和非默认 automount root 不匹配 single-letter drive 规则，按 UNC/回退规则处理。
- logical path 含空格、美元符号、中文和 Unicode；spawn 参数必须保持单 argv，不做 shell 拼接。
- ext4 符号链接经 Linux realpath 参与 mutation queue 去重；broken link 由 ls 显示但 read/stat 报逻辑路径错误。
- Linux 大小写敏感，renderer 比较/去重不得全局 lowercase；只有 Windows project key 可按 win32 规则规范化。
- WSL VM 冷启动超过普通命令 timeout 时，ready progress 必须先发给 UI；ready timeout 与命令 timeout 独立。
- 旧 settings/project 记录只有 { path } 时迁移为 Windows project；不会猜测其 distro 或把 C:\home 当 Linux path。
- MCP/扩展工具可能返回 Windows 路径（C:\ 或 UNC）--系统提示须告知模型这一边界（见 §7.3），不得与"纯 Linux"沉浸 framing 矛盾。

## 6. 数据存储与状态设计

### 6.1 GUI settings JSON

electron-store 的逻辑 schema（字段名固定；`schemaVersion` 与 `wsl` 为新增字段，`Store<GuiSettings>` 须包含）：

~~~json
{
  "schemaVersion": 2,
  "theme": "light",
  "wsl": { "enabled": false, "distro": "", "defaultCwd": "/home" },
  "recentProjects": [
    {
      "path": "/home/bishe/work/fan-web",
      "physicalPath": "\\\\wsl.localhost\\Ubuntu-22.04\\home\\bishe\\work\\fan-web",
      "name": "fan-web",
      "environment": { "kind": "wsl", "distro": "Ubuntu-22.04" },
      "lastOpened": 1760000000000,
      "sessionCount": 4
    }
  ]
}
~~~

迁移规则：1. 缺失 schemaVersion 按旧 schema 读取。2. 缺失 wsl 写入 disabled/defaultCwd=/home。3. 每个旧 recent project 若没有 physicalPath/environment，令 physicalPath=path、environment={kind:"windows"}、path=physicalPath。4. 迁移只在成功读取和校验后一次性写回；坏记录丢弃并记诊断。全局 WSL 默认值只决定新建项目对话框初值；recent project 的 environment/distro 是打开该项目时的权威值。

### 6.2 Team/session 持久化

- teamSnapshotPath、workspaceModePath 和 team snapshot 内 cwd 继续使用 physicalCwd 的 SHA-1（计算点：`team-persistence.ts:13` teamSnapshotPath、`:21` workspaceModePath、`session-bridge.ts:1270` `_getSessionDir`--**三处都必须接收 physicalCwd**，不得混入 logical）。
- session JSONL header 保存 physical cwd 供 SessionManager 恢复；renderer 的 `SessionInfo.cwd`（types.ts:287）通过当前 context 回译成 logical cwd。
- backend、runtime child PID、keep-alive timer、distro probe 结果绝不序列化；它们只在 start 时重建。
- 项目关闭时先停止 session/team，再释放 WslRuntime；snapshot 是否保留沿用现有 mode/stop 语义。

### 6.3 内存状态机

~~~text
unresolved -> resolving -> ready -> running -> stopping -> disposed
                         \-> error
~~~

ready 表示 distro、目录、路径映射和 warm-up 均成功；只有 running 才允许 prompt/tool IPC。一次 context 只能向前移动，distro/cwd 变更创建新 context。shared backend 的 owner 是 SessionBridge/TeamManager 顶层 context，worker 只有借用引用。

## 7. 与现有代码的兼容方案

### 7.1 SDK 与工具兼容

- executionBackend、runtimeCwd、runtimeEnvironmentOverride 全部可选；Windows/CLI/TUI 调用不传时自动走当前 host 路径和本地 operations（SDK 令 runtimeCwd ??= hostCwd）。
- operations 优先级严格为显式 per-tool operations > backend operations > 既有 defaults。merge helper 用 spread 保留全部既有 per-tool 字段（autoResizeImages/commandPrefix/shellPath/spawnHook）。现有 extension 可以覆盖一个工具，不会被 backend 无条件夺走。
- grep hook 保持 ChildProcess 流式形状；Windows 未注入时 ensureTool、JSON readline、context、limit 和 early kill 字节级不变。
- ls 新 optional hook 不改变本地 stat fallback；broken symlink 行为变化仅发生在提供 typed entries 的 WSL backend。
- getShellConfig 不认识 WSL；WSL bash 完全绕过它。executeBash 默认 fallback 保留 `createLocalBashOperations({ shellPath })`。
- BackgroundTaskRegistry（agent-session.ts:438 内部 new，未导出）不改构造和 process tree 逻辑；WSL session 通过 excludeTools 禁用三个 background tools。

### 7.2 bootstrap 与资源兼容

现有 settings/resource/session 代码大量调用 Windows path.resolve，因此所有 host/bootstrap cwd 必须是 physical path。技能、AGENTS/CLAUDE、.pi settings 和 extension 文件真实加载路径保持 physical；在 system prompt/工具诊断中通过 display formatter 显示 logical。不能简单把 paths.ts 全局切换成 POSIX，否则会破坏 host loader。

### 7.3 系统提示沉浸边界（含 MCP/扩展路径提示）

`renderEnvironmentContext`（system-prompt.ts:140）WSL 分支须给出沉浸 framing（"你的整个工作环境是 WSL2 Linux，请像在原生 Linux 机器上一样工作"）与正向指引（cwd 是 /home POSIX、apt、无 .exe、/dev/null、文件工具接受 Linux 路径、路径转换自动处理）。同时须包含**边界提示**：MCP 与扩展工具可能返回 Windows 路径（`C:\...` 或 `\\wsl.localhost\...`），遇到时用 `/mnt/c/...` 转换给 bash，或回传给同一工具；不得因此否定 Linux 沉浸。`editing_contract`（:427-428）改为 platform 条件渲染：WSL 下移除 "Windows bash /dev/null" 文本，但**保留 /mnt/<drive> 保留设备名警告**（/mnt/c 是 NTFS，写 `nul`/`con` 仍会失败或产生不可删文件），措辞改为"写入 /mnt/<drive>/ 时避免 Windows 保留文件名"。

### 7.4 UI/IPC 兼容

旧 renderer 的 path 字符串调用点必须在同一阶段成组迁移为 location；不能保留一个接口接收 Windows 字符串、另一个接口接收 Linux 字符串。preload 返回的 ProjectInfo 始终含 physicalPath，renderer 显示默认使用 path（logical）。旧项目迁移在主进程完成，renderer 不承担 schema 兼容。

### 7.5 Extension 与 MCP 边界

ExtensionRunner 的 ctx.cwd 和 ResourceLoader 的资源路径是 host/physical cwd，扩展可以继续访问 .pi、Node modules 和 Windows 文件。内建工具和模型 prompt 才是 WSL immersive surface。任意扩展返回的宿主路径、package-manager 产物路径和 MCP HTTP/SSE 结果不属于 v1 的完全沉浸保证；README、UI 与系统提示必须说明这一点（§7.3）。Windows 侧 stdio MCP 在 WSL 模式显式禁用（session-bridge.ts:1289 与 team-manager.ts:769 两处）。

### 7.6 依赖与代码风格

不修改 package.json/lockfile，不添加依赖。所有 import 使用文件顶部静态 import（含 `import type { ChildProcessWithoutNullStreams } from "node:child_process"`），禁止 await import()、import("...") 和 any。实现沿用当前 TypeScript strict 风格。Vuetify 组件实现前必须阅读根目录 vuetify_guide 相关页面；不要猜测组件 props。

## 8. Stage Map（workflow 调度蓝图）

> **类型刷新关卡（贯穿 S7/S9/S13）**：`pix/tsconfig.main.json`（moduleResolution Node16，无 paths）把 `@earendil-works/pi-coding-agent` 解析到 `packages/coding-agent/dist`。SDK 源码改动后必须刷新 dist 类型，否则 pix/main 的 `ExecutionBackend`/`runtimeCwd` 引用报 TS2305/TS2353。**类型刷新命令**：`npx tsgo -p packages/coding-agent/tsconfig.build.json`（emit，写 gitignored dist，非禁用的「完整 npm run build」；亦可 `npm --prefix packages/coding-agent run build`）。S2 完成后首次刷新；S7/S9/S13 的 pix tsc gate 须在刷新后运行；S13 终检先刷新再全量。

下表中的硬依赖必须等待对应 stage 的代码和 verify gate 完成；无依赖表示可与其它 stage 并行。Stage 内部如果拆子 agent，只能在本表文件边界内拆分。

| Stage | 一句话目标 | 涉及文件 | 依赖 | 验收点 |
|---|---|---|---|---|
| S1 SDK 双 cwd/backend 契约 | 在 SDK 打通 generic backend、runtimeCwd、hostCwd 和 operations 合并，不写 WSL 代码 | execution-backend.ts, agent-session.ts, sdk.ts, agent-session-services.ts, agent-session-runtime.ts, tools/index.ts, core/index.ts, src/index.ts | 无；可与 S3 并行 | `npx tsgo -p packages/coding-agent/tsconfig.build.json --noEmit`；未注入 backend 的现有调用路径保持默认（行为断言移到 S2）。 |
| S2 SDK 路径/工具接缝 + 测试 | 让七个工具、policy、diff、mutation queue、render、skills、prompt 支持 resolver/path context，保留 Windows fallback，并写 execution-backend.test.ts | tools/{read,write,edit,grep,find,ls,bash}.ts, path-utils.ts, edit-diff.ts, file-mutation-queue.ts, render-utils.ts, utils/paths.ts, file-change.ts, tool-execution-policy.ts, system-prompt.ts, utils/shell.ts, skills.ts, index.ts, **test/execution-backend.test.ts** | 硬依赖 S1 | `npx tsgo -p packages/coding-agent/tsconfig.build.json --noEmit`；`npx vitest run packages/coding-agent/test/execution-backend.test.ts`；断言：fake backend 让 runtime cwd 与 host cwd 分离、reload 后 backend 引用不变、merge helper 保留 `commandPrefix`/`shellPath`/`autoResizeImages`、Windows grep JSON/limit/context 与 ls fallback 不变、`sessionManager.getCwd()===_cwd` 不变式、WSL prompt 含 Linux guidance 且不含 Windows-only /dev/null 文本；edit-diff preview 在 WSL path context 下经 operations/physical 读取；paths.ts 仅新增 `posix?`（`homeDir` 已存在）；ls.ts:161 改 posix.join 在 S2 内；**随后运行类型刷新命令**。 |
| S3 WSL 解析和路径原语 | 实现显式 distro 解析、UTF-16LE parser、automount 和纯字符串 converter | wsl-distro.ts, wsl-paths.ts, **__tests__/wsl.test.ts(paths 子集)** | 无；可与 S1/S2 并行 | `npx tsx pix/src/main/__tests__/wsl.test.ts --filter paths`；通过 §4.5 全部示例（含 cross-distro 拒绝、/mnt/wsl 落 UNC、displayPath、legacy \\wsl$）；无 WSL 主机时 list 返回诊断而不抛未处理异常。 |
| S4 WSL runtime | 集中 spawn、ready timeout、warm-up/keep-alive、pgid 控制文件和先 taskkill 后 kill-pgid 的生命周期 | wsl-runtime.ts, **__tests__/wsl.test.ts(runtime 子集)** | 硬依赖 S3 | `npx tsx pix/src/main/__tests__/wsl.test.ts --filter runtime`；fake child 验证 argv 顺序为 -d/--cd/-e/bash/-c、stdin ignore、控制文件写入 pgid、abort 先 taskkill host child 再 killProcessGroup、控制文件自删除、warmUp 清扫残留；有 `PIX_WSL_TEST_DISTRO` 时执行 `wsl.exe -d distro -e true`。 |
| S5 WSL operations/backend | 将 runtime/path 组装为七类 operations 和 generic backend，覆盖 UNC IO、fd/rg、错误回译、ToolPathContext 合成 | wsl-bash-operations.ts, wsl-file-operations.ts, wsl-execution-backend.ts, **__tests__/wsl.test.ts(operations 子集)** | 硬依赖 S1、**S2**、S3、S4 | `npx tsx pix/src/main/__tests__/wsl.test.ts --filter operations`；fake filesystem 验证 read/write/edit/ls/find/grep contracts、`backend.paths` 按 §4.7 合成、`toLogicalError` 策略、grep 缺 rg 抛 apt 提示、grep early-kill 调 killProcessGroup；有 distro 时验证 /mnt/c existing read 成功、错误文本无 UNC/drive。 |
| S6 Project context 与持久化 | 定义 location -> 双 cwd/context，迁移 settings/project schema，并保证 physical key | project-location.ts, execution-context.ts, settings-store.ts, shared/types.ts, **__tests__/execution-context.test.ts** | 硬依赖 S3、**S5**（execution-context.ts 静态 import createWslExecutionBackend） | `npx tsx pix/src/main/__tests__/execution-context.test.ts`；覆盖旧 { path } 迁移为 Windows、WSL ext4/drive round-trip、显式 distro 缺失失败、schemaVersion=2 JSON 与 physicalPath、`isWsl` 标记、不得调用默认 distro；断言 teamSnapshotPath/workspaceModePath/_getSessionDir 三处 hash 输入均为 physicalCwd。 |
| S7 SessionBridge 单会话接入 | 以 context 启停会话，bootstrap physical、runtime logical，MCP policy 和附件显示正确 | session-bridge.ts, chat-files.ts, packages/mcp-adapter/src/index.ts | 硬依赖 S1、S5、S6；类型刷新后 | `npx tsc -p pix/tsconfig.main.json --noEmit`（刷新后）；mock SessionBridge 启动断言 Settings/Resource/Session manager 收 physical、createAgentSession 收 runtimeCwd/backend；mcpGetConfig 对 WSL stdio 返回明确错误，HTTP/SSE 仍可配置；断言 **session-bridge.ts:1289** McpAdapter 传 allowStdio=false；chat-files 附件 path 与 `<file name>` 标签均经 displayPath 为 logical、跳过 macOS NFD 探测、无 UNC 泄漏。（team-manager.ts:769 的 McpAdapter 断言在 S8。） |
| S8 Team backend 一致性 | leader/worker/restore 共用同一 backend，snapshot/hash 使用 physical cwd，worker MCP policy | team-manager.ts, **__tests__/team-manager.test.ts** | 硬依赖 S6、S7 | `npx tsx pix/src/main/__tests__/team-manager.test.ts`（plain tsx + assert，standalone）；断言 TeamManager.initialize 后 `_executionBackend`/`_physicalCwd`/`_isWsl` 正确存储、snapshot/workspace hash 输入为 physical；断言 **team-manager.ts:769** McpAdapter 传 allowStdio=false（由 `_isWsl`）；worker 创建路径传同一 backend + runtimeCwd=logical 的内部状态（real createAgentSession 调用为 distro-gated 集成，无 distro 时 skip）。 |
| S9 IPC/preload 契约迁移 | 将 location、distro 列表、execution environment 暴露为 typed IPC | ipc-handlers.ts, preload.ts, shared/types.ts, renderer/types/{ipc,rpc,session}.ts | 硬依赖 S6、S7、**S8**（teamManager.initialize 签名）；类型刷新后 | `npx tsc -p pix/tsconfig.main.json --noEmit`（刷新后；注：preload.ts 被 tsconfig exclude，其类型由 `build:renderer` 兜底）；静态检查所有 start/list/snapshot/mode 调用均传 ProjectLocation；非法 input 返回 success=false,error；physical path 只在主进程作为 hash/key 使用。 |
| S10 跨切面回归 | 错误回译不变式、/mnt/c round-trip、Windows backend=undefined 快照回归 | 扩展 execution-backend.test.ts / wsl.test.ts（追加用例） | 硬依赖 S2、S5、S6、S8 | `npx vitest run packages/coding-agent/test/execution-backend.test.ts`；`npx tsx pix/src/main/__tests__/wsl.test.ts`；断言 WSL 模式工具结果与错误消息无 UNC/盘符；/mnt/c 在 bash 与 read 工具行为一致；Windows 无 backend 路径快照通过。无 distro 时真实集成 skip。 |
| S11 Renderer 项目/设置 UI | 让用户选择 global WSL 默认值和 project-level logical cwd/distro | ProjectOpenDialog.vue, HomePage.vue, SettingsPage.vue, settings-store.ts, project-store.ts, ProjectList.vue | 硬依赖 S9；可与 S12 并行 | `npm --prefix pix run build:renderer`；WSL 未启用时 distro/cwd disabled，启用后只允许列表 distro 和绝对 POSIX cwd；旧项目可打开；错误显示不含 UNC；组件 API 与 vuetify_guide 一致。 |
| S12 Renderer workspace/team 迁移 | 贯通 team toggle、session list 和环境状态显示 | team-store.ts, useRpc.ts, useTeamLeaderRpc.ts, WorkspacePage.vue, LeftPanel.vue, CenterPanel.vue, RightPanel.vue, TopBar.vue | 硬依赖 S8、S9、S11 | `npm --prefix pix run build:renderer`；不存在 startRuntime(string)/toggleTeamMode(string) 旧调用；TopBar/RightPanel 只显示 logical cwd+distro；team/solo 切换不重复重启同一 project backend。 |
| S13 文档和最终集成 | 写清前置条件/边界，完成 fs.watch 审计，并完成全局类型与构建关卡 | README.md 以及本表所有文件 | 硬依赖 S7-S12 | 类型刷新命令；`npx tsgo -p packages/coding-agent/tsconfig.build.json --noEmit`；`npx tsc -p pix/tsconfig.main.json --noEmit`；`npm --prefix pix run build:renderer`；`grep -r "fs.watch\|chokidar" pix/src/main` 审计（受 9P 影响站点须追加 §3 后再修）；再运行 S10 三条测试命令（`vitest run execution-backend.test.ts`、`tsx wsl.test.ts`、`tsx team-manager.test.ts`），无 distro 时 skip 的真实集成用例不计为失败。除用户另行要求，不执行完整 `npm run build`/`npm test`。 |

并行关系：S1、S3 的纯契约/原语可并行；S2 依赖 S1；S4 依赖 S3；S5 等待 S1/**S2**/S3/S4；S6 等待 S3/**S5**（不再与 S5 并行）；S7 等待 S5/S6；S8 等待 S7；S9 等待 S8（不再与 S8 并行）；S10 等待 S2/S5/S6/S8；S11 等待 S9，S12 等待 S8/S9/S11；S13 汇合。

## 9. 给执行 Agent 的约束

### 9.1 架构决策：必须严格遵守

- 只能在第 3 节列出的文件中实现；禁止顺手重构相邻模块、改公共命令协议或改 package 依赖。**`packages/coding-agent/src/main.ts` 不在修改范围**；`pix/tsconfig.main.json` 不改（类型解析靠 dist 刷新）。
- 必须使用 ExecutionBackend 单一注入点；七个 built-in tools、executeBash、reload、session replacement 和 Team worker 都从同一实例取得 operations。
- 必须实现 host/physical cwd 与 runtime/logical cwd 双表示，并遵守第 2.4 的消费者边界与 §4.1 的 `_cwd`/`_runtimeCwd` 重定向表（extensions/export-jsonl 留 hostCwd/physical，tools/prompt/bash/policy/export-html 用 runtimeCwd）。
- executeBash 默认 fallback 必须保留 `createLocalBashOperations({ shellPath })`。
- WSL distro 必须显式指定并校验；绝不能使用默认 distro、WSL_DISTRO_NAME 推断或静默 fallback 到另一个 distro。
- /mnt/<单字母盘符> 必须映射 Windows drive；原生 ext4 才映射 UNC；不能把 /mnt/c 机械拼成 UNC。
- WSL 命令必须走 `wsl.exe -d <distro> --cd <logicalCwd> -e bash -c <command>`，每命令独立 cwd；不实现 stderr sentinel、跨命令 cwd 或 bash -lc。command 作为独立 argv 传入 wrapper（`$1`），不拼进 wrapper 字符串。
- abort/timeout 必须先 taskkill Windows wsl.exe，再 best-effort kill Linux pgid（经控制文件，5s，失败仅日志）；不得复用 killProcessTree。grep 的 spawnRipgrep 须经 setsid+控制文件并在 close 时清理 pgid。
- WSL 模式必须禁用 Windows 侧 stdio MCP（session-bridge.ts:1289 与 team-manager.ts:769 两处，由 `context.isWsl` 决定），保留 HTTP/SSE；不做通用 MCP JSON 路径改写。
- v1 必须通过 excludeTools 禁用 background tools，不得修改 BackgroundTaskRegistry 来"顺便支持"后台任务。
- 工具错误和内建诊断不得泄露 UNC/drive（经 `toLogicalError`）；任意 bash stdout/stderr 作为用户命令原始数据可保留，但生成的提示必须使用 logical path。chat-files 附件 `path` 与 `<file name>` 标签、skills `<location>`、edit-diff preview、SessionInfo.cwd 均不得泄露 physical 路径。
- spawnRipgrep 缺失 rg 时必须抛含 distro 名与 apt 提示的 Error。
- Team worker 必须复用 leader backend object identity；只有 context owner 释放 backend。
- UI 必须使用已有 Vuetify 组件和仓库 vuetify_guide，WSL 控件在未启用/未探测成功时禁用；不能在 renderer 中实现路径转换。
- 不新增依赖、不使用 dynamic import、不使用 any，遵循当前代码风格和静态顶层 import。

### 9.2 实现决策：允许执行 Agent 自主决定

- 私有变量名、错误 helper 的拆分、Promise/事件监听的常规写法、Vue template 排版和 CSS 细节。
- CRUD、electron-store 的常规读写、IPC 参数的显然运行时 type guard。
- fake child process、fake WSL runner 和测试 fixture 的组织方式，只要通过第 8 节验收点。
- setsid 的具体标志与后台化写法、控制文件命名与时间戳方案、普通循环、Map/Set 选择、注释措辞和日志级别，只要不改变契约与进程组语义。

### 9.3 不确定性处理

本计划按以下假设实现，不因这些事项暂停 workflow：

1. PiX 主进程运行在 Windows，目标是 WSL2 version 2；WSL1 直接报告不可用。
2. recentProjects 是 v1 的项目环境权威存储，不新增 .pix/environment.json marker，避免 marker 尚未知道 distro 时的 bootstrap 循环。
3. WSL distro/home/automount 探测可以由 wsl.exe 完成；探测失败必须显式报错或在 Windows 模式保持可用。
4. rg/fd 由用户在 distro 内安装；v1 不下载二进制。Debian 的 fdfind 可由 backend 选择，但模型提示和 README 必须说明命名差异。
5. SessionManager 的物理 cwd header 兼容现有恢复逻辑；renderer 显示层负责回译成 logical cwd。
6. `toLogicalError` 作为共享 helper 由 WslFileOperations 调用（per-method wrap），策略见 §4.7。
7. Team worker 真实 createAgentSession 调用的 object-identity 验证为 distro-gated 集成测试，无 distro 时 skip，S8 以内部状态断言为主。

若实现中发现与这些假设冲突，只能在本计划列出的接口内增加诊断或可选字段；不能改变模块边界、持久化语义、stage 依赖或 v1 范围。完成定义是：Windows 无 backend 路径通过原有回归，WSL 单会话和 Team 共享 backend，所有第 4 节示例/边界测试通过，且 workflow verify 不产生提交物（dist 为 gitignored 本地产物）或依赖文件。

---

## 附：核对勘误与对抗式验证修订（2026-08-07）

下列为相对初稿的关键修正（经四路对抗式验证：fidelity / contract+stage / technical / scope），供 executor 与 reviewer 追溯：

1. `_runtimeEnvironmentContext`（agent-session.ts:1189）**无 cwd 字段**；prompt 的 logical cwd 在 `_rebuildSystemPrompt` 的 `BuildSystemPromptOptions.cwd`（:1238）。`runtimeEnvironmentOverride` 不含 cwd。（wsl_work.md §10.5 与初稿均曾误记。）
2. `sessionManager.getCwd()` 共**四处**用作 cwd：executeBash（:3269）、approval policy（:573）、exportToHtml（:3699）、exportToJsonl（:3730）。§4.1 重定向表已全部覆盖（前三改 `_runtimeCwd`，导出 header 存 physicalCwd）。
3. `this._cwd`（:403）同时被 runtime 与 host 两侧消费；不得整体替换，须按 §4.1 表分别处理。
4. `main.ts` 不在修改范围：PiX 直接调 `createAgentSession`（session-bridge.ts:1302、team-manager.ts:794），CLI 经 SDK 默认 `runtimeCwd ??= hostCwd`。
5. `paths.ts` 的 `PathInputOptions`（:9-20）**已含 `homeDir?`**（:15）；本计划仅新增 `posix?`。
6. `edit-diff.ts` 的 `computeEditsDiff`（:418）直接调 `fs.access`/`fs.readFile`；WSL 须改走 operations 或转 physical，仅注入 resolver 不足；新参数 optional 以兼容范围外三参调用。
7. `SettingsPage.vue:436` 的 "例如 wsl" hint 在 `shellCommandPrefix` 字段，`shellPath` 是相邻 :435。
8. `RpcSessionState`（:87）的 `executionMode` 是 approval 模式，与新 `executionEnvironment` 无关；`SessionInfo.cwd`（:287）须回译 logical，`SessionInfo.path` 为物理路径不展示给模型。
9. `chat-files.ts` 绝对路径同时泄漏到附件 `path` 字段（:44/:56/:92）与 `<file name>` 标签（:67/:86-87/:98），两处都经 displayPath 回译；其内部 NFD/curly-quote `existsSync` 探测（:113-124）在 WSL 跳过；新增 `displayPath` 可选参数。
10. SHA-1 hash 站点共三处：`team-persistence.ts:13`/`:21` + `session-bridge.ts:1270`，均须用 physicalCwd。
11. `McpAdapter` 在 `session-bridge.ts:1289` 与 `team-manager.ts:769` 两处均无 options 构造；WSL 两处都须传 `allowStdio:false`，由 `context.isWsl` 决定（不从 backend 存在性推断）。S7 验 session-bridge 站、S8 验 team-manager 站。
12. `BackgroundTaskRegistry` 由 `AgentSession` 在 `:438` 内部 new，未从 package barrel 导出；v1 用 excludeTools 禁用，不改其构造。
13. `getWorkspaceMode`/`setWorkspaceMode` 是 `team-persistence.ts:26/37` 的 standalone 函数，经 ipc-handlers :298/303 调用，非 TeamManager 方法。
14. `executeBash` 默认 fallback 必须保留 `createLocalBashOperations({ shellPath })`（初稿误删 `{ shellPath }`，违反 Windows 无回归）。
15. merge helper 须用 spread 保留**全部** per-tool 字段（`autoResizeImages`/`commandPrefix`/`shellPath`/`spawnHook`），非仅 autoResizeImages。
16. `spawnRipgrep` 缺失 rg 须抛含 distro 名与 apt 提示的 Error；grep early-kill 须经 setsid+控制文件清理 WSL 内 rg（否则 `matchCount>=limit` 频繁触发泄漏孤儿 rg）。
17. 系统提示须含 MCP/扩展路径边界提示（HTTP/SSE MCP 返回 Windows 路径不与"纯 Linux"沉浸矛盾）；`/mnt/<drive>` 保留设备名警告须保留（NTFS）。
18. pgid 控制文件：wrapper 以 `$1` 接 command；目录 warmUp 时 mkdir+setsid 探测（缺失降级）；abort 重试读控制文件；清理命令内含 `rm -f`；启动清扫残留；grep 复用 killProcessGroup。
19. mutation key 用 Linux `wsl.exe -e realpath`（非 Windows realpathSync over UNC），避免 ext4 symlink 解析失败。
20. grep context 行用 `wsl.exe -e cat`（原生读，非 9P）；rg spawn 加独立 timeout 按路径类别翻倍。
21. **类型刷新关卡**：SDK 改动后须 `npx tsgo -p packages/coding-agent/tsconfig.build.json` 刷新 dist，S7/S9/S13 的 pix tsc gate 在刷新后运行（否则 TS2305/TS2353）。
22. **Stage DAG 修订**：S5 硬依赖 +S2（spawnRipgrep/readdirWithTypes 字段）；S6 硬依赖 +S5（静态 import）；S9 硬依赖 +S8（initialize 签名）；测试文件归入各自 stage（S2/S3-S5/S6/S8），S10 改为跨切面回归（依赖 S2/S5/S6/S8）；S1 行为断言移到 S2。
23. §2.4 的 WSL_DISTRO_NAME 禁令限定为「新增 backend-contract 代码」（clipboard-image.ts:144 既有，不动）。
