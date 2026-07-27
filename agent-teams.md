# Claude Code Agent Teams (Swarm) 技术实现深度剖析

## 1. 概述

Agent Teams（又称 Swarm）是 Claude Code 中一项允许**多个独立的 Claude Code 实例组建团队并相互协作**的功能。这与普通的 subagent（子代理）有本质区别：

| 特性 | Subagent | Agent Teams |
|------|----------|-------------|
| 生命周期 | 随父任务结束而终止 | 独立运行，可持续接收新任务 |
| 身份标识 | 无持久身份 | 有唯一 `agentName@teamName` 标识 |
| 通信方式 | 通过返回值向父任务汇报 | 通过文件系统邮箱点对点通信 |
| 执行模型 | 一次性的"发射并遗忘" | 持续循环：执行 → 空闲 → 等待新任务 |
| 可见性 | 作为子任务嵌入父上下文 | 在 UI 中独立展示（可缩放查看对话） |

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Team Leader (主会话)                      │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ TeamCreateTool│  │SendMessageTool│  │  useInboxPoller   │  │
│  └──────────────┘  └──────────────┘  └───────────────────┘  │
│         │                  │                    │            │
│         ▼                  ▼                    ▼            │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              AppState.teamContext                    │    │
│  │  { teamName, leadAgentId, teammates: {...} }        │    │
│  └─────────────────────────────────────────────────────┘    │
│         │                                                    │
└─────────┼────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│           文件系统层 (~/.claude/teams/{team-name}/)          │
│  ┌────────────┐  ┌─────────────────┐  ┌──────────────────┐ │
│  │ config.json │  │ inboxes/*.json  │  │ permissions/     │ │
│  │  (团队文件)  │  │   (邮箱系统)     │  │  (权限同步)      │ │
│  └────────────┘  └─────────────────┘  └──────────────────┘ │
└─────────────────────────────────────────────────────────────┘
          │                    │                    │
          ▼                    ▼                    ▼
┌────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Teammate A     │  │ Teammate B      │  │ Teammate C      │
│ (in-process)   │  │ (tmux pane)     │  │ (iTerm2 pane)   │
│ AsyncLocalStorage│ │ 独立进程        │  │ 独立进程        │
└────────────────┘  └─────────────────┘  └─────────────────┘
```

### 2.1 核心组件

Agent Teams 由以下核心组件构成：

1. **团队文件 (TeamFile)** — 存储团队元数据和成员列表
2. **邮箱系统 (TeammateMailbox)** — 基于文件的点对点消息传递
3. **任务系统 (TaskList)** — 共享的待办事项列表
4. **后端执行器 (TeammateExecutor)** — 抽象化的 teammate 执行引擎
5. **收件箱轮询器 (useInboxPoller)** — React Hook，驱动消息消费
6. **权限同步 (PermissionSync)** — 跨 agent 的工具权限协调
7. **InProcessRunner** — 进程内 teammate 的 agent 循环

## 3. 团队文件 (TeamFile)

### 3.1 存储位置

```
~/.claude/teams/{team-name}/config.json
```

路径由 `getTeamFilePath()` 生成，团队名经过 `sanitizeName()` 处理（非字母数字字符替换为连字符并小写）。注意：邮箱文件路径使用的是 `sanitizePathComponent()`（允许下划线），与团队目录的 `sanitizeName()` 略有不同。

### 3.2 数据结构

```typescript
type TeamFile = {
  name: string                    // 团队名称
  description?: string            // 团队描述
  createdAt: number               // 创建时间戳
  leadAgentId: string             // 领导者 agent ID (格式: "team-lead@{teamName}")
  leadSessionId?: string          // 领导者会话 UUID（用于团队发现）
  hiddenPaneIds?: string[]        // 当前隐藏的面板 ID 列表
  teamAllowedPaths?: TeamAllowedPath[] // 全团队允许编辑的路径
  members: Array<{
    agentId: string               // 唯一标识 "agentName@teamName"
    name: string                  // 显示名称
    agentType?: string            // 角色类型
    model?: string                // 使用的模型
    prompt?: string               // 初始提示词
    color?: string                // UI 颜色
    planModeRequired?: boolean    // 是否需要计划模式审批
    joinedAt: number              // 加入时间
    tmuxPaneId: string            // tmux 面板 ID
    cwd: string                   // 工作目录
    worktreePath?: string         // git worktree 路径
    sessionId?: string            // 会话 UUID
    subscriptions: string[]       // 订阅的消息频道
    backendType?: BackendType     // 后端类型 ('tmux' | 'iterm2' | 'in-process')
    isActive?: boolean            // 是否活跃（false = 空闲）
    mode?: PermissionMode         // 当前权限模式
  }>
}
```

### 3.3 团队文件的创建与销毁

**创建流程** (`TeamCreateTool.call()`):

```
1. 检查是否已有团队（一个 leader 只能管理一个团队）
2. 生成唯一团队名（如已存在则用 generateWordSlug()）
3. 生成 leadAgentId = "team-lead@{teamName}"
4. 构造 TeamFile 对象（初始成员只有 leader 自己）
5. 写入 ~/.claude/teams/{teamName}/config.json
6. 注册到 session cleanup 集合（防止会话退出后残留）
7. 调用 resetTaskList() 清空旧任务 + ensureTasksDir() 创建目录（确保编号从 1 开始）
8. 调用 setLeaderTeamName() 注册 leader 的团队名（使 getTaskListId() 能正确返回团队名）
9. 更新 AppState.teamContext（含 leader 的 name、agentType、color、tmuxSessionName 等）
```

**销毁流程** (`TeamDeleteTool.call()`):

```
1. 检查是否有活跃的非 leader 成员（有则拒绝删除）
2. cleanupTeamDirectories() 内部流程：
   a. 读取团队文件收集 worktree 路径
   b. 先清理 git worktree（需要团队文件来发现路径，所以必须在删除目录之前）
   c. 再清理团队目录（~/.claude/teams/{teamName}/）
   d. 最后清理任务目录（~/.claude/tasks/{taskListId}/）
3. 从 session cleanup 集合中注销
4. 清除颜色分配和 leader team name
5. 清空 AppState.teamContext 和 inbox
```

## 4. 邮箱系统 (TeammateMailbox)

邮箱系统是 Agent Teams 最核心的通信基础设施。它是一个**基于文件系统的持久化消息队列**。

### 4.1 存储结构

```
~/.claude/teams/{team-name}/inboxes/
  ├── team-lead.json      # leader 的收件箱
  ├── researcher.json     # researcher teammate 的收件箱
  ├── tester.json         # tester teammate 的收件箱
  └── ...
```

每个收件箱文件是一个 JSON 数组：

```typescript
type TeammateMessage = {
  from: string           // 发送者名称
  text: string           // 消息内容（纯文本或 JSON 序列化的结构化消息）
  timestamp: string      // ISO 时间戳
  read: boolean          // 是否已读
  color?: string         // 发送者的 UI 颜色
  summary?: string       // 5-10 字摘要（UI 预览用）
}
```

### 4.2 读写操作

**写入** (`writeToMailbox`):
```
1. 确保 inbox 目录存在
2. 如果收件箱文件不存在，创建空数组 []
3. 获取文件锁（proper-lockfile，带重试和退避）
4. 重新读取最新消息（防止并发覆盖）
5. 追加新消息（read: false）
6. 写回文件
7. 释放锁
```

**读取** (`readMailbox` / `readUnreadMessages`):
```
1. 读取收件箱文件
2. 解析 JSON
3. 过滤未读消息（readUnreadMessages）
```

**标记已读** (`markMessageAsReadByIndex` / `markMessagesAsRead`):
```
1. 获取文件锁
2. 重新读取最新消息
3. 修改目标消息的 read 标志
4. 写回文件
5. 释放锁
```

### 4.3 并发安全

大部分邮箱写操作使用 `proper-lockfile` 库实现文件锁（`clearMailbox()` 是例外，它直接写入空数组而不加锁，存在并发竞态风险）：

```typescript
const LOCK_OPTIONS = {
  retries: {
    retries: 10,        // 最多重试 10 次
    minTimeout: 5,      // 最小等待 5ms
    maxTimeout: 100,    // 最大等待 100ms
  },
}
```

这确保了当多个 agent 并发写入同一收件箱时不会产生竞态条件。

### 4.4 消息类型

邮箱系统承载多种消息类型。需要注意的是，关闭协议存在**两层消息格式**：

**SendMessage 工具层（LLM 发送的线格式）**：

```typescript
// SendMessageTool.ts 中的 StructuredMessage schema
type StructuredMessage =
  | { type: 'shutdown_request', reason?: string }
  | { type: 'shutdown_response', request_id: string, approve: boolean, reason?: string }
  | { type: 'plan_approval_response', request_id: string, approve: boolean, feedback?: string }
```

LLM 通过 SendMessage 工具发送 `shutdown_response`，由 `approve` 布尔值决定批准或拒绝。

**邮箱系统层（内部存储格式）**：

`SendMessageTool` 的处理函数将 `shutdown_response` 拆分为两种不同的邮箱消息：

| 消息类型 | 方向 | 用途 |
|---------|------|------|
| 纯文本消息 | 任意方向 | 一般通信 |
| `permission_request` | Worker → Leader | 工具权限请求 |
| `permission_response` | Leader → Worker | 权限审批结果 |
| `sandbox_permission_request` | Worker → Leader | 网络访问权限请求（沙箱出口规则） |
| `sandbox_permission_response` | Leader → Worker | 网络访问审批结果 |
| `shutdown_request` | Leader → Teammate | 关闭请求 |
| `shutdown_approved` | Teammate → Leader | 确认关闭（由 `shutdown_response(approve: true)` 转换） |
| `shutdown_rejected` | Teammate → Leader | 拒绝关闭（由 `shutdown_response(approve: false)` 转换） |
| `task_assignment` | Leader → Teammate | 任务分配通知 |
| `team_permission_update` | Leader → All | 权限规则广播 |
| `mode_set_request` | Leader → Teammate | 权限模式变更 |
| `plan_approval_request` | Teammate → Leader | 计划审批请求（系统自动生成，非 LLM 发送） |
| `plan_approval_response` | Leader → Teammate | 计划审批结果 |
| `idle_notification` | Teammate → Leader | 空闲状态通知 |

**消息转换流程**（以关闭为例）：

```
LLM 发送: SendMessage({ to: "teammate", message: { type: "shutdown_response", approve: true, request_id: "..." } })
  → SendMessageTool.handleShutdownApproval()
    → 写入 leader 邮箱: { type: "shutdown_approved", requestId, from, timestamp, paneId, backendType }
    → 写入 teammate 自身: abortController.abort()
```

结构化消息通过 `isStructuredProtocolMessage()` 识别（包含以上 10 种协议类型：`permission_request`、`permission_response`、`sandbox_permission_request`、`sandbox_permission_response`、`shutdown_request`、`shutdown_approved`、`team_permission_update`、`mode_set_request`、`plan_approval_request`、`plan_approval_response`），这些消息会被路由到专用处理器，而不会作为原始文本注入到 LLM 上下文中。注意：`shutdown_rejected`、`idle_notification`、`task_assignment` 未被纳入此守卫函数，会作为普通消息传递。

**读取不加锁**：`readMailbox()` 直接读取文件而不获取文件锁，只有写操作使用 `proper-lockfile`。这是一个有意的设计权衡——读取可能看到略微过时的数据，但避免了读操作的锁开销。

## 5. 消息发送工具 (SendMessageTool)

`SendMessageTool` 是 agent 发送消息的统一入口，实现了多种路由逻辑：

### 5.1 消息路由决策树

跨会话路由（`bridge:*` 和 `uds:*`）受 `feature('UDS_INBOX')` feature flag 控制，仅在启用时生效。

`shutdown_response` 和 `plan_approval_response` 的 `approve` 字段使用 `semanticBoolean()` 验证器，可接受布尔值和字符串 `"true"`/`"false"`。

```
SendMessage(to, message)
  │
  ├── [UDS_INBOX enabled] to = "bridge:*" → 远程控制桥接（跨机器）
  │
  ├── [UDS_INBOX enabled] to = "uds:*" → Unix Domain Socket（本地跨进程）
  │
  ├── message 是纯文本
  │   ├── to = "*" → handleBroadcast()（遍历 teamFile.members，跳过发送者自己）
  │   ├── to 匹配已注册的 in-process agent → queuePendingMessage() 或 resumeAgentBackground()
  │   └── 其他 → handleMessage()（写入收件箱）
  │
  └── message 是结构化对象（StructuredMessage schema）
      ├── shutdown_request
      │   → handleShutdownRequest()
      │     → 写入 target 邮箱: ShutdownRequestMessage
      │     → 返回 request_id
      │
      ├── shutdown_response (approve = true)
      │   → handleShutdownApproval()
      │     → 读取 teammate 的 paneId/backendType
      │     → 写入 leader 邮箱: ShutdownApprovedMessage
      │     → in-process: abortController.abort()
      │     → tmux: gracefulShutdown(0)
      │
      ├── shutdown_response (approve = false)
      │   → handleShutdownRejection()
      │     → 写入 leader 邮箱: ShutdownRejectedMessage
      │     → 返回 "Shutdown rejected. Continuing to work."
      │
      ├── plan_approval_response (approve = true)
      │   → handlePlanApproval()
      │
      └── plan_approval_response (approve = false)
          → handlePlanRejection()
```

**注意**：`plan_approval_request` 不是通过 SendMessage 工具发送的，而是由系统（ExitPlanMode 工具）自动生成并写入 leader 邮箱。Leader 的 `useInboxPoller` 自动审批后将 `plan_approval_response` 写回 teammate 邮箱。

### 5.2 广播机制

当 `to = "*"` 时，`handleBroadcast()` 执行：

```typescript
async function handleBroadcast(content, summary, context) {
  const teamFile = await readTeamFileAsync(teamName)
  // 遍历所有成员，跳过发送者自己
  for (const member of teamFile.members) {
    if (member.name === senderName) continue
    await writeToMailbox(member.name, { from, text, ... }, teamName)
  }
}
```

### 5.3 In-Process Agent 直连

当收件人是一个正在运行的 in-process agent 时，消息不经过文件系统，而是直接通过内存队列传递：

```typescript
if (isLocalAgentTask(task) && !isMainSessionTask(task)) {
  if (task.status === 'running') {
    queuePendingMessage(agentId, message, setAppState)
    return { success: true, message: `Message queued for delivery...` }
  }
  // agent 已停止 → 自动恢复
  const result = await resumeAgentBackground({ agentId, prompt: message, ... })
}
```

## 6. 后端执行器 (TeammateExecutor)

Agent Teams 支持三种执行后端，通过统一的 `TeammateExecutor` 接口抽象：

### 6.1 后端类型

```typescript
type BackendType = 'tmux' | 'iterm2' | 'in-process'
```

| 后端 | 执行方式 | 隔离级别 | 可视化 |
|------|---------|---------|--------|
| `tmux` | 独立进程，tmux 面板 | 进程级 | tmux 分屏 |
| `iterm2` | 独立进程，iTerm2 原生面板 | 进程级 | iTerm2 分屏 |
| `in-process` | 同进程，AsyncLocalStorage | 上下文级 | UI 内嵌 |

### 6.2 后端检测与 Spawn 路由

`spawnMultiAgent.ts` 中的 `handleSpawn()` 是统一的 spawn 路由入口，支持三种 spawn 处理器：

```
handleSpawn(input, context)
  │
  ├── 1. isInProcessEnabled() = true → handleSpawnInProcess()
  │
  ├── 2. detectAndGetBackend() 成功（面板后端可用）
  │   ├── use_splitpane = true（默认）→ handleSpawnSplitPane()
  │   └── use_splitpane = false → handleSpawnSeparateWindow()
  │
  └── 3. detectAndGetBackend() 失败 + teammateMode = 'auto'
      → markInProcessFallback()
      → handleSpawnInProcess()（静默回退）
```

**三种 Spawn 处理器对比**：

| 处理器 | 执行方式 | 隔离级别 | 可视化 |
|-------|---------|---------|--------|
| `handleSpawnSplitPane` | tmux/iTerm2 分屏，共享同一窗口 | 进程级 | 分屏视图 |
| `handleSpawnSeparateWindow` | 独立 tmux 窗口（`tmux new-window`） | 进程级 | 独立窗口 |
| `handleSpawnInProcess` | 同进程 AsyncLocalStorage | 上下文级 | UI 内嵌 |

**`handleSpawnSeparateWindow` 与 `handleSpawnSplitPane` 的区别**：

注意：这两个是**完全不同的代码路径**，不仅仅是 `use_splitpane` 布尔值的区别。

- `SplitPane`（line 305-539）使用检测到的后端抽象（tmux 或 iTerm2），支持 iTerm2 的 it2 CLI 安装提示 UI；`SeparateWindow`（line 545-753）始终直接使用 tmux
- `SplitPane` 在同一窗口内创建面板；`SeparateWindow` 在 `claude-swarm` session 中通过 `tmux new-window` 创建新窗口
- `SeparateWindow` 通过 `tmux send-keys` 直接发送命令；`SplitPane` 通过 `backend.sendCommandToPane()` 发送
- `SeparateWindow` 始终设置 `backendType: 'tmux'`；`SplitPane` 可能设置 `'tmux'` 或 `'iterm2'`

`registry.ts` 中的 `detectAndGetBackend()` 按优先级选择（结果会被缓存，进程生命周期内固定）：

```
1. 如果在 tmux 中 → 使用 tmux（即使在 iTerm2 内也优先 tmux）
2. 如果在 iTerm2 中：
   a. 用户设置了 preferTmuxOverIterm2 → 跳过 iTerm2，走 tmux
   b. it2 CLI 可用 → 使用 iTerm2
   c. it2 CLI 不可用 + tmux 可用 → 使用 tmux（标记 needsIt2Setup）
   d. 都不可用 → 抛出错误
3. 不在 tmux/iTerm2 中 + tmux 可用 → 使用 tmux（外部会话模式）
4. 都不可用 → 抛出安装指引错误
```

`isInProcessEnabled()` 的判断逻辑：

```typescript
function isInProcessEnabled(): boolean {
  // 非交互式会话（-p 模式）强制使用 in-process
  if (getIsNonInteractiveSession()) return true

  const mode = getTeammateMode() // 'auto' | 'tmux' | 'in-process'
  if (mode === 'in-process') return true
  if (mode === 'tmux') return false
  // 'auto' 模式：如果之前因无面板后端回退到 in-process，则保持
  if (inProcessFallbackActive) return true
  // 检测环境：不在 tmux 且不在 iTerm2 → 使用 in-process
  return !isInsideTmuxSync() && !isInITerm2()
}
```

### 6.3 TeammateExecutor 统一接口

```typescript
type TeammateExecutor = {
  readonly type: BackendType
  isAvailable(): Promise<boolean>
  spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult>
  sendMessage(agentId: string, message: TeammateMessage): Promise<void>
  terminate(agentId: string, reason?: string): Promise<boolean>
  kill(agentId: string): Promise<boolean>
  isActive(agentId: string): Promise<boolean>
}
```

### 6.4 PaneBackendExecutor（面板后端适配器）

`PaneBackendExecutor` 将 `PaneBackend`（底层面板操作）适配为 `TeammateExecutor` 接口。其 `spawn()` 流程：

```
1. 分配颜色 → assignTeammateColor(agentId)
2. 创建面板 → backend.createTeammatePaneInSwarmView()
3. 构建 CLI 命令：
   - teammate 身份参数：--agent-id, --agent-name, --team-name, --agent-color, --parent-session-id
   - 可选参数：--plan-mode-required（计划模式）, --agent-type（角色类型）
   - 继承的 CLI 标志：--dangerously-skip-permissions, --permission-mode, --model, --settings, --plugin-dir, --teammate-mode, --chrome/--no-chrome
   - 环境变量：CLAUDECODE=1, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1, 以及条件转发的 API provider/代理/证书等环境变量
4. 在面板中执行命令
5. 通过邮箱发送初始 prompt
```

### 6.5 InProcessBackend（进程内后端）

`InProcessBackend` 在同一 Node.js 进程中运行 teammate：

```
1. spawnInProcessTeammate():
   - 生成 agentId = formatAgentId(name, teamName)
   - 创建独立的 AbortController（不与 leader 关联）
   - 创建 TeammateContext（用于 AsyncLocalStorage）
   - 注册 InProcessTeammateTaskState 到 AppState.tasks
2. startInProcessTeammate():
   - 启动 runInProcessTeammate() 的 fire-and-forget 执行
3. runInProcessTeammate():
   - 在 runWithTeammateContext() 中执行 agent 循环
   - 使用 runAgent()（与 AgentTool/subagent 共享核心 API 基础设施）
   - 每轮结束后进入空闲等待循环
```

## 7. 进程内 Teammate 的 Agent 循环 (InProcessRunner)

`inProcessRunner.ts` 实现了进程内 teammate 的核心生命周期，这是整个系统中最复杂的部分。

### 7.1 生命周期状态机

```
         spawn()
           │
           ▼
    ┌──────────────┐
    │   Running     │◄──────────────────────┐
    │  (执行 prompt) │◄──────────┐           │
    └──────┬───────┘           │           │
           │ 执行完成           │           │
           ▼                   │           │
    ┌──────────────┐           │ 收到新消息  │
    │    Idle       │───────────┘───────────┘
    │  (等待消息)    │
    └──────┬───────┘
           │ 收到 shutdown_request
           ▼
    ┌──────────────┐
    │  模型决策      │
    │ approve/reject│
    └──┬───────┬───┘
       │       │
  approve   reject → 回到 Running 继续工作
       │       (发送 shutdown_rejected 到 leader 邮箱)
       ▼
    ┌──────────────┐
    │  Completed    │
    └──────────────┘
```

### 7.2 主循环实现

```typescript
async function runInProcessTeammate(config) {
  // 1. 构建系统提示词
  const systemPrompt = [...fullSystemPrompt, TEAMMATE_SYSTEM_PROMPT_ADDENDUM]

  // 2. 尝试从任务列表中认领任务
  await tryClaimNextTask(parentSessionId, agentName)

  // 3. 主循环：执行 → 空闲 → 等待 → 执行
  while (!aborted && !shouldExit) {
    // 3a. 创建本轮的 AbortController（Escape 只停当前轮，不杀整个 teammate）
    const currentWorkAbortController = createAbortController()

    // 3b. 检查是否需要压缩历史
    if (tokenCount > autoCompactThreshold) {
      await compactConversation(allMessages, ...)
    }

    // 3c. 在 AsyncLocalStorage 上下文中执行 agent
    await runWithTeammateContext(teammateContext, async () => {
      await runWithAgentContext(agentContext, async () => {
        for await (const message of runAgent({ ... })) {
          // 追踪进度、更新 AppState
        }
      })
    })

    // 3d. 标记为空闲，发送空闲通知
    updateTaskState(taskId, task => ({ ...task, isIdle: true }))
    await sendIdleNotification(agentName, agentColor, teamName, { ... })

    // 3e. 等待下一条消息或关闭请求
    const waitResult = await waitForNextPromptOrShutdown(identity, ...)
    // waitResult.type: 'new_message' | 'shutdown_request' | 'aborted'
  }
}
```

### 7.3 消息等待循环 (waitForNextPromptOrShutdown)

空闲 teammate 的消息等待是一个**优先级轮询循环**：

```typescript
async function waitForNextPromptOrShutdown(identity, abortController, ...) {
  while (!aborted) {
    // 1. 检查内存中的 pendingUserMessages（来自 UI 的直接输入）—— 最高优先级
    if (task.pendingUserMessages.length > 0) {
      return { type: 'new_message', message, from: 'user' }
    }

    // 2. 等待 500ms 后轮询文件邮箱
    await sleep(POLL_INTERVAL_MS) // 500ms

    // 3. 检查中止信号
    if (abortController.signal.aborted) return { type: 'aborted' }

    // 4. 轮询文件邮箱
    const allMessages = await readMailbox(agentName, teamName)

    // 5. 优先处理关闭请求（防止 peer 消息淹没关闭请求）
    for (const msg of allMessages) {
      if (isShutdownRequest(msg.text)) {
        markMessageAsReadByIndex(...)
        return { type: 'shutdown_request', request, originalMessage }
      }
    }

    // 6. 优先处理 team-lead 消息（高于 peer 消息）
    for (const msg of allMessages) {
      if (!msg.read && msg.from === 'team-lead') {
        return { type: 'new_message', message, from: msg.from }
      }
    }

    // 7. 处理其他未读消息（FIFO）
    const selectedIndex = allMessages.findIndex(m => !m.read)
    if (selectedIndex !== -1) {
      return { type: 'new_message', message, from }
    }

    // 8. 尝试从任务列表中认领新任务
    const taskPrompt = await tryClaimNextTask(taskListId, agentName)
    if (taskPrompt) {
      return { type: 'new_message', message: taskPrompt, from: 'task-list' }
    }
  }
}
```

**关键设计决策**：
- **用户直接输入（pendingUserMessages）最高优先级**：来自 UI 的输入在 sleep 之前检查，确保即时响应
- **邮箱内部分三级扫描**：一次 `readMailbox()` 调用后，先扫描关闭请求，再扫描 leader 消息，最后 fallback 到任意未读消息（FIFO）——这三级是同一次读取中的子扫描，不是独立的顶层步骤
- **Leader 消息优先于 peer 消息**：leader 代表用户意图，不应被 peer 通信饿死
- **自动认领任务**：空闲时自动从共享任务列表中获取待办事项
- **首次轮询不 sleep**：通过 `pollCount > 0` 跳过首次迭代的 500ms 延迟

### 7.4 空闲通知机制

当 teammate 完成一轮工作进入空闲时，会向 leader 发送结构化的空闲通知：

```typescript
type IdleNotificationMessage = {
  type: 'idle_notification'
  from: string               // agent ID
  timestamp: string
  idleReason?: 'available' | 'interrupted' | 'failed'
  summary?: string           // 最近一次 peer DM 的摘要
  completedTaskId?: string
  completedStatus?: 'resolved' | 'blocked' | 'failed'
  failureReason?: string
}
```

Leader 的 `useInboxPoller` 收到此通知后，可以：
- 更新 teammate 的空闲状态指示器
- 分配新任务
- 决定是否关闭空闲 teammate

## 8. 收件箱轮询器 (useInboxPoller)

`useInboxPoller` 是一个 React Hook，是 leader 和 teammate 消费邮箱消息的核心驱动器。

### 8.1 轮询机制

```typescript
function useInboxPoller({ enabled, isLoading, focusedInputDialog, onSubmitMessage }) {
  // 每 1 秒轮询一次
  useInterval(() => void poll(), shouldPoll ? 1000 : null)

  const poll = async () => {
    const agentName = getAgentNameToPoll(appState)
    const unread = await readUnreadMessages(agentName, teamName)

    // 将消息分类到不同的处理队列
    for (const msg of unread) {
      if (isPermissionRequest(msg.text)) permissionRequests.push(msg)
      else if (isPermissionResponse(msg.text)) permissionResponses.push(msg)
      else if (isSandboxPermissionRequest(msg.text)) sandboxPermissionRequests.push(msg)
      else if (isSandboxPermissionResponse(msg.text)) sandboxPermissionResponses.push(msg)
      else if (isShutdownRequest(msg.text)) shutdownRequests.push(msg)
      else if (isShutdownApproved(msg.text)) shutdownApprovals.push(msg)
      else if (isTeamPermissionUpdate(msg.text)) teamPermissionUpdates.push(msg)
      else if (isModeSetRequest(msg.text)) modeSetRequests.push(msg)
      else if (isPlanApprovalRequest(msg.text)) planRequests.push(msg)
      else regularMessages.push(msg)
    }

    // 各类型独立处理
    handlePermissionRequests(permissionRequests)    // → ToolUseConfirmQueue
    handlePermissionResponses(permissionResponses)   // → invokeCallbacks
    handleShutdownApprovals(shutdownApprovals)       // → killPane + removeMember
    handlePlanApprovalRequests(planRequests)         // → auto-approve

    // 普通消息：空闲时立即提交，忙碌时排队
    if (!isLoading) {
      onSubmitMessage(formatted)  // 提交为新的 LLM turn
    } else {
      queueMessages()             // 存入 AppState.inbox
    }
  }
}
```

### 8.2 消息分类与路由

`useInboxPoller` 对每条未读消息进行类型检测，路由到对应的处理器：

```
未读消息
  ├── permission_request       → ToolUseConfirmQueue（仅 leader 侧，显示权限对话框）
  ├── permission_response      → processMailboxPermissionResponse()（仅 worker 侧回调）
  ├── sandbox_permission_request  → leader 侧处理网络访问权限请求
  ├── sandbox_permission_response → worker 侧处理网络访问审批结果
  ├── shutdown_request         → 传递给模型（UI 渲染关闭请求卡片）
  ├── shutdown_approved        → killPane() + removeTeammateFromTeamFile() + 解除任务分配
  ├── team_permission_update   → applyPermissionUpdate()（应用到本地上下文）
  ├── mode_set_request         → applyPermissionUpdate()（切换权限模式）
  ├── plan_approval_request    → 自动审批 + 写回 response（仅 leader 侧）
  └── 普通文本消息              → 格式化为 <teammate-message> XML → 提交为 LLM turn
```

### 8.3 消息投递策略

```typescript
if (!isLoading && !focusedInputDialog) {
  // 空闲：立即提交为新的 LLM turn
  onSubmitTeammateMessage(formatted)
} else {
  // 忙碌：排队到 AppState.inbox
  // 当 turn 结束后 useEffect 会检查并投递排队的消息
  queueMessages()
}
```

## 9. 权限同步系统 (PermissionSync)

### 9.1 权限请求流程

```
Worker                              Leader
  │                                   │
  │ 1. 遇到需要权限的工具调用            │
  │    hasPermissionsToUseTool()       │
  │    返回 {behavior: 'ask'}          │
  │                                   │
  │ 2. 创建权限请求                     │
  │    createPermissionRequest()       │
  │                                   │
  │ 3. 发送到 leader 邮箱 ─────────────►│ 4. useInboxPoller 检测到
  │    writeToMailbox('team-lead',...) │    permission_request
  │                                   │
  │                                   │ 5. 添加到 ToolUseConfirmQueue
  │                                   │    用户看到权限对话框
  │                                   │
  │                                   │ 6. 用户批准/拒绝
  │                                   │
  │ 7. useInboxPoller 检测到    ◄──────│    sendPermissionResponseViaMailbox()
  │    permission_response             │
  │                                   │
  │ 8. processMailboxPermissionResponse│
  │    invoke onAllow/onReject callback│
  │    继续执行                        │
```

### 9.2 In-Process Teammate 的权限处理

对于 in-process teammate，权限处理**不走邮箱系统**，而是直接使用与主 agent 相同的交互式对话框：

```typescript
// in-process teammate 使用独立的 canUseTool 实现
// inProcessRunner.ts 中的 createInProcessCanUseTool() 创建了自己的权限处理器
// 当 leader 的 ToolUseConfirmQueue bridge 可用时，直接向其添加权限请求
// 这与主 agent 使用完全相同的 UI 对话框，无需经过邮箱系统
// 仅当 bridge 不可用时才回退到邮箱路径
```

注意：`isSwarmWorker()` 对 in-process teammate **返回 true**（因为 teamName 和 agentId 都有值且不是 leader）。in-process teammate 不走 `handleSwarmWorkerPermission()` 的真正原因是：它们运行在 `createInProcessCanUseTool()` 中，这是一个**完全独立的 `canUseTool` 实现**，绕过了 REPL 中的 swarm worker 权限处理路径。

此外，`useInboxPoller` 对 in-process teammate 的行为是：内部辅助函数 `getAgentNameToPoll()` 返回 `undefined`（因为 `isInProcessTeammate()` 为 true），导致 poll 函数提前退出、`shouldPoll` 为 false，hook 变为 no-op。

对比之下，tmux 进程级 teammate 由于在独立进程中运行，必须通过邮箱系统发送 `permission_request`，由 leader 的 `useInboxPoller` 检测后注入 `ToolUseConfirmQueue`。

## 10. 任务系统 (TaskList)

团队使用共享的文件系统任务列表进行工作协调。

### 10.1 存储结构

```
~/.claude/tasks/{sanitized-team-name}/
  ├── .highwatermark          # 最大任务 ID 记录
  ├── .lock                   # 文件锁
  ├── {taskId}.json           # 任务文件（taskId 经 sanitizePathComponent 处理）
  └── ...
```

### 10.2 任务数据结构

```typescript
type Task = {
  id: string
  subject: string
  description: string
  activeForm?: string          // 进行中的动词（如 "Running tests"）
  owner?: string               // agent ID（谁认领了这个任务）
  status: 'pending' | 'in_progress' | 'completed'
  blocks: string[]             // 此任务阻塞的其他任务 ID
  blockedBy: string[]          // 阻塞此任务的其他任务 ID
  metadata?: Record<string, unknown>
}
```

### 10.3 任务认领机制

空闲 teammate 在 `waitForNextPromptOrShutdown()` 中自动认领任务：

```typescript
async function tryClaimNextTask(taskListId, agentName) {
  const tasks = await listTasks(taskListId)
  const availableTask = tasks.find(task =>
    task.status === 'pending' &&
    !task.owner &&
    task.blockedBy.every(id => !unresolvedTaskIds.has(id))
  )
  if (!availableTask) return undefined

  await claimTask(taskListId, availableTask.id, agentName)
  await updateTask(taskListId, availableTask.id, { status: 'in_progress' })
  return formatTaskAsPrompt(availableTask)
  // 输出格式: "Complete all open tasks. Start with task #N: \n\n subject\n\ndescription"
}
```

## 11. Teammate 身份标识系统

### 11.1 Agent ID 格式

```
{agentName}@{teamName}
例如: researcher@my-team, tester@my-team
```

由 `formatAgentId()` 生成，`parseAgentId()` 解析。

### 11.2 身份解析优先级

teammate 的身份信息通过三级机制解析：

```
优先级 1: AsyncLocalStorage (in-process teammates)
  └── TeammateContext 存储在 AsyncLocalStorage 中
      每个 in-process teammate 有独立的上下文

优先级 2: dynamicTeamContext (tmux teammates，运行时加入)
  └── 通过 setDynamicTeamContext() 设置

优先级 3: 环境变量 (tmux teammates，CLI 参数传入)
  └── CLAUDE_CODE_AGENT_ID, CLAUDE_CODE_AGENT_NAME 等
```

```typescript
function getAgentId(): string | undefined {
  const inProcessCtx = getTeammateContext()  // 优先级 1
  if (inProcessCtx) return inProcessCtx.agentId
  return dynamicTeamContext?.agentId          // 优先级 2
  // 环境变量在 dynamicTeamContext 初始化时已合并
}
```

### 11.3 AsyncLocalStorage 隔离

```typescript
const teammateContextStorage = new AsyncLocalStorage<TeammateContext>()

function runWithTeammateContext<T>(context: TeammateContext, fn: () => T): T {
  return teammateContextStorage.run(context, fn)
}

function getTeammateContext(): TeammateContext | undefined {
  return teammateContextStorage.getStore()
}
```

这确保了在同一进程中并发运行的多个 teammate 不会互相干扰身份信息。

## 12. 关闭 (Shutdown) 协议

关闭是一个需要双方协商的过程，而非强制终止。

### 12.1 关闭流程

```
Leader                                Teammate
  │                                     │
  │ 1. 发送 shutdown_request ──────────►│ 2. 收到请求
  │    (通过邮箱)                        │    传递给 LLM 模型
  │                                     │
  │                                     │ 3. 模型决策：
  │                                     │    - 使用 SendMessage 发送
  │                                     │      shutdown_response(approve: true)
  │                                     │    - 或 shutdown_response(approve: false)
  │                                     │
  │ 4a. 收到 ShutdownApprovedMessage ◄──│
  │     - killPane() (面板后端)          │ 5a. 触发 abortController.abort()
  │     - removeTeammateFromTeamFile()  │     gracefulShutdown(0)
  │     - 从 teamContext 中移除          │
  │                                     │
  │ 4b. 收到 ShutdownRejectedMessage ◄──│ 5b. 继续工作
  │     - 通知用户                       │
```

**消息格式转换说明**：LLM 发送的是 `shutdown_response`（线格式），SendMessageTool 的处理函数将其转换为邮箱级的 `ShutdownApprovedMessage` 或 `ShutdownRejectedMessage`，包含 `requestId`、`from`、`timestamp` 等元数据。

### 12.2 In-Process Teammate 的关闭

对于 in-process teammate，关闭通过 `AbortController` 实现：

```typescript
// Leader 侧：发送关闭请求
async terminate(agentId, reason) {
  await writeToMailbox(teammateAgentName, shutdownRequest, teamName)
  requestTeammateShutdown(taskId, setAppState)  // 设置 shutdownRequested 标志
}

// Teammate 侧：批准关闭
async handleShutdownApproval(requestId, context) {
  // 通过 findTeammateTaskByAgentId 找到任务
  // 调用 task.abortController.abort()
  // 这会中断 runInProcessTeammate() 中的主循环
}
```

## 13. 系统提示词

### 13.1 Teammate 系统提示词追加

每个 teammate 在标准系统提示词之上，额外接收到：

```markdown
# Agent Teammate Communication

IMPORTANT: You are running as an agent in a team. To communicate with anyone
on your team:
- Use the SendMessage tool with `to: "<name>"` to send messages to specific teammates
- Use the SendMessage tool with `to: "*"` sparingly for team-wide broadcasts

Just writing a response in text is not visible to others on your team - you
MUST use the SendMessage tool.

The user interacts primarily with the team lead. Your work is coordinated
through the task system and teammate messaging.
```

### 13.2 消息格式化

Agent 之间的消息在注入 LLM 上下文时，使用 XML 标签格式化：

```xml
<teammate-message teammate_id="researcher" color="blue" summary="Found a bug">
在 src/utils/parser.ts 第 42 行发现了一个空指针异常...
</teammate-message>
```

## 14. 会话清理

### 14.1 Session Cleanup 机制

当 leader 会话退出时（正常退出或 SIGINT/SIGTERM），需要清理所有残留资源：

```typescript
async function cleanupSessionTeams() {
  const sessionCreatedTeams = getSessionCreatedTeams()
  // 1. 先杀死所有面板（防止孤立进程）
  await Promise.allSettled(teams.map(name => killOrphanedTeammatePanes(name)))
  // 2. 清理目录和 worktree
  await Promise.allSettled(teams.map(name => cleanupTeamDirectories(name)))
}
```

### 14.2 Worktree 清理

```typescript
async function destroyWorktree(worktreePath) {
  // 1. 读取 .git 文件找到主仓库路径
  // 2. 尝试 git worktree remove --force
  // 3. 回退到 rm -rf
}
```

## 15. UI 集成

### 15.1 AppState 中的团队上下文

```typescript
type AppState = {
  teamContext?: {
    teamName: string
    teamFilePath: string
    leadAgentId: string
    teammates: {
      [agentId: string]: {
        name: string
        agentType: string
        color: string
        tmuxSessionName: string
        tmuxPaneId: string
        cwd: string
        spawnedAt: number
      }
    }
  }
  inbox: {
    messages: Array<{
      id: string
      from: string
      text: string
      timestamp: string
      status: 'pending' | 'processed'
      color?: string
      summary?: string
    }>
  }
  tasks: {
    [taskId: string]: InProcessTeammateTaskState | OtherTaskState
  }
}
```

### 15.2 TeammateTask 状态

```typescript
type InProcessTeammateTaskState = TaskStateBase & {
  type: 'in_process_teammate'
  identity: TeammateIdentity       // agentId, agentName, teamName, color, planModeRequired, parentSessionId
  prompt: string
  model?: string
  selectedAgent?: AgentDefinition  // 自定义 agent 定义（如有）
  abortController?: AbortController      // 生命周期控制器 —— 杀死整个 teammate
  currentWorkAbortController?: AbortController  // 工作控制器 —— 只停当前轮次
  unregisterCleanup?: () => void   // 清理回调（运行时）
  awaitingPlanApproval: boolean    // 是否等待计划审批
  permissionMode: PermissionMode
  error?: string
  result?: AgentToolResult
  progress?: AgentProgress
  messages?: Message[]             // 对话历史（上限 50 条，用于缩放视图）
  inProgressToolUseIDs?: Set<string>
  pendingUserMessages: string[]    // 用户直接输入的消息队列
  spinnerVerb?: string
  pastTenseVerb?: string
  isIdle: boolean
  shutdownRequested: boolean
  onIdleCallbacks?: Array<() => void>  // 空闲回调（运行时）
  lastReportedToolCount: number
  lastReportedTokenCount: number
}
```

## 16. 完整数据流示例

以下是一个完整的 team 创建、teammate 执行、消息传递、关闭的端到端流程：

```
用户: "请帮我完成代码审查和测试"

Leader (Claude Code 主会话):
  │
  ├── 1. TeamCreateTool.call({team_name: "review-team"})
  │     → 写入 ~/.claude/teams/review-team/config.json
  │     → 创建 ~/.claude/tasks/review-team/
  │     → 设置 AppState.teamContext
  │
  ├── 2. Agent tool 被调用，检测到 team context
  │     → getTeammateExecutor(preferInProcess: true)
  │     → 返回 InProcessBackend 实例
  │
  ├── 3. InProcessBackend.spawn({
  │        name: "reviewer", teamName: "review-team",
  │        prompt: "审查 src/ 目录下的代码"
  │      })
  │     → spawnInProcessTeammate()
  │       → 创建 TeammateContext (AsyncLocalStorage)
  │       → 注册 InProcessTeammateTaskState 到 AppState.tasks
  │     → startInProcessTeammate()
  │       → runInProcessTeammate() 开始执行
  │
  │   Teammate "reviewer":
  │     ├── 运行 runAgent() 在 AsyncLocalStorage 上下文中
  │     ├── 调用 FileReadTool, BashTool 等
  │     │   如果需要权限 → handleInteractivePermission()
  │     │     → 与主 agent 共享同一权限对话框
  │     │     → 用户在 leader UI 中审批
  │     ├── 完成审查后进入空闲
  │     ├── 发送 idle_notification 到 leader 邮箱
  │     └── waitForNextPromptOrShutdown() 开始轮询
  │
  ├── 4. Leader 的 useInboxPoller 收到 idle_notification
  │     → 更新 teammate 状态为 idle
  │
  ├── 5. Leader 决定分配新任务
  │     → TaskCreate({subject: "Run tests", owner: "reviewer@review-team"})
  │     → SendMessage({to: "reviewer", message: "请运行测试"})
  │       → writeToMailbox("reviewer", message)
  │
  │   Teammate "reviewer":
  │     ├── waitForNextPromptOrShutdown() 检测到新消息
  │     ├── 返回 {type: 'new_message', message, from: 'team-lead'}
  │     ├── 继续 runAgent() 执行新任务
  │     └── ...
  │
  ├── 6. Leader 决定关闭团队
  │     → SendMessage({to: "reviewer", message: {type: "shutdown_request"}})
  │
  │   Teammate "reviewer":
  │     ├── 收到 shutdown_request
  │     ├── 传递给 LLM 模型
  │     ├── 模型决策：
  │     │   ├── approve: SendMessage({to: "team-lead", message: {type: "shutdown_response", approve: true}})
  │     │   │   → abortController.abort() → 退出主循环
  │     │   └── reject: SendMessage({to: "team-lead", message: {type: "shutdown_response", approve: false}})
  │     │       → 回到 Running 状态继续工作
  │     └── (以下假设 approve 路径)
  │
  ├── 7. Leader 的 useInboxPoller 收到 shutdown_approved
  │     → removeTeammateFromTeamFile()
  │     → 从 teamContext.teammates 中移除
  │
  └── 8. TeamDeleteTool.call()
        → cleanupTeamDirectories()
        → 清空 AppState.teamContext
```

## 17. 关键设计决策总结

1. **文件系统作为通信总线**：选择文件系统而非进程间通信（IPC），是因为 teammate 可能运行在完全独立的进程中（tmux 面板），文件系统是唯一可靠的共享介质。

2. **AsyncLocalStorage 用于进程内隔离**：同一进程中的多个 teammate 通过 Node.js 的 `AsyncLocalStorage` 实现上下文隔离，避免全局状态冲突。

3. **两级 AbortController**：lifecycle controller（杀死整个 teammate）和 work controller（只停当前轮次），允许 Escape 中断当前工作而不杀死 teammate。

4. **优先级消息处理**：用户直接输入 > 关闭请求 > leader 消息 > peer 消息 > 自动任务认领，防止关键控制消息被淹没。

5. **邮箱文件锁**：使用 `proper-lockfile` 库确保并发写入安全，带重试和退避策略。

6. **统一的 TeammateExecutor 接口**：无论 tmux、iTerm2 还是 in-process，都通过相同的接口管理 teammate 生命周期。

7. **结构化消息与普通消息分离**：`isStructuredProtocolMessage()` 将协议消息路由到专用处理器，防止它们作为原始文本污染 LLM 上下文。

8. **自动任务认领**：空闲 teammate 自动从共享任务列表中获取待办事项，实现了无需 leader 手动分配的自驱动工作模式。
