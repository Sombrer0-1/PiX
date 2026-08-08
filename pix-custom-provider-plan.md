# pix 自定义第三方 Provider 设置 - 技术实现方案

> 状态：定稿（经三视角并行评审 -> 逐条裁决吸收）
> 范围：pix 产品层。pi 内核（`packages/*`）不改，仅复用其已有能力。

## 1. 背景与需求

需求原文要点：

- 在 pix 设置面板里加入「添加第三方 URL 和 API-key」的设置，方便灵活接入模型、适配中转站。
- 有些模型请求路径不在 pix 当前 auth 默认列出的 providers 中。
- 至少完美适配主流的 anthropic 和 openai 两家的所有请求格式。
- 实现可能在 pi 内核中已经写得差不多，但产品是 pix，需要在 pix 中实现。
- 给予用户较大的自定义空间，例如 URL、模型名等。

需求边界：只在 pix 产品层实现，不为 pi 内核新增 provider 协议；不要求支持 OAuth 类型 custom provider（需求只要 url+api-key）。

## 2. 现状分析

### 2.1 pi 内核已有的完整能力（无需重复实现）

1. **`~/.pi/agent/models.json` 静态自定义 provider 机制**
   - 路径：`packages/coding-agent/src/config.ts:498` `getModelsPath()` = `join(getAgentDir(), "models.json")`。`ModelRegistry.create(authStorage, modelsJsonPath)` 默认值即此路径（`model-registry.ts:420`）。
   - 加载与校验：`packages/coding-agent/src/core/model-registry.ts`，`loadCustomModels()`（`:529`）用 TypeBox schema 校验后合并内置模型。
   - 结构（见 `packages/coding-agent/docs/models.md`）：
     ```json
     {
       "providers": {
         "<name>": {
           "baseUrl": "...", "api": "anthropic-messages|openai-completions|openai-responses|google-generative-ai",
           "apiKey": "literal|$ENV|!cmd", "headers": {...}, "authHeader": true,
           "compat": {...},
           "models": [ { "id": "...", "name": "...", "reasoning": false, "input": ["text"], "contextWindow": 128000, "maxTokens": 16384, "cost": {...} } ],
           "modelOverrides": { "<built-in-model-id>": {...} }
         }
       }
     }
     ```
   - **覆盖内置 provider（中转站核心场景）**：`{ "providers": { "anthropic": { "baseUrl": "https://proxy/..." } } }` 只改 baseUrl，保留全部内置模型与既有 auth（`models.md` §Overriding Built-in Providers）。
   - **热重载**：`ModelRegistry.refresh()`（`model-registry.ts:431`）清缓存从磁盘重载 built-in + custom，无需重启进程。pix 已在 `setApiKey` 后调用 `session.modelRegistry.refresh()`（`pix/src/main/session-bridge.ts:620`）。

2. **anthropic / openai 请求格式已完整实现并注册**
   - API 类型注册：`packages/ai/src/providers/register-builtins.ts:345` 注册 `anthropic-messages`、`openai-completions`、`openai-responses` 等。
   - anthropic 消费 `model.baseUrl` 与 `options.apiKey`：`packages/ai/src/providers/anthropic.ts:874-876`（`apiKey, baseURL: model.baseUrl`）。anthropic SDK 用 apiKey 生成 `x-api-key` 头。
   - openai：`openai-completions.ts:488-493` `new OpenAI({ apiKey, baseURL: model.baseUrl })`，SDK 自身以 apiKey 生成 `Authorization: Bearer <apiKey>`。
   - `compat` 字段处理中转站/兼容服务器 quirks：`supportsDeveloperRole`、`thinkingFormat`（`openrouter|deepseek|together|qwen|qwen-chat-template`）、`maxTokensField`、`cacheControlFormat: "anthropic"` 等（`models.md` §OpenAI Compatibility、`custom-provider.md` §Model Definition Reference）。

3. **凭证解析（实际机制，已校对源码）**
   - `AuthStorage`（`packages/coding-agent/src/core/auth-storage.ts`）管理 `~/.pi/agent/auth.json`，`getApiKey(provider, {includeFallback})`（`:462`）解析 runtime override -> auth.json api_key -> oauth -> env。
   - **models.json 的 apiKey 不走 AuthStorage 的 fallbackResolver**：`AuthStorage.setFallbackResolver`（`:242`）在 packages/ 内无调用方。models.json 的 apiKey 实际由 `ModelRegistry.getApiKeyAndHeaders`（`model-registry.ts:756-764`）自行解析：先调 `authStorage.getApiKey(provider, { includeFallback: false })`（覆盖 runtime>auth.json>oauth>env），**未命中才回退**到 `providerConfig.apiKey`（models.json，由 ModelRegistry 经 `resolveConfigValueOrThrow` 解析 `literal`/`$ENV`/`!cmd`）。
   - **关键推论**：auth.json 凭证优先于 models.json apiKey。这对「覆盖内置 provider 走中转站」场景是安全陷阱（见 §4.3.3）。
   - `getProviderAuthStatus`（`model-registry.ts:801`）含 models.json 配置的 auth 状态。

4. **extension 动态 provider（`pi.registerProvider`）**：运行时注册，不持久化。本方案不依赖它（要求用户写代码不符合「设置面板里加入」），但 pix 已通过 `extensionPaths`（`SettingsPage.vue` 资源分区，`session-bridge.ts:717`）支持加载 extension，作为高级逃生口。

结论：pi 内核「已经写得差不多」属实。缺口完全在 pix 产品层。

### 2.2 pix 产品层现状与缺口

- **设置面板**：`pix/src/renderer/pages/SettingsPage.vue`，侧栏分区 `general|model|shell|wsl|resources|mcp|auth|advanced`（`:23-34`）。
  - 「认证」分区（`:556-584`）遍历 `authStore.authStatus`，仅能为 pi 已注册的 provider 调 `rpc.setApiKey(provider, key)` / `removeAuth`，**无 URL 字段、无法新增 provider**。
  - 「模型」分区（`:418-460`）只有 `enabledModels` glob、transport、retry、takeHerEyes 等，`ModelSettings.vue` 是空壳。
  - `ModelSelector.vue` 从 `rpc.availableModels` 取列表（`useWorkspaceRpc.ts:33`），custom provider 模型一旦注册并 auth configured 即自动出现于 `getAvailable()`（`model-registry.ts:699`），**ModelSelector 无需改动**。
- **pix 内部命令链路（关键，本方案必须沿用）**：所有「会话态」操作走同一路径——`RpcCommand` 联合类型（`pix/src/shared/types.ts:25-89`）-> IPC `rpc-command`/`team-leader-command`（`ipc-handlers.ts:452-504`，`executeCommand` switch `:863-880`）-> `SessionBridge` 方法（`session-bridge.ts:593-670`），并由 `useWorkspaceRpc` 的 `activeRpc = teamMode ? teamLeaderRpc : singleRpc`（`useWorkspaceRpc.ts:28`）自动路由到当前活跃桥。`setApiKey` 在 `useRpc.ts:373` 即 `sendCommand({type:"set_api_key"})`，团队模式经 `useTeamLeaderRpc.ts:14` -> `sendTeamLeaderCommand` -> `executeCommand(teamLeaderSessionBridge)` 自动刷新 leader 注册表。
- **设置存储分两类**：GUI 设置（electron-store，`pix-settings`，`pix/src/main/settings-store.ts`，`GuiSettings` 定义于 `pix/src/shared/project-location.ts`）；Pi 设置（pi `SettingsManager`，`~/.pi/agent/settings.json`，经 `rpc.setPiSettings()`，`session-bridge.ts:647`）。
- **pix 与 pi 集成**：进程内直连。`session-bridge.ts:201` `getAgentDir()` + `AuthStorage.create`；`createAgentSession`（`:1397`）；`_createSettingsManager`（`:1461`）用 GUI 的 `defaultProvider/Model/ThinkingLevel` 作 `applyOverrides`。
- **pix 已 import 的内核符号**：`session-bridge.ts:24-30` 从 `@earendil-works/pi-coding-agent` import `AuthStorage`、`getAgentDir`、`SettingsManager` 等。注意：该包入口 `packages/coding-agent/src/index.ts:6` 仅再导出 `getAgentDir, VERSION`；`getModelsPath` 虽定义于 `config.ts:499` 但**未公开导出**，且 `package.json` exports 仅暴露 `.` 与 `./hooks`，深导入会被 Node exports 约束拒绝。因此 pix 不能 `import { getModelsPath }`，而应直接用已导入的 `getAgentDir()` 拼路径 `join(getAgentDir(), "models.json")`（与 `ModelRegistry.create` 默认值一致）。

**缺口**：pix 没有 models.json 的读写 UI、没有新增/编辑自定义 provider 的入口。

## 3. 架构决策与实现路径

### 3.1 核心决策：pix 直接管理 `~/.pi/agent/models.json`，端到端复用 RpcCommand 链路

- pix 设置面板读写 `~/.pi/agent/models.json`，写入后调 `session.modelRegistry.refresh()` 热重载。
- **沿用 pix 现有命令链路**：新增 `get_custom_providers` / `set_custom_providers` 两个 `RpcCommand`（pix 自有类型，扩展不触碰 `packages/*`），经 `executeCommand` 分发到 `SessionBridge` 方法。这样团队模式经 `team-leader-command` 自动路由到活跃桥、自动刷新 leader 注册表，与 `set_api_key` 行为完全一致；无需新增独立 `ipcMain.handle` 通道，`preload.ts`/`PixApi` 无需改动。`CustomProviders.vue` 经 `useWorkspaceRpc()` 调用，与 `McpSettings` 既有模式一致。

理由：与 pi 原生机制一致（CLI 与 pix 共享 models.json）；复用 pi 的 schema 校验、API 类型注册、compat 处理、热重载；复用 pix 已有的命令路由（含团队模式）；不重造 provider 协议。

### 3.2 配置所有权策略

pix 对 models.json 采取「整体读写、一视同仁」策略：读取整个 models.json 在 UI 展示全部 `providers`，用户可增/删/改任意 provider；写回时 pretty-print（2 空格）保留 `modelOverrides`、`compat` 等高级字段。

不引入「pix 管理的 provider」元数据标记。理由：(1) 保持用户自由、一视同仁，符合「较大自定义空间」；(2) TypeBox schema 默认放行未知属性（`ModelsConfigSchema`/`ProviderConfigSchema` 未设 `additionalProperties:false`，见 `model-registry.ts:194-208`），加元字段虽不破坏校验但会被静默忽略，无意义。

### 3.3 凭证存储决策

custom provider 的 apiKey 统一存 models.json 的 `apiKey` 字段（与 pi models.json 设计一致）。因 `getApiKeyAndHeaders` 先取 auth.json 再回退 models.json apiKey（§2.1.3），必须避免双源：

- custom provider（models.json 中定义）的凭证只在「自定义模型」分区管理，**禁止其走「认证」分区的 `setApiKey`（写 auth.json）**——否则 auth.json 的 key 会静默覆盖 models.json apiKey，且在「覆盖内置 provider」场景会把真实凭证泄漏给中转站（§4.3.3）。
- UI 提供 apiKey 输入框，提示可填 `$ENV_VAR` 引用（key 不落盘，更安全）。
- 覆盖内置 provider 的中转站场景（如 `anthropic` 只改 baseUrl）：保留既有 auth.json/apikey，不触碰凭证；若同时设了 models.json apiKey 而 auth.json 已有同 provider key，UI 须显式告警（§4.3.3）。

### 3.4 数据流

```
CustomProviders.vue (useWorkspaceRpc)
  ── rpc.getCustomProviders() ── sendCommand({type:"get_custom_providers"})
       ── executeCommand ──> activeBridge.getCustomProviders()
           (纯文件读: join(getAgentDir(),"models.json"); 不依赖 session; apiKey 脱敏)
  <── { providers, schemaError? } ──

用户编辑保存
  ── rpc.setCustomProviders(providers) ── sendCommand({type:"set_custom_providers", providers})
       ── executeCommand ──> activeBridge.setCustomProviders(providers)
           1. 加锁(proper-lockfile) 读-改-写; 占位符 apiKey 拷磁盘原值, null=清除
           2. 写临时文件 + renameSync 原子替换; chmodSync 0o600
           3. if (this._session) this._session.modelRegistry.refresh()
           4. schemaError = this._session?.modelRegistry.getError() ?? undefined
           5. 团队模式: 经 TeamManager 对 worker session.modelRegistry.refresh() (或明示重启)
  <── { success, schemaError?, sessionActive } ──
  ──> rpc.refreshModels() + authStore.refreshStatus() + 重新 getCustomProviders() 回显
```

## 4. 详细设计

### 4.1 models.json 数据模型（pix 侧 TS 类型，镜像 pi schema 子集）

新增 `pix/src/shared/custom-providers.ts`（leaf 模块，供 main/renderer 与 RpcCommand 共享）：

```ts
export type CustomApi = "anthropic-messages" | "openai-completions" | "openai-responses" | "google-generative-ai";

export interface CustomModelConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
  headers?: Record<string, string>;
  baseUrl?: string;
  api?: CustomApi;
}

export interface CustomProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: CustomApi;
  apiKey?: string;        // literal | $ENV | !cmd；renderer 侧只见掩码
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  models?: CustomModelConfig[];
  modelOverrides?: Record<string, Record<string, unknown>>;
}

export interface ModelsJson {
  providers: Record<string, CustomProviderConfig>;
}
```

UI 仅暴露核心字段（name/baseUrl/api/apiKey/authHeader/headers/models 的 id+name+reasoning+input+contextWindow+maxTokens），`compat`/`modelOverrides`/`thinkingLevelMap` 作为「高级」折叠项或 JSON 编辑器透传。

### 4.2 pix main 层

#### 4.2.1 SessionBridge 新增方法（`pix/src/main/session-bridge.ts`）

路径用已导入的 `getAgentDir()`：`const modelsPath = join(getAgentDir(), "models.json")`（不 import `getModelsPath`，见 §2.2）。

```ts
// 纯文件读，不调 _getSession()，无 session 也可读（参照 getAuthStatus:593 的 try/catch 兜底）
getCustomProviders(): { providers: Record<string, CustomProviderConfig>; schemaError?: string } {
  // 1. readFileSync(modelsPath)；不存在 -> { providers: {} }
  // 2. JSON.parse 失败 -> { providers: {}, schemaError: "models.json 解析失败: ..." }
  // 3. 脱敏：对每个 provider，若 apiKey 存在则替换为占位符常量 SENTINEL，并记 hasApiKey=true
  //    （不把明文 apiKey 经 IPC 返回 renderer）
  // 4. schemaError：session 活跃时附 modelRegistry.getError()（捕获上次 refresh 的 schema 错误）
}

setCustomProviders(incoming: Record<string, CustomProviderConfig>): {
  success: boolean; schemaError?: string; sessionActive: boolean; error?: string;
} {
  // 1. proper-lockfile 加锁（与 auth-storage.ts:136 一致），读磁盘当前 models.json
  // 2. 合并：对 incoming 每个 provider，
  //    - apiKey === SENTINEL -> 拷磁盘原值（留空保留）
  //    - apiKey === null     -> 删除该字段（显式清除）
  //    - 其它                -> 用 incoming 值
  //    保留磁盘上 providers 中 incoming 未提及的 provider？策略见下（整体替换 vs 合并）
  // 3. JSON.stringify(merged, null, 2)；写同目录临时文件 + renameSync 原子替换
  // 4. chmodSync(modelsPath, 0o600)  （writeFileSync 的 mode 选项对已存在文件无效，必须后置 chmod）
  // 5. if (this._session) { this._session.modelRegistry.refresh(); schemaError = this._session.modelRegistry.getError() ?? undefined; }
  //    else sessionActive=false（不校验，下次 createAgentSession 时 loadModels 设 loadError，延迟暴露）
  // 6. 团队模式：经 TeamManager 对每个 worker session.modelRegistry.refresh()（§4.4）
}
```

合并策略：pix UI 展示全部 providers 并允许增删改，`setCustomProviders` 以 incoming 为准整体替换 `providers`（保留 models.json 顶层非 `providers` 字段，若有）。这要求 UI 保存前已 `getCustomProviders` 拿到全量并在其上编辑——配合 proper-lockfile 的读-改-写，避免丢更新。

**schema 校验局限（已校对源码）**：TypeBox schema 未设 `additionalProperties:false`，`getError()`（`model-registry.ts:450`）仅捕获「已知字段类型错误」与「必填缺失」，**不捕获未知 compat 字段名**——用户把 `supportsDeveloperRole` 拼成 `supportDeveloperRole` 会通过校验、`getError()` 为空，但该字段被静默忽略。pix 应在写入前用已知 compat 键白名单（取自 `model-registry.ts:101-146` 的 schema 枚举）校验字段名，对未知键在 UI 给警告（非阻断），弥补内核不报错之缺。

#### 4.2.2 命令注册（复用 RpcCommand，不新增 IPC 通道）

- `pix/src/shared/types.ts` 的 `RpcCommand` 联合新增：
  ```ts
  | { id?: string; type: "get_custom_providers" }
  | { id?: string; type: "set_custom_providers"; providers: Record<string, CustomProviderConfig> }
  ```
- `pix/src/main/ipc-handlers.ts` `executeCommand` switch（`set_api_key` case 旁，`:863`）加两 case，调 `bridge.getCustomProviders()` / `bridge.setCustomProviders(providers)`。团队模式经 `team-leader-command` 自动路由到 `teamLeaderSessionBridge`，与 `set_api_key` 一致。
- **`preload.ts`/`PixApi` 无需改动**（走现有 `sendCommand`/`sendTeamLeaderCommand`）。
- `getCustomProviders` 不调 `_getSession()`，故无 session 也可读；`setCustomProviders` 写文件始终成功，refresh 与 `getError()` 仅在 session 活跃时执行，否则返回 `sessionActive:false`。

#### 4.2.3 与现有设置存储的关系

不把 providers 存入 `GuiSettings`。`GuiSettings` 仅继续存 `defaultProvider`/`defaultModel`——用户创建自定义 provider 后，可在「常规」分区把 `defaultProvider` 设为该自定义 provider 名。

### 4.3 pix renderer 层（设置面板 UI）

#### 4.3.1 新增侧栏分区「自定义模型」

`SettingsPage.vue`：`SettingsSection` 加 `"custom"`（`:23`），侧栏项 `{ key: "custom", label: "自定义模型", icon: "mdi-transit-connection-variant" }`；新建 `pix/src/renderer/components/settings/CustomProviders.vue`，在 `<div v-show="activeSection==='custom'">` 内挂载（参考 McpSettings 挂载方式 `:551-553`）。

#### 4.3.2 `CustomProviders.vue` 形态

经 `const rpc = useWorkspaceRpc()` 调用（与 McpSettings 一致，不直连 `window.pixApi`）：读取调 `rpc.getCustomProviders()`，保存调 `rpc.setCustomProviders(providers)`。`useRpc.ts` 内照 `setApiKey`（`:373`）模式加 `getCustomProviders`/`setCustomProviders` 助手并 return，`useWorkspaceRpc.ts` 照 `:70` 透传。

Vuetify 组件实现前须查 `G:\develop\pi\vuetify_guide` 验证用法（CLAUDE.md 硬性要求），用 `v-card`/`v-text-field`/`v-select`/`v-switch`/`v-list`（参考「认证」分区 `:561-583` 与 McpSettings）。

布局：
- 顶部说明：「添加第三方 provider 与中转站。配置写入 `~/.pi/agent/models.json`，保存后热加载。覆盖 anthropic/openai 等内置 provider 时只需填名称与 baseUrl。」
- Provider 列表：每项 `v-card`，展示 name/key、api、baseUrl、模型数、configured 状态；点击展开编辑。
- 「添加 Provider」按钮 -> 新增空表单。

Provider 编辑表单字段：
- **provider 名**（key，必填）：提示「填 `anthropic`/`openai` 覆盖内置 provider 走中转站；填新名字新增独立 provider」。
- **baseUrl**（必填）。
- **API 类型**（必填，`v-select`）：`anthropic-messages` / `openai-completions`（最兼容）/ `openai-responses` / `google-generative-ai`。
- **apiKey**（`type=password`，可填）：脱敏展示（已配置显示占位符，编辑时留空=不修改）；提示「可粘贴，或填 `$ENV_VAR` 引用环境变量」；附「清除密钥」按钮（发 null）。
- **authHeader**（`v-switch`）：仅 anthropic-messages 中转站且代理期望 `Authorization: Bearer` 而非 `x-api-key` 时开启（§4.5）。
- **headers**（可选，键值对编辑器）。
- **模型列表**：内联可增删 model 行（id 必填、name、reasoning 开关、input 多选、contextWindow、maxTokens）；提示「覆盖内置 provider 时留空即保留全部内置模型」。
- **高级**（折叠）：`compat` JSON 编辑器（写入前按已知 compat 键白名单校验字段名，未知键警告）、`modelOverrides` JSON 编辑器。
- 操作：保存、删除。

保存：`rpc.setCustomProviders(所有providers)` -> 成功后 `rpc.refreshModels()` + `authStore.refreshStatus()` + 重新 `rpc.getCustomProviders()` 回显；若返回 `schemaError` 非空，UI 顶部 `v-alert` 显式报错；若 `sessionActive:false`，提示「配置已保存，将在下次启动会话时校验」。

#### 4.3.3 与「认证」分区的协调（双源凭证防护）

因 `getApiKeyAndHeaders` 先取 auth.json 再回退 models.json apiKey（§2.1.3），存在双源风险：

1. **禁写**：在 `SessionBridge.setApiKey`/`removeAuth`（`session-bridge.ts:614/624`）对「provider 名存在于 models.json `providers` 中」的情形拒绝写 auth.json 并回错误提示；或在 `SettingsPage.vue` 认证分区（`:562-580`）对这类 provider 直接禁用/隐藏保存与删除按钮（非仅文案提示）。
2. **告警**：`CustomProviders` UI 对「覆盖内置 provider（如 anthropic）且 models.json 设了 apiKey、而该 provider 在 auth.json 已有 key」显式告警——models.json apiKey 不会生效（auth.json 优先），须先在认证分区删除该 provider 的 key；否则请求会打到中转站 URL 却携带 auth.json 的真实 key，把真实凭证泄漏给中转站。
3. custom provider 的凭证在「自定义模型」分区管理；认证分区对 custom provider 仍可展示 configured 状态（来自 models.json），但不提供设 key 入口。

### 4.4 热重载与团队模式

- **leader**：`setCustomProviders` 写文件 + `this._session.modelRegistry.refresh()`；经 RpcCommand 链路团队模式自动作用于 `teamLeaderSessionBridge`，leader 模型列表即时更新。
- **worker**：`agent-session-services.ts:152` 在未传 `modelRegistry` 时为每个会话 `new ModelRegistry.create(...)`；`team-manager.ts:866-877` 的 sessionFactory 不传 `modelRegistry`，故**每个 worker 持有独立 modelRegistry，与 leader 不共享**。`setCustomProviders` 须经 `TeamManager` 对每个 worker `session.modelRegistry.refresh()`（或触发 worker reload）；若暂不实现，UI 须明示「worker 会话需重启生效」。覆盖内置 provider 的 baseUrl 变更对 worker **非立即生效**。
- 刷新后 renderer 调 `rpc.refreshModels()`（`get_available_models`，`useWorkspaceRpc.ts:63`）+ `authStore.refreshStatus()`（`get_auth_status`，`auth-store.ts:31`）。

### 4.5 anthropic / openai 完美适配要点

1. **anthropic 中转站**
   - 覆盖内置：provider 名 `anthropic`，api `anthropic-messages`（可省略，沿用内置），baseUrl 中转站，不填 models（保留内置 claude 全系）。
   - 新增独立：provider 名自定，api `anthropic-messages`，baseUrl，apiKey，models 列出 claude id。
   - `authHeader`：anthropic SDK 用 apiKey 生成 `x-api-key`（`anthropic.ts:873-876`）；中转站若期望 `Authorization: Bearer` 而非 `x-api-key`，设 `authHeader: true`（由 `getApiKeyAndHeaders` 注入 Bearer 头）。
   - 兼容 quirks：`compat.supportsEagerToolInputStreaming=false`、`forceAdaptiveThinking=true`、`allowEmptySignature=true`。
2. **openai 中转站 / OpenAI 兼容服务器**
   - api `openai-completions`（最兼容，绝大多数中转站/ollama/vllm）或 `openai-responses`。
   - **Bearer 认证由 OpenAI SDK 经 apiKey 自动完成**（`openai-completions.ts:488-493`），`authHeader: true` 对 openai-completions 冗余、无需预填。
   - `compat.supportsDeveloperRole=false`、`compat.supportsReasoningEffort=false`、`compat.maxTokensField="max_tokens"`、`thinkingFormat` 按厂商选。
   - `cacheControlFormat: "anthropic"` 用于 OpenAI 兼容但暴露 Anthropic 风格缓存的站。

UI 在「API 类型」选择后，给出该类型常见 `compat` 预填建议（非强制）。

### 4.6 安全考量

- **文件权限**：写 models.json 后立即 `chmodSync(path, 0o600)`（对齐 `auth-storage.ts:111-112`；`writeFileSync` 的 `mode` 选项对已存在文件无效）。**Windows 上 0600 仅为象征性对齐 auth.json，不构成实际访问控制**（NTFS 不按 Unix mode 位强制 ACL，其他本地用户仍可读）——敏感 key 应优先用 `$ENV_VAR` 引用。
- **apiKey 脱敏**：`getCustomProviders` 返回前将 apiKey 替换为占位符 `SENTINEL` 并附 `hasApiKey`，**不回传明文**（避免明文经 IPC 进入 renderer）。
- **留空保留语义**：`setCustomProviders` 先重读磁盘 models.json；incoming apiKey === `SENTINEL` 拷磁盘原值（不修改），=== `null` 删字段（显式清除，由「清除密钥」按钮发出），其它用新值。
- **并发安全**：写采用「同目录临时文件 + `renameSync` 原子替换」（对读者要么见旧要么见新）+ proper-lockfile 包裹读-改-写（与 auth.json 一致），消除半截读与丢更新（§6.1）。
- 不把 models.json 内容打印到日志。

## 5. 代码改动点清单

| 文件 | 改动 |
|---|---|
| `pix/src/shared/custom-providers.ts` | 新增：models.json 子集 TS 类型 + `SENTINEL` 常量（§4.1）。 |
| `pix/src/shared/types.ts` | `RpcCommand` 联合新增 `get_custom_providers` / `set_custom_providers`（§4.2.2）。 |
| `pix/src/main/session-bridge.ts` | 新增 `getCustomProviders()` / `setCustomProviders()`：`join(getAgentDir(),"models.json")` 路径；脱敏/留空保留；临时文件+renameSync 原子写 + proper-lockfile；`chmodSync 0o600`；`modelRegistry.refresh()` + `getError()` 回传；团队 worker refresh（§4.2.1、§4.4）。`setApiKey`/`removeAuth` 增 models.json provider 拒写防护（§4.3.3）。 |
| `pix/src/main/ipc-handlers.ts` | `executeCommand` switch 加 `get_custom_providers` / `set_custom_providers` case（§4.2.2）。 |
| `pix/src/renderer/composables/useRpc.ts` | 照 `setApiKey`（`:373`）模式加 `getCustomProviders`/`setCustomProviders` 助手。 |
| `pix/src/renderer/composables/useWorkspaceRpc.ts` | 照 `:70` 透传两个新助手。 |
| `pix/src/renderer/pages/SettingsPage.vue` | 侧栏加 `custom` 分区；挂载 `CustomProviders`；认证分区对 models.json provider 禁用设 key（§4.3.3）。 |
| `pix/src/renderer/components/settings/CustomProviders.vue` | 新增：provider 列表 + 编辑表单（§4.3）。 |
| `pix/src/renderer/components/settings/ModelSettings.vue` | 可选：从空壳改为指向「自定义模型」分区的引导文案。 |

不改动：`ModelSelector.vue`（custom 模型经 `availableModels` 自动出现）、`preload.ts`/`PixApi`（复用 `sendCommand`）、`packages/*`（pi 内核）。

## 6. 边界、风险与未覆盖项

1. **并发写 models.json**：pi 对 auth.json 用 proper-lockfile，models.json 侧 pi 读（`loadCustomModels:535` `readFileSync`）无锁。`writeFileSync` 截断再写非原子，并发 refresh 会读到空/半截文件 -> `JSON.parse` 抛错 -> `loadError` -> custom 模型静默卸载。本方案用「临时文件 + `renameSync` 原子替换 + proper-lockfile 读-改-写」消除半截读与丢更新。
2. **与用户手编 models.json 冲突**：整体替换 `providers` 要求 UI 保存前已 `getCustomProviders` 拿全量；proper-lockfile 读-改-写降低窗口，但用户在 pix 写入瞬间手编仍可能被覆盖。可选：保存前重读对比（乐观锁）。
3. **apiKey 留空保留**：`SENTINEL` 占位符 + `null` 清除信号，main 层重读磁盘拷原值（§4.2.1/§4.6）。
4. **团队模式 worker**：worker 持有独立 modelRegistry（`agent-session-services.ts:152`、`team-manager.ts:866-877`），leader refresh 不影响 worker。须经 TeamManager refresh 每个 worker 或 UI 明示「worker 需重启生效」。
5. **schema 校验失败**：`getError()` 仅捕获已知字段类型错误与必填缺失，**不捕获未知 compat 字段名**（TypeBox 默认放行未知属性）。session 活跃时 `refresh` 后取 `getError()` 回传 `schemaError`；session 未启动时不校验，`loadError` 在下次 `createAgentSession` 时设置（延迟暴露，须在下次 `getCustomProviders` 推送）。pix 写入前用已知 compat 键白名单校验字段名，对未知键警告。
6. **覆盖内置 provider 的副作用**：改 `anthropic` baseUrl 会影响所有走 anthropic 的会话（含团队 worker，非立即）。UI 须警示。
7. **双源凭证泄漏**：覆盖内置 anthropic 且 auth.json 已有 key 时，请求打代理 URL 却带 auth.json 真实 key。防护见 §4.3.3。
8. **未覆盖**：OAuth 类型 custom provider（`pi.registerProvider` 的 `oauth`）不在 models.json 静态配置范围内，本方案不支持 GUI 配置（需求只要求 url+api-key）。

## 7. 验证方案

1. 新增 anthropic 中转站 provider（api=`anthropic-messages`，baseUrl+apiKey+一个 claude model id）-> 保存 -> `ModelSelector` 出现该模型 -> 发起会话验证请求打到中转站。
2. 覆盖内置 `anthropic` 只改 baseUrl -> 验证内置 claude 模型仍可选且请求走新 url，凭证仍用 auth.json 既有 key；**且 auth.json 已有 anthropic key 时 UI 告警**（§4.3.3）。
3. 新增 openai 兼容中转站（api=`openai-completions`，`compat.supportsDeveloperRole=false`）-> 验证 Bearer 认证由 SDK 自动完成（不设 authHeader）、reasoning 模型与 tool call 正常。
4. models.json 写入非法 compat（已知字段类型错误）-> UI 显示 `schemaError`，不 crash；写入未知 compat 字段名（如 `supportDeveloperRole`）-> UI 白名单警告，`getError()` 为空但字段被静默忽略。
5. 会话未启动时编辑保存 -> 提示「下次启动生效」（`sessionActive:false`）；启动会话后 `getCustomProviders` 推送 `schemaError`（若非法）或模型可用。
6. 删除一个 custom provider -> 模型从 `ModelSelector` 消失。
7. 文件权限：`~/.pi/agent/models.json` 为 0600（Linux/macOS）；Windows 注明仅为象征性对齐。
8. **并发写**：两 pix 会话同时编辑保存 -> 不丢更新（proper-lockfile）、不产生半截文件（renameSync 原子）。
9. **团队模式**：覆盖 anthropic baseUrl 后 leader 即时走新 URL；worker 经 TeamManager refresh 后走新 URL（或 UI 明示需重启）。
10. **凭证隔离**：custom provider 在认证分区的「设 key」入口被禁用/拒绝；尝试对 models.json provider 调 `setApiKey` 返回错误。

---

## 附录：评审裁决摘要

本方案经三视角（pi 内核可行性 / pix 产品架构 / 安全与边界）并行评审，3 子代理 78 次工具调用实地考察源码，共提出 13 条意见（去重 10 个独立点）。逐条裁决如下，全部采纳并吸收改写：

| # | 意见 | 裁决 | 落点 |
|---|---|---|---|
| 1 | `getModelsPath` 未从 `@earendil-works/pi-coding-agent` 公开导出（`index.ts:6`、`package.json` exports），import 会编译失败 | 采纳 | §2.2/§4.2.1/§5 改用 `join(getAgentDir(),"models.json")` |
| 2 | models.json apiKey 不走 AuthStorage fallbackResolver，实由 `ModelRegistry.getApiKeyAndHeaders`（`:756-764`）先 auth.json 后 models.json 解析 | 采纳 | §2.1.3/§3.3 更正机制描述 |
| 3 | TypeBox schema 未设 `additionalProperties:false`，`getError()` 不捕获未知 compat 字段名 | 采纳 | §3.2/§4.2.1/§6.5 更正 + 写入前白名单校验 |
| 4 | openai-completions 的 Bearer 由 SDK 自动完成，`authHeader` 冗余；authHeader 仅对 anthropic 中转站有意义 | 采纳 | §4.5 更正 |
| 5 | 独立 IPC 通道在团队模式下 leader 不刷新；应端到端复用 RpcCommand | 采纳 | §3.1/§3.4/§4.2.2/§5 重构为 RpcCommand 链路 |
| 6 | `getError()` 依赖 ModelRegistry 实例，无 session 矛盾；返回类型缺 `schemaError` 字段 | 采纳 | §4.2.1/§4.3.2/§6.5 加 `schemaError` + 延迟校验 |
| 7 | 双源凭证泄漏陷阱（覆盖内置 provider 时 auth.json key 被带去中转站） | 采纳 | §3.3/§4.3.3/§6.7 禁写 + 告警 |
| 8 | models.json 写非原子，并发 refresh 读半截致 custom 静默卸载 | 采纳 | §4.2.1/§4.6/§6.1 临时文件+renameSync+proper-lockfile |
| 9 | apiKey 脱敏与留空保留缺实现机制 | 采纳 | §4.2.1/§4.6 SENTINEL+hasApiKey+null 清除 |
| 10 | 团队 worker 独立 modelRegistry，leader refresh 不影响 worker | 采纳 | §4.4/§6.4 经 TeamManager refresh 或明示重启 |

另：0600 权限 `writeFileSync` mode 对已存在文件无效、Windows 仅象征性 -> §4.2.1/§4.6/§7.7 固定后置 `chmodSync` 并注明 Windows 限制。

无意见被拒绝。所有采纳意见均基于具体代码行号证据，且不涉及需求范围扩展。
