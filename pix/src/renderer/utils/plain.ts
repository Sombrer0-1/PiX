/**
 * Deep-plain copy of JSON-shaped data.
 *
 * Vue refs/reactive proxies cannot cross the contextBridge/IPC boundary:
 * Electron's structured clone rejects proxies with "An object could not be
 * cloned". Every object handed to window.pixApi.* (project locations, recent
 * project entries) must be a plain JSON value. A JSON round-trip is the
 * simplest deep copy for the settings/location-shaped data used here and also
 * strips nested reactive proxies (toRaw only unwraps the outer layer).
 */

export function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
