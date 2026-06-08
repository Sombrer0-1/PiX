import "./providers/register-builtins.ts";

import { getApiProvider } from "./api-registry.ts";
import { getEnvApiKey } from "./env-api-keys.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.ts";
import { logRequest, logResponse } from "./utils/cache-debug.ts";
import { AssistantMessageEventStream as AssistantMessageEventStreamImpl } from "./utils/event-stream.ts";

export { getEnvApiKey } from "./env-api-keys.ts";

function hasExplicitApiKey(apiKey: string | undefined): apiKey is string {
	return typeof apiKey === "string" && apiKey.trim().length > 0;
}

function withEnvApiKey<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions | undefined,
): TOptions | undefined {
	if (hasExplicitApiKey(options?.apiKey)) return options;
	const apiKey = getEnvApiKey(model.provider);
	if (!apiKey) return options;
	return { ...options, apiKey } as TOptions;
}

function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return provider.stream(model, context, withEnvApiKey(model, options) as StreamOptions);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const requestId = logRequest({
		model: {
			id: model.id,
			name: model.name,
			api: model.api as string,
			provider: model.provider as string,
			reasoning: model.reasoning,
			baseUrl: model.baseUrl,
		},
		systemText: context.systemPrompt ?? "",
		messages: context.messages as unknown[],
		tools: (context.tools as unknown[]) ?? [],
		// Pass through what we have at this level; providers can log more detail later.
		promptCacheKey: options?.sessionId,
		promptCacheRetention: options?.cacheRetention,
		store: false,
	});

	const provider = resolveApiProvider(model.api);
	const original = provider.streamSimple(model, context, withEnvApiKey(model, options));

	const wrapped = new AssistantMessageEventStreamImpl();
	(async () => {
		try {
			for await (const event of original as AsyncIterable<AssistantMessageEvent>) {
				wrapped.push(event);
				if (event.type === "done") {
					logResponse(event.message.usage, requestId);
				} else if (event.type === "error") {
					logResponse(event.error.usage, requestId);
				}
			}
		} catch (err) {
			wrapped.end();
			throw err;
		}
	})();
	return wrapped;
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
