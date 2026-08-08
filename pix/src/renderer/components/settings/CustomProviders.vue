<script setup lang="ts">
/**
 * Custom Providers Settings Panel
 *
 * 第三方 provider 与中转站管理。读写 ~/.pi/agent/models.json，保存后热加载。
 * apiKey 经 IPC 脱敏为 SENTINEL：已配置时占位展示，留空不修改；清除按钮发 null。
 * 保存提交全部 providers（整体替换），由 main 层重读磁盘做留空保留。
 *
 * compat 采用「预设 + 结构化开关 + JSON 覆盖」三层：预设一键设定 thinkingFormat
 * 等 5 个关键字段（OpenAI/OpenRouter/Together/DeepSeek/Qwen/Zai/纯透传），开关可
 * 细调并自动回写预设为「自定义」，JSON 覆盖合并于其上。thinkingLevelMap 按模型分别
 * 配置，落实「模型自声明支持的推理档位」。
 */
import { ref, computed, watch, onMounted } from "vue";
import { useWorkspaceRpc } from "../../composables/useWorkspaceRpc";
import { useAuthStore } from "../../stores/auth-store";
import { SENTINEL } from "../../../shared/custom-providers";
import type { CustomProviderConfig, CustomModelConfig, CustomApi } from "../../../shared/custom-providers";

interface GetCustomProvidersResult {
  providers: Record<string, CustomProviderConfig>;
  schemaError?: string;
}

interface SetCustomProvidersResult {
  success: boolean;
  schemaError?: string;
  sessionActive: boolean;
  workersStale?: boolean;
  error?: string;
}

interface HeaderEntry {
  key: string;
  value: string;
}

type CompatPreset =
	| "openai"
	| "openrouter"
	| "together"
	| "deepseek"
	| "qwen"
	| "zai"
	| "passthrough"
	| "custom";

type MaxTokensField = "max_completion_tokens" | "max_tokens";

interface ModelDraft {
	id: string;
	name?: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMapJson: string;
	thinkingLevelMapError: string;
	showThinking: boolean;
}

interface ProviderDraft {
	/** providers map 的 key，即 provider 名 */
	key: string;
	/** 活配置（apiKey/compat 已剥离，由独立字段管理）；保留 modelOverrides/name 等未暴露字段 */
	config: Omit<CustomProviderConfig, "models" | "compat" | "apiKey"> & { models: ModelDraft[] };
	/** 加载时 apiKey === SENTINEL，即已配置 */
	keyConfigured: boolean;
	apiKeyInput: string;
	apiKeyCleared: boolean;
	headerEntries: HeaderEntry[];
	compatPreset: CompatPreset;
	compatThinkingFormat: string;
	compatSupportsReasoningEffort: boolean;
	compatSupportsStore: boolean;
	compatSupportsDeveloperRole: boolean;
	compatMaxTokensField: MaxTokensField;
	compatOverrideJson: string;
	compatOverrideError: string;
	compatOverrideWarning: string;
	showAdvanced: boolean;
	expanded: boolean;
}

const rpc = useWorkspaceRpc() as ReturnType<typeof useWorkspaceRpc> & {
	getCustomProviders(): Promise<GetCustomProvidersResult>;
	setCustomProviders(providers: Record<string, CustomProviderConfig>): Promise<SetCustomProvidersResult>;
};
const authStore = useAuthStore();

const loading = ref(true);
const saving = ref(false);
const drafts = ref<ProviderDraft[]>([]);
const loadError = ref("");
const saveError = ref("");
const savedNotice = ref("");

const apiTypeItems: { title: string; value: CustomApi }[] = [
	{ title: "anthropic-messages", value: "anthropic-messages" },
	{ title: "openai-completions（最兼容）", value: "openai-completions" },
	{ title: "openai-responses", value: "openai-responses" },
	{ title: "google-generative-ai", value: "google-generative-ai" },
];

const inputItems = [
	{ title: "text", value: "text" },
	{ title: "image", value: "image" },
];

const presetItems: { title: string; value: CompatPreset }[] = [
	{ title: "OpenAI 标准", value: "openai" },
	{ title: "OpenRouter", value: "openrouter" },
	{ title: "Together", value: "together" },
	{ title: "DeepSeek", value: "deepseek" },
	{ title: "Qwen", value: "qwen" },
	{ title: "Zai", value: "zai" },
	{ title: "纯透传（不发 reasoning）", value: "passthrough" },
	{ title: "自定义", value: "custom" },
];

const thinkingFormatItems: { title: string; value: string }[] = [
	{ title: "openai（reasoning_effort）", value: "openai" },
	{ title: "openrouter（reasoning.effort）", value: "openrouter" },
	{ title: "together", value: "together" },
	{ title: "deepseek", value: "deepseek" },
	{ title: "zai（enable_thinking）", value: "zai" },
	{ title: "qwen（enable_thinking）", value: "qwen" },
	{ title: "qwen-chat-template", value: "qwen-chat-template" },
];

const maxTokensFieldItems: { title: string; value: MaxTokensField }[] = [
	{ title: "max_completion_tokens", value: "max_completion_tokens" },
	{ title: "max_tokens", value: "max_tokens" },
];

const COMPAT_PRESETS: Record<Exclude<CompatPreset, "custom">, {
	thinkingFormat: string;
	supportsReasoningEffort: boolean;
	supportsStore: boolean;
	supportsDeveloperRole: boolean;
	maxTokensField: MaxTokensField;
}> = {
	openai: { thinkingFormat: "openai", supportsReasoningEffort: true, supportsStore: true, supportsDeveloperRole: true, maxTokensField: "max_completion_tokens" },
	openrouter: { thinkingFormat: "openrouter", supportsReasoningEffort: true, supportsStore: true, supportsDeveloperRole: false, maxTokensField: "max_completion_tokens" },
	together: { thinkingFormat: "together", supportsReasoningEffort: false, supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
	deepseek: { thinkingFormat: "deepseek", supportsReasoningEffort: true, supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_completion_tokens" },
	qwen: { thinkingFormat: "qwen", supportsReasoningEffort: true, supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_completion_tokens" },
	zai: { thinkingFormat: "zai", supportsReasoningEffort: false, supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_completion_tokens" },
	passthrough: { thinkingFormat: "openai", supportsReasoningEffort: false, supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
};

const STRUCTURED_COMPAT_KEYS = ["thinkingFormat", "supportsReasoningEffort", "supportsStore", "supportsDeveloperRole", "maxTokensField"];

// Union of every compat field name the kernel recognizes across all api types
// (OpenAICompletionsCompat ∪ OpenAIResponsesCompat ∪ AnthropicMessagesCompat).
// Used to surface a non-blocking warning on unknown override keys. The TypeBox
// schema does not set additionalProperties:false, so unknown keys do not hard-
// fail validation, but they are silently inert -- warn so the user notices.
const KNOWN_COMPAT_KEYS = new Set<string>([
	// OpenAICompletionsCompat
	"supportsStore", "supportsDeveloperRole", "supportsReasoningEffort", "supportsUsageInStreaming",
	"maxTokensField", "requiresToolResultName", "requiresAssistantAfterToolResult", "requiresThinkingAsText",
	"requiresReasoningContentOnAssistantMessages", "thinkingFormat", "openRouterRouting", "vercelGatewayRouting",
	"zaiToolStream", "supportsStrictMode", "cacheControlFormat", "sendSessionAffinityHeaders", "supportsLongCacheRetention",
	// OpenAIResponsesCompat
	"sendSessionIdHeader", "supportsReasoningEffort",
	// AnthropicMessagesCompat
	"supportsEagerToolInputStreaming", "supportsCacheControlOnTools", "supportsTemperature", "forceAdaptiveThinking", "allowEmptySignature",
]);

// baseUrl contract differs per api: anthropic SDK appends /v1/messages (so
// baseUrl must NOT include /v1); openai-completions/responses append
// /chat/completions (baseUrl MUST include /v1); google uses /v1beta.
function baseUrlHints(api: CustomApi | undefined): { placeholder: string; hint: string } {
	switch (api) {
		case "anthropic-messages":
			return { placeholder: "https://proxy.example.com", hint: "不要含 /v1（SDK 自动追加 /v1/messages）；保存时自动去除尾部斜杠。" };
		case "google-generative-ai":
			return { placeholder: "https://generativelanguage.googleapis.com/v1beta", hint: "须含版本路径（如 /v1beta）；保存时自动去除尾部斜杠。" };
		case "openai-completions":
		case "openai-responses":
			return { placeholder: "https://api.example.com/v1", hint: "须含版本路径（如 /v1）；保存时自动去除尾部斜杠。" };
		default:
			return { placeholder: "https://api.example.com/v1", hint: "须含版本路径（如 /v1）；保存时自动去除尾部斜杠。" };
	}
}

// The 5 structured compat fields + presets are consumed ONLY by openai-completions.
// For other api types the structured section is hidden; this note lists the
// compat fields that api type actually reads, so the user knows what the
// override JSON can usefully set.
function nonOpenAiCompatNote(api: CustomApi | undefined): string {
	switch (api) {
		case "anthropic-messages":
			return "上方 5 个开关主要面向 openai-completions，对 anthropic-messages 多为无效；其专属 compat 字段在下方「覆盖 JSON」配置：supportsEagerToolInputStreaming、supportsLongCacheRetention、sendSessionAffinityHeaders、supportsCacheControlOnTools、supportsTemperature、forceAdaptiveThinking、allowEmptySignature。";
		case "openai-responses":
			return "openai-responses 读取 supportsReasoningEffort（上方开关）以及 sendSessionIdHeader、supportsLongCacheRetention（下方「覆盖 JSON」）；其余开关对 openai-responses 无效。";
		case "google-generative-ai":
			return "google-generative-ai 不读取 compat，上方开关与覆盖 JSON 均不生效。";
		default:
			return "";
	}
}

// auth.json wins over models.json apiKey (model-registry getApiKeyAndHeaders
// resolves authStorage FIRST). source==="stored" means auth.json holds a key
// for this provider name, so the models.json apiKey edited here will NOT take
// effect and the auth.json key is what reaches the relay baseUrl.
function authJsonOverridesKey(draft: ProviderDraft): boolean {
	return authStore.authStatus[draft.key]?.source === "stored";
}

function compatToDraftState(cfg: CustomProviderConfig): {
	preset: CompatPreset;
	thinkingFormat: string;
	supportsReasoningEffort: boolean;
	supportsStore: boolean;
	supportsDeveloperRole: boolean;
	maxTokensField: MaxTokensField;
	overrideJson: string;
} {
	const c = (cfg.compat ?? {}) as Record<string, unknown>;
	const thinkingFormat = typeof c.thinkingFormat === "string" ? c.thinkingFormat : "openai";
	const supportsReasoningEffort = c.supportsReasoningEffort !== false;
	const supportsStore = c.supportsStore !== false;
	const supportsDeveloperRole = c.supportsDeveloperRole !== false;
	const maxTokensField: MaxTokensField = c.maxTokensField === "max_tokens" ? "max_tokens" : "max_completion_tokens";
	let preset: CompatPreset = "custom";
	for (const [key, p] of Object.entries(COMPAT_PRESETS)) {
		if (
			thinkingFormat === p.thinkingFormat &&
			supportsReasoningEffort === p.supportsReasoningEffort &&
			supportsStore === p.supportsStore &&
			supportsDeveloperRole === p.supportsDeveloperRole &&
			maxTokensField === p.maxTokensField
		) {
			preset = key as CompatPreset;
			break;
		}
	}
	// The 5 structured fields are captured by the switches (shown for every api
	// type); keep only the non-structured keys in the override JSON so it holds
	// the api-specific extras (e.g. anthropic's forceAdaptiveThinking).
	const override: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(c)) {
		if (STRUCTURED_COMPAT_KEYS.includes(k)) continue;
		override[k] = v;
	}
	const overrideJson = Object.keys(override).length ? JSON.stringify(override, null, 2) : "";
	return { preset, thinkingFormat, supportsReasoningEffort, supportsStore, supportsDeveloperRole, maxTokensField, overrideJson };
}

function applyPreset(draft: ProviderDraft, preset: CompatPreset): void {
	draft.compatPreset = preset;
	if (preset === "custom") return;
	const p = COMPAT_PRESETS[preset];
	draft.compatThinkingFormat = p.thinkingFormat;
	draft.compatSupportsReasoningEffort = p.supportsReasoningEffort;
	draft.compatSupportsStore = p.supportsStore;
	draft.compatSupportsDeveloperRole = p.supportsDeveloperRole;
	draft.compatMaxTokensField = p.maxTokensField;
}

function syncPreset(draft: ProviderDraft): void {
	for (const [key, p] of Object.entries(COMPAT_PRESETS)) {
		if (
			draft.compatThinkingFormat === p.thinkingFormat &&
			draft.compatSupportsReasoningEffort === p.supportsReasoningEffort &&
			draft.compatSupportsStore === p.supportsStore &&
			draft.compatSupportsDeveloperRole === p.supportsDeveloperRole &&
			draft.compatMaxTokensField === p.maxTokensField
		) {
			draft.compatPreset = key as CompatPreset;
			return;
		}
	}
	draft.compatPreset = "custom";
}

function toDraft(key: string, cfg: CustomProviderConfig): ProviderDraft {
	const configured = cfg.apiKey === SENTINEL;
	const cs = compatToDraftState(cfg);
	const draft: ProviderDraft = {
		key,
		config: {
			name: cfg.name,
			baseUrl: cfg.baseUrl ?? "",
			api: cfg.api,
			authHeader: cfg.authHeader ?? false,
			headers: cfg.headers,
			modelOverrides: cfg.modelOverrides,
			models: (cfg.models ?? []).map((m) => ({
				id: m.id ?? "",
				name: m.name,
				reasoning: m.reasoning ?? false,
				input: m.input ? [...m.input] : [],
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				thinkingLevelMapJson: m.thinkingLevelMap ? JSON.stringify(m.thinkingLevelMap, null, 2) : "",
				thinkingLevelMapError: "",
				showThinking: false,
			})),
		},
		keyConfigured: configured,
		apiKeyInput: "",
		apiKeyCleared: false,
		headerEntries: Object.entries(cfg.headers ?? {}).map(([k, v]) => ({ key: k, value: v })),
		compatPreset: cs.preset,
		compatThinkingFormat: cs.thinkingFormat,
		compatSupportsReasoningEffort: cs.supportsReasoningEffort,
		compatSupportsStore: cs.supportsStore,
		compatSupportsDeveloperRole: cs.supportsDeveloperRole,
		compatMaxTokensField: cs.maxTokensField,
		compatOverrideJson: cs.overrideJson,
		compatOverrideError: "",
		compatOverrideWarning: "",
		showAdvanced: false,
		expanded: false,
	};
	// Surface override warnings (unknown / structured keys) immediately on load.
	validateOverride(draft);
	return draft;
}

async function load(): Promise<void> {
	loading.value = true;
	loadError.value = "";
	try {
		const result = await rpc.getCustomProviders();
		drafts.value = Object.entries(result.providers).map(([key, cfg]) => toDraft(key, cfg));
		if (result.schemaError) loadError.value = result.schemaError;
	} catch (err) {
		loadError.value = err instanceof Error ? err.message : String(err);
	} finally {
		loading.value = false;
	}
}

function addDraft(): void {
	drafts.value.push({
		key: "",
		config: {
			api: "openai-completions",
			baseUrl: "",
			authHeader: false,
			models: [],
		},
		keyConfigured: false,
		apiKeyInput: "",
		apiKeyCleared: false,
		headerEntries: [],
		compatPreset: "openai",
		compatThinkingFormat: "openai",
		compatSupportsReasoningEffort: true,
		compatSupportsStore: true,
		compatSupportsDeveloperRole: true,
		compatMaxTokensField: "max_completion_tokens",
		compatOverrideJson: "",
		compatOverrideError: "",
		compatOverrideWarning: "",
		showAdvanced: false,
		expanded: true,
	});
}

function toggleExpand(idx: number): void {
	drafts.value[idx].expanded = !drafts.value[idx].expanded;
}

function clearKey(draft: ProviderDraft): void {
	draft.apiKeyCleared = true;
	draft.apiKeyInput = "";
}

function addModel(draft: ProviderDraft): void {
	draft.config.models.push({
		id: "",
		reasoning: false,
		input: ["text"],
		thinkingLevelMapJson: "",
		thinkingLevelMapError: "",
		showThinking: false,
	});
}

function removeModel(draft: ProviderDraft, idx: number): void {
	draft.config.models.splice(idx, 1);
}

function addHeader(draft: ProviderDraft): void {
	draft.headerEntries.push({ key: "", value: "" });
}

function removeHeader(draft: ProviderDraft, idx: number): void {
	draft.headerEntries.splice(idx, 1);
}

function validateOverride(draft: ProviderDraft): void {
	const text = draft.compatOverrideJson.trim();
	draft.compatOverrideError = "";
	draft.compatOverrideWarning = "";
	if (!text) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		draft.compatOverrideError = e instanceof Error ? e.message : String(e);
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		draft.compatOverrideError = "覆盖 JSON 必须是对象";
		return;
	}
	const obj = parsed as Record<string, unknown>;
	const warnings: string[] = [];
	// #16: the 5 structured fields are switch-controlled; a same-named key in
	// the override would silently win on save, so it is ignored there (see
	// buildAndValidate) -- warn the user it has no effect.
	const structured = Object.keys(obj).filter((k) => STRUCTURED_COMPAT_KEYS.includes(k));
	if (structured.length) {
		warnings.push(`结构化字段（${structured.join("、")}）由上方开关控制，覆盖 JSON 中的同名键将被忽略。`);
	}
	// #13: unknown compat keys are inert (schema has no additionalProperties:
	// false) but almost always a mistake -- surface a non-blocking warning.
	const unknown = Object.keys(obj).filter((k) => !KNOWN_COMPAT_KEYS.has(k));
	if (unknown.length) {
		warnings.push(`未知 compat 字段（${unknown.join("、")}），可能不被内核识别。`);
	}
	draft.compatOverrideWarning = warnings.join(" ");
}

function validateThinkingLevelMap(m: ModelDraft): void {
	const text = m.thinkingLevelMapJson.trim();
	m.thinkingLevelMapError = "";
	if (!text) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		m.thinkingLevelMapError = e instanceof Error ? e.message : String(e);
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		m.thinkingLevelMapError = "thinkingLevelMap 必须是 JSON 对象";
		return;
	}
	// ThinkingLevelMapValueSchema = string | null. A non-string/non-null value
	// fails whole-config validation and drops ALL custom providers, so validate
	// per-value here and give a field-level error naming the offending keys.
	const obj = parsed as Record<string, unknown>;
	const bad = Object.entries(obj).filter(([, v]) => v !== null && typeof v !== "string").map(([k]) => k);
	if (bad.length) {
		m.thinkingLevelMapError = `thinkingLevelMap 的值必须为字符串或 null，以下键的值非法：${bad.join("、")}`;
	}
}

function toNum(v: unknown): number | undefined {
	if (typeof v === "number") return v > 0 ? v : undefined;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	}
	return undefined;
}

function buildAndValidate(): { record: Record<string, CustomProviderConfig> } | { error: string } {
	const record: Record<string, CustomProviderConfig> = {};
	const seen = new Set<string>();
	// #12: collect ALL validation errors across providers instead of aborting on
	// the first, so one invalid provider does not hide the others. Save still
	// aborts if any error exists (cannot write a config that would fail whole-
	// config validation), but the user sees every problem at once.
	const errors: string[] = [];
	for (const draft of drafts.value) {
		const key = draft.key.trim();
		if (!key) { errors.push("Provider 名不能为空。"); continue; }
		if (seen.has(key)) { errors.push(`Provider 名「${key}」重复。`); continue; }
		seen.add(key);

		const baseUrl = (draft.config.baseUrl ?? "").trim().replace(/\/+$/, "");
		if (!baseUrl) errors.push(`Provider「${key}」的 baseUrl 不能为空。`);

		// compat：5 个结构化字段由开关控制（所有 api 类型），覆盖 JSON 合并其上的额外
		// 字段（如各 api 类型的专属 compat）；同名结构化键跳过，开关始终是唯一真相源（#16）。
		let compat: Record<string, unknown> | undefined;
		const overrideText = draft.compatOverrideJson.trim();
		let overrideParsed: Record<string, unknown> | undefined;
		if (overrideText) {
			try {
				const parsed = JSON.parse(overrideText);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					errors.push(`Provider「${key}」的 compat 覆盖 JSON 必须是对象。`);
				} else {
					overrideParsed = parsed as Record<string, unknown>;
				}
			} catch (e) {
				errors.push(`Provider「${key}」的 compat 覆盖 JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
			}
		}
		const structured: Record<string, unknown> = {
			thinkingFormat: draft.compatThinkingFormat,
			supportsReasoningEffort: draft.compatSupportsReasoningEffort,
			supportsStore: draft.compatSupportsStore,
			supportsDeveloperRole: draft.compatSupportsDeveloperRole,
			maxTokensField: draft.compatMaxTokensField,
		};
		if (overrideParsed) {
			for (const [k, v] of Object.entries(overrideParsed)) {
				if (!STRUCTURED_COMPAT_KEYS.includes(k)) structured[k] = v;
			}
		}
		compat = structured;

		// 模型（按模型 thinkingLevelMap）
		const models: CustomModelConfig[] = [];
		for (const m of draft.config.models) {
			const id = (m.id ?? "").trim();
			if (!id) continue;
			const out: CustomModelConfig = { id };
			if (m.name?.trim()) out.name = m.name.trim();
			if (m.reasoning) out.reasoning = true;
			if (m.input && m.input.length) out.input = m.input;
			const cw = toNum(m.contextWindow);
			if (cw !== undefined) out.contextWindow = cw;
			const mt = toNum(m.maxTokens);
			if (mt !== undefined) out.maxTokens = mt;
			const tlmText = m.thinkingLevelMapJson.trim();
			if (tlmText) {
				try {
					const parsed = JSON.parse(tlmText);
					if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
						errors.push(`Provider「${key}」模型「${id}」的 thinkingLevelMap 必须是 JSON 对象。`);
					} else {
						// #7: defend ThinkingLevelMapValueSchema (string | null) at build time
						// too, so a stale draft that was never blurred cannot ship an invalid
						// map that drops ALL custom providers.
						const tlmObj = parsed as Record<string, unknown>;
						const badTlm = Object.entries(tlmObj)
							.filter(([, v]) => v !== null && typeof v !== "string")
							.map(([k]) => k);
						if (badTlm.length) {
							errors.push(`Provider「${key}」模型「${id}」的 thinkingLevelMap 值必须为字符串或 null，非法键：${badTlm.join("、")}。`);
						} else {
							out.thinkingLevelMap = tlmObj as Record<string, string | null>;
						}
					}
				} catch (e) {
					errors.push(`Provider「${key}」模型「${id}」的 thinkingLevelMap JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
				}
			}
			models.push(out);
		}

		const headers: Record<string, string> = {};
		for (const h of draft.headerEntries) {
			const hk = h.key.trim();
			if (hk) headers[hk] = h.value;
		}

		const cfg: CustomProviderConfig = {
			baseUrl,
			api: draft.config.api,
			authHeader: draft.config.authHeader,
		};
		if (compat && Object.keys(compat).length) cfg.compat = compat;
		if (draft.config.name) cfg.name = draft.config.name;
		if (Object.keys(headers).length) cfg.headers = headers;
		if (models.length) cfg.models = models;
		if (draft.config.modelOverrides) cfg.modelOverrides = draft.config.modelOverrides;

		// apiKey：清除发 null；输入新值发原值；已配置未改发 SENTINEL（留空保留）；否则不设字段
		if (draft.apiKeyCleared) {
			(cfg as { apiKey?: string | null }).apiKey = null;
		} else if (draft.apiKeyInput.trim()) {
			cfg.apiKey = draft.apiKeyInput.trim();
		} else if (draft.keyConfigured) {
			cfg.apiKey = SENTINEL;
		} else {
			delete cfg.apiKey;
		}

		record[key] = cfg;
	}
	if (errors.length) return { error: errors.join("\n") };
	return { record };
}

async function saveAll(): Promise<void> {
	saveError.value = "";
	savedNotice.value = "";
	const built = buildAndValidate();
	if ("error" in built) {
		saveError.value = built.error;
		return;
	}
	saving.value = true;
	try {
		const result = await rpc.setCustomProviders(built.record);
		if (result.error) {
			saveError.value = result.error;
			return;
		}
		try {
			await rpc.refreshModels();
		} catch {
			// 无活动会话时刷新模型列表可能失败，忽略
		}
		try {
			await authStore.refreshStatus();
		} catch {
			// 忽略
		}
		await load();
		// load() already surfaces schemaError via loadError; only set saveError
		// when it differs (e.g. load() failed) to avoid a duplicate red alert.
		if (result.schemaError && loadError.value !== result.schemaError) {
			saveError.value = result.schemaError;
		}
		if (result.workersStale) {
			savedNotice.value = "配置已保存。团队模式下 worker 会话需重启后生效，leader 已即时更新。";
		} else if (result.sessionActive === false) {
			savedNotice.value = "配置已保存，将在下次启动会话时校验。";
		}
	} catch (err) {
		saveError.value = err instanceof Error ? err.message : String(err);
	} finally {
		saving.value = false;
	}
}

// #11: confirm before persisting a deletion (no undo). The dialog is bound to
// pendingDeleteIdx via a computed so closing it clears the pending index.
const pendingDeleteIdx = ref<number | null>(null);
const deleteDialogOpen = computed({
	get: () => pendingDeleteIdx.value !== null,
	set: (open: boolean) => { if (!open) pendingDeleteIdx.value = null; },
});
const deleteTargetName = computed(() => {
	const idx = pendingDeleteIdx.value;
	return idx !== null ? (drafts.value[idx]?.key || "（未命名）") : "";
});

function requestDelete(idx: number): void {
	pendingDeleteIdx.value = idx;
}

async function confirmDelete(): Promise<void> {
	const idx = pendingDeleteIdx.value;
	pendingDeleteIdx.value = null;
	if (idx === null) return;
	await deleteProvider(idx);
}

async function deleteProvider(idx: number): Promise<void> {
	drafts.value.splice(idx, 1);
	await saveAll();
	// #6: if the save did not persist (a sibling validation error aborted the
	// whole-file write), re-sync drafts from disk so the UI matches what is
	// actually stored -- otherwise the deleted provider vanishes from the UI
	// but remains on disk. (Generic saveAll validation errors are NOT reloaded;
	// only delete re-syncs, so in-progress edits elsewhere are preserved.)
	if (saveError.value) {
		await load();
	}
}

onMounted(load);

// #15: only onMounted loads; a session-less invalid write's deferred schemaError
// would not surface until a remount. SettingsPage renders this panel with v-show
// (always mounted while on /settings), so if a session becomes active while the
// panel stays mounted, re-run load() so the now-available schemaError surfaces.
// Guards false->true only (a stopping session has no deferred schemaError) and
// skips while a save/load is in flight to avoid clobbering in-progress work.
watch(
	() => rpc.isConnected.value,
	(connected, prev) => {
		if (connected && !prev && !saving.value && !loading.value) {
			void load();
		}
	},
);
</script>

<template>
  <div class="section-panel">
    <div class="d-flex align-center justify-space-between mb-4">
      <div>
        <h2 class="section-title">自定义模型</h2>
        <p class="section-desc">
          添加第三方 provider 与中转站。配置写入
          <code>~/.pi/agent/models.json</code>，保存后热加载。
          覆盖 anthropic/openai 等内置 provider 时只需填名称与 baseUrl。
        </p>
      </div>
      <div class="d-flex align-center" style="gap: var(--pix-space-sm);">
        <v-btn color="primary" :loading="saving" @click="saveAll">保存全部</v-btn>
        <v-btn color="primary" variant="outlined" prepend-icon="mdi-plus" @click="addDraft">
          添加 Provider
        </v-btn>
      </div>
    </div>

    <div class="inline-hint mb-3">
      保存采用整体替换：任一 Provider 卡片或上方「保存全部」按钮都会写入<strong>全部</strong> Provider 配置。
      每张卡片独立校验，但保存时所有错误会一并列出，修复后再次保存即生效。
    </div>

    <v-alert v-if="loadError" type="error" closable density="compact" class="mb-4">
      {{ loadError }}
    </v-alert>
    <v-alert v-if="saveError" type="error" closable density="compact" class="mb-4">
      {{ saveError }}
    </v-alert>
    <v-alert v-if="savedNotice" type="info" closable density="compact" class="mb-4">
      {{ savedNotice }}
    </v-alert>

    <div v-if="loading && drafts.length === 0" class="mb-4">
      <v-skeleton-loader v-for="i in 2" :key="i" type="card" class="mb-3" />
    </div>

    <v-alert v-else-if="drafts.length === 0" type="info" density="compact" class="mb-4">
      未配置自定义 provider。点击「添加 Provider」新建。
    </v-alert>

    <div v-if="drafts.length > 0" class="provider-list mb-4">
      <v-card
        v-for="(draft, idx) in drafts"
        :key="idx"
        variant="outlined"
        :border="draft.keyConfigured ? 'success' : undefined"
        class="provider-card mb-3"
      >
        <div class="provider-header" @click="toggleExpand(idx)">
          <div class="provider-info">
            <span class="provider-name">{{ draft.key || "（未命名）" }}</span>
            <v-chip v-if="draft.config.api" size="x-small" variant="tonal" :text="draft.config.api" label />
            <span class="provider-baseurl text-caption text-medium-emphasis">
              {{ draft.config.baseUrl || "未设置 baseUrl" }}
            </span>
          </div>
          <div class="provider-meta">
            <v-icon
              size="small"
              :color="draft.keyConfigured ? 'success' : undefined"
              :icon="draft.keyConfigured ? 'mdi-check-circle' : 'mdi-circle-outline'"
            />
            <span class="text-caption">{{ draft.keyConfigured ? "已配置" : "未配置" }}</span>
            <span class="text-caption text-medium-emphasis">{{ draft.config.models?.length ?? 0 }} 个模型</span>
            <v-icon size="small" class="ml-2">{{ draft.expanded ? "mdi-chevron-up" : "mdi-chevron-down" }}</v-icon>
          </div>
        </div>

        <div v-if="draft.expanded" class="provider-edit">
          <v-text-field
            v-model="draft.key"
            label="Provider 名"
            required
            hint="填 anthropic/openai 覆盖内置 provider 走中转站；填新名字新增独立 provider。"
            persistent-hint
            density="comfortable"
            class="mb-3"
          />
          <v-text-field
            v-model="draft.config.baseUrl"
            label="baseUrl"
            required
            :placeholder="baseUrlHints(draft.config.api).placeholder"
            :hint="baseUrlHints(draft.config.api).hint"
            persistent-hint
            density="comfortable"
            class="mb-3"
          />
          <v-select
            v-model="draft.config.api"
            :items="apiTypeItems"
            label="API 类型"
            hint="openai-completions 最兼容，适配大多数中转站与 OpenAI 兼容服务器。"
            persistent-hint
            density="comfortable"
            class="mb-3"
          />

          <v-alert
            v-if="authJsonOverridesKey(draft)"
            type="warning"
            density="compact"
            variant="tonal"
            class="mb-3"
          >
            检测到 auth.json 已为「{{ draft.key }}」保存密钥（状态来源 stored）。auth.json
            优先级高于 models.json 的 apiKey，下方填写的密钥<strong>不会生效</strong>，实际发往中转站的是
            auth.json 中的密钥。若要使用此处配置的中转专用密钥，需先清除 auth.json 中该 provider 的密钥：
            由于「认证」分区在存在同名自定义 provider 时会拦截删除，请先临时改名本 provider 并保存，再到
            「认证」分区删除密钥，最后改回名称并填写中转密钥。
          </v-alert>

          <div class="field-row mb-3">
            <v-text-field
              v-if="!draft.apiKeyCleared"
              v-model="draft.apiKeyInput"
              type="password"
              :label="`API Key${draft.keyConfigured ? '（已配置）' : ''}`"
              :placeholder="draft.keyConfigured ? '留空不修改；输入新值替换' : '粘贴 API 密钥或 $ENV_VAR'"
              hint="可粘贴密钥，或填 $ENV_VAR 引用环境变量（不落盘更安全）。"
              persistent-hint
              density="comfortable"
            />
            <div v-else class="key-cleared-note">
              <v-icon size="small" icon="mdi-alert-circle-outline" />
              <span>密钥已标记清除，保存后生效。</span>
              <v-btn size="x-small" variant="text" @click="draft.apiKeyCleared = false">恢复</v-btn>
            </div>
            <v-btn
              v-if="draft.keyConfigured && !draft.apiKeyCleared"
              size="small"
              variant="text"
              color="error"
              @click="clearKey(draft)"
            >
              清除密钥
            </v-btn>
          </div>
          <div v-if="draft.keyConfigured && !draft.apiKeyCleared && !draft.apiKeyInput.trim()" class="key-configured-hint mb-3">
            <v-icon size="small" color="success" icon="mdi-check-circle" />
            <span>密钥已保存。留空保存将保留原密钥不变，<strong>无需重新输入</strong>；仅在替换时输入新值。</span>
          </div>

          <v-switch
            v-model="draft.config.authHeader"
            label="使用 Bearer 认证头 (authHeader)"
            hint="仅 anthropic 中转站且代理期望 Authorization: Bearer 而非 x-api-key 时开启。"
            persistent-hint
            density="compact"
            class="mb-3"
          />

          <div class="subsection mb-3">
            <div class="subsection-title">Headers（可选）</div>
            <div class="inline-hint mb-2">
              已配置的 Header 值经 IPC 脱敏为掩码显示，保存时自动保留原值；输入新值替换，留空则删除该 Header。
            </div>
            <div v-for="(h, hIdx) in draft.headerEntries" :key="hIdx" class="kv-row">
              <v-text-field v-model="h.key" label="Header 名" density="comfortable" hide-details />
              <v-text-field
                v-model="h.value"
                label="Header 值"
                type="password"
                density="comfortable"
                hide-details
              />
              <v-btn size="small" variant="text" color="error" icon="mdi-delete" @click="removeHeader(draft, hIdx)" />
            </div>
            <v-btn size="small" variant="text" prepend-icon="mdi-plus" @click="addHeader(draft)">添加 Header</v-btn>
          </div>

          <div class="subsection mb-3">
            <div class="subsection-title">兼容性 (compat)</div>
            <v-alert v-if="draft.config.api === 'openai-completions'" type="info" density="compact" variant="tonal" class="mb-3">
              报错 503/400 或 <code>unknown variant `developer`</code>？非 OpenAI 官方的中转站通常不支持 <code>developer</code> 角色与 <code>reasoning_effort</code> 字段。切换「兼容预设」或关掉对应开关：OpenRouter 走 <code>reasoning.effort</code> 嵌套；DeepSeek/Qwen/Zai 走各自 <code>enable_thinking</code>；完全不支持 reasoning 则选「纯透传」或关掉模型「推理」。
            </v-alert>
            <div v-if="draft.config.api !== 'openai-completions'" class="inline-hint mb-2">
              {{ nonOpenAiCompatNote(draft.config.api) }}
            </div>
            <v-select
              :model-value="draft.compatPreset"
              :items="presetItems"
              label="兼容预设"
              hint="一键设定下方 5 个关键字段；选「自定义」可手动细调。"
              persistent-hint
              density="comfortable"
              class="mb-3"
              @update:model-value="applyPreset(draft, $event)"
            />
            <div class="compat-grid mb-2">
              <v-select
                v-model="draft.compatThinkingFormat"
                :items="thinkingFormatItems"
                label="thinkingFormat"
                density="comfortable"
                hide-details
                @update:model-value="syncPreset(draft)"
              />
              <v-select
                v-model="draft.compatMaxTokensField"
                :items="maxTokensFieldItems"
                label="maxTokensField"
                density="comfortable"
                hide-details
                @update:model-value="syncPreset(draft)"
              />
            </div>
            <div class="compat-switches mb-2">
              <v-switch v-model="draft.compatSupportsReasoningEffort" label="supportsReasoningEffort" density="compact" hide-details @update:model-value="syncPreset(draft)" />
              <v-switch v-model="draft.compatSupportsStore" label="supportsStore" density="compact" hide-details @update:model-value="syncPreset(draft)" />
              <v-switch v-model="draft.compatSupportsDeveloperRole" label="supportsDeveloperRole" density="compact" hide-details @update:model-value="syncPreset(draft)" />
            </div>
            <div class="advanced-section">
              <v-btn
                size="small"
                variant="text"
                @click="draft.showAdvanced = !draft.showAdvanced"
              >
                <v-icon size="small">{{ draft.showAdvanced ? "mdi-chevron-up" : "mdi-chevron-down" }}</v-icon>
                高级：compat 覆盖 JSON
              </v-btn>
              <div v-if="draft.showAdvanced">
                <v-textarea
                  v-model="draft.compatOverrideJson"
                  rows="3"
                  density="comfortable"
                  placeholder='{ "requiresToolResultName": true }'
                  hint="合并到上述 5 个字段之上，用于预设未覆盖的 compat 字段（如各 API 类型的专属字段）；同名结构化键会被忽略。"
                  persistent-hint
                  :error-messages="draft.compatOverrideError ? [draft.compatOverrideError] : []"
                  @blur="validateOverride(draft)"
                />
                <div v-if="draft.compatOverrideWarning" class="compat-warn-hint">
                  <v-icon size="small" icon="mdi-alert-outline" />
                  <span>{{ draft.compatOverrideWarning }}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="subsection mb-3">
            <div class="subsection-title">模型列表</div>
            <div class="inline-hint mb-2">覆盖内置 provider 时留空模型列表即保留全部内置模型。每个模型可单独配置思考档位映射。</div>
            <div v-for="(model, mIdx) in draft.config.models" :key="mIdx" class="model-block">
              <div class="model-row">
                <v-text-field v-model="model.id" label="模型 ID" placeholder="如 gpt-5.6-luna" density="comfortable" hide-details class="model-id-field" />
                <v-text-field v-model="model.name" label="显示名" density="comfortable" hide-details />
                <v-switch v-model="model.reasoning" label="推理" density="compact" hide-details />
                <v-select v-model="model.input" :items="inputItems" label="输入" multiple chips density="comfortable" hide-details />
                <v-text-field v-model.number="model.contextWindow" label="上下文窗口" type="number" density="comfortable" hide-details />
                <v-text-field v-model.number="model.maxTokens" label="最大输出" type="number" density="comfortable" hide-details />
                <v-btn size="small" variant="text" color="error" icon="mdi-delete" @click="removeModel(draft, mIdx)" />
              </div>
              <div class="model-thinking">
                <v-btn size="x-small" variant="text" @click="model.showThinking = !model.showThinking">
                  <v-icon size="small">{{ model.showThinking ? "mdi-chevron-up" : "mdi-chevron-down" }}</v-icon>
                  思考档位映射 thinkingLevelMap
                </v-btn>
                <div v-if="model.showThinking" class="thinking-section">
                  <v-textarea
                    v-model="model.thinkingLevelMapJson"
                    rows="3"
                    density="comfortable"
                    placeholder='{ "low": null, "medium": null, "high": "high", "xhigh": "max" }'
                    hint="把 pi 档位映射到该模型接受的 reasoning 值。未列出的档位默认显示并按原值发送；要隐藏某档位必须显式写 null（如 &quot;low&quot;: null）。xhigh 需在此声明才出现最高档。仅对该模型生效。"
                    persistent-hint
                    :error-messages="model.thinkingLevelMapError ? [model.thinkingLevelMapError] : []"
                    @blur="validateThinkingLevelMap(model)"
                  />
                </div>
              </div>
            </div>
            <v-btn size="small" variant="text" prepend-icon="mdi-plus" @click="addModel(draft)">添加模型</v-btn>
          </div>

          <div class="provider-actions">
            <v-btn color="primary" variant="tonal" :loading="saving" @click="saveAll">保存</v-btn>
            <v-btn color="error" variant="text" :loading="saving" @click="requestDelete(idx)">删除</v-btn>
          </div>
        </div>
      </v-card>
    </div>

    <v-dialog v-model="deleteDialogOpen" max-width="420" persistent>
      <v-card>
        <v-card-title class="text-h6">删除 Provider</v-card-title>
        <v-card-text>
          确定删除「{{ deleteTargetName }}」？该操作不可撤销，确认后立即保存并写入磁盘。
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="saving" @click="deleteDialogOpen = false">取消</v-btn>
          <v-btn color="error" variant="tonal" :loading="saving" @click="confirmDelete">确认删除</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.provider-list {
  display: flex;
  flex-direction: column;
}

.provider-card {
  padding: var(--pix-space-sm);
  border-radius: var(--pix-radius-lg) !important;
  background: var(--pix-bg-card);
}

.provider-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  user-select: none;
  padding: var(--pix-space-sm) 0;
  gap: var(--pix-space-sm);
}

.provider-info {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  flex-wrap: wrap;
  min-width: 0;
}

.provider-name {
  font-weight: 600;
  font-size: var(--pix-text-md);
  font-family: var(--pix-font-ui);
}

.provider-baseurl {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 280px;
}

.provider-meta {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  flex-shrink: 0;
}

.provider-edit {
  margin-top: var(--pix-space-md);
  padding-top: var(--pix-space-md);
  border-top: 1px solid var(--pix-border-light);
  display: flex;
  flex-direction: column;
}

.field-row {
  display: flex;
  align-items: flex-start;
  gap: var(--pix-space-sm);
}

.key-cleared-note {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  font-size: var(--pix-text-sm);
  color: var(--pix-text-secondary);
  padding: 6px 0;
}

.key-configured-hint {
  display: flex;
  align-items: center;
  gap: var(--pix-space-xs);
  font-size: var(--pix-text-sm);
  color: rgb(var(--v-theme-success));
}

.subsection {
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-xs);
  padding: var(--pix-space-sm) 0;
  border-top: 1px solid var(--pix-border-light);
}

.subsection-title {
  font-size: var(--pix-text-sm);
  font-weight: 600;
  color: var(--pix-text-primary);
}

.kv-row,
.model-row {
  display: flex;
  align-items: center;
  gap: var(--pix-space-sm);
  flex-wrap: wrap;
}

.model-id-field {
  min-width: 200px;
}

.compat-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--pix-space-sm);
}

.compat-switches {
  display: flex;
  flex-wrap: wrap;
  gap: var(--pix-space-md);
}

.model-block {
  border: 1px solid var(--pix-border-light);
  border-radius: 8px;
  padding: var(--pix-space-sm);
  margin-bottom: var(--pix-space-sm);
}

.model-thinking {
  margin-top: var(--pix-space-xs);
}

.thinking-section {
  margin-top: var(--pix-space-xs);
}

.advanced-section {
  margin-top: var(--pix-space-xs);
  display: flex;
  flex-direction: column;
  gap: var(--pix-space-xs);
}

.compat-warn-hint {
  display: flex;
  align-items: flex-start;
  gap: var(--pix-space-xs);
  margin-top: var(--pix-space-xs);
  font-size: var(--pix-text-xs);
  color: rgb(var(--v-theme-warning));
}

.inline-hint {
  font-size: var(--pix-text-xs);
  color: var(--pix-text-secondary);
}

.provider-actions {
  display: flex;
  gap: var(--pix-space-sm);
  justify-content: flex-end;
  margin-top: var(--pix-space-sm);
}
</style>
