/** User-facing copy when the Electron preload bridge is missing (e.g. bare Vite). */
export const DESKTOP_API_UNAVAILABLE = "应用接口不可用，请从 PiX 桌面端打开";

export function isDesktopApiAvailable(): boolean {
  return typeof window !== "undefined" && !!window.pixApi;
}

/** Map bridge/preload failures to Chinese; keep other real errors intact. */
export function mapDesktopApiError(err: unknown, fallback = DESKTOP_API_UNAVAILABLE): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (!msg.trim()) return fallback;
  if (/pixApi/i.test(msg)) return fallback;
  if (/Cannot read propert(?:y|ies) of undefined/i.test(msg)) return fallback;
  if (/is not (?:a function|defined)/i.test(msg) && /pixApi|resolveProjectLocation|selectProject|listWslDistros/i.test(msg)) {
    return fallback;
  }
  return msg;
}

/** Strip internal API names from diagnostics shown in banners. */
export function sanitizeUserDiagnostic(text: string | null | undefined, fallback = DESKTOP_API_UNAVAILABLE): string | null {
  if (text == null || text === "") return null;
  if (/pixApi/i.test(text)) return fallback;
  if (/Cannot read propert(?:y|ies) of undefined/i.test(text)) return fallback;
  return text;
}
