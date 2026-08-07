# PiX WSL2 原生终端支持技术方案

> 本方案经过对抗式验证，发现的缺陷与修订见第 10 节。
>
> 方案可行性已在本机实测验证（WSL 2.7.11.0，distro `Ubuntu-22.04`，WSL2 内核 6.18.33.2-microsoft-standard-WSL2），见第 1.4 节。

## 0. 目标与架构基调

**目标**：让 PiX 中的智能体在 WSL2 原生 Linux 环境工作——智能体执行的 bash 命令在 WSL 原生 bash 中运行（cwd 是 `/home/user/...` 这类 Linux 路径），文件操作落在 WSL 原生 ext4 文件系统上，而非通过 Windows PowerShell 间接调用 `wsl` 命令。用户举例的路径对应关系：WSL 内 `/home/bishe/work/fan-web` ⇄ Windows 侧 `\\wsl.localhost\Ubuntu-20.04\home\bishe\work\fan-web`。

**架构基调：宿主桥接（Host-Bridge）**。PiX 始终是 Windows Electron 进程（`process.platform` 永远是 `win32`，驱动 detached/taskkill/二进制扩展名等宿主决策），编码代理 in-process 运行于 Windows 侧。通过两条桥接通道接入 WSL2 原生 Linux 环境：

- **命令执行**：`wsl.exe`（spawn `wsl.exe -d <distro> --cd <linuxCwd> -e bash -c <command>`）
- **文件 IO**：UNC 路径 `\\wsl.localhost\<distro>\...`（Windows 侧 Node `fs` 经 9P 协议直接读写 WSL 文件系统）

智能体看到的是 Linux 语义（`platform=linux`、`cwd=/home/...`、`apt`、无 `.exe`、`/dev/null`）。

**核心架构判断**：WSL 支持不是"换一个 `BashOperations`"，而是"路径解析 + 全部 7 个文件/命令 Operations + 环境上下文 + bootstrap fs 消费者"的**整体替换**。现成的 Operations 注入接缝在多处被绕过，且最危险的断裂是静默降级而非显式失败。因此采用**单一注入点 + 双 cwd 表示**的收敛设计。

**硬约束**：不启用 WSL 时必须完全保持现状（`executionBackend=undefined` 走原路径，行为字节级不变）。

**感知沉浸原则（单向沉浸）**：本方案的顶层目标是让智能体"感知处于 WSL Linux 中、所有工具调用有 Windows 中运行的流畅度、安心在其中工作"。为此确立**单向沉浸**不变式--智能体永远只接触 Linux posix 路径与语义，所有 Windows↔WSL 路径转换、UNC/盘符映射、错误回译都在工具层对智能体透明。具体：工具输入接受 Linux 路径；工具输出（grep 命中、find 结果、ls 列表、错误消息）统一为 Linux posix 路径，**不得向智能体泄漏 UNC（`\\wsl.localhost\...`）或 Windows 盘符路径**；`platform=linux` + `cwd=/home/...` + 系统提示 Linux 分支构成沉浸本体。感知断裂（bash 成功而文件工具失败、错误不可理解）是反复试错的根因，须由路径转换正确性（§4.4/§6.2）、错误回译层与可操作错误反馈（§6.9）共同消除。

## 1. 现状分析

### 1.1 架构概览

PiX = Electron 主进程（`pix/src/main/`，Node）+ Vue3/Vuetify 渲染进程，经 IPC（`preload.ts` 的 `contextBridge` 暴露 `pixApi` + `ipc-handlers.ts` 的 `ipcMain.handle`）通信。编码代理 in-process 运行（`packages/coding-agent`），非子进程。会话由 `SessionBridge` 管理，`_cwd` 持有工作目录，`start(projectDir)` 启动会话。

### 1.2 命令执行现状

- `child_process.spawn`，stdio `["ignore","pipe","pipe"]`（**stdin 忽略，无 PTY**），`windowsHide:true`，超时 120s。
- Shell 由 `getShellConfig()`（`shell.ts:139`）选择，Windows 上强制 Git Bash，args 固定 `["-c"]`。
- `killProcessTree()`（`shell.ts:272`）Windows 用 `taskkill /F /T /PID`。
- **不支持交互式输入**（vim/ssh/交互确认会挂起）。

### 1.3 已有扩展点（关键利好）

| 扩展点 | 位置 | 说明 |
|---|---|---|
| `BashOperations` 接口 | `bash.ts:41` | `exec(command,cwd,options)`，注释原文 "Override these to delegate command execution to remote systems (for example SSH)"。`executeBash`（`agent-session.ts:3257`）接受 `options.operations` 注入。 |
| 文件 Operations 接口 | `read.ts:43`/`write.ts:32`/`edit.ts:74`/`find.ts:41`/`grep.ts:51`/`ls.ts:32` | 各自有默认本地 `fs` 实现，均可注入。 |
| `ToolsOptions` | `tools/index.ts:102-110` | **已含全部 7 个工具字段**（read/bash/write/edit/grep/find/ls），`createAllToolDefinitions` 已逐个下传（`:172-182`）。 |
| `_buildRuntime` 注入缺口 | `agent-session.ts:3071-3074` | 当前**只传 `read`/`bash`**，write/edit/grep/find/ls 用默认本地实现。补传即可。 |
| `shellPath`/`shellCommandPrefix` | `settings-manager.ts:805,825` | 已存在，`SettingsPage.vue:436` hint 甚至写"例如 wsl"。 |
| `RuntimeEnvironmentContext` | `system-prompt.ts:29` + `renderEnvironmentContext:140` | 传达 shell 类型/平台/cwd 给模型。 |

### 1.4 实测验证（本机）

| 验证项 | 命令 | 结果 |
|---|---|---|
| UNC 列目录 | `fs.readdirSync('\\wsl.localhost\Ubuntu-22.04\home')` | `['admin']` ✓ |
| UNC stat | `fs.statSync('\\wsl.localhost\Ubuntu-22.04\etc\hostname')` | size=16, isFile=true ✓ |
| UNC 读文件 | `fs.readFileSync('\\wsl.localhost\Ubuntu-22.04\etc\hostname')` | `"HC-202606151502\n"` ✓ |
| Win→WSL 转换 | `wslpath -u 'C:\Users'` | `/mnt/c/Users` ✓ |
| WSL→Win 转换 | `wslpath -w '/home'` | `\\wsl.localhost\Ubuntu-22.04\home` ✓ |
| WSL 内设 cwd | `wsl -d Ubuntu-22.04 --cd /home -- sh -c 'pwd'` | `/home` ✓ |
| WSL 环境 | `whoami`/`$HOME`/`uname` | `admin` / `/home/admin` / `Linux ...-microsoft-standard-WSL2` ✓ |
| `/mnt/c` 转 Windows | `wslpath -w /mnt/c/Users` | `C:\Users` ✓（`/mnt/c` 是挂载的 Windows C: 盘）|
| UNC 访问用户 home | `fs.readdirSync('\\wsl.localhost\Ubuntu-22.04\home\admin')` | `.bashrc`/`.profile`... ✓（用户 home 可读）|
| UNC 访问 `/mnt/c` | `fs.statSync('\\wsl.localhost\Ubuntu-22.04\mnt\c\...')` | **EPERM**（errno -4048，不可经 UNC 访问 Windows 盘挂载点）|
| `ls /mnt` | `wsl -- ls /mnt` | `c d e wsl wslg`（挂载的盘）|

**结论**：Windows 侧 Node `fs` 可直接经 UNC 读写 WSL **原生 ext4** 文件系统（`/home/...`、`/etc/...`，含用户 home，二进制安全、字节精确、无每操作子进程开销）；`wslpath` 双向转换可用；`wsl.exe --cd <linuxpath>` 可直接设定 WSL 内 cwd。**关键边界**：`/mnt/c` 等 WSL 挂载的 Windows 盘**不能**经 `\\wsl.localhost\<distro>\mnt\c\...` 访问（EPERM），须转成 `C:\...` 直达 NTFS--这决定 `WslPathConverter` 必须对 `/mnt/<drive>/...` 特判（见 §4.4/§6.2/§10.14）。

### 1.5 现状对 WSL 支持的缺口

1. 文件工具不感知 WSL（最严重）：bash 可能在 WSL 执行，但 read/write/edit/grep/find/ls 仍用 Node `fs` 操作 Windows 文件系统，路径不互通。
2. `_buildRuntime` 只给 read/bash 传 options，其他工具用默认本地实现。
3. cwd 是 Windows 路径，无法直接传给 WSL；`_assertProjectDirectory`（`session-bridge.ts:1462`）用 `existsSync`，对 Linux 路径会失败或误解析。
4. `getShellConfig()` 不识别 `wsl.exe`（args 硬编码 `["-c"]`，对 wsl.exe 无效）。
5. `getShellEnv()` 注入 Windows `binDir`（`~/.pi/agent/bin`），WSL 内无效。
6. `RuntimeEnvironmentContext` 始终报 `process.platform`（win32），模型误以为在 Windows。
7. `shellKindFromPath()`（`system-prompt.ts:126`）不识别 wsl，返回 unknown。
8. `tools-manager.ts` 下载的 fd/rg 是 Windows `.exe`。
9. `killProcessTree` 的 `taskkill /T` 杀不到 WSL2 LXSS 子系统内的 Linux 进程。
10. `paths.ts`/`path-utils.ts` 用 Node `path`（Windows 上=win32），Linux 路径 `/home/user` 会被 `path.resolve` 当成当前盘符根，解析成 `C:\home\user`。

## 2. 参考实现借鉴

### 2.1 Claude-Code（TS，跑在 WSL 内 + Win↔WSL 混合场景）

- **路径转换**：`WindowsToWSLConverter`（`idePathConversion.ts:25`）调 `wslpath -u/-w`，fallback 手写 `C:→/mnt/c`、UNC 正则 `^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(.*)$`。
- **tmux 路由**：Windows 原生模式 `execFileNoThrow('wsl', ['-e','tmux',...])`，pin `WSL_INTEROP=/run/WSL/1_interop` 防子进程继承短命 interop socket。
- **性能特判**：ripgrep 超时翻倍（`/mnt/c` 慢 2-10x）。
- **shell**：`child_process.spawn`（无 PTY），只选 bash/zsh。
- **两套路径转换**：`wslpath`（`/mnt/c` 风格，WSL 用）vs 纯 JS 正则（`/c/` 风格，Git Bash 用）。

### 2.2 codex（Rust，原生 Linux 跑 WSL 内，不调 wsl.exe）

- **`ExecRequest` 统一命令载体**（command/cwd/env/sandbox），`SandboxManager::transform` 包装命令。
- **`Environment` local/remote 抽象**：可借鉴把 WSL 当"远程环境"后端。
- **`PathUri` 跨边界校验**（`ForeignPath` 错误）。
- **`win_path_to_wsl` 纯字符串转换**（不调 wslpath）：`C:\foo\bar → /mnt/c/foo/bar`。
- **两条执行路径**：shell 工具（无 PTY 管道）+ `unified_exec`（PTY 交互式）。

### 2.3 取舍

本方案对**同 distro 内 Linux↔Windows** 用纯字符串（O(1)），分两类：原生 ext4 路径（`/home/...`、`/etc/...`）映射 UNC `\\wsl.localhost\<distro>\...`；WSL 挂载的 Windows 盘（`/mnt/c/...`、`/mnt/d/...`，单字母盘符）映射 `C:\...`/`D:\...` 直达 NTFS。后者是硬性要求：实测 `/mnt/c` 经 UNC 是 **EPERM 硬失败**（errno -4048），agent 用 `/mnt/c` 访问 Windows 文件是常态（详见 §10.14）；该分支保持 O(1) 纯字符串，不引入 wslpath 热路径开销，与性能理由兼容。`wslpath` 仅作歧义 Windows 路径（`C:\Users\...`）与非默认挂载根的回退。理由：`wslpath` 每次约 50ms 子进程，热路径不值；codex 也是纯字符串。

不引入 tmux 依赖（Claude-Code 用 tmux 会话路由便于整组清理，本方案用 `setsid` 起 pgid + `kill -KILL -<pgid>`，更轻量但需自管 pgid）。不引入沙箱（PiX 智能体本就是用户级信任）。不维持长驻 bash 会话（codex 用 `ExecRequest` 每次独立，Claude-Code spawn），本方案每命令独立 spawn 与两者一致。

## 3. 总体架构

```
┌─────────────────────────── PiX (Windows Electron, process.platform=win32) ───────────────────────────┐
│  渲染进程 (Vue3)  ←IPC→  主进程 (Node)                                                                    │
│                            ├─ SessionBridge (持有逻辑 cwd + 物理 cwd, 按 per-project 标记选 backend)      │
│                            ├─ createWslExecutionBackend()  [pix/src/main/wsl/]                          │
│                            │     ├─ WslBashOperations   ── spawn wsl.exe ──→  WSL2 bash (原生 Linux)     │
│                            │     ├─ WslFileOperations   ── fs over UNC ──→  WSL2 ext4 (9P)               │
│                            │     │     ├─ read/write/edit/ls  (UNC IO)                                    │
│                            │     │     ├─ find: wsl.exe -e fd   (原生搜索)                                │
│                            │     │     └─ grep: wsl.exe -e rg   (原生搜索)                                │
│                            │     ├─ WslPathConverter (纯字符串 linux↔UNC, wslpath 回退)                  │
│                            │     └─ WslDistroResolver (wsl -l -v UTF-16LE)                               │
│                            └─ createAgentSession({ executionBackend, runtimeEnvironmentOverride, cwd })    │
│                                  └─ AgentSession._buildRuntime() 把 backend ops 注入全部 7 个工具          │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                  │
                    智能体看到的: platform=linux, cwd=/home/..., apt, 无 .exe, /dev/null  (Linux 语义)
```

**双平台区分**：宿主平台（PiX Node 自身，`process.platform` 永远 win32，驱动 detached/killProcessTree/binary 扩展名/tools-manager）vs 执行平台（bash 工具与模型看到的，WSL 模式报 linux）。

**双 cwd 表示**：
- **逻辑 cwd**（Linux posix 路径如 `/home/bishe/work/fan-web`）：用于 system prompt 的 `Current working directory`、工具内 posix 路径语义、bash 的 `--cd`。
- **物理 cwd**（UNC `\\wsl.localhost\<distro>\home\bishe\work\fan-web`）：喂给 `SettingsManager.create`、`DefaultResourceLoader`、`SessionManager`、`_assertProjectDirectory` 等 bootstrap fs 消费者。

原因：`settings-manager.ts:183` 与 `resource-loader.ts:79/207` 都用 `resolvePath`=win32.resolve 消费 cwd，Linux 路径会解析成当前盘符根 `C:\home\...`，导致 `.pi/settings.json`、`AGENTS.md`/`CLAUDE.md`、项目级 skills/extensions 全部静默丢失，bootstrap 消费者必须喂物理 cwd（缺陷详情见 §10.1）。

**单一注入点**：`ExecutionBackend` 收敛 8 个变化点（resolvePath + 7 个 Operations getter + runtimeEnvironment + assertProjectDirectory + getCwd），绝不出现 distro/wslpath/UNC 字样。

## 4. 核心抽象

### 4.1 ExecutionBackend（SDK 层 generic 接口）

**新增** `packages/coding-agent/src/core/tools/execution-backend.ts`：

```typescript
export interface ExecutionBackend {
  resolvePath(path: string, cwd: string): string;          // WSL backend 用 path.posix
  readonly bash?: BashOperations;
  readonly read?: ReadOperations;
  readonly write?: WriteOperations;
  readonly edit?: EditOperations;
  readonly grep?: GrepOperations;     // 含 spawnRipgrep hook
  readonly find?: FindOperations;     // 含 glob escape hatch（已存在）
  readonly ls?: LsOperations;         // 含 readdirWithTypes hook
  runtimeEnvironment?: Partial<RuntimeEnvironmentContext>;
  assertProjectDirectory?(path: string): Promise<void> | void;
  getCwd?(): string;                  // 返回逻辑 Linux cwd
}
```

经 `CreateAgentSessionOptions.executionBackend?: ExecutionBackend` → `AgentSession` 实例字段 `_executionBackend` → `_buildRuntime` 传给全部 7 个工具 + bash；`executeBash` 与（v2）`BackgroundTaskRegistry` 也消费同一实例（`executeBash` 默认 `options?.operations ?? this._executionBackend?.bash ?? createLocalBashOperations({shellPath})`）。Windows 模式 `executionBackend=undefined`，行为字节级不变。

### 4.2 WslBashOperations

**新增** `pix/src/main/wsl/wsl-bash-operations.ts`，实现 `BashOperations`，职责概览：

- `exec(command, cwd, options)`：经 `spawn('wsl.exe', [...])` 在 WSL 原生 bash 中执行命令（argv 形式详见 §5.1）。
- 每命令固定 `--cd <linuxCwd>` 设定 cwd，不做跨命令 cwd 跟踪（详见 §5.2）。
- 自建最小 Linux env（仅 `WSL_DISTRO_NAME` 等），不调 `getShellEnv()`、不透传 Windows env（详见 §7.4）。
- 进程管理：abort/timeout 时先杀 Windows 侧 wsl.exe，再异步 best-effort 杀 WSL 内进程组，不复用 `killProcessTree`（taskkill /T 到不了 WSL2 LXSS 子系统内的 Linux 进程）（详见 §5.3）。
- 冷启动缓解（详见 §5.4）。

### 4.3 WslFileOperations suite

**新增** `pix/src/main/wsl/wsl-file-operations.ts`，共享 distro+conversion+home 的 Read/Write/Edit/Ls/Find/Grep Operations：

- **UNC 做 IO**：read/write/edit/ls/stat/access 经 Windows 侧 Node `fs` over UNC（二进制安全、字节精确、无每操作子进程开销）。Node `fs` readFile/writeFile 不做 CRLF 翻译，字节保留。
- **`readdirWithTypes`** 消除 ls 的 N 次 9P stat 往返（见 6.4）。
- **`mkdir`** 用 `wsl.exe -d <distro> -e mkdir -p <linuxDir>` 单次调用（原生 ext4），而非 UNC recursive mkdir 的 N 级 9P 往返。
- **find**：`customOps.glob`（`find.ts:155` 已有 escape hatch，无需改接口）运行 `wsl.exe -d <distro> --cd <linuxCwd> -e fd --absolute-path --glob ...`，返回绝对 Linux 路径。
- **grep**：`spawnRipgrep` hook 运行 `wsl.exe -d <distro> --cd <linuxCwd> -e rg ...args`（见 6.5）。
- **mutation queue key** 走 UNC realpath（见 6.6）。

### 4.4 WslPathConverter

**新增** `pix/src/main/wsl/wsl-paths.ts`：

- `linuxToWindows(linuxPath)`（取代 `linuxToUnc`）：纯字符串 O(1)，**分两类**（实测验证，见 §1.4）：
  - **WSL 挂载的 Windows 盘**：正则 `/^\/mnt\/([a-zA-Z])\//` 匹配单字母盘符（`/mnt/c`、`/mnt/d`）-> `DRIVE:\...`（如 `/mnt/c/Users/foo` -> `C:\Users\foo`），直达 NTFS。多字母 `/mnt/wsl`、`/mnt/wslg`（WSL 内部挂载）**不匹配**该正则，正确落回 UNC。
  - **原生 ext4 路径**（`/home/...`、`/etc/...` 等其余 `/...`）：映射 UNC `\\wsl.localhost\<distro>\...`，同时处理 legacy `\\wsl$\`。
  - converter 契约改为**可返回 UNC 或盘符路径**，IO 层 Node `fs` 两者皆收。
- `windowsToLinux(winPath)`：UNC（`\\wsl.localhost\<distro>\...`/`\\wsl$\...`）-> 去 distro 前缀的 Linux 路径；盘符（`C:\...`）-> `/mnt/c/...`。
- `wslpath` 仅作回退：歧义 Windows 路径（`C:\Users\...`）、非默认 automount 根（wsl.conf `automount.root`）、纯字符串转换后 stat 失败时。
- 启动时读 `/etc/wsl.conf` 的 `automount.root`/`automount.enabled`，按实际根适配 `/mnt/<盘符>` 正则前缀（默认 `/mnt`）；`automount.enabled=false` 时文档说明 `/mnt` 访问 Windows 不可用。
- `getDistro`：`wsl.exe -l -v`（UTF-16LE 解码 strip BOM/NUL）或 settings 覆盖；`getHome`：`wsl.exe -e sh -c 'echo $HOME'`，缓存。
- **不可复用** `packages/coding-agent/src/utils/clipboard-image.ts:143` 的 `isWSL()`（它检查 `WSL_DISTRO_NAME`/`WSLENV` 环境变量 + 读 `/proc/version`，只在 PiX 跑在 WSL 内时有效；宿主桥接模型下这些环境变量与 `/proc/version` 均不存在）。

### 4.5 PathContext

`{distro; home; posix: boolean}`，作为参数穿过 `AgentSession → createAllToolDefinitions → 各工具 resolveToCwd`，**替代模块级 `setWslPathContext` 全局 setter**（避免 team 多 worker/未来同进程多项目串扰）。`paths.ts` 的 `resolvePath`/`normalizePath` 加 `posix?: boolean` 选项用 `path.posix.isAbsolute/resolve`；`~` 展开用 PathContext.home 而非 `os.homedir()`（=Windows USERPROFILE）。

### 4.6 RuntimeEnvironmentOverride

`AgentSessionConfig` 新增 `runtimeEnvironmentOverride?: Partial<RuntimeEnvironmentContext>`。pix 侧按 wslEnabled 构造 `platform='linux'`、`osName='WSL2 (<distro>)'`、`shell.kind='wsl'`、`cwd=逻辑 Linux cwd`，`_runtimeEnvironmentContext`（`agent-session.ts:1189`）优先合并它。

### 4.7 WslDistroResolver

**新增** `pix/src/main/wsl/wsl-distro.ts`：`wsl.exe -l -v` UTF-16LE 解析（strip BOM/NUL），稳健表格分割（按 ≥2 空格分列而非固定列宽），`spawnSync` 带 3-5s timeout，ENOENT 静默降级 Windows 模式。**distro 必须显式 `wslDistro` 设置**（禁止从默认 distro 推断），session start 用 `wsl.exe -d <distro> -e test -d <linuxCwd>` 校验可达。

## 5. 命令执行方案

### 5.1 spawn 形式

```
spawn('wsl.exe', ['-d', distro, '--cd', linuxCwd, '-e', 'bash', '-c', command])
```

- `-d <distro>` 显式 pin distro（不依赖可能变化的默认 distro）。
- `--cd <linuxCwd>` 用 wsl.exe 内建 cd（比前缀 `cd <dir> && ` 更干净快速）。
- `bash -c`（非 `-lc`）：与本地 `createLocalBashOperations` 的 `-c` 同构，避免每命令 re-source `~/.profile` 的成本与 stdout 污染；apt 装的 rg/fd 在 `/usr/bin` 已在默认 PATH。
- `command` 作为单个 argv 元素，由 Node spawn 传递、不手工拼接转义（唯一安全的转义路径），嵌套的双引号/`$`/反引号/分号原样保留，由内部 bash 解释。若某些 wsl.exe 版本对超长 command 有 32KB 命令行限制，超长脚本改为写入临时 `.sh` 文件后 `bash -c 'source /tmp/x.sh'`。

### 5.2 cwd 跟踪

**放弃 stderr sentinel 跨命令 cwd 跟踪**。本地 `createLocalBashOperations` 用固定 cwd + `bash -c` 且 `cd` 不跨命令持久，模型已习惯绝对路径或 `cd X && cmd` 复合命令。WSL ops 使用固定 `wslProjectPath` 作为每命令 `--cd`，与本地语义对齐，一并消除：后台命令 marker 位置破坏、trackedCwd 并发竞态、unbalanced quote 干扰、系统提示无法读取 trackedCwd 的问题。若将来确需持久 cd，须先在 `BashOperations` 加 `getCwd()` 并打通 agent-session 查询路径，同时解决后台命令 marker 问题。

### 5.3 进程管理

abort/timeout 时**颠倒双杀顺序**：

1. 先 `taskkill /F /T /PID` 杀 Windows 侧 wsl.exe（立即解除 exec promise、立即向用户反馈 abort 完成）。
2. 再异步 best-effort `spawn wsl.exe -d <distro> -e bash -c 'kill -KILL -<pgid>'`，独立短超时（5s），失败仅记日志。

先杀 WSL 进程组再杀 wsl.exe 的顺序在 VM 冷启动/distro 异常时会挂起 abort，使 wsl.exe 兜底不可达。命令用 `setsid -w bash -c '<cmd>'` 起独立 pgid 并经 `$BASHPID` 回传，务必测试 exit code 与 pgid 同时正确传播。

### 5.4 冷启动缓解

`vmIdleTimeout`（默认 60s）+ 审批模式会使 VM 关闭、下条命令冷启动数秒到 30s+。v1 即纳入：

- 启动时 `wsl.exe --running` 预热 + 周期 keep-alive。
- 或引导用户在 `.wslconfig` 设 `vmIdleTimeout=-1`。
- 冷启动期间向 UI 报告 progress 而非静默挂起。
- 为 WSL ops 的 exec 设独立于命令超时的 spawn 就绪超时。

### 5.5 交互式 stdin

**v1 不支持**，保持 stdio `['ignore','pipe','pipe']` 与现状一致。vim/ssh/交互确认在本地模式即挂起，WSL 继承同一契约非回归。v2 作为独立工具（`node-pty` + ConPTY 驱动持久 wsl PTY）评估，不改 bash 工具契约。

### 5.6 后台任务

**v1 用 `excludedToolNames` 禁用** `run_background`/`read_output`/`stop_process` 并文档说明。理由：`BackgroundTaskRegistry`（`background-task-registry.ts`）是 coding-agent 公共类（被 pi-agent CLI 复用），改其构造与 `getShellConfig` 无参调用会影响其他消费者；且 WSL 后台 spawner 须复制 pgid/双杀逻辑。v2 再统一抽取共享 WSL 包装层并改造 `BackgroundTaskRegistry` 注入 spawner/operations，`stop` 杀 WSL 内 pgid。

### 5.7 注入全覆盖

`bashOperations` 存为 AgentSession 实例字段，`_buildRuntime`（`agent-session.ts:3071`）与 `reload()`（`:3110`）都读取它，reload 后不丢失；`executeBash`（`agent-session.ts:3270`）默认兜底见 §4.1，使 bash 工具/executeBash/后台三入口统一。

## 6. 文件系统与路径方案

### 6.1 混合访问模型

- **read/write/edit/ls/access/stat/mkdir**：Windows 侧 Node `fs` over UNC（9P，二进制安全、字节精确、无每操作子进程开销）。
- **find/grep 的搜索引擎**：WSL 内原生运行 Linux fd/rg（经 `wsl.exe` 调用），避开 9P 内容读取性能塌陷（rg over UNC 会把每个命中文件内容经 9P 读，2-10x 慢）。

### 6.2 路径转换

路径转换细节见 §4.4（纯字符串 O(1)，`/mnt/<盘符>` 直达 NTFS 特判，wslpath 仅回退）。

**下游兼容**：converter 输出双形态（UNC 或盘符路径）被 grep context>0 的 `getFileLines`、mutation queue key（`getMutationQueueKey`）、`canonicalizePath` 等消费--`/mnt/c` 文件得 `C:\...` key（Windows realpath 正确解析 symlink 去重），ext4 文件得 UNC key，两类 key 互不冲突。实现时须逐点验证这些下游逻辑兼容双形态。

### 6.3 路径解析改造（前置条件）

`ExecutionBackend.resolvePath(path, cwd)` 用 `node:path/posix`。WSL backend 提供它，工具内 `resolveToCwd`/`resolveReadPath` 调用点改为优先用 backend 解析器。

给 7 个 `ToolOptions` 各加 `resolvePath?: (p, cwd) => string`（`resolvePath` 不是任何 `XxxOperations` 的字段，须作为新 per-tool option）。`paths.ts` `resolvePath`/`normalizePath` 加 `posix?: boolean` 选项用 `path.posix.isAbsolute/resolve`；`~` 展开用 PathContext.home 而非 `os.homedir()`；`canonicalizePath`（`paths.ts:28` realpathSync）在 WSL 模式禁用或改用 `wsl -e realpath`（UNC 上对 WSL 符号链接指向 `/proc`、`/dev` 会解析失败）。

WSL read 路径绕过 `resolveReadPathAsync` 的 macOS NFD/curly-quote 变体 `fs.access` 探测（`path-utils.ts:59-81`，在 WSL 模式是无用的 9P 往返）。

### 6.4 ls 消除 9P 逐条 stat

扩展 `LsOperations` 加可选 `readdirWithTypes?(dir) => Promise<Array<{name; isDirectory}>>`，WSL impl 用 `fs.readdir(uncDir, {withFileTypes:true})`（一次 syscall，类型来自 d_type），fallback lstat。`ls.ts:164` 在 `readdirWithTypes` 存在时跳过 stat 循环。**行为变化**：broken symlink 将出现在列表中（不再被 `:166` catch 跳过），可选 `?` 标记。接口保持可选以维持本地模式不变。

### 6.5 grep spawnRipgrep hook

扩展 `GrepOperations`（`grep.ts:51`）加可选 `spawnRipgrep?(args, cwd, env) => ChildProcess`（**非** `Promise<{stdout,exitCode}>` 缓冲式——后者会丢失现有流式 `--json` 解析与 `matchCount>=limit` 提前杀，`grep.ts:287-290`；ChildProcess 句柄复用现有 readline/JSON/limit 提前杀逻辑，仅换 spawn 目标）。WSL impl = `spawn('wsl.exe', ['-d',distro,'--cd',linuxCwd,'-e','rg',...args])`。

**CRITICAL**：把 `grep.ts:172` 的 `ensureTool('rg')` 移进 `!spawnRipgrep` 分支，让 `spawnRipgrep` 自负 Linux rg 探活（先 `wsl.exe -e sh -c 'command -v rg'`），否则离线/无 Windows rg 时 grep 是死代码。grep `context>0` 的上下文行读取（`getFileLines` `grep.ts:201` 经 `ops.readFile`）在 WSL 模式要么用 rg 自带 JSON 上下文行、要么 `WslGrepOperations.readFile` 走 `wsl.exe -e cat`，避免 50 个命中文件的 9P 内容读取把搜索性能优势抵消。

### 6.6 edit / mutation queue

edit 是整文件读-改-写，UNC 下与本地同样字节精确（Node `fs` 无 CRLF 翻译，`edit.ts:340-346` 的 BOM/行尾逻辑 fs-agnostic）。但 `withFileMutationQueue`（`file-mutation-queue.ts:17` resolve+realpath）在 WSL 模式须基于 UNC——Linux 路径 resolve 得幽灵 `C:\` key，realpath 抛 ENOENT 回退幽灵串，两个指向同一文件的 symlink 路径得不同 key → 并发 read-modify-write 丢失更新。`WslOperations` 在调 `withFileMutationQueue` 前把 Linux 路径转 UNC（realpath over UNC 能正确解析 symlink 去重），或让 `getMutationQueueKey` 在 WSL 上下文先 `linuxToWindows` 再 resolve/realpath。

### 6.7 边界

- **符号链接**：UNC 下 `stat` 跟随链接，broken symlink 使 stat 抛错（ls 见 6.4）。
- **权限元信息**：Windows stat over UNC 不报告真实 Unix mode/uid/gid（合成 mode），只有 `isDirectory()` 可信（当前工具只用这个）；chmod/chown 经 bash。
- **大小写敏感**：ext4 + 9P + Linux fd/rg 保留大小写敏感。
- **行尾**：Node `fs` 无 CRLF 翻译 + edit 已归一行尾 → LF 保留。
- **fs.watch**：跨 9P 不可靠，禁用前先 grep 全仓 `fs.watch`/chokidar 用点逐个评估降级方案（轮询或显式重读），而非一刀切。

### 6.8 显示助手

- `shortenPath`（`render-utils.ts:10`）用缓存 WSL home 而非 `os.homedir()`。
- `linkPath`（`:19`，仅用于 TUI 渲染，不影响智能体收到的工具结果）不要简单禁用 `pathToFileURL`，而是 `linuxToWindows` 后 `pathToFileURL` 生成可被 Windows 资源管理器打开的 `file://wsl.localhost/...` 链接。

### 6.9 工具错误反馈设计（感知沉浸的防御纵深，新增）

智能体反复试错的根因是"错误不可理解"。本节规定路径相关失败的反馈契约，是单向沉浸不变式（§0）的执行保障。

**错误回译层**：`WslFileOperations` 在边界统一包裹 Node `fs` 调用，catch 错误后将错误消息中的 UNC（`\\wsl.localhost\...`）或盘符路径（`C:\...`）**回译为 Linux posix 路径**再上抛。已核实 `read.ts:332-334` 直接 `reject(error)` 原样上抛，Node `fs` 的 ENOENT/EACCES 错误对象天然携带传入的 UNC/盘符路径字符串--若不回译，系统提示说 cwd 是 `/home/...` 而智能体在错误里看到 `\\wsl.localhost` UNC，会误改用 UNC 进一步混乱。审计 `write.ts`/`edit.ts`/`ls.ts` 中所有自构错误消息的路径来源，确保回译覆盖。**回归不变式**：工具结果与错误消息中不得出现 UNC 或 Windows 路径。

**可操作错误反馈**：路径相关失败返回可操作错误而非裸 ENOENT/bash 报错。
- **文件工具**：转换前检测输入是否为 `C:\`/UNC 风格，对无法正确转换的（含 `/mnt/c` 幽灵路径场景）显式拒绝并附引导，如 `Path 'C:\Users\foo' 是 Windows 路径，WSL 文件工具请用 Linux 路径（如 /home/... 或 /mnt/c/Users/foo 经 bash）`。
- **bash 工具**：best-effort 扫描命令中的 `C:\`/UNC token，当 stderr 含 `No such file` 且命令含 Windows 路径特征时追加提示行（bash 命令内容含变量/命令拼接，无法可靠解析，故为软约束）。

**路径校验层**：
- **层级**：per-tool `resolvePath` 包裹 + 文件工具转换前 guard。
- **拒绝输入**：文件工具拒绝 `C:\`/UNC 风格输入（引导改 Linux 路径）；`resolvePath` 拒绝跨 distro 路径。
- **错误文案**：见上"可操作错误反馈"。
- **不对称声明**：bash 命令内容校验是 best-effort 软约束（无法可靠解析变量拼接的路径），故 bash 依赖提示词 + 错误反馈；文件工具有硬约束 guard。这一不对称须显式文档化，避免实现者各工具 ad-hoc 处理。

## 7. 环境与模型感知

### 7.1 RuntimeEnvironmentContext

WSL 模式下 `platform` 报 `'linux'`（非新增 `'wsl'`），`osName` 携带 `'WSL2 (<distro>)'` 区分。已核实 `platform` 仅被 `system-prompt.ts:141/150/185` 消费（纯提示词），所有宿主决策（detached、killProcessTree、tools-manager 扩展名、`package-manager.ts:7`）读 `process.platform`（win32），报 linux 正确触发模型 apt/正斜杠/`/dev/null` 语义且不误触发宿主决策。

注入机制：`AgentSessionConfig.runtimeEnvironmentOverride`，`_runtimeEnvironmentContext`（`agent-session.ts:1189`）优先合并它。否则模型看到 Windows 仍发 powershell/Windows 路径，正是要避免的失败。

### 7.2 shell 识别

`shell.kind` 联合类型（`system-prompt.ts:38`）新增 `'wsl'`；`shellKindFromPath`（`:126`）识别 wsl/wsl.exe。但 WSL bash 走自定义 `BashOperations` **绕开 `getShellConfig`**（`getShellConfig` 对 `wsl.exe` 会 `existsSync` 失败抛错且 args 硬编码 `['-c']`），`shell.kind='wsl'` 仅用于提示词分支。`isPosixLikeShell`（`shell.ts:11`）需认 wsl 以保留 `/dev/null` 归一化（或确认 WSL 下 `>nul` 不会建文件后跳过）。

**不通过 `shellPath` 机制**：`SettingsPage.vue:436` 的"例如 wsl" hint 须改为独立 WSL 配置区，避免用户误填 `shellPath='wsl'` 触发 `getShellConfig` 抛错。

### 7.3 系统提示

`renderEnvironmentContext`（`system-prompt.ts:140`）新增 WSL 分支，明确告知模型：

- shell 是 WSL 原生 Linux
- cwd 是 `/home/...` POSIX 路径
- 包管理用 apt
- 工具是 Linux 版无 `.exe`
- 用 `/dev/null`
- **禁止在 shell 命令里用 Windows 路径（`C:\`）或 UNC（`\\wsl.localhost\...`）**
- 文件工具接受相对 cwd 的 Linux 路径
- 如需访问 Windows 文件系统，用 `/mnt/c/...` 这类挂载路径（正向指引）
- 路径转换由工具自动处理，你只需用 Linux 路径（赋能语句，须在 §4.4 路径转换与 §6.9 错误反馈落地后加入，避免在工具尚未诚实覆盖时误导）

开篇给出沉浸 framing：'你的整个工作环境是 WSL2 Linux，请像在原生 Linux 机器上一样工作，主工作目录在 Linux ext4 文件系统'。

同步把 `editing_contract` 里 always-on 的 "On Windows bash/POSIX shells, discard output with `/dev/null`, not bare `nul`/`NUL`"（`system-prompt.ts:428`）与 "Do not create files named Windows reserved devices..."（`:427`）改为 platform 条件渲染，消除 `platform=linux` 时仍显示 "Windows bash" 字样的矛盾。

**提示词不作路径卫生唯一防线**——配合路径校验层（§6.9）。

### 7.4 getShellEnv 不复用

`getShellEnv`（`shell.ts:194`）仅 `createLocalBashOperations` 用，WSL ops 自建 env 不调它；改 `getShellEnv` 对 WSL bash 工具是空操作。HOME/USER/SHELL 交给 wsl.exe 默认用户（`/etc/passwd`），不转发 Windows `process.env`。

### 7.5 fd/rg 工具链

WSL 模式优先复用 WSL 内已装版本（apt 的 `ripgrep`/`fd`，注意 Debian/Ubuntu 的 fd 实为 `fdfind`，文档说明或 `commandPrefix` 注入 `command -v fd || alias fd=fdfind`），经 `wsl.exe -e rg/fd` 调用。WSL GrepOperations/FindOperations 内部 `wsl.exe -e sh -c 'command -v rg/fd'` 探测，缺失回退 Windows fd/rg over UNC（正确但慢）或 find/grep。`tools-manager.ts:245` 当前按 `platform()=win32` 只下 Windows 二进制，Linux binary provisioning 是 Phase 3 新工作。

### 7.6 性能特判

- grep 工具的 rg spawn（`grep.ts:221`）当前无 timeout，加独立 timeout（可按路径类别翻倍——`/mnt/c` 与 `\\wsl.localhost` 跨界翻倍，ext4 `/home/...` 默认）。路径分类在已解析的 Linux posix 路径上做前缀匹配。
- fs.watch 跨 9P 不可靠（见 6.7）。

## 8. 架构集成改动清单

### 8.1 SDK 层（generic，无 WSL 字样）

| 文件 | 改动 |
|---|---|
| `packages/coding-agent/src/core/tools/execution-backend.ts` | **新增** `ExecutionBackend` 接口 |
| `packages/coding-agent/src/core/agent-session.ts` | `AgentSessionConfig` + `CreateAgentSessionOptions` 增 `executionBackend?` + `runtimeEnvironmentOverride?`；存为 `_executionBackend`；`_buildRuntime:3071` 改为从 backend 取 ops 填充全部 7 工具（显式 per-tool > backend > 默认，保留 `autoResizeImages` 等非 ops 字段）；`reload()`（定义 `:3110`，内 `_buildRuntime` 调用点 `:3116`）读取同一实例字段；`_runtimeEnvironmentContext:1189` 优先合并 override；`executeBash:3270` 默认 `options?.operations ?? this._executionBackend?.bash ?? createLocalBashOperations` |
| `packages/coding-agent/src/core/sdk.ts` | `CreateAgentSessionOptions:35` 增 `executionBackend?` + `runtimeEnvironmentOverride?`；`createAgentSession:415-431` 转发 |
| `packages/coding-agent/src/core/tools/index.ts` | `ToolsOptions:102` 各 per-tool options 增 `resolvePath?`；`createToolDefinition:112` 与 `createAllToolDefinitions:172` **两处**都实现 backend→per-tool 合并 |
| `packages/coding-agent/src/core/tools/grep.ts` | `GrepOperations:51` 增 `spawnRipgrep?(args,cwd,env)=>ChildProcess`；`:172` `ensureTool('rg')` 移进 `!spawnRipgrep` 分支；context>0 优先用 rg JSON 上下文行或 WSL readFile 走 wsl cat；rg spawn 加独立 timeout |
| `packages/coding-agent/src/core/tools/ls.ts` | `LsOperations` 增 `readdirWithTypes?`；`:164` 存在时跳过 stat 循环；记录 broken symlink 可见的行为变化 |
| `packages/coding-agent/src/core/tools/find.ts` | 确认 `customOps?.glob:155` 接收 wsl fd `--absolute-path` 结果；fd 输出相对化（`find.ts:300-313`）WSL 模式用 `path.posix` |
| `packages/coding-agent/src/core/tools/path-utils.ts` | `resolveToCwd`/`resolveReadPathAsync` 接受 PathContext/resolvePath 注入；WSL 模式跳过 macOS NFD 变体探测 |
| `packages/coding-agent/src/utils/paths.ts` | `resolvePath`/`normalizePath` 增 `posix?:boolean`；`~` 展开用传入 home；`canonicalizePath` WSL 模式禁用或改 `wsl -e realpath` |
| `packages/coding-agent/src/core/tools/render-utils.ts` | `shortenPath:10` 用 WSL home 缓存；`linkPath:19` `linuxToWindows` 后 `pathToFileURL` 生成可用链接 |
| `packages/coding-agent/src/core/tools/file-mutation-queue.ts` | `getMutationQueueKey:17` WSL 上下文先 `linuxToWindows` 再 resolve/realpath |
| `packages/coding-agent/src/core/system-prompt.ts` | `shell.kind:38` 增 `'wsl'`；`shellKindFromPath:126` 识别 wsl；`renderEnvironmentContext:140` 新增 WSL 提示词分支；`editing_contract:427-428` Windows 文本 platform 条件化 |
| `packages/coding-agent/src/utils/shell.ts` | `isPosixLikeShell:11` 认 wsl；`getShellEnv`/`getShellConfig` 不为 WSL 改；`killProcessTree:272` 不复用于 WSL |

### 8.2 PiX 层（WSL 实现）

| 文件 | 改动 |
|---|---|
| `pix/src/main/wsl/wsl-paths.ts` | **新增** `WslPathConverter` 纯字符串转换 + distro/home 探测 |
| `pix/src/main/wsl/wsl-distro.ts` | **新增** `WslDistroResolver` UTF-16LE 解析 |
| `pix/src/main/wsl/wsl-bash-operations.ts` | **新增** `WslBashOperations` |
| `pix/src/main/wsl/wsl-file-operations.ts` | **新增** `WslFileOperations` suite |
| `pix/src/main/wsl/wsl-execution-backend.ts` | **新增** `createWslExecutionBackend` 组装 |
| `pix/src/main/session-bridge.ts` | `start(projectDir)` 接收双 cwd（逻辑 Linux + 物理 UNC）；`_assertProjectDirectory:1462` 委托 backend；`_createSession:1283` 对 `SettingsManager`/`ResourceLoader`/`SessionManager` 传 UNC 物理 cwd；按 per-project 环境标记决定构建 WSL backend 还是 local，传给 `createAgentSession` 与 `teamManager.initialize` |
| `pix/src/main/team-manager.ts` | `initialize(cwd,authStorage,executionBackend?):182` 接收并存储 backend；`_launchWorker createAgentSession:794` 与 `_restorePersistedTeamIfPresent:3379` 一律传 `this._executionBackend`；worker bootstrap cwd 走 UNC |
| `pix/src/shared/types.ts` | 增 `WslSettings{enabled;distro;defaultCwd}`；`RpcSessionState` 增 `executionEnvironment?:{kind:'windows'|'wsl';distro?:string}` |
| `pix/src/main/settings-store.ts` + `ipc-handlers.ts` + `preload.ts` | `GuiSettings` 加 `WslSettings`；新增 `list-wsl-distros` IPC（`wsl.exe -l` UTF-16LE 解码）；新增 `get-execution-environment` IPC |
| `pix/src/renderer/pages/SettingsPage.vue` | 加独立 WSL 配置区（v-switch 启用、distro v-select、defaultCwd v-text-field）；清理 `:436` "例如 wsl" hint 指向 WSL 区；项目选择页加 distro 下拉 + Linux 路径文本框（主）+ 原生对话框转 UNC→Linux（辅）；状态栏显示当前环境。**Vuetify 用法先查 `vuetify_guide` 验证** |
| `pix/src/main/background-task-registry.ts` | v2 改造 `start` 接收 backend/operations，`stop` 杀 WSL 内 pgid；**v1 用 `excludedToolNames` 禁用** `run_background`/`read_output`/`stop_process` |

### 8.3 团队一致性

`team-manager.ts:767,795` 当前 worker 用 `this._cwd`（Linux 路径）调 `createAgentSession` 但不传 operations——会落到本地 fs/shell，在 Linux cwd 上完全崩溃。必须让 worker 复用 leader 的 backend。同一团队内执行环境必须一致（leader=WSL, worker=Windows 会导致 worker 产生的命令/路径在 leader 上下文失效），配置错误应告警而非静默崩溃。restore 路径（`:3379`）也须贯穿 backend。

### 8.4 MCP / 扩展工具沉浸边界（新增）

PiX 经 `pi-mcp-adapter` 集成 MCP（`session-bridge.ts:31/1289/1296` `mcpAdapter.register(pi)`），MCP server 作为独立进程在 **Windows 侧** spawn。filesystem 类 MCP 会返回 `C:\` 路径或 `platform=win32`，第一次 MCP 调用即破沉浸——§4.1/§8.1 的注入与改造只覆盖 7 个内建工具 + bash。处理方案（按优先级）：

1. **推荐**：要求 MCP server 在 WSL 内运行（经 `wsl.exe` spawn），使其自报 Linux 环境与 Linux 路径。在 WSL 配置区提供"MCP server 执行环境"选项。
2. **回退**：为 MCP 工具输出加路径回译 shim（拦截 MCP 返回结果，把 `C:\`/UNC 回译为 Linux 路径）--但 MCP 工具输出 schema 多样，回译可行性需评估 `pi-mcp-adapter` 的输出拦截点。
3. **至少**：在文档与设置中声明 MCP 是沉浸边界，给配置指引（哪些 MCP server 适合 WSL 模式）。

MCP 路径回译 shim 与内建工具的错误回译层（§6.9）同构，可复用 `WslPathConverter.windowsToLinux`。

## 9. 分阶段实施计划

### Phase 0 — SDK 注入接缝（generic，无 WSL 代码）

**目标**：在 coding-agent SDK 层打通所有注入接缝，Windows 模式行为字节级不变（`executionBackend=undefined` 走原路径）。这是 WSL 后端的前置条件，单独可测试、可回归。

- 文件改动与合并逻辑见 §8.1。
- 为 `backend=undefined` 路径加 Windows 回归测试（含 grep `--json` 解析、limit 提前杀、context 行、ls 行为）。

### Phase 1 — MVP WSL 后端（`pix/src/main/wsl/`）

**目标**：在 PiX 层实现可用的 WSL 原生命令执行 + 文件操作，覆盖单会话（非 team）主路径。这是用户可见的 MVP。

- 文件改动与合并逻辑见 §8.1/§8.2。
- distro 必须显式设置，session start 用 `wsl.exe -d <distro> -e test -d <linuxCwd>` 校验可达（见 §4.7）。
- 冷启动缓解 v1 即纳入：预热 + keep-alive + spawn 就绪独立超时（见 §5.4）。

### Phase 2 — 一致性与性能

- 团队一致性：worker 复用 leader backend、restore 路径贯穿（见 §8.2/§8.3）。
- fd/rg 探活与缺失回退、Debian/Ubuntu `fd=fdfind` 命名说明（见 §7.5）。
- grep context 行优先用 rg 自带 JSON 上下文行；rg spawn 独立 timeout 与 `/mnt/c` 前缀匹配翻倍（见 §6.5/§7.6）。
- fs.watch 审计（见 §6.7）。
- fd 输出相对化（`find.ts:300-313`）与 `grep.ts:190-192` 的 `formatPath` WSL 模式用 `path.posix`；**`ls.ts:161` 的 `nodePath.join(dirPath, entry)` 改 `path.posix.join`**（`ls.ts` 无 `formatPath`、输出仅 entry 名，但 win32 join 处理 Linux 路径会 mangle 分隔符，传给 `ops.stat` 的路径损坏）。
- 为 `reload()` 与设置变更触发的 `_buildRuntime` 增加测试断言 operations 不丢失；为 `backend=undefined` 加 Windows 快照回归。
- **错误回译不变式测试**：断言 WSL 模式下所有工具结果与错误消息中不得出现 UNC（`\\wsl.localhost`）或 Windows 盘符路径（§6.9 回归不变式）。
- **/mnt/c round-trip 测试**：断言 `WslFileOperations` 对 `/mnt/c/<现存文件>` 操作成功（经 `C:\` 直达），与 bash 工具对同路径行为一致（感知一致性契约）。

### Phase 3 — 增强（非阻断）

- auto-install Linux musl 版 fd/rg 到 WSL 内 `~/.pi/agent/bin`（经 UNC 写入 + `wsl.exe chmod +x`），复用 `tools-manager.ts getAssetName` 的 linux-musl 资产名；实测 chmod +x 经 9P 是否生效。
- v2 统一抽取共享 WSL 包装层，改造 `BackgroundTaskRegistry` 注入 spawner/operations，`stop` 杀 WSL 内 pgid，启用 `run_background`/`read_output`/`stop_process`。
- v2 评估交互式 PTY：`node-pty` + ConPTY 驱动持久 wsl PTY 作为独立工具，不改 bash 工具契约。
- 若冷启动在 agent 工作负载下确成瓶颈，在同一 `BashOperations` 接口下新增持久会话实现（须先在接口加 `getCwd()` 并解决后台命令 marker 问题）。

## 10. 对抗式验证发现的关键缺陷与修订

以下为对抗式验证发现的关键缺陷及本方案吸收的修订，供决策追溯。

### 10.1 双 cwd 表示（integration，critical）

**缺陷**："Linux 路径作为唯一内部 `_cwd`"会使 `SettingsManager.create`（`settings-manager.ts:183`）与 `DefaultResourceLoader`（`resource-loader.ts:207/469/652`）用 win32.resolve 消费 Linux cwd，解析成当前盘符根 `C:\home\...`，导致 WSL 项目的 `.pi/settings.json`、`AGENTS.md`/`CLAUDE.md`、项目级 skills/extensions **全部静默丢失**——这是 `ExecutionBackend` 覆盖不到的 bootstrap 区域。

**修订**：双 cwd 表示（逻辑 Linux + 物理 UNC），bootstrap fs 消费者喂 UNC 物理 cwd，见 §3。

### 10.2 路径解析前置（exec/env，critical）

**缺陷**：`paths.ts:84` `resolvePath` 在 Windows 上是 win32.resolve，`/home/user/proj` + 相对路径 `src/foo.ts` 解析成 `C:\home\user\proj\src\foo.ts`。bash 工具 `echo x > /home/user/foo.txt` 成功后，read 工具读 `/home/user/foo.txt` 经 `resolveToCwd`→`resolvePath` 解析成 `C:\home\user\foo.txt` 读取失败。命令执行与文件工具处于不同路径命名空间，任何"编辑后构建"任务都断裂。`grep.ts:178`/`find.ts:150` 同样经 `resolveToCwd`→`resolvePath`（Windows 上 win32 语义）在调 ops 之前解析，即便 ops 把 rg 路由进 WSL，rg 收到的也是 Windows 路径。

**修订**：路径解析层是所有文件工具的前置条件——`ExecutionBackend.resolvePath` 用 `path.posix`，`PathContext` 穿透到各工具 `resolveToCwd`，见 §4.5/§6.3。

### 10.3 放弃 stderr sentinel cwd 跟踪（exec，refuted×3）

**缺陷**：原设计的 stderr sentinel（`cd <trackedCwd> 2>/dev/null; <cmd>; printf __PI_CWD__$(pwd -P) >&2`，从 stderr 末尾解析）有多个失败场景：(a) 后台命令 `npm run dev &` 使 sentinel 落在 stderr 中段而非末尾；(b) trackedCwd 共享实例在并发命令下 last-write-wins 竞态；(c) `BashOperations` 无 `getCwd()`，agent-session 无法读取 trackedCwd 填系统提示；(d) 与本地固定 cwd 语义不一致，用户从 WSL 切回本地时 cd 突然不持久。

**修订**：去掉 sentinel，每命令固定 `--cd wslProjectPath`，与本地固定 `_cwd` 完全同构，见 §5.2。

### 10.4 双杀顺序（exec，refuted）

**缺陷**：原"先杀 WSL 进程组再杀 wsl.exe"在 VM 冷启动/distro 异常时 kill-spawn 挂起，永远到不了"再杀 wsl.exe"，exec promise 不 resolve，abort 卡死。自称的兜底"wsl.exe 死亡仍能解除 promise"在该顺序下不可达。

**修订**：颠倒顺序——先 `taskkill /F /T` 杀 wsl.exe（立即解除 promise），再异步 best-effort kill-pgid（5s timeout，失败仅记日志），见 §5.3。

### 10.5 系统提示硬编码 win32（exec/env，refuted）

**缺陷**：`_runtimeEnvironmentContext`（`agent-session.ts:1189`）硬编码 `platform: process.platform`（win32）、shell 取自 `getShellConfig(shellPath)`、`cwd=this._cwd`（Windows）。若不注入，`renderEnvironmentContext` 仍渲染 "Operating system: Windows (win32)" + Git Bash，模型发 powershell 与 Windows 路径，正是要避免的失败。

**修订**：`AgentSessionConfig.runtimeEnvironmentOverride` 注入 `platform='linux'`、`shell.kind='wsl'`、cwd=逻辑 Linux cwd，经 `sdk.ts` 转发，见 §4.6/§7.1。

### 10.6 grep ensureTool 死代码（fs，refuted）

**缺陷**：WSL 模式下 distro 内已装 Linux rg，但 Windows rg 未下载（离线/防火墙）时，`grep.ts:172` `ensureTool("rg", true)` 返回 undefined，`:174` 在 `spawnRipgrep`（`:221`）被调用之前就 reject 'ripgrep not available'。设计的 `spawnRipgrep` hook 变成死代码：distro 里明明有 rg，grep 却完全不可用。

**修订**：把 `:172-176` 的 `ensureTool` 调用移进 `!spawnRipgrep` 分支，`spawnRipgrep` 自负 Linux rg 探活，见 §6.5。

### 10.7 distro 必须显式（fs，refuted）

**缺陷**：原设计用 `wsl.exe -e sh -c 'echo $WSL_DISTRO_NAME'` 探测默认 distro。用户有 Ubuntu（默认）和 Debian 两个发行版、项目实际在 Debian 时，探测返回 Ubuntu，所有 UNC 路径变为 `\\wsl.localhost\Ubuntu\...`，若 Ubuntu 恰好也有同路径则静默读写错误 distro 文件，否则 ENOENT。

**修订**：必须显式 `wslDistro` 设置，禁止从默认 distro 推断；session start 用 `wsl.exe -d <distro> -e test -d <linuxCwd>` 校验可达，失败即报错，见 §4.7。

### 10.8 mutation queue symlink 去重（fs，refuted）

**缺陷**：原设计称 edit 在 UNC "与本地同、非回归"，但 `withFileMutationQueue`（`file-mutation-queue.ts:17`）对 Linux 路径 resolve 得幽灵 `C:\` key，realpath 抛 ENOENT 回退幽灵串。两个 team worker 并发 edit 同一 symlink 文件的 symlink 路径与真实路径得不同 key → 不串行 → 并发 read-modify-write 丢失更新。

**修订**：mutation queue key 基于 UNC realpath 去重，见 §6.6。

### 10.9 冷启动非"未来实测"（exec，refuted）

**缺陷**：原设计将冷启动判为"未来实测瓶颈"。实际审批模式下用户对一条命令审批 2 分钟 → WSL2 VM 因 `vmIdleTimeout`（默认 60s）关闭 → 下条命令 wsl.exe spawn 触发冷启动（数秒到 30s+），在 exec 内同步阻塞，叠加 120s 超时可能直接超时返回，用户看到挂起。

**修订**：v1 即纳入冷启动缓解（预热 + keep-alive + progress 报告 + spawn 就绪独立超时），见 §5.4。

### 10.10 shell 改 -c（exec，conditional）

**缺陷**：原 `bash -lc` 加载 `~/.profile`，用户 profile 装载 nvm（200-500ms）或打印 motd/fortune，每条 agent 命令都付此成本并把这些文本写到 stdout，污染上下文。

**修订**：改用 `bash -c`（与本地 `-c` 同构），见 §5.1。

### 10.11 grep hook 签名（integration，refuted）

**缺陷**：原 `runRipgrep?: (args,cwd,env,signal) => Promise<{stdout,exitCode}>` 缓冲式会丢失现有流式 `--json` 解析与 `matchCount>=limit` 提前杀（`grep.ts:287-290`），要么伤本地回归要么伤 WSL 内存。

**修订**：改为 `spawnRipgrep?: (args,cwd,env) => ChildProcess`，复用现有 readline/limit 逻辑，仅换 spawn 目标，见 §6.5。

### 10.12 合并逻辑两处实现（integration，conditional）

**缺陷**：原设计称"合并逻辑集中在 `createToolDefinition`"。实际 `createAllToolDefinitions`（`index.ts:172-182`）直接调各工厂不经 `createToolDefinition`（`:112`），`_buildRuntime` 用的是 `createAllToolDefinitions`，拿不到 backend。

**修订**：`createToolDefinition` 与 `createAllToolDefinitions` 两处均实现 backend→per-tool 合并，显式保留 `autoResizeImages` 等非 ops 字段，见 §8.1。

### 10.13 BackgroundTaskRegistry v1 禁用（exec/integration，conditional）

**缺陷**：`BackgroundTaskRegistry` 是 coding-agent 公共类（CLI 复用），改其构造与 `getShellConfig` 无参调用会影响其他消费者；WSL 后台 spawner 须复制 pgid/双杀逻辑（sentinel 方案已弃用）。

**修订**：v1 用 `excludedToolNames` 禁用 `run_background`/`read_output`/`stop_process`，v2 再统一抽取共享 WSL 包装层，见 §5.6。

### 10.14 /mnt/c 机械映射 EPERM（pathboundary，critical，实测）

**缺陷**：纯字符串机械映射 `/a/b -> \\wsl.localhost\<distro>\a\b` 对 `/mnt/c/Users/foo` 产出 `\\wsl.localhost\<distro>\mnt\c\Users\foo`。实测该路径对 Node `fs` 的 readFile/stat/access/readdir 全部 **EPERM**（errno -4048），而 `C:\Users\foo` 直达 NTFS 可读。后果：agent 在 bash 跑 `cat /mnt/c/...` 成功，调 read 工具读同路径 EPERM 失败，构成"bash 成功/文件工具失败"的反复试错。

**修订**：`/^\/mnt\/([a-zA-Z])\//` 正则分支把单字母盘符映射 `DRIVE:\...` 直达 NTFS，多字母 `/mnt/wsl`、`/mnt/wslg` 不匹配落回 UNC，converter 契约改为可返回 UNC 或盘符路径，见 §4.4/§6.2。

### 10.15 fs 错误泄漏 UNC（perception，high）

**缺陷**：已核实 `read.ts:332-334` 直接 `reject(error)` 原样上抛，Node `fs` 的 ENOENT/EACCES 错误对象天然携带传入的 UNC/盘符路径字符串；`bash.ts:403-404` 仅 append 退出码。系统提示说 cwd 是 `/home/...` 而智能体在错误里看到 `\\wsl.localhost` UNC，会误改用 UNC 进一步混乱——单向沉浸（§0）在输出侧断裂。

**修订**：错误回译层在 `WslFileOperations` 边界统一包裹 fs 调用，错误消息中 UNC/盘符路径回译为 Linux posix 再上抛；回归不变式：工具结果与错误消息中不得出现 UNC 或 Windows 路径，见 §6.9。

### 10.16 无错误反馈设计（prompt，high）

**缺陷**："错误不可理解导致反复试错"的根因未解决：原设计只有 spawn/cwd/进程管理/冷启动与静态提示词要点，无 stderr 增强或工具错误包装设计。

**修订**：新增 §6.9 工具错误反馈设计——可操作错误反馈（文件工具转换前 guard 拒绝 `C:\`/UNC 并附引导、bash best-effort 扫描 Windows 路径 token）+ 路径校验层（层级/拒绝输入/错误文案/bash 软约束不对称声明），见 §6.9。

### 10.17 MCP 破沉浸（perception，medium）

**缺陷**：PiX 经 `pi-mcp-adapter` 集成 MCP（`session-bridge.ts:1289/1296`），MCP server 在 Windows 侧 spawn，filesystem 类 MCP 返回 `C:\` 路径或 `platform=win32`，第一次 MCP 调用即破沉浸；注入与改造只覆盖 7 个内建工具 + bash，MCP 输出未纳入沉浸边界。

**修订**：新增 §8.4 MCP 沉浸边界——推荐 MCP server 在 WSL 内运行，回退为输出加路径回译 shim（复用 `windowsToLinux`），至少文档声明边界与配置指引，见 §8.4。

### 10.18 ls.ts:161 win32 join（perception，medium）

**缺陷**：已核实 `ls.ts:161` `nodePath.join(dirPath, entry)` 在 Windows 上是 win32.join，对 Linux 路径 `/home/user/proj` 会 mangle 分隔符，传给 `ops.stat` 的路径损坏。ls 无 `formatPath`、输出仅 entry 名，join 点不受 `resolvePath` 注入覆盖。

**修订**：`ls.ts:161` 改 `path.posix.join`，见 §9 Phase 2。

## 11. 残留风险与开放问题

### 残留风险

1. **9P 协议延迟**：UNC 文件 IO 每次 few ms，单文件 ops 可接受；ls 大目录（node_modules）与 grep context>0 上下文行读取仍可能慢。缓解已纳入，极端大目录需实测。
2. **冷启动不可消除**：`vmIdleTimeout` + 审批模式下 VM 关闭后首命令冷启动数秒到 30s+。预热/keep-alive/progress 报告缓解但非根除。
3. **进程清理竞态**：先杀 wsl.exe 再异步杀 pgid 期间，WSL 内 Linux 进程理论上仍以孤儿态运行（best-effort）；极少数 distro 异常时 kill-pgid 失败，Linux 侧残留进程继续占 CPU/端口。
4. **distro 切换需 newSession**：backend 在会话生命周期内不可变，会话中切换 distro 必须重启会话（UX 摩擦）。
5. **路径卫生双防线**：模型仍可能把 `C:\` 或 `\\wsl.localhost\...` 写进 bash 命令导致原生 Linux shell 解析失败。路径校验层已设计（§6.9），文件工具为硬约束 guard，bash 命令内容校验仍为 best-effort 软约束。
6. **grep.ts 改动触及核心搜索路径**：`spawnRipgrep` hook 须保证 Windows 模式未注入时行为字节级不变，回归测试是硬要求。
7. **UNC 上 canonicalizePath/realpathSync 对 WSL 符号链接行为未实测**：指向 `/proc`、`/dev` 或绝对 Linux 目标的链接可能解析失败，影响 edit 锚点哈希与 mutation queue 去重。
8. **fd/fdfind 命名差异**：Debian/Ubuntu apt 装 fd-find 提供 `fdfind` 而非 `fd`，模型调 `fd` 报 command not found。需文档 alias 或 `commandPrefix` 处理。
9. **团队模式 worker 一致性强制**：不支持混合环境（leader Windows + worker WSL），配置错误应告警而非静默崩溃；restore 路径贯穿 backend 需测试。
10. **MCP 沉浸边界**：MCP server 默认在 Windows 侧运行会返回 Windows 路径破沉浸（§8.4），回译 shim 对 schema 多样的 MCP 输出可行性未验证。

### 开放问题

1. `paths.ts` `resolvePath`/`normalizePath` 被 `SettingsManager`/`ResourceLoader`/`file-mutation-queue` 等大量非工具代码共享——给它们加 `posix` 选项是否会误伤？需审计所有 `resolvePath` 调用点，确认 bootstrap 消费者走 UNC 物理路径而非依赖 posix 语义。
2. `canonicalizePath`（`paths.ts:28` realpathSync）在 UNC 上对 WSL 符号链接的具体行为需实测：指向 `/proc`、`/dev`、绝对 Linux 目标的链接在 UNC 下是解析失败还是落到错误 Windows 路径？
3. fs.watch 审计：`pix/src/main` 是否有 chokidar/fs.watch 监听项目目录（非智能体工具）会在 9P 上失效？需扫描全仓 watch 用点逐个评估。
4. WSL2 9P 的 `readdir(withFileTypes)` 在目标 Win11 build 上是否返回填充的 d_type？若 DT_UNKNOWN，ls 回退逐条 lstat——需实测。
5. per-project `.pix/environment.json` 存在 Linux 路径，读它须先转 UNC，而转 UNC 需 distro——distro 可能正写在该 marker 里。用全局 defaultDistro 读 marker、marker 内 distro 仅用于后续会话的 bootstrap 顺序是否可接受？改 distro 触发 newSession 的 UX 是否合理？
6. team 多 worker 场景：每个 worker `AgentSession` 是否各自独立 WSL ops 实例？`PathContext` 按 session 隔离是否足够？team-leader/worker 的 `_cwd` 共享（`team-manager.ts:767`）需确认 worker 不会因共享 cwd 而共享 PathContext 状态。
7. WSL 内若缺 rg/fd，v2 经 UNC 把 Linux musl 版二进制下载到 WSL `~/.pi/agent/bin` 再经 wsl.exe 调用是否可靠？chmod +x 经 9P 是否生效？
8. bash 交互式命令（vim/ssh/交互确认）v1 因 stdin ignore 无 PTY 挂起。v2 引入 node-pty+ConPTY 驱动持久 wsl PTY 作为独立工具的可行性与契约设计？
9. settings 变更（会话中切换 distro）应触发 `reloadRuntime` 还是强制 newSession？倾向强制 newSession（backend 在会话生命周期内不可变），但需确认 `_applyPiSetting` 对 wsl 字段的处理。
10. fs 错误回译层应放在 `WslFileOperations`（per-method wrap）还是共享 helper？需审计 read/write/edit/ls 中所有自构错误消息的路径来源以确认覆盖完整。
11. MCP 沉浸：路径回译 shim 在 MCP 工具输出 schema 多样的前提下是否可行，还是必须要求 MCP server 在 WSL 内运行？需评估 `pi-mcp-adapter` 的输出拦截点。
12. `ls.ts:161` `nodePath.join` 改 `path.posix.join` 是否需要 PathContext 传播到 ls（已计划的 `resolvePath` 注入是另一接缝，join 点与之分离）？
13. `/mnt/<盘符>` 正则分支产出 `C:\` 盘符路径后，grep context>0 的 `getFileLines`、mutation queue key、`canonicalizePath` 等下游逻辑是否都兼容"UNC 或盘符路径"双形态？需逐点验证。

## 12. 与 Claude-Code / codex 对比

### 与 Claude-Code（TS，跑在 WSL 内 + Win↔WSL 混合）

| 维度 | Claude-Code | 本方案 | 取舍 |
|---|---|---|---|
| 架构 | claude 进程跑在 WSL 内 | PiX 留在 Windows，宿主桥接 | PiX 是 Electron GUI 不能整体进 WSL |
| 路径转换 | `WindowsToWSLConverter` 调 `wslpath -u/-w`，fallback 手写 | 纯字符串 O(1)：ext4->UNC、`/mnt/<盘符>`->`DRIVE:\`，`wslpath` 仅回退 | `wslpath` 每次 50ms 不进热路径；`/mnt/c` 经 UNC 是 EPERM 须盘符分流（§10.14）|
| shell | spawn 无 PTY，bash/zsh | spawn 无 PTY，自定义 `BashOperations` 绕开 `getShellConfig` | WSL 走独立 ops，Claude-Code 在 WSL 内直接 spawn bash |
| WSL_INTEROP pin | tmux 嵌套 wsl.exe 特设 | 不需要 | 本方案单次 `wsl.exe -e bash -c` 无嵌套 interop |
| 进程清理 | tmux 会话路由 | `setsid` 起 pgid + `kill -KILL -<pgid>` | 不引入 tmux 依赖，换取实现简单 |
| 性能特判 | rg 超时翻倍 | grep rg 加独立 timeout，路径分类翻倍 | 主场景原生 ext4 保持默认 |
| 沙箱 | WSL2 bubblewrap | 不引入 | PiX 智能体用户级信任 |

### 与 codex（Rust，原生 Linux 跑 WSL 内，不调 wsl.exe）

| 维度 | codex | 本方案 | 取舍 |
|---|---|---|---|
| 架构 | WSL 当"远程环境"后端，`ExecRequest` 统一载体，`SandboxManager::transform` 包装 | `ExecutionBackend` 与此同构 | PiX 是 Windows 宿主必须经 wsl.exe，codex 在 WSL 内原生跑不调 wsl.exe |
| 路径校验 | `PathUri` 跨边界校验（ForeignPath） | `PathContext` 显式绑定 + `assertProjectDirectory` 校验 | 禁止跨 distro 路径混用 |
| 路径转换 | `win_path_to_wsl` 纯字符串 `C:\→/mnt/c` | Linux↔UNC 纯字符串 | 方向不同（用户场景是 Linux fs） |
| 执行路径 | shell 工具（无 PTY）+ `unified_exec`（PTY） | v1 只做无 PTY 管道，v2 评估 PTY | codex `codex_utils_pty` 重，本方案 v2 倾向 node-pty+ConPTY |

### 共同取舍

三者都不维持长驻 bash 会话做命令持久（codex `ExecRequest` 每次独立，Claude-Code spawn），本方案每命令独立 spawn 与两者一致（§2.3）。本方案独有硬约束：PiX 在 Windows 不能整体进 WSL，故经 UNC 做 IO（codex/Claude-Code 在 WSL 内直接用原生 fs），代价是 9P 延迟，用 `readdirWithTypes` + `wsl mkdir -p` + 原生 fd/rg 搜索缓解（§6.1）。

## 附录：关键文件与行号索引

### PiX 主进程
- `pix/src/main/session-bridge.ts:173`（`_cwd`）、`:1462`（`_assertProjectDirectory`）、`:1283`（`_createSession`）、`:1302`（`createAgentSession`）
- `pix/src/main/team-manager.ts:182`（`initialize`）、`:794`（`_launchWorker createAgentSession`）、`:3379`（`_restorePersistedTeamIfPresent`）、`:767`（worker `_cwd` 共享）
- `pix/src/main/settings-store.ts`、`pix/src/main/ipc-handlers.ts`、`pix/src/shared/types.ts`

### 编码代理核心（命令执行）
- `packages/coding-agent/src/core/tools/bash.ts:41`（`BashOperations` 接口）、`:67`（`createLocalBashOperations`）、`:137`（`BashSpawnHook`）
- `packages/coding-agent/src/core/bash-executor.ts:50`（`executeBashWithOperations`）
- `packages/coding-agent/src/core/background-task-registry.ts:26`（`start`）、`:153`（`stop`）
- `packages/coding-agent/src/utils/shell.ts:139`（`getShellConfig`）、`:194`（`getShellEnv`）、`:272`（`killProcessTree`）、`:11`（`isPosixLikeShell`）
- `packages/coding-agent/src/utils/child-process.ts:18`（`spawnProcess`）

### 编码代理核心（工具与路径）
- `packages/coding-agent/src/core/agent-session.ts:3056`（`_buildRuntime`）、`:3071-3074`（注入缺口）、`:3110`（`reload`；`:3116` 为其内 `_buildRuntime` 调用点）、`:3254`（`executeBash`）、`:3270`（operations 兜底）、`:1189`（`_runtimeEnvironmentContext`）、`:1214`（`_rebuildSystemPrompt`）
- `packages/coding-agent/src/core/tools/index.ts:102-110`（`ToolsOptions`）、`:112`（`createToolDefinition`）、`:172-182`（`createAllToolDefinitions`）
- `packages/coding-agent/src/core/tools/{read,write,edit,find,grep,ls}.ts`（各 Operations 接口）
- `packages/coding-agent/src/core/tools/grep.ts:172`（`ensureTool('rg')`）、`:201`（`getFileLines`）、`:221`（rg spawn）、`:287-290`（limit 提前杀）
- `packages/coding-agent/src/core/tools/ls.ts:164-168`（stat 循环）
- `packages/coding-agent/src/core/tools/find.ts:155`（`customOps?.glob`）、`:300-313`（fd 输出相对化内联）
- `packages/coding-agent/src/core/tools/path-utils.ts:48`（`resolveToCwd`）、`:59-81`（macOS 变体）
- `packages/coding-agent/src/utils/paths.ts:81`（`resolvePath`）、`:28`（`canonicalizePath`）、`:57`（`normalizePath`）
- `packages/coding-agent/src/core/tools/file-mutation-queue.ts:17`（`getMutationQueueKey`）
- `packages/coding-agent/src/core/tools/render-utils.ts:10`（`shortenPath`）、`:19`（`linkPath`）
- `packages/coding-agent/src/core/system-prompt.ts:29`（`RuntimeEnvironmentContext`）、`:38`（`shell.kind`）、`:126`（`shellKindFromPath`）、`:140`（`renderEnvironmentContext`）、`:427-428`（editing_contract Windows 文本）
- `packages/coding-agent/src/core/sdk.ts:35`（`CreateAgentSessionOptions`）、`:415-431`（`createAgentSession`）
- `packages/coding-agent/src/core/settings-manager.ts:805`（`shellPath`）、`:825`（`shellCommandPrefix`）、`:183`（`create` resolvePath）
- `packages/coding-agent/src/utils/tools-manager.ts:245`（platform-gated 二进制）、`:63`（linux-musl 资产名）

### 参考实现
- `../Claude-Code/src/utils/idePathConversion.ts:25`（`WindowsToWSLConverter`，`wslpath -u/-w`）
- `../Claude-Code/src/utils/tmuxSocket.ts:39`（tmux 路由 wsl，`WSL_INTEROP` pin）
- `../Claude-Code/src/utils/ripgrep.ts:130`（WSL 超时翻倍）
- `../Claude-Code/src/utils/platform.ts:11`（`getPlatform`/`getWslVersion`）
- `../codex/codex-rs/core/src/sandboxing/mod.rs:45`（`ExecRequest`）
- `../codex/codex-rs/core/src/unified_exec/process_manager.rs:1106`（`spawn_process`）
- `../codex/codex-rs/cli/src/wsl_paths.rs:8`（`win_path_to_wsl` 纯字符串）
