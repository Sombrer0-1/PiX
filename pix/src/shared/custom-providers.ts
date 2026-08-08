/**
 * Shared types & constant for user-defined (custom) model providers.
 *
 * These types describe the subset of `models.json` that pix owns: the
 * `providers` map plus the per-model entries nested inside it. They are shared
 * by the renderer (settings UI), preload and main processes, and by the
 * `RpcCommand` union in types.ts, so the module is a leaf with a single
 * runtime export (`SENTINEL`).
 *
 * apiKey masking contract:
 * - `getCustomProviders` replaces each provider's plaintext `apiKey` with the
 *   `SENTINEL` constant before returning across IPC; the plaintext never
 *   reaches the renderer.
 * - `setCustomProviders` treats `apiKey === SENTINEL` as "leave unchanged"
 *   (copy the on-disk value), `apiKey === null` as "clear the field", and any
 *   other value as the new key.
 * `apiKey === undefined` means the field was never set.
 */

export type CustomApi =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses"
  | "google-generative-ai";

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
  /** literal | $ENV | !cmd; renderer only ever sees the SENTINEL mask. */
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  models?: CustomModelConfig[];
  modelOverrides?: Record<string, Record<string, unknown>>;
}

export interface ModelsJson {
  providers: Record<string, CustomProviderConfig>;
}

/** apiKey mask returned to the renderer; signals "do not modify" on write. */
export const SENTINEL = "__PIX_KEY_MASKED__";
